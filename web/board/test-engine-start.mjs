// An interpreter whose worker never starts (code.ts): seen on busy CI
// machines, where a page's workers were made but their scripts never
// loaded, and the board waited for good (test-export's live.json, 90 s).
// Now the interpreter is started again, once, after a deadline, and its
// analyzer asked again on a new worker; still nothing, the board says the
// code can't run here, and outputs() settles rather than waiting.  The
// deadline is lowered for the test (window.__sbEngineStartMs), and the
// first k Workers the page makes are made dead: never loading, never
// answering.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-engine-start.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-engstart-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
setTimeout(() => { console.log("FAIL\n  the test did not end within 240 s"); process.exit(1); }, 240_000).unref();
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}, ms = 60000) => new Promise((resolve, reject) => { const id = ++n, t = setTimeout(() => { waiting.delete(id); reject(new Error(method + ": no answer")); }, ms); waiting.set(id, (r) => { clearTimeout(t); resolve(r); }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression, ms = 30000) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr, Math.max(1000, ms - (Date.now() - t))).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
const BOARD = { title: "Starts", nodes: [{ id: "a", code: "x = 6 * 7" }, { id: "b", code: "print(x)" }] };

// a page whose first `dead` Workers never load (and the deadline `ms`)
let script = null;
async function open(dead, ms) {
  if (script) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script });
  ({ identifier: script } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__sbEngineStartMs = ${ms};
    const W = window.Worker; let left = ${dead}; window.__deadMade = 0;
    window.Worker = function (url, opts) {
      if (left-- > 0) { window.__deadMade++; return { postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {}, onmessage: null, onerror: null }; }
      return new W(url, opts);
    };
    window.Worker.prototype = W.prototype;
  })()` }));
  await send("Page.navigate", { url: `${base}board/?runner=0&fresh=${Math.random()}` });
  if (!(await until(`${B}?.snapshot().items.length > 0`, 60000))) throw new Error("the board did not open");
  await ev(`${B}.load(${JSON.stringify(BOARD)}).then(() => 1)`);
}
const ran = (ms) => until(`${B}.outputs().then((os) => os.find((o) => o.id === 'b')?.output.trim() === '42')`, ms);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // every worker loads: as before
  await open(0, 3000);
  check(await ran(60000), "(the board's code runs: " + JSON.stringify(await ev(`${B}.outputs()`)) + ")");
  // the interpreter's worker and the analyzer's first worker never load:
  // each made again after the deadline, and the code runs
  await open(2, 3000);
  const t0 = Date.now();
  check(await ran(60000), "an interpreter and an analyzer whose first workers never start: started again, the code runs: " + JSON.stringify(await ev(`${B}.outputs()`)) + " " + (await ev("document.querySelector('[data-sbb=say]').textContent")).slice(0, 120));
  check((await ev("window.__deadMade")) === 2, "(both dead workers were made: " + (await ev("window.__deadMade")) + ")");
  console.log(`ran after its workers were made again: ${Math.round((Date.now() - t0) / 1000)} s`);
  // no worker ever loads: it says it can't run here, and outputs() settles
  await open(1000, 3000);
  check(await until("/can't run here/.test(document.querySelector('[data-sbb=say]').textContent) && /did not start/.test(document.querySelector('[data-sbb=say]').textContent)", 30000), "no worker ever starts: the board says the code can't run here, and why: " + (await ev("document.querySelector('[data-sbb=say]').textContent")).slice(0, 200));
  const settled = await ev(`Promise.race([${B}.outputs().then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 10000))])`, 20000);
  check(settled === "settled", "...and outputs() settles, not waiting for good: " + settled);
  check(!errors.length, "no errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
