// The threads demo page (numerics-core r4.2, M0): a dense matrix product C = A*B computed by Sagebrush's Rust
// kernel (engine/nd, WebAssembly SIMD128) on 1 and on N threads of this browser tab, with the speedup and a
// correctness check that must pass before any timing is shown. daybreak2's acceptance list: the same seeded inputs
// and kernel for every thread count; crossOriginIsolated, backend, microkernel, sizes and thread counts shown;
// module load, pool creation and first dispatch reported apart from the warm median and p95.

const $ = (id: string) => document.getElementById(id)!;
const STACK = 1 << 20;
const BASE = 8 << 20; // above the module's own data and the linker's stack
const PAGE = 65536;

type Result = {
  n: number; correct: boolean; maxErr: number; bound: number; samples: number; identical: Record<number, boolean>;
  firstMs?: Record<number, number>; times?: Record<number, number[]>; error?: string;
};

let pool: null | { conductor: Worker; helpers: Worker[]; memory: WebAssembly.Memory; scratchLen: number; microkernel: string; maxT: number; setup: Record<string, number> } = null;

function threadCounts(max: number): number[] {
  const out: number[] = [];
  for (let t = 1; t <= max; t *= 2) out.push(t);
  if (out[out.length - 1] !== max) out.push(max);
  return out;
}

function env() {
  const hw = navigator.hardwareConcurrency || 1;
  const rows: [string, string][] = [
    ["crossOriginIsolated", String(self.crossOriginIsolated)],
    ["SharedArrayBuffer", typeof SharedArrayBuffer === "function" ? "available" : "missing"],
    ["logical cores (hardwareConcurrency)", String(hw)],
    ["backend", "browser WebAssembly (SIMD128, threads over a shared memory)"],
    ["user agent", navigator.userAgent],
  ];
  $("env").innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td></tr>`).join("");
  return self.crossOriginIsolated && typeof SharedArrayBuffer === "function";
}

async function startPool(maxT: number) {
  const setup: Record<string, number> = {};
  let t = performance.now();
  const module = await WebAssembly.compileStreaming(fetch(new URL("sagebrush-nd.wasm", location.href)));
  setup.compileMs = performance.now() - t;
  const memory = new WebAssembly.Memory({ initial: Math.ceil((BASE + (8 << 20)) / PAGE), maximum: 65536, shared: true });
  const ctl = BASE, desc = BASE + 64, text = BASE + 1024;
  const stacks = BASE + PAGE; // T stacks, then the data
  const workerUrl = new URL("threads-worker.js", location.href);
  t = performance.now();
  const conductor = new Worker(workerUrl, { type: "module" });
  const helpers: Worker[] = [];
  const ready: Promise<any>[] = [];
  const once = (w: Worker) => new Promise<any>((res, rej) => {
    w.onmessage = (e) => res(e.data);
    w.onerror = (e) => rej(new Error(e.message));
  });
  for (let id = 1; id < maxT; id++) {
    const w = new Worker(workerUrl, { type: "module" });
    ready.push(once(w));
    w.postMessage({ role: "helper", module, memory, id, stackTop: stacks + (id + 1) * STACK, ctl, desc });
    helpers.push(w);
  }
  const c0 = once(conductor);
  conductor.postMessage({ role: "conductor", module, memory, stackTop: stacks + STACK, ctl, desc, helpers: maxT - 1, text });
  const info = await c0;
  await Promise.all(ready);
  setup.poolMs = performance.now() - t;
  setup.instantiateMs = info.instantiateMs;
  pool = { conductor, helpers, memory, scratchLen: info.scratchLen, microkernel: info.microkernel, maxT, setup };
}

function layout(n: number) {
  const p = pool!;
  const dataStart = BASE + PAGE + (p.maxT + 1) * STACK;
  const bytes = n * n * 8;
  const a = dataStart, b = a + bytes, c = b + bytes, scratch = c + bytes;
  const scratchStride = p.scratchLen * 8;
  const end = scratch + p.maxT * scratchStride;
  const have = p.memory.buffer.byteLength;
  if (end > have) p.memory.grow(Math.ceil((end - have) / PAGE));
  return { n, a, b, c, scratch, scratchStride };
}

function stats(xs: number[]) {
  const s = [...xs].sort((x, y) => x - y);
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(f * s.length) - 1))];
  return { median: q(0.5), p95: q(0.95), best: s[0] };
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)) + " ms";

async function run() {
  const btn = $("run") as HTMLButtonElement;
  btn.disabled = true;
  $("out").innerHTML = "";
  try {
    const n = Number(($("n") as HTMLSelectElement).value);
    const reps = Math.max(1, Number(($("reps") as HTMLSelectElement).value) || 11);
    const maxT = Math.min(16, Number(($("maxT") as HTMLSelectElement).value));
    const threads = threadCounts(maxT);
    if (!pool || pool.maxT !== maxT) {
      if (pool) { pool.conductor.postMessage({ cmd: "stop" }); for (const w of [pool.conductor, ...pool.helpers]) w.terminate(); }
      $("status").textContent = "Starting the thread pool…";
      await startPool(maxT);
    }
    const p = pool!;
    $("status").textContent = `Computing C = A·B, n = ${n}, with ${threads.join(", ")} threads (${reps} timed runs each)…`;
    const lay = layout(n);
    const res: Result = await new Promise((resolve) => {
      p.conductor.onmessage = (e) => {
        if (e.data?.progress) $("status").textContent = `Computing C = A·B, n = ${n}: ${e.data.progress}…`;
        else resolve(e.data);
      };
      p.conductor.postMessage({ cmd: "gemm", lay, threads, reps });
    });
    if (res.error) throw new Error(res.error);
    const ok = res.correct;
    let html = `<h2>Correctness ${ok ? "✓ passed" : "✗ FAILED"}</h2><ul>`;
    html += `<li>Max error over ${res.samples} sampled entries, against a plain scalar sum: ${res.maxErr.toExponential(2)} (bound ${res.bound.toExponential(2)}, r4.2 §7: ${"c·k·u·|A||B|"})</li>`;
    for (const [t, same] of Object.entries(res.identical)) html += `<li>${t} threads: result ${same ? "bit-identical to 1 thread" : "DIFFERENT from 1 thread"}</li>`;
    html += "</ul>";
    if (!ok) {
      $("out").innerHTML = html + "<p>Timings are not shown when correctness fails.</p>";
      $("status").textContent = "Correctness failed.";
      return;
    }
    const st = Object.fromEntries(threads.map((t) => [t, stats(res.times![t])]));
    const one = st[threads[0]].median;
    const gf = (ms: number) => ((2 * n ** 3) / (ms * 1e6)).toFixed(1);
    html += `<h2>Timings, n = ${n}</h2><p>Microkernel <code>${p.microkernel}</code>. Warm steady state, ${reps} runs per thread count, interleaved.</p>`;
    html += `<table class="t"><tr><th>threads</th><th>median</th><th>p95</th><th>best</th><th>GFLOP/s (median)</th><th>speedup vs 1 thread</th><th>first run</th></tr>`;
    for (const t of threads) {
      const s = st[t];
      html += `<tr><td>${t}</td><td>${fmt(s.median)}</td><td>${fmt(s.p95)}</td><td>${fmt(s.best)}</td><td>${gf(s.median)}</td><td><b>${(one / s.median).toFixed(2)}×</b></td><td>${fmt(res.firstMs![t])}</td></tr>`;
    }
    html += `</table><h2>One-time costs</h2><ul><li>Fetch and compile the kernel module: ${fmt(p.setup.compileMs)}</li><li>Start the ${p.maxT}-thread pool (workers, each instantiating the module): ${fmt(p.setup.poolMs)}</li></ul>`;
    const best = threads[threads.length - 1];
    $("out").innerHTML = html;
    $("status").textContent = `Done: ${fmt(one)} on 1 thread, ${fmt(st[best].median)} on ${best} threads — ${(one / st[best].median).toFixed(1)}× faster.`;
  } catch (e) {
    $("status").textContent = "Error: " + String((e as Error)?.message ?? e);
  } finally {
    btn.disabled = false;
  }
}

function init() {
  const okEnv = env();
  const hw = Math.min(16, navigator.hardwareConcurrency || 1);
  const sel = $("maxT") as HTMLSelectElement;
  for (const t of [1, 2, 4, 6, 8, 12, 16].filter((t) => t <= Math.max(hw, 1)).concat(hw > 1 && ![2, 4, 6, 8, 12, 16].includes(hw) ? [hw] : []))
    sel.add(new Option(String(t), String(t), t === hw, t === hw));
  if (!okEnv) {
    $("status").textContent = "This page needs cross-origin isolation (SharedArrayBuffer) for threads; it is not available here.";
    ($("run") as HTMLButtonElement).disabled = true;
    return;
  }
  $("run").addEventListener("click", run);
}
init();
