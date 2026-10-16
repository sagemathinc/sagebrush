import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// str.casefold is Python 3.14's full case folding (src/runtime/casefold-data.ts,
// scripts/gen-casefold.py), not lower(): the expected values are CPython 3.14.8's
// (CORR-D1C-1)
test("str.casefold folds as Python 3.14 does, past ASCII", () => {
  const cases: [string, string][] = [
    ["Straße", "strasse"], ["ﬁ", "fi"], ["ΣΑΣ", "σασ"], ["\u0130", "i\u0307"], ["ꭰ", "Ꭰ"], ["ǅ", "ǆ"], ["ﬃ", "ffi"],
    ["\u0149", "\u02bcn"], ["Ω", "ω"], ["K", "k"], ["\u0390", "\u03b9\u0308\u0301"], ["𐐀", "𐐨"], ["\u01f0", "j\u030c"], ["MASSE", "masse"], ["ĳ", "ĳ"], ["", ""],
  ];
  const code = "import json, sys, collections\ncs = json.loads(sys.argv[1])\nprint(json.dumps([[s.casefold(), str(collections.UserString(s).casefold())] for s in cs]))";
  const got = JSON.parse(execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code, JSON.stringify(cases.map((c) => c[0]))], { encoding: "utf8" }));
  assert.deepEqual(got, cases.map((c) => [c[1], c[1]]));
});
