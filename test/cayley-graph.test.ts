import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// PermutationGroup.cayley_graph against native Sage 10.10 (black box,
// @sagebrush-astra's cases): S_1 to S_4 with the default generators, right
// and left, simple or not; explicit generators, connecting_set, the empty
// list, the identity (Sage's error), duplicates, a subgroup, inverses, and
// list and tuple input. test/cayley_oracle.json holds Sage's output.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("cayley_graph gives Sage's graphs, edges and labels (native Sage oracle)", () => {
  const out = execFileSync(process.execPath, [CLI, "--sage", TEST + "cayley_cases.sage"], { encoding: "utf8", timeout: 120000 });
  const got = JSON.parse(out.trim().split("\n").at(-1)!);
  const want = JSON.parse(readFileSync(TEST + "cayley_oracle.json", "utf8"));
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], k);
});
