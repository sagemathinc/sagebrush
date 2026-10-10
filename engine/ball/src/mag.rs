//! `Mag`: upper bounds for nonnegative reals, the radii of balls.
//!
//! A `Mag` is `m 2^e` with `m < 2^32` (normalized to `2^31 <= m` when not
//! zero), or +infinity.  Every operation rounds up, except those named
//! `_down`, which round down (lower bounds, for denominators).

use num_traits::{ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

const MBITS: u32 = 32;
/// Exponents are kept within +-2^60: beyond, a value is infinite (up) or 0
/// (down), and stays a valid bound.
const EMAX: i64 = 1 << 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mag {
    m: u64,
    e: i64,
}

impl Mag {
    pub const ZERO: Mag = Mag { m: 0, e: 0 };
    pub const INF: Mag = Mag { m: 1 << (MBITS - 1), e: i64::MAX };

    pub fn is_zero(self) -> bool {
        self.m == 0
    }

    pub fn is_inf(self) -> bool {
        self.e == i64::MAX
    }

    /// 2^k exactly.
    pub fn pow2(k: i64) -> Mag {
        Mag::make_up(1 << (MBITS - 1), k.saturating_sub(MBITS as i64 - 1))
    }

    fn make_up(m: u64, e: i64) -> Mag {
        if m == 0 {
            return Mag::ZERO;
        }
        if e > EMAX {
            return Mag::INF;
        }
        // (a tiny value: its exponent clamped up, a larger bound)
        Mag { m, e: e.max(-EMAX) }
    }

    fn make_down(m: u64, e: i64) -> Mag {
        if m == 0 || e < -EMAX {
            return Mag::ZERO;
        }
        if e > EMAX {
            // (an enormous lower bound: kept as the largest finite one)
            return Mag { m, e: EMAX };
        }
        Mag { m, e }
    }

    /// x 2^e rounded up.
    pub fn from_u128_up(x: u128, e: i64) -> Mag {
        if x == 0 {
            return Mag::ZERO;
        }
        if e == i64::MAX {
            return Mag::INF;
        }
        let b = 128 - x.leading_zeros();
        if b <= MBITS {
            let s = MBITS - b;
            return Mag::make_up((x as u64) << s, e.saturating_sub(s as i64));
        }
        let s = b - MBITS;
        let mut q = (x >> s) as u64;
        if x & ((1u128 << s) - 1) != 0 {
            q += 1;
        }
        if q == 1 << MBITS {
            return Mag::make_up(q >> 1, e.saturating_add(s as i64 + 1));
        }
        Mag::make_up(q, e.saturating_add(s as i64))
    }

    /// x 2^e rounded down.
    pub fn from_u128_down(x: u128, e: i64) -> Mag {
        if x == 0 {
            return Mag::ZERO;
        }
        let b = 128 - x.leading_zeros();
        if b <= MBITS {
            let s = MBITS - b;
            return Mag::make_down((x as u64) << s, e.saturating_sub(s as i64));
        }
        let s = b - MBITS;
        Mag::make_down((x >> s) as u64, e.saturating_add(s as i64))
    }

    pub fn from_u64(x: u64) -> Mag {
        Mag::from_u128_up(x as u128, 0)
    }

    /// |x| 2^e rounded up.
    pub fn from_bigint_up(x: &BigInt, e: i64) -> Mag {
        if x.is_zero() {
            return Mag::ZERO;
        }
        let a = num_traits::Signed::abs(x);
        let b = a.bits();
        if b <= 120 {
            return Mag::from_u128_up(a.to_u128().unwrap(), e);
        }
        let s = b - 64;
        let q = (&a >> s).to_u128().unwrap();
        let inexact = a.trailing_zeros().unwrap_or(0) < s;
        Mag::from_u128_up(q + inexact as u128, e.saturating_add(s as i64))
    }

    /// |x| 2^e rounded down.
    pub fn from_bigint_down(x: &BigInt, e: i64) -> Mag {
        if x.is_zero() {
            return Mag::ZERO;
        }
        let a = num_traits::Signed::abs(x);
        let b = a.bits();
        if b <= 120 {
            return Mag::from_u128_down(a.to_u128().unwrap(), e);
        }
        let s = b - 64;
        Mag::from_u128_down((&a >> s).to_u128().unwrap(), e.saturating_add(s as i64))
    }

    /// The exact value m 2^e (`None` for infinity).
    pub fn to_dyadic(self) -> Option<(BigInt, i64)> {
        if self.is_inf() {
            return None;
        }
        Some((BigInt::from(self.m), self.e))
    }

    /// floor(log2 self) + 1, the position of the top bit (self nonzero, finite).
    pub fn top(self) -> i64 {
        self.e + (64 - self.m.leading_zeros()) as i64
    }

    pub fn add(self, o: Mag) -> Mag {
        if self.is_zero() {
            return o;
        }
        if o.is_zero() {
            return self;
        }
        if self.is_inf() || o.is_inf() {
            return Mag::INF;
        }
        let (hi, lo) = if self.e >= o.e { (self, o) } else { (o, self) };
        let d = hi.e - lo.e;
        if d >= 64 {
            // lo < 2^(lo.e + 32) <= 2^hi.e, one unit of hi's mantissa
            return Mag::from_u128_up(hi.m as u128 + 1, hi.e);
        }
        Mag::from_u128_up(((hi.m as u128) << d) + lo.m as u128, lo.e)
    }

    pub fn mul(self, o: Mag) -> Mag {
        if self.is_zero() || o.is_zero() {
            return Mag::ZERO;
        }
        if self.is_inf() || o.is_inf() {
            return Mag::INF;
        }
        Mag::from_u128_up(self.m as u128 * o.m as u128, self.e.saturating_add(o.e))
    }

    pub fn mul_down(self, o: Mag) -> Mag {
        if self.is_zero() || o.is_zero() {
            return Mag::ZERO;
        }
        Mag::from_u128_down(self.m as u128 * o.m as u128, self.e.saturating_add(o.e))
    }

    pub fn mul_2exp(self, k: i64) -> Mag {
        if self.is_zero() || self.is_inf() {
            return self;
        }
        Mag::make_up(self.m, self.e.saturating_add(k))
    }

    pub fn mul_u64(self, k: u64) -> Mag {
        self.mul(Mag::from_u64(k))
    }

    /// self / o rounded up (o a lower bound for the divisor; o = 0 gives +inf).
    pub fn div(self, o: Mag) -> Mag {
        if self.is_zero() {
            return Mag::ZERO;
        }
        if o.is_zero() || self.is_inf() {
            return Mag::INF;
        }
        if o.is_inf() {
            // (self finite over an infinite divisor: 0, but o is a lower
            // bound here only as a magnitude: keep the smallest positive)
            return Mag::ZERO;
        }
        let num = (self.m as u128) << 64;
        let d = o.m as u128;
        let q = num / d + (num % d != 0) as u128;
        Mag::from_u128_up(q, self.e.saturating_sub(64).saturating_sub(o.e))
    }

    /// self / o rounded down (o an upper bound for the divisor).
    pub fn div_down(self, o: Mag) -> Mag {
        if self.is_zero() || o.is_inf() {
            return Mag::ZERO;
        }
        if o.is_zero() {
            return Mag::INF;
        }
        let num = (self.m as u128) << 64;
        Mag::from_u128_down(num / o.m as u128, self.e.saturating_sub(64).saturating_sub(o.e))
    }

    pub fn div_u64(self, k: u64) -> Mag {
        self.div(Mag::from_u128_down(k as u128, 0))
    }

    /// sqrt(self) rounded up.
    pub fn sqrt(self) -> Mag {
        if self.is_zero() || self.is_inf() {
            return self;
        }
        // m 2^e = (m 2^(64 + odd)) 2^(e - 64 - odd), the exponent even
        let odd = self.e.rem_euclid(2);
        let x = (self.m as u128) << (64 + odd);
        let s = isqrt_u128(x);
        let s = s + (s * s != x) as u128;
        Mag::from_u128_up(s, (self.e - 64 - odd) / 2)
    }

    pub fn max(self, o: Mag) -> Mag {
        if self.cmp(&o) == Ordering::Less {
            o
        } else {
            self
        }
    }

    /// Whether self <= 2^k, exactly (not against pow2(k), which rounds up
    /// beyond the exponent range: the review's BALL-F2).
    pub fn le_pow2(self, k: i64) -> bool {
        if self.is_zero() {
            return true;
        }
        if self.is_inf() {
            return false;
        }
        // m in [2^31, 2^32): m 2^e <= 2^k iff e + 31 < k, or e + 31 = k and m = 2^31
        let lo = self.e + (MBITS as i64 - 1);
        lo < k || (lo == k && self.m == 1 << (MBITS - 1))
    }
}

impl PartialOrd for Mag {
    fn partial_cmp(&self, o: &Mag) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl Ord for Mag {
    fn cmp(&self, o: &Mag) -> Ordering {
        match (self.is_zero(), o.is_zero()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        match (self.is_inf(), o.is_inf()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            _ => {}
        }
        // both normalized: the top bit decides, then the mantissas
        self.top().cmp(&o.top()).then_with(|| {
            let (a, b) = (self.m << self.m.leading_zeros(), o.m << o.m.leading_zeros());
            a.cmp(&b)
        })
    }
}

pub(crate) fn isqrt_u128(x: u128) -> u128 {
    if x < 2 {
        return x;
    }
    let mut r = (x as f64).sqrt() as u128;
    while r * r > x {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= x {
        r += 1;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn val(m: Mag) -> f64 {
        m.m as f64 * 2f64.powi(m.e as i32)
    }

    #[test]
    fn rounding_directions() {
        let a = Mag::from_u128_up(u128::MAX, 0);
        assert!(val(a) >= u128::MAX as f64);
        let third = Mag::from_u64(1).div(Mag::from_u64(3));
        let third_down = Mag::from_u64(1).div_down(Mag::from_u64(3));
        assert!(third_down < third);
        assert!(val(third) >= 1.0 / 3.0 && val(third_down) <= 1.0 / 3.0);
        assert_eq!(Mag::from_u64(4).sqrt(), Mag::from_u64(2));
        assert!(val(Mag::from_u64(2).sqrt()) >= std::f64::consts::SQRT_2);
        let s = Mag::pow2(-100).add(Mag::pow2(0));
        assert!(s > Mag::pow2(0) && s < Mag::pow2(1));
        assert_eq!(Mag::pow2(10).mul(Mag::pow2(-3)), Mag::pow2(7));
        assert!(Mag::pow2(-5).le_pow2(-5) && !Mag::pow2(-5).le_pow2(-6));
    }
}
