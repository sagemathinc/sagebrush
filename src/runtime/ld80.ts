// x87's 80-bit extended format, exactly, for R's summaries (Rill: sum, prod, cumsum, cumprod and mean, which R
// accumulates in a long double on x86-64; R 4.5.3 x86-64 Linux is the oracle, observed, never its source): a
// 64-bit significand, rounded to nearest even after each operation, gradual underflow to 2^-16445 and overflow
// at 2^16384, then each result rounded once to a double.  One implementation, in TypeScript, with exact BigInt
// arithmetic: the same bits on every host, nothing to load.
//
// The private builtin module `_ld80` takes one buffer, a list or tuple of floats, ints, bools or None, and
// returns its result with the index of the first missing value met, or -1.  A missing value is an element
// that is None or NaN, or a NaN made on the way (Inf - Inf, 0 * Inf), at the element that made it; from there
// the results are NaN.  R keeps the first missing value met, so the caller, which knows which of its elements
// were NA, decides between NA and NaN from that index.  No NaN payload travels through here.  Each pass
// over a buffer polls for Stop every 1024 elements (a KeyboardInterrupt).  Several
// arguments (R's sum(a, b)) are the caller's to combine, in double: each is one buffer.

import * as Obj from "./object";
import * as O from "./ops";
import { newBuiltinModule } from "./modules";

const BITS = 64;
// the exponent of the smallest subnormal's bit, and the power of two that overflows
const LOW_EXP = -16445;
const HIGH_EXP = 16384;
// the exponents of a double's smallest subnormal's bit, and of its overflow
const DBL_LOW = -1074;
const DBL_HIGH = 1024;

// A finite value is num * 2^exp, |num| < 2^64, with neg the sign of a zero; or an infinity (signed by neg);
// or NaN (a missing value).
export interface LD {
  kind: 0 | 1 | 2; // finite, infinite, NaN
  num: bigint;
  exp: number;
  neg: boolean;
}
const NAN: LD = { kind: 2, num: 0n, exp: 0, neg: false };
const inf = (neg: boolean): LD => ({ kind: 1, num: 0n, exp: 0, neg });
const zero = (neg: boolean): LD => ({ kind: 0, num: 0n, exp: 0, neg });
export const ZERO = zero(false);
export const ONE: LD = { kind: 0, num: 1n, exp: 0, neg: false };

const bitLength = (a: bigint): number => a.toString(2).length;

// num * 2^exp rounded to the format: ties to even, a signed zero below the smallest subnormal, an infinity
// at 2^HIGH_EXP; neg signs a zero num
function round(num: bigint, exp: number, neg = false): LD {
  if (num === 0n) return zero(neg);
  const negative = num < 0n;
  let a = negative ? -num : num;
  const len = bitLength(a);
  let quantum = Math.max(exp + len - BITS, LOW_EXP);
  if (quantum > exp) {
    const shift = quantum - exp;
    let q = a >> BigInt(shift);
    const rem = a - (q << BigInt(shift));
    const half = 1n << BigInt(shift - 1);
    if (rem > half || (rem === half && (q & 1n) === 1n)) {
      q += 1n;
      if (q >> BigInt(BITS) !== 0n) {
        q >>= 1n;
        quantum += 1;
      }
    }
    a = q;
    exp = quantum;
  }
  if (a === 0n) return zero(negative);
  if (bitLength(a) + exp > HIGH_EXP) return inf(negative);
  return { kind: 0, num: negative ? -a : a, exp, neg: negative };
}

const sign = (x: LD): boolean => (x.kind === 0 && x.num !== 0n ? x.num < 0n : x.neg);

export function add(x: LD, y: LD): LD {
  if (x.kind === 2) return x;
  if (y.kind === 2) return y;
  if (x.kind === 1 || y.kind === 1) {
    if (x.kind === 1 && y.kind === 1 && x.neg !== y.neg) return NAN;
    return x.kind === 1 ? x : y;
  }
  if (x.num === 0n && y.num === 0n) return zero(x.neg && y.neg);
  if (x.num === 0n) return y;
  if (y.num === 0n) return x;
  // (an addend more than 70 places below the other's lowest bit only rounds: any value of its sign below a
  // quarter of that bit rounds alike, so it stands in as one unit 70 places down, which keeps the shift short)
  let [hi, lo] = x.exp >= y.exp ? [x, y] : [y, x];
  if (hi.exp - (lo.exp + bitLength(lo.num < 0n ? -lo.num : lo.num)) > 70) lo = { kind: 0, num: lo.num < 0n ? -1n : 1n, exp: hi.exp - 70, neg: false };
  return round((hi.num << BigInt(hi.exp - lo.exp)) + lo.num, lo.exp);
}

export function mul(x: LD, y: LD): LD {
  if (x.kind === 2) return x;
  if (y.kind === 2) return y;
  const neg = sign(x) !== sign(y);
  if (x.kind === 1 || y.kind === 1) {
    if ((x.kind === 0 && x.num === 0n) || (y.kind === 0 && y.num === 0n)) return NAN;
    return inf(neg);
  }
  if (x.num === 0n || y.num === 0n) return zero(neg);
  return round(x.num * y.num, x.exp + y.exp);
}

export const negate = (x: LD): LD => (x.kind === 2 ? x : x.kind === 1 ? inf(!x.neg) : { kind: 0, num: -x.num, exp: x.exp, neg: !x.neg });

/** x / n, n a positive integer, rounded once. */
export function divInt(x: LD, n: number): LD {
  if (x.kind !== 0 || x.num === 0n) return x;
  const d = BigInt(n);
  const k = BITS + 2 + bitLength(d);
  const a = x.num < 0n ? -x.num : x.num;
  const q = (a << BigInt(k)) / d;
  const r = (a << BigInt(k)) - q * d;
  // (a sticky bit below the quotient's: an inexact quotient never looks like a tie)
  const m = (q << 1n) | (r !== 0n ? 1n : 0n);
  return round(x.num < 0n ? -m : m, x.exp - k - 1);
}

const view = new DataView(new ArrayBuffer(8));

/** A double, exactly. */
export function fromDouble(v: number): LD {
  if (v !== v) return NAN;
  if (v === Infinity || v === -Infinity) return inf(v < 0);
  if (v === 0) return zero(Object.is(v, -0));
  view.setFloat64(0, v);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e !== 0) m |= 1n << 52n;
  const exp = (e === 0 ? 1 : e) - 1075;
  return { kind: 0, num: v < 0 ? -m : m, exp, neg: v < 0 };
}

/** The nearest double: ties to even, gradual underflow, an infinity past the largest double. */
export function toDouble(x: LD): number {
  if (x.kind === 2) return NaN;
  if (x.kind === 1) return x.neg ? -Infinity : Infinity;
  if (x.num === 0n) return x.neg ? -0 : 0;
  const negative = x.num < 0n;
  let a = negative ? -x.num : x.num;
  let exp = x.exp;
  const quantum = Math.max(exp + bitLength(a) - 53, DBL_LOW);
  if (quantum > exp) {
    const shift = BigInt(quantum - exp);
    let q = a >> shift;
    const rem = a - (q << shift);
    const half = 1n << (shift - 1n);
    if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
    a = q;
    exp = quantum;
  }
  if (a === 0n) return negative ? -0 : 0;
  if (bitLength(a) + exp > DBL_HIGH) return negative ? -Infinity : Infinity;
  // (a < 2^54 and exp >= -1074: both factors and their product are exact; 2^54 * 2^970 is the one product
  // past the largest power of two, so the larger exponents take two steps)
  let r = Number(a);
  if (exp > 900) r *= 2 ** 900, exp -= 900;
  r *= 2 ** exp;
  return negative ? -r : r;
}

// ------------------------------------------------------------------ R's summaries over one buffer

// one element's value, NaN for None (the caller's NA)
function element(e: any): number {
  if (e === null) return NaN;
  const v = O.fv(e);
  if (v === undefined) Obj.raise(Obj.T.TypeError, `_ld80 takes floats, ints, bools or None, not ${Obj.typeName(e)}`);
  return v;
}

function buffer(xs: any): any[] {
  if (!Array.isArray(xs)) Obj.raise(Obj.T.TypeError, `_ld80 takes a list or a tuple, not ${Obj.typeName(xs)}`);
  return xs;
}

/** A sum or product's running values; at is the first missing value's index, or -1. */
function fold(xs: any[], start: LD, op: (a: LD, b: LD) => LD, each: ((v: number) => void) | null): { v: LD; at: number } {
  let acc = start, at = -1;
  for (let i = 0; i < xs.length; i++) {
    if ((i & 1023) === 1023) O.pollInterrupt();
    acc = op(acc, fromDouble(element(xs[i])));
    if (at < 0 && acc.kind === 2) at = i;
    if (each !== null) each(toDouble(acc));
  }
  return { v: acc, at };
}

export function sum(xs: any[]): [number, number] {
  const r = fold(xs, ZERO, add, null);
  return [toDouble(r.v), r.at];
}

export function prod(xs: any[]): [number, number] {
  const r = fold(xs, ONE, mul, null);
  return [toDouble(r.v), r.at];
}

export function cumulative(xs: any[], op: "sum" | "prod"): [number[], number] {
  const out: number[] = [];
  const r = fold(xs, op === "sum" ? ZERO : ONE, op === "sum" ? add : mul, (v) => out.push(v));
  return [out, r.at];
}

/** R's mean: the sum divided by n, then corrected by the mean of the residuals, both in the extended format,
 * rounded once (an infinite or NaN first mean is the result; no elements, NaN). */
export function mean(xs: any[]): [number, number] {
  const n = xs.length;
  if (n === 0) return [NaN, -1];
  const first = fold(xs, ZERO, add, null);
  const s = divInt(first.v, n);
  if (s.kind !== 0) return [toDouble(s), first.at];
  const ms = negate(s);
  let t = ZERO;
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 1023) O.pollInterrupt();
    t = add(t, add(fromDouble(element(xs[i])), ms));
  }
  return [toDouble(add(s, divInt(t, n))), -1];
}

newBuiltinModule("_ld80", (m) => {
  const pair = (v: number, at: number) => Obj.tuple([O.fbox(v), at]);
  const list = (vs: number[], at: number) => Obj.tuple([vs.map(O.fbox), at]);
  m.sum = Obj.builtin((xs: any) => pair(...sum(buffer(xs))), "sum");
  m.prod = Obj.builtin((xs: any) => pair(...prod(buffer(xs))), "prod");
  m.mean = Obj.builtin((xs: any) => pair(...mean(buffer(xs))), "mean");
  m.cumsum = Obj.builtin((xs: any) => list(...cumulative(buffer(xs), "sum")), "cumsum");
  m.cumprod = Obj.builtin((xs: any) => list(...cumulative(buffer(xs), "prod")), "cumprod");
});
