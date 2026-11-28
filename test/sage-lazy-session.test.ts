import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// Sage mode's session namespace loads a domain the first time one of its names is used (lib/_sage_lazy.py session,
// lib/_sage_names.py; the runtime's miss path, src/runtime/modules.ts builtinName): the session starts with sage_all's
// base only, and every other name of sage_all's __all__ is still there, as the same object, wherever a use reaches it.
// Each case is a fresh `--sage` process (dist/src/cli.js); it prints one JSON line after "@@".
const CLI = path.join(__dirname, "../src/cli.js");
const LIB = path.join(__dirname, "../../lib");

function sage(code: string): any {
  const r = spawnSync(process.execPath, [CLI, "--sage", "-c", code], { encoding: "utf8", timeout: 600_000 });
  const i = r.stdout.lastIndexOf("@@");
  assert.ok(i >= 0, `no result line: status ${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(i + 2));
}
const LOADED = `sorted(m for m in __import__("sys").modules if m.startswith(("_sage_", "sage_")))`;
const out = (expr: string) => `import json as _json; print("@@" + _json.dumps(${expr}))`;

// (the modules sage_all's start loads: itself and the base the preparser, ZZ, QQ, polynomials, matrices, the reals and
// symbolic expressions need; the name index, read on a first use; _sage_shim installed in pyjs)
const BASE = ["_sage_expr", "_sage_frac", "_sage_integer", "_sage_lang", "_sage_lazy", "_sage_matrix", "_sage_names", "_sage_poly", "_sage_real", "_sage_shim", "sage_all"];

test("a session starts with sage_all's base only; one use of a name loads its domain (and what that imports), nothing else", () => {
  assert.deepEqual(sage(out(LOADED)), BASE);
  // (the use alone: what a call then does may import more, at call time, as Sage's modules do)
  // (_sage_graph's GraphPlot subclasses sage_plot's Graphics, which a call at its module level imports)
  const after: string[] = sage(`G = Graph\n${out(LOADED)}`);
  assert.deepEqual(after.filter((m) => !BASE.includes(m)), ["_sage_graph", "sage_plot"]);
  const lie: string[] = sage(`C = crystals\n${out(LOADED)}`);
  assert.deepEqual(lie.filter((m) => !BASE.includes(m)), ["_sage_crystals", "_sage_lie"], "and the modules its DEPS name");
});

test("every name of sage_all's __all__ is the same object in the session as sage_all's attribute; a builtin's name is bound at the start", () => {
  const r = sage(`import sage_all, builtins
start = set(globals())
# (eval at the top level, not in a comprehension, whose own variable would be the one it saw)
shadow = [_k for _k in sage_all.__all__ if hasattr(builtins, _k)]
bad_shadow = [_k for _k in shadow if _k not in start]
lazy = [_k for _k in sage_all.__all__ if _k not in start]
bad = []
for _k in sage_all.__all__:
    if eval(_k, globals()) is not getattr(sage_all, _k):
        bad.append(_k)
${out(`{"shadow": len(shadow), "bad_shadow": bad_shadow, "lazy": len(lazy), "bad": bad, "bound": all(_k in globals() for _k in lazy)}`)}`);
  assert.deepEqual(r.bad_shadow, [], "a name that shadows a builtin must be bound at the session's start");
  assert.deepEqual(r.bad, []);
  assert.ok(r.lazy > 100, `the names loaded on first use: ${r.lazy}`);
  assert.equal(r.bound, true, "a name once used is bound in the session");
});

test("a star import of sage_all (or of sage.all) binds every name of __all__, the same objects, as before", () => {
  const r = sage(`import sage_all
ns = {}
exec("from sage_all import *", ns)
ns2 = {}
exec("from sage.all import *", ns2)
names = set(sage_all.__all__)
${out(`{"missing": sorted(names - set(ns)), "missing2": sorted(names - set(ns2)), "same": all(ns[n] is getattr(sage_all, n) for n in names)}`)}`);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.missing2, []);
  assert.equal(r.same, true);
});

test("a name first used inside a function, a lambda, a comprehension, a nested closure or a class body defined before that use", () => {
  const r = sage(`def f(n):
    return Partitions(n).cardinality()
g = lambda: str(Zp(5))
def outer():
    def inner():
        return DiGraph({0: [1]}).size()
    return inner
class C:
    k = CartanType(["A", 2]).rank()
${out(`[int(f(5)), g(), [int(Permutations(k).cardinality()) for k in (2, 3)], int(outer()()), int(C.k)]`)}`);
  assert.deepEqual(r, [7, "5-adic Ring with capped relative precision 20", [2, 6], 1, 2]);
});

test("eval(s) and exec(s, globals()) in the session, sage_eval, and isinstance with a class loaded lazily", () => {
  const r = sage(`exec("H = Graph({0: [1, 2]})", globals())
from sage.graphs.graph import Graph as G2
${out(`[int(H.size()), str(eval("QQbar(2).sqrt()")), int(sage_eval("Sandpile({0: {1: 1}, 1: {0: 1}}, 0).num_verts()")), isinstance(H, Graph), Graph is G2]`)}`);
  assert.deepEqual(r, [2, "1.414213562373095?", 2, true, true]);
});

test("del: a name deleted, loaded or not yet, is a NameError afterwards, not loaded again; an unknown name's del is a NameError", () => {
  const r = sage(`res = []
x0 = Graph
del Graph
del NumberField
for n in ("Graph", "NumberField"):
    try:
        eval(n)
        res.append("bound")
    except NameError:
        res.append("NameError")
try:
    del no_such_name_anywhere
except NameError:
    res.append("NameError")
Graph = 3
res.append(Graph)
${out("res")}`);
  assert.deepEqual(r, ["NameError", "NameError", "NameError", 3]);
});

test("a domain that fails to import: its own error, a note naming the Sage name, nothing kept; the next use tries again", () => {
  const r = sage(`import _sage_names as N
N.NAMES["Polyhedron"] = "_sage_no_such_module"
res = []
for _ in range(2):
    try:
        Polyhedron
    except ImportError as e:
        res.append([type(e).__name__, e.__notes__])
N.NAMES["Polyhedron"] = "_sage_polyhedra"
res.append(str(Polyhedron([(0, 0), (1, 0), (0, 1)]).volume()))
${out("res")}`);
  const failed = ["ModuleNotFoundError", ["(loading 'Polyhedron' in Sage mode, from _sage_no_such_module)"]];
  assert.deepEqual(r, [failed, failed, "1/2"]);
  // (a domain whose import raises a KeyError: that KeyError, with the note, never a NameError; at a global use, through
  // the session's module and through `from __main__ import`)
  const k = sage(`import _sage_names as N, os, sys, tempfile
d = tempfile.mkdtemp()
with open(os.path.join(d, "_sage_keyerror_domain.py"), "w") as f:
    f.write("raise KeyError('domain import failed')\\n")
sys.path.insert(0, d)
N.NAMES["Polyhedron"] = "_sage_keyerror_domain"
import __main__
res = []
for use in (lambda: Polyhedron, lambda: __main__.Polyhedron, lambda: exec("from __main__ import Polyhedron", {})):
    try:
        use()
    except Exception as e:
        res.append([type(e).__name__, str(e), e.__notes__])
${out("res")}`);
  const kerr = ["KeyError", "'domain import failed'", ["(loading 'Polyhedron' in Sage mode, from _sage_keyerror_domain)"]];
  assert.deepEqual(k, [kerr, kerr, kerr]);
});

test("dir() lists the names not loaded yet, not a deleted one; globals() and a copy of it hold only what is bound (CPython's)", () => {
  const r = sage(`a = "Graph" in dir()
b = "Graph" in globals()
c = "Graph" in dict(globals())
x1 = Graph
d = "Graph" in globals()
del Sandpile
${out(`[a, b, c, d, "Sandpile" in dir(), "Graph" in dir()]`)}`);
  assert.deepEqual(r, [true, false, false, true, false, true]);
});

test("the library's copies of the session are sessions: an interact input box's and a board check's text use a name not loaded yet", () => {
  // (lib/_interact.py input_box.convert and lib/_sb_check.py prepare copy __main__'s names: _sage_lazy.session_copy)
  const r = sage(`from _interact import input_box
import _sb_check
a = int(input_box(3).convert("SymmetricGroup(3).order()"))
_sb_check.prepare("null")
exec("r = DihedralGroup(4).order()", _sb_check.ns.__dict__)
b = int(_sb_check.ns.r)
${out(`[a, b, "SymmetricGroup" in globals(), "DihedralGroup" in globals()]`)}`);
  // (the copies loaded them; the session itself has bound neither)
  assert.deepEqual(r, [6, 8, false, false]);
  // (a name deleted in the session stays deleted in its copy)
  const d = sage(`del CuspForms
from _sage_lazy import session_copy
c = session_copy(globals())
try:
    eval("CuspForms", c)
    res = "bound"
except NameError:
    res = "NameError"
${out(`[res, str(eval("Gamma0(11)", c))]`)}`);
  assert.deepEqual(d, ["NameError", "Congruence Subgroup Gamma0(11)"]);
});

test("the session's module answers for a name not loaded yet: __main__.X, getattr, hasattr, from __main__ import X", () => {
  const r = sage(`import __main__
a = int(__main__.CuspForms(11).dimension())
b = str(getattr(__main__, "Gamma0")(11))
c = hasattr(__main__, "SymmetricGroup")
from __main__ import DihedralGroup
d = int(DihedralGroup(3).order())
e = hasattr(__main__, "no_such_name_anywhere")
del Sandpile
f = hasattr(__main__, "Sandpile")
${out(`[a, b, c, d, e, f, "CuspForms" in globals()]`)}`);
  // (a load through the module binds the name in the session, as a global use's does)
  assert.deepEqual(r, [1, "Congruence Subgroup Gamma0(11)", true, 6, false, false, true]);
});

test("del __main__.X: a name deleted through the module, loaded or not yet, stays deleted; an unknown one is an AttributeError", () => {
  const r = sage(`import __main__
res = []
x0 = Graph
del __main__.Graph
del __main__.NumberField
for n in ("Graph", "NumberField"):
    try:
        eval(n)
        res.append("bound")
    except NameError:
        res.append("NameError")
    res.append(hasattr(__main__, n))
    try:
        getattr(__main__, n)
        res.append("bound")
    except AttributeError:
        res.append("AttributeError")
for n in ("Graph", "no_such_name_anywhere"):
    try:
        delattr(__main__, n)
        res.append("deleted")
    except AttributeError:
        res.append("AttributeError")
__main__.Graph = 3
res.append(Graph)
__main__.mine = 1
del __main__.mine
res.append(hasattr(__main__, "mine"))
try:
    del __main__.mine
except AttributeError:
    res.append("AttributeError")
${out(`res + ["NumberField" in dir()]`)}`);
  // (a name of the user's, not one of sage_all's, deletes as on any module)
  assert.deepEqual(r, ["NameError", false, "AttributeError", "NameError", false, "AttributeError", "AttributeError", "AttributeError", 3, false, "AttributeError", false]);
});

test("a global name's miss is part of its line: a NameError's traceback and sys._getframe have no frame of the compiler's $N", () => {
  const r = spawnSync(process.execPath, [CLI, "-c", "import sys\ndef f():\n    try:\n        no_such_name\n    except NameError:\n        print(sys._getframe(0).f_code.co_name, sys._getframe(1).f_code.co_name)\n    return no_such_name\nf()"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.stdout, "f <module>\n");
  assert.equal(r.stderr, 'Traceback (most recent call last):\n  File "<string>", line 8, in <module>\n  File "<string>", line 7, in f\nNameError: name \'no_such_name\' is not defined\n'.replace('line 8, in <module>\n', 'line 8, in <module>\n    f()\n').replace("line 7, in f\n", "line 7, in f\n    return no_such_name\n"));
});

test("a user's sagebrush.py beside the program: the first use of every lazily loaded name works, the user's import gets theirs", () => {
  // (each domain loaded later imports the library's own package by its private name, _sagebrush_lib, whatever the
  // program's folder holds: src/compile.ts libraryPackage)
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-lazy-shadow-")));
  try {
    writeFileSync(path.join(d, "sagebrush.py"), "MINE = 'mine'\n");
    writeFileSync(path.join(d, "p.sage"), `import sage_all
start = set(globals())
bad = []
for _k in sage_all.__all__:
    if _k not in start:
        try:
            eval(_k, globals())
        except Exception as e:
            bad.append("%s: %s: %s" % (_k, type(e).__name__, e))
import sagebrush
${out(`{"bad": bad, "mine": getattr(sagebrush, "MINE", None), "loaded": len([m for m in __import__("sys").modules if m.startswith(("_sage_", "sage_"))])}`)}`);
    const r = spawnSync(process.execPath, [CLI, "p.sage"], { cwd: d, encoding: "utf8", timeout: 600_000 });
    const i = r.stdout.lastIndexOf("@@");
    assert.ok(i >= 0, `no result line: ${r.status}\n${r.stdout}\n${r.stderr}`);
    const res = JSON.parse(r.stdout.slice(i + 2));
    assert.deepEqual(res.bad, []);
    assert.equal(res.mine, "mine");
    assert.ok(res.loaded > 30, `the domains loaded: ${res.loaded}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the name index names only library modules that exist, and the browser's chunks hold each of them", () => {
  // (lib/_sage_names.py: NAMES, OVERRIDES and DEPS's modules; web/lib-chunks.mts puts every lib/ file in a group)
  const r = sage(`import _sage_names as N
mods = set(N.NAMES.values()) | set(N.OVERRIDES.values()) | set(N.DEPS) | {d for ds in N.DEPS.values() for d in ds}
${out("sorted(mods)")}`);
  const missing = (r as string[]).filter((m) => !existsSync(path.join(LIB, m + ".py")) && !existsSync(path.join(LIB, m, "__init__.py")));
  assert.deepEqual(missing, []);
  assert.ok(readFileSync(path.join(LIB, "_sage_names.py"), "utf8").includes("DEPS = {"));
});
