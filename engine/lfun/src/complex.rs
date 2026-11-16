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
        self * o.recip()
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
