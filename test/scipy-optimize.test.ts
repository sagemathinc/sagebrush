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

// OPT671-WORK-1 (astra): what an optimizer step keeps at once is admitted
// together against the array limit, before its first array (_numpy's
// _admit_work, admitWork's message). Each pair: one byte under the step's
// admission it is refused, with the function never called; at the admission
// it runs (the control). The Jacobian's differences are written into it as
// they are made, so one n x m array is its peak, charged with the vectors
// beside it (scipy-tests/test_optimize_memory.py traces the true peak under
// CPython against the same charge); a long input with one output, one-sided,
// is astra's second case.
test("scipy.optimize: each step's working memory is admitted at once, refused one byte under it", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const np = require("../src/runtime/numpy");
  const Obj = require("../src/runtime/object");
  const F = require("../src/runtime/format");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  await s.handle({
    id: 1,
    code: [
      "import numpy as np",
      "from scipy.optimize import approx_fprime, minimize, rosen, rosen_hess",
      "from scipy.optimize import _dense_difference",
      "calls = [0]",
      "def sq(x):",
      "    calls[0] += 1",
      "    return x * x",
      "def ros(x):",
      "    calls[0] += 1",
      "    return rosen(x)",
      "X32 = np.ones(32); F32 = np.ones(32); H32 = np.full(32, 1e-6); X16 = np.zeros(16); ONE = np.zeros(32, bool)",
      "X128 = np.ones(128); F1 = np.ones(1); H128 = np.full(128, 1e-6); SIDED = np.ones(128, bool)",
      "def first_sq(x):",
      "    calls[0] += 1",
      "    return x[:1] * x[:1]",
      "CASES = {",
      "    '2-point': lambda: _dense_difference(sq, X32, F32, H32, ONE, '2-point', map),",
      "    '3-point': lambda: _dense_difference(sq, X32, F32, H32, ONE, '3-point', map),",
      "    'cs': lambda: _dense_difference(sq, X32, F32, H32, ONE, 'cs', map),",
      "    '3-point one-sided 128 x 1': lambda: _dense_difference(first_sq, X128, F1, H128, SIDED, '3-point', map),",
      "    'BFGS': lambda: minimize(ros, X16, method='BFGS', options={'maxiter': 2}),",
      "    'Nelder-Mead': lambda: minimize(ros, X16, method='Nelder-Mead', options={'maxiter': 2}),",
      "    'rosen_hess': lambda: rosen_hess(X16),",
      "}",
      "def attempt(name):",
      "    calls[0] = 0",
      "    try:",
      "        CASES[name]()",
      "        return 'ok %d' % calls[0]",
      "    except MemoryError as e:",
      "        return 'MemoryError %d %s' % (calls[0], e)",
    ].join("\n"),
  });
  const main = Obj.getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const attempt = Obj.callObj(Obj.getattr(main, "__getitem__"), ["attempt"]);
  // (each step's admission: lib/scipy/optimize.py's _admit calls)
  const NEED: [string, number, string][] = [
    ["2-point", 8 * 32 * 32 + 16 * (16 * 32 + 8 * 32), "approx_derivative"],
    ["3-point", 8 * 32 * 32 + 16 * (16 * 32 + 8 * 32), "approx_derivative"],
    ["cs", 8 * 32 * 32 + 16 * (16 * 32 + 8 * 32), "approx_derivative"],
    ["3-point one-sided 128 x 1", 8 * 128 * 1 + 16 * (16 * 128 + 8 * 1), "approx_derivative"],
    ["BFGS", 8 * 8 * 16 * 16, "BFGS's inverse Hessian"],
    ["Nelder-Mead", 8 * 5 * 17 * 16, "Nelder-Mead's simplex"],
    ["rosen_hess", 8 * 4 * 16 * 16, "rosen_hess"],
  ];
  const saved = { ...np.ARRAY_LIMITS };
  try {
    for (const [name, need, what] of NEED) {
      np.ARRAY_LIMITS.bytes = need - 1;
      const under = F.str(Obj.callObj(attempt, [name]));
      assert.match(under, new RegExp(`^MemoryError 0 ${what} needs .* of working memory, more than Sagebrush's limit of`), `${name} one byte under ${need}`);
      np.ARRAY_LIMITS.bytes = need;
      assert.match(F.str(Obj.callObj(attempt, [name])), name === "rosen_hess" ? /^ok 0$/ : /^ok [1-9]/, `${name} at ${need}`);
    }
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }
});
