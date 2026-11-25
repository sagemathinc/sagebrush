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
