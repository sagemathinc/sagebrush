import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The shared finite-field core (lib/_sage_ffsub.py) under both front ends:
// a cached Conway image is parent-neutral and rehomed per target
// (sagebrush-astra's CORR-FFSHARED-1), Sage and Magma share ONE bounded image
// LRU, every Sage hook (coercion, descent, pushout, Hom, hom, subfields)
// calls the core's bounded functions, and refusals are in words.
// test/ff_shared_cases.py; its .out was checked under CPython.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("finite fields: one shared bounded core for Sage and Magma (F1)", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "ff_shared_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  const want = readFileSync(TEST + "ff_shared_cases.out", "utf8");
  const g = got.split("\n"), w = want.split("\n");
  const diffs = w.map((line, i) => (line === g[i] ? null : `${i + 1}: want ${line}\n   got ${g[i]}`)).filter((x) => x !== null);
  assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} lines differ`);
  assert.equal(g.length, w.length);
});
