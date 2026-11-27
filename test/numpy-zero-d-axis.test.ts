import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A 0-d array's reductions take an integer axis of 0 or -1, as NumPy's C
// reductions allow (argmax and cumsum as of one element, so any other axis
// is out of bounds for dimension 1), and keepdims gives a scalar; and
// broadcast_shapes, broadcast_arrays and broadcast_to refuse with NumPy's
// messages (test/numpy_zero_d_axis_cases.py; its expected output, .out, is
// NumPy 2.5.1's).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("0-d reductions with axis 0 or -1, and NumPy's broadcast refusals", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "numpy_zero_d_axis_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "numpy_zero_d_axis_cases.out", "utf8"));
});
