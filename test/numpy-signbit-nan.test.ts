import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

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

// JavaScriptCore (Bun) keeps no NaN signs: there, signbit and copysign of a
// NaN are refused in words, and of other values still answered
test("under Bun, signbit and copysign of a NaN are refused, of other values answered", () => {
  if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) return;
  const program = [
    "import numpy as np",
    "print(np.signbit(np.array([-1.5, 0.0, -0.0, 2.0])).tolist(), np.copysign(np.array([1.0, 2.0]), -1.0).tolist())",
    "for f in [lambda: np.signbit(np.array([np.nan])), lambda: np.copysign(1.0, np.array([np.nan])), lambda: np.copysign(np.array([np.nan]), 1.0)]:",
    "    try:",
    "        print(f())",
    "    except NotImplementedError as e:",
    "        print('NotImplementedError', e)",
  ].join("\n");
  const out = execFileSync("bun", [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" }).split("\n");
  assert.equal(out[0], "[True, False, True, False] [-1.0, -2.0]");
  for (const line of out.slice(1, 4)) assert.match(line, /^NotImplementedError signbit and copysign of a NaN: this JavaScript engine \(JavaScriptCore, as in Bun\) does not keep NaN signs$/);
});
