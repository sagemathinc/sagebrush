//! Definite integrals, soundly: F(b) - F(a) for an antiderivative F is the
//! integral only if f has no nonintegrable singularity in (a, b) and F is
//! continuous there.  A locally correct antiderivative establishes neither
//! (Astra's audit, F3: 1/cos(x)^2 on [0, pi] gave 0, 1/x^2 on [1, -1] gave
//! 2; 1/(2 + cos(x)) on [0, 2 pi] gave 0, its antiderivative
//! 2/sqrt(3) arctan(sin(x)/(sqrt(3) (cos(x) + 1))) jumping at pi).  So:
//!
//! 1. The singular points of f in (a, b) are located: the zeros of
//!    denominators, fractional-power bases and logarithm arguments, and the
//!    poles of tan, cot, sec, csc.  Real roots of polynomials are counted
//!    exactly (Sturm) and are exact for factors of degree <= 2; zeros of
//!    c + k cos(u), c + k sin(u) (u linear) are exact; other zeros are
//!    located numerically.  A nonintegrable singularity (|f| growing like
//!    |x - r|^-s, s >= 1) means divergence; an undecided one leaves the
//!    integral unevaluated.
//! 2. F is evaluated by one-sided limits on the pieces between its own
//!    singular points (which must be known exactly).
//! 3. The value is checked: a real integrand has a real integral, and it
//!    must agree with adaptive Gauss-Kronrod quadrature (which must succeed
//!    when there are singular points).  Otherwise the integral is left
//!    unevaluated: never a wrong value.

use crate::diff::depends;
use crate::eval::to_c64_env;
use crate::expr::*;
use crate::num::Q;
use crate::qpoly::QPoly;
use num_traits::{Signed, Zero};
use sagebrush_bigint::BigInt;

pub enum Outcome {
    Value(Expr),
    Divergent,
    /// could not be established: leave the integral unevaluated
    Unknown,
}

/// A bound: its value (+-inf allowed) and, if rational, exactly.
struct Bound {
    v: f64,
    q: Option<Q>,
}

fn bound(e: &Expr) -> Option<Bound> {
    if e.is_const(Const::Infinity) {
        return Some(Bound { v: f64::INFINITY, q: None });
    }
    if e.is_const(Const::MinusInfinity) {
        return Some(Bound { v: f64::NEG_INFINITY, q: None });
    }
    let v = crate::eval::to_f64(e)?;
    if !v.is_finite() {
        return None;
    }
    Some(Bound { v, q: e.as_rat().cloned() })
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

/// A singular point of f: integrable (bounded, a removable singularity, or
/// a blow-up like |t - r|^-s with s < 1) or not.
#[derive(PartialEq)]
enum Sing {
    Integrable,
    NotIntegrable,
}

/// Classify the singular point r of f from |f| near r: with s(d) the size
/// at distance d, d s(d) stays put (or grows) at a nonintegrable
/// singularity and shrinks at an integrable one.  None if undecided (an
/// exponent too close to 1 to tell, or f not evaluable near r).
fn classify(f: &Expr, x: &str, r: f64) -> Option<Sing> {
    let scale = 1.0 + r.abs();
    let size = |d: f64| -> Option<f64> {
        let a = at(f, x, r - d * scale).map(|v| v.0.hypot(v.1));
        let b = at(f, x, r + d * scale).map(|v| v.0.hypot(v.1));
        match (a, b) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) | (None, Some(a)) => Some(a),
            _ => None,
        }
    };
    let (s4, s6, s8) = (size(1e-4)?, size(1e-6)?, size(1e-8)?);
    if s8 <= 10.0 * (1.0 + s4) && s6 <= 10.0 * (1.0 + s4) {
        return Some(Sing::Integrable);
    }
    let (g4, g6, g8) = (s4 * 1e-4, s6 * 1e-6, s8 * 1e-8);
    if g8 >= 0.9 * g4 && g6 >= 0.9 * g4 {
        return Some(Sing::NotIntegrable);
    }
    if g8 <= 0.5 * g4 && g8 <= g6 * 0.75 {
        return Some(Sing::Integrable);
    }
    None
}

/// A candidate singular point: its value and, if known, exactly.
struct Pt {
    v: f64,
    e: Option<Expr>,
}

/// What the analysis of an expression on (lo, hi) found.
#[derive(Default)]
struct Scan {
    points: Vec<Pt>,
    /// some singularity could not be located
    unknown: bool,
}

/// u = a x + b with real constants a != 0: (a, b) exactly.
fn linear(u: &Expr, x: &str) -> Option<(Expr, Expr)> {
    let c = crate::poly::coeffs(u, x)?;
    if c.len() != 2 || depends(&c[0], x) || depends(&c[1], x) {
        return None;
    }
    let av = crate::eval::to_f64(&c[1])?;
    (av != 0.0 && crate::eval::to_f64(&c[0]).is_some()).then(|| (c[1].clone(), c[0].clone()))
}

/// The x in (lo, hi) with a x + b = c + 2 k pi for one of the given c.
fn periodic(u: &Expr, x: &str, cs: &[Expr], lo: f64, hi: f64, out: &mut Scan) -> bool {
    let Some((a, b)) = linear(u, x) else { return false };
    let (av, bv) = (crate::eval::to_f64(&a).unwrap(), crate::eval::to_f64(&b).unwrap());
    if !lo.is_finite() || !hi.is_finite() {
        // infinitely many on an infinite interval
        out.unknown = true;
        return true;
    }
    let tau = 2.0 * std::f64::consts::PI;
    let (u1, u2) = { let (p, q) = (av * lo + bv, av * hi + bv); (p.min(q), p.max(q)) };
    if (u2 - u1) / tau > 10_000.0 {
        out.unknown = true;
        return true;
    }
    for c in cs {
        let Some(cv) = crate::eval::to_f64(c) else {
            out.unknown = true;
            return true;
        };
        for k in ((u1 - cv) / tau).floor() as i64..=((u2 - cv) / tau).ceil() as i64 {
            let t = (cv + k as f64 * tau - bv) / av;
            if t > lo && t < hi {
                let e = div(&sub(&add(vec![c.clone(), mul(vec![int(2 * k), pi()])]), &b), &a);
                out.points.push(Pt { v: t, e: Some(e) });
            }
        }
    }
    true
}

/// The zeros of cos(u) - t (or sin(u) - t), t a real constant.
fn trig_eq(sine: bool, u: &Expr, t: &Expr, x: &str, lo: f64, hi: f64, out: &mut Scan) -> bool {
    let Some(tv) = crate::eval::to_f64(t) else { return false };
    if tv.abs() > 1.0 {
        return linear(u, x).is_some();
    }
    let cs = if sine {
        let s = fun1(Fun::Asin, t);
        vec![s.clone(), sub(&pi(), &s)]
    } else {
        let c = fun1(Fun::Acos, t);
        vec![c.clone(), neg(&c)]
    };
    periodic(u, x, &cs, lo, hi, out)
}

/// The real roots of a polynomial in (lo, hi): counted exactly (Sturm),
/// exact for factors of degree at most 2, approximated otherwise.
fn poly_roots(p: &QPoly, lo: &Bound, hi: &Bound, out: &mut Scan) {
    let rb = p.root_bound();
    let margin = |v: f64| 1e-9 * (1.0 + v.abs());
    let inner = |b: &Bound, s: f64, inf: &Q| match (&b.q, b.v.is_finite()) {
        (Some(q), _) => q.clone(),
        (None, true) => q_from_f64(b.v + s * margin(b.v)),
        _ => inf.clone(),
    };
    let (lq, hq) = (inner(lo, 1.0, &-rb.clone()), inner(hi, -1.0, &rb));
    let (lo2, hi2) = (inner(lo, -1.0, &-rb.clone()), inner(hi, 1.0, &rb));
    if lq >= hq {
        out.unknown = true;
        return;
    }
    let f64of = |q: &Q| crate::eval::to_f64(&qnum(q.clone())).unwrap_or(f64::NAN);
    for (fac, _) in p.factor() {
        if fac.deg() < 1 {
            continue;
        }
        let n = fac.count_real_roots(&lq, &hq);
        if fac.count_real_roots(&lo2, &hi2) != n {
            // a root within the margin of an irrational bound
            out.unknown = true;
        }
        if n == 0 {
            continue;
        }
        if fac.deg() <= 2 {
            let roots: Vec<Expr> = if fac.deg() == 1 {
                vec![qnum(-fac.coeff(0) / fac.coeff(1))]
            } else {
                let (a, b, c) = (fac.coeff(2), fac.coeff(1), fac.coeff(0));
                let d = sqrt(&qnum(&b * &b - Q::from_integer(BigInt::from(4)) * &a * &c));
                let two_a = qnum(Q::from_integer(BigInt::from(2)) * &a);
                vec![div(&sub(&neg(&qnum(b.clone())), &d), &two_a), div(&add2(&neg(&qnum(b.clone())), &d), &two_a)]
            };
            let inside: Vec<Pt> = roots
                .into_iter()
                .filter_map(|e| {
                    let v = crate::eval::to_f64(&e)?;
                    (v > lo.v && v < hi.v).then_some(Pt { v, e: Some(e) })
                })
                .collect();
            if inside.len() != n {
                out.unknown = true;
            }
            out.points.extend(inside);
            continue;
        }
        // bisect to isolate and approximate the roots
        let two = Q::from_integer(BigInt::from(2));
        let mut stack = vec![(lq.clone(), hq.clone(), n)];
        while let Some((l, h, k)) = stack.pop() {
            if k == 0 {
                continue;
            }
            let (lv, hv) = (f64of(&l), f64of(&h));
            if hv - lv < 1e-13 * (1.0 + lv.abs()) {
                out.points.push(Pt { v: (lv + hv) / 2.0, e: None });
                continue;
            }
            if k == 1 && hv - lv < 1e-3 * (1.0 + lv.abs()) {
                // one root: bisect on sign (fac is square-free)
                let (mut l, mut h) = (l, h);
                let sl = fac.eval(&l) > Q::zero();
                for _ in 0..60 {
                    let m = (&l + &h) / &two;
                    let vm = fac.eval(&m);
                    if vm.is_zero() {
                        l = m.clone();
                        h = m;
                        break;
                    }
                    if (vm > Q::zero()) == sl { l = m } else { h = m }
                }
                out.points.push(Pt { v: (f64of(&l) + f64of(&h)) / 2.0, e: None });
                continue;
            }
            let m = (&l + &h) / &two;
            let kl = fac.count_real_roots(&l, &m);
            let at_m = usize::from(fac.eval(&m).is_zero());
            if at_m == 1 {
                out.points.push(Pt { v: f64of(&m), e: Some(qnum(m.clone())) });
            }
            stack.push((l, m.clone(), kl));
            stack.push((m, h, k - kl - at_m));
        }
    }
}

/// The candidate singular points of e on (lo, hi).
fn scan(e: &Expr, x: &str, lo: &Bound, hi: &Bound, out: &mut Scan) {
    if !depends(e, x) {
        return;
    }
    match &e.kind {
        Kind::Pow(b, n) if depends(b, x) && !n.as_rat().map_or(false, |r| r.is_integer() && !r.is_negative()) => {
            // a negative or fractional power: zeros of the base
            zeros(b, x, lo, hi, out);
        }
        Kind::Fun(f, a) => match f {
            Fun::Tan | Fun::Sec => zeros(&fun1(Fun::Cos, &a[0]), x, lo, hi, out),
            Fun::Cot | Fun::Csc => zeros(&fun1(Fun::Sin, &a[0]), x, lo, hi, out),
            Fun::Log => zeros(&a[0], x, lo, hi, out),
            Fun::Sin | Fun::Cos | Fun::Atan | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Abs => {}
            _ => {
                if !matches!(f, Fun::Asin | Fun::Acos | Fun::Asinh | Fun::Acot | Fun::Erf) {
                    out.unknown = true;
                }
            }
        },
        _ => {}
    }
    for t in e.children().iter() {
        scan(t, x, lo, hi, out);
    }
}

/// The zeros of b on (lo, hi).
fn zeros(b: &Expr, x: &str, lo: &Bound, hi: &Bound, out: &mut Scan) {
    if !depends(b, x) {
        return;
    }
    if let Some(p) = QPoly::from_expr(b, x) {
        return poly_roots(&p, lo, hi, out);
    }
    match &b.kind {
        Kind::Mul(v) => {
            for t in v {
                zeros(t, x, lo, hi, out);
            }
            return;
        }
        Kind::Pow(base, n) if base.is_const(Const::E) => {
            let _ = n; // e^u never vanishes
            return;
        }
        Kind::Pow(base, n) if n.as_rat().map_or(false, |r| r.is_positive()) => return zeros(base, x, lo, hi, out),
        Kind::Pow(base, n) if n.as_rat().map_or(false, |r| r.is_negative()) => {
            // 1/base vanishes nowhere, but is singular at base's zeros
            return zeros(base, x, lo, hi, out);
        }
        Kind::Fun(Fun::Cos, a) if trig_eq(false, &a[0], &int(0), x, lo.v, hi.v, out) => return,
        Kind::Fun(Fun::Sin, a) if trig_eq(true, &a[0], &int(0), x, lo.v, hi.v, out) => return,
        Kind::Fun(Fun::Cosh, _) => return,
        Kind::Add(v) => {
            // c + k cos(u) or c + k sin(u)
            let (consts, rest): (Vec<&Expr>, Vec<&Expr>) = v.iter().partition(|t| !depends(t, x));
            if rest.len() == 1 {
                let (k, t) = split_coeff(rest[0]);
                if let Kind::Fun(g @ (Fun::Cos | Fun::Sin), a) = &t.kind {
                    let c = add(consts.into_iter().cloned().collect());
                    let target = neg(&div(&c, &num(k)));
                    if trig_eq(*g == Fun::Sin, &a[0], &target, x, lo.v, hi.v, out) {
                        return;
                    }
                }
            }
        }
        _ => {}
    }
    numeric_zeros(b, x, lo, hi, out);
}

/// Zeros of another kind of expression, numerically: sign changes are
/// located (approximately); a value near 0 without one leaves the
/// integral undecided.
fn numeric_zeros(b: &Expr, x: &str, lo: &Bound, hi: &Bound, out: &mut Scan) {
    if !lo.v.is_finite() || !hi.v.is_finite() {
        out.unknown = true;
        return;
    }
    let n = 4000;
    let real = |t: f64| at(b, x, t).and_then(|v| (v.1.abs() <= 1e-12 * (1.0 + v.0.abs())).then_some(v.0));
    let mut vals = vec![];
    for i in 1..n {
        let t = lo.v + (hi.v - lo.v) * (i as f64 / n as f64);
        match real(t) {
            Some(v) => vals.push((t, v)),
            None => {
                out.unknown = true;
                return;
            }
        }
    }
    let mut mags: Vec<f64> = vals.iter().map(|v| v.1.abs()).collect();
    mags.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let typical = mags[mags.len() / 2];
    for w in vals.windows(2) {
        let ((mut l, vl), (mut h, vh)) = (w[0], w[1]);
        if vl == 0.0 {
            out.points.push(Pt { v: l, e: None });
        } else if vl.signum() != vh.signum() && vh != 0.0 {
            for _ in 0..80 {
                let m = (l + h) / 2.0;
                match real(m) {
                    Some(vm) if vm.signum() == vl.signum() => l = m,
                    Some(_) => h = m,
                    None => break,
                }
            }
            out.points.push(Pt { v: (l + h) / 2.0, e: None });
        } else if vl.abs().min(vh.abs()) < 1e-6 * typical.max(1e-300) {
            out.unknown = true;
        }
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

fn contains_i(e: &Expr) -> bool {
    let complex = match &e.kind {
        Kind::Num(crate::num::Num::Exact(_, im)) => !im.is_zero(),
        Kind::Num(crate::num::Num::Float(_, im)) => *im != 0.0,
        _ => false,
    };
    complex || e.children().iter().any(contains_i)
}

/// The definite integral of f from a to b, given an antiderivative F.
pub fn definite(f: &Expr, big_f: &Expr, x: &str, a: &Expr, b: &Expr, has_bad: &dyn Fn(&Expr) -> bool) -> Outcome {
    let (Some(ba), Some(bb)) = (bound(a), bound(b)) else {
        // symbolic bounds: F(b) - F(a) holds when f has no singularity at all
        if has_singular_parts(f, x) || has_singular_parts(big_f, x) {
            return Outcome::Unknown;
        }
        return endpoints(big_f, x, a, b, has_bad);
    };
    if ba.v == bb.v {
        return Outcome::Value(int(0));
    }
    if ba.v > bb.v {
        return match definite(f, big_f, x, b, a, has_bad) {
            Outcome::Value(v) => Outcome::Value(neg(&v)),
            o => o,
        };
    }
    let (lo, hi) = (ba.v, bb.v);
    // 1. the singular points of f: a nonintegrable one means divergence
    let mut sf = Scan::default();
    scan(f, x, &ba, &bb, &mut sf);
    for p in &sf.points {
        match classify(f, x, p.v) {
            Some(Sing::NotIntegrable) => return Outcome::Divergent,
            Some(Sing::Integrable) => {}
            None => return Outcome::Unknown,
        }
    }
    if sf.unknown {
        return Outcome::Unknown;
    }
    // 2. F on the pieces between its singular points (where it may jump),
    // which must be known exactly
    let mut sbig = Scan::default();
    scan(big_f, x, &ba, &bb, &mut sbig);
    if sbig.unknown || sbig.points.iter().any(|p| p.e.is_none()) {
        return Outcome::Unknown;
    }
    let singular = !sf.points.is_empty() || !sbig.points.is_empty();
    let qcuts: Vec<f64> = sf.points.iter().chain(sbig.points.iter()).map(|p| p.v).collect();
    let mut cuts: Vec<Pt> = sbig.points.into_iter().chain(sf.points.into_iter().filter(|p| p.e.is_some())).collect();
    cuts.sort_by(|p, q| p.v.partial_cmp(&q.v).unwrap());
    cuts.dedup_by(|p, q| (p.v - q.v).abs() <= 1e-12 * (1.0 + p.v.abs()));
    let mut pts: Vec<Expr> = vec![a.clone()];
    pts.extend(cuts.into_iter().map(|p| p.e.unwrap()));
    pts.push(b.clone());
    let mut terms = vec![];
    for w in pts.windows(2) {
        match endpoints(big_f, x, &w[0], &w[1], has_bad) {
            Outcome::Value(v) => terms.push(v),
            o => return o,
        }
    }
    let r = add(terms);
    let s = crate::simplify::simplify_rational(&r);
    let r = if crate::simplify::size(&s) <= crate::simplify::size(&r) { s } else { r };
    // 3. checks: a real integrand has a real integral, and it agrees with
    // quadrature (which must succeed when f or F has singular points)
    let Some(val) = crate::eval::to_c64(&r) else { return Outcome::Unknown };
    if !contains_i(f) && val.1.abs() > 1e-9 * (1.0 + val.0.abs()) {
        return Outcome::Unknown;
    }
    match numeric(f, x, lo, hi, &qcuts) {
        Some((q, err)) if err < 1e-6 * (1.0 + q.abs()) => {
            let tol = 1e-7 * (1.0 + q.abs()) + 100.0 * err;
            if (val.0 - q).abs() > tol {
                return Outcome::Unknown;
            }
        }
        _ if singular => return Outcome::Unknown,
        _ => {}
    }
    Outcome::Value(r)
}

/// Whether f has parts that can be singular somewhere on the real line
/// (denominators, tan/cot/sec/csc, logarithms, fractional powers).
fn has_singular_parts(e: &Expr, x: &str) -> bool {
    if !depends(e, x) {
        return false;
    }
    match &e.kind {
        Kind::Pow(b, n) if depends(b, x) && !n.as_rat().map_or(false, |r| r.is_integer() && !r.is_negative()) => true,
        Kind::Fun(Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc | Fun::Log, _) => true,
        _ => e.children().iter().any(|c| has_singular_parts(c, x)),
    }
}

/// F(b-) - F(a+), or divergent if a one-sided limit is infinite (unknown
/// if a limit cannot be found).
fn endpoints(big_f: &Expr, x: &str, a: &Expr, b: &Expr, has_bad: &dyn Fn(&Expr) -> bool) -> Outcome {
    let (Ok(fb), Ok(fa)) = (
        crate::limit::try_limit(big_f, x, b, crate::limit::Dir::Minus),
        crate::limit::try_limit(big_f, x, a, crate::limit::Dir::Plus),
    ) else {
        return Outcome::Unknown;
    };
    if fb.is_infinite() || fa.is_infinite() || has_bad(&fb) || has_bad(&fa) {
        return Outcome::Divergent;
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
        ] {
            assert_eq!(run(f, a, b), "divergent", "integral of {} on [{}, {}]", f, a, b);
        }
    }

    #[test]
    fn undecided_integrals_stay_unevaluated() {
        // no elementary antiderivative, or a limit the engine cannot take
        assert_eq!(run("sin(x)/x", "-1", "1"), "unevaluated");
        assert_eq!(run("1/(1 + tan(x)^2)", "0", "pi"), "unevaluated");
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
        approx("1/(x^2 - 2)", "-1", "1", -(1.0 / 2f64.sqrt()) * ((2f64.sqrt() + 1.0) / (2f64.sqrt() - 1.0)).ln());
        approx("exp(-x)", "0", "oo", 1.0);
    }
}
