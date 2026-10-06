//! Limits: direct substitution where the expression is continuous, the
//! leading term of a series expansion at finite points and (through
//! x = 1/t) at infinity, f^g as exp(g log f), and L'Hopital's rule for the
//! quotient forms 0/0 and oo/oo (with 0*oo rewritten as a quotient).

use crate::diff::{depends, diff};
use crate::err::{soft, SymError, R};
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
    // abs(u) and sign(u) differ on the two sides: one-sided limits, with
    // abs(u) = +-u by the sign of u beside a
    if has_abs(e) && !a.is_infinite() {
        if dir == Dir::Both {
            let (l, r) = (limit(e, x, a, Dir::Minus), limit(e, x, a, Dir::Plus));
            return if l == r { r } else { constant(Const::Undefined) };
        }
        let h = if dir == Dir::Plus { 1e-9 } else { -1e-9 };
        let e2 = resolve_abs(e, x, a, h);
        return limit(&e2, x, a, dir);
    }
    if has_abs(e) {
        let h = if a.is_const(Const::MinusInfinity) { -1e9 } else { 1e9 };
        let e2 = resolve_abs(e, x, &zero(), h);
        return limit(&e2, x, a, dir);
    }
    // division by zero is an infinity here, never an error to recover from
    match soft(|| lim(e, x, a, dir, 0)) {
        Ok(r) => tidy(&r),
        Err(err) => crate::err::throw(err),
    }
}

fn has_abs(e: &Expr) -> bool {
    matches!(&e.kind, Kind::Fun(Fun::Abs | Fun::Sign, _)) || e.children().iter().any(has_abs)
}

/// abs(u) -> u or -u, sign(u) -> +-1, by the sign of u at a + h.
fn resolve_abs(e: &Expr, x: &str, a: &Expr, h: f64) -> Expr {
    if e.children().is_empty() {
        return e.clone();
    }
    let e = rebuild(e, e.children().iter().map(|c| resolve_abs(c, x, a, h)).collect());
    if let Kind::Fun(g @ (Fun::Abs | Fun::Sign), args) = &e.kind {
        let av = crate::eval::to_f64(a).unwrap_or(0.0);
        let pt = av + h;
        let v = crate::eval::to_c64_env(&args[0], &|s| if s == x { Some((pt, 0.0)) } else { None });
        if let Some((re, _)) = v {
            let neg_ = re < 0.0;
            return match g {
                Fun::Abs => if neg_ { neg(&args[0]) } else { args[0].clone() },
                _ => if neg_ { int(-1) } else { one() },
            };
        }
    }
    e
}

/// Whether e is bounded whatever x does (sin, cos, arctan, tanh, ...).
fn bounded(e: &Expr, x: &str) -> bool {
    if !depends(e, x) {
        return !has_infinity(e);
    }
    match &e.kind {
        Kind::Fun(Fun::Sin | Fun::Cos | Fun::Atan | Fun::Tanh | Fun::Erf, _) => true,
        Kind::Add(v) | Kind::Mul(v) => v.iter().all(|t| bounded(t, x)),
        Kind::Pow(b, n) => n.as_i64().map_or(false, |k| k > 0) && bounded(b, x),
        _ => false,
    }
}

/// Continuity at a by substitution: no part of e becomes infinite there
/// (1^(1/x) is not 1 at 0).
fn continuous_value(e: &Expr, x: &str, a: &Expr) -> Option<Expr> {
    fn walk(e: &Expr, x: &str, rules: &[(Expr, Expr)]) -> bool {
        if !depends(e, x) {
            return true;
        }
        let v = subs(e, rules);
        if has_infinity(&v) {
            return false;
        }
        e.children().iter().all(|c| walk(c, x, rules))
    }
    let rules = [(sym(x), a.clone())];
    if !walk(e, x, &rules) {
        return None;
    }
    let v = subs(e, &rules);
    let ok = crate::eval::to_c64(&v).map_or(true, |(r, i)| r.is_finite() && i.is_finite());
    if is_finite_value(&v) && ok { Some(v) } else { None }
}

fn fail<T>(msg: impl Into<String>) -> R<T> {
    Err(SymError::Value(msg.into()))
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

fn lim(e: &Expr, x: &str, a: &Expr, dir: Dir, depth: u32) -> R<Expr> {
    sagebrush_interrupt::check();

    if depth > 40 {
        return fail("limit: too deep");
    }
    if !depends(e, x) {
        return Ok(e.clone());
    }
    // 1. continuity: plug in (finite points)
    if is_finite_value(a) {
        if let Some(v) = continuous_value(e, x, a) {
            return Ok(v);
        }
    }
    // at +oo: products of powers, logs and exponentials by their growth,
    // and sums by their dominant term
    if a.is_const(Const::Infinity) {
        if let Some(v) = growth_limit(e, x) {
            return Ok(v);
        }
    }
    // 2. series at the point
    if let Ok(Some(v)) = series_limit(e, x, a, dir) {
        return Ok(v);
    }
    // 3. structure
    match &e.kind {
        Kind::Pow(b, p) if !depends(p, x) => {
            let l = lim(b, x, a, dir, depth + 1)?;
            let pv = crate::eval::to_f64(p);
            if l.is_const(Const::Infinity) {
                if let Some(pv) = pv {
                    return Ok(if pv > 0.0 { infinity() } else { zero() });
                }
            }
            if l.is_zero() {
                if let Some(pv) = pv {
                    if pv < 0.0 {
                        return Ok(infinity());
                    }
                }
            }
            if is_finite_value(&l) {
                return Ok(pow(&l, p));
            }
        }
        Kind::Pow(b, p) if depends(p, x) => {
            // b^p = exp(p log b)
            let l = lim(&mul2(p, &log(b)), x, a, dir, depth + 1)?;
            return Ok(exp_limit(&l));
        }
        Kind::Add(v) => {
            let mut ls = vec![];
            for t in v {
                ls.push(lim(t, x, a, dir, depth + 1)?);
            }
            let s = add(ls);
            if !s.is_const(Const::Undefined) {
                return Ok(s);
            }
            // oo - oo: one fraction, then L'Hopital
            let (n, d) = together(e);
            return quotient_limit(&n, &d, x, a, dir, depth + 1);
        }
        Kind::Mul(v) => {
            // a bounded factor times something that goes to 0
            let (bd, rest): (Vec<Expr>, Vec<Expr>) = v.iter().cloned().partition(|f| bounded(f, x) && depends(f, x));
            if !bd.is_empty() && !rest.is_empty() {
                if let Ok(l) = lim(&mul(rest), x, a, dir, depth + 1) {
                    if l.is_zero() {
                        return Ok(zero());
                    }
                }
            }
            let (n, d) = together(e);
            if !d.is_one() && depends(&d, x) {
                return quotient_limit(&n, &d, x, a, dir, depth + 1);
            }
            // a product: limits of the factors; 0*oo becomes f/(1/g)
            let mut ls = vec![];
            for f in v {
                ls.push(lim(f, x, a, dir, depth + 1)?);
            }
            let zero_i = ls.iter().position(|l| l.is_zero());
            let inf_i = ls.iter().position(|l| l.is_infinite());
            if let (Some(i), Some(j)) = (zero_i, inf_i) {
                let rest: Vec<Expr> = v.iter().enumerate().filter(|(k, _)| *k != i && *k != j).map(|(_, f)| f.clone()).collect();
                // which goes on top: try putting the infinite factor's
                // reciprocal in the denominator, and the other way
                let f = &v[i];
                let g = &v[j];
                let is_exp = |e: &Expr| matches!(&e.kind, Kind::Pow(b, _) if b.is_const(Const::E));
                // the exponential goes in the denominator: x e^(-x) = x/e^x
                let (first, second) = if is_exp(f) { ((g, f), (f, g)) } else { ((f, g), (g, f)) };
                let q = match quotient_limit(first.0, &recip(first.1), x, a, dir, depth + 1) {
                    Ok(q) => q,
                    Err(_) => quotient_limit(second.0, &recip(second.1), x, a, dir, depth + 1)?,
                };
                return Ok(mul2(&q, &lim(&mul(rest), x, a, dir, depth + 1)?));
            }
            return Ok(mul(ls));
        }
        Kind::Fun(f, args) if args.len() == 1 => {
            let l = lim(&args[0], x, a, dir, depth + 1)?;
            return fun_at(f, &l);
        }
        _ => {}
    }
    fail(format!("limit of {} not found", crate::to_string(e)))
}

/// e = C x^p log(x)^q e^(r(x)) (r a polynomial without constant term):
/// (C, [deg r, lead r], p, q) as a growth key at +oo.
fn growth(e: &Expr, x: &str) -> Option<(Expr, (i64, f64, f64, f64))> {
    let fs = match &e.kind {
        Kind::Mul(v) => v.clone(),
        _ => vec![e.clone()],
    };
    let (mut c, mut r, mut p, mut q) = (vec![], zero(), 0.0, 0.0);
    for f in fs {
        if !depends(&f, x) {
            c.push(f);
            continue;
        }
        let (b, k) = base_exp(&f);
        if b.is_const(Const::E) {
            r = add2(&r, &k);
            continue;
        }
        let kv = crate::eval::to_f64(&k)?;
        match &b.kind {
            Kind::Sym(s) if &**s == x => p += kv,
            Kind::Fun(Fun::Log, a) if a[0].as_sym() == Some(x) => q += kv,
            _ => return None,
        }
    }
    let rc = crate::poly::coeffs(&r, x)?;
    if rc.iter().any(|t| depends(t, x)) {
        return None;
    }
    let deg = rc.len() as i64 - 1;
    let (deg, lead) = if deg >= 1 { (deg, crate::eval::to_f64(&rc[deg as usize])?) } else { (0, 0.0) };
    // the constant part of r is a constant factor
    c.push(exp(&rc[0]));
    Some((mul(c), (deg, lead, p, q)))
}

fn key_cmp(a: &(i64, f64, f64, f64), b: &(i64, f64, f64, f64)) -> std::cmp::Ordering {
    // e^(c x^k) beats x^p beats log(x)^q
    let ea = if a.0 > 0 { (a.0 as f64) * a.1.signum() } else { 0.0 };
    let eb = if b.0 > 0 { (b.0 as f64) * b.1.signum() } else { 0.0 };
    ea.partial_cmp(&eb).unwrap()
        .then_with(|| if a.0 == b.0 && a.0 > 0 { a.1.partial_cmp(&b.1).unwrap() } else { std::cmp::Ordering::Equal })
        .then_with(|| a.2.partial_cmp(&b.2).unwrap())
        .then_with(|| a.3.partial_cmp(&b.3).unwrap())
}

fn growth_limit(e: &Expr, x: &str) -> Option<Expr> {
    let (n, d) = together(e);
    let terms = |t: &Expr| -> Option<Vec<(Expr, (i64, f64, f64, f64))>> {
        let ex = crate::expand::expand(t);
        let v = match &ex.kind {
            Kind::Add(v) => v.clone(),
            _ => vec![ex.clone()],
        };
        v.iter().map(|u| growth(u, x)).collect()
    };
    // the dominant term of a sum (unique), else None
    let dominant = |ts: Vec<(Expr, (i64, f64, f64, f64))>| -> Option<(Expr, (i64, f64, f64, f64))> {
        let mut best: Option<(Expr, (i64, f64, f64, f64))> = None;
        let mut tie = false;
        for t in ts {
            match &best {
                None => best = Some(t),
                Some(b) => match key_cmp(&t.1, &b.1) {
                    std::cmp::Ordering::Greater => {
                        best = Some(t);
                        tie = false;
                    }
                    std::cmp::Ordering::Equal => tie = true,
                    _ => {}
                },
            }
        }
        if tie { None } else { best }
    };
    let (cn, kn) = dominant(terms(&n)?)?;
    let (cd, kd) = dominant(terms(&d)?)?;
    // only when exponentials or logs are involved (polynomials: as before)
    if kn.0 == 0 && kd.0 == 0 && kn.3 == 0.0 && kd.3 == 0.0 {
        return None;
    }
    let ratio = div(&cn, &cd);
    let sign = crate::eval::to_f64(&ratio)?.signum();
    Some(match key_cmp(&kn, &kd) {
        std::cmp::Ordering::Less => zero(),
        std::cmp::Ordering::Greater => if sign > 0.0 { infinity() } else { constant(Const::MinusInfinity) },
        std::cmp::Ordering::Equal => ratio,
    })
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
fn fun_at(f: &Fun, l: &Expr) -> R<Expr> {
    let pinf = l.is_const(Const::Infinity);
    let minf = l.is_const(Const::MinusInfinity);
    Ok(match f {
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
        Fun::Sin | Fun::Cos if pinf || minf => return fail("limit does not exist (the function oscillates)"),
        _ => fun1(f.clone(), l),
    })
}

/// lim n/d by its form: substitution, then L'Hopital for 0/0 and oo/oo.
fn quotient_limit(n: &Expr, d: &Expr, x: &str, a: &Expr, dir: Dir, depth: u32) -> R<Expr> {
    if depth > 40 {
        return fail("limit: L'Hopital's rule did not converge");
    }
    let ld = lim(d, x, a, dir, depth + 1)?;
    if ld.is_infinite() && bounded(n, x) {
        return Ok(zero());
    }
    let ln = lim(n, x, a, dir, depth + 1)?;
    let zero_zero = ln.is_zero() && ld.is_zero();
    let inf_inf = ln.is_infinite() && ld.is_infinite();
    if !(zero_zero || inf_inf) {
        if ld.is_zero() {
            // c/0: an infinity, signed by the side
            return Ok(signed_infinity(n, d, x, a, dir, &ln));
        }
        if ld.is_infinite() {
            return Ok(zero());
        }
        return Ok(div(&ln, &ld));
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
fn series_limit(e: &Expr, x: &str, a: &Expr, dir: Dir) -> R<Option<Expr>> {
    let xs = sym(x);
    let t = sym("__limit_t");
    let (shifted, dir) = if a.is_const(Const::Infinity) {
        (subs(e, &[(xs.clone(), recip(&t))]), Dir::Plus)
    } else if a.is_const(Const::MinusInfinity) {
        (subs(e, &[(xs.clone(), neg(&recip(&t)))]), Dir::Plus)
    } else {
        (subs(e, &[(xs.clone(), add2(a, &t))]), dir)
    };
    let s = series(&shifted, "__limit_t", 4)?;
    if s.c.is_empty() {
        return Ok(Some(zero()));
    }
    let c0 = s.c[0].clone();
    if depends(&c0, "__limit_t") || has_infinity(&c0) {
        return Ok(None);
    }
    if s.v > 0 {
        return Ok(Some(zero()));
    }
    if s.v == 0 {
        return Ok(Some(c0));
    }
    // a pole of order -v
    let Some(c) = crate::eval::to_f64(&c0) else { return Ok(None) };
    let odd = s.v % 2 != 0;
    Ok(Some(match dir {
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
    }))
}
