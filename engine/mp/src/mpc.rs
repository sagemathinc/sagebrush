//! mpmath's complex arithmetic on pairs of raw mpfs, and the few real
//! helpers it uses, ported from mpmath 1.3.0's libmpc.py and libmpf.py
//! (BSD-3-Clause, Copyright (c) 2005-2021 Fredrik Johansson and mpmath
//! contributors).  Where the reference leaves an argument at its default,
//! the port passes the default explicitly: prec 0 (exact) and round_fast,
//! which is round_down.

use crate::mpf::{mpf_add, mpf_div, mpf_mul, mpf_sqrt, normalize1, Mpf, Rnd};
use crate::Fail;

/// round_fast, the reference's default rounding.
pub const FAST: Rnd = Rnd::Down;

pub type Mpc = (Mpf, Mpf);

/// mpf_shift: s * 2^n, exactly.
pub fn mpf_shift(s: &Mpf, n: i64) -> Result<Mpf, Fail> {
    if s.man.is_zero() {
        return Ok(s.clone());
    }
    Ok(Mpf { sign: s.sign, man: s.man.clone(), exp: s.exp.checked_add(n).ok_or(Fail::Exponent)?, bc: s.bc })
}

/// mpf_abs; prec 0 is exact.
pub fn mpf_abs(s: &Mpf, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if s.man.is_zero() && s.exp != 0 {
        if s.is_fninf() {
            return Ok(crate::mpf::finf());
        }
        return Ok(s.clone());
    }
    if prec == 0 {
        if s.sign == 1 {
            return Ok(Mpf { sign: 0, man: s.man.clone(), exp: s.exp, bc: s.bc });
        }
        return Ok(s.clone());
    }
    normalize1(0, s.man.clone(), s.exp, s.bc, prec, rnd)
}

/// mpf_hypot: sqrt(x^2 + y^2).
pub fn mpf_hypot(x: &Mpf, y: &Mpf, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if y.is_fzero() {
        return mpf_abs(x, prec, rnd);
    }
    if x.is_fzero() {
        return mpf_abs(y, prec, rnd);
    }
    let h2 = mpf_add(&mpf_mul(x, x, 0, FAST)?, &mpf_mul(y, y, 0, FAST)?, prec + 4, FAST, false)?;
    mpf_sqrt(&h2, prec, rnd)
}

pub fn mpc_add(z: &Mpc, w: &Mpc, prec: u64, rnd: Rnd) -> Result<Mpc, Fail> {
    Ok((mpf_add(&z.0, &w.0, prec, rnd, false)?, mpf_add(&z.1, &w.1, prec, rnd, false)?))
}

pub fn mpc_sub(z: &Mpc, w: &Mpc, prec: u64, rnd: Rnd) -> Result<Mpc, Fail> {
    Ok((mpf_add(&z.0, &w.0, prec, rnd, true)?, mpf_add(&z.1, &w.1, prec, rnd, true)?))
}

pub fn mpc_mul(z: &Mpc, w: &Mpc, prec: u64, rnd: Rnd) -> Result<Mpc, Fail> {
    let (a, b) = z;
    let (c, d) = w;
    let p = mpf_mul(a, c, 0, FAST)?;
    let q = mpf_mul(b, d, 0, FAST)?;
    let r = mpf_mul(a, d, 0, FAST)?;
    let s = mpf_mul(b, c, 0, FAST)?;
    Ok((mpf_add(&p, &q, prec, rnd, true)?, mpf_add(&r, &s, prec, rnd, false)?))
}

pub fn mpc_div(z: &Mpc, w: &Mpc, prec: u64, rnd: Rnd) -> Result<Mpc, Fail> {
    let (a, b) = z;
    let (c, d) = w;
    let wp = prec + 10;
    let mag = mpf_add(&mpf_mul(c, c, 0, FAST)?, &mpf_mul(d, d, 0, FAST)?, wp, FAST, false)?;
    let t = mpf_add(&mpf_mul(a, c, 0, FAST)?, &mpf_mul(b, d, 0, FAST)?, wp, FAST, false)?;
    let u = mpf_add(&mpf_mul(b, c, 0, FAST)?, &mpf_mul(a, d, 0, FAST)?, wp, FAST, true)?;
    Ok((mpf_div(&t, &mag, prec, rnd)?, mpf_div(&u, &mag, prec, rnd)?))
}

pub fn mpc_abs(z: &Mpc, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    mpf_hypot(&z.0, &z.1, prec, rnd)
}
