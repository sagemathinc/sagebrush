import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A module whose import raised leaves sys.modules, as CPython's _load_unlocked
// deletes the entry (`except: del sys.modules[spec.name]`, whatever the entry
// holds by then), so the next import runs it again.  Found by the remote
// preview's 14(c) (Oct 31): a Stop during a notebook's first `import time`
// interrupted the time module's filling (it imports lib/_pytime.py), the
// empty module stayed in sys.modules, and every later `import time` in that
// interpreter returned a `time` with no sleep.  One test per path that loads a
// module (src/runtime/modules.ts importModule: a builtin's factory, a
// sys.meta_path loader; src/compile.ts: a Python file).  The expected outputs
// are CPython 3.14.4's (python3 -I test/import_failed_*_cases.py, Oct 31),
// written here, not computed when the test runs.
const CLI = __dirname + "/../src/cli.js";
const CASES = __dirname + "/../../test/";
const run = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("import failed: a sys.meta_path loader that raises (KeyboardInterrupt, an error, or after replacing its entry), as CPython 3.14.4", () => {
  assert.equal(run([CASES + "import_failed_meta_cases.py"]), [
    "KeyboardInterrupt raised KeyboardInterrupt",
    "KeyboardInterrupt left in sys.modules: False",
    "KeyboardInterrupt then imported again, complete: 1 2",
    "ValueError raised ValueError",
    "ValueError left in sys.modules: False",
    "ValueError then imported again, complete: 1 2",
    "replaced, then raised raised ValueError",
    "replaced, then raised left in sys.modules: False",
    "replaced, then raised then imported again, complete: 1 2",
    "",
  ].join("\n"));
});

test("import failed: a Python file that raises (KeyboardInterrupt, an error), as CPython 3.14.4", () => {
  assert.equal(run([CASES + "import_failed_file_cases.py"]), [
    "KeyboardInterrupt raised KeyboardInterrupt",
    "KeyboardInterrupt left in sys.modules: False",
    "KeyboardInterrupt then imported again, complete: 1 2",
    "ValueError raised ValueError",
    "ValueError left in sys.modules: False",
    "ValueError then imported again, complete: 1 2",
    "",
  ].join("\n"));
});

// (CPython's time is built in C and imports nothing, so this one is Sagebrush's own: its time module is filled from
// lib/_pytime.py, and that inner import is what a Stop interrupted)
test("import failed: a builtin module whose filling raised leaves sys.modules; the next import fills it again", () => {
  const src = `
import sys
sys.modules['_pytime'] = None
try:
    import time
    print('imported')
except ModuleNotFoundError as e:
    print('raised', type(e).__name__)
print('time' in sys.modules)
del sys.modules['_pytime']
import time
print(hasattr(time, 'sleep'), hasattr(time, 'strftime'), sys.modules['time'] is time)
`;
  assert.equal(run(["-c", src]), "raised ModuleNotFoundError\nFalse\nTrue True True\n");
});
