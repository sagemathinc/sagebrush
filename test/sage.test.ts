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
