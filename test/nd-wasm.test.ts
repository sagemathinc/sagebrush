import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

// The committed numerics-core module, wasm/sagebrush-nd.wasm (engine/nd; numerics-core r4.2, M0), exactly as
// shipped: its GEMM against a plain product on an edge shape, its threads' shares (1, 3 and 8), the bits it
// must share with the native scalar microkernel (engine/nd's cross_kernel_bits: no FMA, no reordering), and
// every boundary refusal of its entry point, each leaving C untouched. (That the committed module is what
// scripts/build-nd.mjs makes from engine/nd is the engine-wasm job's check-fresh-wasm.mjs: build-engine.mjs
// rebuilds both modules.)
const root = join(__dirname, "..", "..");
const bytes = readFileSync(join(root, "wasm", "sagebrush-nd.wasm"));
const PAGE = 65536;
const BASE = 8 << 20; // above the module's own data and stack
// (engine/nd/src/gemm.rs CROSS_KERNEL_FNV)
const CROSS_KERNEL_FNV = 0x364c3cb66df0cabbn;

type Exports = { nd_gemm_part(desc: number, id: number): number; nd_gemm_scratch_len(): number; nd_microkernel(out: number, cap: number): number };

function instance(pages: number) {
  const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports as unknown as Exports;
  return { memory, ex };
}

// seeded inputs: the same 32-bit LCG as engine/nd's tests (exact in f64 in both)
function seeded(count: number, state: { s: number }): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    state.s = (Math.imul(state.s, 1103515245) + 12345) >>> 0;
    out[i] = state.s / 4294967296 - 0.5;
  }
  return out;
}

function fnv(c: Float64Array): bigint {
  let h = 0xcbf29ce484222325n;
  const b = new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
  for (const x of b) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

// a job's layout: [desc 64 B][A][B][C][scratch per thread], all 8-aligned, from BASE
function layout(m: number, k: number, n: number, threads: number, scratchLen: number) {
  const desc = BASE, a = BASE + 64, b = a + m * k * 8, c = b + k * n * 8, s0 = c + m * n * 8, stride = scratchLen * 8;
  return { desc, a, b, c, s0, stride, end: s0 + threads * stride };
}

test("the committed nd module: C = A*B on 97 x 257 x 513 against a plain product, threads 1, 3 and 8, the same bits as the native scalar kernel", () => {
  const [m, k, n] = [97, 257, 513];
  const probe = instance(256);
  const L = layout(m, k, n, 8, probe.ex.nd_gemm_scratch_len());
  const { memory, ex } = instance(Math.ceil(L.end / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
  const st = { s: 2026 };
  f64.set(seeded(m * k, st), L.a / 8);
  f64.set(seeded(k * n, st), L.b / 8);
  // a plain product, for the tolerance check (r4.2 §7: |C - C_ref| <= c k u |A||B|, entries in [-1/2, 1/2))
  const ref = new Float64Array(m * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < m; i++) {
    let s = 0;
    for (let p = 0; p < k; p++) s += f64[L.a / 8 + p * m + i] * f64[L.b / 8 + j * k + p];
    ref[j * m + i] = s;
  }
  const bound = 10 * k * 2.220446049250313e-16 * (k / 4);
  let first: Float64Array | null = null;
  for (const t of [1, 3, 8]) {
    f64.fill(Number.NaN, L.c / 8, L.c / 8 + m * n);
    u32.set([L.a, L.b, L.c, m, n, k, t, L.s0, L.stride], L.desc / 4);
    // (each thread's share, called in turn: the partition, not the scheduling, is what is tested here)
    for (let id = 0; id < 8; id++) assert.equal(ex.nd_gemm_part(L.desc, id), 1, `t=${t} id=${id} refused`);
    const c = f64.slice(L.c / 8, L.c / 8 + m * n);
    let worst = 0;
    for (let i = 0; i < m * n; i++) worst = Math.max(worst, Math.abs(c[i] - ref[i]));
    assert.ok(worst <= bound, `t=${t}: max error ${worst} > ${bound}`);
    if (first) assert.ok(c.every((x, i) => Object.is(x, first![i])), `t=${t}: bits differ from t=1`);
    else first = c;
  }
  assert.equal(fnv(first!), CROSS_KERNEL_FNV, `C's bits: 0x${fnv(first!).toString(16)} (the native scalar kernel's are 0x${CROSS_KERNEL_FNV.toString(16)})`);
  // the microkernel's name
  const len = ex.nd_microkernel(L.end, 64);
  assert.equal(new TextDecoder().decode(new Uint8Array(memory.buffer).slice(L.end, L.end + len)), "wasm-simd128-4x4");
});

test("the committed nd module's entry point refuses every bad job before writing anything (numerics-core M0, E1)", () => {
  const [m, k, n] = [8, 8, 8];
  const probe = instance(256);
  const sl = probe.ex.nd_gemm_scratch_len();
  const L = layout(m, k, n, 2, sl);
  const pages = Math.ceil(L.end / PAGE) + 1;
  const { memory, ex } = instance(pages);
  const mem = pages * PAGE;
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
  f64.fill(1, L.a / 8, L.c / 8);
  const good = [L.a, L.b, L.c, m, n, k, 2, L.s0, L.stride];
  const refused = (name: string, d: number[], descAt = L.desc, id = 0) => {
    f64.fill(7, L.c / 8, L.c / 8 + m * n);
    u32.set(d.map((x) => x >>> 0), L.desc / 4);
    assert.equal(ex.nd_gemm_part(descAt, id), 0, `${name}: not refused`);
    assert.ok(f64.subarray(L.c / 8, L.c / 8 + m * n).every((x) => x === 7), `${name}: C was written`);
  };
  const with_ = (i: number, v: number) => good.map((x, j) => (j === i ? v : x));
  // (the control: the good job runs)
  u32.set(good, L.desc / 4);
  assert.equal(ex.nd_gemm_part(L.desc, 0), 1);
  refused("zero threads", with_(6, 0));
  refused("misaligned A", with_(0, L.a + 4));
  refused("misaligned C", with_(2, L.c + 4));
  refused("misaligned scratch", with_(7, L.s0 + 4));
  refused("short scratch stride", with_(8, sl * 8 - 8));
  refused("C past the end of memory", with_(2, mem - 8));
  refused("A past the end of memory", with_(0, mem - 64));
  refused("scratch past the end of memory", with_(6, 1 << 20));
  refused("m*k overflowing", with_(3, 0x40000000));
  refused("n huge", with_(4, 0xffffffff));
  refused("C overlapping A", with_(2, L.a));
  refused("C overlapping B", with_(2, L.b + 8));
  refused("scratch overlapping C", with_(7, L.c));
  refused("scratch overlapping A", with_(7, L.a));
  refused("a descriptor past the end of memory", good, mem - 16);
  refused("a misaligned descriptor", good, L.desc + 2);
  // ids at or beyond the job's thread count: nothing to do (1), nothing written
  f64.fill(7, L.c / 8, L.c / 8 + m * n);
  u32.set(good, L.desc / 4);
  assert.equal(ex.nd_gemm_part(L.desc, 2), 1);
  assert.equal(ex.nd_gemm_part(L.desc, 0xffffffff), 1);
  assert.ok(f64.subarray(L.c / 8, L.c / 8 + m * n).every((x) => x === 7), "an id beyond the threads wrote C");
  // zero dimensions: nothing to compute, accepted
  for (const [i, what] of [[3, "m"], [4, "n"], [5, "k"]] as const) {
    u32.set(with_(i, 0), L.desc / 4);
    assert.equal(ex.nd_gemm_part(L.desc, 0), 1, `${what} = 0`);
  }
  // the name buffer: out of memory refused
  assert.equal(ex.nd_microkernel(mem - 4, 64), 0);
  assert.equal(ex.nd_microkernel(0, 64), 0);
});

test("the committed nd module on real worker threads sharing its memory: 3 threads give the 1-thread bits", async () => {
  const [m, k, n] = [64, 300, 100];
  const probe = instance(256);
  const L = layout(m, k, n, 3, probe.ex.nd_gemm_scratch_len());
  const STACK = 1 << 20, stacks = L.end + PAGE;
  const { memory, ex } = instance(Math.ceil((stacks + 4 * STACK) / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
  const st = { s: 7 };
  f64.set(seeded(m * k, st), L.a / 8);
  f64.set(seeded(k * n, st), L.b / 8);
  u32.set([L.a, L.b, L.c, m, n, k, 1, L.s0, L.stride], L.desc / 4);
  assert.equal(ex.nd_gemm_part(L.desc, 0), 1);
  const one = f64.slice(L.c / 8, L.c / 8 + m * n);
  f64.fill(Number.NaN, L.c / 8, L.c / 8 + m * n);
  u32.set([L.a, L.b, L.c, m, n, k, 3, L.s0, L.stride], L.desc / 4);
  const src = `
    const { workerData, parentPort } = require("node:worker_threads");
    const { bytes, memory, desc, id, stackTop } = workerData;
    const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
    ex.__stack_pointer.value = stackTop;
    parentPort.postMessage(ex.nd_gemm_part(desc, id));`;
  const runs = [1, 2].map((id) => new Promise<number>((resolve, reject) => {
    const w = new Worker(src, { eval: true, workerData: { bytes, memory, desc: L.desc, id, stackTop: stacks + (id + 1) * STACK } });
    w.once("message", (r) => { resolve(r); void w.terminate(); });
    w.once("error", reject);
  }));
  assert.equal(ex.nd_gemm_part(L.desc, 0), 1);
  assert.deepEqual(await Promise.all(runs), [1, 1]);
  const three = f64.slice(L.c / 8, L.c / 8 + m * n);
  assert.ok(three.every((x, i) => Object.is(x, one[i])), "3 worker threads' bits differ from 1 thread's");
});
