import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// (#2149: a float cast to uint32 is NumPy's per-element (scalar) conversion
// for every element, contiguous or strided, of any length: through a 64-bit
// integer, its low 32 bits kept, with the warning exactly when that
// conversion is invalid. NumPy's vectorized loop gives some contiguous
// elements other values (NUMPY.md), so these rows are pinned here, not
// compared with NumPy; numpy-tests/test_float_int_cast.py compares the
// strided ones, which NumPy converts per element.)
const run = (src: string): string[] =>
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");

test("a float cast to uint32 gives every element the per-element result and warning", () => {
  // value -> [result, warned]
  const want: [string, number, boolean][] = [
    ["float('nan')", 0, true], ["float('inf')", 0, true], ["-float('inf')", 0, true], ["-3e9", 1294967296, false],
    ["4.3e9", 5032704, false], ["2.0 ** 63", 0, true], ["-2.0 ** 63", 0, false], ["1e20", 0, true], ["-1.5", 4294967295, false],
    ["70000.7", 70000, false],
  ];
  const src = `import numpy as np, warnings
for v in (${want.map((w) => w[0]).join(", ")},):
    seen = set()
    for n in range(1, 10):
        for strided in (False, True):
            a = np.full(2 * n, v)[::2] if strided else np.full(n, v)
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                r = a.astype(np.uint32).tolist()
            seen.add((tuple(sorted(set(r))), tuple(str(x.message) for x in w)))
    print(sorted(seen))`;
  const out = run(src);
  assert.equal(out.length, want.length);
  want.forEach(([v, r, warned], i) =>
    assert.equal(out[i], `[((${r},), (${warned ? "'invalid value encountered in cast',": ""}))]`, v));
});

test("np.full(5, -3e9) cast to uint32 is [1294967296]*5, unwarned", () => {
  const out = run(`import numpy as np, warnings
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    r = np.full(5, -3e9).astype(np.uint32)
print(r.tolist() == [1294967296] * 5, len(w))`);
  assert.deepEqual(out, ["True 0"]);
});

// (ENGINE's review of 15c03313: a cast whose loop throws midway, after an
// invalid conversion, mustn't leave its warning to the next cast. Nothing in
// Python makes a cast's loop throw, so its source is made to throw here, in
// the runtime itself; the next, valid cast then gives its values and no
// warning (a warning would need the interpreter, which isn't running here))
test("a cast that throws midway leaves no warning for the next cast", () => {
  const np = require("../src/runtime/numpy");
  const f64 = np.toDtype("float64"), i8 = np.toDtype("int8");
  const bad = np.empty([3], f64);
  bad.data[0] = NaN;
  bad.data = new Proxy(bad.data, { get: (t: any, k: any) => (k === "1" ? assert.fail("midway") : Reflect.get(t, k)) });
  assert.throws(() => np.copy(bad, i8), /midway/);
  const ok = np.empty([2], f64);
  ok.data.set([1.5, -2.5]);
  assert.deepEqual(Array.from(np.copy(ok, i8).data), [1, -2]);
  // (a complex source, by its real parts: its own loop)
  const c128 = np.toDtype("complex128");
  const badc = np.empty([3], c128);
  badc.data[0] = NaN;
  badc.data = new Proxy(badc.data, { get: (t: any, k: any) => (k === "2" ? assert.fail("midway") : Reflect.get(t, k)) });
  assert.throws(() => np.copy(badc, i8), /midway/);
  const okc = np.empty([1], c128);
  okc.data.set([3.5, 9]);
  assert.deepEqual(Array.from(np.copy(okc, i8).data), [3]);
});

// (NUMERIC's ruling on 15c03313: one warning per call, naming the operation.
// NumPy casts an identity-less reduction's or an accumulation's first
// element on its own ("cast"), then the rest ("reduce", "accumulate"), so it
// can give two warnings, or "cast" alone; Sagebrush gives one, named by the
// operation (NUMPY.md))
test("min, max and accumulations into an integer out give one warning, named by the operation", () => {
  const cases: [string, string][] = [
    ["np.max(np.array([np.nan, 1.0]), out=np.zeros((), np.int8))", "reduce"],
    ["np.min(np.array([[np.nan, 1.0], [2.0, np.nan]]), axis=1, out=np.zeros(2, np.int8))", "reduce"],
    ["np.max(np.array([np.inf, 1.0]), out=np.zeros((), np.int8))", "reduce"],
    ["np.cumsum(np.array([np.nan, 1.0]), out=np.zeros(2, np.int8))", "accumulate"],
    ["np.cumprod(np.array([np.nan, 1.0]), out=np.zeros(2, np.int8))", "accumulate"],
    ["np.add.accumulate(np.array([np.nan, 1.0]), out=np.zeros(2, np.int8))", "accumulate"],
  ];
  const src = "import numpy as np, warnings\n" + cases.map(([c]) => `with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    ${c}
print([str(m.message) for m in w])`).join("\n");
  const out = run(src);
  assert.equal(out.length, cases.length);
  cases.forEach(([c, op], i) => assert.equal(out[i], `['invalid value encountered in ${op}']`, c));
});
