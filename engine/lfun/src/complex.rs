//! A complex double: just what the Gamma functions and the L-series need.

use std::ops::{Add, Div, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct C64 {
    pub re: f64,
    pub im: f64,
}

impl C64 {
    pub const ZERO: C64 = C64 { re: 0.0, im: 0.0 };
    pub const ONE: C64 = C64 { re: 1.0, im: 0.0 };
    pub const I: C64 = C64 { re: 0.0, im: 1.0 };

    pub const fn new(re: f64, im: f64) -> C64 {
        C64 { re, im }
    }

    pub const fn real(re: f64) -> C64 {
        C64 { re, im: 0.0 }
    }

    pub fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }

    pub fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }

    pub fn conj(self) -> C64 {
        C64::new(self.re, -self.im)
    }

    pub fn scale(self, k: f64) -> C64 {
        C64::new(self.re * k, self.im * k)
    }

    /// e^z
    pub fn exp(self) -> C64 {
        let m = self.re.exp();
        let (s, c) = self.im.sin_cos();
        C64::new(m * c, m * s)
    }

    /// The principal logarithm: imaginary part in (-pi, pi].
    pub fn ln(self) -> C64 {
        C64::new(self.abs().ln(), self.arg())
    }

    /// 1/z, scaled so that neither part overflows for large or small |z|.
    pub fn recip(self) -> C64 {
        if !moderate(self) {
            return C64::ONE.div_scaled(self);
        }
        self.recip_smith()
    }

    /// Smith's 1/z, exact for parts of moderate size (moderate()).
    fn recip_smith(self) -> C64 {
        if self.re.abs() >= self.im.abs() {
            let r = self.im / self.re;
            let d = self.re + self.im * r;
            C64::new(1.0 / d, -r / d)
        } else {
            let r = self.re / self.im;
            let d = self.re * r + self.im;
            C64::new(r / d, -1.0 / d)
        }
    }

    pub fn is_finite(self) -> bool {
        self.re.is_finite() && self.im.is_finite()
    }

    /// self / o with both scaled by the same power of two (exact), the one
    /// that brings the divisor's larger part near 1: the quotient is the same,
    /// and the divisor's reciprocal is then a moderate number.  (Smith's 1/z
    /// overflowed its denominator at 1e308 + 1e308 i and gave 0; division by
    /// way of the reciprocal gave inf and NaN at 1e-309 + 1e-309 i, whose
    /// quotient by itself is 1: Codex audit A05-F2.)  The dividend is not
    /// scaled by its own size: that flushed its smaller part, and (1e308 +
    /// 1e-308 i) / 1 lost the 1e-308.  A dividend part that the common scaling
    /// takes out of the doubles is a quotient part out of them too (to within
    /// the divisor's factor of 2).
    fn div_scaled(self, o: C64) -> C64 {
        let mb = o.re.abs().max(o.im.abs());
        if !(self.is_finite() && mb.is_finite() && mb > 0.0) {
            // (a zero divisor, infinities and NaNs as the plain formula gives them)
            return self * o.recip_smith();
        }
        // (the divisor scaled by a power of two to a larger part in [1, 2):
        // exact; then Smith's quotient part by part, each part's two terms
        // brought near 1 by their own power of two before they are added and
        // divided, and that power and the divisor's taken back after: each
        // part rounds once at its own scale, and neither a huge nor a tiny
        // part of the dividend flushes or inflates the other)
        let eb = ilog2(mb);
        let (br, bi) = (scale2(o.re, -eb), scale2(o.im, -eb));
        let (a, c) = (self.re, self.im);
        // (Smith's ratio r = p / q is never formed: a subnormal r, or one that
        // underflows to 0, lost the term y r; y p / q is taken from the three
        // mantissas instead, part(), with p and q the divisor's own parts: the
        // scaled smaller part can underflow where the ratio's terms don't)
        if br.abs() >= bi.abs() {
            let den = br + bi * (bi / br);
            C64::new(part(a, c, o.im, o.re, den, -eb), part(c, -a, o.im, o.re, den, -eb))
        } else {
            let den = br * (br / bi) + bi;
            C64::new(part(c, a, o.re, o.im, den, -eb), part(-a, c, o.re, o.im, den, -eb))
        }
    }

}

/// (x + y p / q) / den 2^s, with the two terms first brought near 1 by one
/// power of two, so that the sum and the quotient round once, at their own
/// scale; y p / q from the three mantissas and its exponent applied once, so
/// that no factor alone passes the doubles on the way (scaling y first
/// overflowed at y = 1e308, p / q = 1e-308) and the ratio p / q is never
/// rounded by itself (subnormal, or 0, it lost the term).  (p and q are of
/// any finite size with |p| <= |q|; den is moderate, in [1, 4).)
fn part(x: f64, y: f64, p: f64, q: f64, den: f64, s: i32) -> f64 {
    let ex = if x != 0.0 { Some(ilog2(x.abs())) } else { None };
    let ey = if y != 0.0 && p != 0.0 { Some(ilog2(y.abs()) + ilog2(p.abs()) - ilog2(q.abs())) } else { None };
    let k = match (ex, ey) {
        (Some(a), Some(b)) => -a.max(b),
        (Some(a), None) | (None, Some(a)) => -a,
        (None, None) => 0,
    };
    // (a zero term is left out: a huge y scaled for a tiny x would be inf, and inf * 0 NaN)
    let tx = if ex.is_some() { scale2(x, k) } else { x };
    let ty = if ey.is_some() {
        let ((my, e1), (mp, e2), (mq, e3)) = (mant(y), mant(p), mant(q));
        // (the ratio first: p = q gives exactly y, and z / z exactly 1)
        scale2(my * (mp / mq), e1 + e2 - e3 + k)
    } else {
        0.0
    };
    let v = (tx + ty) / den;
    scale2(v, s - k)
}

/// Each part 0 or within 2^-500..2^500, and the two within 2^500 of each
/// other: Smith's formulas neither overflow nor lose a term there (their ratio
/// of the parts is a normal double), and keep their bits as before.  (A
/// lopsided z, (7.9e6 + 8.8e-302 i) say, lost its small part's term through a
/// subnormal ratio.)
fn moderate(z: C64) -> bool {
    let ok = |v: f64| v == 0.0 || (v.abs() > 2f64.powi(-500) && v.abs() < 2f64.powi(500));
    let lopsided = z.re != 0.0 && z.im != 0.0 && (ilog2(z.re.abs()) - ilog2(z.im.abs())).abs() > 500;
    ok(z.re) && ok(z.im) && !lopsided
}

/// floor(log2 m) for a finite m > 0, exactly, from its bits (subnormals
/// included): f64::log2 is the host's and can round up just below a power of 2.
fn ilog2(m: f64) -> i32 {
    let bits = m.to_bits() & !(1u64 << 63);
    let e = (bits >> 52) as i32;
    if e == 0 {
        // (subnormal: m = f 2^-1074 with f the 52-bit fraction)
        let f = bits & ((1u64 << 52) - 1);
        63 - f.leading_zeros() as i32 - 1074
    } else {
        e - 1023
    }
}

/// m 2^-e with e = ilog2(m): v's mantissa, in [1, 2) up to sign (v finite, nonzero).
fn mant(v: f64) -> (f64, i32) {
    let e = ilog2(v.abs());
    (scale2(v, -e), e)
}

/// x 2^n, exact unless the result leaves the doubles (in steps a double holds).
fn scale2(mut x: f64, mut n: i32) -> f64 {
    while n > 1000 {
        x *= 2f64.powi(1000);
        n -= 1000;
    }
    while n < -1000 {
        x *= 2f64.powi(-1000);
        n += 1000;
    }
    x * 2f64.powi(n)
}

impl Add for C64 {
    type Output = C64;
    fn add(self, o: C64) -> C64 {
        C64::new(self.re + o.re, self.im + o.im)
    }
}

impl Sub for C64 {
    type Output = C64;
    fn sub(self, o: C64) -> C64 {
        C64::new(self.re - o.re, self.im - o.im)
    }
}

impl Mul for C64 {
    type Output = C64;
    fn mul(self, o: C64) -> C64 {
        C64::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
}

impl Div for C64 {
    type Output = C64;
    #[allow(clippy::suspicious_arithmetic_impl)]
    fn div(self, o: C64) -> C64 {
        if moderate(self) && moderate(o) {
            return self * o.recip_smith();
        }
        self.div_scaled(o)
    }
}

impl Neg for C64 {
    type Output = C64;
    fn neg(self) -> C64 {
        C64::new(-self.re, -self.im)
    }
}

impl Add<f64> for C64 {
    type Output = C64;
    fn add(self, o: f64) -> C64 {
        C64::new(self.re + o, self.im)
    }
}

impl Sub<f64> for C64 {
    type Output = C64;
    fn sub(self, o: f64) -> C64 {
        C64::new(self.re - o, self.im)
    }
}

impl Mul<f64> for C64 {
    type Output = C64;
    fn mul(self, o: f64) -> C64 {
        self.scale(o)
    }
}
