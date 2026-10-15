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
