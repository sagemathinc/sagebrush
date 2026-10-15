//! Special functions beyond gamma and erf: psi (digamma and polygamma),
//! log_gamma, zeta, zetaderiv, hurwitz_zeta, beta, erfc, erfi, erfinv,
//! exp_integral_e1, Ei, dilog, polylog, lambert_w, elliptic_kc and
//! elliptic_ec.  This module gives their canonical forms (psi(0, x) =
//! psi(x), polylog(2, x) = dilog(x), ...), the exact values Sage gives
//! (psi(1) = -euler_gamma, zeta(4) = pi^4/90, ...) and their derivatives.
//! Their numerical values, like gamma's and erf's, come from the front end
//! (Sage mode evaluates them with lib/_special.py), so a call with float
//! arguments stays a call here.

use crate::err::{not_implemented, value_error};
use crate::expr::*;
use crate::num::Q;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// The largest integer argument exact values are computed for (Bernoulli
/// numbers and harmonic sums cost quadratically beyond it; larger
/// arguments stay unevaluated).
const EXACT_MAX: i64 = 600;

pub fn is_special(f: &Fun) -> bool {
    matches!(
        f,
        Fun::Psi
            | Fun::LogGamma
            | Fun::Zeta
            | Fun::ZetaDeriv
            | Fun::HurwitzZeta
            | Fun::Beta
            | Fun::Erfc
            | Fun::Erfi
            | Fun::Erfinv
            | Fun::ExpIntegralE1
            | Fun::Ei
            | Fun::Dilog
            | Fun::Polylog
            | Fun::LambertW
            | Fun::EllipticKc
            | Fun::EllipticEc
    )
}

/// f(args): the canonical form, an exact value, or the call itself.
pub fn eval(f: Fun, a: Vec<Expr>) -> Expr {
    if matches!(f, Fun::Psi | Fun::LambertW) && !(1..=2).contains(&a.len()) {
        value_error(format!("{}() takes 1 or 2 arguments ({} given)", f.name(), a.len()));
    }
    if let Some(v) = canonical(&f, &a) {
        return v;
    }
    if let Some(v) = exact(&f, &a) {
        return v;
    }
    raw(Kind::Fun(f, a))
}

fn call(f: Fun, a: Vec<Expr>) -> Expr {
    fun(f, a)
}

fn euler_gamma() -> Expr {
    constant(Const::EulerGamma)
}

fn small_int(e: &Expr) -> Option<i64> {
    let r = e.as_rat()?;
    if !r.is_integer() {
        return None;
    }
    r.to_integer().to_i64().filter(|n| (-EXACT_MAX..=EXACT_MAX).contains(n))
}

/// m with e = m + 1/2, for a rational e with denominator 2.
fn half_int(e: &Expr) -> Option<i64> {
    let r = e.as_rat()?;
    if *r.denom() != BigInt::from(2) {
        return None;
    }
    r.floor().to_integer().to_i64().filter(|n| (-EXACT_MAX..=EXACT_MAX).contains(n))
}

fn is_minus_one_over_e(e: &Expr) -> bool {
    *e == neg(&recip(&constant(Const::E)))
}

fn canonical(f: &Fun, a: &[Expr]) -> Option<Expr> {
    match f {
        Fun::Psi if a.len() == 2 && a[0].is_zero() => Some(call(Fun::Psi, vec![a[1].clone()])),
        Fun::LambertW if a.len() == 2 && a[0].is_zero() => Some(call(Fun::LambertW, vec![a[1].clone()])),
        Fun::HurwitzZeta if a[1].is_one() => Some(call(Fun::Zeta, vec![a[0].clone()])),
        Fun::Polylog => {
            let (s, z) = (&a[0], &a[1]);
            if z.is_one() {
                return Some(call(Fun::Zeta, vec![s.clone()]));
            }
            if z.is_zero() {
                return Some(zero());
            }
            match s.as_i64() {
                Some(2) => Some(call(Fun::Dilog, vec![z.clone()])),
                Some(1) => Some(neg(&log(&sub(&one(), z)))),
                _ => None,
            }
        }
        _ => None,
    }
}

// ------------------------------------------------------------------ rational helpers

fn qi(n: i64) -> Q {
    Q::from_integer(BigInt::from(n))
}

fn factorial(n: i64) -> BigInt {
    let mut r = BigInt::one();
    for k in 2..=n {
        r *= BigInt::from(k);
    }
    r
}

fn binomial(n: i64, k: i64) -> BigInt {
    let mut r = BigInt::one();
    for i in 0..k {
        r = r * BigInt::from(n - i) / BigInt::from(i + 1);
    }
    r
}

/// The Bernoulli numbers B_0, ..., B_n (B_1 = -1/2), from
/// sum_(k=0)^m binomial(m + 1, k) B_k = 0.
fn bernoulli(n: i64) -> Vec<Q> {
    let mut b: Vec<Q> = vec![Q::one()];
    for m in 1..=n {
        // binomial(m + 1, k) for k = 0, 1, ... built along the row
        let mut s = Q::zero();
        let mut c = BigInt::one();
        for (k, bk) in b.iter().enumerate() {
            s += Q::from_integer(c.clone()) * bk;
            c = c * BigInt::from(m + 1 - k as i64) / BigInt::from(k as i64 + 1);
        }
        b.push(-s / qi(m + 1));
    }
    b
}

/// The Bernoulli polynomial B_n(a) = sum_k binomial(n, k) B_k a^(n-k).
fn bernoulli_poly(n: i64, a: &Q) -> Q {
    let b = bernoulli(n);
    let mut s = Q::zero();
    for k in 0..=n {
        s += Q::from_integer(binomial(n, k)) * &b[k as usize] * pow_q(a, n - k);
    }
    s
}

fn pow_q(a: &Q, k: i64) -> Q {
    let mut r = Q::one();
    for _ in 0..k.abs() {
        r *= a;
    }
    if k < 0 {
        Q::one() / r
    } else {
        r
    }
}

/// zeta(k) for an integer k: exact at even positive and nonpositive k, the
/// call zeta(k) at odd k > 1, unsigned infinity at 1.
fn zeta_int(k: i64) -> Expr {
    if k == 1 {
        return constant(Const::UnsignedInfinity);
    }
    if k == 0 {
        return rat(-1, 2);
    }
    if k < 0 {
        // zeta(-n) = -B_(n+1)/(n+1)
        let n = -k;
        let b = bernoulli(n + 1);
        return qnum(-b[(n + 1) as usize].clone() / qi(n + 1));
    }
    if k % 2 == 0 {
        // zeta(2m) = (-1)^(m+1) B_(2m) (2 pi)^(2m) / (2 (2m)!)
        let b = bernoulli(k);
        let sign = if (k / 2) % 2 == 1 { Q::one() } else { -Q::one() };
        let c = sign * &b[k as usize] * Q::from_integer(BigInt::from(2).pow(k as u32)) / Q::from_integer(BigInt::from(2) * factorial(k));
        return mul2(&qnum(c), &pow(&pi(), &int(k)));
    }
    raw(Kind::Fun(Fun::Zeta, vec![int(k)]))
}

/// psi(n, x) at positive integers and half-integers x, for an integer
/// n >= 1: (-1)^(n+1) n! hurwitz_zeta(n + 1, x).
fn psi2_exact(n: i64, x: &Expr) -> Option<Expr> {
    let h = hurwitz_int(n + 1, x)?;
    let c = if n % 2 == 1 { factorial(n) } else { -factorial(n) };
    Some(mul2(&big(c), &h))
}

/// hurwitz_zeta(s, x) for an integer s >= 2 at a positive integer or
/// half-integer x: zeta(s) minus the first terms of the sum, or
/// (2^s - 1) zeta(s) minus them.  Nonpositive integers x are poles.
fn hurwitz_int(s: i64, x: &Expr) -> Option<Expr> {
    if let Some(m) = small_int(x) {
        if m <= 0 {
            value_error("psi2_eval(): pole");
        }
        let mut t = Q::zero();
        for k in 1..m {
            t += pow_q(&qi(k), -s);
        }
        return Some(sub(&zeta_int(s), &qnum(t)));
    }
    if let Some(m) = half_int(x) {
        if m < 0 {
            return None;
        }
        let mut t = Q::zero();
        for k in 0..m {
            t += pow_q(&(qi(k) + Q::new(BigInt::one(), BigInt::from(2))), -s);
        }
        let c = Q::from_integer(BigInt::from(2).pow(s as u32)) - Q::one();
        return Some(sub(&mul2(&qnum(c), &zeta_int(s)), &qnum(t)));
    }
    None
}

fn exact(f: &Fun, a: &[Expr]) -> Option<Expr> {
    let x = a.last()?;
    match f {
        Fun::Psi if a.len() == 1 => {
            if let Some(n) = small_int(x) {
                if n <= 0 {
                    value_error("psi_eval(): simple pole");
                }
                // psi(n) = -euler_gamma + H_(n-1)
                let mut h = Q::zero();
                for k in 1..n {
                    h += Q::new(BigInt::one(), BigInt::from(k));
                }
                return Some(add2(&neg(&euler_gamma()), &qnum(h)));
            }
            // psi(m + 1/2) = psi(1/2) + sum 1/(j + 1/2), psi(1/2) = -euler_gamma - 2 log 2
            let m = half_int(x)?;
            let half = Q::new(BigInt::one(), BigInt::from(2));
            let mut c = Q::zero();
            if m >= 0 {
                for j in 0..m {
                    c += Q::one() / (qi(j) + &half);
                }
            } else {
                for j in m..0 {
                    c -= Q::one() / (qi(j) + &half);
                }
            }
            Some(add(vec![neg(&euler_gamma()), mul2(&int(-2), &log(&int(2))), qnum(c)]))
        }
        Fun::Psi => {
            let n = small_int(&a[0]).filter(|n| *n >= 1)?;
            if x.is_float() || !x.is_num() {
                return None;
            }
            psi2_exact(n, x)
        }
        Fun::LogGamma => {
            let n = small_int(x)?;
            if n <= 0 {
                return Some(infinity());
            }
            if n <= 2 {
                return Some(zero());
            }
            Some(log(&big(factorial(n - 1))))
        }
        Fun::Zeta => Some(zeta_int(small_int(x)?)),
        Fun::HurwitzZeta => {
            let s = small_int(&a[0])?;
            if x.is_float() || !x.is_num() {
                return None;
            }
            if s >= 2 {
                return hurwitz_int(s, x);
            }
            if s <= 0 {
                // hurwitz_zeta(-n, a) = -B_(n+1)(a)/(n+1)
                let r = x.as_rat()?;
                let n = -s;
                return Some(qnum(-bernoulli_poly(n + 1, r) / qi(n + 1)));
            }
            None
        }
        Fun::Beta => {
            let (p, q) = (&a[0], &a[1]);
            // a nonpositive integer (of any size) is a pole of gamma(p) or
            // gamma(q)
            for t in [p, q] {
                if let Some(r) = t.as_rat() {
                    if r.is_integer() && !r.is_positive() {
                        value_error("beta_eval(): simple pole");
                    }
                }
            }
            if p.is_one() {
                return Some(recip(q));
            }
            if q.is_one() {
                return Some(recip(p));
            }
            if let (Some(m), Some(n)) = (small_int(p), small_int(q)) {
                // (m-1)! (n-1)! / (m+n-1)!
                return Some(qnum(Q::new(factorial(m - 1) * factorial(n - 1), factorial(m + n - 1))));
            }
            // gamma(p + q) has a pole there while gamma(p), gamma(q) do not
            let (r, t) = (p.as_rat()?, q.as_rat()?);
            let s = r + t;
            if s.is_integer() && !s.is_positive() {
                return Some(zero());
            }
            None
        }
        Fun::Erfc => {
            if x.is_zero() {
                Some(one())
            } else if x.is_const(Const::Infinity) {
                Some(zero())
            } else if x.is_const(Const::MinusInfinity) {
                Some(int(2))
            } else {
                None
            }
        }
        Fun::Erfi => {
            if x.is_zero() {
                Some(zero())
            } else if x.is_const(Const::Infinity) {
                Some(constant(Const::UnsignedInfinity))
            } else {
                None
            }
        }
        Fun::Erfinv => {
            if x.is_zero() {
                Some(zero())
            } else if x.is_one() {
                Some(constant(Const::UnsignedInfinity))
            } else {
                None
            }
        }
        Fun::Dilog => {
            let r = x.as_rat()?;
            let pi2 = pow(&pi(), &int(2));
            if r.is_zero() {
                Some(zero())
            } else if r.is_one() {
                Some(mul2(&rat(1, 6), &pi2))
            } else if *r == -Q::one() {
                Some(mul2(&rat(-1, 12), &pi2))
            } else if *r == Q::new(BigInt::one(), BigInt::from(2)) {
                Some(sub(&mul2(&rat(1, 12), &pi2), &mul2(&rat(1, 2), &pow(&log(&int(2)), &int(2)))))
            } else {
                None
            }
        }
        Fun::Polylog => {
            // polylog(s, -1) = -(1 - 2^(1-s)) zeta(s)
            let s = small_int(&a[0]).filter(|s| *s >= 3)?;
            if !x.is_minus_one() {
                return None;
            }
            let c = Q::one() - Q::new(BigInt::one(), BigInt::from(2).pow((s - 1) as u32));
            Some(mul2(&qnum(-c), &zeta_int(s)))
        }
        Fun::LambertW if a.len() == 1 => {
            if x.is_zero() {
                Some(zero())
            } else if x.is_const(Const::E) {
                Some(one())
            } else if is_minus_one_over_e(x) {
                Some(int(-1))
            } else {
                None
            }
        }
        Fun::EllipticKc if x.is_zero() => Some(mul2(&rat(1, 2), &pi())),
        Fun::EllipticEc if x.is_zero() => Some(mul2(&rat(1, 2), &pi())),
        Fun::EllipticEc if x.is_one() => Some(one()),
        _ => None,
    }
}

// ------------------------------------------------------------------ derivatives

/// D[i](f)(args) * (args[i])': the derivative in an argument without a rule.
fn generic(f: &Fun, a: &[Expr], i: usize, d: &Expr) -> Expr {
    mul2(&fun(Fun::Deriv(f.name().into(), vec![i as u32]), a.to_vec()), d)
}

/// d f(a) / dx for a special function f (the chain rule included).
pub fn diff(f: &Fun, a: &[Expr], x: &str) -> Expr {
    use crate::diff::{depends, diff as d};
    let e = raw(Kind::Fun(f.clone(), a.to_vec()));
    let two = int(2);
    let sqrt_pi = sqrt(&pi());
    // the last argument is the variable of the functions with parameters
    let u = a.last().unwrap();
    let du = d(u, x);
    // a parameter (psi's n, polylog's s, ...) that depends on x
    if a.len() == 2 && !matches!(f, Fun::Beta) && depends(&a[0], x) {
        if matches!(f, Fun::HurwitzZeta) {
            not_implemented("derivative with respect to first argument");
        }
        let mut t = generic(f, a, 0, &d(&a[0], x));
        if !du.is_zero() {
            t = add2(&t, &generic(f, a, 1, &du));
        }
        return t;
    }
    if let Fun::Beta = f {
        // beta(p, q) ((psi(p) - psi(p + q)) p' + (psi(q) - psi(p + q)) q')
        let (p, q) = (&a[0], &a[1]);
        // written -(psi(p + q) - psi(p)) beta(p, q), as Sage writes it
        let pq = call(Fun::Psi, vec![add2(p, q)]);
        if p == q {
            return mul(vec![int(-2), sub(&pq, &call(Fun::Psi, vec![p.clone()])), d(p, x), e]);
        }
        let dp = mul2(&sub(&pq, &call(Fun::Psi, vec![p.clone()])), &d(p, x));
        let dq = mul2(&sub(&pq, &call(Fun::Psi, vec![q.clone()])), &d(q, x));
        return mul(vec![int(-1), add2(&dp, &dq), e]);
    }
    if du.is_zero() {
        return zero();
    }
    let r = match f {
        Fun::Psi if a.len() == 1 => call(Fun::Psi, vec![one(), u.clone()]),
        Fun::Psi => call(Fun::Psi, vec![add2(&a[0], &one()), u.clone()]),
        Fun::LogGamma => call(Fun::Psi, vec![u.clone()]),
        Fun::Zeta => call(Fun::ZetaDeriv, vec![one(), u.clone()]),
        Fun::ZetaDeriv => call(Fun::ZetaDeriv, vec![add2(&a[0], &one()), u.clone()]),
        Fun::HurwitzZeta => {
            // -s hurwitz_zeta(s + 1, u), which is (-1)^s psi(s, u)/(s - 1)!
            // for an integer s >= 1 (as Sage writes it)
            let s = &a[0];
            match small_int(s).filter(|s| *s >= 1) {
                Some(k) => {
                    let c = Q::new(if k % 2 == 0 { BigInt::one() } else { -BigInt::one() }, factorial(k - 1));
                    mul2(&qnum(c), &call(Fun::Psi, vec![s.clone(), u.clone()]))
                }
                None => neg(&mul2(s, &call(Fun::HurwitzZeta, vec![add2(s, &one()), u.clone()]))),
            }
        }
        Fun::Erfc => neg(&mul(vec![two, exp(&neg(&pow(u, &int(2)))), recip(&sqrt_pi)])),
        Fun::Erfi => mul(vec![two, exp(&pow(u, &int(2))), recip(&sqrt_pi)]),
        Fun::Erfinv => mul(vec![rat(1, 2), sqrt_pi, exp(&pow(&e, &int(2)))]),
        Fun::ExpIntegralE1 => neg(&div(&exp(&neg(u)), u)),
        Fun::Ei => div(&exp(u), u),
        Fun::Dilog => neg(&div(&log(&sub(&one(), u)), u)),
        Fun::Polylog => div(&call(Fun::Polylog, vec![sub(&a[0], &one()), u.clone()]), u),
        // W/(u W + u)
        Fun::LambertW => div(&e, &add2(&mul2(u, &e), u)),
        Fun::EllipticKc => {
            let k = e.clone();
            let ec = call(Fun::EllipticEc, vec![u.clone()]);
            let um1 = sub(u, &one());
            mul(vec![rat(-1, 2), add2(&mul2(&um1, &k), &ec), recip(&mul2(&um1, u))])
        }
        Fun::EllipticEc => {
            let kc = call(Fun::EllipticKc, vec![u.clone()]);
            mul(vec![rat(1, 2), sub(&e, &kc), recip(u)])
        }
        _ => return generic(f, a, a.len() - 1, &du),
    };
    mul2(&r, &du)
}

/// The LaTeX of f(args), as Sage writes it.
pub fn latex(f: &Fun, args: &[String]) -> Option<String> {
    let p = |name: &str| format!("{}\\left({}\\right)", name, args.join(", "));
    Some(match f {
        Fun::Psi => p("\\psi"),
        Fun::LogGamma => p("\\log\\Gamma"),
        Fun::Zeta => format!("\\zeta({})", args.join(", ")),
        Fun::ZetaDeriv => p("\\zeta^\\prime"),
        Fun::HurwitzZeta => p("\\zeta"),
        Fun::Beta => p("\\operatorname{B}"),
        Fun::Erfc => p("\\operatorname{erfc}"),
        Fun::Erfi => p("\\operatorname{erfi}"),
        Fun::Erfinv => p("\\operatorname{erfinv}"),
        Fun::ExpIntegralE1 => p("E_{1}"),
        Fun::Ei => p("{\\rm Ei}"),
        Fun::Dilog => p("{\\rm Li}_2"),
        Fun::Polylog => format!("{{\\rm Li}}_{{{}}}({})", args[0], args[1]),
        Fun::LambertW if args.len() == 1 => format!("\\operatorname{{W}}({{{}}})", args[0]),
        Fun::LambertW => format!("\\operatorname{{W_{{{}}}}}({{{}}})", args[0], args[1]),
        Fun::EllipticKc => p("K"),
        Fun::EllipticEc => p("E"),
        Fun::Gamma => p("\\Gamma"),
        Fun::User(n) if &**n == "legendre_P" => p("P"),
        Fun::User(n) if &**n == "gen_legendre_P" => p("\\mathtt{P}"),
        Fun::Erf => p("\\operatorname{erf}"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::parse::parse;
    use crate::print::{to_latex, to_string};

    fn s(src: &str) -> String {
        to_string(&parse(src))
    }

    fn d(src: &str) -> String {
        to_string(&crate::diff::diff(&parse(src), "x"))
    }

    /// The exact values Sage gives (the oracle's output, sage-tests/test_special).
    #[test]
    fn exact_values() {
        for (a, b) in [
            ("psi(1)", "-euler_gamma"),
            ("psi(5)", "-euler_gamma + 25/12"),
            ("psi(1, 1)", "1/6*pi^2"),
            ("psi(2, 1)", "-2*zeta(3)"),
            ("psi(3, 1/2)", "pi^4"),
            ("psi(1, 3/2)", "1/2*pi^2 - 4"),
            ("psi(0, x)", "psi(x)"),
            ("zeta(2)", "1/6*pi^2"),
            ("zeta(-3)", "1/120"),
            ("zeta(-2)", "0"),
            ("zeta(0)", "-1/2"),
            ("zeta(3)", "zeta(3)"),
            ("hurwitz_zeta(-1, 2)", "-13/12"),
            ("hurwitz_zeta(3, 1/2)", "7*zeta(3)"),
            ("hurwitz_zeta(4, 1/2)", "1/6*pi^4"),
            ("hurwitz_zeta(x, 1)", "zeta(x)"),
            ("beta(2, 3)", "1/12"),
            ("beta(1, x)", "1/x"),
            ("beta(-1/2, 1/2)", "0"),
            ("log_gamma(5)", "log(24)"),
            ("log_gamma(0)", "+Infinity"),
            ("polylog(2, x)", "dilog(x)"),
            ("polylog(s, 1)", "zeta(s)"),
            ("polylog(3, -1)", "-3/4*zeta(3)"),
            ("polylog(4, 1)", "1/90*pi^4"),
            ("dilog(-1)", "-1/12*pi^2"),
            ("lambert_w(e)", "1"),
            ("lambert_w(0, x)", "lambert_w(x)"),
            ("lambert_w(-1/e)", "-1"),
            ("elliptic_ec(1)", "1"),
            ("elliptic_kc(0)", "1/2*pi"),
            ("erfc(0)", "1"),
            ("erfinv(0)", "0"),
        ] {
            assert_eq!(s(a), b, "{}", a);
        }
    }

    /// Arguments beyond EXACT_MAX stay unevaluated, at once, including at
    /// i64::MIN (whose abs() overflows) and the half-integer just above it.
    #[test]
    fn large_arguments_stay_calls() {
        for (a, b) in [
            ("zeta(-9223372036854775808)", "zeta(-9223372036854775808)"),
            ("zeta(-9223372036854775807)", "zeta(-9223372036854775807)"),
            ("zeta(-602)", "zeta(-602)"),
            ("hurwitz_zeta(-9223372036854775808, 1/3)", "hurwitz_zeta(-9223372036854775808, 1/3)"),
            ("psi(-18446744073709551615/2)", "psi(-18446744073709551615/2)"),
            ("psi(-9223372036854775808)", "psi(-9223372036854775808)"),
            ("psi(1, -18446744073709551615/2)", "psi(1, -18446744073709551615/2)"),
            ("log_gamma(-9223372036854775808)", "log_gamma(-9223372036854775808)"),
        ] {
            let t = std::time::Instant::now();
            assert_eq!(s(a), b, "{}", a);
            assert!(t.elapsed().as_millis() < 500, "{}", a);
        }
        assert_eq!(s("zeta(-600)"), "0");
        // a pole of any size is a pole
        let pole = std::panic::catch_unwind(|| s("beta(-9223372036854775808, 2)"));
        assert!(pole.is_err());
    }

    #[test]
    fn derivatives() {
        for (a, b) in [
            ("psi(x)", "psi(1, x)"),
            ("psi(2, x)", "psi(3, x)"),
            ("log_gamma(x)", "psi(x)"),
            ("zeta(x)", "zetaderiv(1, x)"),
            ("gamma(x)", "gamma(x)*psi(x)"),
            ("Ei(x)", "e^x/x"),
            ("exp_integral_e1(x)", "-e^(-x)/x"),
            ("polylog(3, x)", "dilog(x)/x"),
            ("hurwitz_zeta(3, x)", "-1/2*psi(3, x)"),
            ("lambert_w(x)", "lambert_w(x)/(x*lambert_w(x) + x)"),
            ("beta(x, y)", "-(psi(x + y) - psi(x))*beta(x, y)"),
            ("zeta(x^2)", "2*x*zetaderiv(1, x^2)"),
            ("erfinv(x^2)", "sqrt(pi)*x*e^(erfinv(x^2)^2)"),
            ("elliptic_kc(x^2)", "-((x^2 - 1)*elliptic_kc(x^2) + elliptic_ec(x^2))/((x^2 - 1)*x)"),
            ("exp_integral_e1(2*x)", "-e^(-2*x)/x"),
            ("lambert_w(-1, x)", "lambert_w(-1, x)/(x*lambert_w(-1, x) + x)"),
            ("psi(x^2)", "2*x*psi(1, x^2)"),
            ("log_gamma(x^2)", "2*x*psi(x^2)"),
            ("gamma(x^2)", "2*x*gamma(x^2)*psi(x^2)"),
            ("elliptic_ec(x)", "1/2*(elliptic_ec(x) - elliptic_kc(x))/x"),
            ("elliptic_kc(x)", "-1/2*((x - 1)*elliptic_kc(x) + elliptic_ec(x))/((x - 1)*x)"),
            ("erfc(x)", "-2*e^(-x^2)/sqrt(pi)"),
            ("erfi(x)", "2*e^(x^2)/sqrt(pi)"),
            ("dilog(x)", "-log(-x + 1)/x"),
            ("erfinv(x)", "1/2*sqrt(pi)*e^(erfinv(x)^2)"),
        ] {
            assert_eq!(d(a), b, "{}", a);
        }
    }

    #[test]
    fn calculus() {
        let lim = |e: &str| to_string(&crate::limit::limit(&parse(e), "x", &crate::expr::infinity(), crate::limit::Dir::Both));
        assert_eq!(lim("erfc(x)"), "0");
        assert_eq!(lim("log_gamma(x)"), "+Infinity");
        assert_eq!(lim("zeta(x)"), "1");
        let int = |e: &str| to_string(&crate::integrate::integrate(&parse(e), "x").unwrap());
        assert_eq!(int("psi(x)"), "log_gamma(x)");
        assert_eq!(int("erfc(x)"), "x*erfc(x) - e^(-x^2)/sqrt(pi)");
    }

    #[test]
    fn latex_names() {
        assert_eq!(to_latex(&parse("psi(1, x)")), "\\psi\\left(1, x\\right)");
        assert_eq!(to_latex(&parse("lambert_w(x)")), "\\operatorname{W}({x})");
        assert_eq!(to_latex(&parse("polylog(3, x)")), "{\\rm Li}_{3}(x)");
    }
}
