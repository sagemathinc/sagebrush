// Sagebrush's Python against Pyodide (CPython compiled to WebAssembly), in
// headless Chrome, the same way for both: a minimal page per engine, its
// files served from this machine compressed as a CDN serves them (brotli,
// quality 5), a fresh browser profile for each cold start.
//
//   - Download: what a cold start transfers (on the wire, and decoded), and
//     the time until the interpreter is ready and print(1 + 1) has run.
//   - numpy: what importing it adds, and how long that takes.
//   - Speed: a few workloads, each run 5 times after a warm-up run in the
//     same session (the median, in ms, timed inside the page).
//   - Memory (Linux): the private memory (USS) of the page's renderer
//     process, where the page, Sagebrush's Web Worker, their JavaScript
//     heaps and Pyodide's WebAssembly memory all live (the largest renderer
//     started after about:blank; the browser's other renderers, about the
//     same for both engines, are recorded but not counted): on about:blank, after
//     print(1 + 1), after import numpy, and for each workload its peak
//     (sampled every 50 ms from /proc while the workload's setup and
//     warm-up execute; not while it is timed, since reading a process's
//     memory map slows its allocations) and its level after a forced garbage
//     collection; with each engine's JavaScript heap (CDP's
//     Runtime.getHeapUsage, of the page and of Sagebrush's worker) and the
//     size of Pyodide's WebAssembly memory (which never shrinks); then 30 s
//     idle (10 s, a forced collection, 20 s), and a timeline of the whole
//     session, one sample per 250 ms, with its phases marked.  Every
//     execution of every workload, warm-up and timed, in every cold start
//     of both engines, must print what Sagebrush's first warm-up printed,
//     and every timing must be a finite number; else the run fails.
//
// The pages are minimal interpreter pages, not the notebook: Sagebrush in
// its Web Worker (web/dist/sagebrush-worker.js, the notebook's own worker),
// Pyodide on the page's main thread, as its quickstart starts it.  Each cold
// start is a fresh browser profile (no browser cache); the server is this
// one local server throughout, and one discarded priming session per engine
// comes first, so its compressed copies (brotli 5, made once per file) and
// the OS file cache exist before anything is timed; then the engines
// alternate.  Bytes are the response bodies this server sent (compressed
// where compressible), not HTTP overhead.  Times are local and end to end:
// the first-result time is from navigation, including this script's polling.
//
//   bun web/build.ts && node web/bench-compare.mjs --pyodide DIR [--runs 3] [--only json,loop] [--json out.json]
//   node web/bench-compare.mjs --check out.json   (a saved run's results checked again)
//   (DIR: Pyodide's distribution: pyodide.mjs, pyodide.asm.wasm,
//   python_stdlib.zip, pyodide-lock.json, and the wheels of numpy and what
//   it needs; CHROME=... for the browser)
//
// Sagebrush does not aim at CPython's every behaviour: these workloads are
// ones both run the same way, which says nothing about code that only
// CPython runs.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// The check of a run's results (also `--check FILE.json`, a saved run's):
// every engine's print(1 + 1) and numpy check, and every execution,
// warm-up and timed, of every workload in every cold start of both
// engines, prints what Sagebrush's first warm-up printed, which is not empty
// or an error; there are `reps` timed runs, each a finite non-negative time
// (astra's TEST-272-1).  The problems found, or [].
function check(results, names, reps) {
  const bad = [];
  const engines = ["Sagebrush", "Pyodide"];
  for (const engine of engines) if (!Array.isArray(results?.[engine]) || !results[engine].length) bad.push(`${engine}: no cold starts`);
  if (bad.length) return bad;
  for (const engine of engines)
    for (const r of results[engine]) {
      if (r.cold?.out !== "2") bad.push(`${engine} print(1 + 1): ${r.cold?.out}`);
      if (r.numpy?.out !== "45") bad.push(`${engine} numpy: ${r.numpy?.out}`);
    }
  for (const w of names) {
    const want = results.Sagebrush[0].speed?.[w]?.out;
    // (a setup's output, where there is one, the same everywhere too)
    const wantSetup = results.Sagebrush[0].speed?.[w]?.setup;
    if (wantSetup !== undefined && (wantSetup === "" || /ERROR|Traceback/.test(wantSetup))) bad.push(`${w}: Sagebrush's setup printed ${JSON.stringify(wantSetup)}`);
    for (const engine of engines) results[engine].forEach((r, i) => { if (r.speed?.[w]?.setup !== wantSetup) bad.push(`${w}: ${engine} cold start ${i + 1} setup printed ${JSON.stringify(r.speed?.[w]?.setup)}`); });
    if (typeof want !== "string" || want === "" || /ERROR|Traceback/.test(want)) bad.push(`${w}: Sagebrush printed ${JSON.stringify(want)}`);
    for (const engine of engines)
      results[engine].forEach((r, i) => {
        const s = r.speed?.[w];
        if (!s || !Array.isArray(s.outs) || !Array.isArray(s.times) || s.outs.length !== reps || s.times.length !== reps) return void bad.push(`${w}: ${engine} cold start ${i + 1} lacks its ${reps} timed runs`);
        if (s.out !== want) bad.push(`${w}: ${engine} cold start ${i + 1} warm-up printed ${JSON.stringify(s.out)}, not ${JSON.stringify(want)}`);
        s.outs.forEach((o, k) => { if (o !== want) bad.push(`${w}: ${engine} cold start ${i + 1} timed run ${k + 1} printed ${JSON.stringify(o)}`); });
        s.times.forEach((t, k) => { if (typeof t !== "number" || !Number.isFinite(t) || t < 0) bad.push(`${w}: ${engine} cold start ${i + 1} timed run ${k + 1} took ${t}`); });
      });
  }
  return bad;
}
if (opt("--check")) {
  const saved = JSON.parse(readFileSync(opt("--check"), "utf8"));
  const bad = check(saved.results, Object.keys(saved.results?.Sagebrush?.[0]?.speed ?? {}), saved.reps);
  console.log(bad.length ? "DIFFERENT OUTPUTS:\n  " + bad.join("\n  ") : "every execution printed the same result");
  process.exit(bad.length ? 1 : 0);
}
const PYODIDE = opt("--pyodide");
if (!PYODIDE || !existsSync(join(PYODIDE, "pyodide.mjs"))) throw new Error("--pyodide DIR: Pyodide's distribution (pyodide.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json, wheels)");
const RUNS = Number(opt("--runs") ?? 3);
const REPS = 5;

// (two operands of about `digits` decimal digits, made from hex strings
// once before the warm-up run, untimed (in both engines that takes longer
// than the product: a hex string's conversion is linear, but the strings
// themselves must be built); then only their product is timed, and its size
// and a residue printed, both linear)
const bigMul = (digits) => {
  const hex = Math.ceil((digits * Math.log2(10)) / 4);
  return {
    setup: `h = ('0123456789abcdef' * ${Math.ceil(hex / 16) + 1})[:${hex}]\na = int('1' + h, 16)\nb = int('f' + h[::-1], 16)\nprint(a.bit_length(), b.bit_length())`,
    code: "c = a * b\nprint(c.bit_length(), c % 1000003)",
  };
};
// (each a program, or { setup, code }: setup run once before the warm-up,
// untimed, its output checked as the runs' are)
const WORKLOADS = {
  "loop": "s = 0\nfor i in range(3000000):\n    s += i * i\nprint(s)",
  "recursion": "def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nprint(fib(25))",
  "dict and str": "d = {str(i): i for i in range(200000)}\nprint(sum(len(k) for k in sorted(d)), d['12345'])",
  // (bit_length and a remainder: str() of a number past 4300 digits is a
  // ValueError in CPython 3.11+ and in Sagebrush alike)
  "big integers": "import math\nx = math.factorial(20000)\nprint(x.bit_length(), x % 1000003)",
  "big multiply, 10^6 digits": bigMul(10 ** 6),
  "big multiply, 10^7 digits": bigMul(10 ** 7),
  "sieve": "n = 2000000\ns = bytearray([1]) * (n + 1)\ns[0] = s[1] = 0\nfor p in range(2, int(n ** 0.5) + 1):\n    if s[p]:\n        s[p * p::p] = bytes(len(range(p * p, n + 1, p)))\nprint(sum(s))",
  "json": "import json\nx = [{'a': i, 'b': [i, str(i), i / 2], 'c': {'d': None, 'e': True}} for i in range(30000)]\ny = json.loads(json.dumps(x))\nprint(len(y), y[-1]['b'])",
  "numpy matmul": "import numpy as np\nA = np.arange(300 * 300, dtype=float).reshape(300, 300) % 7\nprint(float((A @ A).sum()))",
  "numpy elementwise": "import numpy as np\nx = np.linspace(0, 1, 1000000)\nprint(round(float(np.sum(np.sin(x) * x + x ** 2)), 6))",
  // Adversarial rows, where Sagebrush's design should be weakest.
  // (2,000 distinct small functions, each compiled by exec() and called once:
  // Sagebrush compiles Python to JavaScript that V8 then compiles, where
  // CPython's bytecode compiler is cheap; each run's sources differ, by a
  // comment, so that no run reuses an earlier one's compilation)
  "exec, 2000 functions": {
    setup: "run = [0]\nprint('ready')",
    code: "run[0] += 1\ns = 0\nfor i in range(2000):\n    ns = {}\n    exec(f'def f(x):  # {run[0]}\\n    y = x * {i} + {i % 7}\\n    return y - {i % 3}\\n', ns)\n    s += ns['f'](i)\nprint(s)",
  },
  // (one call site and one attribute load seeing 50 classes with different
  // instance layouts, so that V8's inline caches there are megamorphic; the
  // monomorphic row is the same loop over instances of one class)
  "megamorphic, 50 classes": {
    setup: "src = ''\nfor k in range(50):\n    fields = ''.join(f'        self.p{j}_{k} = {j}\\n' for j in range(k % 8))\n    src += f'class C{k}:\\n    def __init__(self, v):\\n{fields}        self.v = v\\n    def get(self):\\n        return self.v + {k}\\n'\nexec(src)\nobjs = [globals()[f'C{i % 50}'](i) for i in range(200000)]\nprint(len(objs), len({type(o) for o in objs}))",
    code: "s = 0\nfor o in objs:\n    s += o.get() + o.v\nprint(s)",
  },
  "monomorphic, 1 class": {
    setup: "class C:\n    def __init__(self, v):\n        self.v = v\n    def get(self):\n        return self.v + 7\nobjs1 = [C(i) for i in range(200000)]\nprint(len(objs1))",
    code: "s = 0\nfor o in objs1:\n    s += o.get() + o.v\nprint(s)",
  },
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
window.wasmBytes = () => py._module.HEAP8.buffer.byteLength;
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

// The browser's renderer processes (its descendants whose command line has
// --type=renderer), and their private memory in bytes, from /proc
function rendererPids(root) {
  const kids = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch {}
  }
  const out = [], todo = [root];
  while (todo.length) {
    const p = todo.pop();
    for (const c of kids.get(p) ?? []) {
      todo.push(c);
      try { if (readFileSync(`/proc/${c}/cmdline`, "utf8").includes("--type=renderer")) out.push(c); } catch {}
    }
  }
  return out;
}
// (private memory, USS: pages no other process maps, which is what a
// process adds; RSS would count the browser's shared code in every
// renderer again)
function uss(pid) {
  try {
    const t = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return 1024 * (Number(/Private_Clean:\s+(\d+)/.exec(t)?.[1] ?? 0) + Number(/Private_Dirty:\s+(\d+)/.exec(t)?.[1] ?? 0));
  } catch { return 0; }
}
function rss(pids) {
  let b = 0;
  for (const p of pids) b += uss(p);
  return b;
}
// each renderer: its pid, private and resident memory, and its renderer client id
function detail(pids) {
  return pids.map((p) => {
    let rssKb = 0, id = "";
    try { rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))?.[1] ?? 0); id = /--renderer-client-id=(\d+)/.exec(readFileSync(`/proc/${p}/cmdline`, "utf8"))?.[1] ?? ""; } catch {}
    return { pid: p, uss: uss(p), rss: rssKb * 1024, client: id };
  });
}
// the renderers' private memory every 50 ms (their list refreshed every 500 ms): the peak since reset()
// (once page() has named the page's renderer, only it: the browser's other
// renderers hold about the same memory for either engine)
function sampler(root) {
  let pids = rendererPids(root), peak = 0, k = 0, pagePid = 0, last = -Infinity, paused = false;
  const t0 = Date.now(), timeline = [], marks = []; // [ms, bytes]; { t, what, wasm? }
  const tick = () => {
    if (paused) return 0;
    if (!pagePid && ++k % 10 === 0) pids = rendererPids(root);
    const v = rss(pagePid ? [pagePid] : pids), t = Date.now() - t0;
    if (v > peak) peak = v;
    // (the timeline: one sample per 250 ms, of the page's renderer once known)
    if (pagePid && t - last >= 250) { timeline.push([t, v]); last = t; }
    return v;
  };
  const h = setInterval(tick, 50);
  return {
    now: () => { if (!pagePid) pids = rendererPids(root); return rss(pagePid ? [pagePid] : pids); },
    all: () => rss(rendererPids(root)),
    // the page's renderer: the largest of those started after about:blank
    page: (before) => { const d = detail(rendererPids(root)).filter((x) => !before.includes(x.pid)).sort((a, b) => b.uss - a.uss); pagePid = d[0]?.pid ?? 0; return pagePid; },
    reset: () => { if (!pagePid) pids = rendererPids(root); peak = 0; tick(); },
    peak: () => (tick(), peak),
    processes: () => rendererPids(root).length,
    detail: () => detail(rendererPids(root)),
    mark: (what, wasm) => marks.push({ t: Date.now() - t0, what, ...(wasm === undefined ? {} : { wasm }) }),
    timeline: () => ({ samples: timeline, marks }),
    stop: () => clearInterval(h),
    // (reading a process's smaps_rollup walks its page tables under its
    // memory-map lock, which slows the page's own allocations: so no
    // sampling while a workload is timed)
    pause: () => { paused = true; },
    resume: () => { paused = false; },
  };
}

async function session(page) {
  const profile = mkdtempSync(join(tmpdir(), "sb-bench-"));
  // (no spare renderer kept ready: only the page's own renderer counted)
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--disable-features=SpareRendererForSitePerProcess", "about:blank"], { stdio: "ignore" });
  let mem;
  try {
    const port = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    // (Sagebrush's worker attached too, for its heap: its CDP session)
    let worker;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") worker = m.params.sessionId;
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    };
    const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    mem = sampler(chrome.pid);
    // the JavaScript heaps (page, worker: used, total and ArrayBuffer backing
    // stores where CDP reports them) and Pyodide's WebAssembly memory
    const heaps = async () => {
      const h = {};
      for (const [k, sid] of [["page", undefined], ["worker", worker]]) {
        if (k === "worker" && !sid) continue;
        const r = await send("Runtime.getHeapUsage", {}, sid);
        h[k] = { used: r?.usedSize, total: r?.totalSize, backing: r?.backingStorageSize ?? null };
      }
      h.wasm = await ev("window.wasmBytes ? window.wasmBytes() : null");
      return h;
    };
    const gc = async () => {
      await send("HeapProfiler.collectGarbage");
      if (worker) await send("HeapProfiler.collectGarbage", {}, worker);
      await sleep(500);
    };
    const blankRss = mem.now(), blankPids = rendererPids(chrome.pid);
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
    await gc();
    const pagePid = mem.page(blankPids);
    const mark = async (what) => mem.mark(what, await ev("window.wasmBytes ? window.wasmBytes() : null"));
    await mark("print(1 + 1) done");
    cold.mem = { blankRss, pagePid, rss: mem.now(), all: mem.all(), renderers: mem.detail(), heap: await heaps() };
    const np = await ev("run('import numpy\\nprint(numpy.arange(10).sum())')");
    const numpy = { ms: Math.round(np?.ms ?? -1), out: np?.out?.trim(), ...take() };
    await gc();
    numpy.mem = { rss: mem.now(), all: mem.all(), renderers: mem.detail(), heap: await heaps() };
    await mark("import numpy done");
    step("numpy");
    const speed = {};
    for (const [name, w] of Object.entries(WORKLOADS)) {
      const { setup, code } = typeof w === "string" ? { code: w } : w;
      const before = mem.now();
      await mark(`${name}: start`);
      mem.reset();
      const prep = setup === undefined ? undefined : (await ev(`run(${JSON.stringify(setup)})`))?.out?.trim();
      const warm = await ev(`run(${JSON.stringify(code)})`);
      // (the peak: during the setup and the warm-up, which do the same work as each timed run)
      const peakRss = mem.peak();
      mem.pause();
      // (every timed run's output kept: each must equal the warm-up's)
      const timed = [];
      for (let i = 0; i < REPS; i++) {
        const r = await ev(`run(${JSON.stringify(code)})`);
        timed.push({ ms: r?.ms, out: r?.out?.trim() });
      }
      mem.resume();
      await mark(`${name}: end`);
      await gc();
      await mark(`${name}: after GC`);
      const memory = { before, peakRss, afterGcRss: mem.now(), all: mem.all(), renderers: mem.detail(), heap: await heaps() };
      const times = timed.map((t) => t.ms).sort((a, b) => a - b);
      speed[name] = { ms: Math.round(times[REPS >> 1]), out: warm?.out?.trim(), times: timed.map((t) => t.ms), outs: timed.map((t) => t.out), mem: memory, ...(prep === undefined ? {} : { setup: prep }) };
      step(`${name}: ${speed[name].ms} ms`);
    }
    // (then idle: does each engine keep its peak? after the last workload,
    // 10 s later, after a forced GC, and 20 s after that; then every global
    // the workloads made deleted and collected (Python's gc and the
    // browser's), so only what each engine keeps beyond live data remains)
    const idle = { end: mem.now() };
    await sleep(10000);
    idle.after10s = mem.now();
    await mark("idle 10 s");
    await gc();
    idle.afterGc = mem.now();
    await mark("idle, after GC");
    await sleep(20000);
    idle.after30s = mem.now();
    await mark("idle 30 s");
    idle.heap = await heaps();
    const cleared = await ev(`run(${JSON.stringify("import gc as _gc\nfor _k in [k for k in globals() if not k.startswith('_')]:\n    del globals()[_k]\n_gc.collect()\nprint(len([k for k in globals() if not k.startswith('_')]))")})`);
    await gc();
    await sleep(5000);
    idle.cleared = { out: cleared?.out?.trim(), rss: mem.now(), heap: await heaps() };
    await mark("globals deleted, collected");
    const timeline = mem.timeline();
    ws.close();
    return { cold, numpy, speed, idle, timeline };
  } finally {
    mem?.stop();
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
// (one discarded priming session per engine first, so the server's
// compressed copies and the OS file cache exist before anything is timed;
// then the engines alternate, one cold start each, RUNS times)
const ENGINES = [["Sagebrush", "/sagebrush.html"], ["Pyodide", "/pyodide.html"]];
for (const [, page] of ENGINES) await session(page);
const results = { Sagebrush: [], Pyodide: [] };
for (let i = 0; i < RUNS; i++) for (const [engine, page] of ENGINES) results[engine].push(await session(page));
server.close();
const row = (engine) => {
  const rs = results[engine];
  return {
    coldWire: median(rs.map((r) => r.cold.wire)), coldDecoded: median(rs.map((r) => r.cold.decoded)),
    readyMs: median(rs.map((r) => r.cold.readyMs)), firstResultMs: median(rs.map((r) => r.cold.firstResultMs)),
    numpyWire: median(rs.map((r) => r.numpy.wire)), numpyDecoded: median(rs.map((r) => r.numpy.decoded)), numpyMs: median(rs.map((r) => r.numpy.ms)),
    speed: Object.fromEntries(Object.keys(WORKLOADS).map((w) => [w, median(rs.map((r) => r.speed[w].ms))])),
    mem: {
      blank: median(rs.map((r) => r.cold.mem.blankRss)), started: median(rs.map((r) => r.cold.mem.rss)), numpy: median(rs.map((r) => r.numpy.mem.rss)),
      wasmStarted: median(rs.map((r) => r.cold.mem.heap.wasm ?? 0)), wasmNumpy: median(rs.map((r) => r.numpy.mem.heap.wasm ?? 0)),
      idle: { cleared: median(rs.map((r) => r.idle.cleared.rss)), clearedWasm: median(rs.map((r) => r.idle.cleared.heap.wasm ?? 0)), end: median(rs.map((r) => r.idle.end)), after10s: median(rs.map((r) => r.idle.after10s)), afterGc: median(rs.map((r) => r.idle.afterGc)), after30s: median(rs.map((r) => r.idle.after30s)), wasm: median(rs.map((r) => r.idle.heap.wasm ?? 0)) },
      rows: Object.fromEntries(Object.keys(WORKLOADS).map((w) => [w, {
        peak: median(rs.map((r) => r.speed[w].mem.peakRss)), afterGc: median(rs.map((r) => r.speed[w].mem.afterGcRss)), wasm: median(rs.map((r) => r.speed[w].mem.heap.wasm ?? 0)),
      }])),
    },
  };
};
const S = row("Sagebrush"), P = row("Pyodide");
// (min-max over the cold starts, beside each median)
const span = (xs) => `${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))}`;
const ranges = (engine) => {
  const rs = results[engine];
  return { ready: span(rs.map((r) => r.cold.readyMs)), first: span(rs.map((r) => r.cold.firstResultMs)), numpy: span(rs.map((r) => r.numpy.ms)), speed: Object.fromEntries(Object.keys(WORKLOADS).map((w) => [w, span(rs.map((r) => r.speed[w].ms))])) };
};
const RS = ranges("Sagebrush"), RP = ranges("Pyodide");
console.log(`| | Sagebrush | Pyodide |\n|---|---|---|`);
console.log(`| cold start, transferred / decoded | ${mb(S.coldWire)} / ${mb(S.coldDecoded)} MB | ${mb(P.coldWire)} / ${mb(P.coldDecoded)} MB |`);
console.log(`| interpreter ready | ${S.readyMs} ms (${RS.ready}) | ${P.readyMs} ms (${RP.ready}) |`);
console.log(`| first print(1 + 1) result, from navigation | ${S.firstResultMs} ms (${RS.first}) | ${P.firstResultMs} ms (${RP.first}) |`);
console.log(`| import numpy: transferred / decoded | ${mb(S.numpyWire)} / ${mb(S.numpyDecoded)} MB | ${mb(P.numpyWire)} / ${mb(P.numpyDecoded)} MB |`);
console.log(`| import numpy: time | ${S.numpyMs} ms (${RS.numpy}) | ${P.numpyMs} ms (${RP.numpy}) |`);
for (const w of Object.keys(WORKLOADS)) console.log(`| ${w} | ${S.speed[w]} ms (${RS.speed[w]}) | ${P.speed[w]} ms (${RP.speed[w]}) |`);
// memory: renderer RSS (MB), medians over the cold starts; Pyodide's WebAssembly memory in brackets
console.log(`\n| the page's renderer process, private memory (MB) | Sagebrush | Pyodide (its WebAssembly memory) |\n|---|---|---|`);
console.log(`| (the browser's renderers on about:blank, for scale) | ${mb(S.mem.blank)} | ${mb(P.mem.blank)} |`);
console.log(`| after print(1 + 1) | ${mb(S.mem.started)} | ${mb(P.mem.started)} (${mb(P.mem.wasmStarted)}) |`);
console.log(`| after import numpy | ${mb(S.mem.numpy)} | ${mb(P.mem.numpy)} (${mb(P.mem.wasmNumpy)}) |`);
console.log(`| idle after the last workload: at once / 10 s / after GC / 30 s | ${[S.mem.idle.end, S.mem.idle.after10s, S.mem.idle.afterGc, S.mem.idle.after30s].map(mb).join(" / ")} | ${[P.mem.idle.end, P.mem.idle.after10s, P.mem.idle.afterGc, P.mem.idle.after30s].map(mb).join(" / ")} (${mb(P.mem.idle.wasm)}) |`);
console.log(`| every global deleted and collected | ${mb(S.mem.idle.cleared)} | ${mb(P.mem.idle.cleared)} (${mb(P.mem.idle.clearedWasm)}) |`);
for (const w of Object.keys(WORKLOADS)) console.log(`| ${w}: peak / after GC | ${mb(S.mem.rows[w].peak)} / ${mb(S.mem.rows[w].afterGc)} | ${mb(P.mem.rows[w].peak)} / ${mb(P.mem.rows[w].afterGc)} (${mb(P.mem.rows[w].wasm)}) |`);
// both must have printed the same thing (else the comparison is void)
const bad = check(results, Object.keys(WORKLOADS), REPS);
if (bad.length) console.log("DIFFERENT OUTPUTS:\n  " + bad.join("\n  "));
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ when: new Date().toISOString(), runs: RUNS, reps: REPS, results, summary: { Sagebrush: S, Pyodide: P } }, null, 1) + "\n");
process.exit(bad.length ? 1 : 0);
