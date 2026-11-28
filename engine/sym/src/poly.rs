//! Expressions as polynomials: coefficients in one variable (with
//! symbolic coefficients), degrees, and rational univariate polynomials
//! for factoring and gcds.

use crate::err::value_error;
use crate::expand::expand;
use crate::expr::*;
use crate::num::Q;
use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;

/// The power of x in a term: x^k * rest with rest free of x (None if the
/// term is not of that form, like sin(x) or x^(1/2)).
fn term_power(t: &Expr, x: &str) -> Option<(i64, Expr)> {
    let dep = |e: &Expr| crate::diff::depends(e, x);
    if !dep(t) {
        return Some((0, t.clone()));
    }
    match &t.kind {
        Kind::Sym(s) if &**s == x => Some((1, one())),
        Kind::Pow(b, n) if b.as_sym() == Some(x) => n.as_i64().filter(|k| *k >= 0).map(|k| (k, one())),
        Kind::Mul(v) => {
            let mut k: i64 = 0;
            let mut rest = vec![];
            for f in v {
                if dep(f) {
                    let (j, r) = term_power(f, x)?;
                    if !r.is_one() {
                        return None;
                    }
                    k = k.checked_add(j)?; // (past i64: not a polynomial this represents)
                } else {
                    rest.push(f.clone());
                }
            }
            Some((k, mul(rest)))
        }
        _ => None,
    }
}

/// The nonzero coefficients of e (expanded) as a polynomial in x, by power;
/// None if e is not a polynomial in x.  Sparse: x^(2^62) is one entry.
pub fn sparse_coeffs(e: &Expr, x: &str) -> Option<std::collections::BTreeMap<i64, Expr>> {
    let ex = expand(e);
    let terms = match &ex.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![ex.clone()],
    };
    let mut by: std::collections::BTreeMap<i64, Vec<Expr>> = std::collections::BTreeMap::new();
    for t in terms {
        let (k, r) = term_power(&t, x)?;
        by.entry(k).or_default().push(r);
    }
    Some(by.into_iter().map(|(k, v)| (k, add(v))).filter(|(_, c)| !c.is_zero()).collect())
}

/// The coefficients of e (expanded) as a polynomial in x, constant term
/// first; None if e is not a polynomial in x.  The dense list has degree + 1
/// entries: one that cannot be held (x^(2^62)) is Sage's MemoryError, not a
/// capacity panic.
pub fn coeffs(e: &Expr, x: &str) -> Option<Vec<Expr>> {
    let sp = sparse_coeffs(e, x)?;
    let top = sp.keys().next_back().copied().unwrap_or(0);
    let len = usize::try_from(top).ok().and_then(|t| t.checked_add(1));
    let mut c: Vec<Expr> = vec![];
    if len.is_none_or(|n| c.try_reserve_exact(n).is_err()) {
        crate::err::memory_error(format!("a polynomial of degree {} in {} has too many coefficients to hold", top, x));
    }
    for (k, a) in sp {
        while (c.len() as i64) < k {
            sagebrush_interrupt::check();
            c.push(zero());
        }
        c.push(a);
    }
    if c.is_empty() {
        c.push(zero());
    }
    Some(c)
}

/// Sage's degree(x): the largest power of x.
pub fn degree(e: &Expr, x: &str) -> i64 {
    // (sparse: the degree of x^(2^62) needs no dense list)
    match sparse_coeffs(e, x) {
        Some(c) => c.keys().next_back().copied().unwrap_or(-1),
        None => value_error(format!("{} is not a polynomial in {}", crate::to_string(e), x)),
    }
}

/// Sage's coefficient(x, n).
pub fn coefficient(e: &Expr, x: &str, n: i64) -> Expr {
    match coeffs(e, x) {
        Some(c) => c.get(n as usize).cloned().unwrap_or_else(zero),
        None => value_error(format!("{} is not a polynomial in {}", crate::to_string(e), x)),
    }
}

/// From coefficients (constant term first) to an expression.
pub fn from_coeffs(c: &[Expr], x: &Expr) -> Expr {
    add(c.iter().enumerate().map(|(k, a)| mul2(a, &pow(x, &int(k as i64)))).collect())
}

/// e as a polynomial in x with rational coefficients, if it is one.
pub fn rational_coeffs(e: &Expr, x: &str) -> Option<Vec<Q>> {
    coeffs(e, x)?.iter().map(|c| c.as_rat().cloned()).collect()
}

/// Rational coefficients as (content, primitive integer polynomial).
pub fn to_zpoly(c: &[Q]) -> (Q, Vec<BigInt>) {
    let mut den = BigInt::one();
    for q in c {
        den = num_integer::lcm(den, q.denom().clone());
    }
    let ints: Vec<BigInt> = c.iter().map(|q| (q * Q::from_integer(den.clone())).to_integer()).collect();
    let mut g = BigInt::zero();
    for v in &ints {
        g = num_integer::gcd(g, v.clone());
    }
    if g.is_zero() {
        return (Q::zero(), vec![]);
    }
    // positive leading coefficient in the primitive part
    if ints.last().map_or(false, |l| l < &BigInt::zero()) {
        g = -g;
    }
    let prim: Vec<BigInt> = ints.iter().map(|v| v / &g).collect();
    (Q::new(g, den), prim)
}

pub fn zpoly_expr(p: &[BigInt], x: &Expr) -> Expr {
    add(p.iter().enumerate().map(|(k, a)| mul2(&big(a.clone()), &pow(x, &int(k as i64)))).collect())
}
