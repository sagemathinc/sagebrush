//! Complex balls as rectangles: a real ball for each part.

use crate::ball::Ball;
use crate::mag::Mag;

#[derive(Clone, Debug)]
pub struct CBall {
    pub re: Ball,
    pub im: Ball,
}

impl CBall {
    pub fn zero() -> CBall {
        CBall { re: Ball::zero(), im: Ball::zero() }
    }

    pub fn real(re: Ball) -> CBall {
        CBall { re, im: Ball::zero() }
    }

    pub fn new(re: Ball, im: Ball) -> CBall {
        CBall { re, im }
    }

    pub fn add(&self, o: &CBall, prec: u64) -> CBall {
        CBall { re: self.re.add(&o.re, prec), im: self.im.add(&o.im, prec) }
    }

    pub fn sub(&self, o: &CBall, prec: u64) -> CBall {
        CBall { re: self.re.sub(&o.re, prec), im: self.im.sub(&o.im, prec) }
    }

    pub fn neg(&self) -> CBall {
        CBall { re: self.re.neg(), im: self.im.neg() }
    }

    /// (a + bi)(c + di) = (ac - bd) + (ad + bc) i, each part a ball
    /// expression (so each part encloses its real function of the four).
    pub fn mul(&self, o: &CBall, prec: u64) -> CBall {
        let (a, b, c, d) = (&self.re, &self.im, &o.re, &o.im);
        CBall { re: a.mul(c, prec).sub(&b.mul(d, prec), prec), im: a.mul(d, prec).add(&b.mul(c, prec), prec) }
    }

    pub fn sqr(&self, prec: u64) -> CBall {
        self.mul(self, prec)
    }

    /// times a real ball.
    pub fn scale(&self, k: &Ball, prec: u64) -> CBall {
        CBall { re: self.re.mul(k, prec), im: self.im.mul(k, prec) }
    }

    pub fn div_i64(&self, k: i64, prec: u64) -> CBall {
        CBall { re: self.re.div_i64(k, prec), im: self.im.div_i64(k, prec) }
    }

    pub fn mul_2exp(&self, k: i64) -> CBall {
        CBall { re: self.re.mul_2exp(k), im: self.im.mul_2exp(k) }
    }

    /// An error of modulus at most err: added to both parts.
    pub fn add_error(&self, err: Mag) -> CBall {
        CBall { re: self.re.add_error(err), im: self.im.add_error(err) }
    }

    /// An upper bound for |z| over the rectangle.
    pub fn upper_abs(&self) -> Mag {
        let (a, b) = (self.re.upper_abs(), self.im.upper_abs());
        a.mul(a).add(b.mul(b)).sqrt()
    }

    /// 1/z (None if the rectangle may contain 0): conj(z) / |z|^2.
    pub fn recip(&self, prec: u64) -> Option<CBall> {
        let wp = prec + 8;
        let n = self.re.sqr(wp).add(&self.im.sqr(wp), wp);
        Some(CBall { re: self.re.div(&n, prec)?, im: self.im.neg().div(&n, prec)? })
    }

    pub fn div(&self, o: &CBall, prec: u64) -> Option<CBall> {
        Some(self.mul(&o.recip(prec + 8)?, prec))
    }

    pub fn contains(&self, o: &CBall) -> bool {
        self.re.contains(&o.re) && self.im.contains(&o.im)
    }

    pub fn overlaps(&self, o: &CBall) -> bool {
        self.re.overlaps(&o.re) && self.im.overlaps(&o.im)
    }
}

impl std::fmt::Display for CBall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} + {} i", self.re, self.im)
    }
}
