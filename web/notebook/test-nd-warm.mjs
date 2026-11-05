// ci: web-browser/notebook order=126
// engine/nd's warm-up in the notebook's worker (web/worker.ts, src/runtime/nd.ts ndWarm): a run that imports numpy
// asks for it, and once that run is over, the worker idle, it fetches and compiles the module; the decision still
// comes at the first call that could use it (the path stays "undecided" until then), which then only instantiates
// the module. On the embed page (web/embed). Serve web/dist first (python3 web/serve.py 8765), then
//   node web/notebook/test-nd-warm.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ndwarm-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
// a Python run in the page's kernel: its stdout, trimmed
const cell = (code) => ev(`new Promise((done) => { let out = ""; window.demo.kernel.execute(${JSON.stringify(code)}, {}, { out: (t) => (out += t), done: () => done(out.trim()), stopped: (t) => done("stopped " + t) }); })`);
const state = "print(np.linalg._kernels()['solve']['warm'], np.linalg._kernels()['solve']['path'])";

try {
  await send("Runtime.enable");
  await send("Page.navigate", { url: new URL("embed/", base).href });
  check(await until("window.demo?.kernel?.ready === true", 60000), "the embed page's kernel starts");
  check((await ev("self.crossOriginIsolated")) === true, "the page is cross-origin isolated (engine/nd can run)");
  // (asked by the import, not begun during the run that imports numpy)
  const first = await cell(`import numpy as np\n${state}`);
  check(first === "asked undecided", `during numpy's first run: ${first}`);
  // (after it, at idle: compiled, the decision still to come)
  let s = "";
  for (let i = 0; i < 100 && s !== "ready undecided"; i++) { await sleep(100); s = await cell(state); }
  check(s === "ready undecided", `after that run, idle: ${s}`);
  // (the first call from n = 32: engine/nd, instantiating the compiled module)
  const used = await cell(`x = np.linalg.solve(np.eye(32) * 2, np.ones(32))\nprint(float(x[0]), float(x[31]))\n${state}`);
  check(used === "0.5 0.5\nready engine/nd", `the first solve at n = 32: ${JSON.stringify(used)}`);
  check(errors.length === 0, `no page exceptions: ${errors.slice(0, 2).join(" | ")}`);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  // (Chromium may still be writing its profile as it exits)
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exitCode = fails.length ? 1 : 0;
