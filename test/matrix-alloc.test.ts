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
// five are refused after the limit plus one reads.  (CORR-6E4-2) A ragged
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
      "1 4",
      "the rows of a matrix must have the same length 0",
      "the rows of a matrix must have the same length 0",
      "",
    ].join("\n"),
  );
});
