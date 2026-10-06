//! Positive definite binary quadratic forms (a, b, c), b^2 - 4ac = D < 0,
//! with exact (big integer) composition and reduction.  The relation search
//! never composes forms; this is for checking relations and for small
//! discriminants.

use sagebrush_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, Zero};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Form {
    pub a: BigInt,
    pub b: BigInt,
    pub c: BigInt,
}

impl Form {
    pub fn new(a: BigInt, b: BigInt, d: &BigInt) -> Form {
        let c = (&b * &b - d) / (BigInt::from(4) * &a);
        debug_assert_eq!(&b * &b - BigInt::from(4) * &a * &c, *d);
        Form { a, b, c }
    }

    pub fn disc(&self) -> BigInt {
        &self.b * &self.b - BigInt::from(4) * &self.a * &self.c
    }

    /// The principal form of discriminant d.
    pub fn identity(d: &BigInt) -> Form {
        let b = if d.is_odd() { BigInt::one() } else { BigInt::zero() };
        Form::new(BigInt::one(), b, d)
    }

    pub fn inverse(&self) -> Form {
        Form { a: self.a.clone(), b: -&self.b, c: self.c.clone() }.reduced()
    }

    pub fn is_reduced(&self) -> bool {
        let ab = self.b.abs();
        ab <= self.a && self.a <= self.c && !((ab == self.a || self.a == self.c) && self.b.is_negative())
    }

    /// The reduced form equivalent to self (Gauss).
    pub fn reduced(&self) -> Form {
        let (mut a, mut b, mut c) = (self.a.clone(), self.b.clone(), self.c.clone());
        loop {
            // normalize: -a < b <= a
            if !(-&a < b && b <= a) {
                let two_a = &a + &a;
                // r with b + 2a r in (-a, a]
                let r = (&a - &b).div_floor(&two_a);
                let nb = &b + &two_a * &r;
                c = &a * &r * &r + &b * &r + &c;
                b = nb;
            }
            if a > c {
                std::mem::swap(&mut a, &mut c);
                b = -b;
                continue;
            }
            if (a == c) && b.is_negative() {
                b = -b;
            }
            return Form { a, b, c };
        }
    }

    /// The composition self * g (Cohen, Algorithm 5.4.7), reduced.
    pub fn compose(&self, g: &Form) -> Form {
        let (f1, f2) = if self.a > g.a { (g, self) } else { (self, g) };
        let s: BigInt = (&f1.b + &f2.b) / 2;
        let n = &f2.b - &s;
        let (y1, d) = if (&f2.a % &f1.a).is_zero() {
            (BigInt::zero(), f1.a.clone())
        } else {
            let e = f2.a.extended_gcd(&f1.a); // u a2 + v a1 = d
            (e.x, e.gcd)
        };
        let (x2, y2, d1) = if (&s % &d).is_zero() {
            (BigInt::zero(), BigInt::from(-1), d.clone())
        } else {
            let e = s.extended_gcd(&d); // x2 s + y2 d = d1
            (e.x, -e.y, e.gcd)
        };
        let v1 = &f1.a / &d1;
        let v2 = &f2.a / &d1;
        let r = (&y1 * &y2 * &n - &x2 * &f2.c).mod_floor(&v1);
        let b3 = &f2.b + BigInt::from(2) * &v2 * &r;
        let a3 = &v1 * &v2;
        let c3 = (&f2.c * &d1 + &r * (&f2.b + &v2 * &r)) / &v1;
        Form { a: a3, b: b3, c: c3 }.reduced()
    }

    pub fn pow(&self, mut e: i64) -> Form {
        let d = self.disc();
        let mut base = if e < 0 { self.inverse() } else { self.reduced() };
        e = e.abs();
        let mut r = Form::identity(&d).reduced();
        while e > 0 {
            if e & 1 == 1 {
                r = r.compose(&base);
            }
            base = base.compose(&base);
            e >>= 1;
        }
        r
    }

    pub fn is_identity(&self) -> bool {
        let f = self.reduced();
        f.a.is_one()
    }
}

/// The class number of a negative discriminant, by counting reduced forms
/// (|D| up to ~10^9).
pub fn class_number_brute(d: i64) -> u64 {
    assert!(d < 0 && (d.rem_euclid(4) == 0 || d.rem_euclid(4) == 1));
    let n = -d;
    let mut h = 0;
    let mut b = n % 2;
    while 3 * b * b <= n {
        let ac = (b * b + n) / 4;
        let mut a = b.max(1);
        while a * a <= ac {
            if ac % a == 0 {
                let c = ac / a;
                if a == b || a == c || b == 0 {
                    h += 1;
                } else {
                    h += 2;
                }
            }
            a += 1;
        }
        b += 2;
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(a: i64, b: i64, d: i64) -> Form {
        Form::new(BigInt::from(a), BigInt::from(b), &BigInt::from(d))
    }

    #[test]
    fn brute_class_numbers() {
        // h(-3) = h(-4) = 1, h(-23) = 3, h(-47) = 5, h(-71) = 7, h(-163) = 1, h(-5000-something)
        for (d, h) in [(-3, 1), (-4, 1), (-23, 3), (-47, 5), (-71, 7), (-163, 1), (-84, 4), (-420, 8), (-10007, 77)] {
            assert_eq!(class_number_brute(d), h, "h({})", d);
        }
    }

    #[test]
    fn group_law() {
        for d in [-23i64, -47, -71, -84, -420, -10007, -1_000_003] {
            let h = class_number_brute(d) as i64;
            let dd = BigInt::from(d);
            // the prime forms of small split primes: f^h = 1, f * f^-1 = 1, associativity
            let mut forms = vec![];
            for p in [2i64, 3, 5, 7, 11, 13, 17, 19, 23, 29] {
                for b in 0..=p {
                    if (b * b - d) % (4 * p) == 0 {
                        forms.push(f(p, b, d));
                        break;
                    }
                }
            }
            for x in &forms {
                assert!(x.pow(h).is_identity(), "f^h for {:?} D={}", x, d);
                assert!(x.compose(&x.inverse()).is_identity());
                for y in &forms {
                    assert_eq!(x.compose(y), y.compose(x));
                    for z in forms.iter().take(3) {
                        assert_eq!(x.compose(y).compose(z), x.compose(&y.compose(z)));
                    }
                }
                assert_eq!(x.compose(y_id(&dd)).reduced(), x.reduced());
            }
        }
    }

    fn y_id(d: &BigInt) -> &'static Form {
        Box::leak(Box::new(Form::identity(d)))
    }
}
