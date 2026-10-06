//! Integration of rational functions with rational coefficients:
//! the polynomial part, Hermite reduction for the rational part, and for
//! the logarithmic part the irreducible factors of the (square-free)
//! denominator: logs for linear factors, a log and an arctangent (or two
//! logs) for quadratic ones, and the Rothstein-Trager resultant for the
//! rest (when its roots are rational).  See Bronstein, Symbolic
//! Integration I, chapter 2.

use crate::expr::*;
use crate::num::Q;
use crate::qpoly::{pow_q, QPoly};
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;

/// The integral of num/den in x, or None if part of it is not elementary
/// over Q (a Rothstein-Trager resultant with irrational roots).
pub fn integrate_rational(num: &QPoly, den: &QPoly, x: &Expr) -> Option<Expr> {
    if den.is_zero() {
        return None;
    }
    // a monic denominator
    let lc = den.lc();
    let den = den.monic();
    let num = num.scale(&lc.recip());
    let (q, r) = num.divrem(&den);
    let mut terms = vec![poly_integral(&q, x)];
    if r.is_zero() {
        return Some(add(terms));
    }
    let (g, a, d) = hermite(&r, &den);
    for (b, v, j) in g {
        terms.push(rational_term(&b, &v, j, x));
    }
    if !a.is_zero() {
        terms.push(log_part(&a, &d, x)?);
    }
    Some(add(terms))
}

/// b / v^j as Maxima writes it: -1/2/(x + 1)^2, but (2*x - 1)/(2*x^2 + 2):
/// a primitive numerator over the expanded denominator times the content.
fn rational_term(b: &QPoly, v: &QPoly, j: u32, x: &Expr) -> Expr {
    if v.deg() == 1 {
        return div(&b.to_expr(x), &pow(&prim(v, x), &int(j as i64)));
    }
    let (c, nb) = crate::poly::to_zpoly(&b.0);
    let (cv, _) = crate::poly::to_zpoly(&v.0);
    // b / v^j = c * nb / v^j; v = cv * prim(v)
    let k = c / pow_q(&cv, j);
    let num = mul2(&big(k.numer().clone()), &crate::poly::zpoly_expr(&nb, x));
    let den = crate::expand::expand(&mul2(&big(k.denom().clone()), &pow(&prim(v, x), &int(j as i64))));
    div(&num, &den)
}

fn poly_integral(p: &QPoly, x: &Expr) -> Expr {
    add(p.0.iter().enumerate().map(|(k, c)| {
        mul2(&qnum(c / Q::from_integer(BigInt::from(k as i64 + 1))), &pow(x, &int(k as i64 + 1)))
    }).collect())
}

/// Hermite reduction of a/d (deg a < deg d, d monic): the rational part as
/// terms b / v^j, and a remaining a/d with d square-free.
fn hermite(a: &QPoly, d: &QPoly) -> (Vec<(QPoly, QPoly, u32)>, QPoly, QPoly) {
    let mut g = vec![];
    let mut a = a.clone();
    let mut d = d.clone();
    for (v, i) in d.squarefree() {
        if i < 2 || v.deg() < 1 {
            continue;
        }
        let u = d.div_exact(&v.pow(i));
        let dv = v.derivative();
        for j in (1..i).rev() {
            let jq = Q::from_integer(BigInt::from(j as i64));
            let rhs = a.scale(&(-jq.recip()));
            let (b, c) = QPoly::solve_bezout(&u.mul(&dv), &v, &rhs).expect("Hermite: u v' and v are coprime");
            if !b.is_zero() {
                g.push((b.clone(), v.clone(), j));
            }
            a = c.scale(&(-jq)).sub(&u.mul(&b.derivative()));
        }
        d = u.mul(&v);
    }
    (g, a, d)
}

/// The integral of a/d, d monic and square-free, deg a < deg d.
fn log_part(a: &QPoly, d: &QPoly, x: &Expr) -> Option<Expr> {
    let factors = d.factor();
    let mut terms = vec![];
    for (dk, _) in &factors {
        // the partial fraction a_k/d_k: a_k = a (d/d_k)^-1 mod d_k
        let e = d.div_exact(dk);
        let (_, s, _) = e.xgcd(dk);
        let ak = a.mul(&s).rem(dk);
        if ak.is_zero() {
            continue;
        }
        terms.push(match dk.deg() {
            1 => mul2(&qnum(ak.coeff(0)), &log(&prim(dk, x))),
            2 => quadratic(&ak, dk, x),
            _ => rothstein_trager(&ak, dk, x)?,
        });
    }
    Some(add(terms))
}

/// A monic factor as the primitive integer polynomial (log arguments as
/// Sage writes them: log(2*x + 1), not log(x + 1/2)).
fn prim(p: &QPoly, x: &Expr) -> Expr {
    let (_, z) = crate::poly::to_zpoly(&p.0);
    crate::poly::zpoly_expr(&z, x)
}

/// (r x + s)/(x^2 + p x + q), irreducible over Q.
fn quadratic(ak: &QPoly, dk: &QPoly, x: &Expr) -> Expr {
    let (p, q) = (dk.coeff(1), dk.coeff(0));
    let (r, s) = (ak.coeff(1), ak.coeff(0));
    let two = Q::from_integer(BigInt::from(2));
    let four = Q::from_integer(BigInt::from(4));
    let mut out = vec![];
    if !r.is_zero() {
        out.push(mul2(&qnum(&r / &two), &log(&prim(dk, x))));
    }
    // what is left: t / (x^2 + p x + q)
    let t = &s - &r * &p / &two;
    if t.is_zero() {
        return add(out);
    }
    let disc = &p * &p - &four * &q;
    let lin = add2(&mul2(&int(2), x), &qnum(p.clone())); // 2x + p
    if disc.is_negative() {
        // 2 t / sqrt(-disc) * atan((2x + p)/sqrt(-disc))
        let sd = sqrt(&qnum(-disc));
        out.push(mul(vec![qnum(&t * &two), recip(&sd), fun1(Fun::Atan, &div(&lin, &sd))]));
    } else {
        // t / sqrt(disc) * log((2x + p - sqrt(disc))/(2x + p + sqrt(disc)))
        let sd = sqrt(&qnum(disc));
        let arg = div(&sub(&lin, &sd), &add2(&lin, &sd));
        out.push(mul(vec![qnum(t), recip(&sd), log(&arg)]));
    }
    add(out)
}

/// sum over the roots c of res_x(d, a - t d') of c log(gcd(d, a - c d')),
/// when the roots are rational.
fn rothstein_trager(a: &QPoly, d: &QPoly, x: &Expr) -> Option<Expr> {
    let n = d.deg() as usize;
    let dd = d.derivative();
    // the resultant has degree <= n in t: interpolate it from n + 1 values
    let pts: Vec<Q> = (0..=n).map(|k| Q::from_integer(BigInt::from(k as i64))).collect();
    let vals: Vec<Q> = pts.iter().map(|t| d.resultant(&a.sub(&dd.scale(t)))).collect();
    let rt = interpolate(&pts, &vals);
    let mut out = vec![];
    for (f, _) in rt.factor() {
        if f.deg() != 1 {
            return None;
        }
        let c = -f.coeff(0) / f.coeff(1);
        let v = d.gcd(&a.sub(&dd.scale(&c)));
        if v.deg() > 0 {
            out.push(mul2(&qnum(c), &log(&prim(&v, x))));
        }
    }
    Some(add(out))
}

/// The polynomial through (x_i, y_i) (Lagrange).
fn interpolate(xs: &[Q], ys: &[Q]) -> QPoly {
    let mut acc = QPoly::zero();
    for (i, (xi, yi)) in xs.iter().zip(ys).enumerate() {
        if yi.is_zero() {
            continue;
        }
        let mut basis = QPoly::one();
        let mut denom = Q::one();
        for (j, xj) in xs.iter().enumerate() {
            if j != i {
                basis = basis.mul(&QPoly::new(vec![-xj.clone(), Q::one()]));
                denom *= xi - xj;
            }
        }
        acc = acc.add(&basis.scale(&(yi / denom)));
    }
    acc
}
