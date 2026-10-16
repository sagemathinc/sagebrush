import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// float16 is not implemented: NumPy stores and computes it in binary16, and
// float32 in its place gave other values, so float16 is refused (its dtype
// names, np.float16 and np.half, and the float ufuncs NumPy computes in
// float16: of bool, int8 and uint8); 16-bit ints give float32 and wider ints
// float64, as NumPy's (test/numpy_float16_cases.py; its expected output,
// .out, is NumPy 2.5.1's).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("float ufuncs of 16-bit and wider ints have NumPy's float types", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "numpy_float16_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "numpy_float16_cases.out", "utf8"));
});
test("float16, the float ufuncs NumPy computes in float16, and longdouble are refused", () => {
  const cases = [
    "np.array([1.234], dtype=np.float16)",
    "np.array([1.234], dtype='float16')",
    "np.array([1.234], dtype='f2')",
    "np.array([1.234], dtype='e')",
    "np.zeros(2, np.half)",
    "np.dtype('half')",
    "np.float16(1.5)",
    "np.array([1, 2]).astype(np.float16)",
    "np.sin(np.array([1], np.int8))",
    "np.sqrt(np.array([4], np.uint8))",
    "np.exp(np.array([True]))",
    "np.arctan2(np.array([1], np.int8), np.array([1], np.int8))",
    "np.hypot(np.array([3], np.uint8), np.array([4], np.uint8))",
    "np.sin(np.int8(1))",
    "np.hypot(np.uint8(3), np.uint8(4))",
    "np.array([1.0], dtype='longdouble')",
    "np.array([1.0], dtype='float128')",
    "np.array([1.0], dtype='g')",
    "np.array([1.0], dtype='clongdouble')",
    "np.array([1.0], dtype='complex256')",
    "np.result_type('f16')",
    "np.result_type('<f16')",
    "np.result_type('c32')",
    "np.result_type('<c32')",
    "np.hypot(np.array([True]), True)",
    "np.result_type('float16')",
    "np.result_type(np.float16)",
    "np.result_type(np.int8, 'f2')",
    "np.geomspace(1, 2, 3, dtype='float16')",
    "np.add.reduce([1, 2], dtype='float16')",
    "np.maximum.accumulate([1, 2], dtype='float16')",
    "np.add.outer([1], [2], dtype='float16')",
    "np.hypot(np.array([1], np.int8), np.array([2], np.uint8))",
    "np.arctan2(np.array([1], np.int8), 2)",
    "np.copysign(np.array([True]), np.array([1], np.uint8))",
    "np.rint(np.array([1], np.int8))",
    "np.fabs(np.array([-128], np.int8))",
    "np.fabs(np.array([True]))",
    "np.sqrt(np.array([2], np.int16), dtype=np.float16)",
  ];
  const code = ["import numpy as np"].concat(cases.map((c) => `try:\n    print(repr(${c}))\nexcept NotImplementedError as e:\n    print('refused')`)).join("\n");
  const got = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trimEnd().split("\n");
  cases.forEach((c, i) => assert.equal(got[i], "refused", c));
});
