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
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitFor(expression) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await evaluate('new Promise(requestAnimationFrame)');
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

  await resize(1440, 1000);
  await send('Page.navigate', { url });
  await waitFor("document.querySelectorAll('.floating-window[open]').length === 4 && !document.querySelector('.timeline button').disabled");
  console.log('PASS 桌面四个浮窗与播放入口');
  await resize(390, 844, true);
  await waitFor("document.querySelector('.canvas-wrap svg')?.getAttribute('width') === '390'");
  assert.equal(await evaluate("document.querySelectorAll('.floating-window[open]').length"), 0, '窄屏不得保留遮挡画布的桌面浮窗');
  assert.equal(await evaluate("document.querySelectorAll('.panel-tabs button').length"), 5, '窄屏应有五个面板入口');
  await click('.panel-tabs button');
  await waitFor("document.querySelector('dialog[open]')?.getAttribute('aria-label') === '对象与代数'");
  await screenshot('mobile');
  await click('dialog[open] .window-close');
  await waitFor("!document.querySelector('dialog[open]')");
  let desktopLayout = await evaluate("localStorage.getItem('phy.windows.v1')");
  await click('.panel-tabs button:nth-child(5)');
  await setInput('dialog[open] textarea', '切换尺寸后必须保留的未提交题目');
  await resize(1440, 1000);
  await waitFor("document.querySelectorAll('.floating-window[open]').length === 4");
  await clickText('AI 建模', '.app-header');
  await waitFor("document.querySelector('.ai-panel textarea')");
  assert.equal(await evaluate("document.querySelector('.ai-panel textarea').value"), '切换尺寸后必须保留的未提交题目', '跨断点保留 AI 输入');
  await resize(390, 844, true);
  await click('.panel-tabs button:nth-child(5)');
  assert.equal(await evaluate("document.querySelector('dialog[open] textarea').value"), '切换尺寸后必须保留的未提交题目');
  await key('Escape');
  await resize(1440, 1000);
  await click('.floating-window[aria-label="AI 建模"] .window-close');
  await resize(390, 844, true);
  desktopLayout = await evaluate("localStorage.getItem('phy.windows.v1')");
  for (const [index, title] of ['对象与代数', '属性', '答案与推导', '曲线', 'AI 建模'].entries()) {
    await click(`.panel-tabs button:nth-child(${index + 1})`);
    await waitFor(`document.querySelector('dialog[open]')?.getAttribute('aria-label') === ${JSON.stringify(title)}`);
    assert.equal(await evaluate("document.activeElement?.closest('.panel-drawer[open]') !== null"), true, '抽屉获得焦点');
    if (title === '曲线') {
      await clickText('速度–时间', '.panel-drawer[open]');
      assert.equal(await evaluate("document.querySelector('dialog[open] .chart-body').clientHeight > 100"), true);
    }
    if (title === 'AI 建模') assert.equal(await evaluate("!!document.querySelector('dialog[open] textarea')"), true);
    await key('Escape');
    await waitFor("!document.querySelector('dialog[open]')");
    assert.equal(await evaluate("document.activeElement?.closest('.panel-tabs') !== null"), true, '关闭恢复入口焦点');
  }
  assert.equal(await evaluate("localStorage.getItem('phy.windows.v1')"), desktopLayout, '抽屉操作不改桌面布局');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '手机无横向溢出');
  await screenshot('canvas');
  console.log('PASS 手机五类抽屉、Escape 与焦点恢复');

  await click('.panel-tabs button:first-child');
  await click('dialog[open] .row.selectable:nth-of-type(2) .danger');
  await waitFor("document.querySelector('.modal.small')");
  assert.equal(await evaluate("(() => { const e = document.querySelector('.modal.small .primary.danger'); const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2, r.y+r.height/2) === e; })()"), true, '删除确认必须位于抽屉之上且可点击');
  await click('.modal.small .primary.danger');
  await waitFor(`${saved}.supports.length === 0 && ${saved}.bodies.length === 0`);
  await key('Escape');
  await clickText('撤销', '.app-header');
  await waitFor(`${saved}.supports.length === 1 && ${saved}.bodies.length === 1 && ${saved}.contacts.length === 1`);
  console.log('PASS 抽屉依赖删除和撤销恢复');

  await loadFixture(`(() => { const s = factory.baseScene(); const b = factory.makeProjectile(2, 3, 2, 1); b.id = 'probe'; s.bodies = [b]; s.asks = [factory.makeAsk('at_time', {t:0.5})]; s.params = ['px','vx','vy'].map((name,i) => ({name,value:[2,2,1][i],unit:i===0?'length':'speed',min:-10,max:10,step:0.1})); s.bindings = {'bodies.probe.pos.x':'px','bodies.probe.vel.x':'vx','bodies.probe.vel.y':'vy'}; return s; })()`);
  await drag('.body-projectile', 40, -40, true, true);
  await waitFor(`${saved}.params[0].value === 3`);
  await clickText('撤销', '.app-header');
  await waitFor(`${saved}.params[0].value === 2`);
  assert.deepEqual(await evaluate(`${saved}.bodies[0].pos`), {x:2,y:3}, '触摸取消结束手势并保留一步撤销');
  await clickText('重做', '.app-header');
  await waitFor(`${saved}.params[0].value === 3`);
  console.log('PASS 绑定位置的触摸拖动、取消、一次撤销重做');

  await drag('.handle.velocity', 24, -24, true);
  await waitFor(`${saved}.params[1].value === 4 && ${saved}.params[2].value === 3`);
  assert.deepEqual(await evaluate(`${saved}.bodies[0].vel`), {x:4,y:3});
  await click('.panel-tabs button:nth-child(2)');
  await waitFor("document.querySelector('dialog[open] .prop-field')");
  assert.equal(await evaluate("document.querySelectorAll('dialog[open] .num-input')[3].value"), '4');
  assert.equal(await evaluate("document.querySelectorAll('dialog[open] .num-input')[4].value"), '3');
  await setInput('dialog[open] .prop-field:nth-of-type(4) .num-input', 6);
  await waitFor(`${saved}.params[1].value === 6 && ${saved}.bodies[0].vel.x === 6`);
  const beforeBindings = await evaluate(saved);
  await evaluate("(() => { const e = document.querySelector('dialog[open] .prop-field:nth-of-type(5) .binding-select'); e.value = 'vx'; e.dispatchEvent(new Event('change', {bubbles:true})); })()");
  await waitFor(`${saved}.bodies[0].vel.y === 6`);
  await setInput('dialog[open] .prop-field:nth-of-type(4) .num-input', 8);
  await waitFor(`${saved}.bodies[0].vel.x === 8 && ${saved}.bodies[0].vel.y === 8`);
  await evaluate("(() => { const e = document.querySelector('dialog[open] .prop-field:nth-of-type(5) .binding-select'); e.value = ''; e.dispatchEvent(new Event('change', {bubbles:true})); })()");
  await waitFor(`!${saved}.bindings['bodies.probe.vel.y']`);
  await setInput('dialog[open] .prop-field:nth-of-type(4) .num-input', 9);
  await waitFor(`${saved}.bodies[0].vel.x === 9`);
  assert.equal(await evaluate(`${saved}.bodies[0].vel.y`), 8, '解除绑定保留值且不再被参数修改');
  await key('Escape');
  await waitFor("!document.querySelector('dialog[open]')");
  for (let i = 0; i < 4; i++) await clickText('撤销', '.app-header');
  await waitFor(`${saved}.rev === ${beforeBindings.rev}`);
  assert.deepEqual(await evaluate(saved), beforeBindings);
  console.log('PASS 速度柄、属性、参数联动及共享绑定建立解除');

  const beforeZoom = await evaluate(`localStorage.getItem('phy.scene.v2')`);
  await click('[aria-label="放大画布"]');
  await click('[aria-label="缩小画布"]');
  assert.equal(await evaluate("localStorage.getItem('phy.scene.v2')"), beforeZoom, '触屏缩放不改变物理状态');
  await clickText('检查并求解', '.app-header');
  await waitFor("document.querySelector('dialog[open]')?.getAttribute('aria-label') === '答案与推导'");
  await key('Escape');
  await click('.timeline button');
  await waitFor("Number(document.querySelector('.time-slider').value) > 0.05");
  await click('.timeline button');
  const t = await evaluate("document.querySelector('.time-slider').value");
  await evaluate('new Promise(requestAnimationFrame)');
  assert.equal(await evaluate("document.querySelector('.time-slider').value"), t, '暂停冻结');
  assert.equal(await evaluate("localStorage.getItem('phy.scene.v2')"), beforeZoom, '播放不改变初始条件');
  const animationMatches = await evaluate(`(async () => { const {solve} = await import('/src/solver/index.ts'); const scene = ${saved}; const result = solve(scene); if (!result.ok) return false; const t = Number(document.querySelector('.time-slider').value); const state = result.solution.evalAt(t); const camera = JSON.parse(localStorage.getItem('phy.view.v1')); const dot = document.querySelector('.moving-body circle'); const tolerance = Math.max(1, Number(document.querySelector('.time-slider').step) * camera.scale * (Math.abs(state.vx) + Math.abs(state.vy) + 1)); return Math.abs(Number(dot.getAttribute('cx')) - camera.ox - state.x*camera.scale) < tolerance && Math.abs(Number(dot.getAttribute('cy')) - camera.oy + state.y*camera.scale) < tolerance; })()`);
  assert.equal(animationMatches, true, '动画坐标与同一求解结果一致');
  await click('.time-slider');
  await key('End');
  await waitFor("Math.abs(Number(document.querySelector('.time-slider').value) - Number(document.querySelector('.time-slider').max)) < Number(document.querySelector('.time-slider').step) / 2");
  await click('.timeline button');
  await waitFor("Number(document.querySelector('.time-slider').value) > 0.03 && Number(document.querySelector('.time-slider').value) < Number(document.querySelector('.time-slider').max) - 0.1");
  await click('.timeline button');
  await clickText('重置', '.timeline');
  await waitFor("document.querySelector('.time-slider').value === '0'");
  console.log('PASS 触屏缩放、求解、播放、暂停和重置');

  await click('.panel-tabs button:nth-child(2)');
  await click('dialog[open] .prop-field:nth-of-type(2) .num-input');
  await click('dialog[open] .window-close');
  await click('.panel-tabs button:nth-child(3)');
  assert.equal(await evaluate("!!document.querySelector('dialog[open] .result-head .badge.ok')"), true, '仅聚焦和离开数值输入不使正式结果失效');
  await key('Escape');

  await click('.panel-tabs button:first-child');
  const sceneBeforeSlider = await evaluate(saved);
  const beforeSlider = sceneBeforeSlider.params[0].value;
  await drag('dialog[open] .param-block .slider', 35, 0, true, true);
  await waitFor(`${saved}.params[0].value !== ${beforeSlider}`);
  await click('dialog[open] .window-close');
  await clickText('撤销', '.app-header');
  await waitFor(`${saved}.params[0].value === ${beforeSlider}`);
  assert.deepEqual(await evaluate(saved), sceneBeforeSlider, '撤销滑块不得同时撤销前一次属性修改');
  console.log('PASS 输入空操作不修改物理状态、滑块取消后一次撤销');

  await resize(320, 640, true);
  await waitFor("document.querySelector('.canvas-wrap svg')?.getAttribute('width') === '320'");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 320'), true, '320px 无横向溢出');
  assert.equal(await evaluate("document.querySelector('.canvas-wrap').clientHeight >= 180"), true, '320px 仍可操作画布');
  await screenshot('small');
  await click('.panel-tabs button:nth-child(5)');
  if (await evaluate("document.querySelector('.panel-drawer[open]').textContent.includes('本地演示模式')")) {
    const beforeAi = await evaluate(saved);
    await clickText('生成场景草稿', '.panel-drawer[open]');
    await waitFor("document.querySelector('dialog[open] .draft-row')");
    assert.deepEqual(await evaluate(saved), beforeAi, '生成草稿不替换当前场景');
    await clickText('取消', '.panel-drawer[open]');
    await waitFor("!document.querySelector('dialog[open]')");
    assert.deepEqual(await evaluate(saved), beforeAi, '取消草稿保留场景');
    await click('.panel-tabs button:nth-child(5)');
    await clickText('生成场景草稿', '.panel-drawer[open]');
    await waitFor("document.querySelector('dialog[open] .draft-row')");
    await clickText('应用替换场景（可撤销）', '.panel-drawer[open]');
    await waitFor(`${saved}.bodies[0].kind === 'block'`);
    await key('Escape');
    await clickText('撤销', '.app-header');
    await waitFor(`${saved}.bodies[0].id === 'probe'`);
    assert.deepEqual(await evaluate(saved), beforeAi, 'AI 演示替换可完整撤销');
    console.log('PASS 320px AI 演示生成、审阅、取消、替换与撤销');
  } else {
    await key('Escape');
    console.log('SKIP 未调用真实 AI 服务（P3 范围）');
  }

  const beforeSave = await evaluate(saved);
  await send('Page.reload');
  await waitFor("document.querySelector('.body-projectile') && !document.querySelector('.timeline button').disabled");
  assert.deepEqual(await evaluate(saved), beforeSave, '刷新恢复');
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: profile, eventsEnabled: true }, false);
  const downloaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('导出下载超时')), 10000);
    onDownload = (guid) => { clearTimeout(timer); resolve(join(profile, guid)); };
  });
  await clickText('导出', '.app-header');
  const exportedPath = await downloaded;
  assert.deepEqual(JSON.parse(await readFile(exportedPath, 'utf8')), beforeSave, '导出文件保存完整场景');
  await loadFixture('factory.inclineExample()');
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.app-header input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [exportedPath] });
  await waitFor(`${saved}.bodies[0].id === 'probe'`);
  assert.deepEqual(await evaluate(saved), beforeSave, '导入导出保持模型等价');
  console.log('PASS 本地刷新恢复、真实文件导出与导入');

  await resize(1440, 1000);
  await waitFor("document.querySelectorAll('.floating-window[open]').length === 4");
  assert.equal(await evaluate("localStorage.getItem('phy.windows.v1')"), desktopLayout, '返回桌面恢复原布局');
  await screenshot('desktop');
  const beforeWindows = await evaluate(saved);
  await drag('.floating-window[aria-label="属性"] .floating-title', -80, 15);
  await drag('.floating-window[aria-label="属性"] .resize-handle', 40, 40);
  assert.deepEqual(await evaluate(saved), beforeWindows, '浮窗移动缩放不改物理状态');
  await click('.floating-window[aria-label="对象与代数"] .row.selectable');
  await click('.floating-window[aria-label="属性"] .prop-field:nth-of-type(4) button');
  await waitFor(`${saved}.params[1].value === null && ${saved}.bodies[0].vel.x === null`);
  await waitFor("document.querySelector('.timeline button').disabled");
  await clickText('撤销', '.app-header');
  await waitFor(`${saved}.params[1].value === 6`);
  assert.deepEqual(await evaluate(saved), beforeSave, '未知值不被当作已知 0，撤销恢复完整模型');

  await loadFixture('factory.inclineExample()');
  const inclineBefore = await evaluate(saved);
  for (let i = 0; i < 4; i++) await click('.floating-window[open] .window-close');
  await click('.support-line');
  await drag('.selected .handle:nth-of-type(2)', 40, -20);
  await waitFor(`${saved}.supports[0].length !== ${inclineBefore.supports[0].length}`);
  const inclineAfter = await evaluate(saved);
  assert.equal(inclineAfter.bodies[0].attach.support, inclineBefore.bodies[0].attach.support, '调整斜面保持依附关系');
  assert.equal(inclineAfter.bodies[0].attach.s, inclineAfter.supports[0].length, '位于末端的物体随端点移动');
  assert.equal(inclineAfter.params.find(p => p.name === 'theta').value, inclineAfter.supports[0].angleDeg);
  await clickText('撤销', '.app-header');
  await waitFor(`${saved}.rev === ${inclineBefore.rev}`);
  assert.deepEqual(await evaluate(saved), inclineBefore, '斜面端点拖动一次撤销');
  await clickText('重做', '.app-header');
  await waitFor(`${saved}.rev === ${inclineAfter.rev}`);
  assert.deepEqual(await evaluate(saved), inclineAfter, '斜面端点重做');
  const beforePan = await evaluate(saved);
  await drag('.canvas-wrap svg', 60, 20);
  assert.deepEqual(await evaluate(saved), beforePan, '空白平移不改物理条件');
  await click('.toolbar-menu:nth-child(2) summary');
  await clickText('抛体', '.toolbar-menu:nth-child(2)');
  await click('.canvas-wrap svg');
  await waitFor(`${saved}.bodies.length === 2`);
  await clickText('撤销', '.app-header');
  await waitFor(`${saved}.bodies.length === 1`);
  assert.deepEqual(await evaluate(saved), beforePan, '创建对象后一次撤销');
  console.log('PASS 桌面未知值、斜面约束、端点撤销重做、平移与创建');
  assert.deepEqual(errors, [], '无相关控制台错误与运行时异常');
  console.log('PASS P2 浏览器回归');
} finally {
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  chrome.kill();
  if (chrome.exitCode === null) await new Promise((resolve) => chrome.once('exit', resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
