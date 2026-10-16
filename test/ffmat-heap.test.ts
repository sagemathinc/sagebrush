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
];

test("a matrix over a field too big for a 96 MiB heap is refused before it is built", () => {
  const src = CASES.map((c) => `try:\n r = ${c}\n print('built', r.dimensions())\nexcept NotImplementedError as e:\n print('refused', str(e)[:60])\n`).join("") + "print(sys._sagebrush_heap_limit > 0)\n";
  const r = run(["--max-old-space-size=96"], "import sys\n" + src);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, CASES.length + 1, r.stdout);
  for (const l of lines.slice(0, -1)) assert.match(l, /^refused a \d+ x \d+ matrix over /, l);
  assert.equal(lines[CASES.length], "True");
});

test("the same matrices are built in the default heap", () => {
  const src = CASES.map((c) => `print(tuple((${c}).dimensions()))\n`).join("");
  const r = run([], src);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "(181, 181)\n(181, 181)\n(512, 512)\n(1024, 1024)\n(300, 300)\n");
});
