import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// math.factorial, comb, perm and prod as balanced products, compared with
// CPython 3.14 (test/bigint_products_cases.py); Sage mode's prod against
// Sage itself is sage-tests/test_prod_tree.sage
const TEST = __dirname + "/../../test/";
for (const name of ["bigint_products_cases.py"]) {
  test(`big-integer products as CPython's: ${name}`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}

// (fast enough to be a product tree: the old loops took 4 s for
// factorial(100000) and about 2 s for prod(range(1, 100001)); a tree takes
// tens of milliseconds, so these bounds hold on a slow machine and fail on
// a quadratic one)
test("big-integer products are balanced, not quadratic", () => {
  const src = [
    "import math, time",
    "t = time.perf_counter(); math.factorial(100000); a = time.perf_counter() - t",
    "t = time.perf_counter(); math.prod(range(1, 100001)); b = time.perf_counter() - t",
    "t = time.perf_counter(); math.comb(200000, 100000); c = time.perf_counter() - t",
    "print(a, b, c)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" });
  const [a, b, c] = out.trim().split(" ").map(Number);
  assert.ok(a < 1.5 && b < 1.5 && c < 1.5, `factorial ${a} s, prod ${b} s, comb ${c} s`);
});

// (comb and perm with k of 0 or 1 return 1 or n before any size bound,
// which reads n's digits: with those refused, the trivial cases still
// answer, and one that is bounded, comb(n, 2), trips the guard;
// daybreak2's LIMIT-PTREE-1)
test("comb and perm of k 0 or 1 read nothing of n", () => {
  const guard = ["--require", __dirname + "/../../test/bigint-products-trivial.cjs"];
  const trivial = [
    "import math",
    "n = 2**200000 + 12345",
    "r = [math.comb(n, 0), math.comb(n, 1) == n, math.comb(n, n), math.comb(n, n - 1) == n, math.perm(n, 0), math.perm(n, 1) == n]",
    "print(r, math.comb(n, 1) is not None)",
  ].join("\n");
  const out = execFileSync(process.execPath, [...guard, __dirname + "/../src/cli.js", "-c", trivial], { encoding: "utf8" });
  assert.equal(out.trim(), "[1, True, 1, True, 1, True] True");
  const bounded = "import math\nmath.comb(2**200000, 2)";
  assert.throws(() => execFileSync(process.execPath, [...guard, __dirname + "/../src/cli.js", "-c", bounded], { encoding: "utf8", stdio: "pipe" }), /hex digits of a big integer read/);
});

test("Sage mode's prod is balanced, not quadratic", () => {
  const src = "import time\nt = time.perf_counter(); prod(range(1, 100001)); print(time.perf_counter() - t)";
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8" });
  assert.ok(Number(out.trim()) < 1.5, `prod ${out.trim()} s`);
});
