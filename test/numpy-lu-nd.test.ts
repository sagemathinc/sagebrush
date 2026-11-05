import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// np.linalg.solve, det, slogdet and inv on engine/nd's LU (nd_solve's gesv mode, src/runtime/nd.ts ndLu): where
// the module runs, from n = 256, the public calls give the module's bits (engine/nd/src/lu.rs
// SOLVE_FNV, the no-FMA family: Wasm SIMD128); below those sizes, where it can't run (SAGEBRUSH_NO_WASM here) and
// for an A or B with an Inf or NaN (which the module doesn't compute), the older LU runs, as before. Both meet the
// oracle and give NumPy's errors.
const CLI = join(__dirname, "..", "src", "cli.js");
// (engine/nd/src/lu.rs tests::SOLVE_FNV: the seeded 120 x 120 system, 3 right-hand sides, no-FMA family)
const SOLVE_FNV = 0xd44c10badbe88400n;
const U = 1.1102230246251565e-16;

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

const run = (code: string, env: Record<string, string> = {}, cwd?: string) =>
  execFileSync(process.execPath, [CLI, "-c", code], { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim().split("\n");

// a seeded column-major n x n A and n x 3 B (at n = 120, those of nd-solve-wasm.test.ts), through the public calls
// in a fresh process: X = solve(A, B) column-major, inv(A), solve(A, I), slogdet(A) and det(A), and _kernels()
const N = 256;
function seededCalls(env: Record<string, string> = {}, n = N) {
  const d = mkdtempSync(join(tmpdir(), "sb-lu-"));
  try {
    const r = 3;
    writeFileSync(join(d, "a.bin"), seeded(n * n, { s: 2027 }));
    writeFileSync(join(d, "b.bin"), seeded(n * r, { s: 2028 }));
    const out = run([
      "import numpy as np, json",
      // (the files are column-major: A[i, j] is element i + j n)
      `A = np.frombuffer(open('a.bin', 'rb').read(), dtype=np.float64).reshape(${n}, ${n}).T`,
      `B = np.frombuffer(open('b.bin', 'rb').read(), dtype=np.float64).reshape(${r}, ${n}).T`,
      "open('x.bin', 'wb').write(np.linalg.solve(A, B).T.tobytes())",
      "Ai = np.linalg.inv(A)",
      `print(Ai.tobytes() == np.linalg.solve(A, np.eye(${n})).tobytes(), np.abs(A @ Ai - np.eye(${n})).max() / (np.abs(A).sum(1).max() * np.abs(Ai).sum(1).max()) <= 10 * ${n} * ${U})`,
      "s, l = np.linalg.slogdet(A)",
      "print(json.dumps([float(s), float(l), float(np.linalg.det(A))]))",
      "print(json.dumps(np.linalg._kernels()))",
    ].join("\n"), env, d);
    const X = new Float64Array(new Uint8Array(readFileSync(join(d, "x.bin"))).buffer);
    return { inv: out[0], det: JSON.parse(out[1]), kernels: JSON.parse(out[2]), X };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// the normwise backward error of each column of the column-major X for the seeded system
function eta(X: Float64Array, n = N): number {
  const r = 3, A = seeded(n * n, { s: 2027 }), B = seeded(n * r, { s: 2028 });
  let worst = 0;
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
    worst = Math.max(worst, res / (an * xn + bn));
  }
  return worst;
}

// X = A \\ B by the loader itself (src/runtime/nd.ts ndLu) for the seeded system, column-major, in this process
function loaderX(n: number): Float64Array {
  const nd = require("../src/runtime/nd");
  assert.ok(nd.useNd(), "engine/nd doesn't run here");
  const r = 3, Ac = seeded(n * n, { s: 2027 }), Bc = seeded(n * r, { s: 2028 });
  // (ndLu takes row-major A and B: the transposes of the column-major seeds)
  const A = new Float64Array(n * n), B = new Float64Array(n * r);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i * n + j] = Ac[i + j * n];
  for (let i = 0; i < n; i++) for (let j = 0; j < r; j++) B[i * r + j] = Bc[i + j * n];
  const x = nd.ndLu(A, n, B, r).x, X = new Float64Array(n * r);
  for (let i = 0; i < n; i++) for (let j = 0; j < r; j++) X[i + j * n] = x[i * r + j];
  return X;
}

test("the loader gives the module's bits: ndLu on the seeded 120 x 120 system is lu.rs SOLVE_FNV", () => {
  const X = loaderX(120);
  assert.equal(fnv(X), SOLVE_FNV, `X's bits: 0x${fnv(X).toString(16)}`);
  assert.ok(eta(X, 120) <= 10 * 120 * U);
});

test("np.linalg.solve from n = 256 on engine/nd: the loader's bits, the oracle; inv is solve(A, I)'s bits; _kernels() says so", () => {
  const { X, inv, det, kernels } = seededCalls();
  assert.equal(fnv(X), fnv(loaderX(N)), "the public solve's bits differ from the loader's");
  assert.ok(eta(X) <= 10 * N * U);
  assert.equal(inv, "True True");
  const k = (from_n: number) => ({ path: "engine/nd", kernel: "wasm-simd128-4x4", why: "", from_n });
  assert.deepEqual(kernels, { cholesky: k(48), solve: k(256), det: k(256), slogdet: k(256), inv: k(256) });
  // det is slogdet's sign times exp of its log (NumPy's own formula), and agrees with the older LU's
  const ts = seededCalls({ SAGEBRUSH_NO_WASM: "1" }).det;
  assert.equal(Math.abs(det[0]), 1);
  assert.equal(det[0], ts[0]);
  assert.ok(Math.abs(det[1] - ts[1]) <= 1e-12 * Math.abs(ts[1]), `logabsdet ${det[1]} vs ${ts[1]}`);
  assert.ok(Math.abs(det[2] - ts[2]) <= 1e-11 * Math.abs(ts[2]), `det ${det[2]} vs ${ts[2]}`);
});

test("without WebAssembly: the older LU, within the oracle, and _kernels() saying why", () => {
  const { X, inv, kernels } = seededCalls({ SAGEBRUSH_NO_WASM: "1" });
  assert.ok(eta(X) <= 10 * N * U);
  assert.equal(inv, "True True");
  assert.deepEqual(kernels.solve, { path: "typescript", kernel: "", why: "WebAssembly is off here", from_n: 256 });
  assert.deepEqual(kernels.inv, { path: "typescript", kernel: "", why: "WebAssembly is off here", from_n: 256 });
});

test("both paths: a singular matrix is NumPy's LinAlgError for solve and inv, det 0 and slogdet (0, -inf); P's sign", () => {
  const code = [
    "import numpy as np",
    "for M in (np.ones((256, 256)), np.diag(np.arange(256.0)), np.vstack([np.eye(260)[:259], np.eye(260)[:1]])):",
    "    for f in (np.linalg.inv, lambda M: np.linalg.solve(M, np.ones(len(M))), lambda M: np.linalg.solve(M, np.ones((len(M), 2)))):",
    "        try:",
    "            f(M)",
    "            print('solved')",
    "        except np.linalg.LinAlgError as e:",
    "            print('LinAlgError:', e)",
    "    print(np.linalg.det(M), tuple(map(float, np.linalg.slogdet(M))))",
    // (the reversal of n rows is floor(n / 2) interchanges)
    "print([float(np.linalg.det(np.eye(n)[::-1] * 2)) for n in (256, 257, 258, 259)])",
    "print([float(np.linalg.slogdet(np.eye(n)[::-1])[0]) for n in (256, 257, 258, 259)])",
    "print(np.linalg.inv(np.eye(256)[::-1]).tobytes() == np.eye(256)[::-1].tobytes(), np.linalg.solve(np.eye(260)[::-1] * 4, np.arange(260.0)).tolist() == (np.arange(260.0)[::-1] / 4).tolist())",
  ].join("\n");
  const singular = [...Array(3).fill("LinAlgError: Singular matrix"), "0.0 (0.0, -inf)"];
  const want = [...singular, ...singular, ...singular,
    // (NumPy 2.5.1's own values: det is sign * exp(sum of log|u_ii|), so not the exact power of two)
    "[1.15792089237355e+77, 2.3158417847471045e+77, -4.631683569494217e+77, -9.26336713898845e+77]",
    "[1.0, 1.0, -1.0, -1.0]", "True True"];
  for (const env of [{}, { SAGEBRUSH_NO_WASM: "1" }] as Record<string, string>[]) assert.deepEqual(run(code, env), want, JSON.stringify(env));
});

test("an Inf or NaN in A or B: the module computes nothing, so the older LU runs (NumPy's NaNs), in the engine/nd session", () => {
  const code = [
    "import numpy as np",
    "rng = np.random.default_rng(8)",
    "A = rng.standard_normal((260, 260)) + 260 * np.eye(260); b = rng.standard_normal(260)",
    "An = A.copy(); An[3, 4] = np.nan; Ai = A.copy(); Ai[5, 5] = np.inf; bn = b.copy(); bn[7] = np.nan",
    "print(bool(np.isnan(np.linalg.det(An))), bool(np.isnan(np.linalg.slogdet(An)[1])), bool(np.isnan(np.linalg.solve(An, b)).all()), bool(np.isnan(np.linalg.inv(An)).any()))",
    "print(bool(np.isnan(np.linalg.solve(A, bn)).any()), bool(np.isnan(np.linalg.inv(Ai)).any()))",
    "print(np.linalg._kernels()['solve']['path'], bool(np.isfinite(np.linalg.solve(A, b)).all()))",
  ].join("\n");
  // (NumPy 2.5.1 gives the same: an Inf on the diagonal inverts without a NaN)
  assert.deepEqual(run(code), ["True True True True", "True False", "engine/nd True"]);
});

test("below n = 256 the older LU runs, without loading the module: a session of smaller matrices stays undecided", () => {
  const code = [
    "import numpy as np",
    "rng = np.random.default_rng(5)",
    "for n in (1, 2, 12, 32, 64, 255):",
    "    M = rng.standard_normal((n, n)) + n * np.eye(n); np.linalg.solve(M, np.ones(n)); np.linalg.det(M); np.linalg.slogdet(M); np.linalg.inv(M)",
    "print(np.linalg._kernels()['solve']['path'])",
  ].join("\n");
  assert.deepEqual(run(code), ["undecided"]);
  const at = (call: string) => run(`import numpy as np\nM = np.random.default_rng(2).standard_normal((N, N)) + 64 * np.eye(N)\n${call}\nprint(np.linalg._kernels()['solve']['path'])`.replace(/N/g, "256"))[0];
  for (const call of ["np.linalg.solve(M, np.ones(len(M)))", "np.linalg.det(M)", "np.linalg.slogdet(M)", "np.linalg.inv(M)"]) assert.equal(at(call), "engine/nd", call);
});

test("a non-contiguous view or an integer matrix gives its contiguous float64 copy's bits", () => {
  const code = [
    "import numpy as np",
    "A = np.random.default_rng(9).standard_normal((260, 260)) + 260 * np.eye(260); b = np.arange(260.0)",
    "V = A[::-1, ::-1].T; C = np.ascontiguousarray(V)",
    "print(V.flags['C_CONTIGUOUS'], np.linalg.solve(V, b).tobytes() == np.linalg.solve(C, b).tobytes(), np.linalg.inv(V).tobytes() == np.linalg.inv(C).tobytes(), np.linalg.det(V) == np.linalg.det(C))",
    "I = (np.arange(67600).reshape(260, 260) % 7) + 300 * np.eye(260, dtype=np.int64)",
    "print(np.linalg.solve(I, b).tobytes() == np.linalg.solve(I.astype(float), b).tobytes(), np.linalg.det(I) == np.linalg.det(I.astype(float)))",
    "print(np.linalg._kernels()['solve']['path'])",
  ].join("\n");
  assert.deepEqual(run(code), ["False True True True", "True True", "engine/nd"]);
});

test("a module memory that can't grow is a MemoryError with its message, and the session goes on", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const Obj = require("../src/runtime/object");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  const proto = WebAssembly.Memory.prototype as any, grow = proto.grow;
  try {
    await s.handle({ id: 1, code: "import numpy as np\nnp.linalg.solve(np.eye(256) * 2, np.ones(256))\nB = np.eye(700) * 2.0" });
    proto.grow = () => {
      throw new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded");
    };
    await s.handle({ id: 2, code: "R = []\nfor f in (np.linalg.inv, np.linalg.det, lambda M: np.linalg.solve(M, np.ones(700))):\n    try:\n        f(B)\n        R.append('ran')\n    except MemoryError as e:\n        R.append(str(e))" });
  } finally {
    proto.grow = grow;
  }
  await s.handle({ id: 3, code: "OK = float(np.linalg.inv(B)[0, 0])" });
  const main = Obj.getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const v = (name: string) => Obj.callObj(Obj.getattr(main, "__getitem__"), [name]);
  assert.deepEqual(require("../src/runtime").R.toArray(v("R")), ["inv", "det", "solve"].map((w) => `${w} of a 700 x 700 matrix needs more working memory than WebAssembly can have here`));
  assert.equal(v("OK"), 0.5);
});

test("the backend functions refuse a non-square matrix before admitting or loading anything (a fresh session stays undecided)", () => {
  const code = [
    "import numpy as np, _nplinalg as _L",
    "for f in (_L.det, _L.inv, lambda x: _L.solve(x, np.ones((len(x), 1)))):",
    "    for x in (np.zeros((1024, 1)), np.zeros((1, 1024)), np.zeros((1024, 1000))):",
    "        try:",
    "            f(x)",
    "            print('ran')",
    "        except np.linalg.LinAlgError as e:",
    "            print(e)",
    "print(np.linalg._kernels()['solve']['path'])",
  ].join("\n");
  assert.deepEqual(run(code), [...Array(9).fill("Last 2 dimensions of the array must be square"), "undecided"]);
});

test("each engine/nd call admits its exact work, the module's scratch and solve's B included: refused one byte under, run at it (grader L12)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const Obj = require("../src/runtime/object");
  const np = require("../src/runtime/numpy");
  const nd = require("../src/runtime/nd");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  const n = N;
  await s.handle({ id: 1, code: `import numpy as np, _nplinalg as L\nA = np.random.default_rng(3).standard_normal((${n}, ${n})) + ${n} * np.eye(${n})\nb = np.ones(${n}); B = np.ones((${n}, 3))\nL.det(A)` });
  assert.equal(nd.ndPath().path, "engine/nd");
  const main = Obj.getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const g = (name: string) => Obj.callObj(Obj.getattr(main, "__getitem__"), [name]);
  const call = (fname: string, args: any[]) => () => Obj.callObj(Obj.getattr(g("L"), fname), args);
  const sc = nd.ndScratch(), nn = n * n;
  // (each one's admission in float64s, as numpy_linalg.ts states it: the older LU's figure plus engine/nd's terms)
  const CASES: [string, () => any, number][] = [
    ["solve vector", call("solve", [g("A"), g("b")]), 5 * nn + 6 * n + sc + n],
    ["solve matrix", call("solve", [g("A"), g("B")]), 5 * nn + 6 * 3 * n + sc + 3 * n],
    ["det", call("det", [g("A")]), 5 * nn + sc],
    ["slogdet", call("slogdet", [g("A")]), 5 * nn + sc],
    ["inv", call("inv", [g("A")]), 10 * nn + sc],
  ];
  const saved = np.ARRAY_LIMITS.bytes;
  try {
    for (const [name, f, units] of CASES) {
      np.ARRAY_LIMITS.bytes = 8 * units - 1;
      assert.throws(f, (e: any) => Obj.isinstance(e, Obj.T.MemoryError), `${name}: not refused one byte under its ${8 * units}`);
      np.ARRAY_LIMITS.bytes = 8 * units;
      f();
    }
  } finally {
    np.ARRAY_LIMITS.bytes = saved;
  }
});
