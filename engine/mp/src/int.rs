//! Signed integers with Python's semantics, for mpmath's fixed-point
//! arithmetic: `>>` and `//` floor toward minus infinity, `divmod` gives a
//! remainder with the divisor's sign, and `abs`, `<<`, `+`, `-`, `*` are
//! exact.  A sign and a Nat magnitude; zero is never negative.

use crate::nat::Nat;
use core::cmp::Ordering;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Int {
    pub neg: bool,
    pub mag: Nat,
}

impl From<Nat> for Int {
    fn from(mag: Nat) -> Int {
        Int { neg: false, mag }
    }
}

impl Int {
    pub fn new(neg: bool, mag: Nat) -> Int {
        let neg = neg && !mag.is_zero();
        Int { neg, mag }
    }

    pub fn zero() -> Int {
        Int::default()
    }

    pub fn from_i64(x: i64) -> Int {
        Int::new(x < 0, Nat::from_u64(x.unsigned_abs()))
    }

    /// 1 << k
    pub fn pow2(k: u64) -> Int {
        Int::from(Nat::from_u64(1).shl(k))
    }

    pub fn is_zero(&self) -> bool {
        self.mag.is_zero()
    }

    pub fn is_neg(&self) -> bool {
        self.neg
    }

    pub fn to_i64(&self) -> Option<i64> {
        let m = self.mag.to_u64()?;
        if self.neg {
            if m <= 1u64 << 63 {
                Some((m as i64).wrapping_neg())
            } else {
                None
            }
        } else {
            i64::try_from(m).ok()
        }
    }

    pub fn neg(&self) -> Int {
        Int::new(!self.neg, self.mag.clone())
    }

    pub fn abs(&self) -> Int {
        Int::from(self.mag.clone())
    }

    pub fn cmp(&self, o: &Int) -> Ordering {
        match (self.neg, o.neg) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.mag.cmp_mag(&o.mag),
            (true, true) => o.mag.cmp_mag(&self.mag),
        }
    }

    pub fn add(&self, o: &Int) -> Int {
        if self.neg == o.neg {
            return Int::new(self.neg, self.mag.add(&o.mag));
        }
        match self.mag.cmp_mag(&o.mag) {
            Ordering::Less => Int::new(o.neg, o.mag.sub(&self.mag)),
            _ => Int::new(self.neg, self.mag.sub(&o.mag)),
        }
    }

    pub fn sub(&self, o: &Int) -> Int {
        self.add(&o.neg())
    }

    pub fn mul(&self, o: &Int) -> Int {
        Int::new(self.neg != o.neg, self.mag.mul(&o.mag))
    }

    pub fn mul_i64(&self, n: i64) -> Int {
        self.mul(&Int::from_i64(n))
    }

    pub fn shl(&self, k: u64) -> Int {
        Int::new(self.neg, self.mag.shl(k))
    }

    /// x >> k, flooring (Python's arithmetic shift).
    pub fn shr(&self, k: u64) -> Int {
        if !self.neg {
            return Int::from(self.mag.shr(k));
        }
        // -((|x| - 1) >> k) - 1
        Int::new(true, self.mag.sub_u64(1).shr(k).add_u64(1))
    }

    /// x << s for s >= 0, x >> -s otherwise (mpmath's shift by an offset).
    pub fn shift(&self, s: i64) -> Int {
        if s >= 0 {
            self.shl(s as u64)
        } else {
            self.shr(s.unsigned_abs())
        }
    }

    /// divmod(self, o) with Python's floor semantics (o zero: the
    /// reference's ZeroDivisionError).
    pub fn divmod(&self, o: &Int) -> (Int, Int) {
        let (q, r) = self.mag.divmod(&o.mag);
        if self.neg == o.neg {
            return (Int::from(q), Int::new(self.neg, r));
        }
        // opposite signs: floor the quotient
        if r.is_zero() {
            return (Int::new(true, q), Int::zero());
        }
        (Int::new(true, q.add_u64(1)), Int::new(o.neg, o.mag.sub(&r)))
    }

    pub fn floordiv(&self, o: &Int) -> Int {
        self.divmod(o).0
    }

    pub fn floordiv_i64(&self, n: i64) -> Int {
        self.floordiv(&Int::from_i64(n))
    }

    pub fn bits(&self) -> u64 {
        self.mag.bits()
    }

    pub fn is_odd(&self) -> bool {
        self.mag.is_odd()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floors_like_python() {
        let i = Int::from_i64;
        assert_eq!(i(-7).shr(1), i(-4));
        assert_eq!(i(-8).shr(1), i(-4));
        assert_eq!(i(-1).shr(10), i(-1));
        assert_eq!(i(7).shr(1), i(3));
        assert_eq!(i(-7).divmod(&i(2)), (i(-4), i(1)));
        assert_eq!(i(7).divmod(&i(-2)), (i(-4), i(-1)));
        assert_eq!(i(-7).divmod(&i(-2)), (i(3), i(-1)));
        assert_eq!(i(-6).divmod(&i(2)), (i(-3), i(0)));
        assert_eq!(i(-3).add(&i(5)), i(2));
        assert_eq!(i(3).sub(&i(5)), i(-2));
        assert_eq!(i(-3).mul(&i(-5)), i(15));
    }
}
