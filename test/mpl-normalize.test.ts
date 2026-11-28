import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// matplotlib.colors.Normalize (test/mpl_normalize_cases.py, against what CPython with matplotlib printed:
// test/mpl-oracle.json): clip, the instance's and the call's; equal bounds mapping to 0 and reversed bounds refused;
// bounds autoscaled from the first data they are missing for; the result's dtype for each kind of value.
const TEST = __dirname + "/../../test/";
const oracle = JSON.parse(readFileSync(TEST + "mpl-oracle.json", "utf8"));

test("Normalize as matplotlib's: clip, equal and reversed bounds, autoscaling, dtypes (test/mpl_normalize_cases.py)", () => {
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "mpl_normalize_cases.py"], { encoding: "utf8" });
  assert.equal(got, oracle["mpl_normalize_cases.py"]);
});
