import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptName } from "../src/compile";
import { runInThisContext } from "../web/shims/vm";
import { R } from "../src/runtime/index";
import { siteGet, objectType, T } from "../src/runtime/object";

// Python must never reach JavaScript (design/security.md, rule 6).  The
// escapes sagebrush-daybreak found at 983418b, and the shapes around them.
const run = (src: string, cwd?: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });

// SEC-983-1: an attribute read site primed by an own attribute answered the
// next instance with an inherited JavaScript property (Array, then through
// a __proto__ store, Function).
test("SEC-983-1: a cached attribute read never returns an inherited JavaScript property", () => {
  const src = `
class L(list):
    pass

def inherited_constructor(o):
    return o.constructor

a = L()
a.constructor = None
inherited_constructor(a)
b = L()
try:
    Array = inherited_constructor(b)
    setattr(b, "__proto__", Array)
    Function = inherited_constructor(b)
    print(Function("return 6 * 7")())
except AttributeError as e:
    print("AttributeError", e)
`;
  assert.equal(run(src), "AttributeError 'L' object has no attribute 'constructor'\n");
});

test("SEC-983-1: every layout (list, dict, int, plain) keeps JavaScript's properties out of Python's", () => {
  const src = `
class L(list): pass
class D(dict): pass
class I(int): pass
class P: pass

def get(o, name):
    return getattr(o, name)

def ctor(o):
    return o.constructor

def proto(o):
    return o.__proto__

out = []
for mk in (L, D, lambda: I(3), P):
    x = mk()
    x.constructor = 1
    ctor(x)
    for name in ("constructor", "toString", "valueOf", "__proto__", "hasOwnProperty", "length", "push"):
        y = mk()
        try:
            get(y, name)
            out.append("leak " + name)
        except AttributeError:
            pass
    y = mk()
    for f in (ctor, proto):
        try:
            f(y)
            out.append("leak " + f.__name__)
        except AttributeError:
            pass
    # __proto__ is an ordinary attribute, as in CPython
    z = mk()
    setattr(z, "__proto__", 123)
    w = mk()
    w.__proto__ = [1]
    v = mk()
    v.__dict__["__proto__"] = "s"
    out.append((type(z).__name__, getattr(z, "__proto__"), proto(z), w.__proto__, v.__proto__, sorted(vars(v))))
print(out)
`;
  assert.equal(run(src), "[('L', 123, 123, [1], 's', ['__proto__']), ('D', 123, 123, [1], 's', ['__proto__']), ('I', 123, 123, [1], 's', ['__proto__']), ('P', 123, 123, [1], 's', ['__proto__'])]\n");
});

// The runtime's own slots ($cls, $m, ...) are not Python attributes: a
// deliberate difference from CPython, where any string is a valid name.
// sagebrush-daybreak SEC-61C-1 (61c9cfe): __pyjs_host__ dispatched through the
// host object's prototype, so a Python-chosen op like "constructor" called a
// JavaScript method and returned a raw JS value.  Only an own function operation.
test("SEC-61C-1: __pyjs_host__ answers only an own host operation", () => {
  const src = `
import builtins
for op in ("constructor", "toString", "__defineGetter__", "valueOf", "hasOwnProperty"):
    print(op, builtins.__pyjs_host__(op))
print("int", builtins.__pyjs_host__(1))
`;
  assert.equal(run(src), "constructor None\ntoString None\n__defineGetter__ None\nvalueOf None\nhasOwnProperty None\nint None\n");
});

// sagebrush-daybreak SEC-61C-2: a subclass of a JS-backed builtin exposed the
// runtime's implementation fields (bytes' Uint8Array, a reversed iterator's raw
// closure) as Python attributes.  Those names are the runtime's, like $ slots.
test("SEC-61C-2: a JS-backed builtin subclass never exposes its implementation fields", () => {
  const src = `
class B(bytes): pass
class BA(bytearray): pass
class R(reversed): pass
class E(enumerate): pass
class Z(zip): pass
class M(map): pass
class CX(complex): pass
out = []
cases = [(B(b"abc"), "a"), (B(b"abc"), "n"), (BA(b"xy"), "a"), (R([10, 20]), "get"), (R([10, 20]), "a"),
         (E([1]), "it"), (Z([1]), "its"), (M(str, [1]), "f"), (CX(1, 2), "re"), (CX(1, 2), "im")]
for x, name in cases:
    try:
        getattr(x, name); out.append("leak:" + name)
    except AttributeError:
        pass
# a user attribute works, and the buffer is intact; a reserved field cannot be written
b = B(b"xy"); b.user = 5
try:
    b.a = "clobber"; out.append("wrote a")
except AttributeError:
    pass
out.append((bytes(b) == b"xy", b.user, sorted(vars(b))))
print(out)
`;
  assert.equal(run(src), "[(True, 5, ['user'])]\n");
});

// sagebrush-daybreak SEC-BBB-1/2 (bbb4432): built-in descriptors and methods
// had no owner, so one fetched through vars(cls) could be applied to any
// receiver.  Each now records its type and checks the receiver on every path.
test("SEC-BBB-1/2: built-in descriptors and methods apply only to their own type's instances", () => {
  const src = `
import array
out = []
def attempt(f):
    try:
        f(); out.append("ran")
    except TypeError:
        out.append("TypeError")
attempt(lambda: vars(range)["step"].__get__(object(), object))
attempt(lambda: vars(range)["start"].__set__(object(), 1))
class B(bytes): pass
b = B(b"abc")
m = vars(array.array)["__imul__"]
attempt(lambda: m.__get__(b, B)(2))
attempt(lambda: m(b, 2))
attempt(lambda: vars(range)["__repr__"](object()))
out.append(bytes(b))
a = array.array("i", [1, 2]); m(a, 2)
out.append((list(a), vars(range)["step"].__get__(range(0, 9, 3), range), vars(str)["upper"]("x")))
print(out)
`;
  assert.equal(run(src), "['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', b'abc', ([1, 2, 1, 2], 3, 'X')]\n");
});

// sagebrush-daybreak SEC-2C5-1 (2c5ccc1): __pyjs_run__ passed any Python
// object as the compiled code's globals, so a Python function as ns let it
// read `constructor` through Function.prototype.  Only a module or a dict.
test("SEC-2C5-1: __pyjs_run__ runs only in a module or dict namespace", () => {
  const src = `
def fn(): pass
out = []
for ns in (fn, [], 0, "s"):
    try:
        __pyjs_run__("r = 1", ns, False); out.append("ran")
    except TypeError:
        out.append("TypeError")
o, e = __pyjs_run__("print(1 + 1)", {}, False)
out.append((o.strip(), e))
o, e = __pyjs_run__("print(constructor)", {}, False)
out.append("NameError" in (e or ""))
d = {"x": 5}
__pyjs_run__("y = x + 1", d, False)
out.append(d["y"])
print(out)
`;
  assert.equal(run(src), "['TypeError', 'TypeError', 'TypeError', 'TypeError', ('2', None), True, 6]\n");
});

// SEC-2C5-2: _numpy.printopt indexed its options object with a Python key, so
// `constructor` returned JavaScript Object.  Only its own keys.
test("SEC-2C5-2: _numpy.printopt returns only its own options", () => {
  const src = `
import _numpy
print([_numpy.printopt(k) for k in ("constructor", "__proto__", "toString", "hasOwnProperty")], _numpy.printopt("precision"))
`;
  assert.equal(run(src), "[None, None, None, None] 8\n");
});

// sagebrush-daybreak's re-review of dd9b8cb (SEC-DD9-1..3): lookup tables
// matched inherited names ("constructor"), __getstate__ walked raw properties,
// and __dict__ writes, assignment and deletion reached a layout's own storage.
test("SEC-DD9-1: a lookup table finds only its own entries (array typecodes, memoryview formats, dtypes)", () => {
  const src = `
from array import array
out = []
for tc in ("constructor", "toString", "__proto__", "hasOwnProperty", "zz"):
    try:
        array(tc); out.append("made " + tc)
    except (TypeError, ValueError) as e:
        out.append(type(e).__name__)
for fmt in ("constructor", "toString"):
    try:
        memoryview(b"abcd").cast(fmt); out.append("cast " + fmt)
    except ValueError:
        out.append("ValueError")
out.append(array("i").itemsize)
print(out)
`;
  assert.equal(run(src), "['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'ValueError', 'ValueError', 4]\n");
});

test("SEC-DD9-2: default pickle state is the attribute dict, never a layout's own storage", () => {
  const src = `
import pickle
from array import array
class R(reversed): pass
class E(enumerate): pass
class Z(zip): pass
class M(map): pass
class CX(complex): pass
class A(array): pass
class B(bytes): pass
out = [R([1]).__getstate__(), E([1]).__getstate__(), Z([1]).__getstate__(), M(str, [1]).__getstate__(), CX(1).__getstate__()]
a = A("B", [1]); a.user = 3
out.append(a.__getstate__())
b = B(b"xy"); b.user = 4
p = pickle.loads(pickle.dumps(b))
out.append((type(p).__name__, bytes(p), p.user))
print(out)
`;
  assert.equal(run(src), "[None, None, None, None, None, {'user': 3}, ('B', b'xy', 4)]\n");
});

test("SEC-DD9-3: __dict__ writes, assignment and deletion never reach a layout's own storage", () => {
  const src = `
from array import array
class B(bytes): pass
class A(array): pass
b = B(b"xy"); b.user = 1
a = A("B", [1])
out = []
for f in (lambda: vars(b).__setitem__("n", 0), lambda: b.__dict__.setdefault("a", 0), lambda: b.__dict__.update({"n": 0}),
          lambda: setattr(b, "__dict__", {"n": 0}), lambda: vars(a).__setitem__("tc", "constructor")):
    try:
        f(); out.append("wrote")
    except AttributeError:
        out.append("refused")
out.append((len(b), bytes(b), a.itemsize, a.typecode, list(a)))
del b.__dict__
out.append((len(b), bytes(b), hasattr(b, "user")))
print(out)
`;
  assert.equal(run(src), "['refused', 'refused', 'refused', 'refused', 'refused', (2, b'xy', 1, 'B', [1]), (2, b'xy', False)]\n");
});

test("names starting with $ are the runtime's: not readable, writable or deletable from Python", () => {
  const src = `
class L(list): pass
class P: pass
out = []
for o in (L(), P()):
    for f in (lambda: getattr(o, "$cls"), lambda: setattr(o, "$cls", int), lambda: delattr(o, "$cls")):
        try:
            f()
            out.append("ok")
        except AttributeError:
            out.append("AttributeError")
    try:
        o.__dict__["$cls"] = int
        out.append("ok")
    except TypeError:
        out.append("TypeError")
    out.append(type(o).__name__)
    out.append(getattr(o, "$m", "default"))
    out.append(hasattr(o, "$cls"))
print(out)
`;
  assert.equal(run(src), "['AttributeError', 'AttributeError', 'AttributeError', 'TypeError', 'L', 'default', False, 'AttributeError', 'AttributeError', 'AttributeError', 'TypeError', 'P', 'default', False]\n");
});

// sagebrush-daybreak at 18f5216: globals() wrote `$cls` and `$m` onto the
// module object, so a module could pass for a list subclass and mislead the
// attribute cache.  No namespace takes a `$` name; and the cache primes only
// for an object with its class's own layout.
test("no namespace takes the runtime's $ names: globals(), a module's __dict__, SimpleNamespace", () => {
  const src = `
import sys, types
class L(list): pass
out = []
def attempt(f):
    try:
        f()
        out.append("ok")
    except (TypeError, AttributeError) as e:
        out.append(type(e).__name__)
attempt(lambda: globals().__setitem__("$cls", L))
attempt(lambda: globals().__setitem__("$m", {}))
out.append(globals().get("$cls", "absent"))
m = types.ModuleType("m")
attempt(lambda: vars(m).__setitem__("$cls", L))
attempt(lambda: types.SimpleNamespace(**{"$cls": L}))
attempt(lambda: types.SimpleNamespace({"$cls": L}))
out.append(type(sys.modules[__name__]).__name__)
out.append(type(m).__name__)
globals()["__proto__"] = [1]
out.append(globals()["__proto__"])
out.append(types.SimpleNamespace(a=1, b=2).b)
print(out)
`;
  assert.equal(run(src), "['TypeError', 'TypeError', 'absent', 'TypeError', 'AttributeError', 'TypeError', 'module', 'module', [1], 2]\n");
});

// sagebrush-daybreak's full SEC-18F-1 chain (report on 18f5216), as written:
// it printed 42 (JavaScript's Function); CPython raises AttributeError.
test("SEC-18F-1: the forged-layout cache chain never reaches JavaScript", () => {
  const src = `
import sys

class L(list): pass
class D(dict): pass
class Q(property): pass

def leak(o):
    return (o.constructor, o.__lookupSetter__,
            o.__defineGetter__, o.__defineSetter__)

try:
    m, g = sys.modules[__name__], globals()
    for name in ("constructor", "__lookupSetter__", "__defineGetter__", "__defineSetter__"):
        g[name] = None
    g["$cls"] = L
    leak(m)
    Array, lookup_setter, define_getter, define_setter = leak(L())
    x = Q()
    x.get = lookup_setter
    g["$cls"], g["$m"] = D, x
    proto_setter = m["__proto__"]
    x.set = define_getter
    m["$cls"] = lambda: Q
    x.set = define_setter
    m["fget"] = proto_setter
    property.__init__(x, Array)
    g["$cls"] = Q
    leak(m)
    Function = leak(x)[0]
    print(Function("return 6 * 7")())
except (AttributeError, TypeError) as e:
    print(type(e).__name__)
# (the smaller case: a module primes a site for L's attribute, then a real L)
class M: pass
mm = M()
mm.constructor = None
leak2 = lambda o: o.constructor
leak2(mm)
try:
    leak2(L())
    print("leaked")
except AttributeError:
    print("AttributeError")
`;
  assert.equal(run(src), "TypeError\nAttributeError\n");
});

// sagebrush-daybreak SEC-5DE-1 (5deaa70): a custom sys.meta_path loader plus
// sys.modules parents wrote a child module's name onto its parent with a raw
// property store, so `$ctor`/`$cls` could be forged on a class or object.
// A module name is never a runtime slot, and the child is bound with setattr.
// sagebrush-daybreak's SEC-5DE-1 chain as written, plus the backstop: even
// if some write path forged $cls on a differently laid-out object, a cached
// attribute read checks the value is the object's own, so no JavaScript
// property inherited through a forged layout is ever returned.
test("SEC-5DE-1: the import-forged-layout chain never reaches JavaScript", () => {
  const src = `
import sys
class Hook:
    values = {}
    def find_spec(self, name, *args):
        if name in self.values:
            self.name = name
            return self
    def create_module(self, spec):
        return self.values[self.name]
    def exec_module(self, module):
        pass
h = Hook(); h.loader = h
sys.meta_path.insert(0, h)
def plant(parent, slot, value):
    sys.modules["p"] = parent
    sys.modules.pop("p." + slot, None)
    h.values["p." + slot] = value
    __import__("p." + slot)
class C: pass
def carrier(): pass
try:
    plant(C, "$ctor", carrier)
    o = object.__new__(C)
    plant(o, "$cls", C)
    o.constructor = None
    def read(o): return o.constructor
    read(o)
    plant(carrier, "$cls", C)
    print(read(carrier)("return 6 * 7")())
except (ModuleNotFoundError, AttributeError, TypeError) as e:
    print(type(e).__name__)
`;
  assert.equal(run(src), "ModuleNotFoundError\n");
});

// The backstop itself, independent of how a forged object might arise (no
// Python path can make one now, so this is driven from TypeScript): an
// attribute-read site primed by a genuine instance of C, then given a
// JavaScript function that only claims to be a C, never answers with the
// function's inherited `constructor` (JavaScript's Function).
test("SEC-5DE-1 backstop: a cached attribute read answers only an object's own property, whatever its class tag says", () => {
  void R; // (the runtime, initialized)
  const C = objectType("C", [T.object], new Map(), "test");
  const real: any = new (C.$ctor as any)();
  real.constructor = "own";
  const get = siteGet("constructor");
  assert.equal(get(real), "own"); // (primes the site for C)
  assert.equal(get(real), "own"); // (the cached path)
  const forged: any = function () {};
  forged.$cls = C;
  let got: any;
  try {
    got = get(forged);
  } catch {
    got = "raised";
  }
  assert.notEqual(got, Function);
  assert.equal(got, "raised");
});

// dir() shows only what the instance dict holds: not a list subclass's
// elements, nor a JavaScript-backed layout's own fields (as CPython).
test("dir() lists neither a list subclass's elements nor a builtin subclass's implementation fields", () => {
  const src = `
class L(list): pass
class B(bytes): pass
x = L([7, 8]); x.t = 1
b = B(b"ab"); b.u = 2
print([n for n in dir(x) if n in ("0", "1", "length", "t")], [n for n in dir(b) if n in ("a", "n", "u")])
`;
  assert.equal(run(src), "['t'] ['u']\n");
});

test("SEC-5DE-1: importing cannot write a runtime $ slot onto any parent", () => {
  const src = `
import sys, types
class L(list): pass
class Loader:
    def __init__(self, target): self.target = target
    def find_spec(self, name, path, target):
        return types.SimpleNamespace(loader=self) if "." in name else None
    def create_module(self, spec): return self.target
    def exec_module(self, m): pass
def bind(parent, child, value):
    sys.modules["pk"] = parent
    sys.modules.pop("pk." + child, None)
    ld = Loader(value); sys.meta_path.insert(0, ld)
    try: __import__("pk." + child)
    finally: sys.meta_path.remove(ld)
out = []
def attempt(f):
    try:
        f(); out.append("ok")
    except (ModuleNotFoundError, TypeError, AttributeError) as e:
        out.append(type(e).__name__)
inst = L()
attempt(lambda: bind(inst, "$cls", L))
out.append(type(inst).__name__)
attempt(lambda: bind(L, "$ctor", object))
out.append(L([1]).append(2) or "list")
def fn(): pass
attempt(lambda: bind(fn, "$cls", L))
bind(L, "weird", 5)
out.append(getattr(L, "weird", "none"))
print(out)
`;
  assert.equal(run(src), "['ModuleNotFoundError', 'L', 'ModuleNotFoundError', 'list', 'ModuleNotFoundError', 5]\n");
});

test("__class__ assignment cannot move a list subclass's array onto a plain class", () => {
  const src = `
class L(list): pass
class P: pass
x = L([1, 2])
try:
    x.__class__ = P
    print("assigned")
except TypeError:
    print("TypeError", type(x).__name__, x)
`;
  assert.equal(run(src), "TypeError L [1, 2]\n");
});

// SEC-983-2: a module's file name (Python controls it through sys.path)
// became a //# sourceURL= comment after its code in the browser, so a
// newline in it ran the rest of the name as JavaScript.
test("SEC-983-2: a script's name has no line terminator, whatever the file's name", () => {
  for (const t of ["\n", "\r", "\u2028", "\u2029"]) {
    const name = scriptName(`/probe${t}globalThis.__sbProbe = 42//m.py`);
    assert.ok(!/[\r\n\u2028\u2029]/.test(name), JSON.stringify(name));
    assert.ok(name.startsWith("py:/probe%"), name);
  }
  assert.equal(scriptName("/home/user/a-b_c.d/m.py"), "py:/home/user/a-b_c.d/m.py");
  assert.equal(scriptName("/x y/m.py"), "py:/x%20y/m.py");
});

test("SEC-983-2: the browser's eval refuses a script name with a line terminator", () => {
  const g = globalThis as any;
  for (const t of ["\n", "\r", "\u2028", "\u2029"]) {
    g.__sbProbe = 0;
    assert.throws(() => runInThisContext("0", { filename: `safe${t}globalThis.__sbProbe = 42` }), /invalid script name/);
    assert.equal(g.__sbProbe, 0);
  }
  assert.equal(runInThisContext("6 * 7", { filename: "py:/a/m.py" }), 42);
});

test("SEC-983-2: a module in a directory whose name has a newline imports, and its traceback names the real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-sec-"));
  try {
    const src = `
import os, sys
d = os.path.join(os.getcwd(), "probe\\nglobalThis.__sbProbe = 42;true?(()=>{}):0")
os.mkdir(d)
with open(d + "/m.py", "w") as f:
    f.write("x = 1\\ndef boom():\\n    raise ValueError('here')\\n")
sys.path.insert(0, d)
import m
print(m.x)
m.boom()
`;
    const r = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", cwd: dir });
    assert.equal(r.stdout, "1\n");
    assert.ok(r.stderr.includes(`  File "${dir}/probe\nglobalThis.__sbProbe = 42;true?(()=>{}):0/m.py", line 3, in boom\n    raise ValueError('here')\nValueError: here\n`), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
