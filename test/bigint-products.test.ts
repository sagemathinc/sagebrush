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

// (comb and perm bound their sizes without making n's digits, which for
// an n near the largest BigInt are a string of 256 MiB: with any big
// integer's digits refused, k of 0 or 1 answer at once (daybreak2's
// LIMIT-PTREE-1), k of 2 and more bound n's size from its leading bits and
// answer (LIMIT-AF5-1), and one near the largest BigInt is refused at once;
// hex(n), which makes the digits, shows the guard is on)
test("comb and perm bound n's size without making its digits", () => {
  const guard = ["--require", __dirname + "/../../test/bigint-products-trivial.cjs"];
  const src = [
    "import math, time",
    "n = 2**200000 + 12345",
    "r = [math.comb(n, 0), math.comb(n, 1) == n, math.comb(n, n), math.comb(n, n - 1) == n, math.perm(n, 0), math.perm(n, 1) == n]",
    "r += [math.comb(n, 2) == n * (n - 1) // 2, math.perm(n, 2) == n * (n - 1), math.comb(n, 3) == n * (n - 1) * (n - 2) // 6, math.comb(n, n - 2) == math.comb(n, 2)]",
    "huge = 2**(2**29 + 1000)",
    "t = time.perf_counter()",
    "for f, k in [(math.comb, 2), (math.perm, 2), (math.comb, 40), (math.perm, 3)]:",
    "    try:",
    "        f(huge, k)",
    "        r.append('computed')",
    "    except MemoryError:",
    "        r.append('refused')",
    "print(r, time.perf_counter() - t < 2)",
  ].join("\n");
  const out = execFileSync(process.execPath, [...guard, __dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out.trim(), "[1, True, 1, True, 1, True, True, True, True, True, 'refused', 'refused', 'refused', 'refused'] True");
  const control = "import math\nhex(2**200000)";
  assert.throws(() => execFileSync(process.execPath, [...guard, __dirname + "/../src/cli.js", "-c", control], { encoding: "utf8", stdio: "pipe" }), /digits of a big integer read/);
});

// (a product known too big for a BigInt is a MemoryError at once, its size
// bounded from below: comb(2**61 - 1, 2**60 - 1) lost its whole bound when
// log2(n) was read from n's first hex digit only, and its work began;
// astra's finding on 663ddbf2. CPython would compute these for ages.)
test("products past the largest BigInt are refused at once", () => {
  const src = [
    "import math, time",
    "cases = [(math.comb, 2**61 - 1, 2**60 - 1), (math.comb, 2**61 - 1, 2**31), (math.comb, 2**32, 2**30), (math.comb, 2**200 + 3, 2**24),",
    "         (math.comb, 2**70, 2**40), (math.perm, 2**61 - 1, 2**60 - 1), (math.perm, 2**61, 2**61 - 3), (math.perm, 2**200, 2**23)]",
    "t = time.perf_counter()",
    "for f, n, k in cases:",
    "    try:",
    "        f(n, k)",
    "        print('computed', n, k)",
    "    except MemoryError:",
    "        pass",
    "try:",
    "    math.factorial(2**40)",
    "except MemoryError:",
    "    print('refused', time.perf_counter() - t < 2)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", timeout: 60000 });
  assert.equal(out.trim(), "refused True");
});

test("Sage mode's prod is balanced, not quadratic", () => {
  const src = "import time\nt = time.perf_counter(); prod(range(1, 100001)); print(time.perf_counter() - t)";
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8" });
  assert.ok(Number(out.trim()) < 1.5, `prod ${out.trim()} s`);
});
