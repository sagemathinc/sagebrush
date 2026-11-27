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

// (#2283: as NumPy's, a complex array multiplied in a real dtype is the product of its real parts, with NumPy's
// ComplexWarning, not a refusal; a bool dtype reads both parts)
test("a complex array multiplied into a real dtype is its real parts' product, with NumPy's ComplexWarning", () => {
  const src = `import numpy as np, warnings
for d in (float, np.float32, np.int8, bool):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r = np.prod(np.array([1+2j, 3, 0.5+4j]), dtype=d)
    print(repr(r), [(m.category.__name__, str(m.message)) for m in w])`;
  const want = execFileSync("python3", ["-c", src], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" });
  assert.equal(got, want);
});
