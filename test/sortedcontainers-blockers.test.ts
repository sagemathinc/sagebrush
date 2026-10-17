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
for (const name of ["new_init_cases.py", "traceback_exc_cases.py", "traceback_late_import_cases.py"])
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

// Deeper than the JS frames kept, which frame caught an exception is
// unknown: format_exc refuses, never printing its callers as its traceback
// (CORR-6AF-2); shallower, the handler's two frames, as CPython's
test("traceback.format_exc past the JS stack limit is refused, not guessed", () => {
  const code = [
    "import traceback",
    "def leaf(): raise ValueError('leaf')",
    "def handler():",
    "    try: leaf()",
    "    except ValueError: return traceback.format_exc()",
    "def descend(n):",
    "    if n: return descend(n - 1)",
    "    return handler()",
    "for n in [5, 400]:",
    "    try: print(n, [l.split(', in ')[-1] for l in descend(n).splitlines() if l.startswith('  File ')])",
    "    except NotImplementedError as e: print(n, 'refused:', e)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.equal(out[0], "5 ['handler', 'leaf']");
  assert.match(out[1], /^400 refused: which frame caught this exception is unknown: its traceback is deeper than the 200 JavaScript frames kept/);
});

// Recursion through the handler: the function that caught it is more than
// one of the frames it was raised through, and which caught it is unknown,
// so format_exc refuses (CORR-6AF-2)
test("traceback.format_exc refuses when the handler's function recurses through the raise", () => {
  const code = [
    "import traceback",
    "def f(n):",
    "    try:",
    "        if n: return f(n - 1)",
    "        raise KeyError(n)",
    "    except KeyError:",
    "        if n == 1:",
    "            try: return traceback.format_exc()",
    "            except NotImplementedError as e: return 'refused: ' + str(e)",
    "        raise",
    "print(f(2))",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim();
  assert.equal(out, "refused: which frame caught this exception is unknown: f, which caught it, is 3 of the frames it was raised through (recursion through the handler)");
});
