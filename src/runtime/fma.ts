// Correctly rounded fused multiply-adds: fma(x, y, z) = x * y + z rounded once to a double, and fmaf to a
// float32, as C's fma and fmaf, ported from musl (src/math/fma.c and src/math/fmaf.c, MIT, Copyright © 2005-2020
// Rich Felker, et al.). JavaScript has no Math.fma. NumPy's complex multiply loop computes each part as one
// fused multiply-add, so its results depend on that single rounding.

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer); // (little-endian: U32[0] the low word, U32[1] the high)

/** fmaf: x * y + z for float32 values x, y, z, rounded once to float32 (musl's fmaf: the double sum, then
 * round to odd where the double rounding could matter). */
export function fmaf(x: number, y: number, z: number): number {
  const xy = x * y; // (exact: two 24-bit significands)
  F64[0] = xy + z;
  const lo = U32[0], hi = U32[1];
  const e = (hi >>> 20) & 0x7ff;
  // (halfway: the low 29 bits are 0x10000000, the double sits on a float32 halfway point)
  const halfway = (lo & 0x1fffffff) === 0x10000000;
  const tiny = e <= 0x3ff - 126 && e >= 0x3ff - 149;
  if (!halfway && !tiny) return Math.fround(F64[0]);
  if (e !== 0x7ff) {
    const r = F64[0];
    const s = hi >>> 31;
    const t = s === +(xy < z) ? xy - r + z : z - r + xy;
    if (t) {
      // (round to odd: step the double one unit toward r + t when it is even, then set its last bit)
      if (s ^ +(t < 0)) {
        // (u.i -= 1, borrowing from the high word)
        if (U32[0] === 0) {
          U32[0] = 0xffffffff;
          U32[1] = (U32[1] - 1) >>> 0;
        } else U32[0] = (U32[0] - 1) >>> 0;
      }
      U32[0] = (U32[0] | 1) >>> 0;
    }
  }
  return Math.fround(F64[0]);
}

// ------------------------------------------------------------------ fma (double)

const SPLIT = 134217729; // 2**27 + 1
/** fma: x * y + z rounded once. The common case by error-free transformations (the exact product and sum
 * as unevaluated pairs) where their last rounding is provably the correct one; every other case, and every
 * non-finite or extreme-exponent one, by fmaExact, musl's integer algorithm. */
export function fma(x: number, y: number, z: number): number {
  const p = x * y;
  // (outside the range where the transformations are exact: zeros, non-finite values, huge or tiny products)
  const ap = Math.abs(p), az = Math.abs(z), ax = Math.abs(x), ay = Math.abs(y);
  if (!(ap < 1e300 && ap > 1e-280 && az < 1e300 && (az > 1e-280 || z === 0) && ax < 1e250 && ax > 1e-250 && ay < 1e250 && ay > 1e-250))
    return fmaExact(x, y, z);
  // p + e = x * y exactly (Dekker)
  const cx = SPLIT * x, xh = cx - (cx - x), xl = x - xh;
  const cy = SPLIT * y, yh = cy - (cy - y), yl = y - yh;
  const e = xh * yh - p + xh * yl + xl * yh + xl * yl;
  // s + t = p + z exactly (Knuth)
  const s = p + z, bb = s - p, t = p - (s - bb) + (z - bb);
  // u + w = t + e exactly; x * y + z = s + u + w
  const u = t + e, ub = u - t, w = t - (u - ub) + (e - ub);
  // (p + z exactly 0, as in the imaginary part of z * conj(z): the total is the product's error e, exact)
  if (s === 0) return e === 0 ? s : e;
  // s + u rounds the total correctly unless it lands exactly on a halfway point, where w decides. Either p + z
  // didn't cancel (|s| >= |p| / 2: |u| <= |t| + |e| is under 2 ulp(s), so s + u lies on u's grid, whose halfway
  // points are more than |w| away unless s + u is one), or it did (|s| < |p| / 2: then z is within a factor 2
  // of -p, the sum is exact by Sterbenz's lemma, t = 0, u = e and w = 0, so r is s + e rounded once).
  const r = s + u;
  const rb = r - s, d = s - (r - rb) + (u - rb); // s + u = r + d exactly
  if (w === 0 || d === 0) return r;
  // (r is correct unless s + u was exactly halfway between r and its neighbour on d's side: then the exact
  // value is past the halfway point on w's side, and the neighbour is the nearest when that is d's side too)
  const n = nextToward(r, d > 0);
  if (Math.abs(d) * 2 !== Math.abs(n - r)) return r;
  return (d > 0) === (w > 0) ? n : r;
}

// (the double next to r, up or down)
function nextToward(r: number, up: boolean): number {
  if (r === 0) return up ? 2 ** -1074 : -(2 ** -1074);
  F64[0] = r;
  const away = (r > 0) === up;
  let lo = U32[0], hi = U32[1];
  if (away) {
    lo = (lo + 1) >>> 0;
    if (lo === 0) hi = (hi + 1) >>> 0;
  } else {
    if (lo === 0) hi = (hi - 1) >>> 0;
    lo = (lo - 1) >>> 0;
  }
  U32[0] = lo;
  U32[1] = hi;
  return F64[0];
}

// musl's fma.c, with BigInt for its 64-bit words (the exact reference and the fallback)
const M64 = (1n << 64n) - 1n;
const BIG = new BigUint64Array(F64.buffer);
interface Num {
  m: bigint;
  e: number;
  sign: number;
}
function normalize(x: number): Num {
  F64[0] = x;
  let ix = BIG[0];
  let e = Number(ix >> 52n);
  const sign = e & 0x800;
  e &= 0x7ff;
  if (!e) {
    F64[0] = x * 2 ** 63;
    ix = BIG[0];
    e = Number((ix >> 52n) & 0x7ffn);
    e = e ? e - 63 : 0x800;
  }
  ix &= (1n << 52n) - 1n;
  ix |= 1n << 52n;
  ix <<= 1n;
  e -= 0x3ff + 52 + 1;
  return { m: ix, e, sign };
}
const ZEROINFNAN = 0x7ff - 0x3ff - 52 - 1;
const clz64 = (v: bigint): number => 64 - v.toString(2).length;
const toInt64Double = (v: bigint, sign: boolean): number => Number(sign ? -BigInt.asIntN(64, v) : BigInt.asIntN(64, v));

/** musl's fma, line by line (its uint64_t arithmetic as BigInt masked to 64 bits). */
export function fmaExact(x: number, y: number, z: number): number {
  const nx = normalize(x), ny = normalize(y), nz = normalize(z);
  if (nx.e >= ZEROINFNAN || ny.e >= ZEROINFNAN) return x * y + z;
  if (nz.e >= ZEROINFNAN) {
    if (nz.e > ZEROINFNAN) return x * y; // (z == 0)
    return z;
  }
  // mul: r = x * y
  const prod = nx.m * ny.m;
  let rhi = prod >> 64n, rlo = prod & M64, zhi: bigint, zlo: bigint;
  // align exponents
  let e = nx.e + ny.e;
  let d = nz.e - e;
  if (d > 0) {
    if (d < 64) {
      zlo = (nz.m << BigInt(d)) & M64;
      zhi = nz.m >> BigInt(64 - d);
    } else {
      zlo = 0n;
      zhi = nz.m;
      e = nz.e - 64;
      d -= 64;
      if (d === 0) {
        // (nothing to shift)
      } else if (d < 64) {
        rlo = ((rhi << BigInt(64 - d)) & M64) | (rlo >> BigInt(d)) | (((rlo << BigInt(64 - d)) & M64) !== 0n ? 1n : 0n);
        rhi = rhi >> BigInt(d);
      } else {
        rlo = 1n;
        rhi = 0n;
      }
    }
  } else {
    zhi = 0n;
    d = -d;
    if (d === 0) zlo = nz.m;
    else if (d < 64) zlo = (nz.m >> BigInt(d)) | (((nz.m << BigInt(64 - d)) & M64) !== 0n ? 1n : 0n);
    else zlo = 1n;
  }
  // add
  let sign = nx.sign ^ ny.sign;
  const samesign = !(sign ^ nz.sign);
  let nonzero = true;
  if (samesign) {
    const s = rlo + zlo;
    rlo = s & M64;
    rhi = (rhi + zhi + (rlo < zlo ? 1n : 0n)) & M64;
  } else {
    const t = rlo;
    rlo = (rlo - zlo) & M64;
    rhi = (rhi - zhi - (t < rlo ? 1n : 0n)) & M64;
    if (rhi >> 63n) {
      rlo = -rlo & M64;
      rhi = (-rhi - (rlo !== 0n ? 1n : 0n)) & M64;
      sign = sign ? 0 : 1;
    }
    nonzero = rhi !== 0n;
  }
  // set rhi to the top 63 bits of the result (the last bit sticky)
  if (nonzero) {
    e += 64;
    d = clz64(rhi) - 1;
    rhi = ((rhi << BigInt(d)) & M64) | (rlo >> BigInt(64 - d)) | (((rlo << BigInt(d)) & M64) !== 0n ? 1n : 0n);
  } else if (rlo) {
    d = clz64(rlo) - 1;
    if (d < 0) rhi = (rlo >> 1n) | (rlo & 1n);
    else rhi = (rlo << BigInt(d)) & M64;
  } else return x * y + z; // (exact +-0)
  e -= d;
  // convert to double (|r| in [2**62, 2**63], one rounding)
  let r = toInt64Double(rhi, !!sign);
  if (e < -1022 - 62) {
    // (subnormal before rounding)
    if (e === -1022 - 63) {
      const c = sign ? -(2 ** 63) : 2 ** 63;
      if (r === c) {
        // (the smallest normal after rounding)
        // (float fltmin = 0x0.ffffff8p-63*FLT_MIN * r; return DBL_MIN/FLT_MIN * fltmin)
        const fltmin = Math.fround((1 - 2 ** -25) * 2 ** -63 * 2 ** -126 * r);
        return 2 ** -1022 / 2 ** -126 * fltmin;
      }
      if ((rhi << 53n) & M64) {
        // (one bit is lost when scaled: add another top bit so the conversion rounds once)
        const i = (rhi >> 1n) | (rhi & 1n) | (1n << 62n);
        r = toInt64Double(i, !!sign);
        r = 2 * r - c;
      }
    } else {
      // (round once when scaled)
      d = 10;
      const i = ((rhi >> BigInt(d)) | (((rhi << BigInt(64 - d)) & M64) !== 0n ? 1n : 0n)) << BigInt(d);
      r = toInt64Double(i, !!sign);
    }
  }
  return scalbn(r, e);
}
// musl's scalbn: x * 2**n, rounded once
function scalbn(x: number, n: number): number {
  let y = x;
  if (n > 1023) {
    y *= 2 ** 1023;
    n -= 1023;
    if (n > 1023) {
      y *= 2 ** 1023;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    // (the final n below -53, so a subnormal result rounds once)
    y *= 2 ** -1022 * 2 ** 53;
    n += 1022 - 53;
    if (n < -1022) {
      y *= 2 ** -1022 * 2 ** 53;
      n += 1022 - 53;
      if (n < -1022) n = -1022;
    }
  }
  return y * 2 ** n;
}
