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

test("a long container's display is bounded by the line, not the container", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  // (a million types: given up after the first few, then the repr; it is
  // the repr's own size, not a second rendering of every element)
  const t0 = Date.now();
  await s.handle({ id: 1, code: "L = [int] * 1000000\nL" });
  const out = msgs.filter((m) => m.id === 1 && m.stream === "stdout").map((m) => m.text).join("");
  assert.ok(out.startsWith("[<class 'int'>, <class 'int'>"));
  assert.ok(Date.now() - t0 < 20000);
});
