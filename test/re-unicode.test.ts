import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// re's Unicode rules and complex arithmetic as CPython 3.14's
// (test/re_unicode_cases.py: astra's round-2 hunt at 1c6184e8, PY-1C6-1..5):
// \b \w \s and . by Python's definitions, IGNORECASE's dotted and dotless I,
// \S \W \D inside classes, scoped flags; Annex G products and quotients, and
// mixed real and complex operands.
const TEST = __dirname + "/../../test/";
test("re's \\b \\w \\s . and IGNORECASE, and complex products and quotients, as CPython 3.14 (PY-1C6-1..5)", () => {
  const want = execFileSync("python3", [TEST + "re_unicode_cases.py"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "re_unicode_cases.py"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});

// What the translation cannot do faithfully it refuses, rather than
// answering differently: scoped a, L and x flags (they were accepted and
// ignored), and IGNORECASE backreferences in ASCII or bytes patterns (no JS
// i flag there, CORR-BD8-1).
test("unsupported scoped flags and ASCII IGNORECASE backreferences are refused (NotImplementedError)", () => {
  const cases = [
    "re.fullmatch(r'(?a:\\w+)', 'é')",
    "re.fullmatch(r'(?x:a b)', 'ab')",
    "re.fullmatch(r'(?-x:a)', 'a', re.X)",
    "re.fullmatch(r'(a)\\1', 'aA', re.A | re.I)",
    "re.fullmatch(r'(?P<g>a)(?P=g)', 'aA', re.A | re.I)",
    "re.fullmatch(rb'(a)\\1', b'aA', re.I)",
    "re.fullmatch(r'(?u:\\w)', 'é', re.A)",
    "re.fullmatch(r'(?a)(?u:\\w)', 'é')",
  ];
  const code = ["import re"].concat(cases.map((e) => `try:\n    print(${e})\nexcept Exception as x:\n    print(type(x).__name__)`)).join("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trimEnd().split("\n");
  cases.forEach((e, i) => assert.equal(got[i], "NotImplementedError", e));
  // (and what is supported still works: i, m, s scopes; backreferences with Unicode IGNORECASE)
  const ok = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", "import re\nprint(bool(re.fullmatch(r'(?i:a)(?s:.)(?m:^)?', 'A\\n')), bool(re.fullmatch(r'(a)\\1', 'aA', re.I)), bool(re.fullmatch(r'(?u:\\w)', 'é')))"], { encoding: "utf8" });
  assert.equal(ok, "True True True\n");
});
