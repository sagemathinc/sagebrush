//! Limits: direct substitution where the expression is continuous, the
//! leading term of a series expansion at finite points and (through
//! x = 1/t) at infinity, f^g as exp(g log f), and L'Hopital's rule for the
//! quotient forms 0/0 and oo/oo (with 0*oo rewritten as a quotient).

use crate::diff::{depends, diff};
use crate::err::{catch, value_error};
use crate::expr::*;
use crate::series::series;
use crate::simplify::{simplify_rational, together};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dir {
    Both,
    Plus,
    Minus,
}

/// Sage's limit(e, x=a [, dir='+'/'-']).
pub fn limit(e: &Expr, x: &str, a: &Expr, dir: Dir) -> Expr {
    let r = lim(e, x, a, dir, 0);
    tidy(&r)
}

fn tidy(e: &Expr) -> Expr {
    if e.is_infinite() || e.is_const(Const::Undefined) {
        return e.clone();
    }
    simplify_rational(e)
}

fn is_finite_value(e: &Expr) -> bool {
    !e.is_infinite() && !e.is_const(Const::Undefined) && !has_infinity(e)
}

fn has_infinity(e: &Expr) -> bool {
    e.is_infinite() || e.is_const(Const::Undefined) || e.children().iter().any(has_infinity)
}

fn lim(e: &Expr, x: &str, a: &Expr, dir: Dir, depth: u32) -> Expr {
    sagebrush_interrupt::check();
    if depth > 12 {
        value_error("limit: too deep");
    }
    if !depends(e, x) {
        return e.clone();
    }
    let xs = sym(x);
    // 1. continuity: plug in (finite points)
    if is_finite_value(a) {
        if let Ok(v) = catch(|| subs(e, &[(xs.clone(), a.clone())])) {
            if is_finite_value(&v) && !v.is_const(Const::Undefined) {
                let ok = crate::eval::to_c64(&v).map_or(true, |(r, i)| r.is_finite() && i.is_finite());
                if ok {
                    return v;
                }
            }
        }
    }
    // 2. series at the point
    if let Ok(Some(v)) = catch(|| series_limit(e, x, a, dir)) {
        return v;
    }
    // 3. structure
    match &e.kind {
        Kind::Pow(b, p) if depends(p, x) => {
            // b^p = exp(p log b)
            let l = lim(&mul2(p, &log(b)), x, a, dir, depth + 1);
            return exp_limit(&l);
        }
        Kind::Add(v) => {
            let ls: Vec<Expr> = v.iter().map(|t| lim(t, x, a, dir, depth + 1)).collect();
            let s = add(ls);
            if !s.is_const(Const::Undefined) {
                return s;
            }
            // oo - oo: one fraction, then L'Hopital
            let (n, d) = together(e);
            return quotient_limit(&n, &d, x, a, dir, depth + 1);
        }
        Kind::Mul(_) => {
            let (n, d) = together(e);
            if !d.is_one() && depends(&d, x) {
                return quotient_limit(&n, &d, x, a, dir, depth + 1);
            }
            // a product: limits of the factors; 0*oo becomes f/(1/g)
            if let Kind::Mul(v) = &e.kind {
                let ls: Vec<Expr> = v.iter().map(|f| lim(f, x, a, dir, depth + 1)).collect();
                let zero_i = ls.iter().position(|l| l.is_zero());
                let inf_i = ls.iter().position(|l| l.is_infinite());
                if let (Some(i), Some(j)) = (zero_i, inf_i) {
                    let rest: Vec<Expr> = v.iter().enumerate().filter(|(k, _)| *k != i && *k != j).map(|(_, f)| f.clone()).collect();
                    // which goes on top: try putting the infinite factor's
                    // reciprocal in the denominator, and the other way
                    let f = &v[i];
                    let g = &v[j];
                    let q = catch(|| quotient_limit(f, &recip(g), x, a, dir, depth + 1)).unwrap_or_else(|_| quotient_limit(g, &recip(f), x, a, dir, depth + 1));
                    return mul2(&q, &lim(&mul(rest), x, a, dir, depth + 1));
                }
                return mul(ls);
            }
            unreachable!()
        }
        Kind::Fun(f, args) if args.len() == 1 => {
            let l = lim(&args[0], x, a, dir, depth + 1);
            return fun_at(f, &l);
        }
        _ => {}
    }
    value_error(format!("limit of {} not found", crate::to_string(e)))
}

fn exp_limit(l: &Expr) -> Expr {
    if l.is_const(Const::Infinity) {
        infinity()
    } else if l.is_const(Const::MinusInfinity) {
        zero()
    } else {
        exp(l)
    }
}

/// A function at a limit point (continuous functions; values at infinity).
fn fun_at(f: &Fun, l: &Expr) -> Expr {
    let pinf = l.is_const(Const::Infinity);
    let minf = l.is_const(Const::MinusInfinity);
    match f {
        Fun::Log if pinf => infinity(),
        Fun::Log if l.is_zero() => constant(Const::MinusInfinity),
        Fun::Atan if pinf => div(&pi(), &int(2)),
        Fun::Atan if minf => neg(&div(&pi(), &int(2))),
        Fun::Tanh if pinf => one(),
        Fun::Tanh if minf => int(-1),
        Fun::Sinh | Fun::Asinh if pinf || minf => l.clone(),
        Fun::Cosh if pinf || minf => infinity(),
        Fun::Erf if pinf => one(),
        Fun::Erf if minf => int(-1),
        Fun::Sin | Fun::Cos if pinf || minf => value_error("limit does not exist (the function oscillates)"),
        _ => fun1(f.clone(), l),
    }
}

/// lim n/d by its form: substitution, then L'Hopital for 0/0 and oo/oo.
fn quotient_limit(n: &Expr, d: &Expr, x: &str, a: &Expr, dir: Dir, depth: u32) -> Expr {
    if depth > 12 {
        value_error("limit: L'Hopital's rule did not converge");
    }
    let ln = lim(n, x, a, dir, depth + 1);
    let ld = lim(d, x, a, dir, depth + 1);
    let zero_zero = ln.is_zero() && ld.is_zero();
    let inf_inf = ln.is_infinite() && ld.is_infinite();
    if !(zero_zero || inf_inf) {
        if ld.is_zero() {
            // c/0: an infinity, signed by the side
            return signed_infinity(n, d, x, a, dir, &ln);
        }
        if ld.is_infinite() {
            return zero();
        }
        return div(&ln, &ld);
    }
    let dn = simplify_rational(&diff(n, x));
    let dd = simplify_rational(&diff(d, x));
    let q = simplify_rational(&div(&dn, &dd));
    lim(&q, x, a, dir, depth + 1)
}

fn signed_infinity(n: &Expr, d: &Expr, x: &str, a: &Expr, dir: Dir, ln: &Expr) -> Expr {
    // the sign of n/d just beside a
    let xs = sym(x);
    let sample = |h: f64| -> Option<f64> {
        let pt = if a.is_infinite() {
            if a.is_const(Const::MinusInfinity) { -1.0 / h } else { 1.0 / h }
        } else {
            crate::eval::to_f64(a)? + h
        };
        let q = div(n, d);
        crate::eval::to_c64_env(&q, &|s| if s == x { Some((pt, 0.0)) } else { None }).map(|v| v.0)
    };
    let _ = (&xs, ln);
    let r = sample(1e-7);
    let l = sample(-1e-7);
    let sgn = |v: Option<f64>| v.map(|v| if v > 0.0 { 1 } else { -1 });
    match dir {
        Dir::Plus => if sgn(r) == Some(1) { infinity() } else { constant(Const::MinusInfinity) },
        Dir::Minus => if sgn(l) == Some(1) { infinity() } else { constant(Const::MinusInfinity) },
        Dir::Both => match (sgn(l), sgn(r)) {
            (Some(1), Some(1)) => infinity(),
            (Some(-1), Some(-1)) => constant(Const::MinusInfinity),
            _ => constant(Const::UnsignedInfinity),
        },
    }
}

/// The limit from the leading term of the expansion at a.
fn series_limit(e: &Expr, x: &str, a: &Expr, dir: Dir) -> Option<Expr> {
    let xs = sym(x);
    let t = sym("__limit_t");
    let (shifted, dir) = if a.is_const(Const::Infinity) {
        (subs(e, &[(xs.clone(), recip(&t))]), Dir::Plus)
    } else if a.is_const(Const::MinusInfinity) {
        (subs(e, &[(xs.clone(), neg(&recip(&t)))]), Dir::Plus)
    } else {
        (subs(e, &[(xs.clone(), add2(a, &t))]), dir)
    };
    let s = series(&shifted, "__limit_t", 4);
    if s.c.is_empty() {
        return Some(zero());
    }
    let c0 = s.c[0].clone();
    if depends(&c0, "__limit_t") {
        return None;
    }
    if s.v > 0 {
        return Some(zero());
    }
    if s.v == 0 {
        return Some(c0);
    }
    // a pole of order -v
    let c = crate::eval::to_f64(&c0)?;
    let odd = s.v % 2 != 0;
    Some(match dir {
        Dir::Plus => if c > 0.0 { infinity() } else { constant(Const::MinusInfinity) },
        Dir::Minus => if (c > 0.0) != odd { infinity() } else { constant(Const::MinusInfinity) },
        Dir::Both => {
            if odd {
                constant(Const::UnsignedInfinity)
            } else if c > 0.0 {
                infinity()
            } else {
                constant(Const::MinusInfinity)
            }
        }
    })
}
