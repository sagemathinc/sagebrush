import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB R2026b's two tiers for a request that makes or grows an array (#1842): at 2^48 bytes or more
// MATLAB:pmaxsize; at its default 5 GB array-size preference or more MATLAB:array:SizeLimitExceeded, naming the size
// (a linear index's growth as N-by-1) and its gigabytes (2^30 bytes, one decimal). Bytes are MATLAB's: the array's
// class before any conversion (a double grown with a complex value counts 8 per element), 1 for logical and int8, 2
// for char, 8 per cell of cell(...). Every row below was printed by MATLAB R2026b for the same statement.

const cli = join(__dirname, "..", "src", "cli.js");

const PROGRAM = [
  "v = [1 2 3]; m = magic(2); try, v(2^40) = 1; fprintf('e40|OK\\n'); catch err, fprintf('e40|%s|%s\\n', err.identifier, err.message); end",
  "v = [1 2 3]; m = magic(2); try, v(2^44) = 1; fprintf('e44|OK\\n'); catch err, fprintf('e44|%s|%s\\n', err.identifier, err.message); end",
  "v = [1 2 3]; m = magic(2); try, v8 = int8([1 2 3]); v8(2^45) = 1; fprintf('s8e45|OK\\n'); catch err, fprintf('s8e45|%s|%s\\n', err.identifier, err.message); end",
  "v = [1 2 3]; m = magic(2); try, v8 = int8([1 2 3]); v8(2^47) = 1; fprintf('s8e47|OK\\n'); catch err, fprintf('s8e47|%s|%s\\n', err.identifier, err.message); end",
  "try, x = 5; x(2^44) = 1i; disp('s1|OK'); catch err, fprintf('s1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = true; x(2^47) = 1; disp('s4|OK'); catch err, fprintf('s4|%s|%s\\n', err.identifier, err.message); end",
  "try, x = true; x(2^48-1) = 1; disp('s5|OK'); catch err, fprintf('s5|%s|%s\\n', err.identifier, err.message); end",
  "try, x = int8(5); x(2^47) = 1.5; disp('s6|OK'); catch err, fprintf('s6|%s|%s\\n', err.identifier, err.message); end",
  "try, x = 'ab'; x(2^47-1) = 'c'; disp('chm|OK'); catch err, fprintf('chm|%s|%s\\n', err.identifier, err.message); end",
  "try, x = [1 2]; x(2^44) = 1i; disp('dc|OK'); catch err, fprintf('dc|%s|%s\\n', err.identifier, err.message); end",
  "try, x = single(1); x(2^45) = 1i; disp('sc|OK'); catch err, fprintf('sc|%s|%s\\n', err.identifier, err.message); end",
  "try, x = zeros(2^45, 1, 'single'); disp('zs|OK'); catch err, fprintf('zs|%s|%s\\n', err.identifier, err.message); end",
  "try, x = [1 2 3]; x(2^45-1) = 1; fprintf('d45m1|OK\\n'); catch err, fprintf('d45m1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = int8([1 2 3]); x(2^48-1) = 1; fprintf('i8_48m1|OK\\n'); catch err, fprintf('i8_48m1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = int8([1 2 3]); x(2^47+1) = 1; fprintf('i8_47p1|OK\\n'); catch err, fprintf('i8_47p1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = int16([1 2 3]); x(2^47-1) = 1; fprintf('i16_47m1|OK\\n'); catch err, fprintf('i16_47m1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = single([1 2 3]); x(2^46-1) = 1; fprintf('s_46m1|OK\\n'); catch err, fprintf('s_46m1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = [1i 2 3]; x(2^44-1) = 1; fprintf('c_44m1|OK\\n'); catch err, fprintf('c_44m1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = true(1,3); x(2^48-1) = true; fprintf('L_48m1|OK\\n'); catch err, fprintf('L_48m1|%s|%s\\n', err.identifier, err.message); end",
  "try, z = zeros(2^24, 2^21-1); fprintf('z_m|OK\\n'); catch err, fprintf('z_m|%s|%s\\n', err.identifier, err.message); end",
  "try, m = magic(2); m(2^23, 2^22-1) = 1; fprintf('mxm|OK\\n'); catch err, fprintf('mxm|%s|%s\\n', err.identifier, err.message); end",
  "try, z = zeros(1e5, 1e5); fprintf('pre|OK\\n'); catch err, fprintf('pre|%s|%s\\n', err.identifier, err.message); end",
  "try, x = cell(2^45-1,1); fprintf('r1|OK\\n'); clear x; catch err, fprintf('r1|%s|%s\\n', err.identifier, err.message); end",
  "try, x = cell(2^15,2^15,2^15-1); fprintf('r5|OK\\n'); clear x; catch err, fprintf('r5|%s|%s\\n', err.identifier, err.message); end",
  "try, x = cell(2^44,1); fprintf('r6|OK\\n'); clear x; catch err, fprintf('r6|%s|%s\\n', err.identifier, err.message); end"
];
const WANT = [
  "e40|MATLAB:array:SizeLimitExceeded|Requested 1099511627776x1 (8192.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "e44|MATLAB:array:SizeLimitExceeded|Requested 17592186044416x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s8e45|MATLAB:array:SizeLimitExceeded|Requested 35184372088832x1 (32768.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s8e47|MATLAB:array:SizeLimitExceeded|Requested 140737488355328x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s1|MATLAB:array:SizeLimitExceeded|Requested 17592186044416x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s4|MATLAB:array:SizeLimitExceeded|Requested 140737488355328x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s5|MATLAB:array:SizeLimitExceeded|Requested 281474976710655x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s6|MATLAB:array:SizeLimitExceeded|Requested 140737488355328x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "chm|MATLAB:array:SizeLimitExceeded|Requested 140737488355327x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "dc|MATLAB:array:SizeLimitExceeded|Requested 17592186044416x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "sc|MATLAB:array:SizeLimitExceeded|Requested 35184372088832x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "zs|MATLAB:array:SizeLimitExceeded|Requested 35184372088832x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "d45m1|MATLAB:array:SizeLimitExceeded|Requested 35184372088831x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "i8_48m1|MATLAB:array:SizeLimitExceeded|Requested 281474976710655x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "i8_47p1|MATLAB:array:SizeLimitExceeded|Requested 140737488355329x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "i16_47m1|MATLAB:array:SizeLimitExceeded|Requested 140737488355327x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "s_46m1|MATLAB:array:SizeLimitExceeded|Requested 70368744177663x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "c_44m1|MATLAB:array:SizeLimitExceeded|Requested 17592186044415x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "L_48m1|MATLAB:array:SizeLimitExceeded|Requested 281474976710655x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "z_m|MATLAB:array:SizeLimitExceeded|Requested 16777216x2097151 (262143.9GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "mxm|MATLAB:array:SizeLimitExceeded|Requested 8388608x4194303 (262143.9GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "pre|MATLAB:array:SizeLimitExceeded|Requested 100000x100000 (74.5GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "r1|MATLAB:array:SizeLimitExceeded|Requested 35184372088831x1 (262144.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "r5|MATLAB:array:SizeLimitExceeded|Requested 32768x32768x32767 (262136.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive.",
  "r6|MATLAB:array:SizeLimitExceeded|Requested 17592186044416x1 (131072.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to become unresponsive."
];

test("arrays requested above MATLAB's 5 GB preference: MATLAB R2026b's identifier and message, for constructors and growth", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-size-pref-"));
  writeFileSync(join(dir, "main.m"), PROGRAM.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), WANT);
});

test("below the preference nothing changes: a cell grown that far is out of memory, and a small array is made", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-size-pref-"));
  const cases = ["x = {1}; x{2^45-1} = 1;", "x = zeros(2^20, 1); disp(numel(x));", "x = [1 2]; x(1000) = 3; disp(numel(x));"];
  writeFileSync(join(dir, "main.m"), cases.map((c, i) =>
    `try, ${c} fprintf('${i}|OK\\n'); catch err, fprintf('${i}|%s\\n', err.identifier); end`).join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").map((s) => s.trim()), ["0|MATLAB:nomem", "1048576", "1|OK", "1000", "2|OK"]);
});
