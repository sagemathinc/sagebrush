import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The import search keeps a folder's listing (src/compile.ts absentFrom, as CPython's FileFinder) and takes only
// absences from it: a user's module still shadows the library's, and one added after a folder was listed is found
// after importlib.invalidate_caches(), as CPython finds it.  The program runs under CPython and under the CLI, each
// in a fresh folder, and prints the same lines.  (The browser's worker, whose folders' times behave differently:
// web/test-import-listing.mjs.)
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = [
  "import importlib, os, sys",
  "d = os.path.abspath('mods')",
  "os.mkdir(d)",
  "sys.path.insert(0, d)",
  // (a library module imported, then a user's module of its name written: found once the caches are invalidated)
  "import colorsys",
  "print('library', hasattr(colorsys, 'MARK'), hasattr(colorsys, 'rgb_to_hsv'))",
  "with open(os.path.join(d, 'colorsys.py'), 'w') as f: f.write('MARK = \"user\"\\n')",
  "del sys.modules['colorsys']",
  "importlib.invalidate_caches()",
  "import colorsys",
  "print('shadowed', colorsys.MARK, hasattr(colorsys, 'rgb_to_hsv'))",
  // (a library module never imported, a user's module of its name written after the folder was listed)
  "with open(os.path.join(d, 'ipaddress.py'), 'w') as f: f.write('MARK = \"user too\"\\n')",
  "importlib.invalidate_caches()",
  "import ipaddress",
  "print('first import', ipaddress.MARK)",
  // (a name the folder doesn't have, the folder listed, then the module written)
  "try:",
  "    import later_mod",
  "except ModuleNotFoundError as e:",
  "    print('absent', e.name)",
  "with open(os.path.join(d, 'later_mod.py'), 'w') as f: f.write('V = 5\\n')",
  "importlib.invalidate_caches()",
  "import later_mod",
  "print('found', later_mod.V)",
  // (a package directory, and a namespace package, added after the folder was listed)
  "os.mkdir(os.path.join(d, 'pkg_late'))",
  "with open(os.path.join(d, 'pkg_late', '__init__.py'), 'w') as f: f.write('P = 6\\n')",
  "os.mkdir(os.path.join(d, 'ns_late'))",
  "importlib.invalidate_caches()",
  "import pkg_late, ns_late",
  "print('package', pkg_late.P, 'namespace', list(ns_late.__path__) == [os.path.join(d, 'ns_late')])",
].join("\n");

const inFresh = (cmd: string, args: string[]) => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "import-listing-"));
  try {
    return execFileSync(cmd, args, { cwd: d, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: d } });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

test("a folder's listing: a user's module shadows the library's, and one added later is found after invalidate_caches(), as CPython's", () => {
  const want = inFresh("python3", ["-c", CASES]);
  assert.equal(want, "library False True\nshadowed user False\nfirst import user too\nabsent later_mod\nfound 5\npackage 6 namespace True\n", "CPython's own output");
  assert.equal(inFresh(process.execPath, [CLI, "-c", CASES]), want);
});
