import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { numpyOracle } from "./numpy-oracle";

// np.arange's values were start + i * step, and its length ceil((stop -
// start) / step) without NumPy's underflow case; np.linspace truncated for an
// integer dtype and ignored delta when num <= 1. So arange(-1, 1, 0.1)[10]
// was 0.0 (NumPy: -2.220446049250313e-16), arange(0, 5, 0.5, dtype=int)
// counted up (NumPy: all zeros), and linspace(-1, 0, 4, dtype=int) was
// [-1, 0, 0, 0] (NumPy: [-1, -1, -1, 0]). Compared with CPython's NumPy,
// every element to the bit: test/numpy_arange_linspace_cases.py.
const TEST = __dirname + "/../../test/";
test("np.arange and np.linspace give NumPy's elements, to the bit, and its lengths and errors", () => {
  const name = "numpy_arange_linspace_cases.py";
  const want = numpyOracle(TEST + name);
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
