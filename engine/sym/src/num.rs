//! Numbers in symbolic expressions, as in Sage's symbolic ring: exact
//! Gaussian rationals (so I is a number, I^2 = -1, (1 + I)^2 = 2*I) and
//! 53-bit complex floats (printed as Sage prints elements of RR and CC).

use crate::err::{throw, SymError};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::{BigInt, BigRational};
use std::cmp::Ordering;
use std::hash::{Hash, Hasher};

pub type Q = BigRational;

#[derive(Clone, Debug)]
pub enum Num {
    /// re + im*I, exact
    Exact(Q, Q),
    /// re + im*I, 53-bit floats
    Float(f64, f64),
}

pub fn q(n: i64) -> Q {
    Q::from_integer(BigInt::from(n))
}

pub fn qr(n: i64, d: i64) -> Q {
    Q::new(BigInt::from(n), BigInt::from(d))
}

fn q_to_f64(x: &Q) -> f64 {
    // numerator / denominator, robust for big values
    let n = x.numer();
    let d = x.denom();
    match (n.to_f64(), d.to_f64()) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() && b != 0.0 => a / b,
        _ => {
            let shift = (n.bits() as i64 - d.bits() as i64) - 60;
            let (a, b) = if shift > 0 { (n >> shift as usize, d.clone()) } else { (n << (-shift) as usize, d.clone()) };
            let r = (Q::new(a, b).to_integer()).to_f64().unwrap_or(f64::NAN);
            r * 2f64.powi(shift as i32)
        }
    }
}

impl Num {
    pub fn int(n: i64) -> Num {
        Num::Exact(q(n), Q::zero())
    }
    pub fn big(n: BigInt) -> Num {
        Num::Exact(Q::from_integer(n), Q::zero())
    }
    pub fn rat(x: Q) -> Num {
        Num::Exact(x, Q::zero())
    }
    pub fn float(x: f64) -> Num {
        Num::Float(x, 0.0)
    }
    pub fn i() -> Num {
        Num::Exact(Q::zero(), Q::one())
    }
    pub fn zero() -> Num {
        Num::int(0)
    }
    pub fn one() -> Num {
        Num::int(1)
    }

    pub fn is_exact(&self) -> bool {
        matches!(self, Num::Exact(..))
    }
    pub fn is_zero(&self) -> bool {
        match self {
            Num::Exact(a, b) => a.is_zero() && b.is_zero(),
            Num::Float(a, b) => *a == 0.0 && *b == 0.0,
        }
    }
    pub fn is_one(&self) -> bool {
        matches!(self, Num::Exact(a, b) if a.is_one() && b.is_zero())
    }
    pub fn is_minus_one(&self) -> bool {
        matches!(self, Num::Exact(a, b) if *a == -Q::one() && b.is_zero())
    }
    pub fn is_real(&self) -> bool {
        match self {
            Num::Exact(_, b) => b.is_zero(),
            Num::Float(_, b) => *b == 0.0,
        }
    }
    /// An exact rational (real).
    pub fn as_rat(&self) -> Option<&Q> {
        match self {
            Num::Exact(a, b) if b.is_zero() => Some(a),
            _ => None,
        }
    }
    pub fn as_int(&self) -> Option<BigInt> {
        self.as_rat().filter(|r| r.is_integer()).map(|r| r.to_integer())
    }
    pub fn as_i64(&self) -> Option<i64> {
        self.as_int().and_then(|n| n.to_i64())
    }
    pub fn is_integer(&self) -> bool {
        self.as_int().is_some()
    }
    /// Negative real (exact or float).
    pub fn is_negative(&self) -> bool {
        match self {
            Num::Exact(a, b) => b.is_zero() && a.is_negative(),
            Num::Float(a, b) => *b == 0.0 && *a < 0.0,
        }
    }
    pub fn is_positive(&self) -> bool {
        match self {
            Num::Exact(a, b) => b.is_zero() && a.is_positive(),
            Num::Float(a, b) => *b == 0.0 && *a > 0.0,
        }
    }
    /// For printing a term with " - ": the real part (or, if 0, the
    /// imaginary part) is negative.
    pub fn looks_negative(&self) -> bool {
        match self {
            Num::Exact(a, b) => a.is_negative() || (a.is_zero() && b.is_negative()),
            Num::Float(a, b) => *a < 0.0 || (*a == 0.0 && *b < 0.0),
        }
    }

    pub fn to_c64(&self) -> (f64, f64) {
        match self {
            Num::Exact(a, b) => (q_to_f64(a), q_to_f64(b)),
            Num::Float(a, b) => (*a, *b),
        }
    }
    pub fn to_float(&self) -> Num {
        let (a, b) = self.to_c64();
        Num::Float(a, b)
    }

    pub fn neg(&self) -> Num {
        match self {
            Num::Exact(a, b) => Num::Exact(-a.clone(), -b.clone()),
            Num::Float(a, b) => Num::Float(-a, -b),
        }
    }
    pub fn add(&self, o: &Num) -> Num {
        match (self, o) {
            (Num::Exact(a, b), Num::Exact(c, d)) => Num::Exact(a + c, b + d),
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                Num::Float(a + c, b + d)
            }
        }
    }
    pub fn sub(&self, o: &Num) -> Num {
        self.add(&o.neg())
    }
    pub fn mul(&self, o: &Num) -> Num {
        match (self, o) {
            (Num::Exact(a, b), Num::Exact(c, d)) => {
                if b.is_zero() && d.is_zero() {
                    Num::Exact(a * c, Q::zero())
                } else {
                    Num::Exact(a * c - b * d, a * d + b * c)
                }
            }
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                Num::Float(a * c - b * d, a * d + b * c)
            }
        }
    }
    pub fn inv(&self) -> Num {
        if self.is_zero() {
            throw(SymError::DivisionByZero);
        }
        match self {
            Num::Exact(a, b) => {
                if b.is_zero() {
                    return Num::Exact(a.recip(), Q::zero());
                }
                let n = a * a + b * b;
                Num::Exact(a / &n, -b / &n)
            }
            Num::Float(a, b) => {
                let n = a * a + b * b;
                Num::Float(a / n, -b / n)
            }
        }
    }
    pub fn div(&self, o: &Num) -> Num {
        self.mul(&o.inv())
    }
    pub fn pow_int(&self, e: i64) -> Num {
        if e < 0 {
            return self.inv().pow_int(-e);
        }
        match self {
            Num::Exact(a, b) if b.is_zero() => {
                let mut r = Q::one();
                let mut base = a.clone();
                let mut e = e as u64;
                while e > 0 {
                    if e & 1 == 1 {
                        r = &r * &base;
                    }
                    base = &base * &base;
                    e >>= 1;
                }
                Num::Exact(r, Q::zero())
            }
            _ => {
                let mut r = Num::one();
                let mut base = self.clone();
                if !self.is_exact() {
                    r = Num::float(1.0);
                }
                let mut e = e as u64;
                while e > 0 {
                    if e & 1 == 1 {
                        r = r.mul(&base);
                    }
                    base = base.mul(&base);
                    e >>= 1;
                }
                r
            }
        }
    }

    /// Order of real numbers (for canonical sorting; complex numbers by
    /// real then imaginary part).
    pub fn cmp(&self, o: &Num) -> Ordering {
        match (self, o) {
            (Num::Exact(a, b), Num::Exact(c, d)) => a.cmp(c).then(b.cmp(d)),
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                a.partial_cmp(&c).unwrap_or(Ordering::Equal).then(b.partial_cmp(&d).unwrap_or(Ordering::Equal))
            }
        }
    }

    /// Integer part of an exact real (floor), if any.
    pub fn floor_int(&self) -> Option<BigInt> {
        self.as_rat().map(|r| r.floor().to_integer())
    }
}

impl PartialEq for Num {
    fn eq(&self, o: &Num) -> bool {
        match (self, o) {
            (Num::Exact(a, b), Num::Exact(c, d)) => a == c && b == d,
            (Num::Float(a, b), Num::Float(c, d)) => a.to_bits() == c.to_bits() && b.to_bits() == d.to_bits(),
            _ => false,
        }
    }
}
impl Eq for Num {}

impl Hash for Num {
    fn hash<H: Hasher>(&self, h: &mut H) {
        match self {
            Num::Exact(a, b) => {
                0u8.hash(h);
                a.numer().to_string().hash(h);
                a.denom().to_string().hash(h);
                b.numer().to_string().hash(h);
                b.denom().to_string().hash(h);
            }
            Num::Float(a, b) => {
                1u8.hash(h);
                a.to_bits().hash(h);
                b.to_bits().hash(h);
            }
        }
    }
}

// ------------------------------------------------------------------ printing

/// A 53-bit real as Sage prints elements of RR: 15 significant digits.
pub fn real_str(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "+infinity".into() } else { "-infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.000000000000000".into() } else { "0.000000000000000".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let s = format!("{:.14e}", x.abs());
    let (mant, e) = s.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let e: i32 = e.parse().unwrap();
    if (-5..=5).contains(&e) {
        if e >= 0 {
            let k = (e + 1) as usize;
            return format!("{}{}.{}", sign, &digits[..k], &digits[k..]);
        }
        return format!("{}0.{}{}", sign, "0".repeat((-e - 1) as usize), digits);
    }
    format!("{}{}.{}e{}", sign, &digits[..1], &digits[1..], e)
}

fn rat_str(x: &Q) -> String {
    if x.is_integer() {
        x.numer().to_string()
    } else {
        format!("{}/{}", x.numer(), x.denom())
    }
}

impl Num {
    /// Sage's printing: 3, -1/2, 2*I, I + 1, -3*I + 2, 1.50000000000000,
    /// 1.00000000000000 + 2.00000000000000*I.
    pub fn sage_str(&self) -> String {
        match self {
            Num::Exact(a, b) => {
                if b.is_zero() {
                    return rat_str(a);
                }
                let im = if b.is_one() {
                    "I".to_string()
                } else if *b == -Q::one() {
                    "-I".to_string()
                } else {
                    format!("{}*I", rat_str(b))
                };
                if a.is_zero() {
                    return im;
                }
                if a.is_negative() {
                    format!("{} - {}", im, rat_str(&-a.clone()))
                } else {
                    format!("{} + {}", im, rat_str(a))
                }
            }
            Num::Float(a, b) => {
                if *b == 0.0 {
                    return real_str(*a);
                }
                let im = format!("{}*I", real_str(*b));
                if *a == 0.0 {
                    return im;
                }
                if b.is_sign_negative() {
                    format!("{} - {}*I", real_str(*a), real_str(-b))
                } else {
                    format!("{} + {}", real_str(*a), im)
                }
            }
        }
    }

    pub fn latex(&self) -> String {
        match self {
            Num::Exact(a, b) if b.is_zero() => {
                if a.is_integer() {
                    a.numer().to_string()
                } else if a.is_negative() {
                    format!("-\\frac{{{}}}{{{}}}", -a.numer(), a.denom())
                } else {
                    format!("\\frac{{{}}}{{{}}}", a.numer(), a.denom())
                }
            }
            Num::Exact(a, b) => {
                let im = if b.is_one() {
                    "i".to_string()
                } else if *b == -Q::one() {
                    "-i".to_string()
                } else {
                    format!("{} i", Num::rat(b.clone()).latex())
                };
                if a.is_zero() {
                    im
                } else if a.is_negative() {
                    format!("{} - {}", im, Num::rat(-a.clone()).latex())
                } else {
                    format!("{} + {}", im, Num::rat(a.clone()).latex())
                }
            }
            Num::Float(..) => self.sage_str().replace("*I", " i"),
        }
    }
}

// ------------------------------------------------------------------ roots

/// The exact q-th root of the integer n >= 0 if it is a q-th power.
pub fn exact_root(n: &BigInt, k: u32) -> Option<BigInt> {
    if n.is_zero() || n.is_one() {
        return Some(n.clone());
    }
    let r = nth_root_floor(n, k);
    if pow_big(&r, k) == *n {
        Some(r)
    } else {
        None
    }
}

pub fn pow_big(b: &BigInt, k: u32) -> BigInt {
    let mut r = BigInt::one();
    for _ in 0..k {
        r = &r * b;
    }
    r
}

fn nth_root_floor(n: &BigInt, k: u32) -> BigInt {
    // Newton on integers
    if k == 1 {
        return n.clone();
    }
    let bits = n.bits();
    let mut x = BigInt::one() << ((bits / k as u64) as usize + 1);
    loop {
        // y = ((k-1) x + n / x^(k-1)) / k
        let xk1 = pow_big(&x, k - 1);
        let y = (BigInt::from(k - 1) * &x + n / &xk1) / BigInt::from(k);
        if y >= x {
            break;
        }
        x = y;
    }
    while pow_big(&x, k) > *n {
        x -= 1;
    }
    while pow_big(&(&x + 1), k) <= *n {
        x += 1;
    }
    x
}

/// n = a^k * b with b free of k-th powers of small primes (trial division
/// to 10^4, then an exact-power check of what is left).  Returns (a, b).
pub fn extract_power(n: &BigInt, k: u32) -> (BigInt, BigInt) {
    if n.is_zero() {
        return (BigInt::zero(), BigInt::zero());
    }
    let mut a = BigInt::one();
    let mut b = BigInt::one();
    let mut m = n.clone();
    let mut p = 2u32;
    while p < 10000 {
        let bp = BigInt::from(p);
        if (&bp * &bp) > m && m > BigInt::one() {
            break;
        }
        let mut e = 0u32;
        while (&m % &bp).is_zero() {
            m /= &bp;
            e += 1;
        }
        if e > 0 {
            a *= pow_big(&bp, e / k);
            b *= pow_big(&bp, e % k);
        }
        p += if p == 2 { 1 } else { 2 };
    }
    if m > BigInt::one() {
        match exact_root(&m, k) {
            Some(r) => a *= r,
            None => b *= m,
        }
    }
    (a, b)
}

#[allow(dead_code)]
pub fn gcd(a: &BigInt, b: &BigInt) -> BigInt {
    a.gcd(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printing() {
        assert_eq!(Num::rat(qr(-1, 2)).sage_str(), "-1/2");
        assert_eq!(Num::Exact(q(1), q(1)).sage_str(), "I + 1");
        assert_eq!(Num::Exact(q(2), q(-3)).sage_str(), "-3*I + 2");
        assert_eq!(Num::Exact(q(0), q(-1)).sage_str(), "-I");
        assert_eq!(real_str(1.5), "1.50000000000000");
        assert_eq!(real_str(0.841470984807897), "0.841470984807897");
        assert_eq!(real_str(1e20), "1.00000000000000e20");
        assert_eq!(real_str(0.5), "0.500000000000000");
        assert_eq!(Num::Exact(q(1), q(1)).pow_int(2).sage_str(), "2*I");
        assert_eq!(Num::i().pow_int(3).sage_str(), "-I");
    }

    #[test]
    fn roots() {
        assert_eq!(extract_power(&BigInt::from(12), 2), (BigInt::from(2), BigInt::from(3)));
        assert_eq!(extract_power(&BigInt::from(8), 3), (BigInt::from(2), BigInt::from(1)));
        let big = pow_big(&BigInt::from(1_000_003), 2) * 7;
        assert_eq!(extract_power(&big, 2), (BigInt::from(1_000_003), BigInt::from(7)));
        assert_eq!(exact_root(&BigInt::from(1u64 << 40), 4), Some(BigInt::from(1024)));
    }
}
