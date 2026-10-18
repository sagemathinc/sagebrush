// The natural logarithm as glibc computes it.  V8's Math.log differs from
// glibc's log in the last bit for several percent of inputs, and NumPy's
// random distributions (normal, exponential, Poisson ...) call glibc's log,
// so reproducing NumPy's streams bit for bit needs glibc's algorithm.

// glibc's log (ARM optimized-routines math/log.c, MIT OR Apache-2.0 WITH
// LLVM-exception, Copyright (c) 2018-2025 Arm Limited), ported line by line
// so that results agree with NumPy's random distributions (which call it)
// bit for bit.  `fma` selects the variant glibc picks on CPUs with FMA.
import { LN2HI, LN2LO, POLY1 as B, POLY as A, TAB, TAB2 } from "./log_data";
// bit access through aliased typed arrays (little-endian: [1] is the high word)
const gf = new Float64Array(1), gu = new Uint32Array(gf.buffer);
const POW2L = new Float64Array(2200); // 2^(j - 1100)
for (let j = 0; j < 2200; j++) POW2L[j] = 2 ** (j - 1100);
export function glibcLog(x: number, fma = true): number {
  const fmaE = fmaExact;
  if (x >= 0.9375 && x < 1.064697265625) {
    if (x === 1) return 0;
    const r = x - 1.0, r2 = r * r, r3 = r * r2;
    let w = r * 134217728;
    const rhi = r + w - w, rlo = r - rhi;
    w = rhi * rhi * B[0];
    const hi = r + w;
    let lo = r - hi + w;
    if (!fma) {
      let y = r3 * (B[1] + r * B[2] + r2 * B[3] + r3 * (B[4] + r * B[5] + r2 * B[6] + r3 * (B[7] + r * B[8] + r2 * B[9] + r3 * B[10])));
      lo += B[0] * rlo * (rhi + r);
      y += lo;
      y += hi;
      return y;
    }
    // with FMA, GCC fuses every product whose only uses are additions,
    // across statements: the polynomial, lo += B0 rlo (rhi + r), and
    // y = r3 P + lo (checked against glibc 2.43)
    const p3 = fmaE(r3, B[10], fmaE(r2, B[9], fmaE(r, B[8], B[7])));
    const p2 = fmaE(r3, p3, fmaE(r2, B[6], fmaE(r, B[5], B[4])));
    const P = fmaE(r3, p2, fmaE(r2, B[3], fmaE(r, B[2], B[1])));
    lo = fmaE(B[0] * rlo, rhi + r, lo);
    return fmaE(r3, P, lo) + hi;
  }
  gf[0] = x;
  let hiw = gu[1];
  const top = hiw >>> 16;
  let kAdj = 0;
  if (top - 0x0010 >= 0x7ff0 - 0x0010 || top < 0x0010) {
    if (x === 0) return -Infinity;
    if (x === Infinity) return x;
    if (!(x > 0)) return NaN;
    gf[0] = x * 4503599627370496; // subnormal: scale by 2^52
    hiw = gu[1];
    kAdj = -52;
  }
  const tmpHi = (hiw - 0x3fe60000) | 0;
  const i = (tmpHi >>> 13) & 127;
  const k = (tmpHi >> 20) + kAdj;
  const z = (kAdj ? x * 4503599627370496 : x) * POW2L[1100 - k + kAdj]; // x / 2^k, exactly
  const invc = TAB[2 * i], logc = TAB[2 * i + 1];
  let r: number;
  if (fma) {
    // fma(z, invc, -1.0): z*invc - 1 rounded once (z*invc - 1 is exact up to the product's error)
    const p = z * invc;
    const ca = 134217729 * z, ah = ca - (ca - z), al = z - ah;
    const cb = 134217729 * invc, bh = cb - (cb - invc), bl = invc - bh;
    const e = ah * bh - p + ah * bl + al * bh + al * bl;
    r = p - 1.0 + e;
  } else r = (z - TAB2[2 * i] - TAB2[2 * i + 1]) * invc;
  const kd = k;
  const w = kd * LN2HI + logc;
  const hi = w + r;
  const lo = w - hi + r + kd * LN2LO;
  const r2 = r * r;
  return lo + r2 * A[0] + r * r2 * (A[1] + r * A[2] + r2 * (A[3] + r * A[4])) + hi;
}

// glibc's exp (ARM optimized-routines math/exp.c, MIT OR Apache-2.0 WITH
// LLVM-exception, Copyright (c) 2018-2023 Arm Limited), ported line by line.
// glibc's x86-64 build for FMA CPUs contracts a*b+c into fused
// multiply-adds (the polynomial and the final scale + scale*tmp, but not in
// specialcase for k < 0; checked against glibc 2.43 on 10^6 inputs);
// fma() below reproduces that (exactly in all but vanishingly rare
// double-rounding cases).
function fma(a: number, b: number, c: number): number {
  const p = a * b;
  const ca = 134217729 * a, ah = ca - (ca - a), al = a - ah;
  const cb = 134217729 * b, bh = cb - (cb - b), bl = b - bh;
  const e = ah * bh - p + ah * bl + al * bh + al * bl;
  const s = p + c, bb = s - p, t = p - (s - bb) + (c - bb);
  return s + (t + e);
}
const fmaExact = fma;
import { EXP_POLY, EXP_TAB } from "./exp_data";
const INVLN2N = 1.4426950408889634 * 128, NEGLN2HIN = -0.005415212348111709, NEGLN2LON = -1.2864023111638346e-14;
const SHIFT = 6755399441055744; // 0x1.8p52
const [C2, C3, C4, C5] = EXP_POLY;
const ef = new Float64Array(1), eu = new Uint32Array(ef.buffer);
function bitsToDouble(hi: number, lo: number): number {
  eu[1] = hi;
  eu[0] = lo;
  return ef[0];
}
// The tables as doubles: tail[i], and base[i] = 2^(i/128), so that glibc's
// scale = asdouble(T[2i+1] + (k << 45)) is base[i] * 2^((k - i) / 128),
// an exact product while in the normal range (no bit manipulation needed).
const TAIL = new Float64Array(128), BASE = new Float64Array(128);
for (let i = 0; i < 128; i++) {
  TAIL[i] = bitsToDouble(EXP_TAB[4 * i], EXP_TAB[4 * i + 1]);
  BASE[i] = bitsToDouble((EXP_TAB[4 * i + 2] + (i << 13)) >>> 0, EXP_TAB[4 * i + 3]);
}
const POW2 = new Float64Array(2200); // 2^(j - 1100)
for (let j = 0; j < 2200; j++) POW2[j] = 2 ** (j - 1100);

export function glibcExp(x: number): number {
  const ax = Math.abs(x);
  if (!(ax >= 5.551115123125783e-17 && ax < 512)) return glibcExpSlow(x);
  const z = INVLN2N * x;
  const kd = z + SHIFT - SHIFT; // round to integer, as glibc
  const r = x + kd * NEGLN2HIN + kd * NEGLN2LON;
  const i = kd & 127;
  const scale = BASE[i] * POW2[(kd - i) / 128 + 1100];
  const r2 = r * r;
  const tmp = fma(r2 * r2, fma(r, C5, C4), fma(r2, fma(r, C3, C2), TAIL[i] + r));
  // fma(scale, tmp, scale): the product exactly (Dekker), then one rounding
  const p = scale * tmp;
  const ca = 134217729 * scale, ah = ca - (ca - scale), al = scale - ah;
  const cb = 134217729 * tmp, bh = cb - (cb - tmp), bl = tmp - bh;
  const e = ah * bh - p + ah * bl + al * bh + al * bl;
  const sum = p + scale, bb = sum - p, t = p - (sum - bb) + (scale - bb);
  return sum + (t + e);
}

function glibcExpSlow(x: number): number {
  ef[0] = x;
  const hiw = eu[1];
  let abstop = (hiw >>> 20) & 0x7ff;
  if (((abstop - 0x3c9) >>> 0) >= 0x408 - 0x3c9) {
    if (((abstop - 0x3c9) | 0) < 0) return 1.0 + x; // tiny x (and 0)
    if (abstop >= 0x409) {
      if (x === -Infinity) return 0.0;
      if (abstop >= 0x7ff) return 1.0 + x;
      return x < 0 ? 0 : Infinity;
    }
    abstop = 0; // large |x|: handled by specialcase
  }
  const z = INVLN2N * x;
  let kd = z + SHIFT;
  const k = kd - SHIFT; // an integer
  kd -= SHIFT;
  const r = x + kd * NEGLN2HIN + kd * NEGLN2LON;
  const i = k & 127;
  const tail = bitsToDouble(EXP_TAB[4 * i], EXP_TAB[4 * i + 1]);
  // sbits = T[idx + 1] + (ki << 45): only the high word changes
  const sHi = (EXP_TAB[4 * i + 2] + (k << 13)) >>> 0, sLo = EXP_TAB[4 * i + 3];
  const r2 = r * r;
  const tmp = fma(r2 * r2, fma(r, C5, C4), fma(r2, fma(r, C3, C2), tail + r));
  if (abstop === 0) {
    // specialcase: the exponent of scale may have overflowed or underflowed
    if ((k & 0x80000000) === 0 && k >= 0) {
      const scale = bitsToDouble((sHi - (1009 << 20)) >>> 0, sLo);
      return 2 ** 1009 * fma(scale, tmp, scale);
    }
    const scale = bitsToDouble((sHi + (1022 << 20)) >>> 0, sLo);
    let y = scale + scale * tmp;
    if (y < 1.0) {
      let lo = scale - y + scale * tmp;
      const hi = 1.0 + y;
      lo = 1.0 - hi + y + lo;
      y = hi + lo - 1.0;
      if (y === 0) y = 0;
    }
    return 2 ** -1022 * y;
  }
  const scale = bitsToDouble(sHi, sLo);
  return fma(scale, tmp, scale);
}

// glibc's exp2 (ARM optimized-routines math/exp2.c, MIT OR Apache-2.0 WITH
// LLVM-exception, Copyright (c) 2018-2023 Arm Limited), over exp's tables:
// x = k/128 + r, 2^x = 2^(k/128) 2^r.  Python's math.exp2 calls it.
const EXP2_POLY = [0.6931471805599453, 0.24022650695909065, 0.0555041086686087, 0.009618131975721055, 0.0013332074570119598]; // (0x1.62e42fefa39efp-1, 0x1.ebfbdff82c424p-3, 0x1.c6b08d70cf4b5p-5, 0x1.3b2abd24650ccp-7, 0x1.5d7e09b4e3a84p-10)
const EXP2_SHIFT = 6755399441055744 / 128; // 0x1.8p52 / N
export function glibcExp2(x: number): number {
  ef[0] = x;
  let abstop = (eu[1] >>> 20) & 0x7ff;
  if (((abstop - 0x3c9) >>> 0) >= 0x408 - 0x3c9) { // |x| < 2^-54 or |x| >= 512, or nan
    if (((abstop - 0x3c9) | 0) < 0) return 1.0 + x;
    if (abstop >= 0x409) { // |x| >= 1024
      if (x === -Infinity) return 0.0;
      if (abstop >= 0x7ff) return 1.0 + x;
      if (x > 0) return Infinity;
      if (x <= -1075) return 0.0;
    }
    if (Math.abs(x) > 928) abstop = 0; // (2 asuint64(x) > 2 asuint64(928.0): large |x| is special-cased below)
  }
  const kd0 = x + EXP2_SHIFT;
  ef[0] = kd0;
  const k = eu[0] | 0; // the low word of kd0's bits: k (a signed 32-bit integer here)
  const kd = kd0 - EXP2_SHIFT;
  const r = x - kd;
  const i = k & 127;
  const tail = bitsToDouble(EXP_TAB[4 * i], EXP_TAB[4 * i + 1]);
  // (sbits = T[2i+1] + (k << 45): the table holds 2^(i/128) less i << 45; only the high word changes)
  const sHi = (EXP_TAB[4 * i + 2] + (k << 13)) >>> 0, sLo = EXP_TAB[4 * i + 3];
  const [C1, C2e, C3e, C4e, C5e] = EXP2_POLY;
  const r2 = r * r;
  // (glibc builds exp2 without fused multiply-adds: no contraction here)
  const tmp = tail + r * C1 + r2 * (C2e + r * C3e) + r2 * r2 * (C4e + r * C5e);
  if (abstop === 0) {
    if (k >= 0) {
      // (k > 0: the exponent may overflow; glibc scales by 2^-1 and back, here
      // by 2^-1009 so that nothing overflows; the scalings are exact)
      const scale = bitsToDouble((sHi - (1009 << 20)) >>> 0, sLo);
      return 2 ** 1009 * (scale + scale * tmp);
    }
    const scale = bitsToDouble((sHi + (1022 << 20)) >>> 0, sLo);
    let y = scale + scale * tmp;
    if (y < 1.0) {
      let lo = scale - y + scale * tmp;
      const hi = 1.0 + y;
      lo = 1.0 - hi + y + lo;
      y = hi + lo - 1.0;
      if (y === 0) y = 0;
    }
    return 2 ** -1022 * y;
  }
  const scale = bitsToDouble(sHi, sLo);
  return scale + scale * tmp;
}

// The tables of glibcExp and glibcLog, packed for the WebAssembly kernels
// (kernels/src/libm.rs): exp: tail[128], base[128], c2..c5, tbits[128]
// (doubles whose bits are glibc's T[2i+1]); log: (invc, logc)[128], A[5],
// B[11], ln2hi, ln2lo.
const TBITS = Float64Array.from({ length: 128 }, (_, i) => bitsToDouble(EXP_TAB[4 * i + 2], EXP_TAB[4 * i + 3]));
export const EXP_TABLES = Float64Array.from([...TAIL, ...BASE, C2, C3, C4, C5, ...TBITS]);
export const LOG_TABLES = Float64Array.from([...TAB, ...A, ...B, LN2HI, LN2LO]);

// glibc's log1p (sysdeps/ieee754/dbl-64/s_log1p.c, from fdlibm: Copyright
// (C) 1993 by Sun Microsystems, Inc.) as glibc 2.43's x86-64 FMA build
// computes it: GCC fuses the polynomial's products (z Lp1 into z2 R2, ...)
// and k ln2 into the sums, but not s (hfsq + R) (found against glibc on
// 10^5 inputs per path).  V8's Math.log1p is fdlibm's own, which evaluates
// the polynomial in another order.  NumPy's ziggurats call it.
// fdlibm's notice, preserved as it requires:
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunPro, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this software is freely
//   granted, provided that this notice is preserved.
const LP = [0.0, 6.666666666666735130e-01, 3.999999999940941908e-01, 2.857142874366239149e-01, 2.222219843214978396e-01,
  1.818357216161805012e-01, 1.531383769920937332e-01, 1.479819860511658591e-01];
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10;
export function glibcLog1p(x: number): number {
  ef[0] = x;
  const hx = eu[1] | 0, ax = hx & 0x7fffffff;
  let k = 1, f = 0, c = 0, hu = 0;
  if (hx < 0x3fda827a) {
    if (ax >= 0x3ff00000) return x === -1.0 ? -Infinity : NaN;
    if (ax < 0x3e200000) return ax < 0x3c900000 ? x : fma(-(x * x), 0.5, x);
    if (hx > 0 || hx <= (0xbfd2bec3 | 0)) {
      k = 0;
      f = x;
      hu = 1;
    }
  } else if (hx >= 0x7ff00000) return x + x;
  if (k !== 0) {
    let u: number;
    if (hx < 0x43400000) {
      u = 1.0 + x;
      ef[0] = u;
      hu = eu[1] | 0;
      k = (hu >> 20) - 1023;
      c = k > 0 ? 1.0 - (u - x) : x - (u - 1.0);
      c /= u;
    } else {
      u = x;
      ef[0] = u;
      hu = eu[1] | 0;
      k = (hu >> 20) - 1023;
      c = 0;
    }
    hu &= 0x000fffff;
    ef[0] = u;
    if (hu < 0x6a09e) eu[1] = hu | 0x3ff00000;
    else {
      k += 1;
      eu[1] = hu | 0x3fe00000;
      hu = (0x00100000 - hu) >> 2;
    }
    u = ef[0];
    f = u - 1.0;
  }
  const hfsq = 0.5 * f * f;
  if (hu === 0) {
    if (f === 0) return k === 0 ? 0 : fma(k, LN2_HI, fma(k, LN2_LO, c));
    const t = fma(-0.66666666666666666, f, 1.0);
    if (k === 0) return fma(-hfsq, t, f);
    return fma(k, LN2_HI, -(hfsq * t - fma(k, LN2_LO, c) - f));
  }
  const s2 = f / (2.0 + f), z = s2 * s2;
  const z2 = z * z, z4 = z2 * z2, z6 = z4 * z2;
  const R2 = fma(z, LP[3], LP[2]), R3 = fma(z, LP[5], LP[4]), R4 = fma(z, LP[7], LP[6]);
  const R = fma(z6, R4, fma(z4, R3, fma(z, LP[1], z2 * R2)));
  if (k === 0) return f - (hfsq - s2 * (hfsq + R));
  return fma(k, LN2_HI, -(hfsq - (s2 * (hfsq + R) + fma(k, LN2_LO, c)) - f));
}

// glibc's pow (ARM optimized-routines math/pow.c, MIT OR Apache-2.0 WITH
// LLVM-exception, Copyright (c) 2018-2026 Arm Limited), ported line by line
// with HAVE_FAST_FMA as glibc's x86-64 FMA build: the exact fma()s of the
// source, and GCC's one fusion that matters (the polynomial's last product
// into the sum: found against glibc 2.43 on 2*10^6 inputs, all identical).
// V8's Math.pow calls the platform's (88 of those inputs differ from glibc
// on Linux), so it differs between operating systems; this does not.
import { POW_LN2HI, POW_LN2LO, POW_A, POW_INVC, POW_LOGC, POW_LOGCTAIL } from "./pow_data";
const phi = (x: number): number => ((ef[0] = x), eu[1]);
const plo = (x: number): number => ((ef[0] = x), eu[0]);
let POW_TAIL = 0;
// log(x) = y + POW_TAIL, with about 15 bits more than y (x > 0 finite)
function powLog(x: number): number {
  let k0 = 0;
  if (x < 2.2250738585072014e-308) {
    x *= 4503599627370496; // subnormal: normalized (2^52), the exponent adjusted below
    k0 = -52;
  }
  const hx = phi(x), lx = plo(x);
  const tmp = (hx - 0x3fe69555) | 0; // ix - OFF (OFF's low word is 0)
  const i = (tmp >>> 13) & 127;
  const kd = (tmp >> 20) + k0;
  const z = bitsToDouble((hx - (tmp & 0xfff00000)) >>> 0, lx);
  const invc = POW_INVC[i], logc = POW_LOGC[i], logctail = POW_LOGCTAIL[i];
  const r = fma(z, invc, -1.0); // exact
  const t1 = kd * POW_LN2HI + logc; // exact
  const t2 = t1 + r;
  const lo1 = kd * POW_LN2LO + logctail;
  const lo2 = t1 - t2 + r;
  const ar = POW_A[0] * r, ar2 = r * ar, ar3 = r * ar2;
  const hi = t2 + ar2;
  const lo3 = fma(ar, r, -ar2);
  const lo4 = t2 - hi + ar2;
  const q = POW_A[1] + r * POW_A[2] + ar2 * (POW_A[3] + r * POW_A[4] + ar2 * (POW_A[5] + r * POW_A[6]));
  const lo = fma(ar3, q, lo1 + lo2 + lo3 + lo4);
  const y = hi + lo;
  POW_TAIL = hi - y + lo;
  return y;
}
// sign * exp(x + xtail)
function powExp(x: number, xtail: number, neg: boolean): number {
  const abstop = (phi(x) >>> 20) & 0x7ff;
  let big = false;
  if (abstop < 0x3c9 || abstop >= 0x408) {
    if (abstop < 0x3c9) {
      const one = 1.0 + x; // tiny x
      return neg ? -one : one;
    }
    if (abstop >= 0x409) return x < 0 ? (neg ? -0 : 0) : neg ? -Infinity : Infinity;
    big = true; // large |x|: specialcase
  }
  const z = INVLN2N * x;
  const kd = z + SHIFT - SHIFT;
  const r = x + kd * NEGLN2HIN + kd * NEGLN2LON + xtail;
  const i = kd & 127;
  const tail = TAIL[i];
  const r2 = r * r;
  const tmp = fma(r2 * r2, fma(r, C5, C4), fma(r2, fma(r, C3, C2), tail + r));
  // sbits = T[2i+1] + ((k + sign_bias) << 45): the high word changes
  const sHi = (EXP_TAB[4 * i + 2] + (kd << 13) + (neg ? 0x80000000 : 0)) >>> 0, sLo = EXP_TAB[4 * i + 3];
  if (big) {
    if (kd > 0) {
      const scale = bitsToDouble((sHi - (1009 << 20)) >>> 0, sLo);
      return 2 ** 1009 * fma(scale, tmp, scale);
    }
    const scale = bitsToDouble((sHi + (1022 << 20)) >>> 0, sLo);
    let y = scale + scale * tmp;
    if (Math.abs(y) < 1.0) {
      const one = y < 0 ? -1.0 : 1.0;
      let lo = scale - y + scale * tmp;
      const hi = one + y;
      lo = one - hi + y + lo;
      y = hi + lo - one;
      if (y === 0) y = neg ? -0 : 0;
    }
    return 2 ** -1022 * y;
  }
  const scale = bitsToDouble(sHi, sLo);
  return fma(scale, tmp, scale);
}
// 0: y is not an integer, 1: odd, 2: even
function checkint(y: number): number {
  if (!Number.isFinite(y) || Math.trunc(y) !== y) return 0;
  if (Math.abs(y) >= 9007199254740992) return 2;
  return y % 2 !== 0 ? 1 : 2;
}
/** x^y as glibc's pow (C semantics: pow(0, -1) = inf, pow(-8, 1/3) = NaN) */
export function glibcPow(x: number, y: number): number {
  let neg = false;
  const topx = phi(x) >>> 20, topy = phi(y) >>> 20;
  if (((topx - 0x001) >>> 0) >= 0x7ff - 0x001 || (((topy & 0x7ff) - 0x3be) >>> 0) >= 0x43e - 0x3be) {
    // x < 2^-1022 or inf or nan, or |y| < 2^-65 or |y| >= 2^63 or nan
    if (y === 0 || !Number.isFinite(y)) {
      if (y === 0) return 1.0;
      if (x === 1) return 1.0;
      // (x + y of NaNs: x86's and ARM's addition returns the first NaN; V8
      // may commute it, so the operand is chosen here)
      if (x !== x || y !== y) return x !== x ? x : y;
      if (Math.abs(x) === 1) return 1.0;
      if ((Math.abs(x) < 1) === (y > 0)) return 0.0; // |x|<1 && y==inf or |x|>1 && y==-inf
      return y * y;
    }
    if (x === 0 || !Number.isFinite(x)) {
      let x2 = x * x;
      if (phi(x) >>> 31 && checkint(y) === 1) x2 = -x2; // (the sign bit: a NaN's too)
      return y < 0 ? 1 / x2 : x2;
    }
    // x and y are non-zero finite
    if (x < 0) {
      const yint = checkint(y);
      // (glibc's __math_invalid: the NaN of 0 / 0, whose sign is the
      // hardware's, negative on x86, as NumPy's)
      if (yint === 0) return (x - x) / (x - x);
      if (yint === 1) neg = true;
      x = -x;
    }
    const ty = topy & 0x7ff;
    if (((ty - 0x3be) >>> 0) >= 0x43e - 0x3be) {
      if (x === 1) return neg ? -1.0 : 1.0;
      if (ty < 0x3be) return x > 1 ? 1.0 + y : 1.0 - y; // |y| < 2^-65: x^y ~= 1 + y log(x)
      return (x > 1) === (y > 0) ? Infinity : 0;
    }
  }
  const hi = powLog(x), lo = POW_TAIL;
  const ehi = y * hi;
  const elo = y * lo + fma(y, hi, -ehi);
  return powExp(ehi, elo, neg);
}

// glibc's powf (ARM optimized-routines math/powf.c, MIT OR Apache-2.0 WITH
// LLVM-exception, Copyright (c) 2017-2026 Arm Limited), the path glibc's
// x86-64 build takes (no TOINT_INTRINSICS: POWF_SCALE 1, exp2's k by the
// 0x1.8p52 / N shift; WANT_ROUNDING and WANT_ERRNO_UFLOW), ported line by
// line: log2 x in double from a 16-entry table and a degree-5 polynomial,
// y log2 x, then 2^(y log2 x) from a 32-entry table and a cubic, rounded to
// float once.  It is not correctly rounded (0.82 ulp), so it is ported, not
// replaced: NumPy's float32 power calls it (a port checked on 197,105 pairs,
// all identical).  The tables: math/powf_log2_data.c, math/exp2f_data.c.
const POWF_TAB = [
  [1.398907162146528, -0.48430022186289673],
  [1.3403141896637998, -0.42257122959194704],
  [1.286432210124115, -0.3633754347673556],
  [1.2367150214269895, -0.30651309567405577],
  [1.1906977166711752, -0.25180720160537634],
  [1.1479821020556429, -0.19910014943794563],
  [1.1082251448272158, -0.14825100623281615],
  [1.0711297413057381, -0.09913323807318392],
  [1.036437278977283, -0.051632812977629436],
  [1.0, 0.0],
  [0.9492859795739057, 0.07508531937943004],
  [0.8951049428609004, 0.15987125980713107],
  [0.8476821620351103, 0.2384046664317681],
  [0.8050314851692001, 0.31288288605863257],
  [0.7664671008843108, 0.38370422656453185],
  [0.731428603316328, 0.451211048935815],
];
const POWF_A = [0.288457581109214, -0.36092606229713164, 0.480898481472577, -0.7213474675006291, 1.4426950408774342];
// 2^(i/32) as the words of tab[i] = bits(2^(i/32)) - (i << 47), high then low
const EXP2F_TAB = new Uint32Array([0x3ff00000, 0x00000000, 0x3fefd9b0, 0xd3158574, 0x3fefb558, 0x6cf9890f, 0x3fef9301, 0xd0125b51, 0x3fef72b8, 0x3c7d517b, 0x3fef5487, 0x3168b9aa, 0x3fef387a, 0x6e756238, 0x3fef1e9d, 0xf51fdee1, 0x3fef06fe, 0x0a31b715, 0x3feef1a7, 0x373aa9cb, 0x3feedea6, 0x4c123422, 0x3feece08, 0x6061892d, 0x3feebfda, 0xd5362a27, 0x3feeb42b, 0x569d4f82, 0x3feeab07, 0xdd485429, 0x3feea47e, 0xb03a5585, 0x3feea09e, 0x667f3bcd, 0x3fee9f75, 0xe8ec5f74, 0x3feea114, 0x73eb0187, 0x3feea589, 0x994cce13, 0x3feeace5, 0x422aa0db, 0x3feeb737, 0xb0cdc5e5, 0x3feec491, 0x82a3f090, 0x3feed503, 0xb23e255d, 0x3feee89f, 0x995ad3ad, 0x3feeff76, 0xf2fb5e47, 0x3fef199b, 0xdd85529c, 0x3fef3720, 0xdcef9069, 0x3fef5818, 0xdcfba487, 0x3fef7c97, 0x337b9b5f, 0x3fefa4af, 0xa2a490da, 0x3fefd076, 0x5b6e4540]);
const EXP2F_C = [0.05550361559341535, 0.2402284522445722, 0.6931471806916203];
const EXP2F_SHIFT = 211106232532992.0;
const ff = new Float32Array(1), fu = new Uint32Array(ff.buffer);
const f32bits = (x: number): number => ((ff[0] = x), fu[0]);
const f32of = (u: number): number => ((fu[0] = u), ff[0]);
const fround = Math.fround;
const zeroinfnanf = (i: number): boolean => ((((2 * i) >>> 0) - 1) >>> 0) >= 0xfeffffff;
// 0: y is not an integer, 1: odd, 2: even
function checkintf(iy: number): number {
  const e = (iy >>> 23) & 0xff;
  if (e < 0x7f) return 0;
  if (e > 0x7f + 23) return 2;
  if (iy & ((1 << (0x7f + 23 - e)) - 1)) return 0;
  if (iy & (1 << (0x7f + 23 - e))) return 1;
  return 2;
}
function powfLog2(ix: number): number {
  const tmp = (ix - 0x3f330000) >>> 0;
  const i = (tmp >>> 19) % 16;
  const top = (tmp & 0xff800000) >>> 0;
  const iz = (ix - top) >>> 0;
  const k = (top | 0) >> 23; // (arithmetic shift)
  const [invc, logc] = POWF_TAB[i];
  const z = f32of(iz);
  const r = z * invc - 1;
  const y0 = logc + k;
  const r2 = r * r;
  let y = POWF_A[0] * r + POWF_A[1];
  const p = POWF_A[2] * r + POWF_A[3];
  const r4 = r2 * r2;
  let q = POWF_A[4] * r + y0;
  q = p * r2 + q;
  y = y * r4 + q;
  return y;
}
function powfExp2(xd: number, signBias: number): number {
  let kd = xd + EXP2F_SHIFT;
  const kiLo = plo(kd); // (ki's low word: its low bits are k)
  kd -= EXP2F_SHIFT;
  const r = xd - kd;
  // t = tab[ki % 32] + ((ki + sign_bias) << 47): only the high word changes
  const j = kiLo & 31;
  const ski = (kiLo + signBias) >>> 0;
  const s = bitsToDouble((EXP2F_TAB[2 * j] + ((ski << 15) >>> 0)) >>> 0, EXP2F_TAB[2 * j + 1]);
  const z = EXP2F_C[0] * r + EXP2F_C[1];
  const r2 = r * r;
  let y = EXP2F_C[2] * r + 1;
  y = z * r2 + y;
  y = y * s;
  return fround(y);
}
// (glibc's __math_xflowf: (sign ? -y : y) * y, in float)
const xflowf = (sign: number, y: number): number => fround((sign ? -y : y) * y);
/** x^y as glibc's powf (x and y float32 values; the float32 result) */
export function glibcPowf(x: number, y: number): number {
  let signBias = 0;
  let ix = f32bits(x);
  const iy = f32bits(y);
  if (((ix - 0x00800000) >>> 0) >= 0x7f800000 - 0x00800000 || zeroinfnanf(iy)) {
    // x < 0x1p-126 or inf or nan, or y is 0 or inf or nan
    if (zeroinfnanf(iy)) {
      if (((2 * iy) >>> 0) === 0) return 1;
      if (ix === 0x3f800000) return 1;
      if (((2 * ix) >>> 0) > 2 * 0x7f800000 || ((2 * iy) >>> 0) > 2 * 0x7f800000) return x !== x ? x : y; // (x + y of NaNs: the first)
      if (((2 * ix) >>> 0) === 2 * 0x3f800000) return 1;
      if ((((2 * ix) >>> 0) < 2 * 0x3f800000) === !(iy & 0x80000000)) return 0; // |x| < 1 && y == inf or |x| > 1 && y == -inf
      return fround(y * y);
    }
    if (zeroinfnanf(ix)) {
      let x2 = fround(x * x);
      if (ix & 0x80000000 && checkintf(iy) === 1) x2 = -x2;
      return iy & 0x80000000 ? fround(1 / x2) : x2;
    }
    // x and y are non-zero finite
    if (ix & 0x80000000) {
      // finite x < 0
      const yint = checkintf(iy);
      if (yint === 0) return (x - x) / (x - x); // (glibc's __math_invalidf: 0 / 0, the hardware's NaN)
      if (yint === 1) signBias = 1 << (5 + 11);
      ix = (ix & 0x7fffffff) >>> 0;
    }
    if (ix < 0x00800000) {
      // subnormal x: normalized so its exponent becomes negative
      ix = (f32bits(fround(f32of(ix) * 8388608)) & 0x7fffffff) >>> 0;
      ix = (ix - (23 << 23)) >>> 0;
    }
  }
  const ylogx = y * powfLog2(ix);
  // |y log2 x| >= 126
  if (((phi(ylogx) >>> 15) & 0xffff) >= (phi(126) >>> 15)) {
    if (ylogx <= -150) return xflowf(signBias, 2.524354896707238e-29);
    if (ylogx < -149) return xflowf(signBias, 3.3087224502121107e-23);
    if (ylogx > 127.99999991400867) {
      if (ylogx > 127.99999995700433) return xflowf(signBias, 1.5845632502852868e+29);
      // (round to nearest: 1 + 2^-25 is 1, so the largest float)
      return signBias ? -3.4028234663852886e38 : 3.4028234663852886e38;
    }
  }
  return powfExp2(ylogx, signBias);
}
