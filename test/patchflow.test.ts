import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// patchflow, as the board's and the notebook's histories use it (web/board/history.ts,
// web/notebook/patch-history.js), and as `board open --edit` will merge with it
// (plan-board-open-edit r7, step 0):
// - the exact versions pinned, with npm's integrity in the lockfile;
// - an edit that changes only a high surrogate is kept (patchflow 0.12 to 0.15,
//   through @cocalc/diff-match-patch 1.0.x/1.1.0, silently dropped it: "x😀y" -> "x🨀y"
//   stayed "x😀y", reported clean), in patches, in the string merge and in the
//   records codec the boards' TimeTravel uses;
// - its diffs are bounded by a deterministic work budget, DIFF_WORK_LIMIT: at the
//   smallest limit that suffices the diff is the full one, one unit less cuts it off,
//   the units charged stay within the contract's limit plus one step, and a pair over
//   patchflow's limit still patches exactly.
const ROOT = __dirname + "/../../";
const pf = require("patchflow");
// (the diff-match-patch patchflow itself loads: its dependency, not one of ours)
const dmpLib = createRequire(require.resolve("patchflow"))("@cocalc/diff-match-patch");

const PATCHFLOW = "0.16.0", DMP = "1.1.1";
// (npm view patchflow@0.16.0 dist.integrity; npm view @cocalc/diff-match-patch@1.1.1 dist.integrity)
const PATCHFLOW_INTEGRITY = "sha512-uwFzdvxazSmqHWl4H6DizPDPilRfp2/H09qQ+eFDF3dbW0pODzlNR05cKVcCy9SpMYDTWBSh2eZU2lJ3e3t6kQ==";
const DMP_INTEGRITY = "sha512-za8xDP+3G0Cmm0auvXXbuQF0AP0xsydyc7a+rDDfeXg7zm250Krsst79dVeDf6eD9t/5eRHkxiz1kDUosIItJg==";

test("patchflow: pinned exactly, with npm's integrity in the lockfile", () => {
  const pkg = JSON.parse(readFileSync(ROOT + "package.json", "utf8"));
  assert.equal(pkg.dependencies?.patchflow ?? pkg.devDependencies?.patchflow, PATCHFLOW);
  const lock = readFileSync(ROOT + "pnpm-lock.yaml", "utf8");
  const resolution = (name: string) => new RegExp(`\\n  '?${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}'?:\\n    resolution: \\{integrity: (\\S+)\\}`).exec(lock)?.[1];
  assert.equal(resolution(`patchflow@${PATCHFLOW}`), PATCHFLOW_INTEGRITY);
  assert.equal(resolution(`@cocalc/diff-match-patch@${DMP}`), DMP_INTEGRITY);
  // (and what is installed is that)
  const version = (path: string) => JSON.parse(readFileSync(path, "utf8")).version;
  assert.equal(version(ROOT + "node_modules/patchflow/package.json"), PATCHFLOW);
  const dmpDir = require.resolve("patchflow").replace(/node_modules\/patchflow\/.*$/, "node_modules/@cocalc/diff-match-patch/package.json");
  assert.equal(version(dmpDir), DMP);
});

// pairs of texts whose only difference is one half of a surrogate pair
const SURROGATE_EDITS: [string, string, string][] = [
  ["the high surrogate only", "x😀y", "x🨀y"], // 😀 -> 🨀
  ["the low surrogate only", "x😀y", "x😁y"], // 😀 -> 😁
  ["between two emoji", "😀😀", "😀🨀"],
  ["in longer text", "a note: 😀 and more text after it", "a note: 🨀 and more text after it"],
];

test("patchflow: an edit of one half of a surrogate pair is kept (patches)", () => {
  for (const [what, a, b] of SURROGATE_EDITS) {
    const [got, clean] = pf.applyPatch(pf.makePatch(a, b), a);
    assert.equal(got, b, what);
    assert.equal(clean, true, what);
  }
});

test("patchflow: ... and in the three-way string merge", () => {
  for (const [what, a, b] of SURROGATE_EDITS) {
    // (one side edits the emoji, the other appends: both kept)
    assert.equal(pf.mergeStrings3({ base: a, a: b, b: a + "!" }), b + "!", what);
    assert.equal(pf.mergeStrings3({ base: a, a: a + "!", b }), b + "!", what);
  }
});

test("patchflow: ... and in the records codec the boards' TimeTravel uses", () => {
  // (web/board/history.ts's schema: text fields are string columns, patched character by character)
  const codec = pf.createImmerDbCodec({ primaryKeys: ["type", "page", "id"], stringCols: ["title", "text", "code", "detail", "label", "intro"] });
  for (const [what, a, b] of SURROGATE_EDITS) {
    const before = codec.fromString(JSON.stringify({ type: "item", page: "", id: "n1", text: a }));
    const after = codec.fromString(JSON.stringify({ type: "item", page: "", id: "n1", text: b }));
    const patch = codec.makePatch(before, after);
    const got = codec.applyPatch(before, patch);
    assert.equal(got.getOne({ type: "item", page: "", id: "n1" }).text, b, what);
    assert.ok(got.isEqual(after), what);
  }
});

test("patchflow: diffs are bounded by DIFF_WORK_LIMIT, deterministically", () => {
  assert.equal(pf.DIFF_WORK_LIMIT, 25_000_000);
  const { DiffMatchPatch, DiffWorkBudget, BUDGET_STEP_UNITS } = dmpLib;
  const t1 = "The quick brown fox jumps over the lazy dog. ".repeat(20);
  const t2 = t1.replace(/o/g, "0").slice(5) + "end";
  const dmp = new DiffMatchPatch();
  const run = (limit: number) => {
    const budget = new DiffWorkBudget(limit);
    const diffs = dmp.diff_main(t1, t2, true, budget);
    return { diffs: JSON.stringify(diffs), used: limit - budget.left };
  };
  const full = run(1e12).diffs;
  // the smallest limit that gives the full diff, found by bisection; one unit less cuts it off
  let lo = 0, hi = 1e9;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (run(mid).diffs === full) hi = mid;
    else lo = mid + 1;
  }
  const atCap = run(lo), belowCap = run(lo - 1);
  assert.equal(atCap.diffs, full, "the exact limit gives the full diff");
  assert.notEqual(belowCap.diffs, full, "one unit less cuts it off");
  // (the contract: at most the limit plus one step, BUDGET_STEP_UNITS per character of the call's texts, plus 2)
  const step = BUDGET_STEP_UNITS * (t1.length + t2.length + 2);
  assert.ok(atCap.used <= lo + step, `charged ${atCap.used} at the limit ${lo}`);
  assert.ok(belowCap.used <= lo - 1 + step, `charged ${belowCap.used} at the limit ${lo - 1}`);
  // deterministic: the same cut-off every time
  for (let i = 0; i < 3; i++) assert.equal(run(lo - 1).diffs, belowCap.diffs);
  // and either diff patches exactly
  for (const diffs of [atCap.diffs, belowCap.diffs]) {
    const patch = dmp.patch_make(t1, JSON.parse(diffs));
    assert.equal(dmp.patch_apply(patch, t1)[0], t2);
  }
});

test("patchflow: a pair over its work limit still patches exactly", () => {
  // two unrelated 200,000-character texts: far over DIFF_WORK_LIMIT, so the diff is cut off
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const text = (n: number) => Array.from({ length: n }, () => "abcdefghij"[Math.floor(rnd() * 10)]).join("");
  const a = text(200_000), b = text(200_000);
  const [got, clean] = pf.applyPatch(pf.makePatch(a, b), a);
  assert.equal(got, b);
  assert.equal(clean, true);
});
