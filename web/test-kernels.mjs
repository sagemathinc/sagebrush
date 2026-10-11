// One interpreter per notebook (design/reactive-notebook.md, step 1), on the
// full page in headless Chromium: switching notebooks switches interpreters
// (each keeps its variables); Restart keeps the outputs, marked stale until
// their cells run again; outputs loaded from storage are stale; the console
// is a scratchpad with its own interpreter.  Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh kernels
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = 9347;
const profile = mkdtempSync(join(tmpdir(), "sb-kernels-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready";
const out = (i) => `sagebrush.notebook.cells()[${i}].out.textContent.trim()`;
const stale = (i) => `sagebrush.notebook.cells()[${i}].el.classList.contains('stale')`;
const setRun = async (i, code) => {
  await ev(`(() => { const nb = sagebrush.notebook; while (nb.cells().length <= ${i}) nb.addCell(''); nb.setInput(nb.cells()[${i}], ${JSON.stringify(code)}); return true; })()`);
  await ev(`(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[${i}]); return true; })()`);
};
const fileNew = async () => {
  const k = await ev("sagebrush.kernel.uid");
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until(`sagebrush.kernel.uid !== ${k} && sagebrush.kernel.ready`, 15000);
  await sleep(300);
};
try {
  await send("Page.navigate", { url: base });
  await until(ready);
  // notebook A
  await fileNew();
  const idA = await ev("localStorage.getItem('sagebrush-current')");
  await setRun(0, "a = 41\nprint(a + 1)");
  ok((await ev(out(0))) === "42" && !(await ev(stale(0))), "notebook A runs");
  // notebook B: its own interpreter
  await fileNew();
  await setRun(0, "print('a' in globals())\nb = 7");
  ok((await ev(out(0))) === "False", "a new notebook has its own interpreter (A's a is not defined in B)");
  ok((await ev("sagebrush.kernels.size")) >= 2, `the page keeps an interpreter per notebook (${await ev("sagebrush.kernels.size")})`);
  // back to A: same interpreter, outputs not stale
  await ev(`sagebrush.open(${JSON.stringify(idA)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(idA)} && sagebrush.kernel.ready`, 10000);
  ok((await ev(out(0))) === "42" && !(await ev(stale(0))), "back in A: its output, computed by its interpreter, is not stale");
  await setRun(1, "print(a)");
  ok((await ev(out(1))) === "41", "...and its interpreter still has a = 41");
  // Restart keeps the outputs, stale; running a cell freshens it
  await ev("document.querySelector('#restart').click(); true");
  await until("sagebrush.kernel.ready", 15000);
  ok((await ev(out(0))) === "42" && (await ev(stale(0))) && (await ev(stale(1))), "Restart keeps the outputs, marked stale");
  await setRun(0, "a = 41\nprint(a + 1)");
  ok(!(await ev(stale(0))) && (await ev(stale(1))), "running a cell makes its output current again (the other stays stale)");
  // the console: a scratchpad with its own interpreter
  await ev("document.querySelector('#consolebtn').click(); true");
  await until("/console ready/.test(document.querySelector('#status').textContent)", 20000);
  await ev("new Promise((res) => sagebrush.consoleKernel.execute('scratch = 1\\nprint(\\'a\\' in globals())', { mode: 'python', repl: true }, { start() {}, out(t) { window.__c = (window.__c ?? '') + t; }, display() {}, interact() {}, clear() {}, done: res, stopped: res, skipped: res }))");
  ok((await ev("window.__c.trim()")) === "False", "the console does not see the notebook's variables");
  await setRun(1, "print('scratch' in globals())");
  ok((await ev(out(1))) === "False", "the notebook does not see the console's variables");
  // a reload: outputs loaded from storage are stale
  await send("Page.reload");
  await until(ready);
  await until(`sagebrush.notebook.cells().length >= 2`, 10000);
  ok((await ev(stale(0))) && (await ev(out(0))) === "42", "after a reload, the outputs are shown, stale");
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
