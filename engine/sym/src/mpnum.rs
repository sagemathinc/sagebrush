//! Numbers of RealField(p), p != 53, in symbolic expressions: a value
//! m 2^e with exactly p bits in m (or a zero, an infinity or NaN), and the
//! field's arithmetic to nearest, each result rounded once, as Sagebrush's
//! RealNumberMP computes it (lib/_sage_real.py: _round_q, _round_int,
//! _arith, _special_op, _format): the same roundings, so the same digits.
//!
//! The values held lie within 2^-MAX_EXP <= |x| < 2^MAX_EXP (or are 0,
//! infinite or NaN): past them a number has no symbolic form here, and an
//! operation whose result would leave the range is refused.  (Exact sums and
//! powers stay of a size bounded by the range and the precision.)

use crate::err::not_implemented;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

/// The bound of the exponents t of the values held, 2^(t-1) <= |x| < 2^t.
pub const MAX_EXP: i64 = 4096;

/// An infinity or NaN, or a finite number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Sp {
    Fin,
    PosInf,
    NegInf,
    NaN,
}

/// A number of RealField(prec) (rounding to nearest): m 2^e with m of
/// exactly prec bits, or zero (m = 0, e = 0, neg0 its sign), or a special.
#[derive(Clone, Debug)]
pub struct Mp {
    pub m: BigInt,
    pub e: i64,
    pub prec: u32,
    pub sp: Sp,
    pub neg0: bool,
}

/// n/d 2^shift (d > 0) rounded to prec bits, to nearest (ties to even):
/// (m, e) with m of exactly prec bits, or (0, 0).
pub fn round_q(n: &BigInt, d: &BigInt, prec: u32, shift: i64) -> (BigInt, i64) {
    if n.is_zero() {
        return (BigInt::zero(), 0);
    }
    let neg = n.is_negative();
    let a = n.abs();
    let top = BigInt::one() << prec as usize;
    let half = BigInt::one() << (prec - 1) as usize;
    let mut e: i64 = a.bits() as i64 - d.bits() as i64 - prec as i64;
    loop {
        let (q, r, dd) = if e >= 0 {
            let dd = d << e as usize;
            let (q, r) = a.div_rem(&dd);
            (q, r, dd)
        } else {
            let (q, r) = (&a << (-e) as usize).div_rem(d);
            (q, r, d.clone())
        };
        if q >= top {
            e += 1;
            continue;
        }
        if q < half {
            e -= 1;
            continue;
        }
        let mut q = q;
        if !r.is_zero() {
            let c = (&r << 1usize) - &dd;
            if c.is_positive() || (c.is_zero() && q.is_odd()) {
                q += 1;
            }
        }
        if q == top {
            q >>= 1usize;
            e += 1;
        }
        return (if neg { -q } else { q }, e + shift);
    }
}

/// m 2^e (any integer m) rounded to prec bits.
pub fn round_int(m: &BigInt, e: i64, prec: u32) -> (BigInt, i64) {
    if m.is_zero() {
        return (BigInt::zero(), 0);
    }
    let b = m.bits();
    if b <= prec as u64 {
        let s = prec as u64 - b;
        return (m << s as usize, e - s as i64);
    }
    round_q(m, &BigInt::one(), prec, e)
}

fn refuse_range() -> ! {
    not_implemented(format!(
        "a real number of absolute value at least 2^{} or less than 2^-{} in a symbolic expression is not available in sagebrush yet",
        MAX_EXP, MAX_EXP
    ))
}

impl Mp {
    pub fn special(prec: u32, sp: Sp) -> Mp {
        Mp { m: BigInt::zero(), e: 0, prec, sp, neg0: false }
    }
    pub fn zero(prec: u32, neg: bool) -> Mp {
        Mp { m: BigInt::zero(), e: 0, prec, sp: Sp::Fin, neg0: neg }
    }
    /// The finite m 2^e rounded to prec bits (refused past the range).
    pub fn fin(m: &BigInt, e: i64, prec: u32) -> Mp {
        let (m, e) = round_int(m, e, prec);
        Mp::checked(Mp { m, e, prec, sp: Sp::Fin, neg0: false })
    }
    fn checked(x: Mp) -> Mp {
        if x.sp == Sp::Fin && !x.m.is_zero() && x.top().abs() > MAX_EXP {
            refuse_range();
        }
        x
    }
    /// A rational rounded into RealField(prec).
    pub fn from_q(n: &BigInt, d: &BigInt, prec: u32) -> Mp {
        let (m, e) = round_q(n, d, prec, 0);
        Mp::checked(Mp { m, e, prec, sp: Sp::Fin, neg0: false })
    }
    /// A double rounded into RealField(prec).
    pub fn from_f64(x: f64, prec: u32) -> Mp {
        if x.is_nan() {
            return Mp::special(prec, Sp::NaN);
        }
        if x.is_infinite() {
            return Mp::special(prec, if x > 0.0 { Sp::PosInf } else { Sp::NegInf });
        }
        if x == 0.0 {
            return Mp::zero(prec, x.is_sign_negative());
        }
        let bits = x.to_bits();
        let ex = ((bits >> 52) & 0x7ff) as i64;
        let frac = bits & ((1u64 << 52) - 1);
        let (mant, e) = if ex == 0 { (frac, -1074) } else { (frac | (1u64 << 52), ex - 1075) };
        let m = BigInt::from(mant);
        Mp::fin(&if x < 0.0 { -m } else { m }, e, prec)
    }
    pub fn is_zero(&self) -> bool {
        self.sp == Sp::Fin && self.m.is_zero()
    }
    /// The exponent t of a finite nonzero number: 2^(t-1) <= |x| < 2^t.
    pub fn top(&self) -> i64 {
        self.e + self.m.bits() as i64
    }
    pub fn signbit(&self) -> bool {
        self.m.is_negative() || self.neg0 || self.sp == Sp::NegInf
    }
    /// -1, 0 or 1 (0 for a zero or NaN)
    pub fn sign(&self) -> i32 {
        match self.sp {
            Sp::PosInf => 1,
            Sp::NegInf => -1,
            Sp::NaN => 0,
            Sp::Fin => {
                if self.m.is_positive() {
                    1
                } else if self.m.is_negative() {
                    -1
                } else {
                    0
                }
            }
        }
    }
    pub fn neg(&self) -> Mp {
        match self.sp {
            Sp::PosInf => Mp::special(self.prec, Sp::NegInf),
            Sp::NegInf => Mp::special(self.prec, Sp::PosInf),
            Sp::NaN => self.clone(),
            Sp::Fin if self.m.is_zero() => Mp::zero(self.prec, !self.neg0),
            Sp::Fin => Mp { m: -self.m.clone(), ..self.clone() },
        }
    }
    /// This number rounded into RealField(prec).
    pub fn round_to(&self, prec: u32) -> Mp {
        if prec == self.prec {
            return self.clone();
        }
        if self.sp != Sp::Fin || self.m.is_zero() {
            return Mp { prec, ..self.clone() };
        }
        Mp::fin(&self.m, self.e, prec)
    }
    /// The double nearest this number (ties to even), as float() of a
    /// RealNumberMP: subnormals rounded to their own precision.
    pub fn to_f64(&self) -> f64 {
        match self.sp {
            Sp::PosInf => return f64::INFINITY,
            Sp::NegInf => return f64::NEG_INFINITY,
            Sp::NaN => return f64::NAN,
            Sp::Fin => {}
        }
        if self.m.is_zero() {
            return if self.neg0 { -0.0 } else { 0.0 };
        }
        let top = self.e + self.m.bits() as i64;
        let neg = self.m.is_negative();
        if top > 1024 {
            return if neg { f64::NEG_INFINITY } else { f64::INFINITY };
        }
        // bits available: 53 for a normal double, fewer below 2^-1022
        let p = if top > -1022 { 53 } else { top + 1074 };
        let v = if p <= 0 {
            // below the smallest subnormal 2^-1074: it or 0 (a value in
            // [2^-1075, 2^-1074) rounds up unless exactly 2^-1075)
            if p == 0 && self.m.abs() != BigInt::one() << (self.m.bits() - 1) as usize {
                ldexp(1.0, -1074)
            } else {
                0.0
            }
        } else {
            let (mm, ee) = round_int(&self.m.abs(), self.e, p as u32);
            ldexp(mm.to_f64().unwrap(), ee)
        };
        if neg {
            -v
        } else {
            v
        }
    }
    /// The value order of two numbers (NaN equal to everything).
    pub fn cmp_value(&self, o: &Mp) -> Ordering {
        let key = |x: &Mp| match x.sp {
            Sp::NegInf => -2,
            Sp::PosInf => 2,
            Sp::NaN => 0,
            Sp::Fin => 0,
        };
        if self.sp == Sp::NaN || o.sp == Sp::NaN {
            return Ordering::Equal;
        }
        if self.sp != Sp::Fin || o.sp != Sp::Fin {
            return key(self).cmp(&key(o)).then_with(|| {
                if self.sp == Sp::Fin {
                    if o.sp == Sp::PosInf {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    }
                } else {
                    Ordering::Equal
                }
            });
        }
        let (s1, s2) = (self.sign(), o.sign());
        if s1 != s2 || s1 == 0 {
            return s1.cmp(&s2);
        }
        let e = self.e.min(o.e);
        (&self.m << (self.e - e) as usize).cmp(&(&o.m << (o.e - e) as usize))
    }
    /// Equal values (and kinds: NaN equals NaN, -0 is not +0, as a
    /// double's bits; the precision is not part of the value).
    pub fn same_value(&self, o: &Mp) -> bool {
        if self.sp != o.sp {
            return false;
        }
        if self.sp != Sp::Fin {
            return true;
        }
        if self.m.is_zero() || o.m.is_zero() {
            return self.m.is_zero() && o.m.is_zero() && self.neg0 == o.neg0;
        }
        self.cmp_value(o) == Ordering::Equal
    }
    /// (odd mantissa, exponent) of the value: equal values alike.
    pub fn hash_key(&self) -> (u8, String, i64) {
        match self.sp {
            Sp::Fin if self.m.is_zero() => (if self.neg0 { 5 } else { 4 }, String::new(), 0),
            Sp::Fin => {
                let t = self.m.trailing_zeros().unwrap_or(0);
                ((0), (&self.m >> t as usize).to_string(), self.e + t as i64)
            }
            Sp::PosInf => (1, String::new(), 0),
            Sp::NegInf => (2, String::new(), 0),
            Sp::NaN => (3, String::new(), 0),
        }
    }
}

/// x 2^e for an exactly representable result (two steps keep the scale
/// within the doubles).
fn ldexp(mut x: f64, mut e: i64) -> f64 {
    while e > 1000 {
        x *= 2f64.powi(1000);
        e -= 1000;
    }
    while e < -1000 {
        x *= 2f64.powi(-1000);
        e += 1000;
    }
    x * 2f64.powi(e as i32)
}

// ------------------------------------------------------------------ arithmetic

/// a op b (op in '+', '-', '*', '/') when one is an infinity or NaN.
fn special_op(a: &Mp, b: &Mp, op: char, prec: u32) -> Mp {
    let nan = Mp::special(prec, Sp::NaN);
    let inf = |s: i32| Mp::special(prec, if s > 0 { Sp::PosInf } else { Sp::NegInf });
    if a.sp == Sp::NaN || b.sp == Sp::NaN {
        return nan;
    }
    let (sa, mut sb) = (a.sign(), b.sign());
    match op {
        '+' | '-' => {
            let bs = if op == '-' {
                sb = -sb;
                match b.sp {
                    Sp::PosInf => Sp::NegInf,
                    Sp::NegInf => Sp::PosInf,
                    s => s,
                }
            } else {
                b.sp
            };
            if a.sp != Sp::Fin && bs != Sp::Fin {
                return if sa == sb { inf(sa) } else { nan };
            }
            if a.sp != Sp::Fin {
                inf(sa)
            } else {
                inf(sb)
            }
        }
        '*' => {
            if sa == 0 || sb == 0 {
                nan
            } else {
                inf(sa * sb)
            }
        }
        _ => {
            if a.sp != Sp::Fin && b.sp != Sp::Fin {
                return nan;
            }
            let neg = a.signbit() != b.signbit();
            if a.sp != Sp::Fin {
                inf(if neg { -1 } else { 1 })
            } else {
                Mp::zero(prec, neg)
            }
        }
    }
}

/// a op b in RealField(prec), a and b already in it, rounded once
/// (RealNumberMP's _arith to nearest).
pub fn arith(a: &Mp, b: &Mp, op: char, prec: u32) -> Mp {
    if a.sp != Sp::Fin || b.sp != Sp::Fin {
        return special_op(a, b, op, prec);
    }
    let r = match op {
        '+' | '-' => {
            let mb = if op == '+' { b.m.clone() } else { -b.m.clone() };
            if a.m.is_zero() {
                if mb.is_zero() {
                    // two zeros: their common sign, else +0
                    let nb = if op == '+' { b.neg0 } else { !b.neg0 };
                    return Mp::zero(prec, a.neg0 && nb);
                }
                let (m, e) = round_int(&mb, b.e, prec);
                Mp { m, e, prec, sp: Sp::Fin, neg0: false }
            } else if mb.is_zero() {
                let (m, e) = round_int(&a.m, a.e, prec);
                Mp { m, e, prec, sp: Sp::Fin, neg0: false }
            } else {
                // (the exact sum, then one rounding: the values held lie within
                // 2^+-MAX_EXP, so it has at most 2 MAX_EXP + 2 prec bits; an operand far
                // below the other's last bit, already rounded into the field, never
                // moves the result)
                let (ea, eb) = (a.e, b.e);
                let e = ea.min(eb);
                let mm = (&a.m << (ea - e) as usize) + (&mb << (eb - e) as usize);
                if mm.is_zero() {
                    // an exact cancellation: +0
                    return Mp::zero(prec, false);
                }
                let (m, e2) = round_q(&mm, &BigInt::one(), prec, e);
                Mp { m, e: e2, prec, sp: Sp::Fin, neg0: false }
            }
        }
        '*' => {
            let neg = a.signbit() != b.signbit();
            let mm = &a.m * &b.m;
            if mm.is_zero() {
                return Mp::zero(prec, neg);
            }
            let (m, e) = round_q(&mm, &BigInt::one(), prec, a.e + b.e);
            Mp { m, e, prec, sp: Sp::Fin, neg0: false }
        }
        _ => {
            let neg = a.signbit() != b.signbit();
            if b.m.is_zero() {
                if a.m.is_zero() {
                    return Mp::special(prec, Sp::NaN);
                }
                return Mp::special(prec, if neg { Sp::NegInf } else { Sp::PosInf });
            }
            let (mut n, mut d) = (a.m.clone(), b.m.clone());
            if d.is_negative() {
                n = -n;
                d = -d;
            }
            if n.is_zero() {
                return Mp::zero(prec, neg);
            }
            let (m, e) = round_q(&n, &d, prec, a.e - b.e);
            Mp { m, e, prec, sp: Sp::Fin, neg0: false }
        }
    };
    Mp::checked(r)
}

/// Whether pow_int(x, n) computes x^n here (its exact power within the
/// engine's integers, num::MAX_INT_BITS, or a value without powering: 0, an
/// infinity, NaN, n 0).
pub fn pow_int_fits(x: &Mp, n: i64) -> bool {
    n == 0 || x.sp != Sp::Fin || x.m.is_zero() || x.m.bits().saturating_mul(n.unsigned_abs()) <= crate::num::MAX_INT_BITS
}

/// x^n for an integer n, correctly rounded (the exact power, an integer
/// times a power of 2, then one rounding; refused as any integer past the
/// engine's integers would be, num::check_int_bits_at_least).
pub fn pow_int(x: &Mp, n: i64) -> Mp {
    let p = x.prec;
    let odd = n % 2 != 0;
    if n == 0 {
        return Mp::fin(&BigInt::one(), 0, p);
    }
    match x.sp {
        Sp::NaN => return x.clone(),
        Sp::PosInf => return if n > 0 { x.clone() } else { Mp::zero(p, false) },
        Sp::NegInf => {
            return if n > 0 {
                Mp::special(p, if odd { Sp::NegInf } else { Sp::PosInf })
            } else {
                Mp::zero(p, odd)
            }
        }
        Sp::Fin => {}
    }
    if x.m.is_zero() {
        let neg = x.neg0 && odd;
        return if n > 0 { Mp::zero(p, neg) } else { Mp::special(p, if neg { Sp::NegInf } else { Sp::PosInf }) };
    }
    let k = n.unsigned_abs();
    crate::num::check_int_bits_at_least(x.m.bits().saturating_mul(k));
    let mk = x.m.pow(k as u32);
    let ek = x.e.checked_mul(k as i64).unwrap_or_else(|| refuse_range());
    if n > 0 {
        let (m, e) = round_int(&mk, ek, p);
        return Mp::checked(Mp { m, e, prec: p, sp: Sp::Fin, neg0: false });
    }
    let (num, den) = if mk.is_negative() { (-BigInt::one(), -mk) } else { (BigInt::one(), mk) };
    let (m, e) = round_q(&num, &den, p, -ek);
    Mp::checked(Mp { m, e, prec: p, sp: Sp::Fin, neg0: false })
}

// ------------------------------------------------------------------ printing

/// The significant digits RealField(prec) prints (RealNumberMP's _digits).
pub fn digits(prec: u32) -> usize {
    let d = ((prec as f64 - 1.0) * std::f64::consts::LOG10_2 + 1e-12).floor() as i64;
    d.max(2) as usize
}

fn ten_pow(k: u64) -> BigInt {
    BigInt::from(10).pow(k as u32)
}

/// Whether a 2^e >= 10^E (a > 0).
fn ge_pow10(a: &BigInt, e: i64, ex: i64) -> bool {
    let mut l = a.clone();
    let mut r = BigInt::one();
    if e >= 0 {
        l <<= e as usize;
    } else {
        r <<= (-e) as usize;
    }
    if ex >= 0 {
        r *= ten_pow(ex as u64);
    } else {
        l *= ten_pow((-ex) as u64);
    }
    l >= r
}

/// m 2^e printed with D significant digits, to nearest, as Sage prints a
/// RealNumber (RealNumberMP's _format).
fn format(m: &BigInt, e: i64, d: usize) -> String {
    let neg = m.is_negative();
    let a = m.abs();
    let mut ex = (((a.bits() as i64 - 1 + e) as f64) * std::f64::consts::LOG10_2).floor() as i64;
    while !ge_pow10(&a, e, ex) {
        ex -= 1;
    }
    while ge_pow10(&a, e, ex + 1) {
        ex += 1;
    }
    let k = d as i64 - 1 - ex;
    // N = round(a 2^e 10^k), half to even
    let mut num = a.clone();
    let mut den = BigInt::one();
    if e >= 0 {
        num <<= e as usize;
    } else {
        den <<= (-e) as usize;
    }
    if k >= 0 {
        num *= ten_pow(k as u64);
    } else {
        den *= ten_pow((-k) as u64);
    }
    let (mut n, r) = num.div_rem(&den);
    let c = (&r << 1usize) - &den;
    if c.is_positive() || (c.is_zero() && n.is_odd()) {
        n += 1;
    }
    if n >= ten_pow(d as u64) {
        n /= BigInt::from(10);
        ex += 1;
    }
    let s = n.to_string();
    let sign = if neg { "-" } else { "" };
    if ex >= 6 || ex <= -6 {
        return format!("{}{}.{}e{}", sign, &s[..1], &s[1..], ex);
    }
    if ex >= 0 {
        let k = (ex + 1) as usize;
        if k >= d {
            return format!("{}{}{}.", sign, s, "0".repeat(k - d));
        }
        return format!("{}{}.{}", sign, &s[..k], &s[k..]);
    }
    format!("{}0.{}{}", sign, "0".repeat((-ex - 1) as usize), s)
}

impl Mp {
    /// As Sage prints an element of RealField(prec).
    pub fn sage_str(&self) -> String {
        match self.sp {
            Sp::PosInf => "+infinity".into(),
            Sp::NegInf => "-infinity".into(),
            Sp::NaN => "NaN".into(),
            Sp::Fin if self.m.is_zero() => format!("{}0.{}", if self.neg0 { "-" } else { "" }, "0".repeat(digits(self.prec))),
            Sp::Fin => format(&self.m, self.e, digits(self.prec)),
        }
    }
    /// Its latex: the printed digits, an exponent as a power of ten.
    pub fn latex(&self) -> String {
        let s = self.sage_str();
        match s.find('e') {
            Some(i) if i > 0 && s.as_bytes()[i - 1].is_ascii_digit() => {
                let rest = &s[i + 1..];
                let (minus, digits) = match rest.strip_prefix('-') {
                    Some(t) => ("-", t),
                    None => ("", rest.trim_start_matches('+')),
                };
                format!("{} \\times 10^{{{}{}}}", &s[..i], minus, digits)
            }
            _ => s,
        }
    }
    /// The wire form after the tag: prec ":" then "+inf", "-inf", "nan",
    /// "-0", or the mantissa in hex "p" the exponent.
    pub fn wire(&self) -> String {
        let body = match self.sp {
            Sp::PosInf => "+inf".to_string(),
            Sp::NegInf => "-inf".to_string(),
            Sp::NaN => "nan".to_string(),
            Sp::Fin if self.m.is_zero() => if self.neg0 { "-0" } else { "0" }.to_string(),
            Sp::Fin => format!("{}{:x}p{}", if self.m.is_negative() { "-" } else { "" }, self.m.abs(), self.e),
        };
        format!("{}:{}", self.prec, body)
    }
    /// The number a wire form gives, None if it is not one.
    pub fn from_wire(s: &str) -> Option<Mp> {
        let (p, body) = s.split_once(':')?;
        let prec: u32 = p.parse().ok()?;
        if prec < 1 || prec == 53 {
            return None;
        }
        Some(match body {
            "+inf" => Mp::special(prec, Sp::PosInf),
            "-inf" => Mp::special(prec, Sp::NegInf),
            "nan" => Mp::special(prec, Sp::NaN),
            "0" => Mp::zero(prec, false),
            "-0" => Mp::zero(prec, true),
            _ => {
                let (mh, eh) = body.split_once('p')?;
                let (neg, mh) = match mh.strip_prefix('-') {
                    Some(t) => (true, t),
                    None => (false, mh),
                };
                let m = BigInt::parse_bytes(mh.as_bytes(), 16)?;
                let e: i64 = eh.parse().ok()?;
                Mp::fin(&if neg { -m } else { m }, e, prec)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, p: u32) -> Mp {
        Mp::from_f64(x, p)
    }

    #[test]
    fn printing_as_realfield() {
        // (RealField(100)(1.5), (1/3), 2^100, 1e-7; RealField(20)(pi-ish))
        assert_eq!(r(1.5, 100).sage_str(), "1.5000000000000000000000000000");
        assert_eq!(Mp::from_q(&BigInt::from(1), &BigInt::from(3), 100).sage_str(), "0.33333333333333333333333333333");
        assert_eq!(Mp::fin(&BigInt::one(), 100, 100).sage_str(), "1.2676506002282294014967032054e30");
        assert_eq!(Mp::zero(100, false).sage_str(), "0.00000000000000000000000000000");
        assert_eq!(Mp::zero(100, true).sage_str(), "-0.00000000000000000000000000000");
        assert_eq!(r(-2.5, 20).sage_str(), "-2.5000");
        assert_eq!(Mp::fin(&BigInt::one(), 100, 100).latex(), "1.2676506002282294014967032054 \\times 10^{30}");
        assert_eq!(digits(100), 29);
        assert_eq!(digits(2), 2);
    }

    #[test]
    fn rounding_to_nearest_even() {
        // 1 + 2^-100 in 100 bits is 1 (a tie: to even); 1 + 3 2^-101 rounds up
        let one = r(1.0, 100);
        let tiny = Mp::fin(&BigInt::one(), -100, 100);
        assert!(arith(&one, &tiny, '+', 100).same_value(&one));
        let up = arith(&one, &Mp::fin(&BigInt::from(3), -101, 100), '+', 100);
        assert_eq!(up.cmp_value(&one), Ordering::Greater);
        // far apart: the sticky bit
        let far = arith(&one, &Mp::fin(&BigInt::one(), -500, 100), '+', 100);
        assert!(far.same_value(&one));
        // 1/3 + 1/3 + 1/3 at 100 bits is 1
        let t = Mp::from_q(&BigInt::from(1), &BigInt::from(3), 100);
        let s = arith(&arith(&t, &t, '+', 100), &t, '+', 100);
        assert!(s.same_value(&one));
        // division: 1/3 directly
        assert!(arith(&one, &r(3.0, 100), '/', 100).same_value(&t));
    }

    #[test]
    fn specials_and_zeros() {
        let z = Mp::zero(100, false);
        let nz = Mp::zero(100, true);
        assert!(arith(&nz, &nz, '+', 100).same_value(&nz));
        assert!(arith(&z, &nz, '+', 100).same_value(&z));
        assert_eq!(arith(&r(1.0, 100), &z, '/', 100).sp, Sp::PosInf);
        assert_eq!(arith(&z, &z, '/', 100).sp, Sp::NaN);
        assert!(arith(&r(1.0, 100), &r(-1.0, 100), '+', 100).same_value(&z));
        assert_eq!(pow_int(&z, -1).sp, Sp::PosInf);
        assert_eq!(pow_int(&nz, -3).sp, Sp::NegInf);
    }

    #[test]
    fn doubles_round_trip() {
        for x in [1.5, -0.1, 1e300, 5e-324, 2.2250738585072014e-308, -1e-310, 123456789.0] {
            assert_eq!(r(x, 100).to_f64(), x, "{}", x);
        }
        // a 100-bit 1/3 to the nearest double
        assert_eq!(Mp::from_q(&BigInt::from(1), &BigInt::from(3), 100).to_f64(), 1.0 / 3.0);
        assert_eq!(Mp::fin(&BigInt::one(), 2000, 100).to_f64(), f64::INFINITY);
    }

    #[test]
    fn wire_round_trip() {
        for x in [r(1.5, 100), r(-0.0, 30), Mp::special(64, Sp::NaN), Mp::from_q(&BigInt::from(-7), &BigInt::from(3), 200)] {
            let w = x.wire();
            let y = Mp::from_wire(&w).unwrap();
            assert!(x.same_value(&y) && x.prec == y.prec, "{}", w);
        }
        assert!(Mp::from_wire("53:1p0").is_none());
    }
}
