import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// numpy.prod of complex arrays kept only the real parts' product (found by
// the MATLAB catalog probe): np.prod(np.array([1+2j, 3])) gave 3, not
// (3+6j). Compared with CPython's NumPy: prod over every axis and axis
// tuple, keepdims, strided and transposed arrays, complex64, a real array
// into a complex dtype, empty products, overflow and infinities, initial,
// and cumprod (test/numpy_complex_prod_cases.py).
const TEST = __dirname + "/../../test/";
test("numpy.prod and cumprod of complex arrays are NumPy's, imaginary parts and all", () => {
  const name = "numpy_complex_prod_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

test("a complex array multiplied into a real dtype is refused in words, not its imaginary parts silently dropped", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", "import numpy as np\ntry:\n    np.prod(np.array([1+2j, 3]), dtype=float)\nexcept TypeError as e:\n    print(e)"], { encoding: "utf8" });
  assert.equal(out.trim(), "prod: a complex array multiplied in the real dtype float64 would lose its imaginary parts; take .real first");
});
