// engine/nd's WebAssembly module (wasm/sagebrush-nd.wasm, about 70 KB;
// numerics-core r4.3) for the kernels the runtime hands to it: so far
// np.linalg.cholesky of a real float64 matrix (CHOL-1), through nd_potrf,
// and solve, det, slogdet and inv (LU with partial pivoting), through
// nd_solve's gesv mode.
// The module is compiled the first time one of them is called, from wherever
// the host keeps it (as the PNG module's, src/runtime/raster.ts):
//   globalThis.__SAGEBRUSH_ND__      its bytes, as base64 (the CLI bundle)
//   globalThis.__SAGEBRUSH_ND_URL__  a URL to fetch synchronously (the
//                                    notebook's worker), checked against
//                                    __SAGEBRUSH_ND_SHA256__
//   else, in Node, the file wasm/sagebrush-nd.wasm above this module.
// It is built with threads, so it needs a shared WebAssembly.Memory. Where
// none can be made (a page that is not cross-origin isolated), WebAssembly is
// off (__SAGEBRUSH_NO_WASM__, SAGEBRUSH_NO_WASM) or the module can't be had,
// the runtime's TypeScript code runs instead. Which of the two runs is decided
// once, at the first call, and kept for the session, so the same input gives
// the same bits all session (r4.3 §7: deterministic per backend; @sagebrush's
// CHOL-1 ruling R1); ndPath() says which, and why (np.linalg._kernels()).
// In the notebook's worker the module is also compiled ahead, at idle: numpy's
// import asks for it (ndRequestWarm), and after that run the worker fetches
// and compiles it off the thread (ndWarm). The first call then only
// instantiates it. That changes the time and nothing else: the same bytes
// (their SHA-256 checked), the same decision at the same first call, so the
// same bits warm or cold.

import { sha256Hex } from "./sha256";
import { Crew, type WorkerLike } from "./nd-crew";

interface Nd {
  nd_info(what: number): number;
  nd_potrf(desc: number): number;
  nd_solve(desc: number): number;
  nd_gemm_part(desc: number, id: number): number;
  nd_pool_init(ctl: number, stacks: number, slot: number, participants: number): number;
  __stack_pointer: WebAssembly.Global;
}

let decided = false;
let ex: Nd | null = null;
let mem: WebAssembly.Memory | null = null;
let ndModule: WebAssembly.Module | null = null;
let floor = 0;
// (where each call's descriptor and arena start: the floor, 64-aligned, or above the thread pool's region)
let base = 0;
let kernel = "";
let why = "not used yet";
// the warm-up: none asked; asked (numpy imported); warming; ready (compiled, for decide()); unused (the decision
// came first, or the module can't run here); failed (decide() then loads it as without a warm-up)
let warm: "none" | "asked" | "warming" | "ready" | "unused" | "failed" = "none";
let compiled: WebAssembly.Module | null = null;

// only the bytes the page was built with run (design/security.md, SEC-522-1): without the hash they are not
// fetched at all
function wantSha(): string {
  const want = (globalThis as any).__SAGEBRUSH_ND_SHA256__;
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) throw new Error("the numerics module has no SHA-256 to check, so it is not loaded");
  return want;
}

// (exported for the tests)
export function ndBytes(): Uint8Array {
  const g = globalThis as any;
  if (typeof g.__SAGEBRUSH_ND__ === "string") {
    const bin = atob(g.__SAGEBRUSH_ND__);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  if (g.__SAGEBRUSH_ND_URL__) {
    const want = wantSha();
    let b: Uint8Array;
    if (typeof g.__SAGEBRUSH_FETCH_SYNC__ === "function") b = g.__SAGEBRUSH_FETCH_SYNC__(String(g.__SAGEBRUSH_ND_URL__));
    else {
      const x = new XMLHttpRequest();
      x.open("GET", String(g.__SAGEBRUSH_ND_URL__), false);
      x.responseType = "arraybuffer";
      x.send();
      if (x.status !== 200) throw new Error(`could not load the numerics module (HTTP ${x.status})`);
      b = new Uint8Array(x.response);
    }
    if (sha256Hex(b) !== want) throw new Error("the numerics module fetched is not the one this page was built with");
    return b;
  }
  const fs = g.process?.getBuiltinModule?.("fs"), path = g.process?.getBuiltinModule?.("path");
  if (fs && path) {
    const start = typeof __dirname === "string" ? __dirname : g.process.cwd();
    for (let dir = start, i = 0; i < 6; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, "wasm", "sagebrush-nd.wasm");
      if (fs.existsSync(f)) return new Uint8Array(fs.readFileSync(f));
    }
  }
  throw new Error("Sagebrush's numerics module (sagebrush-nd.wasm) is not available here");
}

// The module's memory: shared, 4 GiB at most (the module's own bound), or
// less where so much address space can't be reserved; null if none can be
// made (no SharedArrayBuffer: a page that isn't cross-origin isolated).
function sharedMemory(): WebAssembly.Memory | null {
  for (const maximum of [65536, 16384, 4096]) {
    try {
      return new WebAssembly.Memory({ initial: 17, maximum, shared: true });
    } catch {}
  }
  return null;
}

const wasmOff = () => {
  const g = globalThis as any;
  return !!(g.__SAGEBRUSH_NO_WASM__ || g.process?.env?.SAGEBRUSH_NO_WASM || typeof WebAssembly !== "object");
};

function decide(): void {
  decided = true;
  // (a warm-up still on its way is left to finish unused: this call compiles its own, as without one)
  const pre = compiled;
  compiled = null;
  if (warm === "asked" || warm === "warming") warm = "unused";
  if (wasmOff()) {
    why = "WebAssembly is off here";
    return;
  }
  const m = sharedMemory();
  if (m === null) {
    why = "no shared WebAssembly memory here (the page is not cross-origin isolated)";
    return;
  }
  try {
    instantiate(pre ?? new WebAssembly.Module(ndBytes() as any), m);
    why = "";
  } catch (err: any) {
    why = `the numerics module could not be loaded (${err?.message ?? err})`;
  }
}

function instantiate(mod: WebAssembly.Module, m: WebAssembly.Memory): void {
  const e = new WebAssembly.Instance(mod, { env: { memory: m } }).exports as unknown as Nd;
  // (the host's part of memory starts at the module's __heap_base; the selected kernel's name)
  floor = e.nd_info(1);
  base = Math.ceil(floor / 64) * 64;
  kernel = new TextDecoder().decode(new Uint8Array(m.buffer, e.nd_info(2), e.nd_info(3)).slice());
  ex = e;
  mem = m;
  ndModule = mod;
}

/** Whether engine/nd's kernels run in this session (decided at the first call, then fixed). */
export function useNd(): boolean {
  if (!decided) decide();
  return ex !== null;
}

/** Which code np.linalg's nd-backed functions run in this session, and why. */
export function ndPath(): { path: "engine/nd" | "typescript" | "undecided"; kernel: string; why: string } {
  if (!decided) return { path: "undecided", kernel: "", why: "decided at the first call of an nd-backed function" };
  return ex ? { path: "engine/nd", kernel, why: "" } : { path: "typescript", kernel: "", why };
}

/** numpy's import: compile the module ahead where the host has an idle moment for it (the notebook's worker). */
export function ndRequestWarm(): void {
  if (warm === "none" && !decided) warm = "asked";
}

/** Whether a warm-up is asked for and not yet begun (the worker checks after each run). */
export function ndWarmAsked(): boolean {
  return warm === "asked" && !decided;
}

/** The warm-up's state, for np.linalg._kernels(). */
export function ndWarmState(): string {
  return warm;
}

/** Fetch (by the host's `fetchBytes`, its SHA-256 checked as ndBytes() does) and compile the module off the thread,
 *  for decide() to instantiate. Once; nothing if the decision came first or the module can't run here. A failure
 *  is only remembered: decide() then loads the module as without a warm-up, and says why if it can't. */
export async function ndWarm(fetchBytes?: (url: string) => Promise<ArrayBuffer | Uint8Array>): Promise<void> {
  if (!ndWarmAsked()) return;
  if (wasmOff() || typeof SharedArrayBuffer !== "function") {
    warm = "unused";
    return;
  }
  warm = "warming";
  try {
    const g = globalThis as any;
    let b: Uint8Array;
    if (typeof g.__SAGEBRUSH_ND__ !== "string" && g.__SAGEBRUSH_ND_URL__ && fetchBytes) {
      const want = wantSha();
      b = new Uint8Array(await fetchBytes(String(g.__SAGEBRUSH_ND_URL__)));
      if (sha256Hex(b) !== want) throw new Error("the numerics module fetched is not the one this page was built with");
    } else b = ndBytes();
    const mod = await WebAssembly.compile(b as any);
    if (decided) return;
    compiled = mod;
    warm = "ready";
  } catch {
    if (!decided) warm = "failed";
  }
}

/** The module's memory in bytes (0 before it is made), for the admission tests. */
export function ndMemoryBytes(): number {
  return mem ? mem.buffer.byteLength : 0;
}

/** The work's scratch beyond n^2, in float64s (0 where engine/nd doesn't run). */
export function ndScratch(): number {
  return ex ? ex.nd_info(0) : 0;
}

// Make the memory at least `bytes` long; a RangeError if it can't grow.
function reserve(bytes: number): void {
  const m = mem!, have = m.buffer.byteLength;
  if (have < bytes) m.grow(Math.ceil((bytes - have) / 65536));
}

/** The Cholesky factor of the n x n real symmetric A (row-major float64; only
 *  its lower triangle and diagonal are read): L, row-major and lower
 *  triangular with A = L L^T (its strict upper part 0), or the 1-based column
 *  at which A is not positive definite. Only when useNd(). A RangeError if the
 *  module's memory can't hold A and the work. */
export function ndCholesky(A: Float64Array, n: number): Float64Array | number {
  // A's row-major lower triangle is the column-major upper triangle that
  // nd_potrf reads, and the R it writes there (A = R'R) read row-major is L =
  // R'. The layout: the descriptor at the base (the host's floor, or above the thread pool), then the arena (A,
  // the work, the report), each 64-byte aligned.
  live();
  const SCRATCH = ex!.nd_info(0);
  const up = (x: number) => Math.ceil(x / 64) * 64;
  const desc = base, lo = desc + 64;
  const a = lo, wl = n * n + SCRATCH, work = up(a + 8 * n * n), report = up(work + 8 * wl), hi = report + 16;
  reserve(hi);
  const f64 = new Float64Array(mem!.buffer), u32 = new Uint32Array(mem!.buffer);
  f64.set(A.subarray(0, n * n), a / 8);
  u32.set([a, work, report, n, Math.max(n, 1), wl, lo, hi], desc / 4);
  if (ex!.nd_potrf(desc) !== 1) throw new Error("the numerics module refused a Cholesky layout");
  if (u32[report / 4] !== 1) return u32[report / 4 + 1];
  const L = f64.slice(a / 8, a / 8 + n * n);
  for (let i = 0; i < n; i++) L.fill(0, i * n + i + 1, (i + 1) * n);
  return L;
}

/** PA = LU of the n x n real A (row-major float64) by nd_solve's gesv mode
 *  (LAPACK's dgesv, as NumPy calls it), and X = A^-1 B for the n x r B
 *  (row-major; null: the identity, for inv; r may be 0, for det): U's
 *  diagonal and P's sign (all det and slogdet need of the factors), X
 *  (row-major) and
 *  whether a pivot is exactly zero (X then holds what division by it gives). Null if A or B has an Inf or
 *  NaN: the module computes nothing then (the caller's LU runs instead). Only
 *  when useNd(). A RangeError if the module's memory can't hold the work. */
export function ndLu(A: Float64Array, n: number, B: Float64Array | null, r: number): { diag: Float64Array; sign: number; x: Float64Array; singular: boolean } | null {
  // nd_solve reads column-major operands: A and B go in transposed (the
  // identity is its own transpose), X comes out transposed. The layout: the
  // descriptor at the base (the host's floor, or above the thread pool), then the arena (A, B, the pivots, the
  // work, the report), each 64-byte aligned.
  live();
  const SCRATCH = ex!.nd_info(0);
  const up = (x: number) => Math.ceil(x / 64) * 64;
  const desc = base, lo = desc + 64;
  const wl = Math.max(n * n, n * r) + SCRATCH;
  const a = lo, b = up(a + 8 * n * n), ipiv = up(b + 8 * n * r), work = up(ipiv + 4 * n), report = up(work + 8 * wl), hi = report + 32;
  reserve(hi);
  const f64 = new Float64Array(mem!.buffer), u32 = new Uint32Array(mem!.buffer);
  for (let i = 0, p = a / 8; i < n; i++) for (let j = 0; j < n; j++) f64[p + i + j * n] = A[i * n + j];
  if (B) for (let i = 0, p = b / 8; i < n; i++) for (let j = 0; j < r; j++) f64[p + i + j * n] = B[i * r + j];
  else {
    f64.fill(0, b / 8, b / 8 + n * r);
    for (let i = 0; i < Math.min(n, r); i++) f64[b / 8 + i + i * n] = 1;
  }
  u32.set([a, b, ipiv, work, report, n, r, Math.max(n, 1), Math.max(n, 1), wl, lo, hi, 1], desc / 4);
  if (ex!.nd_solve(desc) !== 1) throw new Error("the numerics module refused a solve layout");
  const code = u32[report / 4];
  if (code === 3) return null;
  const x = new Float64Array(n * r);
  for (let i = 0, p = b / 8; i < n; i++) for (let j = 0; j < r; j++) x[i * r + j] = f64[p + i + j * n];
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) diag[i] = f64[a / 8 + i + i * n];
  // (the pivots are 0-based: row k was interchanged with row ipiv[k])
  let sign = 1;
  for (let k = 0; k < n; k++) if (u32[ipiv / 4 + k] !== k) sign = -sign;
  return { diag, sign, x, singular: code === 2 };
}

// The thread pool (threads r2, PR (1)): large matrix products (ndMatmul) run on engine/nd's GEMM, its columns
// dealt out to the calling thread and up to min(cores - 1, 8) helper threads, with the same bits as on one thread
// (numerics-core r4.2 §7: every element summed in the same order whatever the thread count). So whether a product
// gets threads changes its time only: products are routed to engine/nd by their size alone (ND_MATMUL_MIN), and a
// product that comes before the pool is ready runs on one thread.
// - Where: only where the calling thread may block and threads can be made: a Node thread (the CLI), its helpers
//   running src/runtime/nd-helper.ts; never a page's main thread. Elsewhere (the browser's notebook worker, for
//   now), and with 2 cores or fewer, one thread.
// - When: lazily, at the first product that is large enough; never at load. Its helpers then start in the
//   background, each instantiating the module on its own stack, and count themselves ready in the control words.
// - The memory, from the module's floor: the control words (64 bytes), the GEMM descriptor (64), one stack slot
//   of SLOT bytes per participant (the caller is participant 0), recorded once in the module (nd_pool_init),
//   which checks every threaded job against it (engine/nd/src/boundary.rs check_part); then each call's arena.
// - A job: the caller writes the descriptor, starts the generation, runs its own share, then waits in bounded
//   slices for every helper to count in; no helper finishing for STALL_MS fails the job.
// - Failure (a stall, a helper's error or refusal, a refused job, a pool that did not start within STARTUP_MS):
//   the generation goes terminal, every helper is terminated, and the whole memory is abandoned: never read or
//   reused, since a late helper could still write it. The module runs on in a fresh memory and instance on one
//   thread for the rest of the session, and the product in hand is computed again there from its operands. If
//   no fresh memory can be made, that call and every later one fail with a clear error.
const SLOT = 256 * 1024;
const STALL_MS = 15000;
const STARTUP_MS = 20000;
const MAX_HELPERS = 8;
/** A matrix product runs on engine/nd when each of its three dimensions is at least this. */
export const ND_MATMUL_MIN = 256;
// the control words (Int32), as src/runtime/nd-helper.ts has them
const GEN = 0, DONE = 1, FAIL = 2, READY = 3, BROKEN = 4;

type Pool = { crew: Crew; c: Int32Array; helpers: number; desc: number; t0: number; ready: boolean; failed: string | null };
let pool: Pool | null = null;
// none: not tried yet; on: a pool, starting or ready; off: one thread for the rest of the session (threadsWhy)
let threads: "none" | "on" | "off" = "none";
let threadsWhy = "";
// (set when no fresh memory could be made after a failure: every later call fails with it)
let dead: string | null = null;

/** The tests' hooks into the pool, set only through ndTest (which no production code calls): the helper count;
 *  a fault in helper 1 (src/runtime/nd-helper.ts), and how long a "late" one sleeps; shorter stall and startup
 *  bounds; helpers left unterminated on failure (as a helper that can't be stopped in time); a fresh memory that
 *  can't be made; a second bootstrap, or a malformed first one, sent to helper 1. */
export type NdTestHooks = {
  helpers?: number; fault?: "exit" | "throw" | "late"; lateMs?: number; stallMs?: number; startupMs?: number;
  noTerminate?: boolean; memoryFault?: boolean; rebootstrap?: boolean; malformed?: boolean;
};
const tst = { hooks: null as NdTestHooks | null, made: 0, terminated: 0, products: 0, teams: 0, failovers: 0, abandoned: [] as WebAssembly.Memory[], unstopped: [] as Crew[] };

/** For the tests only: set the hooks (null: none), and see the counters (workers made and terminated, products,
 *  threaded jobs started, failovers) and the memories abandoned. */
export function ndTest(hooks?: NdTestHooks | null): typeof tst {
  if (hooks !== undefined) tst.hooks = hooks;
  return tst;
}

/** The pool's state, for np.linalg._kernels() and the tests: the threads a large product gets now, and why not more. */
export function ndThreads(): { threads: number; state: string; why: string } {
  const p = pool;
  if (p && !p.ready && p.failed === null && Atomics.load(p.c, READY) >= p.helpers && !Atomics.load(p.c, BROKEN)) p.ready = true;
  const state = threads === "on" ? (p?.ready ? "ready" : "starting") : threads;
  return { threads: p?.ready ? p.helpers + 1 : 1, state, why: dead ?? threadsWhy };
}

const now = () => performance.now();

function helperCount(): number {
  if (tst.hooks?.helpers !== undefined) return tst.hooks.helpers;
  const g = globalThis as any;
  const hw = Number(g.navigator?.hardwareConcurrency ?? g.process?.getBuiltinModule?.("os")?.availableParallelism?.() ?? 1);
  return hw <= 2 ? 0 : Math.min(hw - 1, MAX_HELPERS);
}

// How this host makes a helper, or null if it can't here: in Node, a worker_threads Worker of the helper's code
// (the CLI bundle carries it, scripts/build-cli.mjs) or of nd-helper.js beside this module. (The browser's notebook
// worker runs in the runner's opaque origin, where the helper comes in a later step: one thread there for now.)
function helperMaker(): (() => WorkerLike) | null {
  const g = globalThis as any;
  const wt = g.process?.getBuiltinModule?.("worker_threads"), fs = g.process?.getBuiltinModule?.("fs");
  let src = "", code = false;
  if (typeof g.__SAGEBRUSH_ND_HELPER__ === "string") [src, code] = [g.__SAGEBRUSH_ND_HELPER__, true];
  else if (typeof __dirname === "string" && fs?.existsSync(__dirname + "/nd-helper.js")) src = __dirname + "/nd-helper.js";
  if (!wt || !src) return null;
  return () => {
    const w = new wt.Worker(src, { eval: code });
    const like: WorkerLike = { postMessage: (m) => w.postMessage(m), terminate: () => void w.terminate(), onerror: null, onmessageerror: null, onmessage: null };
    w.on("error", (e: Error) => like.onerror?.(e));
    w.on("messageerror", () => like.onmessageerror?.(null));
    w.on("message", (data: unknown) => like.onmessage?.({ data }));
    w.on("exit", (code: number) => like.onerror?.({ message: `stopped (exit code ${code})` }));
    // (after the listeners, which would hold it again: the pool never keeps the process alive)
    w.unref();
    return like;
  };
}

// Start the pool, if this host can have one: its region reserved and recorded, the caller moved onto stack slot 0,
// and the helpers made and sent their bootstraps (they start in the background).
function startPool(): void {
  const make = helperMaker(), helpers = helperCount();
  if (!make || helpers < 1) {
    threads = "off";
    threadsWhy = make ? "2 cores or fewer" : "no worker threads here";
    return;
  }
  const ctl = base, desc = ctl + 64, stacks = desc + 64, top = stacks + (helpers + 1) * SLOT;
  reserve(top + 64);
  if (ex!.nd_pool_init(ctl, stacks, SLOT, helpers + 1) !== 1) {
    threads = "off";
    threadsWhy = "the numerics module refused the pool's layout";
    return;
  }
  ex!.__stack_pointer.value = stacks + SLOT;
  base = top;
  const h = tst.hooks;
  const p: Pool = { crew: null as any, c: new Int32Array(mem!.buffer, ctl, 16), helpers, desc, t0: now(), ready: false, failed: null };
  p.crew = new Crew(() => {
    const w = make();
    tst.made++;
    const end = w.terminate.bind(w);
    w.terminate = () => {
      tst.terminated++;
      end();
    };
    return w;
  }, (why) => (p.failed ??= why));
  pool = p;
  threads = "on";
  try {
    for (let id = 1; id <= helpers; id++) {
      const boot: any = { module: ndModule, memory: mem, id, stackTop: stacks + (id + 1) * SLOT, ctl, desc };
      if (id === 1 && h?.fault) Object.assign(boot, { fault: h.fault, lateMs: h.lateMs });
      if (id === 1 && h?.malformed) boot.id = 0;
      p.crew.add(`helper ${id}`, boot);
      if (id === 1 && h?.rebootstrap) p.crew.workers[0].postMessage(boot);
    }
  } catch (e: any) {
    failover(`the thread pool could not start (${e?.message ?? e})`);
  }
}

// Before any call into the module: a failed or overdue pool is dropped (failover); a pool all of whose helpers
// counted in becomes ready; and after a failure with no fresh memory, every call fails.
function live(): void {
  const p = pool;
  if (p) {
    if (p.failed !== null || Atomics.load(p.c, BROKEN)) failover(p.failed ?? "a helper refused a message");
    else if (!p.ready) {
      if (Atomics.load(p.c, READY) >= p.helpers) p.ready = true;
      else if (now() - p.t0 > (tst.hooks?.startupMs ?? STARTUP_MS)) failover("the thread pool did not start in time");
    }
  }
  if (dead !== null) throw new Error(dead);
}

// Drop the pool and its whole memory (never read or reused again), and go on in a fresh memory and instance on one
// thread; an Error if none can be made (then every later call fails too).
function failover(why: string): void {
  const p = pool!;
  pool = null;
  threads = "off";
  threadsWhy = why;
  tst.failovers++;
  Atomics.store(p.c, GEN, -1);
  Atomics.notify(p.c, GEN);
  if (tst.hooks?.noTerminate) tst.unstopped.push(p.crew);
  else p.crew.end();
  tst.abandoned.push(mem!);
  ex = null;
  mem = null;
  const m = tst.hooks?.memoryFault ? null : sharedMemory();
  if (m !== null) {
    try {
      instantiate(ndModule!, m);
      return;
    } catch {}
  }
  dead = `the numerics module's thread pool failed (${why}), and no new memory could be made for the module`;
  throw new Error(dead);
}

/** C = A B for the row-major n x m A and m x p B (float64): C row-major, n x p. On the thread pool when it is ready,
 *  else on one thread, the same bits either way. Only when useNd(). A RangeError if the module's memory can't
 *  hold the operands. */
export function ndMatmul(A: Float64Array, B: Float64Array, n: number, m: number, p: number): Float64Array {
  tst.products++;
  live();
  if (threads === "none") startPool();
  const P = pool?.ready ? pool : null;
  const t = gemmOn(A, B, n, m, p, P);
  if (typeof t !== "string") return t;
  failover(t);
  const one = gemmOn(A, B, n, m, p, null);
  if (typeof one === "string") throw new Error(one);
  return one;
}

// The product on the pool P (null: on this thread alone), or why it failed. nd_gemm_part reads column-major
// operands: row-major A (n x m) is column-major A^T, so C^T = B^T A^T (p x n, column-major) is C row-major, and
// the module's A is B's buffer, its B A's buffer, with its m, n, k = p, n, m.
function gemmOn(A: Float64Array, B: Float64Array, n: number, m: number, p: number, P: Pool | null): Float64Array | string {
  const T = P ? P.helpers + 1 : 1;
  const up = (x: number) => Math.ceil(x / 64) * 64;
  const desc = P ? P.desc : base, lo = P ? base : base + 64;
  const stride = up(ex!.nd_info(0) * 8);
  const a = lo, b = up(a + 8 * m * p), c = up(b + 8 * n * m), scratch = up(c + 8 * n * p), hi = scratch + T * stride;
  reserve(hi);
  const f64 = new Float64Array(mem!.buffer), u32 = new Uint32Array(mem!.buffer);
  f64.set(B.subarray(0, m * p), a / 8);
  f64.set(A.subarray(0, n * m), b / 8);
  u32.set([a, b, c, p, n, m, T, scratch, stride, lo, hi], desc / 4);
  if (!P) {
    if (ex!.nd_gemm_part(desc, 0) !== 1) return "the numerics module refused a matrix product";
    return f64.slice(c / 8, c / 8 + n * p);
  }
  const w = P.c, stall = tst.hooks?.stallMs ?? STALL_MS;
  Atomics.store(w, DONE, 0);
  Atomics.store(w, FAIL, 0);
  Atomics.add(w, GEN, 1);
  Atomics.notify(w, GEN);
  tst.teams++;
  let ok = false;
  try {
    ok = ex!.nd_gemm_part(desc, 0) === 1;
  } catch {}
  // (bounded: no helper finishing for `stall` ms fails the job; a clock sample that isn't finite, the first one
  // included, or that goes back from the one before fails it too)
  let last = now(), prev = last, seen = -1;
  if (!Number.isFinite(last)) return "the clock failed";
  for (let d; (d = Atomics.load(w, DONE)) < P.helpers; ) {
    const t = now();
    if (P.failed !== null || Atomics.load(w, BROKEN)) return P.failed ?? "a helper refused a message";
    if (!Number.isFinite(t) || t < prev) return "the clock failed";
    prev = t;
    if (d !== seen) [seen, last] = [d, t];
    else if (t - last > stall) return `a helper stopped responding (${d} of ${P.helpers} finished)`;
    Atomics.wait(w, DONE, d, 50);
  }
  if (!ok) return "the numerics module refused a threaded matrix product";
  if (Atomics.load(w, FAIL)) return `${Atomics.load(w, FAIL)} helper(s) failed a matrix product`;
  return f64.slice(c / 8, c / 8 + n * p);
}
