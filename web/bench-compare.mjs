// Sagebrush's Python against Pyodide (CPython compiled to WebAssembly), in
// headless Chrome, the same way for both: a minimal page per engine, its
// files served from this machine compressed as a CDN serves them (brotli,
// quality 5), a fresh browser profile for each cold start.
//
//   - Download: what a cold start transfers (on the wire, and decoded), and
//     the time until the interpreter is ready and print(1 + 1) has run.
//   - numpy: what importing it adds, and how long that takes.
//   - Speed: a few workloads, each run 5 times after a warm-up run in the
//     same session (the median, in ms, timed inside the page).  Every
//     workload prints a result, and both engines must print the same one.
//
// Sagebrush runs in its Web Worker (web/dist/sagebrush-worker.js, the
// notebook's own worker, without the notebook page around it); Pyodide on
// the page's main thread, as its documentation starts it.  Bytes are
// counted by this script's server, not the browser: nothing is cached
// between the cold starts.
//
//   bun web/build.ts && node web/bench-compare.mjs --pyodide DIR [--runs 3] [--only json,loop] [--json out.json]
//   (DIR: Pyodide's distribution: pyodide.mjs, pyodide.asm.wasm,
//   python_stdlib.zip, pyodide-lock.json, and the wheels of numpy and what
//   it needs; CHROME=... for the browser)
//
// Sagebrush does not aim at CPython's every behaviour: these workloads are
// ones both run the same way, which says nothing about code that only
// CPython runs.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { devtoolsPort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const here = new URL(".", import.meta.url).pathname;
const DIST = join(here, "dist");
const PYODIDE = opt("--pyodide");
if (!PYODIDE || !existsSync(join(PYODIDE, "pyodide.mjs"))) throw new Error("--pyodide DIR: Pyodide's distribution (pyodide.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json, wheels)");
const RUNS = Number(opt("--runs") ?? 3);
const REPS = 5;

const WORKLOADS = {
  "loop": "s = 0\nfor i in range(3000000):\n    s += i * i\nprint(s)",
  "recursion": "def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nprint(fib(25))",
  "dict and str": "d = {str(i): i for i in range(200000)}\nprint(sum(len(k) for k in sorted(d)), d['12345'])",
  // (bit_length and a remainder: str() of a number past 4300 digits is a
  // ValueError in CPython 3.11+ and in Sagebrush alike)
  "big integers": "import math\nx = math.factorial(20000)\nprint(x.bit_length(), x % 1000003)",
  "sieve": "n = 2000000\ns = bytearray([1]) * (n + 1)\ns[0] = s[1] = 0\nfor p in range(2, int(n ** 0.5) + 1):\n    if s[p]:\n        s[p * p::p] = bytes(len(range(p * p, n + 1, p)))\nprint(sum(s))",
  "json": "import json\nx = [{'a': i, 'b': [i, str(i), i / 2], 'c': {'d': None, 'e': True}} for i in range(30000)]\ny = json.loads(json.dumps(x))\nprint(len(y), y[-1]['b'])",
  "numpy matmul": "import numpy as np\nA = np.arange(300 * 300, dtype=float).reshape(300, 300) % 7\nprint(float((A @ A).sum()))",
  "numpy elementwise": "import numpy as np\nx = np.linspace(0, 1, 1000000)\nprint(round(float(np.sum(np.sin(x) * x + x ** 2)), 6))",
};

// (--only a,b: just the workloads whose names contain one of these)
if (opt("--only")) for (const k of Object.keys(WORKLOADS)) if (!opt("--only").split(",").some((w) => k.includes(w))) delete WORKLOADS[k];

// The two pages: run(code) -> {out, ms}, and window.ready once the interpreter is
const PAGES = {
  "/sagebrush.html": `<!doctype html><meta charset="utf-8"><script type="module">
const t0 = performance.now();
const w = new Worker("/sb/sagebrush-worker.js", { type: "module" });
let n = 0, waiting = new Map();
window.log = [];
w.onerror = (e) => window.log.push("worker error: " + (e.message || e));
const ready = new Promise((r) => { w.onmessage = (e) => { const m = e.data; window.log.push(JSON.stringify(m).slice(0, 300)); if (window.log.length > 50) window.log.shift(); if (m.ready) return r(); const p = waiting.get(m.id); if (!p) return; if (m.stream) p.out += m.text; if (m.done) { waiting.delete(m.id); p.done(); } }; });
window.run = (code) => new Promise((resolve) => { const id = ++n, t = performance.now(), p = { out: "", done: () => resolve({ out: p.out, ms: performance.now() - t }) }; waiting.set(id, p); w.postMessage({ id, code }); });
ready.then(() => { window.readyMs = performance.now() - t0; });
</script>`,
  "/pyodide.html": `<!doctype html><meta charset="utf-8"><script type="module">
const t0 = performance.now();
const { loadPyodide } = await import("/py/pyodide.mjs");
const py = await loadPyodide({ indexURL: "/py/" });
let out = "";
py.setStdout({ batched: (s) => { out += s + "\\n"; } });
window.run = async (code) => { const t = performance.now(); out = ""; try { await py.loadPackagesFromImports(code, { messageCallback: () => {} }); py.runPython(code); } catch (e) { out += "ERROR " + e; } return { out, ms: performance.now() - t }; };
window.readyMs = performance.now() - t0;
</script>`,
};

const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".zip": "application/zip", ".whl": "application/zip", ".html": "text/html" };
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|wasm))/;
let sent = { wire: 0, decoded: 0, requests: 0, files: {} };
const packed = new Map();
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let body, type;
  if (PAGES[path]) body = Buffer.from(PAGES[path]), type = "text/html";
  else {
    const [root, rest] = path.startsWith("/sb/") ? [DIST, path.slice(4)] : path.startsWith("/py/") ? [PYODIDE, path.slice(4)] : [null, null];
    const file = root && normalize(join(root, rest));
    if (!file || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    body = readFileSync(file), type = MIME[extname(file)] ?? "application/octet-stream";
  }
  const headers = { "content-type": type, "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
  let out = body;
  if (/\bbr\b/.test(String(req.headers["accept-encoding"] ?? "")) && body.length > 1024 && COMPRESSIBLE.test(type)) {
    if (!packed.has(path)) packed.set(path, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }));
    out = packed.get(path);
    headers["content-encoding"] = "br";
  }
  headers["content-length"] = String(out.length);
  sent.wire += out.length, sent.decoded += body.length, sent.requests++;
  sent.files[path] = (sent.files[path] ?? 0) + out.length;
  res.writeHead(200, headers);
  res.end(out);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function session(page) {
  const profile = mkdtempSync(join(tmpdir(), "sb-bench-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  try {
    const port = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    // (each step bounded: a run that never ends is reported, not waited for)
    const ev = async (expression, ms = 180000) => {
      const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), sleep(ms).then(() => ({ timedOut: true }))]);
      if (r?.timedOut) {
        const log = await Promise.race([send("Runtime.evaluate", { expression: "JSON.stringify((window.log || []).slice(-8))", returnByValue: true }), sleep(5000)]);
        throw new Error(`${page}: no answer in ${ms / 1000} s to ${expression.slice(0, 80)}; the page's last messages: ${log?.result?.value}`);
      }
      if (r?.exceptionDetails) throw new Error(`${page}: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
      return r?.result?.value;
    };
    const step = (what) => console.error(`  ${page} ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    sent = { wire: 0, decoded: 0, requests: 0, files: {} };
    var t0 = Date.now();
    await send("Page.navigate", { url: base + page });
    for (let i = 0; i < 1200 && !(await ev("typeof window.readyMs === 'number'")); i++) await sleep(50);
    step("ready");
    const first = await ev("run('print(1 + 1)')");
    step("first result");
    const cold = { readyMs: Math.round(await ev("window.readyMs")), firstResultMs: Date.now() - t0, out: first?.out?.trim(), ...take() };
    const np = await ev("run('import numpy\\nprint(numpy.arange(10).sum())')");
    const numpy = { ms: Math.round(np?.ms ?? -1), out: np?.out?.trim(), ...take() };
    step("numpy");
    const speed = {};
    for (const [name, code] of Object.entries(WORKLOADS)) {
      const warm = await ev(`run(${JSON.stringify(code)})`);
      const times = [];
      for (let i = 0; i < REPS; i++) times.push((await ev(`run(${JSON.stringify(code)})`)).ms);
      times.sort((a, b) => a - b);
      speed[name] = { ms: Math.round(times[REPS >> 1]), out: warm?.out?.trim() };
      step(`${name}: ${speed[name].ms} ms`);
    }
    ws.close();
    return { cold, numpy, speed };
  } finally {
    chrome.kill("SIGKILL");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}
function take() {
  const r = { wire: sent.wire, decoded: sent.decoded, requests: sent.requests, files: Object.entries(sent.files).sort((a, b) => b[1] - a[1]).slice(0, 8) };
  sent = { wire: 0, decoded: 0, requests: 0, files: {} };
  return r;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const mb = (x) => (x / 1e6).toFixed(2);
const results = {};
for (const [engine, page] of [["Sagebrush", "/sagebrush.html"], ["Pyodide", "/pyodide.html"]]) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await session(page));
  results[engine] = runs;
}
server.close();
const row = (engine) => {
  const rs = results[engine];
  return {
    coldWire: median(rs.map((r) => r.cold.wire)), coldDecoded: median(rs.map((r) => r.cold.decoded)),
    readyMs: median(rs.map((r) => r.cold.readyMs)), firstResultMs: median(rs.map((r) => r.cold.firstResultMs)),
    numpyWire: median(rs.map((r) => r.numpy.wire)), numpyDecoded: median(rs.map((r) => r.numpy.decoded)), numpyMs: median(rs.map((r) => r.numpy.ms)),
    speed: Object.fromEntries(Object.keys(WORKLOADS).map((w) => [w, median(rs.map((r) => r.speed[w].ms))])),
  };
};
const S = row("Sagebrush"), P = row("Pyodide");
console.log(`| | Sagebrush | Pyodide |\n|---|---|---|`);
console.log(`| cold start, transferred / decoded | ${mb(S.coldWire)} / ${mb(S.coldDecoded)} MB | ${mb(P.coldWire)} / ${mb(P.coldDecoded)} MB |`);
console.log(`| interpreter ready | ${S.readyMs} ms | ${P.readyMs} ms |`);
console.log(`| first print(1 + 1) result, from navigation | ${S.firstResultMs} ms | ${P.firstResultMs} ms |`);
console.log(`| import numpy: transferred / decoded | ${mb(S.numpyWire)} / ${mb(S.numpyDecoded)} MB | ${mb(P.numpyWire)} / ${mb(P.numpyDecoded)} MB |`);
console.log(`| import numpy: time | ${S.numpyMs} ms | ${P.numpyMs} ms |`);
for (const w of Object.keys(WORKLOADS)) console.log(`| ${w} | ${S.speed[w]} ms | ${P.speed[w]} ms |`);
// both must have printed the same thing (else the comparison is void)
const bad = [];
for (const [engine, rs] of Object.entries(results))
  for (const r of rs) {
    if (r.cold.out !== "2") bad.push(`${engine} print(1 + 1): ${r.cold.out}`);
    if (r.numpy.out !== "45") bad.push(`${engine} numpy: ${r.numpy.out}`);
  }
for (const w of Object.keys(WORKLOADS)) {
  const a = results.Sagebrush[0].speed[w].out, b = results.Pyodide[0].speed[w].out;
  if (a !== b) bad.push(`${w}: Sagebrush ${JSON.stringify(a)}, Pyodide ${JSON.stringify(b)}`);
}
if (bad.length) console.log("DIFFERENT OUTPUTS:\n  " + bad.join("\n  "));
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ when: new Date().toISOString(), runs: RUNS, reps: REPS, results, summary: { Sagebrush: S, Pyodide: P } }, null, 1) + "\n");
process.exit(bad.length ? 1 : 0);
