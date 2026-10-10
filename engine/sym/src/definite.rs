//! Definite integrals: F(b) - F(a) for an antiderivative F is the
//! integral only if f has no nonintegrable singularity in
//! (a, b) and F is continuous there; a locally correct antiderivative
//! establishes neither (Astra's audits: 1/cos(x)^2 on [0, pi] gave 0;
//! 1/(2 + cos(x)) on [0, 2 pi] gave 0, F jumping at pi; the derivative of
//! 1/log(1 + 10^6 (x - 1/3)^2) on [0, 1] gave a finite value, its pole
//! missed by a numerical scan).  Only what is established decides:
//!
//! - Where f and F are built from functions continuous on the whole line
//!   (polynomials, exp, sin, cos, atan, ...), F(b) - F(a) directly.
//! - Otherwise the singular points of f and F in (a, b) (zeros of
//!   denominators, of fractional-power bases and logarithm arguments; poles
//!   of tan, cot, sec, csc) must be known exactly: real roots of polynomials
//!   by Sturm sequences (exact for factors of degree <= 2), zeros of
//!   c + k cos(u), c + k sin(u), c + k exp(u), c + k log(u) (u linear for the
//!   trigonometric ones) in closed form, and any other denominator certified
//!   nonzero on [a, b] by interval arithmetic.  A singular point that is not
//!   known exactly, or a denominator that cannot be certified, leaves the
//!   integral unevaluated: a numerical search that finds nothing proves
//!   nothing.
//! - Divergence is proven, not estimated: a real pole of a rational f (in
//!   lowest terms), or an infinite one-sided limit of F at a singular point
//!   or a bound (F' = f on each piece, so F is unbounded there exactly when
//!   the integral diverges).  Otherwise the value is the sum of the
//!   one-sided limits of F over the pieces between the singular points.
//! - The value must be real for a real f and agree with adaptive
//!   Gauss-Kronrod quadrature, which must succeed when there are singular
//!   points: a check that rejects answers (it proves nothing).
//!
//! What the conclusions rest on: f and F real on (a, b), established
//! (crate::domain); F' = f is checked by integrate(), exactly when
//! simplification shows it, otherwise at fixed points off the real axis and
//! on it (strong evidence for an identity of analytic functions, not a
//! proof); the limits are the limit engine's, whose signs near a point are
//! established, not sampled; interval enclosures assume LIBM below.
//!
//! Bounds and singular points are placed by certified enclosures (or
//! exactly, when rational): ordered when their enclosures are disjoint,
//! equal when their difference simplifies to zero, otherwise undecided
//! (Unknown).  Floats only propose candidates (the fifth review: merging
//! points within 1e-12 of each other lost a pole at pi/2 + 10^-14, V2; the
//! double of sin(10^20 + 1) has the wrong sign, V3).  The interval arithmetic rounds
//! outward by a few units in the last place beyond the platform's exp, log,
//! sin and cos, which are assumed correct to within that.

use crate::diff::depends;
use crate::eval::to_c64_env;
use crate::expr::*;
use crate::num::Q;
use crate::qpoly::QPoly;
use crate::interval::{certified_nonzero, encl, tight, Iv};
use num_traits::{Signed, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

pub enum Outcome {
    Value(Expr),
    Divergent,
    /// could not be established: leave the integral unevaluated
    Unknown,
}

/// A bound: a value (+-inf allowed) inside a certified enclosure, and, if
/// rational, exactly.
struct Bound {
    v: f64,
    iv: Iv,
    q: Option<Q>,
}

/// None if the bound cannot be placed (no narrow certified enclosure).
fn bound(e: &Expr) -> Option<Bound> {
    if e.is_const(Const::Infinity) {
        return Some(Bound { v: f64::INFINITY, iv: Iv(f64::INFINITY, f64::INFINITY), q: None });
    }
    if e.is_const(Const::MinusInfinity) {
        return Some(Bound { v: f64::NEG_INFINITY, iv: Iv(f64::NEG_INFINITY, f64::NEG_INFINITY), q: None });
    }
    let v = tight(e)?;
    Some(Bound { v, iv: encl(e)?, q: e.as_rat().cloned() })
}

/// The order of two exact real values with enclosures: exactly for
/// rationals, by disjoint enclosures, or equal when b - a simplifies to 0.
fn cmp_exact(a: &Expr, ia: Iv, qa: Option<&Q>, b: &Expr, ib: Iv, qb: Option<&Q>) -> Option<Ordering> {
    if let (Some(p), Some(q)) = (qa, qb) {
        return Some(p.cmp(q));
    }
    if ia.1 < ib.0 {
        return Some(Ordering::Less);
    }
    if ia.0 > ib.1 {
        return Some(Ordering::Greater);
    }
    if a == b || crate::simplify::simplify_full(&sub(b, a)).is_zero() {
        return Some(Ordering::Equal);
    }
    None
}

/// The order of two bounds, when it is established.
fn order(a: &Expr, ba: &Bound, b: &Expr, bb: &Bound) -> Option<Ordering> {
    if ba.v.is_infinite() || bb.v.is_infinite() {
        return ba.v.partial_cmp(&bb.v).filter(|_| ba.v != bb.v || a == b);
    }
    cmp_exact(a, ba.iv, ba.q.as_ref(), b, bb.iv, bb.q.as_ref())
}

fn q_from_f64(x: f64) -> Q {
    if x == 0.0 {
        return Q::zero();
    }
    let bits = x.to_bits();
    let sign = if bits >> 63 == 0 { 1i64 } else { -1 };
    let exp = ((bits >> 52) & 0x7ff) as i64;
    let mant = if exp == 0 { (bits & 0xf_ffff_ffff_ffff) << 1 } else { (bits & 0xf_ffff_ffff_ffff) | 0x10_0000_0000_0000 };
    let e = exp - 1075;
    let m = BigInt::from(sign) * BigInt::from(mant);
    if e >= 0 {
        Q::from_integer(m * num_traits::pow(BigInt::from(2), e as usize))
    } else {
        Q::new(m, num_traits::pow(BigInt::from(2), (-e) as usize))
    }
}

/// f at a real point (None if it cannot be evaluated or is not finite).
fn at(f: &Expr, x: &str, t: f64) -> Option<(f64, f64)> {
    let v = to_c64_env(f, &|s| if s == x { Some((t, 0.0)) } else { None })?;
    (v.0.is_finite() && v.1.is_finite()).then_some(v)
}

// ------------------------------------------------------------------ singular points

/// A singular point, exactly (approximate ones are not kept: they could
/// not be used).
struct Pt {
    v: f64,
    iv: Iv,
    e: Expr,
}

#[derive(Default)]
struct Scan {
    points: Vec<Pt>,
    /// a singular point that is not known exactly, or an uncertified
    /// denominator: the analysis is not exhaustive
    unknown: bool,
}

/// u = a x + b with real constants a != 0: (a, b) exactly.
fn linear(u: &Expr, x: &str) -> Option<(Expr, Expr)> {
    let c = crate::poly::coeffs(u, x)?;
    if c.len() != 2 || depends(&c[0], x) || depends(&c[1], x) {
        return None;
    }
    // (placed by certified enclosures: a candidate zero is only proposed
    // by these doubles, but none may be missed)
    let av = tight(&c[1])?;
    (av != 0.0 && encl(&c[1]).is_some_and(|i| !i.contains_zero()) && tight(&c[0]).is_some()).then(|| (c[1].clone(), c[0].clone()))
}

/// A candidate point e of (lo, hi): kept if inside, dropped if outside or
/// at a bound, unknown if that cannot be told (by its certified enclosure
/// against the bounds', or exact equality with a bound).
fn keep(e: Expr, b: &Bounds, out: &mut Scan) {
    let (Some(t), Some(iv)) = (tight(&e), encl(&e)) else {
        out.unknown = true;
        return;
    };
    let q = e.as_rat().cloned();
    let mut inside = true;
    for (k, (bv, biv, be, bq)) in [(b.lo, b.la, &b.a, &b.qa), (b.hi, b.lb, &b.b, &b.qb)].into_iter().enumerate() {
        if !bv.is_finite() {
            continue;
        }
        match cmp_exact(&e, iv, q.as_ref(), be, biv, bq.as_ref()) {
            Some(Ordering::Equal) => return, // at a bound
            Some(o) => inside &= o == if k == 0 { Ordering::Greater } else { Ordering::Less },
            None => {
                out.unknown = true;
                return;
            }
        }
    }
    if inside {
        out.points.push(Pt { v: t, iv, e });
    }
}

/// The bounds of the interval, as values and exactly.
struct Bounds {
    lo: f64,
    hi: f64,
    /// certified enclosures of a and b
    la: Iv,
    lb: Iv,
    a: Expr,
    b: Expr,
    qa: Option<Q>,
    qb: Option<Q>,
}

/// The x in (lo, hi) with a x + b = c + 2 k pi for one of the given c.
fn periodic(u: &Expr, x: &str, cs: &[Expr], bd: &Bounds, out: &mut Scan) -> bool {
    let Some((a, b)) = linear(u, x) else { return false };
    let (av, bv) = (tight(&a).unwrap(), tight(&b).unwrap());
    if !bd.lo.is_finite() || !bd.hi.is_finite() {
        out.unknown = true; // infinitely many
        return true;
    }
    let tau = 2.0 * std::f64::consts::PI;
    let (u1, u2) = { let (p, q) = (av * bd.lo + bv, av * bd.hi + bv); (p.min(q), p.max(q)) };
    // a phase too large for floats to tell its zeros apart (cos(x + 10^20),
    // the third review's T3: the index cast saturated and the range came out
    // empty) is not analysed
    if !(u1.abs().max(u2.abs()) < 1e9) || (u2 - u1) / tau > 10_000.0 {
        out.unknown = true;
        return true;
    }
    for c in cs {
        let Some(cv) = tight(c).filter(|v| v.abs() < 1e9) else {
            out.unknown = true;
            return true;
        };
        // (|k| < 10^9: no overflow in k or 2 k)
        let (k0, k1) = (((u1 - cv) / tau).floor() as i64 - 1, ((u2 - cv) / tau).ceil() as i64 + 1);
        for k in k0..=k1 {
            let e = div(&sub(&add(vec![c.clone(), mul(vec![int(2 * k), pi()])]), &b), &a);
            keep(e, bd, out);
        }
    }
    true
}

/// The zeros of cos(u) - t (or sin(u) - t), t a real constant, u linear.
fn trig_eq(sine: bool, u: &Expr, t: &Expr, x: &str, bd: &Bounds, out: &mut Scan) -> bool {
    let Some(tv) = tight(t) else { return false };
    if tv.abs() > 1.0 + 1e-12 {
        return linear(u, x).is_some();
    }
    if tv.abs() > 1.0 - 1e-12 && t.as_rat().is_none() {
        return false; // |t| = 1 or not: undecided
    }
    let cs = if sine {
        let s = fun1(Fun::Asin, t);
        vec![s.clone(), sub(&pi(), &s)]
    } else {
        let c = fun1(Fun::Acos, t);
        vec![c.clone(), neg(&c)]
    };
    periodic(u, x, &cs, bd, out)
}

/// The real roots of a polynomial in (lo, hi): counted exactly (Sturm),
/// exact for factors of degree at most 2; others make the scan unknown.
fn poly_roots(p: &QPoly, bd: &Bounds, out: &mut Scan) {
    let rb = p.root_bound();
    // an irrational bound by the ends of its enclosure: the count between
    // the inner ends and between the outer ends agree, or a root may lie
    // between the bound and its approximations
    let end = |q: &Option<Q>, v: f64, iv: f64, inf: &Q| match (q, v.is_finite()) {
        (Some(q), _) => q.clone(),
        (None, true) => q_from_f64(iv),
        _ => inf.clone(),
    };
    let (lq, hq) = (end(&bd.qa, bd.lo, bd.la.1, &-rb.clone()), end(&bd.qb, bd.hi, bd.lb.0, &rb));
    let (lo2, hi2) = (end(&bd.qa, bd.lo, bd.la.0, &-rb.clone()), end(&bd.qb, bd.hi, bd.lb.1, &rb));
    if lq >= hq {
        out.unknown = true;
        return;
    }
    for (fac, _) in p.factor() {
        if fac.deg() < 1 {
            continue;
        }
        let n = fac.count_real_roots(&lq, &hq);
        if fac.count_real_roots(&lo2, &hi2) != n {
            out.unknown = true; // a root within the margin of an irrational bound
        }
        if n == 0 {
            continue;
        }
        if fac.deg() > 2 {
            out.unknown = true; // not known exactly
            continue;
        }
        let roots: Vec<Expr> = if fac.deg() == 1 {
            vec![qnum(-fac.coeff(0) / fac.coeff(1))]
        } else {
            let (a, b, c) = (fac.coeff(2), fac.coeff(1), fac.coeff(0));
            let d = sqrt(&qnum(&b * &b - Q::from_integer(BigInt::from(4)) * &a * &c));
            let two_a = qnum(Q::from_integer(BigInt::from(2)) * &a);
            vec![div(&sub(&neg(&qnum(b.clone())), &d), &two_a), div(&add2(&neg(&qnum(b.clone())), &d), &two_a)]
        };
        let before = out.points.len();
        for e in roots {
            keep(e, bd, out);
        }
        if out.points.len() - before != n {
            out.unknown = true;
        }
    }
}

/// The singular points of e on (lo, hi).
fn scan(e: &Expr, x: &str, bd: &Bounds, out: &mut Scan) {
    if !depends(e, x) {
        return;
    }
    // the facts below are about real arguments: a function of a complex one
    // (cosh(I x) = cos(x) vanishes) is not analysed (the third review's T2)
    if complex_argument(e, x) {
        out.unknown = true;
        return;
    }
    match &e.kind {
        Kind::Pow(b, n) if depends(b, x) && !n.as_rat().map_or(false, |r| r.is_integer() && !r.is_negative()) => {
            // a negative or fractional power: the zeros of its base
            zeros(b, x, bd, out);
        }
        Kind::Pow(b, _) if !depends(b, x) && !b.is_const(Const::E) && !encl(b).is_some_and(|i| i.0 > 0.0) => {
            out.unknown = true; // c^u, c not positive
        }
        Kind::Fun(f, a) => match f {
            Fun::Tan | Fun::Sec => zeros(&fun1(Fun::Cos, &a[0]), x, bd, out),
            Fun::Cot | Fun::Csc => zeros(&fun1(Fun::Sin, &a[0]), x, bd, out),
            Fun::Log => zeros(&a[0], x, bd, out),
            Fun::Sin | Fun::Cos | Fun::Atan | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Abs | Fun::Asinh | Fun::Erf => {}
            // asin, acos: branch points where the argument is +-1
            Fun::Asin | Fun::Acos => {
                zeros(&sub(&a[0], &int(1)), x, bd, out);
                zeros(&add2(&a[0], &int(1)), x, bd, out);
            }
            _ => out.unknown = true,
        },
        _ => {}
    }
    for t in e.children().iter() {
        scan(t, x, bd, out);
    }
}

/// The zeros of b on (lo, hi), exactly, or b certified nonzero there.
fn zeros(b: &Expr, x: &str, bd: &Bounds, out: &mut Scan) {
    if !depends(b, x) {
        return;
    }
    if contains_i(b) {
        out.unknown = true; // complex-valued: the zero sets below are real ones
        return;
    }
    if let Some(p) = QPoly::from_expr(b, x) {
        return poly_roots(&p, bd, out);
    }
    match &b.kind {
        Kind::Mul(v) => {
            for t in v {
                zeros(t, x, bd, out);
            }
            return;
        }
        Kind::Pow(base, _) if base.is_const(Const::E) => return, // e^u is never 0
        Kind::Pow(base, n) if n.as_rat().map_or(false, |r| !r.is_zero()) => return zeros(base, x, bd, out),
        Kind::Fun(Fun::Cos, a) if trig_eq(false, &a[0], &int(0), x, bd, out) => return,
        Kind::Fun(Fun::Sin, a) if trig_eq(true, &a[0], &int(0), x, bd, out) => return,
        // log(u) = 0 where u = 1
        Kind::Fun(Fun::Log, a) => return zeros(&sub(&a[0], &int(1)), x, bd, out),
        // sec, csc never vanish (their poles are scan's); tan = 0 where sin = 0
        Kind::Fun(Fun::Cosh | Fun::Sec | Fun::Csc, _) => return,
        Kind::Fun(Fun::Tan, a) => return zeros(&fun1(Fun::Sin, &a[0]), x, bd, out),
        Kind::Fun(Fun::Cot, a) => return zeros(&fun1(Fun::Cos, &a[0]), x, bd, out),
        Kind::Add(v) => {
            // c + k f(u): f(u) = -c/k for f = cos, sin (u linear), exp, log
            let (consts, rest): (Vec<&Expr>, Vec<&Expr>) = v.iter().partition(|t| !depends(t, x));
            if rest.len() == 1 {
                let (k, t) = split_coeff(rest[0]);
                let c = add(consts.into_iter().cloned().collect());
                let target = neg(&div(&c, &num(k)));
                match &t.kind {
                    Kind::Fun(g @ (Fun::Cos | Fun::Sin), a) if trig_eq(*g == Fun::Sin, &a[0], &target, x, bd, out) => return,
                    Kind::Pow(e, u) if e.is_const(Const::E) => {
                        match encl(&target) {
                            Some(tv) if tv.1 < 0.0 || target.is_zero() => return, // e^u > 0
                            Some(tv) if tv.0 > 0.0 => return zeros(&sub(u, &log(&target)), x, bd, out),
                            _ => {}
                        }
                    }
                    Kind::Fun(Fun::Log, a) => return zeros(&sub(&a[0], &exp(&target)), x, bd, out),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    // over a common denominator (tan, sec, ... as sin and cos): the zeros are
    // the numerator's (the denominator's are poles, which scan finds)
    let (nu, de) = crate::simplify::together(&crate::simplify::trig_to_sincos(b));
    if depends(&de, x) && nu != *b {
        return zeros(&nu, x, bd, out);
    }
    if !certified_nonzero(b, x, bd.lo, bd.hi) {
        out.unknown = true;
    }
}

// ------------------------------------------------------------------ quadrature

const GK_X: [f64; 8] = [0.991455371120812639, 0.949107912342758525, 0.864864423359769073, 0.741531185599394440, 0.586087235467691130, 0.405845151377397167, 0.207784955007898468, 0.0];
const GK_WK: [f64; 8] = [0.022935322010529225, 0.063092092629978553, 0.104790010322250184, 0.140653259715525919, 0.169004726639267903, 0.190350578064785410, 0.204432940075298892, 0.209482141084727828];
const GK_WG: [f64; 4] = [0.129484966168869693, 0.279705391489276668, 0.381830050505118945, 0.417959183673469388];

fn gk15(g: &dyn Fn(f64) -> Option<f64>, a: f64, b: f64) -> Option<(f64, f64)> {
    let (c, h) = ((a + b) / 2.0, (b - a) / 2.0);
    let fc = g(c)?;
    let (mut k, mut gs) = (GK_WK[7] * fc, GK_WG[3] * fc);
    for i in 0..7 {
        let (f1, f2) = (g(c - h * GK_X[i])?, g(c + h * GK_X[i])?);
        k += GK_WK[i] * (f1 + f2);
        if i % 2 == 1 {
            gs += GK_WG[i / 2] * (f1 + f2);
        }
    }
    Some((k * h, ((k - gs) * h).abs()))
}

/// Adaptive Gauss-Kronrod on [a, b]: (value, error estimate), or None if g
/// cannot be evaluated somewhere.
fn quad(g: &dyn Fn(f64) -> Option<f64>, a: f64, b: f64) -> Option<(f64, f64)> {
    let mut todo = vec![(a, b, gk15(g, a, b)?)];
    let mut done: Vec<(f64, f64)> = vec![];
    let mut steps = 0;
    while let Some((l, r, (v, err))) = todo.pop() {
        steps += 1;
        let total: f64 = todo.iter().map(|t| t.2 .0).chain(done.iter().map(|d| d.0)).sum::<f64>() + v;
        if err <= 1e-11 * (1.0 + total.abs()) || steps > 4000 || (r - l).abs() < 1e-13 * (1.0 + l.abs()) {
            done.push((v, err));
            continue;
        }
        sagebrush_interrupt::check();
        let m = (l + r) / 2.0;
        todo.push((l, m, gk15(g, l, m)?));
        todo.push((m, r, gk15(g, m, r)?));
    }
    Some((done.iter().map(|d| d.0).sum(), done.iter().map(|d| d.1).sum()))
}

/// The integral of f over (lo, hi) numerically, split at the given
/// points, infinite bounds mapped to finite ones; None if f is not real or
/// cannot be evaluated.  A point where f cannot be evaluated (a removable
/// singularity hit exactly) takes the mean of nearby values.
fn numeric(f: &Expr, x: &str, lo: f64, hi: f64, cuts: &[f64]) -> Option<(f64, f64)> {
    let real1 = |t: f64| at(f, x, t).and_then(|v| (v.1.abs() <= 1e-10 * (1.0 + v.0.abs())).then_some(v.0));
    let real = |t: f64| {
        real1(t).or_else(|| {
            let h = 1e-9 * (1.0 + t.abs());
            Some((real1(t - h)? + real1(t + h)?) / 2.0)
        })
    };
    let piece = |a: f64, b: f64| -> Option<(f64, f64)> {
        match (a.is_finite(), b.is_finite()) {
            (true, true) => quad(&real, a, b),
            (true, false) => quad(&|t: f64| real(a + t / (1.0 - t)).map(|v| v / ((1.0 - t) * (1.0 - t))), 0.0, 1.0),
            (false, true) => quad(&|t: f64| real(b - t / (1.0 - t)).map(|v| v / ((1.0 - t) * (1.0 - t))), 0.0, 1.0),
            (false, false) => quad(&|t: f64| real(t / (1.0 - t * t)).map(|v| v * (1.0 + t * t) / ((1.0 - t * t) * (1.0 - t * t))), -1.0, 1.0),
        }
    };
    let mut pts = vec![lo];
    pts.extend(cuts.iter().copied().filter(|&c| c > lo && c < hi));
    pts.push(hi);
    let (mut v, mut err) = (0.0, 0.0);
    for w in pts.windows(2) {
        let (pv, pe) = piece(w[0], w[1])?;
        v += pv;
        err += pe;
    }
    Some((v, err))
}

/// A function or power of an argument that depends on x and is complex.
fn complex_argument(e: &Expr, x: &str) -> bool {
    match &e.kind {
        Kind::Fun(_, a) => a.iter().any(|t| depends(t, x) && contains_i(t)),
        Kind::Pow(b, n) => (depends(b, x) || depends(n, x)) && (contains_i(b) || contains_i(n)),
        _ => false,
    }
}

fn contains_i(e: &Expr) -> bool {
    let complex = match &e.kind {
        Kind::Num(crate::num::Num::Exact(_, im)) => !im.is_zero(),
        Kind::Num(crate::num::Num::Float(_, im)) => *im != 0.0,
        _ => false,
    };
    complex || e.children().iter().any(contains_i)
}

// ------------------------------------------------------------------ the integral

/// The definite integral of f from a to b, given an antiderivative F.
pub fn definite(f: &Expr, big_f: &Expr, x: &str, a: &Expr, b: &Expr, has_bad: &dyn Fn(&Expr) -> bool) -> Outcome {
    let continuous = !has_singular_parts(f, x) && !has_singular_parts(big_f, x);
    let (Some(ba), Some(bb)) = (bound(a), bound(b)) else {
        // symbolic bounds: F(b) - F(a) holds when f and F are continuous everywhere
        return if continuous { endpoints(big_f, x, a, b, has_bad) } else { Outcome::Unknown };
    };
    match order(a, &ba, b, &bb) {
        None => return Outcome::Unknown,
        Some(Ordering::Equal) => return Outcome::Value(int(0)),
        Some(Ordering::Greater) => {
            return match definite(f, big_f, x, b, a, has_bad) {
                Outcome::Value(v) => Outcome::Value(neg(&v)),
                o => o,
            }
        }
        Some(Ordering::Less) => {}
    }
    if continuous {
        if !derivative_holds_on(f, big_f, x, ba.v, bb.v, &[]) {
            return Outcome::Unknown;
        }
        return checked_real(f, endpoints(big_f, x, a, b, has_bad));
    }
    let (lo, hi) = (ba.v, bb.v);
    if !(lo < hi) {
        return Outcome::Unknown; // distinct, but not as floats
    }
    let bd = Bounds { lo, hi, la: ba.iv, lb: bb.iv, a: a.clone(), b: b.clone(), qa: ba.q.clone(), qb: bb.q.clone() };
    // a rational f with a real pole inside diverges (in lowest terms, f is
    // c (x - r)^-m near a root r of its denominator, m >= 1)
    let (nu, de) = crate::simplify::together(f);
    if let (Some(pn), Some(pd)) = (QPoly::from_expr(&nu, x), QPoly::from_expr(&de, x)) {
        if pd.deg() > 0 {
            let red = pd.div_exact(&pd.gcd(&pn));
            let mut s = Scan::default();
            poly_roots(&red, &bd, &mut s);
            if !s.points.is_empty() || (s.unknown && real_root_inside(&red, &bd)) {
                return Outcome::Divergent;
            }
        }
    }
    // the real-only facts below need f real on (a, b), and F real but for
    // logarithms and fractional powers of real arguments (log(x - sqrt(2))
    // on [-1, 1] is complex but continuous, crossing its cut only at its
    // argument's zeros, which are cut points), established: 1/(x
    // cosh(log(-x)/2)^2) is complex there with no I in sight (the fourth
    // review's U3)
    if !real_on(f, x, &bd) || !real_args(big_f, x, &bd) {
        return Outcome::Unknown;
    }
    // the singular points of f and F, all known exactly
    let mut s = Scan::default();
    scan(f, x, &bd, &mut s);
    scan(big_f, x, &bd, &mut s);
    if s.unknown {
        return Outcome::Unknown;
    }
    // ordered by disjoint enclosures, merged only when equal exactly
    let mut cuts = s.points;
    cuts.sort_by(|p, q| p.v.partial_cmp(&q.v).unwrap());
    let mut merged: Vec<Pt> = vec![];
    for p in cuts {
        if let Some(last) = merged.last() {
            match cmp_exact(&last.e, last.iv, last.e.as_rat(), &p.e, p.iv, p.e.as_rat()) {
                Some(Ordering::Equal) => continue,
                Some(Ordering::Less) => {}
                _ => return Outcome::Unknown,
            }
        }
        merged.push(p);
    }
    let cuts = merged;
    let qcuts: Vec<f64> = cuts.iter().map(|p| p.v).collect();
    let mut pts: Vec<Expr> = vec![a.clone()];
    pts.extend(cuts.into_iter().map(|p| p.e));
    pts.push(b.clone());
    // F' = f on the interval itself, not only where integrate() checked it
    // (fixed points off the real axis and on it: across a branch cut the
    // identity can hold in one place and not another): exactly, or at
    // points inside each piece
    if !derivative_holds_on(f, big_f, x, lo, hi, &qcuts) {
        return Outcome::Unknown;
    }
    // F on each piece, by one-sided limits (infinite: divergent)
    let mut terms = vec![];
    for w in pts.windows(2) {
        match endpoints(big_f, x, &w[0], &w[1], has_bad) {
            Outcome::Value(v) => terms.push(v),
            o => return o,
        }
    }
    let r = add(terms);
    let s2 = crate::simplify::simplify_rational(&r);
    let r = if crate::simplify::size(&s2) <= crate::simplify::size(&r) { s2 } else { r };
    // checks: real, and agreeing with quadrature (which must succeed)
    let Some(val) = crate::eval::to_c64(&r) else { return Outcome::Unknown };
    if !contains_i(f) && val.1.abs() > 1e-9 * (1.0 + val.0.abs()) {
        return Outcome::Unknown;
    }
    match numeric(f, x, lo, hi, &qcuts) {
        Some((q, err)) if err < 1e-6 * (1.0 + q.abs()) => {
            if (val.0 - q).abs() > 1e-7 * (1.0 + q.abs()) + 100.0 * err {
                return Outcome::Unknown;
            }
        }
        _ if !qcuts.is_empty() => return Outcome::Unknown,
        _ => {}
    }
    Outcome::Value(r)
}

/// Whether e is real on (a, b): by its form, with the arguments of logarithms
/// and fractional powers positive there (positive_on).
fn real_on(e: &Expr, x: &str, bd: &Bounds) -> bool {
    crate::domain::real_with(e, x, &|u| positive_on(u, x, bd))
}

/// Sums and products of real expressions and of logarithms and fractional
/// powers of real arguments (any sign): continuous on (a, b) except where
/// those arguments vanish or have poles.
fn real_args(e: &Expr, x: &str, bd: &Bounds) -> bool {
    if !depends(e, x) {
        return true;
    }
    match &e.kind {
        Kind::Add(v) | Kind::Mul(v) => v.iter().all(|t| real_args(t, x, bd)),
        Kind::Fun(Fun::Log, a) => real_on(&a[0], x, bd),
        Kind::Pow(b, n) if !depends(n, x) && !b.is_const(Const::E) && crate::domain::real_const(n) => real_on(b, x, bd),
        _ => real_on(e, x, bd),
    }
}

/// u > 0 on (a, b) except at finitely many points known exactly (its zeros
/// and poles there, which are cut points anyway): u real there, and positive
/// at an inner point (an enclosure) of each piece between those points.
fn positive_on(u: &Expr, x: &str, bd: &Bounds) -> bool {
    if !real_on(u, x, bd) {
        return false;
    }
    let mut s = Scan::default();
    zeros(u, x, bd, &mut s);
    scan(u, x, bd, &mut s);
    if s.unknown {
        return false;
    }
    let mut pts: Vec<f64> = s.points.iter().map(|p| p.v).collect();
    pts.sort_by(|p, q| p.partial_cmp(q).unwrap());
    let mut ends = vec![bd.lo];
    ends.extend(pts);
    ends.push(bd.hi);
    ends.windows(2).all(|w| {
        let t = match (w[0].is_finite(), w[1].is_finite()) {
            (true, true) => w[0] + (w[1] - w[0]) / 2.0,
            (true, false) => w[0] + 1.0,
            (false, true) => w[1] - 1.0,
            (false, false) => 0.0,
        };
        crate::interval::ival(u, x, Iv(t, t)).map_or(false, |i| i.0 > 0.0)
    })
}

/// F' = f on (lo, hi): exactly (simplification), or numerically at three
/// points inside each piece between the cut points (real values; not a
/// proof, but on the interval in question).
fn derivative_holds_on(f: &Expr, big_f: &Expr, x: &str, lo: f64, hi: f64, cuts: &[f64]) -> bool {
    let z = sub(&crate::diff::diff(big_f, x), f);
    if z.is_zero() || crate::simplify::simplify_full(&z).is_zero() {
        return true;
    }
    let mut ends = vec![lo];
    ends.extend(cuts.iter().copied().filter(|&c| c > lo && c < hi));
    ends.push(hi);
    for w in ends.windows(2) {
        let ts: Vec<f64> = match (w[0].is_finite(), w[1].is_finite()) {
            (true, true) => [0.27, 0.5, 0.71].iter().map(|s| w[0] + (w[1] - w[0]) * s).collect(),
            (true, false) => [0.5, 3.0, 17.0].iter().map(|s| w[0] + s).collect(),
            (false, true) => [0.5, 3.0, 17.0].iter().map(|s| w[1] - s).collect(),
            (false, false) => vec![-2.3, 0.37, 4.1],
        };
        for t in ts {
            let (Some(zv), Some(fv)) = (at(&z, x, t), at(f, x, t)) else { return false };
            // relative (a scaled problem must not pass under an absolute floor)
            let scale = fv.0.hypot(fv.1) + 1e-9 * at(big_f, x, t).map_or(0.0, |v| v.0.hypot(v.1));
            if zv.0.hypot(zv.1) > 1e-7 * scale {
                return false;
            }
        }
    }
    true
}

/// Whether the polynomial has a real root strictly inside the interval
/// (a Sturm count with the bounds' exact values or inner margins).
fn real_root_inside(p: &QPoly, bd: &Bounds) -> bool {
    let rb = p.root_bound();
    let inner = |q: &Option<Q>, v: f64, iv: f64, inf: Q| match (q, v.is_finite()) {
        (Some(q), _) => q.clone(),
        (None, true) => q_from_f64(iv),
        _ => inf,
    };
    let (l, h) = (inner(&bd.qa, bd.lo, bd.la.1, -rb.clone()), inner(&bd.qb, bd.hi, bd.lb.0, rb));
    l < h && p.count_real_roots(&l, &h) > 0
}

/// A real f has a real integral: otherwise unknown.
fn checked_real(f: &Expr, o: Outcome) -> Outcome {
    if let Outcome::Value(v) = &o {
        if !contains_i(f) {
            if let Some(c) = crate::eval::to_c64(v) {
                if c.1.abs() > 1e-9 * (1.0 + c.0.abs()) {
                    return Outcome::Unknown;
                }
            }
        }
    }
    o
}

/// Whether e may be singular or discontinuous somewhere on the real line:
/// anything but sums, products, nonnegative integer powers and functions
/// continuous everywhere (exp, positive constants to a power, sin, cos,
/// atan, sinh, cosh, tanh, asinh, erf, abs).
fn has_singular_parts(e: &Expr, x: &str) -> bool {
    if !depends(e, x) {
        return false;
    }
    if complex_argument(e, x) {
        return true;
    }
    let own = match &e.kind {
        Kind::Sym(_) | Kind::Num(_) | Kind::Add(_) | Kind::Mul(_) => false,
        Kind::Pow(b, n) if depends(b, x) => !n.as_rat().map_or(false, |r| r.is_integer() && !r.is_negative()),
        Kind::Pow(b, _) => !(b.is_const(Const::E) || encl(b).is_some_and(|i| i.0 > 0.0)),
        Kind::Fun(Fun::Sin | Fun::Cos | Fun::Atan | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Asinh | Fun::Erf | Fun::Abs, _) => false,
        _ => true,
    };
    own || e.children().iter().any(|c| has_singular_parts(c, x))
}

/// F(b-) - F(a+): divergent if a one-sided limit is infinite (F' = f, so
/// F is unbounded there exactly when the integral diverges); unknown if a
/// limit cannot be found or is undefined.
fn endpoints(big_f: &Expr, x: &str, a: &Expr, b: &Expr, has_bad: &dyn Fn(&Expr) -> bool) -> Outcome {
    // (a limit not found may be found with tan, sec, ... as sin and cos)
    let lim = |pt: &Expr, dir| {
        crate::limit::try_limit(big_f, x, pt, dir).or_else(|_| crate::limit::try_limit(&crate::simplify::trig_to_sincos(big_f), x, pt, dir))
    };
    let (Ok(fb), Ok(fa)) = (lim(b, crate::limit::Dir::Minus), lim(a, crate::limit::Dir::Plus)) else {
        return Outcome::Unknown;
    };
    if fb.is_infinite() || fa.is_infinite() {
        return Outcome::Divergent;
    }
    if has_bad(&fb) || has_bad(&fa) {
        return Outcome::Unknown;
    }
    Outcome::Value(sub(&fb, &fa))
}

#[cfg(test)]
mod tests {
    use crate::parse::parse;

    /// Some(value), or None for unevaluated; "divergent" for the error.
    fn run(f: &str, a: &str, b: &str) -> String {
        match crate::catch(|| crate::integrate::definite(&parse(f), "x", &parse(a), &parse(b))) {
            Ok(Some(v)) => format!("{}", crate::eval::to_f64(&v).map_or(crate::to_string(&v), |v| format!("{:.12}", v))),
            Ok(None) => "unevaluated".into(),
            Err(e) => if format!("{:?}", e).contains("divergent") { "divergent".into() } else { format!("error {:?}", e) },
        }
    }

    fn exact(f: &str, a: &str, b: &str) -> String {
        match crate::catch(|| crate::integrate::definite(&parse(f), "x", &parse(a), &parse(b))) {
            Ok(Some(v)) => crate::to_string(&v),
            Ok(None) => "unevaluated".into(),
            Err(e) => format!("error {:?}", e),
        }
    }

    fn approx(f: &str, a: &str, b: &str, v: f64) {
        let r = run(f, a, b);
        let got: f64 = r.parse().unwrap_or_else(|_| panic!("integral of {} on [{}, {}]: {}", f, a, b, r));
        assert!((got - v).abs() < 1e-9 * (1.0 + v.abs()), "integral of {} on [{}, {}]: {} != {}", f, a, b, got, v);
    }

    #[test]
    fn divergent_integrals_are_errors() {
        for (f, a, b) in [
            ("1/cos(x)^2", "0", "pi"),
            ("1/x^2", "1", "-1"),
            ("1/x^2", "-1", "1"),
            ("1/(x^2 - 2)^2", "0", "2"),
            ("1/(x^3 - 2)", "0", "2"),
            ("x/(x^2 - 3)", "1", "2"),
            ("tan(x)", "0", "pi"),
            ("1/x", "0", "1"),
            ("1/(4 - x^2)", "-3", "3"),
            ("1/sin(x)", "1", "4"),
            ("1/(exp(x) - 1)", "-1", "1"),
            ("1/(x*log(x))", "1/2", "2"),
        ] {
            assert_eq!(run(f, a, b), "divergent", "integral of {} on [{}, {}]", f, a, b);
        }
    }

    #[test]
    fn narrow_poles_are_found_exactly() {
        // the second audit's R1: F has a double pole at 1/3, f = F' a triple one
        for big_f in ["1/log(1 + 10^6*(x - 1/3)^2)", "1/(1 - exp(-10^6*(x - 1/3)^2))", "1/log(1 + 10^12*(x - 1/3)^2)"] {
            let f = crate::to_string(&crate::diff::diff(&parse(big_f), "x"));
            let r = run(&f, "0", "1");
            assert!(r == "divergent" || r == "unevaluated", "derivative of {} on [0, 1]: {}", big_f, r);
        }
    }

    #[test]
    fn exact_bounds_are_compared_exactly() {
        // the second audit's R2: distinct bounds equal as floats
        assert_eq!(exact("1", "10^20", "10^20 + 1"), "1");
        assert_eq!(exact("x", "10^20", "10^20 + 1"), "200000000000000000001/2");
        assert_eq!(exact("1", "0", "1/10^400"), crate::to_string(&parse("1/10^400")));
        assert_eq!(exact("x", "1", "1 + 1/10^20"), crate::to_string(&parse("(1 + 1/10^20)^2/2 - 1/2")));
        assert_eq!(exact("1", "10^20 + 1", "10^20"), "-1");
        assert_eq!(exact("x^2", "pi", "pi"), "0");
    }

    #[test]
    fn undecided_integrals_stay_unevaluated() {
        // no elementary antiderivative, or a limit the engine cannot take
        assert_eq!(run("sin(x)/x", "-1", "1"), "unevaluated");
        assert_eq!(run("1/log(x)", "1/2", "2"), "unevaluated");
    }

    #[test]
    fn antiderivative_jumps_are_handled() {
        let pi = std::f64::consts::PI;
        approx("1/(2 + cos(x))", "0", "2*pi", 2.0 * pi / 3f64.sqrt());
        approx("1/(2 + sin(x))", "0", "2*pi", 2.0 * pi / 3f64.sqrt());
        approx("1/(5 - 4*cos(x))", "0", "2*pi", 2.0 * pi / 3.0);
    }

    #[test]
    fn convergent_integrals_keep_their_values() {
        let pi = std::f64::consts::PI;
        approx("tan(x)", "0", "pi/4", 2f64.sqrt().ln());
        approx("cos(x)/(1 + sin(x))", "0", "pi/2", 2f64.ln());
        approx("log(x)", "0", "1", -1.0);
        approx("1/(1 + x^2)", "-oo", "oo", pi);
        approx("1/sqrt(x)", "0", "1", 2.0);
        approx("x^2", "0", "3", 9.0);
        approx("log(x^2)", "-1", "1", -4.0);
        approx("1/sqrt(1 - x^2)", "-1", "1", pi);
        approx("1/x^(1/3)", "0", "1", 1.5);
        approx("1/(sin(x) + 2)", "0", "10", 5.17403155500198);
        approx("cos(x)^2", "0", "pi", pi / 2.0);
        approx("1/(1 + tan(x)^2)", "0", "pi", pi / 2.0);
        approx("1/(x^2 - 2)", "-1", "1", -(1.0 / 2f64.sqrt()) * ((2f64.sqrt() + 1.0) / (2f64.sqrt() - 1.0)).ln());
        approx("exp(-x)", "0", "oo", 1.0);
        approx("exp(x)/(exp(x) + 1)", "0", "1", ((1f64.exp() + 1.0) / 2.0).ln());
        // x + e^x certified nonzero on [0, 1] by interval arithmetic
        approx("(1 + exp(x))/(x + exp(x))", "0", "1", (1.0 + 1f64.exp()).ln());
    }

    #[test]
    fn third_review_cases() {
        // T2: cosh(I x) = cos(x); T3: a phase too large for floats; and the
        // fourth review's U3: log(-x) is complex for x > 0
        for (f, a, b) in [("1/(x*cosh(log(-x)/2)^2)", "1/2", "2"), ("1/cosh(I*x)^2", "0", "pi"), ("1/cosh(I*x)^2", "0", "2"), ("1/(10^12*cos(x + 10^20)^2)", "0", "pi"), ("1/(10^12*cos(x + 10^30)^2)", "0", "pi")] {
            let r = run(f, a, b);
            assert!(r == "divergent" || r == "unevaluated", "integral of {} on [{}, {}]: {}", f, a, b, r);
        }
        // T1: cos over an interval straddling pi/2 contains 0
        let (a, b) = (std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2.next_up());
        let i = crate::interval::trig(crate::interval::Iv(a, b), true).unwrap();
        assert!(i.contains_zero(), "{:?}", i);
        for k in 0..2000 {
            let t = -50.0 + k as f64 * 0.0517;
            let (l, h) = (t, t + 1e-3 * (k % 7) as f64);
            for (cosine, f) in [(true, f64::cos as fn(f64) -> f64), (false, f64::sin)] {
                let i = crate::interval::trig(crate::interval::Iv(l, h), cosine).unwrap();
                for j in 0..=4 {
                    let v = f(l + (h - l) * j as f64 / 4.0);
                    assert!(i.0 <= v && v <= i.1);
                }
            }
        }
    }

    #[test]
    fn interval_enclosures_contain_the_values() {
        use crate::interval::{ival, Iv};
        for e in ["exp(x)*sin(3*x) + x^3 - 2", "log(x + 2)/(1 + x^2)", "cos(x)^2 - sinh(x)", "atan(x)*cosh(x) - abs(x - 1/2)", "x^(1/3) + 2^x"] {
            let ex = parse(e);
            for k in 0..50 {
                let (l, h) = (0.01 + k as f64 * 0.07, 0.01 + k as f64 * 0.07 + 0.03);
                let i = ival(&ex, "x", Iv(l, h)).unwrap_or_else(|| panic!("no enclosure of {}", e));
                for j in 0..=10 {
                    let t = l + (h - l) * j as f64 / 10.0;
                    let v = super::at(&ex, "x", t).unwrap().0;
                    assert!(i.0 <= v && v <= i.1, "{} at {}: {} not in {:?}", e, t, v, i);
                }
            }
        }
    }

    /// The fifth review's V2 and V3: points placed by certified
    /// enclosures, merged only when equal exactly; never a wrong
    /// conclusion from a double.
    #[test]
    fn points_and_bounds_by_enclosures() {
        // a removable point at pi/2 and a double pole at pi/2 + 10^-14
        let r = run("1/(1 + tan(x)^2) + 10^-30/cos(x - 10^-14)^2", "0", "pi");
        assert!(r == "divergent" || r == "unevaluated", "V2: {}", r);
        assert_eq!(run("10^-30/cos(x - 10^-14)^2", "0", "pi"), "divergent");
        // sin(10^20 + 1) > 0, but its double is negative: never a value
        // with the pole at 0 inside, never divergent without it
        for (a, wrong) in [("sin(10^20 + 1)", "divergent"), ("-sin(10^20 + 1)", "")] {
            let r = run("1/x^2", a, "1");
            assert!(r == "unevaluated" || (r != wrong && r == "divergent"), "V3 from {}: {}", a, r);
        }
        // still decided where enclosures are narrow
        assert_eq!(run("1/x^2", "-sin(1)", "1"), "divergent");
        approx("1/x^2", "sin(1)", "1", 1.0 / 1f64.sin() - 1.0);
        approx("1/(1 + tan(x)^2)", "0", "pi", std::f64::consts::FRAC_PI_2);
    }
}
