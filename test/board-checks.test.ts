import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/board_checks.py, the helpers for a board question's check: numbers
// within a tolerance (exact when every number is rational), sets,
// multisets, sequences, permutations and groups, and symbolic equality
// (right only when the difference simplifies to 0, wrong only with an exact
// counterexample, else undecided); text answers read by parsers that never
// evaluate code. Each Verdict printed as its ok and the value the board's
// check runtime gets from __sagebrush_verdict__ (test/board_checks_cases.sage).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("board check helpers: verdicts, reasons, bounds and refusals", () => {
  const out = execFileSync(process.execPath, [CLI, "--sage", TEST + "board_checks_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "True True",
    "False 'off by $0.00159$ (relative $0.000507$), more than the tolerance'",
    "True True",
    "False 'it is not a number'",
    "True True",
    "True True",
    "ValueError: close: give a tolerance, rel= or abs=",
    "ValueError: close: a tolerance is a finite number, at least 0",
    "TypeError: close: the answer: list is not a number",
    "True True",
    "False 'it is missing $2$; $5$ is not in it'",
    "False 'it is missing $1$, $2$, $3$ and 2 more'",
    "True True",
    "False '$2$ appears 1 time, not 2'",
    "True True",
    "False 'item 3 is $4$, not $3$'",
    "False 'it has 2 items, not 3'",
    "True True",
    "ValueError: same_set: the answer: more than 100000 items",
    "True True",
    "False 'it sends $1$ to $3$, not to $2$'",
    "True True",
    "False 'it has order $3$, not $6$'",
    "False 'it has order $4$, not $8$'",
    "True True",
    "False 'they differ at $x = 1/2$'",
    "True True",
    "True True",
    "None {'undecided': 'the check could not decide whether these are equal'}",
    "None {'undecided': 'the check could not decide whether these are equal'}",
    "CannotDecide: hard",
    "True True",
    "False 'off by $0.1$ (relative $0.1$), more than the tolerance'",
    "True True",
    "True True",
    "True True",
    "True True",
    "False 'off by $2 \\\\times 10^{-20}$ (relative $2 \\\\times 10^{-20}$), more than the tolerance'",
    "ValueError: not a number: '2**10'",
    "ValueError: not a number: a fraction over 0",
    "ValueError: not a number: 'pi'",
    "ValueError: not a number: '1e99999'",
    "ValueError: not a number: ''",
    "False 'it is $\\\\infty$, not $-\\\\infty$'",
    "None {'undecided': 'the expected value is not a number'}",
    "True True",
    "False '$2$ appears 2 times, not 1'",
    "False 'item 2 is $2$, not $3$'",
    "True True",
    "TypeError: same_set: items must be hashable (unhashable type: 'list')",
    "ValueError: parse_list: a list inside a list is not read",
    "True True",
    "False '$(1,2)$ is in it, but not in the expected group'",
    "True True",
    "True True",
    "True True",
    "False 'they differ at $x = 2/3$'",
    "True True",
    "False 'they differ at $x = 1/2, y = 2/3$'",
    "ValueError: parse_expression: unexpected '\"' at 11",
    "ValueError: parse_expression: unexpected '.' at 1",
    "ValueError: parse_expression: a power above 1000",
    "ValueError: parse_expression: more than 100 levels of parentheses",
    "ValueError: parse_expression: unexpected ':' at 6",
    "ValueError: parse_expression: unexpected '[' at 1",
    "x^10000000000",
  ]);
});

test("board check helpers in a Python board: numbers, collections and permutations", () => {
  const out = execFileSync(process.execPath, [CLI, "-c", "from board_checks import *\nprint(close(0.1 + 0.2, 0.3, rel=1e-12).ok, same_set('{1, 2}', [2, 1]).ok, same_permutation([2, 1, 3], '(1,2)').ok, close('0.3', 0.3, abs=1e-12).ok)"], { encoding: "utf8" });
  assert.equal(out.trim(), "True True True True");
});
