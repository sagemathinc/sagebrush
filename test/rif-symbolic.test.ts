import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// RealIntervalField of a symbolic value at the field's own precision: an
// expression of rationals, pi and e with + - * /, integer powers and square
// roots is evaluated in the field's interval arithmetic, so sqrt(2) at 1024
// bits is 2^-1020 wide, not the 4e-14 of the engine's f64 enclosure
// (CORR-AA4-1); anything else keeps that coarse certified enclosure.
const TEST = __dirname + "/../../test/";
test("RealIntervalField(prec)(sqrt(2)) and friends are as tight as prec, and contain their value", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "rif_symbolic_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "53 True True True True",
    "128 True True True True",
    "1024 True True True True",
    "True",
    "True",
    "NotImplementedError",
  ]);
});
