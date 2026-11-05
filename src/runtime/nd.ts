// engine/nd's WebAssembly module (wasm/sagebrush-nd.wasm, about 70 KB;
// numerics-core r4.3) for the kernels the runtime hands to it: so far
// np.linalg.cholesky of a real float64 matrix (CHOL-1), through nd_potrf.
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

import { sha256Hex } from "./sha256";

interface Nd {
  nd_info(what: number): number;
  nd_potrf(desc: number): number;
}

let decided = false;
let ex: Nd | null = null;
let mem: WebAssembly.Memory | null = null;
let floor = 0;
let kernel = "";
let why = "not used yet";

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
    // only the bytes the page was built with run (design/security.md,
    // SEC-522-1): without the hash they are not fetched at all
    const want = g.__SAGEBRUSH_ND_SHA256__;
    if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) throw new Error("the numerics module has no SHA-256 to check, so it is not loaded");
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

function decide(): void {
  decided = true;
  const g = globalThis as any;
  if (g.__SAGEBRUSH_NO_WASM__ || g.process?.env?.SAGEBRUSH_NO_WASM || typeof WebAssembly !== "object") {
    why = "WebAssembly is off here";
    return;
  }
  const m = sharedMemory();
  if (m === null) {
    why = "no shared WebAssembly memory here (the page is not cross-origin isolated)";
    return;
  }
  try {
    const e = new WebAssembly.Instance(new WebAssembly.Module(ndBytes() as any), { env: { memory: m } }).exports as unknown as Nd;
    // (the host's part of memory starts at the module's __heap_base; the selected kernel's name)
    floor = e.nd_info(1);
    kernel = new TextDecoder().decode(new Uint8Array(m.buffer, e.nd_info(2), e.nd_info(3)).slice());
    ex = e;
    mem = m;
    why = "";
  } catch (err: any) {
    why = `the numerics module could not be loaded (${err?.message ?? err})`;
  }
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
  // R'. The layout: the descriptor at the host's floor, then the arena (A,
  // the work, the report), each 64-byte aligned.
  const SCRATCH = ex!.nd_info(0);
  const up = (x: number) => Math.ceil(x / 64) * 64;
  const desc = up(floor), lo = desc + 64;
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
