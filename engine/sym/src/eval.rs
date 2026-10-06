//! Numerical evaluation: an expression to a complex float (with values for
//! its variables), and Sage's n(): every number and constant as a float.

use crate::err::value_error;
use crate::expr::*;
use crate::func::float_eval;
use crate::num::Num;

pub type C = (f64, f64);

fn cmul(a: C, b: C) -> C {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

fn cpow(b: C, x: C) -> C {
    if b.1 == 0.0 && x.1 == 0.0 && (b.0 >= 0.0 || x.0.fract() == 0.0) {
        return (b.0.powf(x.0), 0.0);
    }
    match crate::expr::float_pow(&Num::Float(b.0, b.1), &Num::Float(x.0, x.1)) {
        Num::Float(a, c) => (a, c),
        n => n.to_c64(),
    }
}

/// The value of e with variables from env (None if a variable is unknown
/// or a function cannot be evaluated).
pub fn to_c64_env(e: &Expr, env: &dyn Fn(&str) -> Option<C>) -> Option<C> {
    Some(match &e.kind {
        Kind::Num(n) => n.to_c64(),
        Kind::Sym(s) => env(s)?,
        Kind::Const(c) => match c {
            Const::Pi => (std::f64::consts::PI, 0.0),
            Const::E => (std::f64::consts::E, 0.0),
            Const::EulerGamma => (0.577_215_664_901_532_9, 0.0),
            Const::Infinity => (f64::INFINITY, 0.0),
            Const::MinusInfinity => (f64::NEG_INFINITY, 0.0),
            _ => (f64::NAN, 0.0),
        },
        Kind::Add(v) => {
            let mut s = (0.0, 0.0);
            for t in v {
                let x = to_c64_env(t, env)?;
                s = (s.0 + x.0, s.1 + x.1);
            }
            s
        }
        Kind::Mul(v) => {
            let mut s = (1.0, 0.0);
            for t in v {
                s = cmul(s, to_c64_env(t, env)?);
            }
            s
        }
        Kind::Pow(b, x) => cpow(to_c64_env(b, env)?, to_c64_env(x, env)?),
        Kind::Fun(f, a) => {
            let v: Option<Vec<C>> = a.iter().map(|x| to_c64_env(x, env)).collect();
            float_eval(f, &v?)?
        }
        Kind::Rel(..) => return None,
    })
}

pub fn to_c64(e: &Expr) -> Option<C> {
    to_c64_env(e, &|_| None)
}

/// A real value (imaginary part negligible).
pub fn to_f64(e: &Expr) -> Option<f64> {
    let (a, b) = to_c64(e)?;
    if b.abs() <= 1e-14 * a.abs().max(1.0) {
        Some(a)
    } else {
        None
    }
}

/// Sage's n(): the numerical value of a constant expression.
pub fn n(e: &Expr) -> Expr {
    if !free_symbols(e).is_empty() {
        value_error("cannot evaluate symbolic expression numerically");
    }
    match to_c64(e) {
        Some((a, b)) => num(if b == 0.0 { Num::float(a) } else { Num::Float(a, b) }),
        None => value_error("cannot evaluate symbolic expression numerically"),
    }
}

/// Values of e at many points of one variable (for plots); NaN where it is
/// undefined or not real.
pub fn eval_many(e: &Expr, var: &str, xs: &[f64]) -> Vec<f64> {
    xs.iter()
        .map(|&t| {
            match to_c64_env(e, &|s| if s == var { Some((t, 0.0)) } else { None }) {
                Some((a, b)) if b.abs() <= 1e-12 * a.abs().max(1.0) => a,
                _ => f64::NAN,
            }
        })
        .collect()
}
