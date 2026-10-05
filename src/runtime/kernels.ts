// The WebAssembly SIMD kernels of kernels/src (matmul, LU, QR, eigenproblems,
// SVD), compiled
// synchronously on first use.  Operands are copied into the module's linear
// memory above its initial size (the module has no allocator: everything
// below is its stack and data).  Each kernel does the same floating-point
// operations in the same order as the JavaScript code it replaces, so results
// do not depend on whether WebAssembly is available.  Set
// globalThis.__SAGEBRUSH_NO_WASM__ = true (or the environment variable
// SAGEBRUSH_NO_WASM=1) before first use to disable.

import { KERNELS_WASM, KERNELS_RELAXED_WASM } from "./kernels_wasm";

interface Exports {
  memory: WebAssembly.Memory;
  dgemm(a: number, b: number, c: number, m: number, n: number, k: number, bp: number): void;
  dgetrf(a: number, n: number, piv: number): number;
  dgetrs(lu: number, n: number, x: number, m: number): void;
  dgeqr(c: number, m: number, n: number, v: number, beta: number, q: number, qc: number): void;
  dsyev(w: number, n: number, d: number, e: number): number;
  dgeev(h: number, n: number, w: number, d: number, e: number, ort: number, tmp: number): number;
  dgesvd(a: number, m: number, n: number, u: number, v: number, s: number, e: number, work: number): number;
  vexp(x: number, y: number, n: number, tab: number): void;
  vlog(x: number, y: number, n: number, tab: number): void;
  mt_fill(key: number, meta: number, dist: number, out: number, n: number, lo: number, rng: number, logtab: number): void;
  pcg_fill(words: number, meta: number, dist: number, out: number, n: number, lo: number, rng: number, logtab: number): void;
  sort_f64(x: number, n: number, tmp: number, hist: number): void;
  argsort_f64(x: number, n: number, idx: number, keys: number, keys2: number, idx2: number, hist: number): void;
  transpose(src: number, rows: number, cols: number, dst: number): void;
  fft_stockham(x: number, y: number, n: number, f: number, nf: number, tc: number, ts: number, consts: number, inverse: number): number;
  rfft_rows(data: number, rows: number, n: number, out: number, z: number, y: number, f: number, nf: number,
            tch: number, tsh: number, tcn: number, tsn: number, consts: number): void;
}

let K: Exports | null | undefined;

function instantiate(b64: string): WebAssembly.Exports {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
}
let base = 0;
let f64 = new Float64Array(0);
let i32 = new Int32Array(0);

function kernels(): Exports | null {
  if (K !== undefined) return K;
  K = null;
  try {
    const g = globalThis as any;
    if (g.__SAGEBRUSH_NO_WASM__ || g.process?.env?.SAGEBRUSH_NO_WASM || typeof WebAssembly !== "object") return K;
    K = instantiate(KERNELS_WASM) as unknown as Exports;
    base = K.memory.buffer.byteLength;
  } catch {
    K = null; // no WebAssembly SIMD here: the JavaScript code is used
  }
  return K;
}

// Whether the kernels are in use.
export function wasmKernels(): boolean {
  return kernels() !== null;
}

// Which FFT twiddle tables sit at the start of the scratch area (any other
// use of it clears this).
let resident = "";

// Make room for `doubles` float64s at the scratch base; returns the views
// (valid until the next reserve).
function reserve(doubles: number): void {
  resident = "";
  const mem = K!.memory, need = base + doubles * 8;
  if (mem.buffer.byteLength < need) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
  if (f64.buffer !== mem.buffer) {
    f64 = new Float64Array(mem.buffer);
    i32 = new Int32Array(mem.buffer);
  }
}

// Sizes from which the kernels beat JavaScript including the copies.
const GEMM_MIN = 4096, LU_MIN = 12, EIG_MIN = 4, WORK_MIN = 2000;

// Lay out arrays of the given lengths (in doubles) in the scratch area:
// their byte addresses, each 16-byte aligned.  Arrays are 9 cache lines
// apart beyond their lengths, so that buffers of power-of-two sizes do not
// all map to the same cache sets.
function layout(...lens: number[]): number[] {
  const at: number[] = [];
  let o = 0;
  for (const len of lens) {
    at.push(base + o * 8);
    o += len + (len & 1) + 72;
  }
  reserve(o);
  return at;
}
const view = (addr: number, len: number) => f64.subarray(addr / 8, addr / 8 + len);

// For matmul of an (m x k) by a (k x n) matrix: null when the JavaScript
// loops should be used, otherwise views a, b, c into wasm memory and run().
export function gemmBuffers(m: number, n: number, k: number):
  | { a: Float64Array; b: Float64Array; c: Float64Array; run(): void }
  | null {
  if (n < 4 || m * n * k < GEMM_MIN || !kernels()) return null;
  const pa = 0, pb = pa + m * k, pc = pb + k * n, pp = pc + m * n + (((pc + m * n) & 1) ? 1 : 0);
  reserve(pp + 4 * k);
  const at = (o: number, len: number) => new Float64Array(f64.buffer, base + o * 8, len);
  const b0 = base;
  return {
    a: at(pa, m * k),
    b: at(pb, k * n),
    c: at(pc, m * n),
    run: () => K!.dgemm(b0 + pa * 8, b0 + pb * 8, b0 + pc * 8, m, n, k, b0 + pp * 8),
  };
}

// LU with partial pivoting of the n x n row-major matrix A (not modified).
export function wasmLU(A: Float64Array, n: number): { lu: Float64Array; piv: number[]; sign: number; singular: boolean } | null {
  if (n < LU_MIN || !kernels()) return null;
  const nn = n * n;
  reserve(nn + n);
  f64.set(A, base / 8);
  const r = K!.dgetrf(base, n, base + nn * 8);
  const lu = f64.slice(base / 8, base / 8 + nn);
  const piv = Array.from(i32.subarray((base + nn * 8) / 4, (base + nn * 8) / 4 + n));
  return { lu, piv, sign: Math.sign(r), singular: Math.abs(r) === 2 };
}

// Solve with LU factors: B (n x m, row-major) is permuted by piv and solved.
export function wasmLuSolve(L: { lu: Float64Array; piv: number[] }, n: number, B: Float64Array, m: number): Float64Array | null {
  if (n < LU_MIN || !kernels()) return null;
  const nn = n * n, o = base / 8;
  reserve(nn + n * m);
  f64.set(L.lu, o);
  const x = o + nn;
  for (let i = 0; i < n; i++) f64.set(B.subarray(L.piv[i] * m, L.piv[i] * m + m), x + i * m);
  K!.dgetrs(base, n, base + nn * 8, m);
  return f64.slice(x, x + n * m);
}

// Householder QR of the m x n matrix A (row-major), as qr() in
// numpy_linalg.ts: [Q (m x qc), R, qc].
export function wasmQR(A: Float64Array, m: number, n: number, complete: boolean): [Float64Array, Float64Array, number] | null {
  if (m * n * Math.min(m, n) < WORK_MIN || !kernels()) return null;
  const k = Math.min(m, n), qc = complete ? m : k;
  const [a, c, v, beta, q, qt] = layout(m * n, m * n, k * m, k, qc * m, m * qc);
  view(a, m * n).set(A);
  K!.transpose(a, m, n, c);
  const C = view(c, m * n);
  K!.dgeqr(c, m, n, v, beta, q, qc);
  K!.transpose(q, qc, m, qt);
  const Q = view(qt, m * qc).slice();
  const rr = complete ? m : k, R = new Float64Array(rr * n);
  for (let i = 0; i < Math.min(rr, m); i++) for (let col = i; col < n; col++) R[i * n + col] = C[col * m + i];
  return [Q, R, qc];
}

// Symmetric eigenproblem: eigenvalues d (unsorted) and the eigenvector of
// d[j] in W[j*n .. j*n+n]; "noconv" if QL did not converge.
export function wasmSymEig(A: Float64Array, n: number): { d: Float64Array; W: Float64Array } | "noconv" | null {
  if (n < EIG_MIN || !kernels()) return null;
  const [w, d, e] = layout(n * n, n, n);
  const W = view(w, n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) W[j * n + i] = A[i * n + j];
  if (K!.dsyev(w, n, d, e)) return "noconv";
  return { d: view(d, n).slice(), W: W.slice() };
}

// General eigenproblem: eigenvalues d + i e and V^T (Schur vectors turned
// eigenvectors, before normalization); "noconv" if QR did not converge.
export function wasmGenEig(A: Float64Array, n: number): { d: Float64Array; e: Float64Array; W: Float64Array } | "noconv" | null {
  if (n < EIG_MIN || !kernels()) return null;
  const [h, w, d, e, ort, tmp] = layout(n * n, n * n, n, n, n, n);
  view(h, n * n).set(A);
  if (K!.dgeev(h, n, w, d, e, ort, tmp)) return "noconv";
  return { d: view(d, n).slice(), e: view(e, n).slice(), W: view(w, n * n).slice() };
}

// SVD of the m x n (m >= n) matrix A: U's n columns, S (n), V's n columns,
// as gkrSVD() in numpy_linalg.ts; "noconv" if it did not converge.
export function wasmSVD(A: Float64Array, m: number, n: number): [Float64Array[], Float64Array, Float64Array[]] | "noconv" | null {
  if (m < n || m * n * n < WORK_MIN || n < 2 || !kernels()) return null;
  const [a0, a, u, v, s, e, work] = layout(m * n, m * n, m * n, n * n, n + 1, n, m);
  view(a0, m * n).set(A);
  K!.transpose(a0, m, n, a);
  if (K!.dgesvd(a, m, n, u, v, s, e, work)) return "noconv";
  const U = Array.from({ length: n }, (_, j) => view(u + j * m * 8, m).slice());
  const V = Array.from({ length: n }, (_, j) => view(v + j * n * 8, n).slice());
  return [U, view(s, n).slice(), V];
}

// FFT twiddle tables cos/sin(2 pi k/n), k < n, and the radix-3/5 constants:
// computed by numpy_fft.ts, which passes them in.
export interface Twiddles {
  c: Float64Array;
  s: Float64Array;
}
const FFT_MIN = 64;

// The complex FFT (interleaved, length N, in place) by Stockham passes of
// the given radices; false if the kernels are not used.
export function wasmFFT(x: Float64Array, N: number, factors: number[], inverse: boolean, tw: Twiddles, consts: Float64Array): boolean {
  if (N < FFT_MIN || !kernels()) return false;
  const key = `c${N}`, keep = resident === key;
  const [tc, ts, cs, f, xa, ya] = layout(N, N, 8, factors.length, 2 * N, 2 * N);
  if (!keep) {
    view(tc, N).set(tw.c);
    view(ts, N).set(tw.s);
    view(cs, 8).set(consts);
  }
  view(f, factors.length).set(factors);
  view(xa, 2 * N).set(x);
  const r = K!.fft_stockham(xa, ya, N, f, factors.length, tc, ts, cs, inverse ? 1 : 0);
  x.set(view(r ? ya : xa, 2 * N));
  resident = key;
  return true;
}

// rfft of `rows` contiguous real rows of even length n from data[off..]
// into out (rows x (n/2+1) interleaved complex, from out[ooff..]); the
// half-length transform uses `factors`.
export function wasmRfftRows(data: Float64Array, off: number, rows: number, n: number, out: Float64Array, ooff: number,
                             factors: number[], twh: Twiddles, twn: Twiddles, consts: Float64Array): boolean {
  const h = n / 2;
  if (h < FFT_MIN || !kernels()) return false;
  const key = `r${n}`, keep = resident === key;
  const [tch, tsh, tcn, tsn, cs, f, z, y, d, o] = layout(h, h, n, n, 8, factors.length, n, n, rows * n, rows * 2 * (h + 1));
  if (!keep) {
    view(tch, h).set(twh.c);
    view(tsh, h).set(twh.s);
    view(tcn, n).set(twn.c);
    view(tsn, n).set(twn.s);
    view(cs, 8).set(consts);
  }
  view(f, factors.length).set(factors);
  view(d, rows * n).set(data.subarray(off, off + rows * n));
  K!.rfft_rows(d, rows, n, o, z, y, f, factors.length, tch, tsh, tcn, tsn, cs);
  out.set(view(o, rows * 2 * (h + 1)), ooff);
  resident = key;
  return true;
}

// exp and log also come in a module built with relaxed SIMD
// (kernels/relaxed), whose fused multiply-adds are the hardware's.  The
// WebAssembly spec lets relaxed_madd round once or twice, so it is used only
// where fma_probe() shows that it rounds once: then results are the same
// bits as the main module's exact software FMA, several times faster.
// SAGEBRUSH_NO_RELAXED=1 turns it off.
interface Relaxed {
  memory: WebAssembly.Memory;
  vexp(x: number, y: number, n: number, tab: number): void;
  vlog(x: number, y: number, n: number, tab: number): void;
  mt_fill: Exports["mt_fill"];
  pcg_fill: Exports["pcg_fill"];
  fma_probe(): number;
}
// layout() in the relaxed module's memory: byte addresses, and the view
function rlayout(R: { e: Relaxed; base: number; f64: Float64Array }, ...lens: number[]): number[] {
  const at: number[] = [];
  let o = 0;
  for (const len of lens) {
    at.push(R.base + o * 8);
    o += len + (len & 1) + 72;
  }
  const mem = R.e.memory, need = R.base + o * 8;
  if (mem.buffer.byteLength < need) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
  if (R.f64.buffer !== mem.buffer) R.f64 = new Float64Array(mem.buffer);
  return at;
}
let RX: { e: Relaxed; base: number; f64: Float64Array; tab: string } | null | undefined;
function relaxed() {
  if (RX !== undefined) return RX;
  RX = null;
  try {
    if ((globalThis as any).process?.env?.SAGEBRUSH_NO_RELAXED || !kernels()) return RX;
    const e = instantiate(KERNELS_RELAXED_WASM) as unknown as Relaxed;
    if (e.fma_probe() === 1) RX = { e, base: e.memory.buffer.byteLength, f64: new Float64Array(0), tab: "" };
  } catch {
    // no relaxed SIMD in this engine
  }
  return RX;
}
export function wasmFusedFMA(): boolean {
  return relaxed() !== null;
}

// exp or log (glibc's, as libm.ts) of src[off..off+n] into dst[0..n].
const UNARY_MIN = 64;
export function wasmUnary(op: "vexp" | "vlog", tab: Float64Array, src: Float64Array, off: number, n: number, dst: Float64Array): boolean {
  if (n < UNARY_MIN || !kernels()) return false;
  const R = relaxed();
  if (R) {
    const t = R.base, x = t + 8 * (tab.length + 72), need = x + 8 * n, mem = R.e.memory;
    if (mem.buffer.byteLength < need) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
    if (R.f64.buffer !== mem.buffer) R.f64 = new Float64Array(mem.buffer);
    if (R.tab !== op) R.f64.set(tab, t / 8);
    R.tab = op;
    R.f64.set(src.subarray(off, off + n), x / 8);
    R.e[op](x, x, n, t);
    dst.set(R.f64.subarray(x / 8, x / 8 + n));
    return true;
  }
  const key = op, keep = resident === key;
  const [t, x] = layout(tab.length, n);
  if (!keep) view(t, tab.length).set(tab);
  view(x, n).set(src.subarray(off, off + n));
  K![op](x, x, n, t);
  dst.set(view(x, n));
  resident = key;
  return true;
}

// Sorting doubles (kernels/src/sort.rs: a stable radix sort, in the order of
// a typed array's sort: -0 before +0, NaN last).
const SORT_MIN = 64, HIST = (6 * 2048) / 2; // the histograms, in doubles
export function wasmSort(x: Float64Array): boolean {
  const n = x.length;
  if (n < SORT_MIN || !kernels()) return false;
  const [a, t, h] = layout(n, n, HIST);
  view(a, n).set(x);
  K!.sort_f64(a, n, t, h);
  x.set(view(a, n));
  return true;
}
// The stable argsort of x into out[ooff..ooff+n] (as numbers).
export function wasmArgsort(x: Float64Array, out: Float64Array | number[], ooff: number): boolean {
  const n = x.length;
  if (n < SORT_MIN || n >= 2 ** 32 || !kernels()) return false;
  const half = Math.ceil(n / 2);
  const [a, idx, k1, k2, idx2, h] = layout(n, half, n, n, half, HIST);
  view(a, n).set(x);
  K!.argsort_f64(a, n, idx, k1, k2, idx2, h);
  const r = new Uint32Array(f64.buffer, idx, n);
  if (out instanceof Float64Array) out.set(r, ooff);
  else for (let i = 0; i < n; i++) out[ooff + i] = r[i];
  return true;
}

// numpy.random's fills (kernels/src/random.rs); dist as there: 0 uniform,
// 1 legacy normal, 2 legacy exponential, 3 masked bounded, 4 Lemire
// bounded, 5 polar normal, 6 ziggurat normal, 7 ziggurat exponential.  The generator's state is copied in and
// back out: key (624 words) and meta [pos, has_gauss, gauss] for MT19937,
// words [state lo, hi, inc lo, hi] and meta [has_u32, u32] for PCG64.
const RANDOM_MIN = 256;
// tabs: log's, exp's and the ziggurats' tables (RANDOM_TABLES)
export function wasmRandom(gen: "mt" | "pcg", state: Uint32Array | BigUint64Array, meta: Float64Array, dist: number,
                           out: Float64Array, lo: number, rng: number, logtab: Float64Array): boolean {
  const n = out.length;
  if (n < RANDOM_MIN || !kernels()) return false;
  // the relaxed-SIMD build where its FMA is fused (normals call log)
  const R = relaxed();
  const [t, st, m, o] = R ? rlayout(R, logtab.length, gen === "mt" ? 312 : 4, 4, n) : layout(logtab.length, gen === "mt" ? 312 : 4, 4, n);
  const F = R ? R.f64 : f64, E = R ? R.e : K!;
  const v = (addr: number, len: number) => F.subarray(addr / 8, addr / 8 + len);
  v(t, logtab.length).set(logtab);
  const S = gen === "mt" ? new Uint32Array(F.buffer, st, 624) : new BigUint64Array(F.buffer, st, 4);
  S.set(state as any);
  v(m, meta.length).set(meta);
  (gen === "mt" ? E.mt_fill : E.pcg_fill)(st, m, dist, o, n, lo, rng, t);
  state.set(S as any);
  meta.set(v(m, meta.length));
  out.set(v(o, n));
  if (R) R.tab = "";
  return true;
}
