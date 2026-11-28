import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as LD from "../src/runtime/ld80";

// src/runtime/ld80.ts, x87's 80-bit format for R's summaries, against R 4.5.3 x86-64 Linux itself:
// test/ld80-oracle.json is R's sum, prod, mean, cumsum and cumprod of 160 vectors (test/ld80_oracle.R wrote
// it), every value a hex float, compared bit for bit.  Where R's result is NA or NaN, the kernel's is NaN with
// the index of the first missing value it met, and the caller's rule (the element there was NA: NA; else NaN)
// must give R's label (for mean: NA if any element is NA, else NaN, as #2321's Rill does).
const root = join(__dirname, "..", "..");
const CLI = join(__dirname, "../src/cli.js");

// a C99 hex float as R's sprintf("%a") writes it, "NA" (null) or "NaN"; exact (at most 53 bits)
function hex(s: string): number | null {
  if (s === "NA") return null;
  if (s === "NaN") return NaN;
  if (s === "Inf" || s === "-Inf") return s[0] === "-" ? -Infinity : Infinity;
  const m = /^(-?)0x([0-9a-f]+)(?:\.([0-9a-f]*))?p([+-]\d+)$/.exec(s);
  assert.ok(m, `not a hex float: ${s}`);
  const frac = m[3] ?? "";
  let v = Number(BigInt("0x" + m[2] + frac));
  let e = Number(m[4]) - 4 * frac.length;
  // (two steps where 2^e alone would underflow or overflow)
  if (e < -1000) v *= 2 ** -1000, e += 1000;
  if (e > 1000) v *= 2 ** 1000, e -= 1000;
  v *= 2 ** e;
  return m[1] ? -v : v;
}

const label = (x: (number | null)[], at: number) => (x[at] === null ? "NA" : "NaN");

function same(got: number, at: number, want: string, x: (number | null)[], what: string, anyNA = false) {
  const w = hex(want);
  if (w === null || Number.isNaN(w)) {
    assert.ok(Number.isNaN(got) && at >= 0, `${what}: R gives ${want}, the kernel ${got} (at ${at})`);
    // (mean is NA for an NA anywhere, R's mean.default; the others keep the first missing value met)
    assert.equal(anyNA ? (x.includes(null) ? "NA" : "NaN") : label(x, at), want, `${what}: R gives ${want}; the first missing value met is at ${at}`);
  } else {
    assert.ok(Object.is(got, w), `${what}: R gives ${want} = ${w}, the kernel ${got}`);
    assert.equal(at, -1, `${what}: no missing value`);
  }
}

test("ld80 gives R's sum, prod, mean, cumsum and cumprod, bit for bit, on R's own rows", () => {
  const rows = JSON.parse(readFileSync(join(root, "test/ld80-oracle.json"), "utf8"));
  assert.equal(rows.length, 160);
  for (const [i, r] of rows.entries()) {
    const x = r.x.map(hex);
    const what = (f: string) => `${f}(c(${r.x.join(", ")})) (row ${i})`;
    same(...LD.sum(x), r.sum, x, what("sum"));
    same(...LD.prod(x), r.prod, x, what("prod"));
    same(...LD.mean(x), r.mean, x, what("mean"), true);
    for (const op of ["sum", "prod"] as const) {
      const [vs, at] = LD.cumulative(x, op);
      const want: string[] = op === "sum" ? r.cumsum : r.cumprod;
      assert.equal(vs.length, want.length);
      vs.forEach((v, k) => {
        if (at >= 0 && k >= at) {
          assert.ok(Number.isNaN(v), `${what("cum" + op)}[${k}]: NaN after the first missing value`);
          // (R's label at the first missing value is the caller's to give; after it, R keeps a missing value)
          if (k === at) assert.equal(label(x, at), want[k], `${what("cum" + op)}[${k}]`);
          else assert.ok(want[k] === "NA" || want[k] === "NaN", `${what("cum" + op)}[${k}]: R gives ${want[k]}`);
        } else same(v, -1, want[k], x, `${what("cum" + op)}[${k}]`);
      });
    }
  }
});

test("ld80: the cases R's help and #2321 name", () => {
  // one buffer is one extended sum: sum(c(0.1, 0.2, 0.3)) is 0.6 (several arguments are the caller's, in double)
  assert.equal(LD.sum([0.1, 0.2, 0.3])[0], 0.6);
  assert.notEqual(0.1 + 0.2 + 0.3, 0.6);
  // the 15-bit exponent: past the largest double and back, in either order of the extended range's ends
  assert.equal(LD.sum([1e308, 1e308, -1e308])[0], 1e308);
  assert.equal(LD.sum([1.7976931348623157e308, 1.7976931348623157e308, -1.7976931348623157e308])[0], 1.7976931348623157e308);
  assert.equal(LD.prod([...Array(17).fill(1e300), ...Array(17).fill(1e-300)])[0], Infinity);
  assert.equal(LD.prod([...Array(17).fill(1e-300), ...Array(17).fill(1e300)])[0], 0);
  // (R 4.5.3's values) 16 of each end: 1 + 6 ulp, the rounding of 32 extended products
  assert.equal(LD.prod([...Array(16).fill(1e300), ...Array(16).fill(1e-300)])[0], 1 + 6 * 2 ** -52);
  // gradual underflow below 2^-16382: 2^-16445 survives; half of it is a tie, to an even zero; three quarters
  // of it round up to it, and three halves of it to two of it (then 2^(1023 * 17) brings each back)
  const d = Array(16).fill(2 ** -1022), u = Array(17).fill(2 ** 1023);
  assert.equal(LD.prod([...d, 2 ** -93, ...u])[0], 2 ** 946);
  assert.equal(LD.prod([...d, 2 ** -94, ...u])[0], 0);
  assert.equal(LD.prod([...d, 2 ** -93, 0.75, ...u])[0], 2 ** 946);
  assert.equal(LD.prod([...d, 2 ** -93, 1.5, ...u])[0], 2 ** 947);
  assert.equal(LD.prod([...d, 2 ** -94, 1.5, ...u])[0], 0);
  // overflow at 2^16384 exactly: 2^16383 and just under 2^16384 survive (R 4.5.3)
  const big = Array(16).fill(2 ** 1023), down = Array(16).fill(2 ** -1000);
  assert.equal(LD.prod([...big, 2 ** 15, ...down])[0], 2 ** 383);
  assert.equal(LD.prod([...big, 2 ** 15 * (2 - 2 ** -52), ...down])[0], (2 - 2 ** -52) * 2 ** 383);
  assert.equal(LD.prod([...big, 2 ** 16, ...down])[0], Infinity);
  // the double's rounding is ties to even: 1 + 2^-53 (a tie) is 1, 1 + 3 * 2^-53 is 1 + 2^-51
  assert.equal(LD.sum([1, 2 ** -53])[0], 1);
  assert.equal(LD.sum([1, 3 * 2 ** -53])[0], 1 + 2 ** -51);
  // the mean's residual pass: mean(c(1e20, 1, -1e20)) is 0, and mean(c(1, 2^-60, -1)) is 2^-60 / 3 rounded
  assert.equal(LD.mean([1e20, 1, -1e20])[0], 0);
  assert.equal(LD.mean([1, 2 ** -60, -1])[0], 0x15555555555555 * 2 ** -114);
  assert.deepEqual(LD.cumulative([1, 2 ** -60, -1], "sum"), [[1, 1, 2 ** -60], -1]);
  // (R: the last is 1e300 and one ulp, 0x1.7e43c8800759dp+996: 1e300^2 is rounded to 64 bits before the third factor)
  assert.deepEqual(LD.cumulative([1e300, 1e300, 1e-300], "prod"), [[1e300, Infinity, 1.0000000000000002e300], -1]);
  // a NaN made on the way is at the element that made it; a NaN met first stays first
  assert.deepEqual(LD.sum([1, Infinity, -Infinity, null]), [NaN, 2]);
  assert.deepEqual(LD.prod([0, null, Infinity]), [NaN, 1]);
  assert.deepEqual(LD.mean([]), [NaN, -1]);
  // signed zeros: R's sum starts at +0 and its product at 1
  assert.ok(Object.is(LD.sum([-0, -0])[0], 0));
  assert.ok(Object.is(LD.prod([-0, 2])[0], -0));
});

test("ld80 from Python: the private module _ld80", () => {
  const src = [
    "import _ld80",
    "print(_ld80.sum([0.1, 0.2, 0.3]), _ld80.sum((1e308, 1e308, -1e308)), _ld80.prod([True, 3, 2.5]))",
    "print(_ld80.mean([1e20, 1, -1e20]), _ld80.cumsum([1.0, 2.0**-60, -1.0]), _ld80.cumprod([1e300, 1e300, 1e-300]))",
    "print(_ld80.sum([1.0, None, float('nan')]), _ld80.mean([None]))",
    "for bad in ('ab', [1, 'x'], 5):",
    "    try: _ld80.sum(bad)",
    "    except TypeError as e: print('TypeError', e)",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", src], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    "(0.6, -1) (1e+308, -1) (7.5, -1)\n" +
      "(0.0, -1) ([1.0, 1.0, 8.673617379884035e-19], -1) ([1e+300, inf, 1.0000000000000002e+300], -1)\n" +
      "(nan, 1) (nan, 0)\n" +
      "TypeError _ld80 takes a list or a tuple, not str\n" +
      "TypeError _ld80 takes floats, ints, bools or None, not str\n" +
      "TypeError _ld80 takes a list or a tuple, not int\n",
  );
});
