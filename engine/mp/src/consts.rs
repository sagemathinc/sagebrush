//! mpmath's fixed-point constants (libelefun.py, BSD-3-Clause, Copyright (c)
//! 2005-2021 Fredrik Johansson and mpmath contributors), ported operation
//! for operation, with the reference's memo (constant_memo): a value is
//! computed at int(prec * 1.05 + 10) bits and later requests at or below
//! that precision are its right shifts.  The memo is the session's (one per
//! core instance, as one per Python process for the reference), so the same
//! sequence of requests gives the same bits as the reference.
//!
//! The term counts are chosen with float arithmetic, as the reference's:
//! glibm's log, CPython's.

use crate::glibm;
use crate::int::Int;
use crate::intmath::isqrt_fast_python;
use crate::nat::Nat;
use crate::Fail;
use std::cell::RefCell;

#[derive(Default)]
struct Memo {
    prec: i64,
    val: Nat,
}

thread_local! {
    static LN2: RefCell<Memo> = RefCell::new(Memo { prec: -1, val: Nat::zero() });
    static PI: RefCell<Memo> = RefCell::new(Memo { prec: -1, val: Nat::zero() });
    static E: RefCell<Memo> = RefCell::new(Memo { prec: -1, val: Nat::zero() });
}

/// Forget every memo (a new session).
pub fn reset() {
    for m in [&LN2, &PI, &E] {
        m.with(|c| *c.borrow_mut() = Memo { prec: -1, val: Nat::zero() });
    }
}

fn memo(
    cell: &'static std::thread::LocalKey<RefCell<Memo>>,
    prec: i64,
    f: fn(i64) -> Result<Nat, Fail>,
) -> Result<Nat, Fail> {
    let hit = cell.with(|c| {
        let m = c.borrow();
        if prec <= m.prec {
            Some(m.val.shr((m.prec - prec) as u64))
        } else {
            None
        }
    });
    if let Some(v) = hit {
        return v;
    }
    let newprec = (prec as f64 * 1.05 + 10.0) as i64;
    let val = f(newprec)?;
    let out = val.shr((newprec - prec) as u64)?;
    cell.with(|c| *c.borrow_mut() = Memo { prec: newprec, val });
    Ok(out)
}

/// bsp_acot(q, a, b, hyperbolic) -> (p, q, r)
fn bsp_acot(q: &Int, a: i64, b: i64, hyperbolic: bool) -> Result<(Int, Int, Int), Fail> {
    if b - a == 1 {
        let a1 = Int::from_i64(2 * a + 3);
        let p = if hyperbolic || a & 1 == 1 { Int::from_i64(1) } else { Int::from_i64(-1) };
        return Ok((p, a1.mul(&q.mul(q)?)?, a1));
    }
    let m = (a + b).div_euclid(2);
    let (p1, q1, r1) = bsp_acot(q, a, m, hyperbolic)?;
    let (p2, q2, r2) = bsp_acot(q, m, b, hyperbolic)?;
    Ok((q2.mul(&p1)?.add(&r1.mul(&p2)?)?, q1.mul(&q2)?, r1.mul(&r2)?))
}

/// acot_fixed's term count, int(0.35*prec/math.log(a)+20) (pinned).
pub fn acot_terms(a: i64, prec: i64) -> i64 {
    (0.35 * prec as f64 / glibm::log(a as f64) + 20.0) as i64
}

/// acot_fixed(a, prec, hyperbolic)
fn acot_fixed(a: i64, prec: i64, hyperbolic: bool) -> Result<Int, Fail> {
    let n = acot_terms(a, prec);
    let ai = Int::from_i64(a);
    let (p, q, _r) = bsp_acot(&ai, 0, n, hyperbolic)?;
    p.add(&q)?.shl(prec as u64)?.floordiv(&q.mul(&ai)?)
}

/// machin(coefs, prec, hyperbolic)
fn machin(coefs: &[(i64, i64)], prec: i64, hyperbolic: bool) -> Result<Int, Fail> {
    let extraprec = 10;
    let mut s = Int::zero();
    for &(a, b) in coefs {
        s = s.add(&Int::from_i64(a).mul(&acot_fixed(b, prec + extraprec, hyperbolic)?)?)?;
    }
    s.shr(extraprec as u64)
}

fn nonneg(x: Int) -> Result<Nat, Fail> {
    // (the constants are positive)
    Ok(x.mag)
}

fn ln2_raw(prec: i64) -> Result<Nat, Fail> {
    nonneg(machin(&[(18, 26), (-2, 4801), (8, 8749)], prec, true)?)
}

/// ln2_fixed(prec)
pub fn ln2_fixed(prec: i64) -> Result<Nat, Fail> {
    memo(&LN2, prec, ln2_raw)
}

const CHUD_A: i64 = 13591409;
const CHUD_B: i64 = 545140134;
const CHUD_C: i64 = 640320;
const CHUD_D: i64 = 12;

/// bs_chudnovsky(a, b) -> (g, p, q)
fn bs_chudnovsky(a: i64, b: i64) -> Result<(Int, Int, Int), Fail> {
    if b - a == 1 {
        let g = Int::from_i64(6 * b - 5).mul_i64(2 * b - 1)?.mul_i64(6 * b - 1)?;
        let c3 = Int::from_i64(CHUD_C).mul_i64(CHUD_C)?.mul_i64(CHUD_C)?;
        let p = Int::from_i64(b).mul_i64(b)?.mul_i64(b)?.mul(&c3)?.floordiv_i64(24)?;
        let mut q = g.mul(&Int::from_i64(CHUD_A).add(&Int::from_i64(CHUD_B).mul_i64(b)?)?)?;
        if b & 1 == 1 {
            q = q.neg();
        }
        return Ok((g, p, q));
    }
    let mid = (a + b).div_euclid(2);
    let (g1, p1, q1) = bs_chudnovsky(a, mid)?;
    let (g2, p2, q2) = bs_chudnovsky(mid, b)?;
    Ok((g1.mul(&g2)?, p1.mul(&p2)?, q1.mul(&p2)?.add(&q2.mul(&g1)?)?))
}

fn pi_raw(prec: i64) -> Result<Nat, Fail> {
    let n = pi_terms(prec);
    let (_g, p, q) = bs_chudnovsky(0, n)?;
    let sqrt_c = Int::from(isqrt_fast_python(&Nat::from_u64(CHUD_C as u64).shl(2 * prec as u64)?)?);
    let num = p.mul_i64(CHUD_C)?.mul(&sqrt_c)?;
    let den = q.add(&Int::from_i64(CHUD_A).mul(&p)?)?.mul_i64(CHUD_D)?;
    nonneg(num.floordiv(&den)?)
}

/// pi_fixed(prec): floor(pi * 2^prec), as the reference computes it.
pub fn pi_fixed(prec: i64) -> Result<Nat, Fail> {
    memo(&PI, prec, pi_raw)
}

/// bspe(a, b) -> (p, q)
fn bspe(a: i64, b: i64) -> Result<(Nat, Nat), Fail> {
    if b - a == 1 {
        return Ok((Nat::from_u64(1), Nat::from_u64(b as u64)));
    }
    let m = (a + b).div_euclid(2);
    let (p1, q1) = bspe(a, m)?;
    let (p2, q2) = bspe(m, b)?;
    Ok((p1.mul(&q2)?.add(&p2)?, q1.mul(&q2)?))
}

/// pi_fixed's term count, int(prec/3.3219280948/14.181647462+2) (pinned).
pub fn pi_terms(prec: i64) -> i64 {
    (prec as f64 / 3.3219280948 / 14.181647462 + 2.0) as i64
}

/// e_fixed's term count, int(1.1*prec/math.log(prec)+20) (pinned).
pub fn e_terms(prec: i64) -> i64 {
    (1.1 * prec as f64 / glibm::log(prec as f64) + 20.0) as i64
}

fn e_raw(prec: i64) -> Result<Nat, Fail> {
    let n = e_terms(prec);
    let (p, q) = bspe(0, n)?;
    Ok(p.add(&q)?.shl(prec as u64)?.divmod(&q)?.0)
}

/// e_fixed(prec)
pub fn e_fixed(prec: i64) -> Result<Nat, Fail> {
    memo(&E, prec, e_raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_bits() {
        reset();
        // floor(pi * 2^60) and floor(ln 2 * 2^60), floor(e * 2^60)
        assert_eq!(pi_fixed(60).unwrap().to_u64(), Some(3622009729038561421));
        assert_eq!(ln2_fixed(60).unwrap().to_u64(), Some(799144290325165978));
        assert_eq!(e_fixed(60).unwrap().to_u64(), Some(3133965575612453542));
    }
}
