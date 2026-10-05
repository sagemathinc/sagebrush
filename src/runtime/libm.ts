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
  if (x >= 0.9375 && x < 1.064697265625) {
    if (x === 1) return 0;
    const r = x - 1.0, r2 = r * r, r3 = r * r2;
    let y = r3 * (B[1] + r * B[2] + r2 * B[3] + r3 * (B[4] + r * B[5] + r2 * B[6] + r3 * (B[7] + r * B[8] + r2 * B[9] + r3 * B[10])));
    let w = r * 134217728;
    const rhi = r + w - w, rlo = r - rhi;
    w = rhi * rhi * B[0];
    const hi = r + w;
    let lo = r - hi + w;
    lo += B[0] * rlo * (rhi + r);
    y += lo;
    y += hi;
    return y;
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
// multiply-adds; fma() below reproduces that (exactly in all but vanishingly
// rare double-rounding cases).
function fma(a: number, b: number, c: number): number {
  const p = a * b;
  const ca = 134217729 * a, ah = ca - (ca - a), al = a - ah;
  const cb = 134217729 * b, bh = cb - (cb - b), bl = b - bh;
  const e = ah * bh - p + ah * bl + al * bh + al * bl;
  const s = p + c, bb = s - p, t = p - (s - bb) + (c - bb);
  return s + (t + e);
}
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
  const tmp = TAIL[i] + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
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
  const tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
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
