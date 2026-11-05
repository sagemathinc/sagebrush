import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The committed numerics-core module's Cholesky entry, nd_potrf (engine/nd; CHOL-1): A = R'R on one thread,
// exactly as shipped: R overwrites A's upper triangle (A's strictly lower part is not meaningful afterwards); its bits
// are the native scalar kernel family's (engine/nd/src/chol.rs POTRF_FNV); a matrix that isn't positive
// definite reports its 1-based column; and every boundary refusal (each pair of the three regions
// overlapping, alignment, the layout, the work's length, the descriptor and the caller's stack placement)
// leaves memory untouched.
const root = join(__dirname, "..", "..");
const bytes = readFileSync(join(root, "wasm", "sagebrush-nd.wasm"));
const PAGE = 65536;
const BASE = 8 << 20, ARENA = 16 << 20;
// (engine/nd/src/chol.rs tests::POTRF_FNV: R's upper triangles of the seeded 120 x 120 and 131 x 131 SPD
// matrices, column by column, no-FMA family)
const POTRF_FNV = 0x3c1e8bf25e29f991n;
// the report: [status, column, kernel name address, length]
const REPORT_WORDS = 4;

type Exports = { __stack_pointer: WebAssembly.Global; nd_potrf(desc: number): number; nd_solve(desc: number): number; nd_info(what: number): number };

function instance(pages: number) {
  const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports as unknown as Exports;
  return { memory, ex };
}
const SCRATCH_LEN = instance(256).ex.nd_info(0);
// engine/nd/src/chol.rs potrf_work_len(n) = n * n + scratch_len
const workLen = (n: number) => n * n + SCRATCH_LEN;

function seeded(count: number, state: { s: number }): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    state.s = (Math.imul(state.s, 1103515245) + 12345) >>> 0;
    out[i] = state.s / 4294967296 - 0.5;
  }
  return out;
}

// chol.rs tests::spd, in the same arithmetic order: M'M + n I (column-major)
function spd(n: number, seed: number): Float64Array {
  const m = seeded(n * n, { s: seed + 1 }), a = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += m[k + i * n] * m[k + j * n];
      a[i + j * n] = s + (i === j ? n : 0);
    }
  return a;
}

function fnv(c: Float64Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const x of new Uint8Array(c.buffer, c.byteOffset, c.byteLength)) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

// a factorization's layout in the arena: A (lda), work, report; slack after
function layout(n: number, lda = n, slack = 0) {
  const a = ARENA, work = a + 8 * (lda * Math.max(n - 1, 0) + n) + 8;
  const report = work + 8 * workLen(n);
  const hi = report + 4 * REPORT_WORDS + slack;
  const words = [a, work, report, n, lda, workLen(n), ARENA, hi];
  return { a, work, report, hi, words, n, lda };
}

function factor(A: Float64Array, n: number, lda = n) {
  const L = layout(n, lda);
  const { memory, ex } = instance(Math.ceil(L.hi / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer), u8 = new Uint8Array(memory.buffer);
  f64.fill(NaN, L.a / 8, L.a / 8 + lda * n);
  for (let j = 0; j < n; j++) f64.set(A.subarray(j * n, (j + 1) * n), L.a / 8 + j * lda);
  u32.set(L.words, BASE / 4);
  assert.equal(ex.nd_potrf(BASE), 1);
  const rep = u32.slice(L.report / 4, L.report / 4 + REPORT_WORDS);
  const F = f64.slice(L.a / 8, L.a / 8 + lda * n);
  return { rep, F, name: new TextDecoder().decode(u8.slice(rep[2], rep[2] + rep[3])) };
}

test("nd_potrf: the seeded 120 x 120 and 131 x 131 SPD matrices give the native scalar family's bits, factored", () => {
  const all: number[] = [];
  for (const n of [120, 131]) {
    const A = spd(n, 2029);
    const { rep, F, name } = factor(A, n);
    assert.deepEqual([rep[0], rep[1]], [1, 0], "status: factored");
    assert.equal(name, "wasm-simd128-4x4");
    for (let j = 0; j < n; j++) for (let i = 0; i <= j; i++) all.push(F[i + j * n]);
    // and the oracle: ||A - R'R|| / (n ||A||) <= 10 u (inf-norm)
    let num = 0, an = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) {
        let t = 0;
        for (let k = 0; k <= Math.min(i, j); k++) t += F[k + i * n] * F[k + j * n];
        num = Math.max(num, Math.abs(A[i + j * n] - t));
        row += Math.abs(A[i + j * n]);
      }
      an = Math.max(an, row);
    }
    assert.ok(num / (n * an) <= 10 * 1.1102230246251565e-16, `residual ${num / (n * an)}`);
  }
  const h = fnv(new Float64Array(all));
  assert.equal(h, POTRF_FNV, `R's bits: 0x${h.toString(16)}`);
});

test("nd_potrf: a leading dimension above n gives the same bits and leaves the padding alone", () => {
  const n = 131, A = spd(n, 2029);
  const dense = factor(A, n).F, padded = factor(A, n, n + 5).F;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i <= j; i++) assert.ok(Object.is(dense[i + j * n], padded[i + j * (n + 5)]), `R[${i},${j}]`);
    for (let i = n; i < n + 5 && j < n - 1; i++) assert.ok(Number.isNaN(padded[i + j * (n + 5)]), "padding written");
  }
});

test("nd_potrf: a matrix that isn't positive definite reports its first such column (1-based), as dpotrf's info", () => {
  // (the identity with one entry made not positive, at each place the recursion splits differently)
  for (const n of [1, 2, 7, 64, 131])
    for (const bad of new Set([0, n >> 1, n - 1])) {
      for (const v of [0, -1, NaN]) {
        const A = new Float64Array(n * n);
        for (let i = 0; i < n; i++) A[i + i * n] = 1;
        A[bad + bad * n] = v;
        const { rep } = factor(A, n);
        assert.deepEqual([rep[0], rep[1]], [2, bad + 1], `n=${n} column ${bad} = ${v}`);
      }
    }
  // (an indefinite matrix whose failing pivot only shows after the elimination: [[1, 2], [2, 1]])
  assert.deepEqual([...factor(new Float64Array([1, 2, 2, 1]), 2).rep.slice(0, 2)], [2, 2]);
});

test("nd_potrf: the smallest matrices, n = 0 and 1, with dense or padded lda; short work refused", () => {
  for (const n of [0, 1])
    for (const lda of [Math.max(n, 1), 3]) {
      const L = layout(n, lda);
      const { memory, ex } = instance(Math.ceil(L.hi / PAGE) + 1);
      const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
      if (n) f64[L.a / 8] = 4;
      u32.set(L.words, BASE / 4);
      u32[BASE / 4 + 5] = workLen(n) - 1;
      assert.equal(ex.nd_potrf(BASE), 0, `n=${n} lda=${lda}: short work not refused`);
      u32[BASE / 4 + 5] = workLen(n);
      assert.equal(ex.nd_potrf(BASE), 1, `n=${n} lda=${lda}`);
      assert.deepEqual([u32[L.report / 4], u32[L.report / 4 + 1]], [1, 0]);
      if (n) assert.equal(f64[L.a / 8], 2);
    }
});

test("nd_potrf refuses every bad layout before writing anything: each region pair, alignment, the layout, the work, and the descriptor (the frame's rule: engine/nd/src/boundary.rs potrf_layouts)", () => {
  const n = 10, lda = 12;
  const L = layout(n, lda, 4096);
  const { memory, ex } = instance(Math.ceil(L.hi / PAGE) + 2);
  const u32 = new Uint32Array(memory.buffer), f64 = new Float64Array(memory.buffer);
  const A = spd(n, 7);
  for (let j = 0; j < n; j++) f64.set(A.subarray(j * n, (j + 1) * n), L.a / 8 + j * lda);
  const before = new Uint8Array(memory.buffer).slice(ARENA, L.hi);
  const cases: [string, number[]][] = [];
  const bad = (name: string, i: number, v: number) => {
    const w = [...L.words];
    w[i] = v;
    cases.push([name, w]);
  };
  bad("A misaligned", 0, L.a + 4);
  bad("work misaligned", 1, L.work + 4);
  bad("report misaligned", 2, L.report + 2);
  bad("A at 0", 0, 0);
  bad("lda < n", 4, n - 1);
  bad("work one short", 5, workLen(n) - 1);
  bad("n overflowing", 3, 0xffffffff);
  bad("report past the arena", 7, L.report + 8);
  bad("A before the arena", 6, L.a + 8);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) bad(`region ${i} on region ${j}`, i, L.words[j]);
  for (const [name, w] of cases) {
    u32.set(w, BASE / 4);
    assert.equal(ex.nd_potrf(BASE), 0, `${name}: not refused`);
    assert.deepEqual(new Uint8Array(memory.buffer).slice(ARENA, L.hi), before, `${name}: memory written`);
  }
  // (the descriptor: misaligned, at 0, inside the arena)
  u32.set(L.words, BASE / 4);
  assert.equal(ex.nd_potrf(BASE + 2), 0, "the descriptor misaligned");
  assert.equal(ex.nd_potrf(0), 0, "the descriptor at 0");
  u32.set(L.words, L.hi / 4 - 16);
  assert.equal(ex.nd_potrf(L.hi - 64), 0, "the descriptor in the arena");
  assert.deepEqual(new Uint8Array(memory.buffer).slice(ARENA, L.hi - 64), before.slice(0, L.hi - 64 - ARENA), "memory written");
  // (the control: the good layout factors)
  u32.set(L.words, BASE / 4);
  assert.equal(ex.nd_potrf(BASE), 1);
  assert.equal(u32[L.report / 4], 1);
});

test("nd_potrf and nd_solve refuse a descriptor that runs past memory's end before reading it: no trap, nothing written (grader P15 on #655)", () => {
  const { memory, ex } = instance(Math.ceil((ARENA + 4096) / PAGE) + 1);
  const end = memory.buffer.byteLength;
  // (a good layout's words just below the end, so that only the descriptor's place is wrong)
  const u32 = new Uint32Array(memory.buffer);
  u32.set(layout(4).words, end / 4 - 8);
  // (the host's part of memory, from the module's floor: below it, its own stack, which every call uses)
  const floor = ex.nd_info(1);
  const host = () => Buffer.from(new Uint8Array(memory.buffer, floor));
  const before = host();
  for (const desc of [end - 16, end - 4, end, end + 4096, 0xfffffffc])
    for (const [name, f] of [["nd_potrf", ex.nd_potrf], ["nd_solve", ex.nd_solve]] as const) {
      assert.equal(f(desc), 0, `${name}(${desc}): not refused`);
      assert.ok(host().equals(before), `${name}(${desc}): memory written`);
    }
});

test("each export that reads a descriptor checks its region (desc_region_of) before the read, in the source (grader P15 on #655: the compiled module moves the read after check_potrf's own check, so a runtime test can't see the order)", () => {
  const src = readFileSync(join(root, "engine", "nd", "src", "wasm.rs"), "utf8");
  const fns = [...src.matchAll(/pub unsafe extern "C" fn (nd_[a-z_]+)\(desc: u32[^)]*\) -> u32 \{([\s\S]*?)\n\}/g)];
  assert.deepEqual(fns.map((m) => m[1]).sort(), ["nd_gemm_part", "nd_potrf", "nd_solve"], "the exports scanned");
  for (const [, name, body] of fns) {
    const check = body.indexOf("desc_region"), read = body.indexOf("with_exposed_provenance::<[u32;");
    assert.ok(read > 0, `${name}: no descriptor read found`);
    assert.ok(check > 0 && check < read, `${name}: the descriptor is read before its region is checked`);
  }
});
