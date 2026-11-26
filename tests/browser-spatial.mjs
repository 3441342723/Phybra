import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.P2_URL ?? 'http://127.0.0.1:5173';
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
  await loadFixture("factory.spatialExample('helix')");
  await waitFor("document.querySelector('.spatial-trajectory')");
  assert.equal(await evaluate("document.querySelectorAll('.spatial-axes [data-axis]').length"),3);
  const before=await evaluate("document.querySelector('.spatial-trajectory').getAttribute('points')");
  const savedScene=await evaluate(saved);
  await clickText('正视 xy','.spatial-controls');
  await waitFor("JSON.parse(localStorage.getItem('phy.view.v1')).rotation.yaw===0");
  assert.notEqual(await evaluate("document.querySelector('.spatial-trajectory').getAttribute('points')"),before);
  await clickText('旋转视角','.spatial-controls');
  await drag('.spatial-background',100,-30);
  await waitFor("JSON.parse(localStorage.getItem('phy.view.v1')).rotation.yaw!==0");
  assert.deepEqual(await evaluate(saved),savedScene);
  await clickText('旋转视角','.spatial-controls');
  await click('[data-spatial-body]');
  await waitFor("[...document.querySelectorAll('.prop-field label')].some(e=>e.textContent==='初速度 vz')");
  const inputSelector=await evaluate("(()=>{const e=[...document.querySelectorAll('.prop-field')].find(e=>e.querySelector('label')?.textContent==='初速度 vz').querySelector('input');e.dataset.testVz='true';return '[data-test-vz]';})()");
  await setInput(inputSelector,2);
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).bodies[0].vel.z===2");
  const zInput=await evaluate("(()=>{const e=[...document.querySelectorAll('.prop-field')].find(e=>e.querySelector('label')?.textContent==='初始位置 z').querySelector('input');e.dataset.testZ='true';return '[data-test-z]';})()");
  await setInput(zInput,3);
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).bodies[0].pos.z===3");
  const beforeDrag=await evaluate(saved);
  await drag('[data-spatial-body]',25,12);
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).rev>"+beforeDrag.rev);
  assert.equal((await evaluate(saved)).bodies[0].pos.z,3);
  assert.equal((await evaluate(saved)).bodies[0].vel.z,2);
  await clickText('撤销','.app-header');
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).rev==="+beforeDrag.rev);
  assert.deepEqual((await evaluate(saved)).bodies[0].pos,beforeDrag.bodies[0].pos);
  await clickText('播放','.timeline');
  await waitFor("document.querySelector('.spatial-canvas .moving-body')");
  await clickText('暂停','.timeline');
  const matches=await evaluate(`(async()=>{const {solve}=await import('/src/solver/index.ts');const {projectSpace}=await import('/src/model/projection.ts');const scene=JSON.parse(localStorage.getItem('phy.scene.v2'));const result=solve(scene);if(!result.ok)return false;const t=Number(document.querySelector('.moving-body').dataset.time),s=result.solution.evalAt(t),cam=JSON.parse(localStorage.getItem('phy.view.v1')),p=projectSpace(s,cam.rotation),dot=document.querySelector('.moving-body circle');return Math.abs(Number(dot.getAttribute('cx'))-cam.ox-p.x*cam.scale)<1 && Math.abs(Number(dot.getAttribute('cy'))-cam.oy+p.y*cam.scale)<1;})()`);
  assert.ok(matches,'播放位置必须与求解器三维投影一致');
  await screenshot('spatial-desktop');
  await loadFixture("factory.spatialExample('tilted')");
  const fieldRow=await evaluate("(()=>{const e=[...document.querySelectorAll('.row.selectable')].find(e=>e.querySelector('.row-main')?.textContent==='匀强磁场');e.dataset.testFieldRow='true';return '[data-test-field-row]';})()");
  await click(fieldRow);
  await waitFor("document.querySelector('.panel-content').textContent.includes('磁场 Bx') || document.body.textContent.includes('磁场 Bx')");
  await resize(390,844,true);
  await waitFor("document.querySelector('.canvas-area>svg')?.getAttribute('width')==='390'");
  await clickText('旋转视角','.spatial-controls');
  const old=await evaluate("document.querySelector('.spatial-trajectory').getAttribute('points')");
  await drag('.spatial-background',45,20,true);
  assert.notEqual(await evaluate("document.querySelector('.spatial-trajectory').getAttribute('points')"),old);
  assert.equal(await evaluate('document.documentElement.scrollWidth'),390);
  await screenshot('spatial-mobile');
  await clickText('复位视角','.spatial-controls');
  assert.ok(await evaluate("(()=>{const svg=document.querySelector('.canvas-area>svg'),h=Number(svg.getAttribute('height'));return document.querySelector('.spatial-trajectory').getAttribute('points').split(' ').every(p=>{const [x,y]=p.split(',').map(Number);return x>=0&&x<=390&&y>=0&&y<=h;});})()"),'复位后空间轨迹应位于可见区域');
  await resize(1440,1000);
  await clickText('新建场景','.app-header');
  await waitFor("document.querySelector('[aria-label=\"坐标维度\"]').value==='2d'");
  await evaluate("(()=>{const e=document.querySelector('[aria-label=\"坐标维度\"]');e.value='3d';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor("document.querySelector('.spatial-canvas')");
  await clickText('对象','.toolbar');
  await clickText('小球','.toolbar');
  await click('.spatial-background');
  await waitFor("document.querySelector('[data-spatial-body]')");
  await clickText('场','.toolbar');
  await clickText('重力场','.toolbar');
  await click('.spatial-background');
  await waitFor("document.querySelector('.spatial-trajectory')");
  await waitFor("JSON.parse(localStorage.getItem('phy.scene.v2')).fields?.length===1");
  const manual=await evaluate(saved);
  assert.equal(manual.dimension,'3d');assert.equal(manual.bodies.length,1);assert.equal(manual.fields[0].shape.kind,'global');
  await loadFixture('factory.inclineExample()');
  assert.equal(await evaluate("document.querySelectorAll('.spatial-canvas').length"),0);
  assert.deepEqual(errors,[]);
  console.log('PASS 三维坐标、轨迹、旋转、vz 编辑、真实播放投影、场分量、触屏旋转及二维切换');
} finally {
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  chrome.kill();
  if (chrome.exitCode === null) await new Promise((resolve) => chrome.once('exit', resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
