import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// A help page's File: line names a library module as lib/<module>.py wherever the library was loaded from: the
// bundle's /$pyjs/lib/, or a checkout's lib/ in the development CLI, with "/" or Windows' "\" separators. It never
// prints one machine's path (the examples' leak check, #543; daybreak3's DB3-543-1 for Windows). Paths outside the
// library, a sibling folder such as lib2/ or lib_old/ included, are shown as they are.
test("help's File: line: the library's own files as lib/<module>.py on every platform; other paths as they are", () => {
  const f = join(mkdtempSync(join(tmpdir(), "help-file-")), "check.py");
  writeFileSync(f, [
    "import _pyjs_help as H",
    "def show(here, fn):",
    "    saved = H._HERE",
    "    H._HERE = H._root_of(here) or H._LIB",
    "    try:",
    "        return H._show_file(fn)",
    "    finally:",
    "        H._HERE = saved",
    "posix = '/scratch/sb/lib/_pyjs_help.py'",
    "win = 'C:\\\\work\\\\sagebrush\\\\lib\\\\_pyjs_help.py'",
    "print(H._root_of(posix), H._root_of(win), H._root_of('x.py'), H._root_of(None))",
    "for here, fn in [",
    "    (posix, '/scratch/sb/lib/_sage_modular.py'),",
    "    (win, 'C:\\\\work\\\\sagebrush\\\\lib\\\\_sage_modular.py'),",
    "    (posix, '/$pyjs/lib/_sage_modular.py'),",
    "    (posix, '/scratch/sb/lib2/x.py'),",
    "    (posix, '/scratch/sb/libx.py'),",
    "    (win, 'C:\\\\work\\\\sagebrush\\\\lib_old\\\\x.py'),",
    "    (posix, '/home/user/my_module.py'),",
    "    (posix, None),",
    "]:",
    "    print(repr(show(here, fn)))",
    "import _sage_modular",
    "H.inspect_object(_sage_modular.ModularSymbols, 1, 'ModularSymbols')",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--sage", f], { encoding: "utf8" });
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 9), [
    "/scratch/sb/lib/ C:/work/sagebrush/lib/ None None",
    "'lib/_sage_modular.py'",
    "'lib/_sage_modular.py'",
    "'lib/_sage_modular.py'",
    "'/scratch/sb/lib2/x.py'",
    "'/scratch/sb/libx.py'",
    "'C:\\\\work\\\\sagebrush\\\\lib_old\\\\x.py'",
    "'/home/user/my_module.py'",
    "None",
  ], r.stderr);
  // (the development CLI loads lib/ from this checkout: its help page shows lib/, not the checkout's path)
  const file = lines.find((l) => l.startsWith("File:"));
  assert.equal(file, "File:      lib/_sage_modular.py", r.stdout + r.stderr);
});
