import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The committed numerics-core module's solve entry, nd_solve (engine/nd; numerics-core P2b-2): X = A \ B on one
// thread, exactly as shipped: the structure pass, then the diagonal, triangular, Cholesky or LU path, and rcond
// from the factors. Its bits are the native scalar kernel family's (engine/nd/src/lu.rs SOLVE_FNV for LU,
// solve.rs PATHS_FNV for the triangular and Cholesky paths, X and rcond); its status and structure codes; and
// every boundary refusal (each pair of the five regions overlapping, alignment, the work's length, the
// descriptor and the caller's stack placement), each leaving memory untouched.
const root = join(__dirname, "..", "..");
const bytes = readFileSync(join(root, "wasm", "sagebrush-nd.wasm"));
const PAGE = 65536;
const BASE = 8 << 20, STACK = 1 << 20, ARENA = 16 << 20;
// (engine/nd/src/lu.rs tests::SOLVE_FNV: the seeded 120 x 120 system, 3 right-hand sides, no-FMA family)
const SOLVE_FNV = 0xd44c10badbe88400n;
// (engine/nd/src/solve.rs tests::PATHS_FNV: upper, lower and SPD 120 x 120 systems, 3 right-hand sides, X and rcond)
const PATHS_FNV = 0xb95a3f8a53a7c959n;
// the report: [status, column, kernel name address, length, structure, rcond low word, rcond high word]
const REPORT_WORDS = 7;

type Exports = { __stack_pointer: WebAssembly.Global; nd_solve(desc: number): number; nd_info(what: number): number };

function instance(pages: number) {
  const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports as unknown as Exports;
  return { memory, ex };
}
const SCRATCH_LEN = instance(256).ex.nd_info(0);
// engine/nd/src/solve.rs solve_work_len(n, r) = n * n + max(getrf n * n, getrs n * r, potrf n * n, potrs n * n + 2 n r,
// 2 n) (+ scratch_len) = 2 n^2 + 2 n r + scratch_len
const workLen = (n: number, r: number) => 2 * n * n + 2 * n * r + SCRATCH_LEN;
const rcondAt = (u32: Uint32Array, report: number) => new Float64Array(new Uint32Array([u32[report / 4 + 5], u32[report / 4 + 6]]).buffer)[0];

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
  for (const x of new Uint8Array(c.buffer, c.byteOffset, c.byteLength)) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

// a solve's layout in the arena: A (lda), B (ldb), ipiv (4-byte usizes on wasm32), work, report; slack after
function layout(n: number, r: number, lda = n, ldb = n, slack = 0) {
  const a = ARENA, b = a + 8 * (lda * Math.max(n - 1, 0) + n) + 8;
  const ipiv = b + 8 * (ldb * Math.max(r - 1, 0) + n) + 8;
  const work = Math.ceil((ipiv + 4 * n + 8) / 8) * 8;
  const report = work + 8 * workLen(n, r);
  const hi = report + 4 * REPORT_WORDS + slack;
  const words = [a, b, ipiv, work, report, n, r, lda, ldb, workLen(n, r), ARENA, hi];
  return { a, b, ipiv, work, report, hi, words, n, r, lda, ldb };
}

test("nd_solve: the seeded 120 x 120 system with 3 right-hand sides gives the native scalar family's bits, solved", () => {
  const [n, r] = [120, 3];
  const L = layout(n, r);
  const { memory, ex } = instance(Math.ceil(L.hi / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer), u8 = new Uint8Array(memory.buffer);
  const A = seeded(n * n, { s: 2027 }), B = seeded(n * r, { s: 2028 });
  f64.set(A, L.a / 8);
  f64.set(B, L.b / 8);
  u32.set(L.words, BASE / 4);
  assert.equal(ex.nd_solve(BASE), 1);
  const rep = u32.slice(L.report / 4, L.report / 4 + REPORT_WORDS);
  assert.equal(rep[0], 1, "status: solved");
  assert.equal(rep[4], 0, "structure: general (LU)");
  const rc = rcondAt(u32, L.report);
  assert.ok(rc > 0 && rc <= 1, `rcond ${rc}`);
  assert.equal(new TextDecoder().decode(u8.slice(rep[2], rep[2] + rep[3])), "wasm-simd128-4x4");
  const X = f64.slice(L.b / 8, L.b / 8 + n * r);
  assert.equal(fnv(X), SOLVE_FNV, `X's bits: 0x${fnv(X).toString(16)}`);
  // and the oracle: eta <= 10 n u for each column
  for (let j = 0; j < r; j++) {
    let an = 0, res = 0, xn = 0, bn = 0;
    for (let i = 0; i < n; i++) {
      let row = 0, ax = 0;
      for (let p = 0; p < n; p++) { row += Math.abs(A[i + p * n]); ax += A[i + p * n] * X[p + j * n]; }
      an = Math.max(an, row);
      res = Math.max(res, Math.abs(B[i + j * n] - ax));
      xn = Math.max(xn, Math.abs(X[i + j * n]));
      bn = Math.max(bn, Math.abs(B[i + j * n]));
    }
    assert.ok(res / (an * xn + bn) <= 10 * n * 1.1102230246251565e-16);
  }
});

test("nd_solve: leading dimensions above n give the same bits; a zero pivot reports its column; an Inf or NaN computes nothing", () => {
  const [n, r] = [40, 2];
  const dense = layout(n, r), view = layout(n, r, n + 3, n + 5);
  const { memory, ex } = instance(Math.ceil(Math.max(dense.hi, view.hi) / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
  const A = seeded(n * n, { s: 5 }), B = seeded(n * r, { s: 6 });
  const solveIn = (L: ReturnType<typeof layout>, a: Float64Array, b: Float64Array) => {
    f64.fill(Number.NaN, L.a / 8, L.hi / 8);
    for (let j = 0; j < n; j++) f64.set(a.subarray(j * n, (j + 1) * n), L.a / 8 + j * L.lda);
    for (let j = 0; j < r; j++) f64.set(b.subarray(j * n, (j + 1) * n), L.b / 8 + j * L.ldb);
    u32.set(L.words, BASE / 4);
    assert.equal(ex.nd_solve(BASE), 1);
    const x = new Float64Array(n * r);
    for (let j = 0; j < r; j++) x.set(f64.subarray(L.b / 8 + j * L.ldb, L.b / 8 + j * L.ldb + n), j * n);
    return { x, status: u32[L.report / 4], col: u32[L.report / 4 + 1] };
  };
  const d = solveIn(dense, A, B), v = solveIn(view, A, B);
  assert.equal(d.status, 1);
  assert.ok(d.x.every((x, i) => Object.is(x, v.x[i])), "a view changed the bits");
  // (a zero column 7: the first zero pivot is column 7; X has Inf or NaN)
  const Z = A.slice();
  Z.fill(0, 7 * n, 8 * n);
  const z = solveIn(dense, Z, B);
  assert.equal(z.status, 2);
  assert.equal(z.col, 7);
  assert.ok(z.x.some((x) => !Number.isFinite(x)));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const Bb = B.slice();
    Bb[3] = bad;
    assert.equal(solveIn(dense, A, Bb).status, 3);
    const Ab = A.slice();
    Ab[11] = bad;
    assert.equal(solveIn(dense, Ab, B).status, 3);
  }
});

test("nd_solve: the triangular and Cholesky paths give the native scalar family's bits and rcond; each structure and status code", () => {
  const [n, r] = [120, 3];
  const L = layout(n, r);
  const { memory, ex } = instance(Math.ceil(L.hi / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
  const run = (A: Float64Array, B: Float64Array, nn = n, rr = r) => {
    const M = nn === n && rr === r ? L : layout(nn, rr);
    f64.set(A, M.a / 8);
    f64.set(B, M.b / 8);
    u32.set(M.words, BASE / 4);
    assert.equal(ex.nd_solve(BASE), 1);
    return { x: f64.slice(M.b / 8, M.b / 8 + nn * rr), status: u32[M.report / 4], structure: u32[M.report / 4 + 4], rcond: rcondAt(u32, M.report) };
  };
  // (solve.rs tests: upper_of, transpose and chol.rs spd, in the same arithmetic order)
  const g = seeded(n * n, { s: 2031 }), B = seeded(n * r, { s: 2032 });
  const up = g.slice();
  for (let j = 0; j < n; j++) {
    for (let i = j + 1; i < n; i++) up[i + j * n] = 0;
    up[j + j * n] += 4;
  }
  const low = new Float64Array(n * n).map((_, k) => up[Math.floor(k / n) + (k % n) * n]);
  const m = seeded(n * n, { s: 2034 }), spd = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += m[k + i * n] * m[k + j * n];
      spd[i + j * n] = s + (i === j ? n : 0);
    }
  }
  const all: number[] = [];
  for (const [A, code] of [[up, 2], [low, 3], [spd, 4]] as const) {
    const o = run(A, B);
    assert.equal(o.structure, code, "structure code");
    assert.equal(o.status, 1);
    all.push(...o.x, o.rcond);
  }
  const h = fnv(Float64Array.from(all));
  assert.equal(h, PATHS_FNV, `X and rcond bits: 0x${h.toString(16)}`);
  // diagonal (1), and its singular case: [1 0; 0 0] \ [1; 1] = [1; Inf], status 2 at column 1, rcond 0
  let o = run(Float64Array.from([1, 0, 0, 0]), Float64Array.from([1, 1]), 2, 1);
  assert.deepEqual([o.structure, o.status, o.x[0], o.x[1], o.rcond], [1, 2, 1, Infinity, 0]);
  // symmetric with a positive diagonal but indefinite: Cholesky fails, LU (5)
  o = run(Float64Array.from([1, 2, 2, 1]), Float64Array.from([1, 1]), 2, 1);
  assert.deepEqual([o.structure, o.status], [5, 1]);
  // nearly singular (4): [1 1; 1/2 1/2 + d], rcond about d / 3 just below eps
  const d = 0.5 + 3 * 2.220446049250313e-16 * 0.9 - 0.5;
  o = run(Float64Array.from([1, 0.5, 1, 0.5 + d]), Float64Array.from([1, 1]), 2, 1);
  assert.deepEqual([o.structure, o.status], [0, 4]);
  assert.ok(o.rcond > 0 && o.rcond < 2.220446049250313e-16, `rcond ${o.rcond}`);
  // not computed (3): rcond NaN
  o = run(Float64Array.from([1, 0, 0, Number.NaN]), Float64Array.from([1, 1]), 2, 1);
  assert.ok(o.status === 3 && Number.isNaN(o.rcond));
});

test("nd_solve: the smallest systems, n = 0 and 1, with 0, 1, 3 or 17 right-hand sides and dense or padded ldb (astra ND-S1, grader T1)", () => {
  const { memory, ex } = instance(Math.ceil((ARENA + (4 << 20)) / PAGE) + 1);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer), u8 = new Uint8Array(memory.buffer);
  const floor = ex.nd_info(1);
  for (const n of [0, 1]) {
    for (const r of [0, 1, 3, 17]) {
      for (const ldb of [Math.max(n, 1), n + 4]) {
        const bspan = n === 0 || r === 0 ? 0 : ldb * (r - 1) + n;
        const a = ARENA, b = ARENA + 64, ipiv = b + 8 * bspan + 64, work = Math.ceil((ipiv + 64) / 8) * 8, report = work + 8 * workLen(n, r), hi = report + 4 * REPORT_WORDS + 64;
        f64.fill(6, b / 8, b / 8 + bspan);
        if (n === 1) f64[a / 8] = 2;
        u32.fill(0xdead, report / 4, report / 4 + REPORT_WORDS);
        const words = [a, b, ipiv, work, report, n, r, Math.max(n, 1), ldb, workLen(n, r), ARENA, hi];
        // (refused first: the work one element short; nothing written)
        u32.set(words.map((x, i) => (i === 9 ? x - 1 : x)), BASE / 4);
        let before = u8.slice(floor, hi);
        assert.equal(ex.nd_solve(BASE), 0, `n=${n} r=${r} ldb=${ldb}: short work not refused`);
        assert.ok(u8.subarray(floor, hi).every((x, i) => x === before[i]), "a refused call wrote");
        u32.set(words, BASE / 4);
        before = u8.slice(floor, hi);
        assert.equal(ex.nd_solve(BASE), 1, `n=${n} r=${r} ldb=${ldb}`);
        assert.equal(u32[report / 4], 1, "status: solved");
        if (n === 0) {
          assert.ok(u8.subarray(floor, hi).every((x, i) => x === before[i] || (floor + i >= report && floor + i < report + 4 * REPORT_WORDS)), "n = 0 wrote outside the report");
        } else {
          for (let j = 0; j < r; j++) {
            assert.equal(f64[b / 8 + j * ldb], 3, "x = b / a");
            for (let i = 1; i < ldb && j * ldb + i < bspan; i++) assert.equal(f64[b / 8 + j * ldb + i], 6, "padding written");
          }
        }
      }
    }
  }
});

test("nd_solve refuses every bad layout before writing anything: each region pair, alignment, the work's length, the descriptor and the stack", () => {
  const [n, r] = [12, 2];
  const L = layout(n, r, n, n, 2 * STACK);
  const pages = Math.ceil(L.hi / PAGE) + 1;
  const { memory, ex } = instance(pages);
  const f64 = new Float64Array(memory.buffer), u32 = new Uint32Array(memory.buffer), u8 = new Uint8Array(memory.buffer);
  const floor = ex.nd_info(1);
  f64.set(seeded(n * n, { s: 1 }), L.a / 8);
  f64.set(seeded(n * r, { s: 2 }), L.b / 8);
  u32.fill(0xdead, L.report / 4, L.report / 4 + REPORT_WORDS);
  const put = (at: number, d: number[]) => u8.set(new Uint8Array(new Uint32Array(d.map((x) => x >>> 0)).buffer), at);
  const refused = (name: string, d: number[], descAt = BASE, frame?: [number, number]) => {
    put(descAt, d);
    const before = u8.slice(floor, L.hi);
    assert.equal(ex.nd_solve(descAt), 0, `${name}: not refused`);
    const now = u8.subarray(floor, L.hi);
    assert.ok(now.every((x, i) => x === before[i] || (frame !== undefined && floor + i >= frame[0] && floor + i < frame[1])), `${name}: memory was written`);
  };
  const g = L.words;
  const with_ = (i: number, v: number) => g.map((x, j) => (j === i ? v : x));
  // (each of the 10 pairs of the five regions: region i placed at region j's start)
  const names = ["A", "B", "ipiv", "work", "report"];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) refused(`${names[i]} on ${names[j]}`, with_(i, g[j]));
  // (alignment: the f64 regions 8, ipiv 4, the report 4)
  refused("A misaligned", with_(0, g[0] + 4));
  refused("B misaligned", with_(1, g[1] + 4));
  refused("work misaligned", with_(3, g[3] + 4));
  refused("ipiv misaligned", with_(2, g[2] + 2));
  refused("report misaligned", with_(4, g[4] + 2));
  // (the work: one element short; layouts; overflow)
  refused("work one element short", with_(9, g[9] - 1));
  refused("lda < n", with_(7, n - 1));
  refused("ldb < n", with_(8, n - 1));
  refused("n overflowing", with_(5, 0xffffffff));
  refused("a region at 0", with_(4, 0));
  refused("a region below the floor", with_(4, 64));
  // (the arena, the descriptor, the caller's stack)
  refused("the report outside the arena", with_(11, g[4] + 8));
  // (grader T3: B, ipiv or work alone outside the arena, past its end)
  for (const [i, what] of [[1, "B"], [2, "ipiv"], [3, "work"]] as const) refused(`${what} outside the arena`, with_(i, L.hi + 64));
  refused("the descriptor in the arena", g, L.hi - 64);
  refused("a misaligned descriptor", g, BASE + 1024 + 2);
  const sp = ex.__stack_pointer.value;
  ex.__stack_pointer.value = L.hi - STACK;
  refused("the caller's stack in the arena", g, BASE, [L.hi - STACK - PAGE, L.hi - STACK]);
  ex.__stack_pointer.value = sp;
  // (the control: exactly the needed work, at the good layout, runs)
  put(BASE, g);
  assert.equal(ex.nd_solve(BASE), 1);
  assert.equal(u32[L.report / 4], 1);
});
