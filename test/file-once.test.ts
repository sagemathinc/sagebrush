import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// open(F, M).write(S) as a statement, any F, M and S: written and closed at
// the statement (src/emit.ts fileOnceStmt, src/runtime/file-once.ts; plan
// pyjs-file-visibility r7 with addendum 1, then c1 + c2: the file opened
// once at the open's position and held while S is evaluated).  CPython 3.14
// is the oracle for what both print (file_visibility_cases.py,
// file_visibility_env_cases.py); the rest asserts what only pyjs has: which
// path a site took, the descriptor's handling, its dependencies, the memory
// a site keeps, and the divergences kept.
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

test("open(F, M).write(S): plain and computed operands, S evaluated with the file open (ABBB, rename, raising), its errors, held files and the declines print what CPython prints", () => {
  cases("file_visibility_cases.py");
});

test("lookup order and counts in mapping locals, subclass globals, a __prepare__ namespace and custom builtins are CPython's", () => {
  cases("file_visibility_env_cases.py");
});


// (a Python program in a worker, Stop (the shared interrupt flag) set after
// ms: the last line of its traceback, or "finished")
function stopAfter(code: string, ms: number): Promise<string> {
  const { Worker } = require("node:worker_threads");
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      // (lib on the path, as the CLI has it)
      c.R.importModule("sys").path.push(c.libDir());
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      try {
        c.execModule(workerData.code, "<test>", "__main__");
        parentPort.postMessage({ done: "finished" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: __dirname + "/..", code } },
  );
  return new Promise((resolve, reject) => {
    let stop: any;
    const timer = setTimeout(() => (w.terminate(), resolve("not interrupted")), ms + 20000);
    w.on("message", (m: any) => {
      if (m.intr) stop = setTimeout(() => Atomics.store(new Int32Array(m.intr), 0, 1), ms);
      if (m.done) (clearTimeout(timer), clearTimeout(stop), w.terminate(), resolve(m.done));
    });
    w.on("error", reject);
  });
}

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
            open(F, M).write(S)
        inner()
    outer()
    check("cell " + M, P("c" + M), S.encode() if isinstance(S, str) else S)
    class C:
        open(P("k" + M), M).write(S)
    check("class body " + M, P("k" + M), S.encode() if isinstance(S, str) else S)
L = P("lit")
open(L, "w").write("literal")
check("literals", L, b"literal")
`);
  for (const line of out.split("\n")) assert.match(line, / 0 True 0 True$/, line);
  assert.equal(out.split("\n").length, 17);
  assert.match(out, /^module w 3 0/m);
  assert.match(out, /^module wb 2 0/m);
});

test("computed operands are sites too (c1 + c2): a call, an f-string, + and json.dumps; an ineligible S is written through the open descriptor, no file object made", () => {
  const out = py(`
import json
class Sub(str): pass
class O: a = "x"
S = "s"; L = ["x"]; MODES = ["w", "wb"]
def written(label, f, p, want):
    COUNT[0] = 0
    f()
    print(label, COUNT[0], open(p, "rb").read() == want)
def c1(): open(os.path.join(D, "c1"), "w").write(S)
def c2(): open(P("c2"), "w").write(f"{S}!")
def c3(): open(P("c3"), "w").write(O.a + L[0])
def c4(): open(D + "/c4", MODES[0]).write(json.dumps({"k": 1}))
def c5(): open(P("c5"), MODES[1]).write(bytearray(b"ba"))
def c6(): open(P("c6"), "w").write(Sub("sub"))
def c7(): open(P("c7"), "wb").write(memoryview(b"mv"))
written("call F", c1, P("c1"), b"s")
written("f-string S", c2, P("c2"), b"s!")
written("attribute + subscript S", c3, P("c3"), b"xx")
written("+ F, subscript M, call S", c4, P("c4"), b'{"k": 1}')
written("a bytearray S", c5, P("c5"), b"ba")
written("a str-subclass S", c6, P("c6"), b"sub")
written("a memoryview S", c7, P("c7"), b"mv")
`);
  for (const line of out.split("\n")) assert.match(line, / 0 True$/, line);
  assert.equal(out.split("\n").length, 7);
});

test("what declines makes today's file object (one construction); what isn't a statement site (a lambda's body, an argument, an S that yields) is today's code", () => {
  const out = py(`
class Sub(str): pass
S = "s"; F = P("x"); M = "w"
class Path:
    def __fspath__(self): return F
PATH = Path()
MX = "x"; MP = "w+"; MSUB = Sub("w")
def d1(): open(F, mode=M).write(S)
def d2(): open(PATH, M).write(S)
def d3():
    os.path.exists(F) and os.remove(F)
    open(F, MX).write(S)
def d4(): open(F, MP).write(S)
def d5(): open(F, MSUB).write(S)
def g():
    open(F, M).write((yield))
def n1(): print(open(F, M).write(S), end=" ")
def yielding():
    it = g()
    next(it)
    try:
        it.send("y")
    except StopIteration:
        pass
for label, f in [
    ("keyword mode", d1), ("a PathLike F", d2), ("mode x", d3), ("mode w+", d4),
    ("a str-subclass mode", d5),
    ("a lambda's body", lambda: open(F, M).write(S)),
    ("an argument", n1),
    ("an S that yields", yielding),
]:
    COUNT[0] = 0
    try:
        f()
    except StopIteration:
        pass
    _pyjs_open._flush_all()
    print(label, COUNT[0])
calls = []
def my_open(f, m):
    calls.append(f)
    return _pyjs_open.open(f, m)
OPEN = open
open = my_open
COUNT[0] = 0
open(F, M).write(S)
print("a user open", COUNT[0], len(calls))
open = OPEN
`);
  const lines = out.split("\n");
  for (const l of lines.slice(0, 8)) assert.match(l, / 1$/, l);
  assert.equal(lines[8], "a user open 1 1");
});

test("in every namespace (mapping locals, subclass globals, a __prepare__ namespace, custom builtins) the site is native: nothing is read ahead of its place, so the lookups are CPython's (file_visibility_env_cases.py)", () => {
  const out = py(`
import builtins
class SD(dict): pass
S = "s"; F = P("e"); M = "w"
SRC = "open(F, M).write(S)"
def run(label, f):
    COUNT[0] = 0
    f()
    print(label, COUNT[0], sz(F))
    os.remove(F)
run("mapping locals", lambda: exec(SRC, {"F": F, "M": M, "S": S}, SD()))
run("subclass globals", lambda: exec(SRC, SD(F=F, M=M, S=S)))
g = SD(F=F, M=M, S=S)
exec("def f():\\n    open(F, M).write(S)", g)
run("a function over subclass globals", g["f"])
run("custom builtins", lambda: exec(SRC, {"F": F, "M": M, "S": S, "__builtins__": dict(builtins.__dict__)}))
class Meta(type):
    @classmethod
    def __prepare__(m, name, bases): return SD(F=F, M=M, S=S)
def body():
    class C(metaclass=Meta):
        open(F, M).write(S)
run("a __prepare__ namespace", body)
try:
    import types
    types.FunctionType(body.__code__, SD())
    print("FunctionType(code, globals) runs")
except TypeError as e:
    print("FunctionType(code, globals):", e)
`);
  const lines = out.split("\n");
  for (const l of lines.slice(0, 5)) assert.match(l, / 0 1$/, l);
  // (pyjs has no FunctionType(code, globals): a function over other
  // globals is one exec defines, above)
  assert.equal(lines[5], "FunctionType(code, globals): function() takes no arguments (2 given)");
});

test("S is evaluated after the open: an unbound S raises its scope's error with the file created; S that raises leaves it created and the descriptor closed", () => {
  const out = py(`
F = P("u"); M = "w"
def local():
    open(F, M).write(s)
    s = 1
def cell():
    def inner():
        open(F, M).write(c)
    try:
        inner()
    finally:
        pass
    c = 1
def attempt(label, f):
    COUNT[0] = 0
    if os.path.exists(F): os.remove(F)
    try:
        f()
    except NameError as e:
        print(label, type(e).__name__, COUNT[0], sz(F))
def glob(): open(F, M).write(NOPE)
attempt("global", glob)
attempt("local", local)
attempt("cell", cell)
fds = lambda: len(os.listdir("/proc/self/fd")) if os.path.isdir("/proc/self/fd") else 0
before = fds()
for i in range(300):
    try:
        open(F, M).write(NOPE)
    except NameError:
        pass
print("descriptors after 300 raising S:", fds() - before)
`);
  assert.deepEqual(out.split("\n"), ["global NameError 0 0", "local UnboundLocalError 0 0", "cell NameError 0 0", "descriptors after 300 raising S: 0"]);
});

test("Stop while S is evaluated: KeyboardInterrupt, and the open descriptor closed (once): none left open", async () => {
  const d = mkdtempSync(join(tmpdir(), "file-once-stop-"));
  try {
    const code = `
import os
F = ${JSON.stringify(join(d, "stop"))}
fds = lambda: len(os.listdir("/proc/self/fd"))
before = fds()
def spin():
    while True:
        pass
try:
    open(F, "w").write(spin())
except KeyboardInterrupt:
    raise RuntimeError("stopped: descriptors %d, exists %s, size %d" % (fds() - before, os.path.exists(F), os.path.getsize(F)))
`;
    const r = await stopAfter(code, 300);
    assert.equal(r, "RuntimeError: stopped: descriptors 0, exists True, size 0");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the generated code: S handed over in R.fileOnceS on the native path (no temporary holds it), the descriptor closed in a finally, the declined path's file object cleared", () => {
  const { compile } = require(__dirname + "/../src/compile.js");
  for (const src of ["open(F, M).write(S)\n", "def f(F, M, S):\n    return open(F, M).write(S)\n", "n = open(f(), g()).write(h())\n"]) {
    const code: string = compile(src, "t.py", "__main__").code;
    assert.match(code, /\$\d+ = (\$\d+) !== null \? \(R\.fileOnceS\.v = [^;]+, R\.fileOnceEnd\(\1\)\) : \$K\d+\(\$\d+, [^;]+\);/, code);
    assert.match(code, /\} finally \{\n\s*if \((\$\d+) !== null\) \{ R\.fileOnceAbort\(\1\); \1 = null; \}\n\s*\$\d+ = undefined;\n\s*\}/, code);
  }
});

test("a site keeps no reference to S after it, native or declined, at module level and in functions: rebinding S frees it", () => {
  const N = 32 << 20;
  const out = py(`
used = sys._sagebrush_heap_used
F = P("big"); M = "w"
if used() is None: raise SystemExit(print("no heap figure"))
def make(c):
    # (in a function: a module-level call's argument temporaries would keep
    # the string, today's code's, not the site's)
    return flat(c * ${N})
class Keeper:
    # (a user open's writer that keeps what it is given: freed with it)
    def write(self, s):
        self.s = s
        return len(s)
def keeper_open(f, m):
    return Keeper()
# (at module level, a global's load keeps its value in a temporary of the
# module's frame, which never returns, until the temporary's next use:
# today's code for any call, so the site is held to that, id(S) here)
base = used()
S = make("z")
id(S)
S = None
print("module-control", round((used() - base) / ${N}, 2))
base = used()
S = make("a")
open(F, M).write(S)
ok = sz(F) == ${N}
S = None
print("module", round((used() - base) / ${N}, 2), ok)
base = used()
S = make("b")
OPEN = open
open = keeper_open
open(F, M).write(S)
open = OPEN
S = None
print("module-declined", round((used() - base) / ${N}, 2))
def site():
    s = make("c")
    open(F, M).write(s)
    s = None
def declined():
    s = make("d")
    keeper_open(F, M).write(s)
    s = None
def raising():
    s = make("e")
    def boom():
        raise ValueError
    try:
        open(F, M).write(s if boom() else s)
    except ValueError:
        pass
    s = None
for f in (site, declined, raising, site):
    base = used()
    f()
    print(f.__name__, round((used() - base) / ${N}, 2))
`);
  if (out === "no heap figure") return;
  const lines = out.split("\n");
  const at = (i: number) => Number(lines[i].split(" ")[1]);
  assert.match(lines[1], / True$/);
  assert.ok(at(1) <= at(0) + 0.25 && at(2) <= at(0) + 0.25, `module level, live after the site: ${out}`);
  for (let i = 3; i < lines.length; i++) assert.ok(at(i) < 0.5, `live after the site: ${out}`);
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
n = open(F, M).write(S)
(_pyjs_open.open, _pyjs_open.TextFile.write, _pyjs_open._Mixin._write, _pyjs_open._Mixin.flush, _pyjs_open._unwritten, _fs.write, _fs.isdir) = saved
print(n, sz(F), called)
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
  assert.deepEqual(imports, ["./object: PyBytes T callObj isinstance markRaised typeName unbox", "./ops: bufferOf", "./modules: hostPath"]);
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
    const show = (e) => e === null || e === undefined ? null : { cls: O.getattr(O.typeOf(e), "__name__"), args: O.getattr(e, "args").map(String), filename: (() => { try { return O.getattr(e, "filename"); } catch { return "absent"; } })(), context: show(e.__context__) };
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

// The web build's fs (web/shims/fs.ts, run here with its types stripped and
// its SHA-256 import stubbed) under the site's handles: a handle is on the
// file, not its path (astra2's CORR-FV-R3-1)
function shimRun(script: string): any {
  const d = mkdtempSync(join(tmpdir(), "file-once-shim-"));
  try {
    const src = readFileSync(__dirname + "/../../web/shims/fs.ts", "utf8").replace('import { sha256Hex } from "../../src/runtime/sha256";', 'const sha256Hex = (_d: Uint8Array): string => "";');
    assert.ok(src.includes("const sha256Hex = "), "the shim's import, stubbed");
    writeFileSync(join(d, "fs.mts"), src);
    writeFileSync(join(d, "run.mjs"), `
      import { createRequire } from "module";
      const require = createRequire(import.meta.url);
      const shim = await import(${JSON.stringify(join(d, "fs.mts"))});
      require(${JSON.stringify(__dirname + "/../src/runtime/index.js")});
      const FO = require(${JSON.stringify(__dirname + "/../src/runtime/file-once.js")});
      const ops = FO.fileOpsFor(shim);
      const txt = (p) => new TextDecoder().decode(shim.readFileSync(p));
      const changed = [];
      shim.__hooks.changed = (p, d) => changed.push([p, d === null ? null : new TextDecoder().decode(d)]);
      // (a site: open, S's effects, S, the end; the abort in a finally)
      const site = (p, m, during, s) => { const h = FO.fileOnceBegin(p, m, ops); try { during(); FO.fileOnceS.v = s; return FO.fileOnceEnd(h); } finally { FO.fileOnceAbort(h); } };
      ${script}
    `);
    return JSON.parse(execFileSync(process.execPath, [join(d, "run.mjs")], { encoding: "utf8" }));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("the web build's fs holds the opened file: S renaming it and recreating the path, or unlinking it, leaves the write where a descriptor's goes; ABBB; append; the page told of each change", () => {
  const r = shimRun(`
    const out = {};
    shim.writeFileSync("/old", "old");
    site("/old", "w", () => { shim.renameSync("/old", "/renamed"); shim.writeFileSync("/old", "new"); }, "X");
    out.rename = [txt("/old"), txt("/renamed")];
    shim.writeFileSync("/gone", "g");
    let err = null;
    try { site("/gone", "w", () => shim.unlinkSync("/gone"), "X"); } catch (e) { err = String(e); }
    out.unlink = [err, shim.existsSync("/gone")];
    site("/abbb", "w", () => site("/abbb", "a", () => {}, "BBBB"), "A");
    out.abbb = txt("/abbb");
    shim.writeFileSync("/app", "keep");
    site("/app", "a", () => {}, "x");
    out.append = txt("/app");
    changed.length = 0;
    site("/n", "w", () => {}, "hi");
    out.changes = changed;
    console.log(JSON.stringify(out));
  `);
  assert.deepEqual(r.rename, ["new", "X"]);
  assert.deepEqual(r.unlink, [null, false]);
  assert.equal(r.abbb, "ABBB");
  assert.equal(r.append, "keepx");
  assert.deepEqual(r.changes, [["/n", ""], ["/n", "hi"]]);
});

test("S may not suspend the frame while the file is held: a yield in a lambda's default (positional or keyword-only) is no site; one in its body is (CORR-FV-R3-2)", () => {
  const { compile } = require(__dirname + "/../src/compile.js");
  const site = (line: string) => compile(`def g():\n    ${line}\n`, "t.py", "__main__").code.includes("fileOnceBegin");
  assert.equal(site('open(F, "w").write(lambda x=(yield "paused"): x)'), false);
  assert.equal(site('open(F, "w").write(lambda *, k=(yield): k)'), false);
  assert.equal(site('open(F, "w").write(lambda x=(yield from g()): x)'), false);
  assert.equal(site('open(F, "w").write(lambda: (yield))'), true);
  assert.equal(site('open(F, "w").write(lambda x=1: x)'), true);
});

test("the held descriptor (fileOnceBegin, End, Abort): S written once and closed once; an ineligible S raises with it closed; Abort after End does nothing; Abort closes once and drops its close error", () => {
  const r = native(`
    const B = (m = "w", o = ops()) => FO.fileOnceBegin("/f", m, o);
    let h = B();
    FO.fileOnceS.v = "héllo";
    const n = FO.fileOnceEnd(h);
    FO.fileOnceAbort(h);
    const ok = log.splice(0);
    h = B("wb");
    FO.fileOnceS.v = "a str";
    const typeErr = attempt(() => FO.fileOnceEnd(h));
    FO.fileOnceAbort(h);
    const afterType = log.splice(0);
    h = B();
    FO.fileOnceAbort(h);
    FO.fileOnceAbort(h);
    const aborted = log.splice(0);
    h = B("a", ops({ close: (fd) => { log.push(["close", fd]); throw err("EIO", 5); } }));
    const dropped = attempt(() => FO.fileOnceAbort(h));
    const afterDropped = log.splice(0);
    const slot = FO.fileOnceS.v;
    console.log(JSON.stringify({ n, ok, typeErr, afterType, aborted, dropped, afterDropped, slot: slot === undefined }));
  `);
  assert.equal(r.n, 5);
  assert.deepEqual(r.ok, [["open", "/f", false], ["write", 7, 0, 6], ["close", 7]]);
  assert.deepEqual(r.typeErr, { cls: "TypeError", args: ["a bytes-like object is required, not 'str'"], filename: "absent", context: null });
  assert.deepEqual(r.afterType, [["open", "/f", false], ["close", 7]]);
  assert.deepEqual(r.aborted, [["open", "/f", false], ["close", 7]]);
  assert.equal(r.dropped, null);
  assert.deepEqual(r.afterDropped, [["open", "/f", true], ["close", 7]]);
  assert.equal(r.slot, true);
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
M = "w"
# a held file's flush writes its whole buffer (CPython: 'ABBB')
F = P("whole"); f = open(F, "w"); f.write("A"); open(F, M).write("BBBB"); f.close()
print(1, repr(open(F).read()))
# a file released by rebinding is still pending (CPython: 'AB')
F = P("rebind"); f = open(F, "a"); f.write("A"); f = None; open(F, "a").write("B"); _pyjs_open._flush_all()
print(2, repr(open(F).read()))
# a write inside a larger expression is not a site: its file is written later (CPython: 'x')
print(3, open(P("nested"), "w").write("x"), repr(open(P("nested")).read()))
# a lambda's body is no statement either (CPython: 'x')
(lambda: open(P("lam"), "w").write("x"))()
print(4, repr(open(P("lam")).read()))
_pyjs_open._flush_all()
print(5, repr(open(P("nested")).read()), repr(open(P("lam")).read()))
# a declined site's write method is looked up after S is evaluated, as any
# method call's in pyjs (CPython: the method bound before S)
class Writer:
    def write(self, s):
        return "bound before S"
def other_write(self, s):
    return "installed by S"
def install():
    Writer.write = other_write
    return "s"
def writer_open(f, m):
    return Writer()
REAL = open
open = writer_open
r = open(P("bw"), "w").write(install())
open = REAL
print(7, r)
# today's open() in append mode does not refuse a missing directory until its flush (CPython: FileNotFoundError at open)
try:
    g = (lambda: open("/nonexistent-dir/x", "a"))()
    print(6, "opened")
except FileNotFoundError:
    print(6, "refused")
`);
  assert.deepEqual(out.split("\n"), ["1 'A'", "2 'BA'", "3 1 ''", "4 ''", "5 'x' 'x'", "7 installed by S", "6 opened"]);
});
