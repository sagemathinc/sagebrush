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

/// The largest integer (numerator, denominator) an expression may hold.
/// Expressions cross the engine boundary as decimal text, whose cost grows
/// faster than linearly: past this every operation would take seconds, so
/// it is refused, as CPython refuses int-to-str past its digit limit.
pub const MAX_INT_BITS: u64 = 1 << 21;

/// Refuse an integer of `bits` bits past MAX_INT_BITS.
pub fn check_int_bits(bits: u64) {
    if bits > MAX_INT_BITS {
        int_too_big(bits, "");
    }
}

/// Refuse a result known to need at least `bits` bits, before computing it.
pub fn check_int_bits_at_least(bits: u64) {
    if bits > MAX_INT_BITS {
        int_too_big(bits, "at least ");
    }
}

fn int_too_big(bits: u64, qual: &str) -> ! {
    crate::err::not_implemented(format!(
        "an integer of {}{} bits in a symbolic expression: sagebrush's symbolic ring holds integers of at most {} bits",
        qual, bits, MAX_INT_BITS
    ))
}

pub fn check_q_bits(x: &Q) {
    check_int_bits(x.numer().bits().max(x.denom().bits()));
}

/// log2 |n| for n != 0, finite however large n is (its top 64 bits and
/// its length: n.to_f64() is infinite past 2^1024).
pub fn log2_big(n: &BigInt) -> f64 {
    let b = n.bits();
    if b <= 64 {
        return n.abs().to_f64().unwrap().log2();
    }
    let sh = b - 64;
    (n.abs() >> sh as usize).to_f64().unwrap().log2() + sh as f64
}

fn q_bits(x: &Q) -> u64 {
    x.numer().bits().max(x.denom().bits())
}

#[derive(Clone, Debug)]
pub enum Num {
    /// re + im*I, exact
    Exact(Q, Q),
    /// re + im*I, 53-bit floats, of a parent (Fk; a real one has im 0)
    Float(f64, f64, Fk),
}

/// The parent a symbolic float keeps, as Sage keeps it (1d-i): RR or CC (printed with 15 digits,
/// 1.50000000000000) or RDF or CDF (printed shortest, 1.5). CC and CDF are complex even when
/// the imaginary part is 0; a real kind always holds an imaginary part 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Fk {
    RR,
    CC,
    RDF,
    CDF,
}

impl Fk {
    /// RDF or CDF: printed as Python prints a double
    pub fn double(self) -> bool {
        matches!(self, Fk::RDF | Fk::CDF)
    }
    pub fn complex(self) -> bool {
        matches!(self, Fk::CC | Fk::CDF)
    }
    pub fn to_complex(self) -> Fk {
        if self.double() {
            Fk::CDF
        } else {
            Fk::CC
        }
    }
    pub fn to_real(self) -> Fk {
        if self.double() {
            Fk::RDF
        } else {
            Fk::RR
        }
    }
    /// The parent of a result of two floats, as Sage meets them on symbolic numbers: in one
    /// domain the first one's (RDF + RR is RDF, RR + RDF is RR), across domains the complex one's
    /// (RR + CDF is CDF, CC + RDF is CC)
    pub fn meet(self, o: Fk) -> Fk {
        if self.complex() == o.complex() || self.complex() {
            self
        } else {
            o
        }
    }
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
        Num::Float(x, 0.0, Fk::RR)
    }
    /// re + im*I of parent k, a real kind made complex by a nonzero imaginary part (Sage:
    /// RR(1.5)*I is over CC)
    pub fn fl(re: f64, im: f64, k: Fk) -> Num {
        Num::Float(re, im, if im != 0.0 && !k.complex() { k.to_complex() } else { k })
    }
    /// The parent of a float (None for an exact number)
    pub fn fk(&self) -> Option<Fk> {
        match self {
            Num::Float(_, _, k) => Some(*k),
            Num::Exact(..) => None,
        }
    }
    /// The parent of a result of self and o: a float's, or the meet of two
    pub fn fk_with(&self, o: &Num) -> Fk {
        match (self.fk(), o.fk()) {
            (Some(a), Some(b)) => a.meet(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => Fk::RR,
        }
    }
    /// self as a float of parent k's family when it is exact (an exact number meeting a float
    /// takes its parent), self when it is a float
    pub fn with_fk(&self, k: Fk) -> Num {
        match self {
            Num::Exact(..) => {
                let (a, b) = self.to_c64();
                Num::fl(a, b, if b != 0.0 { k.to_complex() } else { k })
            }
            _ => self.clone(),
        }
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
            Num::Float(a, b, _) => *a == 0.0 && *b == 0.0,
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
            Num::Float(_, b, _) => *b == 0.0,
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
            Num::Float(a, b, _) => *b == 0.0 && *a < 0.0,
        }
    }
    pub fn is_positive(&self) -> bool {
        match self {
            Num::Exact(a, b) => b.is_zero() && a.is_positive(),
            Num::Float(a, b, _) => *b == 0.0 && *a > 0.0,
        }
    }
    /// For printing a term with " - ": the real part (or, if 0, the
    /// imaginary part) is negative.
    pub fn looks_negative(&self) -> bool {
        match self {
            // as printed, the imaginary part first (-2*I + 1): Sage's sign
            Num::Exact(a, b) => b.is_negative() || (b.is_zero() && a.is_negative()),
            Num::Float(a, b, _) => *a < 0.0 || (*a == 0.0 && *b < 0.0),
        }
    }

    pub fn to_c64(&self) -> (f64, f64) {
        match self {
            Num::Exact(a, b) => (q_to_f64(a), q_to_f64(b)),
            Num::Float(a, b, _) => (*a, *b),
        }
    }
    pub fn to_float(&self) -> Num {
        match self {
            Num::Float(..) => self.clone(),
            _ => {
                let (a, b) = self.to_c64();
                Num::fl(a, b, Fk::RR)
            }
        }
    }

    pub fn neg(&self) -> Num {
        match self {
            Num::Exact(a, b) => Num::Exact(-a.clone(), -b.clone()),
            Num::Float(a, b, k) => Num::Float(-a, -b, *k),
        }
    }
    pub fn add(&self, o: &Num) -> Num {
        match (self, o) {
            (Num::Exact(a, b), Num::Exact(c, d)) => Num::Exact(a + c, b + d),
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                Num::fl(a + c, b + d, self.fk_with(o))
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
            // an exact zero absorbs a float, even an infinite or NaN one (Sage: SR(RR('inf'))*0
            // and SR(RR(1.5))*0 are 0)
            (Num::Exact(a, b), _) | (_, Num::Exact(a, b)) if a.is_zero() && b.is_zero() => Num::Exact(Q::zero(), Q::zero()),
            // an exact one is the identity: 1 + 0*I times inf + I in the complex formula has
            // 0*inf = NaN (a product's coefficient starts from 1)
            (Num::Exact(a, b), o) | (o, Num::Exact(a, b)) if a.is_one() && b.is_zero() => o.clone(),
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                let k = self.fk_with(o);
                // two reals multiply as reals: the complex formula's products with their zero
                // imaginary parts are NaN for an infinite or NaN number (inf*0), and RR('inf')*x
                // became (NaN - NaN*I)*x (Sage: (+infinity)*x). A real times a complex is the
                // complex formula, as Sage (SR(RR(2))*SR(CC(infinity, 1)) is +infinity + NaN*I)
                if b == 0.0 && d == 0.0 {
                    Num::fl(a * c, 0.0, k)
                } else {
                    Num::fl(a * c - b * d, a * d + b * c, k)
                }
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
            // a real one as a real (1/inf is 0, not inf/inf = NaN)
            Num::Float(a, b, k) if *b == 0.0 => Num::Float(1.0 / a, 0.0, *k),
            Num::Float(a, b, k) => {
                let n = a * a + b * b;
                Num::Float(a / n, -b / n, *k)
            }
        }
    }
    pub fn div(&self, o: &Num) -> Num {
        self.mul(&o.inv())
    }
    pub fn pow_int(&self, e: i64) -> Num {
        // (by the exponent's magnitude: -e overflows at i64::MIN, the review's
        // RDF(2)^(-2^63))
        if e < 0 {
            return self.inv().pow_uint(e.unsigned_abs());
        }
        self.pow_uint(e as u64)
    }

    /// self^e by binary powering.
    pub fn pow_uint(&self, e: u64) -> Num {
        match self {
            Num::Exact(a, b) if b.is_zero() => {
                // r and base are powers of the reduced a, so a product has
                // at least bits(r) + bits(base) - 1 bits: refuse before
                // computing one past MAX_INT_BITS
                let mut r = Q::one();
                let mut base = a.clone();
                let mut e = e;
                while e > 0 {
                    if e & 1 == 1 {
                        check_int_bits_at_least((q_bits(&r) + q_bits(&base)).saturating_sub(1));
                        r = &r * &base;
                    }
                    e >>= 1;
                    if e > 0 {
                        check_int_bits_at_least((2 * q_bits(&base)).saturating_sub(1));
                        base = &base * &base;
                    }
                }
                Num::Exact(r, Q::zero())
            }
            _ => {
                let exact = self.is_exact();
                let check = |x: &Num| {
                    if let Num::Exact(p, q) = x {
                        check_q_bits(p);
                        check_q_bits(q);
                    }
                };
                let mut r = Num::one();
                let mut base = self.clone();
                if !exact {
                    r = Num::fl(1.0, 0.0, self.fk().unwrap_or(Fk::RR).to_real());
                }
                let mut e = e;
                while e > 0 {
                    if e & 1 == 1 {
                        r = r.mul(&base);
                        check(&r);
                    }
                    e >>= 1;
                    if e > 0 {
                        base = base.mul(&base);
                        check(&base);
                    }
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
            // (the parent is not part of the value: Sage merges (x + RDF(1))*(x + RR(1)) into a square)
            (Num::Float(a, b, _), Num::Float(c, d, _)) => a.to_bits() == c.to_bits() && b.to_bits() == d.to_bits(),
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
            Num::Float(a, b, _) => {
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

/// A double as Sage prints elements of RDF: as Python's repr, the shortest digits that read back
/// (1.5, 0.3333333333333333, 1000000000000000.0, 1e+16, 1e-05), and RR's NaN and infinities.
pub fn double_str(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "+infinity".into() } else { "-infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's {:e} gives the shortest round-trip digits, as Python's repr
    let s = format!("{:e}", x.abs());
    let (mant, e) = s.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let e: i32 = e.parse().unwrap();
    let n = digits.len() as i32;
    if (-4..16).contains(&e) {
        if e < 0 {
            return format!("{}0.{}{}", sign, "0".repeat((-e - 1) as usize), digits);
        }
        if n <= e + 1 {
            return format!("{}{}{}.0", sign, digits, "0".repeat((e + 1 - n) as usize));
        }
        let k = (e + 1) as usize;
        return format!("{}{}.{}", sign, &digits[..k], &digits[k..]);
    }
    let m = if n == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
    format!("{}{}e{}{:02}", sign, m, if e < 0 { "-" } else { "+" }, e.abs())
}

/// a float's latex as Sage writes it: 1.5, 1 \times 10^{20} (RDF), 1.00000000000000 \times
/// 10^{20} (RR)
fn sci_latex(s: String) -> String {
    match s.split_once('e') {
        Some((m, e)) => format!("{} \\times 10^{{{}}}", m, e.trim_start_matches('+').trim_start_matches('0').replace("-0", "-")),
        None => s,
    }
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
            Num::Float(a, b, k) => {
                let f = if k.double() { double_str } else { real_str };
                if *b == 0.0 {
                    return f(*a);
                }
                let im = format!("{}*I", f(*b));
                if *a == 0.0 {
                    return im;
                }
                // (a NaN imaginary part is + NaN*I whatever its sign bit, as Sage)
                if b.is_sign_negative() && !b.is_nan() {
                    format!("{} - {}*I", f(*a), f(-b))
                } else {
                    format!("{} + {}", f(*a), im)
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
            // (2.00000000000000 - 3.00000000000000i, as Sage)
            // (as Sage: 1 \times 10^{20}, 1.0 + 2.0i, 2.00000000000000 - 3.00000000000000i)
            Num::Float(a, b, k) => {
                let f = |x: f64| sci_latex(if k.double() { double_str(x) } else { real_str(x) });
                if *b == 0.0 {
                    return f(*a);
                }
                let im = format!("{}i", f(*b));
                if *a == 0.0 {
                    im
                } else if b.is_sign_negative() && !b.is_nan() {
                    format!("{} - {}i", f(*a), f(-b))
                } else {
                    format!("{} + {}", f(*a), im)
                }
            }
        }
    }
}

// ------------------------------------------------------------------ roots

/// The exact q-th root of the integer n >= 0 if it is a q-th power.
pub fn exact_root(n: &BigInt, k: u32) -> Option<BigInt> {
    if n.is_zero() || n.is_one() {
        return Some(n.clone());
    }
    if k > 1 && !power_residues(n, k) {
        return None;
    }
    let r = nth_root_floor(n, k);
    if pow_big(&r, k) == *n {
        Some(r)
    } else {
        None
    }
}

/// Whether n > 1 is a k-th power modulo a dozen primes p = 1 mod k (false
/// proves n is not a k-th power; a k-th power always passes).  Each test
/// is one pass over n, where computing the root costs a few divisions.
fn power_residues(n: &BigInt, k: u32) -> bool {
    let k = k as u64;
    if k > 1 << 20 {
        return true;
    }
    let mut found = 0;
    let mut p = (1_000_000 / k + 1) * k + 1;
    while found < 12 {
        if is_small_prime(p) {
            found += 1;
            let r = (n % BigInt::from(p)).to_u64().unwrap();
            if r != 0 && powmod_u64(r, (p - 1) / k, p) != 1 {
                return false;
            }
        }
        p += k;
    }
    true
}

fn is_small_prime(p: u64) -> bool {
    if p < 2 {
        return false;
    }
    let mut d = 2;
    while d * d <= p {
        if p % d == 0 {
            return false;
        }
        d += 1;
    }
    true
}

fn powmod_u64(b: u64, mut e: u64, m: u64) -> u64 {
    let (m, mut b, mut r) = (m as u128, (b % m) as u128, 1u128);
    while e > 0 {
        if e & 1 == 1 {
            r = r * b % m;
        }
        b = b * b % m;
        e >>= 1;
    }
    r as u64
}

/// The primes below 10^4 dividing m, increasing: one division of m by
/// their product, then remainders of that small remainder (a remainder of
/// m for each of the 1229 primes took seconds for a million-bit m).
pub fn small_prime_divisors(m: &BigInt) -> Vec<u32> {
    thread_local! {
        static SMALL: (Vec<u32>, BigInt) = {
            let mut sieve = vec![true; 10000];
            let mut ps = vec![];
            for p in 2..10000usize {
                if sieve[p] {
                    ps.push(p as u32);
                    for q in (p * p..10000).step_by(p) {
                        sieve[q] = false;
                    }
                }
            }
            let prod = ps.iter().fold(BigInt::one(), |a, &p| a * BigInt::from(p));
            (ps, prod)
        };
    }
    SMALL.with(|(ps, prod)| {
        let r = m.abs() % prod;
        ps.iter().copied().filter(|&p| (&r % BigInt::from(p)).is_zero()).collect()
    })
}

/// Divide p out of m != 0 completely, returning its multiplicity: one
/// division per bit of the multiplicity, so 3^600000 costs about 20.
pub fn strip_factor(m: &mut BigInt, p: u32) -> u32 {
    if p == 2 {
        let t = m.trailing_zeros().unwrap_or(0);
        *m >>= t as usize;
        return t as u32;
    }
    let bp = BigInt::from(p);
    if !(&*m % &bp).is_zero() {
        return 0;
    }
    // p, p^2, p^4, ... while they divide m
    let mut pows = vec![bp];
    loop {
        let last = pows.last().unwrap();
        let sq = last * last;
        if sq.bits() > m.bits() || !(&*m % &sq).is_zero() {
            break;
        }
        pows.push(sq);
    }
    // the multiplicity is below 2^len: its binary digits, greatest first
    let mut e = 0u32;
    for j in (0..pows.len()).rev() {
        if (&*m % &pows[j]).is_zero() {
            *m /= &pows[j];
            e += 1 << j;
        }
    }
    e
}

pub fn pow_big(b: &BigInt, k: u32) -> BigInt {
    b.pow(k)
}

fn nth_root_floor(n: &BigInt, k: u32) -> BigInt {
    if k == 1 {
        return n.clone();
    }
    if k == 2 {
        return n.sqrt();
    }
    let bits = n.bits();
    let mut x = if bits <= 64 * k as u64 {
        BigInt::one() << ((bits / k as u64) as usize + 1)
    } else {
        // the root of the top half of the bits, an upper bound to half
        // the precision, so Newton below needs only a couple of steps
        let h = (bits / k as u64 / 2) as usize;
        let a = nth_root_floor(&(n >> (h * k as usize)), k);
        (a + 1) << h
    };
    // Newton on integers, decreasing from an upper bound
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
    for p in small_prime_divisors(n) {
        let bp = BigInt::from(p);
        let e = strip_factor(&mut m, p);
        a *= pow_big(&bp, e / k);
        b *= pow_big(&bp, e % k);
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

    /// 1d-i: a float keeps its parent; RDF and CDF print as Python's repr, and two parents meet
    /// as Sage meets them (sym1d/kinds.oracle, Sage 10.9)
    #[test]
    fn float_parents_as_sage() {
        for (x, s) in [(1.5, "1.5"), (3.0, "3.0"), (-2.0, "-2.0"), (1e20, "1e+20"), (1e16, "1e+16"), (1e15, "1000000000000000.0"), (1e-20, "1e-20"),
                       (0.0001, "0.0001"), (0.00001, "1e-05"), (1.0 / 3.0, "0.3333333333333333"), (123456789.123, "123456789.123"), (0.1, "0.1"), (0.0, "0.0"), (-0.0, "-0.0")] {
            assert_eq!(double_str(x), s, "{}", x);
        }
        let (rdf, rr) = (Num::Float(1.5, 0.0, Fk::RDF), Num::Float(2.5, 0.0, Fk::RR));
        let (cdf, cc) = (Num::Float(1.0, 2.0, Fk::CDF), Num::Float(1.0, 1.0, Fk::CC));
        // in one domain the first's parent, across domains the complex one's
        assert_eq!(rdf.add(&rr).fk(), Some(Fk::RDF));
        assert_eq!(rr.add(&rdf).fk(), Some(Fk::RR));
        assert_eq!(rr.mul(&cdf).fk(), Some(Fk::CDF));
        assert_eq!(rdf.add(&cc).fk(), Some(Fk::CC));
        assert_eq!(cdf.add(&cc).fk(), Some(Fk::CDF));
        assert_eq!(cc.add(&cdf).fk(), Some(Fk::CC));
        assert_eq!(Num::int(2).add(&rdf).fk(), Some(Fk::RDF));
        // a real parent made complex by an imaginary part (RR(1.5)*I is over CC)
        assert_eq!(rr.mul(&Num::i()).fk(), Some(Fk::CC));
        assert_eq!(Num::Float(1.5, 0.0, Fk::RDF).mul(&Num::i()).fk(), Some(Fk::CDF));
        // printing: RDF 4.0, CDF 2.5 + 2.0*I, CC 2.50000000000000 + 1.00000000000000*I
        assert_eq!(rdf.add(&rr).sage_str(), "4.0");
        assert_eq!(rdf.add(&cdf).sage_str(), "2.5 + 2.0*I");
        assert_eq!(rdf.add(&cc).sage_str(), "2.50000000000000 + 1.00000000000000*I");
        assert_eq!(Num::Float(0.0, 2.0, Fk::CDF).sage_str(), "2.0*I");
        assert_eq!(Num::Float(1.0, -2.0, Fk::CDF).latex(), "1.0 - 2.0i");
        assert_eq!(Num::Float(1e20, 0.0, Fk::RDF).latex(), "1 \\times 10^{20}");
        assert_eq!(Num::Float(1e-20, 0.0, Fk::RDF).latex(), "1 \\times 10^{-20}");
        assert_eq!(Num::Float(1e20, 0.0, Fk::RR).latex(), "1.00000000000000 \\times 10^{20}");
        // the parent is not part of the value (Sage merges (x + RDF(1))*(x + RR(1)))
        assert_eq!(Num::Float(1.0, 0.0, Fk::RDF), Num::Float(1.0, 0.0, Fk::RR));
    }

    /// rrnan: a real float stays real through * and inverse (no inf*0 = NaN imaginary part), and an
    /// exact zero absorbs any float (Sage: RR('inf')*x is (+infinity)*x, SR(RR('nan'))*0 is 0)
    #[test]
    fn real_specials_stay_real() {
        let (inf, nan) = (Num::float(f64::INFINITY), Num::float(f64::NAN));
        let real = |n: Num| match n {
            Num::Float(_, b, _) => b == 0.0,
            Num::Exact(_, b) => b.is_zero(),
        };
        for (n, v) in [(inf.mul(&Num::one()), f64::INFINITY), (inf.mul(&Num::float(-2.0)), f64::NEG_INFINITY), (inf.inv(), 0.0)] {
            assert!(real(n.clone()), "{:?}", n);
            assert_eq!(n.to_c64().0, v);
        }
        let p = nan.mul(&Num::float(2.0));
        assert!(real(p.clone()) && p.to_c64().0.is_nan());
        // a real times a complex: the complex formula (inf*(1 + 2*I) is inf + inf*I, and
        // 2*(inf + I) is inf + NaN*I, as Sage's SR(RR(2))*SR(CC(infinity, 1)))
        assert_eq!(inf.mul(&Num::Float(1.0, 2.0, Fk::CC)).to_c64(), (f64::INFINITY, f64::INFINITY));
        let p = Num::float(2.0).mul(&Num::Float(f64::INFINITY, 1.0, Fk::CC));
        assert!(p.to_c64().0 == f64::INFINITY && p.to_c64().1.is_nan());
        let p = Num::Float(1.0, f64::INFINITY, Fk::CC).mul(&Num::float(-2.0));
        assert!(p.to_c64().0.is_nan() && p.to_c64().1 == f64::NEG_INFINITY);
        for x in [&inf, &nan, &Num::float(1.5)] {
            assert_eq!(Num::zero().mul(x), Num::zero());
            assert_eq!(x.mul(&Num::zero()), Num::zero());
        }
        assert_eq!(Num::float(-2.0).inv().to_c64(), (-0.5, 0.0));
    }

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
    fn pow_int_exponent_bounds() {
        // (i64::MIN has no negation: by its magnitude, as Sage's RDF(2)^(-2^63) == 0.0)
        let d = |v: f64| Num::fl(v, 0.0, Fk::RDF);
        let re = |n: Num| n.to_c64().0;
        assert_eq!(re(d(2.0).pow_int(i64::MIN)), 0.0);
        assert_eq!(re(d(2.0).pow_int(i64::MIN + 1)), 0.0);
        assert_eq!(re(d(0.5).pow_int(i64::MIN)), f64::INFINITY);
        assert_eq!(re(d(-1.0).pow_int(i64::MIN)), 1.0);
        assert_eq!(re(d(-1.0).pow_int(i64::MIN + 1)), -1.0);
        assert_eq!(re(d(2.0).pow_int(-1)), 0.5);
        assert_eq!(re(d(2.0).pow_int(0)), 1.0);
        // (the largest exponent, -(i64::MIN + 1))
        assert_eq!(re(d(2.0).pow_int(-(i64::MIN + 1))), f64::INFINITY);
        assert_eq!(Num::one().pow_int(i64::MIN).sage_str(), "1");
        assert_eq!(Num::i().pow_int(i64::MIN).sage_str(), "1");
    }

    #[test]
    fn roots() {
        assert_eq!(extract_power(&BigInt::from(12), 2), (BigInt::from(2), BigInt::from(3)));
        assert_eq!(extract_power(&BigInt::from(8), 3), (BigInt::from(2), BigInt::from(1)));
        let big = pow_big(&BigInt::from(1_000_003), 2) * 7;
        assert_eq!(extract_power(&big, 2), (BigInt::from(1_000_003), BigInt::from(7)));
        assert_eq!(exact_root(&BigInt::from(1u64 << 40), 4), Some(BigInt::from(1024)));
    }

    #[test]
    fn large_roots() {
        // floor roots against the defining inequalities, across the
        // recursive (precision-doubling) range
        let mut n = BigInt::from(3);
        for i in 0..40 {
            n = &n * &n + BigInt::from(i);
            for k in 2..=9u32 {
                let r = nth_root_floor(&n, k);
                assert!(pow_big(&r, k) <= n && pow_big(&(&r + 1), k) > n, "{} {}", i, k);
            }
            if n.bits() > 20000 {
                break;
            }
        }
        let q = (BigInt::one() << 521usize) - 1;
        for k in 2..=8u32 {
            assert_eq!(exact_root(&pow_big(&q, k), k), Some(q.clone()));
            assert_eq!(exact_root(&(pow_big(&q, k) + 1), k), None);
            assert_eq!(exact_root(&(pow_big(&q, k) - 1), k), None);
        }
        let mut m = pow_big(&BigInt::from(3), 600000) * 7;
        assert_eq!(strip_factor(&mut m, 3), 600000);
        assert_eq!(m, BigInt::from(7));
        let mut m = (BigInt::one() << 1000000usize) * 5;
        assert_eq!(strip_factor(&mut m, 2), 1000000);
        assert_eq!(strip_factor(&mut m, 3), 0);
        assert_eq!(m, BigInt::from(5));
        let mut m = pow_big(&BigInt::from(9973), 1023);
        assert_eq!(strip_factor(&mut m, 9973), 1023);
        assert!(m.is_one());
    }
}
