import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// np.linalg.cholesky on engine/nd's blocked Cholesky (CHOL-1 step 2, src/runtime/nd.ts): where the module runs,
// the public call gives the module's bits (engine/nd/src/chol.rs POTRF_FNV, the no-FMA family: Wasm SIMD128);
// where it can't (SAGEBRUSH_NO_WASM here), the TypeScript loop runs. Either path is chosen once, at the first call,
// and kept for the session (@sagebrush's ruling R1), and np.linalg._kernels() says which, and why. Both paths
// meet the oracle and give NumPy's errors, shapes and upper=True.
const CLI = join(__dirname, "..", "src", "cli.js");
const POTRF_FNV = 0x3c1e8bf25e29f991n;
const U = 1.1102230246251565e-16;

function seeded(count: number, state: { s: number }): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    state.s = (Math.imul(state.s, 1103515245) + 12345) >>> 0;
    out[i] = state.s / 4294967296 - 0.5;
  }
  return out;
}

// engine/nd/src/chol.rs tests::spd, in the same arithmetic order: M'M + n I (symmetric, so row-major is the same)
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

// ||A - L L^T||_inf / (n ||A||_inf), row-major
function residual(A: Float64Array, L: Float64Array, n: number): number {
  let num = 0, an = 0;
  for (let i = 0; i < n; i++) {
    let row = 0;
    for (let j = 0; j < n; j++) {
      let t = 0;
      for (let k = 0; k <= Math.min(i, j); k++) t += L[i * n + k] * L[j * n + k];
      num = Math.max(num, Math.abs(A[i * n + j] - t));
      row += Math.abs(A[i * n + j]);
    }
    an = Math.max(an, row);
  }
  return num / (n * an);
}

// the factors of the seeded 120 and 131 SPD matrices through the public call, in a fresh process, with its
// _kernels() report; env adds to the process's environment
function factors(env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "sb-chol-"));
  try {
    const sizes = [120, 131];
    for (const n of sizes) writeFileSync(join(d, `a${n}.bin`), spd(n, 2029));
    const code = [
      "import numpy as np, json",
      `for n in ${JSON.stringify(sizes)}:`,
      "    A = np.frombuffer(open(f'a{n}.bin', 'rb').read(), dtype=np.float64).reshape(n, n)",
      "    open(f'l{n}.bin', 'wb').write(np.linalg.cholesky(A).tobytes())",
      "print(json.dumps(np.linalg._kernels()))",
    ].join("\n");
    const out = execFileSync(process.execPath, [CLI, "-c", code], { cwd: d, encoding: "utf8", env: { ...process.env, ...env } });
    const L = new Map(sizes.map((n) => [n, new Float64Array(new Uint8Array(readFileSync(join(d, `l${n}.bin`))).buffer)]));
    return { kernels: JSON.parse(out.trim()).cholesky, L };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("np.linalg.cholesky on engine/nd: the module's bits (POTRF_FNV, R = L^T), the oracle, and _kernels() saying so", () => {
  const { kernels, L } = factors();
  assert.deepEqual(kernels, { path: "engine/nd", kernel: "wasm-simd128-4x4", why: "", from_n: 48 });
  const r: number[] = [];
  for (const [n, F] of L) {
    // L's strict upper part is 0; R's upper triangle, column by column, is L's lower one, row by row
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(Object.is(F[i * n + j], 0), `L[${i},${j}]`);
    for (let j = 0; j < n; j++) for (let i = 0; i <= j; i++) r.push(F[j * n + i]);
    assert.ok(residual(spd(n, 2029), F, n) <= 10 * U, `n=${n}`);
  }
  const h = fnv(new Float64Array(r));
  assert.equal(h, POTRF_FNV, `R's bits: 0x${h.toString(16)}`);
});

test("np.linalg.cholesky without WebAssembly: the TypeScript loop, within the oracle, and _kernels() saying why", () => {
  const { kernels, L } = factors({ SAGEBRUSH_NO_WASM: "1" });
  assert.deepEqual(kernels, { path: "typescript", kernel: "", why: "WebAssembly is off here", from_n: 48 });
  for (const [n, F] of L) assert.ok(residual(spd(n, 2029), F, n) <= 10 * U, `n=${n}`);
});

test("the path is chosen at the first call and kept: turning WebAssembly off mid-session changes nothing", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const Obj = require("../src/runtime/object");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  const g = globalThis as any, saved = g.__SAGEBRUSH_NO_WASM__;
  try {
    await s.handle({ id: 1, code: "import numpy as np\nP0 = np.linalg._kernels()['cholesky']['path']\nM = np.random.default_rng(3).standard_normal((60, 60))\nA = M @ M.T + 60 * np.eye(60)\nL1 = np.linalg.cholesky(A)\nP1 = np.linalg._kernels()['cholesky']['path']" });
    g.__SAGEBRUSH_NO_WASM__ = true;
    await s.handle({ id: 2, code: "L2 = np.linalg.cholesky(A)\nP2 = np.linalg._kernels()['cholesky']['path']\nSAME = L2.tobytes() == L1.tobytes()" });
  } finally {
    g.__SAGEBRUSH_NO_WASM__ = saved;
  }
  const main = Obj.getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const v = (name: string) => Obj.callObj(Obj.getattr(main, "__getitem__"), [name]);
  assert.deepEqual([v("P0"), v("P1"), v("P2"), v("SAME")], ["undecided", "engine/nd", "engine/nd", true]);
});

test("both paths: NumPy's error for a matrix that isn't positive definite, empty matrices, stacks and upper=True", () => {
  const code = [
    "import numpy as np",
    // (not [[nan]]: NumPy factors it, and Sagebrush has always refused it, on either path: a separate question)
    "for M in ([[1.0, 2.0], [2.0, 1.0]], [[0.0]], [[-1.0]], [[4.0, 1.0, 0.0], [1.0, -3.0, 0.0], [0.0, 0.0, 1.0]]):",
    "    try:",
    "        np.linalg.cholesky(np.array(M))",
    "        print('factored')",
    "    except np.linalg.LinAlgError as e:",
    "        print('LinAlgError:', e)",
    "A = np.array([[4.0, 2.0, 0.4], [2.0, 5.0, 1.0], [0.4, 1.0, 3.0]])",
    "print(np.linalg.cholesky(np.zeros((0, 0))).shape, np.linalg.cholesky(np.stack([A, 2 * A])).shape)",
    "S = np.linalg.cholesky(np.stack([A, 2 * A]))",
    "print(np.abs(S[1] @ S[1].T - 2 * A).max() <= 1e-15 * 10, np.allclose(np.linalg.cholesky(A, upper=True), np.linalg.cholesky(A).T, rtol=0, atol=0))",
    "print(np.linalg.cholesky(np.array([[4.0, 2.0], [2.0, 5.0]])).tolist())",
    "print(np.linalg.cholesky(np.array([[4, 2], [2, 5]])).dtype)",
  ].join("\n");
  const want = [
    "LinAlgError: Matrix is not positive definite",
    "LinAlgError: Matrix is not positive definite",
    "LinAlgError: Matrix is not positive definite",
    "LinAlgError: Matrix is not positive definite",
    "(0, 0) (2, 3, 3)",
    "True True",
    "[[2.0, 0.0], [1.0, 2.0]]",
    "float64",
  ];
  for (const env of [{}, { SAGEBRUSH_NO_WASM: "1" }]) {
    const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.deepEqual(out.trim().split("\n"), want, JSON.stringify(env));
  }
});

test("below n = 48 the TypeScript loop runs, without loading the module: a session of small matrices stays undecided, and gives the loop's bits", () => {
  const code = [
    "import numpy as np",
    "rng = np.random.default_rng(5)",
    "out = []",
    "for n in (1, 2, 8, 16, 47):",
    "    M = rng.standard_normal((n, n)); out.append(np.linalg.cholesky(M @ M.T + n * np.eye(n)).tobytes().hex())",
    "print(np.linalg._kernels()['cholesky']['path'])",
    "print(hash(tuple(out)) % 1000003, len(''.join(out)))",
  ].join("\n");
  const nd = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  const ts = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_NO_WASM: "1" } }).trim().split("\n");
  assert.equal(nd[0], "undecided", "the module was loaded for a small matrix");
  assert.equal(nd[1], ts[1], "a small matrix's bits differ from the loop's");
});

// a fresh process's loader, with globals set as a host would set them, then one cholesky of a 60 x 60 matrix
function loaderIn(setup: string): { path: string; why: string; fetches: number } {
  const js = [
    `const g = globalThis; g.__fetches = 0; ${setup}`,
    `const nd = require(${JSON.stringify(join(__dirname, "..", "src", "runtime", "nd"))});`,
    "nd.useNd();",
    "const p = nd.ndPath();",
    "console.log(JSON.stringify({ path: p.path, why: p.why, fetches: g.__fetches }));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", js], { encoding: "utf8" }).trim());
}

test("a URL with no hash, or a malformed one, is never fetched: the session runs the TypeScript loop, saying why (grader N1b)", () => {
  const stub = "g.__SAGEBRUSH_FETCH_SYNC__ = () => { g.__fetches++; return new Uint8Array(8); };";
  for (const hash of ["", "g.__SAGEBRUSH_ND_SHA256__ = 'abc';", "g.__SAGEBRUSH_ND_SHA256__ = '" + "A".repeat(64) + "';", "g.__SAGEBRUSH_ND_SHA256__ = 42;"]) {
    const r = loaderIn(`g.__SAGEBRUSH_ND_URL__ = "https://example.invalid/sagebrush-nd.wasm"; ${stub} ${hash}`);
    assert.deepEqual(r, { path: "typescript", why: "the numerics module could not be loaded (the numerics module has no SHA-256 to check, so it is not loaded)", fetches: 0 }, hash || "no hash");
  }
  // (the control: a well-formed hash is fetched, once, and refused when the bytes aren't the module's)
  const c = loaderIn(`g.__SAGEBRUSH_ND_URL__ = "https://example.invalid/sagebrush-nd.wasm"; ${stub} g.__SAGEBRUSH_ND_SHA256__ = '${"a".repeat(64)}';`);
  assert.deepEqual(c, { path: "typescript", why: "the numerics module could not be loaded (the numerics module fetched is not the one this page was built with)", fetches: 1 });
});

test("a module memory that can't grow is a MemoryError with its message, and the session goes on (grader N12)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  const proto = WebAssembly.Memory.prototype as any, grow = proto.grow;
  try {
    await s.handle({ id: 1, code: "import numpy as np\nM = np.random.default_rng(4).standard_normal((60, 60))\nnp.linalg.cholesky(M @ M.T + 60 * np.eye(60))\nB = np.eye(700) * 2.0" });
    proto.grow = () => {
      throw new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded");
    };
    await s.handle({ id: 2, code: "try:\n    np.linalg.cholesky(B)\n    R = 'ran'\nexcept MemoryError as e:\n    R = str(e)" });
  } finally {
    proto.grow = grow;
  }
  await s.handle({ id: 3, code: "OK = float(np.linalg.cholesky(B)[0, 0])" });
  const main = require("../src/runtime/object").getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const v = (name: string) => require("../src/runtime/object").callObj(require("../src/runtime/object").getattr(main, "__getitem__"), [name]);
  assert.equal(v("R"), "cholesky of a 700 x 700 matrix needs more working memory than WebAssembly can have here");
  assert.equal(v("OK"), Math.SQRT2);
});

test("the backend function refuses a non-square or non-2-D matrix before admitting or loading anything: no module memory grows (astra ND657-ADMIT-2)", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const Obj = require("../src/runtime/object");
  const nd = require("../src/runtime/nd");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.handle({ id: 1, code: "import numpy as np, _nplinalg as _L\nM = np.random.default_rng(6).standard_normal((60, 60))\n_L.cholesky(M @ M.T + 60 * np.eye(60))" });
  const w0 = nd.ndMemoryBytes();
  await s.handle({ id: 2, code: [
    "R = []",
    "for x in (np.zeros((1024, 1)), np.zeros((1, 1024)), np.zeros(1024), np.zeros((2, 2, 2))):",
    "    try:",
    "        _L.cholesky(x)",
    "        R.append('ran')",
    "    except Exception as e:",
    "        R.append(type(e).__name__ + ': ' + str(e))",
  ].join("\n") });
  const main = Obj.getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const R = Obj.callObj(Obj.getattr(main, "__getitem__"), ["R"]);
  assert.deepEqual(require("../src/runtime").R.toArray(R), [
    "LinAlgError: Last 2 dimensions of the array must be square",
    "LinAlgError: Last 2 dimensions of the array must be square",
    "ValueError: 1-dimensional array given. Array must be two-dimensional",
    "ValueError: 3-dimensional array given. Array must be two-dimensional",
  ]);
  assert.equal(nd.ndMemoryBytes(), w0, "the module's memory grew for a refused matrix");
});
