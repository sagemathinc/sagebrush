//! mpmath's integer square roots on the python backend (libintmath.py,
//! BSD-3-Clause, Copyright (c) 2005-2021 Fredrik Johansson and mpmath
//! contributors), ported operation for operation: isqrt_small_python and
//! isqrt_fast_python are approximate (float starting values; isqrt_fast is
//! off by one for about one input in eight), and mpmath's constants depend
//! on their exact outputs, so they are reproduced, float arithmetic
//! included (glibm: CPython's pow).

use crate::glibm::pow;
use crate::nat::Nat;
use core::cmp::Ordering;

fn one_shl(k: u64) -> Nat {
    Nat::from_u64(1).shl(k)
}

/// giant_steps(start, target, n=2).
pub fn giant_steps(start: i64, target: i64) -> Vec<i64> {
    let mut l = vec![target];
    while *l.last().unwrap() > start * 2 {
        let v = l.last().unwrap().div_euclid(2) + 2;
        l.push(v);
    }
    l.reverse();
    l
}

/// (x + x // y) >> 1 steps of Newton's iteration from y.
fn newton(x: &Nat, y: Nat) -> Nat {
    let (q, _) = x.divmod(&y);
    y.add(&q).shr(1)
}

pub fn isqrt_small_python(x: &Nat) -> Nat {
    if x.is_zero() {
        return Nat::zero();
    }
    let mut r = if x.bits() <= 800 {
        let xf = x.to_f64();
        if x.bits() <= 50 {
            return Nat::from_f64_trunc(pow(xf, 0.5));
        }
        Nat::from_f64_trunc(pow(xf, 0.5) * 1.00000000000001).add_u64(1)
    } else {
        let bc = x.bits() as i64;
        let n = bc / 2;
        let xs = x.shr((2 * n - 100) as u64).to_f64();
        Nat::from_f64_trunc(pow(xs, 0.5) + 2.0).shl((n - 50) as u64)
    };
    loop {
        let y = newton(x, r.clone());
        if y.cmp_mag(&r) != Ordering::Less {
            return r;
        }
        r = y;
    }
}

pub fn isqrt_fast_python(x: &Nat) -> Nat {
    if x.bits() <= 800 {
        // x < 2^800 (x < _1_800)
        let mut y = Nat::from_f64_trunc(pow(x.to_f64(), 0.5));
        if x.cmp_mag(&one_shl(100)) != Ordering::Less {
            y = newton(x, y);
            if x.cmp_mag(&one_shl(200)) != Ordering::Less {
                y = newton(x, y);
                if x.cmp_mag(&one_shl(400)) != Ordering::Less {
                    y = newton(x, y);
                }
            }
        }
        return y;
    }
    let guard_bits = 10u64;
    let x = x.shl(2 * guard_bits);
    let mut bc = x.bits() as i64;
    bc += bc & 1;
    let hbc = bc / 2;
    let startprec = 50.min(hbc);
    let xs = x.shr((bc - 2 * startprec) as u64).to_f64();
    let mut r = Nat::from_f64_trunc(2f64.powi((2 * startprec) as i32) * pow(xs, -0.5));
    let mut pp = startprec;
    let mut p = startprec;
    for step in giant_steps(startprec, hbc) {
        p = step;
        let r2 = r.mul(&r).shr((2 * pp - p) as u64);
        let xr2 = x.shr((bc - p) as u64).mul(&r2).shr(p as u64);
        // (3 << p) - xr2 is positive in the iteration's range
        let three = Nat::from_u64(3).shl(p as u64);
        let d = three.sub(&xr2);
        r = r.mul(&d).shr((pp + 1) as u64);
        pp = p;
    }
    r.mul(&x.shr(hbc as u64)).shr(p as u64 + guard_bits)
}

/// sqrtrem_python: (y, x - y^2) with y = floor(sqrt(x)).
pub fn sqrtrem_python(x: &Nat) -> (Nat, Nat) {
    if x.bits() <= 600 {
        let y = isqrt_small_python(x);
        let rem = x.sub(&y.mul(&y));
        return (y, rem);
    }
    let mut y = isqrt_fast_python(x).add_u64(1);
    // rem = x - y*y, possibly negative: kept as sign and magnitude
    let yy = y.mul(&y);
    let (mut neg, mut rem) = match x.cmp_mag(&yy) {
        Ordering::Less => (true, yy.sub(x)),
        _ => (false, x.sub(&yy)),
    };
    while neg {
        y = y.sub_u64(1);
        // rem += 1 + 2y
        let inc = y.shl(1).add_u64(1);
        match rem.cmp_mag(&inc) {
            Ordering::Greater => rem = rem.sub(&inc),
            _ => {
                rem = inc.sub(&rem);
                neg = false;
            }
        }
    }
    if !rem.is_zero() {
        loop {
            let lim = y.add_u64(1).shl(1);
            if rem.cmp_mag(&lim) != Ordering::Greater {
                break;
            }
            y = y.add_u64(1);
            rem = rem.sub(&y.shl(1).add_u64(1));
        }
    }
    (y, rem)
}
