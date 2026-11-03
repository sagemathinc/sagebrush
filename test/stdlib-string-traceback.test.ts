import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The string module (lib/string/__init__.py, CPython 3.14's, over
// lib/_string.py, its C parsers ported) and traceback's keyword arguments
// (limit=, file=, chain=; print_exc, print_exception, format_exception),
// and re's scoped ASCII flag (?a:...) that string.Template needs, compared
// with CPython 3.14: sortedcontainers' blockers 3 and 4 (sage2's
// report). CPython's caret lines under a traceback's source line (^^^ and
// ~~~) are not printed here, so they are left out of the comparison.
const TEST = __dirname + "/../../test/";
const carets = (s: string) => s.split("\n").filter((l) => !/^\s+[~^]+\s*$/.test(l));
for (const name of ["string_module_cases.py", "_string_cases.py", "traceback_kwargs_cases.py", "traceback_tb_none_cases.py"])
  test(`${name}: CPython's output`, () => {
    const want = carets(execFileSync("python3", [TEST + name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const got = carets(execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });

// What this runtime cannot do faithfully is refused, not guessed: it has no
// traceback objects (sys.exc_info()[2] and __traceback__ are None), so a tb
// other than None cannot be honored; nor colorize=True. tb=None is taken as
// the exception's own traceback (@sagebrush's ruling A, narrowing astra's
// CORR-484-2): format_exception(*sys.exc_info()) and
// format_exception(type(e), e, e.__traceback__) are CPython's
// (traceback_tb_none_cases.py, above).
test("traceback: a tb object, and colorize=True, are refused (NotImplementedError)", () => {
  const code = [
    "import sys, traceback, io",
    "try:",
    "    raise ValueError('example')",
    "except ValueError as e:",
    "    saved = e",
    "for label, f in [",
    "    ('a tb object', lambda: traceback.format_exception(type(saved), saved, object())),",
    "    ('print_exception a tb object', lambda: traceback.print_exception(type(saved), saved, object(), file=io.StringIO())),",
    "    ('colorize', lambda: traceback.format_exception(saved, colorize=True)),",
    "]:",
    "    try:",
    "        f(); print(label, 'not refused')",
    "    except NotImplementedError:",
    "        print(label, 'refused')",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["a tb object refused", "print_exception a tb object refused", "colorize refused"]);
});

// The deviation that ruling A accepts: a literal tb=None for a raised
// exception prints its frames too, where CPython prints only the exception's
// line (here None can't be told from e.__traceback__).
test("traceback: a literal tb=None for a raised exception formats its frames (the documented deviation)", () => {
  const code = ["import traceback", "try:", "    raise ValueError('example')", "except ValueError as e:", "    print(''.join(traceback.format_exception(type(e), e, None)), end='')"].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
  assert.match(out, /^Traceback \(most recent call last\):\n {2}File "<string>", line 3, in <module>\n/);
  assert.match(out, /ValueError: example\n$/);
});

// latex's report (#519): an exec'd program's error, in Sage mode, where it
// raised (a file, as latex's: CPython prints no source line for exec's
// "<string>" frame, Sagebrush does, so it isn't compared with python3)
test("traceback: format_exception(type(e), e, e.__traceback__) in Sage mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  const file = join(dir, "t.sage");
  writeFileSync(file, ["import traceback", "try:", "    exec('1/0', {})", "except Exception as e:", "    print(''.join(traceback.format_exception(type(e), e, e.__traceback__)), end='')", ""].join("\n"));
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true });
  assert.equal(out.split("\n")[0], "Traceback (most recent call last):");
  assert.match(out, /line 3, in <module>\n/);
  assert.match(out, /ZeroDivisionError: [^\n]*\n$/);
  assert.doesNotMatch(out, /another exception occurred|NotImplementedError/);
});
