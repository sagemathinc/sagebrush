import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// F3 of plan-finite-fields: RootsInSplittingField (Magma), splitting_field
// and roots(ring) (Sage) under one bounded core (lib/_sage_ffsub.py
// factor_cost, split_degree, split_cost, split_field, split_roots): the
// factorization charged before it, the splitting field's 2^20 bound on the
// degrees, the roots' whole work before the field's Conway search or any
// root; refused one cop short with nothing of the next stage done, admitted
// at its cost.  test/ff_f3b_cases.py; its .out was checked under CPython.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("finite fields F3: splitting fields and their roots admit each stage's work before it (Magma and Sage)", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "ff_f3b_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  const want = readFileSync(TEST + "ff_f3b_cases.out", "utf8");
  const g = got.split("\n"), w = want.split("\n");
  const diffs = w.map((line, i) => (line === g[i] ? null : `${i + 1}: want ${line}\n   got ${g[i]}`)).filter((x) => x !== null);
  assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} lines differ`);
  assert.equal(g.length, w.length);
});
