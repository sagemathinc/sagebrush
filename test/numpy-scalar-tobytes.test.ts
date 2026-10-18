import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// NumPy scalars had no tobytes() (np.float64(1.5).tobytes() was an
// AttributeError): the bytes of a 0-d array of the scalar's dtype, as
// NumPy's. Compared with CPython's NumPy (test/numpy_scalar_tobytes_cases.py).
const TEST = __dirname + "/../../test/";
test("NumPy scalars' tobytes() are NumPy's", () => {
  const name = "numpy_scalar_tobytes_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
