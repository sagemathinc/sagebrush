import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { numpyOracle } from "./numpy-oracle";

// Complex powers of integer exponents, 0 ** b, np.reciprocal and the `**`
// operator's routes as NumPy's (npy_cpow; its reciprocal loop;
// fast_scalar_power): powers began from 1 + 0j (signed zeros and infinities
// lost), squared with 2 a b, and refused nothing NumPy does but differed in
// the last bits; reciprocal was Smith's division, which NumPy's loop is not.
// Compared with CPython's NumPy without AVX-512 (glibc's loops;
// test/numpy-oracle.ts): test/numpy_complex_power_cases.py.
const TEST = __dirname + "/../../test/";
test("complex powers, reciprocal and z ** -1 are NumPy's to the bit", () => {
  const name = "numpy_complex_power_cases.py";
  const want = numpyOracle(TEST + name);
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
