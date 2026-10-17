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

// What this runtime cannot do faithfully is refused, not guessed: it has no
// traceback objects (sys.exc_info()[2] and __traceback__ are None), so an
// explicit tb for an exception that was raised, the three-argument form
// with exc_info, cannot be honored (astra's CORR-484-2); nor colorize=True.
// (tb=None for a never-raised exception, which drops nothing, is honored:
// traceback_kwargs_cases.py compares it with CPython)
test("traceback: an explicit tb for a raised exception, and colorize=True, are refused (NotImplementedError)", () => {
  const code = [
    "import sys, traceback, io",
    "try:",
    "    raise ValueError('example')",
    "except ValueError as e:",
    "    saved = e",
    "    info = sys.exc_info()",
    "for label, f in [",
    "    ('tb=None', lambda: traceback.format_exception(type(saved), value=saved, tb=None)),",
    "    ('three-argument form', lambda: traceback.format_exception(*info)),",
    "    ('print_exception tb=None', lambda: traceback.print_exception(type(saved), saved, None, file=io.StringIO())),",
    "    ('a tb object', lambda: traceback.format_exception(type(saved), saved, object())),",
    "    ('colorize', lambda: traceback.format_exception(saved, colorize=True)),",
    "]:",
    "    try:",
    "        f(); print(label, 'not refused')",
    "    except NotImplementedError:",
    "        print(label, 'refused')",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["tb=None refused", "three-argument form refused", "print_exception tb=None refused", "a tb object refused", "colorize refused"]);
});
