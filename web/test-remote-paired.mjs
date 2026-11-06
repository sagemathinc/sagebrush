// ci: none (needs the runner, `sagebrush remote`, and a built web/dist: run by hand, and by engine/py/test_remote_pair.py where both exist)
// "Your computer (paired)" in the notebook page, end to end in headless Chromium against the real runner on
// 127.0.0.1: the page served from a loopback origin (web/serve.py), which the runner is told to accept
// (SAGEBRUSH_KERNEL_DEV_ORIGIN), so no Local Network Access prompt is involved.  Opened from the runner's link:
// the code leaves the address at once, the sheet opens prefilled and nothing connects until Connect; then a
// person's Run runs in the runner's own Python, a run without the gesture is never sent, Restart forgets the
// variables, and the runner stopping says so and offers Retry.
//   bun web/build.ts && PYTHONPATH=engine/py/python node web/test-remote-paired.mjs   (PYTHON=..., CHROME=...; SHOTS=dir
//   saves screenshots of the pairing sheet, a run on your computer, and the runner stopped)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const profile = mkdtempSync(join(tmpdir(), "sb-remote-paired-"));
let server = null, chrome = null, ws = null, ev = null, runner = null; // (ev here: the failure-state dump below uses it)
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
  ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const goto = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("!!(window.sagebrush && window.sagebrush.notebook) && /ready/.test(document.querySelector('#status').textContent)", 60000); };
  const status = () => ev("document.querySelector('#status').textContent");
  // (a wait on the status line: a timeout says what the status was)
  const untilStatus = async (expr, ms) => { try { return await until(expr, ms); } catch (e) { throw new Error(`${e.message} (status ${JSON.stringify(await status())})`); } };
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

  // the runner, told to accept this loopback origin
  const py = process.env.PYTHON ?? "python3";
  runner = spawn(py, ["-m", "sagebrush.cli", "remote", "--loopback", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SAGEBRUSH_KERNEL_DEV_ORIGIN: base.replace(/\/$/, "") } });
  let said = "";
  runner.stderr.on("data", (d) => (said += d));
  const link = await new Promise((resolve, reject) => {
    let o = "";
    runner.stdout.on("data", (d) => { o += d; if (o.includes("\n")) resolve(o.split("\n")[0]); });
    runner.on("exit", (c) => reject(new Error(`the runner exited ${c}: ${said.slice(0, 300)}`)));
  });
  const q = new URL(link).searchParams;
  ok(link.startsWith(base.replace(/\/$/, "")) && /^[A-Z2-7]{26}$/.test(q.get("kpair")) && Number(q.get("kport")) > 0, `the runner's link is for this page's origin (${link.replace(/kpair=\w+/, "kpair=…")})`);

  // 1. a plain page: no picker
  await goto(base);
  ok(await ev("document.querySelector('#kernelpick').hidden === true"), "without ?remote=1 or a pairing link the picker is hidden");

  // 2. the runner's link: the code leaves the address; the sheet opens, prefilled; nothing connects yet
  await goto(`${base}?kpair=${q.get("kpair")}&kport=${q.get("kport")}`);
  ok(await ev("!/kpair|kport/.test(location.href) && !/kpair/.test(JSON.stringify(history.state ?? null))"), "the code is taken off the address at once");
  await until("!!document.querySelector('#remotedlg') && document.querySelector('#remotedlg').open && document.querySelector('#kernelpick').value === 'paired'");
  const sheet = await ev("document.querySelector('#remotedlg').textContent");
  ok(/run on your computer, with your files and permissions/.test(sheet) && /sagebrush remote --loopback/.test(sheet), "the sheet: the consent line and the command");
  await shot("paired-sheet.png");
  ok(await ev(`document.querySelector('#pairlink').value.includes(${JSON.stringify(q.get("kpair"))})`), "prefilled from the link");
  ok(await ev("document.activeElement !== document.querySelector('#pairallow')"), "focus isn't on Connect (Enter doesn't connect)");
  await sleep(500);
  ok(!/A page is paired/.test(said), "nothing has paired before Connect");
  // a code cell of the reactive notebook to run
  const C = await ev("(() => { const nb = sagebrush.notebook; nb.addCell('', null, false, 'code'); return nb.cells().length - 1; })()");
  // a pasted wrong link is refused in the sheet, not sent
  await ev("(() => { const f = document.querySelector('#pairlink'); const v = f.value; f.value = 'not a link'; document.querySelector('#pairallow').click(); f.value = v; return true; })()");
  ok(/isn't the link/.test(await ev("document.querySelector('#pairstatus').textContent")) && !/A page is paired/.test(said), "a wrong paste: said in the sheet, nothing sent");
  await ev("document.querySelector('#pairallow').click(); true");
  await untilStatus("/Your computer · ready/.test(document.querySelector('#status').textContent)");
  ok(/A page is paired/.test(said), `connected: ${await status()}`);

  // 3. a person's Run runs in the runner's own Python
  const o3 = await runCode(C, "import sys\nx = 6 * 7\nprint('on', sys.implementation.name, x)");
  await ev(`(() => { sagebrush.notebook.cells()[${C}].el.scrollIntoView({ block: "center" }); return true; })()`);
  await shot("paired-run.png");
  ok(/on cpython 42/.test(o3), `a Run runs on your computer, in CPython (${JSON.stringify(o3.slice(0, 80))})`);
  // 4. a run without a person's Run gesture: never sent
  await setCode(C, "print('sneaky')");
  await ev(`(async () => { await sagebrush.notebook.run(sagebrush.notebook.cells()[${C}]); return true; })()`);
  await sleep(800);
  ok(!/sneaky/.test(await out(C)), "a run without the person's Run is not sent");
  // 5. Restart: variables gone
  ok(/True/.test(await runCode(C, "y = 1\nprint('y' in globals())")), "y is set on your computer");
  await ev("document.querySelector('#restart').click(); true");
  await untilStatus("/Your computer · ready/.test(document.querySelector('#status').textContent)");
  await sleep(300);
  ok(/False/.test(await runCode(C, "print('y' in globals())")), "after Restart the variables are gone");
  // 6. the runner stops: said, with Retry and This browser offered
  runner.kill("SIGINT");
  await untilStatus("/Your computer: disconnected \\(the runner on your computer stopped\\)/.test(document.querySelector('#status').textContent)", 20000);
  await shot("paired-lost.png");
  ok(await ev("[...document.querySelectorAll('#remoteacts button')].map((b) => b.textContent).join('|') === 'Retry|Switch to browser'"), `the runner stopping: ${await status()}, Retry and Switch to browser`);
  await ev("document.querySelector('#remoteacts button:last-child').click(); true");
  await until("document.querySelector('#kernelpick').value === 'local'");
  ok(true, "Switch to browser: This browser again");
} catch (e) {
  ok(false, `the test ran to its end: ${e?.message ?? e}`);
  try {
    const d = await ev("JSON.stringify({ status: document.querySelector('#status').textContent, pick: document.querySelector('#kernelpick').value })");
    console.log("state at the failure: " + d);
  } catch (d) { console.log("state at the failure: (unavailable: " + (d?.message ?? d) + ")"); }
} finally {
  try { ws?.close(); } catch {}
  try { chrome?.kill("SIGKILL"); } catch {}
  try { server?.kill("SIGKILL"); } catch {}
  try { if (runner && runner.exitCode === null) runner.kill("SIGKILL"); } catch {}
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(process.exitCode ? "FAILED" : "all passed");
