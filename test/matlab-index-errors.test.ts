import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Indexing errors as MATLAB raises them: every bad or out-of-range subscript is MATLAB:badsubscript; a bad linear
// index says only "Array indices must be positive integers or logical values.", a bad subscript among several names
// its position, and a logical index past the end has its own message. Each row's identifier and message were
// recorded from MATLAB R2026b (v = [1 2 3], m = magic(2)); NaN and Inf subscripts used to leak a Python error.

const cli = join(__dirname, "..", "src", "cli.js");

// [name, statements, "identifier|message" as MATLAB R2026b printed them]
const ROWS: [string, string, string][] = [
  ["v0", "a = v(0);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vneg", "a = v(-1);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vfrac", "a = v(1.5);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vnan", "a = v(NaN);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vinf", "a = v(Inf);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vninf", "a = v(-Inf);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vvnan", "a = v([1 NaN]);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vvinf", "a = v([2 Inf]);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["v00", "a = v([1 0]);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vs0", "a = v(single(0));", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vsnan", "a = v(single(NaN));", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vi0", "a = v(int8(0));", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["ve0", "a = v(end-3);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["m01", "a = m(0,1);", "MATLAB:badsubscript|Index in position 1 is invalid. Array indices must be positive integers or logical values."],
  ["m10", "a = m(1,0);", "MATLAB:badsubscript|Index in position 2 is invalid. Array indices must be positive integers or logical values."],
  ["mnan1", "a = m(NaN,1);", "MATLAB:badsubscript|Index in position 1 is invalid. Array indices must be positive integers or logical values."],
  ["m1inf", "a = m(1,Inf);", "MATLAB:badsubscript|Index in position 2 is invalid. Array indices must be positive integers or logical values."],
  ["m1frac", "a = m(1,1.5);", "MATLAB:badsubscript|Index in position 2 is invalid. Array indices must be positive integers or logical values."],
  ["m30", "a = m(3,1);", "MATLAB:badsubscript|Index in position 1 exceeds array bounds. Index must not exceed 2."],
  ["m13", "a = m(1,3);", "MATLAB:badsubscript|Index in position 2 exceeds array bounds. Index must not exceed 2."],
  ["m5", "a = m(5);", "MATLAB:badsubscript|Index exceeds the number of array elements. Index must not exceed 4."],
  ["m111", "a = m(1,1,2);", "MATLAB:badsubscript|Index in position 3 exceeds array bounds. Index must not exceed 1."],
  ["m0c", "a = m(0,:);", "MATLAB:badsubscript|Index in position 1 is invalid. Array indices must be positive integers or logical values."],
  ["mc0", "a = m(:,0);", "MATLAB:badsubscript|Index in position 2 is invalid. Array indices must be positive integers or logical values."],
  ["vlog", "a = v(logical([1 0 1 1]));", "MATLAB:badsubscript|The logical indices contain a true value outside of the array bounds."],
  ["vlog0", "a = v(logical([0 0 0 1]));", "MATLAB:badsubscript|The logical indices contain a true value outside of the array bounds."],
  ["mlog", "a = m(logical([1 0 0 0 1]));", "MATLAB:badsubscript|The logical indices contain a true value outside of the array bounds."],
  ["asg0", "v2 = v; v2(0) = 1;", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["asgnan", "v2 = v; v2(NaN) = 1;", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["asginf", "v2 = v; v2(Inf) = 1;", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["asgfrac", "v2 = v; v2(1.5) = 1;", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["asgm10", "m2 = m; m2(1,0) = 1;", "MATLAB:badsubscript|Index in position 2 is invalid. Array indices must be positive integers or logical values."],
  ["del0", "v2 = v; v2(0) = [];", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["delnan", "v2 = v; v2(NaN) = [];", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["c0", "c = {1,2}; a = c{0};", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["cnan", "c = {1,2}; a = c{NaN};", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["cp0", "c = {1,2}; a = c(0);", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["vbig2", "a = v([1 1e19]);", "MATLAB:badsubscript|Index exceeds the number of array elements. Index must not exceed 3."],
  ["mbig2", "a = m(1,[1 1e19]);", "MATLAB:badsubscript|Index in position 2 exceeds array bounds. Index must not exceed 2."],
];

test("every bad or out-of-range subscript raises MATLAB's identifier and message (39 rows recorded from MATLAB R2026b)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-index-errors-"));
  const lines = ROWS.map(([name, code]) =>
    `v = [1 2 3]; m = magic(2); try, ${code} fprintf('${name}|OK\\n'); catch err, fprintf('${name}|%s|%s\\n', err.identifier, err.message); end`);
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = r.stdout.trim().split("\n");
  assert.equal(got.length, ROWS.length, r.stdout);
  ROWS.forEach(([name, , want], i) => assert.equal(got[i], `${name}|${want}`, name));
});
