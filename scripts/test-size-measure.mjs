// The core's growth gate (scripts/size-measure.mjs, plan-growth-budget-r5 §5):
// records, base selection, bundles and the bootstrap, the rules, epoch resets,
// the range rule, markers, the merge protocol's lease, docs-only inputs and
// the normalization.  No build: synthetic records and files.
//   node scripts/test-size-measure.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countAssignments, epochHash, evaluate, gateInputs, jcs, measureFiles, parseMarker, recordProblems, resetGroups, safeSum, strictParse, testedTransition, NEUTRAL_WIDTH,
} from "./size-measure.mjs";

let passed = 0, failures = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}
const passes = (name, r) => check(`${name} passes`, r.ok, r.problems.join("; "));
const fails = (name, r, re) => check(`${name} fails`, !r.ok && (!re || r.problems.some((p) => re.test(p))), r.ok ? "passed" : r.problems.join("; "));

// ---- fixtures
const KEY = { bun: "1.4.4", node: "24.21.0", measure_sha256: "a".repeat(64) };
const KEY2 = { ...KEY, bun: "1.4.5" };
const BASE = "b".repeat(40), MERGE = "c".repeat(40);
const rec = (commit, sizes, key = KEY) => ({ format: "sagebrush-size-record", v: 1, repo: "sagemathinc/sagebrush", commit, tree: "t", event: "push", run: { id: "1", attempt: "1", job: "checks" }, key, bundles: Object.keys(sizes).sort(), sizes, neutral: Object.fromEntries(Object.keys(sizes).map((k) => [k, 0])) });
const ne = (ceiling, extra = {}) => ({ exact: false, ceiling, noise_bytes: 0, noise_total: 0, marker_slack: 1024, ...extra });
function budgets({ sizes = { "cli/pyjs.cjs": 100000, "engine/w.js": 5000 }, max = 300, bundles = {}, reset = null } = {}) {
  const b = { format: "sagebrush-budgets", v: 1, toolchain: { bun: "1.4.4" }, bundles: {}, epoch: { sizes: {}, reset } };
  for (const [k, v] of Object.entries(sizes)) {
    b.bundles[k] = ne(Math.floor(v * 1.1));
    b.epoch.sizes[k] = v;
  }
  b.bundles["cli/packages.gen.js"] = { exact: true, max };
  Object.assign(b.bundles, bundles);
  return b;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const marker = (bytes, reason = "a reviewed feature") => JSON.stringify({ v: 1, reason, bytes });
// one integration: base N (sizes), merge M (sizes), the merge's budgets and markers, the base's budgets
function transition({ n, m, B = budgets(), baseB = budgets(), markers = [], diff, key = KEY, nKey = KEY, declaredKey = KEY, old = null, legacy = null }) {
  return evaluate({
    mode: "transition",
    merge: { record: rec(MERGE, m, key), budgets: B, markers },
    declaredNode: "24.21.0",
    base: { commit: BASE, record: rec(BASE, n, nKey), budgets: baseB, declaredKey },
    old,
    legacy,
    markerDiff: diff ?? markers.map((x) => ({ status: "A", path: x.path })),
  });
}
const S = (pyjs, w = 5000, pk = 300) => ({ "cli/pyjs.cjs": pyjs, "engine/w.js": w, "cli/packages.gen.js": pk });

// ---- strict JSON and JCS
check("strictParse: duplicate keys refused", (() => { try { strictParse('{"a":1,"a":2}'); return false; } catch (e) { return /duplicate/.test(e.message); } })());
for (const lit of ["1.5", "1e400", "1.0", "1e3", "-0.0"]) check(`strictParse: ${lit} refused`, (() => { try { strictParse(`{"a":${lit}}`); return false; } catch { return true; } })());
check("strictParse: a truncated text refused", (() => { try { strictParse('{"a":1'); return false; } catch { return true; } })());
check("jcs sorts keys, nests", jcs({ b: 1, a: { d: [1, "x"], c: null } }) === '{"a":{"c":null,"d":[1,"x"]},"b":1}');
check("safeSum: out of range is null", safeSum([Number.MAX_SAFE_INTEGER, 1]) === null && safeSum([1, 2]) === 3);

// ---- records (r5 §1.1)
check("record: valid", recordProblems(rec(BASE, S(1)), BASE).length === 0);
check("record: wrong repo", recordProblems({ ...rec(BASE, S(1)), repo: "fork/sagebrush" }, BASE).length > 0);
check("record: wrong commit", recordProblems(rec(MERGE, S(1)), BASE).length > 0);
check("record: no key", recordProblems({ ...rec(BASE, S(1)), key: undefined }, BASE).length > 0);
check("record: a listed bundle missing from sizes", recordProblems({ ...rec(BASE, S(1)), bundles: [...Object.keys(S(1)), "x"] }, BASE).length > 0);
check("record: an extra size", recordProblems({ ...rec(BASE, S(1)), bundles: ["cli/pyjs.cjs"] }, BASE).length > 0);
check("record: negative size", recordProblems(rec(BASE, S(-1)), BASE).length > 0);
check("record: fractional size", recordProblems(rec(BASE, S(1.5)), BASE).length > 0);
check("record: wrong format", recordProblems({ ...rec(BASE, S(1)), v: 2 }, BASE).length > 0);

// ---- rule 2: growth needs a marker, tightly
passes("Δ 0", transition({ n: S(100000), m: S(100000) }));
passes("a decrease", transition({ n: S(100000), m: S(99000) }));
fails("+1 with no marker", transition({ n: S(100000), m: S(100001) }), /needs a marker/);
const mk = (bytes, path = ".growth/2026-10-24-x.json") => ({ path, text: marker(bytes) });
let Bm = (bytes) => { const b = budgets(); b.epoch.sizes["cli/pyjs.cjs"] = 100000; return b; };
passes("a marker equal to Δ", transition({ n: S(100000), m: S(102000), markers: [mk({ "cli/pyjs.cjs": 2000 })] }));
passes("a marker of Δ + marker_slack", transition({ n: S(100000), m: S(102000), markers: [mk({ "cli/pyjs.cjs": 3024 })] }));
fails("a marker of Δ + marker_slack + 1", transition({ n: S(100000), m: S(102000), markers: [mk({ "cli/pyjs.cjs": 3025 })] }), /tight/);
fails("a marker smaller than Δ", transition({ n: S(100000), m: S(102000), markers: [mk({ "cli/pyjs.cjs": 1999 })] }), /needs a marker/);
fails("a stale marker on a decrease of 2000", transition({ n: S(100000), m: S(98000), markers: [mk({ "cli/pyjs.cjs": 2000 })] }), /tight/);
passes("two markers summing", transition({ n: S(100000), m: S(103000), markers: [mk({ "cli/pyjs.cjs": 2000 }), mk({ "cli/pyjs.cjs": 1000 }, ".growth/y.json")] }));
{
  const B = budgets();
  B.bundles["cli/pyjs.cjs"].noise_bytes = 64;
  B.bundles["cli/pyjs.cjs"].noise_total = 1024;
  passes("jitter: Δ = noise_bytes (test values)", transition({ n: S(100000), m: S(100064), B, baseB: B }));
  fails("jitter: Δ = noise_bytes + 1", transition({ n: S(100000), m: S(100065), B, baseB: B }), /needs a marker/);
  passes("jitter accumulated to noise_total", transition({ n: S(100990), m: S(101024), B, baseB: B }));
  fails("jitter one past noise_total", transition({ n: S(100990), m: S(101025), B, baseB: B }), /rule 3/);
}
// ---- rule 3: the ledger, rule 4: the ceiling
{
  const inTree = { path: ".growth/old.json", text: marker({ "cli/pyjs.cjs": 500 }) };
  passes("the ledger counts a marker already in the tree", transition({ n: S(100400), m: S(100400), markers: [inTree], diff: [] }));
  fails("one byte past epoch + markers in the tree", transition({ n: S(100500), m: S(100501), markers: [inTree], diff: [] }), /rule 3/);
  fails("the ledger: a marker deleted in this PR no longer counts", transition({ n: S(100400), m: S(100400), markers: [], diff: [{ status: "D", path: ".growth/old.json" }] }), /rule 3/);
  const B = budgets();
  B.bundles["cli/pyjs.cjs"].ceiling = 101000;
  passes("at the ceiling", transition({ n: S(100000), m: S(101000), B, baseB: B, markers: [mk({ "cli/pyjs.cjs": 1000 })] }));
  fails("one over the ceiling, even with a marker", transition({ n: S(100000), m: S(101001), B, baseB: B, markers: [mk({ "cli/pyjs.cjs": 1001 })] }), /ceiling/);
}
// ---- rule 1: exact bundles
fails("an exact bundle +1, max unchanged", transition({ n: S(100000, 5000, 300), m: S(100000, 5000, 301), B: budgets({ max: 301 }), baseB: budgets({ max: 301 }) }), /may not grow/);
fails("an exact bundle +1, with a marker naming it", transition({ n: S(100000, 5000, 300), m: S(100000, 5000, 301), markers: [mk({ "cli/packages.gen.js": 1 })] }), /exact bundle can't be named/);
passes("an exact bundle −1", transition({ n: S(100000, 5000, 300), m: S(100000, 5000, 299) }));
passes("a raise of max in the same PR, up to the new max", transition({ n: S(100000, 5000, 300), m: S(100000, 5000, 400), B: budgets({ max: 400 }), baseB: budgets({ max: 300 }) }));
fails("a raise of max, one over the new max", transition({ n: S(100000, 5000, 300), m: S(100000, 5000, 401), B: budgets({ max: 400 }), baseB: budgets({ max: 300 }) }), /max 400/);
// ---- markers (r5 §1.4)
for (const [name, text, re] of [
  ["duplicate keys", '{"v":1,"reason":"x","bytes":{"cli/pyjs.cjs":1,"cli/pyjs.cjs":2}}', /duplicate/],
  ["an unknown bundle", marker({ "cli/nope.js": 1 }), /not a bundle/],
  ["0", marker({ "cli/pyjs.cjs": 0 }), /positive/],
  ["1.5", '{"v":1,"reason":"x","bytes":{"cli/pyjs.cjs":1.5}}', /integer literal/],
  ["1e400", '{"v":1,"reason":"x","bytes":{"cli/pyjs.cjs":1e400}}', /integer literal/],
  ["an empty reason", marker({ "cli/pyjs.cjs": 1 }, "  "), /reason/],
  ["an unknown key", '{"v":1,"reason":"x","bytes":{"cli/pyjs.cjs":1},"extra":1}', /exactly/],
]) check(`marker: ${name} refused`, parseMarker(text, budgets()).problems.some((p) => re.test(p)), jcs(parseMarker(text, budgets()).problems));
fails("a malformed marker anywhere in .growth/", transition({ n: S(1), m: S(1), markers: [{ path: ".growth/bad.json", text: "{" }], diff: [] }), /bad\.json/);
fails("an edit of an old marker", transition({ n: S(100000), m: S(101000), markers: [mk({ "cli/pyjs.cjs": 1000 }, ".growth/old.json")], diff: [{ status: "M", path: ".growth/old.json" }] }), /can't be edited/);
{
  const t = mk({ "cli/pyjs.cjs": 1000 }, ".growth/new.json");
  const r = evaluate({ mode: "transition", merge: { record: rec(MERGE, S(101000)), budgets: budgets(), markers: [t] }, declaredNode: "24.21.0", base: { commit: BASE, record: rec(BASE, S(100000)), budgets: budgets(), declaredKey: KEY }, markerDiff: [{ status: "D", path: ".growth/old.json" }, { status: "A", path: ".growth/new.json" }], deletedMarkerTexts: [t.text] });
  passes("a rename (D + A) is a new request", r);
  check("a rename: noted", r.notes.some((n) => /new request/.test(n)));
}
fails("a rebase onto a base that already has the marker (not eligible)", transition({ n: S(100000), m: S(101000), markers: [mk({ "cli/pyjs.cjs": 1000 })], diff: [] }), /needs a marker/);
// ---- bundles and the key sets (r5 §1.2)
{
  const B = budgets({ sizes: { "cli/pyjs.cjs": 100000, "engine/w.js": 5000, "engine/new.js": 700 } });
  passes("a new bundle, implicit zero, epoch = its size", transition({ n: S(100000), m: { ...S(100000), "engine/new.js": 700 }, B }));
  const B2 = clone(B);
  B2.epoch.sizes["engine/new.js"] = 600;
  B2.bundles["engine/new.js"].ceiling = 800;
  fails("a new bundle whose epoch isn't its size", transition({ n: S(100000), m: { ...S(100000), "engine/new.js": 700 }, B: B2 }), /new bundle's epoch/);
  fails("measured but not listed", transition({ n: S(100000), m: { ...S(100000), "engine/x.js": 1 } }), /measured but not listed/);
  fails("a bundle measured in the base but not in budgets.json, outside a reset", transition({ n: { ...S(100000), "engine/gone.js": 9 }, m: S(100000) }), /only in an epoch reset/);
}
// ---- comparability (r5 §1.1)
fails("the base's record under another key", transition({ n: S(1), m: S(1), nKey: KEY2 }), /comparability key/);
fails("bun changed, without a reset", transition({ n: S(100000, 5000, 300), m: S(100000, 5000, 300), declaredKey: KEY2 }), /key changed/);
fails("the merge built with another bun than budgets.json pins", transition({ n: S(1), m: S(1), key: KEY2, nKey: KEY2, declaredKey: KEY2 }), /pins 1\.4\.4/);
// ---- the bootstrap (PR A)
{
  const n = S(100000, 5000, 300);
  const B = budgets({ sizes: { "cli/pyjs.cjs": 100000, "engine/w.js": 5000 }, max: 300 });
  const legacy = { measured: { ...n, "cli/pyjs.cjs": 99989 }, recorded: { ...n, "cli/pyjs.cjs": 99992 } };
  const N = rec(BASE, n);
  N.neutral["cli/pyjs.cjs"] = 11;
  const boot = (B2, lg = legacy, m = n) => evaluate({ mode: "transition", merge: { record: rec(MERGE, m), budgets: B2, markers: [] }, declaredNode: "24.21.0", base: { commit: BASE, record: N, budgets: null, declaredKey: { bun: null, node: "24.21.0", measure_sha256: null } }, legacy: lg, markerDiff: [] });
  const r = boot(B);
  passes("the bootstrap with epoch = the rebuilt base", r);
  check("the bootstrap: the legacy file's upper-bound slack is noted", r.notes.some((x) => /over its build/.test(x)));
  const B1 = clone(B);
  B1.epoch.sizes["cli/pyjs.cjs"] = 100001;
  fails("the bootstrap, epoch off by 1", boot(B1), /epoch must equal/);
  const B3 = clone(B);
  B3.bundles["cli/packages.gen.js"].max = 301;
  fails("the bootstrap, an exact max off by 1", boot(B3), /max must equal/);
  fails("the bootstrap, a cross-check mismatch", boot(B, { ...legacy, measured: { ...legacy.measured, "cli/pyjs.cjs": 99990 } }), /cross-check/);
  fails("the bootstrap, the base measuring over its size-budget.json", boot(B, { ...legacy, recorded: { ...legacy.recorded, "cli/pyjs.cjs": 99988 } }), /over its size-budget|> its size-budget/);
  fails("the bootstrap without the legacy measurement", boot(B, null), /cross-check/);
  fails("the bootstrap, growth without a marker", boot(B, legacy, S(100001, 5000, 300)), /needs a marker/);
}
// ---- epoch resets (r5 §1.3 rule 5)
function resetCase({ O, N, M, growth = {}, keyChanged = true, markers = [], map = [], added = [], removed = [], baseB, B, old, mutate }) {
  baseB ??= budgets({ sizes: { "cli/pyjs.cjs": 100000, "engine/w.js": 5000 } });
  B ??= clone(baseB);
  B.epoch = { sizes: Object.fromEntries(Object.keys(B.bundles).filter((k) => !B.bundles[k].exact).map((k) => [k, M[k]])), reset: { reason: "bun 1.4.5", prev: epochHash(baseB.epoch), growth, map, added, removed } };
  for (const k of Object.keys(B.epoch.sizes)) B.bundles[k].ceiling = Math.max(B.bundles[k].ceiling, B.epoch.sizes[k]);
  mutate?.(B);
  return evaluate({
    mode: "transition",
    merge: { record: rec(MERGE, M, keyChanged ? KEY2 : KEY), budgets: { ...B, toolchain: { bun: keyChanged ? "1.4.5" : "1.4.4" } }, markers },
    declaredNode: "24.21.0",
    base: { commit: BASE, record: rec(BASE, N, keyChanged ? KEY2 : KEY), budgets: baseB, declaredKey: KEY },
    old: old !== undefined ? old : keyChanged ? rec(BASE, O, KEY) : null,
    markerDiff: [],
  });
}
const R = (pyjs, w = 5000, pk = 300) => S(pyjs, w, pk);
fails("astra's first example, growth 1000", resetCase({ O: R(100000), N: R(101000), M: R(102000), growth: { "cli/pyjs.cjs": 1000 } }), /not within charge 2000/);
passes("astra's first example, growth 2000", resetCase({ O: R(100000), N: R(101000), M: R(102000), growth: { "cli/pyjs.cjs": 2000 } }));
passes("astra's first example, growth 2000 + marker_slack", resetCase({ O: R(100000), N: R(101000), M: R(102000), growth: { "cli/pyjs.cjs": 3024 } }));
fails("astra's first example, one past the slack", resetCase({ O: R(100000), N: R(101000), M: R(102000), growth: { "cli/pyjs.cjs": 3025 } }), /not within/);
passes("astra's second example (ΔT 5000, ΔI 1000), growth 6000", resetCase({ O: R(100000), N: R(105000), M: R(106000), growth: { "cli/pyjs.cjs": 6000 } }));
passes("astra's r4 example: ΔT +1000, ΔI −1000, growth 1000, epoch unchanged", resetCase({ O: R(100000), N: R(101000), M: R(100000), growth: { "cli/pyjs.cjs": 1000 } }));
fails("astra's r4 example, growth 999", resetCase({ O: R(100000), N: R(101000), M: R(100000), growth: { "cli/pyjs.cjs": 999 } }), /not within/);
fails("ΔT −1000 doesn't offset ΔI +1000", resetCase({ O: R(100000), N: R(99000), M: R(100000), growth: {} }), /needs epoch\.reset\.growth/);
passes("a zero-byte toolchain reset: no growth entries, epoch unchanged", resetCase({ O: R(100000), N: R(100000), M: R(100000) }));
passes("a zero-byte release reset (same key)", resetCase({ O: R(100000), N: R(100000), M: R(100000), keyChanged: false }));
fails("a charge of 0 with an entry over the slack", resetCase({ O: R(100000), N: R(100000), M: R(100000), growth: { "cli/pyjs.cjs": 1025 } }), /not within/);
fails("a reset that leaves a marker", resetCase({ O: R(100000), N: R(100000), M: R(100000), markers: [mk({ "cli/pyjs.cjs": 1 })] }), /\.growth\/ empty/);
fails("a key change with no old-key record: fails closed", resetCase({ O: R(100000), N: R(100000), M: R(100000), old: null }), /fails closed/);
fails("a growth entry for no group", resetCase({ O: R(100000), N: R(100000), M: R(100000), growth: { "cli/nope.js": 5 } }), /not a group/);
fails("epoch.sizes ≠ the merge after a reset", resetCase({ O: R(100000), N: R(100000), M: R(100000), mutate: (B) => (B.epoch.sizes["cli/pyjs.cjs"] = 99999) }), /must equal the merge/);
{
  // eligibility
  const baseB = budgets();
  const B = clone(baseB);
  B.epoch.reset = { reason: "old reset", prev: "f".repeat(64), growth: {}, map: [], added: [], removed: [] };
  const persisted = clone(B);
  fails("prev ≠ the base's epoch block (a reset rebased across another)", transition({ n: S(100000), m: S(100000), B, baseB }), /without a new reset declaration/);
  fails("a persisted epoch.reset on an ordinary later PR: markers needed", transition({ n: S(100000), m: S(101000), B: persisted, baseB: persisted }), /needs a marker/);
  const B2 = clone(baseB);
  B2.epoch.sizes["cli/pyjs.cjs"] = 101000;
  fails("an epoch.sizes edit without epoch.reset", transition({ n: S(100000), m: S(101000), B: B2, baseB }), /without a new reset declaration/);
}
{
  // the key map: rename, join, split, exact rename, and the refusals
  const baseB = budgets({ sizes: { "engine/a.js": 100, "engine/w.js": 5000 } });
  const B = budgets({ sizes: { "engine/b.js": 120, "engine/w.js": 5000 } });
  const O = { "engine/a.js": 100, "engine/w.js": 5000, "cli/packages.gen.js": 300 };
  const N = { "engine/b.js": 110, "engine/w.js": 5000, "cli/packages.gen.js": 300 };
  const M = { "engine/b.js": 120, "engine/w.js": 5000, "cli/packages.gen.js": 300 };
  passes("a rename A → B (O 100, N 110, M 120), growth 20", resetCase({ O, N, M, baseB, B, map: [{ old: ["engine/a.js"], new: ["engine/b.js"] }], growth: { "engine/b.js": 20 } }));
  fails("a rename A → B, growth 19", resetCase({ O, N, M, baseB, B, map: [{ old: ["engine/a.js"], new: ["engine/b.js"] }], growth: { "engine/b.js": 19 } }), /charge 20/);
  fails("a rename with no map entry (an unmatched key)", resetCase({ O, N, M, baseB, B }), /no place/);
  fails("a key in two entries", resetCase({ O, N, M, baseB, B, map: [{ old: ["engine/a.js"], new: ["engine/b.js"] }, { old: ["engine/a.js"], new: ["engine/w.js"] }] }), /two places/);
  const joinB = budgets({ sizes: { "engine/ab.js": 300 } });
  passes("a join", resetCase({ O: { "engine/a.js": 100, "engine/w.js": 200, "cli/packages.gen.js": 300 }, N: { "engine/ab.js": 300, "cli/packages.gen.js": 300 }, M: { "engine/ab.js": 300, "cli/packages.gen.js": 300 }, baseB: budgets({ sizes: { "engine/a.js": 100, "engine/w.js": 200 } }), B: joinB, map: [{ old: ["engine/a.js", "engine/w.js"], new: ["engine/ab.js"] }] }));
  const splitB = budgets({ sizes: { "engine/a1.js": 60, "engine/a2.js": 40, "engine/w.js": 5000 } });
  passes("a split", resetCase({ O, N: { "engine/a1.js": 60, "engine/a2.js": 40, "engine/w.js": 5000, "cli/packages.gen.js": 300 }, M: { "engine/a1.js": 60, "engine/a2.js": 40, "engine/w.js": 5000, "cli/packages.gen.js": 300 }, baseB, B: splitB, map: [{ old: ["engine/a.js"], new: ["engine/a1.js", "engine/a2.js"] }] }));
  const mixB = budgets({ sizes: { "engine/w.js": 5000 }, bundles: { "engine/b.js": { exact: true, max: 120 } } });
  fails("an exact/non-exact mix", resetCase({ O, N, M, baseB, B: mixB, map: [{ old: ["engine/a.js"], new: ["engine/b.js"] }] }), /mixes exact/);
  const slackB = budgets({ sizes: { "engine/a1.js": 60, "engine/a2.js": 40, "engine/w.js": 5000 } });
  slackB.bundles["engine/a2.js"].marker_slack = 512;
  fails("a merged group with different marker_slack", resetCase({ O, N: { "engine/a1.js": 60, "engine/a2.js": 40, "engine/w.js": 5000, "cli/packages.gen.js": 300 }, M: { "engine/a1.js": 60, "engine/a2.js": 40, "engine/w.js": 5000, "cli/packages.gen.js": 300 }, baseB, B: slackB, map: [{ old: ["engine/a.js"], new: ["engine/a1.js", "engine/a2.js"] }] }), /different marker_slack/);
  // an exact rename: exactness carried; growth needs a raise of max
  const exBase = budgets({ sizes: { "engine/w.js": 5000 } }), exB = budgets({ sizes: { "engine/w.js": 5000 } });
  delete exB.bundles["cli/packages.gen.js"];
  exB.bundles["cli/pkgs.gen.js"] = { exact: true, max: 300 };
  const eO = { "engine/w.js": 5000, "cli/packages.gen.js": 300 }, eN = { "engine/w.js": 5000, "cli/pkgs.gen.js": 300 };
  passes("an exact rename, no growth", resetCase({ O: eO, N: eN, M: eN, baseB: exBase, B: exB, map: [{ old: ["cli/packages.gen.js"], new: ["cli/pkgs.gen.js"] }] }));
  fails("an exact rename that grows, without a raise of max", resetCase({ O: eO, N: eN, M: { ...eN, "cli/pkgs.gen.js": 301 }, baseB: exBase, B: exB, map: [{ old: ["cli/packages.gen.js"], new: ["cli/pkgs.gen.js"] }] }), /max/);
  // an exact split whose aggregate is fine but one key is over its own max
  const spB = budgets({ sizes: { "engine/w.js": 5000 } });
  delete spB.bundles["cli/packages.gen.js"];
  spB.bundles["cli/p1.js"] = { exact: true, max: 150 };
  spB.bundles["cli/p2.js"] = { exact: true, max: 150 };
  fails("an exact split, one key over its own max", resetCase({ O: eO, N: { "engine/w.js": 5000, "cli/p1.js": 160, "cli/p2.js": 140 }, M: { "engine/w.js": 5000, "cli/p1.js": 160, "cli/p2.js": 140 }, baseB: exBase, B: spB, map: [{ old: ["cli/packages.gen.js"], new: ["cli/p1.js", "cli/p2.js"] }] }), /cli\/p1\.js: 160 > max 150/);
  // a sum past the safe-integer range
  const big = Number.MAX_SAFE_INTEGER - 10;
  const bigBase = budgets({ sizes: { "engine/a1.js": 1, "engine/a2.js": 1 } });
  for (const k of ["engine/a1.js", "engine/a2.js"]) (bigBase.bundles[k].ceiling = big), (bigBase.epoch.sizes[k] = big);
  fails("a sum past Number.MAX_SAFE_INTEGER", resetCase({ O: { "engine/a1.js": big, "engine/a2.js": big, "cli/packages.gen.js": 300 }, N: { "engine/a.js": 5, "cli/packages.gen.js": 300 }, M: { "engine/a.js": 5, "cli/packages.gen.js": 300 }, baseB: bigBase, B: budgets({ sizes: { "engine/a.js": 5 } }), map: [{ old: ["engine/a1.js", "engine/a2.js"], new: ["engine/a.js"] }] }), /safe-integer/);
  check("resetGroups: identity for unchanged names", resetGroups(budgets(), budgets(), { map: [], added: [], removed: [] }).groups.map((g) => g.name).sort().join(",") === "cli/packages.gen.js,cli/pyjs.cjs,engine/w.js");
}
// ---- the range rule (r5 §1.3 rule 6)
function range({ n, m, markers, k = 2, epochChanged = false, key = KEY }) {
  return evaluate({ mode: "range", merge: { record: rec(MERGE, m), budgets: budgets(), markers }, declaredNode: "24.21.0", base: { commit: BASE, record: rec(BASE, n, key), budgets: budgets(), declaredKey: KEY }, markerDiff: markers.map((x) => ({ status: "A", path: x.path })), range: { k, epochChanged } });
}
const two = [mk({ "cli/pyjs.cjs": 2024 }, ".growth/a.json"), mk({ "cli/pyjs.cjs": 2024 }, ".growth/b.json")];
passes("astra's trace: two +1000 transitions with 2024 markers (no range tightness)", range({ n: S(100000), m: S(102000), markers: two }));
passes("growth then shrink", range({ n: S(100000), m: S(100500), markers: [mk({ "cli/pyjs.cjs": 1000 })] }));
fails("a range short of authorization by 1", range({ n: S(100000), m: S(101001), markers: [mk({ "cli/pyjs.cjs": 1000 })] }), /rule 6/);
fails("a range containing a reset, even when the final tree passes", range({ n: S(100000), m: S(100000), markers: [], epochChanged: true }), /epoch reset/);
fails("a range that changes the key", range({ n: S(100000), m: S(100000), markers: [], key: KEY2 }), /key/);
check("a range is flagged", range({ n: S(1), m: S(1), markers: [] }).notes.some((x) => /outside the single-writer/.test(x)));
// ---- the absolute checks (schedule, dispatch)
passes("absolute: within", evaluate({ mode: "absolute", merge: { record: rec(MERGE, S(100000)), budgets: budgets(), markers: [] }, declaredNode: "24.21.0" }));
fails("absolute: over the ledger", evaluate({ mode: "absolute", merge: { record: rec(MERGE, S(100001)), budgets: budgets(), markers: [] }, declaredNode: "24.21.0" }), /rule 3/);
// ---- docs-only inputs (r5 §1.5)
for (const f of ["budgets.json", ".github/workflows/optional.yml", "scripts/ci-paths.mjs", "pnpm-lock.yaml", ".growth/x.json", "scripts/size-measure.mjs", "heap-budget.json", "core-api-surface.json"]) check(`docs-only: ${f} is a gate input`, gateInputs([f]).length === 1);
check("docs-only: design/x.md is not a gate input", gateInputs(["design/x.md", "README.md"]).length === 0);
// ---- normalization (r5 §1.6)
{
  const dir = mkdtempSync(join(tmpdir(), "size-measure-test-"));
  try {
    const write = (name, version, id, extra = "") => {
      const f = join(dir, name);
      writeFileSync(f, `globalThis.__SAGEBRUSH_BUILD_ID__ = ${JSON.stringify(id)};\nglobalThis.__SAGEBRUSH_VERSION__ = ${JSON.stringify(version)};\nlib();${extra}\n`);
      return f;
    };
    const expected = { "cli/lib.gen.js": { VERSION: 1, BUILD_ID: 1 } };
    const size = (version, id, extra) => {
      const m = measureFiles({ "cli/lib.gen.js": [write("lib.gen.js", version, id, extra)] }, dir, { VERSION: version, BUILD_ID: id }, {}, expected);
      return { size: m.sizes["cli/lib.gen.js"], problems: m.problems };
    };
    const a = size("0.9.9", "0123456789abcdef"), b = size("0.10.0", "0123456789abcdef"), c = size("0.10.0-rc.1", "fedcba9876543210");
    check("normalization: 0.9.9 → 0.10.0 → 0.10.0-rc.1 and a build id change give Δ 0", a.size === b.size && b.size === c.size && !a.problems.length, `${a.size} ${b.size} ${c.size}`);
    check("normalization: the value counts as NEUTRAL_WIDTH", a.size === size("0.9.9", "0123456789abcdef").size && NEUTRAL_WIDTH === 16);
    check("normalization: an unrelated literal \"0.9.9\" still counts", size("0.9.9", "0123456789abcdef", ' x("0.9.9");').size === a.size + ' x("0.9.9");'.length);
    check("normalization: an added field still counts", size("0.9.9", "0123456789abcdef", " globalThis.__SAGEBRUSH_OTHER__ = 1;").size > a.size);
    check("normalization: an assignment beyond the count fails", size("0.9.9", "0123456789abcdef", ' globalThis.__SAGEBRUSH_VERSION__ = "0.9.9";').problems.some((p) => /VERSION/.test(p)));
    const m0 = measureFiles({ "cli/lib.gen.js": [(() => { const f = join(dir, "none.js"); writeFileSync(f, "lib();\n"); return f; })()] }, dir, { VERSION: "0.9.9", BUILD_ID: "x" }, {}, expected);
    check("normalization: a missing assignment fails", m0.problems.length === 2);
    check("normalization: the minified form", countAssignments('globalThis.__SAGEBRUSH_VERSION__="0.9.9",globalThis.__SAGEBRUSH_VERSION__=`0.9.9`', "VERSION", "0.9.9") === 2);
    check("normalization: only the known value", countAssignments('globalThis.__SAGEBRUSH_VERSION__="0.9.8"', "VERSION", "0.9.9") === 0);
    const other = measureFiles({ "engine/w.js": [write("w.js", "0.9.9", "0123456789abcdef")] }, dir, { VERSION: "0.9.9", BUILD_ID: "0123456789abcdef" }, {}, expected);
    check("normalization: an assignment in a bundle not listed fails", other.problems.some((p) => /engine\/w\.js/.test(p)));
    check("normalization: the checkout path isn't counted", measureFiles({ "x": [(() => { const f = join(dir, "p.js"); writeFileSync(f, `a${dir}b`); return f; })()] }, dir, { VERSION: "v", BUILD_ID: "i" }, {}, {}).sizes.x === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// ---- base selection and the merge protocol, in a scratch repository (r5 §1.1, §3.2)
{
  const dir = mkdtempSync(join(tmpdir(), "size-measure-git-"));
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  try {
    const origin = join(dir, "origin.git"), w = join(dir, "w");
    g(dir, "init", "-q", "--bare", "-b", "master", origin);
    g(dir, "clone", "-q", origin, w);
    const commit = (msg) => (writeFileSync(join(w, "f"), msg), g(w, "add", "f"), g(w, "commit", "-q", "-m", msg), g(w, "rev-parse", "HEAD"));
    const A0 = commit("a0");
    g(w, "push", "-q", "origin", "HEAD:master");
    const B = commit("b");
    g(w, "push", "-q", "origin", "HEAD:master");
    g(w, "checkout", "-q", "-b", "pr", A0);
    const H = commit("h");
    g(w, "checkout", "-q", "--detach", B);
    g(w, "merge", "-q", "--no-ff", "--no-edit", "-X", "theirs", H);
    const Mg = g(w, "rev-parse", "HEAD");
    // base selection
    const t = testedTransition({ cwd: w, name: "pull_request", ev: { pull_request: { head: { sha: H } } } });
    check("base selection: a pull request's base is HEAD^1", t.mode === "transition" && t.base === B && t.head === H);
    check("base selection: HEAD^2 ≠ the event's head fails", (() => { try { testedTransition({ cwd: w, name: "pull_request", ev: { pull_request: { head: { sha: A0 } } } }); return false; } catch { return true; } })());
    check("base selection: a merge_group base ≠ HEAD^1 fails", (() => { try { testedTransition({ cwd: w, name: "merge_group", ev: { merge_group: { base_sha: A0 } } }); return false; } catch { return true; } })());
    check("base selection: a merge_group base = HEAD^1", testedTransition({ cwd: w, name: "merge_group", ev: { merge_group: { base_sha: B } } }).base === B);
    check("base selection: a schedule run is absolute", testedTransition({ cwd: w, name: "schedule", ev: {} }).mode === "absolute");
    check("base selection: a first push (zero before) is absolute", testedTransition({ cwd: w, name: "push", ev: { before: "0".repeat(40) } }).mode === "absolute");
    check("base selection: a push of one transition", testedTransition({ cwd: w, name: "push", ev: { before: B } }).mode === "transition");
    const r = testedTransition({ cwd: w, name: "push", ev: { before: A0 } });
    check("base selection: a multi-transition push uses the range rule", r.mode === "range" && r.k === 2, jcs(r));
    g(w, "checkout", "-q", "--detach", H);
    check("base selection: a head checkout (one parent) fails", (() => { try { testedTransition({ cwd: w, name: "pull_request", ev: { pull_request: { head: { sha: H } } } }); return false; } catch (e) { return /two-parent/.test(e.message); } })());
    // the lease (astra's probe): master moved B → H, an ancestor of the merge
    g(w, "push", "-q", "--force", "origin", `${H}:refs/heads/master`);
    let plain = true;
    try { g(w, "push", "-q", "origin", `${Mg}:refs/heads/master`); } catch { plain = false; }
    check("the merge protocol: a plain push after B → H succeeds (the documented failure)", plain);
    g(w, "push", "-q", "--force", "origin", `${H}:refs/heads/master`);
    let lease = true;
    try { g(w, "push", "-q", `--force-with-lease=refs/heads/master:${B}`, "origin", `${Mg}:refs/heads/master`); } catch { lease = false; }
    check("the merge protocol: the lease push after B → H is rejected", !lease);
    g(w, "push", "-q", "--force", "origin", `${A0}:refs/heads/master`);
    lease = true;
    try { g(w, "push", "-q", `--force-with-lease=refs/heads/master:${B}`, "origin", `${Mg}:refs/heads/master`); } catch { lease = false; }
    check("the merge protocol: master reset to an ancestor of B rejects the lease", !lease);
    g(w, "checkout", "-q", "--detach", B);
    const D = commit("divergent");
    g(w, "push", "-q", "--force", "origin", `${D}:refs/heads/master`);
    lease = true;
    try { g(w, "push", "-q", `--force-with-lease=refs/heads/master:${B}`, "origin", `${Mg}:refs/heads/master`); } catch { lease = false; }
    check("the merge protocol: a divergent tip rejects the lease", !lease);
    g(w, "push", "-q", "--force", "origin", `${B}:refs/heads/master`);
    lease = true;
    try { g(w, "push", "-q", `--force-with-lease=refs/heads/master:${B}`, "origin", `${Mg}:refs/heads/master`); } catch { lease = false; }
    check("the merge protocol: master at B: the lease push lands B → M", lease && g(origin, "rev-parse", "refs/heads/master") === Mg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`test-size-measure: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
