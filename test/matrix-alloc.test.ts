import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Every range(), list(), list repetition and loop over a parameter in the
// matrix and vector code (lib/_sage_matrix.py, lib/_sage_ffmat.py, the
// matrix part of lib/_sage_padic.py) is a reviewed site, recorded in
// test/matrix-alloc-sites.json: its size is bounded by data that already
// passed _shape, _bounded_list or _bounded_rows.  A new or changed site
// fails here until it is reviewed and recorded (the review of
// sage-padic-matrix found unbounded reads and allocations three times).
const ROOT = __dirname + "/../../test/";

test("matrix and vector allocation sites are all reviewed", () => {
  const got = JSON.parse(execFileSync("python3", [ROOT + "matrix_alloc_sites.py"], { encoding: "utf8" }));
  const want = JSON.parse(readFileSync(ROOT + "matrix-alloc-sites.json", "utf8"));
  const added = Object.keys(got).filter((k) => got[k] !== want[k]);
  const removed = Object.keys(want).filter((k) => !(k in got));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    "review these sites (each must be bounded by a checked shape or a bounded read), then run: python3 test/matrix_alloc_sites.py > test/matrix-alloc-sites.json",
  );
});

// sagebrush-daybreak on 6e41f39 (HARD-6E4-1): the finite-field and p-adic
// base detectors that matrix() runs first gave every row the full entry
// budget, so [row] * 2^22 with one shared row of 2^22 entries was 2^44
// reads.  The rows share one budget: at a limit of 5, five shared rows of
// five are refused after the limit plus one reads; and (HARD-8B7-1) the
// outer list's scalars share it, so four of them leave one entry for a row.  (CORR-6E4-2) A ragged
// Matrix is refused before any entry is converted (Probe counts the reads
// of a conversion: four for a good row of two).
test("matrix() reads shared rows within one budget; ragged rows are refused before conversion", () => {
  const src = `
import numbers
import _sage_matrix as sm
class CountingRow(list):
    calls = 0
    def __iter__(self):
        for x in list.__iter__(self):
            CountingRow.calls += 1
            yield x
sm._MAX_ENTRIES = 5
row = CountingRow([0] * 5)
for n in [1, 5]:
    CountingRow.calls = 0
    try:
        print(matrix([row] * n).dimensions(), CountingRow.calls)
    except ValueError as e:
        print(e, CountingRow.calls)
CountingRow.calls = 0
try:
    sm._ff_base_of([[row] * 5])
except ValueError as e:
    print(e, CountingRow.calls)
# (8b7b533, HARD-8B7-1) the outer list's scalars count too
for scan in [matrix, sm._ff_base_of, sm._padic_base_of]:
    CountingRow.calls = 0
    try:
        scan([0, 0, 0, 0, row])
    except ValueError as e:
        print(e, CountingRow.calls)
sm._MAX_ENTRIES = 1 << 22
class Probe:
    reads = 0
    @property
    def numerator(self):
        Probe.reads += 1; return 1
    @property
    def denominator(self):
        Probe.reads += 1; return 2
numbers.Rational.register(Probe)
x = Probe()
print(sm.Matrix(object(), [[x, x]]).nrows(), Probe.reads)
Probe.reads = 0
for f in [lambda: sm.Matrix(object(), [[x, x], [x]]), lambda: sm.Matrix(object(), [[x], [x]], 2)]:
    try:
        f()
    except ValueError as e:
        print(e, Probe.reads)
`;
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8" });
  assert.equal(
    out,
    [
      "(1, 5) 15",
      "more than 5 entries 6",
      "more than 5 entries 1",
      "more than 5 entries 2",
      "more than 5 entries 2",
      "more than 5 entries 2",
      "1 4",
      "the rows of a matrix must have the same length 0",
      "the rows of a matrix must have the same length 0",
      "",
    ].join("\n"),
  );
});

// matrix(..., {(i, j): x}) (the dict-of-positions forms): every key is read
// and checked before the size is admitted (_shape), and the size before the
// entries are allocated; a dict of more keys than any admitted matrix has
// positions is refused before any key is read; a dict subclass is read as a
// dict, its own items() not called.
test("matrix() from a dict admits its keys, then its size, before allocating", () => {
  const src = `
import _sage_matrix as sm
def run(f):
    try:
        M = f()
        print("ok", M.dimensions())
    except Exception as e:
        print(type(e).__name__, str(e).split(" (")[0])
shapes = []
real_shape = sm._shape
def spy_shape(m, n, limit=None):
    shapes.append((m, n))
    return real_shape(m, n, limit)
sm._shape = spy_shape
run(lambda: sm.matrix({(10**12, 10**12): 1}))
run(lambda: sm.matrix(ZZ, 10**6, 10**6, {(0, 0): 1}))
run(lambda: sm.matrix(ZZ, 10**6, 10**6, {(0, 0.5): 1}))
print(shapes)
sm._shape = real_shape
class Key(tuple):
    reads = 0
    def __iter__(self):
        Key.reads += 1
        return tuple.__iter__(self)
saved = sm._MAX_ENTRIES
sm._MAX_ENTRIES = 5
run(lambda: sm.matrix(ZZ, 3, 3, {Key((i, 0)): 1 for i in range(6)}))
print("keys read", Key.reads)
sm._MAX_ENTRIES = saved
class Odd(dict):
    def items(self):
        return [((0, 0), 99)]
print(sm.matrix(ZZ, 2, 2, Odd({(1, 1): 5})).list())
`;
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8" });
  assert.equal(
    out,
    [
      "NotImplementedError a 1000000000001 x 1000000000001 matrix exceeds sagebrush's limit of 4194304 entries",
      "NotImplementedError a 1000000 x 1000000 matrix exceeds sagebrush's limit of 4194304 entries",
      "TypeError 'sage.rings.real_mpfr.RealLiteral' object cannot be interpreted as an integer",
      "[(1000000000001, 1000000000001), (1000000, 1000000)]",
      "ValueError more than 5 entries",
      "keys read 0",
      "[0, 0, 0, 5]",
      "",
    ].join("\n"),
  );
});
