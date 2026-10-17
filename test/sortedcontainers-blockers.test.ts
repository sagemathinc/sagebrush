import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Runtime gaps that blocked sortedcontainers (sage2's report), compared with
// CPython 3.14: type.__call__ initializing a __new__ result by
// type(obj).__init__ (test/new_init_cases.py), and traceback.format_exc()
// formatting the exception being handled (test/traceback_exc_cases.py;
// CPython's caret lines under a traceback's source line, ^^^ and ~~~, are not
// printed here, so they are left out of the comparison).
const TEST = __dirname + "/../../test/";
const carets = (s: string) => s.split("\n").filter((l) => !/^\s+[~^]+\s*$/.test(l));
for (const name of ["new_init_cases.py", "traceback_exc_cases.py"])
  test(`${name}: CPython's output`, () => {
    const want = carets(execFileSync("python3", [TEST + name], { encoding: "utf8" }));
    const got = carets(execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }));
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });

// format_exc's frame limit isn't implemented: refused, not ignored
test("traceback.format_exc(limit=...) is refused", () => {
  const code = "import traceback\ntry:\n    1/0\nexcept ZeroDivisionError:\n    try:\n        traceback.format_exc(1)\n    except NotImplementedError as e:\n        print('refused', e)\n";
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
  assert.equal(out.trim(), "refused traceback.format_exc(limit=...) is not supported here");
});
