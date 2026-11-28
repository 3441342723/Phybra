import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scenario = process.argv.includes('--repair') ? 'repair' : process.argv.includes('--regenerate') ? 'regenerate' : process.argv.includes('--qwen') ? 'qwen' : 'valid';
const verification = scenario !== 'valid' || process.argv.includes('--production') || process.env.AI_VERIFY_PRODUCTION === '1'
  ? await (await import('./ai-production-server.mjs')).startVerificationServer({ scenario }) : null;
const url = verification?.url ?? process.env.P2_URL ?? 'http://127.0.0.1:5173';
const executable = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'physics-p2-'));
const chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const pending = new Map();
const errors = [];
let sequence = 0;
let sessionId;
let onDownload;

try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Chrome 启动超时')), 15000);
    chrome.on('error', reject);
    chrome.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    } else if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') {
      onDownload?.(message.params.guid);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !message.params.entry.url?.endsWith('/favicon.ico')) {
      errors.push(`${message.params.entry.text} ${message.params.entry.url ?? ''}`);
    }
  };
  function send(method, params = {}, scoped = true) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(scoped && sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).catch(error=>{throw new Error(expression+'\n'+error.message);});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitFor(expression) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    await screenshot('ai-verification-failure');
    console.error(await evaluate("({title:JSON.parse(localStorage.getItem('phy.scene.v2'))?.title,errors:[...document.querySelectorAll('.ai-panel .error')].map(e=>e.innerText),stage:document.querySelector('.draft-stage-select')?.value})"));
    throw new Error(`等待条件超时: ${expression}`);
  }
  async function resize(width, height, mobile = false) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await waitFor(`document.documentElement.clientWidth === ${width}`);
  }
  async function click(selector) {
    const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('找不到 ${selector}'); e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  async function clickText(text, root = 'body') {
    const selector = await evaluate(`(() => { const e = [...document.querySelector(${JSON.stringify(root)}).querySelectorAll('button, summary')].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!e) throw new Error('缺少按钮 ${text}'); e.dataset.p2Target = 'current'; return '[data-p2-target="current"]'; })()`);
    await click(selector);
    await evaluate("document.querySelector('[data-p2-target]')?.removeAttribute('data-p2-target')");
  }
  async function key(key, code = key, modifiers = 0) {
    const windowsVirtualKeyCode = { Escape: 27, Tab: 9, Enter: 13, End: 35, Home: 36, ArrowRight: 39, ArrowLeft: 37 }[key] ?? key.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
  }
  async function setInput(selector, value) {
    await click(selector);
    await key('a', 'KeyA', 2);
    await send('Input.insertText', { text: String(value) });
    await key('Tab');
  }
  async function drag(selector, dx, dy, touch = false, cancel = false) {
    const start = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (touch) await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
    else await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 4; i++) {
      const point = { x: start.x + dx * i / 4, y: start.y + dy * i / 4 };
      if (touch) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 0 }] });
      else await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 });
      await evaluate('new Promise(requestAnimationFrame)');
    }
    if (touch) await send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    else await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + dx, y: start.y + dy, button: 'left', clickCount: 1 });
  }
  async function loadFixture(expression) {
    await evaluate(`(async () => { const factory = await import('/src/model/factory.ts'); const scene = ${expression}; localStorage.setItem('phy.scene.v2', JSON.stringify(scene)); localStorage.setItem('phy.view.v1', JSON.stringify({scale:40,ox:60,oy:360})); })()`);
    await send('Page.reload');
    await waitFor("document.querySelector('.canvas-wrap svg') && !document.querySelector('.timeline button').disabled");
  }
  const saved = "JSON.parse(localStorage.getItem('phy.scene.v2'))";
  async function screenshot(name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const path = join(tmpdir(), `physics-p2-${name}.png`);
    await writeFile(path, Buffer.from(data, 'base64'));
    console.log(`截图: ${path}`);
  }




  await resize(1440,1000);
  await send('Page.navigate',{url});
  await waitFor("document.querySelector('.canvas-wrap svg')");
  if (!verification) await loadFixture('factory.inclineExample()');
  await waitFor("localStorage.getItem('phy.scene.v2')");
  const initial=await evaluate(saved);
  await clickText('AI 建模','.app-header');
  if (verification) {
    await setInput('.ai-panel textarea', verification.problem);
    await clickText('生成场景草稿', '.ai-panel');
    if (scenario === 'repair') {
      await waitFor("document.querySelector('.ai-panel').innerText.includes('正在自动修正场景格式')");
      assert.deepEqual(await evaluate(saved), initial);
      await screenshot('ai-production-repair-progress');
    }
    if (scenario === 'regenerate') {
      await waitFor("document.querySelector('.ai-panel .error')?.innerText.includes('请重新生成草稿')");
      assert.ok(!(await evaluate("document.querySelector('.ai-panel .error').innerText")).includes('补全题面'));
      assert.deepEqual(await evaluate(saved), initial);
      assert.equal(await evaluate("document.querySelector('.ai-panel textarea').value"), verification.problem);
      await screenshot('ai-production-regenerate-error');
      await clickText('重新生成草稿', '.ai-panel');
    }
  } else await clickText('载入碰撞与复合场修订示例（本地）','.ai-panel');
  await waitFor("document.querySelector('.draft-stage-select')");
  assert.ok(await evaluate("document.querySelector('.ai-panel').innerText.includes('10000 N/C')"));
  if (verification) {
    assert.deepEqual(verification.requests, scenario === 'repair' ? ['POST', 'GET', 'GET']
      : scenario === 'regenerate' ? ['POST', 'GET', 'GET', 'POST', 'GET'] : ['POST', 'GET']);
    assert.equal(verification.cloud.sessions.length, scenario === 'qwen' ? 0 : scenario === 'repair' ? 2 : scenario === 'regenerate' ? 3 : 1);
    if (scenario === 'qwen') {
      assert.equal(verification.qwenCalls.length, 1);
      assert.equal(verification.qwenCalls[0].url, 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
      assert.equal(verification.qwenCalls[0].init.headers.Authorization, 'Bearer fixture-key');
      assert.equal(JSON.parse(verification.qwenCalls[0].init.body).model, 'qwen3.8-flash');
    }
    if (scenario === 'regenerate') {
      assert.equal(verification.generationIds[0], null);
      assert.match(verification.generationIds[1], /^[a-f0-9-]{36}$/);
    }
    assert.equal(await evaluate("document.querySelector('.ai-panel .ai-mode-row').innerText.trim()"), '服务端读题');
    assert.ok(!(await evaluate("document.querySelector('.ai-panel').innerText")).includes('bodies.0.kind'));
    await clickText('应用替换场景（可撤销）', '.ai-panel');
    await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).bodies.length===2 && JSON.parse(localStorage.getItem('phy.scene.v2')).bodies.every(b=>b.kind==='ball')");
    await clickText('检查并求解', '.app-header');
    await waitFor("document.querySelector('.result-panel').innerText.includes('2.14')");
  }
  const choose=async(id)=>{
    await click('dialog[aria-label="AI 建模"] .floating-title strong');
    await evaluate(`(()=>{const e=document.querySelector('.draft-stage-select');e.value="${id}";e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  await choose('a-field');
  await clickText('应用替换场景（可撤销）','.ai-panel');
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).title.includes('A 进入复合场')");
  const a=await evaluate(saved);
  assert.equal(a.bodies[0].charge,.0001);assert.ok(Math.abs(a.bodies[0].vel.x-15/7)<1e-9);assert.equal(a.fields.length,3);
  if (verification) {
    await clickText('检查并求解', '.app-header');
    await waitFor("document.querySelector('.result-panel').innerText.includes('匀速圆周')");
    const heightText = await evaluate("[...document.querySelectorAll('.result-panel .answer-row')].find(e=>e.querySelector('.answer-label')?.textContent==='返回时的离地高度')?.querySelector('.answer-value')?.textContent");
    assert.ok(heightText, '必须显示返回高度');
    assert.ok(Math.abs(parseFloat(heightText) - (.8 + 60000 / 7)) < 10, heightText);
    await screenshot(`ai-production-${scenario}-field-result`);
  } else {
    const results=await evaluate(`(async()=>{const {solve}=await import('/src/solver/index.ts');const r=solve(JSON.parse(localStorage.getItem('phy.scene.v2')));return r.ok?r.solution.answers:[];})()`);
    assert.ok(results.some(a=>a.text?.includes('匀速圆周')));
    assert.ok(results.some(a=>a.label==='返回时的离地高度'&&Math.abs(a.value-(.8+60000/7))<1e-6));
  }
  assert.equal(await evaluate("document.querySelectorAll('.ai-panel .draft-stage-select').length"),1);
  await choose('b-flight');
  await clickText('应用替换场景（可撤销）','.ai-panel');
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).title.includes('B 平抛')");
  assert.ok(Math.abs((await evaluate(saved)).bodies[0].vel.x-50/7)<1e-9);
  if (verification) {
    await clickText('检查并求解', '.app-header');
    await waitFor("document.querySelector('.result-panel').innerText.includes('2.86')");
  }
  await clickText('撤销','.app-header');
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).title.includes('A 进入复合场')");
  await clickText('撤销','.app-header');
  if (verification) {
    await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).bodies.length===2");
    await clickText('撤销','.app-header');
  }
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).title==='斜面与摩擦（示例）'");
  assert.deepEqual(await evaluate(saved),initial);
  await screenshot(verification ? `ai-production-${scenario}-stages` : 'ai-fields-stages');
  await resize(390,844,true);
  await waitFor("document.documentElement.clientWidth===390");
  await clickText('AI','.panel-tabs');
  assert.equal(await evaluate("document.querySelectorAll('.draft-stage-select option').length"),4);
  assert.equal(await evaluate('document.documentElement.scrollWidth'),390);
  await screenshot(verification ? `ai-production-${scenario}-mobile` : 'ai-fields-mobile');
  if (scenario === 'regenerate') {
    const expected = error => error.startsWith('Failed to load resource: the server responded with a status of 502')
      && error.endsWith(`${verification.url}/functions/v1/app/interpret?job=${verification.cloud.sessions[0].metadata.job}`);
    assert.equal(errors.filter(expected).length, 1, '仅允许一次预期的无效草稿网络错误');
    assert.deepEqual(errors.filter(error => !expected(error)), []);
  } else assert.deepEqual(errors,[]);
  console.log('PASS 电荷与场完整显示、阶段选择、碰后速度本地注入、返回高度、B 平抛、撤销和窄屏');
} finally {
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  chrome.kill();
  if (chrome.exitCode === null) await new Promise((resolve) => chrome.once('exit', resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await verification?.close();
}
