import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// str.encode and bytes.decode through every Unicode codec and error
// handler, a lone surrogate never silently replaced (sage2's time/datetime
// cases found '\ud800'.encode('utf-8') giving b'\xef\xbf\xbd'), and the
// Unicode errors, int's conversions and rounding dunders, and a getset's
// __get__ (test/surrogate_cases.py, test/builtin_fixes2_cases.py), compared
// with CPython 3.14.
const TEST = __dirname + "/../../test/";
for (const name of ["surrogate_cases.py", "builtin_fixes2_cases.py"]) {
  test(`${name}: CPython's`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}

// (namereplace of a named character needs Unicode's names, which Sagebrush
// has no table of yet: refused in words, never another replacement; a
// surrogate, which has no name, is escaped as CPython does)
test("the namereplace handler refuses a named character, escapes a surrogate", () => {
  const src = "for s in ('x\\U0001f600y', '\\u00e9'):\n    try:\n        s.encode('ascii', 'namereplace')\n    except NotImplementedError as e:\n        print(type(e).__name__)\nprint('\\ud800'.encode('ascii', 'namereplace'))";
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" });
  assert.equal(out, "NotImplementedError\nNotImplementedError\nb'\\\\ud800'\n");
});
