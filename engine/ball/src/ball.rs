//! `Ball`: a real interval [mid - rad, mid + rad], mid = m 2^e exact.

use crate::mag::Mag;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

/// Midpoint exponents and top bits stay within +-2^40; beyond, a result is
/// the ball of everything (midpoint 0, infinite radius), still a valid
/// enclosure (the review's BALL-F1: i64 exponents wrapped around).
pub const EXP_MAX: i64 = 1 << 40;
/// A radius stays within 2^20 bits of the midpoint: a smaller one is
/// rounded up to 2^(top - 2^20), a midpoint that much below the radius goes
/// into it.  So exact endpoints never exceed about 2^20 bits plus the
/// midpoint's (BALL-F4: 1 +- 2^-(2^40) built a trillion-bit endpoint).
pub const GAP: i64 = 1 << 20;

#[derive(Clone, Debug)]
pub struct Ball {
    pub(crate) m: BigInt,
    pub(crate) e: i64,
    pub(crate) r: Mag,
}

/// The position of the top bit of |m| 2^e (m nonzero): floor(log2 |x|) + 1.
pub(crate) fn top(m: &BigInt, e: i64) -> i64 {
    e.saturating_add(m.bits() as i64)
}

/// The order of the exact dyadics a 2^ae and b 2^be.
pub fn cmp_dyadic(a: &BigInt, ae: i64, b: &BigInt, be: i64) -> Ordering {
    let (sa, sb) = (a.sign_i8(), b.sign_i8());
    if sa != sb || sa == 0 {
        return sa.cmp(&sb);
    }
    let (ta, tb) = (top(a, ae), top(b, be));
    if ta != tb {
        // the same sign: the larger magnitude is the larger number when positive
        let o = ta.cmp(&tb);
        return if sa > 0 { o } else { o.reverse() };
    }
    // the same top bit: the shift is at most the bit lengths' difference
    if ae >= be {
        (a << (ae - be) as u64).cmp(b)
    } else {
        a.cmp(&(b << (be - ae) as u64))
    }
}

trait SignI8 {
    fn sign_i8(&self) -> i8;
}
impl SignI8 for BigInt {
    fn sign_i8(&self) -> i8 {
        if self.is_zero() {
            0
        } else if self.is_negative() {
            -1
        } else {
            1
        }
    }
}

/// a 2^ae + b 2^be exactly.
pub(crate) fn add_dyadic(a: &BigInt, ae: i64, b: &BigInt, be: i64) -> (BigInt, i64) {
    if a.is_zero() {
        return (b.clone(), be);
    }
    if b.is_zero() {
        return (a.clone(), ae);
    }
    if ae >= be {
        ((a << (ae - be) as u64) + b, be)
    } else {
        (a + (b << (be - ae) as u64), ae)
    }
}

/// m 2^e rounded to prec bits (nearest): (m', e', error bound).
pub(crate) fn round(m: BigInt, e: i64, prec: u64) -> (BigInt, i64, Mag) {
    let b = m.bits();
    if b <= prec {
        return (m, e, Mag::ZERO);
    }
    let s = b - prec;
    if m.trailing_zeros().unwrap_or(0) >= s {
        return (m >> s, e + s as i64, Mag::ZERO);
    }
    let neg = m.is_negative();
    let a = m.abs();
    let mut q = &a >> s;
    if a.bit(s - 1) {
        q += 1u32;
    }
    let q = if neg { -q } else { q };
    // |m 2^e - q 2^(e + s)| <= 2^(e + s - 1)
    (q, e + s as i64, Mag::pow2(e + s as i64 - 1))
}

impl Ball {
    /// The ball of every real number.
    pub fn indeterminate() -> Ball {
        Ball { m: BigInt::zero(), e: 0, r: Mag::INF }
    }

    /// The invariants (EXP_MAX, GAP), applied after every operation.
    fn normalize(mut self) -> Ball {
        if self.r.is_inf() {
            return Ball::indeterminate();
        }
        if !self.m.is_zero() {
            let t = top(&self.m, self.e);
            if self.e.unsigned_abs() > EXP_MAX as u64 || t.unsigned_abs() > EXP_MAX as u64 {
                return Ball::indeterminate();
            }
            if !self.r.is_zero() {
                let tr = self.r.top();
                if tr > EXP_MAX {
                    return Ball::indeterminate();
                }
                if tr < t - GAP {
                    self.r = Mag::pow2(t - GAP);
                } else if t < tr - GAP {
                    self.r = self.r.add(Mag::from_bigint_up(&self.m, self.e));
                    self.m = BigInt::zero();
                    self.e = 0;
                }
            }
        } else {
            self.e = 0;
            if !self.r.is_zero() && self.r.top() > EXP_MAX {
                return Ball::indeterminate();
            }
        }
        self
    }

    /// The exact value m 2^e (the ball of everything if the exponent is
    /// beyond +-EXP_MAX).
    pub fn exact(m: BigInt, e: i64) -> Ball {
        Ball { m, e, r: Mag::ZERO }.normalize()
    }

    pub fn zero() -> Ball {
        Ball::exact(BigInt::zero(), 0)
    }

    pub fn one() -> Ball {
        Ball::exact(BigInt::one(), 0)
    }

    pub fn from_i64(x: i64) -> Ball {
        Ball::exact(BigInt::from(x), 0)
    }

    pub fn from_int(x: &BigInt) -> Ball {
        Ball::exact(x.clone(), 0)
    }

    /// A double, exactly (no rounding: every finite double is a dyadic).
    pub fn from_f64_exact(x: f64) -> Option<Ball> {
        if !x.is_finite() {
            return None;
        }
        if x == 0.0 {
            return Some(Ball::zero());
        }
        let bits = x.to_bits();
        let sign = if bits >> 63 == 1 { -1 } else { 1 };
        let ex = ((bits >> 52) & 0x7ff) as i64;
        let frac = bits & ((1u64 << 52) - 1);
        let (m, e) = if ex == 0 { (frac, -1074) } else { (frac | (1u64 << 52), ex - 1075) };
        Some(Ball::exact(BigInt::from(m) * sign, e))
    }

    /// p/q to prec bits (q != 0).
    pub fn from_rational(p: &BigInt, q: &BigInt, prec: u64) -> Ball {
        Ball::from_int(p).div(&Ball::from_int(q), prec).expect("division by zero")
    }

    /// A ball with an explicit midpoint and radius.
    pub fn with_radius(m: BigInt, e: i64, r: Mag) -> Ball {
        Ball { m, e, r }.normalize()
    }

    pub fn mid(&self) -> (BigInt, i64) {
        (self.m.clone(), self.e)
    }

    pub fn rad(&self) -> Mag {
        self.r
    }

    pub fn is_exact(&self) -> bool {
        self.r.is_zero()
    }

    pub fn is_finite(&self) -> bool {
        !self.r.is_inf()
    }

    /// The midpoint rounded to prec bits, its error added to the radius.
    pub fn rounded(&self, prec: u64) -> Ball {
        let prec = prec.min(crate::funcs::PREC_MAX);
        let (m, e, err) = round(self.m.clone(), self.e, prec);
        Ball { m, e, r: self.r.add(err) }.normalize()
    }

    pub fn add_error(&self, err: Mag) -> Ball {
        Ball { m: self.m.clone(), e: self.e, r: self.r.add(err) }.normalize()
    }

    /// |mid| + rad, rounded up.
    pub fn upper_abs(&self) -> Mag {
        Mag::from_bigint_up(&self.m, self.e).add(self.r)
    }

    /// A lower bound for min |x| over the ball (0 when it contains 0).
    pub fn lower_abs(&self) -> Mag {
        if self.contains_zero() {
            return Mag::ZERO;
        }
        let (lm, le) = self.lower();
        let (um, ue) = self.upper();
        let (a, b) = (Mag::from_bigint_down(&lm, le), Mag::from_bigint_down(&um, ue));
        if a < b { a } else { b }
    }

    /// mid - rad, exactly (None if the radius is infinite).
    pub fn lower(&self) -> (BigInt, i64) {
        let (rm, re) = self.r.to_dyadic().expect("infinite radius");
        add_dyadic(&self.m, self.e, &-rm, re)
    }

    /// mid + rad, exactly.
    pub fn upper(&self) -> (BigInt, i64) {
        let (rm, re) = self.r.to_dyadic().expect("infinite radius");
        add_dyadic(&self.m, self.e, &rm, re)
    }

    pub fn contains_zero(&self) -> bool {
        if self.r.is_inf() {
            return true;
        }
        let (rm, re) = self.r.to_dyadic().unwrap();
        cmp_dyadic(&self.m.abs(), self.e, &rm, re) != Ordering::Greater
    }

    /// Certainly > 0.
    pub fn is_positive(&self) -> bool {
        self.is_finite() && {
            let (m, e) = self.lower();
            cmp_dyadic(&m, e, &BigInt::zero(), 0) == Ordering::Greater
        }
    }

    /// Certainly < 0.
    pub fn is_negative(&self) -> bool {
        self.is_finite() && {
            let (m, e) = self.upper();
            cmp_dyadic(&m, e, &BigInt::zero(), 0) == Ordering::Less
        }
    }

    /// Certainly nonzero.
    pub fn is_nonzero(&self) -> bool {
        self.is_positive() || self.is_negative()
    }

    /// The order of every x in self and y in o, when the balls decide it.
    pub fn cmp(&self, o: &Ball) -> Option<Ordering> {
        if !self.is_finite() || !o.is_finite() {
            return None;
        }
        if self.is_exact() && o.is_exact() {
            return Some(cmp_dyadic(&self.m, self.e, &o.m, o.e));
        }
        let (su, sue) = self.upper();
        let (ol, ole) = o.lower();
        if cmp_dyadic(&su, sue, &ol, ole) == Ordering::Less {
            return Some(Ordering::Less);
        }
        let (sl, sle) = self.lower();
        let (ou, oue) = o.upper();
        if cmp_dyadic(&sl, sle, &ou, oue) == Ordering::Greater {
            return Some(Ordering::Greater);
        }
        None
    }

    /// Whether every point of o lies in self.
    pub fn contains(&self, o: &Ball) -> bool {
        if self.r.is_inf() {
            return true;
        }
        if o.r.is_inf() {
            return false;
        }
        let (sl, sle) = self.lower();
        let (su, sue) = self.upper();
        let (ol, ole) = o.lower();
        let (ou, oue) = o.upper();
        cmp_dyadic(&sl, sle, &ol, ole) != Ordering::Greater && cmp_dyadic(&ou, oue, &su, sue) != Ordering::Greater
    }

    /// Whether the balls have a point in common.
    pub fn overlaps(&self, o: &Ball) -> bool {
        if self.r.is_inf() || o.r.is_inf() {
            return true;
        }
        let (sl, sle) = self.lower();
        let (su, sue) = self.upper();
        let (ol, ole) = o.lower();
        let (ou, oue) = o.upper();
        cmp_dyadic(&sl, sle, &ou, oue) != Ordering::Greater && cmp_dyadic(&ol, ole, &su, sue) != Ordering::Greater
    }

    /// A ball containing a and b: the smallest (to the radius's rounding)
    /// when their endpoints are within 2^22 bits of each other; else one
    /// centered at a's midpoint (BALL-F6: no unbounded alignment, and an
    /// infinite ball gives the ball of everything).
    pub fn hull(a: &Ball, b: &Ball) -> Ball {
        if !a.is_finite() || !b.is_finite() {
            return Ball::indeterminate();
        }
        let span = |x: &Ball| {
            let lo = if x.m.is_zero() { x.r.top() } else { x.e.min(x.r.top() - 34) };
            let hi = if x.m.is_zero() { x.r.top() } else { top(&x.m, x.e).max(x.r.top()) };
            (lo, hi)
        };
        let ((alo, ahi), (blo, bhi)) = (span(a), span(b));
        if ahi.max(bhi) - alo.min(blo) > 1 << 22 {
            // radius max(a.r, |b - mid(a)| + b.r), from a ball difference
            let d = b.sub(&Ball::exact(a.m.clone(), a.e), 64);
            return Ball { m: a.m.clone(), e: a.e, r: a.r.max(d.upper_abs()) }.normalize();
        }
        let (al, ale) = a.lower();
        let (bl, ble) = b.lower();
        let (au, aue) = a.upper();
        let (bu, bue) = b.upper();
        let (lo, loe) = if cmp_dyadic(&al, ale, &bl, ble) == Ordering::Less { (al, ale) } else { (bl, ble) };
        let (hi, hie) = if cmp_dyadic(&au, aue, &bu, bue) == Ordering::Greater { (au, aue) } else { (bu, bue) };
        // mid = (lo + hi)/2 exactly, rad = (hi - lo)/2 rounded up
        let (s, se) = add_dyadic(&lo, loe, &hi, hie);
        let (d, de) = add_dyadic(&hi, hie, &-lo, loe);
        Ball { m: s, e: se - 1, r: Mag::from_bigint_up(&d, de - 1) }.normalize()
    }

    pub fn neg(&self) -> Ball {
        Ball { m: -&self.m, e: self.e, r: self.r }
    }

    pub fn abs(&self) -> Ball {
        Ball { m: self.m.abs(), e: self.e, r: self.r }
    }

    /// self 2^k, exactly.
    pub fn mul_2exp(&self, k: i64) -> Ball {
        match self.e.checked_add(k) {
            Some(e) if k.unsigned_abs() <= 4 * EXP_MAX as u64 => Ball { m: self.m.clone(), e, r: self.r.mul_2exp(k) }.normalize(),
            _ => Ball::indeterminate(),
        }
    }

    pub fn add(&self, o: &Ball, prec: u64) -> Ball {
        let prec = prec.min(crate::funcs::PREC_MAX);
        let r = self.r.add(o.r);
        if o.m.is_zero() {
            return Ball { m: self.m.clone(), e: self.e, r }.rounded(prec);
        }
        if self.m.is_zero() {
            return Ball { m: o.m.clone(), e: o.e, r }.rounded(prec);
        }
        // far apart: the smaller midpoint goes into the radius (an exact sum
        // of 2^1000000 and 2^-1000000 would have two million bits)
        let (ts, to) = (top(&self.m, self.e), top(&o.m, o.e));
        let gap = prec as i64 + 8;
        if ts - to > gap {
            return Ball { m: self.m.clone(), e: self.e, r: r.add(Mag::from_bigint_up(&o.m, o.e)) }.rounded(prec);
        }
        if to - ts > gap {
            return Ball { m: o.m.clone(), e: o.e, r: r.add(Mag::from_bigint_up(&self.m, self.e)) }.rounded(prec);
        }
        let (m, e) = add_dyadic(&self.m, self.e, &o.m, o.e);
        Ball { m, e, r }.rounded(prec)
    }

    pub fn sub(&self, o: &Ball, prec: u64) -> Ball {
        self.add(&o.neg(), prec)
    }

    pub fn mul(&self, o: &Ball, prec: u64) -> Ball {
        // |xy - ab| <= |a| s + |b| r + r s for x in [a +- r], y in [b +- s]
        let ma = Mag::from_bigint_up(&self.m, self.e);
        let mb = Mag::from_bigint_up(&o.m, o.e);
        let r = ma.mul(o.r).add(mb.mul(self.r)).add(self.r.mul(o.r));
        // (exponents within +-2^40: their sum cannot overflow; normalize
        // catches one beyond the range)
        Ball { m: &self.m * &o.m, e: self.e + o.e, r }.rounded(prec)
    }

    pub fn sqr(&self, prec: u64) -> Ball {
        self.mul(self, prec)
    }

    pub fn mul_i64(&self, k: i64, prec: u64) -> Ball {
        self.mul(&Ball::from_i64(k), prec)
    }

    pub fn div_i64(&self, k: i64, prec: u64) -> Ball {
        self.div(&Ball::from_i64(k), prec).expect("division by zero")
    }

    /// self / o, or None if o contains 0.
    pub fn div(&self, o: &Ball, prec: u64) -> Option<Ball> {
        let prec = prec.min(crate::funcs::PREC_MAX);
        if o.contains_zero() {
            return None;
        }
        // the midpoint quotient a/b: q = floor(a 2^k / b) with prec + 4 bits,
        // error < 1 unit
        let (a, b) = (&self.m, &o.m);
        let k = (prec as i64 + 4 - a.bits() as i64 + b.bits() as i64).max(0) as u64;
        let (q, rem) = (a << k).div_rem(b);
        let qe = self.e - o.e - k as i64;
        let mut err = if rem.is_zero() { Mag::ZERO } else { Mag::pow2(qe) };
        // |x/y - a/b| <= (|a| s + |b| r) / (|b| (|b| - s)), |b| - s > 0
        if !self.r.is_zero() || !o.r.is_zero() {
            let ma = Mag::from_bigint_up(a, self.e);
            let mb_up = Mag::from_bigint_up(b, o.e);
            let num = ma.mul(o.r).add(mb_up.mul(self.r));
            let den = Mag::from_bigint_down(b, o.e).mul_down(o.lower_abs());
            err = err.add(num.div(den));
        }
        Some(Ball { m: q, e: qe, r: err }.rounded(prec))
    }

    pub fn recip(&self, prec: u64) -> Option<Ball> {
        Ball::one().div(self, prec)
    }

    /// sqrt over the ball's nonnegative part; None for a negative midpoint.
    /// A ball containing 0 gives [0 +- sqrt(upper)].
    pub fn sqrt(&self, prec: u64) -> Option<Ball> {
        let prec = prec.min(crate::funcs::PREC_MAX);
        if self.m.is_negative() || !self.is_finite() {
            return None;
        }
        if self.contains_zero() {
            // (only the ball's nonnegative part is in the domain: sqrt of it
            // lies in [0, sqrt(upper)], enclosed by [0 +- sqrt(upper)])
            let (um, ue) = self.upper();
            let up = Mag::from_bigint_up(&um, ue).sqrt();
            return Some(Ball { m: BigInt::zero(), e: 0, r: up }.normalize());
        }
        // the midpoint: s = isqrt(m 2^(k)) 2^((e - k)/2), error < 1 unit
        let k0 = (2 * prec as i64 + 8 - self.m.bits() as i64).max(0);
        let k = k0 + (self.e - k0).rem_euclid(2);
        let x = &self.m << k as u64;
        let s = x.sqrt();
        let se = (self.e - k) / 2;
        let mut err = if &s * &s == x { Mag::ZERO } else { Mag::pow2(se) };
        // |sqrt(y) - sqrt(m)| <= r / sqrt(m) <= r / s
        if !self.r.is_zero() {
            err = err.add(self.r.div(Mag::from_bigint_down(&s, se)));
        }
        Some(Ball { m: s, e: se, r: err }.rounded(prec))
    }

    /// (n, err): the integer n nearest self * 2^k's midpoint and an upper
    /// bound for |x 2^k - n| over the ball (fixed point at k bits).
    pub fn to_fixed(&self, k: i64) -> Option<(BigInt, Mag)> {
        if !self.is_finite() {
            return None;
        }
        let e = self.e + k;
        let r = self.r.mul_2exp(k);
        if e >= 0 {
            return Some((&self.m << e as u64, r));
        }
        let s = (-e) as u64;
        let neg = self.m.is_negative();
        let a = self.m.abs();
        let mut q = &a >> s;
        if a.bit(s - 1) {
            q += 1u32;
        }
        let exact = a.trailing_zeros().unwrap_or(0) >= s;
        let q = if neg { -q } else { q };
        // |mid 2^k - q| <= 1/2
        Some((q, if exact { r } else { r.add(Mag::pow2(-1)) }))
    }

    /// An approximation for display only (not part of any computation).
    pub fn to_f64_approx(&self) -> f64 {
        let b = self.m.bits() as i64;
        let s = (b - 60).max(0);
        let m = (&self.m >> s as u64).to_f64().unwrap_or(0.0);
        ldexp(m, self.e + s)
    }

    /// The radius as a double, for display only.
    pub fn rad_f64_approx(&self) -> f64 {
        match self.r.to_dyadic() {
            None => f64::INFINITY,
            Some((m, e)) => ldexp(m.to_f64().unwrap(), e),
        }
    }

    /// Bits of relative accuracy: about -log2(rad / |mid|) (display and
    /// precision decisions only).
    pub fn rel_accuracy_bits(&self) -> i64 {
        if self.r.is_zero() {
            return i64::MAX;
        }
        if self.m.is_zero() || self.r.is_inf() {
            return i64::MIN;
        }
        top(&self.m, self.e) - self.r.top()
    }
}

/// x 2^k for display, in steps (2^k alone underflows before x 2^k does:
/// 2^-1060 displayed as 0, the review's BALL-F5).
fn ldexp(mut x: f64, mut k: i64) -> f64 {
    // (stops as soon as x overflows or underflows: inf * 2^-k with the
    // rest of a huge k was NaN, the review's BALL-F5)
    while k > 1000 {
        x *= 2f64.powi(1000);
        k -= 1000;
        if !x.is_finite() {
            return x;
        }
    }
    while k < -1000 {
        x *= 2f64.powi(-1000);
        k += 1000;
        if x == 0.0 {
            return x;
        }
    }
    x * 2f64.powi(k as i32)
}

impl std::fmt::Display for Ball {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:e} +/- {:.3e}]", self.to_f64_approx(), self.rad_f64_approx())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: i64) -> Ball {
        Ball::from_i64(x)
    }

    #[test]
    fn arithmetic_contains() {
        let third = Ball::from_rational(&BigInt::from(1), &BigInt::from(3), 100);
        let one = third.mul_i64(3, 100);
        assert!(one.contains(&b(1)), "{}", one);
        assert!(one.rel_accuracy_bits() > 95);
        let s = b(2).sqrt(100).unwrap();
        assert!(s.sqr(100).contains(&b(2)));
        // far apart
        let big = Ball::exact(BigInt::from(1), 100000);
        let tiny = Ball::exact(BigInt::from(1), -100000);
        let sum = big.add(&tiny, 64);
        assert!(sum.contains(&big) && sum.overlaps(&big.add(&Ball::exact(BigInt::from(1), -99000), 64)));
        // cancellation is exact
        let x = Ball::exact(BigInt::from(1), 0).add(&Ball::exact(BigInt::from(1), -200), 300);
        assert!(x.sub(&b(1), 300).contains(&Ball::exact(BigInt::from(1), -200)));
        // division by a ball containing 0
        assert!(b(1).div(&Ball::with_radius(BigInt::from(1), 0, Mag::from_u64(2)), 64).is_none());
        assert_eq!(b(3).cmp(&b(2)), Some(Ordering::Greater));
        let w = Ball::with_radius(BigInt::from(2), 0, Mag::from_u64(1));
        assert_eq!(w.cmp(&b(2)), None);
        assert!(w.contains(&b(3)) && !w.contains(&b(4)));
    }

    #[test]
    fn f64_exact() {
        for x in [1.0, -0.1, 1e-310, 1e300, 5e-324] {
            let bx = Ball::from_f64_exact(x).unwrap();
            assert!(bx.is_exact());
            assert_eq!(bx.to_f64_approx(), x);
        }
    }
}
