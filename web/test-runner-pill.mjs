// Run after bun web/build.ts, through ptest. Localhost only; no browser packages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { devtoolsPort } from './test-port.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'runner-pill-'));
const server = spawn('python3', ['web/serve.py', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws, seq = 0;
let front, blockRunner = false;
const pending = new Map();
const terminal = setTimeout(() => { console.error('runner pill test deadline'); chrome.kill('SIGKILL'); server.kill('SIGKILL'); process.exitCode = 1; ws?.close(); }, 180000);
function send(method, params = {}, ms = 10000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP deadline: ' + method)); }, ms);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 40000);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function until(expression) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await ev(expression)) return; await pause(100); }
  throw new Error('not ready: ' + expression);
}
const pill = `[...document.querySelectorAll('button')].find(b=>b.textContent==='No sandbox')`;
let bootstrap;
try {
  const upstreamPort = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start deadline')), 10000);
    server.stdout.once('data', data => { clearTimeout(t); resolve(Number(String(data).trim())); });
    server.once('error', reject);
  });
  // Browser frame requests may run in their own DevTools target. Refuse the
  // runner at the localhost server for the fallback case, independent of CDP.
  front = createServer((req, res) => {
    if (blockRunner && req.url.startsWith('/runner/')) return res.writeHead(404).end();
    const up = request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method }, r => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => res.destroy()); req.pipe(up);
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const port = front.address().port;
  const debug = await devtoolsPort(profile, 15000);
  const targets = await (await fetch(`http://127.0.0.1:${debug}/json`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const m = JSON.parse(event.data), p = pending.get(m.id);
    if (!p) return; clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  const navigate = async (path, plain = false, fallback = false) => {
    if (bootstrap) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootstrap });
    bootstrap = plain ? (await send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.userAgentData;' })).identifier : undefined;
    blockRunner = fallback;
    const before = await ev('performance.timeOrigin');
    const url = `http://127.0.0.1:${port}/${path}`;
    await send('Page.navigate', { url });
    await until(`performance.timeOrigin !== ${before} && document.readyState === "complete"`);
  };
  await navigate(''); await until('!!window.sagebrush?.kernel?.ready');
  assert.equal(await ev(`!!(${pill})`), false); console.log('ok flag off: no pill');
  await navigate('?runner-info=1'); await until('!!window.sagebrush?.kernel?.ready');
  assert.equal(await ev(`(${pill}).hidden`), true); console.log('ok real sandbox: pill hidden');
  await navigate('?runner-info=1', true); await until('!!window.sagebrush?.kernel?.ready');
  assert.equal(await ev(`(${pill}).hidden`), false);
  await ev(`(${pill}).click()`);
  assert.equal(await ev(`!!document.querySelector('dialog[open][aria-label="About the code sandbox"]')`), true);
  assert.equal(await ev(`document.querySelector('dialog[open]').textContent.includes('Your own code is fine')`), true);
  await ev(`document.querySelector('dialog[open] button').click()`);
  assert.equal(await ev(`!!document.querySelector('dialog[open]')`), false);
  console.log('ok plain notebook: pill and accessible dismissible modal');
  await ev('sagebrush.kernel.restart()'); await until('sagebrush.kernel.ready');
  assert.equal(await ev(`(${pill}).hidden`), false); console.log('ok notebook restart retains actual runner status');
  await navigate('?runner-info=1', false, true); await until('!!window.sagebrush?.kernel?.ready');
  console.log('fallback state', await ev(`({ua:'userAgentData' in navigator,isolated:crossOriginIsolated,worker:sagebrush.kernel.worker.constructor.name,inner:!!sagebrush.kernel.worker.inner,frames:[...document.querySelectorAll('iframe')].map(f=>f.src)})`));
  assert.equal(await ev('!!sagebrush.kernel.worker.inner'), true);
  assert.equal(await ev(`(${pill}).hidden`), false); console.log('ok Chromium runner fallback: pill visible');
  await navigate('board/?new=python&runner-info=1', true); await until('!!window.sagebrush?.board?.load');
  await ev(`sagebrush.board.load({title:'Runner information',nodes:[{id:'code',code:'print(45)'}]}).then(()=>true)`);
  await until(`!!(${pill}) && !(${pill}).hidden`);
  await ev(`(${pill}).click()`);
  assert.equal(await ev(`!!document.querySelector('dialog[open]')`), true);
  await ev(`document.querySelector('dialog[open] button').click()`);
  console.log('ok board plain worker: pill and modal');
  await navigate('board/?new=python&runner-info=1'); await until('!!window.sagebrush?.board?.load');
  await ev(`sagebrush.board.load({title:'Sandboxed board',nodes:[{id:'code',code:'print(45)'}]}).then(()=>sagebrush.board.run()).then(()=>true)`);
  assert.equal(await ev(`(${pill}).hidden`), true);
  assert.equal(await ev(`!!document.querySelector('iframe[sandbox="allow-scripts"]')`), true);
  console.log('ok board sandbox: pill hidden');
  console.log('runner pill browser checks passed');
} finally {
  clearTimeout(terminal);
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('test closed')); }
  pending.clear(); ws?.close(); chrome.kill('SIGTERM'); server.kill('SIGTERM');
  front?.closeAllConnections(); front?.close();
  await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), pause(1000)]);
  if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await pause(100); }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
