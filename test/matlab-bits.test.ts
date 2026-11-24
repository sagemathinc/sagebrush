import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// bitget, bitset and bitcmp: the pages' examples, two's complement for signed classes, doubles read as 'uint64' or an
// assumed class, classes, sizes, empties, and the refusals. MATLAB's own outputs for the cases the pages leave open
// aren't recorded yet (the oracle job is queued).

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-bits-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const id = line.split("|")[0];
    if (line.includes("|") && !got.has(id)) got.set(id, line);
  }
  return got;
}

const field = (got: Map<string, string>, id: string) => {
  const line = got.get(id);
  assert.ok(line, id + ": no row");
  return line.split("|").slice(1);
};
const S = (name: string, expr: string) => `x = ${expr}; fprintf('${name}|%s|%s|%s\\n', class(x), mat2str(size(x)), strtrim(sprintf('%.17g ', double(x))));`;

test("bitget, bitset, bitcmp: the pages' examples, two's complement, doubles and classes", () => {
  const got = run([
    S("g_int8max", "bitget(intmax('int8'), 8:-1:1)"),
    S("g_uint8max", "bitget(intmax('uint8'), 8:-1:1)"),
    S("g_neg", "bitget(-29, 8:-1:1, 'int8')"),
    S("g_dbl", "bitget(5, 1:4)"),
    S("g_top", "bitget(2^63, 64)"),
    S("g_mat", "bitget([1 2; 3 4], 1)"),
    S("g_bits", "bitget(7, [1 2; 3 4])"),
    S("g_int16neg", "bitget(int16(-1), [1 16])"),
    S("s_page", "bitset(4, 4:6)"),
    S("s_int8", "bitset(75, 5, 'int8')"),
    S("s_val", "bitset(0, 2:6, [1 0 0 1 1], 'int8')"),
    S("s_clear", "bitset(uint8(255), 8, 0)"),
    S("s_negclear", "bitset(int8(-1), 8, 0)"),
    S("s_negset", "bitset(int8(5), 8)"),
    S("s_top", "bitset(0, 64)"),
    S("s_valnz", "bitset(0, 1, 7)"),
    S("s_logical", "bitset(0, 1, true)"),
    S("s_dblneg", "bitset(-1, 8, 0, 'int8')"),
    S("c_page", "bitcmp(int8(-11))"),
    S("c_uint8", "bitcmp(64, 'uint8')"),
    S("c_uint16", "bitcmp(uint16([0 1 65535]))"),
    S("c_int32", "bitcmp(int32([0 -1 2147483647]))"),
    S("c_dblint8", "bitcmp(-5, 'int8')"),
    S("c_dbl", "bitcmp(0)"),
    S("e_get", "bitget(zeros(0, 3), 1)"),
    S("e_cmp", "bitcmp(zeros(0, 3))"),
  ]);
  // (the pages' examples)
  assert.deepEqual(field(got, "g_int8max"), ["int8", "[1 8]", "0 1 1 1 1 1 1 1"]);
  assert.deepEqual(field(got, "g_uint8max"), ["uint8", "[1 8]", "1 1 1 1 1 1 1 1"]);
  assert.deepEqual(field(got, "g_neg"), ["double", "[1 8]", "1 1 1 0 0 0 1 1"]);
  assert.deepEqual(field(got, "s_page"), ["double", "[1 3]", "12 20 36"]);
  assert.deepEqual(field(got, "s_int8"), ["double", "[1 1]", "91"]);
  assert.deepEqual(field(got, "s_val"), ["double", "[1 5]", "2 0 0 16 32"]);
  assert.deepEqual(field(got, "c_page"), ["int8", "[1 1]", "10"]);
  assert.deepEqual(field(got, "c_uint8"), ["double", "[1 1]", "191"]);
  // (5 is 101; 2^63 has bit 64 set in 'uint64'; elementwise and with a matrix of positions, 7 is 111)
  assert.deepEqual(field(got, "g_dbl"), ["double", "[1 4]", "1 0 1 0"]);
  assert.deepEqual(field(got, "g_top"), ["double", "[1 1]", "1"]);
  assert.deepEqual(field(got, "g_mat"), ["double", "[2 2]", "1 1 0 0"]);
  assert.deepEqual(field(got, "g_bits"), ["double", "[2 2]", "1 1 1 0"]);
  // (two's complement: -1 has every bit set; clearing int8(-1)'s top bit gives 127, setting int8(5)'s gives -123)
  assert.deepEqual(field(got, "g_int16neg"), ["int16", "[1 2]", "1 1"]);
  assert.deepEqual(field(got, "s_clear"), ["uint8", "[1 1]", "127"]);
  assert.deepEqual(field(got, "s_negclear"), ["int8", "[1 1]", "127"]);
  assert.deepEqual(field(got, "s_negset"), ["int8", "[1 1]", "-123"]);
  assert.deepEqual(field(got, "s_top"), ["double", "[1 1]", "9.2233720368547758e+18"]);
  assert.deepEqual(field(got, "s_valnz"), ["double", "[1 1]", "1"]);
  assert.deepEqual(field(got, "s_logical"), ["double", "[1 1]", "1"]);
  assert.deepEqual(field(got, "s_dblneg"), ["double", "[1 1]", "127"]);
  // (an unsigned value's complement is the maximum less it; a signed one's -A - 1)
  assert.deepEqual(field(got, "c_uint16"), ["uint16", "[1 3]", "65535 65534 0"]);
  assert.deepEqual(field(got, "c_int32"), ["int32", "[1 3]", "-1 0 -2147483648"]);
  assert.deepEqual(field(got, "c_dblint8"), ["double", "[1 1]", "4"]);
  // (2^64 - 1 as a double, read as 'uint64': the nearest double, 2^64)
  assert.deepEqual(field(got, "c_dbl"), ["double", "[1 1]", "1.8446744073709552e+19"]);
  assert.deepEqual(field(got, "e_get"), ["double", "[0 3]", ""]);
  assert.deepEqual(field(got, "e_cmp"), ["double", "[0 3]", ""]);
});

test("bitget, bitset, bitcmp: refusals", () => {
  const T = (name: string, expr: string) => `try, ${expr}, catch e, fprintf('${name}|%s\\n', e.message), end`;
  const got = run([
    T("bit0", "bitget(5, 0)"),
    T("bit65", "bitget(5, 65)"),
    T("bit9", "bitget(uint8(5), 9)"),
    T("bitfrac", "bitget(5, 1.5)"),
    T("negdbl", "bitget(-1, 1)"),
    T("frac", "bitget(1.5, 1)"),
    T("nan", "bitget(NaN, 1)"),
    T("range", "bitset(300, 5, 'int8')"),
    T("mismatch", "bitget(int8(5), 1, 'uint8')"),
    T("logical", "bitget(true, 1)"),
    T("single", "bitcmp(single(5))"),
    T("badtype", "bitget(5, 1, 'double')"),
    T("sizes", "bitget([1 2 3], [1 2])"),
    T("setsizes", "bitset([0 0 0], 1, [1 0])"),
    T("cmpneg", "bitcmp(-1)"),
  ]);
  for (const id of ["bit0", "bit65", "bitfrac"]) assert.match(field(got, id)[0], /bit position must be an integer from 1 to 64/, id);
  assert.match(field(got, "bit9")[0], /from 1 to 8/);
  for (const id of ["negdbl", "frac", "nan", "cmpneg"]) assert.match(field(got, id)[0], /integer values in the range of 'uint64'/, id);
  assert.match(field(got, "range")[0], /range of 'int8', -128 to 127/);
  assert.match(field(got, "mismatch")[0], /assumedtype must be its own class, 'int8'/);
  assert.match(field(got, "logical")[0], /integer or double array, not logical/);
  assert.match(field(got, "single")[0], /integer or double array, not single/);
  assert.match(field(got, "badtype")[0], /assumedtype must be 'uint8'/);
  assert.match(field(got, "sizes")[0], /same size, or scalars/);
  assert.match(field(got, "setsizes")[0], /same size, or scalars/);
});

test("bitget, bitset and bitcmp admitted before their work (test/matlab_bits_admit_cases.py)", () => {
  const r = spawnSync(process.execPath, [cli, join(__dirname, "..", "..", "test", "matlab_bits_admit_cases.py")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 1, r.stdout);
});
