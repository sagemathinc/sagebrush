import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/scipy/optimize.py where it is not SciPy (scipy-tests/test_optimize.py
// compares the rest with SciPy itself): what it does not implement raises
// NotImplementedError, never a plausible answer; a callback's form is read
// without the inspect module.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("scipy.optimize: methods, bounds and constraints not ported raise NotImplementedError", () => {
  const out = py(`
import numpy as np
from scipy.optimize import minimize
f = lambda x: float(np.sum((x - 1.0) ** 2))
cases = [
    lambda: minimize(f, [0.0, 0.0], method="L-BFGS-B"),
    lambda: minimize(f, [0.0, 0.0], bounds=[(0, 1), (0, 1)]),
    lambda: minimize(f, [0.0, 0.0], constraints=[{"type": "eq", "fun": lambda x: x[0] - x[1]}]),
    lambda: minimize(f, [0.0, 0.0], method="trust-constr"),
    lambda: minimize(f, [0.0, 0.0], method="Powell"),
    lambda: minimize(f, [0.0, 0.0], method="Newton-CG", jac=lambda x: 2 * (x - 1.0)),
    lambda: minimize(f, [0.0, 0.0], method="Nelder-Mead", bounds=[(0, 1), (0, 1)]),
]
for c in cases:
    try:
        c()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", str(e).split(" is not")[0])
`);
  assert.equal(out, [
    "NotImplementedError scipy.optimize: minimize's method 'L-BFGS-B'",
    "NotImplementedError scipy.optimize: minimize's method 'L-BFGS-B'",
    "NotImplementedError scipy.optimize: minimize's method 'SLSQP'",
    "NotImplementedError scipy.optimize: minimize's method 'trust-constr'",
    "NotImplementedError scipy.optimize: minimize's method 'Powell'",
    "NotImplementedError scipy.optimize: minimize's method 'Newton-CG'",
    "NotImplementedError scipy.optimize: Nelder-Mead with bounds",
    "",
  ].join("\n"));
});

test("scipy.optimize: a callback taking intermediate_result gets the result, in each form inspect.signature reads", () => {
  const out = py(`
import numpy as np
from scipy.optimize import minimize
f = lambda x: float((x[0] - 2.0) ** 2 + (x[1] + 1.0) ** 2)
got = []
def by_name(intermediate_result):
    got.append(("def", type(intermediate_result).__name__))
class ByMethod:
    def cb(self, intermediate_result):
        got.append(("method", type(intermediate_result).__name__))
class ByCall:
    def __call__(self, intermediate_result):
        got.append(("call", type(intermediate_result).__name__))
def classic(xk):
    got.append(("classic", type(xk).__name__))
for cb in (by_name, ByMethod().cb, ByCall(), classic, lambda xk, *a: got.append(("varargs", type(xk).__name__))):
    minimize(f, [0.0, 0.0], method="CG", callback=cb, options={"maxiter": 1})
print(sorted(set(got)))
`);
  assert.equal(out, "[('call', 'OptimizeResult'), ('classic', 'ndarray'), ('def', 'OptimizeResult'), ('method', 'OptimizeResult'), ('varargs', 'ndarray')]\n");
});
