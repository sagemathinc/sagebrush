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
    match try_limit(e, x, a, dir) {
        Ok(r) => r,
        Err(err) => crate::err::throw(err),
    }
}

/// [`limit`], with a limit that cannot be found an Err rather than a
/// thrown error (which, in WebAssembly, cannot be caught).
pub fn try_limit(e: &Expr, x: &str, a: &Expr, dir: Dir) -> R<Expr> {
    // one budget for the whole recursion (limits of abs arguments, of their
    // derivatives, ...): an expression that cycled crashed the process (the
    // fourth review's U1)
    thread_local! {
        static DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            DEPTH.with(|d| d.set(d.get() - 1));
        }
    }
    if DEPTH.with(|d| d.get()) > 60 {
        return fail("limit: too deep");
    }
    DEPTH.with(|d| d.set(d.get() + 1));
    let _guard = Guard;
    // abs(u) and sign(u) of u in x differ on the two sides: one-sided limits,
    // with abs(u) = +-u by the sign of u beside a
    if has_abs(e, x) && !a.is_infinite() && dir == Dir::Both {
        let (l, r) = (try_limit(e, x, a, Dir::Minus)?, try_limit(e, x, a, Dir::Plus)?);
        return Ok(if l == r { r } else { constant(Const::Undefined) });
    }
    if has_abs(e, x) {
        let e2 = resolve_abs(e, x, a, dir)?;
        if e2 != *e {
            return try_limit(&e2, x, a, dir);
        }
    }
    // division by zero is an infinity here, never an error to recover from
    soft(|| lim(e, x, a, dir, 0)).map(|r| tidy(&r))
}

/// abs or sign of something that depends on x (abs(y) is a constant here).
fn has_abs(e: &Expr, x: &str) -> bool {
    matches!(&e.kind, Kind::Fun(Fun::Abs | Fun::Sign, a) if depends(&a[0], x)) || e.children().iter().any(|c| has_abs(c, x))
}

/// u is real near a (on the side dir; eventually, at +-oo): by its form,
/// with logarithms and fractional powers of positive arguments only.
fn real_near(u: &Expr, x: &str, a: &Expr, dir: Dir) -> bool {
    crate::domain::real_with(u, x, &|w| eventual_sign(w, x, a, dir, 0) == Some(1))
}

/// u = P + I Q with P, Q real near a, for |u| = sqrt(P^2 + Q^2).
fn re_im(u: &Expr, x: &str, a: &Expr, dir: Dir) -> Option<(Expr, Expr)> {
    let ex = crate::expand::expand(u);
    let terms = match &ex.kind {
        Kind::Add(v) => v.clone(),
        _ => vec![ex.clone()],
    };
    let (mut p, mut q) = (vec![], vec![]);
    for t in terms {
        let (c, r) = split_coeff(&t);
        if !real_near(&r, x, a, dir) {
            return None;
        }
        let (re, im) = match c {
            crate::num::Num::Exact(re, im) => (qnum(re), qnum(im)),
            crate::num::Num::Float(re, im) => (float(re), float(im)),
        };
        p.push(mul(vec![re, r.clone()]));
        q.push(mul(vec![im, r]));
    }
    Some((add(p), add(q)))
}

/// abs(u) -> u or -u, sign(u) -> +-1, by the sign u has near a (on the side
/// dir; eventually, at +-oo), established by eventual_sign: not sampled (the
/// third review's T5: a sample at a +- 10^-9 or at +-10^9 need not be on the
/// right side of u's zeros, and |x - 10^20| had limit -oo at +oo).
fn resolve_abs(e: &Expr, x: &str, a: &Expr, dir: Dir) -> R<Expr> {
    if e.children().is_empty() {
        return Ok(e.clone());
    }
    let e = rebuild(e, e.children().iter().map(|c| resolve_abs(c, x, a, dir)).collect::<R<Vec<_>>>()?);
    if let Kind::Fun(g @ (Fun::Abs | Fun::Sign), args) = &e.kind {
        if !depends(&args[0], x) {
            return Ok(e.clone());
        }
        // a complex argument (1 + I x: its limit's sign says nothing): the
        // modulus of its real and imaginary parts, or no rewrite
        if !real_near(&args[0], x, a, dir) {
            if let (Fun::Abs, Some((p, q))) = (g, re_im(&args[0], x, a, dir)) {
                return Ok(sqrt(&add(vec![pow(&p, &int(2)), pow(&q, &int(2))])));
            }
            return fail(format!("limit: {} is not established to be real near the point", crate::to_string(&args[0])));
        }
        let Some(sg) = eventual_sign(&args[0], x, a, dir, 0) else {
            return fail(format!("limit: the sign of {} near the point is not established", crate::to_string(&args[0])));
        };
        return Ok(match (g, sg) {
            (Fun::Abs, s) => if s < 0 { neg(&args[0]) } else { args[0].clone() },
            (_, s) => int(s as i64),
        });
    }
    Ok(e)
}

/// The sign of a real constant, certified (domain::const_sign: exact, or an
/// enclosure excluding 0; a float with a large margin is not enough:
/// sin(10^20 + 1) evaluated as sin(1e20) has the wrong sign, the fourth
/// review's U4).
fn const_sign(c: &Expr) -> Option<i32> {
    crate::domain::const_sign(c)
}

/// The sign u keeps near a on the side dir (eventually, at +-oo), or None:
/// that of its limit when the limit is not 0; when it is 0, by the mean
/// value theorem from u' (u(a + h) = h u'(xi), u(a - h) = -h u'(xi); at +oo,
/// u = -(integral of u' to oo); at -oo, the integral from -oo).
fn eventual_sign(u: &Expr, x: &str, a: &Expr, dir: Dir, depth: u32) -> Option<i32> {
    if !depends(u, x) {
        return const_sign(u).filter(|&s| s != 0);
    }
    if depth > 6 || !real_near(u, x, a, dir) {
        return None; // (the mean value theorem below is about real functions)
    }
    let l = try_limit(u, x, a, dir).ok()?;
    if l.is_const(Const::Infinity) {
        return Some(1);
    }
    if l.is_const(Const::MinusInfinity) {
        return Some(-1);
    }
    if l.is_infinite() || l.is_const(Const::Undefined) || has_infinity(&l) {
        return None;
    }
    match const_sign(&l) {
        Some(0) => {}
        Some(s) => return Some(s),
        None => {
            if !crate::simplify::simplify_full(&l).is_zero() {
                return None;
            }
        }
    }
    let factor = if a.is_const(Const::Infinity) { -1 } else if a.is_const(Const::MinusInfinity) { 1 } else if dir == Dir::Minus { -1 } else { 1 };
    eventual_sign(&diff(u, x), x, a, dir, depth + 1).map(|s| factor * s)
}

/// Whether e is bounded whatever x does (sin, cos, arctan, tanh, ... of
/// real arguments: sin(I x) = I sinh(x) is not, the fourth review's U5).
fn bounded(e: &Expr, x: &str) -> bool {
    if !depends(e, x) {
        return !has_infinity(e);
    }
    match &e.kind {
        Kind::Fun(Fun::Sin | Fun::Cos | Fun::Atan | Fun::Tanh | Fun::Erf, a) => crate::domain::real_everywhere(&a[0], x),
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
        // on a branch cut or a jump substitution gives one side's value (the
        // fourth review's U6, log(-1 + I x) from below; the fifth's V5,
        // atan(2 I + x)): the argument's value must be certified off it
        // (domain::off_cut), or move along it as a real argument
        if !cut_ok(e, x, rules) {
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
    let e = &at_infinity(e);
    if e.is_infinite() || e.is_const(Const::Undefined) {
        return e.clone();
    }
    simplify_rational(e)
}

/// Monotone functions at +-oo, applied where a limit was passed through
/// them: log(+oo) = +oo, log(oo) = oo, e^(+-oo) = +oo, 0, atan(+-oo) = +-pi/2, ...
fn at_infinity(e: &Expr) -> Expr {
    let e = map(e, &mut |c| at_infinity(c));
    let (plus, minus) = (|x: &Expr| x.is_const(Const::Infinity), |x: &Expr| x.is_const(Const::MinusInfinity));
    match &e.kind {
        Kind::Fun(Fun::Log, a) if plus(&a[0]) => infinity(),
        // |log z| >= log |z|
        Kind::Fun(Fun::Log, a) if a[0].is_const(Const::UnsignedInfinity) => constant(Const::UnsignedInfinity),
        Kind::Fun(Fun::Atan, a) if plus(&a[0]) => div(&pi(), &int(2)),
        Kind::Fun(Fun::Atan, a) if minus(&a[0]) => neg(&div(&pi(), &int(2))),
        Kind::Fun(Fun::Sinh, a) if plus(&a[0]) || minus(&a[0]) => a[0].clone(),
        Kind::Fun(Fun::Cosh, a) if plus(&a[0]) || minus(&a[0]) => infinity(),
        Kind::Fun(Fun::Tanh, a) if plus(&a[0]) => int(1),
        Kind::Fun(Fun::Tanh, a) if minus(&a[0]) => int(-1),
        Kind::Pow(b, n) if b.is_const(Const::E) && plus(n) => infinity(),
        Kind::Pow(b, n) if b.is_const(Const::E) && minus(n) => int(0),
        _ => e,
    }
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
    // 2. series at the point (not across a branch cut: the expansion is
    // that of one side)
    if !(is_finite_value(a) && crosses_cut(e, x, a)) {
        if let Ok(Some(v)) = series_limit(e, x, a, dir) {
            return Ok(v);
        }
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
                // a fractional power at its branch cut: only along it
                if !p.as_rat().map_or(false, |q| q.is_integer()) && !l.is_zero() && !crate::domain::off_cut(crate::domain::Cut::NonPositive, &l) && !real_near(b, x, a, dir) {
                    // b^p = |l|^p e^(+-i pi p) from one side of the axis
                    if let Some(s) = side_of_cut(b, x, a, dir, &l) {
                        // e^(i pi p) as cos + i sin (exact at rational multiples of pi)
                        let t = mul(vec![int(s as i64), pi(), p.clone()]);
                        let phase = add2(&fun1(Fun::Cos, &t), &mul2(&num(crate::num::Num::i()), &fun1(Fun::Sin, &t)));
                        return Ok(mul2(&pow(&neg(&l), p), &phase));
                    }
                    return fail("limit: a fractional power's base tends to its branch cut");
                }
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
            // log(0+) = -oo only from the positive side (the fourth review's
            // U6): |log u| >= -log |u|, complex infinity otherwise
            if *f == Fun::Log && l.is_zero() {
                return Ok(if eventual_sign(&args[0], x, a, dir, 0) == Some(1) { constant(Const::MinusInfinity) } else { constant(Const::UnsignedInfinity) });
            }
            // at a point of a branch cut or jump the function is continuous
            // only along the cut, for a real argument (and never at a jump):
            // the limit is certified off it or not given (the fifth
            // review's V4, V5)
            if let Some((cut, _)) = crate::domain::cut_of(e) {
                if is_finite_value(&l) && !crate::domain::off_cut(cut, &l) && !(crate::domain::along_cut_ok(e, cut, &l) && real_near(&args[0], x, a, dir)) {
                    // log from one side of the negative axis
                    if *f == Fun::Log {
                        if let Some(s) = side_of_cut(&args[0], x, a, dir, &l) {
                            return Ok(add2(&log(&neg(&l)), &mul(vec![int(s as i64), num(crate::num::Num::i()), pi()])));
                        }
                    }
                    return fail(format!("limit: the argument of {} tends to its branch cut or jump", crate::to_string(e)));
                }
            }
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

/// u -> l, a certified negative real, from the side of the negative real
/// axis given by the established sign of Im u near a (the same on both sides
/// for a two-sided limit): +-1, or None.
fn side_of_cut(u: &Expr, x: &str, a: &Expr, dir: Dir, l: &Expr) -> Option<i32> {
    let (re, im) = crate::domain::complex_encl(l)?;
    if !(im.0 == 0.0 && im.1 == 0.0 && re.1 < 0.0) {
        return None;
    }
    let side = |d: Dir| -> Option<i32> {
        let (_, q) = re_im(u, x, a, d)?;
        eventual_sign(&q, x, a, d, 0)
    };
    match dir {
        Dir::Both => {
            let (m, p) = (side(Dir::Minus)?, side(Dir::Plus)?);
            (m == p).then_some(p)
        }
        d => side(d),
    }
}

/// Whether e's own cut or jump (domain::cut_of) is no obstacle at the
/// point: its argument free of x, real for real x with a cut met only along
/// the real axis, or its value there certified off the cut.
fn cut_ok(e: &Expr, x: &str, rules: &[(Expr, Expr)]) -> bool {
    let Some((cut, u)) = crate::domain::cut_of(e) else { return true };
    if !depends(u, x) {
        return true;
    }
    let v = subs(u, rules);
    crate::domain::off_cut(cut, &v) || crate::domain::real_everywhere(u, x) && crate::domain::along_cut_ok(e, cut, &v)
}

/// Whether some part of e meets its branch cut or jump at a (cut_ok fails):
/// a series there is one side's.
fn crosses_cut(e: &Expr, x: &str, a: &Expr) -> bool {
    if !depends(e, x) {
        return false;
    }
    !cut_ok(e, x, &[(sym(x), a.clone())]) || e.children().iter().any(|c| crosses_cut(c, x, a))
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
        // a function at an infinity no rule above covers (sin of complex
        // infinity, ...): not a value to compute with (0 sin(oo) became 0)
        _ if has_infinity(l) => return fail(format!("limit of {:?} at {} not found", f, crate::to_string(l))),
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

fn signed_infinity(n: &Expr, d: &Expr, x: &str, a: &Expr, dir: Dir, _ln: &Expr) -> Expr {
    // the sign of n/d just beside a, established (eventual_sign), not
    // sampled: otherwise complex infinity, which is still true
    let side = |s: Dir| -> Option<i32> { Some(eventual_sign(n, x, a, s, 0)? * eventual_sign(d, x, a, s, 0)?) };
    let signed = |s: Option<i32>| match s {
        Some(1) => infinity(),
        Some(-1) => constant(Const::MinusInfinity),
        _ => constant(Const::UnsignedInfinity),
    };
    match dir {
        Dir::Both => match (side(Dir::Minus), side(Dir::Plus)) {
            (Some(l), Some(r)) if l == r => signed(Some(r)),
            _ => constant(Const::UnsignedInfinity),
        },
        d => signed(side(d)),
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
    // a pole of order -v: signed by the leading coefficient's certified
    // sign (a double's sign decides nothing), else complex infinity (|f|
    // grows without bound: still true)
    let Some(c) = const_sign(&c0).filter(|&c| c != 0) else { return Ok(Some(constant(Const::UnsignedInfinity))) };
    let c = c as f64;
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

#[cfg(test)]
mod sign_tests {
    use super::*;
    use crate::parse::parse;
    fn lim(e: &str, a: &str, dir: Dir) -> String {
        match try_limit(&parse(e), "x", &parse(a), dir) {
            Ok(v) => crate::to_string(&v),
            Err(_) => "not found".into(),
        }
    }
    #[test]
    fn signs_are_established_not_sampled() {
        // the third review's T5
        assert_eq!(lim("abs(x)", "1/10^20", Dir::Minus), "1/100000000000000000000");
        assert_eq!(lim("abs(x - 10^20)", "+Infinity", Dir::Both), "+Infinity");
        assert_eq!(lim("exp(-abs(x - 10^20))", "+Infinity", Dir::Both), "0");
        assert_eq!(lim("abs(x)/x", "0", Dir::Minus), "-1");
        assert_eq!(lim("abs(x)/x", "0", Dir::Plus), "1");
        assert_eq!(lim("abs(sin(x))/x", "0", Dir::Minus), "-1");
        assert_eq!(lim("abs(x^3 - x^2)/x^2", "0", Dir::Plus), "1");
        assert_eq!(lim("abs(1 - x)", "-Infinity", Dir::Both), "+Infinity");
    }

    #[test]
    fn fourth_review_cases() {
        // U1: abs of a constant terminates (and stays)
        assert_eq!(lim("abs(y)", "0", Dir::Both), "abs(y)");
        assert_eq!(lim("abs(y) + x", "0", Dir::Both), "abs(y)");
        assert_eq!(lim("abs(y)", "+Infinity", Dir::Both), "abs(y)");
        // U2: |1 + I x| is not 1 + I x
        for d in [Dir::Both, Dir::Plus, Dir::Minus] {
            let r = lim("(abs(1 + I*x) - 1)/x", "0", d);
            assert!(r == "0" || r == "not found", "{}", r);
        }
        // U4: the sign of sin(10^20 + 1) is not that of sin(1e20)
        let r = lim("abs(x + sin(10^20 + 1))", "0", Dir::Both);
        assert!(r == "abs(sin(100000000000000000001))" || r == "sin(100000000000000000001)" || r == "not found", "{}", r);
        // U5: sin(I x), cos(I x) are not bounded
        assert_ne!(lim("sin(I*x)/exp(x)", "+Infinity", Dir::Both), "0");
        assert_ne!(lim("cos(I*x)/exp(x)", "+Infinity", Dir::Both), "0");
        // U6: from below the branch cut
        assert_ne!(lim("log(-1 + I*x)", "0", Dir::Minus), "I*pi");
        assert_ne!(lim("sqrt(-1 + I*x)", "0", Dir::Minus), "I");
        assert_eq!(lim("I*x", "+Infinity", Dir::Both), "Infinity");
        let r = lim("log(-1 + I*x)", "0", Dir::Plus);
        assert!(r == "I*pi" || r == "not found", "{}", r);
    }

    /// The fifth review's V4 and V5: branch cuts and jumps by certified
    /// enclosures, for every function with one; the side's value or no
    /// limit, never the other side's.
    #[test]
    fn branch_cuts_by_enclosures() {
        let s = "sin(10^20 + 1)";
        for d in [Dir::Minus, Dir::Plus, Dir::Both] {
            for e in [format!("log(-{} + I*x)", s), format!("sqrt(-{} + I*x)", s), "atan(2*I + x)".into(), "asin(2 + I*x)".into(), "asinh(2*I + x)".into(), "atanh(2 + I*x)".into(), "floor(x)".into(), "acot(x)".into(), "atanh(1 + x)".into()] {
                assert_eq!(lim(&e, "0", d), "not found", "{} {:?}", e, d);
            }
        }
        assert_eq!(lim("log(-1 + I*x)", "0", Dir::Minus), "-I*pi");
        assert_eq!(lim("log(-2 + I*x)", "0", Dir::Plus), "log(2) + I*pi");
        assert_eq!(lim("log(-1 + I*x)", "0", Dir::Both), "not found");
        // off the cuts, or along them for a real argument: values
        assert_eq!(lim("atan(x + 1)", "0", Dir::Both), "1/4*pi");
        assert_eq!(lim("asin(x + 1)", "0", Dir::Both), "1/2*pi");
        assert_eq!(lim("floor(x + 1/2)", "0", Dir::Both), "0");
        assert_eq!(lim("atan(x + I/2)", "0", Dir::Both), crate::to_string(&parse("atan(I/2)")));
        // a pole's sign from the certified sign of its coefficient
        let r = lim(&format!("{}/x^2", s), "0", Dir::Both);
        assert!(r == "Infinity" || r == "not found", "{}", r);
    }
}
