//! Whether an expression is real-valued: the premise of every real-only fact
//! the limit engine and definite integration use (zero sets, continuity,
//! boundedness, signs).  It is established, not assumed: the fourth review
//! found 1/cosh(log(-x)/2)^2 (complex for x > 0 with no I in sight), the
//! sign of 1 + I x taken from its limit, and sin(I x) taken to be bounded.
//!
//! One walker, `real_with`, decides it from the expression's form; where a
//! logarithm's argument or a fractional power's base depends on x, it must be
//! positive, which only the caller can establish (on an interval, near a
//! point): `pos` decides that.

use crate::diff::depends;
use crate::expr::*;
use crate::interval::{encl, Iv};
use num_traits::{Signed, Zero};

/// Whether e is real for the values of x in question, with `pos(u)`
/// establishing u > 0 there (for logarithms and fractional powers of u).
pub fn real_with(e: &Expr, x: &str, pos: &dyn Fn(&Expr) -> bool) -> bool {
    if !depends(e, x) {
        return real_const(e);
    }
    match &e.kind {
        Kind::Sym(_) => true, // (x itself: other symbols do not depend on x)
        Kind::Add(v) | Kind::Mul(v) => v.iter().all(|t| real_with(t, x, pos)),
        Kind::Pow(b, n) if b.is_const(Const::E) => real_with(n, x, pos),
        Kind::Pow(b, n) if !depends(b, x) => real_const(b) && positive_const(b) && real_with(n, x, pos),
        Kind::Pow(b, n) => {
            if !real_with(b, x, pos) {
                return false;
            }
            if n.as_rat().map_or(false, |q| q.is_integer()) {
                return true;
            }
            !depends(n, x) && real_const(n) && pos(b) || depends(n, x) && real_with(n, x, pos) && pos(b)
        }
        Kind::Fun(f, a) if a.len() == 1 => match f {
            Fun::Sin | Fun::Cos | Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc | Fun::Atan | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Asinh | Fun::Erf | Fun::Sign => real_with(&a[0], x, pos),
            // |z| is real for complex z too
            Fun::Abs => true,
            Fun::Log => real_with(&a[0], x, pos) && pos(&a[0]),
            // arcsin, arccos: real on [-1, 1] (1 - u, 1 + u positive but at
            // isolated points, as pos allows)
            Fun::Asin | Fun::Acos => real_with(&a[0], x, pos) && pos(&sub(&int(1), &a[0])) && pos(&add2(&int(1), &a[0])),
            _ => false,
        },
        _ => false,
    }
}

/// Real for every real x, by form alone (no logarithms or fractional powers
/// of expressions in x).
pub fn real_everywhere(e: &Expr, x: &str) -> bool {
    real_with(e, x, &|_| false)
}

/// Whether a constant (no symbols at all) is real: by form, with positive
/// arguments of logarithms and fractional powers certified by interval
/// enclosures (log(-2) has no I in it).
pub fn real_const(c: &Expr) -> bool {
    match &c.kind {
        Kind::Num(crate::num::Num::Exact(_, im)) => im.is_zero(),
        Kind::Num(crate::num::Num::Float(_, im)) => *im == 0.0,
        Kind::Const(Const::Pi | Const::E | Const::EulerGamma) => true,
        Kind::Add(v) | Kind::Mul(v) => v.iter().all(real_const),
        Kind::Pow(b, n) if b.is_const(Const::E) => real_const(n),
        Kind::Pow(b, n) => real_const(b) && real_const(n) && (n.as_rat().map_or(false, |q| q.is_integer()) || positive_const(b)),
        Kind::Fun(f, a) if a.len() == 1 => match f {
            Fun::Sin | Fun::Cos | Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc | Fun::Atan | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Asinh | Fun::Erf | Fun::Sign => real_const(&a[0]),
            Fun::Abs => true,
            Fun::Log => real_const(&a[0]) && positive_const(&a[0]),
            _ => false,
        },
        _ => false,
    }
}

/// The sign of a real constant, certified: exactly for rationals, else from
/// an interval enclosure that excludes 0 (sin(10^20 + 1) gets none: its
/// argument does not survive conversion to a float); None if not
/// established.
pub fn const_sign(c: &Expr) -> Option<i32> {
    if let Some(q) = c.as_rat() {
        return Some(if q.is_zero() { 0 } else if q.is_positive() { 1 } else { -1 });
    }
    if !real_const(c) {
        return None;
    }
    let i = crate::interval::ival(c, "\u{0}", crate::interval::Iv(0.0, 0.0))?;
    if i.0 > 0.0 {
        Some(1)
    } else if i.1 < 0.0 {
        Some(-1)
    } else {
        None
    }
}

/// A constant certainly positive (and real).
pub fn positive_const(c: &Expr) -> bool {
    const_sign(c) == Some(1)
}

/// Where a function of one argument is discontinuous in its argument: a
/// principal branch's cut (or a jump), as the set of argument values.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Cut {
    /// (-oo, 0]: log, fractional powers
    NonPositive,
    /// real, |t| >= 1: asin, acos, atanh
    RealOutsideUnit,
    /// imaginary, |t| >= 1: atan, asinh
    ImagOutsideUnit,
    /// (-oo, 1]: acosh
    BelowOne,
    /// (-oo, 0] and [1, oo): asech (acosh(1/t))
    RealOutsideZeroOne,
    /// real, |t| <= 1: asec, acsc, acoth (1/t on their cuts)
    RealUnit,
    /// imaginary, |t| <= 1: acot, acsch
    ImagUnit,
    /// sign and heaviside: jumps at 0
    JumpAtZero,
    /// floor and ceil: jumps at the integers
    JumpAtIntegers,
    /// not described: never certified
    Unknown,
}

impl Cut {
    /// Whether a real argument moving along the real axis meets the cut only
    /// by moving along it or at a point where the function is continuous or
    /// infinite (so substitution for a real argument is sound): log(x) for
    /// x < 0 takes the values from above all along.
    pub fn along_real_axis(self) -> bool {
        matches!(self, Cut::NonPositive | Cut::RealOutsideUnit | Cut::BelowOne | Cut::RealOutsideZeroOne)
    }
}

/// e's own discontinuity in its argument (the argument, and where), or None
/// for a function continuous wherever it is finite (sin, exp, gamma, ...,
/// integer powers, c^u).
pub fn cut_of(e: &Expr) -> Option<(Cut, &Expr)> {
    match &e.kind {
        // (a constant base: c^u is entire in u, and callers skip arguments
        // free of x)
        Kind::Pow(b, n) if !b.is_const(Const::E) && !n.as_rat().map_or(false, |q| q.is_integer()) => Some((Cut::NonPositive, b)),
        Kind::Fun(f, a) if a.len() == 1 => {
            let c = match f {
                Fun::Log => Cut::NonPositive,
                Fun::Asin | Fun::Acos | Fun::Atanh => Cut::RealOutsideUnit,
                Fun::Atan | Fun::Asinh => Cut::ImagOutsideUnit,
                Fun::Acosh => Cut::BelowOne,
                Fun::Asech => Cut::RealOutsideZeroOne,
                Fun::Asec | Fun::Acsc | Fun::Acoth => Cut::RealUnit,
                Fun::Acot | Fun::Acsch => Cut::ImagUnit,
                Fun::Sign | Fun::Heaviside => Cut::JumpAtZero,
                Fun::Floor | Fun::Ceil => Cut::JumpAtIntegers,
                Fun::Sin | Fun::Cos | Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Coth | Fun::Sech | Fun::Csch
                | Fun::Erf | Fun::Gamma | Fun::Factorial | Fun::Abs | Fun::Conjugate | Fun::RealPart | Fun::ImagPart | Fun::User(_) => return None,
                _ => Cut::Unknown,
            };
            Some((c, &a[0]))
        }
        Kind::Fun(Fun::Atan2, a) => Some((Cut::Unknown, &a[0])),
        _ => None,
    }
}

/// Certified enclosures of the real and imaginary parts of a constant: each
/// expanded term an exact complex number times a real constant.
pub fn complex_encl(c: &Expr) -> Option<(Iv, Iv)> {
    if real_const(c) {
        return Some((encl(c)?, Iv(0.0, 0.0)));
    }
    let ex = crate::expand::expand(c);
    let terms = match &ex.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![ex.clone()],
    };
    let (mut re, mut im) = (vec![], vec![]);
    for t in terms {
        let (k, r) = split_coeff(&t);
        if !real_const(&r) {
            return None;
        }
        let crate::num::Num::Exact(kr, ki) = k else { return None };
        re.push(mul(vec![qnum(kr), r.clone()]));
        im.push(mul(vec![qnum(ki), r]));
    }
    Some((encl(&add(re))?, encl(&add(im))?))
}

/// Whether the constant v is certainly off the cut (strictly: branch points
/// are on it), by certified enclosures of its real and imaginary parts: a
/// double's sign decides nothing (-sin(10^20 + 1) evaluates positive, the
/// fifth review's V4).
pub fn off_cut(cut: Cut, v: &Expr) -> bool {
    let Some((re, im)) = complex_encl(v) else { return false };
    let im_nonzero = !im.contains_zero();
    let im_zero = im.0 == 0.0 && im.1 == 0.0;
    let re_nonzero = !re.contains_zero();
    match cut {
        Cut::NonPositive => im_nonzero || re.0 > 0.0,
        Cut::RealOutsideUnit => im_nonzero || (re.0 > -1.0 && re.1 < 1.0),
        Cut::ImagOutsideUnit => re_nonzero || (im.0 > -1.0 && im.1 < 1.0),
        Cut::BelowOne => im_nonzero || re.0 > 1.0,
        Cut::RealOutsideZeroOne => im_nonzero || (re.0 > 0.0 && re.1 < 1.0),
        Cut::RealUnit => im_nonzero || re.0 > 1.0 || re.1 < -1.0,
        Cut::ImagUnit => re_nonzero || im.0 > 1.0 || im.1 < -1.0,
        // real arguments away from the jumps
        Cut::JumpAtZero => im_zero && re_nonzero,
        Cut::JumpAtIntegers => im_zero && re.0.floor() == re.1.floor() && re.0 > re.0.floor(),
        Cut::Unknown => false,
    }
}

/// Whether a real argument moving along e's cut may substitute at the
/// value v: the cut is met only along the real axis (Cut::along_real_axis),
/// and v is not a branch point where e is infinite (atanh at +-1, which the
/// value atanh(1) would hide).
pub fn along_cut_ok(e: &Expr, cut: Cut, v: &Expr) -> bool {
    if !cut.along_real_axis() {
        return false;
    }
    if matches!(&e.kind, Kind::Fun(Fun::Atanh, _)) {
        return complex_encl(v).is_some_and(|(re, im)| !im.contains_zero() || re.1 < -1.0 || (re.0 > -1.0 && re.1 < 1.0) || re.0 > 1.0);
    }
    // asech is infinite at 0
    if matches!(&e.kind, Kind::Fun(Fun::Asech, _)) {
        return complex_encl(v).is_some_and(|(re, im)| !im.contains_zero() || !re.contains_zero());
    }
    true
}
