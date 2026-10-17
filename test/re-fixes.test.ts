import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// python-re-fixes (astra3's A22-A26): CPython's answers, compared with
// CPython 3.14 itself; and the patterns refused where JS's RegExp and sre
// would answer differently
const TEST = __dirname + "/../../test/";
const run = (file: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + file], { encoding: "utf8" }).split("\n");

test("re as CPython's: parse errors and their positions, fix_flags, repeats that can match nothing, must_advance, lastindex (re_fixes_cases.py)", () => {
  const want = execFileSync("python3", [TEST + "re_fixes_cases.py"], { encoding: "utf8" }).split("\n");
  const got = run("re_fixes_cases.py");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `re_fixes_cases.py line ${i + 1}`);
});

test("re refuses, saying what, the patterns JS's RegExp would answer otherwise than CPython (re_fixes_refusals.py)", () => {
  const REF = (g: number) => `a reference to group ${g}, which may not have matched at that point, is not supported yet (CPython's match fails there, JavaScript's matches the empty string)`;
  const IN = (g: number) => `group ${g} may not match in every repetition of the repeated part of the pattern around it, and Sagebrush cannot keep its earlier match as CPython does: such a group is not supported yet`;
  const EMPTY = "repeating a part of the pattern that can match the empty string before it tries to match text (such as (?:|a)* or (a*?)*) is not supported yet";
  assert.deepEqual(run("re_fixes_refusals.py"), [
    `(a)?b\\1 NotImplementedError: ${REF(1)}`,
    `(a|(b))\\2 NotImplementedError: ${REF(2)}`,
    `(a|(b))+ NotImplementedError: ${IN(2)}`,
    `(?:(a)|b)* NotImplementedError: ${IN(1)}`,
    `(?:|a)* NotImplementedError: ${EMPTY}`,
    `(a*?)* NotImplementedError: ${EMPTY}`,
    "(a?){1,3} NotImplementedError: a group inside a part of the pattern that can match the empty string and repeats a bounded number of times ({m,n} with n > m + 1) is not supported yet",
    "(a?)*\\1 NotImplementedError: a reference to group 1, which is inside a repeated part of the pattern that can match the empty string, is not supported yet",
    "(?<=(\\b)*)a NotImplementedError: inside a look-behind, repeating a part of the pattern that can match the empty string is not supported yet",
    "",
  ]);
});

// The analysis is linear in the pattern and never expands a repeat's
// count (daybreak2's HARD-079-1): in a 64 MB heap, at once
test("re's analysis of a pattern is linear in it, whatever its repeat counts (HARD-079-1)", () => {
  const { spawnSync } = require("node:child_process");
  const code = [
    "import re, time",
    "t = time.perf_counter()",
    "for p in ['(?:a?){4294967294}', '(?:a?){4294967294,}', '(?:a?b?){1000000000,}', '(?:){0,1}' * 20000, '(?:' * 200 + '(a)' + ')+' * 200 + r'\\1', '(?:(x)|y)?' * 3000, '|'.join('w%d' % i for i in range(100000)), ''.join('(a)' for i in range(20000)) + r'\\20000']:",
    "    print(re.compile(p).groups)",
    "print(time.perf_counter() - t < 20)",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--max-old-space-size=48", __dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0\n0\n0\n0\n1\n3000\n0\n20000\nTrue\n");
});
