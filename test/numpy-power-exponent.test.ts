import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// x ** 2, x ** -1 and x ** 0.5 of float arrays went through pow, whose last
// bit differs from NumPy's x * x, 1 / x and sqrt(x) in about one element in
// 1,000; and pow's NaNs had the wrong signs. Compared with CPython's NumPy:
// every form of one exponent for the whole loop, arrays of exponents,
// strided and transposed bases, out=, in place, where=, and NaN signs
// (test/numpy_power_exponent_cases.py).
const TEST = __dirname + "/../../test/";
test("float power of one exponent, and pow's NaNs, are NumPy's to the bit", () => {
  const name = "numpy_power_exponent_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
