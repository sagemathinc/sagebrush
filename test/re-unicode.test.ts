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
