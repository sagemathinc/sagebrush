//! Factoring and simplification of rational expressions:
//!
//! - factor: the irreducible factorization over Q of a polynomial or a
//!   rational function, with kernels such as sin(x) or e^x as variables;
//! - together / simplify_rational: one fraction, common factors cancelled,
//!   numerator and denominator expanded (as Maxima's ratsimp);
//! - simplify_trig: sin^2 + cos^2 = 1 (trying both directions, keeping the
//!   smaller result), tan, cot, sec, csc in terms of sin and cos;
//! - simplify_full: trigonometric, then rational simplification.

use crate::expand::expand;
use crate::expr::*;
use crate::mpoly::{factor as mfactor, generators, primitive, MPoly};
use crate::num::Q;
use num_traits::One;

/// (numerator, denominator) of e as a single fraction.
pub fn together(e: &Expr) -> (Expr, Expr) {
    match &e.kind {
        Kind::Add(v) => {
            let mut n = zero();
            let mut d = one();
            for t in v {
                let (tn, td) = together(t);
                if td == d {
                    n = add2(&n, &tn);
                } else {
                    n = add2(&mul2(&n, &td), &mul2(&tn, &d));
                    d = mul2(&d, &td);
                }
            }
            (n, d)
        }
        Kind::Mul(v) => {
            let mut n = vec![];
            let mut d = vec![];
            for f in v {
                let (fnum, fden) = together(f);
                n.push(fnum);
                d.push(fden);
            }
            (mul(n), mul(d))
        }
        Kind::Pow(b, x) => match x.as_i64() {
            Some(k) if k != 0 => {
                let (bn, bd) = together(b);
                if k > 0 {
                    (pow(&bn, x), pow(&bd, x))
                } else {
                    let m = int(-k);
                    (pow(&bd, &m), pow(&bn, &m))
                }
            }
            _ => {
                if x.as_num().map_or(false, |n| n.is_negative()) {
                    (one(), pow(b, &neg(x)))
                } else {
                    (e.clone(), one())
                }
            }
        },
        Kind::Num(n) => match n.as_rat() {
            Some(r) => (big(r.numer().clone()), big(r.denom().clone())),
            None => (e.clone(), one()),
        },
        _ => (e.clone(), one()),
    }
}

/// A product of factors exactly as given (no distribution of a number
/// into a sum: 2*(x + 1) stays, as Sage's factor prints it).
pub fn product_keep(c: &Q, factors: Vec<Expr>) -> Expr {
    let body = mul(factors);
    if c.is_one() {
        return body;
    }
    if body.is_one() {
        return qnum(c.clone());
    }
    let mut v = vec![qnum(c.clone())];
    match &body.kind {
        Kind::Mul(f) => {
            if f[0].is_num() {
                return mul2(&qnum(c.clone()), &body);
            }
            v.extend(f.iter().cloned())
        }
        _ => v.push(body),
    }
    raw(Kind::Mul(v))
}

fn factored(p: &MPoly) -> (Q, Vec<(Expr, u32)>) {
    let (c, fs) = mfactor(p);
    (c, fs.into_iter().map(|(f, e)| (f.to_expr(), e)).collect())
}

/// Sage's factor: polynomials and rational functions over Q.
pub fn factor(e: &Expr) -> Expr {
    let (n, d) = together(e);
    let (n, d) = (expand(&n), expand(&d));
    let gens = generators(&add2(&n, &d));
    let (Some(np), Some(dp)) = (MPoly::from_expr(&n, &gens), MPoly::from_expr(&d, &gens)) else {
        return e.clone();
    };
    if np.is_zero() {
        return zero();
    }
    let (cn, mut fnum) = factored(&np);
    let (cd, mut fden) = factored(&dp);
    // cancel common factors
    for (f, k) in fnum.iter_mut() {
        if let Some((_, j)) = fden.iter_mut().find(|(g, _)| g == f) {
            let m = (*k).min(*j);
            *k -= m;
            *j -= m;
        }
    }
    let mut factors: Vec<Expr> = fnum.into_iter().filter(|(_, k)| *k > 0).map(|(f, k)| pow(&f, &int(k as i64))).collect();
    factors.extend(fden.into_iter().filter(|(_, k)| *k > 0).map(|(f, k)| pow(&f, &int(-(k as i64)))));
    product_keep(&(cn / cd), factors)
}

/// Sage's simplify_rational: one fraction, cancelled, numerator and
/// denominator expanded.
pub fn simplify_rational(e: &Expr) -> Expr {
    if let Kind::Rel(r, a, b) = &e.kind {
        return relation(*r, &simplify_rational(a), &simplify_rational(b));
    }
    // simplify inside functions first
    let e = map_functions(e, &simplify_rational);
    let (n, d) = together(&e);
    let (n, d) = (expand(&n), expand(&d));
    let gens = generators(&add2(&n, &d));
    let (Some(np), Some(dp)) = (MPoly::from_expr(&n, &gens), MPoly::from_expr(&d, &gens)) else {
        return if d.is_one() { n } else { div(&n, &d) };
    };
    if np.is_zero() {
        return zero();
    }
    // Only the denominator is factored: its factors are cancelled from the
    // numerator by exact division (factoring a numerator in many kernels,
    // such as u_x(x, y, z) and sin(x*y*z), is far too slow and not needed:
    // the numerator is printed expanded anyway).
    let (cd, fden) = mfactor(&dp);
    let mut num = np.clone();
    let mut den_f: Vec<Expr> = vec![];
    for (f, j) in &fden {
        let mut k = *j;
        while k > 0 {
            match num.divexact(f) {
                Some(q) => {
                    num = q;
                    k -= 1;
                }
                None => break,
            }
        }
        if k > 0 {
            den_f.push(pow(&f.to_expr(), &int(k as i64)));
        }
    }
    let (cn, num) = primitive(&num);
    let c = cn / cd;
    let numer = expand(&mul2(&qnum(Q::new(c.numer().clone(), One::one())), &num.to_expr()));
    let denom = expand(&mul2(&qnum(Q::from_integer(c.denom().clone())), &mul(den_f)));
    // a negative leading coefficient moves to the numerator
    if denom.is_one() {
        return numer;
    }
    div(&numer, &denom)
}

fn map_functions(e: &Expr, f: &dyn Fn(&Expr) -> Expr) -> Expr {
    match &e.kind {
        Kind::Fun(g, a) => fun(g.clone(), a.iter().map(|x| f(x)).collect()),
        _ => map(e, &mut |c| map_functions(c, f)),
    }
}

/// tan, cot, sec, csc in terms of sin and cos.
pub fn trig_to_sincos(e: &Expr) -> Expr {
    let e = map(e, &mut |c| trig_to_sincos(c));
    match &e.kind {
        Kind::Fun(Fun::Tan, a) => div(&sin(&a[0]), &cos(&a[0])),
        Kind::Fun(Fun::Cot, a) => div(&cos(&a[0]), &sin(&a[0])),
        Kind::Fun(Fun::Sec, a) => recip(&cos(&a[0])),
        Kind::Fun(Fun::Csc, a) => recip(&sin(&a[0])),
        _ => e,
    }
}

/// Replace f(u)^n (n >= 2) by (1 - g(u)^2)^(n/2) g-wise: sin <-> cos.
fn pythagoras(e: &Expr, from: Fun, to: Fun) -> Expr {
    let e = map(e, &mut |c| pythagoras(c, from.clone(), to.clone()));
    if let Kind::Pow(b, x) = &e.kind {
        if let (Kind::Fun(f, a), Some(k)) = (&b.kind, x.as_i64()) {
            if *f == from && k >= 2 {
                let other = pow(&fun(to.clone(), a.clone()), &int(2));
                let s = sub(&one(), &other);
                let r = pow(&s, &int(k / 2));
                return if k % 2 == 1 { mul2(&r, b) } else { r };
            }
        }
    }
    e
}

/// Size of an expression (for choosing the simplest form).
pub fn size(e: &Expr) -> usize {
    1 + e.children().iter().map(size).sum::<usize>()
}

/// Sage's simplify_trig.
pub fn simplify_trig(e: &Expr) -> Expr {
    let base = simplify_rational(&trig_to_sincos(e));
    let a = simplify_rational(&pythagoras(&base, Fun::Sin, Fun::Cos));
    let b = simplify_rational(&pythagoras(&base, Fun::Cos, Fun::Sin));
    let mut best = base;
    for c in [a, b] {
        if size(&c) < size(&best) {
            best = c;
        }
    }
    best
}

/// Sage's simplify_full (full_simplify).
pub fn simplify_full(e: &Expr) -> Expr {
    let t = simplify_trig(e);
    let r = simplify_rational(e);
    if size(&t) < size(&r) {
        t
    } else {
        r
    }
}
