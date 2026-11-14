// ci: web-browser/notebook order=81
// The edited mark outside the reactive notebook, on the full page in headless Chromium: a code cell whose output came
// from other code than it shows is marked "edited" (the reactive notebook has its own rule, test-reactive.mjs).
//   1. run, then edit: edited; edited back: not edited;
//   2. Clear outputs: not edited (no output, nothing to be stale);
//   3. a change from elsewhere to the code alone, the outputs the same: edited;
//   4. a change from elsewhere bringing an output with its new code: not edited;
//   5. the reactive notebook turned on and off again: the edited cell is still marked.
// Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh edited-mark
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-edited-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const J = JSON.stringify;
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready";
const edited = () => ev("sagebrush.notebook.cells()[0].el.classList.contains('edited')");
const out = () => ev("sagebrush.notebook.cells()[0].out.textContent.trim()");
// (typed, as a person types: the input event the cell listens to)
const type = (code) => ev(`(() => { const ta = sagebrush.notebook.cells()[0].ta; ta.value = ${J(code)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const run = () => ev("sagebrush.notebook.run(sagebrush.notebook.cells()[0]).then(() => 1)");
// (a document changed elsewhere: this page's own, with cell 0 changed by f, applied as the page applies one)
const remote = (f) => ev(`(() => { const nb = sagebrush.notebook, d = nb.snapshot(); const c = d.cells[0]; (${f})(c); nb.applyRemote({ ...d, rev: undefined }, false); return 1; })()`);
try {
  await send("Page.navigate", { url: base });
  await until(ready);
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until("sagebrush.kernel.ready && sagebrush.notebook.cells().length === 1", 15000);
  await ev("sagebrush.notebook.setReactive(false); 1");
  ok(!(await ev("sagebrush.notebook.reactiveOn")), "the reactive notebook is off");

  // 1. run, then edit; edited back
  await type("print(1)");
  ok(!(await edited()), "code that never ran, with no output: not edited");
  await run();
  await until("sagebrush.notebook.cells()[0].out.textContent.trim() === '1'");
  ok(!(await edited()), "run: not edited");
  await type("print(2)");
  console.log("DEBUG", await ev("(() => { const c = sagebrush.notebook.cells()[0]; return JSON.stringify({ ran: c.ranText, v: c.ta.value, kids: c.out.childNodes.length, cls: c.el.className, ro: sagebrush.notebook.reactiveOn }); })()"));
  ok(await edited(), "run, then edited: edited (its output is print(1)'s)");
  await type("print(1)");
  ok(!(await edited()), "edited back to what ran: not edited");

  // 1b. a notebook as loaded (its saved output, never run here): an edit marks it; edited back, it isn't
  const saved = await ev("JSON.stringify(sagebrush.notebook.snapshot().cells[0].outputs)");
  await ev(`(sagebrush.notebook.load({ mode: "python", cells: [{ id: "loaded1", code: "print(1)", outputs: ${saved}, n: 1 }] }), 1)`);
  ok((await ev("sagebrush.notebook.cells()[0].ta.value")) === "print(1)" && (await out()) === "1" && !(await edited()), "a notebook as loaded, with its saved output: not edited");
  await type("print(7)");
  ok(await edited(), "...edited after loading: edited (its output is the saved code's)");
  await type("print(1)");
  ok(!(await edited()), "...edited back to the saved code: not edited");

  // 2. Clear outputs
  await type("print(2)");
  ok(await edited(), "edited again: edited");
  await ev("sagebrush.notebook.clearOutputs(); 1");
  ok(!(await edited()) && (await out()) === "", "Clear outputs: no output, not edited");

  // 3. a change from elsewhere to the code alone
  await run();
  await until("sagebrush.notebook.cells()[0].out.textContent.trim() === '2'");
  ok(!(await edited()), "run print(2): not edited");
  await remote("(c) => { c.code = 'print(3)'; }");
  ok((await ev("sagebrush.notebook.cells()[0].ta.value")) === "print(3)" && (await out()) === "2", "a change from elsewhere: the code print(3), the output still 2");
  ok(await edited(), "…edited: the output is other code's");

  // 4. a change from elsewhere bringing its output with its new code
  const snap = await ev("JSON.stringify(sagebrush.notebook.snapshot().cells[0].outputs)");
  await type("print(5)");
  await run();
  await until("sagebrush.notebook.cells()[0].out.textContent.trim() === '5'");
  await remote(`(c) => { c.code = 'print(2)'; c.outputs = ${snap}; }`);
  ok((await ev("sagebrush.notebook.cells()[0].ta.value")) === "print(2)" && (await out()) === "2", "a change from elsewhere with its output: print(2) and 2");
  ok(!(await edited()), "…not edited: the output is its code's");

  // 5. the reactive notebook on and off: the edited cell stays marked
  await type("print(6)");
  ok(await edited(), "edited: edited");
  await ev("sagebrush.notebook.setBudget(0, { save: false }); sagebrush.notebook.setReactive(true); 1");
  await sleep(500);
  await ev("sagebrush.notebook.setReactive(false); 1");
  ok(!(await ev("sagebrush.notebook.reactiveOn")) && (await edited()), "the reactive notebook on, then off: still edited");
} catch (e) {
  ok(false, "the test stopped: " + String(e?.message ?? e).slice(0, 400));
} finally {
  ws.close();
  // (Chrome writes into its profile until it exits)
  await new Promise((r) => { chrome.once("exit", r); chrome.kill(); });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
