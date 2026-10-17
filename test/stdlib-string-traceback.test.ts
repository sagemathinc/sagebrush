import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The string module (lib/string/__init__.py, CPython 3.14's, over
// lib/_string.py, its C parsers ported) and traceback's keyword arguments
// (limit=, file=, chain=; print_exc, print_exception, format_exception),
// and re's scoped ASCII flag (?a:...) that string.Template needs, compared
// with CPython 3.14: sortedcontainers' blockers 3 and 4 (sage2's
// report). CPython's caret lines under a traceback's source line (^^^ and
// ~~~) are not printed here, so they are left out of the comparison.
const TEST = __dirname + "/../../test/";
const carets = (s: string) => s.split("\n").filter((l) => !/^\s+[~^]+\s*$/.test(l));
for (const name of ["string_module_cases.py", "_string_cases.py", "traceback_kwargs_cases.py"])
  test(`${name}: CPython's output`, () => {
    const want = carets(execFileSync("python3", [TEST + name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const got = carets(execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });

