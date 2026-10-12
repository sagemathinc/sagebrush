import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptName } from "../src/compile";
import { runInThisContext } from "../web/shims/vm";

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
