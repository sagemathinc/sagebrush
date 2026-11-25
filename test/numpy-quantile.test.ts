import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// numpy.quantile, percentile and median as NumPy 2.5.5 computes them, value bits and dtype (#1866): method="midpoint"
// at an integer virtual index is the element itself; a float32 q's virtual index is computed in float32; a Python q is
// weak, so float32 data stays float32; percentile divides q by 100 in q's dtype; an integer q under "linear" takes the
// element in the data's dtype (test/numpy_quantile_cases.py; its expected output, .out, is NumPy 2.5.5's).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("numpy quantile, percentile and median: NumPy 2.5.5's values and dtypes", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "numpy_quantile_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "numpy_quantile_cases.out", "utf8"));
});
