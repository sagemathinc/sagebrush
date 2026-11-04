// The threads demo page (numerics-core r4.2, M0): a dense matrix product C = A*B computed by Sagebrush's Rust
// kernel (engine/nd, WebAssembly SIMD128) on 1 and on N threads of this browser tab, with the speedup and a
// correctness check that must pass before any timing is shown. daybreak2's acceptance list: the same seeded inputs
// and kernel for every thread count; crossOriginIsolated, backend, microkernel, sizes and thread counts shown;
// module load, pool creation and first dispatch reported apart from the warm median and p95; a row whose p95 is
// over 1.5x its median flagged as noisy.
//
// Failures never hang (E3/ND-M3): every worker is registered the moment it exists and has error handlers for
// its whole life (crew.ts), startup and each job are bounded, and any failure, a startup failing partway
// included, terminates every worker made and drops the pool, so the next Run starts a new one.
//
// The memory map (engine/nd/src/boundary.rs): the module's own data and stack below its floor (checked to be
// below BASE); from BASE the control words and the descriptor; the thread stacks; then the writable
// arena (A, B, C and the scratch), above every stack.

import { Crew } from "./crew";

const $ = (id: string) => document.getElementById(id)!;
const STACK = 1 << 20;
const BASE = 8 << 20; // above the module's own data and the linker's stack
const PAGE = 65536;
// (startup: workers ready within this; a job: some message (progress or result) at least this often)
const STARTUP_MS = 20000;
const QUIET_MS = 90000;
const NOISY = 1.5; // p95 over this times the median: the row is flagged

type Result = {
  n: number; correct: boolean; maxErr: number; bound: number; samples: number; identical: Record<number, boolean>;
  firstMs?: Record<number, number>; times?: Record<number, number[]>; error?: string;
};

type Pool = {
  crew: Crew<Worker>; conductor: Worker | null; memory: WebAssembly.Memory; scratchLen: number; microkernel: string; maxT: number;
  setup: Record<string, number>; dead: boolean; fail: (why: string) => void;
};
let pool: Pool | null = null;
// the job in flight: its settle functions (a pool failure rejects it)
let active: { resolve: (r: Result) => void; reject: (e: Error) => void } | null = null;

// (test hooks: helper 1 refuses, throws or exits ("refuse", "throw", "exit"); or, on the first startup only, the
// second worker's constructor ("spawn") or postMessage ("post") throws; window.__ndWorkers counts workers made
// and terminated)
const fault = new URLSearchParams(location.search).get("fault") ?? undefined;
const counts = { made: 0, terminated: 0, startups: 0 };
if (fault) (self as any).__ndWorkers = counts;
function makeWorker(url: URL): Worker {
  const first = counts.startups === 1;
  if (fault === "spawn" && first && counts.made === 1) throw new Error("injected Worker constructor failure");
  const w = new Worker(url, { type: "module" });
  counts.made++;
  if (fault) {
    const terminate = w.terminate.bind(w), post = w.postMessage.bind(w);
    w.terminate = () => { counts.terminated++; terminate(); };
    if (fault === "post" && first && counts.made === 2) w.postMessage = () => { throw new DOMException("injected postMessage failure", "DataCloneError"); };
    else w.postMessage = post;
  }
  return w;
}

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

// Tear the pool down for good: every worker terminated, the pool dropped (never reused), the job in flight rejected.
function destroy(p: Pool, why: string) {
  if (p.dead) return;
  p.dead = true;
  p.crew.end(); // (every worker made, whether or not the conductor exists yet)
  if (pool === p) pool = null;
  const a = active;
  active = null;
  a?.reject(new Error(why));
}

async function startPool(maxT: number): Promise<Pool> {
  counts.startups++;
  const setup: Record<string, number> = {};
  let t = performance.now();
  const module = await WebAssembly.compileStreaming(fetch(new URL("sagebrush-nd.wasm", location.href)));
  setup.compileMs = performance.now() - t;
  const memory = new WebAssembly.Memory({ initial: Math.ceil(arenaStart(maxT) / PAGE) + 1, maximum: 65536, shared: true });
  const ctl = BASE, desc = BASE + 64;
  const stacks = BASE + PAGE; // T stacks, then the arena
  const workerUrl = new URL("threads-worker.js", location.href);
  t = performance.now();
  const p: Pool = {
    crew: new Crew<Worker>(() => makeWorker(workerUrl), (why) => destroy(p, why)),
    conductor: null, memory, scratchLen: 0, microkernel: "", maxT, setup, dead: false, fail: (why) => destroy(p, why),
  };
  try {
    for (let id = 1; id < maxT; id++)
      p.crew.add(`helper ${id}`, { role: "helper", module, memory, id, stackTop: stacks + (id + 1) * STACK, ctl, desc, fault });
    p.conductor = p.crew.add("the conductor", { role: "conductor", module, memory, stackTop: stacks + STACK, ctl, desc, helpers: maxT - 1 });
    const failed = new Promise<never>((_, rej) => {
      const timer = setTimeout(() => rej(new Error(`the thread pool did not start within ${STARTUP_MS / 1000} s`)), STARTUP_MS);
      const check = setInterval(() => { if (p.dead) { clearInterval(check); clearTimeout(timer); rej(new Error("the thread pool failed while starting")); } }, 100);
      void p.crew.started().finally(() => { clearTimeout(timer); clearInterval(check); });
    });
    const infos = await Promise.race([p.crew.started(), failed]);
    const info = infos[infos.length - 1]; // (the conductor's, added last)
    // (the layout's premise: the module's own part ends below the control words, stacks and arena)
    if (!(info.floor > 0 && info.floor <= BASE)) throw new Error(`the kernel module's data reaches ${info.floor}, above ${BASE}`);
    setup.poolMs = performance.now() - t;
    setup.instantiateMs = info.instantiateMs;
    p.scratchLen = info.scratchLen;
    p.microkernel = info.microkernel;
    // after startup, the conductor's messages go to the job in flight
    p.conductor.onmessage = (e) => {
      if (e.data?.helperError) return p.fail(e.data.helperError);
      onJobMessage(e.data);
    };
    return p;
  } catch (e) {
    destroy(p, String((e as Error)?.message ?? e)); // (startup failed: no worker of it survives; e is what is reported)
    throw e;
  }
}

let lastMessage = 0;
let progressText = "";
function onJobMessage(data: any) {
  lastMessage = performance.now();
  if (data?.progress) {
    progressText = data.progress;
    $("status").textContent = `Computing: ${data.progress}…`;
    return;
  }
  const a = active;
  active = null;
  a?.resolve(data as Result);
}

// the arena starts above every stack (the conductor's and maxT - 1 helpers', from BASE + PAGE)
const arenaStart = (maxT: number) => BASE + PAGE + (maxT + 1) * STACK;

function layout(p: Pool, n: number) {
  const bytes = n * n * 8;
  const a = arenaStart(p.maxT), b = a + bytes, c = b + bytes, scratch = c + bytes;
  const scratchStride = p.scratchLen * 8;
  const end = scratch + p.maxT * scratchStride;
  const have = p.memory.buffer.byteLength;
  if (end > have) p.memory.grow(Math.ceil((end - have) / PAGE));
  return { n, a, b, c, scratch, scratchStride, lo: a, hi: end };
}

function stats(xs: number[]) {
  const s = [...xs].sort((x, y) => x - y);
  // (nearest rank; with the default 21 runs the p95 is the 20th, not the maximum)
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(f * s.length) - 1))];
  const median = q(0.5), p95 = q(0.95);
  return { median, p95, best: s[0], noisy: p95 > NOISY * median };
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)) + " ms";

async function run() {
  const btn = $("run") as HTMLButtonElement;
  btn.disabled = true;
  $("out").innerHTML = "";
  try {
    const n = Number(($("n") as HTMLSelectElement).value);
    const reps = Math.max(1, Number(($("reps") as HTMLSelectElement).value) || 21);
    const binding = reps >= 21;
    const maxT = Math.min(16, Number(($("maxT") as HTMLSelectElement).value));
    const threads = threadCounts(maxT);
    if (!pool || pool.dead || pool.maxT !== maxT) {
      if (pool) destroy(pool, "replaced");
      $("status").textContent = "Starting the thread pool…";
      pool = await startPool(maxT);
    }
    const p = pool;
    $("status").textContent = `Computing C = A·B, n = ${n}, with ${threads.join(", ")} threads (${reps} timed runs each)…`;
    const lay = layout(p, n);
    lastMessage = performance.now();
    progressText = "";
    const res: Result = await new Promise<Result>((resolve, reject) => {
      active = { resolve, reject };
      // (a job that goes quiet, the conductor stuck: fail it and the pool)
      const watch = setInterval(() => {
        if (!active) return clearInterval(watch);
        if (performance.now() - lastMessage > QUIET_MS) {
          clearInterval(watch);
          p.fail(`no progress for ${QUIET_MS / 1000} s${progressText ? ` (last: ${progressText})` : ""}`);
        }
      }, 1000);
      p.conductor!.postMessage({ cmd: "gemm", lay, threads, reps });
    });
    if (res.error) {
      // (a job error leaves the pool in an unknown state: drop it)
      destroy(p, res.error);
      throw new Error(res.error);
    }
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
    html += `<h2>Timings, n = ${n}</h2><p>Microkernel <code>${p.microkernel}</code>. Warm steady state, ${reps} runs per thread count, interleaved.`;
    if (!binding) html += ` <b>Quick mode: fewer than 21 runs, so the p95 is not meaningful; these timings are indicative only (non-binding).</b>`;
    html += `</p><table class="t"><tr><th>threads</th><th>median</th><th>p95</th><th>best</th><th>GFLOP/s (median)</th><th>speedup vs 1 thread</th><th>first run</th></tr>`;
    for (const t of threads) {
      const s = st[t];
      const flag = s.noisy ? ` <span class="noisy" title="p95 over ${NOISY}x the median: a noisy measurement">⚠ noisy</span>` : "";
      html += `<tr${s.noisy ? ' class="noisyrow"' : ""}><td>${t}</td><td>${fmt(s.median)}</td><td>${fmt(s.p95)}${flag}</td><td>${fmt(s.best)}</td><td>${gf(s.median)}</td><td><b>${(one / s.median).toFixed(2)}×</b></td><td>${fmt(res.firstMs![t])}</td></tr>`;
    }
    const noisyRows = threads.filter((t) => st[t].noisy);
    html += `</table>`;
    if (noisyRows.length) html += `<p class="warn">⚠ Noisy: the p95 is over ${NOISY}× the median for ${noisyRows.join(", ")} thread(s). Something else was likely using the CPU; run again for steadier numbers.</p>`;
    html += `<h2>One-time costs</h2><ul><li>Fetch and compile the kernel module: ${fmt(p.setup.compileMs)}</li><li>Start the ${p.maxT}-thread pool (workers, each instantiating the module): ${fmt(p.setup.poolMs)}</li></ul>`;
    const best = threads[threads.length - 1];
    $("out").innerHTML = html;
    const caveat = [!binding ? "quick mode, indicative only" : "", st[best].noisy || st[threads[0]].noisy ? "noisy: p95 > 1.5× median" : ""].filter(Boolean).join("; ");
    $("status").textContent = `Done: ${fmt(one)} on 1 thread, ${fmt(st[best].median)} on ${best} threads — ${(one / st[best].median).toFixed(1)}× faster.${caveat ? ` (${caveat})` : ""}`;
  } catch (e) {
    $("status").textContent = "Error: " + String((e as Error)?.message ?? e) + " (the thread pool was stopped; Run starts a new one)";
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
