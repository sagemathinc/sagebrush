import test from "node:test";
import assert from "node:assert/strict";

// A notebook shows a cell's value as IPython does (Jupyter's text/plain),
// not as its repr: a type as its name, a function with its signature, an
// object without a __repr__ of its own as <__main__.C at 0x...>, and these
// inside lists, tuples and dicts (lib/_pyjs_pretty.py). The expected texts
// are IPython 9.17.1's, on CPython 3.14.8 (addresses masked). The command
// line's prompt keeps CPython's repr.
const CASES: [string, string][] = [
  ["def f(c=3):\n    pass\nf", "<function __main__.f(c=3)>"],
  ["max", "<function max>"],
  ["print", "<function print(*args, sep=' ', end='\\n', file=None, flush=False)>"],
  ["len", "<function len(obj, /)>"],
  ["sorted", "<function sorted(iterable, /, *, key=None, reverse=False)>"],
  ["round", "<function round(number, ndigits=None)>"],
  ["abs", "<function abs(x, /)>"],
  ["divmod", "<function divmod(x, y, /)>"],
  ["type(3)", "int"],
  ["int", "int"],
  ["type('a')", "str"],
  ["type(None)", "NoneType"],
  ["range", "range"],
  ["dict", "dict"],
  ["type", "type"],
  ["Exception", "Exception"],
  ["[type(1), type(2.0)]", "[int, float]"],
  ["[int, [float, str]]", "[int, [float, str]]"],
  ["(int,)", "(int,)"],
  ["((), [], {})", "((), [], {})"],
  ["{1: int, 'k': (max,)}", "{1: int, 'k': (<function max>,)}"],
  ["[1, 2, 3]", "[1, 2, 3]"],
  ["import numpy as np\nnp.ndarray", "numpy.ndarray"],
  ["type(np.zeros(2))", "numpy.ndarray"],
  ["np.sum", "<function sum at 0x?>"],
  ["np.sin", "<ufunc 'sin'>"],
  ["class C:\n    def m(self, x=1): pass\nC", "__main__.C"],
  ["C()", "<__main__.C at 0x?>"],
  ["C.m", "<function __main__.C.m(self, x=1)>"],
  ["C().m", "<bound method C.m of <__main__.C object at 0x?>>"],
  ["class N:\n    pass\n[N(), N]", "[<__main__.N at 0x?>, __main__.N]"],
  ["class D:\n    def __repr__(self):\n        return 'D!'\nD()", "D!"],
  ["class M(type):\n    pass\nclass E(metaclass=M):\n    pass\nE", "__main__.E"],
  ["object()", "<object at 0x?>"],
  ["lambda x: x", "<function __main__.<lambda>(x)>"],
  ["lambda: 0", "<function __main__.<lambda>()>"],
  ["f2 = lambda a, *b, k=2, **kw: 0\nf2", "<function __main__.<lambda>(a, *b, k=2, **kw)>"],
  ["(f, max)", "(<function __main__.f(c=3)>, <function max>)"],
  ["{'a': f}", "{'a': <function __main__.f(c=3)>}"],
  ["def p(a, /, b, *, c=1):\n    pass\np", "<function __main__.p(a, /, b, *, c=1)>"],
  ["def q(x: 'float | None' = None, *ys: int, **kw: str) -> 'list[int]':\n    pass\nq", "<function __main__.q(x: 'float | None' = None, *ys: int, **kw: str) -> 'list[int]'>"],
  ["def r(a, b=[1, 2], *args, d, e='x'):\n    pass\nr", "<function __main__.r(a, b=[1, 2], *args, d, e='x')>"],
  ["def s(z: list[int]) -> dict[str, int]:\n    pass\ns", "<function __main__.s(z: list[int]) -> dict[str, int]>"],
  ["def g(*, a: int = 1) -> str:\n    'doc'\ng", "<function __main__.g(*, a: int = 1) -> str>"],
  ["async def h(): pass\nh", "<function __main__.h()>"],
  ["import math\nmath.sqrt", "<function math.sqrt(x, /)>"],
  ["math.floor", "<function math.floor(x, /)>"],
  ["'ab'.upper", "<function str.upper()>"],
  ["'x'.split", "<function str.split(sep=None, maxsplit=-1)>"],
  ["[1, 2].append", "<function list.append(object, /)>"],
  ["{}.get", "<function dict.get(key, default=None, /)>"],
  ["ValueError('x')", "ValueError('x')"],
  ["NotImplemented", "NotImplemented"],
  ["Ellipsis", "Ellipsis"],
  ["True", "True"],
  // (holding itself: [...], as IPython's; past 79 columns: the repr (IPython
  // breaks the line there, one item a line: a separate item), built no
  // further than the line)
  ["[int] * 20", "[<class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>, <class 'int'>]"],
  ["a = [int]\na.append(a)\na", "[int, [...]]"],
  ["d = {'t': int}\nd['k'] = d\nd", "{'t': int, 'k': {...}}"],
  ["[[[[[[[[int]]]]]]]]", "[[[[[[[[int]]]]]]]]"],
  // (38 levels around int: 79 columns, one line; 39 levels pass the line:
  // the repr)
  ["eval('[' * 38 + 'int' + ']' * 38)", "[".repeat(38) + "int" + "]".repeat(38)],
  ["eval('[' * 39 + 'int' + ']' * 39)", "[".repeat(39) + "<class 'int'>" + "]".repeat(39)],
  // (the runtime's own types by identity, not by name: CORR-PR57-1)
  ["class function:\n    pass\nfunction()", "<__main__.function at 0x?>"],
  ["class builtin_function_or_method:\n    pass\nbuiltin_function_or_method()", "<__main__.builtin_function_or_method at 0x?>"],
  ["class method:\n    pass\nmethod()", "<__main__.method at 0x?>"],
  ["class method_descriptor:\n    pass\n[method_descriptor(), method_descriptor]", "[<__main__.method_descriptor at 0x?>, __main__.method_descriptor]"],
  // (a builtin's class and static methods: CORR-PR57-2)
  ["dict.fromkeys", "<function dict.fromkeys(iterable, value=None, /)>"],
  ["{}.fromkeys", "<function dict.fromkeys(iterable, value=None, /)>"],
  ["class DD(dict):\n    pass\nDD.fromkeys", "<function DD.fromkeys(iterable, value=None, /)>"],
  ["int.from_bytes", "<function int.from_bytes(bytes, byteorder='big', *, signed=False)>"],
  ["(1).from_bytes", "<function int.from_bytes(bytes, byteorder='big', *, signed=False)>"],
  ["float.fromhex", "<function float.fromhex(string, /)>"],
  ["bytes.fromhex", "<function bytes.fromhex(string, /)>"],
  ["str.maketrans", "<function str.maketrans>"],
  // (functools.wraps: the signature of the function wrapped, as
  // inspect.signature follows __wrapped__: CORR-PR57-3)
  ["import functools\ndef target(a, b=3, *, c=4):\n    pass\n@functools.wraps(target)\ndef wrapper(*args, **kwargs):\n    return target(*args, **kwargs)\nwrapper", "<function __main__.target(a, b=3, *, c=4)>"],
  ["def w1(*a, **k):\n    pass\nw1.__wrapped__ = w1\nw1", "<function __main__.w1>"],
  ["def w2(*a, **k):\n    pass\nw2.__wrapped__ = len\nw2", "<function __main__.w2(obj, /)>"],
  ["def w5(*a, **k):\n    pass\nw5.__signature__ = None\nw5", "<function __main__.w5(*a, **k)>"],
];

test("a notebook shows a cell's value as IPython does: types, functions, objects, and in containers", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  for (const [code, want] of CASES) {
    const n = ++id;
    await s.handle({ id: n, code });
    const err = msgs.filter((m) => m.id === n && m.stream === "stderr").map((m) => m.text).join("");
    const out = msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join("");
    assert.equal(err, "", code);
    assert.equal(out.replace(/0x[0-9a-f]+/g, "0x?"), want + "\n", code);
  }
});

test("the command line's prompt keeps CPython's repr (a type is <class 'int'>)", () => {
  const R = require("../src/runtime").R;
  const saved = R.host;
  R.host = null;
  try {
    assert.equal(R.displayText(R.builtins.int), "<class 'int'>");
    assert.equal(R.displayText(R.builtins.max), "<built-in function max>");
  } finally {
    R.host = saved;
  }
});

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    const of = (stream: string) => msgs.filter((m) => m.id === n && m.stream === stream).map((m) => m.text).join("");
    return { out: of("stdout"), err: of("stderr") };
  };
}

test("astra's cases, IPython 9.15's text (past the line: the repr)", async () => {
  const cases = JSON.parse(require("fs").readFileSync(__dirname + "/../../test/ipython_display_astra_cases.json", "utf8"));
  const run = await session();
  for (const [label, code, want] of cases) {
    const { out, err } = await run(code);
    assert.equal(err, "", label);
    assert.equal(out.replace(/0x[0-9a-f]+/g, "0x?"), want + "\n", label);
  }
});

// LIMIT-PR57-1 (daybreak2): a value past the line shows as its repr, so the
// work is one repr plus the trial line, which stops at 79 columns. The walk
// is counted by wrapping _pyjs_pretty._walk, which it calls for each item
// and container; with no user code run, it stops with the line and the
// runtime's repr is the rest.
test("past the line: one repr, and a trial bounded by the line (counted)", async () => {
  const run = await session();
  await run("import _pyjs_pretty as P\nVISITS = [0]\n_t = P._walk\ndef _counted(*a):\n    VISITS[0] += 1\n    return _t(*a)\nP._walk = _counted\ndef nest(n):\n    L = []\n    for _ in range(n):\n        L = [L]\n    return L");
  for (const code of ["[int] * 1000000", "[1] * 1000000", "{i: int for i in range(100000)}", "nest(1500)", "[[int] * 1000] * 1000"]) {
    const { out, err } = await run(`VISITS[0] = 0\nV = ${code}\nV`);
    assert.equal(err, "", code);
    assert.ok(out.length > 79, code);
    const { out: n } = await run("VISITS[0]");
    assert.ok(Number(n) <= 80, `${code}: the trial visited ${n.trim()} values`);
  }
  await run("P._walk = _t");
});

// LIMIT-PR57-3 (daybreak2): no element's __repr__ runs twice. The trial line
// runs an element's __repr__ (as IPython's does) and, past the line, the
// repr is built with the strings it already got.
test("past the line, no element's __repr__ is called twice (counted)", async () => {
  const run = await session();
  await run("class R:\n    n = 0\n    def __init__(self, s='R'):\n        self.s = s\n    def __repr__(self):\n        R.n += 1\n        return self.s");
  const CASES: [string, number, string][] = [
    ["[int, R(), 'x' * 100]", 1, "[<class 'int'>, R, '" + "x".repeat(100) + "']"],
    ["[R(), R('y' * 100)]", 2, "[R, " + "y".repeat(100) + "]"],
    ["r = R()\n[r, r, int, 'x' * 100]", 2, "[R, R, <class 'int'>, '" + "x".repeat(100) + "']"],
    ["{R(): int, 2: [R(), 'x' * 80]}", 2, "{R: <class 'int'>, 2: [R, '" + "x".repeat(80) + "']}"],
    ["(R('\\n'), int)", 1, "(\n, <class 'int'>)"],
    ["[R() for _ in range(100000)]", 100000, "[" + Array(100000).fill("R").join(", ") + "]"],
    // (a cycle back through the trial's leaves: the repr meets the list again
    // as [...], so R's runs once)
    ["L = [R(), 'x' * 100]\nL.append([L])\nL", 1, "[R, '" + "x".repeat(100) + "', [[...]]]"],
    ["T = ([R(), int, 'x' * 100],)\nT[0].append(T)\nT", 1, "([R, <class 'int'>, '" + "x".repeat(100) + "', (...)],)"],
  ];
  for (const [code, calls, want] of CASES) {
    await run("R.n = 0");
    const { out, err } = await run(code);
    assert.equal(err, "", code);
    assert.equal(out, want + "\n", code);
    const { out: n } = await run("R.n");
    assert.equal(Number(n), calls, `${code}: R.__repr__ ran ${n.trim()} times`);
  }
  // (as the repr: the same calls, in the same order)
  await run("seen = []\nclass O:\n    def __init__(self, k):\n        self.k = k\n    def __repr__(self):\n        seen.append(self.k)\n        return 'O%d' % self.k");
  const { out } = await run("[O(1), [O(2), {O(3): O(4)}], int, O(5), 'x' * 80]");
  assert.equal(out, "[O1, [O2, {O3: O4}], <class 'int'>, O5, '" + "x".repeat(80) + "']\n");
  assert.equal((await run("seen")).out, "[1, 2, 3, 4, 5]\n");
});

// CORR-PR57-4 (astra): a __repr__ that changes the value it is in. One walk
// builds the line and the repr together, as repr walks a list (by index, to
// its length at each step) and a dict, and nothing is walked again. Past the
// line, the expected texts are CPython 3.14.8's repr of a fresh copy (IPython
// 9.17.1 breaks those lines); on the line, IPython's text. Each __repr__ runs
// once. (For the dict whose sibling is popped, IPython's printer raises
// "dictionary changed size during iteration"; repr goes on, and so does this.)
test("a __repr__ that changes its container: one walk, as repr's, each __repr__ once", async () => {
  const run = await session();
  await run("class Clear:\n    n = 0\n    def __init__(self, f, s='Q' * 80):\n        self.f = f\n        self.s = s\n    def __repr__(self):\n        Clear.n += 1\n        self.f()\n        return self.s");
  const Q = "Q".repeat(80);
  const CASES: [string, string, string][] = [
    ["parent cleared", "V = []\nV.append(Clear(V.clear))\nV", `[${Q}]`],
    ["parent cleared, more after", "V = []\nV.append(Clear(V.clear))\nV.append(1)\nV", `[${Q}]`],
    ["parent grows", "V = []\nV.append(Clear(lambda: V.append(7)))\nV.append(1)\nV", `[${Q}, 1, 7]`],
    ["sibling popped", "V = [0, 0, 0]\nV[0] = Clear(lambda: V.pop())\nV", `[${Q}, 0]`],
    ["sibling replaced", "V = [0, 1]\nV[0] = Clear(lambda: V.__setitem__(1, int))\nV", `[${Q}, <class 'int'>]`],
    ["nested cleared", "W = [1, 2]\nV = [Clear(W.clear), W]\nV", `[${Q}, []]`],
    ["nested grows", "W = [1]\nV = [Clear(lambda: W.append(2)), W]\nV", `[${Q}, [1, 2]]`],
    ["tuple, list in it cleared", "W = [1, 2]\nT = (Clear(W.clear), W)\nT", `(${Q}, [])`],
    ["dict cleared", "D = {}\nD[1] = Clear(D.clear)\nD[2] = 3\nD", `{1: ${Q}}`],
    ["dict grows", "D = {}\nD[1] = Clear(lambda: D.__setitem__(9, 9))\nD[2] = 3\nD", `{1: ${Q}, 2: 3, 9: 9}`],
    ["dict sibling popped", "D = {}\nD[1] = Clear(lambda: D.pop(2))\nD[2] = 3\nD[4] = 5\nD", `{1: ${Q}, 4: 5}`],
    ["dict key grows it", "D = {}\nD[Clear(lambda: D.__setitem__(1, 1))] = 3\nD", `{${Q}: 3, 1: 1}`],
    ["dict sibling value replaced", "D = {}\nD[1] = Clear(lambda: D.__setitem__(2, 'new'))\nD[2] = 3\nD", `{1: ${Q}, 2: 'new'}`],
    ["dict in a list cleared", "D = {1: 2, 3: 4}\nV = [Clear(D.clear), D]\nV", `[${Q}, {}]`],
    ["short: parent cleared", "V = []\nV.append(Clear(V.clear, 'q'))\nV.append(int)\nV", "[q]"],
    ["short: nested cleared", "W = [int, 2]\nV = [Clear(W.clear, 'q'), W, int]\nV", "[q, [], int]"],
    ["short: dict sibling popped", "D = {}\nD[1] = Clear(lambda: D.pop(2), 'q')\nD[2] = int\nD[4] = int\nD", "{1: q, 4: int}"],
  ];
  for (const [label, code, want] of CASES) {
    await run("Clear.n = 0");
    const { out, err } = await run(code);
    assert.equal(err, "", label);
    assert.equal(out, want + "\n", label);
    assert.equal((await run("Clear.n")).out, "1\n", `${label}: __repr__ calls`);
  }
  // (a function's default, whose __repr__ runs for the signature only (repr
  // shows no defaults), clears the list: the walk goes on in the list as it
  // is now, as IPython's printer does, and does not start the list again)
  await run("Clear.n = 0");
  const { out, err } = await run("V = []\ndef g(a=Clear(V.clear, 'm' * 80)):\n    pass\nV += [g, 'x' * 100]\nV");
  assert.equal(err, "");
  assert.equal(out.replace(/0x[0-9a-f]+/g, "0x?"), "[<function g at 0x?>]\n");
  assert.equal((await run("Clear.n")).out, "1\n");
});

// LIMIT-PR57-2 (daybreak2): a container nested past the recursion limit
// raises RecursionError, as its repr does, not a JavaScript stack overflow.
test("nesting past the recursion limit raises RecursionError, as repr does", async () => {
  const run = await session();
  await run("class R:\n    def __repr__(self):\n        return 'R'");
  for (const [code, msg] of [
    ["L = []\nfor _ in range(100000):\n    L = [L]\nL", "maximum recursion depth exceeded"],
    ["D = {}\nfor _ in range(100000):\n    D = {1: D}\nD", "maximum recursion depth exceeded"],
    ["L = []\nfor _ in range(100000):\n    L = [L]\n[R(), 'x' * 100, L]", "maximum recursion depth exceeded while getting the repr of an object"],
  ]) {
    const { out, err } = await run(code);
    assert.equal(out, "", code);
    assert.ok(err.trimEnd().endsWith("RecursionError: " + msg), `${code}: ${err.slice(-300)}`);
    assert.ok(!/internal error|RangeError|_pyjs_pretty.py", line \d+, in _/.test(err), `${code}: ${err.slice(0, 600)}`);
  }
  // (and the session goes on)
  assert.equal((await run("[int]")).out, "[int]\n");
});

// (last: a Sage cell installs sage_all's display hook for the whole process)
test("a Sage cell keeps the repr, as SageMath's shell shows it", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const out = async (n: number, code: string, extra: object = {}) => {
    await s.handle({ id: n, code, ...extra });
    return msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join("");
  };
  assert.equal(await out(1, "int", { sage: true }), "<class 'int'>\n");
  assert.equal(await out(2, "max", { sage: true }), "<built-in function max>\n");
  assert.equal(await out(3, "int"), "int\n");
});
