import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Indexing errors as MATLAB raises them: every bad or out-of-range subscript is MATLAB:badsubscript; a bad linear
// index says only "Array indices must be positive integers or logical values.", a bad subscript among several names
// its position, and a logical index past the end has its own message; an assignment or deletion at an index of 2^48
// or more says "Indices must be less than 2^48." (a read there is out of range). Each row's identifier and message were
// recorded from MATLAB R2026b (v = [1 2 3], m = magic(2)); NaN and Inf subscripts used to leak a Python error. In a
// mixed subscript the first offending element, left to right, decides which message (Inf is invalid, not too big);
// on a read, an element of 2^48 or more is out of range. A deletion past the end is MATLAB:subsdeldimmismatch, and an
// array of 2^48 bytes or more (growth, zeros/ones, rand/randn/randi, eye, blanks, repmat) MATLAB:pmaxsize, refused before
// anything is allocated; a cell grown that far is out of memory (MATLAB:nomem) instead.

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
  ["gv", "v([1 1e19]) = 5;", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["gs", "v(1e19) = 5;", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["gm", "m(1,[1 1e19]) = 5;", "MATLAB:badsubscript|Index in position 2 is invalid. Indices must be less than 2^48."],
  ["gms", "m(1e19,1) = 5;", "MATLAB:badsubscript|Index in position 1 is invalid. Indices must be less than 2^48."],
  ["dv", "v([1 1e19]) = [];", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["vz2", "v([1e19 0]) = 1;", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["vn2", "v([1e19 NaN]) = 1;", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["vinf", "v([1e19 Inf]) = 1;", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["d3", "v([0 1e19]) = [];", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["d5", "v([1.5 1e19]) = [];", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["di1", "v([Inf 2^48]) = [];", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["di2", "v([2^48 Inf]) = [];", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["di3", "v(Inf) = [];", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["di4", "v([2^48 1.5]) = [];", "MATLAB:badsubscript|One or more indices are invalid. Indices must be less than 2^48."],
  ["ai1", "v([Inf 2^48]) = 1;", "MATLAB:badsubscript|Array indices must be positive integers or logical values."],
  ["dm4", "m([0 2^48],:) = [];", "MATLAB:badsubscript|Index in position 1 is invalid. Array indices must be positive integers or logical values."],
  ["ai32", "v(int32(5)) = 9;", "OK"],
  ["au8", "v(uint8([1 4])) = 9;", "OK"],
  ["mi32", "m(int32(1),int32(3)) = 7;", "OK"],
  ["mu8", "m(uint8(3),uint8(1)) = 7;", "OK"],
  ["rd1", "a = v([1e19 0]);", "MATLAB:badsubscript|Index exceeds the number of array elements. Index must not exceed 3."],
  ["d2", "v(2^48-1) = [];", "MATLAB:subsdeldimmismatch|Matrix index is out of range for deletion."],
  ["dm3", "m(2^48-1,:) = [];", "MATLAB:subsdeldimmismatch|Matrix index is out of range for deletion."],
  ["di5", "v(4) = [];", "MATLAB:subsdeldimmismatch|Matrix index is out of range for deletion."],
  ["b1", "v(2^48-1) = 1;", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["vv1", "v([1 2^48-1]) = 1;", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["i64m", "v(int64(2^48)-1) = 1;", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["mbig", "m(2^47,2^47) = 1;", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["z45", "z = zeros(2^45,1);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["o2", "x = ones(2^24,2^24);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["cat", "a = zeros(2^20,1); b = repmat(a, 2^25, 1);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["cs", "x = 1i; x(2^44) = 1;", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["rc47", "x = repmat('a', 2^47, 1);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["rcx", "x = repmat(1i, 2^44, 1);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["rn", "x = rand(2^24, 2^21);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["rnn", "x = randn(2^45, 1);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["rni", "x = randi(5, 2^45, 1);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["rns", "x = rand(2^46, 1, 'single');", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["ey", "x = eye(2^23, 2^22);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["bl", "x = blanks(2^47);", "MATLAB:pmaxsize|Requested array exceeds the maximum possible variable size."],
  ["ce", "x = {1}; x{2^45} = 1;", "MATLAB:nomem|Out of memory."],
  ["ce48", "x = {1}; x{2^48-1} = 1;", "MATLAB:nomem|Out of memory."],
];

test("every bad or out-of-range subscript raises MATLAB's identifier and message (81 rows: MATLAB R2026b's errors, and integer-class assignments MATLAB accepts)", () => {
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

test("below 2^48 bytes in MATLAB's storage, no pmaxsize: a char counts 2 bytes, and growth is sized by the array's class", () => {
  // (MATLAB R2026b gives its machine-specific array-size preference error for these, which names the machine's setting;
  // Sagebrush leaves them to its own bounds, so only the identifier pmaxsize is ruled out)
  const dir = mkdtempSync(join(tmpdir(), "sb-index-errors-"));
  const cases = ["x = repmat('a', 2^45, 1);", "x = repmat('a', 2^47-1, 1);", "x = [1 2]; x(2^44) = 1i;", "x = single(1); x(2^45) = 1i;"];
  writeFileSync(join(dir, "main.m"), cases.map((c, i) =>
    `try, ${c} fprintf('${i}|OK\\n'); catch err, fprintf('${i}|%s\\n', err.identifier); end`).join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = r.stdout.trim().split("\n");
  assert.equal(got.length, cases.length, r.stdout);
  got.forEach((line, i) => assert.notEqual(line, `${i}|MATLAB:pmaxsize`, cases[i]));
});

test("repmat's own size refusals carry MATLAB's size-preference identifier", () => {
  // (MATLAB R2026b refuses these with MATLAB:array:SizeLimitExceeded, naming the machine's preference; Sagebrush's
  // repmat refuses them below the memory guard with its own message and the same identifier)
  const dir = mkdtempSync(join(tmpdir(), "sb-index-errors-"));
  const cases = ["x = repmat('a', 2^45, 1);", "x = repmat('a', 2^47-1, 1);", "x = repmat({1}, 2^45, 1);", "x = repmat(1i, 2^44-1, 1);"];
  writeFileSync(join(dir, "main.m"), cases.map((c, i) =>
    `try, ${c} fprintf('${i}|OK\\n'); catch err, fprintf('${i}|%s\\n', err.identifier); end`).join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), cases.map((_, i) => `${i}|MATLAB:array:SizeLimitExceeded`));
});

test("huge cell arrays are refused before they are made, never a crash (#1783)", () => {
  // (MATLAB R2026b: cell(2^45,1) is pmaxsize, 2^48 bytes at 8 per element; x{2^44} = 1 is out of memory. Below
  // 2^48 bytes Sagebrush admits a cell array against this host's memory, so the refusal is its memory guard's,
  // MATLAB:nomem, with its own message; small ones are made as before)
  const dir = mkdtempSync(join(tmpdir(), "sb-index-errors-"));
  const cases = ["x = cell(2^45, 1);", "x = {1}; x{2^44} = 1;", "x = cell(2^44, 1);", "x = cell(2^20, 2^20);",
    "x = {1}; x{2^30} = 1;", "x = cell(1, 3); x{10} = 1; disp(numel(x));"];
  writeFileSync(join(dir, "main.m"), cases.map((c, i) =>
    `try, ${c} fprintf('${i}|OK\\n'); catch err, fprintf('${i}|%s\\n', err.identifier); end`).join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").map((s) => s.trim()),
    ["0|MATLAB:pmaxsize", "1|MATLAB:nomem", "2|MATLAB:nomem", "3|MATLAB:nomem", "4|MATLAB:nomem", "10", "5|OK"]);
});
