import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// numpy int64 and uint64 arithmetic: overflow wrapped as NumPy's where the
// result is exactly representable in Sagebrush's int64 arrays (doubles),
// compared with CPython's NumPy (test/numpy_int64_cases.py); every value
// they cannot hold exactly refused, never rounded.
const TEST = __dirname + "/../../test/";
test("numpy int64 arithmetic wraps as NumPy's, exactly", () => {
  const name = "numpy_int64_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// (each repro from the int64 report, and the paths that produce int64
// values: creation, scalars, arithmetic, reductions, matmul, astype)
test("an int64 or uint64 value Sagebrush cannot hold exactly is refused, never rounded", () => {
  const cases = [
    "np.array([2**53 + 1])", "np.array([3]) ** 50", "np.array([3]) ** 40", "np.array([1]) + 2**60", "np.array([1]) + (2**60 + 1)",
    "np.prod(np.array([3**20, 3**20, 3]))", "np.cumprod(np.array([3**20, 3**20, 3]))", "np.array([1e20]).astype(np.int64)",
    "np.array([float('nan')]).astype(np.int64)", "np.array([-1]).astype(np.uint64)", "np.array([3], np.uint64) - np.array([5], np.uint64)",
    "np.square(np.array([2**31 + 1]))", "np.array([1]) & (2**60 + 1)", "np.array([2**62]) == 2**62 + 1", "np.array([2**62 + 1])",
    "np.sum(np.array([2**62, 2**62, 1]))", "~np.array([2**62])", "np.array([2**62]) // np.array([3])",
  ];
  const src = "import numpy as np\n" + cases.map((c) => `try:\n    print(repr(${c}))\nexcept NotImplementedError as e:\n    print(type(e).__name__, e)`).join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  assert.equal(out.length, cases.length);
  out.forEach((l, i) => assert.match(l, /^NotImplementedError u?int64 values beyond 2\*\*53 are not supported yet$/, cases[i]));
});
