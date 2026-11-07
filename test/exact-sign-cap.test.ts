import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// bool() of a relation between algebraic constants converts their difference
// to an algebraic number (lib/_sage_expr.py _exact_sign) only under a degree
// cap: a constant past it is refused from its tree's degree bound before any
// field is built, a stricter cap already set is kept, the cap is restored, and
// the relation is still decided as Sage decides it (the review's EXACT-WORK-1).
const TEST = __dirname + "/../../test/";
test("_exact_sign refuses a constant past its degree cap before building it, and restores the cap", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "exact_sign_cap_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "capped True",
    "capped 4",
    "capped True",
    "True False True True",
    "0 True",
  ]);
});
