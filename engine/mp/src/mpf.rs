//! mpmath's raw floating-point numbers and their arithmetic, ported from
//! mpmath 1.3.0's pure-Python reference (mpmath/libmp/libmpf.py, BSD-3-Clause,
//! Copyright (c) 2005-2021 Fredrik Johansson and mpmath contributors), which
//! is their specification: every function returns exactly the raw tuple (sign,
//! man, exp, bc) the reference returns for the same arguments, special values
//! and rounding included. The exceptions are reviewed fixes of upstream bugs,
//! each marked where it is made: mpf_div at precision 0 follows mpmath 1.4.1,
//! except that a power-of-two divisor at precision 0 gives the exact quotient,
//! which 1.4.1 doesn't.  Statement for statement where the reference branches,
//! so that the two can be read side by side.

use crate::fail::{raise, too_big};
use crate::exp::Exp;
use crate::int::Int;
use crate::nat::Nat;
use crate::Fail;
use core::cmp::Ordering;

/// A raw mpf: (-1)^sign * man * 2^exp with man's bit count bc; the special
/// values have man 0 and the reference's marker exponents and counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mpf {
    pub sign: u32,
    pub man: Nat,
    pub exp: Exp,
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
    pub(crate) fn shifts_down(self, sign: u32) -> bool {
        match self {
            Rnd::Floor => sign == 0,
            Rnd::Ceiling => sign == 1,
            Rnd::Down => true,
            Rnd::Up | Rnd::Nearest => false,
        }
    }
}

fn special(sign: u32, exp: i64, bc: i64) -> Mpf {
    Mpf { sign, man: Nat::zero(), exp: Exp::S(exp), bc }
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

fn add_exp(e: &Exp, n: i64) -> Exp {
    e.add_i64(n)
}

impl Mpf {
    pub fn is_finf(&self) -> bool {
        self.man.is_zero() && self.sign == 0 && self.exp == Exp::S(-456) && self.bc == -2
    }
    pub fn is_fninf(&self) -> bool {
        self.man.is_zero() && self.sign == 1 && self.exp == Exp::S(-789) && self.bc == -3
    }
    pub fn is_fnan(&self) -> bool {
        self.man.is_zero() && self.sign == 0 && self.exp == Exp::S(-123) && self.bc == -1
    }
    pub fn is_fzero(&self) -> bool {
        self.man.is_zero() && self.sign == 0 && self.exp == Exp::S(0) && self.bc == 0
    }
}

/// The reference's {1: finf, -1: fninf}[sign]: a sign of 0 (a negative zero
/// or nan met an infinity) is its KeyError.
fn inf_of_sign(sign: i32) -> Mpf {
    match sign {
        1 => finf(),
        -1 => fninf(),
        _ => {
            raise(Fail::KeyError);
            fnan()
        }
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
        if !s.exp.is_zero() {
            if s.is_finf() {
                return fninf();
            }
            if s.is_fninf() {
                return finf();
            }
        }
        return s.clone();
    }
    Mpf { sign: 1 - s.sign, man: s.man.clone(), exp: s.exp.clone(), bc: s.bc }
}

/// The rounding step shared by _normalize and _normalize1: man (bc bits by
/// the caller's count) cut to prec bits, n = bc - prec > 0.
fn round_off(sign: u32, man: &Nat, n: u64, rnd: Rnd) -> Nat {
    if rnd == Rnd::Nearest {
        let t = man.shr(n - 1);
        if t.bit(0) && (t.bit(1) || man.low_nonzero(n - 1)) {
            t.shr(1).add_u64(1)
        } else {
            t.shr(1)
        }
    } else if rnd.shifts_down(sign) {
        man.shr(n)
    } else {
        // -((-man) >> n): the ceiling
        let away = man.low_nonzero(n);
        let q = man.shr(n);
        if away {
            q.add_u64(1)
        } else {
            q
        }
    }
}

/// Strip trailing zero bits (bc counted down with them), then the
/// power-of-two fix: a mantissa of 1 has bc 1.
fn strip(sign: u32, man: Nat, exp: Exp, bc: i64) -> Mpf {
    // (a mantissa rounded to nothing, only at precision 0: the reference's strip never ends there, `while not
    // man & 255`, so no result is its; zero is the rounding's, never a tuple with man 0 and bc 0)
    if man.is_zero() {
        return fzero();
    }
    let (mut man, mut exp, mut bc) = (man, exp, bc);
    if !man.is_odd() {
        let t = man.trailing_zeros();
        man = man.shr(t);
        exp = add_exp(&exp, t as i64);
        bc -= t as i64;
    }
    if man.to_u64() == Some(1) {
        bc = 1;
    }
    Mpf { sign, man, exp, bc }
}

/// _normalize: the reference's conditions on the input (a regular number,
/// man > 0 or 0, bc exact) are the caller's.
pub fn normalize(sign: u32, man: Nat, exp: Exp, bc: i64, prec: u64, rnd: Rnd) -> Mpf {
    if man.is_zero() {
        return fzero();
    }
    let (mut man, mut exp, mut bc) = (man, exp, bc);
    let n = bc - prec as i64;
    if n > 0 {
        man = round_off(sign, &man, n as u64, rnd);
        exp = add_exp(&exp, n);
        bc = prec as i64;
    }
    strip(sign, man, exp, bc)
}

/// _normalize1: as normalize, for a man that is odd or zero; when it already
/// fits it is returned untouched.
pub fn normalize1(sign: u32, man: Nat, exp: Exp, bc: i64, prec: u64, rnd: Rnd) -> Mpf {
    if man.is_zero() {
        return fzero();
    }
    if bc <= prec as i64 {
        return Mpf { sign, man, exp, bc };
    }
    let n = bc - prec as i64;
    let man = round_off(sign, &man, n as u64, rnd);
    let exp = add_exp(&exp, n);
    strip(sign, man, exp, prec as i64)
}

/// from_man_exp: the mantissa given as sign and magnitude; prec 0 is exact.
pub fn from_man_exp(sign: u32, man: Nat, exp: Exp, prec: u64, rnd: Rnd) -> Mpf {
    let sign = if man.is_zero() { 0 } else { sign };
    let bc = man.bits() as i64;
    if prec == 0 {
        if man.is_zero() {
            return fzero();
        }
        return strip(sign, man, exp, bc);
    }
    normalize(sign, man, exp, bc, prec, rnd)
}

/// A - B for magnitudes a and b, with the sign `asign` when a > b and the
/// other when a < b (the reference's subtraction branches).
fn sub_mag(a: &Nat, b: &Nat, asign: u32) -> (u32, Nat) {
    match a.cmp_mag(b) {
        Ordering::Greater => (asign, a.sub(b)),
        Ordering::Less => (1 - asign, b.sub(a)),
        Ordering::Equal => (0, Nat::zero()),
    }
}

fn is_special(s: &Mpf) -> bool {
    s.man.is_zero() && !s.exp.is_zero()
}

/// mpf_add (sub = true: mpf_sub); prec 0 adds exactly.
pub fn mpf_add(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd, sub: bool) -> Mpf {
    let (ssign, sman, sexp, sbc) = (s.sign, &s.man, &s.exp, s.bc);
    let (tman, texp, tbc) = (&t.man, &t.exp, t.bc);
    let tsign = t.sign ^ sub as u32;
    if !sman.is_zero() && !tman.is_zero() {
        let offset = sexp.sub(texp);
        if offset.gt_i64(0) {
            if offset.gt_i64(100) && prec != 0 {
                // delta = sbc + sexp - tbc - texp
                let delta = offset.add_i64(sbc - tbc);
                if delta.gt_i64(prec as i64 + 4) {
                    let off = prec + 4;
                    let m = sman.shl(off);
                    let m = if tsign == ssign { m.add_u64(1) } else { m.sub_u64(1) };
                    let bc = m.bits() as i64;
                    return normalize1(ssign, m, add_exp(sexp, -(off as i64)), bc, prec, rnd);
                }
            }
            let a = sman.shl(offset.as_shift());
            let (sg, man) = if ssign == tsign { (ssign, tman.add(&a)) } else { sub_mag(&a, tman, ssign) };
            let bc = man.bits() as i64;
            return normalize1(sg, man, texp.clone(), bc, if prec != 0 { prec } else { bc as u64 }, rnd);
        } else if offset.lt_i64(0) {
            let noff = offset.neg();
            if noff.gt_i64(100) && prec != 0 {
                // delta = tbc + texp - sbc - sexp
                let delta = noff.add_i64(tbc - sbc);
                if delta.gt_i64(prec as i64 + 4) {
                    let off = prec + 4;
                    let m = tman.shl(off);
                    let m = if ssign == tsign { m.add_u64(1) } else { m.sub_u64(1) };
                    let bc = m.bits() as i64;
                    return normalize1(tsign, m, add_exp(texp, -(off as i64)), bc, prec, rnd);
                }
            }
            let a = tman.shl(noff.as_shift());
            let (sg, man) = if ssign == tsign { (ssign, sman.add(&a)) } else { sub_mag(&a, sman, tsign) };
            let bc = man.bits() as i64;
            return normalize1(sg, man, sexp.clone(), bc, if prec != 0 { prec } else { bc as u64 }, rnd);
        }
        let (sg, man) = if ssign == tsign { (ssign, tman.add(sman)) } else { sub_mag(sman, tman, ssign) };
        let bc = man.bits() as i64;
        return normalize(sg, man, texp.clone(), bc, if prec != 0 { prec } else { bc as u64 }, rnd);
    }
    // zeros and special values
    let t = if sub { mpf_neg(t) } else { t.clone() };
    if sman.is_zero() {
        if !sexp.is_zero() {
            if *s == t || !t.man.is_zero() || t.exp.is_zero() {
                return s.clone();
            }
            return fnan();
        }
        if !t.man.is_zero() {
            let p = if prec != 0 { prec } else { t.bc as u64 };
            return normalize1(t.sign, t.man.clone(), t.exp.clone(), t.bc, p, rnd);
        }
        return t;
    }
    if !t.exp.is_zero() {
        return t;
    }
    if !sman.is_zero() {
        let p = if prec != 0 { prec } else { sbc as u64 };
        return normalize1(ssign, sman.clone(), sexp.clone(), sbc, p, rnd);
    }
    s.clone()
}

/// python_mpf_mul; prec 0 multiplies exactly (unnormalized, as the reference).
pub fn mpf_mul(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    let sign = s.sign ^ t.sign;
    let man = s.man.mul(&t.man);
    if !man.is_zero() {
        let mut bc = s.bc + t.bc - 1;
        // bc += int(man >> bc), literally (1 when the product has one more
        // bit, 0 when not, for exact operand counts)
        if bc >= 0 {
            let top = man.shr(bc as u64);
            bc += top.to_u64().and_then(|x| i64::try_from(x).ok()).unwrap_or_else(|| {
                too_big();
                0
            });
        }
        let exp = s.exp.add(&t.exp);
        if prec != 0 {
            return normalize1(sign, man, exp, bc, prec, rnd);
        }
        return Mpf { sign, man, exp, bc };
    }
    let s_special = is_special(s);
    let t_special = is_special(t);
    if !s_special && !t_special {
        return fzero();
    }
    if s.is_fnan() || t.is_fnan() {
        return fnan();
    }
    let (s, t) = if is_special(t) { (t, s) } else { (s, t) };
    if t.is_fzero() {
        return fnan();
    }
    inf_of_sign(mpf_sign(s) * mpf_sign(t))
}

/// mpf_div.
pub fn mpf_div(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    if s.man.is_zero() || t.man.is_zero() {
        if s.is_fzero() {
            if t.is_fzero() {
                raise(Fail::ZeroDivision);
                return fnan();
            }
            if t.is_fnan() {
                return fnan();
            }
            return fzero();
        }
        if t.is_fzero() {
            raise(Fail::ZeroDivision);
            return fnan();
        }
        let s_special = is_special(s);
        let t_special = is_special(t);
        if s_special && t_special {
            return fnan();
        }
        if s.is_fnan() || t.is_fnan() {
            return fnan();
        }
        if !t_special {
            if t.is_fzero() {
                return fnan();
            }
            return inf_of_sign(mpf_sign(s) * mpf_sign(t));
        }
        return fzero();
    }
    let sign = s.sign ^ t.sign;
    let exp = s.exp.sub(&t.exp);
    if t.man.to_u64() == Some(1) {
        // a power-of-two divisor only moves the exponent, so at prec 0 the
        // quotient keeps the dividend's own bits and is exact. This goes past
        // mpmath 1.4.1, whose branch rounds to prec 0 here. In the cases tried,
        // round_nearest gave one bit (3/4, 3/1, 5/2), and round_floor and
        // round_down (3/4, 1/2, 3/1, 5/2), and 1/2 with round_nearest, didn't
        // return within 5 s (reported upstream: mpmath issue 1225)
        let p = if prec == 0 { s.bc as u64 } else { prec };
        return normalize1(sign, s.man.clone(), exp, s.bc, p, rnd);
    }
    // (mpmath 1.4.1: at prec 0 the quotient keeps max(sbc, tbc) + 5 bits
    // past the operands' ratio and is rounded to its own bit count, the
    // sticky bit included; 1.3.0's prec 0 rounded it to one bit, or, with
    // round_floor, its pure-Python backend didn't return)
    let mut extra = if prec == 0 { s.bc.max(t.bc) - s.bc + t.bc + 5 } else { prec as i64 - s.bc + t.bc + 5 };
    if extra < 5 {
        extra = 5;
    }
    let (quot, rem) = s.man.shl(extra as u64).divmod(&t.man);
    if !rem.is_zero() {
        let quot = quot.shl(1).add_u64(1);
        extra += 1;
        let bc = quot.bits() as i64;
        let p = if prec == 0 { bc as u64 } else { prec };
        return normalize1(sign, quot, add_exp(&exp, -extra), bc, p, rnd);
    }
    let bc = quot.bits() as i64;
    let p = if prec == 0 { bc as u64 } else { prec };
    normalize(sign, quot, add_exp(&exp, -extra), bc, p, rnd)
}

/// mpf_sqrt: correctly rounded; a negative argument is the reference's
/// ComplexResult.
pub fn mpf_sqrt(s: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    if s.sign == 1 {
        raise(Fail::ComplexResult);
        return fnan();
    }
    if s.man.is_zero() {
        return s.clone();
    }
    let (mut man, mut exp, mut bc) = (s.man.clone(), s.exp.clone(), s.bc);
    if exp.is_odd() {
        exp = exp.add_i64(-1);
        man = man.shl(1);
        bc += 1;
    } else if man.to_u64() == Some(1) {
        return normalize1(0, man, exp.floor_div2(), bc, prec, rnd);
    }
    let mut shift = (2 * prec as i64 - bc + 4).max(4);
    shift += shift & 1;
    let root = if matches!(rnd, Rnd::Floor | Rnd::Down) {
        crate::intmath::sqrtrem_python(&man.shl(shift as u64)).0
    } else {
        let (r, rem) = crate::intmath::sqrtrem_python(&man.shl(shift as u64));
        if !rem.is_zero() {
            shift += 2;
            r.shl(1).add_u64(1)
        } else {
            r
        }
    };
    from_man_exp(0, root, exp.add_i64(-shift).floor_div2(), prec, rnd)
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
    Mpf { sign: 0, man: Nat::from_u64(1), exp: Exp::S(0), bc: 1 }
}

/// mpf_pos: s rounded to prec (prec 0: s itself).
pub fn mpf_pos(s: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    if prec != 0 {
        if is_special(s) {
            return s.clone();
        }
        return normalize1(s.sign, s.man.clone(), s.exp.clone(), s.bc, prec, rnd);
    }
    s.clone()
}

/// from_int: sign and magnitude; prec 0 is exact (int_cache holds exactly
/// what from_man_exp gives, so it needs no port of its own).
pub fn from_int(sign: u32, n: Nat, prec: u64, rnd: Rnd) -> Mpf {
    from_man_exp(sign, n, Exp::S(0), prec, rnd)
}

/// python_mpf_mul_int: s times the integer (-1)^nsign * n.
pub fn mpf_mul_int(s: &Mpf, nsign: u32, n: &Nat, prec: u64, rnd: Rnd) -> Mpf {
    if s.man.is_zero() {
        return mpf_mul(s, &from_int(nsign, n.clone(), 0, rnd), prec, rnd);
    }
    if n.is_zero() {
        return fzero();
    }
    let sign = s.sign ^ nsign;
    let man = s.man.mul(n);
    let mut bc = s.bc + n.bits() as i64 - 1;
    let top = man.shr(bc.max(0) as u64);
    bc += top.to_u64().and_then(|x| i64::try_from(x).ok()).unwrap_or_else(|| {
                too_big();
                0
            });
    normalize(sign, man, s.exp.clone(), bc, prec, rnd)
}

/// The bctable lookups in the binary powering loops: the bit count of a
/// small integer (the reference indexes a 1024-entry table).
fn small_bits(x: &Nat) -> i64 {
    match x.to_u64() {
        Some(v) if v < 1024 => 64 - v.leading_zeros() as i64,
        _ => {
            raise(Fail::KeyError);
            0
        }
    }
}

/// mpf_pow_int: s^n for an integer n of any size.
pub fn mpf_pow_int(s: &Mpf, n: &Int, prec: u64, rnd: Rnd) -> Mpf {
    let pos = !n.is_neg() && !n.is_zero();
    if is_special(s) {
        if s.is_finf() {
            if pos {
                return s.clone();
            }
            if n.is_zero() {
                return fone();
            }
            return fzero();
        }
        if s.is_fninf() {
            if pos {
                return if n.is_odd() { fninf() } else { finf() };
            }
            if n.is_zero() {
                return fone();
            }
            return fzero();
        }
        // (mpmath 1.4.1: x**0 is 1 for every x, nan too)
        if n.is_zero() {
            return fone();
        }
        return fnan();
    }
    let small = n.to_i64();
    if small == Some(0) {
        return fone();
    }
    if small == Some(1) {
        return mpf_pos(s, prec, rnd);
    }
    if small == Some(2) {
        if s.man.is_zero() {
            return fzero();
        }
        let man = s.man.mul(&s.man);
        let exp = s.exp.add(&s.exp);
        if man.to_u64() == Some(1) {
            return Mpf { sign: 0, man, exp, bc: 1 };
        }
        let mut bc = s.bc + s.bc - 2;
        bc += small_bits(&man.shr(bc as u64));
        return normalize1(0, man, exp, bc, prec, rnd);
    }
    if small == Some(-1) {
        return mpf_div(&fone(), s, prec, rnd);
    }
    if n.is_neg() {
        let inverse = mpf_pow_int(s, &n.neg(), prec + 5, rnd.reciprocal());
        return mpf_div(&fone(), &inverse, prec, rnd);
    }
    let result_sign = s.sign & n.is_odd() as u32;
    if s.man.to_u64() == Some(1) {
        return Mpf { sign: result_sign, man: Nat::from_u64(1), exp: s.exp.mul_int(n), bc: 1 };
    }
    if Int::from_i64(s.bc).mul(n).cmp(&Int::from_i64(1000)) == Ordering::Less {
        // (a zero mantissa passes this test for any n: man**n is 0, as the reference's, not n multiplications)
        if s.man.is_zero() {
            return fzero();
        }
        let k = n.to_i64().unwrap_or(0);
        let mut man = Nat::from_u64(1);
        for _ in 0..k {
            man = man.mul(&s.man);
        }
        let bc = man.bits() as i64;
        return normalize1(result_sign, man, s.exp.mul_int(n), bc, prec, rnd);
    }
    let rounds_down = rnd == Rnd::Nearest || rnd.shifts_down(result_sign);
    let workprec = prec as i64 + 4 * n.bits() as i64 + 4;
    let cut = |x: &Nat, k: u64| -> Nat {
        if rounds_down {
            x.shr(k)
        } else {
            let away = x.low_nonzero(k);
            let q = x.shr(k);
            if away {
                q.add_u64(1)
            } else {
                q
            }
        }
    };
    let (mut man, mut exp, mut bc) = (s.man.clone(), s.exp.clone(), s.bc);
    let (mut pm, mut pe, mut pbc) = (Nat::from_u64(1), Exp::S(0), 1i64);
    let mut n = n.clone();
    loop {
        if n.is_odd() {
            pm = pm.mul(&man);
            pe = pe.add(&exp);
            pbc += bc - 2;
            pbc += small_bits(&pm.shr(pbc as u64));
            if pbc > workprec {
                pm = cut(&pm, (pbc - workprec) as u64);
                pe = pe.add_i64(pbc - workprec);
                pbc = workprec;
            }
            n = n.sub(&Int::from_i64(1));
            if n.is_zero() {
                break;
            }
        }
        man = man.mul(&man);
        exp = exp.add(&exp);
        bc = bc + bc - 2;
        bc += small_bits(&man.shr(bc as u64));
        if bc > workprec {
            man = cut(&man, (bc - workprec) as u64);
            exp = exp.add_i64(bc - workprec);
            bc = workprec;
        }
        n = n.shr(1);
    }
    normalize(result_sign, pm, pe, pbc, prec, rnd)
}

/// mpf_perturb: x + eps with directed rounding (eps of sign eps_sign,
/// below the precision); to nearest, x rounded.
pub fn mpf_perturb(x: &Mpf, eps_sign: u32, prec: u64, rnd: Rnd) -> Mpf {
    if rnd == Rnd::Nearest {
        return mpf_pos(x, prec, rnd);
    }
    let eps = Mpf { sign: eps_sign, man: Nat::from_u64(1), exp: x.exp.add_i64(x.bc - prec as i64 - 1), bc: 1 };
    let away = if x.sign == 1 {
        matches!(rnd, Rnd::Down | Rnd::Ceiling) as u32 ^ eps_sign
    } else {
        matches!(rnd, Rnd::Up | Rnd::Ceiling) as u32 ^ eps_sign
    };
    if away == 1 {
        mpf_add(x, &eps, prec, rnd, false)
    } else {
        mpf_pos(x, prec, rnd)
    }
}

/// to_fixed(s, prec): the signed fixed-point integer of s at prec bits.
pub fn to_fixed(s: &Mpf, prec: i64) -> Int {
    let offset = s.exp.add_i64(prec);
    let m = Int::new(s.sign == 1, s.man.clone());
    match offset.as_i64() {
        Some(o) => m.shift(o),
        None if offset.is_neg() => if m.is_neg() { Int::from_i64(-1) } else { Int::zero() },
        None => {
            too_big();
            Int::zero()
        }
    }
}

/// from_man_exp for a signed man (an Int) and an Int exponent.
pub fn from_int_man_exp(man: &Int, exp: &Exp, prec: u64, rnd: Rnd) -> Mpf {
    from_man_exp(man.is_neg() as u32, man.mag.clone(), exp.clone(), prec, rnd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(sign: u32, man: u64, exp: i64) -> Mpf {
        from_man_exp(sign, Nat::from_u64(man), Exp::S(exp), 0, Rnd::Nearest)
    }

    #[test]
    fn a_few_values_as_the_reference_gives_them() {
        // mpf_add(from_man_exp(1,0), from_man_exp(2,0), 53, 'n') == (0, 3, 0, 2)
        let r = mpf_add(&f(0, 1, 0), &f(0, 2, 0), 53, Rnd::Nearest, false);
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(3), Exp::S(0), 2));
        // 1/3 at 53 bits: (0, 6004799503160661, -54, 53)
        let r = mpf_div(&f(0, 1, 0), &f(0, 3, 0), 53, Rnd::Nearest);
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(6004799503160661), Exp::S(-54), 53));
        // sqrt(2) at 53 bits: (0, 6369051672525773, -52, 53)
        let r = mpf_sqrt(&f(0, 1, 1), 53, Rnd::Nearest);
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(6369051672525773), Exp::S(-52), 53));
        assert!(matches!(crate::fail::checked(|| mpf_div(&fzero(), &fzero(), 53, Rnd::Nearest)), Err(Fail::ZeroDivision)));
        assert!(mpf_add(&finf(), &fninf(), 53, Rnd::Nearest, false).is_fnan());
        assert!(mpf_mul(&finf(), &fzero(), 53, Rnd::Nearest).is_fnan());
    }

    #[test]
    fn zero_to_a_huge_integer_power_is_immediate() {
        // (the conformance list's 0 ** -(2^53 - 1): mpf_pow_int(fzero, n) once multiplied n times)
        let n = Int::from_i64((1 << 53) - 1);
        assert!(mpf_pow_int(&fzero(), &n, 53, Rnd::Nearest).is_fzero());
        assert!(mpf_pow_int(&fzero(), &Int::pow2(70), 53, Rnd::Nearest).is_fzero());
        let neg = Int::from_i64(-((1 << 53) - 1));
        assert!(matches!(crate::fail::checked(|| mpf_pow_int(&fzero(), &neg, 53, Rnd::Nearest)), Err(Fail::ZeroDivision)));
    }

    #[test]
    fn a_mantissa_rounded_to_nothing_is_one_bit() {
        // (normalize at precision 0, where the reference's strip never ends)
        assert!(normalize1(1, Nat::from_u64(5), Exp::S(0), 3, 0, Rnd::Floor).man.to_u64() == Some(1));
    }

    #[test]
    fn division_at_precision_zero_keeps_the_quotients_own_bits() {
        // mpmath 1.4.1's mpf_div(s, t, 0, rnd): the quotient with max(sbc, tbc)
        // + 5 extra bits and a sticky bit, at its own bit count, the same for
        // every rounding (1.3.0 rounded it to one bit)
        let cases = [
            (f(0, 199999999, 0), f(0, 100000000, 0), (0, 17179869099u64, -33i64, 34i64)),
            (f(0, 1, 0), f(0, 3, 0), (0, 171, -9, 8)),
            (f(0, 3, 0), f(0, 7, -5), (0, 439, -5, 9)),
        ];
        for (s, t, (sign, man, exp, bc)) in cases {
            for rnd in [Rnd::Nearest, Rnd::Floor, Rnd::Ceiling, Rnd::Down, Rnd::Up] {
                let r = mpf_div(&s, &t, 0, rnd);
                assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (sign, Some(man), Exp::S(exp), bc), "{:?}", rnd);
                // a negative quotient is the same magnitude
                let n = mpf_div(&mpf_neg(&s), &t, 0, rnd);
                assert_eq!((n.sign, n.man.to_u64(), n.bc), (1, Some(man), bc));
            }
        }
        // an exact quotient keeps its exact value: 6 / 3 = 2
        let r = mpf_div(&f(0, 6, 0), &f(0, 3, 0), 0, Rnd::Nearest);
        assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (0, Some(1), Exp::S(1), 1));    }

    #[test]
    fn division_by_a_power_of_two_at_precision_zero_is_exact() {
        // a power-of-two divisor: the dividend's own bits, the exponent moved,
        // for every rounding (past mpmath 1.4.1, which rounds to prec 0 there:
        // one bit, or no return with round_floor/round_down)
        let cases = [
            (f(0, 3, 0), f(0, 1, 2), (0, 3u64, -2i64, 2i64)),
            (f(0, 1, 0), f(0, 1, 1), (0, 1, -1, 1)),
            (f(0, 3, 0), f(0, 1, 0), (0, 3, 0, 2)),
            (f(0, 7, 3), f(0, 1, -2), (0, 7, 5, 3)),
            (f(0, 12345, -4), f(0, 1, 7), (0, 12345, -11, 14)),
        ];
        for (s, t, (sign, man, exp, bc)) in cases {
            for rnd in [Rnd::Nearest, Rnd::Floor, Rnd::Ceiling, Rnd::Down, Rnd::Up] {
                let r = mpf_div(&s, &t, 0, rnd);
                assert_eq!((r.sign, r.man.to_u64(), r.exp, r.bc), (sign, Some(man), Exp::S(exp), bc), "{:?}", rnd);
                let n = mpf_div(&mpf_neg(&s), &t, 0, rnd);
                assert_eq!((n.sign, n.man.to_u64(), n.exp, n.bc), (1, Some(man), Exp::S(exp), bc), "{:?}", rnd);
            }
        }
        // a nonzero precision still rounds there: 3 / 4 to one bit
        let r = mpf_div(&f(0, 3, 0), &f(0, 1, 2), 1, Rnd::Floor);
        assert_eq!((r.man.to_u64(), r.exp, r.bc), (Some(1), Exp::S(-1), 1));
    }
}
