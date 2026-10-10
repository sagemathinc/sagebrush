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
