import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// A matrix over AA or QQbar is charged by what its entries hold: each entry,
// and each distinct algebraic generator once.  A charge per entry alone (1500
// budget units) admitted matrices whose entries each have their own
// generator and ran V8 out of memory in 96 MiB: 100 x 100 entries
// sqrt(k) + sqrt(3), each in its own degree-4 field.

const CLI = __dirname + "/../src/cli.js";
const run = (heap: string[], src: string) => spawnSync(process.execPath, [...heap, CLI, "--sage", "-c", src], { encoding: "utf8", timeout: 600000 });

// (the four bisection cases, 96 MiB: the largest n that fit, build and A + A, was
// 131 for sqrt(k), 110 for k^(1/3), 69 for sqrt(k) + sqrt(3), and 138 for QQbar
// sqrt(-k); each n here is past that and below the per-entry cap's 129)
const CASES: [string, string][] = [
  ["AA, sqrt(k)", "A = matrix(AA, 128, 128, lambda i, j: AA(128*i + j + 2).sqrt()); B = A + A"],
  ["AA, k^(1/3)", "A = matrix(AA, 120, 120, lambda i, j: AA(120*i + j + 2)^(1/3)); B = A + A"],
  ["AA, sqrt(k) + sqrt(3)", "A = matrix(AA, 100, 100, lambda i, j: AA(100*i + j + 2).sqrt() + AA(3).sqrt()); B = A + A"],
  ["QQbar, sqrt(-k)", "A = matrix(QQbar, 128, 128, lambda i, j: QQbar(-(128*i + j + 2)).sqrt()); B = A + A"],
];

test("a matrix over AA or QQbar whose entries each have their own generator is refused, not crashed, in 96 MiB", () => {
  for (const [name, c] of CASES) {
    // (refused cleanly: NotImplementedError, the process going on afterwards)
    const r = run(["--max-old-space-size=96"], `try:\n ${c.replace(/; /g, "\n ")}\n print('built')\nexcept NotImplementedError as e:\n print('refused', str(e)[:24])\nprint(matrix(AA, [[1, 2]]) + matrix(AA, [[3, 4]]))\n`);
    assert.equal(r.status, 0, name + ": " + r.stderr.slice(-400));
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0], /^refused a /, name);
    assert.equal(lines[1], "[4 6]", name);
  }
});

test("a matrix over AA refused in 96 MiB is built in the default heap", () => {
  // (the budget scales with the heap; only the cheapest of the four cases,
  // since each entry is an algebraic number of its own: building all four
  // took 265 s)
  const r = run([], CASES[0][1].replace(/; /g, "\n") + "\nprint(B.dimensions())\n");
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.equal(r.stdout, "(128, 128)\n");
});
