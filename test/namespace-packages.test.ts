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

// (daybreak3's follow-up: as _NamespacePath, the portions are recomputed only when the parent's path has changed, so
// one the program appended stays until then; and a __path__ the program replaced is left as it is, and used.
// CPython 3.14's output for the same program)
test("a namespace package keeps an appended portion until its parent's path changes, and a replaced __path__, as CPython's", () => {
  const d = tree({
    "a/ns/one.py": "A = 1\n",
    "b/ns/late.py": 'L = "late"\n',
    "d/ns/extra.py": 'X = "extra"\n',
    "e/ns/w.py": 'W = "w"\n',
    "e/ns/r.py": 'R = "r"\n',
    "t.py": "import sys, os\nrel = lambda p: [os.path.relpath(x) for x in p]\nsys.path.insert(0, \"a\")\nimport ns.one\nns.__path__.append(os.path.abspath(\"d\"))\nns.__path__[-1] = os.path.abspath(\"d/ns\")\nimport ns.extra\nprint(\"appended\", ns.extra.X, rel(ns.__path__))\nsys.path.insert(0, \"b\")\nimport ns.late\nprint(\"recomputed\", ns.late.L, rel(ns.__path__))\nns.__path__ = [os.path.abspath(\"e/ns\")]\nsys.path.insert(0, \"e\")\nimport ns.w\nprint(\"replaced\", ns.w.W, rel(ns.__path__), type(ns.__path__).__name__)\nsys.path.remove(\"e\")\nimport ns.r\nprint(\"kept\", ns.r.R, rel(ns.__path__))\n",
  });
  try {
    assert.equal(run(d, "t.py"), [
      "appended extra ['a/ns', 'd/ns']",
      "recomputed late ['b/ns', 'a/ns']",
      "replaced w ['e/ns'] list",
      "kept r ['e/ns']",
      "",
    ].join("\n"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// (daybreak3's NAMESPACE-EPOCH-2: as _NamespacePath's _epoch, importlib.invalidate_caches() makes a namespace package
// recompute its portions though its parent's path is unchanged: a portion made in a directory already on the path is
// found after it, not before; nested too. CPython 3.14's output for the same program)
test("importlib.invalidate_caches() makes a namespace package find a portion made since, its parent's path unchanged, as CPython's", () => {
  const d = tree({
    "a/ns/one.py": "A = 1\n",
    "a/ns/sub/s.py": "S = 1\n",
    "c/.keep": "",
    "t.py": "import importlib, os, sys\nrel = lambda p: [os.path.relpath(x) for x in p]\ndef put(path, text):\n    os.makedirs(os.path.dirname(path), exist_ok=True)\n    with open(path, \"w\") as f:\n        f.write(text)\nsys.path[:0] = [\"c\", \"a\"]\nimport ns.one, ns.sub.s\nprint(\"initial\", rel(ns.__path__), rel(ns.sub.__path__))\nput(\"b/ns/two.py\", \"Y = 2\\n\")\nsys.path.insert(0, \"b\")\nimport ns.two\nprint(\"path-change\", ns.two.Y, rel(ns.__path__))\nput(\"c/ns/three.py\", \"Z = 3\\n\")\ntry:\n    import ns.three\nexcept ModuleNotFoundError as e:\n    print(\"before-invalidate\", e)\nimportlib.invalidate_caches()\nimport ns.three\nprint(\"after-invalidate\", ns.three.Z, rel(ns.__path__))\ntry:\n    import ns.sub.nope\nexcept ModuleNotFoundError as e:\n    print(\"nested probe\", e, rel(ns.sub.__path__))\nput(\"b/ns/sub/w.py\", \"W = 4\\n\")\ntry:\n    import ns.sub.w\nexcept ModuleNotFoundError as e:\n    print(\"nested before-invalidate\", e)\nimportlib.invalidate_caches()\nimport ns.sub.w\nprint(\"nested after-invalidate\", ns.sub.w.W, rel(ns.sub.__path__))\n",
  });
  try {
    assert.equal(run(d, "t.py"), [
      "initial ['a/ns'] ['a/ns/sub']",
      "path-change 2 ['b/ns', 'a/ns']",
      "before-invalidate No module named 'ns.three'",
      "after-invalidate 3 ['b/ns', 'c/ns', 'a/ns']",
      "nested probe No module named 'ns.sub.nope' ['a/ns/sub']",
      "nested before-invalidate No module named 'ns.sub.w'",
      "nested after-invalidate 4 ['b/ns/sub', 'a/ns/sub']",
      ""
    ].join("\n"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// (grader's r790 survivors: R7 the refresh fills the same list; R4 a portion appended by hand after a refresh stays;
// R8 a nested package's refresh refreshes its parent first; R5 no portion left keeps the old ones; Q3 a plain file
// named like the package is no portion. CPython 3.14's output for the same program)
test("a namespace package's refresh: the same list, a hand-appended portion kept, the parent refreshed first, none left keeps the old; a file is no portion, as CPython's", () => {
  const d = tree({
    "a/ns/one.py": "A = 1\n",
    "a/ns/kept.py": "K = 'kept'\n",
    "a/ns/sub/s.py": "S = 1\n",
    "b/ns/two.py": "B = 2\n",
    "d/ns/hand.py": "H = 'hand'\n",
    "e/ns/sub/mod.py": "M = 'mod'\n",
    "f/pkg": "not python\n",
    "t.py": "import os, sys\nrel = lambda p: [os.path.relpath(x) for x in p]\nsys.path[:0] = [\"a\"]\nimport ns.one, ns.sub.s\np = ns.__path__\nsys.path.insert(0, \"b\")\nimport ns.two\nprint(\"R7 same object\", p is ns.__path__, rel(p))\nns.__path__.append(os.path.abspath(\"d/ns\"))\nimport ns.hand\nprint(\"R4 appended after a refresh\", ns.hand.H, rel(ns.__path__))\nsys.path.insert(0, \"e\")\nimport ns.sub.mod\nprint(\"R8 nested\", ns.sub.mod.M, rel(ns.sub.__path__), rel(ns.__path__))\nsys.path.remove(\"a\"); sys.path.remove(\"b\"); sys.path.remove(\"e\")\nimport ns.kept\nprint(\"R5 none left\", ns.kept.K, rel(ns.__path__))\nsys.path.insert(0, \"f\")\ntry:\n    import pkg\n    print(\"Q3 imported\", pkg)\nexcept ModuleNotFoundError as e:\n    print(\"Q3\", type(e).__name__, e)\n",
  });
  try {
    assert.equal(run(d, "t.py"), [
      "R7 same object True ['b/ns', 'a/ns']",
      "R4 appended after a refresh hand ['b/ns', 'a/ns', 'd/ns']",
      "R8 nested mod ['e/ns/sub', 'a/ns/sub'] ['e/ns', 'b/ns', 'a/ns']",
      "R5 none left kept ['e/ns', 'b/ns', 'a/ns']",
      "Q3 ModuleNotFoundError No module named 'pkg'",
      ""
    ].join("\n"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// (grader's Q5 and Q1: a registry package wins over a directory of its name without __init__.py, as a regular package
// anywhere on the path does in CPython; and a mounted package's own directories are never portions, the exclusion
// astra's SEC review relies on: here packages/pypi-tabulate/py, a real directory without __init__.py, once tabulate is
// mounted. In the bundled CLI the packages and the library are virtual paths, which no directory listing reaches)
test("a registry package wins over a bare directory of its name, and a mounted package's directories are no portions", () => {
  const d = tree({ "tabulate/.keep": "", "t.py": "import os, sys\nimport tabulate\nprint(\"Q5\", tabulate.__name__, callable(tabulate.tabulate), os.path.basename(tabulate.__file__))\nbase = os.path.dirname(os.path.dirname(tabulate.__file__))\nsys.path.insert(0, base)\nprint(\"Q1 base has py/ without __init__.py\", os.path.isdir(os.path.join(base, \"py\")), os.path.exists(os.path.join(base, \"py\", \"__init__.py\")))\ntry:\n    import py\n    print(\"Q1 imported\", py.__path__)\nexcept ModuleNotFoundError as e:\n    print(\"Q1\", type(e).__name__, e)\n" });
  try {
    assert.equal(run(d, "t.py"), [
      "Q5 tabulate True tabulate.py",
      "Q1 base has py/ without __init__.py True False",
      "Q1 ModuleNotFoundError No module named 'py'",
      "",
    ].join("\n"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
