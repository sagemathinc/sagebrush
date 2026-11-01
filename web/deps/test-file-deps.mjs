// fileDeps (web/deps/file-deps.ts): which workspace files the Share
// dialog pre-checks, from a notebook's code (share-ux-plan r2 §2).  The
// cases are python's (PY-SHARE-1/2/3) and astra3's (CORR-SHAREUX-2) from
// the plan's review, the plan's own, and #170's review (python's PY-170-1..3
// and N-170-1/2, astra3's CORR-170-ASTRA-1..4).
//   bun web/deps/test-file-deps.mjs
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
async function run({ files, cells, cwd = "/", importPath = [{ dir: "/", workspace: true }, { dir: "/$pyjs/lib", workspace: false }], builtins = ["math", "sys", "os", "os.path", "io"], external = ["json", "pathlib", "importlib", "typing", "logging", "warnings", "codecs", "posixpath", "glob"], packages = ["numpy", "pandas"], signal } = {}) {
  const deps = [], unf = [], reads = [];
  const meta = new Map(Object.keys(files).map((p) => [p, { size: files[p].length }]));
  const r = await fileDeps({
    cells: cells.map((c, index) => (typeof c === "string" ? { index, kind: "python", source: c } : { index, ...c })),
    files: meta,
    cwd,
    importPath,
    builtinModules: new Set(builtins),
    externalModules: new Set(external),
    packageModules: new Set(packages),
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
  eq(r.paths, ["/a.csv", "/b.txt", "/h.py", "/c.csv", "/l.py"], "`!` and %%bash words naming files, %run (followed, before the next cell), %load");
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

// ---- #170's review: python's (PY-170-1..3, N-170-1/2) and astra3's (CORR-170-ASTRA-1..4)
const why = (r) => r.unf.map((u) => u.why);
const said = (r, re) => r.unf.some((u) => re.test(u.why));
{
  // PY-170-1: a change of directory lasts beyond its own cell
  const files = { "/a.csv": "x", "/sub/a.csv": "x" };
  const p1 = await run({ files, cells: ['import os\nos.chdir("sub")\n', 'open("a.csv")\n'] });
  eq(p1.paths, [], "P1: os.chdir in cell 0, open in cell 1: nothing pre-checked");
  ok(said(p1, /"a\.csv" after a change of directory/), "P1: ...the open is reported");
  ok(!said(p1, /"sub"/), "N-170-2: chdir's own argument isn't reported");
  const n2 = await run({ files: { ...files, "/notes/sub": "x" }, cells: ['import os\nos.chdir("sub")\n'] });
  eq([n2.paths, why(n2)], [[], []], "N-170-2: ...even where a file elsewhere has that name: it's a directory to change to, never a file");
  const p1b = await run({ files, cells: ["%cd sub\n", 'open("a.csv")\n'] });
  eq([p1b.paths, said(p1b, /after a change of directory/)], [[], true], "P1b: %cd in cell 0: the next cell's open is reported, not pre-checked");
  const p1c = await run({ files, cells: ['import os\ndef go():\n    os.chdir("sub")\n', 'go()\nopen("a.csv")\n'] });
  eq([p1c.paths, said(p1c, /after a change of directory/)], [[], true], "P1c: a chdir in an earlier cell's function body counts from that cell on");
  const before = await run({ files: { ...files, "/b.csv": "x" }, cells: ['open("b.csv")\n', 'import os\nos.chdir("sub")\n'] });
  eq(before.paths, ["/b.csv"], "a cell above the first chdir cell still pre-checks (control)");
  const fn = await run({ files, cells: ['def load():\n    return open("a.csv")\n', 'import os\nos.chdir("sub")\n', "load()\n"] });
  eq([fn.paths, said(fn, /after a change of directory/)], [[], true], "a function body runs when called: defined above a chdir, still reported");
  const gen = await run({ files, cells: ['g = (open(n) for n in ["a.csv"])\nh = (open("a.csv") for _ in [1])\n', 'import os\nos.chdir("sub")\n'] });
  eq(gen.paths, [], "a generator expression runs when iterated: like a function body");
  const mod = await run({ files: { ...files, "/helpers.py": 'import os\ndef setup():\n    os.chdir("sub")\n' }, cells: ['import helpers\nhelpers.setup()\nopen("a.csv")\n'] });
  eq([mod.paths, said(mod, /"a\.csv" after a change of directory/)], [["/helpers.py"], true], "a workspace module that can change directory counts from the cell that imports it");
  const top = await run({ files: { "/m.py": 'open("m.csv")\n', "/m.csv": "x", "/sub/x": "" }, cells: ["import m\n", 'import os\nos.chdir("sub")\n'] });
  eq(top.paths, ["/m.py", "/m.csv"], "a module first imported above the chdir: its top level ran before it (control)");
}
{
  // PY-170-2: sys.path's relative entries follow os.chdir
  const files = { "/m.py": "", "/sub/m.py": "" };
  const rel = [{ dir: "", workspace: true }, { dir: "/$pyjs/lib", workspace: false }];
  const p2 = await run({ files, cells: ['import os\nos.chdir("sub")\nimport m\n'], importPath: rel });
  eq(p2.paths, [], "P2: import after chdir through a relative entry: neither /m.py nor /sub/m.py pre-checked");
  ok(said(p2, /import m after a change of directory/), "P2: ...reported");
  const abs = await run({ files, cells: ['import os\nos.chdir("sub")\nimport m\n'] });
  eq(abs.paths, ["/m.py"], "an absolute sys.path entry doesn't move with the directory (control)");
  const cwd = await run({ files: { "/nb/m.py": "" }, cells: ["import m\n"], cwd: "/nb", importPath: rel });
  eq(cwd.paths, ["/nb/m.py"], "a relative entry resolves against the working directory");
}
{
  // PY-170-3: what isn't found is reported
  const p3 = await run({ files: { "/a/__init__.py": "" }, cells: ["try:\n    import a.b\nexcept ImportError:\n    pass\n"] });
  eq(p3.paths, ["/a/__init__.py"], "P3: a partial chain: the found package runs, so it's followed");
  ok(said(p3, /no module a\.b/), "P3: ...and the missing rest reported");
  const p4 = await run({ files: {}, cells: ["import nosuchmod\nimport numpy\nimport json\nimport math\n"] });
  eq(why(p4), ["no module nosuchmod in the workspace or the session"], "P4: a module found nowhere is reported; a package, a library module, a native aren't");
  const p6 = await run({ files: { "/m.py": "" }, cells: ["import m\n"], importPath: [{ dir: "/ext1", workspace: false }, { dir: "/", workspace: true }, { dir: "/ext2", workspace: false }], external: ["m"] });
  eq(p6.paths, [], "P6: an outside m ahead of /m.py, among several outside entries: not pre-checked");
  ok(said(p6, /which one loads can't be told/), "P6: ...reported");
  const attr = await run({ files: { "/pkg/__init__.py": "def f(): pass\n" }, cells: ["from pkg import f\n"] });
  eq([attr.paths, why(attr)], [["/pkg/__init__.py"], []], "from pkg import an attribute: no submodule, nothing to report (control)");
  const n1 = await run({ files: { "/p/__init__.py": "x = 1\n", "/p/x.py": "" }, cells: ["from p import x\n"] });
  eq([n1.paths, said(n1, /defines x/)], [["/p/__init__.py"], true], "N-170-1: a name the __init__ binds: its submodule may never load, so reported");
  const self = await run({ files: { "/q/__init__.py": "from . import y\n", "/q/y.py": "" }, cells: ["from q import y\n"] });
  eq(self.paths, ["/q/__init__.py", "/q/y.py"], "...but __init__'s own `from . import y` is the submodule (control)");
}
{
  // CORR-170-ASTRA-1: a path expression's parts are no files of their own
  const files = { "/data/a.csv": "x", "/a.csv": "x" };
  for (const [src, what] of [
    ['import os\nopen(os.path.join("data", "a.csv"))\n', "os.path.join"],
    ['from pathlib import Path\nopen(Path("data") / "a.csv")\n', "Path / ..."],
    ['import os\np = os.path.join("data", "a.csv")\nopen(p)\n', "a joined path bound to a name"],
    ['from pathlib import Path\nPath("data", "a.csv").read_text()\n', "Path(a, b).read_text()"],
  ]) eq((await run({ files, cells: [src] })).paths, ["/data/a.csv"], `ASTRA-1: ${what} names /data/a.csv only, never the decoy /a.csv`);
  const dyn = await run({ files, cells: ['import os\nopen(os.path.join(get_dir(), "a.csv"))\n'] });
  eq([dyn.paths, said(dyn, /computed/)], [[], true], "ASTRA-1: a join with a computed part: nothing pre-checked, reported");
}
{
  // CORR-170-ASTRA-2: a name bound more than once names nothing for sure
  const files = { "/private.csv": "x", "/public.csv": "x", "/a.csv": "x" };
  const two = await run({ files, cells: ['p = "private.csv"\np = "public.csv"\nopen(p)\n'] });
  eq([two.paths, said(two, /bound more than once/)], [[], true], "ASTRA-2: overwritten by another constant: neither pre-checked, reported");
  const d = await run({ files, cells: ['p = "private.csv"\np = get_path()\nopen(p)\n'] });
  eq([d.paths, said(d, /bound more than once/)], [[], true], "ASTRA-2: overwritten by a computed value: not pre-checked, reported");
  const cells = await run({ files, cells: ['p = "private.csv"\n', "p = get_path()\n", "open(p)\n"] });
  eq([cells.paths, said(cells, /bound more than once/)], [[], true], "ASTRA-2: across cells (the notebook's globals)");
  const same = await run({ files, cells: ['p = "a.csv"\n', 'p = "a.csv"\nopen(p)\n'] });
  eq(same.paths, ["/a.csv"], "the same constant twice is one value (control)");
  const local = await run({ files, cells: ['p = "a.csv"\ndef f():\n    p = get()\n    return p\nopen(p)\n'] });
  eq(local.paths, ["/a.csv"], "a function's own p is another name (control)");
  const glob = await run({ files, cells: ['p = "a.csv"\ndef f():\n    global p\n    p = get()\nopen(p)\n'] });
  eq([glob.paths, said(glob, /bound more than once/)], [[], true], "...but `global p` rebinds the module's p");
}
{
  // CORR-170-ASTRA-3: bindings stay in their scope
  const files = { "/private.csv": "x", "/b.npy": "x" };
  const pr = await run({ files, cells: ['def f(print):\n    pass\nprint("private.csv")\n'] });
  eq(pr.paths, [], "ASTRA-3: a function's parameter named print doesn't change the module's print");
  const np = await run({ files, cells: ['import numpy as np\ndef g(np):\n    return np\nx = np.load("b.npy")\n'] });
  eq(np.deps, [["/b.npy", { kind: "opened", cell: 0 }]], "ASTRA-3: ...nor a parameter named np the module's np (an opener)");
  const shadow = await run({ files, cells: ['def h(open):\n    return open("private.csv")\n'] });
  eq(shadow.deps.map((d) => d[1].kind), ["named"], "a local open is the caller's, not builtins.open: 'named', not 'opened'");
}
{
  // CORR-170-ASTRA-4: what the code computes or lists is reported
  const files = { "/a.csv": "x" };
  const r = await run({ files, cells: ['p = get_path()\nopen(p)\n', "open(get_path())\n", 'import glob\nglob.glob("*.csv")\n', 'from pathlib import Path\nfor f in Path(".").glob("*.csv"):\n    pass\n'] });
  eq(r.paths, [], "ASTRA-4: nothing pre-checked");
  eq(r.unf.map((u) => u.where.cell), [0, 1, 2, 3], "ASTRA-4: each of the four reported, in its own cell");
  ok(said(r, /glob\.glob\("\*\.csv"\)/) && said(r, /Path\(\)\.glob/), "ASTRA-4: the glob patterns are named in the report");
  ok(r.complete === true, "reports don't make the result incomplete: only a skipped or unparsed unit, or an abort, does");
  const arg = await run({ files, cells: ['open("a.csv", "r")\n'] });
  eq(arg.deps, [["/a.csv", { kind: "opened", cell: 0 }]], "an opener's file is its first argument; the mode isn't a file");
}

// ---- #170 r2's review: astra3's CORR-170-R2-ASTRA-1..3 (CPython's answers in astra3's report)
{
  const files = { "/private.csv": "x", "/public.csv": "x" };
  // R2-1: nonlocal binds in the nearest enclosing function that binds the name, skipping one that doesn't
  const nl = await run({ files, cells: ['def outer():\n    p = "public.csv"\n    def middle():\n        def change():\n            nonlocal p\n            p = "private.csv"\n        change()\n    middle()\n    open(p)\nouter()\n'] });
  eq([nl.paths, said(nl, /p is bound more than once/)], [[], true], "R2-1: a nonlocal write two functions down rebinds outer's p: neither pre-checked, reported");
  const one = await run({ files, cells: ['def outer():\n    p = "public.csv"\n    def change():\n        nonlocal p\n        p = "private.csv"\n    change()\n    open(p)\n'] });
  eq(one.paths, [], "R2-1: ...and one function down");
  const read = await run({ files, cells: ['def outer():\n    p = "public.csv"\n    def show():\n        return p\n    open(p)\n'] });
  eq(read.paths, ["/public.csv"], "a nested function only reading p doesn't rebind it (control)");
  // R2-2: a class body runs in order
  const cls = await run({ files, cells: ['p = "private.csv"\nclass C:\n    open(p)\n    p = "public.csv"\n'] });
  eq(cls.deps, [["/private.csv", { kind: "opened", cell: 0 }]], "R2-2: open(p) before the class's own p = ...: the module's p, as Python reads it");
  const after = await run({ files, cells: ['p = "private.csv"\nclass C:\n    p = "public.csv"\n    open(p)\n'] });
  eq(after.paths, ["/public.csv"], "R2-2: after the class's assignment: the class's p (control)");
  const cond = await run({ files, cells: ['p = "private.csv"\nclass C:\n    if flag:\n        p = "public.csv"\n    open(p)\n'] });
  eq([cond.paths, said(cond, /bound more than once/)], [[], true], "R2-2: a conditional class binding: either may be seen: neither pre-checked, reported");
  const method = await run({ files, cells: ['p = "private.csv"\nclass C:\n    p = "public.csv"\n    def m(self):\n        return open(p)\n'] });
  eq(method.paths, ["/private.csv"], "a method doesn't see the class body's p: the module's (control)");
  // R2-3: a container that changes or is copied
  const sub = await run({ files, cells: ['p = ["private.csv"]\np[0] = "public.csv"\nhandle(p)\n'] });
  eq([sub.paths, said(sub, /holds a list, dict or set/)], [[], true], "R2-3: p[0] = ...: the list's old constant isn't pre-checked, reported");
  for (const [src, what] of [
    ['d = {"k": "private.csv"}\nd["k"] = "public.csv"\nhandle(d)\n', "a dict's item replaced"],
    ['d = {"k": "private.csv"}\ndel d["k"]\nhandle(d)\n', "a dict's item deleted"],
    ['p = ["private.csv"]\np.clear()\nhandle(p)\n', "a mutating method"],
    ['p = ["private.csv"]\nq = p\nq[0] = "public.csv"\nhandle(p)\n', "changed through an alias"],
    ['p = ["private.csv"]\ndef f():\n    return p\nhandle(p)\n', "returned, so anyone may change it"],
  ]) eq((await run({ files, cells: [src] })).paths, [], `R2-3: ${what}: not pre-checked`);
  // r3's review: a change nested inside the container
  for (const [src, what] of [
    ['p = [["private.csv"]]\np[0][0] = "public.csv"\nhandle(p)\n', "p[0][0] = ..."],
    ['p = {"k": {"item": "private.csv"}}\ndel p["k"]["item"]\nhandle(p)\n', 'del p["k"]["item"]'],
    ['p = [["private.csv"]]\np[0].clear()\nhandle(p)\n', "p[0].clear()"],
  ]) {
    const r = await run({ files, cells: [src] });
    eq([r.paths, said(r, /holds a list, dict or set/)], [[], true], `R2-3 (r3): a nested change, ${what}: not pre-checked, reported`);
  }
  // r4's review, and the rule that closes the class: a name stands for a container's constants only if it is
  // immutable all the way down; one holding a list, dict or set anywhere is reported, never pre-checked
  for (const [src, what] of [
    ['p = (["private.csv"],)\np[0].clear()\nhandle(p)\n', "a list inside a tuple, cleared"],
    ['p = [["private.csv"]]\nq = p[0]\nq.clear()\nhandle(p)\n', "an inner list taken out and cleared"],
    ['p = [["private.csv"]]\nx = p[0][0]\nhandle(p)\n', "a nested list only read (still a list)"],
    ['fs = ["private.csv"]\nhandle(fs)\n', "a list left alone (still a list)"],
    ['a = ["private.csv"]\np = (a,)\nhandle(p)\n', "a tuple holding a list through a name"],
  ]) {
    const r = await run({ files, cells: [src] });
    eq([r.paths, said(r, /holds a list, dict or set/)], [[], true], `R4: ${what}: not pre-checked, reported`);
  }
  const imm = await run({ files, cells: ['t = ("public.csv", ("private.csv",))\nu = t\nfor x in t: pass\nhandle(t)\n'] });
  eq(imm.paths, ["/public.csv", "/private.csv"], "a tuple of strings, nested, copied and iterated: immutable all the way down, still counts (control)");
  const lit = await run({ files, cells: ['handle(["private.csv", {"k": "public.csv"}])\n'] });
  eq(lit.paths, ["/private.csv", "/public.csv"], "a list or dict written out in the call itself: nothing can change it first (control)");
  const inner = await run({ files, cells: ['a = ["private.csv"]\nhandle([a, "public.csv"])\n'] });
  eq([inner.paths, said(inner, /holds a list, dict or set/)], [[], true], "...but one holding a list name: the whole is reported");
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
    packageModules: new Set(),
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
