import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/sympy: a subset of SymPy's interface over the symbolic engine.  The
// expected lines are SymPy 1.14's own output for the same programs
// (sympy-tests/run.py compares the rest with SymPy itself when it is
// installed); what is not part of the subset raises NotImplementedError.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("sympy: float powers, diff, subs with a NumPy number, and SymPy's printed and LaTeX forms", () => {
  const out = py(`
import numpy as np
from sympy import diff
from sympy.abc import X, Y
f = 1.25*X**3.2/(2.5**3.2 + X**3.2)
print(f)
print(diff(f, X))
print(f._repr_latex_())
print(diff(3*X*Y, Y))
m = diff(f, X).subs(X, np.float64(1.75))
print(m, round(m, 4), float(m) > 0)
`);
  assert.equal(out, [
    "1.25*X**3.2/(X**3.2 + 18.7675692809599)",
    "4.0*X**2.2/(X**3.2 + 18.7675692809599) - 4.0*X**5.4/(X**3.2 + 18.7675692809599)**2",
    "$\\displaystyle \\frac{1.25 X^{3.2}}{X^{3.2} + 18.7675692809599}$",
    "3*X",
    "0.419365758682269 0.4194 True",
    "",
  ].join("\n"));
});

test("sympy: Matrix jacobian, subs with a list of pairs, and a NumPy array of the result", () => {
  const out = py(`
import numpy as np
from sympy import Matrix
from sympy.abc import N, P
F = Matrix([0.8*N*(1 - N/40) - 0.05*N*P, 0.02*N*P - 0.4*P])
J = F.jacobian(Matrix([N, P]))
print(J)
print(J._repr_latex_())
A = np.array(J.subs([(N, 20.0), (P, 8.0)]), dtype=float)
print(A.shape, [round(float(x), 9) for x in A.ravel()])
`);
  assert.equal(out, [
    "Matrix([[-0.04*N - 0.05*P + 0.8, -0.05*N], [0.02*P, 0.02*N - 0.4]])",
    "$\\displaystyle \\left[\\begin{matrix}- 0.04 N - 0.05 P + 0.8 & - 0.05 N\\\\0.02 P & 0.02 N - 0.4\\end{matrix}\\right]$",
    "(2, 2) [-0.4, -1.0, 0.16, 0.0]",
    "",
  ].join("\n"));
});

test("sympy: diff's integer order and subs with a dict", () => {
  const out = py(`
from sympy import diff
from sympy.abc import X, Y
print(diff(X**4, X, 2))
print((3*X*Y).subs({X: 2}))
`);
  assert.equal(out, "12*X**2\n6*Y\n");
});

test("sympy: solve imports but raises NotImplementedError when called; a symbolic matrix is no float array", () => {
  const out = py(`
import numpy as np
from sympy import solve, Matrix
from sympy.abc import X
try:
    solve(X**2 - 1, X)
    print("no error")
except NotImplementedError as e:
    print("NotImplementedError", str(e).split(",")[0])
try:
    np.array(Matrix([X, 1]), dtype=float)
    print("no error")
except TypeError:
    print("TypeError")
`);
  assert.equal(out, "NotImplementedError sympy.solve is not part of Sagebrush's sympy\nTypeError\n");
});
