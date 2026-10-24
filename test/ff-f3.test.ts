import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// F3 of plan-finite-fields: ChangeRing (Magma), change_ring and
// map_coefficients (Sage) move a polynomial's coefficients under one
// bounded core (lib/_sage_ffsub.py change, from_rationals): the whole work
// is charged before any coefficient is moved, refused one cop short with no
// embedding, descent or discrete log done, admitted at its cost; between
// finite fields F1's 2^20 bound holds.  test/ff_f3_cases.py; its .out was
// checked under CPython.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("finite fields F3: ChangeRing and change_ring admit their whole work before moving any coefficient (Magma and Sage)", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "ff_f3_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  const want = readFileSync(TEST + "ff_f3_cases.out", "utf8");
  const g = got.split("\n"), w = want.split("\n");
  const diffs = w.map((line, i) => (line === g[i] ? null : `${i + 1}: want ${line}\n   got ${g[i]}`)).filter((x) => x !== null);
  assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} lines differ`);
  assert.equal(g.length, w.length);
});
