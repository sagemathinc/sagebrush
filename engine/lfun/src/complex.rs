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
        let eb = ilog2(mb);
        let b = C64::new(scale2(o.re, -eb), scale2(o.im, -eb));
        // (scaled up, the dividend could pass the doubles though the quotient
        // doesn't, 1 / 1e-308 among them: it goes up to 2^1020 at most, and
        // the rest of the factor is applied to the quotient, exactly; it is
        // never scaled down for its own size, which would flush its smaller part)
        let ma = self.re.abs().max(self.im.abs());
        let mut k = -eb;
        if k > 0 && ma > 0.0 && ilog2(ma) + k > 1020 {
            k = (1020 - ilog2(ma)).max(0);
        }
        let a = C64::new(scale2(self.re, k), scale2(self.im, k));
        let q = a * b.recip_smith();
        let rest = -eb - k;
        if rest == 0 {
            q
        } else {
            C64::new(scale2(q.re, rest), scale2(q.im, rest))
        }
    }
}

/// Parts within 2^-500..2^500 (or 0): Smith's formulas neither overflow nor
/// lose the quotient there, and keep their bits as before.
fn moderate(z: C64) -> bool {
    let m = z.re.abs().max(z.im.abs());
    m == 0.0 || (m > 2f64.powi(-500) && m < 2f64.powi(500))
}

/// floor(log2 m) for a finite m > 0 (subnormals included).
fn ilog2(m: f64) -> i32 {
    m.log2().floor() as i32
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
