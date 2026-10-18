import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// float32 power was pow in double rounded to float, which differs from
// NumPy's float32 loop, glibc's powf (not correctly rounded), in a few
// results; it is that powf now (src/runtime/libm.ts, glibcPowf). Compared
// with CPython's NumPy (test/numpy_float32_powf_cases.py).
const TEST = __dirname + "/../../test/";
test("float32 power is glibc's powf, as NumPy's, to the bit", () => {
  const name = "numpy_float32_powf_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
