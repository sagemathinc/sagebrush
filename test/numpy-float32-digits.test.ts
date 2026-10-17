import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// NumPy's shortest float32 digits, Dragon4's unique mode (2**-96 is
// 1.2621775e-29, 2**-12 0.00024414062), and float32 arrays scientific from
// 1e6 up, compared with CPython's NumPy (test/numpy_float32_digits_cases.py)
const TEST = __dirname + "/../../test/";
test("numpy float32 digits and array notation as NumPy's", () => {
  const name = "numpy_float32_digits_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});
