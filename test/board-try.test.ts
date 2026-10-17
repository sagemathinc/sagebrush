import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sagebrush board try: a board's questions tried with given answers, for an
// evaluator (src/board-try.ts, lib/_sb_check.py, the session's `evaluate`).
const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-board-try-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: dir, timeout: 180_000 });
const file = (name: string, d: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(d)); return f; };

const BOARD = {
  format: "sagebrush-board", version: 1, title: "Sums",
  nodes: [
    { id: "c1", code: "xs = [1, 2, 3]" },
    { id: "c2", code: "ys = []\ndef grow():\n    ys.append(1)" },
    { id: "q1", kind: "ask", text: "The sum of $1, 2, 3$?", input: "text",
      check: "s = sum(xs)\nxs.append(99)\nTrue if answer.strip() == str(s) else f'Not {answer}: add the list'",
      hints: ["Add them up.", { code: "f'You wrote {answer}.'" }], next: { right: "yes", wrong: "no" } },
    { id: "q2", kind: "ask", text: "Divide", input: "text", check: "1/0" },
    { id: "q3", kind: "ask", text: "Forever", input: "text", check: "while True:\n    pass", checkMs: 300 },
    { id: "q4", kind: "ask", text: "Grow", input: "text", check: "grow()\nTrue" },
    { id: "q5", kind: "ask", text: "No verdict", input: "text", check: "x = 1" },
    { id: "yes", text: "Right!" }, { id: "no", text: "Try again." },
  ],
};

test("board try: each case checked from the board's state, its verdict, message, branch and errors; notes not checked; hints; a sequence saved and read back", () => {
  const f = file("sums.board.json", BOARD);
  const cases = file("cases.json", {
    checks: [
      { case_id: "r", ask_id: "q1", answer: " 6 " },
      { case_id: "w", ask_id: "q1", answer: "5" },
      { case_id: "r2", ask_id: "q1", answer: "6" },
      { case_id: "en", ask_id: "q1", note: "I don't know how to add" },
      { case_id: "en+r", ask_id: "q1", answer: "6", note: "I added them" },
      { case_id: "zero", ask_id: "q2", answer: "1" },
      { case_id: "slow", ask_id: "q3", answer: "1" },
      { case_id: "after-slow", ask_id: "q1", answer: "6" },
      { case_id: "grow", ask_id: "q4", answer: "1" },
      { case_id: "none", ask_id: "q5", answer: "1" },
    ],
    sequences: [{ ask_id: "q1", answers: ["5", "4", "6"] }],
  });
  const r = run(["board", "try", f, "--cases", cases, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.schema_version, 1);
  assert.equal(j.complete, true);
  assert.match(j.board_sha256, /^[0-9a-f]{64}$/);
  assert.equal(j.validation.ok, true, JSON.stringify(j.validation));
  assert.deepEqual(j.code.map((c: any) => [c.id, c.ok]), [["c1", true], ["c2", true]]);
  const by = Object.fromEntries(j.checks.map((c: any) => [c.case_id, c]));
  // (right; and its mutation of a copied list never reaches the board: the next case starts from the same state)
  assert.deepEqual([by.r.outcome, by.r.raw_result, by.r.next, by.r.scope_preserved, by.r.isolation, by.r.check_invoked], ["right", true, "yes", true, "copy", true]);
  assert.deepEqual([by.w.outcome, by.w.raw_result, by.w.message, by.w.next], ["wrong", "Not 5: add the list", "Not 5: add the list", "no"]);
  assert.equal(by.r2.outcome, "right");
  assert.deepEqual([by.en.outcome, by.en.check_invoked, by.en.raw_result, by.en.next, by.en.note], ["in words", false, null, null, "I don't know how to add"]);
  assert.deepEqual([by["en+r"].outcome, by["en+r"].note], ["right", "I added them"]);
  // (errors stay errors: an exception, a deadline, no verdict; never "wrong")
  assert.deepEqual([by.zero.outcome, by.zero.raw_result], ["error", null]);
  assert.match(by.zero.error, /ZeroDivisionError/);
  assert.deepEqual([by.slow.outcome, by.slow.timed_out], ["error", true]);
  assert.equal(by["after-slow"].outcome, "right");
  assert.equal(by.none.outcome, "error");
  assert.match(by.none.error, /not True, False or a message/);
  // (a check that changes the board through a function it shares: said, not hidden)
  assert.equal(by.grow.scope_preserved, false);
  // hints: one record each, a computed one with the first wrong answer
  assert.deepEqual(j.hints.filter((h: any) => h.ask_id === "q1").map((h: any) => [h.index, h.rendered, h.error]), [[0, "Add them up.", null], [1, "You wrote 5.", null]]);
  // a sequence: wrong, wrong, right; the hints shown; its progress saved and read back
  assert.deepEqual(j.interaction, [{ ask_id: "q1", sequence: ["wrong", "wrong", "right"], hints_shown: [0, 1], attempts_after_reload: 3, result_after_reload: "right", answer_preserved_after_reload: true }]);
});

test("board try: a case whose names can't be copied runs alone; inline --case; cases refused before anything runs", () => {
  const b = { format: "sagebrush-board", version: 1, nodes: [{ id: "g", code: "gen = (i for i in range(3))" }, { id: "q", kind: "ask", text: "Q", input: "number", check: "answer == 2" }] };
  const f = file("gen.board.json", b);
  let r = run(["board", "try", f, "--case", "q=2", "--case", "q=3", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome, c.isolation]), [["case-1", "right", "rerun"], ["case-2", "wrong", "rerun"]]);
  // refused: a case naming no question, a case_id twice, a case with neither answer nor note, no cases
  const refuse = (cases: unknown, why: RegExp, status = 1) => { const x = run(["board", "try", f, "--cases", file("bad.json", cases)]); assert.equal(x.status, status, x.stderr); assert.match(x.stderr, why); };
  refuse({ checks: [{ case_id: "a", ask_id: "nope", answer: 1 }] }, /no question has the id "nope"/);
  refuse({ checks: [{ case_id: "a", ask_id: "q", answer: 1 }, { case_id: "a", ask_id: "q", answer: 2 }] }, /the case_id "a" is there twice/);
  refuse({ checks: [{ case_id: "a", ask_id: "q" }] }, /an answer, or a note/);
  // (each answer of a sequence counts as a case: one long sequence can't pass the cap, HARD-A19-2)
  refuse({ sequences: [{ ask_id: "q", answers: Array.from({ length: 10_001 }, () => 1) }] }, /more than 10000 cases, counting each answer of a sequence/);
  refuse({ checks: Array.from({ length: 6000 }, (_, i) => ({ case_id: `c${i}`, ask_id: "q", answer: 1 })), sequences: [{ ask_id: "q", answers: Array.from({ length: 4001 }, () => 1) }] }, /counting each answer of a sequence/);
  // (no cases, and no question with an example: nothing to try)
  const none = run(["board", "try", f]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /nothing to try: no question has an `example`/);
  assert.equal(run(["board", "try", f, "--case", "q"]).status, 2);
});

test("board try: with no cases, each question's example", () => {
  const b = { format: "sagebrush-board", version: 1, nodes: [{ id: "c", code: "n = 2" }, { id: "q", kind: "ask", text: "Q", input: "number", check: "answer == n", example: 2 },
    { id: "w", kind: "ask", text: "W", input: "text", check: "answer == 'yes'", example: "no" }, { id: "plain", kind: "ask", text: "P", input: "text" }] };
  const r = run(["board", "try", file("ex.board.json", b), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).checks.map((c: any) => [c.case_id, c.ask_id, c.outcome]), [["example-q", "q", "right"], ["example-w", "w", "wrong"]]);
});
