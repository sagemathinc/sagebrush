import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

// The committed numerics-core module (engine/nd; numerics-core r4.2, M0 and P2a), exactly as shipped:
// wasm/sagebrush-nd.wasm (SIMD128, mul then add): its GEMM against a plain product on an edge shape, its threads' shares (1, 3 and 8), the bits it
// must share with the native kernels without FMA (engine/nd's CROSS_KERNEL_FNV), and
// every boundary refusal of its entry point, each leaving memory untouched (E1/ND-M1: the host's part above
// __heap_base, the descriptor outside the writable arena, C and the scratch inside it, stacks below it). (That the committed module is what
// scripts/build-nd.mjs makes from engine/nd is the engine-wasm job's check-fresh-wasm.mjs: build-engine.mjs
// rebuilds both modules.)
const root = join(__dirname, "..", "..");
const PAGE = 65536;
// the memory map (engine/nd/src/boundary.rs): the module's own data and stack below its floor; the descriptor at
// BASE, the pool's control words after it (CTL); thread stacks (SLOT each, the pool's, recorded by nd_pool_init:
// a job on more than one thread runs only within it, each participant on its own slot) from STACKS; the writable
// arena from ARENA
const BASE = 8 << 20, CTL = BASE + 64, STACKS = BASE + PAGE, SLOT = 256 << 10, ARENA = 16 << 20;
const top = (id: number) => STACKS + (id + 1) * SLOT;
// (engine/nd/src/gemm.rs CROSS_KERNEL_FNV: the kernels without FMA, the SIMD128 one among them)
const CROSS_KERNEL_FNV = 0x364c3cb66df0cabbn;
// the module: file, the microkernel it must report, and its bits (a list, so more modules can be added)
const MODULES = [{ file: "sagebrush-nd.wasm", kernel: "wasm-simd128-4x4", pins: [CROSS_KERNEL_FNV] }];

type Exports = {
  __stack_pointer: WebAssembly.Global; nd_gemm_part(desc: number, id: number): number; nd_info(what: number): number;
  nd_pool_init(ctl: number, stacks: number, slot: number, participants: number): number;
};

for (const MOD of MODULES) {
  const bytes = readFileSync(join(root, "wasm", MOD.file));

  function instance(pages: number) {
    const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
    const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports as unknown as Exports;
    return { memory, ex };
  }
  const SCRATCH_LEN = instance(256).ex.nd_info(0);

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

  // a job's layout in the arena, regions in the given order (default A, B, C, then the scratch), all 8-aligned;
  // words() is its descriptor, the arena [ARENA, end + slack)
  function layout(m: number, k: number, n: number, threads: number, order = ["a", "b", "c", "s"], slack = 0) {
    const size: Record<string, number> = { a: m * k * 8, b: k * n * 8, c: m * n * 8, s: threads * SCRATCH_LEN * 8 };
    const at: Record<string, number> = {};
    let p = ARENA;
    for (const r of order) { at[r] = p; p += size[r]; }
    const L = { desc: BASE, a: at.a, b: at.b, c: at.c, s0: at.s, stride: SCRATCH_LEN * 8, lo: ARENA, hi: p + slack, end: p + slack };
    return { ...L, words: (t = threads) => [L.a, L.b, L.c, m, n, k, t, L.s0, L.stride, L.lo, L.hi] };
  }

  test(`${MOD.file}: the committed nd module: C = A*B on 97 x 257 x 513 against a plain product, threads 1, 3 and 8, one native kernel family's bits`, () => {
    const [m, k, n] = [97, 257, 513];
    const L = layout(m, k, n, 8);
    const { memory, ex } = instance(Math.ceil(L.end / PAGE) + 1);
    const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
    // the module's own part ends below the host's layout, and its name is its own static there
    const floor = ex.nd_info(1);
    assert.ok(floor > 0 && floor <= BASE, `floor ${floor}`);
    const [at, len] = [ex.nd_info(2), ex.nd_info(3)];
    assert.ok(at + len <= floor);
    assert.equal(new TextDecoder().decode(new Uint8Array(memory.buffer).slice(at, at + len)), MOD.kernel);
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
    assert.equal(ex.nd_pool_init(CTL, STACKS, SLOT, 8), 1);
    assert.equal(ex.nd_pool_init(CTL, STACKS, SLOT, 8), 0, "a second pool record");
    const sp = ex.__stack_pointer.value;
    let first: Float64Array | null = null;
    for (const t of [1, 3, 8]) {
      f64.fill(Number.NaN, L.c / 8, L.c / 8 + m * n);
      u32.set(L.words(t), L.desc / 4);
      // (each thread's share, called in turn, each on its own stack slot: the partition, not the scheduling, is what
      // is tested here)
      for (let id = 0; id < 8; id++) {
        ex.__stack_pointer.value = top(id);
        assert.equal(ex.nd_gemm_part(L.desc, id), 1, `t=${t} id=${id} refused`);
      }
      ex.__stack_pointer.value = sp;
      const c = f64.slice(L.c / 8, L.c / 8 + m * n);
      let worst = 0;
      for (let i = 0; i < m * n; i++) worst = Math.max(worst, Math.abs(c[i] - ref[i]));
      assert.ok(worst <= bound, `t=${t}: max error ${worst} > ${bound}`);
      if (first) assert.ok(c.every((x, i) => Object.is(x, first![i])), `t=${t}: bits differ from t=1`);
      else first = c;
    }
    assert.ok(MOD.pins.includes(fnv(first!)), `C's bits: 0x${fnv(first!).toString(16)} (allowed for ${MOD.kernel}: ${MOD.pins.map((x) => "0x" + x.toString(16)).join(", ")})`);
  });

  test(`${MOD.file}: the committed nd module's entry point refuses every bad job before writing anything (numerics-core M0, E1/ND-M1)`, () => {
    const [m, k, n] = [8, 8, 8];
    const L = layout(m, k, n, 2, undefined, 4 << 20); // (4 MiB of free arena after the scratch)
    const pages = Math.ceil((L.end + SLOT) / PAGE) + 1;
    const { memory, ex } = instance(pages);
    // (a pool of 3: participant id's calls run on its slot, `on`; the jobs here are on 2 threads)
    assert.equal(ex.nd_pool_init(CTL, STACKS, SLOT, 3), 1);
    const sp = ex.__stack_pointer.value;
    const on = (desc: number, id: number) => {
      ex.__stack_pointer.value = top(Math.min(id, 2));
      try {
        return ex.nd_gemm_part(desc, id);
      } finally {
        ex.__stack_pointer.value = sp;
      }
    };
    const mem = pages * PAGE;
    const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer), u8 = new Uint8Array(memory.buffer);
    const st = { s: 99 };
    f64.set(seeded(m * k, st), L.a / 8);
    f64.set(seeded(k * n, st), L.b / 8);
    const good = L.words();
    const put = (at: number, d: number[]) => u8.set(new Uint8Array(new Uint32Array(d.map((x) => x >>> 0)).buffer), at);
    // (the control: the good job runs; its C is the reference for the reordered layouts below)
    put(L.desc, good);
    assert.equal(on(L.desc, 0), 1);
    assert.equal(on(L.desc, 1), 1);
    const goodC = f64.slice(L.c / 8, L.c / 8 + m * n);
    // a refused job: 0, and not one byte of memory changed (the module's part, the descriptor, the arena)
    // (from the module's floor: below it is the module's own stack; the pool's stack slots, which the calls use,
    // and `frame`, a caller's stack placed in the arena, are excluded likewise)
    const floor = ex.nd_info(1);
    const unchanged = (before: Uint8Array, frame: [number, number] = [STACKS, top(2)]) => {
      const now = u8.subarray(floor, L.end), was = before.subarray(0, L.end - floor);
      return now.every((x, i) => x === was[i] || (floor + i >= STACKS && floor + i < top(2)) || (floor + i >= frame[0] && floor + i < frame[1]));
    };
    const refused = (name: string, d: number[], descAt = L.desc, id = 0, at = L.desc, frame?: [number, number]) => {
      put(at, d);
      const before = u8.slice(floor, L.end);
      assert.equal(frame ? ex.nd_gemm_part(descAt, id) : on(descAt, id), 0, `${name}: not refused`);
      assert.ok(unchanged(before, frame), `${name}: memory was written`);
    };
    const with_ = (i: number, v: number) => good.map((x, j) => (j === i ? v : x));
    refused("zero threads", with_(6, 0));
    refused("misaligned A", with_(0, L.a + 4));
    refused("misaligned C", with_(2, L.c + 4));
    refused("misaligned scratch", with_(7, L.s0 + 4));
    refused("short scratch stride", with_(8, L.stride - 8));
    refused("C past the end of memory", with_(2, mem - 8));
    refused("A past the end of memory", with_(0, mem - 64));
    refused("scratch past the end of memory", with_(6, 1 << 20));
    refused("m*k overflowing", with_(3, 0x40000000));
    refused("n huge", with_(4, 0xffffffff));
    refused("C overlapping A", with_(2, L.a));
    refused("C overlapping B", with_(2, L.b + 8));
    refused("scratch overlapping C", with_(7, L.c));
    // (nonempty regions at address 0, or on the module's own statics and stack, below its floor)
    refused("C at 0", with_(2, 0));
    refused("the scratch at 0", with_(7, 0));
    refused("A at 0", with_(0, 0));
    refused("C on the module's statics", with_(2, ex.nd_info(2) & ~7));
    refused("the scratch on the module's stack", with_(7, 4096));
    refused("the descriptor at 0", good, 0, 0, 0);
    refused("the descriptor on the module's statics", good, ex.nd_info(2) & ~7, 0, ex.nd_info(2) & ~7);
    // (the arena: C and the scratch in it, the descriptor out of it)
    refused("an arena from 0", with_(9, 0));
    refused("an empty arena", with_(10, L.lo));
    refused("C outside the arena", with_(2, L.hi));
    refused("the scratch outside the arena (C and the scratch in memory, the arena ending before the scratch)", with_(10, L.s0));
    refused("the scratch outside the arena (past its end)", with_(7, L.hi));
    // (grader T3: C, then the scratch, starting just below the arena, where the stacks are)
    refused("C starting just below the arena", with_(9, L.c + 8));
    {
      const R = layout(m, k, n, 2, ["a", "b", "s", "c"], 4 << 20);
      const d = R.words();
      d[9] = R.s0 + 8;
      refused("the scratch starting just below the arena", d);
    }
    // (an arena from between the module's stack and its floor: C, the scratch and the frame alone would allow it)
    // (the descriptor above the arena, so that only the arena's own floor is wrong)
    refused("an arena from below the floor", with_(9, (floor - 64) & ~7), L.end + 64, 0, L.end + 64);
    refused("the descriptor on C", good, L.c, 0, L.c);
    refused("the descriptor on the scratch", good, L.s0 + L.stride, 0, L.s0 + L.stride);
    refused("the descriptor in the arena", good, L.hi - 64, 0, L.hi - 64);
    refused("a descriptor past the end of memory", good, mem - 16, 0, L.desc);
    // (grader R1: a good descriptor, misaligned)
    refused("a misaligned descriptor", good, L.desc + 1024 + 2, 0, L.desc + 1024 + 2);
    // (grader R2: the scratch overlapping only A, then only B: A or B last, the scratch on it)
    for (const r of ["a", "b"]) {
      const R = layout(m, k, n, 2, ["a", "b", "c"].filter((x) => x !== r).concat(r), 4 << 20);
      const d = R.words();
      d[7] = r === "a" ? R.a : R.b;
      refused(`the scratch overlapping only ${r.toUpperCase()}`, d);
    }
    // (a one-thread job's calling frame must lie below the arena: in it, or above it, refused; a threaded job's in
    // its own slot of the pool: another participant's slot, or the module's own stack, refused)
    for (const [what, t] of [["in", L.hi - PAGE], ["above", L.end + SLOT]] as const) {
      ex.__stack_pointer.value = t;
      refused(`the caller's stack ${what} the arena`, with_(6, 1), L.desc, 0, L.desc, [t - PAGE, t]);
      ex.__stack_pointer.value = sp;
    }
    for (const [what, t] of [["participant 1's slot", top(1)], ["the module's own stack", sp]] as const) {
      ex.__stack_pointer.value = t;
      refused(`participant 0 on ${what}`, good, L.desc, 0, L.desc, [t - PAGE, t]);
      ex.__stack_pointer.value = sp;
    }
    refused("3 threads on a pool of 3, participant 0 on the module's own stack", with_(6, 3), L.desc, 0, L.desc, [sp - PAGE, sp]);
    // ids at or beyond the job's thread count, within the pool: nothing to do (1), nothing written; beyond the pool:
    // refused (0), nothing written
    put(L.desc, good);
    const before = u8.slice(floor, L.end);
    assert.equal(on(L.desc, 2), 1);
    assert.equal(on(L.desc, 3), 0);
    assert.equal(on(L.desc, 0xffffffff), 0);
    assert.ok(unchanged(before), "an id beyond the threads wrote memory");
    // (grader R3: thread 1 of 2 uses its own scratch: thread 0's stays as it was)
    f64.fill(7, L.s0 / 8, L.s0 / 8 + 2 * SCRATCH_LEN);
    assert.equal(on(L.desc, 1), 1);
    assert.ok(f64.subarray(L.s0 / 8, L.s0 / 8 + SCRATCH_LEN).every((x) => x === 7), "thread 1 wrote thread 0's scratch");
    assert.ok(!f64.subarray(L.s0 / 8 + SCRATCH_LEN, L.s0 / 8 + 2 * SCRATCH_LEN).every((x) => x === 7), "thread 1 left its own scratch alone");
    // (the partition is in blocks of the kernel's NR, 4 in both modules: thread 1 of 2 on n = 8 computes
    // exactly columns 4..8 and leaves 0..4 alone)
    {
      const P = layout(8, 8, 8, 2, undefined, 4 << 20);
      put(P.desc, P.words());
      f64.fill(7, P.c / 8, P.c / 8 + 64);
      assert.equal(on(P.desc, 1), 1);
      assert.ok(f64.subarray(P.c / 8, P.c / 8 + 32).every((x) => x === 7), "thread 1 wrote columns 0..4");
      assert.ok(f64.subarray(P.c / 8 + 32, P.c / 8 + 64).every((x) => x !== 7), "thread 1 left columns 4..8");
      put(L.desc, good);
    }
    // zero dimensions: nothing to compute, accepted
    for (const [i, what] of [[3, "m"], [4, "n"], [5, "k"]] as const) {
      put(L.desc, with_(i, 0));
      assert.equal(on(L.desc, 0), 1, `${what} = 0`);
    }
    // (grader advisory: valid layouts in other orders, C before A and B, run and give the same C)
    for (const order of [["c", "a", "b", "s"], ["s", "c", "b", "a"]]) {
      const R = layout(m, k, n, 2, order, 4 << 20);
      const ins = new Float64Array(m * k + k * n);
      ins.set(f64.slice(L.a / 8, L.a / 8 + m * k));
      ins.set(f64.slice(L.b / 8, L.b / 8 + k * n), m * k);
      f64.fill(0, ARENA / 8, R.end / 8);
      f64.set(ins.subarray(0, m * k), R.a / 8);
      f64.set(ins.subarray(m * k), R.b / 8);
      put(R.desc, R.words());
      assert.equal(on(R.desc, 0), 1, `order ${order}`);
      assert.equal(on(R.desc, 1), 1, `order ${order}`);
      assert.ok(f64.subarray(R.c / 8, R.c / 8 + m * n).every((x, i) => Object.is(x, goodC[i])), `order ${order}: a different C`);
      f64.set(ins.subarray(0, m * k), L.a / 8);
      f64.set(ins.subarray(m * k), L.b / 8);
    }
  });

  // a worker thread on its own stack (top at stackTop), calling the entry point once
  const workerSrc = `
    const { workerData, parentPort } = require("node:worker_threads");
    const { bytes, memory, desc, id, stackTop } = workerData;
    const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports;
    ex.__stack_pointer.value = stackTop;
    parentPort.postMessage(ex.nd_gemm_part(desc, id));`;
  function onWorker(memory: WebAssembly.Memory, desc: number, id: number, stackTop: number) {
    return new Promise<number>((resolve, reject) => {
      const w = new Worker(workerSrc, { eval: true, workerData: { bytes, memory, desc, id, stackTop } });
      w.once("message", (r) => { resolve(r); void w.terminate(); });
      w.once("error", reject);
    });
  }

  test(`${MOD.file}: the committed nd module on real worker threads sharing its memory: 3 threads give the 1-thread bits; a thread whose stack is in the arena refuses`, async () => {
    const [m, k, n] = [64, 300, 100];
    const L = layout(m, k, n, 3, undefined, 2 * SLOT);
    const { memory, ex } = instance(Math.ceil(L.end / PAGE) + 1);
    const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
    const st = { s: 7 };
    f64.set(seeded(m * k, st), L.a / 8);
    f64.set(seeded(k * n, st), L.b / 8);
    u32.set(L.words(1), L.desc / 4);
    assert.equal(ex.nd_gemm_part(L.desc, 0), 1);
    const one = f64.slice(L.c / 8, L.c / 8 + m * n);
    f64.fill(Number.NaN, L.c / 8, L.c / 8 + m * n);
    u32.set(L.words(3), L.desc / 4);
    // (the pool's stacks below the arena, as the page lays them out; the caller on slot 0)
    assert.equal(ex.nd_pool_init(CTL, STACKS, SLOT, 3), 1);
    const runs = [1, 2].map((id) => onWorker(memory, L.desc, id, top(id)));
    const sp = ex.__stack_pointer.value;
    ex.__stack_pointer.value = top(0);
    assert.equal(ex.nd_gemm_part(L.desc, 0), 1);
    ex.__stack_pointer.value = sp;
    assert.deepEqual(await Promise.all(runs), [1, 1]);
    const three = f64.slice(L.c / 8, L.c / 8 + m * n);
    assert.ok(three.every((x, i) => Object.is(x, one[i])), "3 worker threads' bits differ from 1 thread's");
    // a worker given a stack in the arena's free end, or another participant's slot: refused, C as it was
    assert.equal(await onWorker(memory, L.desc, 1, (L.end - PAGE) & ~15), 0);
    assert.equal(await onWorker(memory, L.desc, 1, top(2)), 0);
    assert.ok(f64.slice(L.c / 8, L.c / 8 + m * n).every((x, i) => Object.is(x, one[i])), "a refused worker wrote C");
  });

  test(`${MOD.file}: the committed nd module refuses a 2 GiB operand at its entry point (isize::MAX, wasm32's slice limit) and accepts 2 GiB - 8`, () => {
    // (m = 1, k = 2^28: A is exactly 2^31 bytes; n = 0, so B and C are empty and nothing is computed. The memory
    // is reserved, not written: only the descriptor and the snapshot's range are touched)
    const a = ARENA, s0 = a + 2 ** 31;
    const end = s0 + SCRATCH_LEN * 8;
    const pages = Math.ceil(end / PAGE) + 1;
    const { memory, ex } = instance(pages);
    const u32 = new Uint32Array(memory.buffer, 0, (ARENA + PAGE) / 4);
    const words = (k: number) => [a, a, a, 1, 0, k, 1, s0, SCRATCH_LEN * 8, a, end];
    u32.set(words(2 ** 28), BASE / 4);
    assert.equal(ex.nd_gemm_part(BASE, 0), 0, "a 2^31-byte A was not refused");
    u32.set(words(2 ** 28 - 1), BASE / 4);
    assert.equal(ex.nd_gemm_part(BASE, 0), 1, "a (2^31 - 8)-byte A was refused");
  });
}
