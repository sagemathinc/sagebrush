//! Antiderivatives, the way a calculus student finds them: a table of
//! standard integrals (with linear arguments), linearity, exact rational
//! function integration (ratint.rs), derivative-divides substitution,
//! integration by parts, powers and products of trigonometric functions,
//! square roots of quadratics, rational functions of exp, and expansion.
//! Every answer is checked by differentiating it (symbolically, else
//! numerically at several complex points) before it is returned, and the
//! rules used can be recorded as steps for teaching.

use crate::diff::{depends, diff};
use crate::err::soft;
use crate::expand::expand;
use crate::expr::*;
use crate::num::Q;
use crate::qpoly::QPoly;
use crate::simplify::{simplify_full, simplify_rational, together};
use num_traits::{One, Signed, Zero};
use std::cell::RefCell;

/// One step of a derivation: the rule, its integrand and result, and the
/// integrals it needed.
#[derive(Clone, Debug)]
pub struct Step {
    pub rule: String,
    pub integrand: Expr,
    pub var: String,
    pub result: Expr,
    pub sub: Vec<Step>,
}

thread_local! {
    static TRACE: RefCell<Option<Vec<Vec<Step>>>> = const { RefCell::new(None) };
}

fn step(rule: &str, f: &Expr, x: &str, run: impl FnOnce() -> Option<Expr>) -> Option<Expr> {
    let tracing = TRACE.with(|t| match t.borrow_mut().as_mut() {
        Some(s) => {
            s.push(vec![]);
            true
        }
        None => false,
    });
    let r = run();
    if tracing {
        TRACE.with(|t| {
            let mut t = t.borrow_mut();
            let s = t.as_mut().unwrap();
            let kids = s.pop().unwrap_or_default();
            if let Some(res) = &r {
                if let Some(top) = s.last_mut() {
                    top.push(Step { rule: rule.into(), integrand: f.clone(), var: x.into(), result: res.clone(), sub: kids });
                }
            }
        });
    }
    r
}

/// An antiderivative of f in x, checked by differentiation; None if none
/// was found.
pub fn integrate(f: &Expr, x: &str) -> Option<Expr> {
    let r = soft(|| Ctx { x, inv: false }.int(f, 0).map(|r| collect_kernels(&tidy(&r), x)))?;
    if has_bad(&r) || !verify(f, &r, x) {
        return None;
    }
    Some(r)
}

/// The antiderivative with the steps that found it.
pub fn integrate_steps(f: &Expr, x: &str) -> Option<(Expr, Step)> {
    TRACE.with(|t| *t.borrow_mut() = Some(vec![vec![]]));
    let r = integrate(f, x);
    let steps = TRACE.with(|t| t.borrow_mut().take()).and_then(|mut s| s.pop()).unwrap_or_default();
    let r = r?;
    let mut top = steps.into_iter().last().unwrap_or(Step { rule: "".into(), integrand: f.clone(), var: x.into(), result: r.clone(), sub: vec![] });
    top.result = r.clone(); // the tidied, collected answer
    Some((r, top))
}

fn has_bad(e: &Expr) -> bool {
    e.is_infinite() || e.is_const(Const::Undefined) || e.children().iter().any(has_bad)
}

/// Whether d/dx F = f: exactly after simplification, or numerically at
/// several points off the real axis (so branch cuts do not interfere).
pub fn verify(f: &Expr, big_f: &Expr, x: &str) -> bool {
    let d = diff(big_f, x);
    let z = sub(&d, f);
    if z.is_zero() {
        return true;
    }
    let mut syms = free_symbols(f);
    syms.extend(free_symbols(big_f));
    syms.sort();
    syms.dedup();
    let pts = [(0.37, 0.11), (1.13, -0.07), (2.71, 0.23), (-0.83, 0.17), (0.61, 1.3)];
    let mut checked = 0;
    for (k, p) in pts.iter().enumerate() {
        let env = |s: &str| -> Option<(f64, f64)> {
            if s == x {
                return Some(*p);
            }
            let i = syms.iter().position(|t| t == s)? as f64;
            Some((0.7 + 0.31 * i + 0.05 * k as f64, 0.0))
        };
        let (Some(zv), Some(fv)) = (crate::eval::to_c64_env(&z, &env), crate::eval::to_c64_env(f, &env)) else { continue };
        if !zv.0.is_finite() || !zv.1.is_finite() || !fv.0.is_finite() || !fv.1.is_finite() {
            continue;
        }
        let err = zv.0.hypot(zv.1);
        let scale = 1.0 + fv.0.hypot(fv.1);
        if err > 1e-7 * scale {
            return simplify_full(&z).is_zero() || verify_real(&z, f, x, &syms);
        }
        checked += 1;
    }
    checked >= 3 || simplify_full(&z).is_zero() || verify_real(&z, f, x, &syms)
}

/// The numerical part of verify (no symbolic simplification).
fn verify_numeric(f: &Expr, big_f: &Expr, x: &str) -> bool {
    let z = sub(&diff(big_f, x), f);
    let mut syms = free_symbols(f);
    syms.extend(free_symbols(big_f));
    syms.sort();
    syms.dedup();
    let mut checked = 0;
    for (k, p) in [(0.37, 0.11), (1.13, -0.07), (2.71, 0.23), (-0.83, 0.17), (0.61, 1.3)].iter().enumerate() {
        let env = |s: &str| -> Option<(f64, f64)> {
            if s == x {
                return Some(*p);
            }
            let i = syms.iter().position(|t| t == s)? as f64;
            Some((0.7 + 0.31 * i + 0.05 * k as f64, 0.0))
        };
        let (Some(zv), Some(fv)) = (crate::eval::to_c64_env(&z, &env), crate::eval::to_c64_env(f, &env)) else { continue };
        if !zv.0.is_finite() || !zv.1.is_finite() || !fv.0.is_finite() || !fv.1.is_finite() {
            continue;
        }
        if zv.0.hypot(zv.1) > 1e-7 * (1.0 + fv.0.hypot(fv.1)) {
            return verify_real(&z, f, x, &syms);
        }
        checked += 1;
    }
    checked >= 3 || verify_real(&z, f, x, &syms)
}

/// The check at real points where f is real (antiderivatives like
/// -arcsin(1/x) for 1/(x sqrt(x^2 - 1)) hold on the real line only): at
/// least three such points, and none failing.
fn verify_real(z: &Expr, f: &Expr, x: &str, syms: &[String]) -> bool {
    let mut checked = 0;
    for p in [0.37, 1.13, 2.71, -0.83, 3.7, -2.3, 0.61, 1.9, -1.4, 5.3] {
        let env = |s: &str| -> Option<(f64, f64)> {
            if s == x {
                return Some((p, 0.0));
            }
            let i = syms.iter().position(|t| t == s)? as f64;
            Some((0.7 + 0.31 * i, 0.0))
        };
        let (Some(zv), Some(fv)) = (crate::eval::to_c64_env(z, &env), crate::eval::to_c64_env(f, &env)) else { continue };
        if !fv.0.is_finite() || fv.1.abs() > 1e-12 * (1.0 + fv.0.abs()) || !zv.0.is_finite() || !zv.1.is_finite() {
            continue;
        }
        if zv.0.hypot(zv.1) > 1e-7 * (1.0 + fv.0.abs()) {
            return false;
        }
        checked += 1;
    }
    checked >= 3
}

/// log(e^y) = y (for real y, as in calculus), which substitutions leave;
/// and odd and even functions of a negative argument (cos(-x) = cos(x)),
/// as Maxima writes its answers.
fn tidy(e: &Expr) -> Expr {
    if e.children().is_empty() {
        return e.clone();
    }
    let e = rebuild(e, e.children().iter().map(tidy).collect());
    if let Kind::Fun(g, a) = &e.kind {
        if *g == Fun::Log {
            if let Kind::Pow(b, y) = &a[0].kind {
                if b.is_const(Const::E) {
                    return y.clone();
                }
            }
        }
        if a.len() == 1 && negative_lead(&a[0]) {
            let m = neg(&a[0]);
            match g {
                Fun::Sin | Fun::Tan | Fun::Cot | Fun::Csc | Fun::Sinh | Fun::Tanh | Fun::Asin | Fun::Atan | Fun::Asinh | Fun::Atanh | Fun::Erf => {
                    return neg(&fun1(g.clone(), &m));
                }
                Fun::Cos | Fun::Sec | Fun::Cosh | Fun::Sech => return fun1(g.clone(), &m),
                _ => {}
            }
        }
    }
    e
}

fn negative_lead(e: &Expr) -> bool {
    match &e.kind {
        Kind::Add(v) => v.iter().all(negative_lead),
        _ => split_coeff(e).0.is_negative(),
    }
}

/// Terms sharing a transcendental kernel (e^x, cos(x), ...) collected,
/// with the polynomial coefficient's content in front, as Maxima writes
/// its answers: (x - 1)*e^x, 1/4*(2*x - 1)*e^(2*x), (-x^2 + 2)*cos(x).
fn collect_kernels(e: &Expr, x: &str) -> Expr {
    let Kind::Add(v) = &e.kind else { return e.clone() };
    let mut groups: Vec<(Expr, Vec<Expr>)> = vec![];
    let mut others = vec![];
    for t in v {
        let (p, k): (Vec<Expr>, Vec<Expr>) = factors(t).into_iter().partition(|f| is_poly(f, x));
        let kernel = mul(k);
        let is_kernel = matches!(&kernel.kind, Kind::Pow(b, _) if b.is_const(Const::E))
            || matches!(&kernel.kind, Kind::Fun(Fun::Sin | Fun::Cos | Fun::Sinh | Fun::Cosh, _))
            || matches!(&kernel.kind, Kind::Mul(w) if w.iter().all(|f| matches!(&f.kind, Kind::Pow(b, _) if b.is_const(Const::E)) || matches!(&f.kind, Kind::Fun(Fun::Sin | Fun::Cos, _))));
        if !is_kernel || !depends(&kernel, x) {
            others.push(t.clone());
            continue;
        }
        match groups.iter_mut().find(|g| g.0 == kernel) {
            Some(g) => g.1.push(mul(p)),
            None => groups.push((kernel, vec![mul(p)])),
        }
    }
    for (k, ps) in groups {
        if ps.len() == 1 {
            others.push(mul2(&ps[0], &k));
            continue;
        }
        let c = expand(&add(ps));
        // the content of a rational polynomial in front
        let term = match QPoly::from_expr(&c, x) {
            Some(q) if q.deg() >= 1 => {
                let (content, prim) = crate::poly::to_zpoly(&q.0);
                // keep the sign inside, as Maxima does: (-x - 1)*e^(-x)
                let content = if content.is_negative() { -content } else { content };
                let prim_expr = expand(&div(&c, &qnum(content.clone())));
                let _ = prim;
                mul(vec![qnum(content), prim_expr, k])
            }
            _ => mul2(&c, &k),
        };
        others.push(term);
    }
    add(others)
}

struct Ctx<'a> {
    x: &'a str,
    /// an inverse substitution (x = e^u, x = u^(1/k), ...) was made on the
    /// way here: one per chain, or log and exp substitutions alternate
    inv: bool,
}

/// (a, b) with e = a x + b, a != 0 free of x.
fn linear(e: &Expr, x: &str) -> Option<(Expr, Expr)> {
    let c = crate::poly::coeffs(e, x)?;
    if c.len() != 2 || c[1].is_zero() || depends(&c[1], x) || depends(&c[0], x) {
        return None;
    }
    Some((c[1].clone(), c[0].clone()))
}

/// The factors of a product (or the single factor).
fn factors(e: &Expr) -> Vec<Expr> {
    match &e.kind {
        Kind::Mul(v) => v.clone(),
        _ => vec![e.clone()],
    }
}

/// (factors free of x, factors depending on x) as two products.
fn split_const(e: &Expr, x: &str) -> (Expr, Expr) {
    let (c, d): (Vec<Expr>, Vec<Expr>) = factors(e).into_iter().partition(|f| !depends(f, x));
    (mul(c), mul(d))
}

fn is_poly(e: &Expr, x: &str) -> bool {
    crate::poly::coeffs(e, x).is_some()
}

fn is_expanded_poly(e: &Expr, x: &str) -> bool {
    expand(e) == *e && depends(e, x)
}

fn fresh(depth: u32) -> String {
    format!("_u{}", depth)
}

impl<'a> Ctx<'a> {
    fn xs(&self) -> Expr {
        sym(self.x)
    }

    fn int(&self, f: &Expr, depth: u32) -> Option<Expr> {
        sagebrush_interrupt::check();
        if depth > 14 {
            return None;
        }
        let x = self.x;
        if !depends(f, x) {
            return step("constant", f, x, || Some(mul2(f, &self.xs())));
        }
        if let Some(p) = QPoly::from_expr(f, x) {
            // a polynomial: Maxima expands it unless a nonlinear
            // substitution applies (x^2 (x^3 + 1)^4 = (x^3 + 1)^5/15)
            if p.deg() >= 1 {
                if !is_expanded_poly(f, x) {
                    if let Some(r) = self.substitution_where(f, depth, |u| linear(u, x).is_none()) {
                        return Some(r);
                    }
                }
                return step("polynomial", f, x, || crate::ratint::integrate_rational(&p, &QPoly::one(), &self.xs()));
            }
        }
        if let Some(r) = self.table(f) {
            return Some(r);
        }
        if let Kind::Add(v) = &f.kind {
            if let Some(r) = step("sum rule", f, x, || {
                let mut out = vec![];
                for t in v {
                    out.push(self.int(t, depth + 1)?);
                }
                Some(add(out))
            }) {
                return Some(r);
            }
        }
        let (c, g) = split_const(f, x);
        if !c.is_one() {
            return step("constant multiple", f, x, || Some(mul2(&c, &self.int(&g, depth + 1)?)));
        }
        if let Some(r) = self.rational(f) {
            return Some(r);
        }
        if let Some(r) = self.quadratic_param(f) {
            return Some(r);
        }
        if let Some(r) = self.trig(f, depth) {
            return Some(r);
        }
        if let Some(r) = self.exp_sin(f) {
            return Some(r);
        }
        if let Some(r) = self.parts(f, depth) {
            return Some(r);
        }
        if let Some(r) = self.substitution(f, depth) {
            return Some(r);
        }
        if let Some(r) = self.sqrt_quadratic(f, depth) {
            return Some(r);
        }
        if let Some(r) = self.rational_exp(f, depth) {
            return Some(r);
        }
        if let Some(r) = self.gaussian(f) {
            return Some(r);
        }
        if let Some(r) = self.hyperbolic_exp(f, depth) {
            return Some(r);
        }
        if let Some(r) = self.weierstrass(f, depth) {
            return Some(r);
        }
        let e = expand(f);
        if e != *f {
            if let Some(r) = step("expand", f, x, || self.int(&e, depth + 1)) {
                return Some(r);
            }
        }
        let (_, d) = together(f);
        if !d.is_one() {
            let q = simplify_rational(f);
            if q != *f {
                return step("simplify", f, x, || self.int(&q, depth + 1));
            }
        }
        None
    }

    // ---------------------------------------------------------------- table

    fn table(&self, f: &Expr) -> Option<Expr> {
        let x = self.x;
        let xs = self.xs();
        match &f.kind {
            Kind::Sym(_) => step("power rule", f, x, || Some(div(&pow(&xs, &int(2)), &int(2)))),
            Kind::Pow(b, n) if n.as_i64() == Some(2) && matches!(b.kind, Kind::Fun(..)) => {
                // sec^2, csc^2, sech^2, csch^2 of a linear argument
                let Kind::Fun(g, args) = &b.kind else { return None };
                let (a, _) = linear(args.first()?, x)?;
                let u = &args[0];
                let r = match g {
                    Fun::Sec => fun1(Fun::Tan, u),
                    Fun::Csc => neg(&recip(&fun1(Fun::Tan, u))),
                    Fun::Sech => fun1(Fun::Tanh, u),
                    Fun::Csch => neg(&fun1(Fun::Coth, u)),
                    _ => return None,
                };
                step("table", f, x, || Some(div(&r, &a)))
            }
            Kind::Pow(b, n) if n.as_i64() == Some(-2) && matches!(b.kind, Kind::Fun(..)) => {
                // 1/cos^2 and 1/sin^2
                let Kind::Fun(g, args) = &b.kind else { return None };
                let (a, _) = linear(args.first()?, x)?;
                let u = &args[0];
                let r = match g {
                    Fun::Cos => fun1(Fun::Tan, u),
                    Fun::Sin => neg(&recip(&fun1(Fun::Tan, u))),
                    Fun::Cosh => fun1(Fun::Tanh, u),
                    _ => return None,
                };
                step("table", f, x, || Some(div(&r, &a)))
            }
            Kind::Pow(b, n) if !depends(n, x) => {
                let (a, _) = linear(b, x)?;
                if n.is_minus_one() {
                    return step("1/u gives log(u)", f, x, || Some(div(&log(b), &a)));
                }
                // fractional and integer powers of a linear function
                step("power rule", f, x, || {
                    let n1 = add2(n, &one());
                    Some(div(&pow(b, &n1), &mul2(&n1, &a)))
                })
            }
            Kind::Pow(b, e) if !depends(b, x) => {
                let (a, _) = linear(e, x)?;
                if b.is_const(Const::E) {
                    return step("exponential", f, x, || Some(div(f, &a)));
                }
                step("exponential", f, x, || Some(div(f, &mul2(&a, &log(b)))))
            }
            Kind::Mul(v) if v.len() == 2 => {
                // sec tan, csc cot
                let (Kind::Fun(g, ga), Kind::Fun(h, ha)) = (&v[0].kind, &v[1].kind) else { return None };
                if ga != ha {
                    return None;
                }
                let (a, _) = linear(ga.first()?, x)?;
                let u = &ga[0];
                let r = match (g, h) {
                    (Fun::Sec, Fun::Tan) | (Fun::Tan, Fun::Sec) => recip(&cos(u)),
                    (Fun::Csc, Fun::Cot) | (Fun::Cot, Fun::Csc) => neg(&recip(&sin(u))),
                    (Fun::Sech, Fun::Tanh) | (Fun::Tanh, Fun::Sech) => neg(&fun1(Fun::Sech, u)),
                    _ => return None,
                };
                step("table", f, x, || Some(div(&r, &a)))
            }
            Kind::Fun(g, args) if args.len() == 1 => {
                let u = &args[0];
                let (a, _) = linear(u, x)?;
                let r = match g {
                    Fun::Sin => neg(&cos(u)),
                    Fun::Cos => sin(u),
                    Fun::Tan => log(&fun1(Fun::Sec, u)),
                    Fun::Cot => log(&sin(u)),
                    Fun::Sec => log(&add2(&fun1(Fun::Sec, u), &fun1(Fun::Tan, u))),
                    Fun::Csc => neg(&log(&add2(&fun1(Fun::Cot, u), &fun1(Fun::Csc, u)))),
                    Fun::Sinh => fun1(Fun::Cosh, u),
                    Fun::Cosh => fun1(Fun::Sinh, u),
                    Fun::Tanh => log(&fun1(Fun::Cosh, u)),
                    Fun::Coth => log(&fun1(Fun::Sinh, u)),
                    Fun::Sech => fun1(Fun::Atan, &fun1(Fun::Sinh, u)),
                    Fun::Log => sub(&mul2(u, &log(u)), u),
                    Fun::Atan => sub(&mul2(u, &fun1(Fun::Atan, u)), &div(&log(&add2(&pow(u, &int(2)), &one())), &int(2))),
                    Fun::Asin => add2(&mul2(u, &fun1(Fun::Asin, u)), &sqrt(&sub(&one(), &pow(u, &int(2))))),
                    Fun::Acos => sub(&mul2(u, &fun1(Fun::Acos, u)), &sqrt(&sub(&one(), &pow(u, &int(2))))),
                    Fun::Asinh => sub(&mul2(u, &fun1(Fun::Asinh, u)), &sqrt(&add2(&pow(u, &int(2)), &one()))),
                    Fun::Acosh => sub(&mul2(u, &fun1(Fun::Acosh, u)), &sqrt(&sub(&pow(u, &int(2)), &one()))),
                    Fun::Atanh => add2(&mul2(u, &fun1(Fun::Atanh, u)), &div(&log(&sub(&one(), &pow(u, &int(2)))), &int(2))),
                    Fun::Erf => add2(&mul2(u, &fun1(Fun::Erf, u)), &div(&exp(&neg(&pow(u, &int(2)))), &sqrt(&pi()))),
                    _ => return None,
                };
                let rule = match g {
                    Fun::Log | Fun::Atan | Fun::Asin | Fun::Acos | Fun::Asinh | Fun::Acosh | Fun::Atanh | Fun::Erf => "table (by parts)",
                    _ => "table",
                };
                step(rule, f, x, || Some(div(&r, &a)))
            }
            _ => None,
        }
    }

    // ---------------------------------------------------------------- rational

    fn rational(&self, f: &Expr) -> Option<Expr> {
        let x = self.x;
        let (n, d) = together(f);
        let qn = QPoly::from_expr(&n, x)?;
        let qd = QPoly::from_expr(&d, x)?;
        if qd.deg() < 1 && qn.deg() < 0 {
            return None;
        }
        let rule = if qd.deg() >= 1 { "partial fractions" } else { "polynomial" };
        step(rule, f, x, || crate::ratint::integrate_rational(&qn, &qd, &self.xs()))
    }

    /// (r x + s)/(A x^2 + B x + C) with symbolic coefficients: a log and
    /// an arctangent (or a log) when the sign of 4AC - B^2 is clear (sums
    /// of squares of the parameters are positive, as Maxima assumes).
    fn quadratic_param(&self, f: &Expr) -> Option<Expr> {
        let x = self.x;
        let xs = self.xs();
        let (n, d) = together(f);
        let dc = crate::poly::coeffs(&d, x)?;
        let nc = crate::poly::coeffs(&n, x)?;
        if dc.len() != 3 || nc.len() > 2 || dc.iter().chain(nc.iter()).any(|c| depends(c, x)) {
            return None;
        }
        let (a, b, c) = (&dc[2], &dc[1], &dc[0]);
        let (r, s_) = (nc.get(1).cloned().unwrap_or_else(zero), nc[0].clone());
        let disc = expand(&sub(&mul(vec![int(4), a.clone(), c.clone()]), &pow(b, &int(2))));
        let lin = add2(&mul(vec![int(2), a.clone(), xs.clone()]), b);
        let t = sub(&s_, &div(&mul2(&r, b), &mul2(&int(2), a)));
        let mut out = vec![];
        if !r.is_zero() {
            out.push(mul2(&div(&r, &mul2(&int(2), a)), &log(&d)));
        }
        if !t.is_zero() {
            if positive(&disc) {
                let sd = sqrt_pos(&disc);
                out.push(mul(vec![int(2), t, recip(&sd), fun1(Fun::Atan, &div(&lin, &sd))]));
            } else if positive(&neg(&disc)) {
                let sd = sqrt_pos(&neg(&disc));
                out.push(mul(vec![t, recip(&sd), log(&div(&sub(&lin, &sd), &add2(&lin, &sd)))]));
            } else {
                return None;
            }
        }
        step("partial fractions (quadratic)", f, x, || Some(add(out)))
    }

    // ---------------------------------------------------------------- substitution

    /// Derivative divides: f = g(u) u' for an inner expression u.
    fn substitution(&self, f: &Expr, depth: u32) -> Option<Expr> {
        self.substitution_where(f, depth, |_| true)
    }

    fn substitution_where(&self, f: &Expr, depth: u32, keep: impl Fn(&Expr) -> bool) -> Option<Expr> {
        let x = self.x;
        let xs = self.xs();
        let mut cands = vec![];
        collect_inner(f, x, &mut cands);
        // a factor x^m next to powers of x: u = x^(m+1) (x/(1 + x^4): u = x^2)
        for g in factors(f) {
            let (b, e) = base_exp(&g);
            if b == xs {
                if let Some(m) = e.as_i64().filter(|m| *m >= 1) {
                    cands.push(pow(&xs, &int(m + 1)));
                }
            }
        }
        cands.retain(|u| u != &xs && u != f && keep(u));
        cands.sort_by_key(|u| std::cmp::Reverse(crate::simplify::size(u)));
        cands.dedup();
        for u in cands {
            let du = diff(&u, x);
            if du.is_zero() {
                continue;
            }
            let un = fresh(depth);
            let us = sym(&un);
            let q = div(f, &du);
            let mut g = replace_u(&q, &u, &us, x);
            let mut used_inverse = false;
            if depends(&g, x) {
                let q2 = simplify_rational(&q);
                g = replace_u(&q2, &u, &us, x);
                if depends(&g, x) {
                    // x itself in terms of u: x = (u - b)/a, u^(1/k), e^u, ...
                    let lin = linear(&u, x).is_some();
                    if self.inv && !lin {
                        continue;
                    }
                    let Some(xu) = inverse(&u, x, &us) else { continue };
                    g = subs(&g, &[(xs.clone(), xu)]);
                    if depends(&g, x) {
                        continue;
                    }
                    used_inverse = !lin;
                }
            }
            if g == *f {
                continue;
            }
            let r = step(&format!("substitute u = {}", crate::to_string(&u)), f, x, || {
                let inner = Ctx { x: &un, inv: self.inv || used_inverse };
                let h = inner.int(&g, depth + 1)?;
                let r = tidy(&subs(&h, &[(us.clone(), u.clone())]));
                // inverse substitutions (x = u^(1/k), ...) can leave branch
                // errors: check before accepting
                if used_inverse && !verify_numeric(f, &r, x) {
                    return None;
                }
                Some(r)
            });
            if r.is_some() {
                return r;
            }
        }
        None
    }

    // ---------------------------------------------------------------- parts

    fn parts(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let trans_dv = |e: &Expr| -> bool {
            match &e.kind {
                Kind::Pow(b, n) => !depends(b, x) && linear(n, x).is_some(),
                Kind::Fun(Fun::Sin | Fun::Cos | Fun::Sinh | Fun::Cosh, a) => linear(&a[0], x).is_some(),
                _ => false,
            }
        };
        let trans_u = |e: &Expr| -> bool {
            match &e.kind {
                Kind::Fun(Fun::Log | Fun::Atan | Fun::Asin | Fun::Acos | Fun::Asinh | Fun::Acosh | Fun::Atanh | Fun::Acot, _) => true,
                Kind::Pow(b, n) => matches!(b.kind, Kind::Fun(Fun::Log, _)) && n.as_i64().map_or(false, |k| k > 0),
                _ => false,
            }
        };
        // polynomial factors and the rest
        let (p, mut t): (Vec<Expr>, Vec<Expr>) = factors(f).into_iter().partition(|g| is_poly(g, x));
        if t.len() == 2 && t.iter().all(|g| trans_dv(g)) {
            // e^(a x) sin(b x) as one factor
            t = vec![mul(t)];
        }
        if t.len() != 1 {
            return None;
        }
        let p = mul(p);
        let t = &t[0];
        if depends(&p, x) && (trans_dv(t) || matches!(t.kind, Kind::Mul(_))) {
            // u = P (a polynomial), dv = T: P V - int(P' V)
            return step("integration by parts", f, x, || {
                let v = self.int(t, depth + 1)?;
                let rest = self.int(&expand(&mul2(&diff(&p, x), &v)), depth + 1)?;
                Some(sub(&mul2(&p, &v), &rest))
            });
        }
        if trans_u(t) {
            // u = T (log, inverse trig), dv = P: T W - int(W T')
            return step("integration by parts", f, x, || {
                let w = self.int(&p, depth + 1)?;
                let rest = self.int(&simplify_rational(&mul2(&w, &diff(t, x))), depth + 1)?;
                Some(sub(&mul2(t, &w), &rest))
            });
        }
        None
    }

    /// e^(a x + b) sin(c x + d) and e^(a x + b) cos(c x + d).
    fn exp_sin(&self, f: &Expr) -> Option<Expr> {
        let x = self.x;
        let fs = factors(f);
        if fs.len() != 2 {
            return None;
        }
        let (ex, tr) = if matches!(fs[0].kind, Kind::Pow(..)) { (&fs[0], &fs[1]) } else { (&fs[1], &fs[0]) };
        let Kind::Pow(b, e) = &ex.kind else { return None };
        if !b.is_const(Const::E) {
            return None;
        }
        let (a, _) = linear(e, x)?;
        let Kind::Fun(g, args) = &tr.kind else { return None };
        let (c, _) = linear(&args[0], x)?;
        let v = &args[0];
        let den = add2(&pow(&a, &int(2)), &pow(&c, &int(2)));
        let num = match g {
            Fun::Sin => sub(&mul2(&a, &sin(v)), &mul2(&c, &cos(v))),
            Fun::Cos => add2(&mul2(&a, &cos(v)), &mul2(&c, &sin(v))),
            _ => return None,
        };
        step("integration by parts twice", f, x, || Some(div(&mul2(&num, ex), &den)))
    }

    // ---------------------------------------------------------------- trig

    fn trig(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let fs = factors(f);
        // sin(u)^m cos(u)^n, tan(u)^n, sec(u)^n, csc(u)^n, cot(u)^n
        let mut arg: Option<Expr> = None;
        let (mut m, mut n) = (0i64, 0i64);
        let mut single: Option<(Fun, i64)> = None;
        for g in &fs {
            let (b, e) = base_exp(g);
            let k = e.as_i64()?;
            let Kind::Fun(h, a) = &b.kind else { return None };
            if a.len() != 1 {
                return None;
            }
            match &arg {
                None => arg = Some(a[0].clone()),
                Some(u) if u != &a[0] => return self.product_to_sum(f, depth),
                _ => {}
            }
            match h {
                Fun::Sin => m += k,
                Fun::Cos => n += k,
                Fun::Tan | Fun::Sec | Fun::Csc | Fun::Cot if fs.len() == 1 => single = Some((h.clone(), k)),
                Fun::Tan | Fun::Sec => return self.tan_sec(f, depth),
                _ => return None,
            }
        }
        let u = arg?;
        let (a, _) = linear(&u, x)?;
        let w = sym(&fresh(depth));
        let wn = fresh(depth);
        let inner = Ctx { x: &wn, inv: self.inv };
        if let Some((h, k)) = single {
            if k < 2 {
                return None;
            }
            if h == Fun::Sec && k % 2 == 0 {
                return self.tan_sec(f, depth);
            }
            return step("trigonometric reduction", f, x, || {
                let kq = int(k);
                let k1 = int(k - 1);
                let r = match h {
                    // tan^k = tan^(k-2) sec^2 - tan^(k-2)
                    Fun::Tan => sub(&div(&pow(&fun1(Fun::Tan, &u), &k1), &mul2(&k1, &a)), &self.int(&pow(&fun1(Fun::Tan, &u), &int(k - 2)), depth + 1)?),
                    Fun::Cot => sub(&neg(&div(&pow(&fun1(Fun::Cot, &u), &k1), &mul2(&k1, &a))), &self.int(&pow(&fun1(Fun::Cot, &u), &int(k - 2)), depth + 1)?),
                    // sec^k = sec^(k-2) tan/(k-1) + (k-2)/(k-1) int sec^(k-2)
                    Fun::Sec => add2(
                        &div(&mul2(&pow(&fun1(Fun::Sec, &u), &int(k - 2)), &fun1(Fun::Tan, &u)), &mul2(&k1, &a)),
                        &mul2(&div(&int(k - 2), &k1), &self.int(&pow(&fun1(Fun::Sec, &u), &int(k - 2)), depth + 1)?),
                    ),
                    Fun::Csc => add2(
                        &neg(&div(&mul2(&pow(&fun1(Fun::Csc, &u), &int(k - 2)), &fun1(Fun::Cot, &u)), &mul2(&k1, &a))),
                        &mul2(&div(&int(k - 2), &k1), &self.int(&pow(&fun1(Fun::Csc, &u), &int(k - 2)), depth + 1)?),
                    ),
                    _ => return None,
                };
                let _ = kq;
                Some(r)
            });
        }
        if m + n < 2 && !(m % 2 != 0 && n != 0 || n % 2 != 0 && m != 0) {
            return None;
        }
        if m.rem_euclid(2) == 1 {
            // w = cos u: sin^m cos^n du = -(1 - w^2)^((m-1)/2) w^n dw / a
            let g = mul2(&pow(&sub(&one(), &pow(&w, &int(2))), &int((m - 1).div_euclid(2))), &pow(&w, &int(n)));
            return step("substitute w = cos", f, x, || {
                let h = inner.int(&expand(&g), depth + 1)?;
                Some(neg(&div(&subs(&h, &[(w.clone(), cos(&u))]), &a)))
            });
        }
        if n.rem_euclid(2) == 1 {
            let g = mul2(&pow(&w, &int(m)), &pow(&sub(&one(), &pow(&w, &int(2))), &int((n - 1).div_euclid(2))));
            return step("substitute w = sin", f, x, || {
                let h = inner.int(&expand(&g), depth + 1)?;
                Some(div(&subs(&h, &[(w.clone(), sin(&u))]), &a))
            });
        }
        if m < 0 || n < 0 {
            return None;
        }
        // both even: sin^2 = (1 - cos 2u)/2, cos^2 = (1 + cos 2u)/2
        let c2 = cos(&mul2(&int(2), &u));
        let g = mul2(
            &pow(&div(&sub(&one(), &c2), &int(2)), &int(m / 2)),
            &pow(&div(&add2(&one(), &c2), &int(2)), &int(n / 2)),
        );
        step("power reduction", f, x, || self.int(&expand(&g), depth + 1))
    }

    /// sin(a) cos(b), sin(a) sin(b), cos(a) cos(b) with different arguments.
    fn product_to_sum(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let fs = factors(f);
        if fs.len() != 2 {
            return None;
        }
        let (Kind::Fun(g, ga), Kind::Fun(h, ha)) = (&fs[0].kind, &fs[1].kind) else { return None };
        let (p, q) = (&ga[0], &ha[0]);
        let half = |e: Expr| div(&e, &int(2));
        let r = match (g, h) {
            (Fun::Sin, Fun::Cos) => half(add2(&sin(&add2(p, q)), &sin(&sub(p, q)))),
            (Fun::Cos, Fun::Sin) => half(add2(&sin(&add2(p, q)), &sin(&sub(q, p)))),
            (Fun::Sin, Fun::Sin) => half(sub(&cos(&sub(p, q)), &cos(&add2(p, q)))),
            (Fun::Cos, Fun::Cos) => half(add2(&cos(&sub(p, q)), &cos(&add2(p, q)))),
            _ => return None,
        };
        step("product to sum", f, self.x, || self.int(&expand(&r), depth + 1))
    }

    // ---------------------------------------------------------------- square roots

    /// Integrands with sqrt(a x^2 + b x + c): (r x + s) Q^(-1/2), Q^(1/2), Q^(-3/2).
    fn sqrt_quadratic(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let xs = self.xs();
        let fs = factors(f);
        let (mut root, mut rest) = (None, vec![]);
        for g in &fs {
            if let Kind::Pow(b, e) = &g.kind {
                if let Some(q) = e.as_rat() {
                    if q.denom() == &sagebrush_bigint::BigInt::from(2) && root.is_none() {
                        let c = crate::poly::coeffs(b, x)?;
                        if c.len() == 3 && c.iter().all(|v| !depends(v, x)) {
                            root = Some((b.clone(), q.clone(), c));
                            continue;
                        }
                    }
                }
            }
            rest.push(g.clone());
        }
        let (qq, k, c) = root?;
        let rest = mul(rest);
        let (a, b, cc) = (c[2].clone(), c[1].clone(), c[0].clone());
        let half_q = Q::new(1.into(), 2.into());
        let mhalf = -half_q.clone();
        if (k == mhalf || k == half_q) && !rest.is_one() && linear(&rest, x).is_none() {
            if let Some(r) = self.poly_sqrt(f, &rest, &qq, &k, &c, depth) {
                return Some(r);
            }
        }
        if k == mhalf {
            let lin = linear(&rest, x);
            if !rest.is_one() && lin.is_none() {
                return None;
            }
            let (r, s) = if rest.is_one() { (zero(), one()) } else { let (r, s) = lin.unwrap(); (r, s) };
            return step("square root of a quadratic", f, x, || {
                // (r x + s)/sqrt(Q) = r/(2a) Q'/sqrt(Q) + (s - r b/(2a))/sqrt(Q)
                let mut out = vec![];
                if !r.is_zero() {
                    out.push(mul2(&div(&r, &a), &sqrt(&qq)));
                }
                let t = sub(&s, &div(&mul2(&r, &b), &mul2(&int(2), &a)));
                if !t.is_zero() {
                    out.push(mul2(&t, &inv_sqrt_quadratic(&qq, &a, &b, &cc, &xs)?));
                }
                Some(add(out))
            });
        }
        if k == half_q && rest.is_one() {
            // sqrt(Q) = (2 a x + b) sqrt(Q)/(4 a) + (4 a c - b^2)/(8 a) int Q^(-1/2)
            return step("square root of a quadratic", f, x, || {
                let first = div(&mul2(&add2(&mul(vec![int(2), a.clone(), xs.clone()]), &b), &sqrt(&qq)), &mul2(&int(4), &a));
                let disc = sub(&mul(vec![int(4), a.clone(), cc.clone()]), &pow(&b, &int(2)));
                let second = mul2(&div(&disc, &mul2(&int(8), &a)), &inv_sqrt_quadratic(&qq, &a, &b, &cc, &xs)?);
                Some(add2(&first, &second))
            });
        }
        if k == Q::new((-3).into(), 2.into()) && rest.is_one() {
            return step("square root of a quadratic", f, x, || {
                let disc = sub(&mul(vec![int(4), a.clone(), cc.clone()]), &pow(&b, &int(2)));
                Some(div(&mul2(&int(2), &add2(&mul(vec![int(2), a.clone(), xs.clone()]), &b)), &mul2(&disc, &sqrt(&qq))))
            });
        }
        let _ = depth;
        None
    }

    /// P(x) Q^(+-1/2) for a polynomial P: P/sqrt(Q) = (R sqrt(Q))' + l/sqrt(Q)
    /// with deg R = deg P - 1, from R' Q + R Q'/2 + l = P (solved from the
    /// top coefficient down); and x^-m / sqrt(Q) through x = 1/t.
    fn poly_sqrt(&self, f: &Expr, rest: &Expr, qq: &Expr, k: &Q, c: &[Expr], depth: u32) -> Option<Expr> {
        let x = self.x;
        let xs = self.xs();
        let qc: Vec<Q> = c.iter().map(|v| v.as_rat().cloned()).collect::<Option<_>>()?;
        let qpoly = QPoly::new(qc);
        if let Some(p) = QPoly::from_expr(rest, x) {
            // P/sqrt(Q): with sqrt(Q) = Q/sqrt(Q) for the positive half power
            let p = if k.is_integer() || k > &Q::zero() { p.mul(&qpoly) } else { p };
            let n = p.deg();
            if n < 1 {
                return None;
            }
            // unknowns: R = r_0 + ... + r_{n-1} x^{n-1}, and l
            let dq = qpoly.derivative();
            let mut r = vec![Q::zero(); n as usize];
            let mut lhs = p.clone();
            for j in (0..n as usize).rev() {
                // the x^(j+1) coefficient of (x^j)' Q + x^j Q'/2 is (j + 1/2 * 2) a... computed directly
                let basis = QPoly::new({ let mut v = vec![Q::zero(); j + 1]; v[j] = Q::one(); v });
                let term = basis.derivative().mul(&qpoly).add(&basis.mul(&dq).scale(&Q::new(1.into(), 2.into())));
                let top = term.coeff(j + 1);
                if top.is_zero() {
                    return None;
                }
                let cj = lhs.coeff(j + 1) / &top;
                lhs = lhs.sub(&term.scale(&cj));
                r[j] = cj;
            }
            // what is left must be a constant l
            if lhs.deg() > 0 {
                return None;
            }
            let l = lhs.coeff(0);
            let rexpr = QPoly::new(r).to_expr(&xs);
            return step("reduction formula for sqrt of a quadratic", f, x, || {
                let mut out = vec![expand(&mul2(&rexpr, &sqrt(qq)))];
                if !l.is_zero() {
                    out.push(mul2(&qnum(l.clone()), &inv_sqrt_quadratic(qq, &c[2], &c[1], &c[0], &xs)?));
                }
                Some(add(out))
            });
        }
        // x^-m Q^(-1/2): x = 1/t gives -t^(m-1) / sqrt(c t^2 + b t + a) (x > 0)
        let mexp = match &rest.kind {
            Kind::Pow(b, e) if b == &xs => e.as_i64().filter(|v| *v < 0)?,
            _ => return None,
        };
        if k != &Q::new((-1).into(), 2.into()) {
            return None;
        }
        let m = -mexp;
        let tn = fresh(depth);
        let t = sym(&tn);
        let q2 = add(vec![mul2(&c[0], &pow(&t, &int(2))), mul2(&c[1], &t), c[2].clone()]);
        let g = neg(&div(&pow(&t, &int(m - 1)), &sqrt(&q2)));
        let inner = Ctx { x: &tn, inv: self.inv };
        step("substitute x = 1/t", f, x, || {
            let h = inner.int(&g, depth + 1)?;
            // sqrt(c t^2 + b t + a) = sqrt(Q)/x for x > 0
            let h = map_pow(&h, &mut |b, e| if b == &q2 { Some(mul2(&pow(qq, e), &pow(&xs, &neg(&mul2(&int(2), e))))) } else { None }, &tn);
            Some(subs(&h, &[(t.clone(), recip(&xs))]))
        })
    }

    /// tan(u)^m sec(u)^n: u = tan for n even, u = sec for m odd.
    fn tan_sec(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let (mut m, mut n, mut arg) = (0i64, 0i64, None::<Expr>);
        for g in factors(f) {
            let (b, e) = base_exp(&g);
            let k = e.as_i64()?;
            let Kind::Fun(h, a) = &b.kind else { return None };
            if arg.as_ref().map_or(false, |u| u != &a[0]) {
                return None;
            }
            arg = Some(a[0].clone());
            match h {
                Fun::Tan => m += k,
                Fun::Sec => n += k,
                _ => return None,
            }
        }
        let u = arg?;
        let (a, _) = linear(&u, x)?;
        let wn = fresh(depth);
        let w = sym(&wn);
        let inner = Ctx { x: &wn, inv: self.inv };
        if n >= 2 && n % 2 == 0 && m >= 0 {
            let g = mul2(&pow(&w, &int(m)), &pow(&add2(&one(), &pow(&w, &int(2))), &int((n - 2) / 2)));
            return step("substitute w = tan", f, x, || {
                let h = inner.int(&expand(&g), depth + 1)?;
                Some(div(&subs(&h, &[(w.clone(), fun1(Fun::Tan, &u))]), &a))
            });
        }
        if m >= 1 && m % 2 == 1 && n >= 1 {
            let g = mul2(&pow(&sub(&pow(&w, &int(2)), &one()), &int((m - 1) / 2)), &pow(&w, &int(n - 1)));
            return step("substitute w = sec", f, x, || {
                let h = inner.int(&expand(&g), depth + 1)?;
                Some(div(&subs(&h, &[(w.clone(), fun1(Fun::Sec, &u))]), &a))
            });
        }
        None
    }

    /// e^(a x^2 + b x + c): the error function.
    fn gaussian(&self, f: &Expr) -> Option<Expr> {
        let x = self.x;
        let Kind::Pow(b0, e) = &f.kind else { return None };
        if !b0.is_const(Const::E) {
            return None;
        }
        let c = crate::poly::coeffs(e, x)?;
        if c.len() != 3 || c.iter().any(|v| depends(v, x)) {
            return None;
        }
        let (a, b, cc) = (&c[2], &c[1], &c[0]);
        let av = crate::eval::to_f64(a)?;
        // a (x + b/2a)^2 + c - b^2/4a
        let shift = div(b, &mul2(&int(2), a));
        let k = exp(&sub(cc, &div(&pow(b, &int(2)), &mul2(&int(4), a))));
        let t = add2(&self.xs(), &shift);
        let r = if av < 0.0 {
            let s = sqrt(&neg(a));
            mul(vec![k, sqrt(&pi()), recip(&mul2(&int(2), &s)), fun1(Fun::Erf, &mul2(&s, &t))])
        } else {
            let s = sqrt(a);
            mul(vec![neg(&i()), k, sqrt(&pi()), recip(&mul2(&int(2), &s)), fun1(Fun::Erf, &mul(vec![i(), s.clone(), t.clone()]))])
        };
        step("Gaussian integral (erf)", f, x, || Some(r))
    }

    /// sinh, cosh, tanh, ... written with e^x (as Maxima integrates them).
    fn hyperbolic_exp(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let mut found = false;
        let g = to_exp(f, x, &mut found);
        if !found {
            return None;
        }
        step("rewrite with exponentials", f, x, || self.int(&g, depth + 1))
    }

    /// A rational function of sin(u), cos(u) (u linear): t = tan(u/2),
    /// written back as sin(u)/(cos(u) + 1), as Maxima does.
    fn weierstrass(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let mut arg = None;
        if !only_sin_cos(f, x, &mut arg) {
            return None;
        }
        let u = arg?;
        let (a, _) = linear(&u, x)?;
        let tn = fresh(depth);
        let t = sym(&tn);
        let t2 = add2(&one(), &pow(&t, &int(2)));
        let g = subs(f, &[(sin(&u), div(&mul2(&int(2), &t), &t2)), (cos(&u), div(&sub(&one(), &pow(&t, &int(2))), &t2))]);
        if depends(&g, x) {
            return None;
        }
        let g = simplify_rational(&mul2(&g, &div(&int(2), &mul2(&a, &t2))));
        let inner = Ctx { x: &tn, inv: self.inv };
        step("Weierstrass substitution t = tan(x/2)", f, x, || {
            let h = inner.rational(&g)?;
            Some(subs(&h, &[(t.clone(), div(&sin(&u), &add2(&cos(&u), &one())))]))
        })
    }

    // ---------------------------------------------------------------- exp

    /// A rational function of e^(k x): w = e^(k x).
    fn rational_exp(&self, f: &Expr, depth: u32) -> Option<Expr> {
        let x = self.x;
        let mut ks: Vec<Q> = vec![];
        collect_exp_rates(f, x, &mut ks)?;
        if ks.is_empty() {
            return None;
        }
        // the common rate g: every rate is an integer multiple of it
        let mut g = ks[0].clone();
        for k in &ks[1..] {
            g = gcd_q(&g, k);
        }
        let wn = fresh(depth);
        let w = sym(&wn);
        let mut ok = true;
        let h = map_exp(f, x, &g, &w, &mut ok);
        if !ok || depends(&h, x) {
            return None;
        }
        let integrand = div(&h, &mul2(&qnum(g.clone()), &w));
        let inner = Ctx { x: &wn, inv: self.inv };
        step("substitute w = e^x", f, x, || {
            let r = inner.int(&integrand, depth + 1)?;
            Some(subs(&r, &[(w.clone(), exp(&mul2(&qnum(g.clone()), &sym(x))))]))
        })
    }
}

/// Whether e is evidently positive: a sum of positive multiples of even
/// powers of the parameters (4*a^2, a^2 + b^2, 3), taken as real.
fn positive(e: &Expr) -> bool {
    let term = |t: &Expr| -> bool {
        let (c, rest) = split_coeff(t);
        if !(c.is_real() && c.is_positive()) {
            return false;
        }
        factors(&rest).iter().all(|f| {
            let (_, k) = base_exp(f);
            f.is_one() || k.as_i64().map_or(false, |k| k % 2 == 0) || matches!(f.kind, Kind::Const(Const::Pi | Const::E))
        })
    };
    match &e.kind {
        Kind::Add(v) => v.iter().all(term),
        _ => !e.is_zero() && term(e),
    }
}

/// sqrt of a positive expression, with sqrt(c a^2) = sqrt(c) a for a
/// positive parameter a (as Maxima's answers assume).
fn sqrt_pos(e: &Expr) -> Expr {
    if let Kind::Add(_) = &e.kind {
        return sqrt(e);
    }
    let (c, rest) = split_coeff(e);
    let mut out = vec![sqrt(&num(c))];
    for f in factors(&rest) {
        let (b, k) = base_exp(&f);
        match k.as_i64() {
            Some(k) if k % 2 == 0 => out.push(pow(&b, &int(k / 2))),
            _ => out.push(sqrt(&f)),
        }
    }
    mul(out)
}

/// 1/sqrt(a x^2 + b x + c) by completing the square (a, c numbers decide
/// between arcsin, arcsinh and a log).
fn inv_sqrt_quadratic(qq: &Expr, a: &Expr, b: &Expr, c: &Expr, x: &Expr) -> Option<Expr> {
    let av = crate::eval::to_f64(a)?;
    let k = sub(c, &div(&pow(b, &int(2)), &mul2(&int(4), a))); // c - b^2/(4a)
    let kv = crate::eval::to_f64(&k)?;
    let t = add2(x, &div(b, &mul2(&int(2), a))); // x + b/(2a)
    if av < 0.0 && kv > 0.0 {
        let na = neg(a);
        return Some(div(&fun1(Fun::Asin, &div(&mul2(&sqrt(&na), &t), &sqrt(&k))), &sqrt(&na)));
    }
    if av > 0.0 && kv > 0.0 {
        return Some(div(&fun1(Fun::Asinh, &div(&mul2(&sqrt(a), &t), &sqrt(&k))), &sqrt(a)));
    }
    if av > 0.0 {
        // log(2 sqrt(a) sqrt(Q) + 2 a x + b)/sqrt(a)
        let arg = add(vec![mul(vec![int(2), sqrt(a), sqrt(qq)]), mul(vec![int(2), a.clone(), x.clone()]), b.clone()]);
        return Some(div(&log(&arg), &sqrt(a)));
    }
    None
}

/// q with the inner expression u replaced by us; radicals of u's radicand
/// become powers of us (u = L^(1/k): L^(j/k) -> us^j).
fn replace_u(q: &Expr, u: &Expr, us: &Expr, x: &str) -> Expr {
    let g = subs(q, &[(u.clone(), us.clone())]);
    if let Kind::Pow(b, k) = &u.kind {
        if b.as_sym() == Some(x) {
            if let Some(k) = k.as_i64().filter(|k| *k >= 2) {
                return map_pow(&g, &mut |b2, e| {
                    let j = e.as_i64()?;
                    (b2.as_sym() == Some(x) && j % k == 0).then(|| pow(us, &int(j / k)))
                }, x);
            }
        }
    }
    if let Kind::Pow(l, r) = &u.kind {
        if let Some(r) = r.as_rat() {
            if !r.is_integer() {
                let k = Q::from_integer(r.denom().clone());
                let l = l.clone();
                return map_pow(&g, &mut |b, e| {
                    if b == &l {
                        if let Some(p) = e.as_rat() {
                            let j = p * &k;
                            if j.is_integer() {
                                return Some(pow(us, &qnum(j)));
                            }
                        }
                    }
                    None
                }, x);
            }
        }
    }
    g
}

fn map_pow(e: &Expr, f: &mut dyn FnMut(&Expr, &Expr) -> Option<Expr>, x: &str) -> Expr {
    if !depends(e, x) {
        return e.clone();
    }
    if let Kind::Pow(b, n) = &e.kind {
        if let Some(r) = f(b, n) {
            return r;
        }
    }
    rebuild(e, e.children().iter().map(|c| map_pow(c, f, x)).collect())
}

/// x in terms of u = us for invertible inner expressions.
fn inverse(u: &Expr, x: &str, us: &Expr) -> Option<Expr> {
    if let Some((a, b)) = linear(u, x) {
        return Some(div(&sub(us, &b), &a));
    }
    match &u.kind {
        Kind::Pow(b, n) if !depends(n, x) && n.as_rat().map_or(false, |r| r.numer() == &1.into() && !r.is_integer()) => {
            // u = (a x + c)^(1/k): x = (u^k - c)/a
            let (a, c) = linear(b, x)?;
            Some(div(&sub(&pow(us, &recip(n)), &c), &a))
        }
        Kind::Pow(b, e) if b.is_const(Const::E) => {
            let (a, c) = linear(e, x)?;
            Some(div(&sub(&log(us), &c), &a))
        }
        Kind::Fun(Fun::Log, a) => {
            let (k, c) = linear(&a[0], x)?;
            Some(div(&sub(&exp(us), &c), &k))
        }
        Kind::Mul(v) if v.len() == 2 && !depends(&v[0], x) => inverse(&v[1], x, &div(us, &v[0])),
        _ => None,
    }
}

/// Hyperbolic functions as exponentials.
fn to_exp(e: &Expr, x: &str, found: &mut bool) -> Expr {
    if !depends(e, x) {
        return e.clone();
    }
    if let Kind::Fun(g, a) = &e.kind {
        if a.len() == 1 {
            let u = to_exp(&a[0], x, found);
            let (p, m) = (exp(&u), exp(&neg(&u)));
            let r = match g {
                Fun::Sinh => Some(div(&sub(&p, &m), &int(2))),
                Fun::Cosh => Some(div(&add2(&p, &m), &int(2))),
                Fun::Tanh => Some(div(&sub(&p, &m), &add2(&p, &m))),
                Fun::Coth => Some(div(&add2(&p, &m), &sub(&p, &m))),
                Fun::Sech => Some(div(&int(2), &add2(&p, &m))),
                Fun::Csch => Some(div(&int(2), &sub(&p, &m))),
                _ => None,
            };
            if let Some(r) = r {
                *found = true;
                return r;
            }
        }
    }
    rebuild(e, e.children().iter().map(|c| to_exp(c, x, found)).collect())
}

/// Whether e is built from sin(u), cos(u) (one u) and constants by + * and
/// integer powers.
fn only_sin_cos(e: &Expr, x: &str, arg: &mut Option<Expr>) -> bool {
    if !depends(e, x) {
        return true;
    }
    match &e.kind {
        Kind::Fun(Fun::Sin | Fun::Cos, a) => {
            if arg.as_ref().map_or(false, |u| u != &a[0]) {
                return false;
            }
            *arg = Some(a[0].clone());
            true
        }
        Kind::Pow(b, n) => n.as_i64().is_some() && only_sin_cos(b, x, arg),
        Kind::Add(v) | Kind::Mul(v) => v.iter().all(|t| only_sin_cos(t, x, arg)),
        _ => false,
    }
}

/// Inner expressions u for derivative-divides: function arguments, bases
/// and exponents of powers.
fn collect_inner(e: &Expr, x: &str, out: &mut Vec<Expr>) {
    if !depends(e, x) {
        return;
    }
    match &e.kind {
        Kind::Fun(_, a) => {
            for t in a {
                if depends(t, x) {
                    out.push(t.clone());
                }
                collect_inner(t, x, out);
            }
            out.push(e.clone());
        }
        Kind::Pow(b, n) => {
            if depends(b, x) {
                out.push(b.clone());
            }
            if depends(n, x) {
                out.push(n.clone());
                out.push(e.clone());
            }
            if let Some(r) = n.as_rat() {
                // a radical of a linear expression: u = (a x + b)^(1/k)
                if !r.is_integer() && linear(b, x).is_some() {
                    out.push(pow(b, &qnum(Q::new(1.into(), r.denom().clone()))));
                }
            }
            collect_inner(b, x, out);
            collect_inner(n, x, out);
        }
        Kind::Add(v) | Kind::Mul(v) => {
            for t in v {
                collect_inner(t, x, out);
            }
        }
        _ => {}
    }
}

/// The rates k of every e^(k x) in e (None if e has another kind of x).
fn collect_exp_rates(e: &Expr, x: &str, out: &mut Vec<Q>) -> Option<()> {
    if !depends(e, x) {
        return Some(());
    }
    match &e.kind {
        Kind::Pow(b, n) if b.is_const(Const::E) => {
            let (a, c) = linear(n, x)?;
            if !c.is_zero() {
                return None;
            }
            out.push(a.as_rat()?.clone());
            Some(())
        }
        Kind::Pow(b, n) if n.as_i64().is_some() => collect_exp_rates(b, x, out),
        Kind::Add(v) | Kind::Mul(v) => {
            for t in v {
                collect_exp_rates(t, x, out)?;
            }
            Some(())
        }
        _ => None,
    }
}

fn map_exp(e: &Expr, x: &str, g: &Q, w: &Expr, ok: &mut bool) -> Expr {
    if !depends(e, x) {
        return e.clone();
    }
    match &e.kind {
        Kind::Pow(b, n) if b.is_const(Const::E) => {
            let Some((a, _)) = linear(n, x) else {
                *ok = false;
                return e.clone();
            };
            let k = a.as_rat().cloned().unwrap_or_default() / g;
            if !k.is_integer() {
                *ok = false;
                return e.clone();
            }
            pow(w, &qnum(k))
        }
        _ => rebuild(e, e.children().iter().map(|c| map_exp(c, x, g, w, ok)).collect()),
    }
}

fn gcd_q(a: &Q, b: &Q) -> Q {
    let n = num_integer::gcd(a.numer().clone() * b.denom().clone(), b.numer().clone() * a.denom().clone());
    Q::new(n, a.denom().clone() * b.denom().clone())
}

// ------------------------------------------------------------------ definite

/// The definite integral from a to b: F(b) - F(a) through one-sided
/// limits (which also handles infinite bounds).  None if no antiderivative
/// was found; an error if the integral diverges.
pub fn definite(f: &Expr, x: &str, a: &Expr, b: &Expr) -> Option<Expr> {
    let big_f = integrate(f, x)?;
    if let Some(p) = interior_pole(f, x, a, b) {
        let _ = p;
        crate::err::value_error("Integral is divergent.");
    }
    let fb = crate::limit::limit(&big_f, x, b, crate::limit::Dir::Minus);
    let fa = crate::limit::limit(&big_f, x, a, crate::limit::Dir::Plus);
    if fb.is_infinite() || fa.is_infinite() || has_bad(&fb) || has_bad(&fa) {
        crate::err::value_error("Integral is divergent.");
    }
    let r = sub(&fb, &fa);
    let s = simplify_rational(&r);
    Some(if crate::simplify::size(&s) <= crate::simplify::size(&r) { s } else { r })
}

/// A real zero of f's denominator strictly between a and b.
fn interior_pole(f: &Expr, x: &str, a: &Expr, b: &Expr) -> Option<f64> {
    let (av, bv) = (crate::eval::to_f64(a).unwrap_or(f64::NEG_INFINITY), crate::eval::to_f64(b).unwrap_or(f64::INFINITY));
    let (_, d) = together(f);
    let qd = QPoly::from_expr(&d, x)?;
    for (p, _) in qd.factor() {
        if p.deg() == 1 {
            let r = -p.coeff(0) / p.coeff(1);
            let rv = crate::eval::to_f64(&qnum(r))?;
            if av < rv && rv < bv {
                return Some(rv);
            }
        }
    }
    None
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;

    fn check(f: &str, expect: Option<&str>) {
        let e = parse(f);
        let r = integrate(&e, "x");
        match (r, expect) {
            (Some(r), Some(s)) => assert_eq!(crate::to_string(&r), s, "integrate({})", f),
            (Some(r), None) => println!("integrate({}) = {}", f, crate::to_string(&r)),
            (None, Some(s)) => panic!("integrate({}) failed, expected {}", f, s),
            (None, None) => {}
        }
    }

    #[test]
    fn basics() {
        check("x^2", Some("1/3*x^3"));
        check("1/x", Some("log(x)"));
        check("sin(x)", Some("-cos(x)"));
        check("exp(2*x)", Some("1/2*e^(2*x)"));
        check("1/(1 + x^2)", Some("arctan(x)"));
    }
}
