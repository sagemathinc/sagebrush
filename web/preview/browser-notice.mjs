// Small real-browser control for the prepared preview, with its real CSP.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../../scripts/preview/prepare.mjs';
import { devtoolsPort } from '../test-port.mjs';

export async function checkNoticeBrowser() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-notice-'));
  const profile = mkdtempSync(join(tmpdir(), 'preview-notice-chrome-'));
  let chrome, ws, server, sequence = 0;
  const pending = new Map(), violations = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const source = { branch: 'feature/<img src=x onerror=alert(1)>', commit: 'a'.repeat(40), dirty: true };
  const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'";
  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><html><head><style>
    *{box-sizing:border-box}body{margin:0}.tex-page{position:fixed;inset:0}.sbfiles{position:fixed;left:0;top:0;bottom:0;width:100%;height:100%;display:flex;flex-direction:column;background:white}.fh{display:flex;justify-content:flex-end;gap:8px;padding:12px}.ftree{flex:1}.ffoot{padding:8px}button{min-height:30px}
    </style><script src="/app.js" defer></script></head><body><div class="tex-page"><aside id="wssidebar" class="sbfiles" aria-label="Files"><div class="fh"><button aria-label="New">New</button><button aria-label="Upload">Upload</button><button aria-label="More">More</button></div><div class="ftree">Files</div><div class="ffoot"><button id="folder-control">Folder controls</button></div></aside></div></body></html>`);
  writeFileSync(join(dir, 'app.js'), "document.querySelector('[aria-label=New]').onclick=()=>{window.newClicked=true}; addEventListener('securitypolicyviolation',e=>console.error('CSP:'+e.violatedDirective));");
  writeFileSync(join(dir, '_headers'), '/*\n  Content-Security-Policy: ' + policy + '\n');
  const output = prepare(dir, '127.0.0.1', [], source);
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP deadline: ' + method)); }, 5000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  }
  async function until(expression) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await ev(expression)) return; await pause(50); }
    throw new Error('Not ready: ' + expression);
  }
  async function click(selector) {
    const p = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b}})()`);
    assert.equal(p.hit, true, selector + ' must be reachable by a real pointer');
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  try {
    server = createServer((req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
      const file = output.files.get(path);
      if (!file || path.startsWith('.')) return res.writeHead(404).end();
      res.setHeader('content-type', file.type);
      if (path.endsWith('.html')) res.setHeader('content-security-policy', JSON.parse(output.files.get('.preview/headers/' + path + '.json').bytes).csp);
      res.end(file.bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const port = await devtoolsPort(profile, 15000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('CDP socket deadline')), 5000); ws.onopen = () => { clearTimeout(t); resolve(); }; ws.onerror = reject; });
    ws.onmessage = event => {
      const m = JSON.parse(event.data), p = pending.get(m.id);
      if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') violations.push(m.params.args.map(a => a.value).join(' '));
      if (m.method === 'Log.entryAdded' && /Content Security Policy|violates/.test(m.params.entry.text)) violations.push(m.params.entry.text);
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await until('!!document.getElementById("sb-preview-pill")');
    const geometry = await ev(`(()=>{const p=document.getElementById('sb-preview-pill').getBoundingClientRect(), f=document.querySelector('.ffoot').getBoundingClientRect(); return {width:innerWidth,left:p.left,top:p.top,bottom:p.bottom,controlsBottom:f.bottom,height:innerHeight}})()`);
    assert.equal(geometry.width, 390); assert.ok(geometry.left >= 0 && geometry.left <= 12);
    assert.ok(geometry.bottom <= geometry.height && geometry.top >= geometry.controlsBottom, JSON.stringify(geometry));
    for (const selector of ['[aria-label=New]', '[aria-label=Upload]', '[aria-label=More]', '#folder-control']) await click(selector);
    assert.equal(await ev('window.newClicked'), true);
    await click('#sb-preview-pill');
    await until('document.getElementById("sb-preview-dialog").open');
    const text = await ev('document.getElementById("sb-preview-dialog").textContent');
    for (const expected of ['unmerged branch', 'no accounts or cloud sync', 'stays in this browser', '14 days', source.branch, source.commit]) assert.ok(text.includes(expected), expected);
    assert.equal(await ev('!!document.querySelector("#sb-preview-dialog img")'), false);
    await click('#sb-preview-dialog button');
    assert.equal(await ev('sessionStorage.getItem("sagebrush-preview-notice-hidden")'), '1');
    assert.equal(await ev('!!document.getElementById("sb-preview-pill")'), false);
    await send('Page.reload'); await until('!!document.querySelector("[aria-label=New]") && document.readyState === "complete"');
    assert.equal(await ev('!!document.getElementById("sb-preview-pill")'), false);
    await click('[aria-label=New]');
    await ev('sessionStorage.clear()'); await send('Page.reload'); await until('!!document.getElementById("sb-preview-pill")');
    assert.deepEqual(violations, []);
    return geometry;
  } finally {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('test closed')); }
    ws?.close(); chrome?.kill('SIGTERM'); server?.closeAllConnections(); server?.close();
    if (chrome && chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), pause(1000)]);
    if (chrome && chrome.exitCode === null) { chrome.kill('SIGKILL'); await pause(100); }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); rmSync(dir, { recursive: true, force: true });
  }
}
