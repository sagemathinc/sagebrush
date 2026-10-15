// math.gamma and math.lgamma as CPython computes them: its own Lanczos
// approximation (N = 13, g = 6.024680040776729583740234375, as Boost's),
// with the reflection formula for negative x, ported from CPython 3.14's
// Modules/mathmodule.c (m_tgamma, m_lgamma, m_sinpi, lanczos_sum; PSF
// license, see NOTICE.md).  CPython uses these rather than the C library's
// tgamma and lgamma, so its results are these, digit for digit, given the
// C library's exp, log and pow (here glibc's ports, libm.ts) and sin/cos.
// Domain and range errors are the caller's (modules.ts: math): a NaN or an
// infinity comes back.

import { glibcExp, glibcLog, glibcPow } from "./libm";
import * as FD from "./fdlibm";

const PI = 3.141592653589793238462643383279502884197;
const LOGPI = 1.144729885849400174143427351353058711647;
const LANCZOS_G = 6.024680040776729583740234375;
const LANCZOS_G_MINUS_HALF = 5.524680040776729583740234375;
const LANCZOS_NUM = [
  23531376880.410759688572007674451636754734846804940, 42919803642.649098768957899047001988850926355848959,
  35711959237.355668049440185451547166705960488635843, 17921034426.037209699919755754458931112671403265390,
  6039542586.3520280050642916443072979210699388420708, 1439720407.3117216736632230727949123939715485786772,
  248874557.86205415651146038641322942321632125127801, 31426415.585400194380614231628318205362874684987640,
  2876370.6289353724412254090516208496135991145378768, 186056.26539522349504029498971604569928220784236328,
  8071.6720023658162106380029022722506138218516325024, 210.82427775157934587250973392071336271166969580291,
  2.5066282746310002701649081771338373386264310793408,
];
// the denominator x*(x+1)*...*(x+LANCZOS_N-2)
const LANCZOS_DEN = [0.0, 39916800.0, 120543840.0, 150917976.0, 105258076.0, 45995730.0, 13339535.0, 2637558.0, 357423.0, 32670.0, 1925.0, 66.0, 1.0];
// Gamma at the small positive integers 1 to 23
const GAMMA_INTEGRAL = [
  1.0, 1.0, 2.0, 6.0, 24.0, 120.0, 720.0, 5040.0, 40320.0, 362880.0, 3628800.0, 39916800.0, 479001600.0, 6227020800.0,
  87178291200.0, 1307674368000.0, 20922789888000.0, 355687428096000.0, 6402373705728000.0, 121645100408832000.0,
  2432902008176640000.0, 51090942171709440000.0, 1124000727777607680000.0,
];

// sin(pi x), for finite x
function sinpi(x: number): number {
  const y = Math.abs(x) % 2.0;
  const n = Math.round(2.0 * y); // (y >= 0: C's round)
  let r: number;
  switch (n) {
    case 0: r = FD.sin(PI * y); break;
    case 1: r = FD.cos(PI * (y - 0.5)); break;
    // (-sin(pi*(y-1.0)) would give -0.0 instead of 0.0 at y == 1.0)
    case 2: r = FD.sin(PI * (1.0 - y)); break;
    case 3: r = -FD.cos(PI * (y - 1.5)); break;
    default: r = FD.sin(PI * (y - 2.0)); break;
  }
  return (x < 0 || Object.is(x, -0) ? -1 : 1) * r;
}

// Lanczos' sum L_g(x), for x > 0 (as a rational function in 1/x for x >= 5,
// against overflow)
function lanczosSum(x: number): number {
  let num = 0.0, den = 0.0;
  if (x < 5.0) {
    for (let i = 12; i >= 0; i--) {
      num = num * x + LANCZOS_NUM[i];
      den = den * x + LANCZOS_DEN[i];
    }
  } else {
    for (let i = 0; i < 13; i++) {
      num = num / x + LANCZOS_NUM[i];
      den = den / x + LANCZOS_DEN[i];
    }
  }
  return num / den;
}

export function tgamma(x: number): number {
  if (!Number.isFinite(x)) return x !== x || x > 0 ? x : NaN;
  if (x === 0) return Object.is(x, -0) ? -Infinity : Infinity;
  if (x === Math.floor(x)) {
    if (x < 0) return NaN;
    if (x <= 23) return GAMMA_INTEGRAL[x - 1];
  }
  const absx = Math.abs(x);
  if (absx < 1e-20) return 1.0 / x;
  if (absx > 200.0) return x < 0 ? 0.0 / sinpi(x) : Infinity;
  const y = absx + LANCZOS_G_MINUS_HALF;
  // the error in y (CPython's correction factor: r + e*g/y*r)
  let z: number;
  if (absx > LANCZOS_G_MINUS_HALF) {
    const q = y - absx;
    z = q - LANCZOS_G_MINUS_HALF;
  } else {
    const q = y - LANCZOS_G_MINUS_HALF;
    z = q - absx;
  }
  z = (z * LANCZOS_G) / y;
  let r: number;
  if (x < 0.0) {
    r = (((-PI / sinpi(absx)) / absx) * glibcExp(y)) / lanczosSum(absx);
    r -= z * r;
    if (absx < 140.0) r /= glibcPow(y, absx - 0.5);
    else {
      const sqrtpow = glibcPow(y, absx / 2.0 - 0.25);
      r /= sqrtpow;
      r /= sqrtpow;
    }
  } else {
    r = lanczosSum(absx) / glibcExp(y);
    r += z * r;
    if (absx < 140.0) r *= glibcPow(y, absx - 0.5);
    else {
      const sqrtpow = glibcPow(y, absx / 2.0 - 0.25);
      r *= sqrtpow;
      r *= sqrtpow;
    }
  }
  return r;
}

export function lgamma(x: number): number {
  if (!Number.isFinite(x)) return x !== x ? x : Infinity;
  if (x === Math.floor(x) && x <= 2.0) return x <= 0.0 ? Infinity : 0.0;
  const absx = Math.abs(x);
  if (absx < 1e-20) return -glibcLog(absx);
  let r = glibcLog(lanczosSum(absx)) - LANCZOS_G;
  r += (absx - 0.5) * (glibcLog(absx + LANCZOS_G - 0.5) - 1);
  // the reflection formula for negative x
  if (x < 0.0) r = LOGPI - glibcLog(Math.abs(sinpi(absx))) - glibcLog(absx) - r;
  return r;
}
