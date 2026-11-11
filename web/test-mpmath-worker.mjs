// ci: web-runner order=125 chrome
// mpmath on the multiprecision core in the browser's worker (design/mpmath-core.md, section 6.1), in headless Chromium
// against the built worker (web/worker.ts): the core asset (sagebrush-mp.wasm) loads there, mpmath's backend is the
// core by default, and bench/mpmath/conformance.py, every row of the native types' surface, prints in the worker
// exactly what it prints under the built CLI in Node, line for line.
//   bun web/build.ts, then node web/test-mpmath-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-mpmath-"));
const conformance = readFileSync(join(here, "..", "bench", "mpmath", "conformance.py"), "utf8");
// (Node's output: the built CLI, the default backend)
const env = { ...process.env };
delete env.SAGEBRUSH_MPMATH_BACKEND;
const want = execFileSync(process.execPath, [join(here, "..", "build", "cli", "pyjs.cjs"), join(here, "..", "bench", "mpmath", "conformance.py"), "gen"], { encoding: "utf8", env, maxBuffer: 1 << 28 });
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};
const start = () => ev(`(() => {
  const w = new Worker("sagebrush-worker.js", { type: "module" });
  const s = window.__s = { w, runs: new Map(), next: 1 };
  w.onmessage = (e) => {
    const m = e.data;
    const r = s.runs.get(m?.id);
    if (!r) return;
    if (m.stream) r.out[m.stream] += m.text;
    if (m.done) { s.runs.delete(m.id); r.res({ ...r.out, error: m.error ?? null }); }
  };
  w.postMessage({ files: [["/mt/conformance.py", new TextEncoder().encode(${JSON.stringify(conformance)})]] });
  w.postMessage({ startDir: "/mt" });
  w.postMessage({ init: { limits: null } });
  return true;
})()`);
const run = (code, ms = 120000) => ev(`new Promise((res) => {
  const s = window.__s;
  const id = s.next++;
  const r = { res, out: { stdout: "", stderr: "" } };
  s.runs.set(id, r);
  setTimeout(() => { if (s.runs.has(id)) { s.runs.delete(id); res({ ...r.out, timeout: true }); } }, ${ms});
  s.w.postMessage({ id, code: ${JSON.stringify(code)} });
})`);
const ranOk = (r, what) => check(!r.timeout && r.error === null && r.stderr === "", `${what} ran (${r.timeout ? "timed out" : r.error ?? "no error"}${r.stderr ? ": " + r.stderr.slice(-300) : ""})`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  await start();

  // ---- the default backend is the core, and its asset loads in the worker
  const b = await run("import sys, mpmath\nfrom mpmath.libmp import libmpf\nc = sys.modules.get('_sagebrush_mpcore')\nprint(mpmath.libmp.BACKEND, c is not None and libmpf.mpf_add is c.mpf_add, mpmath.mpf(2) / 3)");
  ranOk(b, "import mpmath");
  check(b.stdout === "sagebrush True 0.666666666666667\n", `the default backend is the core's, live (${JSON.stringify(b.stdout)})`);

  // ---- the conformance list: the worker prints what Node prints
  const c = await run("import sys\nsys.argv = ['conformance.py', 'gen']\nexec(compile(open('/mt/conformance.py').read(), 'conformance.py', 'exec'))", 900000);
  ranOk(c, "conformance.py gen");
  const w = want.split("\n"), g = c.stdout.split("\n");
  const i = w.findIndex((l, j) => l !== g[j]);
  check(i < 0 && w.length === g.length && w.length > 20000, i < 0 && w.length === g.length ? `conformance.py: ${w.length - 1} lines, as Node prints them` : `conformance.py: line ${i + 1}: Node ${JSON.stringify(w[i])}, the worker ${JSON.stringify(g[i])} (${w.length} vs ${g.length} lines)`);
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  chrome.kill();
  serve.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
