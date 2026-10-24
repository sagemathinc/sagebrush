import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// A matrix over AA or QQbar is charged by what its entries hold: each entry,
// and each distinct algebraic generator once.  A charge per entry alone (1500
// budget units) admitted matrices whose entries each have their own
// generator and ran V8 out of memory in 96 MiB: 100 x 100 entries
// sqrt(k) + sqrt(3), each in its own degree-4 field.

const CLI = __dirname + "/../src/cli.js";
// (a run killed by its timeout fails as a timeout: r.error, not status null)
const run = (heap: string[], src: string, timeout = 120000) =>
  spawnSync(process.execPath, [...heap, CLI, "--sage", "-c", src], { encoding: "utf8", timeout });

test("the charge of the four measured AA/QQbar cases exceeds a 96 MiB budget, where 1500 an entry did not", () => {
  // (the largest n x n that fit in 96 MiB, built and added to itself, was 131
  // for sqrt(k), 110 for k^(1/3), 69 for sqrt(k) + sqrt(3) and 140 for QQbar
  // sqrt(-k); each n here is past that and was admitted by 1500 an entry.
  // One entry's charge, with its own field, times n^2: no matrix is built)
  const src = "import _sage_ffmat as f, _sage_qqbar as q\n" +
    "budget = f._heap_limit() // f._HEAP_SHARE\n" +
    "for n, x in ((128, AA(10002).sqrt()), (120, AA(10002)^(1/3)), (100, AA(10002).sqrt() + AA(3).sqrt()), (128, QQbar(-10002).sqrt())):\n" +
    " print(n, n * n * q._heap_units(x, set()) > budget, n * n * 1500 <= budget)\n";
  const r = run(["--max-old-space-size=96"], src);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.equal(r.stdout, "128 True True\n120 True True\n100 True True\n128 True True\n");
});

test("a matrix over AA whose entries each have their own field is refused, not crashed, in 96 MiB", () => {
  // (refused within a row of the budget: NotImplementedError, and the process
  // goes on, well before the heap is full: the entries up to the budget are
  // built first)
  // (building those ~5500 entries takes 20-22 s on an idle machine, Node 24
  // and 26 alike, with at most 65-67 MB live after a full GC: the heap
  // has room, but in a loaded full CI run it took over 120 s, so the time
  // limit is generous; the margin was measured Oct 19, see the commit)
  const c = "A = matrix(AA, 128, 128, lambda i, j: AA(128*i + j + 2).sqrt())";
  const r = run(["--max-old-space-size=96"], `try:\n ${c}\n print('built')\nexcept (NotImplementedError, MemoryError) as e:\n print('refused', type(e).__name__, ' '.join(str(e).split())[:40])\nprint(matrix(AA, [[1, 2]]) + matrix(AA, [[3, 4]]))\n`, 600000);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^refused (NotImplementedError a |SagebrushMemoryError Not enough memory for th)/);
  assert.equal(lines[1], "[4 6]");
});
