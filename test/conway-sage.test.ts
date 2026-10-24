import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The cap on a cold Conway search, _sage_ff.CONWAY_WORK, is one constant for
// both modes: Sage's GF(q) (prefix fields too) and conway_polynomial refuse
// past it in words, before the field is made and with the polynomial cache
// unchanged (transactional), admit at exactly the charge, and a cache hit or
// a given modulus costs nothing.  test/conway_sage_cases.py; its .out was
// checked under CPython.
// (the cases exercise the limits as a policy sets them: test/limits-finite.json;
// plan-c0 made the defaults unlimited)
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("Sage mode: GF and conway_polynomial under the shared Conway cap (LIMIT-PR48)", () => {
  const got = execFileSync(process.execPath, [CLI, "--limits", TEST + "limits-finite.json", TEST + "conway_sage_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  const want = readFileSync(TEST + "conway_sage_cases.out", "utf8");
  const g = got.split("\n"), w = want.split("\n");
  const diffs = w.map((line, i) => (line === g[i] ? null : `${i + 1}: want ${line}\n   got ${g[i]}`)).filter((x) => x !== null);
  assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} lines differ`);
  assert.equal(g.length, w.length);
});
