// Correctly rounded elementary functions: the double nearest the exact value.
//
// fdlibm's and musl's sin, asin, atan, atan2, asinh, acosh, atanh, log2 and
// V8's hypot (fdlibm.ts) are within an ulp, and differ in the last bit from
// glibc's, which CPython and Octave use, on 1-17% of inputs
// (scripts/libm-sweep.py).  Where glibc is correctly rounded these agree with
// it bit for bit, and where it is not they are better.  Each is computed in
// double-double arithmetic (about 104 bits: Dekker's exact product and Knuth's
// exact sum, Taylor series, and one Newton step from fdlibm's result), then
// rounded once.  That is the correctly rounded double unless the exact value
// lies within about 2^-100 relative of a midpoint between doubles, which no
// input of the sweeps does.  Like fdlibm.ts they use only +, -, *, / and sqrt,
// so every JavaScript engine computes the same bits.

import * as FD from "./fdlibm";
import { glibcLog1p } from "./libm";

// ------------------------------------------------------------ double-double arithmetic
// (a value hi + lo with |lo| <= ulp(hi)/2; the operations below are good to about 2^-104
// relative, for operands well inside the double range: callers scale)
type DD = [number, number];
const SPLITTER = 134217729; // 2^27 + 1

function twoSum(a: number, b: number): DD {
  const s = a + b, bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}
function fast(a: number, b: number): DD {
  const s = a + b;
  return [s, b - (s - a)];
}
function twoProd(a: number, b: number): DD {
  const p = a * b;
  const ca = SPLITTER * a, ah = ca - (ca - a), al = a - ah;
  const cb = SPLITTER * b, bh = cb - (cb - b), bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}
function add(a: DD, b: DD): DD {
  const s = twoSum(a[0], b[0]), t = twoSum(a[1], b[1]);
  let r = fast(s[0], s[1] + t[0]);
  r = fast(r[0], r[1] + t[1]);
  return r;
}
const neg = (a: DD): DD => [-a[0], -a[1]];
const sub = (a: DD, b: DD): DD => add(a, neg(b));
function mul(a: DD, b: DD): DD {
  const p = twoProd(a[0], b[0]);
  return fast(p[0], p[1] + (a[0] * b[1] + a[1] * b[0]));
}
function mulD(a: DD, b: number): DD {
  const p = twoProd(a[0], b);
  return fast(p[0], p[1] + a[1] * b);
}
function div(a: DD, b: DD): DD {
  const q0 = a[0] / b[0];
  let r = sub(a, mulD(b, q0));
  const q1 = r[0] / b[0];
  r = sub(r, mulD(b, q1));
  const q2 = r[0] / b[0];
  return add(fast(q0, q1), [q2, 0]);
}
function sqrt(a: DD): DD {
  if (a[0] <= 0) return [0, 0];
  const q = Math.sqrt(a[0]); // (IEEE's square root, exact in every engine)
  const r = sub(a, twoProd(q, q));
  return fast(q, r[0] / (2 * q));
}
const dd = (x: number): DD => [x, 0];
const ONE: DD = [1, 0];

const LN2: DD = [0.6931471805599453, 2.3190468138462996e-17];
const INVLN2: DD = [1.4426950408889634, 2.0355273740931033e-17];
const PIO2: DD = [1.5707963267948966, 6.123233995736766e-17];
const PI: DD = [3.141592653589793, 1.2246467991473532e-16];
// pi/2 in five parts of 33 bits: n * part is exact for |n| < 2^20 (Cody and Waite's reduction)
const PIO2P = [1.5707963267341256, 6.077100506303966e-11, 2.0222662487111665e-21, 8.478427660348229e-32, 2.067032109450824e-43];
// 1/k!, k = 0..30, as double-doubles (exact divisions at load: the same in every engine)
const INVFACT: DD[] = [ONE];
for (let k = 1; k <= 30; k++) INVFACT.push(div(INVFACT[k - 1], dd(k)));

// 2^k exactly for -1074 <= k <= 1023 (built by exact doublings and halvings: no Math.pow,
// whose bits engines need not agree on), and x * 2^k, exact unless the result is subnormal
const POW2 = new Float64Array(2098);
POW2[1074] = 1;
for (let k = 1; k <= 1023; k++) POW2[1074 + k] = POW2[1073 + k] * 2;
for (let k = 1; k <= 1074; k++) POW2[1074 - k] = POW2[1075 - k] / 2;
const pow2 = (k: number): number => POW2[1074 + k];
const scale = (x: number, k: number): number =>
  k > 1000 ? x * pow2(1000) * pow2(k - 1000) : k < -1000 ? x * pow2(-1000) * pow2(k + 1000) : x * pow2(k);
// the exponent e with 2^e <= |x| < 2^(e+1), for a finite nonzero x
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer);
function ilogb(x: number): number {
  F64[0] = x;
  const e = (U32[1] >>> 20) & 0x7ff;
  if (e !== 0) return e - 1023;
  F64[0] = x * 18014398509481984; // 2^54: a subnormal made normal
  return ((U32[1] >>> 20) & 0x7ff) - 1023 - 54;
}

// ------------------------------------------------------------ two ways to compute
// Each function is computed first with the fast components below (good to about 2^-74
// relative); when that cannot decide the rounding (about one input in 2^17), again with
// the accurate ones (about 2^-100).
interface Way {
  reduce(x: number): [number, DD]; // x - n pi/2 and n mod 4
  sincos(r: DD): [DD, DD]; // sin and cos for |r| <= pi/4 + 2^-20
  log1p(u: DD): DD; // log(1 + u) for -0.3 < u < 0.42
}
const EPS = 8.470329472543003e-22; // 2^-70: the fast path's error bound, with a margin
// the double nearest h + l, if every value within EPS |h| of it rounds to it (else NaN)
function decided(h: number, l: number): number {
  const r = h + l, e = Math.abs(h) * EPS;
  return h + (l + e) === r && h + (l - e) === r ? r : NaN;
}
// the accurate way's value, rounded (when the fast path's was not decided)
function cr(f: (w: Way) => DD): number {
  const v = f(ACC);
  return v[0] + v[1];
}

// ------------------------------------------------------------ the accurate components
// e^r - 1 for |r| <= 0.36: Taylor's series of e^(r/1024) - 1, then ten squarings in the
// form (1 + m)^2 - 1 = 2m + m^2, which keeps the relative accuracy of a small result
function expm1Small(r: DD): DD {
  const s = mulD(r, 1 / 1024);
  let m: DD = [0, 0];
  for (let k = 9; k >= 1; k--) m = mul(add(m, INVFACT[k]), s);
  for (let i = 0; i < 10; i++) m = add(mulD(m, 2), mul(m, m));
  return m;
}
// log(1 + u): one Newton step from glibc's log1p, on the residual
// (1 + u) e^-y0 - 1 = u + m + u m with m = e^-y0 - 1, so a small result keeps its relative accuracy
function log1pAcc(u: DD): DD {
  const y0 = glibcLog1p(u[0] + u[1]);
  const m = expm1Small(dd(-y0));
  return add(dd(y0), add(add(u, m), mul(u, m)));
}
// sin and cos by Taylor's series to r^29
function sinAcc(r: DD): DD {
  // (sum of (-1)^k r^(2k+1) / (2k+1)! by Horner's rule in r^2: s = 1/(2k+1)! - r^2 s)
  const r2 = mul(r, r);
  let s: DD = INVFACT[29];
  for (let k = 27; k >= 1; k -= 2) s = sub(INVFACT[k], mul(s, r2));
  return mul(s, r);
}
function cosAcc(r: DD): DD {
  const r2 = mul(r, r);
  let s: DD = INVFACT[28];
  for (let k = 26; k >= 0; k -= 2) s = sub(INVFACT[k], mul(s, r2));
  return s;
}
// x - n pi/2 for a finite x: below 2^20 pi/2 with `parts` 33-bit parts of pi/2 (n * part
// exact; five give 2^-160 absolute), above by fdlibm's 113-bit reduction
function reduceWith(x: number, parts: number): [number, DD] {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) return [0, dd(x)];
  if (ax < 1647099.3291652855) {
    const n = Math.round(x * 0.6366197723675814);
    let r: DD = dd(x);
    for (let i = 0; i < parts; i++) r = add(r, twoProd(-n, PIO2P[i]));
    return [((n % 4) + 4) % 4, r];
  }
  const [n, y0, y1, y2] = FD.remPio2Wide(x);
  return [((n % 4) + 4) % 4, add(fast(y0, y1), dd(y2))];
}
const ACC: Way = {
  reduce: (x) => reduceWith(x, 5),
  sincos: (r) => [sinAcc(r), cosAcc(r)],
  log1p: log1pAcc,
};

// ------------------------------------------------------------ the fast path
// The same double-double operations on scalars, without allocating: each g* function
// leaves its result in H + L.  Components:
//   sin and cos: r = j/32 + t, |t| <= 1/64, with sin and cos of j/32 from a table and those
//     of t by their series (the t^3 and t^2 terms in double-double, the rest, below 2^-30
//     relative, in doubles: 2^-80 overall);
//   log1p: 1 + u = a (1 + z) with a = 1 + j/128 from a table (its log and reciprocal),
//     |z| <= 2^-7.5, and log1p z by its series (to z^3 in double-double, the rest in doubles).
let H = 0, L = 0;
function gTwoSum(a: number, b: number): void {
  const s = a + b, bb = s - a;
  H = s;
  L = (a - (s - bb)) + (b - bb);
}
function gTwoProd(a: number, b: number): void {
  const p = a * b;
  const ca = SPLITTER * a, ah = ca - (ca - a), al = a - ah;
  const cb = SPLITTER * b, bh = cb - (cb - b), bl = b - bh;
  H = p;
  L = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}
function gAdd(ah: number, al: number, bh: number, bl: number): void {
  const s = ah + bh, bb = s - ah, e = (ah - (s - bb)) + (bh - bb);
  const t = al + bl, cc = t - al, f = (al - (t - cc)) + (bl - cc);
  const e1 = e + t, h1 = s + e1, l1 = e1 - (h1 - s);
  const e2 = l1 + f;
  H = h1 + e2;
  L = e2 - (H - h1);
}
function gMul(ah: number, al: number, bh: number, bl: number): void {
  const p = ah * bh;
  const ca = SPLITTER * ah, a1 = ca - (ca - ah), a2 = ah - a1;
  const cb = SPLITTER * bh, b1 = cb - (cb - bh), b2 = bh - b1;
  const e = ((a1 * b1 - p) + a1 * b2 + a2 * b1) + a2 * b2 + (ah * bl + al * bh);
  H = p + e;
  L = e - (H - p);
}
function gDiv(ah: number, al: number, bh: number, bl: number): void {
  const q0 = ah / bh;
  gMul(bh, bl, q0, 0);
  gAdd(ah, al, -H, -L);
  const rh = H, rl = L, q1 = rh / bh;
  gMul(bh, bl, q1, 0);
  gAdd(rh, rl, -H, -L);
  const q2 = H / bh, s = q0 + q1, e = q1 - (s - q0);
  gAdd(s, e, q2, 0);
}
function gSqrt(ah: number, al: number): void {
  const q = Math.sqrt(ah);
  gTwoProd(q, q);
  gAdd(ah, al, -H, -L);
  const c = H / (2 * q);
  H = q + c;
  L = c - (H - q);
}
const SC32 = new Float64Array(53 * 4); // sin j/32, cos j/32 as double-doubles, j = -26..26
for (let j = -26; j <= 26; j++) {
  const s = sinAcc(dd(j / 32)), c = cosAcc(dd(j / 32));
  SC32.set([s[0], s[1], c[0], c[1]], (j + 26) * 4);
}
const LA = new Float64Array(97 * 2), IA = new Float64Array(97 * 2); // log(1 + j/128), 1/(1 + j/128), j = -40..56
for (let j = -40; j <= 56; j++) {
  const l = j === 0 ? dd(0) : log1pAcc(dd(j / 128)), r = div(ONE, dd(1 + j / 128));
  LA[(j + 40) * 2] = l[0];
  LA[(j + 40) * 2 + 1] = l[1];
  IA[(j + 40) * 2] = r[0];
  IA[(j + 40) * 2 + 1] = r[1];
}
const THIRD = div(ONE, dd(3)), I3H = INVFACT[3][0], I3L = INVFACT[3][1];
// x - n pi/2 with three or five parts of pi/2 (below 2^20 pi/2): RQ = n mod 4, H + L
let RQ = 0;
function gReduce(x: number): void {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) {
    RQ = 0;
    H = x;
    L = 0;
    return;
  }
  if (ax < 1647099.3291652855) {
    const n = Math.round(x * 0.6366197723675814);
    let rh = x, rl = 0;
    for (let i = 0; i < 3; i++) {
      gTwoProd(-n, PIO2P[i]);
      gAdd(rh, rl, H, L);
      rh = H;
      rl = L;
    }
    // (three parts leave |n| 8.5e-32 absolute: near a multiple of pi/2, where r is small,
    // that is too much relative to r, and the other two parts are added: 3.8e-53 |n|)
    if (Math.abs(rh) < Math.abs(n) * 2e-9) {
      for (let i = 3; i < 5; i++) {
        gTwoProd(-n, PIO2P[i]);
        gAdd(rh, rl, H, L);
        rh = H;
        rl = L;
      }
    }
    RQ = ((n % 4) + 4) % 4;
    H = rh;
    L = rl;
    return;
  }
  const [q, r] = reduceWith(x, 5);
  RQ = q;
  H = r[0];
  L = r[1];
}
// sin and cos of r = rh + rl, |r| <= pi/4 + 2^-20: SH + SL, CH + CL
let SH = 0, SL = 0, CH = 0, CL = 0;
function gSinCos(rh: number, rl: number): void {
  const j = Math.round(rh * 32);
  let th = rh, tl = rl;
  if (j !== 0) {
    gAdd(rh, rl, -j / 32, 0);
    th = H;
    tl = L;
  }
  gMul(th, tl, th, tl);
  const tth = H, ttl = L, t2 = tth;
  // sin t = t + t (-t^2/6 + tail)
  gMul(tth, ttl, I3H, I3L);
  gAdd(-H, -L, t2 * t2 * (1 / 120 + t2 * (-1 / 5040 + t2 / 362880)), 0);
  gMul(th, tl, H, L);
  gAdd(th, tl, H, L);
  const sh = H, sl = L;
  // cos t = 1 + (-t^2/2 + tail)
  gAdd(tth * -0.5, ttl * -0.5, t2 * t2 * (1 / 24 + t2 * (-1 / 720 + t2 / 40320)), 0);
  gAdd(1, 0, H, L);
  const ch = H, cl = L;
  if (j === 0) {
    SH = sh;
    SL = sl;
    CH = ch;
    CL = cl;
    return;
  }
  const k = (j + 26) * 4, Sh = SC32[k], Sl = SC32[k + 1], Ch = SC32[k + 2], Cl = SC32[k + 3];
  gMul(Sh, Sl, ch, cl);
  const ah = H, al = L;
  gMul(Ch, Cl, sh, sl);
  gAdd(ah, al, H, L);
  const nsh = H, nsl = L;
  gMul(Ch, Cl, ch, cl);
  const bh = H, bl = L;
  gMul(Sh, Sl, sh, sl);
  gAdd(bh, bl, -H, -L);
  SH = nsh;
  SL = nsl;
  CH = H;
  CL = L;
}
// log(1 + u) for -0.3 < u < 0.42
function gLog1pCore(uh: number, ul: number): void {
  const j = Math.round(uh * 128);
  let zh = uh, zl = ul;
  if (j !== 0) {
    gAdd(uh, ul, -j / 128, 0);
    gMul(H, L, IA[(j + 40) * 2], IA[(j + 40) * 2 + 1]);
    zh = H;
    zl = L;
  }
  const z0 = zh;
  const tail = z0 * z0 * z0 * (-1 / 4 + z0 * (1 / 5 + z0 * (-1 / 6 + z0 * (1 / 7 + z0 * (-1 / 8 + z0 * (1 / 9 + z0 * (-1 / 10 + z0 / 11)))))));
  gMul(zh, zl, zh, zl);
  gMul(H, L, THIRD[0], THIRD[1]);
  gAdd(zh * -0.5, zl * -0.5, H, L);
  gAdd(H, L, tail, 0);
  gMul(zh, zl, H, L);
  gAdd(zh, zl, H, L);
  if (j !== 0) gAdd(LA[(j + 40) * 2], LA[(j + 40) * 2 + 1], H, L);
}
// log(v) for a positive v = vh + vl
function gLog(vh: number, vl: number): void {
  let e = ilogb(vh);
  let mh = scale(vh, -e), ml = scale(vl, -e); // in [1, 2)
  if (mh > 1.4142135623730951) {
    mh /= 2;
    ml /= 2;
    e += 1;
  }
  gAdd(mh, ml, -1, 0);
  gLog1pCore(H, L);
  if (e !== 0) {
    const lh = H, ll = L;
    gMul(LN2[0], LN2[1], e, 0);
    gAdd(lh, ll, H, L);
  }
}
// log(1 + u) for any u > -1
function gLog1p(uh: number, ul: number): void {
  if (uh > -0.3 && uh < 0.42) gLog1pCore(uh, ul);
  else {
    gAdd(1, 0, uh, ul);
    gLog(H, L);
  }
}
// atan of z = zh + zl: the Newton step of atanWith
function gAtan(zh: number, zl: number): void {
  const y0 = FD.atan(zh + zl), a = Math.abs(y0);
  let sh: number, sl: number, ch: number, cl: number;
  if (a <= 0.7853981633974483) {
    gSinCos(y0, 0);
    sh = SH; sl = SL; ch = CH; cl = CL;
  } else {
    gAdd(PIO2[0], PIO2[1], -a, 0);
    gSinCos(H, L);
    sh = y0 < 0 ? -CH : CH;
    sl = y0 < 0 ? -CL : CL;
    ch = SH;
    cl = SL;
  }
  gMul(zh, zl, ch, cl);
  gAdd(sh, sl, -H, -L);
  gMul(ch, cl, H, L);
  gAdd(y0, 0, -H, -L);
}
// atan2 of positive y, x of comparable size, in [0, pi/2]
function gAtan2Pos(yh: number, yl: number, xh: number, xl: number): void {
  if (yh <= xh) {
    gDiv(yh, yl, xh, xl);
    gAtan(H, L);
  } else {
    gDiv(xh, xl, yh, yl);
    gAtan(H, L);
    gAdd(PIO2[0], PIO2[1], -H, -L);
  }
}

// ------------------------------------------------------------ log in double-double
// log(1 + u) for any u > -1, and log(v) for a positive v, by either way
function log1pWith(w: Way, u: DD): DD {
  return u[0] > -0.3 && u[0] < 0.42 ? w.log1p(u) : logWith(w, add(ONE, u));
}
function logWith(w: Way, v: DD): DD {
  let e = ilogb(v[0]);
  let m: DD = [scale(v[0], -e), scale(v[1], -e)]; // in [1, 2)
  if (m[0] > 1.4142135623730951) {
    m = [m[0] / 2, m[1] / 2];
    e += 1;
  }
  const l = w.log1p(add(m, [-1, 0]));
  return e === 0 ? l : add(l, mulD(LN2, e));
}

// ------------------------------------------------------------ the functions
// (each: the special cases as C99's Annex F and glibc have them, then the double-double
// value, rounded once)

function sinWith(w: Way, x: number): DD {
  const [q, r] = w.reduce(x);
  const [s, c] = w.sincos(r);
  return q === 0 ? s : q === 1 ? c : q === 2 ? neg(s) : neg(c);
}
export function sin(x: number): number {
  if (!Number.isFinite(x)) return x - x;
  if (Math.abs(x) < 7.450580596923828e-9) return x; // |x| < 2^-27: x is the nearest
  gReduce(x);
  const q = RQ;
  gSinCos(H, L);
  const r = q === 0 ? decided(SH, SL) : q === 1 ? decided(CH, CL) : q === 2 ? -decided(SH, SL) : -decided(CH, CL);
  return r === r ? r : cr((w) => sinWith(w, x));
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return x - x;
  if (Math.abs(x) < 7.450580596923828e-9) return 1;
  gReduce(x);
  const q = RQ;
  gSinCos(H, L);
  const r = q === 0 ? decided(CH, CL) : q === 1 ? -decided(SH, SL) : q === 2 ? -decided(CH, CL) : decided(SH, SL);
  if (r === r) return r;
  return cr((w) => {
    const [q, r] = w.reduce(x);
    const [s, c] = w.sincos(r);
    return q === 0 ? c : q === 1 ? neg(s) : q === 2 ? neg(c) : s;
  });
}

export function tan(x: number): number {
  if (!Number.isFinite(x)) return x - x;
  if (Math.abs(x) < 7.450580596923828e-9) return x;
  gReduce(x);
  const q = RQ;
  gSinCos(H, L);
  if (q & 1) gDiv(CH, CL, SH, SL);
  else gDiv(SH, SL, CH, CL);
  const f = q & 1 ? -decided(H, L) : decided(H, L);
  if (f === f) return f;
  return cr((w) => {
    const [q, r] = w.reduce(x);
    const [s, c] = w.sincos(r);
    return q & 1 ? neg(div(c, s)) : div(s, c);
  });
}

// atan of a double-double z: one Newton step y1 = y0 - cos y0 (sin y0 - z cos y0) from
// fdlibm's atan, with sin and cos of y0 (|y0| <= pi/2) through pi/2 - |y0| above pi/4
function atanWith(w: Way, z: DD): DD {
  const y0 = FD.atan(z[0] + z[1]);
  const a = Math.abs(y0);
  let s: DD, c: DD;
  if (a <= 0.7853981633974483) [s, c] = w.sincos(dd(y0));
  else {
    const [sw, cw] = w.sincos(sub(PIO2, dd(a)));
    s = y0 < 0 ? neg(cw) : cw;
    c = sw;
  }
  return sub(dd(y0), mul(c, sub(s, mul(z, c))));
}
// atan2 of positive double-doubles y, x of comparable size: in [0, pi/2]
function atan2Pos(w: Way, y: DD, x: DD): DD {
  return y[0] <= x[0] ? atanWith(w, div(y, x)) : sub(PIO2, atanWith(w, div(x, y)));
}

export function atan(x: number): number {
  if (x !== x) return x;
  const a = Math.abs(x);
  if (a < 7.450580596923828e-9) return x;
  if (a > 1.8014398509481984e16) return x > 0 ? PIO2[0] : -PIO2[0]; // |x| > 2^54: pi/2 - 1/|x| rounds to pi/2
  if (a <= 1) {
    gAtan(x, 0);
    const f = decided(H, L);
    return f === f ? f : cr((w) => atanWith(w, dd(x)));
  }
  // (|x| > 1: pi/2 - atan(1/|x|), so the Newton step sees an argument of at most 1: near
  // pi/2 its error, about tan(y) times the square of fdlibm's, would reach an ulp)
  gDiv(1, 0, a, 0);
  gAtan(H, L);
  gAdd(PIO2[0], PIO2[1], -H, -L);
  let r = decided(H, L);
  if (r !== r) r = cr((w) => sub(PIO2, atanWith(w, div(ONE, dd(a)))));
  return x < 0 ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (y !== y || x !== x || y === 0 || x === 0 || !Number.isFinite(y) || !Number.isFinite(x)) return FD.atan2(y, x);
  // (the quotient only matters: scale both so the larger is near 1)
  const ay = Math.abs(y), ax = Math.abs(x);
  const e = ilogb(Math.max(ay, ax));
  const sy = scale(ay, -e), sx = scale(ax, -e);
  let r: number;
  if (sy < sx * 8.673617379884035e-19) r = x > 0 ? ay / ax : PI[0]; // (|y/x| < 2^-60: atan(y/x) rounds to y/x, pi - y/x to pi)
  else if (sx < sy * 8.673617379884035e-19) r = PIO2[0];
  else {
    gAtan2Pos(sy, 0, sx, 0);
    if (x < 0) gAdd(PI[0], PI[1], -H, -L);
    r = decided(H, L);
    if (r !== r) r = cr((w) => {
      const v = atan2Pos(w, dd(sy), dd(sx));
      return x < 0 ? sub(PI, v) : v;
    });
  }
  return y < 0 ? -r : r;
}

export function asin(x: number): number {
  if (x !== x) return x;
  const a = Math.abs(x);
  if (a > 1) return NaN;
  if (a < 1.4901161193847656e-8) return x; // |x| < 2^-26
  if (a === 1) return x > 0 ? PIO2[0] : -PIO2[0];
  // asin x = atan2(|x|, sqrt((1 - |x|)(1 + |x|)))
  const c = sqrt(mul(twoSum(1, -a), twoSum(1, a)));
  gAtan2Pos(a, 0, c[0], c[1]);
  let r = decided(H, L);
  if (r !== r) r = cr((w) => atan2Pos(w, dd(a), c));
  return x < 0 ? -r : r;
}

export function acos(x: number): number {
  if (x !== x) return x;
  const a = Math.abs(x);
  if (a > 1) return NaN;
  if (x === 1) return 0;
  if (x === -1) return PI[0];
  if (a === 0) return PIO2[0];
  const c = sqrt(mul(twoSum(1, -a), twoSum(1, a)));
  gAtan2Pos(c[0], c[1], a, 0);
  if (x < 0) gAdd(PI[0], PI[1], -H, -L);
  const f = decided(H, L);
  if (f === f) return f;
  return cr((w) => {
    const v = atan2Pos(w, c, dd(a));
    return x < 0 ? sub(PI, v) : v;
  });
}

export function asinh(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const a = Math.abs(x);
  if (a < 7.450580596923828e-9) return x; // |x| < 2^-27
  if (a > 1.152921504606847e18) {
    gLog(a, 0);
    gAdd(H, L, LN2[0], LN2[1]);
  } else {
    gTwoProd(a, a);
    const a2h = H, a2l = L;
    gAdd(1, 0, a2h, a2l);
    gSqrt(H, L);
    gAdd(1, 0, H, L);
    gDiv(a2h, a2l, H, L);
    gAdd(a, 0, H, L);
    gLog1p(H, L);
  }
  let r = decided(H, L);
  if (r !== r) r = cr((w) => {
    // (|x| > 2^60: asinh x = log 2|x| to well below an ulp)
    if (a > 1.152921504606847e18) return add(logWith(w, dd(a)), LN2);
    // log1p(|x| + x^2 / (1 + sqrt(1 + x^2))): no cancellation for small |x|
    const a2 = twoProd(a, a);
    return log1pWith(w, add(dd(a), div(a2, add(ONE, sqrt(add(ONE, a2))))));
  });
  return x < 0 ? -r : r;
}

export function acosh(x: number): number {
  if (x !== x) return x;
  if (x < 1) return NaN;
  if (x === 1) return 0;
  if (x === Infinity) return x;
  if (x > 1.152921504606847e18) {
    gLog(x, 0);
    gAdd(H, L, LN2[0], LN2[1]);
  } else {
    gTwoSum(x, -1);
    const th = H, tl = L;
    gAdd(th, tl, 2, 0);
    gMul(th, tl, H, L);
    gSqrt(H, L);
    gAdd(th, tl, H, L);
    gLog1p(H, L);
  }
  const f = decided(H, L);
  if (f === f) return f;
  return cr((w) => {
    if (x > 1.152921504606847e18) return add(logWith(w, dd(x)), LN2);
    // log1p(t + sqrt(t (t + 2))) with t = x - 1, exact as a double-double
    const t = twoSum(x, -1);
    return log1pWith(w, add(t, sqrt(mul(t, add(t, dd(2))))));
  });
}

export function atanh(x: number): number {
  if (x !== x) return x;
  const a = Math.abs(x);
  if (a > 1) return NaN;
  if (a === 1) return x > 0 ? Infinity : -Infinity;
  if (a < 7.450580596923828e-9) return x;
  // atanh |x| = log1p(2|x| / (1 - |x|)) / 2
  const u = div(dd(2 * a), twoSum(1, -a));
  gLog1p(u[0], u[1]);
  let r = decided(H / 2, L / 2);
  if (r !== r) r = cr((w) => mulD(log1pWith(w, u), 0.5));
  return x < 0 ? -r : r;
}

export function log2(x: number): number {
  if (x !== x || x < 0) return x !== x ? x : NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return x;
  // (a power of two: its exponent, exactly)
  const e = ilogb(x);
  if (x === pow2(e)) return e;
  gLog(x, 0);
  gMul(H, L, INVLN2[0], INVLN2[1]);
  const f = decided(H, L);
  return f === f ? f : cr((w) => div(logWith(w, dd(x)), LN2));
}

// sqrt(x^2 + y^2): the squares exactly, scaled so neither overflows nor underflows
export function hypot(x: number, y: number): number {
  if (x === Infinity || x === -Infinity || y === Infinity || y === -Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  let a = Math.abs(x), b = Math.abs(y);
  if (a < b) [a, b] = [b, a];
  if (b === 0) return a;
  if (b < a * 8.673617379884035e-19) return a; // (b/a < 2^-60: a is the nearest)
  const e = ilogb(a);
  const as = scale(a, -e), bs = scale(b, -e); // (as in [1, 2); bs exact unless it underflows, then negligible)
  const r = sqrt(add(twoProd(as, as), twoProd(bs, bs)));
  return roundScaled(r, e);
}
// the Euclidean norm of any number of coordinates (math.hypot): the same way, the
// squares summed exactly enough in double-double after scaling by the largest
export function hypotN(xs: number[]): number {
  if (xs.length === 2) return hypot(xs[0], xs[1]);
  let max = 0, nan = false;
  for (const x of xs) {
    const a = Math.abs(x);
    if (a === Infinity) return Infinity;
    if (a !== a) nan = true;
    else if (a > max) max = a;
  }
  if (nan) return NaN;
  if (max === 0) return 0;
  const e = ilogb(max);
  let s: DD = [0, 0];
  for (const x of xs) {
    const v = scale(Math.abs(x), -e);
    s = add(s, twoProd(v, v));
  }
  return roundScaled(sqrt(s), e);
}
// (hi + lo) * 2^e rounded once, also where the result is subnormal (where hi * 2^e would
// round a second time)
function roundScaled(r: DD, e: number): number {
  if (e >= -1022) return scale(r[0] + r[1], e);
  // (the result's last place is 2^-1074: round r to a multiple of 2^(-1074 - e) first)
  const q = pow2(-1074 - e);
  const k = Math.floor(r[0] / q);
  const rem = add(r, dd(-k * q));
  let n = k;
  const half = q / 2;
  if (rem[0] > half || (rem[0] === half && rem[1] > 0) || (rem[0] === half && rem[1] === 0 && (k & 1))) n = k + 1;
  return n * 5e-324;
}
