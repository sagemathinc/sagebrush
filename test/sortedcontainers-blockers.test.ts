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
  assert.match(out[1], /^400 refused: this traceback is deeper than the 200 JavaScript frames kept/);
});

// Where an exception is caught is recorded only once traceback is imported
// (the record costs a stack capture per catch); one caught before is
// refused, not given its callers' frames
test("traceback.format_exc of an exception caught before traceback was imported is refused", () => {
  const code = [
    "def caught():",
    "    try: 1 / 0",
    "    except ZeroDivisionError as e: return e",
    "old = caught()",
    "import traceback",
    "try: raise ValueError('later') from old",
    "except ValueError:",
    "    try: traceback.format_exc()",
    "    except NotImplementedError as e: print('refused:', e)",
    "    print(traceback.format_exc(chain=False).splitlines()[-1])",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["refused: this exception was caught before the traceback module was imported: where is unknown", "ValueError: later"]);
});
