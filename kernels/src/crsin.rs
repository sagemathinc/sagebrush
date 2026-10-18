//! Correctly rounded sin and cos over arrays: the fast path of sin and cos in
//! src/runtime/crmath.ts (double-double arithmetic, good to about 2^-74),
//! operation for operation.  An element that path cannot round, or that is
//! not finite, or whose |x| is 2^20 pi/2 or more, is left to the TS: its
//! index goes into `idx`, and the count of them is returned.
//!
//! The exact product of two doubles is Dekker's in the main module, and one
//! fused multiply-add in the relaxed-SIMD module (used only where
//! fma_probe() shows it is fused): both are the exact error a b - fl(a b),
//! the same double.

use core::arch::wasm32::*;

/// The tables, from crmath.ts: sin j/32 and cos j/32 as double-doubles for
/// j = -26..26 (212), then 1/3! as a double-double, then the series'
/// coefficients 1/120, -1/5040, 1/24 and -1/720 (the last terms divide, as
/// the TS does): SINCOS_TABLE, 218 doubles.
struct Tab(*const f64);
impl Tab {
    #[inline(always)]
    unsafe fn at(&self, i: usize) -> f64 {
        *self.0.add(i)
    }
}

#[cfg(not(feature = "relaxed"))]
const SPLITTER: f64 = 134217729.0; // 2^27 + 1
// pi/2 in five parts of 33 bits (Cody and Waite's reduction)
const PIO2P: [f64; 5] = [1.5707963267341256, 6.077100506303966e-11, 2.0222662487111665e-21, 8.478427660348229e-32, 2.067032109450824e-43];
const EPS: f64 = 8.470329472543003e-22; // 2^-70

/// JavaScript's Math.round: the nearest integer, ties toward +inf, -0 for
/// -0.5 <= v < 0 (only finite v of moderate size occur here)
#[inline(always)]
fn js_round(v: f64) -> f64 {
    let f = f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(v)));
    let r = if v - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && v < 0.0 {
        -0.0
    } else {
        r
    }
}

/// a b - fl(a b), exactly
#[cfg(not(feature = "relaxed"))]
#[inline(always)]
fn prod_err(a: f64, b: f64, p: f64) -> f64 {
    let ca = SPLITTER * a;
    let ah = ca - (ca - a);
    let al = a - ah;
    let cb = SPLITTER * b;
    let bh = cb - (cb - b);
    let bl = b - bh;
    ((ah * bh - p) + ah * bl + al * bh) + al * bl
}
#[cfg(feature = "relaxed")]
#[inline(always)]
fn prod_err(a: f64, b: f64, p: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_relaxed_madd(f64x2_splat(a), f64x2_splat(b), f64x2_splat(-p)))
}

#[inline(always)]
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    (p, prod_err(a, b, p))
}

/// gAdd: (ah + al) + (bh + bl)
#[inline(always)]
fn add(ah: f64, al: f64, bh: f64, bl: f64) -> (f64, f64) {
    let s = ah + bh;
    let bb = s - ah;
    let e = (ah - (s - bb)) + (bh - bb);
    let t = al + bl;
    let cc = t - al;
    let f = (al - (t - cc)) + (bl - cc);
    let e1 = e + t;
    let h1 = s + e1;
    let l1 = e1 - (h1 - s);
    let e2 = l1 + f;
    let h = h1 + e2;
    (h, e2 - (h - h1))
}

/// gMul: (ah + al) (bh + bl)
#[inline(always)]
fn mul(ah: f64, al: f64, bh: f64, bl: f64) -> (f64, f64) {
    let p = ah * bh;
    let e = prod_err(ah, bh, p) + (ah * bl + al * bh);
    let h = p + e;
    (h, e - (h - p))
}

/// gReduce below 2^20 pi/2: (n mod 4, r) with r = x - n pi/2
#[inline(always)]
fn reduce(x: f64) -> (i32, f64, f64) {
    let ax = f64x2_extract_lane::<0>(f64x2_abs(f64x2_splat(x)));
    if ax <= 0.7853981633974483 {
        return (0, x, 0.0);
    }
    let n = js_round(x * 0.6366197723675814);
    let (mut rh, mut rl) = (x, 0.0);
    for p in &PIO2P[..3] {
        let (h, l) = two_prod(-n, *p);
        (rh, rl) = add(rh, rl, h, l);
    }
    // (near a multiple of pi/2, the other two parts too)
    let arh = f64x2_extract_lane::<0>(f64x2_abs(f64x2_splat(rh)));
    let an = f64x2_extract_lane::<0>(f64x2_abs(f64x2_splat(n)));
    if arh < an * 2e-9 {
        for p in &PIO2P[3..] {
            let (h, l) = two_prod(-n, *p);
            (rh, rl) = add(rh, rl, h, l);
        }
    }
    let q = ((n % 4.0) + 4.0) % 4.0;
    (q as i32, rh, rl)
}

/// gSinCos: sin and cos of rh + rl, |r| <= pi/4 + 2^-20
#[inline(always)]
unsafe fn sincos(rh: f64, rl: f64, t: &Tab) -> (f64, f64, f64, f64) {
    let j = js_round(rh * 32.0);
    let (mut th, mut tl) = (rh, rl);
    if j != 0.0 {
        (th, tl) = add(rh, rl, -j / 32.0, 0.0);
    }
    let (tth, ttl) = mul(th, tl, th, tl);
    let t2 = tth;
    // sin t = t + t (-t^2/6 + tail)
    let (h, l) = mul(tth, ttl, t.at(212), t.at(213));
    let (h, l) = add(-h, -l, t2 * t2 * (t.at(214) + t2 * (t.at(215) + t2 / 362880.0)), 0.0);
    let (h, l) = mul(th, tl, h, l);
    let (sh, sl) = add(th, tl, h, l);
    // cos t = 1 + (-t^2/2 + tail)
    let (h, l) = add(tth * -0.5, ttl * -0.5, t2 * t2 * (t.at(216) + t2 * (t.at(217) + t2 / 40320.0)), 0.0);
    let (ch, cl) = add(1.0, 0.0, h, l);
    if j == 0.0 {
        return (sh, sl, ch, cl);
    }
    let k = ((j as i32 + 26) * 4) as usize;
    let (s_h, s_l, c_h, c_l) = (t.at(k), t.at(k + 1), t.at(k + 2), t.at(k + 3));
    let (ah, al) = mul(s_h, s_l, ch, cl);
    let (h, l) = mul(c_h, c_l, sh, sl);
    let (nsh, nsl) = add(ah, al, h, l);
    let (bh, bl) = mul(c_h, c_l, ch, cl);
    let (h, l) = mul(s_h, s_l, sh, sl);
    let (nch, ncl) = add(bh, bl, -h, -l);
    (nsh, nsl, nch, ncl)
}

/// The double nearest h + l if every value within EPS |h| of it rounds to
/// it, else NaN
#[inline(always)]
fn decided(h: f64, l: f64) -> f64 {
    let r = h + l;
    let e = f64x2_extract_lane::<0>(f64x2_abs(f64x2_splat(h))) * EPS;
    if h + (l + e) == r && h + (l - e) == r {
        r
    } else {
        f64::NAN
    }
}

/// y[i] = sin x[i] (cos: cos x[i]) where the fast path decides it; the
/// indices of the others in idx, their count returned
#[no_mangle]
pub unsafe extern "C" fn vsincos(x: *const f64, y: *mut f64, n: usize, tab: *const f64, cos: i32, idx: *mut i32) -> i32 {
    let t = Tab(tab);
    let mut left = 0;
    for i in 0..n {
        let v = *x.add(i);
        let av = f64x2_extract_lane::<0>(f64x2_abs(f64x2_splat(v)));
        let r = if !(av < 1647099.3291652855) {
            f64::NAN // not finite, or the TS's wide reduction
        } else if av < 7.450580596923828e-9 {
            if cos != 0 {
                1.0
            } else {
                v
            }
        } else {
            let (q, rh, rl) = reduce(v);
            let (sh, sl, ch, cl) = sincos(rh, rl, &t);
            match (cos != 0, q) {
                (false, 0) | (true, 3) => decided(sh, sl),
                (false, 1) | (true, 0) => decided(ch, cl),
                (false, 2) | (true, 1) => -decided(sh, sl),
                _ => -decided(ch, cl),
            }
        };
        if r != r {
            *idx.add(left) = i as i32;
            left += 1;
        } else {
            *y.add(i) = r;
        }
    }
    left as i32
}
