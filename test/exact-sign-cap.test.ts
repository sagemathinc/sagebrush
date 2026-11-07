import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// bool() of a relation between algebraic constants converts their difference
// to an algebraic number (lib/_sage_expr.py _exact_sign) only under a degree
// cap: a constant past it is refused from its tree's degree bound before any
// field is built and stays undecided, a stricter cap already set is kept, the
// cap is restored, and a product with a factor proven 0 is 0 without building
// the rest (the reviews' EXACT-WORK-1); I counts as degree 2 in the bound, a Gaussian
// rational's conversion runs under the armed cap, and a constant past 4000 characters is
// refused before any factor is converted (the grader's r802b Z2, Z9 and Z15).
const TEST = __dirname + "/../../test/";
test("_exact_sign refuses a constant past its degree cap before building it, and restores the cap", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "exact_sign_cap_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "None 0 True",
    "None 4",
    "None 0 True",
    "0 True True",
    "True False True False True",
    "0 True",
    "None False True",
    "None [32] True",
    "True None 0 True",
  ]);
});
