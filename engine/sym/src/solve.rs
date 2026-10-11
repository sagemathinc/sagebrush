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
use num_traits::{One, Zero};

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
        4 if cubic_roots(c).is_some() => cubic_roots(c).unwrap(),
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
            // a cyclotomic polynomial (x^5 == 1 left x^4 + x^3 + x^2 + x + 1
            // unsolved): the primitive n-th roots of unity
            if let Some(n) = cyclotomic_index(c) {
                let h = n as i64;
                return (-(h - 1) / 2..=h / 2)
                    .filter(|&k| gcd_i64(k.abs(), h) == 1)
                    .map(|k| if h <= 2 { int(if k == 0 { 1 } else { -1 }) } else { exp(&mul(vec![rat(2 * k, h), pi(), num(crate::num::Num::i())])) })
                    .collect();
            }
            not_solved()
        }
    }
}

/// The roots of a cubic with rational coefficients (one without a rational
/// root: those factor()), for x = t - b/3, t^3 + p t + q = 0, D = q^2/4 +
/// p^3/27: three real roots for D < 0, in Viete's trigonometric form t =
/// 2 sqrt(-p/3) cos(theta - 2 pi k/3), theta = acos(3 q/(2 p) sqrt(-3/p))/3
/// (x^3 - 3 x + 1: 2 cos(2/9 pi), ...; Cardano's formula needs complex cube
/// roots there, the casus irreducibilis); for D > 0 Cardano's with real
/// cube roots A, B: A + B and -(A + B)/2 +- i sqrt(3)/2 (A - B).
fn cubic_roots(c: &[Expr]) -> Option<Vec<Expr>> {
    let q_of = |e: &Expr| e.as_num().and_then(|n| n.as_rat()).cloned();
    let (a3, a2, a1, a0) = (q_of(&c[3])?, q_of(&c[2])?, q_of(&c[1])?, q_of(&c[0])?);
    if a3.is_zero() {
        return None;
    }
    let (b, cc, d) = (&a2 / &a3, &a1 / &a3, &a0 / &a3);
    let three = Q::from_integer(3.into());
    let p = &cc - &b * &b / &three;
    let q = Q::from_integer(2.into()) * &b * &b * &b / Q::from_integer(27.into()) - &b * &cc / &three + &d;
    let disc = &q * &q / Q::from_integer(4.into()) + &p * &p * &p / Q::from_integer(27.into());
    let qn = |r: &Q| num(crate::num::Num::rat(r.clone()));
    let shift = qn(&(-&b / &three));
    if disc.is_zero() {
        return None; // a repeated root: rational, found by factor()
    }
    use num_traits::Signed;
    if disc.is_negative() {
        let r = mul2(&int(2), &sqrt(&qn(&(-&p / &three))));
        let arg = mul2(&qn(&(&three * &q / (Q::from_integer(2.into()) * &p))), &sqrt(&qn(&(-&three / &p))));
        let theta = div(&fun1(Fun::Acos, &arg), &int(3));
        // cos of a rational multiple of pi taken in [0, pi] (cos is even,
        // 2 pi periodic): 2 cos(2/9 pi), not 2 cos(-10/9 pi)
        let reduced = |t: Expr| -> Expr {
            let Some(r) = simplify_rational(&div(&t, &pi())).as_num().and_then(|n| n.as_rat()).cloned() else { return cos(&t) };
            let two = Q::from_integer(2.into());
            let mut m = &r - (&r / &two).floor() * &two;
            if m > Q::one() {
                m = &two - m;
            }
            cos(&mul2(&qn(&m), &pi()))
        };
        let mut out: Vec<Expr> = (0..3)
            .map(|k| crate::expand::expand(&add2(&shift, &mul2(&r, &reduced(sub(&theta, &mul(vec![rat(2 * k, 3), pi()])))))))
            .collect();
        sort_roots(&mut out);
        return Some(out);
    }
    // real cube roots of u = -q/2 +- sqrt(D)
    let sd = sqrt(&qn(&disc));
    let cbrt = |u: Expr| -> Option<Expr> {
        let (re, _) = crate::domain::complex_encl(&u)?;
        if re.contains_zero() {
            return None;
        }
        Some(if re.0 > 0.0 { pow(&u, &rat(1, 3)) } else { neg(&pow(&neg(&u), &rat(1, 3))) })
    };
    let half_q = qn(&(-&q / Q::from_integer(2.into())));
    let a = cbrt(add2(&half_q, &sd))?;
    let bb = cbrt(sub(&half_q, &sd))?;
    let s_ = add2(&a, &bb);
    let dlt = mul(vec![sub(&a, &bb), sqrt(&int(3)), rat(1, 2), num(crate::num::Num::i())]);
    let mid = sub(&shift, &div(&s_, &int(2)));
    let mut out = vec![
        crate::expand::expand(&add2(&shift, &s_)),
        crate::expand::expand(&sub(&mid, &dlt)),
        crate::expand::expand(&add2(&mid, &dlt)),
    ];
    sort_roots(&mut out);
    Some(out)
}

fn gcd_i64(a: i64, b: i64) -> i64 {
    if b == 0 { a } else { gcd_i64(b, a % b) }
}

/// The cyclotomic polynomial Phi_n as integer coefficients (constant first),
/// from x^n - 1 = prod over d | n of Phi_d; None past i128.
fn cyclotomic(n: usize) -> Option<Vec<i128>> {
    let mut p = vec![0i128; n + 1];
    p[0] = -1;
    p[n] = 1;
    for d in 1..n {
        if n % d == 0 {
            let q = cyclotomic(d)?;
            // exact division by the monic q
            let mut r = p.clone();
            let mut out = vec![0i128; r.len() - q.len() + 1];
            for i in (0..out.len()).rev() {
                let c = r[i + q.len() - 1];
                out[i] = c;
                for (j, qj) in q.iter().enumerate() {
                    r[i + j] = r[i + j].checked_sub(c.checked_mul(*qj)?)?;
                }
            }
            p = out;
        }
    }
    Some(p)
}

/// n when the polynomial c (constant first) is a multiple of Phi_n with
/// n > 2 (degree phi(n) <= 48).
fn cyclotomic_index(c: &[Expr]) -> Option<usize> {
    let d = c.len() - 1;
    if !(2..=48).contains(&d) {
        return None;
    }
    let lead = c[d].as_num()?.as_rat()?.clone();
    let q: Vec<Q> = c.iter().map(|a| a.as_num().and_then(|n| n.as_rat()).map(|r| r / &lead)).collect::<Option<_>>()?;
    let phi = |n: usize| (1..=n).filter(|&k| gcd_i64(k as i64, n as i64) == 1).count();
    // phi(n) >= sqrt(n / 2), so n <= 2 d^2
    for n in 3..=2 * d * d {
        if phi(n) != d {
            continue;
        }
        let Some(f) = cyclotomic(n) else { continue };
        if f.iter().zip(&q).all(|(a, b)| Q::from_integer((*a).into()) == *b) {
            return Some(n);
        }
    }
    None
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
        // a pivot proved nonzero; a symbolic one (a x + y == 1) would be
        // divided by unconditionally, so such systems go to the general
        // solver, which splits the cases (a == 0 or not)
        let Some(p) = (r..rows.len()).find(|&i| !simplify_rational(&rows[i][col]).is_zero() && !maybe_zero(&rows[i][col])) else {
            if (r..rows.len()).any(|i| !simplify_rational(&rows[i][col]).is_zero()) {
                return None;
            }
            continue;
        };
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
    // inconsistent rows: no solution; 0 == c + d is a condition on the
    // parameters, for the general solver (Sage, and this, gave [] for
    // [a + b == 1, a == b, c + d == 0] in a, b: ask.sagemath 10028)
    for row in &rows[r..] {
        if !row[n].is_zero() {
            if maybe_zero(&row[n]) {
                return None;
            }
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
    /// Candidates obtained by squaring away radicals: not solutions by
    /// construction, so their residual must vanish exactly, else a condition
    /// stays.  With one radical, A + B sqrt(b) = 0, also (w, B) for w = -A/B
    /// in x: there the candidate is a solution exactly when w is the
    /// principal square root (see radical_roots).
    static VERIFY: std::cell::RefCell<Vec<(Expr, Option<(Expr, Expr)>)>> = const { std::cell::RefCell::new(vec![]) };
    /// Whether the last accepted residual was zero only numerically (or,
    /// for a candidate from squaring, not shown zero at all).
    static NUMERIC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
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

/// May e vanish (for some value of its symbols)?  False only when e is
/// proved nonzero: a nonzero exact number, or a constant whose enclosure
/// excludes 0.  A constant that is not decided (sqrt(2 I) - 1 - I, which is
/// 0) may vanish: dividing by it was the review's CSOL-F13.
fn maybe_zero(e: &Expr) -> bool {
    let s = crate::simplify::simplify_full(e);
    if s.is_zero() {
        return true;
    }
    // e^u never vanishes, nor does a product of such factors and nonzero
    // numbers (log(x) - log(x + 1) == a had a branch where e^a == 0)
    let never = |f: &Expr| matches!(&f.kind, Kind::Pow(b, _) if b.is_const(Const::E)) || f.as_num().map_or(false, |n| n.is_exact() && !n.is_zero());
    if never(&s) || matches!(&s.kind, Kind::Mul(v) if v.iter().all(never)) {
        return false;
    }
    if !free_symbols(&s).is_empty() {
        return true;
    }
    if let Some(n) = s.as_num() {
        if n.is_exact() {
            return false;
        }
    }
    match crate::domain::complex_encl(&s) {
        Some((re, im)) => re.contains_zero() && im.contains_zero(),
        None => true,
    }
}

/// e == 0 or e != 0, with a numeric factor of e dropped (2 a != 0 is a != 0),
/// and solved for its symbol when e is linear in one (a - 1 != 0 is a != 1).
fn zero_rel(r: Rel, e: &Expr) -> Expr {
    let e = crate::simplify::simplify_rational(e);
    // b^k vanishes exactly where b does (k > 0): a^2 != 0 is a != 0
    if let Kind::Pow(b, k) = &e.kind {
        if k.as_num().map_or(false, |k| k.is_exact() && k.is_positive()) {
            return zero_rel(r, b);
        }
    }
    let fs = free_symbols(&e);
    if fs.len() == 1 {
        if let Some(c) = coeffs(&crate::expand::expand(&e), &fs[0]) {
            // (only by a coefficient proved nonzero: c a != 0 with c = 0 is
            // not a != 0, the review's CSOL-F13)
            if c.len() == 2 && c.iter().all(|t| free_symbols(t).is_empty()) && !maybe_zero(&c[1]) {
                return relation(r, &sym(&fs[0]), &simplify_rational(&neg(&div(&c[0], &c[1]))));
            }
        }
    }
    let (_, g) = split_coeff(&e);
    relation(r, &g, &zero())
}

/// e != 0 as conditions, one per factor that may vanish (x (x + 1) != 0 is
/// x != 0 and x != -1); none if e is proved nonzero.
fn ne_conds(e: &Expr) -> Vec<Expr> {
    let e = crate::simplify::simplify_rational(e);
    if !maybe_zero(&e) {
        return vec![];
    }
    let f = crate::simplify::factor(&e);
    let parts: Vec<Expr> = match &f.kind {
        Kind::Mul(v) => v.iter().map(|g| base_exp(g).0).collect(),
        Kind::Pow(b, k) if k.as_num().map_or(false, |k| k.is_positive()) => vec![b.clone()],
        _ => vec![e.clone()],
    };
    let mut out = vec![];
    for g in parts {
        if maybe_zero(&g) {
            let c = zero_rel(Rel::Ne, &g);
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// The expressions that must not vanish for z to be defined in x, beyond
/// its denominator: u for log(u), cos(u) for tan(u) and sec(u), sin(u) for
/// cot(u) and csc(u) (a family meeting such a point there: sin(x) log(x) ==
/// 0 needs n1 != 0, the review's follow-up to CSOL-F1).
/// (Also those in the parameters only, log(a) (x - 1) == 0 needs a != 0,
/// and the bases of negative powers anywhere, e^(1/x) needs x != 0: the
/// review's CSOL-F14, F16.)
/// A numeric exponent with real part <= 0 (x^-1, x^I) needs its base
/// nonzero; a symbolic one goes to zero_powers.  Constants are not skipped:
/// log(c) with an undecided c = 0 needs c != 0 (F14).
fn singular_args(z: &Expr, x: &str, out: &mut Vec<Expr>) {
    if let Kind::Pow(b, k) = &z.kind {
        let nonpositive = k.as_num().map_or(false, |k| {
            use num_traits::Signed;
            // the real part's sign exactly for an exact number (I + 10^-400
            // has a positive real part, which a double rounds to 0: CSOL-F16)
            match k {
                crate::num::Num::Exact(a, _) => !a.is_positive(),
                crate::num::Num::Float(re, _) => *re <= 0.0,
            }
        });
        if nonpositive && !b.is_const(Const::E) && !out.contains(b) {
            out.push(b.clone());
        }
    }
    if let Kind::Fun(f, a) = &z.kind {
        if a.len() == 1 {
            let u = &a[0];
            let g = match f {
                Fun::Log => Some(u.clone()),
                Fun::Tan | Fun::Sec => Some(fun1(Fun::Cos, u)),
                Fun::Cot | Fun::Csc => Some(sin(u)),
                _ => None,
            };
            if let Some(g) = g {
                if !out.contains(&g) {
                    out.push(g);
                }
            }
        }
    }
    for c in z.children() {
        singular_args(&c, x, out);
    }
}

/// The powers b^e with a symbolic exponent and a base that may vanish: 0^e
/// is defined only for Re(e) > 0, which is a condition per candidate (the
/// review's CSOL-F16): see solve1_full.
fn zero_powers(z: &Expr, out: &mut Vec<(Expr, Expr)>) {
    if let Kind::Pow(b, k) = &z.kind {
        if k.as_num().is_none() && !b.is_const(Const::E) && maybe_zero(b) && !out.contains(&(b.clone(), k.clone())) {
            out.push((b.clone(), k.clone()));
        }
    }
    for c in z.children() {
        zero_powers(&c, out);
    }
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
    // a factor common to every term (e^(t x) in e^(t x) (t x^2 + ...)):
    // its own roots and those of the rest (factor() is for polynomials)
    if let Some((common, rest)) = common_factor(n, x) {
        let mut out = roots_c(&common, x);
        out.extend(roots_c(&rest, x));
        return out;
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
    // a single term in x (k g(u) + c) is inverted exactly, with its
    // conditions; squaring radicals is for sums of several (sqrt(x) == x - 2)
    let dep_terms = match &f.kind {
        Kind::Add(v) => v.iter().filter(|t| depends(t, x)).count(),
        _ => 1,
    };
    let mut ks = vec![];
    trig_kernels(&f, x, &mut ks);
    if ks.len() >= 2 {
        if let Some(sols) = trig_roots(&f, x, &ks) {
            return sols;
        }
    }
    if let Some(sols) = kernel_poly_roots(&f, x) {
        return sols;
    }
    if dep_terms > 1 {
        if let Some(sols) = log_roots(&f, x) {
            return sols;
        }
        if let Some(sols) = radical_roots(&f, x) {
            return sols;
        }
    }
    invert_c(&f, x)
}

/// Sums of logarithms, k1 log(u1) + k2 log(u2) + ... + C = 0 with integers
/// k (log(x) + log(x - 1) == log(2), unsolved by Sage): u1^k1 u2^k2 ... e^C
/// = 1 holds at every solution, so its roots are the candidates, each
/// checked in the original equation (log a + log b = log(a b) only up to
/// 2 pi i: x = -1 is no solution there).
fn log_roots(f: &Expr, x: &str) -> Option<Vec<Sol>> {
    let Kind::Add(v) = &f.kind else { return None };
    let mut prod = vec![];
    let mut c = vec![];
    let mut logs = 0;
    for t in v {
        if !depends(t, x) {
            c.push(t.clone());
            continue;
        }
        let (k, g) = split_coeff(t);
        let Kind::Fun(Fun::Log, a) = &g.kind else { return None };
        let k = k.as_rat().filter(|k| k.is_integer() && !k.is_zero())?.to_integer();
        use num_traits::ToPrimitive;
        let k = k.to_i64().filter(|k| k.unsigned_abs() <= 16)?;
        prod.push(pow(&a[0], &int(k)));
        logs += 1;
    }
    if logs < 2 {
        return None;
    }
    prod.push(exp(&add(c)));
    let (n, _) = together(&sub(&mul(prod), &int(1)));
    let n = crate::expand::expand(&n);
    if n.is_zero() || !depends(&n, x) {
        return None;
    }
    let sols = roots_c(&n, x);
    VERIFY.with(|v| v.borrow_mut().extend(sols.iter().map(|s| (s.val.clone(), None))));
    Some(sols)
}

/// The trigonometric functions of x in e (sin(a) with a depending on x).
fn trig_kernels(e: &Expr, x: &str, out: &mut Vec<Expr>) {
    if let Kind::Fun(Fun::Sin | Fun::Cos | Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc, a) = &e.kind {
        if a.len() == 1 && depends(&a[0], x) {
            if !out.contains(e) {
                out.push(e.clone());
            }
            return;
        }
    }
    for c in e.children() {
        trig_kernels(&c, x, out);
    }
}

/// a = q x + c with q a nonzero rational number and c free of x.
fn linear_in(a: &Expr, x: &str) -> Option<(Q, Expr)> {
    let c = coeffs(&crate::expand::expand(a), x)?;
    if c.len() != 2 || depends(&c[0], x) {
        return None;
    }
    let q = c[1].as_num()?.as_rat()?.clone();
    (!q.is_zero()).then(|| (q, c[0].clone()))
}

/// Equations in trigonometric functions of x (their arguments linear in x),
/// a recurring complaint about Sage's solve, which gives sin(x) == cos(x),
/// cos(2 x) == cos(x) back unsolved or only principal solutions: f(u) =
/// f(v) as u, v linear (sin u = sin v: u = v + 2 pi n or u = pi - v + 2 pi
/// n), a sin u + b cos u + c as R sin(u + phi) + c, and otherwise a
/// polynomial in sin and cos of one angle.  Every value is an exact
/// inversion, so these are checked as any other candidate.
fn trig_roots(f: &Expr, x: &str, ks: &[Expr]) -> Option<Vec<Sol>> {
    if let Some(s) = two_term_trig(f, x) {
        return Some(s);
    }
    if let Some(s) = sin_cos_linear(f, x, ks) {
        return Some(s);
    }
    trig_poly(f, x)
}

/// k f(a) for f = sin, cos, tan, k a number, a linear in x.
fn trig_term(t: &Expr, x: &str) -> Option<(Expr, Fun, Expr)> {
    let (k, g) = split_coeff(t);
    if let Kind::Fun(f @ (Fun::Sin | Fun::Cos | Fun::Tan), a) = &g.kind {
        if a.len() == 1 && linear_in(&a[0], x).is_some() {
            return Some((num(k), f.clone(), a[0].clone()));
        }
    }
    None
}

/// k (f(a) - g(b)) = 0 or k (f(a) + g(b)) = 0 for sin and cos (as sines:
/// cos a = sin(a + pi/2), -sin w = sin(-w)), or tan with tan: linear
/// equations in x and a new integer n.
fn two_term_trig(f: &Expr, x: &str) -> Option<Vec<Sol>> {
    let Kind::Add(v) = &f.kind else { return None };
    if v.len() != 2 {
        return None;
    }
    let (k1, f1, a1) = trig_term(&v[0], x)?;
    let (k2, f2, a2) = trig_term(&v[1], x)?;
    if a1 == a2 {
        return None;
    }
    // f1(a1) = s f2(a2)
    let s = if add2(&k1, &k2).is_zero() {
        1
    } else if sub(&k1, &k2).is_zero() {
        -1
    } else {
        return None;
    };
    let as_sin = |g: &Fun, a: &Expr| if *g == Fun::Cos { add2(a, &div(&pi(), &int(2))) } else { a.clone() };
    let eqs: Vec<(Expr, String)> = match (&f1, &f2) {
        (Fun::Tan, Fun::Tan) => {
            // tan a1 = tan(s a2): a1 = s a2 + pi n
            let n = fresh("n");
            vec![(sub(&sub(&a1, &mul2(&int(s), &a2)), &two_pi_n(&n, 1)), n)]
        }
        (Fun::Tan, _) | (_, Fun::Tan) => return None,
        _ => {
            let w1 = as_sin(&f1, &a1);
            let w2 = mul2(&int(s), &as_sin(&f2, &a2));
            let (n1, n2) = (fresh("n"), fresh("n"));
            vec![
                (sub(&sub(&w1, &w2), &two_pi_n(&n1, 2)), n1),
                (sub(&sub(&add2(&w1, &w2), &pi()), &two_pi_n(&n2, 2)), n2),
            ]
        }
    };
    let mut out = vec![];
    for (e, n) in eqs {
        let c = coeffs(&crate::expand::expand(&e), x)?;
        if c.len() != 2 || depends(&c[1], x) || c[1].is_zero() {
            return None; // a branch without x: left to the general way
        }
        let val = crate::expand::expand(&neg(&div(&c[0], &c[1])));
        out.push(Sol { val, cond: vec![], params: vec![n] });
    }
    Some(out)
}

/// A real nonzero number (exactly real: its enclosure has no imaginary part).
fn real_nonzero(e: &Expr) -> Option<f64> {
    if !free_symbols(e).is_empty() {
        return None;
    }
    let (re, im) = crate::domain::complex_encl(e)?;
    if im.0 != 0.0 || im.1 != 0.0 || re.contains_zero() {
        return None;
    }
    Some(re.0)
}

/// A sin(u) + B cos(u) + C with A, B real numbers: R sin(u + phi) + C, R =
/// sqrt(A^2 + B^2), phi the angle of (A, B) (sin(x) == cos(x): x == pi/4 +
/// pi n1).
fn sin_cos_linear(f: &Expr, x: &str, ks: &[Expr]) -> Option<Vec<Sol>> {
    if ks.len() != 2 {
        return None;
    }
    let u = match (&ks[0].kind, &ks[1].kind) {
        (Kind::Fun(Fun::Sin, a), Kind::Fun(Fun::Cos, b)) | (Kind::Fun(Fun::Cos, b), Kind::Fun(Fun::Sin, a)) if a == b => a[0].clone(),
        _ => return None,
    };
    let (sn, cn) = (fresh("_s"), fresh("_c"));
    let p = crate::expand::expand(&subs(f, &[(sin(&u), sym(&sn)), (cos(&u), sym(&cn))]));
    if depends(&p, x) {
        return None;
    }
    let cs = coeffs(&p, &sn)?;
    if cs.len() != 2 || depends(&cs[1], &cn) {
        return None;
    }
    let cc = coeffs(&cs[0], &cn)?;
    if cc.len() != 2 || depends(&cc[0], &cn) {
        return None;
    }
    let (a, b, c) = (simplify_rational(&cs[1]), simplify_rational(&cc[1]), cc[0].clone());
    let (af, bf) = (real_nonzero(&a)?, real_nonzero(&b)?);
    let r = crate::simplify::simplify_full(&sqrt(&add2(&mul2(&a, &a), &mul2(&b, &b))));
    let base = fun1(Fun::Atan, &simplify_rational(&div(&b, &a)));
    let phi = if af > 0.0 {
        base
    } else if bf > 0.0 {
        add2(&base, &pi())
    } else {
        sub(&base, &pi())
    };
    let g = add2(&sin(&add2(&u, &phi)), &simplify_rational(&div(&c, &r)));
    Some(invert_c(&g, x))
}

/// The rational gcd of nonzero rationals (the largest q with each an
/// integer multiple of q).
fn gcd_q(qs: &[Q]) -> Q {
    use num_integer::Integer;
    let mut g = qs[0].clone();
    for q in &qs[1..] {
        let (a, b) = (g.numer() * q.denom(), q.numer() * g.denom());
        g = Q::new(a.gcd(&b), g.denom() * q.denom());
    }
    if g < Q::zero() { -g } else { g }
}

/// sin(k u) and cos(k u) as polynomials in s = sin u, c = cos u.
fn multiple_angle(k: i64, s: &Expr, c: &Expr) -> (Expr, Expr) {
    let (mut sk, mut ck) = (zero(), int(1));
    for _ in 0..k.unsigned_abs() {
        let (s2, c2) = (add2(&mul2(&sk, c), &mul2(&ck, s)), sub(&mul2(&ck, c), &mul2(&sk, s)));
        sk = crate::expand::expand(&s2);
        ck = crate::expand::expand(&c2);
    }
    if k < 0 { (neg(&sk), ck) } else { (sk, ck) }
}

/// A polynomial in sin(k u + c), cos(k u + c) (tan and the others through
/// sin and cos), u = g x: a polynomial P(s, c) in s = sin u, c = cos u on
/// s^2 + c^2 = 1.  With c only in even powers it is one in s (sin(u) =
/// each root), with s only in even powers one in c; homogeneous up to s^2 +
/// c^2 = 1, one in t = tan u (with cos u = 0 when the degree drops: sin(x)
/// cos(x) == 1/4 gives x == pi/12 + pi n); else squared, P0^2 = (1 - s^2)
/// P1^2, each candidate checked.
fn trig_poly(f: &Expr, x: &str) -> Option<Vec<Sol>> {
    let (num_, _) = together(&crate::simplify::trig_to_sincos(f));
    let n = crate::expand::expand(&num_);
    let mut ks = vec![];
    trig_kernels(&n, x, &mut ks);
    let mut args = vec![];
    for k in &ks {
        let Kind::Fun(Fun::Sin | Fun::Cos, a) = &k.kind else { return None };
        let (q, c) = linear_in(&a[0], x)?;
        args.push((k.clone(), q, c));
    }
    if args.is_empty() {
        return None;
    }
    let g = gcd_q(&args.iter().map(|t| t.1.clone()).collect::<Vec<_>>());
    let u = mul2(&num(crate::num::Num::rat(g.clone())), &sym(x));
    let (sn, cn) = (fresh("_s"), fresh("_c"));
    let (s, c) = (sym(&sn), sym(&cn));
    let mut rules = vec![];
    for (k, q, off) in &args {
        let m = (q / &g).to_integer();
        use num_traits::ToPrimitive;
        let m = m.to_i64().filter(|m| m.unsigned_abs() <= 12)?;
        let (sk, ck) = multiple_angle(m, &s, &c);
        let (co, so) = (cos(off), sin(off));
        let v = match &k.kind {
            Kind::Fun(Fun::Sin, _) => add2(&mul2(&sk, &co), &mul2(&ck, &so)),
            _ => sub(&mul2(&ck, &co), &mul2(&sk, &so)),
        };
        rules.push((k.clone(), v));
    }
    let p = crate::expand::expand(&subs(&n, &rules));
    if depends(&p, x) {
        return None;
    }
    // P = P0(s) + c P1(s) on c^2 = 1 - s^2 (and the same with s, c swapped)
    let reduce = |p: &Expr, v: &str, w: &Expr| -> Option<(Expr, Expr)> {
        let cs = coeffs(p, v)?;
        let one_minus = sub(&int(1), &mul2(w, w));
        let (mut p0, mut p1) = (zero(), zero());
        for (i, ci) in cs.iter().enumerate() {
            let t = mul2(ci, &pow(&one_minus, &int((i / 2) as i64)));
            if i % 2 == 0 { p0 = add2(&p0, &t) } else { p1 = add2(&p1, &t) }
        }
        Some((crate::expand::expand(&p0), crate::expand::expand(&p1)))
    };
    let (p0, p1) = reduce(&p, &cn, &s)?;
    if p1.is_zero() {
        return poly_in_kernel(&p0, &sn, &sin(&u), x);
    }
    let (q0, q1) = reduce(&p, &sn, &c)?;
    if q1.is_zero() {
        return poly_in_kernel(&q0, &cn, &cos(&u), x);
    }
    // the monomials s^i c^j with their coefficients
    let mut mons = vec![];
    for (i, ci) in coeffs(&p, &sn)?.iter().enumerate() {
        for (j, cij) in coeffs(ci, &cn)?.iter().enumerate() {
            if !cij.is_zero() {
                mons.push((i, j, cij.clone()));
            }
        }
    }
    let d = mons.iter().map(|m| m.0 + m.1).max()?;
    if mons.iter().all(|m| (m.0 + m.1) % 2 == d % 2) {
        // P / c^d with each monomial times (s^2 + c^2)^m: h(t), t = tan u
        let tn = fresh("_t");
        let t = sym(&tn);
        let h = crate::expand::expand(&add(mons.iter().map(|(i, j, k)| {
            let m = ((d - i - j) / 2) as i64;
            mul(vec![k.clone(), pow(&t, &int(*i as i64)), pow(&add2(&int(1), &mul2(&t, &t)), &int(m))])
        }).collect()));
        let hc = coeffs(&h, &tn)?;
        let mut out = if hc.len() > 1 { poly_in_kernel(&h, &tn, &fun1(Fun::Tan, &u), x)? } else { vec![] };
        if hc.len() < d + 1 || hc.last().map_or(false, |l| l.is_zero()) {
            // cos u = 0: P(+-1, 0) = 0 there
            out.extend(invert_c(&cos(&u), x));
        }
        return Some(out);
    }
    // squared: P0 = -c P1 implies P0^2 = (1 - s^2) P1^2.  At a root s0, u =
    // asin(s0) + 2 pi n has cos u = sqrt(1 - s0^2) (for every complex s0),
    // u = pi - asin(s0) + 2 pi n the opposite: each branch is a solution
    // exactly when P0(s0) +- sqrt(1 - s0^2) P1(s0) = 0, decided (exactly or
    // by an enclosure) or kept as that condition
    let r = crate::expand::expand(&sub(&mul2(&p0, &p0), &mul(vec![sub(&int(1), &mul2(&s, &s)), p1.clone(), p1.clone()])));
    let c0: Vec<Expr> = coeffs(&r, &sn)?.iter().map(simplify_rational).collect();
    if c0.len() < 2 || maybe_zero(c0.last().unwrap()) {
        return None;
    }
    let f0 = crate::simplify::factor(&r);
    let parts: Vec<Expr> = match &f0.kind {
        Kind::Mul(v) => v.iter().map(|g| base_exp(g).0).collect(),
        Kind::Pow(b, _) => vec![b.clone()],
        _ => vec![r.clone()],
    };
    let mut roots = vec![];
    for g in parts.iter().filter(|g| depends(g, &sn)) {
        let c: Vec<Expr> = coeffs(g, &sn)?.iter().map(simplify_rational).collect();
        let rs = poly_roots(&c);
        if rs.is_empty() {
            return None;
        }
        roots.extend(rs);
    }
    sort_roots(&mut roots);
    let ginv = num(crate::num::Num::rat(g.recip()));
    let mut out = vec![];
    for s0 in roots {
        let at = |e: &Expr| subs(e, &[(s.clone(), s0.clone())]);
        let root = sqrt(&sub(&int(1), &mul2(&s0, &s0)));
        let a0 = fun1(Fun::Asin, &s0);
        for (sign, base) in [(1, a0.clone()), (-1, sub(&pi(), &a0))] {
            let w = crate::simplify::simplify_full(&add2(&at(&p0), &mul(vec![int(sign), root.clone(), at(&p1)])));
            let cond = if w.is_zero() {
                vec![]
            } else {
                match (free_symbols(&w).is_empty(), crate::domain::complex_encl(&w)) {
                    (true, Some((re, im))) if !(re.contains_zero() && im.contains_zero()) => continue,
                    _ => vec![relation(Rel::Eq, &w, &zero())],
                }
            };
            let n = fresh("n");
            let val = crate::expand::expand(&mul2(&ginv, &add2(&base, &two_pi_n(&n, 2))));
            out.push(Sol { val, cond, params: vec![n] });
        }
    }
    Some(out)
}

/// The roots of the polynomial p in v (v standing for the kernel k(x)),
/// then k(x) = each root inverted.  None when the leading coefficient may
/// vanish or the roots are not found.
fn poly_in_kernel(p: &Expr, v: &str, k: &Expr, x: &str) -> Option<Vec<Sol>> {
    let c: Vec<Expr> = coeffs(p, v)?.iter().map(simplify_rational).collect();
    if c.iter().any(|a| depends(a, x)) || c.len() < 2 || maybe_zero(c.last().unwrap()) {
        return None;
    }
    // factor by factor (s^4, (s^2 - 2) (s - 1)): every root found or None
    let f = crate::simplify::factor(p);
    let parts: Vec<Expr> = match &f.kind {
        Kind::Mul(v) => v.iter().map(|g| base_exp(g).0).collect(),
        Kind::Pow(b, _) => vec![b.clone()],
        _ => vec![p.clone()],
    };
    let mut roots = vec![];
    for g in parts.iter().filter(|g| depends(g, v)) {
        let c: Vec<Expr> = coeffs(g, v)?.iter().map(simplify_rational).collect();
        let r = poly_roots(&c);
        if r.is_empty() {
            return None;
        }
        roots.extend(r);
    }
    sort_roots(&mut roots);
    let mut out = vec![];
    for r in roots {
        out.extend(invert_c(&sub(k, &r), x));
    }
    Some(out)
}

/// f a polynomial of degree >= 2 in one function k(x) (log(x)^2 == 2, sin(x)^2
/// + sin(x) - 1 == 0, which factor() does not split over QQ).
fn kernel_poly_roots(f: &Expr, x: &str) -> Option<Vec<Sol>> {
    fn kernels(e: &Expr, x: &str, out: &mut Vec<Expr>) {
        let is_kernel = match &e.kind {
            Kind::Fun(_, a) => a.iter().any(|a| depends(a, x)),
            Kind::Pow(b, p) => b.is_const(Const::E) && depends(p, x),
            _ => false,
        };
        if is_kernel {
            if !out.contains(e) {
                out.push(e.clone());
            }
            return;
        }
        for c in e.children() {
            kernels(&c, x, out);
        }
    }
    let mut ks = vec![];
    kernels(f, x, &mut ks);
    if ks.len() != 1 {
        return None;
    }
    let vn = fresh("_k");
    let p = crate::expand::expand(&subs(f, &[(ks[0].clone(), sym(&vn))]));
    if depends(&p, x) || coeffs(&p, &vn).map_or(true, |c| c.len() < 3) {
        return None;
    }
    poly_in_kernel(&p, &vn, &ks[0], x)
}

fn is_half(k: &Expr) -> bool {
    k.as_num().and_then(|q| q.as_rat()).map_or(false, |q| q.denom() == &sagebrush_bigint::BigInt::from(2))
}

/// A square root sqrt(b) (b^(m/2), m odd) of an expression b in x.
fn find_sqrt(e: &Expr, x: &str) -> Option<Expr> {
    if let Kind::Pow(b, k) = &e.kind {
        if depends(b, x) && is_half(k) {
            return Some(b.clone());
        }
    }
    e.children().iter().find_map(|c| find_sqrt(c, x))
}

/// e with b^(m/2) replaced by r^m.
fn replace_sqrt(e: &Expr, b: &Expr, r: &Expr) -> Expr {
    if let Kind::Pow(bb, k) = &e.kind {
        if bb == b && is_half(k) {
            return pow(r, &mul2(&int(2), k));
        }
    }
    let ch = e.children();
    if ch.is_empty() {
        return e.clone();
    }
    rebuild(e, ch.iter().map(|c| replace_sqrt(c, b, r)).collect())
}

/// Equations with square roots of x (sqrt(x) == x - 2, sqrt(x + 1) -
/// sqrt(x) == 1, a recurring complaint about Sage's solve): one radical
/// r = sqrt(b) at a time, f = A + B r = 0 implies A^2 - B^2 b = 0; the
/// roots of the result are candidates, each checked in the original
/// equation by solve1_full (squaring adds extraneous ones).  None if f has
/// no such radical, or more than four.
fn radical_roots(f: &Expr, x: &str) -> Option<Vec<Sol>> {
    let mut g = f.clone();
    let mut steps = 0;
    let mut branch = None;
    while let Some(b) = find_sqrt(&g, x) {
        steps += 1;
        if steps > 4 {
            return None;
        }
        let rname = fresh("_rad");
        let r = sym(&rname);
        let h = crate::expand::expand(&replace_sqrt(&g, &b, &r));
        let (hn, _) = together(&h);
        let hn = crate::expand::expand(&hn);
        let c = coeffs(&hn, &rname)?;
        if steps == 1 && c.len() == 2 {
            branch = Some((neg(&div(&c[0], &c[1])), c[1].clone()));
        }
        // reduce r^2 = b: A from the even powers, B from the odd ones
        let (mut a, mut bb) = (zero(), zero());
        for (i, ci) in c.iter().enumerate() {
            let t = mul2(ci, &pow(&b, &int((i / 2) as i64)));
            if i % 2 == 0 {
                a = add2(&a, &t);
            } else {
                bb = add2(&bb, &t);
            }
        }
        g = if bb.is_zero() || crate::simplify::simplify_full(&bb).is_zero() {
            crate::expand::expand(&a)
        } else {
            crate::expand::expand(&sub(&mul2(&a, &a), &mul(vec![bb.clone(), bb, b.clone()])))
        };
        if g.is_zero() || depends(&g, &rname) {
            return None; // an identity after squaring, or not reduced
        }
    }
    if steps == 0 {
        return None;
    }
    // (A + B r = 0 at a root of A^2 - B^2 b, with B != 0 there: r = w and
    // w^2 = b, so sqrt(b) = r exactly when w is the principal root)
    let branch = if steps == 1 { branch } else { None };
    let sols = roots_c(&g, x);
    VERIFY.with(|v| v.borrow_mut().extend(sols.iter().map(|s| (s.val.clone(), branch.clone()))));
    Some(sols)
}

/// n = common * rest for a factor (a power b^k, k > 0, of a non-polynomial
/// b in x, or e^u) dividing every term of the sum n.
fn common_factor(n: &Expr, x: &str) -> Option<(Expr, Expr)> {
    let Kind::Add(terms) = &n.kind else { return None };
    let factors = |t: &Expr| -> Vec<Expr> {
        match &t.kind {
            Kind::Mul(v) => v.clone(),
            _ => vec![t.clone()],
        }
    };
    let first = factors(&terms[0]);
    for f in first {
        if !depends(&f, x) {
            continue;
        }
        let (b, k) = base_exp(&f);
        let exp_like = b.is_const(Const::E);
        if !exp_like && (k.as_num().map_or(true, |k| !k.is_positive()) || coeffs(&b, x).is_some()) {
            continue; // polynomials are factor()'s
        }
        if terms[1..].iter().all(|t| factors(t).contains(&f)) {
            let rest = crate::expand::expand(&add(terms.iter().map(|t| div(t, &f)).collect()));
            return Some((f, rest));
        }
    }
    None
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
            // every x: 1^u = 1, and 0^u = 0 where Re(u) > 0 (u the exponent at
            // x = r; for any exponent, not only x: CSOL-F4)
            let mut direct = vec![];
            if maybe_zero(&sub(b, &int(1))) && (maybe_zero(&sub(&t, &int(1))) || t == int(1)) {
                let mut cond = vec![zero_rel(Rel::Eq, &sub(b, &int(1)))];
                if t != int(1) {
                    cond.push(zero_rel(Rel::Eq, &sub(&t, &int(1))));
                }
                direct.push(Sol { val: sym(&fresh("r")), cond, params: vec![] });
            }
            if maybe_zero(b) && (t.is_zero() || maybe_zero(&t)) {
                let r = sym(&fresh("r"));
                let mut cond = vec![zero_rel(Rel::Eq, b)];
                if !t.is_zero() {
                    cond.push(zero_rel(Rel::Eq, &t));
                }
                cond.push(relation(Rel::Gt, &fun1(Fun::RealPart, &subs(p, &[(sym(x), r.clone())])), &zero()));
                direct.push(Sol { val: r, cond, params: vec![] });
            }
            if vs.is_empty() {
                return direct;
            }
            if !direct.is_empty() {
                let mut out = vec![];
                for s in vs {
                    if p.as_sym() == Some(x) {
                        out.push(s);
                        continue;
                    }
                    for r in roots_c(&sub(p, &s.val), x) {
                        let mut r = with_cond(r, &s.cond);
                        let mut ps = s.params.clone();
                        ps.extend(r.params);
                        r.params = ps;
                        out.push(r);
                    }
                }
                out.extend(direct);
                return out;
            }
            (p.clone(), vs)
        }
        Kind::Fun(Fun::Log, a) => {
            // log(u) = t: u = e^t, when t is a value of the principal log:
            // -pi < Im(t) <= pi
            // (none for a real constant t: log(x)^2 == 2 kept -pi <
            // imag_part(sqrt(2)) <= pi)
            let real_number = free_symbols(&t).is_empty() && crate::domain::complex_encl(&t).map_or(false, |(_, im)| im.0 == 0.0 && im.1 == 0.0);
            let im = fun1(Fun::ImagPart, &t);
            let cond = if real_number { vec![] } else { vec![relation(Rel::Gt, &im, &neg(&pi())), relation(Rel::Le, &im, &pi())] };
            let s = Sol { val: exp(&t), cond, params: vec![] };
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
                    use num_traits::Signed;
                    let (pq, tt) = if q.is_negative() { (-q.clone(), recip(&t)) } else { (q.clone(), t.clone()) };
                    if q.is_negative() && t.is_zero() {
                        return vec![];
                    }
                    // in units of pi, exactly (doubles chose the branches
                    // wrongly for p = 1 - 10^-20: the review's CSOL-F3):
                    // branch k needs -p - 2k < arg(t)/pi <= p - 2k, with
                    // arg(t)/pi in (-1, 1]: k in ((-p - 1)/2, (p + 1)/2)
                    let one = Q::one();
                    let two = &one + &one;
                    let kmin: sagebrush_bigint::BigInt = ((-&pq - &one) / &two).floor().to_integer() + 1;
                    let kmax: sagebrush_bigint::BigInt = ((&pq + &one) / &two).ceil().to_integer() - 1;
                    if &kmax - &kmin > sagebrush_bigint::BigInt::from(4096) {
                        // too many branches to list: unresolved
                        unsolved(e);
                        return vec![];
                    }
                    let pe = num(crate::num::Num::rat(pq.clone()));
                    let ar = fun1(Fun::Arg, &tt);
                    let mut vs = vec![];
                    let mut kk = kmin.clone();
                    while kk <= kmax {
                        let k2 = Q::from_integer(&kk * 2);
                        let (lo, hi) = (-&pq - &k2, &pq - &k2);
                        if hi > -&one && lo < one {
                            let ke = big(kk.clone());
                            let v = if kk.is_zero() {
                                pow(&tt, &recip(&pe))
                            } else {
                                mul2(&pow(&tt, &recip(&pe)), &exp(&div(&mul(vec![int(2), ke.clone(), pi(), i.clone()]), &pe)))
                            };
                            let mut cond = vec![];
                            if lo > -&one {
                                cond.push(relation(Rel::Gt, &ar, &mul2(&num(crate::num::Num::rat(lo.clone())), &pi())));
                            }
                            if hi < one {
                                cond.push(relation(Rel::Le, &ar, &mul2(&num(crate::num::Num::rat(hi.clone())), &pi())));
                            }
                            if !(t.is_zero() && !kk.is_zero()) {
                                vs.push(Sol { val: v, cond, params: vec![] });
                            }
                        }
                        kk += 1;
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

/// A condition in one integer parameter n alone, where n occurs only in
/// arguments q pi n + c (q rational) of periodic trigonometric functions:
/// the condition is periodic in n, so it is decided by its values over one
/// period (tan(x) == 1 gave pi*n1 + pi/4 "if cos(pi*n1 + 1/4*pi) != 0",
/// which holds for every integer n1).
fn periodic_decide(c: &Expr, params: &[String]) -> Option<bool> {
    let fs = free_symbols(c);
    if fs.len() != 1 || !params.contains(&fs[0]) {
        return None;
    }
    let n = fs[0].clone();
    // the period in n, or None if n occurs elsewhere
    fn period(e: &Expr, n: &str) -> Option<u64> {
        if !depends(e, n) {
            return Some(1);
        }
        if let Kind::Fun(f @ (Fun::Sin | Fun::Cos | Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc), a) = &e.kind {
            let cs = coeffs(&crate::expand::expand(&a[0]), n)?;
            if cs.len() != 2 || depends(&cs[0], n) {
                return None;
            }
            // cs[1] = q pi
            let q = crate::simplify::simplify_rational(&div(&cs[1], &pi()));
            let q = q.as_num()?.as_rat()?.clone();
            if q.is_zero() {
                return Some(1);
            }
            // (capped before doubling: 2 b wrapped for b near 2^64, giving a
            // small false period, and the pole exclusion of sin(x)/cos(x/b)
            // was decided away: the review's SOLVE2-F5)
            let b = q.denom().to_u64().filter(|&b| b <= 64)?;
            let m = if matches!(f, Fun::Tan | Fun::Cot) { b } else { 2 * b };
            return (m <= 64).then_some(m);
        }
        if matches!(e.kind, Kind::Sym(_)) {
            return None; // n itself, outside a trigonometric argument
        }
        let mut p = 1u64;
        for c in e.children() {
            let q = period(&c, n)?;
            p = p / gcd_u64(p, q) * q;
            if p > 64 {
                return None;
            }
        }
        Some(p)
    }
    fn gcd_u64(a: u64, b: u64) -> u64 {
        if b == 0 { a } else { gcd_u64(b, a % b) }
    }
    use num_traits::ToPrimitive;
    let p = period(c, &n)?;
    let mut all = None;
    for k in 0..p as i64 {
        let v = decide(&subs(c, &[(sym(&n), int(k))]))?;
        match all {
            None => all = Some(v),
            Some(w) if w != v => return None,
            _ => {}
        }
    }
    all
}

/// Whether k1 log(q1) + k2 log(q2) + ... (rational k, positive rational q)
/// is 0: exactly when q1^k1 q2^k2 ... = 1 (2 log(3) - log(9), left
/// undecided by the simplifier); None for any other expression.
fn log_sum_zero(e: &Expr) -> Option<bool> {
    use num_integer::Integer;
    use num_traits::{Signed, ToPrimitive};
    let ex = crate::expand::expand(e);
    let terms = match &ex.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![ex.clone()],
    };
    let mut parts = vec![];
    for t in &terms {
        let (k, g) = split_coeff(t);
        let k = k.as_rat()?.clone();
        let Kind::Fun(Fun::Log, a) = &g.kind else { return None };
        let q = a[0].as_num()?.as_rat()?.clone();
        if !q.is_positive() {
            return None;
        }
        parts.push((k, q));
    }
    if parts.is_empty() {
        return None;
    }
    let den = parts.iter().fold(sagebrush_bigint::BigInt::from(1), |l, (k, _)| l.lcm(k.denom()));
    let mut prod = Q::one();
    for (k, q) in parts {
        let m = (k * Q::from_integer(den.clone())).to_integer().to_i64().filter(|m| m.unsigned_abs() <= 256)?;
        for _ in 0..m.unsigned_abs() {
            prod = if m > 0 { prod * &q } else { prod / &q };
        }
    }
    Some(prod.is_one())
}

/// A relation between constants decided: Some(true/false), or None
/// (exactly, or by an enclosure separating the sides).
pub fn decide(c: &Expr) -> Option<bool> {
    let Kind::Rel(r, a, b) = &c.kind else { return None };
    // asin(sin(c)) == c for a real constant c: c in [-pi/2, pi/2] (acos:
    // [0, pi], atan: (-pi/2, pi/2)), decided as those relations
    if *r == Rel::Eq {
        if let Kind::Fun(f @ (Fun::Asin | Fun::Acos | Fun::Atan), u) = &a.kind {
            if let Kind::Fun(g, v) = &u[0].kind {
                let inverse = matches!((f, g), (Fun::Asin, Fun::Sin) | (Fun::Acos, Fun::Cos) | (Fun::Atan, Fun::Tan));
                let real = free_symbols(b).is_empty() && crate::domain::complex_encl(b).map_or(false, |(_, im)| im.0 == 0.0 && im.1 == 0.0);
                if inverse && &v[0] == b && real {
                    let h = div(&pi(), &int(2));
                    let (lo, hi) = match f {
                        Fun::Asin => (relation(Rel::Ge, b, &neg(&h)), relation(Rel::Le, b, &h)),
                        Fun::Acos => (relation(Rel::Ge, b, &zero()), relation(Rel::Le, b, &pi())),
                        _ => (relation(Rel::Gt, b, &neg(&h)), relation(Rel::Lt, b, &h)),
                    };
                    return match (decide(&lo), decide(&hi)) {
                        (Some(true), Some(true)) => Some(true),
                        (Some(false), _) | (_, Some(false)) => Some(false),
                        _ => None,
                    };
                }
            }
        }
    }
    let d = crate::simplify::simplify_full(&sub(a, b));
    if d.is_zero() {
        return Some(matches!(r, Rel::Eq | Rel::Le | Rel::Ge));
    }
    if !free_symbols(&d).is_empty() {
        return None;
    }
    // q pi with q rational: by the sign of q, exactly
    let qpi = match &d.kind {
        Kind::Const(Const::Pi) => Some(Q::one()),
        Kind::Mul(f) if f.len() == 2 && f[1].is_const(Const::Pi) => f[0].as_num().and_then(|n| n.as_rat()).cloned(),
        _ => None,
    };
    if let Some(q) = qpi {
        use num_traits::Signed;
        return Some(match r {
            Rel::Eq => q.is_zero(),
            Rel::Ne => !q.is_zero(),
            Rel::Lt => q.is_negative(),
            Rel::Le => !q.is_positive(),
            Rel::Gt => q.is_positive(),
            Rel::Ge => !q.is_negative(),
        });
    }
    if log_sum_zero(&d) == Some(true) {
        return Some(matches!(r, Rel::Eq | Rel::Le | Rel::Ge));
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
            // undefined there (a singularity no condition excludes): not
            // decided, so never a claim that the family is empty
            return None;
        }
        let v = subs(&v, sub0);
        if v.is_zero() {
            return Some(true);
        }
        let sv = crate::simplify::simplify_full(&v);
        if sv.is_zero() || log_sum_zero(&sv) == Some(true) {
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
            // a candidate from squaring holds only where its residual
            // vanishes, which nothing here proves: accepted unproved, so
            // that solve1_full attaches the residual as a condition (with
            // the candidate's own conditions it was accepted as a solution:
            // sqrt(x) == a x - 2 kept x == 1 at a = 1, residual 2: the
            // review's SOLVE2-F1)
            if VERIFY.with(|v| v.borrow().iter().any(|(c, _)| c == &s.val)) {
                NUMERIC.with(|n| n.set(true));
                return Some(true);
            }
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
                // holding 0 is agreement (see solve1_full: the inversion,
                // not this test, is why a candidate is a solution)
                let z0 = re.contains_zero() && im.contains_zero();
                if z0 {
                    NUMERIC.with(|n| n.set(true));
                }
                return Some(z0);
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
            Some((re, im)) if re.is_finite() && im.is_finite() && size.is_finite() && size > 0.0 => {
                let ok = re.hypot(im) <= 1e-12 * size;
                if ok {
                    NUMERIC.with(|n| n.set(true));
                }
                Some(ok)
            }
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

/// Each solution's integer parameters renamed n1, n2, ... in order (the
/// searches use up names: sin(x) + sin(2 x) + sin(3 x) == 0 had n1, n2, n4),
/// apart from the equation's own symbols.
fn renumber_params(out: &mut [(Expr, Vec<Expr>, Vec<String>)], z: &Expr, x: &str) {
    let mut taken = free_symbols(z);
    taken.push(x.to_string());
    // (the solutions' other symbols, r1 and such, are kept too)
    for (rel, cond, params) in out.iter() {
        for e in std::iter::once(rel).chain(cond.iter()) {
            for s in free_symbols(e) {
                if !params.contains(&s) && !taken.contains(&s) {
                    taken.push(s);
                }
            }
        }
    }
    let mut k = 0;
    for (rel, cond, params) in out.iter_mut() {
        let mut rules = vec![];
        let mut names = vec![];
        for p in params.iter() {
            let name = loop {
                k += 1;
                let n = format!("n{}", k);
                if !taken.contains(&n) {
                    break n;
                }
            };
            rules.push((sym(p), sym(&name)));
            names.push(name);
        }
        if rules.iter().any(|(a, b)| a != b) {
            *rel = subs(rel, &rules);
            for c in cond.iter_mut() {
                *c = subs(c, &rules);
            }
        }
        *params = names;
    }
}

/// Unconditional families x == c + p n (one integer parameter n) in their
/// simplest form: p with a positive coefficient (n -> -n), a family inside
/// another dropped, and c + p Z, c + p/2 + p Z merged into c + p/2 Z
/// (sin(x)^2 == 1/4 had four families, x == +-pi/6 + pi n are two).
fn merge_families(out: &mut Vec<(Expr, Vec<Expr>, Vec<String>)>, x: &str) {
    let parts = |e: &(Expr, Vec<Expr>, Vec<String>)| -> Option<(Expr, Expr)> {
        if !e.1.is_empty() || e.2.len() != 1 {
            return None;
        }
        let Kind::Rel(Rel::Eq, l, v) = &e.0.kind else { return None };
        if l.as_sym() != Some(x) {
            return None;
        }
        let c = coeffs(v, &e.2[0])?;
        (c.len() == 2 && !free_symbols(&c[0]).contains(&e.2[0]) && !free_symbols(&c[1]).contains(&e.2[0]) && !c[1].is_zero()).then(|| (c[0].clone(), c[1].clone()))
    };
    let ratio = |a: &Expr, b: &Expr| -> Option<Q> { simplify_rational(&div(a, b)).as_num()?.as_rat().cloned() };
    let make = |c: &Expr, p: &Expr, n: &str| -> Expr { eq(&sym(x), &crate::expand::expand(&add2(c, &mul2(p, &sym(n))))) };
    for e in out.iter_mut() {
        if let Some((c, p)) = parts(e) {
            if split_coeff(&p).0.is_negative() {
                e.0 = make(&c, &neg(&p), &e.2[0]);
            }
        }
    }
    let half = Q::new(1.into(), 2.into());
    loop {
        let mut changed = false;
        'outer: for i in 0..out.len() {
            for j in 0..out.len() {
                if i == j {
                    continue;
                }
                let (Some((ci, pi_)), Some((cj, pj))) = (parts(&out[i]), parts(&out[j])) else { continue };
                // family i inside family j: pi = k pj and ci - cj = m pj
                if let (Some(k), Some(m)) = (ratio(&pi_, &pj), ratio(&sub(&ci, &cj), &pj)) {
                    if k.is_integer() && m.is_integer() {
                        out.remove(i);
                        changed = true;
                        break 'outer;
                    }
                    if k.is_one() && (&m - &half).is_integer() {
                        // the offset nearer 0 kept
                        let size = |c: &Expr| crate::eval::to_c64(c).map_or(f64::INFINITY, |w| w.0.hypot(w.1));
                        let c = if size(&cj) < size(&ci) { cj } else { ci };
                        let n = out[i].2[0].clone();
                        out[i] = (make(&c, &div(&pi_, &int(2)), &n), vec![], vec![n]);
                        out.remove(j);
                        changed = true;
                        break 'outer;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
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
    let mut sing = vec![];
    singular_args(&z, x, &mut sing);
    let mut zpow = vec![];
    zero_powers(&z, &mut zpow);
    let conservative = std::cell::Cell::new(false);
    // the conditions for z to be defined at x = v, given the candidate's own
    // conditions: its denominator and singular arguments nonzero there; for
    // b^e with a symbolic e, Re(e) > 0 where the conditions make b = 0,
    // nothing where they make b nonzero, else b != 0 conservatively (0^e is
    // fine for Re(e) > 0), and then the equation is also reported unresolved
    let defined = |v: &Expr, have: &[Expr]| -> Option<Vec<Expr>> {
        let mut cond = vec![];
        for g in std::iter::once(&d).chain(sing.iter()) {
            let gv = crate::simplify::simplify_rational(&subs(g, &[(xs.clone(), v.clone())]));
            if gv.is_zero() || crate::simplify::simplify_full(&gv).is_zero() {
                return None;
            }
            for c in ne_conds(&gv) {
                if !cond.contains(&c) {
                    cond.push(c);
                }
            }
        }
        for (b, e) in &zpow {
            let bv = crate::simplify::simplify_rational(&subs(b, &[(xs.clone(), v.clone())]));
            if !maybe_zero(&bv) {
                continue;
            }
            let ev = subs(e, &[(xs.clone(), v.clone())]);
            let is_zero = bv.is_zero() || have.contains(&zero_rel(Rel::Eq, &bv));
            let nonzero = have.contains(&zero_rel(Rel::Ne, &bv))
                || have.iter().any(|c| matches!(&c.kind, Kind::Rel(Rel::Eq, l, r) if l == &bv && !maybe_zero(r)))
                || ne_conds(&bv).iter().all(|c| have.contains(c));
            if is_zero {
                let c = relation(Rel::Gt, &fun1(Fun::RealPart, &ev), &zero());
                if decide(&c) == Some(false) {
                    return None;
                }
                if !cond.contains(&c) && !have.contains(&c) {
                    cond.push(c);
                }
            } else if !nonzero {
                for c in ne_conds(&bv) {
                    if !cond.contains(&c) {
                        cond.push(c);
                    }
                }
                conservative.set(true);
            }
        }
        Some(cond)
    };
    if n.is_zero() || crate::simplify::simplify_full(&n).is_zero() {
        // every x where the equation is defined (the review: the
        // denominators x (x + 1) of an identity were lost)
        let r = sym(&fresh("r"));
        let mut out = match defined(&r, &[]) {
            Some(cond) => vec![(eq(&xs, &r), cond, vec![])],
            None => vec![],
        };
        if conservative.get() {
            out.push((relation(Rel::Eq, &zero(), &z), vec![], vec![]));
        }
        return out;
    }
    UNSOLVED.with(|u| u.borrow_mut().clear());
    VERIFY.with(|v| v.borrow_mut().clear());
    let mut sols = roots_c(&n, x);
    let rest: Vec<Expr> = UNSOLVED.with(|u| std::mem::take(&mut *u.borrow_mut()));
    let mut out = vec![];
    let mut undecided = false;
    for mut s in sols.drain(..) {
        // the denominator must not vanish there: a condition, also on the
        // integer parameters (sin(x)/(x - 2 pi) == 0: n1 != 2; CSOL-F1)
        match defined(&s.val, &s.cond) {
            Some(cond) => s.cond.extend(cond),
            None => continue,
        }
        // the numerator vanishes there (the denominator is the condition)
        // (Why a candidate is a solution: each comes from an exact inversion
        // -- the quadratic formula, u = t^(1/p) e^(2 pi i k/p) on its arg
        // range, u = e^t for -pi < Im t <= pi, the periods -- which holds
        // exactly when its conditions do; those are decided exactly or by
        // separating enclosures, or stay attached.  The residual test
        // filters candidates, it does not certify them: agreement in numbers
        // never admits a value the inversion did not produce.)
        NUMERIC.with(|n| n.set(false));
        let verdict = holds(&n, &xs, &s);
        match verdict {
            Some(true) => {
                // a candidate from squaring, accepted by numerical agreement
                // only: exact under its residual vanishing, kept as a
                // condition
                let squared = VERIFY.with(|v| v.borrow().iter().find(|(c, _)| c == &s.val).map(|(_, b)| b.clone()));
                if let (true, Some(branch)) = (NUMERIC.with(|n| n.get()), squared) {
                    let at = |u: &Expr| crate::simplify::simplify_rational(&subs(u, &[(xs.clone(), s.val.clone())]));
                    match branch {
                        // w the principal root: -pi/2 < arg(w) <= pi/2, as
                        // for sqrt(x) == a (decided for numbers below)
                        Some((w, b)) if !maybe_zero(&at(&b)) => {
                            let ar = fun1(Fun::Arg, &crate::simplify::simplify_full(&at(&w)));
                            let h = div(&pi(), &int(2));
                            s.cond.push(relation(Rel::Gt, &ar, &neg(&h)));
                            s.cond.push(relation(Rel::Le, &ar, &h));
                        }
                        // else the equation itself there
                        _ => s.cond.push(match &e.kind {
                            Kind::Rel(Rel::Eq, l, r) => relation(Rel::Eq, &at(l), &at(r)),
                            _ => relation(Rel::Eq, &at(&z), &zero()),
                        }),
                    }
                }
            }
            Some(false) => continue,
            None => {
                undecided = true;
                continue;
            }
        }
        // decided conditions: dropped if true, the solution if one is false;
        // a condition fixing a symbol (t == 0) is substituted into the others
        // (t == 0 and t == 2 is no solution)
        let mut fixed: Vec<(Expr, Expr)> = vec![];
        let mut ok = true;
        for c in &s.cond {
            if let Kind::Rel(Rel::Eq, l, r) = &c.kind {
                if l.as_sym().is_some() && free_symbols(r).is_empty() {
                    if let Some((_, r0)) = fixed.iter().find(|(l0, _)| l0 == l) {
                        if decide(&relation(Rel::Eq, r0, r)) == Some(false) {
                            ok = false;
                        }
                    } else {
                        fixed.push((l.clone(), r.clone()));
                    }
                }
            }
        }
        if !ok {
            continue;
        }
        let s_cond: Vec<Expr> = s.cond.iter().map(|c| {
            if let Kind::Rel(Rel::Eq, l, r) = &c.kind {
                if l.as_sym().is_some() && free_symbols(r).is_empty() {
                    return c.clone();
                }
            }
            if fixed.is_empty() { c.clone() } else { crate::simplify::simplify_rational(&subs(c, &fixed)) }
        }).collect();
        let mut cond = vec![];
        for c in s_cond {
            let verdict = decide(&c).or_else(|| periodic_decide(&c, &s.params));
            match verdict {
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
    merge_families(&mut out, x);
    renumber_params(&mut out, &z, x);
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
    // an unresolved piece that is a factor of the numerator stands for
    // itself; one met inside an inversion (exp(x/(x+1)) == 1: x/(x+1) ==
    // 2 pi i n1) would lose that inversion's conditions and integer
    // parameters, so the whole equation is reported instead (the review's
    // CSOL-F17)
    let factors: Vec<Expr> = match &crate::simplify::factor(&n).kind {
        Kind::Mul(v) => v.iter().map(|g| base_exp(g).0).collect(),
        Kind::Pow(b, _) => vec![b.clone()],
        _ => vec![n.clone()],
    };
    let mut rest: Vec<Expr> = rest;
    let nested = rest.iter().any(|u| !factors.contains(u) && u != &n);
    if nested || undecided {
        rest.retain(|u| factors.contains(u) || u == &n);
        if !rest.contains(&n) && !(rest.len() == factors.len() && !factors.is_empty() && factors.iter().all(|f| rest.contains(f))) {
            rest.push(n.clone());
        }
    }
    // with a denominator in x (or singular arguments), a remainder is the
    // equation itself: its numerator's factor would drop x != 0 from
    // sin(x)/x == a (the review)
    if conservative.get() && rest.is_empty() {
        rest = vec![z.clone()];
    }
    if !rest.is_empty() && (depends(&d, x) || !sing.is_empty()) {
        rest = vec![z.clone()];
    }
    out.extend(rest.iter().map(|f| (relation(Rel::Eq, &zero(), f), vec![], vec![])));
    out
}
