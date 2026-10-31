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
  // 9. the same cell run again and again, and a syntax error (William, Oct 29: his cell, with a stray | typed at its
  // end, ended with "Not run: a remote run must be approved first." on every Run: a syntax error's own path ran the
  // cell without the approval gate).  Each Run completes; a syntax error shows the SyntaxError and sends nothing.
  {
    await goto(base + "?remote=1");
    const W = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
    await pick("gpu");
    await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
    await ev("document.querySelector('#remoteallow').click(); true");
    await until("/Remote compute \\(preview, simulated[^)]*\\) · ready/.test(document.querySelector('#status').textContent)");
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
  // 10. a slow network (&latency=MS&jitter=MS): what latency changes for a person (William, Oct 29: double-click
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
    // (what the simulated gateway actually executed: each run's code, in order)
    const execs = (code) => ev(`sagebrush.notebook.kernel.gateway.executions.filter((x) => x.code === ${JSON.stringify(code)}).length`);
    const execList = () => ev("sagebrush.notebook.kernel.gateway.executions.map((x) => x.code)");
    const idleNow = () => until(`(() => { const el = sagebrush.notebook.cells()[${L2}].el; return !el.classList.contains('running') && !el.classList.contains('queued'); })()`, 60000);
    // (a) double-click Run: never two runs' output
    await setCode(L2, "print('ran once')");
    await ev(`(() => { const b = sagebrush.notebook.cells()[${L2}].runb; b.click(); b.click(); return true; })()`);
    await waitFor(/ran once|Not run|KeyboardInterrupt|interrupted/i);
    await sleep(2 * lat + 500);
    await idleNow();
    const oa = await cellOut();
    ok((await execs("print('ran once')")) <= 1, `${lat} ms: a double-clicked Run executes at most once at the gateway (${await execs("print('ran once')")}; output ${JSON.stringify(oa.slice(0, 80))})`);
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
    // (e) A held in flight, then B Run twice: B is queued once and executes exactly once (astra LAT-A1)
    const tag = `${lat}`;
    const A = `import time\ntime.sleep(1.5)\nprint('A${tag}')`, B = `print('B${tag}')`, Cc = `print('C${tag}')`;
    await setCode(L2, A);
    await ctrlEnter();
    await sleep(lat / 2 + 200);
    await setCode(L2, B);
    await ctrlEnter();
    await ctrlEnter();
    ok(await waitFor(new RegExp(`B${tag}`)), `${lat} ms: B's output arrives after A`);
    await sleep(2 * lat + 800);
    await idleNow();
    ok((await execs(A)) === 1 && (await execs(B)) === 1, `${lat} ms: A held, B Run twice: A executed once, B exactly once (A ${await execs(A)}, B ${await execs(B)})`);
    // (f) distinct A, B, C while A is in flight: each executes at most once, in order, and C (the newest) last
    const before = (await execList()).length;
    const A2 = A.replace(`A${tag}`, `A2${tag}`);
    await setCode(L2, A2);
    await ctrlEnter();
    await sleep(lat / 2 + 200);
    await setCode(L2, B.replace(`B${tag}`, `B2${tag}`));
    await ctrlEnter();
    await sleep(50);
    await setCode(L2, Cc);
    await ctrlEnter();
    ok(await waitFor(new RegExp(`C${tag}`)), `${lat} ms: C's output arrives`);
    await sleep(2 * lat + 800);
    await idleNow();
    const ran = (await execList()).slice(before);
    const counts = [A2, B.replace(`B${tag}`, `B2${tag}`), Cc].map((x) => ran.filter((y) => y === x).length);
    ok(counts.every((n) => n <= 1) && ran[0] === A2 && ran.at(-1) === Cc && /C/.test(await cellOut()) && !/B2/.test(await cellOut()),
      `${lat} ms: A, B, C in turn: each executed at most once, A first, C last, C's output shown (${JSON.stringify(ran)})`);
    if (lat === 1000) await shot("remote-latency-1000.png");
  }
  // (connect the page's notebook to remote compute: the sheet, Connect, and the status says it's ready)
  const connect = async (lat) => {
    await pick("gpu");
    await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
    await ev("document.querySelector('#remoteallow').click(); true");
    await until(`/Remote compute \\(preview, simulated · ${lat} ms[^)]*\\) · ready/.test(document.querySelector('#status').textContent)`, 60000);
  };
  const newCell = () => ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
  // 11. what one simple run costs at 400 ms, on a clean link: its requests, and the time from Run to its output
  {
    const lat = 400;
    await goto(base + `?remote=1&latency=${lat}`);
    const R = await newCell();
    await connect(lat);
    // (every request the page's remote client makes: method, path, when it was asked and answered)
    await ev(`(() => { window.__rq = []; const cl = sagebrush.notebook.kernel.client, f = cl.fetch;
      cl.fetch = (u, i) => { const e = { m: i?.method ?? 'GET', u: String(u).replace(/^.*\\/v1/, '').replace(/rq\\.[^/?]+/, 'RQ'), t0: performance.now() }; __rq.push(e);
        return f(u, i).then((r) => { e.t1 = performance.now(); return r; }); }; return true; })()`);
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      const o = await runCode(R, "2+2");
      times.push(Date.now() - t);
      if (!/\b4\b/.test(o)) ok(false, `2+2 printed 4 (${JSON.stringify(o.slice(0, 80))})`);
    }
    const rq = await ev("__rq.map((e) => `${e.m} ${e.u}`)");
    const perRun = rq.length / 5;
    times.sort((a, b) => a - b);
    console.log(`info 400 ms: one 2+2 run's requests: ${JSON.stringify(rq.slice(0, perRun))}; Run to output, ms (5 runs): ${JSON.stringify(times)}`);
    ok(perRun <= 2 && rq.every((x) => /^POST \/bindings\/[^/]+\/runs$|^GET \/bindings\/[^/]+\/runs\/RQ\/events/.test(x)), `400 ms: one simple run is ${perRun} requests (submit, then its events), nothing else`);
    // (two round trips, the submit's and the events', plus the stream's last leg and the page's own work)
    ok(times[2] <= 3 * lat + 800, `400 ms: 2+2 shows its output in about two round trips (median ${times[2]} ms, at most ${3 * lat + 800})`);
  }
  // 12. a lossy link (William, Oct 29: latency=400 jitter=50 loss=10): 20 cells run at once; every run settles (its
  // output, or a note that says why it didn't run), the page never switches to This browser by itself, and the kernel
  // still runs a cell afterwards, with no reload
  {
    const lat = 400;
    await goto(base + `?remote=1&latency=${lat}&jitter=50&loss=10`);
    const first = await newCell();
    for (let i = 1; i < 20; i++) await newCell();
    await connect(lat);
    ok(/10% loss/.test(await status()), `loss=10 is 10%, and the status line says so: ${await status()}`);
    // (watching, from here on: the picker leaving remote compute, or the notebook's kernel replaced)
    await ev(`(() => { window.__k = sagebrush.notebook.kernel; window.__left = 0;
      window.__iv = setInterval(() => { if (document.querySelector('#kernelpick').value !== 'gpu' || sagebrush.notebook.kernel !== __k) __left++; }, 50); return true; })()`);
    const cells = Array.from({ length: 20 }, (_, i) => first + i);
    for (const i of cells) await setCode(i, `print('@@L${i}@@')`);
    for (const i of cells) await clickRun(i);
    const settled = `(() => { const cs = sagebrush.notebook.cells(); return ${JSON.stringify(cells)}.every((i) => { const el = cs[i].el; return !el.classList.contains('running') && !el.classList.contains('queued') && (el.querySelector('.out')?.textContent ?? '').trim() !== ''; }); })()`;
    let allSettled = true;
    try { await until(settled, 300000); } catch { allSettled = false; }
    const outs = await ev(`${JSON.stringify(cells)}.map((i) => (sagebrush.notebook.cells()[i].el.querySelector('.out')?.textContent ?? '').trim())`);
    const ran = cells.filter((i, k) => outs[k].includes(`@@L${i}@@`)).length;
    const notes = [...new Set(outs.filter((o, k) => !o.includes(`@@L${cells[k]}@@`)).map((o) => o.slice(0, 90)))];
    const lost = await ev("sagebrush.notebook.kernel.gateway.lost");
    console.log(`info loss 10%: ${ran} of 20 printed their output; the rest: ${JSON.stringify(notes)}; the network lost ${lost} replies or events`);
    ok(allSettled, `loss 10%: all 20 runs settled: each cell has its output or a note, none left running or queued`);
    ok((await ev("__left")) === 0 && (await ev("document.querySelector('#kernelpick').value")) === "gpu" && /Remote compute/.test(await status()),
      `loss 10%: never switched to This browser, and the kernel was never replaced (status ${JSON.stringify(await status())})`);
    // (and it still works: a new run prints its output, a few tries at most, as a person would rerun)
    const X = await newCell();
    let again = false;
    for (let t = 0; t < 5 && !again; t++) {
      const m = `@@again${t}@@`;
      await setCode(X, `print(${JSON.stringify(m)})`);
      await clickRun(X);
      try { await until(`(() => { const el = sagebrush.notebook.cells()[${X}].el; return !el.classList.contains('running') && !el.classList.contains('queued') && (el.querySelector('.out')?.textContent ?? '').trim() !== ''; })()`, 60000); } catch {}
      again = (await out(X)).includes(m);
    }
    ok(again, `loss 10%: afterwards a new run works, without a reload (${JSON.stringify((await out(X)).slice(0, 100))})`);
    ok((await ev("(clearInterval(__iv), __left)")) === 0, "loss 10%: still on remote compute at the end");
  }
  // 13. the same cell run again and again (William, Oct 29: his cell, run a few times, ended with "Not run: a remote
  // run must be approved first." and no Run fixed it): 10 Runs waited for, then 10 in quick succession; each one
  // completes, and nothing is ever refused as unapproved
  {
    const lat = 400;
    await goto(base + `?remote=1&latency=${lat}&jitter=50`);
    const W = await newCell();
    await connect(lat);
    const code = "import time; [print(i) or time.sleep(0.1) for i in range(8)]";
    await setCode(W, code);
    const execsW = () => ev(`sagebrush.notebook.kernel.gateway.executions.filter((x) => x.code.includes('range(8)')).length`);
    const doneW = `(() => { const el = sagebrush.notebook.cells()[${W}].el, o = el.querySelector('.out')?.textContent ?? ''; return !el.classList.contains('running') && !el.classList.contains('queued') && (/7/.test(o) || /Not run|unknown|error/i.test(o)); })()`;
    let good = 0, refused = 0;
    const outs = [];
    for (let i = 0; i < 10; i++) {
      const before = await execsW();
      await clickRun(W);
      // (the Run takes a round trip or more before the cell shows it: wait for this run's execution, then its end)
      try { await until(`sagebrush.notebook.kernel.gateway.executions.filter((x) => x.code.includes('range(8)')).length > ${before}`, 20000); } catch {}
      try { await until(doneW, 30000); } catch {}
      const o = await out(W);
      outs.push(o.replace(/\s+/g, " ").slice(0, 60));
      if (/approved first/.test(o)) refused++;
      else if (/0\s+1\s+2\s+3\s+4\s+5\s+6\s+7/.test(o)) good++;
    }
    ok(good === 10 && refused === 0, `the same cell, 10 Runs waited for: each completes (${good} of 10; refused as unapproved ${refused}; ${JSON.stringify([...new Set(outs)])})`);
    // (quickly: Ctrl+Enter, a person's Run that never means Stop, every 150 ms, each while the one before may
    // still be in flight; the cell's Run button would be Stop while it is queued or running)
    const ctrlEnterW = () => ev(`(() => { const c = sagebrush.notebook.cells()[${W}]; c.ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
    const before = await execsW();
    for (let i = 0; i < 10; i++) { await ctrlEnterW(); await sleep(150); }
    try { await until(`sagebrush.notebook.kernel.gateway.executions.filter((x) => x.code.includes('range(8)')).length > ${before}`, 20000); } catch {}
    await sleep(2 * lat);
    try { await until(doneW, 60000); } catch {}
    await sleep(2 * lat);
    const oq = await out(W);
    const nq = (await execsW()) - before;
    ok(!/approved first/.test(oq) && /0\s+1\s+2\s+3\s+4\s+5\s+6\s+7/.test(oq) && nq >= 1 && nq <= 10 && !(await ev(`(() => { const el = sagebrush.notebook.cells()[${W}].el; return el.classList.contains('running') || el.classList.contains('queued'); })()`)),
      `the same cell, 10 quick Runs: it ends with its output, never refused as unapproved (${nq} executed; ${JSON.stringify(oq.replace(/\s+/g, " ").slice(0, 80))})`);
    // (and a Run afterwards still works)
    const b2 = await execsW();
    await clickRun(W);
    try { await until(`sagebrush.notebook.kernel.gateway.executions.filter((x) => x.code.includes('range(8)')).length > ${b2}`, 20000); } catch {}
    try { await until(doneW, 30000); } catch {}
    ok(/0\s+1\s+2\s+3\s+4\s+5\s+6\s+7/.test(await out(W)) && !/approved first/.test(await out(W)), `and a Run afterwards completes (${JSON.stringify((await out(W)).replace(/\s+/g, " ").slice(0, 80))})`);
    // (the text as it may be mid-typing, its ] missing: the SyntaxError is shown, nothing is sent and nothing
    // is refused as unapproved; with the ] typed, the next Run runs it)
    const b3 = await execsW();
    await setCode(W, code.slice(0, -1));
    await clickRun(W);
    try { await until(`/SyntaxError/.test(sagebrush.notebook.cells()[${W}].el.querySelector('.out')?.textContent ?? '')`, 20000); } catch {}
    await sleep(2 * lat);
    const os = await out(W);
    ok(/SyntaxError/.test(os) && !/approved first/.test(os) && (await execsW()) === b3, `a syntax error on remote compute: the SyntaxError is shown, nothing sent (${JSON.stringify(os.replace(/\s+/g, " ").slice(0, 100))})`);
    await setCode(W, code);
    await clickRun(W);
    try { await until(`sagebrush.notebook.kernel.gateway.executions.filter((x) => x.code.includes('range(8)')).length > ${b3}`, 20000); } catch {}
    try { await until(doneW, 30000); } catch {}
    ok(/0\s+1\s+2\s+3\s+4\s+5\s+6\s+7/.test(await out(W)), `and once it's fixed, a Run runs it (${JSON.stringify((await out(W)).replace(/\s+/g, " ").slice(0, 80))})`);
  }
  // 14. recovery without a reload, never a silent switch (Reconnect/Switch plan r2): a connect that fails offers
  // Retry and Switch to browser; the Run/Stop guard; queued runs stopped before they ran; another tab takes the kernel
  {
    const lat = 400;
    const acts = () => ev("[...(document.querySelector('#remoteacts')?.children ?? [])].map((b) => b.textContent + (b.disabled ? ' (off)' : '')).join('|')");
    const clickAct = (label) => ev(`(() => { const b = [...(document.querySelector('#remoteacts')?.children ?? [])].find((b) => b.textContent.startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
    // (a) every bind refused: the picker stays, Retry and Switch to browser are offered, a Run says not connected; Retry connects
    await goto(base + `?remote=1&latency=${lat}`);
    const F = await newCell();
    await ev(`(async () => { const m = await import(new URL("sagebrush-remote.js", location.href).href); m.PreviewGateway.failNextBinds = 4; return true; })()`);
    await pick("gpu");
    await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open");
    await ev("document.querySelector('#remoteallow').click(); true");
    await until("!!document.querySelector('#remoteacts')", 60000);
    ok((await acts()) === "Retry|Switch to browser" && (await ev("document.querySelector('#kernelpick').value")) === "gpu" && /couldn't connect/.test(await status()),
      `a connect that fails: the picker stays on Remote compute, Retry and Switch to browser offered (${JSON.stringify(await status())})`);
    ok(await ev("sagebrush.notebook.kernel.remote === true && !sagebrush.notebook.kernel.ready"), "and the notebook's kernel is the remote one, unbound: nothing runs in this browser instead");
    await setCode(F, "print('ran somewhere')");
    await clickRun(F);
    await until(`/connected/.test(sagebrush.notebook.cells()[${F}].el.querySelector('.out')?.textContent ?? '')`, 20000);
    ok(/remote compute isn't connected/.test(await out(F)) && !/ran somewhere/.test(await out(F)), `a Run while not connected: told so, not run (${JSON.stringify((await out(F)).trim())})`);
    await clickAct("Retry");
    await until(`/Remote compute \\(preview, simulated · ${lat} ms[^)]*\\) · ready/.test(document.querySelector('#status').textContent) && !document.querySelector('#remoteacts')`, 30000);
    ok(true, `Retry connects, and the actions go: ${await status()}`);
    await clickRun(F);
    await until(`/ran somewhere/.test(sagebrush.notebook.cells()[${F}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    ok(true, "and the cell runs on the remote kernel");
    // (b) the Run/Stop guard: a click just after the button turned into Stop, and a double click's second click, don't stop;
    // a deliberate click later does
    const S = await newCell();
    await setCode(S, "import time\ntime.sleep(4)\nprint('slept')");
    const guard = await ev(`(async () => {
      const c = sagebrush.notebook.cells()[${S}];
      c.runb.click();
      for (let i = 0; i < 400 && !(c.el.classList.contains('queued') || c.el.classList.contains('running')); i++) await new Promise((r) => setTimeout(r, 5));
      const armed = c.stopArmedAt, t = performance.now() - armed;
      c.runb.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); // (within the guard)
      await new Promise((r) => setTimeout(r, 450));
      c.runb.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); // (a double click's second click)
      await new Promise((r) => setTimeout(r, 200));
      const busy = c.el.classList.contains('queued') || c.el.classList.contains('running');
      return { t, busy, armedSame: c.stopArmedAt === armed };
    })()`);
    ok(guard.busy && guard.armedSame && guard.t < 400, `a click ${Math.round(guard.t)} ms after the button turned into Stop, and a double click's second click: ignored, the cell still running`);
    await ev(`(() => { sagebrush.notebook.cells()[${S}].runb.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); return true; })()`);
    await until(`(() => { const el = sagebrush.notebook.cells()[${S}].el; return !el.classList.contains('running') && !el.classList.contains('queued'); })()`, 30000);
    ok(!/slept/.test(await out(S)), `a deliberate click after the guard stops it (${JSON.stringify((await out(S)).trim().slice(-60))})`);
    // (c) three Runs, the first slow, then the toolbar's Stop: the running one is interrupted and says so; the Runs asked
    // after it are each their own action and run then, as on This browser's interpreter (stopped before it ran is the
    // remote kernel's own queue: test-remote-kernel.mjs)
    const Q = [await newCell(), await newCell(), await newCell()];
    await setCode(Q[0], "import time\ntime.sleep(3)\nprint('first')");
    await setCode(Q[1], "print('second')");
    await setCode(Q[2], "print('third')");
    for (const i of Q) await clickRun(i);
    await until(`sagebrush.notebook.kernel.gateway.executions.some((x) => x.code.includes("print('first')"))`, 30000);
    await sleep(300);
    await ev("document.querySelector('#stop').click(); true");
    await until(`/third/.test(sagebrush.notebook.cells()[${Q[2]}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    const qo = [];
    for (const i of Q) qo.push((await out(i)).trim());
    ok(/KeyboardInterrupt/.test(qo[0]) && !/first/.test(qo[0]) && qo[1] === "second" && qo[2] === "third",
      `Stop while the first of three Runs runs: it is interrupted and says KeyboardInterrupt; the two asked after it run, as locally (${JSON.stringify(qo)})`);
    // (d) another tab takes this notebook's kernel: Reconnect (a fresh kernel, without the sheet) and Switch to browser
    const X = await newCell();
    await setCode(X, "kept = 5\nprint('kept set')");
    await clickRun(X);
    await until(`/kept set/.test(sagebrush.notebook.cells()[${X}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    await ev("(() => { for (const b of sagebrush.notebook.kernel.gateway.bindings.values()) b.epoch++; return true; })()"); // (another tab's takeover)
    const Y = await newCell();
    await setCode(Y, "print('kept' in globals())");
    await clickRun(Y);
    await until("!!document.querySelector('#remoteacts')", 30000);
    ok((await acts()) === "Reconnect (a fresh kernel: its variables are lost)|Switch to browser" && /another tab/.test(await status()),
      `another tab took the kernel: Reconnect (saying the kernel will be fresh) and Switch to browser (${JSON.stringify(await status())})`);
    await clickAct("Reconnect");
    await sleep(200);
    ok(!(await ev("!!document.querySelector('#remotedlg')")), "Reconnect doesn't ask the Connect sheet again (this notebook was connected in this page)");
    await until("/a fresh kernel: earlier variables are gone/.test(document.querySelector('#status').textContent)", 30000);
    await setCode(Y, "print('kept' in globals(), 'after reconnect')");
    await clickRun(Y);
    await until(`/after reconnect/.test(sagebrush.notebook.cells()[${Y}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    ok(/False after reconnect/.test(await out(Y)), `Reconnect: a fresh kernel, its variables gone, and it runs (${JSON.stringify((await out(Y)).trim())})`);
  }
  // 16. an import interrupted by Stop leaves no half-made module (Oct 31, found as 14(c)'s intermittent failure: a Stop
  // during the interpreter's first `import time` left an empty `time` in sys.modules, so a later `time.sleep` raised
  // AttributeError).  Deterministic here: a finder's module waits in its exec_module the first time it is loaded, and
  // Stop interrupts it there; the next import must run it again and get a whole module (src/runtime/modules.ts
  // dropFailed; the builtin path, and the Python-file loader's: test/import-failed.test.ts)
  {
    const lat = 400;
    await goto(base + `?remote=1&latency=${lat}`);
    const A = await newCell(), B = await newCell(), C = await newCell();
    await connect(lat);
    await setCode(A, [
      "import sys, time, types",
      "class SlowFinder:",
      "    loads = 0",
      "    def find_spec(self, name, path=None, target=None):",
      "        if name != 'slowmod':",
      "            return None",
      "        try:",
      "            from importlib.machinery import ModuleSpec",
      "        except ImportError:",
      "            return types.SimpleNamespace(name=name, loader=self)",
      "        return ModuleSpec(name, self)",
      "    def create_module(self, spec):",
      "        return None",
      "    def exec_module(self, m):",
      "        SlowFinder.loads += 1",
      "        m.started = True",
      "        if SlowFinder.loads == 1:",
      "            time.sleep(30)",
      "        m.done = True",
      "sys.meta_path.insert(0, SlowFinder())",
      "print('finder ready')",
    ].join("\n"));
    await clickRun(A);
    await until(`/finder ready/.test(sagebrush.notebook.cells()[${A}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    await setCode(B, "import slowmod as s1\nprint('B', s1.done)");
    await clickRun(B);
    await until(`sagebrush.notebook.kernel.gateway.executions.some((x) => x.code.includes('import slowmod as s1'))`, 30000);
    await sleep(1500);
    await ev("document.querySelector('#stop').click(); true");
    await until(`/KeyboardInterrupt/.test(sagebrush.notebook.cells()[${B}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    await setCode(C, "import sys\nimport slowmod as s2\nprint('C', hasattr(s2, 'done'), sys.modules['slowmod'] is s2)");
    await clickRun(C);
    await until(`/C (True|False)/.test(sagebrush.notebook.cells()[${C}].el.querySelector('.out')?.textContent ?? '')`, 30000);
    ok(/KeyboardInterrupt/.test(await out(B)) && /C True True/.test(await out(C)),
      `16: an import Stop interrupted leaves no half-made module: the next import runs it again, whole (${JSON.stringify((await out(B)).trim().slice(-40))}; ${JSON.stringify((await out(C)).trim())})`);
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
