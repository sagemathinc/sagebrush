//! glibc's exp and log (ARM optimized-routines, MIT OR Apache-2.0 WITH
//! LLVM-exception, Copyright (c) 2018-2025 Arm Limited) over arrays, as
//! glibcExp/glibcLog in src/runtime/libm.ts, operation for operation: two
//! lanes at a time in the main range, one at a time elsewhere.  The tables
//! come from the TS (exp_data.ts, log_data.ts) at each call.

use core::arch::wasm32::*;

#[inline(always)]
unsafe fn ld(p: *const f64) -> v128 {
    v128_load(p as *const v128)
}
#[inline(always)]
unsafe fn st(p: *mut f64, v: v128) {
    v128_store(p as *mut v128, v)
}
#[inline(always)]
fn spl(x: f64) -> v128 {
    f64x2_splat(x)
}
/// 2^e for -1074 <= e <= 1023, exactly
#[inline(always)]
fn pow2(e: i32) -> f64 {
    if e >= -1022 {
        f64::from_bits(((e + 1023) as u64) << 52)
    } else {
        f64::from_bits(1u64 << (e + 1074))
    }
}

/// a b + c with one rounding.  In the baseline module, Dekker's exact
/// product (fma() in the TS); in the relaxed-SIMD module (kernels/relaxed),
/// the hardware's fused multiply-add, which the TS uses only after
/// fma_probe() shows that it is fused.
#[cfg(not(feature = "relaxed"))]
#[inline(always)]
fn fma(a: f64, b: f64, c: f64) -> f64 {
    let p = a * b;
    let ca = 134217729.0 * a;
    let ah = ca - (ca - a);
    let al = a - ah;
    let cb = 134217729.0 * b;
    let bh = cb - (cb - b);
    let bl = b - bh;
    let e = ah * bh - p + ah * bl + al * bh + al * bl;
    let s = p + c;
    let bb = s - p;
    let t = p - (s - bb) + (c - bb);
    s + (t + e)
}
#[cfg(not(feature = "relaxed"))]
#[inline(always)]
fn fma2(a: v128, b: v128, c: v128) -> v128 {
    let k = spl(134217729.0);
    let p = f64x2_mul(a, b);
    let ca = f64x2_mul(k, a);
    let ah = f64x2_sub(ca, f64x2_sub(ca, a));
    let al = f64x2_sub(a, ah);
    let cb = f64x2_mul(k, b);
    let bh = f64x2_sub(cb, f64x2_sub(cb, b));
    let bl = f64x2_sub(b, bh);
    let mut e = f64x2_sub(f64x2_mul(ah, bh), p);
    e = f64x2_add(e, f64x2_mul(ah, bl));
    e = f64x2_add(e, f64x2_mul(al, bh));
    e = f64x2_add(e, f64x2_mul(al, bl));
    let s = f64x2_add(p, c);
    let bb = f64x2_sub(s, p);
    let t = f64x2_add(f64x2_sub(p, f64x2_sub(s, bb)), f64x2_sub(c, bb));
    f64x2_add(s, f64x2_add(t, e))
}
#[cfg(feature = "relaxed")]
#[inline(always)]
fn fma2(a: v128, b: v128, c: v128) -> v128 {
    f64x2_relaxed_madd(a, b, c)
}
#[cfg(feature = "relaxed")]
#[inline(always)]
fn fma(a: f64, b: f64, c: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_relaxed_madd(spl(a), spl(b), spl(c)))
}

/// 1 if fma() rounds once: (1 + 2^-52)(1 - 2^-52) - 1 is -2^-104 fused, 0 not
#[no_mangle]
pub extern "C" fn fma_probe() -> i32 {
    let e = f64::EPSILON;
    (fma(1.0 + e, 1.0 - e, -1.0) == -e * e) as i32
}

// ------------------------------------------------------------------ exp

const INVLN2N: f64 = 1.4426950408889634 * 128.0;
const NEGLN2HIN: f64 = -0.005415212348111709;
const NEGLN2LON: f64 = -1.2864023111638346e-14;
const SHIFT: f64 = 6755399441055744.0;

/// Tables for exp: tail[128], base[128] (2^(i/128)), c2..c5, and glibc's
/// T[2i+1] = bits(base[i]) - (i << 45) as doubles' bits (tbits[128]).
pub(crate) struct ExpTab(pub(crate) *const f64);
impl ExpTab {
    #[inline(always)]
    unsafe fn tail(&self, i: usize) -> f64 {
        *self.0.add(i)
    }
    #[inline(always)]
    unsafe fn base(&self, i: usize) -> f64 {
        *self.0.add(128 + i)
    }
    #[inline(always)]
    unsafe fn c(&self, j: usize) -> f64 {
        *self.0.add(256 + j)
    }
    #[inline(always)]
    unsafe fn tbits(&self, i: usize) -> f64 {
        *self.0.add(260 + i)
    }
}

pub(crate) unsafe fn exp1(x: f64, t: &ExpTab) -> f64 {
    let ax = f64::from_bits(x.to_bits() & !(1u64 << 63));
    if !(ax >= 5.551115123125783e-17 && ax < 512.0) {
        return exp_slow(x, t);
    }
    let z = INVLN2N * x;
    let kd = z + SHIFT - SHIFT;
    let r = x + kd * NEGLN2HIN + kd * NEGLN2LON;
    let i = ((kd as i32) & 127) as usize;
    let scale = t.base(i) * pow2(((kd as i32) - i as i32) / 128);
    let r2 = r * r;
    let tmp = fma(r2 * r2, fma(r, t.c(3), t.c(2)), fma(r2, fma(r, t.c(1), t.c(0)), t.tail(i) + r));
    fma(scale, tmp, scale)
}

unsafe fn exp_slow(x: f64, t: &ExpTab) -> f64 {
    let hiw = (x.to_bits() >> 32) as u32;
    let mut abstop = (hiw >> 20) & 0x7ff;
    if abstop.wrapping_sub(0x3c9) >= 0x408 - 0x3c9 {
        if (abstop as i32 - 0x3c9) < 0 {
            return 1.0 + x;
        }
        if abstop >= 0x409 {
            if x == f64::NEG_INFINITY {
                return 0.0;
            }
            if abstop >= 0x7ff {
                return 1.0 + x;
            }
            return if x < 0.0 { 0.0 } else { f64::INFINITY };
        }
        abstop = 0;
    }
    let z = INVLN2N * x;
    let kd = z + SHIFT;
    let k = kd - SHIFT;
    let kd = k;
    let r = x + kd * NEGLN2HIN + kd * NEGLN2LON;
    let ki = k as i32;
    let i = (ki & 127) as usize;
    let tail = t.tail(i);
    // sbits = T[2i+1] + (k << 45) = bits(base[i]) + ((k - i) / 128 << 52)
    let j = ((ki - i as i32) / 128) as i64;
    let sbits = t.base(i).to_bits().wrapping_add((j as u64) << 52);
    let r2 = r * r;
    let tmp = fma(r2 * r2, fma(r, t.c(3), t.c(2)), fma(r2, fma(r, t.c(1), t.c(0)), tail + r));
    if abstop == 0 {
        if ki >= 0 {
            let scale = f64::from_bits(sbits.wrapping_sub(1009u64 << 52));
            return pow2(1009) * fma(scale, tmp, scale);
        }
        let scale = f64::from_bits(sbits.wrapping_add(1022u64 << 52));
        let mut y = scale + scale * tmp;
        if y < 1.0 {
            let mut lo = scale - y + scale * tmp;
            let hi = 1.0 + y;
            lo = 1.0 - hi + y + lo;
            y = hi + lo - 1.0;
            if y == 0.0 {
                y = 0.0;
            }
        }
        return pow2(-1022) * y;
    }
    let scale = f64::from_bits(sbits);
    fma(scale, tmp, scale)
}

/// y[i] = exp(x[i]), i < n; tab: tail[128], base[128], c2, c3, c4, c5.
#[no_mangle]
pub unsafe extern "C" fn vexp(x: *const f64, y: *mut f64, n: usize, tab: *const f64) {
    let t = ExpTab(tab);
    let (c2, c3, c4, c5) = (spl(t.c(0)), spl(t.c(1)), spl(t.c(2)), spl(t.c(3)));
    let (lo, hi) = (spl(5.551115123125783e-17), spl(512.0));
    let mut i = 0;
    while i + 2 <= n {
        let v = ld(x.add(i));
        let ax = f64x2_abs(v);
        if !i64x2_all_true(v128_and(f64x2_ge(ax, lo), f64x2_lt(ax, hi))) {
            *y.add(i) = exp1(*x.add(i), &t);
            *y.add(i + 1) = exp1(*x.add(i + 1), &t);
            i += 2;
            continue;
        }
        let z = f64x2_mul(spl(INVLN2N), v);
        // as glibc: ki = bits(z + shift), whose low bits are round(z), and
        // scale = T[2i+1] + (ki << 45), the same double as base[i] 2^((k-i)/128)
        let kds = f64x2_add(z, spl(SHIFT));
        let kd = f64x2_sub(kds, spl(SHIFT));
        let r = f64x2_add(f64x2_add(v, f64x2_mul(kd, spl(NEGLN2HIN))), f64x2_mul(kd, spl(NEGLN2LON)));
        let idx = v128_and(kds, i64x2_splat(127));
        let (i0, i1) = (i64x2_extract_lane::<0>(idx) as usize, i64x2_extract_lane::<1>(idx) as usize);
        let scale = i64x2_add(f64x2(t.tbits(i0), t.tbits(i1)), i64x2_shl(kds, 45));
        let r2 = f64x2_mul(r, r);
        let tmp0 = f64x2_add(f64x2(t.tail(i0), t.tail(i1)), r);
        let tmp1 = fma2(r2, fma2(r, c3, c2), tmp0);
        let tmp = fma2(f64x2_mul(r2, r2), fma2(r, c5, c4), tmp1);
        st(y.add(i), fma2(scale, tmp, scale));
        i += 2;
    }
    if i < n {
        *y.add(i) = exp1(*x.add(i), &t);
    }
}

// ------------------------------------------------------------------ log

/// Tables for log: tab[2*128] (invc, logc), a[5], b[11], ln2hi, ln2lo.
pub(crate) struct LogTab(pub(crate) *const f64);
impl LogTab {
    #[inline(always)]
    unsafe fn invc(&self, i: usize) -> f64 {
        *self.0.add(2 * i)
    }
    #[inline(always)]
    unsafe fn logc(&self, i: usize) -> f64 {
        *self.0.add(2 * i + 1)
    }
    #[inline(always)]
    unsafe fn a(&self, j: usize) -> f64 {
        *self.0.add(256 + j)
    }
    #[inline(always)]
    unsafe fn b(&self, j: usize) -> f64 {
        *self.0.add(261 + j)
    }
    #[inline(always)]
    unsafe fn ln2hi(&self) -> f64 {
        *self.0.add(272)
    }
    #[inline(always)]
    unsafe fn ln2lo(&self) -> f64 {
        *self.0.add(273)
    }
}

pub(crate) unsafe fn log1(x: f64, t: &LogTab) -> f64 {
    if x >= 0.9375 && x < 1.064697265625 {
        if x == 1.0 {
            return 0.0;
        }
        let b = |j| t.b(j);
        let r = x - 1.0;
        let r2 = r * r;
        let r3 = r * r2;
        let mut w = r * 134217728.0;
        let rhi = r + w - w;
        let rlo = r - rhi;
        w = rhi * rhi * b(0);
        let hi = r + w;
        let lo = r - hi + w;
        let p3 = fma(r3, b(10), fma(r2, b(9), fma(r, b(8), b(7))));
        let p2 = fma(r3, p3, fma(r2, b(6), fma(r, b(5), b(4))));
        let p = fma(r3, p2, fma(r2, b(3), fma(r, b(2), b(1))));
        let lo = fma(b(0) * rlo, rhi + r, lo);
        return fma(r3, p, lo) + hi;
    }
    let mut hiw = (x.to_bits() >> 32) as u32;
    let top = hiw >> 16;
    let mut kadj = 0i32;
    let mut xs = x;
    if top.wrapping_sub(0x0010) >= 0x7ff0 - 0x0010 || top < 0x0010 {
        if x == 0.0 {
            return f64::NEG_INFINITY;
        }
        if x == f64::INFINITY {
            return x;
        }
        if !(x > 0.0) {
            return f64::NAN;
        }
        xs = x * 4503599627370496.0;
        hiw = (xs.to_bits() >> 32) as u32;
        kadj = -52;
    }
    let tmphi = (hiw as i32).wrapping_sub(0x3fe60000);
    let i = (((tmphi as u32) >> 13) & 127) as usize;
    let k = (tmphi >> 20) + kadj;
    let z = xs * pow2(kadj - k);
    log_main(z, k, i, t)
}

#[inline(always)]
unsafe fn log_main(z: f64, k: i32, i: usize, t: &LogTab) -> f64 {
    let invc = t.invc(i);
    let logc = t.logc(i);
    let r = fma(z, invc, -1.0);
    let kd = k as f64;
    let w = kd * t.ln2hi() + logc;
    let hi = w + r;
    let lo = w - hi + r + kd * t.ln2lo();
    let r2 = r * r;
    lo + r2 * t.a(0) + r * r2 * (t.a(1) + r * t.a(2) + r2 * (t.a(3) + r * t.a(4))) + hi
}

/// y[i] = log(x[i]), i < n; tab: (invc, logc)[128], a[5], b[11], ln2hi, ln2lo.
#[no_mangle]
pub unsafe extern "C" fn vlog(x: *const f64, y: *mut f64, n: usize, tab: *const f64) {
    let t = LogTab(tab);
    let (a0, a1, a2, a3, a4) = (spl(t.a(0)), spl(t.a(1)), spl(t.a(2)), spl(t.a(3)), spl(t.a(4)));
    let (l2h, l2l) = (spl(t.ln2hi()), spl(t.ln2lo()));
    let one = spl(1.0);
    let mut i = 0;
    while i + 2 <= n {
        let v = ld(x.add(i));
        // near 1, or zero, subnormal, negative, infinite or NaN: one at a time
        let near1 = v128_and(f64x2_ge(v, spl(0.9375)), f64x2_lt(v, spl(1.064697265625)));
        let top = i64x2_sub(u64x2_shr(v, 48), i64x2_splat(0x0010));
        let special = v128_or(i64x2_lt(top, i64x2_splat(0)), i64x2_ge(top, i64x2_splat(0x7ff0 - 0x0010)));
        if v128_any_true(v128_or(near1, special)) {
            *y.add(i) = log1(*x.add(i), &t);
            *y.add(i + 1) = log1(*x.add(i + 1), &t);
            i += 2;
            continue;
        }
        // as glibc: tmp = ix - OFF; i = (tmp >> 45) % 128; k = tmp >> 52;
        // z = ix - (tmp & 0xfff << 52), which is x / 2^k
        let tmp = i64x2_sub(v, i64x2_splat(0x3fe6000000000000));
        let idx = v128_and(u64x2_shr(tmp, 45), i64x2_splat(127));
        let (i0, i1) = (i64x2_extract_lane::<0>(idx) as usize, i64x2_extract_lane::<1>(idx) as usize);
        let kv = i64x2_shr(tmp, 52);
        let z = i64x2_sub(v, v128_and(tmp, i64x2_splat(0xfff0000000000000u64 as i64)));
        let kd = f64x2_convert_low_i32x4(i32x4_shuffle::<0, 2, 0, 2>(kv, kv));
        let invc = f64x2(t.invc(i0), t.invc(i1));
        let logc = f64x2(t.logc(i0), t.logc(i1));
        // r = fma(z, invc, -1) (the TS's p - 1 + e: z invc - 1 is exact
        // up to the product's error, so both round once)
        let r = fma2(z, invc, f64x2_neg(one));
        let w = f64x2_add(f64x2_mul(kd, l2h), logc);
        let hi = f64x2_add(w, r);
        let lo = f64x2_add(f64x2_add(f64x2_sub(w, hi), r), f64x2_mul(kd, l2l));
        let r2 = f64x2_mul(r, r);
        let inner = f64x2_add(f64x2_add(a1, f64x2_mul(r, a2)), f64x2_mul(r2, f64x2_add(a3, f64x2_mul(r, a4))));
        let mut res = f64x2_add(lo, f64x2_mul(r2, a0));
        res = f64x2_add(res, f64x2_mul(f64x2_mul(r, r2), inner));
        st(y.add(i), f64x2_add(res, hi));
        i += 2;
    }
    if i < n {
        *y.add(i) = log1(*x.add(i), &t);
    }
}

// ------------------------------------------------------------------ log1p

const LP: [f64; 8] = [
    0.0,
    6.666666666666735130e-01,
    3.999999999940941908e-01,
    2.857142874366239149e-01,
    2.222219843214978396e-01,
    1.818357216161805012e-01,
    1.531383769920937332e-01,
    1.479819860511658591e-01,
];
const LN2_HI: f64 = 6.93147180369123816490e-01;
const LN2_LO: f64 = 1.90821492927058770002e-10;

#[inline(always)]
fn set_hi(u: f64, h: u32) -> f64 {
    f64::from_bits((u.to_bits() & 0xffffffff) | ((h as u64) << 32))
}

/// glibc's log1p as its x86-64 FMA build computes it: glibcLog1p() in the TS
pub(crate) fn log1p(x: f64) -> f64 {
    let hx = (x.to_bits() >> 32) as i32;
    let ax = hx & 0x7fffffff;
    let mut k = 1i32;
    let mut f = 0.0;
    let mut c = 0.0;
    let mut hu = 0i32;
    if hx < 0x3fda827a {
        if ax >= 0x3ff00000 {
            return if x == -1.0 { f64::NEG_INFINITY } else { f64::NAN };
        }
        if ax < 0x3e200000 {
            return if ax < 0x3c900000 { x } else { fma(-(x * x), 0.5, x) };
        }
        if hx > 0 || hx <= 0xbfd2bec3u32 as i32 {
            k = 0;
            f = x;
            hu = 1;
        }
    } else if hx >= 0x7ff00000 {
        return x + x;
    }
    if k != 0 {
        let mut u;
        if hx < 0x43400000 {
            u = 1.0 + x;
            hu = (u.to_bits() >> 32) as i32;
            k = (hu >> 20) - 1023;
            c = if k > 0 { 1.0 - (u - x) } else { x - (u - 1.0) };
            c /= u;
        } else {
            u = x;
            hu = (u.to_bits() >> 32) as i32;
            k = (hu >> 20) - 1023;
            c = 0.0;
        }
        hu &= 0x000fffff;
        if hu < 0x6a09e {
            u = set_hi(u, (hu | 0x3ff00000) as u32);
        } else {
            k += 1;
            u = set_hi(u, (hu | 0x3fe00000) as u32);
            hu = (0x00100000 - hu) >> 2;
        }
        f = u - 1.0;
    }
    let kd = k as f64;
    let hfsq = 0.5 * f * f;
    if hu == 0 {
        if f == 0.0 {
            return if k == 0 { 0.0 } else { fma(kd, LN2_HI, fma(kd, LN2_LO, c)) };
        }
        let t = fma(-0.66666666666666666, f, 1.0);
        if k == 0 {
            return fma(-hfsq, t, f);
        }
        return fma(kd, LN2_HI, -(hfsq * t - fma(kd, LN2_LO, c) - f));
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let z2 = z * z;
    let z4 = z2 * z2;
    let z6 = z4 * z2;
    let r2 = fma(z, LP[3], LP[2]);
    let r3 = fma(z, LP[5], LP[4]);
    let r4 = fma(z, LP[7], LP[6]);
    let r = fma(z6, r4, fma(z4, r3, fma(z, LP[1], z2 * r2)));
    if k == 0 {
        return f - (hfsq - s * (hfsq + r));
    }
    fma(kd, LN2_HI, -(hfsq - (s * (hfsq + r) + fma(kd, LN2_LO, c)) - f))
}
