import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// A matrix over a field (finite fields, number fields, QQbar, AA, RDF, ...)
// is admitted by the heap its entries take, as a share of the heap this
// process can grow to: in a small heap a large one is refused cleanly
// before it is built (a 512 x 512 matrix over AA ran V8 out of memory in
// 96 MiB: daybreak2's HARD-F4E-1), and the default heap keeps it.

const CLI = __dirname + "/../src/cli.js";
const run = (heap: string[], src: string) => spawnSync(process.execPath, [...heap, CLI, "--sage", "-c", src], { encoding: "utf8", timeout: 240000 });

const CASES = [
  "zero_matrix(AA, 181) + 1.0",
  // (entries the matrix makes itself: a list of 181^2 AA elements of the
  // caller's would fill 96 MiB on its own, before matrix() is called)
  "matrix(AA, 181, 181, range(181 * 181)) + 1",
  "random_matrix(RDF, 512) + 1.0",
  "matrix(GF(7), 1024, 1024, 1) * 3",
  "identity_matrix(QQbar, 300) * 2",
  // (a subspace's generators and their echelon form: daybreak2's HARD-21A-1)
  "VectorSpace(GF(7), 400).subspace([[int(i == j) for j in range(400)] for i in range(400)]).basis_matrix()",
  // (rows from a generator, counted as they are read: it is stopped at the
  // budget, not run to the end first)
  "matrix(RDF, ([float(i + j) for j in range(512)] for i in range(512)))",
];

test("a matrix over a field too big for a 96 MiB heap is refused before it is built", () => {
  const src = CASES.map((c) => `try:\n r = ${c}\n print('built', r.dimensions())\nexcept NotImplementedError as e:\n print('refused', str(e)[:60])\n`).join("") +
    "V = VectorSpace(RDF, 512)\ntry:\n V.subspace([[1.0] * 512] * 512)\nexcept NotImplementedError as e:\n print('refused', str(e)[:30])\n" +
    // (an endless row iterator: stopped at the budget for the rows read
    // and their conversion, daybreak2's HARD-5B6-1)
    "import itertools\ntry:\n matrix(RDF, ([0.0] * 512 for i in itertools.count()))\nexcept NotImplementedError as e:\n print('refused', str(e)[:30])\n" +
    // (one row, a generator past the budget: astra's CORR-03D-1)
    "try:\n matrix(RDF, ((0.0 for j in range(100000)) for i in range(1)))\nexcept NotImplementedError as e:\n print('refused', str(e)[:30])\n" +
    // (and an endless one: daybreak2's HARD-03D-1)
    "try:\n matrix(RDF, (iter(itertools.repeat(0.0)) for i in range(1)))\nexcept NotImplementedError as e:\n print('refused', str(e)[:30])\n" +
    // (the old generation the flag gives, whatever young generation this
    // Node version adds: 96 MiB, so the budget is the same everywhere)
    "print(sys._sagebrush_heap_limit == 96 * 2^20)\n";
  const r = run(["--max-old-space-size=96"], "import sys\n" + src);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, CASES.length + 5, r.stdout);
  for (const l of lines.slice(0, -1)) assert.match(l, /^refused a /, l);
  assert.equal(lines[CASES.length + 4], "True");
});

test("the same matrices are built in the default heap", () => {
  const src = CASES.map((c) => `print(tuple((${c}).dimensions()))\n`).join("");
  const r = run([], src);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "(181, 181)\n(181, 181)\n(512, 512)\n(1024, 1024)\n(300, 300)\n(400, 400)\n(512, 512)\n");
});

test("Sage's errors for a malformed matrix come before the heap budget, in either heap (astra's CORR-21A-1)", () => {
  // (a nonzero scalar for a non-square shape, a known wrong entry count and
  // ragged rows: no matrix exists, so its size is not what is refused)
  for (const [heap, R, n] of [[["--max-old-space-size=96"], "GF(7)", 500], [[], "AA", 700]] as [string[], string, number][]) {
    const cases = [`matrix(${R}, ${n}, ${n + 1}, 1)`, `matrix(${R}, ${n}, ${n}, [1])`, `matrix(${R}, [[0] * ${n + 1}] * ${n - 1} + [[0] * ${n}])`];
    const src = cases.map((c) => `try:\n ${c}\nexcept Exception as e:\n print(type(e).__name__, e)\n`).join("");
    const r = run(heap, src);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "TypeError nonzero scalar matrix must be square\nValueError entries has the wrong length\n" +
      `ValueError the rows of a matrix must all have ${n + 1} entries\n`);
  }
});

test("matrix(R, m, n, rows) has exactly m rows of n entries (astra's CORR-5B6-1)", () => {
  // (the rows were taken as given: matrix(GF(7), 1, 1, [[1], [2]]) was a 2 x 1
  // matrix, and too few rows were accepted; Sage raises ValueError)
  const cases = ["1, 1, [[1], [2]]", "0, 2, [[1, 2]]", "1, 0, [[], []]", "1, 2, [[1, 2], [3, 4]]", "0, 0, [[]]", "2, 2, [[1, 2]]", "3, 1, [[1], [2]]"];
  for (const heap of [["--max-old-space-size=96"], []]) {
    for (const R of ["GF(7)", "AA"]) {
      const src = cases.map((c) => `try:\n print(matrix(${R}, ${c}).dimensions())\nexcept ValueError:\n print('ValueError')\n`).join("") +
        `print(matrix(${R}, 2, 2, [[1, 2], [3, 4]]).list())\n`;
      const r = run(heap, src);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "ValueError\n".repeat(cases.length) + "[1, 2, 3, 4]\n");
    }
  }
});

const VECTORS = [
  "vector(RDF, [0.0] * 200000)",
  "VectorSpace(AA, 50000).zero()",
  "VectorSpace(RDF, 200000).random_element()",
  "VectorSpace(GF(7), 300000)([1] * 300000)",
];

test("a vector over a field too big for a 96 MiB heap is refused before it is built, and built in the default heap", () => {
  // (a vector had only the 4M-entry ceiling)
  const src = VECTORS.map((c) => `try:\n v = ${c}\n print('built', len(v))\nexcept NotImplementedError as e:\n print('refused', str(e)[:40])\n`).join("") +
    // (an endless iterator of entries: stopped at the budget)
    "import itertools\ntry:\n vector(GF(7), (i for i in itertools.count()))\nexcept NotImplementedError as e:\n print('refused', str(e)[:40])\n" +
    // (Sage's error for a wrong length comes first, whatever sized object
    // has it)
    "class L(list): pass\nclass T(tuple): pass\n" +
    "for x in ([1, 2], vector(QQ, [1, 2]), range(2), L([1, 2]), T((1, 2))):\n try:\n  VectorSpace(GF(7), 300000)(x)\n except TypeError as e:\n  print('TypeError', e)\n";
  const r = run(["--max-old-space-size=96"], src);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, VECTORS.length + 6, r.stdout);
  for (const l of lines.slice(0, VECTORS.length + 1)) assert.match(l, /^refused a vector /, l);
  // (a list, a vector over QQ, a range, a list and a tuple subclass: astra's CORR-4E2-1)
  for (const l of lines.slice(VECTORS.length + 1)) assert.equal(l, "TypeError entries must be a list of length 300000");
  const d = run([], VECTORS.map((c) => `print(len(${c}))\n`).join(""));
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.stdout, "200000\n50000\n200000\n300000\n");
});
