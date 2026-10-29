// The GPU kernel's preview in the notebook page (web/notebook/remote-ui.js,
// sagebrush-remote.js), end to end in headless Chromium: the picker only
// with ?remote=1, the Connect sheet, a cell run by a person's Run (approved,
// sent through the simulated gateway, executed in a second interpreter), a
// run without a gesture refused, variables apart from the browser's own
// interpreter, Restart, and back to "This browser".  It serves web/dist
// itself (web/serve.py on a port of the system's choice):
//   bun web/build.ts && node web/test-remote-preview.mjs      (CHROME=... for another browser binary;
//   SHOTS=dir saves screenshots of the Connect sheet and of a cell run on the GPU kernel there)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const profile = mkdtempSync(join(tmpdir(), "sb-remote-preview-"));
let server = null, chrome = null, ws = null;
try {
  const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
  const port = await serve.port;
  const base = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  const paused = []; // (Fetch.requestPaused events: a request held until the test continues it)
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    else if (m.method === "Fetch.requestPaused") paused.push(m.params);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const goto = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("!!(window.sagebrush && window.sagebrush.notebook) && /ready/.test(document.querySelector('#status').textContent)", 60000); };
  const status = () => ev("document.querySelector('#status').textContent");
  const out = (i) => ev(`sagebrush.notebook.cells()[${i}].el.querySelector('.out')?.textContent ?? ''`);
  const setCode = (i, code) => ev(`(() => { const nb = sagebrush.notebook, c = nb.cells()[${i}]; nb.setInput(c, ${JSON.stringify(code)}); return true; })()`);
  // (a person's Run: the cell's own Run button, whose handler captures their consent)
  const clickRun = (i) => ev(`(() => { sagebrush.notebook.cells()[${i}].runb.click(); return true; })()`);
  const idle = (i) => until(`(() => { const el = sagebrush.notebook.cells()[${i}].el; return !el.classList.contains('running') && !el.classList.contains('queued'); })()`);
  // (a person's Run of new code, waited for: its output, once it has a fresh one (each code prints a marker))
  let mark = 0;
  const runCode = async (i, code) => {
    const m = `@@${++mark}@@`;
    await setCode(i, `print(${JSON.stringify(m)})\n${code}`);
    await clickRun(i);
    await until(`(sagebrush.notebook.cells()[${i}].el.querySelector('.out')?.textContent ?? '').includes(${JSON.stringify(m)})`, 120000);
    await idle(i);
    return (await out(i)).replace(m, "").trim();
  };
  const shot = async (name) => {
    if (!process.env.SHOTS) return;
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r?.data) writeFileSync(join(process.env.SHOTS, name), Buffer.from(r.data, "base64"));
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");

  // 1. without ?remote=1: no picker
  await goto(base);
  ok(await ev("document.querySelector('#kernelpick').hidden === true"), "without ?remote=1 the picker is hidden");

  // 2. with it: the picker; File > New gives a fresh notebook
  await goto(base + "?remote=1");
  ok(await ev("document.querySelector('#kernelpick').hidden === false && document.querySelector('#kernelpick').value === 'local'"), "with ?remote=1 the picker shows, on This browser");
  // (a code cell of its own, at the end of the notebook the page opened)
  // (two: L defines a name in the browser's interpreter; C is run on each kernel. In the reactive notebook a
  // cell's new code forgets the names its old code defined, so the name lives in a cell of its own.)
  const L = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
  const C = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
  ok(Number.isInteger(L) && C === L + 1 && (await ev(`sagebrush.notebook.cells()[${C}].type === 'code'`)), `two code cells to run (${L}, ${C})`);
  await runCode(L, "secret = 'local only'");

  // 2b. the module's load held (the first GPU choice imports sagebrush-remote.js): This browser is chosen meanwhile;
  // when the load finishes, nothing is shown or connected (astra P1D-A1)
  await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-remote.js*", requestStage: "Request" }] });
  const pick = (v) => ev(`(() => { const p = document.querySelector('#kernelpick'); p.value = ${JSON.stringify(v)}; p.dispatchEvent(new Event('change')); return true; })()`);
  await pick("gpu");
  for (let i = 0; i < 100 && !paused.length; i++) await sleep(50);
  ok(paused.length === 1, "the module's load is held");
  await pick("local");
  await send("Fetch.continueRequest", { requestId: paused[0].requestId });
  await send("Fetch.disable");
  await sleep(800);
  ok(await ev("!document.querySelector('#remotedlg') && document.querySelector('#kernelpick').value === 'local' && !/GPU kernel/.test(document.querySelector('#status').textContent)"),
    "the load finishing after This browser was chosen shows no sheet and connects nothing");

  // 3. GPU: the Connect sheet
  await ev("(() => { const p = document.querySelector('#kernelpick'); p.value = 'gpu'; p.dispatchEvent(new Event('change')); return true; })()");
  await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
  const sheet = await ev("document.querySelector('#remotedlg').textContent");
  ok(/simulated/.test(sheet) && /nothing is billed/i.test(sheet) && /Proposed spending cap/.test(sheet) && /confirm the cap on CoCalc's page/.test(sheet), "the Connect sheet: simulated, unbilled, the proposed cap and its note");
  ok(await ev("document.activeElement !== document.querySelector('#remoteallow')"), "focus isn't on Connect (Enter doesn't connect)");
  // (Cancel: back to This browser)
  await ev("document.querySelector('#remotecancel').click(); true");
  await until("!document.querySelector('#remotedlg') && document.querySelector('#kernelpick').value === 'local'");
  ok(true, "Cancel closes the sheet and stays on This browser");
  await ev("(() => { const p = document.querySelector('#kernelpick'); p.value = 'gpu'; p.dispatchEvent(new Event('change')); return true; })()");
  await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
  await shot("remote-connect-sheet.png");
  await ev("document.querySelector('#remoteallow').click(); true");
  await until("/GPU kernel \\(preview, simulated\\) · ready/.test(document.querySelector('#status').textContent)");
  ok(true, `connected: ${await status()}`);

  // 4. a person's Run: approved, sent, executed
  const o0 = await runCode(C, "x = 6 * 7\nprint('on the GPU kernel')\nx");
  await ev(`(() => { sagebrush.notebook.cells()[${C}].el.scrollIntoView({ block: "center" }); return true; })()`);
  await shot("remote-gpu-run.png");
  ok(/on the GPU kernel/.test(o0) && /42/.test(o0), `a Run runs the cell on the GPU kernel (${JSON.stringify(o0.slice(0, 80))})`);
  // (the gateway's own record: one run, delivered, with this cell's code)
  // (variables are the remote kernel's: the browser's own interpreter's aren't there)
  const o4 = await runCode(C, "print('secret' in globals())");
  ok(/False/.test(o4), `the GPU kernel's variables are its own: the browser interpreter's 'secret' isn't there (${JSON.stringify(o4.slice(0, 80))})`);

  // 5. a run without a person's Run gesture isn't approved: never sent
  await setCode(C, "print('sneaky')");
  const before = await out(C);
  await ev(`(async () => { await sagebrush.notebook.run(sagebrush.notebook.cells()[${C}]); return true; })()`);
  await sleep(500);
  const o5 = await out(C);
  await shot("remote-not-approved.png");
  ok(!/sneaky/.test(o5), `a run without the person's Run is not sent (output ${JSON.stringify(o5.slice(0, 80))}, was ${JSON.stringify(before.slice(0, 40))})`);

  // 6. Restart: the remote kernel's variables are gone
  const oy = await runCode(C, "y = 1\nprint('y' in globals())");
  ok(/True/.test(oy), `y is set on the GPU kernel (${JSON.stringify(oy.slice(0, 80))})`);
  await ev("document.querySelector('#restart').click(); true");
  await until("/GPU kernel \\(preview, simulated\\) · ready/.test(document.querySelector('#status').textContent)");
  await sleep(300);
  const o6 = await runCode(C, "print('y' in globals())");
  ok(/False/.test(o6), `after Restart the GPU kernel's variables are gone (${JSON.stringify(o6.slice(0, 80))})`);

  // 7. back to This browser
  await ev("(() => { const p = document.querySelector('#kernelpick'); p.value = 'local'; p.dispatchEvent(new Event('change')); return true; })()");
  await until("/ready \\(sagebrush/.test(document.querySelector('#status').textContent) || !/GPU kernel/.test(document.querySelector('#status').textContent)");
  const o7 = await runCode(C, "print(secret)");
  ok(/local only/.test(o7), `This browser again: the browser's interpreter, with its own variables (${JSON.stringify(o7.slice(0, 80))})`);
  // 8. another notebook opened while the Connect sheet is up: the sheet is settled, nothing connects, the picker is This browser
  await pick("gpu");
  await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until("!document.querySelector('#remotedlg')", 15000);
  await sleep(500);
  ok(await ev("document.querySelector('#kernelpick').value === 'local' && !/GPU kernel/.test(document.querySelector('#status').textContent)"),
    "opening another notebook while the sheet is up: the sheet goes, nothing connects, the picker is This browser");
  // 9. the same cell run again and again, and a syntax error (William, Oct 29: his cell, with a stray | typed at its
  // end, ended with "Not run: a remote run must be approved first." on every Run: a syntax error's own path ran the
  // cell without the approval gate).  Each Run completes; a syntax error shows the SyntaxError and sends nothing.
  {
    await goto(base + "?remote=1");
    const W = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
    await pick("gpu");
    await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
    await ev("document.querySelector('#remoteallow').click(); true");
    await until("/GPU kernel \\(preview, simulated\\) · ready/.test(document.querySelector('#status').textContent)");
    // (each run of code the page submits: the remote client's POSTs of runs with code; a forget's, of the names
    // a cell's old text defined, has none)
    await ev(`(() => { window.__runs = 0; const cl = sagebrush.notebook.kernel.client, f = cl.fetch;
      cl.fetch = (u, i) => { if (i?.method === 'POST' && /\\/runs$/.test(String(u))) { try { if (JSON.parse(i.body).payload.code) __runs++; } catch { __runs++; } } return f(u, i); }; return true; })()`);
    const runs = () => ev("__runs");
    const code = "import time; [print(i) or time.sleep(0.1) for i in range(8)]";
    const all8 = /0\s+1\s+2\s+3\s+4\s+5\s+6\s+7/;
    const doneW = `(() => { const el = sagebrush.notebook.cells()[${W}].el; return !el.classList.contains('running') && !el.classList.contains('queued'); })()`;
    await setCode(W, code);
    let good = 0, refused = 0;
    for (let i = 0; i < 10; i++) {
      const before = await runs();
      await clickRun(W);
      try { await until(`__runs > ${before}`, 20000); } catch {}
      try { await until(doneW, 30000); } catch {}
      const o = await out(W);
      if (/approved first/.test(o)) refused++;
      else if (all8.test(o)) good++;
    }
    ok(good === 10 && refused === 0, `the same cell, 10 Runs waited for: each completes (${good} of 10; refused as unapproved ${refused})`);
    // (quickly: Ctrl+Enter, a person's Run that never means Stop, every 150 ms)
    const ctrlEnter = () => ev(`(() => { const c = sagebrush.notebook.cells()[${W}]; c.ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    const bq = await runs();
    for (let i = 0; i < 10; i++) { await ctrlEnter(); await sleep(150); }
    try { await until(`__runs > ${bq}`, 20000); } catch {}
    await sleep(500);
    try { await until(doneW, 60000); } catch {}
    const oq = await out(W);
    ok(all8.test(oq) && !/approved first/.test(oq), `the same cell, 10 quick Runs: it ends with its output, never refused as unapproved (${(await runs()) - bq} sent; ${JSON.stringify(oq.replace(/\s+/g, " ").slice(0, 80))})`);
    // (his text, with the stray | at its end: the SyntaxError is shown, and nothing is sent)
    const bs = await runs();
    await setCode(W, code + "|");
    await clickRun(W);
    try { await until(`/SyntaxError/.test(sagebrush.notebook.cells()[${W}].el.querySelector('.out')?.textContent ?? '')`, 20000); } catch {}
    await sleep(500);
    const os = await out(W);
    ok(/SyntaxError/.test(os) && !/approved first/.test(os) && !/SyntaxError: SyntaxError/.test(os) && (await runs()) === bs,
      `a syntax error on the GPU kernel: the SyntaxError is shown, nothing is sent (${JSON.stringify(os.replace(/\s+/g, " ").slice(0, 100))})`);
    // (fixed: the next Run runs it)
    await setCode(W, code);
    await clickRun(W);
    try { await until(`__runs > ${bs}`, 20000); } catch {}
    try { await until(doneW, 30000); } catch {}
    ok(all8.test(await out(W)), `and once it's fixed, a Run runs it (${JSON.stringify((await out(W)).replace(/\s+/g, " ").slice(0, 80))})`);
  }
} catch (e) {
  ok(false, `the test ran to its end: ${e?.message ?? e}`);
  try {
    const d = await ev("JSON.stringify({ status: document.querySelector('#status').textContent, pick: document.querySelector('#kernelpick').value, cells: sagebrush.notebook.cells().map((c) => ({ cls: c.el.className, code: c.ta.value.slice(0, 60), out: (c.el.querySelector('.out')?.textContent ?? '').slice(0, 200) })) })");
    console.log("state at the failure: " + d);
  } catch (d) { console.log("state at the failure: (unavailable: " + (d?.message ?? d) + ")"); }
} finally {
  try { ws?.close(); } catch {}
  try { chrome?.kill("SIGKILL"); } catch {}
  try { server?.kill("SIGKILL"); } catch {}
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(process.exitCode ? "FAILED" : "all passed");
