import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// np.signbit(-nan) was False and np.copysign ignored a NaN's sign (both
// tested x < 0 or -0): they read and set the sign bit, as NumPy's do.
// Compared with CPython's NumPy (test/numpy_signbit_nan_cases.py).
const TEST = __dirname + "/../../test/";
test("np.signbit and np.copysign use a NaN's sign bit, as NumPy's", () => {
  const name = "numpy_signbit_nan_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
