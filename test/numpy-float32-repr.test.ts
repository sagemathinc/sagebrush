import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// NumPy's float32 scalar repr: shortest digits, scientific outside
// 1e-4 <= |x| < 1e6 (np.float32(3.8923753e+13) printed 38923753000000.0),
// compared with CPython's NumPy (test/numpy_float32_repr_cases.py).
const TEST = __dirname + "/../../test/";
test("numpy float32 scalars print as NumPy's", () => {
  const name = "numpy_float32_repr_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});
