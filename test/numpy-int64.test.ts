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

// (astra CORR-76A-1/2: the protocols a Python object is converted
// through, counted, and the float64 products' order)
test("a Python object into int64 or uint64 converts through NumPy's protocol, once", () => {
  const name = "numpy_int64_protocol_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// (astra CORR-3D5-1: float64 and complex128 products in NumPy's
// reduction order over transposed, reversed and Fortran layouts, axes
// and initial=, her 384-case grids)
// (CORR-948-1: broadcast axes' zero strides, and her 648-case probe of
// broadcasts, reversals, steps, transposes, axis tuples and initial=)
for (const name of ["numpy_prod_order_cases.py", "numpy_prod3d64_cases.py", "numpy_prod3d128_cases.py", "numpy_prod_broadcast_cases.py", "numpy_prod_stride_cases.py"]) {
  test(`numpy prod in NumPy's order: ${name}`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
    const w = want.split("\n"), g = got.split("\n");
    for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
  });
}

// (each repro from the int64 report, and the paths that produce int64
// values: creation, scalars, arithmetic, reductions, matmul, astype)
test("an int64 or uint64 value Sagebrush cannot hold exactly is refused, never rounded", () => {
  const cases = [
    "np.array([2**53 + 1])", "np.array([3]) ** 50", "np.array([3]) ** 40", "np.array([1]) + 2**60", "np.array([1]) + (2**60 + 1)",
    "np.prod(np.array([3**20, 3**20, 3]))", "np.cumprod(np.array([3**20, 3**20, 3]))", "np.array([1e20]).astype(np.int64)",
    "np.array([float('nan')]).astype(np.int64)", "np.array([-1]).astype(np.uint64)", "np.array([3], np.uint64) - np.array([5], np.uint64)",
    "np.square(np.array([2**31 + 1]))", "np.array([1]) & (2**60 + 1)", "np.array([2**62 + 1])",
    "np.sum(np.array([2**62, 2**62, 1]))", "~np.array([2**62])", "np.array([2**62]) // np.array([3])",
    // (astra's review of 6ae79e89)
    "np.int64(2**53) + np.int64(1)", "np.add(np.int64(2**53), np.int64(1))", "np.int64(2**62) // 3", "np.sum(np.array([2**53]), initial=1)",
    "np.array([2**53], np.uint64) + np.array([1], np.uint64)", "(lambda a: a.__setitem__(0, 2**53 + 1))(np.zeros(3, dtype=np.int64))",
    "(lambda a: a.__setitem__(slice(None), 2**53 + 1))(np.zeros(3, dtype=np.int64))", "np.full(2, 2**53 + 1)", "np.full(2, 2**53 + 1, dtype=np.int64)",
    "np.arange(2**53, 2**53 + 4)", "np.array([2**53]) == np.int64(2**53 + 1)", "np.array([0]) + np.int64(2**53 + 1)",
    "np.array([np.int64(2**53 + 1)])", "np.maximum(np.array([0], np.uint64), 2**63 - 1)", "np.int64(2**53 + 1) + 1",
    "-np.array([1], np.uint64)", "np.array([type('B', (), {'__int__': lambda s: 2**53 + 1, '__index__': lambda s: 7})()], dtype=np.int64)", "np.array([type('I', (), {'__int__': lambda s: 2**53 + 1, '__float__': lambda s: 2.0**53})()], dtype=np.int64)",
  ];
  const src = "import numpy as np\n" + cases.map((c) => `try:\n    print(repr(${c}))\nexcept NotImplementedError as e:\n    print(type(e).__name__, e)`).join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  assert.equal(out.length, cases.length);
  out.forEach((l, i) => assert.match(l, /^NotImplementedError u?int64 values beyond 2\*\*53 are not supported yet$/, cases[i]));
});

// (astra CORR-1B4-2: a float32 product over several axes of a view whose
// order NumPy's iterator chooses (reordered axes, flipped strides) is
// refused, never a product in another order)
test("a float32 product NumPy orders by its iterator is refused", () => {
  const src = `import numpy as np
c = np.array([1e-30, 1e30, 1e30, 1e-30, 1, 1e-30, 1e30, 1, 1e-30, 1e30, 1, 1], np.float32).reshape(2, 3, 2)
for f in (lambda: np.prod(c[::-1]), lambda: np.prod(c[::-1], axis=(0, 1)), lambda: np.prod(c[:, ::-1], keepdims=True), lambda: np.prod(c[:, ::-1], initial=1e30), lambda: np.prod(c.T), lambda: np.prod(c, axis=(0, 2)), lambda: np.prod(np.asfortranarray(c))):
    try:
        print(f())
    except NotImplementedError as e:
        print(type(e).__name__, "several axes" in str(e))`;
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(out, Array(7).fill("NotImplementedError True"));
});
