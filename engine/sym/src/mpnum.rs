//! Numbers of RealField(p), p != 53, in symbolic expressions: a value
//! m 2^e with exactly p bits in m (or a zero, an infinity or NaN), and the
//! field's arithmetic to nearest, each result rounded once, as Sagebrush's
//! RealNumberMP computes it (lib/_sage_real.py: _round_q, _round_int,
//! _arith, _special_op, _format): the same roundings, so the same digits.
//!
//! The values held lie within 2^-(MAX_EXP+1) <= |x| < 2^MAX_EXP (or are 0,
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

pub(crate) fn refuse_range() -> ! {
    not_implemented(format!(
        "a real number of absolute value at least 2^{} or less than 2^-{} in a symbolic expression is not available in sagebrush yet",
        MAX_EXP, MAX_EXP + 1
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
    /// log2 |x| of a finite nonzero number, with a relative error of a few
    /// units of 2^-52, and the exact one when |x| is a power of 2.  From the
    /// top 64 bits of the mantissa, but for |x| in [1/2, 2) from d = |x| - 1
    /// taken exactly from the whole mantissa, as ln(1 + d)/ln 2: near 1 the
    /// top bits alone give 0 (R100's 1 + 2^-70, whose 2^140th power is
    /// +infinity).
    pub fn log2_abs(&self) -> (f64, Option<i64>) {
        let a = self.m.abs();
        let b = a.bits();
        let exact = if a.trailing_zeros() == Some(b - 1) { Some(self.top() - 1) } else { None };
        let top = |v: &BigInt, e: i64| -> f64 {
            let s = v.bits().saturating_sub(64);
            let f = (v >> s as usize).to_f64().unwrap();
            f * ((e + s as i64) as f64).exp2()
        };
        if (0..=1).contains(&self.top()) && self.e < 0 {
            let d = &a - (BigInt::one() << (-self.e) as usize);
            let df = if d.is_negative() { -top(&-d, self.e) } else { top(&d, self.e) };
            return (df.ln_1p() / std::f64::consts::LN_2, exact);
        }
        let s = b.saturating_sub(64);
        let t = (&a >> s as usize).to_f64().unwrap();
        (t.log2() + (self.e + s as i64) as f64, exact)
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


/// x^n for an integer n, correctly rounded (Sage's mpfr_pow_si): the exact
/// power then one rounding when it is small, else bracketed (pow_bracket);
/// refused past the range.
pub fn pow_int(x: &Mp, n: i64) -> Mp {
    pow_big(x, &BigInt::from(n))
}

/// x^n for an integer n of any size, correctly rounded (Sage's mpfr_pow_z):
/// as pow_int, its parity and sign n's own, the bracket's binary powering
/// over the bits of |n|, refused past the range.
pub fn pow_big(x: &Mp, n: &BigInt) -> Mp {
    let p = x.prec;
    let odd = n.is_odd();
    let pos = n.is_positive();
    if n.is_zero() {
        return Mp::fin(&BigInt::one(), 0, p);
    }
    match x.sp {
        Sp::NaN => return x.clone(),
        Sp::PosInf => return if pos { x.clone() } else { Mp::zero(p, false) },
        Sp::NegInf => {
            return if pos {
                Mp::special(p, if odd { Sp::NegInf } else { Sp::PosInf })
            } else {
                Mp::zero(p, odd)
            }
        }
        Sp::Fin => {}
    }
    if x.m.is_zero() {
        let neg = x.neg0 && odd;
        return if pos { Mp::zero(p, neg) } else { Mp::special(p, if neg { Sp::NegInf } else { Sp::PosInf }) };
    }
    let k = n.abs();
    // (x = a 2^e with a odd: a power of 2 is a shift, and an odd power
    // either fits the bracket's width, so its ends agree, or has more than
    // p + 1 significant bits, so it is no rounding boundary)
    let t = x.m.trailing_zeros().unwrap_or(0);
    let a = x.m.abs() >> t as usize;
    let e = x.e.checked_add(t as i64).unwrap_or_else(|| refuse_range());
    let neg = x.m.is_negative() && odd;
    let fin = |(m, e): (BigInt, i64)| Mp::checked(Mp { m: if neg { -m } else { m }, e, prec: p, sp: Sp::Fin, neg0: false });
    if a.is_one() {
        let en = (BigInt::from(e) * n).to_i64().unwrap_or_else(|| refuse_range());
        return fin(round_int(&BigInt::one(), en, p));
    }
    if let Some(ks) = k.to_u64().filter(|&ks| a.bits().saturating_mul(ks) <= 4 * p as u64 + 256) {
        let ak = a.pow(ks as u32);
        let en = (BigInt::from(e) * n).to_i64().unwrap_or_else(|| refuse_range());
        return fin(if pos { round_int(&ak, en, p) } else { round_q(&BigInt::one(), &ak, p, en) });
    }
    fin(pow_round(&a, e, n, p, p as u64 + 2 * k.bits() + 20))
}

/// (a 2^e)^n (a > 0 odd, n != 0) rounded to p bits, as the front end's
/// _pow_round: bracketed by binary powering cut down and up to w bits; when
/// both ends round alike that is the result, else w doubles.
fn pow_round(a: &BigInt, e: i64, n: &BigInt, p: u32, w: u64) -> (BigInt, i64) {
    let k = n.abs();
    let mut w = w;
    loop {
        let (lo, hi) = pow_bracket(a, e, &k, w);
        let (r1, r2) = if n.is_positive() {
            (round_int(&lo.0, lo.1, p), round_int(&hi.0, hi.1, p))
        } else {
            // (1/x^k lies between 1/hi and 1/lo)
            (round_q(&BigInt::one(), &hi.0, p, -hi.1), round_q(&BigInt::one(), &lo.0, p, -lo.1))
        };
        if r1 == r2 {
            return r1;
        }
        w *= 2;
    }
}

/// m 2^e (m > 0) cut to at most w bits, down or up.
fn cut(m: BigInt, e: i64, w: u64, up: bool) -> (BigInt, i64) {
    let b = m.bits();
    if b <= w {
        return (m, e);
    }
    let s = b - w;
    let q = &m >> s as usize;
    let inexact = &(&q << s as usize) != &m;
    (if up && inexact { q + BigInt::one() } else { q }, e + s as i64)
}

/// lo <= (a 2^e)^k <= hi (a > 0, k > 0 of any size), each m 2^e with m of
/// at most w + 1 bits, by binary powering over the bits of k, cut down (lo)
/// and up (hi).  Refused where the power, or its inverse, is past the range
/// for certain: a factor still to come is at least 1 when a 2^e >= 1 (so
/// lo only grows) and at most 1 below (hi only shrinks), which also bounds
/// the exponents.
fn pow_bracket(a: &BigInt, e: i64, k: &BigInt, w: u64) -> ((BigInt, i64), (BigInt, i64)) {
    let mul = |x: &(BigInt, i64), y: &(BigInt, i64), up: bool| -> (BigInt, i64) {
        let r = cut(&x.0 * &y.0, x.1.checked_add(y.1).unwrap_or_else(|| refuse_range()), w, up);
        let top = r.1 + r.0.bits() as i64;
        if (!up && top > MAX_EXP + 4) || (up && top < -MAX_EXP - 4) {
            refuse_range();
        }
        r
    };
    let mut r = [(BigInt::one(), 0i64), (BigInt::one(), 0i64)];
    let mut base = [(a.clone(), e), (a.clone(), e)];
    let bits = k.bits();
    for i in 0..bits {
        if k.bit(i) {
            r = [mul(&r[0], &base[0], false), mul(&r[1], &base[1], true)];
        }
        if i + 1 < bits {
            base = [mul(&base[0], &base[0], false), mul(&base[1], &base[1], true)];
        }
    }
    let [lo, hi] = r;
    (lo, hi)
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

// ------------------------------------------------------------------ ComplexField(p)

/// A number of ComplexField(prec), prec != 53: re + im*I, both parts of
/// RealField(prec).  Its arithmetic is Sage's ComplexNumber's, each step
/// rounded to the field (complex_mpfr.pyx: _mul_, __invert__ and
/// generic_power), so a product is not correctly rounded but Sage's.
#[derive(Clone, Debug)]
pub struct Mpc {
    pub re: Mp,
    pub im: Mp,
}

impl Mpc {
    pub fn new(re: Mp, im: Mp) -> Mpc {
        debug_assert_eq!(re.prec, im.prec);
        Mpc { re, im }
    }
    pub fn prec(&self) -> u32 {
        self.re.prec
    }
    /// A real of RealField(prec) as a number of ComplexField(prec): the
    /// imaginary part +0, as Sage's coercion makes it.
    pub fn from_real(x: &Mp) -> Mpc {
        Mpc { re: x.clone(), im: Mp::zero(x.prec, false) }
    }
    pub fn one(prec: u32) -> Mpc {
        Mpc::from_real(&Mp::fin(&BigInt::one(), 0, prec))
    }
    /// Each part rounded into ComplexField(prec).
    pub fn round_to(&self, prec: u32) -> Mpc {
        Mpc { re: self.re.round_to(prec), im: self.im.round_to(prec) }
    }
    pub fn is_zero(&self) -> bool {
        self.re.is_zero() && self.im.is_zero()
    }
    pub fn neg(&self) -> Mpc {
        Mpc { re: self.re.neg(), im: self.im.neg() }
    }
    pub fn conjugate(&self) -> Mpc {
        Mpc { re: self.re.clone(), im: self.im.neg() }
    }
    /// Either part NaN.
    pub fn has_nan(&self) -> bool {
        self.re.sp == Sp::NaN || self.im.sp == Sp::NaN
    }
    /// self + o (op '+') or self - o (op '-'), part by part (_add_, _sub_).
    pub fn add(&self, o: &Mpc, op: char) -> Mpc {
        let p = self.prec();
        Mpc { re: arith(&self.re, &o.re, op, p), im: arith(&self.im, &o.im, op, p) }
    }
    /// self o, as Sage's _mul_: (RN(ac) - RN(bd)) + (RN(ad) + RN(bc)) I,
    /// each step rounded.
    pub fn mul(&self, o: &Mpc) -> Mpc {
        let p = self.prec();
        let (a, b, c, d) = (&self.re, &self.im, &o.re, &o.im);
        let re = arith(&arith(a, c, '*', p), &arith(b, d, '*', p), '-', p);
        let im = arith(&arith(a, d, '*', p), &arith(b, c, '*', p), '+', p);
        Mpc { re, im }
    }
    /// 1/self, as Sage's __invert__: n = RN(RN(a^2) + RN(b^2)), then
    /// RN(a/n) - RN(b/n) I (a zero is NaN + NaN*I, as mpfr's 0/0).
    pub fn inv(&self) -> Mpc {
        let p = self.prec();
        let (a, b) = (&self.re, &self.im);
        let n = arith(&arith(a, a, '*', p), &arith(b, b, '*', p), '+', p);
        Mpc { re: arith(a, &n, '/', p), im: arith(&b.neg(), &n, '/', p) }
    }
    /// self^n for an integer n of any size, as pow_int (Sage's
    /// generic_power on an Integer), by the bits of |n|: CC's I^(2^100) is 1.
    pub fn pow_big(&self, n: &BigInt) -> Mpc {
        if let Some(n) = n.to_i64() {
            return self.pow_int(n);
        }
        let mut apow = if n.is_negative() { self.inv() } else { self.clone() };
        let k = n.abs();
        let bits = k.bits();
        let mut i = 0;
        while !k.bit(i) {
            apow = apow.mul(&apow);
            i += 1;
        }
        let mut res = apow.clone();
        for j in i + 1..bits {
            apow = apow.mul(&apow);
            if k.bit(j) {
                res = apow.mul(&res);
            }
        }
        res
    }
    /// log2 |self| for a finite nonzero number (parts within MP numbers), and
    /// the exact one when it is a power of 2 (a part 0, the other +-2^t).
    pub fn log2_abs(&self) -> (f64, Option<i64>) {
        let (r, i) = (&self.re, &self.im);
        if r.is_zero() {
            return i.log2_abs();
        }
        if i.is_zero() {
            return r.log2_abs();
        }
        let (a, b) = (r.log2_abs().0, i.log2_abs().0);
        let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
        (hi + 0.5 * (1.0 + (2.0 * (lo - hi)).exp2()).log2(), None)
    }
    /// self^n for an integer n, as Sage's generic_power: 1 for n = 0; for
    /// n < 0 the inverse to -n; the powers self^(2^i) by squaring, from the
    /// lowest set bit, each multiplied into the result as apow * res.
    pub fn pow_int(&self, n: i64) -> Mpc {
        if n == 0 {
            return Mpc::one(self.prec());
        }
        let mut apow = if n < 0 { self.inv() } else { self.clone() };
        let mut k = n.unsigned_abs();
        while k & 1 == 0 {
            apow = apow.mul(&apow);
            k >>= 1;
        }
        let mut res = apow.clone();
        k >>= 1;
        while k != 0 {
            apow = apow.mul(&apow);
            if k & 1 == 1 {
                res = apow.mul(&res);
            }
            k >>= 1;
        }
        res
    }
    /// Equal values part by part (Mp::same_value's: -0 is not +0).
    pub fn same_value(&self, o: &Mpc) -> bool {
        self.re.same_value(&o.re) && self.im.same_value(&o.im)
    }
    /// As Sage prints an element of ComplexField(prec) (ComplexNumber.str):
    /// the real part when it is nonzero, then the imaginary part when it is
    /// nonzero, with " - " for a negative one; 0 as the real part prints.
    pub fn sage_str(&self) -> String {
        self.joined(|x| x.sage_str(), "*I")
    }
    /// Its latex: the parts' (an exponent as a power of ten), "i" for I,
    /// an infinity as \infty (as Sage's ComplexField; RealField's is
    /// +infinity).
    pub fn latex(&self) -> String {
        self.joined(|x| x.latex().replace("infinity", "\\infty"), "i")
    }
    fn joined(&self, f: impl Fn(&Mp) -> String, unit: &str) -> String {
        // (a part is nonzero when it is not a zero: NaN and the infinities
        // are, as mpfr_zero_p)
        let mut s = String::new();
        if !self.re.is_zero() {
            s = f(&self.re);
        }
        if !self.im.is_zero() {
            let mut y = self.im.clone();
            if !s.is_empty() {
                if y.sign() < 0 {
                    s.push_str(" - ");
                    y = y.neg();
                } else {
                    s.push_str(" + ");
                }
            }
            s.push_str(&f(&y));
            s.push_str(unit);
        }
        if s.is_empty() {
            s = f(&self.re);
        }
        s
    }
    /// The wire form after the tag: the parts' wire forms, joined by "|"
    /// (both carry the precision).
    pub fn wire(&self) -> String {
        format!("{}|{}", self.re.wire(), self.im.wire())
    }
    /// The number a wire form gives, None if it is not one.
    pub fn from_wire(s: &str) -> Option<Mpc> {
        let (a, b) = s.split_once('|')?;
        let (re, im) = (Mp::from_wire(a)?, Mp::from_wire(b)?);
        if re.prec != im.prec {
            return None;
        }
        Some(Mpc { re, im })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, p: u32) -> Mp {
        Mp::from_f64(x, p)
    }

    fn mp(h: &str, e: i64, p: u32) -> Mp {
        let (neg, h) = match h.strip_prefix('-') {
            Some(t) => (true, t),
            None => (false, h),
        };
        let m = BigInt::parse_bytes(h.as_bytes(), 16).unwrap();
        Mp::fin(&if neg { -m } else { m }, e, p)
    }

    /// x^n by the bracket (pow_int past the exact power's small case) is
    /// the exact power rounded once, as mpfr_pow_si: against that power,
    /// for bases near 1 and not, both signs of x and n, at 20, 53 and 200
    /// bits; Sage's values for exponents with no exact power to compute.
    #[test]
    fn pow_int_bracketed() {
        let exact = |x: &Mp, n: i64| -> Mp {
            let k = n.unsigned_abs();
            let mk = x.m.pow(k as u32);
            let (m, e) = if n > 0 {
                round_int(&mk, x.e * k as i64, x.prec)
            } else {
                let (a, d) = if mk.is_negative() { (-BigInt::one(), -mk) } else { (BigInt::one(), mk) };
                round_q(&a, &d, x.prec, -x.e * k as i64)
            };
            Mp { m, e, prec: x.prec, sp: Sp::Fin, neg0: false }
        };
        for p in [20u32, 53, 200] {
            for v in [1.0000001, -1.0001, 0.9999999, 3.0 / 7.0, -1.1, 1.5, 0.75, -2.0 / 3.0] {
                let x = Mp::from_q(&BigInt::from((v * 1e15f64).round() as i64), &BigInt::from(10i64.pow(15)), p);
                for k in (1i64..=300).step_by(7).chain([997, 1024, 1500]) {
                    for n in [k, -k] {
                        if (x.top().abs() + 1) * k > MAX_EXP - 8 {
                            continue;
                        }
                        let (a, b) = (pow_int(&x, n), exact(&x, n));
                        assert!(a.same_value(&b), "{} ^ {} at {}: {} for {}", x.sage_str(), n, p, a.sage_str(), b.sage_str());
                    }
                }
            }
        }
        // (the bracket itself: lo <= (a 2^e)^k <= hi, the exact power, and
        // apart when it was cut, at widths that cut it)
        let le = |x: &(BigInt, i64), y: &(BigInt, i64)| {
            let e = x.1.min(y.1);
            (&x.0 << (x.1 - e) as usize) <= (&y.0 << (y.1 - e) as usize)
        };
        for (a, e) in [(3u64, 0i64), (12345, -14), (0x1fffff, -21), (0x100001, -20), (7, -3)] {
            let a = BigInt::from(a);
            for k in [5u64, 17, 64, 101, 333] {
                let exact = (a.pow(k as u32), e * k as i64);
                for w in [24u64, 40, 64] {
                    let (lo, hi) = pow_bracket(&a, e, &BigInt::from(k), w);
                    assert!(le(&lo, &exact) && le(&exact, &hi), "{} 2^{} ^ {} at {}", a, e, k, w);
                    assert_eq!(le(&hi, &lo), exact.0.bits() <= w, "{} 2^{} ^ {} at {}", a, e, k, w);
                }
            }
        }
        // (from a width too narrow to decide, w doubles until both ends
        // round alike: still the exact power's rounding)
        for (a, e, p) in [(3u64, 0i64, 20u32), (12345, -14, 20), (0x1fffff, -21, 53), (7, -3, 8)] {
            let x = Mp::fin(&BigInt::from(a), e, p);
            for k in [5i64, 17, 64, 101] {
                for n in [k, -k] {
                    let b = exact(&x, n);
                    let r = pow_round(&BigInt::from(a), e, &BigInt::from(n), p, p as u64 + 1);
                    assert!(b.m == r.0 && b.e == r.1, "{} 2^{} ^ {} at {}", a, e, n, p);
                }
            }
        }
        // (Sage's RR(1.0000001)^(10^7), RR(-1.0001)^40000 and
        // RR(0.9999999)^(-10^9): an exact power of 53 million bits and more)
        assert_eq!(pow_int(&r(1.0000001, 53), 10_000_000).to_f64(), 2.7182816941320818);
        assert_eq!(pow_int(&r(-1.0001, 53), 40000).to_f64(), 54.587232222778944);
        assert_eq!(pow_int(&r(0.9999999, 53), -1_000_000_000).to_f64(), 2.6881304409450066e43);
        // (a power of 2 is a shift; past the range, refused)
        assert!(pow_int(&r(-2.0, 53), 4001).same_value(&Mp::fin(&BigInt::from(-1), 4001, 53)));
        assert!(crate::err::catch(|| pow_int(&r(1.5, 53), 1 << 40)).is_err());
        assert!(crate::err::catch(|| pow_int(&r(1.5, 53), -(1 << 40))).is_err());
    }

    /// ComplexField(p)'s arithmetic as Sage's ComplexNumber computes it, each
    /// step rounded: values from Sage (random parts at p = 20, 100, 200).
    #[test]
    fn complex_arithmetic_as_sage() {
        // p = 20, case 0
        let (z, w) = (Mpc::new(mp("-f3cf2", -18, 20), mp("f3ab4", -18, 20)), Mpc::new(mp("-af45e", -14, 20), mp("a13ff", -17, 20)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("93bdb", -12, 20), mp("-ba06d", -12, 20))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("-be82d", -14, 20), mp("8d8ac", -16, 20))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("a008f", -14, 20), mp("-9da94", -19, 20))));
        assert!(z.inv().same_value(&Mpc::new(mp("-867a4", -22, 20), mp("-86667", -22, 20))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("c3ec9", -23, 20), mp("-9b6af", -23, 20))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("88a00", -25, 20), mp("-e810b", -15, 20))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("dcc29", -13, 20), mp("dd242", -13, 20))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("-a8686", -14, 20), mp("beb31", -5, 20))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("87c1d", 12, 20), mp("-86bf0", 12, 20))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("-867a4", -22, 20), mp("-86667", -22, 20))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("a3d5f", -32, 20), mp("a35d6", -32, 20))));
        assert_eq!(z.sage_str(), "-3.8095 + 3.8073*I");
        // p = 20, case 1
        let (z, w) = (Mpc::new(mp("-98187", -19, 20), mp("a44ca", -25, 20)), Mpc::new(mp("-986e8", -20, 20), mp("a7677", -15, 20)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("935fe", -21, 20), mp("-c7034", -15, 20))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("-e44fb", -19, 20), mp("a7908", -15, 20))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("-97c26", -20, 20), mp("-a73e6", -15, 20))));
        assert!(z.inv().same_value(&Mpc::new(mp("-d761e", -20, 20), mp("-e8aa0", -26, 20))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("a891f", -28, 20), mp("e84a3", -24, 20))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("b4ace", -19, 20), mp("-c33a6", -24, 20))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("-d6908", -19, 20), mp("adf7b", -23, 20))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("b35fa", -18, 20), mp("-91cf4", -21, 20))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("-9349d", -16, 20), mp("83607", -18, 20))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("-d761e", -20, 20), mp("-e8aa0", -26, 20))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("-d7385", -21, 20), mp("-91a33", -24, 20))));
        assert_eq!(z.sage_str(), "-1.1882 + 0.020056*I");
        // p = 20, case 2
        let (z, w) = (Mpc::new(mp("9f855", -26, 20), mp("8f3eb", -26, 20)), Mpc::new(mp("e12b2", -23, 20), mp("-c7321", -19, 20)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("f0756", -26, 20), mp("-e87fe", -26, 20))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("f51bd", -23, 20), mp("-c6139", -19, 20))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("-cd3a7", -23, 20), mp("c8509", -19, 20))));
        assert!(z.inv().same_value(&Mpc::new(mp("e36fc", -14, 20), mp("-cc3b3", -14, 20))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("-a8c48", -27, 20), mp("d8ef3", -27, 20))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("99fe4", -35, 20), mp("b2851", -32, 20))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("-afcad", -39, 20), mp("f405e", -39, 20))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("-dfc8c", -59, 20), mp("-a7915", -57, 20))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("-cb6b7", -101, 20), mp("-8e4e8", -104, 20))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("e36fc", -14, 20), mp("-cc3b3", -14, 20))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("-870c8", 12, 20), mp("9986e", 11, 20))));
        assert_eq!(z.sage_str(), "0.0097364 + 0.0087430*I");
        // p = 100, case 0
        let (z, w) = (Mpc::new(mp("bd7a94ded97491e2370c6a5b8", -98, 100), mp("87ff122294b4d8474a3ea284d", -96, 100)), Mpc::new(mp("e4735af1ca7a1149075139237", -98, 100), mp("-c50b601fc4105cca7b53302fc", -103, 100)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("b62c3876c5b9889f88e86d057", -96, 100), mp("f07189183c9d9d1147349f574", -95, 100))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("d0f6f7e851f751959f2ed1bf8", -97, 100), mp("8674fb62552cb78db547fc247", -96, 100))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("-9be3184bc415fd9b41133b1fc", -100, 100), mp("898928e2d43cf900df3548e53", -96, 100))));
        assert!(z.inv().same_value(&Mpc::new(mp("95b0d32336d6bd99106bc4352", -104, 100), mp("-d6e0b5a8afc11fa78da3c6cae", -103, 100))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("c3c16dd19fe63031252412399", -100, 100), mp("99b730a70edd25840225e0981", -98, 100))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("-fdec7e759a0b83e15e86a03d8", -94, 100), mp("c950de100aee7a88c6221fed8", -94, 100))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("-99ee86d93fb4665ecedd50ca4", -90, 100), mp("-c348e1b6fcbe31cc7595e214e", -91, 100))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("dd43d11e4185dd7a2ffd64087", -82, 100), mp("ead9070c29649bbec601d0c18", -81, 100))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("-8ad99d446aa4956b72617c8be", -58, 100), mp("-cdf8bf846db005b1b4666ec9a", -60, 100))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("95b0d32336d6bd99106bc4352", -104, 100), mp("-d6e0b5a8afc11fa78da3c6cae", -103, 100))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("8d3a9a41eb8a5429139ff3521", -115, 100), mp("ee4e6985b26c79b907e5906c6", -119, 100))));
        assert_eq!(z.sage_str(), "2.9606067825569165543415902318 + 8.4997731543365287528672155566*I");
        // p = 100, case 1
        let (z, w) = (Mpc::new(mp("-c902a174f11fa2ac0079dd25a", -105, 100), mp("e4a789cb3d8b9b45c1b98fbe4", -105, 100)), Mpc::new(mp("b0023b682af5570eed8e94b15", -103, 100), mp("-bfaf8cda9601e5b4578511608", -100, 100)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("99ef5a2f4f064ca1a13ab7b16", -105, 100), mp("aa29737effccc534c05316bae", -105, 100))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("fb832615dd5adcc7dae03acfd", -104, 100), mp("-b88a508c3c1588da297744e29", -100, 100))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("-e242e3c5673d3fb9edad0bfac", -103, 100), mp("c6d4c928efee428e8592ddde7", -100, 100))));
        assert!(z.inv().same_value(&Mpc::new(mp("-8e205b6ec962cc0bcb4934445", -95, 100), mp("-a1ac2869bedda1d15fc5ef5b8", -95, 100))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("-a5e81d858df5b8a9409617892", -104, 100), mp("-e65e5be0edbf30830c33d60c7", -105, 100))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("-b996e61a22a98d345a9939a28", -112, 100), mp("-b389e4b577da541b564c5b0b8", -109, 100))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("b2937ba5c5f0e277f3d75dcd4", -114, 100), mp("f0814332e34eade24c70689ba", -115, 100))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("88298a316c29e60c17964cab1", -129, 100), mp("a7c46f1cd0d4c4c07878b13b6", -128, 100))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("-f2dad5b7082509a731382e570", -166, 100), mp("-98182289dd480c3bba625de4d", -161, 100))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("-8e205b6ec962cc0bcb4934445", -95, 100), mp("-a1ac2869bedda1d15fc5ef5b8", -95, 100))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("c0b407cf146dc6b79086eda6e", -77, 100), mp("c0769738b26aa8d6d7bfc356c", -76, 100))));
        assert_eq!(z.sage_str(), "-0.024537387223549659891146400835 + 0.027911919716573985909352878094*I");
        // p = 100, case 2
        let (z, w) = (Mpc::new(mp("-ba123f50190f5380e12b2a414", -94, 100), mp("-d4fab6f3e164f1513563e9bed", -106, 100)), Mpc::new(mp("a1e34b3f1ec3fbf4dc20ef164", -103, 100), mp("c77064c2c0f552c9402cdf2af", -99, 100)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("-ea098496033530fb2fb8d5212", -98, 100), mp("-90f6671e6b4eb61fbab545862", -93, 100))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("-b9c14daa797ff182e6bd19c9b", -94, 100), mp("c5c66f54d93288e69dc217577", -99, 100))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("-ba6330f5b89eb57edb993ab8d", -94, 100), mp("-c91a5a30a8b81cabe297a6fe7", -99, 100))));
        assert!(z.inv().same_value(&Mpc::new(mp("-b01ac3510b27d4dd28bc1ca70", -105, 100), mp("c992418419f0720e8f6e4e6d0", -117, 100))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("-c2704ab779a96b7087d5c0e71", -99, 100), mp("ee3980d0d53ce279a7a4885f2", -95, 100))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("873e849c2b21c31fd95e5b0c9", -88, 100), mp("9acd573a65219d234abc9eef5", -99, 100))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("-c49a1e5fd4d7b2940eebffdfd", -83, 100), mp("-a8c656dc96559cacbb2cabbbe", -93, 100))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("96fc5456fe1636b7aa10318ab", -66, 100), mp("819d75d78fe6852b75ff5d9ae", -75, 100))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("-8172fb4f0328f78ec358b95c7", -27, 100), mp("-f0c6931a984e787c73987a1dc", -36, 100))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("-b01ac3510b27d4dd28bc1ca70", -105, 100), mp("c992418419f0720e8f6e4e6d0", -117, 100))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("-9dbe708963eefadf84c606fd8", -127, 100), mp("e1b1ccc47fa2bdba70123f416", -137, 100))));
        assert_eq!(z.sage_str(), "-46.517819644479306176730482371 - 0.012999228157715866518750703787*I");
        // p = 200, case 0
        let (z, w) = (Mpc::new(mp("fc30d0b19482450164728a6fcf303a07b28f2df760ae9ca08b", -195, 200), mp("fd6bb6a3de65151c401dd377bf623d8eb7a4ca83b26b52b08d", -203, 200)), Mpc::new(mp("cd97bdd982cdac6046f9903b72f88ece64dd44fd3645114889", -206, 200), mp("93a44f576a9a1de24edab871d5feef16e964ef2ebe2ff36007", -205, 200)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("c96443ecc539f78269bec46211c8834fa3bf0cbea414ab29f5", -201, 200), mp("91d7a800b4f16395598d5eb5fe0c2318702b7483afe9a5c2ff", -200, 200))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("fc4a83a94fb29eb6f07b69a1d69e99198c5bc9a000556542b4", -195, 200), mp("912a653cdc85ce4a69ea40ca1a70fcaa38ff0327b0fba7c447", -202, 200))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("fc171db9d951eb4bd869ab3dc7c1daf5d8c2924ec107d3fe62", -195, 200), mp("d882a2ce03be8da3ac67255b49e281c8fd4b8eb802df55d88b", -203, 200))));
        assert!(z.inv().same_value(&Mpc::new(mp("81ee71e674281233d0bf84045d289be5bb8b7d2551ecf11c2a", -204, 200), mp("-8290af187a10ef2de2f1353f05dc64f3303e87bf086d80cbd2", -212, 200))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("ce35ca99de601fdc5c407a24776c1620ea75240eb0bd3de981", -190, 200), mp("-92da41603833f05de850e4667dd5f800817c7fa8084f67f296", -189, 200))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("f86f294e74c72059e35d9071c2c1c9e5a91e586b740eb3a36f", -190, 200), mp("f9a65a92dc86da538e52a5da58e37a9f348305e9dc081937fd", -197, 200))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("f4baddc2bbe5c39201a8a338f74ce6505cd980ba130cb8f682", -185, 200), mp("b87346d0a8516b9c7280d61532f465e33de4784c4e74b331fd", -191, 200))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("e9ec70c399f68309e9c30a90c305940adb1d61e96d40b391bb", -170, 200), mp("b054830826e771e8e9e2eb3e077c54f75a548619a5965ff17d", -175, 200))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("d26a1f84ebb81c28335f31f7edfa2d2e53ab737c1fb931c8e7", -135, 200), mp("abf1af0a2d1934c6addd04b4fe5fad6d4c2b4461725c24baa4", -139, 200))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("81ee71e674281233d0bf84045d289be5bb8b7d2551ecf11c2a", -204, 200), mp("-8290af187a10ef2de2f1353f05dc64f3303e87bf086d80cbd2", -212, 200))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("89ee868af800a1ff106cea2d02f44f1f4e2f55f2886355fe5f", -224, 200), mp("-ad46e925d7257b9925fb20e2f3dc5a7b94875f86552502153c", -230, 200))));
        assert_eq!(z.sage_str(), "31.523835551590567496588837700632096027496147754369518719403 + 0.12374060332858730968933157942451026442292030686416742842583*I");
        // p = 200, case 1
        let (z, w) = (Mpc::new(mp("-c5027385c9421e7a607108e02236971e1b2577c1ecfd42e044", -197, 200), mp("b51711eb571304145212ca3f7062dc08d64bdbf090d48dd9f3", -197, 200)), Mpc::new(mp("-a0740572419f452c075f27ff085e617f8e99edbce703f8670d", -197, 200), mp("-a02ecdcc0a62d74145ddd4a05422bfb8e0931719fdd5157e9d", -204, 200)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("f8bae11d90fab18d10fb5fc85f7dbaed12d21c711752efa442", -195, 200), mp("-e113e4cee4c3c198a691a18c0da5cf68363fdfbe26f6749b6d", -195, 200))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("-b2bb3c7c0570b1d333e8186f954a7c4ed4dfb2bf6a009da3a8", -196, 200), mp("b3d6b44fbefe3e65cf870e962fba9689648ab5c25cd8e3aef6", -197, 200))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("-9239b84e1e8b6539644783846760d67a322e281417e529e4dc", -199, 200), mp("b6576f86ef27c9c2d49e85e8b10b2188480d021ec4d03804f0", -197, 200))));
        assert!(z.inv().same_value(&Mpc::new(mp("-b44ee437dda48c0e53af80b9c5ad37fa5a478c8c3859de87cc", -203, 200), mp("-a5bcffbd0e0354dc1c9d7eae72923b666ef5205b54605597c0", -203, 200))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("9c06ba8b0a7967904ebaacedf332bd93cd07102aa70b1bd59a", -199, 200), mp("-91ae07258c9a0672016e07d6f925e082aff83919563769e2cc", -199, 200))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("bc1923373a65ec9feef46340e9afad31dbc8827c19e2998a20", -197, 200), mp("-8b5c7cb03e3f3a3f1e6274daa44c0b31baa0f843d2448dec48", -193, 200))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("b311c1cc77167270eafed98b077cbd107631d71e6e9b7472d3", -191, 200), mp("e720da4a4d6202972e32a4f13b6544571af82d9e5740e38e8e", -191, 200))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("-a6d4efd44beb6d4c888fcd8b0a3500952b9b3a8d58a601afeb", -183, 200), mp("a1ac00c8d14f2c7c4f7f701f7dd86a62ee7ab349a1dac65f93", -181, 200))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("dd37cc9c61b2dd40a45b2aa3a442f3489da06303696c0537cc", -160, 200), mp("-d70409bc5f5b1c112804112a0f5277ec4f82920db0b7128a8c", -162, 200))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("-b44ee437dda48c0e53af80b9c5ad37fa5a478c8c3859de87cc", -203, 200), mp("-a5bcffbd0e0354dc1c9d7eae72923b666ef5205b54605597c0", -203, 200))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("ac27cb1d0d579e5d5db2b8851ce880d8fd7e8653e3a64ce4d7", -215, 200), mp("df2171872682a1b33cc3c482d353ef5dfe45efd7dfe54c304c", -216, 200))));
        assert_eq!(z.sage_str(), "-6.1565492260943449041070786466437615909664149279319641369586 + 5.6590661617743483002149030487680133836220847079179801869953*I");
        // p = 200, case 2
        let (z, w) = (Mpc::new(mp("b0b9b338eb3fdf23489c461cb5d15b77f23a775505e88e752f", -204, 200), mp("949a8137e97b862eace1d7300f6361b9f8f33c1a7fafdd8733", -200, 200)), Mpc::new(mp("-bd41536363f6724ba08329c05b09e803191bea85931a953cca", -195, 200), mp("cb7db224cb98b20411e7a28cbdd2df2c206bba8d2141c9886e", -198, 200)));
        assert!(z.mul(&w).same_value(&Mpc::new(mp("-b772945564bbf468ddb2e6cb855cc0d6297e8615b566b3b585", -198, 200), mp("-d98611f6abd24d3ad7e9dbb8b62b5d0e7d0afd0bd77cb70455", -196, 200))));
        assert!(z.add(&w, '+').same_value(&Mpc::new(mp("-bce8f689c780d25c0ededb9d4caeff555d22cd49e897a0f58f", -195, 200), mp("f0a45272c5f7938fbd201858c1abb79a9ea88993c12dc0ea3b", -198, 200))));
        assert!(z.add(&w, '-').same_value(&Mpc::new(mp("bd99b03d006c123b322777e36964d0b0d51507c13d9d898405", -195, 200), mp("-a65711d6d139d07866af2cc0b9fa06bda22eeb868155d226a1", -198, 200))));
        assert!(z.inv().same_value(&Mpc::new(mp("8265a818cc0b61ebdf3c89cd0ceff3dd51fbdb67d656da51c9", -202, 200), mp("-db4b7062546dbb6fbc4667c38e47877d60909982ea6ba25b35", -199, 200))));
        assert!(z.mul(&w.inv()).same_value(&Mpc::new(mp("bdc8bb39a8e35cab2105d13626b9587d2232e3976bfb0aa694", -209, 200), mp("-c76ae00c022fcb786ed581218e45e4ecf93816ecae7cd27275", -205, 200))));
        assert!(z.pow_int(2).same_value(&Mpc::new(mp("-ab9205967757d99a9265cf1d5fdabcacf4a0d916c822bc841e", -201, 200), mp("cd2c090dc943d65764b52812194c63df1c82134875f04244c0", -204, 200))));
        assert!(z.pow_int(3).same_value(&Mpc::new(mp("-b251b586c8723912f14a55b68a1a2c92177ce2ddaa79e47496", -204, 200), mp("-c4f962ee10a33b4e9a58c818c82d8bef36775304279d0c5090", -202, 200))));
        assert!(z.pow_int(6).same_value(&Mpc::new(mp("-8fcb76c5e5e55998be5342960bb005724fabc74377ca717fb9", -204, 200), mp("8934455ddc9b9584aecb0d21682075b57dc5ddb4cab17c8c44", -205, 200))));
        assert!(z.pow_int(13).same_value(&Mpc::new(mp("bdb635261e616c058b9160f973555b64c2513449fade0faf30", -210, 200), mp("838de47d4150b6f4ae5a7c355edf0c0cad8050a9efc4efc2e8", -210, 200))));
        assert!(z.pow_int(-1).same_value(&Mpc::new(mp("8265a818cc0b61ebdf3c89cd0ceff3dd51fbdb67d656da51c9", -202, 200), mp("-db4b7062546dbb6fbc4667c38e47877d60909982ea6ba25b35", -199, 200))));
        assert!(z.pow_int(-5).same_value(&Mpc::new(mp("ad9862e46701a0ea2fd5ffc4ca7c5f88ebb011b8ac7bc6acfa", -197, 200), mp("-df26c1be7a6b06c0f812b2c71cdb080e077a41adf89b339cc7", -196, 200))));
        assert_eq!(z.sage_str(), "0.043145847403778219504774224403923824555347736956962941887994 + 0.58048255553283753780287980242496104296191073573674220432635*I");
    }

    #[test]
    fn complex_printing_as_sage() {
        let c = |a: f64, b: f64| Mpc::new(Mp::from_f64(a, 30), Mp::from_f64(b, 30));
        let (inf, nan) = (f64::INFINITY, f64::NAN);
        for (z, s, l) in [
            (c(1.0, 2.0), "1.0000000 + 2.0000000*I", "1.0000000 + 2.0000000i"),
            (c(1.0, -2.0), "1.0000000 - 2.0000000*I", "1.0000000 - 2.0000000i"),
            (c(0.0, 2.0), "2.0000000*I", "2.0000000i"),
            (c(0.0, -2.0), "-2.0000000*I", "-2.0000000i"),
            (c(2.0, 0.0), "2.0000000", "2.0000000"),
            (c(0.0, 0.0), "0.00000000", "0.00000000"),
            (c(-0.0, 0.0), "-0.00000000", "-0.00000000"),
            (c(1e-10, 3e20), "1.0000000e-10 + 3.0000000e20*I", "1.0000000 \\times 10^{-10} + 3.0000000 \\times 10^{20}i"),
            (c(nan, 1.0), "NaN + 1.0000000*I", "NaN + 1.0000000i"),
            (c(inf, -inf), "+infinity - +infinity*I", "+\\infty - +\\inftyi"),
            (c(0.0, nan), "NaN*I", "NaNi"),
        ] {
            assert_eq!(z.sage_str(), s);
            assert_eq!(z.latex(), l);
        }
        // the wire form both ways
        for z in [c(1.0, -2.0), c(-0.0, nan), c(inf, 0.5)] {
            let w = Mpc::from_wire(&z.wire()).unwrap();
            assert!(w.same_value(&z) && w.prec() == 30);
        }
        assert!(Mpc::from_wire("30:1p0|31:1p0").is_none());
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
        // just below 2^-1022 the double has 52 bits, so the value rounds once, to them: 2^-1023 (1 + 2^-52 + 2^-90)
        // is 2^-1023 (1 + 2^-51), not the 53-bit 2^-1023 (1 + 2^-52) rounded again by ldexp to 2^-1023
        let m = (BigInt::one() << 90usize) + (BigInt::one() << 38usize) + BigInt::one();
        assert_eq!(Mp::fin(&m, -1113, 100).to_f64().to_bits(), (1u64 << 51) + 1);
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
