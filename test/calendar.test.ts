import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// CPython's calendar.py and locale.py, copied unchanged into lib/, run on
// pyjs over lib/_locale.py (the C locale) and lib/encodings (normalize_encoding
// and aliases): text and HTML calendars, the iterators, the Month and Day
// enums, timegm, the errors and locale's C-locale functions print what
// CPython's do.
const CASES = __dirname + "/../../test/calendar_cases.py";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("CPython's calendar.py and locale.py behave as in CPython (the C locale)", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});
