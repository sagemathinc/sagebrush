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
  // (the board has a function: its state can't be shown unchanged, so null, with why, and each case fresh)
  assert.deepEqual([by.r.outcome, by.r.raw_result, by.r.next, by.r.scope_preserved, by.r.isolation, by.r.check_invoked], ["right", true, "yes", null, "rerun", true]);
  assert.match(by.r.scope_preserved_reason, /an interpreter of its own/);
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
  // (a check that changes the board through a function it shares: never said to be preserved)
  assert.deepEqual([by.grow.outcome, by.grow.scope_preserved, by.grow.isolation], ["right", null, "rerun"]);
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
  const refuse = (cases: unknown, why: RegExp, status = 2) => { const x = run(["board", "try", f, "--cases", file("bad.json", cases)]); assert.equal(x.status, status, x.stderr); assert.match(x.stderr, why); };
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

// astra2's CORR-A19-1, -2: every evaluation starts from the board's state just after its code ran
const one = (code: string, check: string, extra: any = {}) => ({ format: "sagebrush-board", version: 1, nodes: [{ id: "c", code }, { id: "q", kind: "ask", text: "Q", input: "number", check, ...extra }] });
const tryCases = (name: string, board: unknown, cases: unknown) => {
  const r = run(["board", "try", file(name + ".board.json", board), "--cases", file(name + ".cases.json", cases), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("board try: a helper's change to an object inside the board is seen; the next case starts from the board's state", () => {
  const b = one("class Box:\n    pass\nb = Box()\nb.x = []\ndef grow():\n    b.x.append(1)\ndef size():\n    return len(b.x)", "grow() if answer == 1 else None\nsize() == 0 if answer == 0 else True");
  const k = tryCases("object2", b, { checks: [{ case_id: "grow", ask_id: "q", answer: 1 }, { case_id: "size", ask_id: "q", answer: 0 }] });
  assert.deepEqual(k.checks.map((c: any) => [c.case_id, c.outcome, c.isolation, c.scope_preserved]), [["grow", "right", "rerun", null], ["size", "right", "rerun", null]]);
});

test("board try: a change the copy can't keep in (a method using the board's globals) is seen, and the board is run again before the next case", () => {
  const b = one("xs = []\nclass C:\n    def add(self):\n        xs.append(1)\nc = C()", "c.add() if answer == 1 else None\nxs == [] if answer == 0 else True");
  const j = tryCases("method", b, { checks: [{ case_id: "add", ask_id: "q", answer: 1 }, { case_id: "empty", ask_id: "q", answer: 0 }, { case_id: "again", ask_id: "q", answer: 0 }] });
  assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome, c.scope_preserved]), [["add", "right", null], ["empty", "right", null], ["again", "right", null]]);
});

test("board try: state in the board's own classes, functions, closures, dict keys and list subclasses: a change seen, the next case fresh (astra2's CORR-A19-1, at cb1a5279)", () => {
  const boards: [string, string, string][] = [
    ["class", "class Box:\n    xs = []", "len(Box.xs)"],
    ["function", "def f():\n    pass\nf.xs = []", "len(f.xs)"],
    ["closure", "def make():\n    xs = []\n    def g(add):\n        if add:\n            xs.append(1)\n        return len(xs)\n    return g\nf = make()", "f(False)"],
    ["dict-key", "class K:\n    def __init__(self):\n        self.xs = []\nholders = {K(): 1}", "len(next(iter(holders)).xs)"],
    ["list-attribute", "class L(list):\n    pass\nb = L([1])\nb.xs = []", "len(b.xs)"],
  ];
  const grow: Record<string, string> = { class: "Box.xs.append(1)", function: "f.xs.append(1)", closure: "f(True)", "dict-key": "next(iter(holders)).xs.append(1)", "list-attribute": "b.xs.append(1)" };
  for (const [name, code, size] of boards) {
    const j = tryCases("state-" + name, one(code, `${grow[name]} if answer == 1 else None\n${size} == 0 if answer == 0 else True`), { checks: [{ case_id: "grow", ask_id: "q", answer: 1 }, { case_id: "size", ask_id: "q", answer: 0 }] });
    assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome, c.scope_preserved]), [["grow", "right", null], ["size", "right", null]], name);
  }
});

test("board try: a board of plain values: shown unchanged (true), or changed (false), and then the next case fresh", () => {
  const b = one("xs = [1, (2, 'a')]\nd = {'k': 1.5, 2: None}", "__import__('__main__').xs.append(9) if answer == 1 else None\nxs == [1, (2, 'a')] if answer == 0 else True");
  const j = tryCases("plain", b, { checks: [{ case_id: "read", ask_id: "q", answer: 0 }, { case_id: "write", ask_id: "q", answer: 1 }, { case_id: "after", ask_id: "q", answer: 0 }] });
  assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome, c.scope_preserved]), [["read", "right", null], ["write", "right", null], ["after", "right", null]]);
});

test("board try: dict order, shared lists, the board's own dunder names: each case from the state the code leaves (astra2's CORR-A19-1, at 7294c800)", () => {
  const shapes: [string, string, string, string][] = [
    ["order", "d = {'a': 1, 'b': 2}", "m = __import__('__main__')\nv = m.d.pop('a')\nm.d['a'] = v", "list(d) == ['a', 'b']"],
    ["alias", "x = []\ny = x", "__import__('__main__').y = []", "x is y"],
    ["alias-inner", "x = [[]]\ny = x[0]", "__import__('__main__').x[0] = []", "x[0] is y"],
    ["dunder", "__state = []", "__state.append(1)", "__state == []"],
  ];
  for (const [name, code, change, base] of shapes) {
    // (the change only when the answer is 1: an if block around all of it)
    const guarded = "if answer == 1:\n" + change.split("\n").map((l) => "    " + l).join("\n") + "\n";
    const j = tryCases("shape-" + name, one(code, `${guarded}${base} if answer == 0 else True`), { checks: [{ case_id: "change", ask_id: "q", answer: 1 }, { case_id: "base", ask_id: "q", answer: 0 }] });
    assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome]), [["change", "right"], ["base", "right"]], name);
  }
});

test("board try: a state that can't be copied: each check, hint and sequence answer from the board's state run afresh", () => {
  const b = one("gen = (i for i in range(20))", "next(gen) == 0", { hints: [{ code: "str(next(gen))" }] });
  const j = tryCases("gen", b, { checks: [{ case_id: "a", ask_id: "q", answer: 0 }, { case_id: "b", ask_id: "q", answer: 0 }], sequences: [{ ask_id: "q", answers: [0, 0] }, { ask_id: "q", answers: [0] }] });
  assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome, c.isolation, c.scope_preserved]), [["a", "right", "rerun", null], ["b", "right", "rerun", null]]);
  assert.match(j.checks[0].scope_preserved_reason, /an interpreter of its own/);
  assert.deepEqual(j.hints.map((h: any) => h.rendered), ["0"]);
  assert.deepEqual(j.interaction.map((i: any) => i.sequence), [["right", "right"], ["right"]]);
});

test("board try: the verdict is the check's own (CORR-A19-3); a check's errors are no attempts (CORR-A19-6)", () => {
  let j = tryCases("slot", one("__sb_value__ = True", "x = 1"), { checks: [{ case_id: "a", ask_id: "q", answer: 1 }] });
  assert.deepEqual([j.checks[0].outcome, j.checks[0].raw_result], ["error", null]);
  assert.match(j.checks[0].error, /doesn't end with an expression/);
  j = tryCases("errs", one("n = 1", "1/0"), { sequences: [{ ask_id: "q", answers: [1, 2] }] });
  assert.deepEqual([j.interaction[0].sequence, j.interaction[0].attempts_after_reload], [["error", "error"], 0]);
});

test("board try: the contract's edges: --json refusals are reports; --case beside sequences; the engine named", () => {
  const f = file("edge.board.json", one("n = 2", "answer == n"));
  // (a refusal with --json: a report, incomplete, with its error; exit 2 for cases, 1 for a board that can't be read)
  let r = run(["board", "try", f, "--cases", file("dup.json", { checks: [{ case_id: "a", ask_id: "q", answer: 2 }, { case_id: "a", ask_id: "q", answer: 2 }] }), "--json"]);
  assert.equal(r.status, 2);
  let j = JSON.parse(r.stdout);
  assert.deepEqual([j.schema_version, j.complete, typeof j.error, typeof j.board_sha256], [1, false, "string", "string"]);
  r = run(["board", "try", file("notaboard.json", { hello: 1 }), "--json"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).complete, false);
  // (--case beside a file of sequences only)
  r = run(["board", "try", f, "--cases", file("seq.json", { sequences: [{ ask_id: "q", answers: [1, 2] }] }), "--case", "q=2", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  j = JSON.parse(r.stdout);
  assert.deepEqual([j.checks.map((c: any) => c.outcome), j.interaction[0].sequence], [["right"], ["wrong", "right"]]);
  assert.match(j.runtime.engine, /^cli-[0-9a-f]{20}$/);
});

test("board try: a check whose value is a verdict object (the board check helpers'): right, wrong with its reason, or can't decide, an error told apart", () => {
  const code = "class V:\n    def __init__(s, x):\n        s.x = x\n    def __sagebrush_verdict__(s):\n        if s.x == 'raise':\n            raise ValueError('bad')\n        return s.x";
  const check = "V(True) if answer == 1 else V('it is $2$, not $1$') if answer == 2 else V({'undecided': 'no proof either way'}) if answer == 3 else V('raise') if answer == 4 else V(5)";
  const j = tryCases("verdicts", one(code, check), { checks: [1, 2, 3, 4, 5].map((n) => ({ case_id: "c" + n, ask_id: "q", answer: n })) });
  assert.deepEqual(j.checks.map((c: any) => [c.case_id, c.outcome, c.undecided]), [["c1", "right", false], ["c2", "wrong", false], ["c3", "error", true], ["c4", "error", false], ["c5", "error", false]]);
  assert.equal(j.checks[1].message, "it is $2$, not $1$");
  assert.equal(j.checks[2].error, "could not decide: no proof either way");
  assert.match(j.checks[3].error, /its verdict failed: ValueError: bad/);
  assert.match(j.checks[4].error, /not True, a message or/);
});
