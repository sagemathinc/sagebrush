//! glibc's log and pow (ARM optimized-routines math/log.c and math/pow.c,
//! MIT OR Apache-2.0 WITH LLVM-exception, Copyright (c) 2018-2026 Arm
//! Limited) as glibc's x86-64 FMA build computes them, the build CPython
//! calls on the reference machine: ported operation for operation from the
//! same source as src/runtime/libm.ts's glibcLog/glibcPow (their F64 twin,
//! design/mpmath-core.md §5.3), with the fused multiply-adds that build
//! contracts.  mpmath chooses some of its algorithms' parameters with float
//! arithmetic (x ** 0.5, x ** -0.5, math.log, prec ** 0.35), so these must
//! give CPython's bits for the core to give mpmath's results; the core has
//! this one copy for every target (@sagebrush's ruling: no platform libm).

#[path = "glibm_tables.rs"]
mod tables;
use tables::*;

#[inline]
fn d(bits: u64) -> f64 {
    f64::from_bits(bits)
}

#[inline]
fn fma(a: f64, b: f64, c: f64) -> f64 {
    a.mul_add(b, c)
}

/// math.log(x) (glibc's log).
pub fn log(x: f64) -> f64 {
    let b = |i: usize| d(LOG_POLY1[i]);
    if (0.9375..1.064697265625).contains(&x) {
        if x == 1.0 {
            return 0.0;
        }
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
    let mut ix = x.to_bits();
    let top = (ix >> 48) as u32;
    if top.wrapping_sub(0x0010) >= 0x7ff0 - 0x0010 {
        if x == 0.0 {
            return f64::NEG_INFINITY;
        }
        if x == f64::INFINITY {
            return x;
        }
        if !(x > 0.0) {
            return f64::NAN;
        }
        // subnormal: normalized
        ix = (x * 4503599627370496.0).to_bits().wrapping_sub(52u64 << 52);
    }
    let tmp = ix.wrapping_sub(0x3fe6000000000000);
    let i = ((tmp >> 45) % 128) as usize;
    let k = (tmp as i64) >> 52;
    let iz = ix.wrapping_sub(tmp & (0xfffu64 << 52));
    let invc = d(LOG_TAB[2 * i]);
    let logc = d(LOG_TAB[2 * i + 1]);
    let z = f64::from_bits(iz);
    let r = fma(z, invc, -1.0);
    let kd = k as f64;
    let w = kd * d(LOG_LN2[0]) + logc;
    let hi = w + r;
    let lo = w - hi + r + kd * d(LOG_LN2[1]);
    let r2 = r * r;
    let a = |i: usize| d(LOG_POLY[i]);
    lo + r2 * a(0) + r * r2 * (a(1) + r * a(2) + r2 * (a(3) + r * a(4))) + hi
}

const INVLN2N: f64 = 1.4426950408889634 * 128.0;
const NEGLN2HIN: f64 = -0.005415212348111709;
const NEGLN2LON: f64 = -1.2864023111638346e-14;
const SHIFT: f64 = 6755399441055744.0; // 0x1.8p52

/// (log(x) hi, tail) for pow, x > 0 finite.
fn pow_log(x: f64) -> (f64, f64) {
    let mut ix = x.to_bits();
    if x < 2.2250738585072014e-308 {
        ix = (x * 4503599627370496.0).to_bits().wrapping_sub(52u64 << 52);
    }
    let tmp = ix.wrapping_sub(0x3fe6955500000000);
    let i = ((tmp >> 45) % 128) as usize;
    let k = (tmp as i64) >> 52;
    let iz = ix.wrapping_sub(tmp & (0xfffu64 << 52));
    let z = f64::from_bits(iz);
    let kd = k as f64;
    let (invc, logc, logctail) = (d(POW_INVC[i]), d(POW_LOGC[i]), d(POW_LOGCTAIL[i]));
    let a = |i: usize| d(POW_A[i]);
    let r = fma(z, invc, -1.0);
    let t1 = kd * d(POW_LN2[0]) + logc;
    let t2 = t1 + r;
    let lo1 = kd * d(POW_LN2[1]) + logctail;
    let lo2 = t1 - t2 + r;
    let ar = a(0) * r;
    let ar2 = r * ar;
    let ar3 = r * ar2;
    let hi = t2 + ar2;
    let lo3 = fma(ar, r, -ar2);
    let lo4 = t2 - hi + ar2;
    let q = a(1) + r * a(2) + ar2 * (a(3) + r * a(4) + ar2 * (a(5) + r * a(6)));
    let lo = fma(ar3, q, lo1 + lo2 + lo3 + lo4);
    let y = hi + lo;
    (y, hi - y + lo)
}

fn exp_tab(i: usize) -> (f64, u64) {
    let tail = (EXP_TAB[4 * i] as u64) << 32 | EXP_TAB[4 * i + 1] as u64;
    let sbits = (EXP_TAB[4 * i + 2] as u64) << 32 | EXP_TAB[4 * i + 3] as u64;
    (f64::from_bits(tail), sbits)
}

/// sign * exp(x + xtail), for pow.
fn pow_exp(x: f64, xtail: f64, neg: bool) -> f64 {
    let abstop = ((x.to_bits() >> 52) & 0x7ff) as u32;
    let mut big = false;
    if !(0x3c9..0x408).contains(&abstop) {
        if abstop < 0x3c9 {
            let one = 1.0 + x;
            return if neg { -one } else { one };
        }
        if abstop >= 0x409 {
            return if x < 0.0 {
                if neg {
                    -0.0
                } else {
                    0.0
                }
            } else if neg {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            };
        }
        big = true;
    }
    let z = INVLN2N * x;
    let kd0 = z + SHIFT;
    let ki = kd0.to_bits();
    let kd = kd0 - SHIFT;
    let r = x + kd * NEGLN2HIN + kd * NEGLN2LON + xtail;
    let (tail, tbits) = exp_tab((ki % 128) as usize);
    let sign_bias: u64 = if neg { 0x800 << 7 } else { 0 };
    let top = ki.wrapping_add(sign_bias) << 45;
    let sbits = tbits.wrapping_add(top);
    let c = |i: usize| d(EXP_POLY[i]);
    let r2 = r * r;
    let tmp = fma(r2 * r2, fma(r, c(3), c(2)), fma(r2, fma(r, c(1), c(0)), tail + r));
    if big {
        if ki & 0x80000000 == 0 {
            let scale = f64::from_bits(sbits.wrapping_sub(1009u64 << 52));
            return 2f64.powi(1009) * fma(scale, tmp, scale);
        }
        let sbits = sbits.wrapping_add(1022u64 << 52);
        let scale = f64::from_bits(sbits);
        let mut y = scale + scale * tmp;
        if y.abs() < 1.0 {
            let one = if y < 0.0 { -1.0 } else { 1.0 };
            let mut lo = scale - y + scale * tmp;
            let hi = one + y;
            lo = one - hi + y + lo;
            y = hi + lo - one;
            if y == 0.0 {
                y = f64::from_bits(sbits & 0x8000000000000000);
            }
        }
        return f64::from_bits(1u64 << 52) * y; // 0x1p-1022
    }
    let scale = f64::from_bits(sbits);
    fma(scale, tmp, scale)
}

/// 0: y is not an integer, 1: odd, 2: even.
fn checkint(y: f64) -> u32 {
    if !y.is_finite() || y.trunc() != y {
        return 0;
    }
    if y.abs() >= 9007199254740992.0 {
        return 2;
    }
    if y % 2.0 != 0.0 {
        1
    } else {
        2
    }
}

/// x ** y (glibc's pow, C semantics).
pub fn pow(x: f64, y: f64) -> f64 {
    let mut x = x;
    let mut neg = false;
    let topx = (x.to_bits() >> 52) as u32;
    let topy = (y.to_bits() >> 52) as u32;
    if topx.wrapping_sub(0x001) >= 0x7ff - 0x001 || (topy & 0x7ff).wrapping_sub(0x3be) >= 0x43e - 0x3be {
        if y == 0.0 || !y.is_finite() {
            if y == 0.0 {
                return 1.0;
            }
            if x == 1.0 {
                return 1.0;
            }
            if x.is_nan() || y.is_nan() {
                return x + y;
            }
            if x.abs() == 1.0 {
                return 1.0;
            }
            if (x.abs() < 1.0) == (y > 0.0) {
                return 0.0;
            }
            return y * y;
        }
        if x == 0.0 || !x.is_finite() {
            let mut x2 = x * x;
            if x.to_bits() >> 63 != 0 && checkint(y) == 1 {
                x2 = -x2;
            }
            return if y < 0.0 { 1.0 / x2 } else { x2 };
        }
        if x < 0.0 {
            let yint = checkint(y);
            if yint == 0 {
                return f64::NAN;
            }
            if yint == 1 {
                neg = true;
            }
            x = -x;
        }
        let ty = topy & 0x7ff;
        if ty.wrapping_sub(0x3be) >= 0x43e - 0x3be {
            if x == 1.0 {
                return if neg { -1.0 } else { 1.0 };
            }
            if ty < 0x3be {
                return if x > 1.0 { 1.0 + y } else { 1.0 - y };
            }
            return if (x > 1.0) == (y > 0.0) { f64::INFINITY } else { 0.0 };
        }
    }
    let (hi, lo) = pow_log(x);
    let ehi = y * hi;
    let elo = y * lo + fma(y, hi, -ehi);
    pow_exp(ehi, elo, neg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_cases() {
        assert_eq!(pow(4.0, 0.5), 2.0);
        assert_eq!(pow(2.0, 10.0), 1024.0);
        assert_eq!(pow(9.0, -0.5), 1.0 / 3.0);
        assert_eq!(log(1.0), 0.0);
        assert_eq!(log(std::f64::consts::E), 1.0);
        assert!(pow(-8.0, 1.0 / 3.0).is_nan());
    }
}
