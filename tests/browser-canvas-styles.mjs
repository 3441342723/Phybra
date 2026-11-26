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


  await resize(1440,1000);
  await send('Page.navigate',{url});
  await waitFor("document.querySelector('.canvas-label-box')");
  const labels = await evaluate("[...document.querySelectorAll('.canvas-label')].map(e=>({box:getComputedStyle(e.querySelector('rect')).fill,text:getComputedStyle(e.querySelector('text')).fill,pointer:getComputedStyle(e).pointerEvents}))");
  assert.ok(labels.length>0);
  assert.ok(labels.every(e=>e.box==='rgb(255, 255, 255)' && e.text!=='rgb(0, 0, 0)' && e.pointer==='none'),JSON.stringify(labels));
  const tones=await evaluate(`(()=>{const svg=document.querySelector('.canvas-area>svg');const ns='http://www.w3.org/2000/svg';return ['event','moving','measure','velocity'].map(tone=>{const g=document.createElementNS(ns,'g');g.setAttribute('class','canvas-label label-'+tone);const text=document.createElementNS(ns,'text');g.append(text);svg.append(g);const fill=getComputedStyle(text).fill;g.remove();return fill;});})()`);
  assert.deepEqual(tones,['rgb(109, 40, 217)','rgb(146, 64, 14)','rgb(14, 116, 144)','rgb(4, 120, 87)']);
  await loadFixture("factory.ELECTROMAGNETIC_EXAMPLES.find(e=>e.id==='crossed-fields').build()");
  const fields=await evaluate("[...document.querySelectorAll('.field-region')].map(e=>({fill:getComputedStyle(e).fill,opacity:getComputedStyle(e).fillOpacity,stroke:getComputedStyle(e).stroke}))");
  assert.equal(fields.length,2);
  assert.ok(fields.every(e=>e.fill!=='rgb(0, 0, 0)'&&e.opacity==='0.1'&&e.stroke!=='none'),JSON.stringify(fields));
  await loadFixture("factory.EXAMPLES.find(e=>e.id==='circular').build()");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.physical-link')).stroke"),'rgb(71, 85, 105)');
  await evaluate("document.querySelector('.timeline button').click()");
  await waitFor("document.querySelector('.initial-body')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.initial-body')).fill"),'none');
  await evaluate("document.querySelector('.timeline button').click()");
  await screenshot('canvas-styles');
  await resize(390,844,true);
  await waitFor("document.querySelector('.canvas-area>svg')?.getAttribute('width')==='390'");
  await loadFixture("factory.ELECTROMAGNETIC_EXAMPLES.find(e=>e.id==='crossed-fields').build()");
  await waitFor("document.querySelector('.canvas-label-box')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.canvas-label-box')).fill"),'rgb(255, 255, 255)');
  assert.deepEqual(errors,[]);
  console.log('PASS 画布标签底色、分类字色、点击穿透、透明场区、绳杆、初始轮廓及窄屏样式');
} finally {
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  chrome.kill();
  if (chrome.exitCode === null) await new Promise((resolve) => chrome.once('exit', resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
