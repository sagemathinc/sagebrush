//! Solving equations: polynomial equations in one variable (factoring over
//! Q, then the linear and quadratic formulas, with symbolic coefficients
//! too), simple equations f(u) = c with f invertible (principal solutions,
//! as Sage gives them), and systems of linear equations.

use crate::diff::depends;
use crate::err::value_error;
use crate::expr::*;
use crate::poly::coeffs;
use crate::simplify::{simplify_rational, together};
use crate::num::Q;
use num_traits::One;

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
        if v.is_zero() {
            return true;
        }
        if !free_symbols(&v).is_empty() {
            // with parameters: dropped only if the residual is clearly
            // nonzero at every sample (parameters of both signs), i.e. the
            // candidate fails for every real value tried (sqrt(x) = -e^a gave
            // x = e^(2 a), whose residual 2 e^a never vanishes: the
            // systematic review's R2-SYMALG-F1); conditional ones stay
            let sv = crate::simplify::simplify_full(&v);
            if sv.is_zero() {
                return true;
            }
            let terms = match &z.kind {
                Kind::Add(t) => t.clone(),
                _ => vec![z.clone()],
            };
            let mut nonzero_everywhere = true;
            let mut sampled = 0;
            for vals in [[0.7, 1.3], [-0.7, 1.9], [1.6, -0.45], [-1.15, -2.3]] {
                let env = |name: &str| -> Option<(f64, f64)> {
                    let h = name.bytes().fold(0usize, |h, b| h.wrapping_mul(31).wrapping_add(b as usize));
                    Some((vals[h % 2] * (1.0 + (h % 7) as f64 * 0.03), 0.0))
                };
                let Some((re, im)) = crate::eval::to_c64_env(&sv, &env) else { continue };
                if !re.is_finite() || !im.is_finite() {
                    continue;
                }
                let size = terms.iter().filter_map(|t| crate::eval::to_c64_env(&crate::err::soft(|| subs(t, &[(xs.clone(), r.clone())])), &env).map(|w| w.0.hypot(w.1))).fold(0.0f64, f64::max);
                sampled += 1;
                if re.hypot(im) <= 1e-9 * size.max(1e-300) {
                    nonzero_everywhere = false;
                }
            }
            return !(sampled >= 3 && nonzero_everywhere);
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

// ---------------------------------------------------------------------------
// Complete solutions with conditions (the public solve): unlike Sage, which
// gives generic and principal solutions only (solve(sqrt(x) == a, x) is
// x == a^2 whatever a; solve(a*x^2 + x - 1, x) divides by a; sin(x) == 0
// gives x == 0), each solution carries the conditions on the parameters
// under which it is one, the branches where a leading coefficient vanishes
// are solved too, and periodic functions give their whole families, in new
// integer parameters n1, n2, ...  (the systematic review's R2-SYMALG-F1/F3).

/// A solution x == val, valid when every relation in cond holds, for every
/// integer value of the parameters in params.
#[derive(Clone, Debug)]
pub struct Sol {
    pub val: Expr,
    pub cond: Vec<Expr>,
    pub params: Vec<String>,
}

thread_local! {
    /// The names in use (the equation's symbols and the new ones so far).
    static USED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(vec![]) };
}

fn fresh(prefix: &str) -> String {
    USED.with(|u| {
        let mut u = u.borrow_mut();
        let name = (1..).map(|i| format!("{}{}", prefix, i)).find(|n| !u.contains(n)).unwrap();
        u.push(name.clone());
        name
    })
}

fn plain(val: Expr) -> Sol {
    Sol { val, cond: vec![], params: vec![] }
}

/// May e vanish for some value of its symbols?  (A nonzero number cannot.)
fn maybe_zero(e: &Expr) -> bool {
    if free_symbols(e).is_empty() {
        return false;
    }
    !crate::simplify::simplify_full(e).is_zero()
}

/// e == 0 or e != 0, with a numeric factor of e dropped (2 a != 0 is a != 0),
/// and solved for its symbol when e is linear in one (a - 1 != 0 is a != 1).
fn zero_rel(r: Rel, e: &Expr) -> Expr {
    let e = crate::simplify::simplify_rational(e);
    let fs = free_symbols(&e);
    if fs.len() == 1 {
        if let Some(c) = coeffs(&crate::expand::expand(&e), &fs[0]) {
            if c.len() == 2 && c.iter().all(|t| free_symbols(t).is_empty()) && !c[1].is_zero() {
                return relation(r, &sym(&fs[0]), &simplify_rational(&neg(&div(&c[0], &c[1]))));
            }
        }
    }
    let (_, g) = split_coeff(&e);
    relation(r, &g, &zero())
}

/// log(t)/log(b) when t = b^m exactly for an integer m (b, t positive rationals).
fn exact_log(b: &Expr, t: &Expr) -> Option<Expr> {
    let (bq, tq) = (b.as_num()?.as_rat()?.clone(), t.as_num()?.as_rat()?.clone());
    use num_traits::{Signed, ToPrimitive};
    if !bq.is_positive() || !tq.is_positive() || bq.is_one() {
        return None;
    }
    let (bf, tf) = (bq.to_f64()?, tq.to_f64()?);
    let m = (tf.ln() / bf.ln()).round();
    if !m.is_finite() || m.abs() > 4096.0 {
        return None;
    }
    let m = m as i64;
    let mut p = Q::one();
    for _ in 0..m.unsigned_abs() {
        p = &p * &bq;
    }
    if m < 0 {
        p = p.recip();
    }
    (p == tq).then(|| int(m))
}

fn with_cond(mut s: Sol, c: &[Expr]) -> Sol {
    let mut cond = c.to_vec();
    cond.extend(s.cond);
    s.cond = cond;
    s
}

/// The roots of n = 0 in x, with conditions.  An n free of x that can
/// vanish (a, or the factor a of a x) gives every x where it does (the
/// review of solve's CSOL-F2: a x == 0 had only x == 0).
fn roots_c(n: &Expr, x: &str) -> Vec<Sol> {
    if !depends(n, x) {
        if maybe_zero(n) {
            return vec![Sol { val: sym(&fresh("r")), cond: vec![zero_rel(Rel::Eq, n)], params: vec![] }];
        }
        return vec![];
    }
    let f = crate::simplify::factor(n);
    if let Kind::Mul(v) = &f.kind {
        let mut out = vec![];
        for g in v {
            let (b, e) = base_exp(g);
            // (a negative power is a denominator: no roots)
            if e.as_num().map_or(false, |k| k.is_negative()) {
                continue;
            }
            out.extend(roots_c(&b, x));
        }
        return out;
    }
    if let Kind::Pow(b, k) = &f.kind {
        if k.as_num().map_or(false, |k| k.is_positive()) {
            return roots_c(b, x);
        }
    }
    let f = if matches!(f.kind, Kind::Mul(_) | Kind::Pow(..)) { n.clone() } else { f };
    if let Some(c) = coeffs(&f, x) {
        if c.iter().all(|a| !depends(a, x)) {
            return poly_roots_c(&c, &f, x);
        }
    }
    invert_c(&f, x)
}

/// The roots of the polynomial c[0] + c[1] x + ...: generic ones while the
/// leading coefficient is nonzero, and those of the lower-degree polynomial
/// where it vanishes.
fn poly_roots_c(c: &[Expr], f: &Expr, x: &str) -> Vec<Sol> {
    let mut c: Vec<Expr> = c.iter().map(crate::simplify::simplify_rational).collect();
    while c.len() > 1 && c.last().unwrap().is_zero() {
        c.pop();
    }
    if c.len() <= 1 {
        return vec![];
    }
    let lead = c.last().unwrap().clone();
    let generic = poly_roots(&c);
    if generic.is_empty() && c.len() > 3 {
        unsolved(f);
    }
    if !maybe_zero(&lead) {
        return generic.into_iter().map(plain).collect();
    }
    let ne = zero_rel(Rel::Ne, &lead);
    let mut out: Vec<Sol> = generic.into_iter().map(|v| Sol { val: v, cond: vec![ne.clone()], params: vec![] }).collect();
    // the leading coefficient vanishes
    let eqc = zero_rel(Rel::Eq, &lead);
    let lower = &c[..c.len() - 1];
    if lower.len() == 1 {
        // a constant c0: every x when c0 = 0 too
        let c0 = &lower[0];
        if c0.is_zero() || maybe_zero(c0) {
            let mut cond = vec![eqc];
            if !c0.is_zero() {
                cond.push(zero_rel(Rel::Eq, c0));
            }
            out.push(Sol { val: sym(&fresh("r")), cond, params: vec![] });
        }
        return out;
    }
    let g = add((0..lower.len()).map(|i| mul2(&lower[i], &pow(&sym(x), &int(i as i64)))).collect());
    out.extend(poly_roots_c(lower, &g, x).into_iter().map(|s| with_cond(s, &[eqc.clone()])));
    out
}

fn two_pi_n(n: &str, k: i64) -> Expr {
    // k pi n
    mul(vec![int(k), pi(), sym(n)])
}

/// f(u) = 0 for f invertible or periodic: every u, with conditions.
fn invert_c(e: &Expr, x: &str) -> Vec<Sol> {
    let (rest, c) = match &e.kind {
        Kind::Add(v) => {
            let dep: Vec<Expr> = v.iter().filter(|t| depends(t, x)).cloned().collect();
            let free: Vec<Expr> = v.iter().filter(|t| !depends(t, x)).cloned().collect();
            (add(dep), neg(&add(free)))
        }
        _ => (e.clone(), zero()),
    };
    let (k, g) = split_coeff(&rest);
    let t = crate::simplify::simplify_rational(&div(&c, &num(k)));
    let i = num(crate::num::Num::i());
    // (inner, values): inner = each value
    let (inner, vals): (Expr, Vec<Sol>) = match &g.kind {
        Kind::Fun(Fun::Sin, a) => {
            let n = fresh("n");
            let p = vec![n.clone()];
            let vs = if t.is_zero() {
                vec![two_pi_n(&n, 1)]
            } else if t == int(1) {
                vec![add2(&div(&pi(), &int(2)), &two_pi_n(&n, 2))]
            } else if t == int(-1) {
                vec![add2(&neg(&div(&pi(), &int(2))), &two_pi_n(&n, 2))]
            } else {
                let a0 = fun1(Fun::Asin, &t);
                vec![add2(&a0, &two_pi_n(&n, 2)), add2(&sub(&pi(), &a0), &two_pi_n(&n, 2))]
            };
            (a[0].clone(), vs.into_iter().map(|v| Sol { val: v, cond: vec![], params: p.clone() }).collect())
        }
        Kind::Fun(Fun::Cos, a) => {
            let n = fresh("n");
            let p = vec![n.clone()];
            let vs = if t.is_zero() {
                vec![add2(&div(&pi(), &int(2)), &two_pi_n(&n, 1))]
            } else if t == int(1) {
                vec![two_pi_n(&n, 2)]
            } else if t == int(-1) {
                vec![add2(&pi(), &two_pi_n(&n, 2))]
            } else {
                let a0 = fun1(Fun::Acos, &t);
                vec![add2(&a0, &two_pi_n(&n, 2)), add2(&neg(&a0), &two_pi_n(&n, 2))]
            };
            (a[0].clone(), vs.into_iter().map(|v| Sol { val: v, cond: vec![], params: p.clone() }).collect())
        }
        Kind::Fun(Fun::Tan, a) => {
            // tan omits exactly +-i (the review's CSOL-F6)
            let (pi_, mi_) = (sub(&t, &i), add2(&t, &i));
            if simplify_rational(&pi_).is_zero() || simplify_rational(&mi_).is_zero() {
                return vec![];
            }
            let n = fresh("n");
            let mut cond = vec![];
            if maybe_zero(&pi_) {
                cond.push(relation(Rel::Ne, &t, &i));
            }
            if maybe_zero(&mi_) {
                cond.push(relation(Rel::Ne, &t, &neg(&i)));
            }
            (a[0].clone(), vec![Sol { val: add2(&fun1(Fun::Atan, &t), &two_pi_n(&n, 1)), cond, params: vec![n] }])
        }
        Kind::Fun(Fun::Sinh, a) => {
            // sinh(u) = sinh(i pi - u), period 2 pi i
            let n = fresh("n");
            let a0 = fun1(Fun::Asinh, &t);
            let per = mul(vec![int(2), pi(), i.clone(), sym(&n)]);
            let vs = vec![add2(&a0, &per), add(vec![mul2(&pi(), &i), neg(&a0), per.clone()])];
            (a[0].clone(), vs.into_iter().map(|v| Sol { val: v, cond: vec![], params: vec![n.clone()] }).collect())
        }
        Kind::Pow(b, p) if b.is_const(Const::E) => {
            // e^u = t: u = log(t) + 2 pi i n (no solution for t = 0)
            if t.is_zero() {
                return vec![];
            }
            let n = fresh("n");
            let mut s = Sol { val: add2(&log(&t), &mul(vec![int(2), pi(), i.clone(), sym(&n)])), cond: vec![], params: vec![n] };
            if maybe_zero(&t) {
                s.cond.push(zero_rel(Rel::Ne, &t));
            }
            (p.clone(), vec![s])
        }
        Kind::Pow(b, p) if !depends(b, x) => {
            // b^u = t: u = (log(t) + 2 pi i n)/log(b) for b != 0, 1, t != 0;
            // with a symbolic base also b = 1 (every u if t = 1) and b = 0
            // (0^u = 0 for Re(u) > 0): the review's CSOL-F4
            let mut vs = vec![];
            if !t.is_zero() {
                let n = fresh("n");
                let per = div(&mul(vec![int(2), pi(), i.clone(), sym(&n)]), &log(b));
                let v = match exact_log(b, &t) {
                    Some(m) => add2(&m, &per),
                    None => div(&add2(&log(&t), &mul(vec![int(2), pi(), i.clone(), sym(&n)])), &log(b)),
                };
                let mut s = Sol { val: v, cond: vec![], params: vec![n] };
                if maybe_zero(&t) {
                    s.cond.push(zero_rel(Rel::Ne, &t));
                }
                if maybe_zero(b) {
                    s.cond.push(zero_rel(Rel::Ne, b));
                }
                if maybe_zero(&sub(b, &int(1))) {
                    s.cond.push(zero_rel(Rel::Ne, &sub(b, &int(1))));
                }
                vs.push(s);
            }
            if p.as_sym() == Some(x) {
                if maybe_zero(&sub(b, &int(1))) && (maybe_zero(&sub(&t, &int(1))) || t == int(1)) {
                    let mut cond = vec![zero_rel(Rel::Eq, &sub(b, &int(1)))];
                    if t != int(1) {
                        cond.push(zero_rel(Rel::Eq, &sub(&t, &int(1))));
                    }
                    vs.push(Sol { val: sym(&fresh("r")), cond, params: vec![] });
                }
                if maybe_zero(b) && (t.is_zero() || maybe_zero(&t)) {
                    let r = sym(&fresh("r"));
                    let mut cond = vec![zero_rel(Rel::Eq, b)];
                    if !t.is_zero() {
                        cond.push(zero_rel(Rel::Eq, &t));
                    }
                    cond.push(relation(Rel::Gt, &fun1(Fun::RealPart, &r), &zero()));
                    vs.push(Sol { val: r, cond, params: vec![] });
                }
            }
            if vs.is_empty() {
                return vec![];
            }
            (p.clone(), vs)
        }
        Kind::Fun(Fun::Log, a) => {
            // log(u) = t: u = e^t, when t is a value of the principal log:
            // -pi < Im(t) <= pi
            let im = fun1(Fun::ImagPart, &t);
            let s = Sol { val: exp(&t), cond: vec![relation(Rel::Gt, &im, &neg(&pi())), relation(Rel::Le, &im, &pi())], params: vec![] };
            (a[0].clone(), vec![s])
        }
        Kind::Pow(b, p) if !depends(p, x) => {
            // u^p = e^(p log u) = t, p = m/q rational: p log u = log t + 2 pi i k,
            // u = t^(1/p) e^(2 pi i k/p), for each k with Im(log u) in (-pi, pi],
            // i.e. -pi p < arg(t) + 2 pi k <= pi p (p > 0; u^p = 1/t^-1 for
            // p < 0): every branch (the review's CSOL-F3 missed all but one),
            // each with its condition on arg(t) (decided for a number: F5)
            match p.as_num().and_then(|q| q.as_rat()).cloned() {
                Some(q) if !q.denom().is_one() => {
                    use num_traits::{Signed, ToPrimitive};
                    let (pq, tt) = if q.is_negative() { (-q.clone(), recip(&t)) } else { (q.clone(), t.clone()) };
                    if q.is_negative() && t.is_zero() {
                        return vec![];
                    }
                    let pf = pq.to_f64().unwrap_or(1.0);
                    let kmax = (pf / 2.0 + 1.0).ceil() as i64;
                    let pe = num(crate::num::Num::rat(pq.clone()));
                    let ar = fun1(Fun::Arg, &tt);
                    let mut vs = vec![];
                    for kk in -kmax..=kmax {
                        // -pi p - 2 pi k < arg(t) <= pi p - 2 pi k, within (-pi, pi]
                        let lo = sub(&neg(&mul2(&pi(), &pe)), &mul(vec![int(2 * kk), pi()]));
                        let hi = sub(&mul2(&pi(), &pe), &mul(vec![int(2 * kk), pi()]));
                        let (lof, hif) = (-std::f64::consts::PI * pf - 2.0 * std::f64::consts::PI * kk as f64, std::f64::consts::PI * pf - 2.0 * std::f64::consts::PI * kk as f64);
                        if hif <= -std::f64::consts::PI || lof >= std::f64::consts::PI {
                            continue; // empty with arg in (-pi, pi]
                        }
                        let v = if kk == 0 {
                            pow(&tt, &recip(&pe))
                        } else {
                            mul2(&pow(&tt, &recip(&pe)), &exp(&div(&mul(vec![int(2 * kk), pi(), i.clone()]), &pe)))
                        };
                        let mut cond = vec![];
                        if lof > -std::f64::consts::PI {
                            cond.push(relation(Rel::Gt, &ar, &lo));
                        }
                        if hif < std::f64::consts::PI {
                            cond.push(relation(Rel::Le, &ar, &hi));
                        }
                        if t.is_zero() && kk != 0 {
                            continue;
                        }
                        vs.push(Sol { val: v, cond, params: vec![] });
                    }
                    (b.clone(), vs)
                }
                _ => {
                    // an irrational or symbolic exponent: the principal branch,
                    // when it is one; the others are not searched, so the
                    // equation is also reported unresolved
                    unsolved(e);
                    let v = pow(&t, &recip(p));
                    (b.clone(), vec![Sol { val: v.clone(), cond: vec![relation(Rel::Eq, &pow(&v, p), &t)], params: vec![] }])
                }
            }
        }
        Kind::Fun(f @ (Fun::Asin | Fun::Acos | Fun::Atan), a) => {
            // asin(u) = t: u = sin(t), when asin(sin(t)) = t
            let (fwd, v) = match f {
                Fun::Asin => (Fun::Asin, sin(&t)),
                Fun::Acos => (Fun::Acos, fun1(Fun::Cos, &t)),
                _ => (Fun::Atan, fun1(Fun::Tan, &t)),
            };
            // for a real number t the principal range: asin [-pi/2, pi/2],
            // acos [0, pi], atan (-pi/2, pi/2); else the identity itself
            let real_number = free_symbols(&t).is_empty() && crate::domain::complex_encl(&t).map_or(false, |(_, im)| im.0 == 0.0 && im.1 == 0.0);
            let h = div(&pi(), &int(2));
            let cond = if real_number {
                match fwd {
                    Fun::Asin => vec![relation(Rel::Ge, &t, &neg(&h)), relation(Rel::Le, &t, &h)],
                    Fun::Acos => vec![relation(Rel::Ge, &t, &zero()), relation(Rel::Le, &t, &pi())],
                    _ => vec![relation(Rel::Gt, &t, &neg(&h)), relation(Rel::Lt, &t, &h)],
                }
            } else {
                vec![relation(Rel::Eq, &fun1(fwd, &v), &t)]
            };
            (a[0].clone(), vec![Sol { val: v, cond, params: vec![] }])
        }
        _ => {
            unsolved(e);
            return vec![];
        }
    };
    if inner.as_sym() == Some(x) {
        return vals;
    }
    let mut out = vec![];
    for s in vals {
        for r in roots_c(&sub(&inner, &s.val), x) {
            let mut r = with_cond(r, &s.cond);
            let mut p = s.params.clone();
            p.extend(r.params);
            r.params = p;
            out.push(r);
        }
    }
    out
}

/// A relation between constants decided: Some(true/false), or None.
fn decide(c: &Expr) -> Option<bool> {
    let Kind::Rel(r, a, b) = &c.kind else { return None };
    let d = crate::simplify::simplify_full(&sub(a, b));
    if d.is_zero() {
        return Some(matches!(r, Rel::Eq | Rel::Le | Rel::Ge));
    }
    if !free_symbols(&d).is_empty() {
        return None;
    }
    let (re, im) = crate::domain::complex_encl(&d)?;
    if re.contains_zero() && im.contains_zero() {
        return None;
    }
    let nonzero = true;
    match r {
        Rel::Eq => Some(!nonzero),
        Rel::Ne => Some(nonzero),
        _ => {
            if !im.contains_zero() {
                return None; // complex: no order
            }
            let pos = re.0 > 0.0;
            let negv = re.1 < 0.0;
            if !pos && !negv {
                return None;
            }
            Some(match r {
                Rel::Lt | Rel::Le => negv,
                _ => pos,
            })
        }
    }
}

/// Is the candidate a solution where its conditions hold?  Some(true) or
/// Some(false) when the residual decides it (exactly, or by an enclosure,
/// or relative to the terms for an equation with floating-point numbers),
/// None when it cannot be decided: then the equation is reported
/// unresolved, so that [] means no solution (the review's recommendation).
/// A family's values at a few integers check its formula; the family itself
/// comes from the functions' periods.
fn holds(z: &Expr, xs: &Expr, s: &Sol) -> Option<bool> {
    // a family: the integer values where its conditions do not fail (n1 = 2
    // is excluded by n1 != 2), checked exactly; the family itself comes from
    // the functions' periods, and these values check its formula
    let samples: Vec<Vec<(Expr, Expr)>> = if s.params.is_empty() {
        vec![vec![]]
    } else {
        let all: Vec<Vec<(Expr, Expr)>> = [0i64, 1, -1, 2, -2, 3, -3].iter().map(|&k| s.params.iter().map(|p| (sym(p), int(k))).collect()).collect();
        let ok: Vec<Vec<(Expr, Expr)>> = all.into_iter().filter(|sub0| s.cond.iter().all(|c| decide(&subs(c, sub0)) != Some(false))).take(3).collect();
        if ok.is_empty() {
            return None;
        }
        ok
    };
    let mut verdict = Some(true);
    for sub0 in &samples {
        let v = holds_at(z, xs, s, sub0);
        match v {
            Some(false) => return Some(false),
            None => verdict = None,
            _ => {}
        }
    }
    verdict
}

fn holds_at(z: &Expr, xs: &Expr, s: &Sol, sub0: &[(Expr, Expr)]) -> Option<bool> {
    {
        let r = subs(&s.val, sub0);
        let v = crate::err::soft(|| subs(z, &[(xs.clone(), r.clone())]));
        if contains_infinity(&v) {
            return Some(false);
        }
        let v = subs(&v, sub0);
        if v.is_zero() {
            return Some(true);
        }
        let sv = crate::simplify::simplify_full(&v);
        if sv.is_zero() {
            return Some(true);
        }
        // an exact number: zero or not, exactly (2 10^-400 is not 0, though
        // an enclosure in doubles underflows to contain 0: CSOL-F5)
        if let Some(q) = sv.as_num() {
            if q.is_exact() {
                return Some(q.is_zero());
            }
        }
        if !free_symbols(&sv).is_empty() {
            // the conditions say when; without any, the candidate claims
            // every parameter value: false when it fails at every sample
            // (then it is no solution for those values), else undecided
            if !s.cond.is_empty() {
                return Some(true);
            }
            return if nonzero_at_samples(&sv, z, xs, &r) { Some(false) } else { None };
        }
        if !has_float(z) {
            if let Some((re, im)) = crate::domain::complex_encl(&sv) {
                // an enclosure excluding 0 proves the residual nonzero; one
                // holding 0 is numerical agreement only (the residual is a
                // constant the simplifier did not reduce)
                return Some(re.contains_zero() && im.contains_zero());
            }
        }
        let terms = match &z.kind {
            Kind::Add(t) => t.clone(),
            _ => vec![z.clone()],
        };
        let size = terms.iter().filter_map(|t| crate::eval::to_c64(&crate::err::soft(|| subs(t, &[(xs.clone(), r.clone())]))).map(|w| w.0.hypot(w.1))).fold(0.0f64, f64::max);
        // numerically, relative to the size of the equation's terms (an
        // unreduced constant residual such as sqrt(2 I) - 1 - I); a residual
        // that cannot be evaluated is not decided: neither accepted nor
        // dropped (CSOL-F6)
        match crate::eval::to_c64(&sv) {
            Some((re, im)) if re.is_finite() && im.is_finite() && size.is_finite() && size > 0.0 => Some(re.hypot(im) <= 1e-12 * size),
            _ => None,
        }
    }
}

/// The residual is clearly nonzero at every (real) sample of the parameters.
fn nonzero_at_samples(sv: &Expr, z: &Expr, xs: &Expr, r: &Expr) -> bool {
    let terms = match &z.kind {
        Kind::Add(t) => t.clone(),
        _ => vec![z.clone()],
    };
    let mut sampled = 0;
    for vals in [[0.7, 1.3], [-0.7, 1.9], [1.6, -0.45], [-1.15, -2.3]] {
        let env = |name: &str| -> Option<(f64, f64)> {
            let h = name.bytes().fold(0usize, |h, b| h.wrapping_mul(31).wrapping_add(b as usize));
            Some((vals[h % 2] * (1.0 + (h % 7) as f64 * 0.03), 0.0))
        };
        let Some((re, im)) = crate::eval::to_c64_env(sv, &env) else { continue };
        if !re.is_finite() || !im.is_finite() {
            continue;
        }
        let size = terms.iter().filter_map(|t| crate::eval::to_c64_env(&crate::err::soft(|| subs(t, &[(xs.clone(), r.clone())])), &env).map(|w| w.0.hypot(w.1))).fold(0.0f64, f64::max);
        sampled += 1;
        if re.hypot(im) <= 1e-9 * size.max(1e-300) {
            return false;
        }
    }
    sampled >= 3
}

/// Every solution of one equation in x, with conditions (see Sol), then
/// 0 == f for each factor f whose roots were not found (as a solution with
/// that value): the public solve.
pub fn solve1_full(e: &Expr, x: &str) -> Vec<(Expr, Vec<Expr>, Vec<String>)> {
    let xs = sym(x);
    let z = as_zero(e);
    let mut used = free_symbols(&z);
    used.push(x.to_string());
    USED.with(|u| *u.borrow_mut() = used);
    let (n, d) = together(&z);
    let n = crate::expand::expand(&n);
    if n.is_zero() || crate::simplify::simplify_full(&n).is_zero() {
        return vec![(eq(&xs, &sym(&fresh("r"))), vec![], vec![])];
    }
    UNSOLVED.with(|u| u.borrow_mut().clear());
    let mut sols = roots_c(&n, x);
    let rest: Vec<Expr> = UNSOLVED.with(|u| std::mem::take(&mut *u.borrow_mut()));
    let mut out = vec![];
    let mut undecided = false;
    for mut s in sols.drain(..) {
        // the denominator must not vanish there: a condition, also on the
        // integer parameters (sin(x)/(x - 2 pi) == 0: n1 != 2; CSOL-F1)
        let dv = crate::simplify::simplify_rational(&subs(&d, &[(xs.clone(), s.val.clone())]));
        if maybe_zero(&dv) {
            s.cond.push(zero_rel(Rel::Ne, &dv));
        } else if dv.is_zero() {
            continue;
        }
        // the numerator vanishes there (the denominator is the condition)
        match holds(&n, &xs, &s) {
            Some(true) => {}
            Some(false) => continue,
            None => {
                undecided = true;
                continue;
            }
        }
        // decided conditions: dropped if true, the solution if one is false
        let mut ok = true;
        let mut cond = vec![];
        for c in s.cond {
            match decide(&c) {
                Some(true) => {}
                Some(false) => ok = false,
                None => {
                    if !cond.contains(&c) {
                        cond.push(c)
                    }
                }
            }
        }
        if !ok {
            continue;
        }
        let val = crate::expand::expand(&s.val);
        let rel = eq(&xs, &val);
        if !out.iter().any(|(r, c, _): &(Expr, Vec<Expr>, Vec<String>)| r == &rel && c == &cond) {
            out.push((rel, cond, s.params));
        }
    }
    // the unconditional ones first, sorted as solve1 sorts
    out.sort_by(|a, b| {
        a.1.is_empty().cmp(&b.1.is_empty()).reverse().then_with(|| {
            let rhs = |r: &Expr| match &r.kind {
                Kind::Rel(_, _, v) => v.clone(),
                _ => r.clone(),
            };
            let (u, v) = (crate::eval::to_c64(&rhs(&a.0)), crate::eval::to_c64(&rhs(&b.0)));
            match (u, v) {
                (Some(p), Some(q)) => p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal).then(p.1.partial_cmp(&q.1).unwrap_or(std::cmp::Ordering::Equal)),
                _ => std::cmp::Ordering::Equal,
            }
        })
    });
    let mut rest = rest;
    if undecided && !rest.contains(&n) {
        rest.push(n.clone());
    }
    out.extend(rest.iter().map(|f| (relation(Rel::Eq, &zero(), f), vec![], vec![])));
    out
}
