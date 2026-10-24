import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// F2 of plan-finite-fields: each operation's work is admitted in closed
// form (lib/_sage_ffsub.py *_cost) before its first power, refused one cop
// short and admitted at its cost, from Magma's intrinsics and Sage's
// methods alike; relative operations keep F1's 2^20 bound; Root's exponent
// is capped at 1024 bits; ext< > and extension() are refused before any
// field is made.  test/ff_f2_cases.py; its .out was checked under CPython.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("finite fields F2: traces, norms, minimal polynomials, roots and ext under one bounded core (Magma and Sage)", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "ff_f2_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  const want = readFileSync(TEST + "ff_f2_cases.out", "utf8");
  const g = got.split("\n"), w = want.split("\n");
  const diffs = w.map((line, i) => (line === g[i] ? null : `${i + 1}: want ${line}\n   got ${g[i]}`)).filter((x) => x !== null);
  assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} lines differ`);
  assert.equal(g.length, w.length);
});
