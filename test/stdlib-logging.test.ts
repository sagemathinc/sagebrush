import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// logging, CPython 3.14's own Lib/logging/__init__.py, lazily embedded, and atexit, which it registers its shutdown
// with: test/logging_cases.py prints what CPython prints for it, line for line (the reference is CI's "3.14").
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "logging_cases.py");

test("logging_cases.py: the module's functions, loggers, handlers, formatter styles, filters, adapters, exc_info, basicConfig, disable and atexit, as CPython 3.14 prints them", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 20, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `logging_cases.py line ${i + 1}`);
});

test("atexit: the functions run at a program's end, after a SystemExit too, last first; one that raises is reported and the rest run", () => {
  const code = [
    "import atexit, sys",
    "atexit.register(print, 'first registered')",
    "def bad():",
    "    raise ValueError('in a callback')",
    "atexit.register(bad)",
    "atexit.register(print, 'last registered', end='!\\n')",
    "print('body')",
    "sys.exit(3)",
  ].join("\n");
  let status = 0, out = "", err = "";
  try {
    out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    status = e.status;
    out = e.stdout;
    err = e.stderr;
  }
  assert.equal(status, 3);
  assert.equal(out, "body\nlast registered!\nfirst registered\n");
  assert.match(err, /^Exception ignored in atexit callback <function bad at 0x[0-9a-f]+>:\nTraceback \(most recent call last\):\n  File "<string>", line 4, in bad\n/);
  assert.match(err, /ValueError: in a callback\n$/);
});

test("time's functions are builtins, as CPython's C functions: none binds as a class attribute", () => {
  const out = execFileSync(process.execPath, [CLI, "-c", "import time\nclass C:\n    conv = time.gmtime\nprint(C().conv(0).tm_year, type(time.localtime).__name__, time.localtime)"], { encoding: "utf8" });
  assert.equal(out, "1970 builtin_function_or_method <built-in function localtime>\n");
});
