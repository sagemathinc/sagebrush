import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Implicit namespace packages (PEP 420; Codex friction step 1, P1: 205 topics hit "a helper folder without
// __init__.py does not import"): a directory on sys.path without __init__.py imports as a namespace package, in python
// and sage mode, after any regular module or package of the name anywhere on the path, merged across path entries.
// The expected lines are CPython 3.14's for the same files.
const CLI = join(__dirname, "..", "src", "cli.js");

function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "nspkg-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
}
const run = (dir: string, ...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

test("a helper folder without __init__.py imports, in python and sage mode (friction P1)", () => {
  const d = tree({
    "pkg/mod.py": "X = 7\n",
    "main.py": "import pkg.mod\nprint(pkg.mod.X)\nfrom pkg import mod\nprint(mod.X)\n",
    "main.sage": "import pkg.mod\nprint(pkg.mod.X, 2^3)\n",
  });
  try {
    assert.equal(run(d, "main.py"), "7\n7\n");
    assert.equal(run(d, "main.sage"), "7 8\n");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("namespace packages as CPython's: __file__ None, an absolute __path__ of every portion, nested, merged across sys.path; a module or package of the name wins; errors unchanged", () => {
  const d = tree({
    "a/ns/one.py": 'X = "a"\n',
    "b/ns/two.py": 'Y = "b"\n',
    "a/ns/sub/deep.py": "Z = 3\n",
    "shadow/.keep": "",
    "lib2/shadow.py": 'V = "module wins"\n',
    "json/.keep": "",
    "c/.keep": "",
    "t.py": [
      "import sys, os",
      'sys.path[:0] = ["a", "b"]',
      "import ns",
      'print(ns.__file__, [os.path.relpath(p) for p in ns.__path__], [os.path.isabs(p) for p in ns.__path__], ns.__package__)',
      "import ns.one, ns.two",
      "print(ns.one.X, ns.two.Y)",
      "from ns.sub import deep",
      "print(deep.Z, type(ns.sub).__name__, ns.sub.__file__)",
      'sys.path.append("lib2")',
      "import shadow",
      'print(getattr(shadow, "V", "namespace"))',
      "import json",
      "print(json.dumps([1]))",
      "try:",
      "    import ns.missing",
      "except ModuleNotFoundError as e:",
      "    print(type(e).__name__, e, e.name)",
      "try:",
      "    import nothere",
      "except ModuleNotFoundError as e:",
      "    print(type(e).__name__, e)",
      "import c",
      "print(c.__name__, c.__file__)",
      "",
    ].join("\n"),
  });
  try {
    assert.equal(run(d, "t.py"), [
      "None ['a/ns', 'b/ns'] [True, True] ns",
      "a b",
      "3 module None",
      "module wins",
      "[1]",
      "ModuleNotFoundError No module named 'ns.missing' ns.missing",
      "ModuleNotFoundError No module named 'nothere'",
      "c None",
      "",
    ].join("\n"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// (daybreak3's NAMESPACE-DYNAMIC-1: a namespace package's __path__ follows its parent's path, sys.path at the top, as
// CPython's _NamespacePath: portions added after the import are found, in the path's order, nested too; a regular
// package of the name appearing later doesn't take it over. CPython 3.14's output for the same program)
test("a namespace package's __path__ follows sys.path and its parent's __path__ after it is imported, as CPython's", () => {
  const d = tree({
    "a/ns/one.py": "A = 1\n",
    "b/ns/late.py": 'L = "late"\n',
    "a/ns/sub/x.py": 'X = "x"\n',
    "b/ns/sub/y.py": 'Y = "y"\n',
    "c/ns/__init__.py": "",
    "c/ns/z.py": "Z = 1\n",
    "t.py": "import sys, os\nrel = lambda p: [os.path.relpath(x) for x in p]\nsys.path.insert(0, \"a\")\nimport ns.one, ns.sub.x\nprint(rel(ns.__path__), rel(ns.sub.__path__))\nsys.path.insert(0, \"b\")\nimport ns.late\nprint(ns.late.L, rel(ns.__path__))\nimport ns.sub.y\nprint(ns.sub.y.Y, rel(ns.sub.__path__))\nsys.path.insert(0, \"c\")\ntry:\n    import ns.z\n    print(\"z imported\", rel(ns.__path__))\nexcept ModuleNotFoundError as e:\n    print(\"ModuleNotFoundError\", e, rel(ns.__path__))\n",
  });
  try {
    assert.equal(run(d, "t.py"), [
      "['a/ns'] ['a/ns/sub']",
      "late ['b/ns', 'a/ns']",
      "y ['b/ns/sub', 'a/ns/sub']",
      "ModuleNotFoundError No module named 'ns.z' ['b/ns', 'a/ns']",
      "",
    ].join("\n"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
