// Remote compute's preview in the notebook page (web/notebook/remote-ui.js,
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
  ok(await ev("!document.querySelector('#remotedlg') && document.querySelector('#kernelpick').value === 'local' && !/Remote compute/.test(document.querySelector('#status').textContent)"),
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
  await until("/Remote compute \\(preview, simulated[^)]*\\) · ready/.test(document.querySelector('#status').textContent)");
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
  await until("/Remote compute \\(preview, simulated[^)]*\\) · ready/.test(document.querySelector('#status').textContent)");
  await sleep(300);
  const o6 = await runCode(C, "print('y' in globals())");
  ok(/False/.test(o6), `after Restart the GPU kernel's variables are gone (${JSON.stringify(o6.slice(0, 80))})`);

  // 7. back to This browser
  await ev("(() => { const p = document.querySelector('#kernelpick'); p.value = 'local'; p.dispatchEvent(new Event('change')); return true; })()");
  await until("/ready \\(sagebrush/.test(document.querySelector('#status').textContent) || !/Remote compute/.test(document.querySelector('#status').textContent)");
  const o7 = await runCode(C, "print(secret)");
  ok(/local only/.test(o7), `This browser again: the browser's interpreter, with its own variables (${JSON.stringify(o7.slice(0, 80))})`);
  // 8. another notebook opened while the Connect sheet is up: the sheet is settled, nothing connects, the picker is This browser
  await pick("gpu");
  await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until("!document.querySelector('#remotedlg')", 15000);
  await sleep(500);
  ok(await ev("document.querySelector('#kernelpick').value === 'local' && !/Remote compute/.test(document.querySelector('#status').textContent)"),
    "opening another notebook while the sheet is up: the sheet goes, nothing connects, the picker is This browser");
  // 9. a slow network (&latency=MS&jitter=MS): what latency changes for a person (William, Oct 29: double-click
  // Run, stale output order, Stop during a slow start, typing during a run)
  for (const lat of [400, 1000]) {
    await goto(base + `?remote=1&latency=${lat}&jitter=${lat / 4}`);
    const L2 = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
    await pick("gpu");
    await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
    await ev("document.querySelector('#remoteallow').click(); true");
    await until(`/Remote compute \\(preview, simulated · ${lat} ms/.test(document.querySelector('#status').textContent)`, 30000);
    ok(true, `${lat} ms: connected, and the status says so: ${await status()}`);
    const cellOut = () => out(L2);
    const busy = () => ev(`(() => { const el = sagebrush.notebook.cells()[${L2}].el; return el.classList.contains('running') || el.classList.contains('queued'); })()`);
    // (a person's Ctrl+Enter in the cell: a Run gesture)
    const ctrlEnter = () => ev(`(() => { const c = sagebrush.notebook.cells()[${L2}]; c.ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    const settle = async () => { await sleep(200); await until(`(() => { const el = sagebrush.notebook.cells()[${L2}].el; return !el.classList.contains('running') && !el.classList.contains('queued'); })()`, 60000); await sleep(lat + 200); };
    // (each check waits for what its own run prints, never for the cell to look idle: under latency a Run's
    // consent and preparation take a round trip before the cell even shows it is queued)
    const waitFor = async (re, ms = 20000 + 8 * lat) => {
      const t = Date.now();
      while (Date.now() - t < ms) { if (re.test(await cellOut())) return true; await sleep(100); }
      return false;
    };
    const idleNow = () => until(`(() => { const el = sagebrush.notebook.cells()[${L2}].el; return !el.classList.contains('running') && !el.classList.contains('queued'); })()`, 60000);
    // (a) double-click Run: never two runs' output
    await setCode(L2, "print('ran once')");
    await ev(`(() => { const b = sagebrush.notebook.cells()[${L2}].runb; b.click(); b.click(); return true; })()`);
    await waitFor(/ran once|Not run|KeyboardInterrupt|interrupted/i);
    await sleep(2 * lat + 500);
    await idleNow();
    const oa = await cellOut();
    ok((oa.match(/ran once/g) ?? []).length <= 1, `${lat} ms: a double-clicked Run shows at most one run's output (${JSON.stringify(oa.slice(0, 120))})`);
    // (b) a quick edit and run again: the newest run's output is what stays
    await setCode(L2, "print('first')");
    await ctrlEnter();
    await sleep(50);
    await setCode(L2, "print('second')");
    await ctrlEnter();
    const gotSecond = await waitFor(/second/);
    await sleep(2 * lat + 500);
    await idleNow();
    const ob = await cellOut();
    ok(gotSecond && /second/.test(ob) && !/first/.test(ob), `${lat} ms: edit and run again quickly: only the newest run's output stays (${JSON.stringify(ob.slice(0, 120))})`);
    // (c) Stop during a slow start: the cell ends, nothing is stuck, and the next run works
    await setCode(L2, "print('started')");
    await ctrlEnter();
    await sleep(Math.min(100, lat / 4));
    await ev("document.querySelector('#stop').click(); true");
    await sleep(2 * lat + 500);
    await idleNow();
    const oc = await cellOut();
    ok(!(await busy()), `${lat} ms: Stop during a slow start: the cell isn't left running (${JSON.stringify(oc.slice(0, 120))})`);
    await setCode(L2, "print('after stop')");
    await ctrlEnter();
    ok(await waitFor(/after stop/), `${lat} ms: and the next run works`);
    await idleNow();
    // (d) typing during a run: the run's own output arrives; the edited text is what runs next
    await setCode(L2, "import time\ntime.sleep(1.2)\nprint('slow done')");
    await ctrlEnter();
    await sleep(lat / 2 + 300);
    await setCode(L2, "print('typed meanwhile')");
    const endedD = await waitFor(/slow done|Not run/);
    await idleNow();
    const od = await cellOut();
    const edited = await ev(`sagebrush.notebook.cells()[${L2}].el.classList.contains('edited')`);
    ok(endedD, `${lat} ms: typing during a run: the run ends with its own output or a clear note (${JSON.stringify(od.slice(0, 120))}; edited ${edited})`);
    await ctrlEnter();
    ok(await waitFor(/typed meanwhile/), `${lat} ms: and the typed text is what runs next (${JSON.stringify((await cellOut()).slice(0, 120))})`);
    await idleNow();
    if (lat === 1000) await shot("remote-latency-1000.png");
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
