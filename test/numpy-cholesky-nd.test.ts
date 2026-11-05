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
  assert.deepEqual(kernels, { path: "engine/nd", kernel: "wasm-simd128-4x4", why: "" });
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
  assert.deepEqual(kernels, { path: "typescript", kernel: "", why: "WebAssembly is off here" });
  for (const [n, F] of L) assert.ok(residual(spd(n, 2029), F, n) <= 10 * U, `n=${n}`);
});

test("the path is chosen at the first call and kept: turning WebAssembly off mid-session changes nothing", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const Obj = require("../src/runtime/object");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  const g = globalThis as any, saved = g.__SAGEBRUSH_NO_WASM__;
  try {
    await s.handle({ id: 1, code: "import numpy as np\nP0 = np.linalg._kernels()['cholesky']['path']\nA = np.array([[4.0, 2.0, 0.4], [2.0, 5.0, 1.0], [0.4, 1.0, 3.0]])\nL1 = np.linalg.cholesky(A)\nP1 = np.linalg._kernels()['cholesky']['path']" });
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
