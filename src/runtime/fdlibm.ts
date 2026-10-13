// Elementary functions that give the same bits in every JavaScript engine
// (design/timetravel-replay.md: TimeTravel replays a session in another
// browser).  Math.sin and friends are not specified to the last bit: V8
// (Chrome, Node) has its own fdlibm port, JavaScriptCore (Safari) calls the
// system's libm, and they disagree on 1-38% of inputs.  These are ported line
// by line from the Rust libm crate 0.2.16 (MIT OR Apache-2.0), itself from
// musl, FreeBSD's msun and Sun's fdlibm (and CORE-MATH's cbrt), and use only
// +, -, *, / and sqrt, which IEEE 754 and JavaScript define exactly.  They
// agree bit for bit with that crate compiled to WebAssembly (checked on 2*10^6
// inputs per function: bench/libm-oracle; test/fdlibm.test.ts checks that
// V8 and JavaScriptCore compute the same bits, and glibc's where so ported).
//
// fdlibm's notice, preserved as it requires:
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunPro, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this software is freely
//   granted, provided that this notice is preserved.
// The Rust libm crate: Copyright (c) 2018 Jorge Aparicio (MIT); musl:
// Copyright © 2005-2020 Rich Felker, et al. (MIT); CORE-MATH's cbrt:
// Copyright (c) 2021-2022 Alexei Sibidanov (MIT).  (NOTICE.md has the texts.)
// expm1, sinh, cosh, tanh and log10 below follow glibc instead (fdlibm's
// originals over glibc's exp and log, with GCC's fused multiply-adds where
// they matter), and hypot V8 (as numpy_linalg's kernels).

import { glibcLog, glibcExp, glibcPow } from "./libm";

// ------------------------------------------------------------ the bits of a double
const F = new Float64Array(1), U = new Uint32Array(F.buffer); // (little-endian: U[1] is the high word)
const hiw = (x: number): number => ((F[0] = x), U[1]);
const low = (x: number): number => ((F[0] = x), U[0]);
const words = (h: number, l: number): number => ((U[1] = h), (U[0] = l), F[0]);
const zeroLow = (x: number): number => ((F[0] = x), (U[0] = 0), F[0]);
const trunc = Math.trunc;
// a*b + c rounded once (Dekker's product, then a compensated sum: as libm.ts)
function fmaX(a: number, b: number, c: number): number {
  const p = a * b;
  const ca = 134217729 * a, ah = ca - (ca - a), al = a - ah;
  const cb = 134217729 * b, bh = cb - (cb - b), bl = b - bh;
  const e = ah * bh - p + ah * bl + al * bh + al * bl;
  const s = p + c, bb = s - p, t = p - (s - bb) + (c - bb);
  return s + (t + e);
}
// a C99 hexadecimal floating-point literal, exactly
function hf(s: string): number {
  const m = /^(-?)0x([0-9a-f])\.([0-9a-f]*)p([+-]?\d+)$/i.exec(s)!;
  const v = (parseInt(m[2] + m[3], 16) / 16 ** m[3].length) * 2 ** +m[4];
  return m[1] ? -v : v;
}

/** x * 2^n, as C's scalbn (no double rounding in the subnormal range) */
export function scalbn(x: number, n: number): number {
  if (n > 1023) {
    x *= 2 ** 1023;
    n -= 1023;
    if (n > 1023) {
      x *= 2 ** 1023;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    x *= 2 ** -969; // 2^-1022 * 2^53
    n += 969;
    if (n < -1022) {
      x *= 2 ** -969;
      n += 969;
      if (n < -1022) n = -1022;
    }
  }
  return x * 2 ** n;
}

// ------------------------------------------------------------ sin, cos, tan
const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4,
  S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10;
function kSin(x: number, y: number, iy: number): number {
  const z = x * x, w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5,
  C4 = -2.75573143513906633035e-7, C5 = 2.08757232129817482790e-9, C6 = -1.13596475577881948265e-11;
function kCos(x: number, y: number): number {
  const z = x * x, w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const w1 = 1.0 - hz;
  return w1 + (((1.0 - w1) - hz) + (z * r - x * y));
}
const T = [3.33333333333334091986e-1, 1.33333333333201242699e-1, 5.39682539762260521377e-2, 2.18694882948595424599e-2,
  8.86323982359930005737e-3, 3.59207910759131235356e-3, 1.45620945432529025516e-3, 5.88041240820264096874e-4,
  2.46463134818469906812e-4, 7.81794442939557092300e-5, 7.14072491382608190305e-5, -1.85586374855275456654e-5,
  2.59073051863633712884e-5];
const PIO4 = 7.85398163397448278999e-1, PIO4_LO = 3.06161699786838301793e-17;
function kTan(x: number, y: number, odd: number): number {
  const hx = hiw(x);
  const big = (hx & 0x7fffffff) >= 0x3fe59428; // |x| >= 0.6744
  if (big) {
    if (hx >>> 31) { x = -x; y = -y; }
    x = (PIO4 - x) + (PIO4_LO - y);
    y = 0.0;
  }
  const z = x * x, w = z * z;
  let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  const v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  const s = z * x;
  r = y + z * (s * (r + v) + y) + s * T[0];
  const w1 = x + r;
  if (big) {
    const s1 = 1.0 - 2.0 * odd;
    const v1 = s1 - 2.0 * (x + (r - (w1 * w1) / (w1 + s1)));
    return hx >>> 31 ? -v1 : v1;
  }
  if (odd === 0) return w1;
  // -1.0/(x+r) has up to 2ulp error, so compute it accurately
  const w0 = zeroLow(w1);
  const v2 = r - (w0 - x);
  const a = -1.0 / w1;
  const a0 = zeroLow(a);
  return a0 + a * (1.0 + a0 * w0 + a0 * v2);
}

// x = n pi/2 + (y0 + y1), |y0 + y1| <= pi/4: the results in RN, RY0, RY1
let RN = 0, RY0 = 0, RY1 = 0;
const TO_INT = 1.5 / 2.2204460492503131e-16, INV_PIO2 = 6.36619772367581382433e-1,
  PIO2_1 = 1.57079632673412561417e+0, PIO2_1T = 6.07710050650619224932e-11, PIO2_2 = 6.07710050630396597660e-11,
  PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
function medium(x: number, ix: number): void {
  const tmp = x * INV_PIO2 + TO_INT;
  const fn = tmp - TO_INT;
  const n = trunc(fn);
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T; // 1st round, good to 85 bits
  let y0 = r - w;
  const ex = ix >>> 20;
  if (ex - ((hiw(y0) >>> 20) & 0x7ff) > 16) {
    // 2nd round, good to 118 bits
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - ((t - r) - w);
    y0 = r - w;
    if (ex - ((hiw(y0) >>> 20) & 0x7ff) > 49) {
      // 3rd round, good to 151 bits, covers all cases
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - ((t - r) - w);
      y0 = r - w;
    }
  }
  RN = n;
  RY0 = y0;
  RY1 = (r - y0) - w;
}
function remPio2(x: number): void {
  const h = hiw(x), sign = h >>> 31, ix = h & 0x7fffffff;
  const near = (k: number) => {
    // |x| ~<= 9pi/4: x - k pi/2 in one round, good to 85 bits
    if (sign === 0) {
      const z = x - k * PIO2_1;
      RY0 = z - k * PIO2_1T;
      RY1 = (z - RY0) - k * PIO2_1T;
      RN = k;
    } else {
      const z = x + k * PIO2_1;
      RY0 = z + k * PIO2_1T;
      RY1 = (z - RY0) + k * PIO2_1T;
      RN = -k;
    }
  };
  if (ix <= 0x400f6a7a) {
    // |x| ~<= 5pi/4
    if ((ix & 0xfffff) === 0x921fb) return medium(x, ix); // |x| ~= pi/2 or 2pi/2: cancellation
    return near(ix <= 0x4002d97c ? 1 : 2);
  }
  if (ix <= 0x401c463b) {
    // |x| ~<= 9pi/4
    if (ix <= 0x4015fdbc) {
      if (ix === 0x4012d97c) return medium(x, ix); // |x| ~= 3pi/2
      return near(3);
    }
    if (ix === 0x401921fb) return medium(x, ix); // |x| ~= 4pi/2
    return near(4);
  }
  if (ix < 0x413921fb) return medium(x, ix); // |x| ~< 2^20 pi/2
  if (ix >= 0x7ff00000) {
    RN = 0;
    RY0 = RY1 = x - x;
    return;
  }
  // z = scalbn(|x|, -ilogb(x) + 23)
  let z = words((h & 0x000fffff) | ((0x3ff + 23) << 20), low(x));
  const tx = [0, 0, 0];
  for (let i = 0; i < 2; i++) {
    tx[i] = trunc(z);
    z = (z - tx[i]) * 16777216;
  }
  tx[2] = z;
  let i = 2;
  while (i !== 0 && tx[i] === 0) i--;
  const ty = [0, 0, 0];
  const n = remPio2Large(tx.slice(0, i + 1), ty, (ix >>> 20) - (0x3ff + 23), 1);
  if (sign) {
    RN = -n;
    RY0 = -ty[0];
    RY1 = -ty[1];
  } else {
    RN = n;
    RY0 = ty[0];
    RY1 = ty[1];
  }
}
// 2/pi in 24-bit chunks (the table of the 32-bit build, which the WebAssembly build uses)
const IPIO2 = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7,
  0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c,
  0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11,
  0x8b5a0a, 0x6d1f6d, 0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7,
  0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e,
  0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];
const PIO2 = [1.57079625129699707031e+0, 7.54978941586159635335e-8, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
  1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51];
const INIT_JK = [3, 4, 4, 6];
function remPio2Large(x: number[], y: number[], e0: number, prec: number): number {
  const x1p24 = 16777216, x1p_24 = 1 / 16777216;
  const nx = x.length;
  let fw: number, n: number, ih: number, z: number;
  const f = new Array(20).fill(0), fq = new Array(20).fill(0), q = new Array(20).fill(0), iq = new Array(20).fill(0);
  const jk = INIT_JK[prec], jp = jk, jx = nx - 1;
  let jv = trunc((e0 - 3) / 24);
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);
  let j = jv - jx;
  const m = jx + jk;
  for (let i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0 : IPIO2[j];
  for (let i = 0; i <= jk; i++) {
    fw = 0;
    for (let k = 0; k <= jx; k++) fw += x[k] * f[jx + i - k];
    q[i] = fw;
  }
  let jz = jk;
  for (;;) {
    // distill q[] into iq[] reversingly
    let i = 0;
    z = q[jz];
    for (let k = jz; k >= 1; k--) {
      fw = trunc(x1p_24 * z);
      iq[i] = trunc(z - x1p24 * fw);
      z = q[k - 1] + fw;
      i++;
    }
    // compute n
    z = scalbn(z, q0); // actual value of z
    z -= 8.0 * Math.floor(z * 0.125); // trim off integer >= 8
    n = trunc(z);
    z -= n;
    ih = 0;
    if (q0 > 0) {
      // need iq[jz-1] to determine n
      i = iq[jz - 1] >> (24 - q0);
      n += i;
      iq[jz - 1] -= i << (24 - q0);
      ih = iq[jz - 1] >> (23 - q0);
    } else if (q0 === 0) ih = iq[jz - 1] >> 23;
    else if (z >= 0.5) ih = 2;
    if (ih > 0) {
      // q > 0.5
      n += 1;
      let carry = 0;
      for (let k = 0; k < jz; k++) {
        const t = iq[k];
        if (carry === 0) {
          if (t !== 0) {
            carry = 1;
            iq[k] = 0x1000000 - t;
          }
        } else iq[k] = 0xffffff - t;
      }
      if (q0 > 0) {
        // rare case: chance is 1 in 12
        if (q0 === 1) iq[jz - 1] &= 0x7fffff;
        else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
      }
      if (ih === 2) {
        z = 1.0 - z;
        if (carry !== 0) z -= scalbn(1.0, q0);
      }
    }
    // check if recomputation is needed
    if (z === 0) {
      let t = 0;
      for (let k = jz - 1; k >= jk; k--) t |= iq[k];
      if (t === 0) {
        // need recomputation
        let k = 1;
        while (iq[jk - k] === 0) k++; // k = no. of terms needed
        for (let ii = jz + 1; ii <= jz + k; ii++) {
          // add q[jz+1] to q[jz+k]
          f[jx + ii] = IPIO2[jv + ii];
          fw = 0;
          for (let kk = 0; kk <= jx; kk++) fw += x[kk] * f[jx + ii - kk];
          q[ii] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }
  // chop off zero terms
  if (z === 0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    // break z into 24-bit if necessary
    z = scalbn(z, -q0);
    if (z >= x1p24) {
      fw = trunc(x1p_24 * z);
      iq[jz] = trunc(z - x1p24 * fw);
      jz += 1;
      q0 += 24;
      iq[jz] = trunc(fw);
    } else iq[jz] = trunc(z);
  }
  // convert integer "bit" chunk to floating-point value
  fw = scalbn(1.0, q0);
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= x1p_24;
  }
  // compute PIo2[0,...,jp]*q[jz,...,0]
  for (let i = jz; i >= 0; i--) {
    fw = 0;
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * q[i + k];
    fq[jz - i] = fw;
  }
  // compress fq[] into y[] (prec 1: two terms)
  fw = 0;
  for (let i = jz; i >= 0; i--) fw += fq[i];
  y[0] = ih === 0 ? fw : -fw;
  fw = fq[0] - fw;
  for (let i = 1; i <= jz; i++) fw += fq[i];
  y[1] = ih === 0 ? fw : -fw;
  return n & 7;
}

export function sin(x: number): number {
  const ix = hiw(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e500000) return x; // |x| < 2^-26
    return kSin(x, 0.0, 0);
  }
  if (ix >= 0x7ff00000) return x - x; // inf or NaN
  remPio2(x);
  switch (RN & 3) {
    case 0: return kSin(RY0, RY1, 1);
    case 1: return kCos(RY0, RY1);
    case 2: return -kSin(RY0, RY1, 1);
    default: return -kCos(RY0, RY1);
  }
}
export function cos(x: number): number {
  const ix = hiw(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1.0; // |x| < 2^-27 sqrt(2)
    return kCos(x, 0.0);
  }
  if (ix >= 0x7ff00000) return x - x;
  remPio2(x);
  switch (RN & 3) {
    case 0: return kCos(RY0, RY1);
    case 1: return -kSin(RY0, RY1, 1);
    case 2: return -kCos(RY0, RY1);
    default: return kSin(RY0, RY1, 1);
  }
}
export function tan(x: number): number {
  const ix = hiw(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    return kTan(x, 0.0, 0);
  }
  if (ix >= 0x7ff00000) return x - x;
  remPio2(x);
  return kTan(RY0, RY1, RN & 1);
}

// ------------------------------------------------------------ asin, acos, atan, atan2
const PIO2_HI = 1.57079632679489655800e+0, PIO2_LO = 6.12323399573676603587e-17;
const PS0 = 1.66666666666666657415e-1, PS1 = -3.25565818622400915405e-1, PS2 = 2.01212532134862925881e-1,
  PS3 = -4.00555345006794114027e-2, PS4 = 7.91534994289814532176e-4, PS5 = 3.47933107596021167570e-5,
  QS1 = -2.40339491173441421878e+0, QS2 = 2.02094576023350569471e+0, QS3 = -6.88283971605453293030e-1,
  QS4 = 7.70381505559019352791e-2;
function rAsin(z: number): number {
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  const q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  return p / q;
}
export function asin(x: number): number {
  const hx = hiw(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    // |x| >= 1 or NaN
    if (((ix - 0x3ff00000) | low(x)) === 0) return x * PIO2_HI + 2 ** -120; // asin(+-1) = +-pi/2
    return 0.0 / (x - x);
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix >= 0x00100000 && ix < 0x3e500000) return x;
    return x + x * rAsin(x * x);
  }
  // 1 > |x| >= 0.5
  const z = (1.0 - Math.abs(x)) * 0.5;
  const s = Math.sqrt(z);
  const r = rAsin(z);
  let y: number;
  if (ix >= 0x3fef3333) y = PIO2_HI - (2 * (s + s * r) - PIO2_LO); // |x| > 0.975
  else {
    const f = zeroLow(s);
    const c = (z - f * f) / (s + f);
    y = 0.5 * PIO2_HI - (2.0 * s * r - (PIO2_LO - 2.0 * c) - (0.5 * PIO2_HI - 2.0 * f));
  }
  return hx >>> 31 ? -y : y;
}
export function acos(x: number): number {
  const x1p_120 = 2 ** -120;
  const hx = hiw(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | low(x)) === 0) return hx >>> 31 ? 2 * PIO2_HI + x1p_120 : 0; // acos(1) = 0, acos(-1) = pi
    return 0 / (x - x);
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix <= 0x3c600000) return PIO2_HI + x1p_120; // |x| < 2^-57
    return PIO2_HI - (x - (PIO2_LO - x * rAsin(x * x)));
  }
  if (hx >>> 31) {
    // x < -0.5
    const z = (1.0 + x) * 0.5;
    const s = Math.sqrt(z);
    const w = rAsin(z) * s - PIO2_LO;
    return 2 * (PIO2_HI - (s + w));
  }
  // x > 0.5
  const z = (1.0 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = zeroLow(s);
  const c = (z - df * df) / (s + df);
  const w = rAsin(z) * s + c;
  return 2 * (df + w);
}
const ATANHI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e+0];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2];
export function atan(x: number): number {
  const h = hiw(x), sign = h >>> 31, ix = h & 0x7fffffff;
  if (ix >= 0x44100000) {
    // |x| >= 2^66
    if (x !== x) return x;
    const z = ATANHI[3] + words(0, 0x03800000); // (as the crate: a subnormal, f64::from_bits(0x0380_0000))
    return sign ? -z : z;
  }
  let id: number;
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      // |x| < 1.1875
      if (ix < 0x3fe60000) { x = (2.0 * x - 1.0) / (2.0 + x); id = 0; } // 7/16 <= |x| < 11/16
      else { x = (x - 1.0) / (x + 1.0); id = 1; } // 11/16 <= |x| < 19/16
    } else if (ix < 0x40038000) { x = (x - 1.5) / (1.0 + 1.5 * x); id = 2; } // |x| < 2.4375
    else { x = -1.0 / x; id = 3; } // 2.4375 <= |x| < 2^66
  }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - (x * (s1 + s2) - ATANLO[id] - x);
  return sign ? -r : r;
}
const PI = 3.1415926535897931160e+0, PI_LO = 1.2246467991473531772e-16;
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y;
  let ix = hiw(x);
  const lx = low(x);
  let iy = hiw(y);
  const ly = low(y);
  if ((((ix - 0x3ff00000) >>> 0) | lx) === 0) return atan(y); // x = 1.0
  const m = ((iy >>> 31) & 1) | ((ix >>> 30) & 2); // 2*sign(x) + sign(y)
  ix &= 0x7fffffff;
  iy &= 0x7fffffff;
  if ((iy | ly) === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI; // y = 0
  if ((ix | lx) === 0) return m & 1 ? -PI / 2 : PI / 2; // x = 0
  if (ix === 0x7ff00000) {
    // x is inf
    if (iy === 0x7ff00000) return [PI / 4, -PI / 4, (3 * PI) / 4, (-3 * PI) / 4][m];
    return [0.0, -0.0, PI, -PI][m];
  }
  if (((ix + (64 << 20)) >>> 0) < iy || iy === 0x7ff00000) return m & 1 ? -PI / 2 : PI / 2; // |y/x| > 2^64
  // z = atan(|y/x|) without spurious underflow
  const z = m & 2 && ((iy + (64 << 20)) >>> 0) < ix ? 0.0 : atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// ------------------------------------------------------------ exp, log, log1p, expm1 (fdlibm's)
const LN2HI = 6.93147180369123816490e-1, LN2LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+0;
const P1 = 1.66666666666666019037e-1, P2 = -2.77777777770155933842e-3, P3 = 6.61375632143793436117e-5,
  P4 = -1.65339022054652515390e-6, P5 = 4.13813679705723846039e-8;
/** fdlibm's exp (used by sinh, cosh: math.exp itself is glibc's, libm.ts) */
export function exp(x: number): number {
  let hx = hiw(x);
  const sign = hx >>> 31;
  hx &= 0x7fffffff;
  if (hx >= 0x4086232b) {
    // |x| >= 708.39 or NaN
    if (x !== x) return x;
    if (x > 709.782712893383973096) return x * 2 ** 1023; // overflow
    if (x < -708.39641853226410622 && x < -745.13321910194110842) return 0;
  }
  let hi: number, lo: number, k: number;
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx >= 0x3ff0a2b2) k = trunc(INVLN2 * x + (sign ? -0.5 : 0.5)); // |x| >= 1.5 ln2
    else k = 1 - sign - sign;
    hi = x - k * LN2HI; // k*ln2hi is exact here
    lo = k * LN2LO;
    x = hi - lo;
  } else if (hx > 0x3e300000) {
    // |x| > 2^-28
    k = 0;
    hi = x;
    lo = 0;
  } else return 1 + x;
  const xx = x * x;
  const c = x - xx * (P1 + xx * (P2 + xx * (P3 + xx * (P4 + xx * P5))));
  const y = 1 + ((x * c) / (2 - c) - lo + hi);
  return k === 0 ? y : scalbn(y, k);
}
const LG1 = 6.666666666666735130e-1, LG2 = 3.999999999940941908e-1, LG3 = 2.857142874366239149e-1,
  LG4 = 2.222219843214978396e-1, LG5 = 1.818357216161805012e-1, LG6 = 1.531383769920937332e-1, LG7 = 1.479819860511658591e-1;
// log's reduction: x = 2^K (1 + LF) with sqrt(2)/2 < 1 + LF < sqrt(2); false for a special x (its result in LS)
let LK = 0, LF = 0, LS = 0;
function logReduce(x: number): boolean {
  let hx = hiw(x);
  LK = 0;
  if (hx < 0x00100000 || hx >>> 31) {
    if ((hx & 0x7fffffff) === 0 && low(x) === 0) { LS = -1 / (x * x); return false; } // log(+-0) = -inf
    if (hx >>> 31) { LS = (x - x) / 0.0; return false; } // log(-#) = NaN
    // subnormal number, scale x up
    LK -= 54;
    x *= 18014398509481984; // 2^54
    hx = hiw(x);
  } else if (hx >= 0x7ff00000) { LS = x; return false; }
  else if (hx === 0x3ff00000 && low(x) === 0) { LS = 0; return false; }
  // reduce x into [sqrt(2)/2, sqrt(2)]
  hx = (hx + (0x3ff00000 - 0x3fe6a09e)) >>> 0;
  LK += (hx >>> 20) - 0x3ff;
  hx = (hx & 0x000fffff) + 0x3fe6a09e;
  LF = words(hx, low(x)) - 1.0;
  return true;
}
/** fdlibm's log (used by asinh, acosh: math.log itself is glibc's, libm.ts) */
export function log(x: number): number {
  if (!logReduce(x)) return LS;
  const f = LF, hfsq = 0.5 * f * f, s = f / (2.0 + f), z = s * s, w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1, dk = LK;
  return s * (hfsq + r) + dk * LN2LO - hfsq + f + dk * LN2HI;
}
export function log2(x: number): number {
  if (!logReduce(x)) return LS;
  const f = LF, hfsq = 0.5 * f * f, s = f / (2.0 + f), z = s * s, w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  // hi+lo = f - hfsq + s*(hfsq+R) ~ log(1+f)
  const hi = zeroLow(f - hfsq);
  const lo = f - hi - hfsq + s * (hfsq + r);
  let valHi = hi * 1.44269504072144627571e+0;
  let valLo = (lo + hi) * 1.67517131648865118353e-10 + lo * 1.44269504072144627571e+0;
  const y = LK;
  const w1 = y + valHi;
  valLo += (y - w1) + valHi;
  valHi = w1;
  return valLo + valHi;
}
/** musl's log10 (the oracle test's); math.log10 is glibc's, log10() below */
export function muslLog10(x: number): number {
  if (!logReduce(x)) return LS;
  const f = LF, hfsq = 0.5 * f * f, s = f / (2.0 + f), z = s * s, w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  const hi = zeroLow(f - hfsq);
  const lo = f - hi - hfsq + s * (hfsq + r);
  let valHi = hi * 4.34294481878168880939e-1;
  const dk = LK;
  const y = dk * 3.01029995663611771306e-1;
  let valLo = dk * 3.69423907715893078616e-13 + (lo + hi) * 2.50829467116452752298e-11 + lo * 4.34294481878168880939e-1;
  const w1 = y + valHi;
  valLo += (y - w1) + valHi;
  valHi = w1;
  return valLo + valHi;
}
/** fdlibm's log1p (used by asinh, acosh, atanh: math.log1p itself is glibc's, libm.ts) */
export function log1p(x: number): number {
  const hx = hiw(x);
  let k = 1, f = 0, c = 0;
  if (hx < 0x3fda827a || hx >>> 31) {
    // 1 + x < sqrt(2)+
    if (hx >= 0xbff00000) {
      // x <= -1.0
      if (x === -1) return x / 0.0; // log1p(-1) = -inf
      return (x - x) / 0.0; // log1p(x < -1) = NaN
    }
    if (((hx << 1) >>> 0) < 0x3ca00000 * 2) return x; // |x| < 2^-53
    if (hx <= 0xbfd2bec4) {
      // sqrt(2)/2- <= 1 + x < sqrt(2)+
      k = 0;
      c = 0;
      f = x;
    }
  } else if (hx >= 0x7ff00000) return x;
  if (k) {
    const u = 1 + x;
    let hu = hiw(u);
    hu = (hu + (0x3ff00000 - 0x3fe6a09e)) >>> 0;
    k = (hu >>> 20) - 0x3ff;
    // correction term ~ log(1+x) - log(u), avoid underflow in c/u
    if (k < 54) {
      c = k >= 2 ? 1 - (u - x) : x - (u - 1);
      c /= u;
    } else c = 0;
    // reduce u into [sqrt(2)/2, sqrt(2)]
    hu = (hu & 0x000fffff) + 0x3fe6a09e;
    f = words(hu, low(u)) - 1;
  }
  const hfsq = 0.5 * f * f, s = f / (2.0 + f), z = s * s, w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1, dk = k;
  return s * (hfsq + r) + (dk * LN2LO + c) - hfsq + f + dk * LN2HI;
}
const Q1 = -3.33333333333331316428e-2, Q2 = 1.58730158725481460165e-3, Q3 = -7.93650757867487942473e-5,
  Q4 = 4.00821782732936239552e-6, Q5 = -2.01099218183624371326e-7;
/** musl's expm1 (the oracle test's); math.expm1 is glibc's, expm1() below */
export function muslExpm1(x: number): number {
  let hi: number, lo: number, k: number, c: number, t: number, y: number;
  const h = hiw(x), hx = h & 0x7fffffff, sign = h >>> 31;
  // filter out huge and non-finite argument
  if (hx >= 0x4043687a) {
    // |x| >= 56 ln2
    if (x !== x) return x;
    if (sign) return -1;
    if (x > 7.09782712893383973096e+2) return x * 2 ** 1023; // overflow
  }
  // argument reduction
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5 ln2
      if (!sign) { hi = x - LN2HI; lo = LN2LO; k = 1; }
      else { hi = x + LN2HI; lo = -LN2LO; k = -1; }
    } else {
      k = trunc(INVLN2 * x + (sign ? -0.5 : 0.5));
      t = k;
      hi = x - t * LN2HI; // t*ln2_hi is exact here
      lo = t * LN2LO;
    }
    x = hi - lo;
    c = (hi - x) - lo;
  } else if (hx < 0x3c900000) return x; // |x| < 2^-54
  else { c = 0; k = 0; }
  // x is now in primary range
  const hfx = 0.5 * x, hxs = x * hfx;
  const r1 = 1.0 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  t = 3.0 - r1 * hfx;
  let e = hxs * ((r1 - t) / (6.0 - x * t));
  if (k === 0) return x - (x * e - hxs); // c is 0
  e = x * (e - c) - c;
  e -= hxs;
  // exp(x) ~ 2^k (x_reduced - e + 1)
  if (k === -1) return 0.5 * (x - e) - 0.5;
  if (k === 1) {
    if (x < -0.25) return -2.0 * (e - (x + 0.5));
    return 1.0 + 2.0 * (x - e);
  }
  const twopk = words((0x3ff + k) << 20, 0); // 2^k
  if (k < 0 || k > 56) {
    // suffice to return exp(x)-1
    y = x - e + 1.0;
    if (k === 1024) y = y * 2.0 * 2 ** 1023;
    else y = y * twopk;
    return y - 1.0;
  }
  const uf = words((0x3ff - k) << 20, 0); // 2^-k
  if (k < 20) y = (x - e + (1.0 - uf)) * twopk;
  else y = (x - (e + uf) + 1.0) * twopk;
  return y;
}

// ------------------------------------------------------------ hyperbolic functions
// exp(x - k ln2) 2^k for k = 2043, avoiding overflow
const KLN2 = words(0x40962066, 0x151add8b), K2SCALE = words((0x3ff + 1021) << 20, 0);
const expo2 = (x: number): number => exp(x - KLN2) * K2SCALE * K2SCALE;
/** musl's sinh (the oracle test's) */
export function muslSinh(x: number): number {
  const h = 0.5 * (hiw(x) >>> 31 ? -1 : 1);
  const absx = Math.abs(x);
  const w = hiw(absx);
  if (w < 0x40862e42) {
    // |x| < log(DBL_MAX)
    const t = muslExpm1(absx);
    if (w < 0x3ff00000) {
      if (w < 0x3ff00000 - (26 << 20)) return x; // note: inexact and underflow are raised by expm1
      return h * (2.0 * t - (t * t) / (t + 1.0));
    }
    return h * (t + t / (t + 1.0)); // note: |x| > log(0x1p26)+eps could be just h*exp(x)
  }
  // |x| > log(DBL_MAX) or nan: note: the result is stored to handle overflow
  return 2.0 * h * expo2(absx);
}
/** musl's cosh (the oracle test's) */
export function muslCosh(x: number): number {
  x = Math.abs(x);
  const w = hiw(x);
  if (w < 0x3fe62e42) {
    // |x| < log(2)
    if (w < 0x3ff00000 - (26 << 20)) return 1.0;
    const t = muslExpm1(x);
    return 1.0 + (t * t) / (2.0 * (1.0 + t));
  }
  if (w < 0x40862e42) {
    // |x| < log(DBL_MAX)
    const t = exp(x);
    return 0.5 * (t + 1.0 / t); // note: if x>log(0x1p26) then the 1/t is not needed
  }
  return expo2(x); // |x| > log(DBL_MAX) or nan
}
/** musl's tanh (the oracle test's); math.tanh is fdlibm's, tanh() below */
export function muslTanh(x: number): number {
  const sign = hiw(x) >>> 31;
  x = Math.abs(x);
  const w = hiw(x);
  let t: number;
  if (w > 0x3fe193ea) {
    // |x| > log(3)/2 ~= 0.5493 or nan
    if (w > 0x40340000) t = 1.0 - 0.0 / x; // |x| > 20 or nan
    else {
      t = muslExpm1(2.0 * x);
      t = 1.0 - 2.0 / (t + 2.0);
    }
  } else if (w > 0x3fd058ae) {
    // |x| > log(5/3)/2 ~= 0.2554
    t = muslExpm1(2.0 * x);
    t = t / (t + 2.0);
  } else if (w >= 0x00100000) {
    // |x| >= 0x1p-1022, up to 2ulp error in [0.1,0.2554]
    t = muslExpm1(-2.0 * x);
    t = -t / (t + 2.0);
  } else t = x; // |x| is subnormal
  return sign ? -t : t;
}
const LN2 = 0.693147180559945309417232121458176568;
export function asinh(x: number): number {
  const e = (hiw(x) >>> 20) & 0x7ff, sign = hiw(x) >>> 31;
  x = Math.abs(x);
  if (e >= 0x3ff + 26) x = log(x) + LN2; // |x| >= 0x1p26 or inf or nan
  else if (e >= 0x3ff + 1) x = log(2.0 * x + 1.0 / (Math.sqrt(x * x + 1.0) + x)); // |x| >= 2
  else if (e >= 0x3ff - 26) x = log1p(x + (x * x) / (Math.sqrt(x * x + 1.0) + 1.0)); // |x| >= 0x1p-26
  return sign ? -x : x;
}
export function acosh(x: number): number {
  const e = (hiw(x) >>> 20) & 0x7ff;
  if (e < 0x3ff + 1) return log1p(x - 1.0 + Math.sqrt((x - 1.0) * (x - 1.0) + 2.0 * (x - 1.0))); // |x| < 2, invalid if x < 1
  if (e < 0x3ff + 26) return log(2.0 * x - 1.0 / (x + Math.sqrt(x * x - 1.0))); // |x| < 0x1p26
  return log(x) + LN2; // |x| >= 0x1p26 or nan
}
export function atanh(x: number): number {
  const e = (hiw(x) >>> 20) & 0x7ff, sign = hiw(x) >>> 31;
  let y = Math.abs(x);
  if (e < 0x3ff - 1) {
    if (e >= 0x3ff - 32) y = 0.5 * log1p(2.0 * y + (2.0 * y * y) / (1.0 - y)); // |x| >= 0x1p-32
  } else y = 0.5 * log1p(2.0 * (y / (1.0 - y))); // avoid overflow
  return sign ? -y : y;
}

// ------------------------------------------------------------ hypot, cbrt
function sqHi(x: number): number { return x * x; }
function sqLo(x: number): number {
  const xc = x * 134217729.0, xh = x - xc + xc, xl = x - xh;
  return xh * xh - x * x + 2.0 * xh * xl + xl * xl;
}
export function hypot(x: number, y: number): number {
  x = Math.abs(x);
  y = Math.abs(y);
  // arrange |x| >= |y|
  let hx = hiw(x), lx = low(x), hy = hiw(y), ly = low(y);
  if (hx < hy || (hx === hy && lx < ly)) {
    const t = x; x = y; y = t;
    [hx, lx, hy, ly] = [hy, ly, hx, lx];
  }
  const ex = hx >>> 20, ey = hy >>> 20;
  if (ey === 0x7ff) return y; // hypot(inf, nan) == inf
  if (ex === 0x7ff || (hy | ly) === 0) return x;
  if (ex - ey > 64) return x + y;
  let z = 1.0;
  if (ex > 0x3ff + 510) {
    z = 2 ** 700;
    x *= 2 ** -700;
    y *= 2 ** -700;
  } else if (ey < 0x3ff - 450) {
    z = 2 ** -700;
    x *= 2 ** 700;
    y *= 2 ** 700;
  }
  return z * Math.sqrt(sqLo(y) + sqLo(x) + sqHi(y) + sqHi(x));
}
// the rounding error of a*b, exactly (Dekker: fma(a, b, -a*b))
function prodErr(a: number, b: number, p: number): number {
  const ca = 134217729 * a, ah = ca - (ca - a), al = a - ah;
  const cb = 134217729 * b, bh = cb - (cb - b), bl = b - bh;
  return ah * bh - p + ah * bl + al * bh + al * bl;
}
const ESCALE = [1.0, hf("0x1.428a2f98d728bp+0"), hf("0x1.965fea53d6e3dp+0")]; // 1, 2^(1/3), 2^(2/3)
const CB = [hf("0x1.1b0babccfef9cp-1"), hf("0x1.2c9a3e94d1da5p-1"), hf("-0x1.4dc30b1a1ddbap-3"), hf("0x1.7a8d3e4ec9b07p-6")];
const U0 = hf("0x1.5555555555555p-2"), U1 = hf("0x1.c71c71c71c71cp-3");
const CB_X1 = hf("0x1.9b78223aa307cp+1"), CB_Y1 = hf("0x1.79d15d0e8d59cp+0"), CB_X2 = hf("0x1.a202bfc89ddffp+2"), CB_Y2 = hf("0x1.de87aa837820fp+0");
const RSC = [1.0, -1.0, 0.5, -0.5, 0.25, -0.25];
export function cbrt(x: number): number {
  let h = hiw(x), l = low(x);
  const sign = h >>> 31;
  let e = (h >>> 20) & 0x7ff;
  if (((e + 1) & 0x7ff) < 2) {
    if (e === 0x7ff || ((h & 0x7fffffff) | l) === 0) return x + x; // 0, inf, nan
    // subnormal: normalized, with its exponent (as the crate's shift does)
    const y = x * 18446744073709551616; // 2^64
    h = hiw(y);
    l = low(y);
    e = ((h >>> 20) & 0x7ff) - 64;
  }
  e += 3072;
  const et = Math.floor(e / 3), it = e % 3;
  const mh = h & 0x000fffff;
  const z = words(mh | (0x3ff << 20), l); // 1 <= z < 2
  const zz = words((mh | ((0x3ff + it) << 20) | (sign << 31)) >>> 0, l); // 2^it z, signed
  const isc = sign ? -ESCALE[it] : ESCALE[it];
  const r = 1.0 / z;
  const rr = r * RSC[(it << 1) | sign];
  const z2 = z * z;
  const c0 = CB[0] + z * CB[1];
  const c2 = CB[2] + z * CB[3];
  let y = c0 + z2 * c2;
  let y2 = y * y;
  let hh = y2 * (y * r) - 1.0;
  y -= (hh * y) * (U0 - U1 * hh);
  y *= isc;
  y2 = y * y;
  let y2l = prodErr(y, y, y2);
  let y3 = y2 * y;
  let y3l = prodErr(y, y2, y3) + y * y2l;
  hh = ((y3 - zz) + y3l) * rr;
  let dy = hh * (y * U0);
  let y1 = y - dy;
  dy = (y - y1) - dy;
  let ady = Math.abs(dy);
  let ady0 = Math.abs(ady - 2 ** -53);
  let ady1 = Math.abs(ady - (2 ** -52 + 2 ** -53));
  if (ady0 < 2 ** -75 || ady1 < 2 ** -75) {
    y2 = y1 * y1;
    y2l = prodErr(y1, y1, y2);
    y3 = y2 * y1;
    y3l = prodErr(y1, y2, y3) + y1 * y2l;
    hh = ((y3 - zz) + y3l) * rr;
    dy = hh * (y1 * U0);
    y = y1 - dy;
    dy = (y1 - y) - dy;
    y1 = y;
    ady = Math.abs(dy);
    ady0 = Math.abs(ady - 2 ** -53);
    ady1 = Math.abs(ady - (2 ** -52 + 2 ** -53));
    if (ady0 < 2 ** -98 || ady1 < 2 ** -98) {
      const azz = Math.abs(zz);
      if (azz === CB_X1) y1 = sign ? -CB_Y1 : CB_Y1;
      if (azz === CB_X2) y1 = sign ? -CB_Y2 : CB_Y2;
    }
  }
  // the exponent: + (et - 1365)
  let h3 = (hiw(y1) + (et - 342 - 1023) * 1048576) >>> 0;
  let l3 = low(y1);
  if ((h3 & 3) === 0 && l3 <= 1) {
    // (cvt3 << 30) has its top bit clear and is at most 2^30
    const y1h = hiw(y1), y1l = low(y1);
    let l4 = y1l + 164 * 32768, h4 = y1h;
    if (l4 >= 4294967296) { l4 -= 4294967296; h4 = (h4 + 1) >>> 0; }
    l4 = (l4 & 0xffff0000) >>> 0;
    if (Math.abs((words(h4, l4) - y1) - dy) < 2 ** -60 || Math.abs(zz) === 1.0) {
      l3 += 32768;
      if (l3 >= 4294967296) { l3 -= 4294967296; h3 = (h3 + 1) >>> 0; }
      l3 = (l3 & 0xffff0000) >>> 0;
    }
  }
  return words(h3, l3);
}

// ------------------------------------------------------------ tanh and log10 as glibc
/** fdlibm's tanh (s_tanh.c, which glibc and V8 use): V8's bits exactly */
export function tanh(x: number): number {
  const jx = hiw(x) | 0, ix = jx & 0x7fffffff;
  if (ix >= 0x7ff00000) return jx >= 0 ? 1 / x + 1 : 1 / x - 1; // tanh(+-inf) = +-1, tanh(NaN) = NaN
  let z: number;
  if (ix < 0x40360000) {
    // |x| < 22
    if (ix < 0x3c800000) return x * (1 + x); // |x| < 2^-55
    if (ix >= 0x3ff00000) {
      // |x| >= 1
      const t = expm1(2 * Math.abs(x));
      z = 1 - 2 / (t + 2);
    } else {
      const t = expm1(-2 * Math.abs(x));
      z = -t / (t + 2);
    }
  } else z = 1 - 1e-300; // |x| >= 22: return +-1
  return jx >= 0 ? z : -z;
}
/** glibc's log10 (fdlibm's e_log10.c over glibc's log): identical to glibc on 2*10^5 inputs */
export function log10(x: number): number {
  let hx = hiw(x) | 0, k = 0;
  if (hx < 0x00100000) {
    // x < 2^-1022
    if (((hx & 0x7fffffff) | low(x)) === 0) return -Infinity; // log(+-0) = -inf
    if (hx < 0) return (x - x) / 0; // log(-#) = NaN
    k -= 54;
    x *= 18014398509481984; // subnormal number, scale up x
    hx = hiw(x) | 0;
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  const i = (k >>> 31) & 1;
  hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
  const y = k + i;
  const z = y * 3.69423907715893078616e-13 + 4.34294481903251816668e-1 * glibcLog(words(hx, low(x)));
  return z + y * 3.01029995663611771306e-1;
}

// ------------------------------------------------------------ expm1, sinh, cosh as glibc
// fdlibm's s_expm1.c as glibc 2.43's x86-64 FMA build computes it: GCC fuses
// the polynomial and four more products into fused multiply-adds (found
// against glibc: 41 of 2*10^5 inputs still differ, against 173 for fdlibm
// as written, which V8 and musl compute).
const EQ1 = -3.33333333333331316428e-02, EQ2 = 1.58730158725481460165e-03, EQ3 = -7.93650757867487942473e-05,
  EQ4 = 4.00821782732936239552e-06, EQ5 = -2.01099218183624371326e-07;
export function expm1(x: number): number {
  let y: number, hi: number, lo: number, c = 0, t: number, e: number, k: number;
  let hx = hiw(x) | 0;
  const xsb = hx & 0x80000000;
  hx &= 0x7fffffff;
  if (hx >= 0x4043687a) {
    // |x| >= 56 ln2
    if (hx >= 0x40862e42) {
      if (hx >= 0x7ff00000) return ((hx & 0xfffff) | low(x)) !== 0 ? x + x : xsb === 0 ? x : -1.0;
      if (x > 7.09782712893383973096e+02) return Infinity;
    }
    if (xsb !== 0) return -1.0; // x < -56 ln2
  }
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      if (xsb === 0) { hi = x - LN2HI; lo = LN2LO; k = 1; }
      else { hi = x + LN2HI; lo = -LN2LO; k = -1; }
    } else {
      k = trunc(INVLN2 * x + (xsb === 0 ? 0.5 : -0.5));
      t = k;
      hi = x - t * LN2HI;
      lo = t * LN2LO;
    }
    x = hi - lo;
    c = (hi - x) - lo;
  } else if (hx < 0x3c900000) return x; // |x| < 2^-54
  else k = 0;
  const hfx = 0.5 * x, hxs = x * hfx;
  const r1 = fmaX(hxs, fmaX(hxs, fmaX(hxs, fmaX(hxs, fmaX(hxs, EQ5, EQ4), EQ3), EQ2), EQ1), 1.0);
  t = fmaX(-r1, hfx, 3.0);
  e = hxs * ((r1 - t) / fmaX(-x, t, 6.0));
  if (k === 0) return x - fmaX(x, e, -hxs);
  e = fmaX(x, e - c, -c);
  e -= hxs;
  if (k === -1) return 0.5 * (x - e) - 0.5;
  if (k === 1) return x < -0.25 ? -2.0 * (e - (x + 0.5)) : 1.0 + 2.0 * (x - e);
  if (k <= -2 || k > 56) {
    y = 1.0 - (e - x);
    y = k === 1024 ? y * 2.0 * 2 ** 1023 : y * 2 ** k;
    return y - 1.0;
  }
  if (k < 20) {
    t = words((0x3ff00000 - (0x200000 >> k)) >>> 0, 0); // 1 - 2^-k
    y = (t - (e - x)) * 2 ** k;
  } else {
    t = words(((0x3ff - k) << 20) >>> 0, 0); // 2^-k
    y = (x - (e + t) + 1.0) * 2 ** k;
  }
  return y;
}
/** fdlibm's e_sinh.c over glibc's exp and expm1 (as glibc) */
export function sinh(x: number): number {
  const jx = hiw(x) | 0, ix = jx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x + x; // inf or NaN
  const h = jx < 0 ? -0.5 : 0.5;
  if (ix < 0x40360000) {
    // |x| < 22
    if (ix < 0x3e300000) return x; // |x| < 2^-28
    const t = expm1(Math.abs(x));
    if (ix < 0x3ff00000) return h * (2.0 * t - (t * t) / (t + 1));
    return h * (t + t / (t + 1));
  }
  if (ix < 0x40862e42) return h * glibcExp(Math.abs(x)); // |x| in [22, log(maxdouble)]
  if (ix < 0x408633ce || (ix === 0x408633ce && low(x) <= 0x8fb9f87d)) {
    // |x| in [log(maxdouble), overflow threshold]
    const w = glibcExp(0.5 * Math.abs(x));
    const t = h * w;
    return t * w;
  }
  return x * 1.0e307; // overflow
}
/** fdlibm's e_cosh.c over glibc's exp and expm1: identical to glibc on 2*10^5 inputs */
export function cosh(x: number): number {
  const ix = hiw(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) return x * x;
  if (ix < 0x3fd62e43) {
    // |x| < 0.5 ln2
    if (ix < 0x3c800000) return 1.0; // cosh(tiny) = 1
    const t = expm1(Math.abs(x));
    const w = 1.0 + t;
    return 1.0 + (t * t) / (w + w);
  }
  if (ix < 0x40360000) {
    // |x| in [0.5 ln2, 22]
    const t = glibcExp(Math.abs(x));
    return 0.5 * t + 0.5 / t;
  }
  if (ix < 0x40862e42) return 0.5 * glibcExp(Math.abs(x));
  if (ix < 0x408633ce || (ix === 0x408633ce && low(x) <= 0x8fb9f87d)) {
    const w = glibcExp(0.5 * Math.abs(x));
    const t = 0.5 * w;
    return t * w;
  }
  return Infinity;
}

// ------------------------------------------------------------ hypot as V8 computes it
/**
 * V8's Math.hypot (src/builtins/math.tq): each |x_i|/max squared, summed with
 * Kahan's compensation, sqrt, times max.  Written out, so every engine
 * computes Chrome's bits (and numpy_linalg's kernels already do this).
 */
export function v8hypot(...xs: number[]): number {
  let max = 0, nan = false;
  const abs = xs.map((v) => {
    if (v !== v) { nan = true; return 0; }
    const a = Math.abs(v);
    if (a > max) max = a;
    return a;
  });
  if (max === Infinity) return Infinity;
  if (nan) return NaN;
  if (max === 0) return 0;
  let sum = 0, comp = 0;
  for (const a of abs) {
    const n = a / max;
    const summand = n * n - comp;
    const pre = sum + summand;
    comp = (pre - sum) - summand;
    sum = pre;
  }
  return Math.sqrt(sum) * max;
}

// ------------------------------------------------------------ erf, erfc, lgamma, tgamma
// (Python's math.erf, erfc, gamma and lgamma.)  erf and erfc are fdlibm's
// s_erf.c and lgamma its e_lgamma_r.c, ported as the rest of this file from
// the Rust libm crate, but calling glibc's exp and log as glibc's builds of
// the same sources do (so erf and erfc agree with CPython on Linux).  tgamma
// is musl's Lanczos approximation (g = 6.024680040776729583740234375, the
// constants CPython's math.gamma uses too) over glibc's exp and pow.
const ERX = 8.45062911510467529297e-01, EFX8 = 1.02703333676410069053e+00;
const PP = [1.28379167095512558561e-01, -3.25042107247001499370e-01, -2.84817495755985104766e-02, -5.77027029648944159157e-03, -2.37630166566501626084e-05];
const QQ = [3.97917223959155352819e-01, 6.50222499887672944485e-02, 5.08130628187576562776e-03, 1.32494738004321644526e-04, -3.96022827877536812320e-06];
const PA = [-2.36211856075265944077e-03, 4.14856118683748331666e-01, -3.72207876035701323847e-01, 3.18346619901161753674e-01,
  -1.10894694282396677476e-01, 3.54783043256182359371e-02, -2.16637559486879084300e-03];
const QA = [1.06420880400844228286e-01, 5.40397917702171048937e-01, 7.18286544141962662868e-02, 1.26171219808761642112e-01,
  1.36370839120290507362e-02, 1.19844998467991074170e-02];
const RA = [-9.86494403484714822705e-03, -6.93858572707181764372e-01, -1.05586262253232909814e+01, -6.23753324503260060396e+01,
  -1.62396669462573470355e+02, -1.84605092906711035994e+02, -8.12874355063065934246e+01, -9.81432934416914548592e+00];
const SA = [1.96512716674392571292e+01, 1.37657754143519042600e+02, 4.34565877475229228821e+02, 6.45387271733267880336e+02,
  4.29008140027567833386e+02, 1.08635005541779435134e+02, 6.57024977031928170135e+00, -6.04244152148580987438e-02];
const RB = [-9.86494292470009928597e-03, -7.99283237680523006574e-01, -1.77579549177547519889e+01, -1.60636384855821916062e+02,
  -6.37566443368389627722e+02, -1.02509513161107724954e+03, -4.83519191608651397019e+02];
const SB = [3.03380607434824582924e+01, 3.25792512996573918826e+02, 1.53672958608443695994e+03, 3.19985821950859553908e+03,
  2.55305040643316442583e+03, 4.74528541206955367215e+02, -2.24409524465858183362e+01];
const X1P_1022 = 2 ** -1022;
function erfc1(x: number): number {
  const s = Math.abs(x) - 1.0;
  const p = PA[0] + s * (PA[1] + s * (PA[2] + s * (PA[3] + s * (PA[4] + s * (PA[5] + s * PA[6])))));
  const q = 1.0 + s * (QA[0] + s * (QA[1] + s * (QA[2] + s * (QA[3] + s * (QA[4] + s * QA[5])))));
  return 1.0 - ERX - p / q;
}
function erfc2(ix: number, x: number): number {
  if (ix < 0x3ff40000) return erfc1(x); // |x| < 1.25
  x = Math.abs(x);
  const s = 1.0 / (x * x);
  let r: number, bigS: number;
  if (ix < 0x4006db6d) { // |x| < 1/.35
    r = RA[0] + s * (RA[1] + s * (RA[2] + s * (RA[3] + s * (RA[4] + s * (RA[5] + s * (RA[6] + s * RA[7]))))));
    bigS = 1.0 + s * (SA[0] + s * (SA[1] + s * (SA[2] + s * (SA[3] + s * (SA[4] + s * (SA[5] + s * (SA[6] + s * SA[7])))))));
  } else {
    r = RB[0] + s * (RB[1] + s * (RB[2] + s * (RB[3] + s * (RB[4] + s * (RB[5] + s * RB[6])))));
    bigS = 1.0 + s * (SB[0] + s * (SB[1] + s * (SB[2] + s * (SB[3] + s * (SB[4] + s * (SB[5] + s * SB[6]))))));
  }
  const z = zeroLow(x);
  return (glibcExp(-z * z - 0.5625) * glibcExp((z - x) * (z + x) + r / bigS)) / x;
}
const erfR = (z: number) => PP[0] + z * (PP[1] + z * (PP[2] + z * (PP[3] + z * PP[4])));
const erfS = (z: number) => 1.0 + z * (QQ[0] + z * (QQ[1] + z * (QQ[2] + z * (QQ[3] + z * QQ[4]))));
export function erf(x: number): number {
  let ix = hiw(x);
  const sign = ix >>> 31;
  ix &= 0x7fffffff;
  if (ix >= 0x7ff00000) return 1.0 - 2.0 * sign + 1.0 / x; // nan, +-inf
  if (ix < 0x3feb0000) { // |x| < 0.84375
    if (ix < 0x3e300000) return 0.125 * (8.0 * x + EFX8 * x); // |x| < 2^-28
    const z = x * x;
    return x + x * (erfR(z) / erfS(z));
  }
  const y = ix < 0x40180000 ? 1.0 - erfc2(ix, x) : 1.0 - X1P_1022; // |x| < 6
  return sign ? -y : y;
}
export function erfc(x: number): number {
  let ix = hiw(x);
  const sign = ix >>> 31;
  ix &= 0x7fffffff;
  if (ix >= 0x7ff00000) return 2.0 * sign + 1.0 / x;
  if (ix < 0x3feb0000) { // |x| < 0.84375
    if (ix < 0x3c700000) return 1.0 - x; // |x| < 2^-56
    const z = x * x;
    const y = erfR(z) / erfS(z);
    if (sign || ix < 0x3fd00000) return 1.0 - (x + x * y); // x < 1/4
    return 0.5 - (x - 0.5 + x * y);
  }
  if (ix < 0x403c0000) return sign ? 2.0 - erfc2(ix, x) : erfc2(ix, x); // |x| < 28
  return sign ? 2.0 - X1P_1022 : X1P_1022 * X1P_1022;
}

const LG_PI = 3.14159265358979311600e+00;
const LA = [7.72156649015328655494e-02, 3.22467033424113591611e-01, 6.73523010531292681824e-02, 2.05808084325167332806e-02,
  7.38555086081402883957e-03, 2.89051383673415629091e-03, 1.19270763183362067845e-03, 5.10069792153511336608e-04,
  2.20862790713908385557e-04, 1.08011567247583939954e-04, 2.52144565451257326939e-05, 4.48640949618915160150e-05];
const TC = 1.46163214496836224576e+00, TF = -1.21486290535849611461e-01, TT = -3.63867699703950536541e-18;
const LT = [4.83836122723810047042e-01, -1.47587722994593911752e-01, 6.46249402391333854778e-02, -3.27885410759859649565e-02,
  1.79706750811820387126e-02, -1.03142241298341437450e-02, 6.10053870246291332635e-03, -3.68452016781138256760e-03,
  2.25964780900612472250e-03, -1.40346469989232843813e-03, 8.81081882437654011382e-04, -5.38595305356740546715e-04,
  3.15632070903625950361e-04, -3.12754168375120860518e-04, 3.35529192635519073543e-04];
const LU = [-7.72156649015328655494e-02, 6.32827064025093366517e-01, 1.45492250137234768737e+00, 9.77717527963372745603e-01,
  2.28963728064692451092e-01, 1.33810918536787660377e-02];
const LV = [2.45597793713041134822e+00, 2.12848976379893395361e+00, 7.69285150456672783825e-01, 1.04222645593369134254e-01,
  3.21709242282423911810e-03];
const LGS = [-7.72156649015328655494e-02, 2.14982415960608852501e-01, 3.25778796408930981787e-01, 1.46350472652464452805e-01,
  2.66422703033638609560e-02, 1.84028451407337715652e-03, 3.19475326584100867617e-05];
const LR = [1.39200533467621045958e+00, 7.21935547567138069525e-01, 1.71933865632803078993e-01, 1.86459191715652901344e-02,
  7.77942496381893596434e-04, 7.32668430744625636189e-06];
const LW = [4.18938533204672725052e-01, 8.33333333333329678849e-02, -2.77777777728775536470e-03, 7.93650558643019558500e-04,
  -5.95187557450339963135e-04, 8.36339918996282139126e-04, -1.63092934096575273989e-03];
/** sin(pi x) for x > 2^-100 (its sign is arbitrary when it is 0) */
function sinPi(x: number): number {
  x = 2.0 * (x * 0.5 - Math.floor(x * 0.5)); // x mod 2
  let n = Math.trunc(x * 4.0);
  n = Math.trunc((n + 1) / 2);
  x -= n * 0.5;
  x *= LG_PI;
  switch (n) {
    case 1: return kCos(x, 0.0);
    case 2: return kSin(-x, 0.0, 0);
    case 3: return -kCos(x, 0.0);
    default: return kSin(x, 0.0, 0);
  }
}
/** log|Gamma(x)| (fdlibm's lgamma_r; a nonpositive integer gives +inf) */
export function lgamma(x: number): number {
  const ix = hiw(x) & 0x7fffffff, lx = low(x);
  const sign = x < 0 || Object.is(x, -0);
  if (ix >= 0x7ff00000) return x * x;
  if (ix < (0x3ff - 70) << 20) return -glibcLog(Math.abs(x)); // |x| < 2^-70
  let nadj = 0;
  if (sign) {
    x = -x;
    let t = sinPi(x);
    if (t === 0.0) return 1.0 / (x - x); // -integer
    if (t < 0) t = -t;
    nadj = glibcLog(LG_PI / (t * x));
  }
  let r: number;
  if ((ix === 0x3ff00000 || ix === 0x40000000) && lx === 0) r = 0.0; // 1 and 2
  else if (ix < 0x40000000) { // x < 2
    let y: number, i: number;
    if (ix <= 0x3feccccc) { // lgamma(x) = lgamma(x+1) - log(x)
      r = -glibcLog(x);
      if (ix >= 0x3fe76944) { y = 1.0 - x; i = 0; } else if (ix >= 0x3fcda661) { y = x - (TC - 1.0); i = 1; } else { y = x; i = 2; }
    } else {
      r = 0.0;
      if (ix >= 0x3ffbb4c3) { y = 2.0 - x; i = 0; } else if (ix >= 0x3ff3b4c4) { y = x - TC; i = 1; } else { y = x - 1.0; i = 2; }
    }
    if (i === 0) {
      const z = y * y;
      const p1 = LA[0] + z * (LA[2] + z * (LA[4] + z * (LA[6] + z * (LA[8] + z * LA[10]))));
      const p2 = z * (LA[1] + z * (LA[3] + z * (LA[5] + z * (LA[7] + z * (LA[9] + z * LA[11])))));
      r += y * p1 + p2 - 0.5 * y;
    } else if (i === 1) {
      const z = y * y, w = z * y;
      const p1 = LT[0] + w * (LT[3] + w * (LT[6] + w * (LT[9] + w * LT[12])));
      const p2 = LT[1] + w * (LT[4] + w * (LT[7] + w * (LT[10] + w * LT[13])));
      const p3 = LT[2] + w * (LT[5] + w * (LT[8] + w * (LT[11] + w * LT[14])));
      r += TF + (z * p1 - (TT - w * (p2 + y * p3)));
    } else {
      const p1 = y * (LU[0] + y * (LU[1] + y * (LU[2] + y * (LU[3] + y * (LU[4] + y * LU[5])))));
      const p2 = 1.0 + y * (LV[0] + y * (LV[1] + y * (LV[2] + y * (LV[3] + y * LV[4]))));
      r += -0.5 * y + p1 / p2;
    }
  } else if (ix < 0x40200000) { // x < 8
    const i = Math.trunc(x);
    const y = x - i;
    const p = y * (LGS[0] + y * (LGS[1] + y * (LGS[2] + y * (LGS[3] + y * (LGS[4] + y * (LGS[5] + y * LGS[6]))))));
    const q = 1.0 + y * (LR[0] + y * (LR[1] + y * (LR[2] + y * (LR[3] + y * (LR[4] + y * LR[5])))));
    r = 0.5 * y + p / q;
    let z = 1.0; // lgamma(1+s) = log(s) + lgamma(s)
    if (i >= 7) z *= y + 6.0;
    if (i >= 6) z *= y + 5.0;
    if (i >= 5) z *= y + 4.0;
    if (i >= 4) z *= y + 3.0;
    if (i >= 3) { z *= y + 2.0; r += glibcLog(z); }
  } else if (ix < 0x43900000) { // x < 2^58
    const t = glibcLog(x), z = 1.0 / x, y = z * z;
    const w = LW[0] + z * (LW[1] + y * (LW[2] + y * (LW[3] + y * (LW[4] + y * (LW[5] + y * LW[6])))));
    r = (x - 0.5) * (t - 1.0) + w;
  } else r = x * (glibcLog(x) - 1.0);
  return sign ? nadj - r : r;
}

const GMHALF = 5.524680040776729583740234375;
const SNUM = [23531376880.410759688572007674451636754734846804940, 42919803642.649098768957899047001988850926355848959,
  35711959237.355668049440185451547166705960488635843, 17921034426.037209699919755754458931112671403265390,
  6039542586.3520280050642916443072979210699388420708, 1439720407.3117216736632230727949123939715485786772,
  248874557.86205415651146038641322942321632125127801, 31426415.585400194380614231628318205362874684987640,
  2876370.6289353724412254090516208496135991145378768, 186056.26539522349504029498971604569928220784236328,
  8071.6720023658162106380029022722506138218516325024, 210.82427775157934587250973392071336271166969580291,
  2.5066282746310002701649081771338373386264310793408];
const SDEN = [0.0, 39916800.0, 120543840.0, 150917976.0, 105258076.0, 45995730.0, 13339535.0, 2637558.0, 357423.0, 32670.0,
  1925.0, 66.0, 1.0];
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800, 479001600, 6227020800, 87178291200,
  1307674368000, 20922789888000, 355687428096000, 6402373705728000, 121645100408832000, 2432902008176640000,
  51090942171709440000, 1124000727777607680000];
function lanczosS(x: number): number {
  let num = 0.0, den = 0.0;
  if (x < 8.0) {
    for (let i = 12; i >= 0; i--) { num = num * x + SNUM[i]; den = den * x + SDEN[i]; }
  } else {
    for (let i = 0; i <= 12; i++) { num = num / x + SNUM[i]; den = den / x + SDEN[i]; }
  }
  return num / den;
}
/** Gamma(x) (musl's tgamma: NaN at the nonpositive integers and -inf, +-inf at +-0) */
export function tgamma(x: number): number {
  const ix = hiw(x) & 0x7fffffff;
  const sign = x < 0 || Object.is(x, -0);
  if (ix >= 0x7ff00000) return x + Infinity;
  if (ix < (0x3ff - 54) << 20) return 1.0 / x; // |x| < 2^-54
  if (x === Math.floor(x)) {
    if (sign) return NaN;
    if (x <= FACT.length) return FACT[x - 1];
  }
  if (ix >= 0x40670000) { // |x| >= 184
    if (sign) return Math.floor(x) * 0.5 === Math.floor(x * 0.5) ? 0.0 : -0.0;
    return x * 2 ** 1023;
  }
  const absx = sign ? -x : x;
  let y = absx + GMHALF, dy: number;
  if (absx > GMHALF) { dy = y - absx; dy -= GMHALF; } else { dy = y - GMHALF; dy -= absx; }
  let z = absx - 0.5;
  let r = lanczosS(absx) * glibcExp(-y);
  if (x < 0.0) {
    r = -LG_PI / (sinPi(absx) * absx * r);
    dy = -dy;
    z = -z;
  }
  r += (dy * (GMHALF + 0.5) * r) / y;
  z = glibcPow(y, 0.5 * z);
  y = r * z * z;
  return y;
}
