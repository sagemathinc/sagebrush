import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parse } from "../src/parse";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("sage mode lexes ^ as ** and ^^ as xor", () => {
  const op = (src: string, sage: boolean) => (parse(src, "t.sage", "exec", { sage }).body[0] as any);
  assert.equal(op("2^3\n", true).value.op, "sage**"); // **, but int ** -int is exact
  assert.equal(op("2^^3\n", true).value.op, "^");
  assert.equal(op("x ^= 2\n", true).op, "sage**");
  assert.equal(op("x ^^= 2\n", true).op, "^");
  assert.equal(op("2^3\n", false).value.op, "^");
  assert.equal(op("2/3\n", true).value.op, "sage/");
  assert.throws(() => op("2^^3\n", false));
});

test("sage mode: exact rationals and sage_all", () => {
  const out = cli("--sage", "-c", "print(2^10, 6^^3, 2/3, 4/2, 2^-2, 1/2 + 1/2, 0.5/2, factor(-360), next_prime(100))");
  assert.equal(out, "1024 5 2/3 2 1/4 1 0.250000000000000 -1 * 2^3 * 3^2 * 5 101\n");
  // the preparser: ellipsis ranges, Integer methods on literals, f(x) = ...
  const lang = cli("--sage", "-c", "f(x) = x^2\nprint([1..5], [1,3..9], 12.factor(), 1.5r, f, f(3))");
  assert.equal(lang, "[1, 2, 3, 4, 5] [1, 3, 5, 7, 9] 2^2 * 3 1.5 x |--> x^2 9\n");
  // Python mode is unchanged.
  assert.equal(cli("-c", "print(2^3, 2/4)"), "1 0.5\n");
});

test("hash of a float, int or str subclass calling the base __hash__", () => {
  // (a Sage real literal is a float subclass whose __hash__ calls
  // float.__hash__(self), which dispatched back to it: RecursionError)
  assert.equal(cli("--sage", "-c", "print(hash(1.5) == hash(float(1.5)), {1.5: 1}[1.5])"), "True 1\n");
  const src = "class F(float):\n def __hash__(self): return float.__hash__(self)\nclass I(int):\n def __hash__(self): return int.__hash__(self)\nclass S(str):\n def __hash__(self): return str.__hash__(self)\nprint(hash(F(1.5)) == hash(1.5), hash(I(7)) == hash(7), hash(S('ab')) == hash('ab'))";
  assert.equal(cli("-c", src), "True True True\n");
});

test("pickling an int/float/str/bytes/tuple subclass instance keeps its value", () => {
  // (RR(pi) came back as 0.000000000000000: no __getnewargs__, so only the class was pickled)
  assert.equal(cli("--sage", "-c", "import pickle\nprint(pickle.loads(pickle.dumps(RR(pi))), pickle.loads(pickle.dumps(RealField(100)(2).sqrt())))"),
    "3.14159265358979 1.4142135623730950488016887242\n");
  const src = "import pickle\nclass F(float): pass\nclass I(int): pass\nclass S(str): pass\nclass B(bytes): pass\nclass T(tuple): pass\n" +
    "b = B(b'xy'); b.tag = 1\nfor p in (2, 5):\n for v in (F(1.5), I(7), S('ab'), b, T((1, 2))):\n  w = pickle.loads(pickle.dumps(v, p)); assert w == v and type(w) is type(v), (p, v)\n" +
    "print(pickle.loads(pickle.dumps(b)).tag)";
  assert.equal(cli("-c", src), "1\n");
});

// many ranges in one ellipsis list stay linear: whether an ellipsis is the
// first is a flag, not a rescan of the prefix (astra's PERF-CF3-1 on cf3b4f2:
// 16,000 ranges took 12.9 s copying 512 million prefix entries, against 0.09 s)
test("ellipsis_range with 16,000 ranges is linear", () => {
  const out = cli("--sage", "-c", "import time\na = [0, Ellipsis, -1] + [1, 2, Ellipsis, 1]*16000\nt = time.perf_counter(); v = ellipsis_range(*a); t = time.perf_counter() - t\nprint(v == [1]*16000, len(v), t < 1.0 or t)");
  assert.equal(out, "True 16000 True\n");
});

// limits of the tutorial fixes (daybreak2's HARD-38C-1, HARD-862-1): ideal
// generators convert by name in time linear in the rings' arities (adding
// zero ideals over 24000 variables took 11 s), and a rational's square root
// at a huge precision is refused before the integer square root (prec=10^8
// ran for minutes in 480 MB)
test("ideal conversion is linear in the arity; sqrt(prec) is admitted first", () => {
  const t = Date.now();
  const src = "import time\nS = PolynomialRing(QQ, 24000, 'x'); T = PolynomialRing(QQ, 24000, 'y')\nt = time.time(); K = S.ideal(S(0)) + T.ideal(T(0)); print(len(K.gens()), time.time() - t < 2)\n" +
    "try: QQ(2).sqrt(prec=100000000)\nexcept NotImplementedError as e: print('refused', 'limit' in str(e))\nprint((2/1).sqrt(prec=60000) > 1)";
  assert.equal(cli("--sage", "-c", src), "2 True\nrefused True\nTrue\n");
  assert.ok(Date.now() - t < 30000, `took ${Date.now() - t} ms`);
});

test("divmod with a real number above 16384 bits is refused first, integral or not (HARD-F2B-1)", () => {
  // (the cap came after the exact conversion and the integral fast path:
  // divmod(1/1, RealField(2^20)(2)) gave (1/2, 0))
  const src = "R = RealField(2^20)\nfor x in (R(2), R(1)/3, -R(2)):\n try:\n  print(divmod(1/1, x))\n except NotImplementedError as e:\n  print(e)\n";
  const t = Date.now();
  const line = "divmod with a real number of more than 16384 bits of precision is not implemented\n";
  assert.equal(cli("--sage", "-c", src), line.repeat(3));
  assert.ok(Date.now() - t < 20000);
});

test("a matrix index list subclass whose len() lies is refused after len() + 1 items (HARD-552-1)", () => {
  // (a list claiming length 1 that yielded 4.3 million indices passed the
  // block-size check: 15 s and 230 MB before the timeout)
  const src = "class E(list):\n def __len__(self): return 1\n def __iter__(self):\n  while True:\n   yield 0\n" +
    "A = matrix(QQ, 1, 1, [0])\nfor f in (lambda: A[E(), 0], lambda: A[0, E()], lambda: A[E()], lambda: A.__setitem__((E(), 0), 1), lambda: A.__setitem__((0, E()), 1)):\n try:\n  f()\n except ValueError as e:\n  print(e)\nprint(A)\n";
  const t = Date.now();
  const line = "an index list yielded more items but has length 1\n";
  assert.equal(cli("--sage", "-c", src), line.repeat(5) + "[0]\n");
  assert.ok(Date.now() - t < 20000);
});

test("QQ[a] refuses a field of degree above 16 before building it (HARD-EC1-1)", () => {
  // (nested radicals double the degree at each level: degree 32 took 8 s and
  // 250 MB in qqbar's Kronecker and characteristic-polynomial work)
  const src = "for n in [4, 5, 7]:\n x = sqrt(2)\n for i in range(n):\n  x = sqrt(x + i + 3)\n try:\n  QQ[x]\n except NotImplementedError as e:\n  print('refused', n)\n" +
    "a = QQbar(sqrt(2) + sqrt(3) + sqrt(5) + sqrt(7) + sqrt(11))\ntry:\n QQ[a]\nexcept NotImplementedError as e:\n print('refused qqbar')\nprint(QQ[sqrt(2 + sqrt(3 + sqrt(5)))].degree())\n";
  const t = Date.now();
  assert.equal(cli("--sage", "-c", src), "refused 4\nrefused 5\nrefused 7\nrefused qqbar\n8\n");
  assert.ok(Date.now() - t < 30000);
});

test("delete_edge reads at most 4 items of an edge that claims a length of 3 (HARD-658-1)", () => {
  // (tuple(e) read the whole iterator: 2,000,000 items and 414 MB, or forever)
  const src = "class E:\n def __init__(self): self.n = 0\n def __len__(self): return 3\n def __iter__(self):\n  while True:\n   self.n += 1\n   yield self.n\n" +
    "g = Graph([(0, 1), (1, 2)])\nfor f in (lambda e: g.delete_edge(e), lambda e: g.delete_edges([e])):\n e = E()\n try:\n  f(e)\n except ValueError as err:\n  print(type(err).__name__, e.n, g.size())\n";
  const t = Date.now();
  assert.equal(cli("--sage", "-c", src), "ValueError 4 2\nValueError 4 2\n");
  assert.ok(Date.now() - t < 20000);
});

test("variety refuses large point counts and precisions before the work (HARD-11A-1/2)", () => {
  // (x^1000000 - 1 reached the 100-point cap after 8 s and 1 GB; a linear
  // ideal over RealField(10^9) built 2^-(10^9) before its 20000-digit check)
  const src = "R.<x,y> = PolynomialRing(QQ, sparse=True)\nfor F in (RR, AA):\n try:\n  R.ideal([x^1000000 - 1, y]).variety(F)\n except NotImplementedError as e:\n  print('refused')\n" +
    "try:\n R.ideal([x - 1, y]).variety(RealField(10^9))\nexcept NotImplementedError as e:\n print('refused')\nprint(len(R.ideal([x^100 - 1, y]).variety(CC)))\n";
  const t = Date.now();
  assert.equal(cli("--sage", "-c", src), "refused\nrefused\nrefused\n100\n");
  assert.ok(Date.now() - t < 60000);
});

test("a large graph's adjacency matrices are refused before their n^2 entries exist (HARD-6B4-1)", () => {
  // (matrix(Graph(10000)) reached 1 GB before the 4194304-entry cap)
  const src = "G = Graph(10000)\nfor f in (G.adjacency_matrix, G.weighted_adjacency_matrix, G.laplacian_matrix, lambda: matrix(G), lambda: matrix(QQ, G), lambda: matrix(1, 1, G)):\n try:\n  f()\n except (NotImplementedError, ValueError) as err:\n  print(type(err).__name__)\nprint(matrix(Graph(3)).dimensions())\n";
  const t = Date.now();
  assert.equal(cli("--sage", "-c", src), "NotImplementedError\n".repeat(5) + "ValueError\n(3, 3)\n");
  assert.ok(Date.now() - t < 30000);
});

test("matrix() over a number field is built by elimination over K; a ring of integers is refused before anything is read (HARD-541-1)", () => {
  // (matrix(K, 0, 0, []) iterated K[0], K[1], ... until the heap ran out;
  // number fields now take QQbar's generic field path, and an order, which
  // matrices do not support yet, is still refused without being iterated)
  const src = "P.<t> = QQ[]\nK = NumberField(t^2 - 2, 'a')\nprint(matrix(K, 0, 0, []).dimensions(), matrix(K, [[K.gen()]]).det(), matrix(QuadraticField(-3, 'b'), 1, 1, [1]).rank())\ntry:\n matrix(K.maximal_order(), 0, 0, [])\nexcept NotImplementedError as e:\n print(type(e).__name__)\nprint(matrix(QQbar, 2, 2, [1, 2, 3, 4]).det())\n";
  const t = Date.now();
  assert.equal(cli("--sage", "-c", src), "(0, 0) a 1\nNotImplementedError\n-2\n");
  assert.ok(Date.now() - t < 30000);
});

test("matrix() keeps callable row iterables as rows, and takes an entry function (CORR-260-1)", () => {
  // (the HARD-541-1 rule had refused any callable object without a length;
  // and matrix(QQ, 2, 2, f) was a TypeError; values as Sage 10.10's)
  const src = "class Rows:\n def __iter__(self): return iter([[1, 2], [3, 4]])\n def __call__(self): return 0\n" +
    "def f(i, j): return i + j\n" +
    "for m in (matrix(Rows()), matrix(QQ, 2, 2, f), matrix(QQ, 2, 2, lambda i, j: i - j), matrix(ZZ, 2, 3, lambda i, j: 10*i + j)):\n print(m.dimensions(), m.list())\n";
  assert.equal(cli("--sage", "-c", src),
    "(2, 2) [1, 2, 3, 4]\n(2, 2) [0, 1, 1, 2]\n(2, 2) [0, -1, 1, 0]\n(2, 3) [0, 1, 2, 10, 11, 12]\n");
});

test("matrix() converts each entry function value as it is returned (CORR-C12-1)", () => {
  // (the values were converted after all the calls: a callback returning one
  // mutable object gave [2, 2, 2, 2], and a ZZ callback ran past its first
  // non-integral value; values and call logs as Sage 10.10's)
  const src = "from fractions import Fraction\nclass Value(Fraction):\n @property\n def numerator(self): return self.n\n @property\n def denominator(self): return 1\n" +
    "v = Value(0)\nv.n = 0\ndef f(i, j):\n v.n = int(i + j)\n return v\nprint(matrix(ZZ, 2, 2, f).list())\n" +
    "calls = []\ndef g(i, j):\n calls.append((int(i), int(j)))\n return QQ(i - j)/2\ntry:\n matrix(ZZ, 2, 3, g)\nexcept TypeError:\n print(calls)\n";
  assert.equal(cli("--sage", "-c", src), "[0, 1, 1, 2]\n[(0, 0), (0, 1)]\n");
});

test("matrix(QQ, r, c, f) converts each value strictly before the next call (CORR-798-1)", () => {
  // (a value that failed to convert was kept and changed by later calls:
  // [2, 1, 1, 2] where Sage 10.10 raises the value's own TypeError after (0, 0))
  const src = "from fractions import Fraction\nclass V(Fraction):\n @property\n def numerator(self):\n  if self.n == 0: raise TypeError('not rational yet')\n  return self.n\n @property\n def denominator(self): return 1\n" +
    "v = V(1)\nv.n = 0\ncalls = []\ndef f(i, j):\n calls.append((int(i), int(j)))\n v.n = int(i + j)\n return v\ntry:\n print(matrix(QQ, 2, 2, f).list())\nexcept TypeError as e:\n print('TypeError', e, calls)\n";
  assert.equal(cli("--sage", "-c", src), "TypeError not rational yet [(0, 0)]\n");
});
