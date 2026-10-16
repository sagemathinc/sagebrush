import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The six deprecated names current NumPy no longer has are kept for old scripts, computing what
// NumPy 1.x's did (test/numpy_deprecated_cases.py; its expected output,
// test/numpy_deprecated_cases.out, is NumPy 1.26's, which still has them),
// each with a DeprecationWarning naming its replacement.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("numpy's deprecated names (asfarray, in1d, product, round_, row_stack, trapz) compute NumPy 1.x's values", () => {
  const want = require("node:fs").readFileSync(TEST + "numpy_deprecated_cases.out", "utf8");
  const got = execFileSync(process.execPath, [CLI, TEST + "numpy_deprecated_cases.py"], { encoding: "utf8" });
  assert.equal(got, want);
});
test("each removed numpy name warns once per call with a DeprecationWarning naming its replacement", () => {
  const code = [
    "import warnings, numpy as np",
    "with warnings.catch_warnings(record=True) as w:",
    "    warnings.simplefilter('always')",
    "    np.asfarray([1]); np.in1d([1], [1]); np.product([1]); np.round_(1.5); np.row_stack(([1], [2])); np.trapz([1, 2])",
    "for m in w: print(m.category.__name__, m.message)",
    "print(np.trapz.__name__, np.round is np.around)",
    "try:\n    np.round(np.array([1.25]), 1, out=np.zeros(1, complex))\nexcept NotImplementedError as e:\n    print(type(e).__name__)",
  ].join("\n");
  const got = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" });
  assert.equal(
    got,
    [
      "DeprecationWarning `np.asfarray` is deprecated (current NumPy no longer has it); use `np.asarray(a, dtype=float)` instead",
      "DeprecationWarning `np.in1d` is deprecated (current NumPy no longer has it); use `np.isin` instead",
      "DeprecationWarning `np.product` is deprecated (current NumPy no longer has it); use `np.prod` instead",
      "DeprecationWarning `np.round_` is deprecated (current NumPy no longer has it); use `np.round` instead",
      "DeprecationWarning `np.row_stack` is deprecated (current NumPy no longer has it); use `np.vstack` instead",
      "DeprecationWarning `np.trapz` is deprecated (current NumPy no longer has it); use `np.trapezoid` instead",
      "trapz True",
      "NotImplementedError",
      "",
    ].join("\n"),
  );
});
