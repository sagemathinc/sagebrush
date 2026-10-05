// The WebAssembly SIMD kernels of kernels/src (matmul, LU, QR, eigenproblems,
// SVD), compiled
// synchronously on first use.  Operands are copied into the module's linear
// memory above its initial size (the module has no allocator: everything
// below is its stack and data).  Each kernel does the same floating-point
// operations in the same order as the JavaScript code it replaces, so results
// do not depend on whether WebAssembly is available.  Set
// globalThis.__SAGEBRUSH_NO_WASM__ = true (or the environment variable
// SAGEBRUSH_NO_WASM=1) before first use to disable.

import { KERNELS_WASM } from "./kernels_wasm";

interface Exports {
  memory: WebAssembly.Memory;
  dgemm(a: number, b: number, c: number, m: number, n: number, k: number, bp: number): void;
  dgetrf(a: number, n: number, piv: number): number;
  dgetrs(lu: number, n: number, x: number, m: number): void;
  dgeqr(c: number, m: number, n: number, v: number, beta: number, q: number, qc: number): void;
  dsyev(w: number, n: number, d: number, e: number): number;
  dgeev(h: number, n: number, w: number, d: number, e: number, ort: number, tmp: number): number;
  dgesvd(a: number, m: number, n: number, u: number, v: number, s: number, e: number, work: number): number;
}

let K: Exports | null | undefined;
let base = 0;
let f64 = new Float64Array(0);
let i32 = new Int32Array(0);

function kernels(): Exports | null {
  if (K !== undefined) return K;
  K = null;
  try {
    const g = globalThis as any;
    if (g.__SAGEBRUSH_NO_WASM__ || g.process?.env?.SAGEBRUSH_NO_WASM || typeof WebAssembly !== "object") return K;
    const bin = atob(KERNELS_WASM);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    K = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as Exports;
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

// Make room for `doubles` float64s at the scratch base; returns the views
// (valid until the next reserve).
function reserve(doubles: number): void {
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
// their byte addresses, each 16-byte aligned.
function layout(...lens: number[]): number[] {
  const at: number[] = [];
  let o = 0;
  for (const len of lens) {
    at.push(base + o * 8);
    o += len + (len & 1);
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
  const [c, v, beta, q] = layout(m * n, k * m, k, qc * m);
  const C = view(c, m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) C[j * m + i] = A[i * n + j];
  K!.dgeqr(c, m, n, v, beta, q, qc);
  const Qc = view(q, qc * m), Q = new Float64Array(m * qc);
  for (let col = 0; col < qc; col++) for (let i = 0; i < m; i++) Q[i * qc + col] = Qc[col * m + i];
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
  const [a, u, v, s, e, work] = layout(m * n, m * n, n * n, n + 1, n, m);
  const Am = view(a, m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) Am[j * m + i] = A[i * n + j];
  if (K!.dgesvd(a, m, n, u, v, s, e, work)) return "noconv";
  const U = Array.from({ length: n }, (_, j) => view(u + j * m * 8, m).slice());
  const V = Array.from({ length: n }, (_, j) => view(v + j * n * 8, n).slice());
  return [U, view(s, n).slice(), V];
}
