//! Rewrites a user asks for by name (Sage's expand_trig, reduce_trig,
//! expand_log, simplify_log): identities applied in one direction, never
//! automatically.

use crate::expr::*;
use crate::num::Num;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

fn binom(n: u32, k: u32) -> Expr {
    let mut r = BigInt::one();
    for i in 0..k {
        r = r * BigInt::from(n - i) / BigInt::from(i + 1);
    }
    big(r)
}

fn looks_negative(a: &Expr) -> bool {
    crate::print::to_string(a).starts_with('-')
}

/// f(a), with the sign of an argument that prints with a leading minus
/// taken out (sin(-y) = -sin(y), cos(-y) = cos(y)), as Sage writes them.
fn f1(f: Fun, a: &Expr) -> Expr {
    if looks_negative(a) {
        let p = neg(a);
        match f {
            Fun::Sin | Fun::Tan | Fun::Sinh | Fun::Tanh => return neg(&fun1(f, &p)),
            Fun::Cos | Fun::Cosh => return fun1(f, &p),
            _ => {}
        }
    }
    fun1(f, a)
}

// ------------------------------------------------------------------ expand_trig

/// sin, cos, tan and their hyperbolic forms of a sum by the addition
/// formulas, and of an integer multiple n*u (|n| >= 2) by the multiple-angle
/// formulas in u, everywhere in e.  As Sage: one level, so the terms of a sum
/// are not expanded again (sin(2*x + y) = cos(y)*sin(2*x) + cos(2*x)*sin(y)).
pub fn expand_trig(e: &Expr) -> Expr {
    let e = map(e, &mut |c| expand_trig(c));
    if let Kind::Fun(f, a) = &e.kind {
        if a.len() == 1 && is_expandable(f) {
            let u = &a[0];
            if matches!(u.kind, Kind::Add(_)) {
                // (products of the pieces distributed, as Sage: cos(x + y + z))
                let r = sum_rule(f, u);
                return if matches!(f, Fun::Tan | Fun::Tanh) { r } else { crate::expand::expand(&r) };
            }
            if let Some((n, v)) = integer_multiple(u) {
                return multiple_angle(f, n, &v);
            }
        }
    }
    e
}

fn is_expandable(f: &Fun) -> bool {
    matches!(f, Fun::Sin | Fun::Cos | Fun::Tan | Fun::Sinh | Fun::Cosh | Fun::Tanh)
}

/// u = n*v with an integer n, |n| >= 2.
fn integer_multiple(u: &Expr) -> Option<(i64, Expr)> {
    if let Kind::Mul(fs) = &u.kind {
        let n = fs[0].as_i64()?;
        if !fs[0].as_num()?.is_exact() || n.unsigned_abs() < 2 || n.unsigned_abs() > 1000 {
            return None;
        }
        return Some((n, mul(fs[1..].to_vec())));
    }
    None
}

fn sum_rule(f: &Fun, u: &Expr) -> Expr {
    let Kind::Add(ts) = &u.kind else { return f1(f.clone(), u) };
    let a = &ts[0];
    let r = add(ts[1..].to_vec());
    // f of the rest by the same rule (only the addition formula)
    let rest = |g: Fun| if matches!(r.kind, Kind::Add(_)) { sum_rule(&g, &r) } else { f1(g, &r) };
    match f {
        Fun::Sin => add2(&mul2(&f1(Fun::Sin, a), &rest(Fun::Cos)), &mul2(&f1(Fun::Cos, a), &rest(Fun::Sin))),
        Fun::Cos => sub(&mul2(&f1(Fun::Cos, a), &rest(Fun::Cos)), &mul2(&f1(Fun::Sin, a), &rest(Fun::Sin))),
        Fun::Sinh => add2(&mul2(&f1(Fun::Sinh, a), &rest(Fun::Cosh)), &mul2(&f1(Fun::Cosh, a), &rest(Fun::Sinh))),
        Fun::Cosh => add2(&mul2(&f1(Fun::Cosh, a), &rest(Fun::Cosh)), &mul2(&f1(Fun::Sinh, a), &rest(Fun::Sinh))),
        Fun::Tan => {
            // -(tan a + tan r)/(tan a tan r - 1), as Sage writes it
            let (ta, tr) = (f1(Fun::Tan, a), rest(Fun::Tan));
            div(&neg(&add2(&ta, &tr)), &sub(&mul2(&ta, &tr), &one()))
        }
        Fun::Tanh => {
            let (ta, tr) = (f1(Fun::Tanh, a), rest(Fun::Tanh));
            div(&add2(&ta, &tr), &add2(&one(), &mul2(&ta, &tr)))
        }
        _ => f1(f.clone(), u),
    }
}

/// f(n*v) in terms of f's of v: the binomial expansion of
/// (cos v + i sin v)^n (cosh v + sinh v for the hyperbolic ones).
fn multiple_angle(f: &Fun, n: i64, v: &Expr) -> Expr {
    let m = n.unsigned_abs() as u32;
    let hyper = matches!(f, Fun::Sinh | Fun::Cosh | Fun::Tanh);
    let (c, s) = if hyper { (f1(Fun::Cosh, v), f1(Fun::Sinh, v)) } else { (f1(Fun::Cos, v), f1(Fun::Sin, v)) };
    // sum over k of the given parity of sign(k) C(m, k) c^(m-k) s^k
    let part = |odd: bool| -> Expr {
        let mut ts = vec![];
        for k in 0..=m {
            if (k % 2 == 1) != odd {
                continue;
            }
            let sign = if hyper || (k / 2) % 2 == 0 { 1 } else { -1 };
            ts.push(mul(vec![int(sign), binom(m, k), pow(&c, &int((m - k) as i64)), pow(&s, &int(k as i64))]));
        }
        add(ts)
    };
    let tanpart = |odd: bool, t: &Expr| -> Expr {
        let mut ts = vec![];
        for k in 0..=m {
            if (k % 2 == 1) != odd {
                continue;
            }
            let sign = if hyper || (k / 2) % 2 == 0 { 1 } else { -1 };
            ts.push(mul(vec![int(sign), binom(m, k), pow(t, &int(k as i64))]));
        }
        add(ts)
    };
    let odd_fn = matches!(f, Fun::Sin | Fun::Sinh | Fun::Tan | Fun::Tanh);
    let r = match f {
        Fun::Sin | Fun::Sinh => part(true),
        Fun::Cos | Fun::Cosh => part(false),
        Fun::Tan | Fun::Tanh => {
            let t = f1(f.clone(), v);
            let (nu, de) = (tanpart(true, &t), tanpart(false, &t));
            // the denominator led by a positive term, as Sage writes it
            // (-2*tan(x)/(tan(x)^2 - 1)): its highest even power's sign
            let top = if m % 2 == 0 { m } else { m - 1 };
            if !hyper && (top / 2) % 2 == 1 {
                div(&neg(&nu), &neg(&de))
            } else {
                div(&nu, &de)
            }
        }
        _ => unreachable!(),
    };
    if n < 0 && odd_fn {
        neg(&r)
    } else {
        r
    }
}

// ------------------------------------------------------------------ reduce_trig

/// Products and positive integer powers of sin and cos (and of sinh and
/// cosh) as sums of sin and cos of combined arguments, term by term of each
/// sum, everywhere in e: sin(x)^2 = 1/2 - 1/2*cos(2*x).  Other factors stay
/// as factors; a sum raised to a power is not expanded first (as Sage).
pub fn reduce_trig(e: &Expr) -> Expr {
    match &e.kind {
        Kind::Add(ts) => add(ts.iter().map(reduce_trig).collect()),
        // a product as a whole (its factors one by one would not combine)
        Kind::Mul(_) | Kind::Pow(..) => match reduce_product(e) {
            Reduce::Done(r) => r,
            Reduce::Keep => e.clone(),
            Reduce::NoWaves => map(e, &mut |c| reduce_trig(c)),
        },
        _ => map(e, &mut |c| reduce_trig(c)),
    }
}

enum Reduce {
    Done(Expr),
    /// a sine or cosine to a power other than a positive integer: as is
    Keep,
    NoWaves,
}

#[derive(Clone, Copy, PartialEq)]
enum Wave {
    Sin,
    Cos,
}

/// A linear combination of exponentials: (argument, coefficient) pairs.
type Comb = Vec<(Expr, Expr)>;

fn comb_add(c: &mut Comb, v: Expr, k: Expr) {
    match c.iter_mut().find(|(w, _)| *w == v) {
        Some(p) => p.1 = add2(&p.1, &k),
        None => c.push((v, k)),
    }
}

/// The product of the given sin/cos factors (trig, or hyperbolic) as a
/// sum of terms.
fn reduce_waves(ws: &[(Wave, Expr)], hyper: bool) -> Vec<Expr> {
    // sin u = (E(u) - E(-u))/(2i), cos u = (E(u) + E(-u))/2 with E(u) = e^(iu)
    // (sinh u = (H(u) - H(-u))/2, cosh u = (H(u) + H(-u))/2, H(u) = e^u)
    let half = qnum(crate::num::qr(1, 2));
    let s_coef = if hyper { half.clone() } else { mul2(&half, &neg(&i())) }; // 1/(2i) = -i/2
    let mut c: Comb = vec![(zero(), one())];
    for (w, u) in ws {
        let mut d: Comb = vec![];
        for (v, k) in &c {
            match w {
                Wave::Sin => {
                    comb_add(&mut d, add2(v, u), mul2(k, &s_coef));
                    comb_add(&mut d, sub(v, u), neg(&mul2(k, &s_coef)));
                }
                Wave::Cos => {
                    comb_add(&mut d, add2(v, u), mul2(k, &half));
                    comb_add(&mut d, sub(v, u), mul2(k, &half));
                }
            }
        }
        c = d;
    }
    // pair E(v) with E(-v): c E(v) + d E(-v) = (c + d) cos v + i (c - d) sin v
    let (cf, sf) = if hyper { (Fun::Cosh, Fun::Sinh) } else { (Fun::Cos, Fun::Sin) };
    let mut done = vec![false; c.len()];
    let mut out = vec![];
    for j in 0..c.len() {
        if done[j] {
            continue;
        }
        done[j] = true;
        let (v, k) = (c[j].0.clone(), c[j].1.clone());
        if v.is_zero() {
            out.push(k);
            continue;
        }
        let nv = neg(&v);
        let mut kn = zero();
        if let Some(p) = (0..c.len()).find(|&q| !done[q] && c[q].0 == nv) {
            done[p] = true;
            kn = c[p].1.clone();
        }
        // the argument as Sage writes it
        let (v, k, kn) = if last_term_negative(&v) { (nv, kn, k) } else { (v, k, kn) };
        let a = add2(&k, &kn);
        let b = if hyper { sub(&k, &kn) } else { mul2(&i(), &sub(&k, &kn)) };
        out.push(mul2(&a, &fun1(cf.clone(), &v)));
        out.push(mul2(&b, &fun1(sf.clone(), &v)));
    }
    out
}

/// Whether the last term of v, as printed, has a minus sign (Sage writes
/// the combined arguments with it positive: sin(-x + y)).
fn last_term_negative(v: &Expr) -> bool {
    let s = crate::print::to_string(v);
    match (s.rfind(" - "), s.rfind(" + ")) {
        (Some(m), Some(p)) => m > p,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => s.starts_with('-'),
    }
}

fn reduce_product(e: &Expr) -> Reduce {
    let fs = match &e.kind {
        Kind::Mul(v) => v.clone(),
        _ => vec![e.clone()],
    };
    let (mut trig, mut hyp, mut other) = (vec![], vec![], vec![]);
    for f in fs {
        let (b, k) = base_exp(&f);
        let wave = match &b.kind {
            Kind::Fun(Fun::Sin, a) => Some((false, Wave::Sin, a[0].clone())),
            Kind::Fun(Fun::Cos, a) => Some((false, Wave::Cos, a[0].clone())),
            Kind::Fun(Fun::Sinh, a) => Some((true, Wave::Sin, a[0].clone())),
            Kind::Fun(Fun::Cosh, a) => Some((true, Wave::Cos, a[0].clone())),
            _ => None,
        };
        match wave {
            Some((h, w, u)) => {
                // a positive integer power; any other (sin(x)^2/cos(x)): as is
                let Some(n) = k.as_i64().filter(|&n| n >= 1 && n <= 64 && k.as_num().map_or(false, |m| m.is_exact())) else {
                    return Reduce::Keep;
                };
                for _ in 0..n {
                    if h { hyp.push((w, u.clone())) } else { trig.push((w, u.clone())) }
                }
            }
            // (its parts reduced, not itself again)
            None => other.push(map(&f, &mut |c| reduce_trig(c))),
        }
    }
    if trig.len() + hyp.len() <= 1 {
        return Reduce::NoWaves;
    }
    let t = if trig.is_empty() { vec![one()] } else { reduce_waves(&trig, false) };
    let h = if hyp.is_empty() { vec![one()] } else { reduce_waves(&hyp, true) };
    let o = mul(other);
    let mut terms = vec![];
    for a in &t {
        for b in &h {
            terms.push(mul(vec![o.clone(), a.clone(), b.clone()]));
        }
    }
    Reduce::Done(add(terms))
}

// ------------------------------------------------------------------ logs

/// log of a product as the sum of the logs of its factors and log of a
/// power b^p as p*log(b), everywhere in e (products = false: powers only,
/// Sage's algorithm='powers').  A negative number factor gives I*pi, as
/// log(-1) = I*pi; numbers are not factored (log(8) stays).
pub fn expand_log(e: &Expr, products: bool) -> Expr {
    let e = map(e, &mut |c| expand_log(c, products));
    if let Kind::Fun(Fun::Log, a) = &e.kind {
        if a.len() == 1 {
            return split_log(&a[0], products);
        }
    }
    e
}

fn split_log(u: &Expr, products: bool) -> Expr {
    match &u.kind {
        Kind::Mul(fs) if products => add(fs.iter().map(|f| split_log(f, products)).collect()),
        Kind::Num(Num::Exact(re, im)) if im.is_zero() && re.is_negative() && products => {
            let r = qnum(-re.clone());
            add2(&mul2(&i(), &pi()), &log(&r))
        }
        Kind::Pow(b, p) => {
            if b.is_const(Const::E) {
                p.clone()
            } else {
                mul2(p, &split_log(b, products))
            }
        }
        _ => log(u),
    }
}

/// Sums of logs with integer coefficients as the log of one product
/// (log(x) - 2*log(y) = log(x/y^2)), everywhere in e.  As Sage, a log of a
/// number joins only with coefficient 1 or -1 (3*log(2) stays), and a lone
/// log with coefficient 1 or -1 stays.
pub fn simplify_log(e: &Expr) -> Expr {
    let e = map(e, &mut |c| simplify_log(c));
    let terms = match &e.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![e.clone()],
    };
    let mut joined = vec![];
    let mut rest = vec![];
    for t in terms {
        match log_term(&t) {
            // (a number's log only with coefficient 1 or -1)
            Some((c, u)) if !(u.is_num() && c.abs() != BigInt::one()) => joined.push((c, u)),
            _ => rest.push(t),
        }
    }
    let single_unit = joined.len() == 1 && joined[0].0.abs() == BigInt::one();
    if joined.is_empty() || single_unit {
        return e;
    }
    let prod = mul(joined.iter().map(|(c, u)| pow(u, &big(c.clone()))).collect());
    rest.push(log(&prod));
    add(rest)
}

/// t = c*log(u) with an integer c.
fn log_term(t: &Expr) -> Option<(BigInt, Expr)> {
    match &t.kind {
        Kind::Fun(Fun::Log, a) if a.len() == 1 => Some((BigInt::one(), a[0].clone())),
        Kind::Mul(fs) if fs.len() == 2 => {
            let c = fs[0].as_int()?;
            match &fs[1].kind {
                Kind::Fun(Fun::Log, a) if a.len() == 1 && !c.is_zero() => Some((c, a[0].clone())),
                _ => None,
            }
        }
        _ => None,
    }
}


// ------------------------------------------------------------------ radicals

/// Sage's canonicalize_radical: radicals and logs in one canonical form,
/// choosing branches (sqrt(x^2) = x, as Sage documents): a power of a
/// product is the product of the powers, (b^p)^q is b^(p*q), a polynomial
/// base is factored first, numeric radicals with the same exponent are
/// combined, logs of products and powers are split, e^(c*log(u)) is u^c.
pub fn canonicalize_radical(e: &Expr) -> Expr {
    let e = map(e, &mut |c| canonicalize_radical(c));
    match &e.kind {
        Kind::Pow(b, q) if b.is_const(Const::E) => exp_logs(q),
        Kind::Pow(b, q) if q.as_int().is_none() => radical_power(b, q),
        Kind::Fun(Fun::Log, a) if a.len() == 1 => split_log(&a[0], true),
        Kind::Mul(fs) => combine_numeric_radicals(fs),
        _ => e,
    }
}

fn radical_power(b: &Expr, q: &Expr) -> Expr {
    // a polynomial base factored (sqrt(x^2 + 2*x + 1) = x + 1)
    let b = if matches!(b.kind, Kind::Add(_)) { crate::simplify::factor(b) } else { b.clone() };
    distribute_power(&b, q)
}

fn distribute_power(b: &Expr, q: &Expr) -> Expr {
    match &b.kind {
        Kind::Mul(fs) => mul(fs.iter().map(|f| distribute_power(f, q)).collect()),
        Kind::Pow(g, p) if !g.is_const(Const::E) => distribute_power(g, &mul2(p, q)),
        _ => pow(b, q),
    }
}

/// e^(c1*log(u1) + ... + rest) = u1^c1 * ... * e^rest.
fn exp_logs(q: &Expr) -> Expr {
    let ts = match &q.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![q.clone()],
    };
    let (mut fs, mut rest) = (vec![], vec![]);
    for t in ts {
        let (c, f) = match &t.kind {
            Kind::Mul(v) if v.len() == 2 && v[0].is_num() => (v[0].clone(), v[1].clone()),
            _ => (one(), t.clone()),
        };
        match &f.kind {
            Kind::Fun(Fun::Log, a) if a.len() == 1 => fs.push(pow(&a[0], &c)),
            _ => rest.push(t),
        }
    }
    if fs.is_empty() {
        return pow(&constant(Const::E), q);
    }
    fs.push(pow(&constant(Const::E), &add(rest)));
    mul(fs)
}

/// sqrt(6)*sqrt(2) = sqrt(12) = 2*sqrt(3): powers of positive rationals
/// with the same exponent as one power.
fn combine_numeric_radicals(fs: &[Expr]) -> Expr {
    let mut groups: Vec<(Expr, Expr)> = vec![]; // (exponent, product of bases)
    let mut other = vec![];
    for f in fs {
        if let Kind::Pow(b, x) = &f.kind {
            if b.as_rat().map_or(false, |r| r.is_positive()) && x.as_rat().map_or(false, |r| !r.is_integer()) {
                match groups.iter_mut().find(|(y, _)| y == x) {
                    Some(g) => g.1 = mul2(&g.1, b),
                    None => groups.push((x.clone(), b.clone())),
                }
                continue;
            }
        }
        other.push(f.clone());
    }
    for (x, b) in groups {
        other.push(pow(&b, &x));
    }
    mul(other)
}

// ------------------------------------------------------------------ factorials

/// Sage's simplify_factorial: factorials (and gammas) whose arguments
/// differ by integers combined, factorial(n + 2)/factorial(n) =
/// (n + 2)*(n + 1); binomial(a, b) with a symbolic b in factorials.
pub fn simplify_factorial(e: &Expr) -> Expr {
    let e = map(e, &mut |c| simplify_factorial(c));
    if let Kind::Fun(Fun::Binomial, a) = &e.kind {
        // binomial(a, k) for an integer k >= 0: a (a-1) ... (a-k+1)/k!
        if let (Some(k), None) = (a[1].as_int().and_then(|k| k.to_i64()), a[0].as_int()) {
            if k < 0 {
                return zero();
            }
            if k <= 1000 {
                let mut fs: Vec<Expr> = (0..k).map(|j| sub(&a[0], &int(j))).collect();
                let mut kf = BigInt::one();
                for j in 2..=k {
                    kf *= BigInt::from(j);
                }
                fs.push(qnum(Q::new(BigInt::one(), kf)));
                return mul(fs);
            }
        }
        if a.len() == 2 && a[1].as_int().is_none() {
            let (n, k) = (&a[0], &a[1]);
            return div(&f1(Fun::Factorial, n), &mul2(&f1(Fun::Factorial, k), &f1(Fun::Factorial, &sub(n, k))));
        }
    }
    match &e.kind {
        Kind::Mul(fs) => combine_factorials(fs).unwrap_or(e.clone()),
        _ => e,
    }
}

/// u = s + c with an integer c (the constant term of a sum; 0 otherwise).
fn integer_shift(u: &Expr) -> (Expr, i64) {
    if let Kind::Add(ts) = &u.kind {
        for (j, t) in ts.iter().enumerate() {
            if let Some(c) = t.as_i64() {
                if t.as_num().map_or(false, |n| n.is_exact()) {
                    let rest: Vec<Expr> = ts.iter().enumerate().filter(|(k, _)| *k != j).map(|(_, x)| x.clone()).collect();
                    return (add(rest), c);
                }
            }
        }
    }
    (u.clone(), 0)
}

fn combine_factorials(fs: &[Expr]) -> Option<Expr> {
    // (s, shift, exponent) of each factorial(s + shift)^exponent
    // (gamma(u) = factorial(u - 1)); exponents exact (no wrapping)
    let mut facts: Vec<(Expr, i64, BigInt)> = vec![];
    let mut other = vec![];
    for f in fs {
        let (b, k) = base_exp(f);
        let arg = match &b.kind {
            Kind::Fun(Fun::Factorial, a) if a.len() == 1 => Some(a[0].clone()),
            Kind::Fun(Fun::Gamma, a) if a.len() == 1 => Some(sub(&a[0], &one())),
            _ => None,
        };
        match (arg, k.as_int()) {
            (Some(u), Some(m)) if !u.is_num() => {
                let (s, c) = integer_shift(&u);
                facts.push((s, c, m));
            }
            _ => other.push(f.clone()),
        }
    }
    // groups of the same s
    let mut done = vec![false; facts.len()];
    let mut changed = false;
    let mut out = other;
    for j in 0..facts.len() {
        if done[j] {
            continue;
        }
        let s = facts[j].0.clone();
        let members: Vec<usize> = (j..facts.len()).filter(|&k| !done[k] && facts[k].0 == s).collect();
        for &k in &members {
            done[k] = true;
        }
        let lo = members.iter().map(|&k| facts[k].1).min().unwrap();
        let hi = members.iter().map(|&k| facts[k].1).max().unwrap();
        // (the span checked: shifts near the ends of i64 do not combine)
        let span_ok = hi.checked_sub(lo).map_or(false, |d| d <= 1000);
        if members.len() < 2 || !span_ok {
            for &k in &members {
                out.push(pow(&f1(Fun::Factorial, &add2(&s, &int(facts[k].1))), &big(facts[k].2.clone())));
            }
            continue;
        }
        changed = true;
        // factorial(s + c) = factorial(s + lo) * (s + lo + 1) ... (s + c)
        let mut total = BigInt::zero();
        for &k in &members {
            let (c, m) = (facts[k].1, &facts[k].2);
            total += m;
            // (offsets from lo, at most 1000: lo + 1 may not exist in i64)
            for off in 1..=(c - lo) {
                out.push(pow(&add2(&s, &int(lo + off)), &big(m.clone())));
            }
        }
        if !total.is_zero() {
            out.push(pow(&f1(Fun::Factorial, &add2(&s, &int(lo))), &big(total)));
        }
    }
    if changed {
        Some(mul(out))
    } else {
        None
    }
}

// ------------------------------------------------------------------ partial fractions

/// The partial fraction decomposition of a rational function of x over Q:
/// the polynomial part plus B/p^j for the irreducible factors p of the
/// denominator (deg B < deg p).  None where the coefficients are not
/// rational numbers.
pub fn partial_fraction(e: &Expr, x: &str) -> Option<Expr> {
    use crate::qpoly::QPoly;
    let (n, d) = crate::simplify::together(e);
    let (n, d) = (crate::expand::expand(&n), crate::expand::expand(&d));
    let (np, dp) = (QPoly::from_expr(&n, x)?, QPoly::from_expr(&d, x)?);
    if dp.is_zero() {
        return None;
    }
    let g = np.gcd(&dp);
    let (np, dp) = (np.div_exact(&g), dp.div_exact(&g));
    let xs = sym(x);
    let (q, r) = np.divrem(&dp);
    let mut terms = vec![q.to_expr(&xs)];
    if r.is_zero() || dp.deg() == 0 {
        if dp.deg() == 0 {
            return Some(div(&np.to_expr(&xs), &dp.to_expr(&xs)));
        }
        return Some(add(terms));
    }
    // r/d with d = lc * prod p_i^e_i (p_i monic): split off one p_i^e_i at a time
    let lc = dp.lc();
    let mut num = r.scale(&(Q::one() / lc));
    let factors = dp.factor();
    let mut rest = dp.monic();
    for (p, ex) in &factors {
        let pe = p.pow(*ex);
        rest = rest.div_exact(&pe);
        // num/(pe*rest) = s/pe + t/rest
        let (s, t) = if rest.deg() == 0 {
            (num.scale(&(Q::one() / rest.lc())), QPoly::zero())
        } else {
            QPoly::solve_bezout(&rest, &pe, &num)?
        };
        num = t;
        // s/p^ex as sum_j B_j/p^(ex - j), deg B_j < deg p
        let (pint, scale) = primitive(p);
        let mut a = s;
        for j in 0..*ex {
            let (qq, b) = a.divrem(p);
            a = qq;
            if b.is_zero() {
                continue;
            }
            let k = ex - j;
            // b/p^k = (b * scale^k)/pint^k
            let b = b.scale(&crate::qpoly::pow_q(&scale, k));
            let (bint, c) = primitive(&b);
            let c = Q::one() / c;
            terms.push(mul(vec![qnum(c), bint.to_expr(&xs), pow(&pint.to_expr(&xs), &int(-(k as i64)))]));
        }
    }
    Some(add(terms))
}

type Q = crate::num::Q;

/// p = pint/scale with pint a primitive integer polynomial, positive leading
/// coefficient (2*x + 1 for x + 1/2): (pint, scale).
fn primitive(p: &crate::qpoly::QPoly) -> (crate::qpoly::QPoly, Q) {
    use num_integer::Integer;
    let mut l = BigInt::one();
    let mut g = BigInt::zero();
    for c in &p.0 {
        l = l.lcm(c.denom());
        g = g.gcd(c.numer());
    }
    if g.is_zero() {
        return (p.clone(), Q::one());
    }
    let mut s = Q::new(l, g);
    if p.lc().is_negative() {
        s = -s;
    }
    (p.scale(&s), s)
}
