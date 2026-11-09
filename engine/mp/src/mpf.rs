//! mpmath's raw floating-point numbers and their arithmetic, ported from
//! mpmath 1.3.0's pure-Python reference (mpmath/libmp/libmpf.py, BSD-3-Clause,
//! Copyright (c) 2005-2021 Fredrik Johansson and mpmath contributors), which
//! is their specification: every function returns exactly the raw tuple
//! (sign, man, exp, bc) the reference returns for the same arguments, special
//! values and rounding included.  Statement for statement where the reference
//! branches, so that the two can be read side by side.

use crate::nat::Nat;
use crate::Fail;
use core::cmp::Ordering;

/// A raw mpf: (-1)^sign * man * 2^exp with man's bit count bc; the special
/// values have man 0 and the reference's marker exponents and counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mpf {
    pub sign: u32,
    pub man: Nat,
    pub exp: i64,
    pub bc: i64,
}

/// The rounding modes: the reference's 'n', 'f', 'c', 'd', 'u'.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rnd {
    Nearest,
    Floor,
    Ceiling,
    Down,
    Up,
}

impl Rnd {
    pub fn from_code(c: u32) -> Option<Rnd> {
        Some(match c {
            0 => Rnd::Nearest,
            1 => Rnd::Floor,
            2 => Rnd::Ceiling,
            3 => Rnd::Down,
            4 => Rnd::Up,
            _ => return None,
        })
    }

    /// shifts_down[rnd][sign]: truncate (true) or round away from zero.
    fn shifts_down(self, sign: u32) -> bool {
        match self {
            Rnd::Floor => sign == 0,
            Rnd::Ceiling => sign == 1,
            Rnd::Down => true,
            Rnd::Up | Rnd::Nearest => false,
        }
    }
}

fn special(sign: u32, exp: i64, bc: i64) -> Mpf {
    Mpf { sign, man: Nat::zero(), exp, bc }
}

pub fn fzero() -> Mpf {
    special(0, 0, 0)
}
pub fn fnan() -> Mpf {
    special(0, -123, -1)
}
pub fn finf() -> Mpf {
    special(0, -456, -2)
}
pub fn fninf() -> Mpf {
    special(1, -789, -3)
}

fn add_exp(e: i64, n: i64) -> Result<i64, Fail> {
    e.checked_add(n).ok_or(Fail::Exponent)
}

impl Mpf {
    pub fn is_finf(&self) -> bool {
        self.man.is_zero() && self.sign == 0 && self.exp == -456 && self.bc == -2
    }
    pub fn is_fninf(&self) -> bool {
        self.man.is_zero() && self.sign == 1 && self.exp == -789 && self.bc == -3
    }
    pub fn is_fnan(&self) -> bool {
        self.man.is_zero() && self.sign == 0 && self.exp == -123 && self.bc == -1
    }
    pub fn is_fzero(&self) -> bool {
        self.man.is_zero() && self.sign == 0 && self.exp == 0 && self.bc == 0
    }
}

/// The reference's {1: finf, -1: fninf}[sign]: a sign of 0 (a negative zero
/// or nan met an infinity) is its KeyError.
fn inf_of_sign(sign: i32) -> Result<Mpf, Fail> {
    match sign {
        1 => Ok(finf()),
        -1 => Ok(fninf()),
        _ => Err(Fail::KeyError),
    }
}

/// mpf_sign: -1, 0 or 1 (nan gives 0).
pub fn mpf_sign(s: &Mpf) -> i32 {
    if s.man.is_zero() {
        if s.is_finf() {
            return 1;
        }
        if s.is_fninf() {
            return -1;
        }
        return 0;
    }
    if s.sign == 1 {
        -1
    } else {
        1
    }
}

pub fn mpf_neg(s: &Mpf) -> Mpf {
    if s.man.is_zero() {
        if s.exp != 0 {
            if s.is_finf() {
                return fninf();
            }
            if s.is_fninf() {
                return finf();
            }
        }
        return s.clone();
    }
    Mpf { sign: 1 - s.sign, man: s.man.clone(), exp: s.exp, bc: s.bc }
}

/// The rounding step shared by _normalize and _normalize1: man (bc bits by
/// the caller's count) cut to prec bits, n = bc - prec > 0.
fn round_off(sign: u32, man: &Nat, n: u64, rnd: Rnd) -> Result<Nat, Fail> {
    if rnd == Rnd::Nearest {
        let t = man.shr(n - 1)?;
        if t.bit(0) && (t.bit(1) || man.low_nonzero(n - 1)) {
            t.shr(1)?.add_u64(1)
        } else {
            t.shr(1)
        }
    } else if rnd.shifts_down(sign) {
        man.shr(n)
    } else {
        // -((-man) >> n): the ceiling
        let away = man.low_nonzero(n);
        let q = man.shr(n)?;
        if away {
            q.add_u64(1)
        } else {
            Ok(q)
        }
    }
}

/// Strip trailing zero bits (bc counted down with them), then the
/// power-of-two fix: a mantissa of 1 has bc 1.
fn strip(sign: u32, man: Nat, exp: i64, bc: i64) -> Result<Mpf, Fail> {
    let (mut man, mut exp, mut bc) = (man, exp, bc);
    if !man.is_odd() {
        let t = man.trailing_zeros();
        man = man.shr(t)?;
        exp = add_exp(exp, t as i64)?;
        bc -= t as i64;
    }
    if man.to_u64() == Some(1) {
        bc = 1;
    }
    Ok(Mpf { sign, man, exp, bc })
}

/// _normalize: the reference's conditions on the input (a regular number,
/// man > 0 or 0, bc exact) are the caller's.
pub fn normalize(sign: u32, man: Nat, exp: i64, bc: i64, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if man.is_zero() {
        return Ok(fzero());
    }
    let (mut man, mut exp, mut bc) = (man, exp, bc);
    let n = bc - prec as i64;
    if n > 0 {
        man = round_off(sign, &man, n as u64, rnd)?;
        exp = add_exp(exp, n)?;
        bc = prec as i64;
    }
    strip(sign, man, exp, bc)
}

/// _normalize1: as normalize, for a man that is odd or zero; when it already
/// fits it is returned untouched.
pub fn normalize1(sign: u32, man: Nat, exp: i64, bc: i64, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if man.is_zero() {
        return Ok(fzero());
    }
    if bc <= prec as i64 {
        return Ok(Mpf { sign, man, exp, bc });
    }
    let n = bc - prec as i64;
    let man = round_off(sign, &man, n as u64, rnd)?;
    let exp = add_exp(exp, n)?;
    strip(sign, man, exp, prec as i64)
}

/// from_man_exp: the mantissa given as sign and magnitude; prec 0 is exact.
pub fn from_man_exp(sign: u32, man: Nat, exp: i64, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    let sign = if man.is_zero() { 0 } else { sign };
    let bc = man.bits() as i64;
    if prec == 0 {
        if man.is_zero() {
            return Ok(fzero());
        }
        return strip(sign, man, exp, bc);
    }
    normalize(sign, man, exp, bc, prec, rnd)
}

/// A - B for magnitudes a and b, with the sign `asign` when a > b and the
/// other when a < b (the reference's subtraction branches).
fn sub_mag(a: &Nat, b: &Nat, asign: u32) -> Result<(u32, Nat), Fail> {
    Ok(match a.cmp_mag(b) {
        Ordering::Greater => (asign, a.sub(b)?),
        Ordering::Less => (1 - asign, b.sub(a)?),
        Ordering::Equal => (0, Nat::zero()),
    })
}

/// mpf_add (sub = true: mpf_sub); prec 0 adds exactly.
pub fn mpf_add(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd, sub: bool) -> Result<Mpf, Fail> {
    let (ssign, sman, sexp, sbc) = (s.sign, &s.man, s.exp, s.bc);
    let (tman, texp, tbc) = (&t.man, t.exp, t.bc);
    let tsign = t.sign ^ sub as u32;
    if !sman.is_zero() && !tman.is_zero() {
        let offset = sexp.checked_sub(texp).ok_or(Fail::Exponent)?;
        if offset > 0 {
            if offset > 100 && prec != 0 {
                let delta = sbc + sexp - tbc - texp;
                if delta > prec as i64 + 4 {
                    let off = prec + 4;
                    let m = sman.shl(off)?;
                    let m = if tsign == ssign { m.add_u64(1)? } else { m.sub_u64(1)? };
                    let bc = m.bits() as i64;
                    return normalize1(ssign, m, add_exp(sexp, -(off as i64))?, bc, prec, rnd);
                }
            }
            let a = sman.shl(offset as u64)?;
            let (sg, man) = if ssign == tsign { (ssign, tman.add(&a)?) } else { sub_mag(&a, tman, ssign)? };
            let bc = man.bits() as i64;
            return normalize1(sg, man, texp, bc, if prec != 0 { prec } else { bc as u64 }, rnd);
        } else if offset < 0 {
            if offset < -100 && prec != 0 {
                let delta = tbc + texp - sbc - sexp;
                if delta > prec as i64 + 4 {
                    let off = prec + 4;
                    let m = tman.shl(off)?;
                    let m = if ssign == tsign { m.add_u64(1)? } else { m.sub_u64(1)? };
                    let bc = m.bits() as i64;
                    return normalize1(tsign, m, add_exp(texp, -(off as i64))?, bc, prec, rnd);
                }
            }
            let a = tman.shl(offset.unsigned_abs())?;
            let (sg, man) = if ssign == tsign { (ssign, sman.add(&a)?) } else { sub_mag(&a, sman, tsign)? };
            let bc = man.bits() as i64;
            return normalize1(sg, man, sexp, bc, if prec != 0 { prec } else { bc as u64 }, rnd);
        }
        let (sg, man) = if ssign == tsign { (ssign, tman.add(sman)?) } else { sub_mag(sman, tman, ssign)? };
        let bc = man.bits() as i64;
        return normalize(sg, man, texp, bc, if prec != 0 { prec } else { bc as u64 }, rnd);
    }
    // zeros and special values
    let t = if sub { mpf_neg(t) } else { t.clone() };
    if sman.is_zero() {
        if sexp != 0 {
            if *s == t || !t.man.is_zero() || t.exp == 0 {
                return Ok(s.clone());
            }
            return Ok(fnan());
        }
        if !t.man.is_zero() {
            let p = if prec != 0 { prec } else { t.bc as u64 };
            return normalize1(t.sign, t.man.clone(), t.exp, t.bc, p, rnd);
        }
        return Ok(t);
    }
    if t.exp != 0 {
        return Ok(t);
    }
    if !sman.is_zero() {
        let p = if prec != 0 { prec } else { sbc as u64 };
        return normalize1(ssign, sman.clone(), sexp, sbc, p, rnd);
    }
    Ok(s.clone())
}

/// python_mpf_mul; prec 0 multiplies exactly (unnormalized, as the reference).
pub fn mpf_mul(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    let sign = s.sign ^ t.sign;
    let man = s.man.mul(&t.man)?;
    if !man.is_zero() {
        let mut bc = s.bc + t.bc - 1;
        // bc += int(man >> bc), literally (1 when the product has one more
        // bit, 0 when not, for exact operand counts)
        if bc >= 0 {
            let top = man.shr(bc as u64)?;
            bc += top.to_u64().and_then(|x| i64::try_from(x).ok()).ok_or(Fail::Exponent)?;
        }
        let exp = add_exp(s.exp, t.exp)?;
        if prec != 0 {
            return normalize1(sign, man, exp, bc, prec, rnd);
        }
        return Ok(Mpf { sign, man, exp, bc });
    }
    let s_special = s.man.is_zero() && s.exp != 0;
    let t_special = t.man.is_zero() && t.exp != 0;
    if !s_special && !t_special {
        return Ok(fzero());
    }
    if s.is_fnan() || t.is_fnan() {
        return Ok(fnan());
    }
    let (s, t) = if t.man.is_zero() && t.exp != 0 { (t, s) } else { (s, t) };
    if t.is_fzero() {
        return Ok(fnan());
    }
    inf_of_sign(mpf_sign(s) * mpf_sign(t))
}

/// mpf_div.
pub fn mpf_div(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if s.man.is_zero() || t.man.is_zero() {
        if s.is_fzero() {
            if t.is_fzero() {
                return Err(Fail::ZeroDivision);
            }
            if t.is_fnan() {
                return Ok(fnan());
            }
            return Ok(fzero());
        }
        if t.is_fzero() {
            return Err(Fail::ZeroDivision);
        }
        let s_special = s.man.is_zero() && s.exp != 0;
        let t_special = t.man.is_zero() && t.exp != 0;
        if s_special && t_special {
            return Ok(fnan());
        }
        if s.is_fnan() || t.is_fnan() {
            return Ok(fnan());
        }
        if !t_special {
            if t.is_fzero() {
                return Ok(fnan());
            }
            return inf_of_sign(mpf_sign(s) * mpf_sign(t));
        }
        return Ok(fzero());
    }
    let sign = s.sign ^ t.sign;
    let exp = s.exp.checked_sub(t.exp).ok_or(Fail::Exponent)?;
    if t.man.to_u64() == Some(1) {
        return normalize1(sign, s.man.clone(), exp, s.bc, prec, rnd);
    }
    let mut extra = prec as i64 - s.bc + t.bc + 5;
    if extra < 5 {
        extra = 5;
    }
    let (quot, rem) = s.man.shl(extra as u64)?.divmod(&t.man)?;
    if !rem.is_zero() {
        let quot = quot.shl(1)?.add_u64(1)?;
        extra += 1;
        let bc = quot.bits() as i64;
        return normalize1(sign, quot, add_exp(exp, -extra)?, bc, prec, rnd);
    }
    let bc = quot.bits() as i64;
    normalize(sign, quot, add_exp(exp, -extra)?, bc, prec, rnd)
}

/// mpf_sqrt: correctly rounded; a negative argument is the reference's
/// ComplexResult.
pub fn mpf_sqrt(s: &Mpf, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if s.sign == 1 {
        return Err(Fail::ComplexResult);
    }
    if s.man.is_zero() {
        return Ok(s.clone());
    }
    let (mut man, mut exp, mut bc) = (s.man.clone(), s.exp, s.bc);
    if exp & 1 != 0 {
        exp -= 1;
        man = man.shl(1)?;
        bc += 1;
    } else if man.to_u64() == Some(1) {
        return normalize1(0, man, exp.div_euclid(2), bc, prec, rnd);
    }
    let mut shift = (2 * prec as i64 - bc + 4).max(4);
    shift += shift & 1;
    let root = if matches!(rnd, Rnd::Floor | Rnd::Down) {
        man.shl(shift as u64)?.sqrtrem()?.0
    } else {
        let (r, rem) = man.shl(shift as u64)?.sqrtrem()?;
        if !rem.is_zero() {
            shift += 2;
            r.shl(1)?.add_u64(1)?
        } else {
            r
        }
    };
    from_man_exp(0, root, (exp - shift).div_euclid(2), prec, rnd)
}

impl Rnd {
    /// reciprocal_rnd: the direction that rounds a reciprocal's input.
    pub fn reciprocal(self) -> Rnd {
        match self {
            Rnd::Down => Rnd::Up,
            Rnd::Up => Rnd::Down,
            Rnd::Floor => Rnd::Ceiling,
            Rnd::Ceiling => Rnd::Floor,
            Rnd::Nearest => Rnd::Nearest,
        }
    }
}

pub fn fone() -> Mpf {
    Mpf { sign: 0, man: Nat::from_u64(1), exp: 0, bc: 1 }
}

/// mpf_pos: s rounded to prec (prec 0: s itself).
pub fn mpf_pos(s: &Mpf, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if prec != 0 {
        if s.man.is_zero() && s.exp != 0 {
            return Ok(s.clone());
        }
        return normalize1(s.sign, s.man.clone(), s.exp, s.bc, prec, rnd);
    }
    Ok(s.clone())
}

/// from_int: sign and magnitude; prec 0 is exact (int_cache holds exactly
/// what from_man_exp gives, so it needs no port of its own).
pub fn from_int(sign: u32, n: Nat, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    from_man_exp(sign, n, 0, prec, rnd)
}

fn mul_exp(e: i64, n: i64) -> Result<i64, Fail> {
    e.checked_mul(n).ok_or(Fail::Exponent)
}

/// python_mpf_mul_int: s times the integer (-1)^nsign * n.
pub fn mpf_mul_int(s: &Mpf, nsign: u32, n: &Nat, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if s.man.is_zero() {
        return mpf_mul(s, &from_int(nsign, n.clone(), 0, rnd)?, prec, rnd);
    }
    if n.is_zero() {
        return Ok(fzero());
    }
    let sign = s.sign ^ nsign;
    let man = s.man.mul(n)?;
    let mut bc = s.bc + n.bits() as i64 - 1;
    let top = man.shr(bc.max(0) as u64)?;
    bc += top.to_u64().and_then(|x| i64::try_from(x).ok()).ok_or(Fail::Exponent)?;
    normalize(sign, man, s.exp, bc, prec, rnd)
}

/// The bctable lookups in the binary powering loops: the bit count of a
/// small integer (the reference indexes a 1024-entry table).
fn small_bits(x: &Nat) -> Result<i64, Fail> {
    match x.to_u64() {
        Some(v) if v < 1024 => Ok(64 - v.leading_zeros() as i64),
        _ => Err(Fail::Exponent),
    }
}

/// mpf_pow_int: s^n for an integer n (the glue keeps n within i64).
pub fn mpf_pow_int(s: &Mpf, n: i64, prec: u64, rnd: Rnd) -> Result<Mpf, Fail> {
    if s.man.is_zero() && s.exp != 0 {
        if s.is_finf() {
            if n > 0 {
                return Ok(s.clone());
            }
            if n == 0 {
                return Ok(fnan());
            }
            return Ok(fzero());
        }
        if s.is_fninf() {
            if n > 0 {
                return Ok(if n & 1 == 1 { fninf() } else { finf() });
            }
            if n == 0 {
                return Ok(fnan());
            }
            return Ok(fzero());
        }
        return Ok(fnan());
    }
    if n == 0 {
        return Ok(fone());
    }
    if n == 1 {
        return mpf_pos(s, prec, rnd);
    }
    if n == 2 {
        if s.man.is_zero() {
            return Ok(fzero());
        }
        let man = s.man.mul(&s.man)?;
        let exp = add_exp(s.exp, s.exp)?;
        if man.to_u64() == Some(1) {
            return Ok(Mpf { sign: 0, man, exp, bc: 1 });
        }
        let mut bc = s.bc + s.bc - 2;
        bc += small_bits(&man.shr(bc as u64)?)?;
        return normalize1(0, man, exp, bc, prec, rnd);
    }
    if n == -1 {
        return mpf_div(&fone(), s, prec, rnd);
    }
    if n < 0 {
        let inverse = mpf_pow_int(s, n.checked_neg().ok_or(Fail::Exponent)?, prec + 5, rnd.reciprocal())?;
        return mpf_div(&fone(), &inverse, prec, rnd);
    }
    let result_sign = s.sign & (n & 1) as u32;
    if s.man.to_u64() == Some(1) {
        return Ok(Mpf { sign: result_sign, man: Nat::from_u64(1), exp: mul_exp(s.exp, n)?, bc: 1 });
    }
    if s.bc.saturating_mul(n) < 1000 {
        let mut man = Nat::from_u64(1);
        for _ in 0..n {
            man = man.mul(&s.man)?;
        }
        let bc = man.bits() as i64;
        return normalize1(result_sign, man, mul_exp(s.exp, n)?, bc, prec, rnd);
    }
    let rounds_down = rnd == Rnd::Nearest || rnd.shifts_down(result_sign);
    let nbits = 64 - (n as u64).leading_zeros() as u64;
    let workprec = (prec + 4 * nbits + 4) as i64;
    let cut = |x: &Nat, k: u64| -> Result<Nat, Fail> {
        if rounds_down {
            x.shr(k)
        } else {
            let away = x.low_nonzero(k);
            let q = x.shr(k)?;
            if away {
                q.add_u64(1)
            } else {
                Ok(q)
            }
        }
    };
    let (mut man, mut exp, mut bc) = (s.man.clone(), s.exp, s.bc);
    let (mut pm, mut pe, mut pbc) = (Nat::from_u64(1), 0i64, 1i64);
    let mut n = n;
    loop {
        if n & 1 == 1 {
            pm = pm.mul(&man)?;
            pe = add_exp(pe, exp)?;
            pbc += bc - 2;
            pbc += small_bits(&pm.shr(pbc as u64)?)?;
            if pbc > workprec {
                pm = cut(&pm, (pbc - workprec) as u64)?;
                pe = add_exp(pe, pbc - workprec)?;
                pbc = workprec;
            }
            n -= 1;
            if n == 0 {
                break;
            }
        }
        man = man.mul(&man)?;
        exp = add_exp(exp, exp)?;
        bc = bc + bc - 2;
        bc += small_bits(&man.shr(bc as u64)?)?;
        if bc > workprec {
            man = cut(&man, (bc - workprec) as u64)?;
            exp = add_exp(exp, bc - workprec)?;
            bc = workprec;
        }
        n /= 2;
    }
    normalize(result_sign, pm, pe, pbc, prec, rnd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(sign: u32, man: u64, exp: i64) -> Mpf {
        from_man_exp(sign, Nat::from_u64(man), exp, 0, Rnd::Nearest).unwrap()
    }

    #[test]
    fn a_few_values_as_the_reference_gives_them() {
        // mpf_add(from_man_exp(1,0), from_man_exp(2,0), 53, 'n') == (0, 3, 0, 2)
        let r = mpf_add(&f(0, 1, 0), &f(0, 2, 0), 53, Rnd::Nearest, false).unwrap();
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(3), 0, 2));
        // 1/3 at 53 bits: (0, 6004799503160661, -54, 53)
        let r = mpf_div(&f(0, 1, 0), &f(0, 3, 0), 53, Rnd::Nearest).unwrap();
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(6004799503160661), -54, 53));
        // sqrt(2) at 53 bits: (0, 6369051672525773, -52, 53)
        let r = mpf_sqrt(&f(0, 1, 1), 53, Rnd::Nearest).unwrap();
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(6369051672525773), -52, 53));
        assert!(matches!(mpf_div(&fzero(), &fzero(), 53, Rnd::Nearest), Err(Fail::ZeroDivision)));
        assert!(mpf_add(&finf(), &fninf(), 53, Rnd::Nearest, false).unwrap().is_fnan());
        assert!(mpf_mul(&finf(), &fzero(), 53, Rnd::Nearest).unwrap().is_fnan());
    }
}
