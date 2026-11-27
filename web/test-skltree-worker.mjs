// ci: web-runner order=126 chrome
// The decision-tree kernel in the browser's worker (src/runtime/skltree.ts; the design note sklearn-trees r3), in
// headless Chromium against the built worker (web/worker.ts): importing sagebrush.skltree makes no instance; the
// first dataset fetches wasm/sagebrush-skltree.wasm by its URL and SHA-256 (__SAGEBRUSH_SKLTREE_URL__ and
// _SHA256__), checks the copy there and gives the same answers as the built CLI in Node: the dataset's state, a
// release, and the refusals (NaN outside the mask, a non-float32 X).
//   bun web/build.ts, then node web/test-skltree-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (every wait has its own deadline: a hung page fails this test, never the job)
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no answer within ${ms} ms`); })]);
const tmp = mkdtempSync(join(tmpdir(), "sb-skltree-"));

const PROGRAM = `
import numpy as np
import _skltree
from sagebrush import skltree
print("imported", _skltree._state()[0])
X = np.arange(12, dtype=np.float32).reshape(4, 3)
y = np.array([[0.0], [1.0], [0.0], [1.0]])
d = skltree.dataset(X, y)
g, mem, n, live, debt, retired, b = _skltree._state()
print("made", g, n, live, d.usable, repr(d))
d.release()
print("released", _skltree._state()[2], d.usable)
Xn = X.copy(); Xn[1, 2] = np.nan
try:
    skltree.dataset(Xn, y)
except ValueError as e:
    print("ValueError", e)
try:
    skltree.dataset(X.astype(np.float64), y)
except TypeError as e:
    print("TypeError", e)
m = skltree.dataset(Xn, y, np.array([False, False, True]))
print("masked", m.usable)
`;
const want = execFileSync(process.execPath, [join(here, "..", "build", "cli", "pyjs.cjs"), "-c", PROGRAM], { encoding: "utf8" });

const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};
let chrome = null;
const stop = () => {
  try { chrome?.kill("SIGKILL"); } catch {}
  try { serve.kill(); } catch {}
};
process.on("exit", stop);
try {
  const port = await within(new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop())))), 20000, "serve.py");
  const profile = join(tmp, "profile");
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const cdp = await within(devtoolsPort(profile), 60000, "Chrome's DevTools port");
  let targets;
  for (let i = 0; i < 300 && !targets; i++) {
    try {
      targets = await within(fetch(`http://127.0.0.1:${cdp}/json`).then((r) => r.json()), 2000, "the target list");
    } catch {
      await sleep(100);
    }
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await within(new Promise((r) => (ws.onopen = r)), 10000, "the DevTools socket");
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m.result ?? m.error);
      waiting.delete(m.id);
    }
  };
  const send = (method, params = {}, ms = 20000) => within(new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }), ms, method);
  const ev = async (expression, ms = 20000) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  await ev(`(() => {
    const w = new Worker("sagebrush-worker.js", { type: "module" });
    const s = window.__s = { w, runs: new Map(), next: 1 };
    w.onmessage = (e) => {
      const m = e.data;
      const r = s.runs.get(m?.id);
      if (!r) return;
      if (m.stream) r.out[m.stream] += m.text;
      if (m.done) { s.runs.delete(m.id); r.res({ ...r.out, error: m.error ?? null }); }
    };
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
  })`, ms + 5000);
  const r = await run(PROGRAM);
  check(!r.timeout && r.error === null && r.stderr === "", `the program ran in the worker (${r.timeout ? "timed out" : r.error ?? "no error"}${r.stderr ? ": " + r.stderr.slice(-300) : ""})`);
  check(r.stdout.startsWith("imported 0\n"), "importing sagebrush.skltree made no instance");
  // (the instance's memory and B differ between hosts; the lines compared hold neither)
  check(r.stdout === want, `the worker prints what Node prints (${JSON.stringify(r.stdout)} vs ${JSON.stringify(want)})`);
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  stop();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
