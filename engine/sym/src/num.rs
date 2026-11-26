//! Numbers in symbolic expressions, as in Sage's symbolic ring: exact
//! Gaussian rationals (so I is a number, I^2 = -1, (1 + I)^2 = 2*I) and
//! 53-bit complex floats (printed as Sage prints elements of RR and CC).

use crate::err::{not_implemented, throw, SymError};
use crate::mpnum::{self, Mp, Mpc, Sp};
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
    /// a real of RealField(prec), prec != 53 (mpnum)
    Mp(Box<Mp>),
    /// a number of ComplexField(prec), prec != 53 (mpnum), complex even
    /// when its imaginary part is 0, as Sage's
    Mpc(Box<Mpc>),
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
            Num::Exact(..) | Num::Mp(_) | Num::Mpc(_) => None,
        }
    }
    /// The real of RealField(p), p != 53, if this is one
    pub fn as_mp(&self) -> Option<&Mp> {
        match self {
            Num::Mp(x) => Some(x),
            _ => None,
        }
    }
    pub fn mp(x: Mp) -> Num {
        Num::Mp(Box::new(x))
    }
    /// The number of ComplexField(p), p != 53, if this is one
    pub fn as_mpc(&self) -> Option<&Mpc> {
        match self {
            Num::Mpc(x) => Some(x),
            _ => None,
        }
    }
    pub fn mpc(x: Mpc) -> Num {
        Num::Mpc(Box::new(x))
    }
    /// A number of RealField(p) or ComplexField(p), p != 53.
    pub fn is_mp_kind(&self) -> bool {
        matches!(self, Num::Mp(_) | Num::Mpc(_))
    }
    /// A number of RealField(p) or ComplexField(p) with a NaN part.
    pub fn mp_nan(&self) -> bool {
        match self {
            Num::Mp(m) => m.sp == Sp::NaN,
            Num::Mpc(z) => z.has_nan(),
            _ => false,
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
            Num::Mp(x) => x.is_zero(),
            Num::Mpc(x) => x.is_zero(),
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
            Num::Mp(_) => true,
            Num::Mpc(x) => x.im.is_zero(),
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
            Num::Mp(x) => x.sign() < 0,
            Num::Mpc(x) => x.im.is_zero() && x.re.sign() < 0,
        }
    }
    pub fn is_positive(&self) -> bool {
        match self {
            Num::Exact(a, b) => b.is_zero() && a.is_positive(),
            Num::Float(a, b, _) => *b == 0.0 && *a > 0.0,
            Num::Mp(x) => x.sign() > 0,
            Num::Mpc(x) => x.im.is_zero() && x.re.sign() > 0,
        }
    }
    /// For printing a term with " - ": the real part (or, if 0, the
    /// imaginary part) is negative.
    pub fn looks_negative(&self) -> bool {
        match self {
            // as printed, the imaginary part first (-2*I + 1): Sage's sign
            Num::Exact(a, b) => b.is_negative() || (b.is_zero() && a.is_negative()),
            Num::Float(a, b, _) => *a < 0.0 || (*a == 0.0 && *b < 0.0),
            Num::Mp(x) => x.sign() < 0,
            Num::Mpc(x) => x.re.sign() < 0 || (x.re.is_zero() && x.im.sign() < 0),
        }
    }

    pub fn to_c64(&self) -> (f64, f64) {
        match self {
            Num::Exact(a, b) => (q_to_f64(a), q_to_f64(b)),
            Num::Float(a, b, _) => (*a, *b),
            Num::Mp(x) => (x.to_f64(), 0.0),
            Num::Mpc(x) => (x.re.to_f64(), x.im.to_f64()),
        }
    }
    pub fn to_float(&self) -> Num {
        match self {
            Num::Float(..) | Num::Mp(_) | Num::Mpc(_) => self.clone(),
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
            Num::Mp(x) => Num::mp(x.neg()),
            Num::Mpc(x) => Num::mpc(x.neg()),
        }
    }
    pub fn add(&self, o: &Num) -> Num {
        match (self, o) {
            (Num::Exact(a, b), Num::Exact(c, d)) => Num::Exact(a + c, b + d),
            (Num::Mpc(x), o) | (o, Num::Mpc(x)) => mpc_binop(x, o, '+'),
            (Num::Mp(x), o) => mp_binop(x, o, '+', false),
            (o, Num::Mp(x)) => mp_binop(x, o, '+', true),
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                let (r, left) = tracked(|| Num::fl(step(a + c, false), step(b + d, false), self.fk_with(o)));
                rr_cc(r, &[self, o], left, |_| false, |v| v[0].add(&v[1]))
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
            (Num::Mpc(x), o) | (o, Num::Mpc(x)) => mpc_binop(x, o, '*'),
            (Num::Mp(x), o) => mp_binop(x, o, '*', false),
            (o, Num::Mp(x)) => mp_binop(x, o, '*', true),
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                let k = self.fk_with(o);
                // two reals multiply as reals: the complex formula's products with their zero
                // imaginary parts are NaN for an infinite or NaN number (inf*0), and RR('inf')*x
                // became (NaN - NaN*I)*x (Sage: (+infinity)*x). A real times a complex is the
                // complex formula, as Sage (SR(RR(2))*SR(CC(infinity, 1)) is +infinity + NaN*I)
                let p = |x: f64, y: f64| step(x * y, x != 0.0 && y != 0.0);
                let (r, left) = tracked(|| {
                    if b == 0.0 && d == 0.0 {
                        Num::fl(p(a, c), 0.0, k)
                    } else {
                        Num::fl(step(p(a, c) - p(b, d), false), step(p(a, d) + p(b, c), false), k)
                    }
                });
                rr_cc(r, &[self, o], left, |_| false, |v| v[0].mul(&v[1]))
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
            Num::Float(a, b, k) if *b == 0.0 => {
                let (r, left) = tracked(|| Num::Float(step(1.0 / a, true), 0.0, *k));
                rr_cc(r, &[self], left, |_| false, |v| v[0].inv())
            }
            // (a part of 1/z is 0 only where z's is: a/n and b/n underflow)
            Num::Float(a, b, k) => {
                let (r, left) = tracked(|| {
                    let n = step(step(a * a, *a != 0.0) + step(b * b, *b != 0.0), false);
                    Num::Float(step(a / n, *a != 0.0), step(-b / n, *b != 0.0), *k)
                });
                let lost = |i: usize| if i == 0 { *a != 0.0 } else { *b != 0.0 };
                rr_cc(r, &[self], left, lost, |v| v[0].inv())
            }
            // 1/x in its field, rounded once
            Num::Mp(x) => Num::mp(mpnum::arith(&Mp::fin(&BigInt::one(), 0, x.prec), x, '/', x.prec)),
            // (Sage's __invert__, each step rounded)
            Num::Mpc(x) => Num::mpc(x.inv()),
        }
    }
    pub fn div(&self, o: &Num) -> Num {
        // (an RR or CC quotient checked as a whole: Sage's is self times 1/o,
        // each in the MP field)
        if let Num::Float(_, _, k) = if matches!(self, Num::Float(..)) { self } else { o } {
            if !k.double() && !IN_STEPS.with(|p| p.get()) {
                let (r, left) = in_steps(|| self.mul(&o.inv()));
                let a = self.to_c64();
                let lost = |i: usize| if r.to_c64().1 == 0.0 && o.to_c64().1 == 0.0 && a.1 == 0.0 { i == 0 && a.0 != 0.0 } else { true };
                return rr_cc(r.clone(), &[self, o], left, lost, |v| v[0].mul(&v[1].inv()));
            }
        }
        self.mul(&o.inv())
    }
    pub fn pow_int(&self, e: i64) -> Num {
        if let Num::Mp(x) = self {
            if e < 0 && x.is_zero() {
                // (as 1/0 of a float)
                throw(SymError::DivisionByZero);
            }
            // (x^e correctly rounded, as Sage's mpfr_pow_si: not 1/x then
            // its powers)
            return Num::mp(mpnum::pow_int(x, e));
        }
        if let Num::Mpc(x) = self {
            if e < 0 && x.is_zero() {
                throw(SymError::DivisionByZero);
            }
            // (Sage's generic_power: the inverse first for e < 0, then
            // binary powering, each product Sage's)
            return Num::mpc(x.pow_int(e));
        }
        // (an RR or CC power is checked as a whole, against Sage's: a 0 part
        // of a nonzero number's power may be lost, for a real one as
        // mpfr_pow_si, a complex one as generic_power)
        if let Num::Float(a, b, k) = self {
            if !k.double() && e != 0 && !IN_STEPS.with(|p| p.get()) {
                let (r, left) = in_steps(|| self.pow_int(e));
                let lost = |i: usize| if *b == 0.0 { i == 0 && *a != 0.0 } else { true };
                return rr_cc(r, &[self], left, lost, |v| v[0].pow_int(e));
            }
        }
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
            Num::Mp(x) => match i64::try_from(e) {
                Ok(e) => Num::mp(mpnum::pow_int(x, e)),
                Err(_) => not_implemented("a power of a real number with so large an exponent in a symbolic expression is not available in sagebrush yet"),
            },
            Num::Mpc(x) => match i64::try_from(e) {
                Ok(e) => Num::mpc(x.pow_int(e)),
                Err(_) => not_implemented("a power of a complex number with so large an exponent in a symbolic expression is not available in sagebrush yet"),
            },
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
            // (the value, then a total order on equal ones: -0 and +0, the
            // precisions)
            // (NaN after every number, so that the order is total)
            (Num::Mp(x), Num::Mp(y)) => (x.sp == Sp::NaN)
                .cmp(&(y.sp == Sp::NaN))
                .then_with(|| x.cmp_value(y))
                .then_with(|| x.hash_key().cmp(&y.hash_key()))
                .then(x.prec.cmp(&y.prec)),
            (Num::Mpc(x), Num::Mpc(y)) => {
                let nan = |m: &Mp| m.sp == Sp::NaN;
                let part = |a: &Mp, b: &Mp| nan(a).cmp(&nan(b)).then_with(|| a.cmp_value(b)).then_with(|| a.hash_key().cmp(&b.hash_key()));
                part(&x.re, &y.re).then_with(|| part(&x.im, &y.im)).then(x.prec().cmp(&y.prec()))
            }
            _ => {
                let ((a, b), (c, d)) = (self.to_c64(), o.to_c64());
                // (then the doubles' bits: -0 and +0, NaNs, equal values of two kinds)
                fcmp(a, c).then(fcmp(b, d)).then(self.kind_rank().cmp(&o.kind_rank())).then_with(|| match (self, o) {
                    (Num::Float(a, b, _), Num::Float(c, d, _)) => (a.to_bits(), b.to_bits()).cmp(&(c.to_bits(), d.to_bits())),
                    _ => Ordering::Equal,
                })
            }
        }
    }

    /// The order of equal values of different kinds: a float before an exact
    /// number, as Sage prints f(0.500000000000000) + f(1/2) whatever the order
    /// the terms come in.
    fn kind_rank(&self) -> u8 {
        match self {
            Num::Float(..) => 0,
            Num::Mp(_) | Num::Mpc(_) => 1,
            Num::Exact(..) => 2,
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
            // (the precision neither: by value, NaN equal to NaN and -0 not
            // +0, as the doubles' bits)
            (Num::Mp(x), Num::Mp(y)) => x.same_value(y),
            (Num::Mpc(x), Num::Mpc(y)) => x.same_value(y),
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
            Num::Mp(x) => {
                2u8.hash(h);
                x.hash_key().hash(h);
            }
            Num::Mpc(x) => {
                3u8.hash(h);
                x.re.hash_key().hash(h);
                x.im.hash_key().hash(h);
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
        // (the exponent's digits as printed, a "+" dropped: RR's 1.50000000000000e-7 is
        // 10^{-7}, RDF's 2.5e-07 is 10^{-07}, as Sage)
        Some((m, e)) => format!("{} \\times 10^{{{}}}", m, e.trim_start_matches('+')),
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
            Num::Mp(x) => x.sage_str(),
            Num::Mpc(x) => x.sage_str(),
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
            Num::Mp(x) => x.latex(),
            Num::Mpc(x) => x.latex(),
        }
    }
}

/// A total order of doubles for sorting: NaN after every number (and equal
/// to NaN), -0 equal to 0, the rest by value (partial_cmp's Equal for NaN
/// made sorts of terms with NaN inconsistent, a panic in the sort).
pub fn fcmp(x: f64, y: f64) -> Ordering {
    match (x.is_nan(), y.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
    }
}

// ------------------------------------------------------------------ RR and CC past the doubles

// Sage's RR and CC are MPFR numbers at 53 bits, whose exponents reach far
// past a double's; a symbolic RR or CC number here holds doubles.  Where
// every double step of an operation (each product, quotient and sum, the
// steps of an inverse, a quotient a times 1/b and an integer power
// included) stays among the normal doubles, the steps are MPFR's, each
// rounded alike, and the result is Sage's.  Where one left them (step(): a
// product or quotient of nonzero numbers 0 or subnormal, or a step infinite
// or NaN), or an operand is not tame (each part 0 or of magnitude 2^-510 to
// 2^510), or a part of the result is infinite, NaN, subnormal or a lost 0,
// the operation is done again in the 53-bit MP field, Sage's steps: its
// value is kept when each part is a double, and refused when it is not
// (never an infinity or a 0 that Sage does not have, nor a part an
// underflowed step lost; https://github.com/sagemathinc/sagebrush/issues/1949).

const TAME_MIN: f64 = f64::from_bits(513 << 52); // 2^-510
const TAME_MAX: f64 = f64::from_bits(1533 << 52); // 2^510

fn tame(x: f64) -> bool {
    x == 0.0 || (TAME_MIN..=TAME_MAX).contains(&x.abs())
}

/// An infinite, NaN or subnormal double: a value that left the normal ones.
fn off(x: f64) -> bool {
    !x.is_finite() || (x != 0.0 && x.abs() < f64::MIN_POSITIVE)
}

thread_local! {
    // (set while an integer power or a quotient steps through its products:
    // it is checked as a whole, Sage's mpfr_pow_si, generic_power or a times
    // 1/b, not each step)
    static IN_STEPS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    // (set when a double step left the normal doubles, step(): where it did,
    // the operation is not MPFR's and is done again in the 53-bit MP field)
    static LEFT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// x, a double step's result, noted (LEFT) where it left the normal
/// doubles: infinite or NaN, or 0 or subnormal where `nonzero` (a product
/// or quotient of nonzero numbers, which MPFR keeps normal).
fn step(x: f64, nonzero: bool) -> f64 {
    if !x.is_finite() || (nonzero && x.abs() < f64::MIN_POSITIVE) {
        LEFT.with(|l| l.set(true));
    }
    x
}

/// f() and whether a step of it left the normal doubles (LEFT, kept for
/// an enclosing call).
fn tracked(f: impl FnOnce() -> Num) -> (Num, bool) {
    let before = LEFT.with(|l| l.replace(false));
    let r = f();
    let left = LEFT.with(|l| l.get());
    LEFT.with(|l| l.set(before || left));
    (r, left)
}

/// f() with the RR and CC checks of its steps suspended (IN_STEPS), the
/// previous state restored after it (a nested call keeps its caller's), and
/// whether any of its steps left the normal doubles.
fn in_steps(f: impl FnOnce() -> Num) -> (Num, bool) {
    struct Done(bool);
    impl Drop for Done {
        fn drop(&mut self) {
            IN_STEPS.with(|p| p.set(self.0));
        }
    }
    let _done = Done(IN_STEPS.with(|p| p.replace(true)));
    tracked(f)
}

/// A top-level call starts: the RR and CC checks are on and no step is
/// noted, whatever a trapped call left (a trap runs no destructors, so
/// in_steps' restore may not run).
pub fn reset_steps() {
    IN_STEPS.with(|p| p.set(false));
    LEFT.with(|l| l.set(false));
}

/// An operand of an RR or CC operation as a number of the 53-bit MP field,
/// its own (an element of RR a real, of CC a complex one, an exact number
/// real unless it has an imaginary part; mixed, the MP field's coercion
/// does what Sage's does): a double exactly, an exact number rounded once.
fn to_mp53(x: &Num) -> Num {
    let q = |a: &Q| Mp::from_q(a.numer(), a.denom(), 53);
    match x {
        Num::Exact(a, b) if !b.is_zero() => Num::mpc(Mpc::new(q(a), q(b))),
        Num::Exact(a, _) => Num::mp(q(a)),
        Num::Float(a, b, k) if k.complex() || *b != 0.0 => Num::mpc(Mpc::new(Mp::from_f64(*a, 53), Mp::from_f64(*b, 53))),
        Num::Float(a, _, _) => Num::mp(Mp::from_f64(*a, 53)),
        _ => x.clone(),
    }
}

/// r, the double result of an RR or CC operation on finite operands `ops`,
/// or the 53-bit MP field's (`mp` on the operands there) where r may have
/// left the doubles: a step of it did (`left`), an operand is not tame, a
/// part of r is off, or a part of r is 0 where `zero_lost` says Sage's may
/// not be.  That value is kept when each
/// part is a double and refused when it is not.  RDF and CDF are doubles in
/// Sage too, and an infinite or NaN operand takes the double steps (Sage's
/// special values).
fn rr_cc(r: Num, ops: &[&Num], left: bool, zero_lost: impl Fn(usize) -> bool, mp: impl FnOnce(&[Num]) -> Num) -> Num {
    let Num::Float(re, im, k) = r else { return r };
    if k.double() || IN_STEPS.with(|p| p.get()) {
        return r;
    }
    let parts: Vec<(f64, f64)> = ops.iter().map(|x| x.to_c64()).collect();
    let special = |x: &&Num| match x {
        Num::Float(a, b, _) => !a.is_finite() || !b.is_finite(),
        Num::Exact(..) => false,
        _ => true,
    };
    if ops.iter().any(special) {
        return r;
    }
    let suspect = left || parts.iter().any(|&(a, b)| !tame(a) || !tame(b)) || off(re) || off(im) || (re == 0.0 && zero_lost(0)) || (im == 0.0 && zero_lost(1));
    if !suspect {
        return r;
    }
    let v: Vec<Num> = ops.iter().map(|x| to_mp53(x)).collect();
    from_mp53(&mp(&v), k)
}

/// The double value r of a function `name` at finite RR or CC arguments v,
/// refused where it may have left the doubles (no MP version of the
/// function here): a part infinite or NaN where `pole` does not allow it, a
/// part subnormal, or 0 where `zero_ok` does not say Sage's value has an
/// exact 0 there (part 0 real, 1 imaginary).
pub fn check_float_value(name: &str, v: &[(f64, f64)], r: &Num, pole: bool, zero_ok: impl Fn(usize) -> bool) {
    if float_value_off(v, r, pole, zero_ok) {
        refuse_float_value(name, v, r.fk().unwrap_or(Fk::RR));
    }
}

/// Whether check_float_value refuses r.
pub fn float_value_off(v: &[(f64, f64)], r: &Num, pole: bool, zero_ok: impl Fn(usize) -> bool) -> bool {
    let Num::Float(re, im, k) = *r else { return false };
    if k.double() || v.iter().any(|&(a, b)| !a.is_finite() || !b.is_finite()) {
        return false;
    }
    let bad = |x: f64, i: usize| if !x.is_finite() { !pole } else if x == 0.0 { !zero_ok(i) } else { x.abs() < f64::MIN_POSITIVE };
    bad(re, 0) || bad(im, 1)
}

/// The refusal of a function's RR or CC value (parent k) at v past the doubles.
pub fn refuse_float_value(name: &str, v: &[(f64, f64)], k: Fk) -> ! {
    let args: Vec<String> = v.iter().map(|&(a, b)| crate::print::to_string(&crate::expr::num(Num::fl(a, b, k.to_real())))).collect();
    let f = if k.complex() { "CC" } else { "RR" };
    not_implemented(format!("{}({}): the value in {}, past the double range, is not available in sagebrush yet", name, args.join(", "), f))
}

/// b^n for an RR or CC number b (parent k) and an integer n, as Sage
/// computes it in the 53-bit MP field (mpfr_pow_si for a real b, generic_power
/// for a complex one): kept when each part is a double, refused otherwise.
pub fn pow_int_mp53(b: &Num, n: i64, k: Fk) -> Num {
    from_mp53(&to_mp53(b).pow_int(n), k)
}

/// A number of the 53-bit MP field as RR's or CC's doubles (parent k), or
/// refused, with Sage's value, when a part is not a double.
fn from_mp53(v: &Num, k: Fk) -> Num {
    let back = |x: &Mp| {
        let d = x.to_f64();
        if Mp::from_f64(d, 53).same_value(x) {
            Some(d)
        } else {
            None
        }
    };
    let refuse = |s: String, f: &str| -> ! { not_implemented(format!("{}, an element of {} past the double range, has no symbolic form in sagebrush yet", s, f)) };
    match v {
        Num::Mp(x) => match back(x) {
            Some(d) => Num::Float(d, 0.0, k),
            None => refuse(x.sage_str(), if k.complex() { "CC" } else { "RR" }),
        },
        Num::Mpc(z) => match (back(&z.re), back(&z.im)) {
            (Some(a), Some(b)) => Num::fl(a, b, k),
            _ => refuse(z.sage_str(), "CC"),
        },
        _ => v.clone(),
    }
}

/// x of RealField(p) (p > 53) or ComplexField(p) at 53 bits as a double, as
/// Sage's coercion into RR or CC rounds it; refused when the 53-bit value
/// is past the doubles (an element of RR or CC has no other symbolic form
/// here).
fn mp_to_53(x: &Mp) -> f64 {
    let r = x.round_to(53);
    let d = r.to_f64();
    if !Mp::from_f64(d, 53).same_value(&r) {
        not_implemented("a real number of RR past the doubles in a symbolic expression is not available in sagebrush yet");
    }
    d
}

/// x op o (op '+' or '*'; o op x when rev) for x of RealField(p), as Sage
/// computes it on RealNumber (RealNumberMP's _binop): an exact number is
/// rounded into RealField(p); another such real and x are rounded into the
/// coarser field; against a double (RR or RDF) a finer field is the
/// double's (RR's 53-bit arithmetic, the result in RR; RDF's double
/// arithmetic, in RDF) and a coarser one takes the double rounded into it.
/// Each result is rounded once.  Against a complex number, x is the complex
/// x + 0*I of its field (mpc_binop).
fn mp_binop(x: &Mp, o: &Num, op: char, rev: bool) -> Num {
    let p = x.prec;
    let ar = |a: &Mp, b: &Mp, q: u32| {
        let (a, b) = if rev { (b, a) } else { (a, b) };
        mpnum::arith(a, b, op, q)
    };
    match o {
        Num::Mp(y) => {
            let q = p.min(y.prec);
            Num::mp(ar(&x.round_to(q), &y.round_to(q), q))
        }
        Num::Mpc(_) => mpc_binop(&Mpc::from_real(x), o, op),
        Num::Exact(a, b) => {
            if !b.is_zero() {
                return mpc_binop(&Mpc::from_real(x), o, op);
            }
            Num::mp(ar(x, &Mp::from_q(a.numer(), a.denom(), p), p))
        }
        Num::Float(a, b, k) => {
            if *b != 0.0 || k.complex() {
                return mpc_binop(&Mpc::from_real(x), o, op);
            }
            if p < 53 {
                return Num::mp(ar(x, &Mp::from_f64(*a, p), p));
            }
            if k.double() {
                let (u, v) = if rev { (*a, x.to_f64()) } else { (x.to_f64(), *a) };
                return Num::Float(if op == '+' { u + v } else { u * v }, 0.0, Fk::RDF);
            }
            let r = ar(&x.round_to(53), &Mp::from_f64(*a, 53), 53);
            let d = r.to_f64();
            // (an element of RR past the doubles has no symbolic form here)
            if !Mp::from_f64(d, 53).same_value(&r) {
                not_implemented("a real number of RR past the doubles in a symbolic expression is not available in sagebrush yet");
            }
            Num::Float(d, 0.0, Fk::RR)
        }
    }
}

/// x op o (op '+' or '*', both commutative here) for x of ComplexField(p),
/// as Sage computes it on ComplexNumber: o is coerced into the pushout of
/// the two parents and Sage's operation runs there, each step rounded.
/// - an exact number: each part rounded into ComplexField(p);
/// - a real or complex of another precision: both in the coarser field (a
///   real as x + 0*I);
/// - a double of any kind: for p < 53 rounded into ComplexField(p);
///   otherwise against CDF x as a pair of doubles and CDF's arithmetic, and
///   against RR, CC or RDF x rounded into CC and CC's, the result in CC.
fn mpc_binop(x: &Mpc, o: &Num, op: char) -> Num {
    let p = x.prec();
    let run = |a: &Mpc, b: &Mpc| Num::mpc(if op == '+' { a.add(b, '+') } else { a.mul(b) });
    match o {
        Num::Mpc(y) => {
            let q = p.min(y.prec());
            run(&x.round_to(q), &y.round_to(q))
        }
        Num::Mp(y) => {
            let q = p.min(y.prec);
            run(&x.round_to(q), &Mpc::from_real(&y.round_to(q)))
        }
        Num::Exact(a, b) => run(x, &Mpc::new(Mp::from_q(a.numer(), a.denom(), p), Mp::from_q(b.numer(), b.denom(), p))),
        Num::Float(a, b, k) => {
            if p < 53 {
                return run(x, &Mpc::new(Mp::from_f64(*a, p), Mp::from_f64(*b, p)));
            }
            // (CDF's arithmetic against CDF; against RR, CC or RDF, CC's: RDF
            // meets ComplexField(p) in CC, as Sage's coercion)
            let (xf, of) = if *k == Fk::CDF {
                (Num::Float(x.re.to_f64(), x.im.to_f64(), Fk::CDF), o.clone())
            } else {
                (Num::Float(mp_to_53(&x.re), mp_to_53(&x.im), Fk::CC), Num::Float(*a, *b, if k.complex() { Fk::CC } else { Fk::RR }))
            };
            if op == '+' {
                xf.add(&of)
            } else {
                xf.mul(&of)
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
    use crate::mpnum::{Mp, Sp};

    fn mpq(n: i64, d: i64, p: u32) -> Num {
        Num::mp(Mp::from_q(&BigInt::from(n), &BigInt::from(d), p))
    }

    #[test]
    fn realfield_coercions() {
        // two fields: the coarser one, each operand rounded into it first
        let s = mpq(1, 3, 100).add(&mpq(1, 3, 20));
        assert_eq!(s.as_mp().unwrap().prec, 20);
        assert_eq!(s.sage_str(), "0.66667");
        // an exact number is rounded into the field, the result rounded once
        assert_eq!(mpq(1, 3, 100).add(&Num::rat(qr(1, 3))).sage_str(), "0.66666666666666666666666666667");
        // RR against a finer field: RR's arithmetic; a coarser field takes RR's number
        assert_eq!(mpq(1, 3, 100).add(&Num::float(1.0)), Num::Float(1.0 + 1.0 / 3.0, 0.0, Fk::RR));
        assert_eq!(mpq(1, 3, 20).add(&Num::float(1.0)).sage_str(), "1.3333");
        // RDF against a finer field: the double's arithmetic, in RDF
        assert_eq!(Num::Float(1.0, 0.0, Fk::RDF).mul(&mpq(1, 3, 100)).fk(), Some(Fk::RDF));
        assert_eq!(mpq(1, 3, 20).mul(&Num::Float(3.0, 0.0, Fk::RDF)).sage_str(), "1.0000");
        // the exact identities: 0*x is 0, 1*x is x
        assert!(mpq(1, 3, 100).mul(&Num::zero()).is_exact());
        assert_eq!(Num::one().mul(&mpq(1, 3, 100)).as_mp().unwrap().prec, 100);
        // an integer power is correctly rounded, 1/x too
        assert_eq!(mpq(1, 3, 100).pow_int(-3).sage_str(), "27.000000000000000000000000000");
        assert_eq!(mpq(3, 1, 100).inv(), mpq(1, 3, 100));
        // equal values are equal and hash alike whatever their fields; -0 is not +0
        assert_eq!(mpq(1, 2, 100), mpq(1, 2, 30));
        assert_ne!(Num::mp(Mp::zero(100, true)), Num::mp(Mp::zero(100, false)));
        assert_eq!(Num::mp(Mp::special(10, Sp::NaN)), Num::mp(Mp::special(90, Sp::NaN)));
        let h = |n: &Num| {
            use std::hash::{BuildHasher, BuildHasherDefault};
            BuildHasherDefault::<std::collections::hash_map::DefaultHasher>::default().hash_one(n)
        };
        assert_eq!(h(&mpq(1, 2, 100)), h(&mpq(1, 2, 30)));
        assert_eq!(mpq(-1, 2, 100).cmp(&mpq(1, 3, 10)), Ordering::Less);
    }

    #[test]
    fn rr_cc_past_the_doubles() {
        // (Sage's RR and CC have MPFR's exponents: a result past the doubles
        // is refused with Sage's value, one whose steps left them is Sage's)
        let rr = |x: f64| Num::Float(x, 0.0, Fk::RR);
        let refused = |f: &dyn Fn() -> Num| match crate::err::catch(f) {
            Err(SymError::NotImplemented(m)) => m,
            r => panic!("not refused: {:?}", r),
        };
        let p = |e: i32| 2f64.powi(e);
        assert_eq!(rr(p(600)).mul(&rr(p(-600))), rr(1.0));
        assert_eq!(rr(p(-600)).div(&rr(p(-600))), rr(1.0));
        assert!(refused(&|| rr(p(1000)).mul(&Num::int(1 << 30))).starts_with("1.15052360631188e310, an element of RR past the double range"));
        assert!(refused(&|| rr(p(-600)).mul(&rr(p(-600)))).starts_with("5.80771375621750e-362, an element of RR"));
        assert!(refused(&|| rr(1e300).pow_int(2)).starts_with("1.00000000000000e600, an element of RR"));
        assert_eq!(rr(p(-1020)).inv(), rr(p(1020)));
        assert!(refused(&|| Num::Float(p(600), 1.0, Fk::CC).mul(&Num::Float(p(600), 0.0, Fk::CC))).starts_with("1.72184794563858e361 + 4.14951556888099e180*I, an element of CC"));
        // (an integer power of CC is Sage's generic_power, a quotient Sage's
        // a times 1/b, each checked as a whole)
        assert_eq!(Num::Float(1.0, 1.0, Fk::CC).pow_int(2), Num::Float(0.0, 2.0, Fk::CC));
        assert!(refused(&|| rr(1.5).div(&Num::Float(p(600), 1.0, Fk::CC))).starts_with("3.61487979765433e-181 - 8.71157063432625e-362*I, an element of CC"));
        // RDF and CDF are doubles in Sage too
        assert_eq!(Num::Float(1e300, 0.0, Fk::RDF).mul(&Num::Float(1e300, 0.0, Fk::RDF)), Num::Float(f64::INFINITY, 0.0, Fk::RDF));
        // (the checks are off only inside in_steps: a nested one restores its
        // caller's state, and a top-level call turns them back on after a
        // trap left them off)
        let on = || !IN_STEPS.with(|p| p.get());
        in_steps(|| {
            in_steps(|| Num::zero());
            assert!(!on());
            Num::zero()
        });
        // (a step inside a quotient or a power that left the doubles is
        // noted: 1/b's real part 2^-1200 is lost to the doubles, so a/a was
        // 1 + 2^-800*I and a/b's real part 2^-800, Sage's 1 and 2^-799)
        let a = Num::Float(p(-400), -p(400), Fk::CC);
        let b = Num::Float(p(400), -p(-400), Fk::CC);
        assert_eq!(a.div(&a), Num::Float(1.0, 0.0, Fk::CC));
        assert_eq!(a.div(&b), Num::Float(p(-799), -1.0, Fk::CC));
        // (and 1/a itself, 2^-1200 + 2^-400*I in Sage, is past the doubles)
        assert!(refused(&|| a.pow_int(-1)).starts_with("5.80771375621750e-362 + 3.87259191484932e-121*I, an element of CC"));
        assert!(on());
        IN_STEPS.with(|p| p.set(true));
        reset_steps();
        assert!(on());
        assert!(refused(&|| rr(p(-600)).mul(&rr(p(-600)))).starts_with("5.80771375621750e-362"));
    }

    #[test]
    fn canonical_order_is_total() {
        // (antisymmetric and transitive over NaN, signed zeros, infinities and
        // values of each kind: a sort of terms with NaN panicked)
        let mut v = vec![Num::zero(), Num::rat(qr(1, 2)), Num::rat(qr(-3, 1))];
        for x in [f64::NAN, 0.0, -0.0, f64::INFINITY, f64::NEG_INFINITY, 1.5, -1.0, 2.0] {
            v.push(Num::Float(x, 0.0, Fk::RR));
        }
        for p in [10, 100] {
            v.push(Num::mp(Mp::special(p, Sp::NaN)));
            v.push(Num::mp(Mp::special(p, Sp::PosInf)));
            v.push(Num::mp(Mp::special(p, Sp::NegInf)));
            v.push(Num::mp(Mp::zero(p, false)));
            v.push(Num::mp(Mp::zero(p, true)));
            v.push(mpq(1, 3, p));
            v.push(mpq(-2, 1, p));
            v.push(mpq(5, 1, p));
        }
        for a in &v {
            for b in &v {
                assert_eq!(a.cmp(b), b.cmp(a).reverse(), "{:?} {:?}", a, b);
                for c in &v {
                    if a.cmp(b) != Ordering::Greater && b.cmp(c) != Ordering::Greater {
                        assert_ne!(a.cmp(c), Ordering::Greater, "{:?} {:?} {:?}", a, b, c);
                    }
                }
            }
        }
    }

    /// A real of RealField(p) or a number of ComplexField(p) meets complex
    /// numbers and doubles in Sage's pushout: ComplexField(p) for an exact
    /// one, the coarser field, and for p > 53 CC against RR, CC and RDF and
    /// CDF against CDF; for p < 53 ComplexField(p) against any double.
    #[test]
    fn complexfield_coercions_as_sage() {
        let c = |p: u32| Num::mpc(Mpc::new(Mp::from_f64(1.0, p), Mp::from_f64(2.0, p)));
        let kind = |n: Num| match n {
            Num::Mpc(z) => format!("C{}", z.prec()),
            Num::Mp(x) => format!("R{}", x.prec),
            Num::Float(_, _, k) => format!("{:?}", k),
            Num::Exact(..) => "Q".into(),
        };
        let (rdf, cdf, rr, cc) = (Num::Float(1.0, 0.0, Fk::RDF), Num::Float(1.0, 1.0, Fk::CDF), Num::float(1.0), Num::Float(1.0, 1.0, Fk::CC));
        assert_eq!(kind(mpq(1, 3, 100).mul(&Num::i())), "C100");
        for (a, b, k) in [
            (c(100), rdf.clone(), "CC"),
            (c(100), cdf.clone(), "CDF"),
            (c(100), rr.clone(), "CC"),
            (c(100), cc.clone(), "CC"),
            (c(20), rdf.clone(), "C20"),
            (c(20), cdf.clone(), "C20"),
            (c(20), cc.clone(), "C20"),
            (mpq(1, 3, 100), cdf.clone(), "CDF"),
            (mpq(1, 3, 100), cc.clone(), "CC"),
            (mpq(1, 3, 20), cdf.clone(), "C20"),
            (mpq(1, 3, 20), cc.clone(), "C20"),
            (c(100), mpq(1, 3, 200), "C100"),
            (c(100), mpq(1, 3, 20), "C20"),
            (c(100), c(200), "C100"),
            (c(100), Num::Exact(qr(1, 3), qr(2, 7)), "C100"),
        ] {
            assert_eq!(kind(a.add(&b)), k, "{:?} + {:?}", a, b);
            assert_eq!(kind(b.mul(&a)), k, "{:?} * {:?}", b, a);
        }
    }
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
            Num::Mp(_) => true,
            Num::Mpc(z) => z.im.is_zero(),
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
