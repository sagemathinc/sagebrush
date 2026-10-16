import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// math against CPython 3.14 (test/math_hunt_cases.py): astra's probe
// (CORR-447-1..5: dist's dimensions, log to base 1, nextafter with no steps,
// degrees/radians near the top of the range, pow(0, -inf)) and the domain
// errors in CPython 3.14's words.
const TEST = __dirname + "/../../test/";
test("math as CPython 3.14: astra's probe and the domain errors' messages", () => {
  const want = execFileSync("python3", [TEST + "math_hunt_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "math_hunt_cases.py"], { encoding: "utf8" });
  assert.equal(got, want);
});
