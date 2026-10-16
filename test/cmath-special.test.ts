import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// cmath as CPython's Modules/cmathmodule.c: the special-value tables for
// infinite and NaN parts, the large-argument formulas (atan(1e308) is pi/2,
// tan(1000j) is 1j), the signed zeros of tan and tanh, and errno raised as
// ValueError or OverflowError (sagebrush-astra's CORR-ABC-3, -4, -5).
// test/cmath_special_cases.py; its expected output, .out, is CPython 3.14's.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("cmath's special values, large arguments and errors are CPython's", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "cmath_special_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  const want = readFileSync(TEST + "cmath_special_cases.out", "utf8");
  const g = got.split("\n"), w = want.split("\n");
  const diffs = w.map((line, i) => (line === g[i] ? null : `${i + 1}: want ${line}\n   got ${g[i]}`)).filter((x) => x !== null);
  assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} lines differ`);
  assert.equal(g.length, w.length);
});
