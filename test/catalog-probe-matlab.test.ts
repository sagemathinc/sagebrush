import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// scripts/catalog-probe-matlab.py's comparison: its self-test, which includes the false matches
// the reviews found (printed text starting with "error", a marker-like text inside a char value)

test("the MATLAB catalog probe's comparison: outcomes from its own markers, printed text exact, numbers only in numeric values", () => {
  const r = spawnSync("python3", [join(__dirname, "..", "..", "scripts", "catalog-probe-matlab.py"), "--self-test"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(\d+) of \1 checks pass$/m);
});
