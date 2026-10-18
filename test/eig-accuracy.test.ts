import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The general eigenproblem: a small subdiagonal splits the matrix only by LAPACK dlahqr's tests
// (Ahues-Tisseur, and the neighbouring entries when both diagonal entries are 0), and the matrix
// is balanced first (dgebal 'B'), as NumPy's eig and MATLAB's eig are.  A companion matrix with
// widely scaled coefficients then keeps its small eigenvalues.
const cli = join(__dirname, "..", "src", "cli.js");

test("eig keeps a small eigenvalue of a widely scaled matrix, at every scale, as NumPy does", () => {
  const out = execFileSync(process.execPath, [cli, "-c", [
    "import numpy as np, math",
    "ok2, ok4 = [], []",
    "for e in range(6, 21):",
    "    s = 10.0 ** e",
    "    x = -2.0 / (s + math.sqrt(s * s - 4))",
    "    w = np.linalg.eigvals(np.array([[-s, -1.0], [1.0, 0.0]]))",
    "    ok2.append(abs(min(w, key=abs) - x) <= 1e-12 * abs(x))",
    "    c = np.convolve([1.0, s, 1.0], [1.0, 3.0, 2.0])",
    "    w = np.linalg.eigvals(np.vstack([-c[1:] / c[0], np.eye(3, 4)]))",
    "    ok4.append(abs(min(w, key=abs) - x) <= 1e-6 * abs(x) and abs(sorted(w.real)[1] + 2) < 1e-9)",
    "print(all(ok2), all(ok4))",
  ].join("\n")], { encoding: "utf8" }).trim();
  assert.equal(out, "True True");
});

test("MATLAB roots and eig: the small root of x^2 + 1e20 x + 1, balance and nobalance differ; Sage's eigenvalues too", () => {
  const out = execFileSync(process.execPath, [cli, "--matlab", "-c", [
    "disp(sprintf('%.17g ', sort(roots([1 1e20 1]))))",
    "c = conv([1 1e20 1], [1 3 2]); r = sort(roots(c)); disp(abs(r(end) + 1e-20) < 1e-26)",
    "c = conv([1 1e16 1], [1 3 2]); C = [-c(2:end) / c(1); eye(3) zeros(3, 1)];",
    "a = min(abs(eig(C))); b = min(abs(eig(C, 'nobalance'))); disp([abs(a - 1e-16) < 1e-22, abs(b - 1e-16) > 1e-20])",
  ].join("\n")], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n").map((s: string) => s.trim()), ["-1e+20 -9.9999999999999995e-21", "1", "1   1"]);
  const sage = execFileSync(process.execPath, [cli, "--sage", "-c", "print(matrix(RDF, [[-1e20, -1], [1, 0]]).eigenvalues())"], { encoding: "utf8" }).trim();
  assert.equal(sage, "[-1e+20, -1e-20]");
});

test("balancing a graded matrix keeps every row's cumulative scale in range: eigenvalues and eigenvectors finite, residual small", () => {
  const out = execFileSync(process.execPath, [cli, "-c", [
    "import numpy as np",
    "res = []",
    "for n, c in [(6, 150), (4, 250), (8, 100), (3, 370)]:",
    "    A = np.array([[2.0 ** (c * (j - i)) + (1.0 if i == j else 0.0) for j in range(n)] for i in range(n)])",
    "    w, v = np.linalg.eig(A)",
    "    r = float(np.max(np.abs(A @ v - v * w))) / float(np.max(np.abs(A)))",
    "    res.append(bool(np.all(np.isfinite(w)) and np.all(np.isfinite(v)) and r < 1e-10))",
    "print(res)",
  ].join("\n")], { encoding: "utf8" }).trim();
  assert.equal(out, "[True, True, True, True]");
});

test("MATLAB eig(A, 'nobalance') solves both the right and the left eigenvector problems unbalanced; the default balances both", () => {
  const out = execFileSync(process.execPath, [cli, "-c", [
    "import numpy as np, _matlab as m",
    "seen = []",
    "orig = np.linalg._eig",
    "def spy(a, balance=True):",
    "    seen.append(balance)",
    "    return orig(a, balance)",
    "np.linalg._eig = spy",
    "A = m._box(np.array([[1.0, 2.0], [3.0, 4.0]]))",
    "m.eig_(3, A, m.Char('nobalance'))",
    "print(seen)",
    "seen.clear()",
    "m.eig_(3, A)",
    "print(seen)",
  ].join("\n")], { encoding: "utf8" }).trim();
  assert.equal(out, "[False, False]\n[True, True]");
});
