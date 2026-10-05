// The WebAssembly SIMD kernels of kernels/src/lib.rs (dgemm, LU), compiled
// synchronously on first use.  Operands are copied into the module's linear
// memory above its initial size (the module has no allocator: everything
// below is its stack and data).  Each kernel does the same floating-point
// operations in the same order as the JavaScript code it replaces, so results
// do not depend on whether WebAssembly is available.  Set
// globalThis.__SAGEBRUSH_NO_WASM__ = true before first use to disable.

import { KERNELS_WASM } from "./kernels_wasm";

interface Exports {
  memory: WebAssembly.Memory;
  dgemm(a: number, b: number, c: number, m: number, n: number, k: number, bp: number): void;
  dgetrf(a: number, n: number, piv: number): number;
  dgetrs(lu: number, n: number, x: number, m: number): void;
}

let K: Exports | null | undefined;
let base = 0;
let f64 = new Float64Array(0);
let i32 = new Int32Array(0);

function kernels(): Exports | null {
  if (K !== undefined) return K;
  K = null;
  try {
    if ((globalThis as any).__SAGEBRUSH_NO_WASM__ || typeof WebAssembly !== "object") return K;
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
const GEMM_MIN = 4096, LU_MIN = 12;

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
