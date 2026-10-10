//! Ordinary differential equations, Sage's desolve: first order
//! (linear, separable, Bernoulli, exact, homogeneous) and second-order
//! linear equations with constant coefficients (particular solutions by
//! variation of parameters) or of Cauchy-Euler type; with initial
//! conditions.  Answers take Maxima's forms (what Sage's desolve returns):
//! the constants _C, _K1, _K2, explicit solutions for linear equations,
//! implicit ones (an equation) for separable and exact equations.

use crate::diff::{depends, diff};
use crate::err::{not_implemented, value_error};
use crate::expand::expand;
use crate::expr::*;
use crate::integrate::integrate;
use crate::simplify::{simplify_full, simplify_rational, together};

const Y0: &str = "__ode_y";
const Y1: &str = "__ode_y1";
const Y2: &str = "__ode_y2";

/// Solve de (an equation or an expression = 0) for the function y of x.
/// ics: [x0, y0] or [x0, y0, y'(x0)].
///
/// A user's symbol that is also an internal name (__ode_y, _C, ...) is
/// renamed for the computation, and a generated constant that would
/// coincide with it gets another name (_C1, ...): no capture.
pub fn desolve(de: &Expr, y: &str, x: &str, ics: &[Expr]) -> Expr {
    let reserved = |s: &str| s.starts_with("__ode") || s == "_C" || s == "_K1" || s == "_K2";
    let mut names = free_symbols(de);
    for e in ics {
        names.extend(free_symbols(e));
    }
    names.push(x.to_string());
    let clashes: Vec<String> = names.iter().filter(|s| reserved(s)).cloned().collect();
    if clashes.is_empty() {
        return desolve_inner(de, y, x, ics);
    }
    let mut avoid = names.clone();
    let mut fwd = vec![];
    let mut back = vec![];
    for c in &clashes {
        let t = fresh("u", &avoid);
        avoid.push(t.clone());
        fwd.push((sym(c), sym(&t)));
        back.push((sym(&t), sym(c)));
    }
    let de2 = subs(de, &fwd);
    let ics2: Vec<Expr> = ics.iter().map(|e| subs(e, &fwd)).collect();
    let sol = desolve_inner(&de2, y, x, &ics2);
    // generated constants that coincide with a user's symbol: rename them
    let mut gen = vec![];
    for k in ["_C", "_K1", "_K2"] {
        if clashes.iter().any(|c| c == k) {
            let t = fresh(k, &avoid);
            avoid.push(t.clone());
            gen.push((sym(k), sym(&t)));
        }
    }
    subs(&subs(&sol, &gen), &back)
}

fn desolve_inner(de: &Expr, y: &str, x: &str, ics: &[Expr]) -> Expr {
    let f = match &de.kind {
        Kind::Rel(Rel::Eq, a, b) => sub(a, b),
        Kind::Rel(..) => value_error("desolve: an equation (==) is needed"),
        _ => de.clone(),
    };
    let (g, order) = to_symbols(&f, y, x);
    if depends_on_y_badly(&g, y) {
        not_implemented("desolve: the function appears with other arguments");
    }
    let yx = fun(Fun::User(y.into()), vec![sym(x)]);
    if order >= 1 && !ics.is_empty() && ics.len() != order + 1 {
        value_error(if order == 1 { "desolve: ics must be [x0, y0]" } else { "desolve: ics must be [x0, y0, y'(x0)]" });
    }
    // y(x0) = y0 at an equilibrium (y' = G(x, y) with G(x, y0) = 0 for all
    // x): the constant y0, which separation (dividing by G's factor in y)
    // would lose
    if order == 1 && ics.len() == 2 && free_symbols(&ics[1]).is_empty() {
        if let Some(cs) = crate::poly::coeffs(&g, Y1) {
            if cs.len() == 2 {
                let at = |t: &Expr| simplify_full(&subs(t, &[(sym(Y0), ics[1].clone())]));
                if at(&cs[0]).is_zero() && !at(&cs[1]).is_zero() && solves(&g, &ics[1], x) {
                    return subs(&ics[1], &[(sym(Y0), yx)]);
                }
            }
        }
    }
    let sol = match order {
        1 => first_order(&g, x),
        2 => second_order(&g, x),
        0 => value_error("desolve: no derivative of the function in the equation"),
        _ => not_implemented("desolve: equations of order above 2"),
    };
    let sol = match sol {
        Some(s) => s,
        None => not_implemented("desolve: this type of equation is not supported yet"),
    };
    let sol = if ics.is_empty() { sol } else { apply_ics(&sol, x, ics, order) };
    // an explicit solution is checked by substituting it
    if !matches!(sol.kind, Kind::Rel(..)) && !solves(&g, &sol, x) {
        not_implemented("desolve: no verified solution found");
    }
    // back to y(x)
    subs(&sol, &[(sym(Y0), yx)])
}

/// Whether y = sol satisfies g(x, y, y', y'') = 0 (symbolically, else
/// numerically at a few points, with the constants given values).
fn solves(g: &Expr, sol: &Expr, x: &str) -> bool {
    let d1 = diff(sol, x);
    let d2 = diff(&d1, x);
    let r = subs(g, &[(sym(Y0), sol.clone()), (sym(Y1), d1.clone()), (sym(Y2), d2.clone())]);
    if r.is_zero() || simplify_full(&r).is_zero() {
        return true;
    }
    let mut checked = 0;
    let g0 = subs(g, &[(sym(Y0), zero()), (sym(Y1), zero()), (sym(Y2), zero())]);
    for p in [0.37, 1.13, 2.71, 0.61] {
        let env = |s: &str| -> Option<(f64, f64)> {
            match s {
                _ if s == x => Some((p, 0.0)),
                "_C" | "_K1" => Some((0.7, 0.0)),
                "_K2" => Some((-1.3, 0.0)),
                _ => Some((0.5, 0.0)),
            }
        };
        let Some(v) = crate::eval::to_c64_env(&r, &env) else { continue };
        if !v.0.is_finite() || !v.1.is_finite() {
            continue;
        }
        // relative to the solution and its derivatives (and the equation's
        // other terms through g(x, 0, 0, 0)): scaling must not hide a residual
        let size = |e: &Expr| crate::eval::to_c64_env(e, &env).map_or(0.0, |w| w.0.hypot(w.1));
        let scale = size(sol) + size(&d1) + size(&d2) + size(&g0);
        if v.0.hypot(v.1) > 1e-8 * scale.min(1.0) {
            return false;
        }
        checked += 1;
    }
    checked >= 2
}

/// y(x), y'(x), y''(x) as symbols; the order.
fn to_symbols(e: &Expr, y: &str, x: &str) -> (Expr, usize) {
    fn walk(t: &Expr, y: &str, xs: &Expr, order: &mut usize) -> Expr {
        match &t.kind {
            Kind::Fun(Fun::User(n), a) if &**n == y && a.len() == 1 && &a[0] == xs => sym(Y0),
            Kind::Fun(Fun::Deriv(n, idx), a) if &**n == y && a.len() == 1 && &a[0] == xs => {
                *order = (*order).max(idx.len());
                sym(match idx.len() {
                    1 => Y1,
                    2 => Y2,
                    _ => "__ode_high",
                })
            }
            _ if t.children().is_empty() => t.clone(),
            _ => rebuild(t, t.children().iter().map(|c| walk(c, y, xs, order)).collect()),
        }
    }
    let mut order = 0;
    let g = walk(e, y, &sym(x), &mut order);
    (g, order)
}

fn depends_on_y_badly(e: &Expr, y: &str) -> bool {
    match &e.kind {
        Kind::Fun(Fun::User(n), _) | Kind::Fun(Fun::Deriv(n, _), _) if &**n == y => true,
        _ => e.children().iter().any(|c| depends_on_y_badly(c, y)),
    }
}

fn c() -> Expr {
    sym("_C")
}

fn int_or_unevaluated(f: &Expr, x: &str) -> Expr {
    integrate(f, x).unwrap_or_else(|| fun(Fun::Integral, vec![f.clone(), sym(x)]))
}

// ------------------------------------------------------------------ first order

fn first_order(g: &Expr, x: &str) -> Option<Expr> {
    let y = sym(Y0);
    // A y' + B = 0
    let cs = crate::poly::coeffs(g, Y1)?;
    if cs.len() != 2 {
        return None;
    }
    let (b, a) = (&cs[0], &cs[1]);
    let rhs = simplify_rational(&neg(&div(b, a))); // y' = G(x, y)
    // linear: y' + p y = q
    if let Some(gc) = crate::poly::coeffs(&rhs, Y0) {
        if gc.len() <= 2 && gc.iter().all(|t| !depends(t, Y0)) {
            let q = gc[0].clone();
            let p = neg(gc.get(1).unwrap_or(&zero()));
            return Some(linear_first(&p, &q, x));
        }
    }
    // separable: G = g(x) h(y)
    if let Some((gx, hy)) = separate(&rhs, x) {
        let lhs = int_or_unevaluated(&recip(&hy), Y0);
        let r = add2(&int_or_unevaluated(&gx, x), &c());
        return Some(relation(Rel::Eq, &lhs, &r));
    }
    // exact: M + N y' = 0 with M_y = N_x
    if simplify_full(&sub(&diff(b, Y0), &diff(a, x))).is_zero() {
        let phi_x = int_or_unevaluated(b, x);
        let rest = simplify_full(&sub(a, &diff(&phi_x, Y0)));
        if !depends(&rest, x) {
            let phi = add2(&phi_x, &int_or_unevaluated(&rest, Y0));
            return Some(relation(Rel::Eq, &phi, &c()));
        }
    }
    // homogeneous: G(x, y) = H(y/x); y = v x
    let t = sym("__ode_t");
    let v = sym("__ode_v");
    let scaled = subs(&rhs, &[(sym(x), mul2(&t, &sym(x))), (y.clone(), mul2(&t, &y))]);
    if simplify_full(&sub(&scaled, &rhs)).is_zero() {
        let h = simplify_full(&subs(&rhs, &[(y.clone(), mul2(&v, &sym(x)))]));
        let h = subs(&h, &[(sym(x), one())]);
        if !depends(&h, x) {
            let lhs = int_or_unevaluated(&recip(&sub(&h, &v)), "__ode_v");
            let lhs = subs(&lhs, &[(v, div(&y, &sym(x)))]);
            return Some(relation(Rel::Eq, &lhs, &add2(&log(&sym(x)), &c())));
        }
    }
    // Bernoulli: y' = -p y + q y^n
    bernoulli(&rhs, x)
}

/// y' + p y = q: y = (int(q mu) + C)/mu with mu = e^(int p).
fn linear_first(p: &Expr, q: &Expr, x: &str) -> Expr {
    let ip = int_or_unevaluated(p, x);
    let mu = exp(&ip);
    let inner = if q.is_zero() { zero() } else { int_or_unevaluated(&simplify_full(&mul2(q, &mu)), x) };
    mul2(&add2(&inner, &c()), &exp(&neg(&ip)))
}

fn bernoulli(rhs: &Expr, x: &str) -> Option<Expr> {
    // terms: (coefficient in x) * y^k, with exactly k = 1 and one other k
    let e = expand(rhs);
    let terms = match &e.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![e.clone()],
    };
    let (mut p, mut q, mut n) = (zero(), zero(), None::<Expr>);
    for t in terms {
        let (cx, k) = y_power(&t)?;
        if k.is_one() {
            p = sub(&p, &cx);
        } else if k.is_zero() {
            return None;
        } else {
            if n.as_ref().map_or(false, |m| m != &k) {
                return None;
            }
            n = Some(k);
            q = add2(&q, &cx);
        }
    }
    let n = n?;
    // v = y^(1 - n): v' + (1 - n) p v = (1 - n) q
    let m = sub(&one(), &n);
    let v = linear_first(&mul2(&m, &p), &mul2(&m, &q), x);
    Some(pow(&v, &recip(&m)))
}

/// t = c(x) * y^k (k free of x): (c, k).
fn y_power(t: &Expr) -> Option<(Expr, Expr)> {
    let (mut cx, mut k) = (vec![], zero());
    for f in match &t.kind {
        Kind::Mul(v) => v.clone(),
        _ => vec![t.clone()],
    } {
        let (b, e) = base_exp(&f);
        if b.as_sym() == Some(Y0) && !depends(&e, Y0) {
            k = add2(&k, &e);
        } else if depends(&f, Y0) {
            return None;
        } else {
            cx.push(f);
        }
    }
    Some((mul(cx), k))
}

/// G(x, y) = g(x) h(y), from G's factors (after factoring).
fn separate(g: &Expr, x: &str) -> Option<(Expr, Expr)> {
    let gf = crate::simplify::factor(g);
    let mut fs = vec![];
    for f in match &gf.kind {
        Kind::Mul(v) => v.clone(),
        _ => vec![gf.clone()],
    } {
        // e^(x - y) = e^x e^(-y), kept apart (the product would merge them)
        match &f.kind {
            Kind::Pow(b, n) if b.is_const(Const::E) => match &expand(n).kind {
                Kind::Add(v) => fs.extend(v.iter().map(exp)),
                _ => fs.push(f.clone()),
            },
            _ => fs.push(f.clone()),
        }
    }
    let (mut gx, mut hy) = (vec![], vec![]);
    for f in fs {
        let (dx, dy) = (depends(&f, x), depends(&f, Y0));
        match (dx, dy) {
            (true, true) => return None,
            (false, true) => hy.push(f),
            _ => gx.push(f),
        }
    }
    if hy.is_empty() {
        return None;
    }
    Some((mul(gx), mul(hy)))
}

// ------------------------------------------------------------------ second order

fn second_order(g: &Expr, x: &str) -> Option<Expr> {
    let xs = sym(x);
    let e = expand(g);
    let c2 = crate::poly::coeffs(&e, Y2)?;
    if c2.len() != 2 {
        return None;
    }
    let a = c2[1].clone();
    let rest = &c2[0];
    let c1 = crate::poly::coeffs(rest, Y1)?;
    let b = c1.get(1).cloned().unwrap_or_else(zero);
    let c0 = crate::poly::coeffs(&c1[0], Y0)?;
    let cc = c0.get(1).cloned().unwrap_or_else(zero);
    let r = neg(&c0[0]);
    if [&a, &b, &cc, &r].iter().any(|t| depends(t, Y0) || depends(t, Y1) || depends(t, Y2)) || c1.len() > 2 || c0.len() > 2 {
        return None;
    }
    let (k1, k2) = (sym("_K1"), sym("_K2"));
    let (y1, y2) = if !depends(&a, x) && !depends(&b, x) && !depends(&cc, x) {
        constant_coefficients(&a, &b, &cc, &xs)?
    } else {
        cauchy_euler(&a, &b, &cc, x)?
    };
    // Sage's constants: _K2 with the cosine (or the second root), _K1 with the first
    let yh = add2(&mul2(&k1, &y1), &mul2(&k2, &y2));
    if r.is_zero() {
        return Some(yh);
    }
    if !depends(&a, x) && !depends(&b, x) && !depends(&cc, x) {
        if let Some(yp) = undetermined(&a, &b, &cc, &r, x) {
            return Some(add2(&yh, &yp));
        }
    }
    // variation of parameters
    let w = simplify_full(&sub(&mul2(&y1, &diff(&y2, x)), &mul2(&diff(&y1, x), &y2)));
    let f = div(&r, &a);
    let u1 = int_or_unevaluated(&simplify_full(&neg(&div(&mul2(&y2, &f), &w))), x);
    let u2 = int_or_unevaluated(&simplify_full(&div(&mul2(&y1, &f), &w)), x);
    let yp = crate::simplify::simplify_trig(&simplify_full(&add2(&mul2(&u1, &y1), &mul2(&u2, &y2))));
    Some(add2(&yh, &yp))
}

/// A particular solution of a y'' + b y' + c y = r by undetermined
/// coefficients, for r a sum of P(x) e^(alpha x) cos(beta x) and sin(beta x).
fn undetermined(a: &Expr, b: &Expr, c: &Expr, r: &Expr, x: &str) -> Option<Expr> {
    let xs = sym(x);
    let terms = match &expand(r).kind {
        Kind::Add(v) => v.clone(),
        _ => vec![expand(r)],
    };
    // group the terms by (alpha, beta)
    let mut groups: Vec<(Expr, Expr, Vec<Expr>)> = vec![];
    for t in terms {
        let (mut alpha, mut beta) = (zero(), zero());
        let mut deg = 0i64;
        for f in match &t.kind {
            Kind::Mul(v) => v.clone(),
            _ => vec![t.clone()],
        } {
            if !depends(&f, x) {
                continue;
            }
            let (bs, k) = base_exp(&f);
            if bs == xs {
                deg += k.as_i64().filter(|k| *k >= 0)?;
                continue;
            }
            match &f.kind {
                Kind::Pow(e0, n) if e0.is_const(Const::E) => {
                    let cs = crate::poly::coeffs(n, x)?;
                    if cs.len() != 2 {
                        return None;
                    }
                    alpha = add2(&alpha, &cs[1]);
                }
                Kind::Fun(Fun::Sin | Fun::Cos, args) => {
                    let cs = crate::poly::coeffs(&args[0], x)?;
                    if cs.len() != 2 || !cs[0].is_zero() || !beta.is_zero() {
                        return None;
                    }
                    beta = cs[1].clone();
                }
                _ => return None,
            }
        }
        let _ = deg;
        match groups.iter_mut().find(|g| g.0 == alpha && g.1 == beta) {
            Some(g) => g.2.push(t),
            None => groups.push((alpha, beta, vec![t])),
        }
    }
    let mut out = vec![];
    for (alpha, beta, ts) in groups {
        let rg = add(ts);
        // the degree of the polynomial part
        let mut d = 0;
        let probe = subs(&rg, &[(exp(&mul2(&alpha, &xs)), one())]);
        for t in [sin(&mul2(&beta, &xs)), cos(&mul2(&beta, &xs))] {
            let p = subs(&probe, &[(t, one())]);
            if let Some(cs) = crate::poly::coeffs(&p, x) {
                d = d.max(cs.len() as i64 - 1);
            }
        }
        // the multiplicity of alpha + i beta as a root of a m^2 + b m + c
        let m = add2(&alpha, &mul2(&beta, &i()));
        let chi = expand(&add(vec![mul2(a, &pow(&m, &int(2))), mul2(b, &m), c.clone()]));
        let dchi = expand(&add2(&mul(vec![int(2), a.clone(), m.clone()]), b));
        let s = if !chi.is_zero() { 0 } else if !dchi.is_zero() { 1 } else { 2 };
        // trial: x^s e^(alpha x) (A(x) cos(beta x) + B(x) sin(beta x))
        let (mut names, mut pa, mut pb) = (vec![], vec![], vec![]);
        for k in 0..=d {
            let an = format!("__uc_a{}", k);
            pa.push(mul2(&sym(&an), &pow(&xs, &int(k))));
            names.push(an);
            if !beta.is_zero() {
                let bn = format!("__uc_b{}", k);
                pb.push(mul2(&sym(&bn), &pow(&xs, &int(k))));
                names.push(bn);
            }
        }
        let (bc, bsn) = (cos(&mul2(&beta, &xs)), sin(&mul2(&beta, &xs)));
        let inner = if beta.is_zero() { add(pa) } else { add2(&mul2(&add(pa), &bc), &mul2(&add(pb), &bsn)) };
        let trial = mul(vec![pow(&xs, &int(s)), exp(&mul2(&alpha, &xs)), inner]);
        let lhs = add(vec![mul2(a, &diff(&diff(&trial, x), x)), mul2(b, &diff(&trial, x)), mul2(c, &trial)]);
        let resid = expand(&mul2(&sub(&lhs, &rg), &exp(&neg(&mul2(&alpha, &xs)))));
        // the coefficients of x^k cos, x^k sin vanish
        let (cs_, ss_) = (sym("__uc_C"), sym("__uc_S"));
        let resid = expand(&subs(&resid, &[(bc.clone(), cs_.clone()), (bsn.clone(), ss_.clone())]));
        let mut eqs = vec![];
        for part in crate::poly::coeffs(&resid, "__uc_C")? {
            for q in crate::poly::coeffs(&part, "__uc_S")? {
                for e in crate::poly::coeffs(&q, x)? {
                    if !e.is_zero() {
                        eqs.push(relation(Rel::Eq, &e, &zero()));
                    }
                }
            }
        }
        let sol = crate::solve::solve(&eqs, &names);
        let sol = sol.first()?;
        let mut rules = vec![];
        for rel in sol {
            if let Kind::Rel(Rel::Eq, l, v) = &rel.kind {
                rules.push((l.clone(), v.clone()));
            }
        }
        // unknowns the equations left free are 0
        for n in &names {
            if !rules.iter().any(|(l, _)| l.as_sym() == Some(n.as_str())) {
                rules.push((sym(n), zero()));
            }
        }
        out.push(expand(&subs(&trial, &rules)));
    }
    Some(add(out))
}

/// a y'' + b y' + c y = 0 with constant a, b, c: two solutions.
fn constant_coefficients(a: &Expr, b: &Expr, c: &Expr, x: &Expr) -> Option<(Expr, Expr)> {
    let disc = simplify_full(&sub(&pow(b, &int(2)), &mul(vec![int(4), a.clone(), c.clone()])));
    let two_a = mul2(&int(2), a);
    let alpha = simplify_full(&neg(&div(b, &two_a)));
    if disc.is_zero() {
        let e = exp(&mul2(&alpha, x));
        return Some((e.clone(), mul2(x, &e)));
    }
    let dv = crate::eval::to_f64(&disc)?;
    if dv > 0.0 {
        let s = div(&sqrt(&disc), &two_a);
        let (m1, m2) = (simplify_full(&add2(&alpha, &s)), simplify_full(&sub(&alpha, &s)));
        return Some((exp(&mul2(&m1, x)), exp(&mul2(&m2, x))));
    }
    let beta = simplify_full(&div(&sqrt(&neg(&disc)), &two_a));
    let e = exp(&mul2(&alpha, x));
    Some((mul2(&e, &sin(&mul2(&beta, x))), mul2(&e, &cos(&mul2(&beta, x)))))
}

/// A x^2 y'' + B x y' + C y = 0: y = x^m.
fn cauchy_euler(a: &Expr, b: &Expr, c: &Expr, x: &str) -> Option<(Expr, Expr)> {
    let xs = sym(x);
    let aa = simplify_rational(&div(a, &pow(&xs, &int(2))));
    let bb = simplify_rational(&div(b, &xs));
    if depends(&aa, x) || depends(&bb, x) || depends(c, x) {
        return None;
    }
    // A m (m - 1) + B m + C = A m^2 + (B - A) m + C
    let lx = log(&xs);
    let (u1, u2) = constant_coefficients(&aa, &sub(&bb, &aa), c, &sym("__ode_t"))?;
    let back = |e: &Expr| simplify_full(&subs(e, &[(sym("__ode_t"), lx.clone())]));
    Some((back(&u1), back(&u2)))
}

// ------------------------------------------------------------------ initial conditions

fn apply_ics(sol: &Expr, x: &str, ics: &[Expr], order: usize) -> Expr {
    let xs = sym(x);
    let y = sym(Y0);
    if order == 1 {
        if ics.len() < 2 {
            value_error("desolve: ics must be [x0, y0]");
        }
        let (x0, y0) = (&ics[0], &ics[1]);
        let eq = match &sol.kind {
            Kind::Rel(Rel::Eq, l, r) => sub(&subs(l, &[(xs.clone(), x0.clone()), (y.clone(), y0.clone())]), &subs(r, &[(xs.clone(), x0.clone()), (y.clone(), y0.clone())])),
            _ => sub(&subs(sol, &[(xs.clone(), x0.clone())]), y0),
        };
        let cv = solve_constant(&eq, "_C");
        return simplify_constants(&subs(sol, &[(c(), cv)]));
    }
    if ics.len() < 3 {
        value_error("desolve: ics must be [x0, y0, y'(x0)]");
    }
    let (x0, y0, dy0) = (&ics[0], &ics[1], &ics[2]);
    let e1 = sub(&subs(sol, &[(xs.clone(), x0.clone())]), y0);
    let e2 = sub(&subs(&diff(sol, x), &[(xs.clone(), x0.clone())]), dy0);
    let sols = crate::solve::solve(&[relation(Rel::Eq, &e1, &zero()), relation(Rel::Eq, &e2, &zero())], &["_K1".to_string(), "_K2".to_string()]);
    let Some(s) = sols.first() else { value_error("desolve: the initial conditions cannot be met") };
    let mut rules = vec![];
    for r in s {
        if let Kind::Rel(Rel::Eq, l, v) = &r.kind {
            rules.push((l.clone(), v.clone()));
        }
    }
    simplify_constants(&subs(sol, &rules))
}

fn solve_constant(eq: &Expr, name: &str) -> Expr {
    let s = crate::solve::solve1(&relation(Rel::Eq, eq, &zero()), name);
    match s.first().map(|r| &r.kind) {
        Some(Kind::Rel(Rel::Eq, _, v)) => v.clone(),
        _ => value_error("desolve: the initial condition cannot be met"),
    }
}

fn simplify_constants(e: &Expr) -> Expr {
    match &e.kind {
        Kind::Rel(r, a, b) => relation(*r, &simplify_constants(a), &simplify_constants(b)),
        _ => {
            let s = expand(e);
            let (n, d) = together(&s);
            if d.is_one() { s } else { simplify_rational(&div(&n, &d)) }
        }
    }
}
