//! Definite integrals: F(b) - F(a) for an antiderivative F (verified:
//! F' = f) is the integral only if f has no nonintegrable singularity in
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
//! Bounds are compared exactly when rational; distinct bounds that are equal
//! as floats are never taken to be equal.  The interval arithmetic rounds
//! outward by a few units in the last place beyond the platform's exp, log,
//! sin and cos, which are assumed correct to within that.

use crate::diff::depends;
use crate::eval::to_c64_env;
use crate::expr::*;
use crate::num::Q;
use crate::qpoly::QPoly;
use num_traits::{Signed, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

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

/// The order of two bounds, when it is established: exactly for rationals
/// and infinities, by floats only when they are far apart, else by
/// simplifying b - a to zero.
fn order(a: &Expr, ba: &Bound, b: &Expr, bb: &Bound) -> Option<Ordering> {
    if let (Some(p), Some(q)) = (&ba.q, &bb.q) {
        return Some(p.cmp(q));
    }
    if ba.v.is_infinite() || bb.v.is_infinite() {
        return ba.v.partial_cmp(&bb.v).filter(|_| ba.v != bb.v || a == b);
    }
    if (ba.v - bb.v).abs() > 1e-9 * (1.0 + ba.v.abs() + bb.v.abs()) {
        return ba.v.partial_cmp(&bb.v);
    }
    if crate::simplify::simplify_full(&sub(b, a)).is_zero() {
        return Some(Ordering::Equal);
    }
    None
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

// ------------------------------------------------------------------ interval arithmetic

/// A closed interval [lo, hi] of reals.
#[derive(Clone, Copy, Debug)]
struct Iv(f64, f64);

/// Outward rounding: a few ulps beyond the computed ends.
fn out(lo: f64, hi: f64) -> Option<Iv> {
    if lo.is_nan() || hi.is_nan() || lo > hi {
        return None;
    }
    let down = |v: f64| if v.is_finite() { (v - 4.0 * f64::EPSILON * v.abs()).next_down() } else { v };
    let up = |v: f64| if v.is_finite() { (v + 4.0 * f64::EPSILON * v.abs()).next_up() } else { v };
    Some(Iv(down(lo), up(hi)))
}

impl Iv {
    fn contains_zero(self) -> bool {
        self.0 <= 0.0 && self.1 >= 0.0
    }
    fn add(self, o: Iv) -> Option<Iv> {
        out(self.0 + o.0, self.1 + o.1)
    }
    fn mul(self, o: Iv) -> Option<Iv> {
        let p = [self.0 * o.0, self.0 * o.1, self.1 * o.0, self.1 * o.1];
        if p.iter().any(|v| v.is_nan()) {
            return None;
        }
        out(p.iter().cloned().fold(f64::INFINITY, f64::min), p.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    }
    fn recip(self) -> Option<Iv> {
        if self.contains_zero() {
            return None;
        }
        out(1.0 / self.1, 1.0 / self.0)
    }
    fn powi(self, n: i64) -> Option<Iv> {
        if n < 0 {
            return self.powi(-n)?.recip();
        }
        if n == 0 {
            return Some(Iv(1.0, 1.0));
        }
        if n > 1 << 20 {
            return None;
        }
        let (a, b) = (self.0.abs(), self.1.abs());
        let (lo, hi) = if n % 2 == 1 {
            (self.0.signum() * a.powi(n as i32), self.1.signum() * b.powi(n as i32))
        } else {
            (if self.contains_zero() { 0.0 } else { a.min(b).powi(n as i32) }, a.max(b).powi(n as i32))
        };
        // (powi's own error: a few ulps per multiplication)
        let s = (n as f64) * 4.0 * f64::EPSILON;
        out(lo - lo.abs() * s, hi + hi.abs() * s)
    }
    /// A monotone function, increasing or decreasing.
    fn mono(self, f: impl Fn(f64) -> f64, increasing: bool) -> Option<Iv> {
        let (a, b) = (f(self.0), f(self.1));
        if increasing { out(a, b) } else { out(b, a) }
    }
}

/// An enclosure of e over x in [lo, hi], or None.
fn ival(e: &Expr, x: &str, r: Iv) -> Option<Iv> {
    match &e.kind {
        Kind::Sym(s) if &**s == x => Some(r),
        Kind::Num(_) | Kind::Const(Const::Pi | Const::E | Const::EulerGamma) => {
            let v = crate::eval::to_c64(e)?;
            if v.1 != 0.0 || !v.0.is_finite() {
                return None;
            }
            out(v.0, v.0)
        }
        Kind::Add(v) => v.iter().try_fold(Iv(0.0, 0.0), |acc, t| acc.add(ival(t, x, r)?)),
        Kind::Mul(v) => v.iter().try_fold(Iv(1.0, 1.0), |acc, t| acc.mul(ival(t, x, r)?)),
        Kind::Pow(b, n) if b.is_const(Const::E) => ival(n, x, r)?.mono(f64::exp, true),
        Kind::Pow(b, n) => {
            if let Some(k) = n.as_rat().filter(|q| q.is_integer()).and_then(|q| num_traits::ToPrimitive::to_i64(q.numer())) {
                return ival(b, x, r)?.powi(k);
            }
            // b^n = exp(n log b) for b > 0
            let bi = ival(b, x, r)?;
            if bi.0 <= 0.0 {
                return None;
            }
            let li = bi.mono(f64::ln, true)?;
            li.mul(ival(n, x, r)?)?.mono(f64::exp, true)
        }
        Kind::Fun(f, a) if a.len() == 1 => {
            let u = ival(&a[0], x, r)?;
            match f {
                Fun::Log if u.0 > 0.0 => u.mono(f64::ln, true),
                Fun::Atan => u.mono(f64::atan, true),
                Fun::Sinh => u.mono(f64::sinh, true),
                Fun::Tanh => u.mono(f64::tanh, true),
                Fun::Asinh => u.mono(f64::asinh, true),
                Fun::Cosh => {
                    let m = u.0.abs().max(u.1.abs()).cosh();
                    out(if u.contains_zero() { 1.0 } else { u.0.abs().min(u.1.abs()).cosh() }, m)
                }
                Fun::Abs => {
                    let m = u.0.abs().max(u.1.abs());
                    out(if u.contains_zero() { 0.0 } else { u.0.abs().min(u.1.abs()) }, m)
                }
                Fun::Sin => trig(u, 0.0),
                Fun::Cos => trig(u, std::f64::consts::FRAC_PI_2),
                _ => None,
            }
        }
        _ => None,
    }
}

/// sin(u + shift) over u: the values at the ends, and +-1 if a maximum or
/// minimum may lie inside (decided with a margin).
fn trig(u: Iv, shift: f64) -> Option<Iv> {
    let (a, b) = (u.0 + shift, u.1 + shift);
    if !a.is_finite() || !b.is_finite() || b - a >= 2.0 * std::f64::consts::PI {
        return Some(Iv(-1.0, 1.0));
    }
    let (fa, fb) = (a.sin(), b.sin());
    let (mut lo, mut hi) = (fa.min(fb), fa.max(fb));
    let tau = 2.0 * std::f64::consts::PI;
    let has = |c: f64| {
        // c + 2 k pi in [a - margin, b + margin] for some k
        let m = 1e-9 * (1.0 + a.abs());
        ((a - m - c) / tau).ceil() <= ((b + m - c) / tau).floor()
    };
    if has(std::f64::consts::FRAC_PI_2) {
        hi = 1.0;
    }
    if has(-std::f64::consts::FRAC_PI_2) {
        lo = -1.0;
    }
    out(lo.max(-1.0), hi.min(1.0)).map(|i| Iv(i.0.max(-1.0), i.1.min(1.0)))
}

/// Whether b is certainly nonzero on [lo, hi] (bisection on interval
/// enclosures, a bounded number of steps).
fn certified_nonzero(b: &Expr, x: &str, lo: f64, hi: f64) -> bool {
    let (lo, hi) = (lo.next_down(), hi.next_up());
    if lo.is_infinite() || hi.is_infinite() {
        return ival(b, x, Iv(lo, hi)).map_or(false, |i| !i.contains_zero());
    }
    let mut todo = vec![(lo, hi)];
    let mut steps = 0;
    while let Some((l, h)) = todo.pop() {
        steps += 1;
        if steps > 20_000 {
            return false;
        }
        match ival(b, x, Iv(l, h)) {
            Some(i) if !i.contains_zero() => continue,
            _ => {}
        }
        if h - l < 1e-10 * (1.0 + l.abs()) {
            return false;
        }
        let m = l + (h - l) / 2.0;
        todo.push((l, m));
        todo.push((m, h));
    }
    true
}

// ------------------------------------------------------------------ singular points

/// A singular point, exactly (approximate ones are not kept: they could
/// not be used).
struct Pt {
    v: f64,
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
    let av = crate::eval::to_f64(&c[1])?;
    (av != 0.0 && crate::eval::to_f64(&c[0]).is_some()).then(|| (c[1].clone(), c[0].clone()))
}

/// A candidate point t (exactly e) of [lo, hi] (bounds la, lb): kept if
/// inside, dropped if outside or at a bound, unknown if that cannot be told.
fn keep(t: f64, e: Expr, b: &Bounds, out: &mut Scan) {
    let near = |v: f64| (t - v).abs() <= 1e-9 * (1.0 + t.abs());
    for (bv, be) in [(b.lo, &b.a), (b.hi, &b.b)] {
        if bv.is_finite() && near(bv) {
            // at the bound, or just inside or outside it?
            if !crate::simplify::simplify_full(&sub(&e, be)).is_zero() {
                out.unknown = true;
            }
            return;
        }
    }
    if t > b.lo && t < b.hi {
        out.points.push(Pt { v: t, e });
    }
}

/// The bounds of the interval, as values and exactly.
struct Bounds {
    lo: f64,
    hi: f64,
    a: Expr,
    b: Expr,
    qa: Option<Q>,
    qb: Option<Q>,
}

/// The x in (lo, hi) with a x + b = c + 2 k pi for one of the given c.
fn periodic(u: &Expr, x: &str, cs: &[Expr], bd: &Bounds, out: &mut Scan) -> bool {
    let Some((a, b)) = linear(u, x) else { return false };
    let (av, bv) = (crate::eval::to_f64(&a).unwrap(), crate::eval::to_f64(&b).unwrap());
    if !bd.lo.is_finite() || !bd.hi.is_finite() {
        out.unknown = true; // infinitely many
        return true;
    }
    let tau = 2.0 * std::f64::consts::PI;
    let (u1, u2) = { let (p, q) = (av * bd.lo + bv, av * bd.hi + bv); (p.min(q), p.max(q)) };
    if (u2 - u1) / tau > 10_000.0 {
        out.unknown = true;
        return true;
    }
    for c in cs {
        let Some(cv) = crate::eval::to_f64(c) else {
            out.unknown = true;
            return true;
        };
        for k in ((u1 - cv) / tau).floor() as i64 - 1..=((u2 - cv) / tau).ceil() as i64 + 1 {
            let t = (cv + k as f64 * tau - bv) / av;
            let e = div(&sub(&add(vec![c.clone(), mul(vec![int(2 * k), pi()])]), &b), &a);
            keep(t, e, bd, out);
        }
    }
    true
}

/// The zeros of cos(u) - t (or sin(u) - t), t a real constant, u linear.
fn trig_eq(sine: bool, u: &Expr, t: &Expr, x: &str, bd: &Bounds, out: &mut Scan) -> bool {
    let Some(tv) = crate::eval::to_f64(t) else { return false };
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
    let margin = |v: f64| 1e-9 * (1.0 + v.abs());
    let inner = |q: &Option<Q>, v: f64, s: f64, inf: &Q| match (q, v.is_finite()) {
        (Some(q), _) => q.clone(),
        (None, true) => q_from_f64(v + s * margin(v)),
        _ => inf.clone(),
    };
    let (lq, hq) = (inner(&bd.qa, bd.lo, 1.0, &-rb.clone()), inner(&bd.qb, bd.hi, -1.0, &rb));
    let (lo2, hi2) = (inner(&bd.qa, bd.lo, -1.0, &-rb.clone()), inner(&bd.qb, bd.hi, 1.0, &rb));
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
            if let Some(v) = crate::eval::to_f64(&e) {
                keep(v, e, bd, out);
            }
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
    match &e.kind {
        Kind::Pow(b, n) if depends(b, x) && !n.as_rat().map_or(false, |r| r.is_integer() && !r.is_negative()) => {
            // a negative or fractional power: the zeros of its base
            zeros(b, x, bd, out);
        }
        Kind::Pow(b, _) if !depends(b, x) && !b.is_const(Const::E) && !crate::eval::to_f64(b).map_or(false, |v| v > 0.0) => {
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
                        match crate::eval::to_f64(&target) {
                            Some(tv) if tv <= 0.0 && (tv < 0.0 || target.is_zero()) => return, // e^u > 0
                            Some(tv) if tv > 0.0 => return zeros(&sub(u, &log(&target)), x, bd, out),
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
        return checked_real(f, endpoints(big_f, x, a, b, has_bad));
    }
    let (lo, hi) = (ba.v, bb.v);
    if !(lo < hi) {
        return Outcome::Unknown; // distinct, but not as floats
    }
    let bd = Bounds { lo, hi, a: a.clone(), b: b.clone(), qa: ba.q.clone(), qb: bb.q.clone() };
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
    // the singular points of f and F, all known exactly
    let mut s = Scan::default();
    scan(f, x, &bd, &mut s);
    scan(big_f, x, &bd, &mut s);
    if s.unknown {
        return Outcome::Unknown;
    }
    let mut cuts = s.points;
    cuts.sort_by(|p, q| p.v.partial_cmp(&q.v).unwrap());
    cuts.dedup_by(|p, q| (p.v - q.v).abs() <= 1e-12 * (1.0 + p.v.abs()));
    let qcuts: Vec<f64> = cuts.iter().map(|p| p.v).collect();
    let mut pts: Vec<Expr> = vec![a.clone()];
    pts.extend(cuts.into_iter().map(|p| p.e));
    pts.push(b.clone());
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

/// Whether the polynomial has a real root strictly inside the interval
/// (a Sturm count with the bounds' exact values or inner margins).
fn real_root_inside(p: &QPoly, bd: &Bounds) -> bool {
    let rb = p.root_bound();
    let inner = |q: &Option<Q>, v: f64, s: f64, inf: Q| match (q, v.is_finite()) {
        (Some(q), _) => q.clone(),
        (None, true) => q_from_f64(v + s * 1e-9 * (1.0 + v.abs())),
        _ => inf,
    };
    let (l, h) = (inner(&bd.qa, bd.lo, 1.0, -rb.clone()), inner(&bd.qb, bd.hi, -1.0, rb));
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
    let own = match &e.kind {
        Kind::Sym(_) | Kind::Num(_) | Kind::Add(_) | Kind::Mul(_) => false,
        Kind::Pow(b, n) if depends(b, x) => !n.as_rat().map_or(false, |r| r.is_integer() && !r.is_negative()),
        Kind::Pow(b, _) => !(b.is_const(Const::E) || crate::eval::to_f64(b).map_or(false, |v| v > 0.0)),
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
    fn interval_enclosures_contain_the_values() {
        use super::{ival, Iv};
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
}
