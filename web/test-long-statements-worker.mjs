// ci: web-runner order=126 chrome
// Long statements in the browser's engine worker (web/worker.ts), whose JavaScript stack is the smallest a run gets:
// the CLI's rows are test/long-statements.test.ts; these are the same shapes in headless Chromium against the built
// worker:
//   - a 200,000-element list of floats (the shape MATLAB's 200,000-element row compiles to), 200,000-argument calls,
//     plain and of a method, a 120,000-element tuple of walrus expressions, a 30,000-term + chain: each runs, with
//     its value;
//   - nesting: 50 brackets (the least MATLAB's code generation counts on) compile, well past the worker's measured
//     parser limit is CPython's MemoryError ("Parser stack overflowed"), and the 201st bracket CPython's SyntaxError.
//   bun web/build.ts, then node web/test-long-statements-worker.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-long-"));
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
// (a fresh worker, one run of `code` (built in the page, not sent: a 200,000-element statement is megabytes); its
// stdout and stderr, or why it gave none)
const runIn = (build) => ev(`new Promise((res) => {
  const w = new Worker("sagebrush-worker.js", { type: "module" });
  const out = { stdout: "", stderr: "" };
  const t = setTimeout(() => { w.terminate(); res({ ...out, timeout: true }); }, 180000);
  w.onmessage = (e) => {
    const m = e.data;
    if (m?.id !== 1) return;
    if (m.stream) out[m.stream] += m.text;
    if (m.done) { clearTimeout(t); w.terminate(); res({ ...out, error: m.error ?? null }); }
  };
  const nums = (n, f = String) => Array.from({ length: n }, (_, i) => f(i)).join(", ");
  w.postMessage({ init: { limits: null } });
  w.postMessage({ id: 1, code: (${build})(nums) });
})`);
const last = (r) => (r.stdout + r.stderr).trim().split("\n").pop();

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);

  const rows = [
    ["200,000 floats in a list", "(nums) => `x = [${nums(200000, (i) => i + '.0')}]\\nprint(len(x), x[-1], sum(x))`", "200000 199999.0 19999900000.0"],
    ["a 200,000-argument call", "(nums) => `def f(*a): return len(a), a[-1]\\nprint(f(${nums(200000)}))`", "(200000, 199999)"],
    ["a 200,000-argument method call", "(nums) => `class O:\\n    def m(self, *a): return len(a), a[-1]\\nprint(O().m(${nums(200000)}))`", "(200000, 199999)"],
    ["120,000 walrus elements", "(nums) => `x = (${nums(120000, () => '(_c := 1)')})[-1]\\nprint(x, _c)`", "1 1"],
    ["a 30,000-term + chain", "(nums) => `x = ${Array.from({ length: 30000 }, (_, i) => i).join(' + ')}\\nprint(x)`", "449985000"],
  ];
  for (const [what, build, want] of rows) {
    const r = await runIn(build);
    check(!r.timeout && r.error === null && last(r) === want, `${what}: ${JSON.stringify(last(r))}${r.timeout ? " (timed out)" : r.error ? ` (${r.error})` : ""}`);
  }

  // (the worker's parser limit, measured Nov 11 on this branch's build in headless Chromium: 60 nested brackets
  // compile, 80 run its stack out; 50 is the least MATLAB's code generation counts on, never to go below)
  const NEST_OK = 50, NEST_REFUSED = 120;
  const nest = (k) => `(nums) => "x = " + "[".repeat(${k}) + "]".repeat(${k}) + "\\nprint('ok')"`;
  const overflow = "MemoryError: Parser stack overflowed - Python source too complex to parse";
  let r = await runIn(nest(NEST_OK));
  check(last(r) === "ok", `${NEST_OK} nested brackets compile (${last(r)})`);
  r = await runIn(nest(NEST_REFUSED));
  check(last(r) === overflow, `${NEST_REFUSED} nested brackets: CPython's MemoryError, not a JavaScript error (${last(r)})`);
  r = await runIn(nest(201));
  check(last(r) === "SyntaxError: too many nested parentheses", `the 201st nested bracket is CPython's SyntaxError (${last(r)})`);
  r = await runIn(`(nums) => "x = " + "-".repeat(100000) + "1"`);
  check(last(r) === overflow, `a 100,000-deep unary chain is CPython's MemoryError (${last(r)})`);
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
