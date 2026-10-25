// fileDeps (web/share-client/file-deps.ts): which workspace files the Share
// dialog pre-checks, from a notebook's code (share-ux-plan r2 §2).  The
// cases are python's (PY-SHARE-1/2/3) and astra3's (CORR-SHAREUX-2) from
// the plan's review, and the plan's own.
//   bun web/share-client/test-file-deps.mjs
import { fileDeps, workspacePath } from "./file-deps.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} (wanted ${JSON.stringify(b)})`);

// A workspace: { "/path": "text" }; cells as strings (python) or {kind, source}.
async function run({ files, cells, cwd = "/", importPath = [{ dir: "/", workspace: true }, { dir: "/$pyjs/lib", workspace: false }], builtins = ["math", "sys", "os", "os.path", "io"], external = ["json", "pathlib", "importlib", "typing", "logging", "warnings", "codecs", "posixpath"], signal } = {}) {
  const deps = [], unf = [], reads = [];
  const meta = new Map(Object.keys(files).map((p) => [p, { size: files[p].length }]));
  const r = await fileDeps({
    cells: cells.map((c, index) => (typeof c === "string" ? { index, kind: "python", source: c } : { index, ...c })),
    files: meta,
    cwd,
    importPath,
    builtinModules: new Set(builtins),
    externalModules: new Set(external),
    readFile: async (p) => {
      reads.push(p);
      return files[p];
    },
    onDep: (p, reason) => deps.push([p, reason]),
    onUnfollowed: (u) => unf.push(u),
    onProgress: () => {},
    signal: signal ?? new AbortController().signal,
  });
  return { ...r, deps, paths: deps.map((d) => d[0]), unf, reads };
}

// ---- paths
eq(workspacePath("/nb", "a.csv"), "/nb/a.csv", "relative to cwd");
eq(workspacePath("/nb", "../x/a.csv"), "/x/a.csv", ".. within the workspace");
eq(workspacePath("/", "../a.csv"), null, ".. above the root is refused");
eq(workspacePath("/", "https://x.org/a.csv"), null, "a URL is never a path");
eq(workspacePath("/", "file:///a.csv"), null, "file: is never a path");

// ---- PY-SHARE-1: which constants count
{
  const files = { "/a.csv": "x", "/notes.txt": "x", "/secrets.csv": "x", "/b.npy": "x", "/skip.txt": "x", "/err.txt": "x" };
  const r = await run({
    files,
    cells: [
      '"""reads secrets.csv"""\nimport numpy as np\nx = open("a.csv").read()\nif name == "notes.txt": pass\nprint("skip.txt")\nd = {}\nd["notes.txt"] = 1\nraise ValueError("err.txt")\n',
      'y = np.load("b.npy")\n',
    ],
  });
  eq(r.paths, ["/a.csv", "/b.npy"], "only call arguments count: a docstring, a comparison, print, a subscript and a raise don't");
  eq(r.deps[0][1], { kind: "opened", cell: 0 }, "open(...) is 'opened'");
  eq(r.deps[1][1], { kind: "opened", cell: 1 }, "np.load through `import numpy as np` is 'opened'");
}
{
  const r = await run({ files: { "/a.csv": "x", "/b.csv": "x" }, cells: ['import logging, warnings\nlogging.info("a.csv")\nwarnings.warn("b.csv")\nhandle("a.csv")\n'] });
  eq(r.deps, [["/a.csv", { kind: "named", cell: 0 }]], "logging/warnings are messages; another call's constant is 'named'");
}
{
  const r = await run({ files: { "/a.csv": "x", "/b.csv": "x" }, cells: ['f = "a.csv"\nfs = ["b.csv"]\nopen(f)\nfor x in fs: pass\n'] });
  eq(r.paths, ["/a.csv"], "a constant bound to a name reaches a call; one never passed to a call doesn't");
}
{
  const r = await run({ files: { "/d/a.csv": "x" }, cells: ['from pathlib import Path\nimport os.path as osp\nPath("d").joinpath\nopen(Path("d") / "a.csv")\n', 'import os\nopen(os.path.join("d", "a.csv"))\n'] });
  eq(r.paths, ["/d/a.csv"], "Path(...) / ... and os.path.join with constant parts");
}
{
  const r = await run({ files: { "/d/a.csv": "x" }, cells: ['def join(*a): return "x"\nopen(join("d", "a.csv"))\n'] });
  eq(r.paths, [], "a user's own join isn't os.path.join: its result is no constant path");
}
{
  const r = await run({ files: { "/a.csv": "x", "/b.csv": "x" }, cells: ['from pathlib import Path\nt = Path("a.csv").read_text()\nn = 3\nopen(f"b{n}.csv")\n'] });
  eq(r.deps[0], ["/a.csv", { kind: "opened", cell: 0 }], "Path(...).read_text() is 'opened'");
  ok(r.unf.some((u) => /computed/.test(u.why)), "an f-string file name is reported unfollowed");
  ok(!r.paths.includes("/b.csv"), "...and never guessed");
}
{
  const r = await run({ files: { "/a.csv": "x", "/b.csv": "x", "/sub/a.csv": "x" }, cells: ['import os\nos.chdir("sub")\nopen("a.csv")\nopen("/b.csv")\n'] });
  eq(r.paths, ["/b.csv"], "after os.chdir a relative name is unfollowed (never resolved against the old cwd); an absolute one still counts");
  ok(r.unf.some((u) => /change of directory/.test(u.why)), "...reported");
}

// ---- imports: pyjs's order (PY-SHARE-2, CORR-SHAREUX-2)
{
  const r = await run({ files: { "/a.py": "import b\n", "/b.py": 'open("data.csv")\n', "/data.csv": "x" }, cells: ["import a\n"] });
  eq(r.deps, [["/a.py", { kind: "imported", cell: 0 }], ["/b.py", { kind: "imported", by: "/a.py" }], ["/data.csv", { kind: "opened", by: "/b.py" }]], "a.py -> b.py -> a data file opened in the imported module");
}
{
  const r = await run({ files: { "/a.py": "import b\n", "/b.py": "import a\n" }, cells: ["import a\n"] });
  eq(r.paths, ["/a.py", "/b.py"], "a cycle terminates");
  eq(r.reads, ["/a.py", "/b.py"], "...each file read once");
}
{
  const r = await run({ files: { "/a.py": "b = 1\n" }, cells: ["from a import b\n"] });
  eq(r.paths, ["/a.py"], "from a import b with only a.py checks a.py (the base module)");
}
{
  const r = await run({ files: { "/pkg/__init__.py": "", "/pkg/sub.py": "value = 1\n" }, cells: ["from pkg.sub import value\n"] });
  eq(r.paths, ["/pkg/__init__.py", "/pkg/sub.py"], "from pkg.sub import value: the package's __init__, then pkg/sub.py");
}
{
  const r = await run({ files: { "/pkg/__init__.py": "", "/pkg/mod.py": "" }, cells: ["from pkg import mod\n"] });
  eq(r.paths, ["/pkg/__init__.py", "/pkg/mod.py"], "from pkg import mod follows the submodule");
}
{
  const r = await run({ files: { "/pkg/__init__.py": '__all__ = ["one"]\n', "/pkg/one.py": "", "/pkg/two.py": "" }, cells: ["from pkg import *\n"] });
  eq(r.paths, ["/pkg/__init__.py", "/pkg/one.py"], "a star import follows the constant __all__ only");
}
{
  const r = await run({ files: { "/pkg/__init__.py": 'open("pkg/table.csv")\n', "/pkg/table.csv": "x" }, cells: ["import pkg\n"] });
  eq(r.paths, ["/pkg/__init__.py", "/pkg/table.csv"], "a package initializer naming a data file");
}
{
  const r = await run({ files: { "/a/__init__.py": "", "/a.py": "" }, cells: ["import a\n"] });
  eq(r.paths, ["/a/__init__.py"], "a module/package conflict in one directory: the package wins, as in pyjs");
}
{
  const r = await run({ files: { "/one/m.py": "", "/two/m.py": "" }, cells: ["import m\n"], importPath: [{ dir: "/one", workspace: true }, { dir: "/two", workspace: true }] });
  eq(r.paths, ["/one/m.py"], "two sys.path roots: the first wins, the shadowed one isn't checked");
}
{
  const r = await run({ files: { "/math.py": "", "/json.py": "" }, cells: ["import math\nimport json\n"] });
  eq(r.paths, ["/json.py"], "a workspace math.py isn't what `import math` loads (native); json.py before lib/ on sys.path is");
  const r2 = await run({ files: { "/json.py": "" }, cells: ["import json\n"], importPath: [{ dir: "/$pyjs/lib", workspace: false }, { dir: "/", workspace: true }] });
  eq(r2.paths, [], "...and json.py after lib/ on sys.path isn't");
}
{
  const r = await run({ files: { "/ns/m.py": "" }, cells: ["import ns.m\n"] });
  eq(r.paths, [], "no namespace packages: pyjs's loader needs __init__.py");
}
{
  const r = await run({ files: { "/p/__init__.py": "", "/p/q/__init__.py": "from .. import r\nfrom . import s\nfrom ... import t\n", "/p/r.py": "", "/p/q/s.py": "" }, cells: ["import p.q\n"] });
  eq(r.paths, ["/p/__init__.py", "/p/q/__init__.py", "/p/r.py", "/p/q/s.py"], "relative imports, levels 1 and 2");
  ok(r.unf.some((u) => /beyond the top package/.test(u.why)), "a relative import beyond the top package is reported, not guessed");
  const r2 = await run({ files: { "/x.py": "" }, cells: ["from . import x\n"] });
  eq(r2.paths, [], "a relative import in a cell is unfollowed");
}
{
  const r = await run({ files: { "/a.py": "", "/b.py": "", "/c.py": "" }, cells: ['import importlib\nimportlib.import_module("a")\n__import__("b")\nfrom typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import c\n'] });
  eq(r.paths, ["/a.py", "/b.py"], "importlib.import_module and __import__ are imports; TYPE_CHECKING bodies aren't");
}
{
  const r = await run({ files: { "/a.py": "", "/b.py": "" }, cells: ["try:\n    import a\nexcept ImportError:\n    pass\ndef f():\n    import b\n"] });
  eq(r.paths, ["/a.py", "/b.py"], "conditional imports (try, a function body) count");
}
{
  const r = await run({ files: { "/bad.py": "def (:\n", "/x.csv": "" }, cells: ["import bad\n"] });
  eq(r.paths, ["/bad.py"], "a module that can't be parsed still counts as imported");
  ok(r.complete === false && r.unf.some((u) => /couldn't be parsed/.test(u.why)), "...and the result is incomplete, said so");
}

// ---- magics, shell lines, other kinds, Markdown
{
  const r = await run({ files: { "/a.csv": "x", "/b.txt": "x", "/h.py": 'open("c.csv")\n', "/c.csv": "x", "/l.py": "" }, cells: ["!cat a.csv nothing.txt\n", "%%bash\nwc -l b.txt\n", "%run h.py\n", "%load l.py\n"] });
  eq(r.paths, ["/a.csv", "/b.txt", "/h.py", "/l.py", "/c.csv"], "`!` and %%bash words naming files, %run (followed), %load");
}
{
  const r = await run({ files: { "/fig.png": "x", "/data/t.csv": "x", "/x.html": "x" }, cells: [{ kind: "markdown", source: "![plot](fig.png) and [table](data/t.csv \"t\") and <a href='x.html'>x</a> and [web](https://e.org/x.html)\n" }] });
  eq(r.deps, [["/fig.png", { kind: "linked", cell: 0 }], ["/data/t.csv", { kind: "linked", cell: 0 }], ["/x.html", { kind: "linked", cell: 0 }]], "Markdown links and images; a URL isn't a path");
}
{
  const r = await run({ files: { "/a.csv": "x" }, cells: [{ kind: "sage", source: 'x = 2^3\nopen("a.csv")\n' }] });
  eq(r.paths, ["/a.csv"], "a Sage cell, preparsed");
}
{
  const r = await run({ files: { "/unrelated.mat": "x", "/other.npy": "x" }, cells: ["x = 1\n"] });
  eq(r.paths, [], "unrelated files are never checked");
}

// ---- the calling convention
{
  const files = { "/a.py": "import b\n", "/b.py": "" };
  const c = new AbortController();
  let reads = 0;
  const r = await fileDeps({
    cells: [{ index: 0, kind: "python", source: "import a\n" }],
    files: new Map(Object.keys(files).map((p) => [p, {}])),
    cwd: "/",
    importPath: [{ dir: "/", workspace: true }],
    builtinModules: new Set(),
    externalModules: new Set(),
    readFile: async (p) => {
      reads++;
      c.abort();
      return files[p];
    },
    onDep: () => {},
    onUnfollowed: () => {},
    onProgress: () => {},
    signal: c.signal,
  });
  ok(r.complete === false && reads === 1, "an abort stops it between files, incomplete");
}
{
  const r1 = await run({ files: { "/a.py": "import c\n", "/b.py": "", "/c.py": "" }, cells: ["import a\nimport b\n"] });
  const r2 = await run({ files: { "/a.py": "import c\n", "/b.py": "", "/c.py": "" }, cells: ["import a\nimport b\n"] });
  eq(r1.deps, r2.deps, "deterministic order");
  eq(r1.paths, ["/a.py", "/b.py", "/c.py"], "cells first, then the FIFO worklist");
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
