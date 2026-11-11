import test from "node:test";
import assert from "node:assert/strict";
import { cases, censusProblems, freshProblems, outcomeHash, rowProblems, runFile, scopeProblems, type Known, type Row } from "./sprig-corpus-run";

// The corpus runner's negative controls (the grader's condition 1 on the S1 plan, Nov 9): each planted fault must fail
// the run, so a runner that says "pass" without comparing is caught.  Each control has its passing twin.
const F = "sprig-tests/core/test_1.sprig";
const exists = (f: string) => f !== "sprig-tests/core/test_9.sprig";
const ids = () => ["c1", "c2"];
const entry = (o: { result: string; output: string }, cls = "not-implemented"): Known => ({ class: cls, reason: "Print's output form (S1.3)", sha256: outcomeHash(o) });

test("SCOPE: a missing file, a file listed twice and a held-out file each fail; a good scope passes", () => {
  assert.deepEqual(scopeProblems([F], {}, exists, ids), []);
  assert.match(scopeProblems([F, "sprig-tests/core/test_9.sprig"], {}, exists, ids).join("\n"), /doesn't exist/);
  assert.match(scopeProblems([F, F], {}, exists, ids).join("\n"), /lists a file twice/);
  assert.match(scopeProblems([F, "sprig-tests/heldout/s1/test_1.sprig"], {}, () => true, ids).join("\n"), /held out/);
});

test("KNOWN: an entry for no scoped case, an unknown class and a not-implemented entry naming no PR each fail", () => {
  const o = { result: "x", output: "" };
  assert.match(scopeProblems([F], { [`${F}#c9`]: entry(o) }, exists, ids).join("\n"), /not a case of a scoped file/);
  assert.match(scopeProblems([F], { [`${F}#c1`]: entry(o, "close-enough") }, exists, ids).join("\n"), /can't check/);
  assert.match(scopeProblems([F], { [`${F}#c1`]: { ...entry(o), reason: "later" } }, exists, ids).join("\n"), /names the PR or slice/);
  assert.deepEqual(scopeProblems([F], { [`${F}#c1`]: entry(o) }, exists, ids), []);
});

test("rows: a difference not in KNOWN, a KNOWN case now exact, and a KNOWN case whose output changed each fail", () => {
  const want = { result: "x ^ 2", output: "" }, ours = { result: "x^2", output: "" };
  const row = (o: typeof ours): Record<string, Row> => ({ c1: { id: "c1", ours: o, want } });
  assert.match(rowProblems(F, row(ours), {}).problems.join("\n"), /differs from the oracle/);
  assert.deepEqual(rowProblems(F, row(want), {}).problems, []);
  assert.match(rowProblems(F, row(want), { [`${F}#c1`]: entry(want) }).problems.join("\n"), /now exact; remove it from KNOWN.json/);
  assert.match(rowProblems(F, row({ result: "x^3", output: "" }), { [`${F}#c1`]: entry(ours) }).problems.join("\n"), /changed inside a known difference/);
  assert.deepEqual(rowProblems(F, row(ours), { [`${F}#c1`]: entry(ours) }).problems, []);
});

test("rows: a value class whose check fails, or wasn't run, fails", () => {
  const want = { result: "b + a", output: "" }, ours = { result: "a + b", output: "" };
  const k = { [`${F}#c1`]: entry(ours, "term-order") };
  assert.match(rowProblems(F, { c1: { id: "c1", ours, want, check: [false, "mismatch"] } }, k).problems.join("\n"), /term-order check fails/);
  assert.match(rowProblems(F, { c1: { id: "c1", ours, want } }, k).problems.join("\n"), /check fails \(not run\)/);
  assert.deepEqual(rowProblems(F, { c1: { id: "c1", ours, want, check: [true, "term-order"] } }, k).problems, []);
});

test("fresh sessions: a planted leak (one session for every case) is caught by the one-process-per-case check", () => {
  const list: [string, string][] = [["c1", "a = 5"], ["c2", "a + 1"]];
  const leaked = runFile(F, { cases: list, leak: true, recorded: false });
  assert.equal(leaked.c2.ours.result, "6", "the planted leak leaks");
  assert.match(freshProblems(F, leaked, () => true, undefined, list).join("\n"), /c2: a process of its own differs/);
  const fresh = runFile(F, { cases: list, recorded: false });
  assert.equal(fresh.c2.ours.result, "1 + a");
  assert.deepEqual(freshProblems(F, fresh, () => true, undefined, list), []);
});

test("the census: a character left after the normalization fails unless its case is KNOWN", () => {
  const left = [{ file: F, id: "c1", chars: ["\u2192"] }];
  assert.match(censusProblems(left, {}).join("\n"), /c1: the oracle's \u2192 outside a string/);
  assert.deepEqual(censusProblems(left, { [`${F}#c1`]: entry({ result: "x", output: "" }) }), []);
  assert.deepEqual(censusProblems([], {}), []);
});

// (the grader's ruling on #1037: a reference inconsistency names its witness, another exact case of its file, and ours
// must be exactly the witness's recorded outcome)
test("KNOWN reference-inconsistency: a missing, self or known witness fails; ours unlike the witness's outcome fails; the twin passes", () => {
  const o = { result: "{3, 4}", output: "" };
  const ri = (witness?: string): Known => ({ class: "reference-inconsistency", reason: "the oracle answers the equivalent form", sha256: outcomeHash(o), witness });
  assert.match(scopeProblems([F], { [`${F}#c1`]: ri() }, exists, ids).join("\n"), /names its witness/);
  assert.match(scopeProblems([F], { [`${F}#c1`]: ri("c1") }, exists, ids).join("\n"), /names its witness/);
  assert.match(scopeProblems([F], { [`${F}#c1`]: ri("c3") }, exists, ids).join("\n"), /names its witness/);
  assert.match(scopeProblems([F], { [`${F}#c1`]: ri("c2"), [`${F}#c2`]: entry(o) }, exists, ids).join("\n"), /itself a known case/);
  assert.deepEqual(scopeProblems([F], { [`${F}#c1`]: ri("c2") }, exists, ids), []);
  // (through the runner, on the recorded rules file: rules-12's witness is rules-14; rules-16's outcome is another)
  const R = "sprig-tests/rules/test_1.sprig";
  const pick = (ids: string[]) => cases(R).filter(([id]) => ids.includes(id));
  const good = runFile(R, { cases: pick(["rules-12"]), known: { [`${R}#rules-12`]: ri("rules-14") } });
  assert.deepEqual(good["rules-12"].check, [true, "the witness's recorded outcome"]);
  const bad = runFile(R, { cases: pick(["rules-12"]), known: { [`${R}#rules-12`]: ri("rules-16") } });
  assert.equal(bad["rules-12"].check![0], false);
  assert.match(rowProblems(R, bad, { [`${R}#rules-12`]: ri("rules-16") }).problems.join("\n"), /reference-inconsistency check fails/);
});
