//! Exponents of any magnitude, as the reference's Python ints are: an i64 on
//! the fast path, promoted to a signed big integer (a Nat magnitude) when an
//! operand or a result leaves i64.  Every operation is checked; the big
//! path's storage counts against the call's limits and allocates fallibly
//! (§4.5), like any mantissa.  (Exponent magnitude and mantissa bit size are
//! separate things: an exponent's size is its own value's, never a
//! mantissa's.)

use crate::nat::Nat;
use crate::Fail;
use core::cmp::Ordering;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exp {
    /// The fast path: any i64.
    S(i64),
    /// The big path: a value outside i64, as a sign and magnitude.
    B { neg: bool, mag: Nat },
}

/// Test-only: how many results took the big path (a which-path counter for
/// the promotion-bound pins, §6.1).
#[cfg(any(test, feature = "path-counter"))]
pub mod counter {
    use std::cell::Cell;
    thread_local!(static BIG: Cell<u64> = const { Cell::new(0) });
    pub fn bump() {
        BIG.with(|c| c.set(c.get() + 1));
    }
    pub fn take() -> u64 {
        BIG.with(|c| c.replace(0))
    }
}

impl From<i64> for Exp {
    fn from(x: i64) -> Exp {
        Exp::S(x)
    }
}

impl Exp {
    /// A signed value from sign and magnitude, on the fast path when it fits.
    pub fn from_parts(neg: bool, mag: Nat) -> Exp {
        if let Some(m) = mag.to_u64() {
            if !neg && m <= i64::MAX as u64 {
                return Exp::S(m as i64);
            }
            if neg && m <= 1u64 << 63 {
                return Exp::S((m as i64).wrapping_neg());
            }
        }
        #[cfg(any(test, feature = "path-counter"))]
        counter::bump();
        Exp::B { neg, mag }
    }

    fn parts(&self) -> (bool, Nat) {
        match self {
            Exp::S(x) => (*x < 0, Nat::from_u64(x.unsigned_abs())),
            Exp::B { neg, mag } => (*neg, mag.clone()),
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Exp::S(x) => Some(*x),
            Exp::B { .. } => None,
        }
    }

    pub fn is_zero(&self) -> bool {
        matches!(self, Exp::S(0))
    }

    pub fn is_neg(&self) -> bool {
        match self {
            Exp::S(x) => *x < 0,
            Exp::B { neg, .. } => *neg,
        }
    }

    pub fn is_odd(&self) -> bool {
        match self {
            Exp::S(x) => x & 1 != 0,
            Exp::B { mag, .. } => mag.is_odd(),
        }
    }

    pub fn neg(&self) -> Result<Exp, Fail> {
        match self {
            Exp::S(x) => match x.checked_neg() {
                Some(y) => Ok(Exp::S(y)),
                None => Ok(Exp::from_parts(false, Nat::from_u64(1u64 << 63))),
            },
            Exp::B { neg, mag } => Ok(Exp::from_parts(!neg, mag.clone())),
        }
    }

    pub fn add(&self, o: &Exp) -> Result<Exp, Fail> {
        if let (Exp::S(a), Exp::S(b)) = (self, o) {
            if let Some(c) = a.checked_add(*b) {
                return Ok(Exp::S(c));
            }
        }
        let (an, am) = self.parts();
        let (bn, bm) = o.parts();
        if an == bn {
            return Ok(Exp::from_parts(an, am.add(&bm)?));
        }
        Ok(match am.cmp_mag(&bm) {
            Ordering::Less => Exp::from_parts(bn, bm.sub(&am)?),
            _ => Exp::from_parts(an, am.sub(&bm)?),
        })
    }

    pub fn add_i64(&self, n: i64) -> Result<Exp, Fail> {
        self.add(&Exp::S(n))
    }

    pub fn sub(&self, o: &Exp) -> Result<Exp, Fail> {
        self.add(&o.neg()?)
    }

    pub fn mul_i64(&self, n: i64) -> Result<Exp, Fail> {
        if let Exp::S(a) = self {
            if let Some(c) = a.checked_mul(n) {
                return Ok(Exp::S(c));
            }
        }
        let (an, am) = self.parts();
        let prod = am.mul(&Nat::from_u64(n.unsigned_abs()))?;
        Ok(Exp::from_parts(an != (n < 0) && !prod.is_zero(), prod))
    }

    /// self * n for an integer n of any size.
    pub fn mul_int(&self, n: &crate::int::Int) -> Result<Exp, Fail> {
        if let (Exp::S(a), Some(b)) = (self, n.to_i64()) {
            if let Some(c) = a.checked_mul(b) {
                return Ok(Exp::S(c));
            }
        }
        let (an, am) = self.parts();
        let prod = am.mul(&n.mag)?;
        Ok(Exp::from_parts(an != n.neg && !prod.is_zero(), prod))
    }

    /// The exponent of an integer value.
    pub fn from_int(n: &crate::int::Int) -> Exp {
        Exp::from_parts(n.neg, n.mag.clone())
    }

    /// As a Python int.
    pub fn to_int(&self) -> crate::int::Int {
        let (neg, mag) = self.parts();
        crate::int::Int::new(neg, mag)
    }

    /// Python's floor division by 2.
    pub fn floor_div2(&self) -> Result<Exp, Fail> {
        match self {
            Exp::S(x) => Ok(Exp::S(x.div_euclid(2))),
            Exp::B { neg, mag } => {
                let h = mag.shr(1)?;
                if *neg && mag.is_odd() {
                    Ok(Exp::from_parts(true, h.add_u64(1)?))
                } else {
                    Ok(Exp::from_parts(*neg, h))
                }
            }
        }
    }

    pub fn cmp(&self, o: &Exp) -> Ordering {
        if let (Exp::S(a), Exp::S(b)) = (self, o) {
            return a.cmp(b);
        }
        let (an, am) = self.parts();
        let (bn, bm) = o.parts();
        match (an, bn) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => am.cmp_mag(&bm),
            (true, true) => bm.cmp_mag(&am),
        }
    }

    pub fn gt_i64(&self, n: i64) -> bool {
        self.cmp(&Exp::S(n)) == Ordering::Greater
    }
    pub fn lt_i64(&self, n: i64) -> bool {
        self.cmp(&Exp::S(n)) == Ordering::Less
    }

    /// A nonnegative value as a shift distance or count; past u64 it is a
    /// number too large for the call (the mantissa it would size could never
    /// be allocated): the limit refusal, before any allocation.
    pub fn as_shift(&self) -> Result<u64, Fail> {
        match self {
            Exp::S(x) if *x >= 0 => Ok(*x as u64),
            Exp::B { neg: false, mag } => mag.to_u64().ok_or(Fail::Limit { limbs: u64::MAX }),
            _ => Err(Fail::Limit { limbs: u64::MAX }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotion_at_the_i64_edge_both_signs() {
        counter::take();
        let max = Exp::S(i64::MAX);
        assert_eq!(counter::take(), 0);
        let one_past = max.add_i64(1).unwrap();
        assert!(matches!(one_past, Exp::B { neg: false, .. }));
        assert_eq!(counter::take(), 1);
        assert_eq!(one_past.add_i64(-1).unwrap(), Exp::S(i64::MAX));
        let min = Exp::S(i64::MIN);
        assert!(matches!(min.add_i64(-1).unwrap(), Exp::B { neg: true, .. }));
        assert_eq!(min.neg().unwrap().add_i64(-1).unwrap(), Exp::S(i64::MAX));
        // a product of two in-range values that leaves i64
        let p = Exp::S(1 << 62).mul_i64(2).unwrap();
        assert!(matches!(p, Exp::B { neg: false, .. }));
        assert_eq!(Exp::S(1 << 62).mul_i64(-2).unwrap(), Exp::S(i64::MIN));
        assert_eq!(Exp::S(-7).floor_div2().unwrap(), Exp::S(-4));
        let big_odd_neg = Exp::S(i64::MIN).add_i64(-3).unwrap();
        let h = big_odd_neg.floor_div2().unwrap();
        // (-(2^63) - 3) // 2 = -(2^62) - 2
        assert_eq!(h, Exp::S(-(1i64 << 62) - 2));
        assert_eq!(Exp::S(5).cmp(&one_past), Ordering::Less);
    }
}
