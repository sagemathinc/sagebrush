import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// open(F, M).write(S) with plain operands: written and closed at the
// statement (src/emit.ts fileOnceCall, src/runtime/file-once.ts; plan
// pyjs-file-visibility r7 with addendum 1).  CPython 3.14 is the oracle for
// what both print (file_visibility_cases.py, file_visibility_env_cases.py);
// the rest asserts what only pyjs has: which path a site took, the native
// step's descriptor handling, its dependencies, and the divergences kept.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
const cases = (name: string) => {
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [CLI, TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
};
// a pyjs program's output; its directory is D (a fresh one), and COUNT
// counts TextFile and BinaryFile constructions (a file object made: the
// site declined), patched in before the program runs
const PRELUDE = `
import os, sys, _pyjs_open
D = sys.argv[1]
P = lambda n: os.path.join(D, n)
sz = lambda p: os.path.getsize(p) if os.path.exists(p) else -1
COUNT = [0]
# (a large string as a flat one: "a" * N is a rope of a few kilobytes until
# something flattens it; hash() does, and keeps no reference, where an
# index or len() would leave it in strpos's one-string cache)
def flat(s):
    hash(s)
    return s
def _counting(cls):
    init = cls.__init__
    def counted(self, *a):
        COUNT[0] += 1
        init(self, *a)
    cls.__init__ = counted
_counting(_pyjs_open.TextFile)
_counting(_pyjs_open.BinaryFile)
`;
function py(src: string, args: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), "file-once-"));
  try {
    writeFileSync(join(d, "prog.py"), PRELUDE + src);
    const r = spawnSync(process.execPath, [...args, CLI, join(d, "prog.py"), d], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 120000 });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("open(F, M).write(S) with plain operands, its errors, held files and the declines print what CPython prints", () => {
  cases("file_visibility_cases.py");
});

test("lookup order and counts in the four unsafe environments (mapping locals, subclass globals, a __prepare__ namespace, custom builtins) are CPython's", () => {
  cases("file_visibility_env_cases.py");
});

test("an eligible site makes no file object, in each mode and scope: the data is on disk at once and _unwritten is untouched", () => {
  const out = py(`
import _fs
U = _pyjs_open._unwritten
def check(label, p, want):
    # (read through _fs: open() would count a construction)
    print(label, COUNT[0], _fs.read(p) == want, len(U), _pyjs_open._unwritten is U)
for M, S in (("w", "té😀"), ("a", "té😀"), ("wb", b"\\x00b"), ("ab", b"\\x00b")):
    F = P("m" + M)
    n = open(F, M).write(S)
    check("module " + M + " " + str(n), F, S.encode() if isinstance(S, str) else S)
    def fn(F, M, S):
        return open(F, M).write(S)
    G = P("f" + M); fn(G, M, S)
    check("function " + M, G, S.encode() if isinstance(S, str) else S)
    def outer(F=P("c" + M), M=M, S=S):
        def inner():
            return open(F, M).write(S)
        return inner()
    outer()
    check("cell " + M, P("c" + M), S.encode() if isinstance(S, str) else S)
L = P("lit")
open(L, "w").write("literal")
check("literals", L, b"literal")
`);
  for (const line of out.split("\n")) assert.match(line, / 0 True 0 True$/, line);
  assert.equal(out.split("\n").length, 13);
  assert.match(out, /^module w 3 0/m);
  assert.match(out, /^module wb 2 0/m);
});

test("what is not a site, or declines, makes today's file object: one construction each", () => {
  const out = py(`
class Sub(str): pass
class O: a = "x"
S = "s"; F = P("x"); M = "w"; L = ["x"]; SUB = Sub("sub"); LONE = "\\ud800"; BA = bytearray(b"b")
class Path:
    def __fspath__(self): return F
PATH = Path()
MX = "x"; MP = "w+"; MSUB = Sub("w")
def my_open(f, m): return _pyjs_open.open(f, m)
for label, f in [
    ("f-string S", lambda: open(F, M).write(f"{S}")),
    ("attribute S", lambda: open(F, M).write(O.a)),
    ("subscript S", lambda: open(F, M).write(L[0])),
    ("call S", lambda: open(F, M).write(str(S))),
    ("call F", lambda: open(os.path.join(D, "x"), M).write(S)),
    ("keyword mode", lambda: open(F, mode=M).write(S)),
    ("a str subclass S", lambda: open(F, M).write(SUB)),
    ("a lone surrogate", lambda: open(F, M).write(LONE)),
    ("a bytearray", lambda: open(F, "wb").write(BA)),
    ("a PathLike F", lambda: open(PATH, M).write(S)),
    ("mode x", lambda: (os.path.exists(F) and os.remove(F), open(F, MX).write(S))),
    ("mode w+", lambda: open(F, MP).write(S)),
    ("a str-subclass mode", lambda: open(F, MSUB).write(S)),
]:
    COUNT[0] = 0
    f()
    _pyjs_open._flush_all()
    print(label, COUNT[0])
OPEN = open
open = my_open
COUNT[0] = 0
open(F, M).write(S)
print("a user open", COUNT[0])
open = OPEN
`);
  for (const line of out.split("\n")) assert.match(line, / 1$/, line);
  assert.equal(out.split("\n").length, 14);
});

test("the unsafe environments decline before any read, so the site's code makes today's file object (zero native steps)", () => {
  const out = py(`
import builtins
class SD(dict): pass
S = "s"; F = P("e"); M = "w"
SRC = "open(F, M).write(S)"
def run(label, f):
    COUNT[0] = 0
    f()
    print(label, COUNT[0])
run("mapping locals", lambda: exec(SRC, {"F": F, "M": M, "S": S}, SD()))
run("subclass globals", lambda: exec(SRC, SD(F=F, M=M, S=S)))
g = SD(F=F, M=M, S=S)
exec("def f():\\n    open(F, M).write(S)", g)
run("a function over subclass globals", g["f"])
run("custom builtins", lambda: exec(SRC, {"F": F, "M": M, "S": S, "__builtins__": dict(builtins.__dict__)}))
run("custom builtins, a function", lambda: (exec("def f():\\n    open(F, M).write(S)", h := {"F": F, "M": M, "S": S, "__builtins__": dict(builtins.__dict__)}), h["f"]()))
class Meta(type):
    @classmethod
    def __prepare__(m, name, bases): return SD(F=F, M=M, S=S)
def body():
    class C(metaclass=Meta):
        open(F, M).write(S)
run("a __prepare__ namespace", body)
def cls_body():
    class C:
        open(F, M).write(S)
run("a class body", cls_body)
# (exec reads any dict, a module's __dict__ too, through a proxy over it:
# declined, as conservative; a module's own namespace is the runtime's, a
# notebook cell's too, as the control shows)
run("exec globals, a new dict", lambda: exec(SRC, {"F": F, "M": M, "S": S}))
run("the module's own globals (the control: a site)", lambda: open(F, M).write(S))
try:
    import types
    types.FunctionType(cls_body.__code__, SD())
    print("FunctionType(code, globals) runs")
except TypeError as e:
    print("FunctionType(code, globals):", e)
`);
  const lines = out.split("\n");
  for (const l of lines.slice(0, 8)) assert.match(l, / 1$/, l);
  assert.match(lines[8], / 0$/, lines[8]);
  // (pyjs has no FunctionType(code, globals): a function over other
  // globals is one exec defines, above)
  assert.equal(lines[9], "FunctionType(code, globals): function() takes no arguments (2 given)");
});

test("an unbound S takes the native open only after the whole prefix passes: else today's open runs, then the read raises", () => {
  const out = py(`
F = P("u"); M = "w"
class Path:
    def __fspath__(self): return F
PATH = Path()
calls = []
def my_open(f, m):
    calls.append(f)
    return _pyjs_open.open(f, m)
def attempt(label, f):
    COUNT[0] = 0
    try:
        f()
    except NameError as e:
        print(label, type(e).__name__, COUNT[0], len(calls), sz(F))
attempt("canonical", lambda: open(F, M).write(NOPE))
attempt("a PathLike F", lambda: open(PATH, M).write(NOPE))
OPEN = open
open = my_open
attempt("a user open", lambda: open(F, M).write(NOPE))
open = OPEN
`);
  assert.deepEqual(out.split("\n"), ["canonical NameError 0 0 0", "a PathLike F NameError 1 0 0", "a user open NameError 1 1 0"]);
});

test("a declined str-subclass S is read again after today's open: a value the open's code rebinds is the one written", () => {
  const out = py(`
class Sub(str): pass
F = P("r"); M = "w"
S = Sub("old")
init = _pyjs_open.TextFile.__init__
def rebinding(self, *a):
    global S
    S = "new"
    init(self, *a)
_pyjs_open.TextFile.__init__ = rebinding
open(F, M).write(S)
_pyjs_open._flush_all()
print(open(F).read())
def fn():
    s = Sub("old")
    open(F, M).write(s)
`);
  assert.equal(out, "new");
});

// (MEMORY-FILEVIS-R7-1.  pyjs's weakref can't show it: a JavaScript WeakRef
// keeps its target until the running job ends, which is the whole program;
// so, as daybreak2's fallback, the clear is pinned in the generated code and
// the heap is measured after a full collection inside the window)
test("the generated code clears the peek on both of its paths: the eligible call's arguments, and before the declined continuation's open", () => {
  const { compile } = require(__dirname + "/../src/compile.js");
  for (const src of ["open(F, M).write(S)\n", "def f(F, M, S):\n    open(F, M).write(S)\n"]) {
    const code: string = compile(src, "t.py", "__main__").code;
    const m = /: R\.fileOnceFits\((\$\d+), \$\d+\) \? \(R\.fileOnceS\.v = \1, \1 = undefined, R\.fileOnceWrite\(\$\d+, \$\d+\)\) : \(\1 = undefined, \$K\d+\(/.exec(code);
    assert.ok(m, code);
  }
});

test("a declined S is released before the open runs: inside the open, after a full collection, only the new value is live", () => {
  const N = 32 << 20;
  const out = py(`
class Sub(str): pass
F = P("big"); M = "w"
used = sys._sagebrush_heap_used
if used() is None:
    print("no heap figure")
else:
    base = used()
    # (made in a function: a module-level call's argument temporaries would
    # keep the string, today's code's, not the site's)
    def make():
        return Sub(flat("a" * ${N}))
    S = make()
    def make2():
        return flat("b" * ${N})
    seen = []
    init = _pyjs_open.TextFile.__init__
    def rebinding(self, *a):
        global S
        S = make2()
        seen.append(used() - base)
        init(self, *a)
    _pyjs_open.TextFile.__init__ = rebinding
    open(F, M).write(S)
    _pyjs_open.TextFile.__init__ = init
    print(round(seen[0] / ${N}, 2))
`);
  if (out === "no heap figure") return;
  // one 32 MiB string live in the window (the new S), not two
  assert.ok(Number(out) < 1.5, `live in the window: ${out} x 32 MiB`);
});

test("an eligible site keeps no reference to S after it: rebinding S frees the written value", () => {
  // (at module level and in functions, after the site and after a second
  // one; S.encode() in a function as the control)
  const N = 32 << 20;
  const out = py(`
used = sys._sagebrush_heap_used
F = P("big"); M = "w"; X = "x"
if used() is None: raise SystemExit(print("no heap figure"))
def make(c):
    # (in a function: a module-level call's argument temporaries would keep
    # the string, today's code's, not the site's)
    return flat(c * ${N})
base = used()
S = make("a")
open(F, M).write(S)
ok = sz(F) == ${N}
S = None
print("module", round((used() - base) / ${N}, 2), ok)
open(F, M).write(X)
print("module-after-another", round((used() - base) / ${N}, 2))
def site():
    s = flat("b" * ${N})
    open(F, M).write(s)
    s = None
def control():
    s = flat("c" * ${N})
    t = s.encode()
    s = t = None
for f in (control, site, control, site):
    base = used()
    f()
    print(f.__name__, round((used() - base) / ${N}, 2))
`);
  if (out === "no heap figure") return;
  const lines = out.split("\n");
  assert.match(lines[0], / True$/);
  for (const l of lines) assert.ok(Number(l.split(" ")[1]) < 0.5, `live after the site: ${out}`);
});

test("the site's own dependencies only: patching _pyjs_open, its classes, _unwritten or _fs changes nothing at a site; replacing builtins.open declines it", () => {
  const out = py(`
import _fs, builtins
called = []
def never(name):
    def f(*a, **k):
        called.append(name)
        raise AssertionError(name)
    return f
class Keeping(dict):
    def __setitem__(self, k, v):
        called.append("_unwritten")
        dict.__setitem__(self, k, v)
saved = (_pyjs_open.open, _pyjs_open.TextFile.write, _pyjs_open._Mixin._write, _pyjs_open._Mixin.flush, _pyjs_open._unwritten, _fs.write, _fs.isdir)
_pyjs_open.open = never("_pyjs_open.open")
_pyjs_open.TextFile.write = never("TextFile.write")
_pyjs_open._Mixin._write = never("_Mixin._write")
_pyjs_open._Mixin.flush = never("_Mixin.flush")
_pyjs_open._unwritten = Keeping()
_fs.write = never("_fs.write")
_fs.isdir = never("_fs.isdir")
F = P("dep"); M = "w"; S = "dep"
print(open(F, M).write(S), open(F, "rb").read() if False else sz(F), called)
(_pyjs_open.open, _pyjs_open.TextFile.write, _pyjs_open._Mixin._write, _pyjs_open._Mixin.flush, _pyjs_open._unwritten, _fs.write, _fs.isdir) = saved
real = builtins.open
def replaced(f, m):
    called.append("builtins.open")
    return real(f, m)
builtins.open = replaced
open(F, M).write(S)
builtins.open = real
print(called)
`);
  assert.deepEqual(out.split("\n"), ["3 3 []", "['builtins.open']"]);
});

test("file-once.ts depends on what its inventory lists, and nothing reached through Python", () => {
  const src = readFileSync(__dirname + "/../../src/runtime/file-once.ts", "utf8");
  const imports = [...src.matchAll(/^import \{([^}]*)\} from "([^"]+)";$/gm)].map((m) => `${m[2]}: ${m[1].split(",").map((s) => s.trim()).sort().join(" ")}`);
  assert.deepEqual(imports, ["./object: NS_DICT NS_GLOBALS PyBytes T callObj markRaised typeOf", "./builtins: builtins", "./modules: hostPath"]);
  assert.equal([...src.matchAll(/^import /gm)].length, 3);
  assert.deepEqual([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]), ["fs"]);
  for (const name of ["getattr", "importModule", "sysModules", "callKw", "lookupType", "special(", "globalThis"]) assert.ok(!src.includes(name), name);
});

// The native step through its test hook (ops): the descriptor calls counted
function native(script: string): any {
  const prog = `
    require(${JSON.stringify(__dirname + "/../src/runtime/index.js")});
    const FO = require(${JSON.stringify(__dirname + "/../src/runtime/file-once.js")});
    const O = require(${JSON.stringify(__dirname + "/../src/runtime/object.js")});
    const log = [];
    const ops = (o = {}) => ({
      open: o.open ?? ((p, a) => (log.push(["open", p, a]), 7)),
      write: o.write ?? ((fd, d, off, len) => (log.push(["write", fd, off, len]), len)),
      close: o.close ?? ((fd) => log.push(["close", fd])),
    });
    const err = (code, errno) => Object.assign(new Error(code), { code, errno: -errno });
    const show = (e) => e === null || e === undefined ? null : { cls: O.getattr(O.typeOf(e), "__name__"), args: O.getattr(e, "args").map(String), filename: O.getattr(e, "filename"), context: show(e.__context__) };
    const attempt = (f) => { try { f(); return null; } catch (e) { return show(e); } };
    ${script}
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", prog], { encoding: "utf8" }));
}

test("the native step: every byte written through short writes, nothing written for empty data, the descriptor closed once", () => {
  const r = native(`
    const data = new Uint8Array(10);
    let calls = 0;
    const short = ops({ write: (fd, d, off, len) => (log.push(["write", fd, off, len]), Math.min(len, 3)) });
    const a = attempt(() => FO.writeWhole("/f", false, data, short));
    const one = log.splice(0);
    const b = attempt(() => FO.writeWhole("/f", true, new Uint8Array(0), ops()));
    const empty = log.splice(0);
    const c = attempt(() => FO.writeWhole("/f", false, null, ops()));
    console.log(JSON.stringify({ a, one, b, empty, c, touch: log }));
  `);
  assert.equal(r.a, null);
  assert.deepEqual(r.one, [["open", "/f", false], ["write", 7, 0, 10], ["write", 7, 3, 7], ["write", 7, 6, 4], ["write", 7, 9, 1], ["close", 7]]);
  assert.deepEqual(r.empty, [["open", "/f", true], ["close", 7]]);
  assert.deepEqual(r.touch, [["open", "/f", false], ["close", 7]]);
});

test("the native step: a write that makes no progress raises OSError (EIO) at once; the descriptor is closed once", () => {
  const r = native(`
    let writes = 0;
    // (a loop that kept going ends at 100 calls, failing the test)
    const e = attempt(() => FO.writeWhole("/f", false, new Uint8Array(4), ops({ write: () => { if (++writes > 100) throw new Error("spun"); return 0; } })));
    console.log(JSON.stringify({ e, writes, log }));
  `);
  assert.equal(r.writes, 1);
  assert.equal(r.e.cls, "OSError");
  assert.equal(r.e.args[0], "5");
  assert.equal(r.e.filename, null);
  assert.deepEqual(r.log, [["open", "/f", false], ["close", 7]]);
});

test("the native step's error precedence: an open error alone; a write error, with a close error as its __context__; a close error alone", () => {
  const r = native(`
    const openErr = attempt(() => FO.writeWhole("/nodir/f", false, new Uint8Array(1), ops({ open: () => { throw err("ENOENT", 2); } })));
    const afterOpen = log.splice(0);
    const both = attempt(() => FO.writeWhole("/f", false, new Uint8Array(1), ops({ write: () => { throw err("ENOSPC", 28); }, close: (fd) => { log.push(["close", fd]); throw err("EIO", 5); } })));
    const afterBoth = log.splice(0);
    const closeOnly = attempt(() => FO.writeWhole("/f", false, new Uint8Array(1), ops({ close: (fd) => { log.push(["close", fd]); throw err("EIO", 5); } })));
    const afterClose = log.splice(0);
    console.log(JSON.stringify({ openErr, afterOpen, both, afterBoth, closeOnly, afterClose }));
  `);
  assert.deepEqual(r.openErr, { cls: "FileNotFoundError", args: ["2", "No such file or directory"], filename: "/nodir/f", context: null });
  assert.deepEqual(r.afterOpen, []);
  assert.deepEqual(r.both, { cls: "OSError", args: ["28", "No space left on device"], filename: null, context: { cls: "OSError", args: ["5", "Input/output error"], filename: null, context: null } });
  assert.deepEqual(r.afterBoth, [["open", "/f", false], ["close", 7]]);
  assert.deepEqual(r.closeOnly, { cls: "OSError", args: ["5", "Input/output error"], filename: null, context: null });
  assert.deepEqual(r.afterClose, [["open", "/f", false], ["write", 7, 0, 1], ["close", 7]]);
});

test("a full device raises OSError at the site, small writes too (a divergence: CPython's small write returns and reports at finalization)", { skip: !existsSync("/dev/full") }, () => {
  const out = py(`
F = "/dev/full"
for M, S in (("w", "x"), ("w", "x" * 1000000), ("wb", b"x"), ("wb", b"x" * 1000000)):
    try:
        open(F, M).write(S)
        print("returned")
    except OSError as e:
        print(type(e).__name__, e.errno, COUNT[0])
`);
  assert.deepEqual(out.split("\n"), ["OSError 28 0", "OSError 28 0", "OSError 28 0", "OSError 28 0"]);
});

test("10^4 whole-file reads keep nothing: _unwritten stays empty and the heap does not grow with them", () => {
  const out = py(`
F = P("big"); M = "w"; S = "x" * (1 << 20)
open(F, M).write(S)
used = sys._sagebrush_heap_used
before = used()
for i in range(10000):
    x = open(F).read()
x = None
after = used()
print(len(_pyjs_open._unwritten), "none" if before is None else int((after - before) / 1048576))
`);
  const [n, mib] = out.split(" ");
  assert.equal(n, "0");
  if (mib !== "none") assert.ok(Number(mib) < 8, `the heap grew ${mib} MiB`);
});

test("the divergences kept, as documented (README): pyjs's results beside CPython's", () => {
  const out = py(`
f = None
# io-oracle-r5 1, 2: S is a call, not a site (CPython: 'ABBB'; 'new' 'old')
F = P("abbb"); M = "w"
def other():
    open(F, "a").write("BBBB")
    return "A"
open(F, M).write(other())
_pyjs_open._flush_all()
print(1, repr(open(F).read()))
# a held file's flush writes its whole buffer (CPython: 'ABBB')
F = P("whole"); f = open(F, "w"); f.write("A"); open(F, M).write("BBBB"); f.close()
print(2, repr(open(F).read()))
# a file released by rebinding is still pending (CPython: 'AB')
F = P("rebind"); f = open(F, "a"); f.write("A"); f = None; open(F, "a").write("B"); _pyjs_open._flush_all()
print(3, repr(open(F).read()))
# a call operand is not a site, so its file is written later (CPython: 'x')
open(os.path.join(D, "call"), "w").write("x")
print(4, repr(open(P("call")).read()))
_pyjs_open._flush_all()
print(5, repr(open(P("call")).read()))
`);
  assert.deepEqual(out.split("\n"), ["1 'A'", "2 'A'", "3 'BA'", "4 ''", "5 'x'"]);
});
