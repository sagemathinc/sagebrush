//! The kernel fast path (design/mpmath-core.md §4.1): mpf_add, mpf_sub and
//! mpf_mul for nonzero operands whose mantissas fit 64 bits, on u128 with no
//! allocation, step for step the general path's (mpf.rs: the reference's
//! python_mpf_add / python_mpf_mul, normalize and normalize1 with bc taken
//! literally).  Anything outside what u128 holds exactly (an exponent
//! offset past 63 bits, a shift past 127, an exponent past i64, a bc the
//! reference's own arithmetic would make huge) is None: the general path
//! computes it.  tests/corpus.rs holds this to the general path on every
//! case of the reference corpora the kernel accepts.

use crate::exp::Exp;
use crate::mpf::{Mpf, Rnd};
use crate::nat::Nat;

impl Sm {
    /// s, if its mantissa fits 128 bits and its exponent i64
    pub fn of(s: &Mpf) -> Option<Sm> {
        Some(Sm { sign: s.sign, man: s.man.to_u128()?, exp: s.exp.as_i64()?, bc: s.bc })
    }
    pub fn mpf(self) -> Mpf {
        Mpf { sign: self.sign, man: Nat::from_u128(self.man), exp: Exp::S(self.exp), bc: self.bc }
    }
}

/// A raw mpf with a mantissa of at most 128 bits and an i64 exponent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sm {
    pub sign: u32,
    pub man: u128,
    pub exp: i64,
    pub bc: i64,
}

const ZERO: Sm = Sm { sign: 0, man: 0, exp: 0, bc: 0 };

fn bits(x: u128) -> i64 {
    128 - x.leading_zeros() as i64
}

/// round_off: man cut by n bits (0 < n < 128).
fn round_off(sign: u32, man: u128, n: i64, rnd: Rnd) -> Option<u128> {
    if !(1..128).contains(&n) {
        return None;
    }
    let n = n as u32;
    Some(if rnd == Rnd::Nearest {
        let t = man >> (n - 1);
        let low = man & ((1u128 << (n - 1)) - 1);
        if t & 1 == 1 && (t & 2 == 2 || low != 0) {
            (t >> 1) + 1
        } else {
            t >> 1
        }
    } else if rnd.shifts_down(sign) {
        man >> n
    } else {
        (man >> n) + (man & ((1u128 << n) - 1) != 0) as u128
    })
}

fn strip(sign: u32, man: u128, exp: i64, bc: i64) -> Option<Sm> {
    let (mut man, mut exp, mut bc) = (man, exp, bc);
    if man & 1 == 0 {
        let t = man.trailing_zeros() as i64;
        man >>= t;
        exp = exp.checked_add(t)?;
        bc -= t;
    }
    if man == 1 {
        bc = 1;
    }
    Some(Sm { sign, man, exp, bc })
}

fn normalize(sign: u32, man: u128, exp: i64, bc: i64, prec: u64, rnd: Rnd) -> Option<Sm> {
    if man == 0 {
        return Some(ZERO);
    }
    let n = bc.checked_sub(i64::try_from(prec).ok()?)?;
    if n > 0 {
        let m = round_off(sign, man, n, rnd)?;
        return strip(sign, m, exp.checked_add(n)?, prec as i64);
    }
    strip(sign, man, exp, bc)
}

fn normalize1(sign: u32, man: u128, exp: i64, bc: i64, prec: u64, rnd: Rnd) -> Option<Sm> {
    if man == 0 {
        return Some(ZERO);
    }
    let p = i64::try_from(prec).ok()?;
    if bc <= p {
        return Some(Sm { sign, man, exp, bc });
    }
    let n = bc - p;
    let m = round_off(sign, man, n, rnd)?;
    strip(sign, m, exp.checked_add(n)?, p)
}

/// a - b with a's sign when a > b, the other's when a < b (sub_mag).
fn sub_mag(a: u128, b: u128, asign: u32) -> (u32, u128) {
    if a > b {
        (asign, a - b)
    } else if a < b {
        (1 - asign, b - a)
    } else {
        (0, 0)
    }
}

/// mpf_add (sub: mpf_sub) of nonzero operands with mantissas below 2^64.
pub fn add(s: Sm, t: Sm, prec: u64, rnd: Rnd, sub: bool) -> Option<Sm> {
    if s.man == 0 || t.man == 0 || s.man >> 64 != 0 || t.man >> 64 != 0 {
        return None;
    }
    let tsign = t.sign ^ sub as u32;
    let offset = s.exp.checked_sub(t.exp)?;
    // (an offset past 63 bits: the general path, which also has the
    // reference's far-apart perturbation for offsets past 100)
    if !(-63..=63).contains(&offset) {
        return None;
    }
    let p = |bc: i64| if prec != 0 { prec } else { bc as u64 };
    if offset > 0 {
        let a = s.man << offset;
        let (sg, man) = if s.sign == tsign { (s.sign, t.man + a) } else { sub_mag(a, t.man, s.sign) };
        let bc = bits(man);
        return normalize1(sg, man, t.exp, bc, p(bc), rnd);
    }
    if offset < 0 {
        let a = t.man << -offset;
        let (sg, man) = if s.sign == tsign { (s.sign, s.man + a) } else { sub_mag(a, s.man, tsign) };
        let bc = bits(man);
        return normalize1(sg, man, s.exp, bc, p(bc), rnd);
    }
    let (sg, man) = if s.sign == tsign { (s.sign, t.man + s.man) } else { sub_mag(s.man, t.man, s.sign) };
    let bc = bits(man);
    normalize(sg, man, t.exp, bc, p(bc), rnd)
}

/// python_mpf_mul of nonzero operands with mantissas below 2^64.
pub fn mul(s: Sm, t: Sm, prec: u64, rnd: Rnd) -> Option<Sm> {
    if s.man == 0 || t.man == 0 || s.man >> 64 != 0 || t.man >> 64 != 0 {
        return None;
    }
    let man = s.man * t.man;
    let mut bc = s.bc.checked_add(t.bc)?.checked_sub(1)?;
    if bc >= 0 {
        // bc += int(man >> bc): 0 or 1 for exact operand counts; anything else is the general path's
        let top = if bc >= 128 { 0 } else { man >> bc };
        if top > 1 {
            return None;
        }
        bc += top as i64;
    }
    let exp = s.exp.checked_add(t.exp)?;
    if prec != 0 {
        return normalize1(s.sign ^ t.sign, man, exp, bc, prec, rnd);
    }
    Some(Sm { sign: s.sign ^ t.sign, man, exp, bc })
}
