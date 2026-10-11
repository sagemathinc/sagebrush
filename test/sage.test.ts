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
