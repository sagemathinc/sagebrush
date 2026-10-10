//! Solving equations: polynomial equations in one variable (factoring over
//! Q, then the linear and quadratic formulas, with symbolic coefficients
//! too), simple equations f(u) = c with f invertible (principal solutions,
//! as Sage gives them), and systems of linear equations.

use crate::diff::depends;
use crate::err::value_error;
use crate::expr::*;
use crate::poly::coeffs;
use crate::simplify::{simplify_rational, together};

/// The expression lhs - rhs of an equation (or e itself).
fn as_zero(e: &Expr) -> Expr {
    match &e.kind {
        Kind::Rel(Rel::Eq, a, b) => sub(a, b),
        Kind::Rel(..) => value_error("solve: only equations (==) are supported"),
        _ => e.clone(),
    }
}

fn eq(x: &Expr, v: &Expr) -> Expr {
    relation(Rel::Eq, x, v)
}

thread_local! {
    /// The factors whose roots were not found (returned as 0 == f, as Sage does).
    static UNSOLVED: std::cell::RefCell<Vec<Expr>> = const { std::cell::RefCell::new(vec![]) };
}

fn unsolved(f: &Expr) {
    UNSOLVED.with(|u| u.borrow_mut().push(f.clone()));
}

/// Solutions of one equation in x, as x == value relations, followed by
/// 0 == f for each factor f whose roots were not found (so a partial
/// answer is never mistaken for the whole solution set).  An identity
/// gives x == r1 with a new symbol r1.
pub fn solve1(e: &Expr, x: &str) -> Vec<Expr> {
    let xs = sym(x);
    let z = as_zero(e);
    let (n, _d) = together(&z);
    let n = crate::expand::expand(&n);
    if n.is_zero() || crate::simplify::simplify_full(&n).is_zero() {
        let used = free_symbols(&z);
        let r = (1..).map(|i| format!("r{}", i)).find(|r| r != x && !used.contains(r)).unwrap();
        return vec![eq(&xs, &sym(&r))];
    }
    UNSOLVED.with(|u| u.borrow_mut().clear());
    let mut roots = roots_of(&n, x);
    let rest: Vec<Expr> = UNSOLVED.with(|u| std::mem::take(&mut *u.borrow_mut()));
    // drop roots of the denominator, and candidates (principal values of
    // inverse functions) that do not satisfy the equation: a constant
    // residual that is not zero (sqrt(1) = 1 != -1, asin(0) = 0 != pi,
    // log(e^(4 I)) = (4 - 2 pi) I)
    roots.retain(|r| {
        let v = crate::err::soft(|| subs(&z, &[(xs.clone(), r.clone())]));
        if contains_infinity(&v) {
            return false;
        }
        if !free_symbols(&v).is_empty() || v.is_zero() {
            return true;
        }
        let sv = crate::simplify::simplify_full(&v);
        if sv.is_zero() {
            return true;
        }
        // a certified nonzero residual drops the candidate (sqrt(1) + 1 = 2,
        // also beside a root of size 10^12; 2 10^-20 is not 0 either)
        // (an equation with floating-point numbers: its roots are rounded, so
        // only the relative test below applies)
        if !has_float(&z) {
            if let Some((re, im)) = crate::domain::complex_encl(&sv) {
                return re.contains_zero() && im.contains_zero();
            }
        }
        // no enclosure: numerically, relative to the size of the equation's
        // terms at the candidate (not to the size of the candidate)
        let terms = match &z.kind {
            Kind::Add(t) => t.clone(),
            _ => vec![z.clone()],
        };
        let size = terms.iter().filter_map(|t| crate::eval::to_c64(&crate::err::soft(|| subs(t, &[(xs.clone(), r.clone())]))).map(|w| w.0.hypot(w.1))).fold(0.0f64, f64::max);
        match crate::eval::to_c64(&sv) {
            Some((re, im)) if re.is_finite() && im.is_finite() => re.hypot(im) <= 1e-12 * size,
            _ => true,
        }
    });
    sort_roots(&mut roots);
    let mut out: Vec<Expr> = roots.into_iter().map(|r| eq(&xs, &r)).collect();
    out.extend(rest.iter().map(|f| relation(Rel::Eq, &zero(), f)));
    out
}

fn has_float(e: &Expr) -> bool {
    matches!(&e.kind, Kind::Num(crate::num::Num::Float(..))) || e.children().iter().any(has_float)
}

fn contains_infinity(e: &Expr) -> bool {
    e.is_infinite() || e.is_const(Const::Undefined) || e.children().iter().any(contains_infinity)
}

fn sort_roots(r: &mut Vec<Expr>) {
    r.sort_by(|a, b| {
        let (u, v) = (crate::eval::to_c64(a), crate::eval::to_c64(b));
        match (u, v) {
            (Some(p), Some(q)) => p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal).then(p.1.partial_cmp(&q.1).unwrap_or(std::cmp::Ordering::Equal)),
            _ => std::cmp::Ordering::Equal,
        }
    });
    r.dedup();
}

/// The roots of n = 0 in x.
fn roots_of(n: &Expr, x: &str) -> Vec<Expr> {
    if !depends(n, x) {
        return vec![];
    }
    // a product: the roots of each factor
    let f = crate::simplify::factor(n);
    if let Kind::Mul(v) = &f.kind {
        let mut out = vec![];
        for g in v {
            let (b, _) = base_exp(g);
            out.extend(roots_of(&b, x));
        }
        return out;
    }
    if let Kind::Pow(b, k) = &f.kind {
        if k.as_num().map_or(false, |k| k.is_positive()) {
            return roots_of(b, x);
        }
    }
    let f = if matches!(f.kind, Kind::Mul(_) | Kind::Pow(..)) { n.clone() } else { f };
    if let Some(c) = coeffs(&f, x) {
        if c.iter().all(|a| !depends(a, x)) {
            let r = poly_roots(&c);
            if r.is_empty() && c.len() > 2 {
                unsolved(&f);
            }
            return r;
        }
    }
    invert(&f, x)
}

fn poly_roots(c: &[Expr]) -> Vec<Expr> {
    match c.len() {
        0 | 1 => vec![],
        2 => vec![simplify_rational(&neg(&div(&c[0], &c[1])))],
        3 => {
            let (a, b, cc) = (&c[2], &c[1], &c[0]);
            let disc = simplify_rational(&sub(&pow(b, &int(2)), &mul(vec![int(4), a.clone(), cc.clone()])));
            let sq = sqrt(&disc);
            let two_a = mul2(&int(2), a);
            vec![
                crate::expand::expand(&div(&sub(&neg(b), &sq), &two_a)),
                crate::expand::expand(&div(&add2(&neg(b), &sq), &two_a)),
            ]
        }
        _ => {
            // x^n = r (binomial): r^(1/n) e^(2 pi i k/n), k = 0, ..., n - 1
            let n = c.len() - 1;
            if c[1..n].iter().all(|t| t.is_zero()) && !c[0].is_zero() {
                let r = neg(&div(&c[0], &c[n]));
                let root = pow(&r, &rat(1, n as i64));
                return (0..n as i64)
                    .map(|k| if k == 0 { root.clone() } else { mul2(&root, &exp(&mul(vec![rat(2 * k, n as i64), pi(), num(crate::num::Num::i())]))) })
                    .collect();
            }
            not_solved()
        }
    }
}

fn not_solved() -> Vec<Expr> {
    vec![]
}

/// f(u) = 0 for f invertible: u = f^-1(...), principal values.
fn invert(e: &Expr, x: &str) -> Vec<Expr> {
    // e = g + c with c free of x, g = f(u)
    let (rest, c) = match &e.kind {
        Kind::Add(v) => {
            let dep: Vec<Expr> = v.iter().filter(|t| depends(t, x)).cloned().collect();
            let free: Vec<Expr> = v.iter().filter(|t| !depends(t, x)).cloned().collect();
            (add(dep), neg(&add(free)))
        }
        _ => (e.clone(), zero()),
    };
    // rest = k * g
    let (k, g) = split_coeff(&rest);
    let target = div(&c, &num(k));
    let (inner, val) = match &g.kind {
        Kind::Fun(Fun::Sin, a) => (a[0].clone(), fun1(Fun::Asin, &target)),
        Kind::Fun(Fun::Cos, a) => (a[0].clone(), fun1(Fun::Acos, &target)),
        Kind::Fun(Fun::Tan, a) => (a[0].clone(), fun1(Fun::Atan, &target)),
        Kind::Fun(Fun::Log, a) => (a[0].clone(), exp(&target)),
        Kind::Fun(Fun::Asin, a) => (a[0].clone(), sin(&target)),
        Kind::Fun(Fun::Atan, a) => (a[0].clone(), fun1(Fun::Tan, &target)),
        Kind::Fun(Fun::Sinh, a) => (a[0].clone(), fun1(Fun::Asinh, &target)),
        Kind::Pow(b, p) if b.is_const(Const::E) => (p.clone(), log(&target)),
        Kind::Pow(b, p) if !depends(b, x) => (p.clone(), div(&log(&target), &log(b))),
        Kind::Pow(b, p) if !depends(p, x) => (b.clone(), pow(&target, &recip(p))),
        _ => {
            unsolved(e);
            return vec![];
        }
    };
    if inner.as_sym() == Some(x) {
        return vec![val];
    }
    roots_of(&sub(&inner, &val), x)
}

/// Sage's solve for one equation, or a list of linear equations in several
/// variables: (list of solutions, each a list of x == value).
pub fn solve(eqs: &[Expr], vars: &[String]) -> Vec<Vec<Expr>> {
    if eqs.len() == 1 && vars.len() == 1 {
        return solve1(&eqs[0], &vars[0]).into_iter().map(|r| vec![r]).collect();
    }
    match linear_system(eqs, vars) {
        // an inconsistent system has no solutions (not one empty solution)
        Some(sol) if sol.is_empty() => vec![],
        Some(sol) => vec![sol],
        None => value_error("solve: only linear systems are supported for several equations"),
    }
}

/// Gaussian elimination on a linear system with symbolic coefficients.
fn linear_system(eqs: &[Expr], vars: &[String]) -> Option<Vec<Expr>> {
    let n = vars.len();
    let mut rows: Vec<Vec<Expr>> = vec![];
    for e in eqs {
        let z = crate::expand::expand(&as_zero(e));
        let mut row = vec![];
        let mut rest = z.clone();
        for v in vars {
            let c = crate::poly::coeffs(&z, v)?;
            if c.len() > 2 {
                return None;
            }
            let a = c.get(1).cloned().unwrap_or_else(zero);
            rest = sub(&rest, &mul2(&a, &sym(v)));
            row.push(a);
        }
        let rest = crate::expand::expand(&rest);
        if vars.iter().any(|v| depends(&rest, v)) {
            return None;
        }
        row.push(neg(&rest));
        rows.push(row);
    }
    // reduce
    let mut r = 0;
    let mut piv = vec![];
    for col in 0..n {
        let Some(p) = (r..rows.len()).find(|&i| !simplify_rational(&rows[i][col]).is_zero()) else { continue };
        rows.swap(r, p);
        let inv = recip(&rows[r][col]);
        rows[r] = rows[r].iter().map(|v| simplify_rational(&mul2(v, &inv))).collect();
        for i in 0..rows.len() {
            if i != r {
                let f = rows[i][col].clone();
                if !f.is_zero() {
                    rows[i] = rows[i].iter().zip(&rows[r]).map(|(a, b)| simplify_rational(&sub(a, &mul2(&f, b)))).collect();
                }
            }
        }
        piv.push(col);
        r += 1;
    }
    // inconsistent rows: no solution
    for row in &rows[r..] {
        if !row[n].is_zero() {
            return Some(vec![]);
        }
    }
    if piv.len() < n {
        return None; // underdetermined: not supported yet
    }
    Some((0..n).map(|i| eq(&sym(&vars[i]), &rows[i][n])).collect())
}
