import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

// sum() of ints across 2^53, where pyjs's ints change from doubles to
// BigInt: exact (expected output from CPython 3.14), ranges summed in chunks
test("sum() of ints beyond 2^53 is exact", () => {
  assert.equal(cli("-c", "print(sum(range(10**6)), sum(range(10**7, 0, -7)), sum(range(-2**53 + 1, -2**53 + 6)), sum(range(2**53 - 3, 2**53 - 1)))\nprint(sum(range(0, 2**53 - 1, 2**50)), sum(range(3), 2**80), sum(range(0)), sum(range(5, 6), -1))\nprint(sum([2**52, 2**52, 2**52, 1]), sum(iter([2**53 - 1, 1, 1])), sum([(2**52 + 1)] * 5), sum([2**70, -2**70, 5]))\nprint(sum([1, 2.5, 3]), sum([True, True, 3]), sum([10**20, 1, 2.0]), sum([], 7), sum([1, 2], 2**60))\nprint(sum(x * x for x in range(10**5)), sum(range(10**15, 10**15 + 10**5)), sum(range(10**8)))\nfrom fractions import Fraction\nprint(sum([1, Fraction(1, 2), 3]), type(sum(range(10))).__name__, type(sum(range(2**27, 2**27 + 2**27))).__name__)\n"), "499999500000 7142862142858 -45035996273704945 18014398509481979\n31525197391593472 1208925819614629174706179 0 4\n13510798882111489 9007199254740993 22517998136852485 5\n6.5 5 1e+20 7 1152921504606846979\n333328333350000 100000000004999950000 4999999950000000\n9/2 int int\n");
});

// and fast: sum(range(10**9)) took 35 s when every addition past 2^53 was a
// BigInt addition (CPython: ~9 s)
test("sum(range(10**9)) stays fast past 2^53", () => {
  const t = Date.now();
  assert.equal(cli("-c", "print(sum(range(10**9)))"), "499999999500000000\n");
  assert.ok(Date.now() - t < 15000, `took ${Date.now() - t} ms`);
});

// weakrefs compare and hash by referent (the first two lines as CPython 3.14
// prints them); otherwise _py_abc's WeakSet caches never hit and every
// isinstance(x, numbers.Rational) added a ref (1000 here): Fraction arithmetic
// with ints leaked ~2.5 KB per operation, and E.gens() over a few hundred
// curves ran out of memory
test("weakref equality and hashing; isinstance on an ABC hits its cache", () => {
  assert.equal(cli("-c", "import weakref, numbers\nclass C: pass\nc, d = C(), C(); r = weakref.ref(c)\nprint(r == weakref.ref(c), r != weakref.ref(d), r == weakref.ref(d), {r: 1}[weakref.ref(c)], r == 3)\nws = weakref.WeakSet([c]); print(c in ws, d in ws, len(ws))\nfor i in range(1000): isinstance(i, numbers.Rational)\nprint(len(numbers.Rational._abc_cache), len(numbers.Integral._abc_negative_cache))\n"), "True True False 1 False\nTrue False 1\n1 0\n");
});
