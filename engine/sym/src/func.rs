//! Elementary and special functions: names, evaluation at floats (complex
//! where needed), and exact special values (trigonometric functions at
//! rational multiples of pi with denominators 1, 2, 3, 4, 5, 6, 8, 10, 12,
//! their inverses at those values, log(1), log(e^r), factorials, ...).

use crate::err::value_error;
use crate::expr::*;
use crate::num::{Num, Q};
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

impl Fun {
    /// Sage's name (as printed).
    pub fn name(&self) -> String {
        match self {
            Fun::Sin => "sin",
            Fun::Cos => "cos",
            Fun::Tan => "tan",
            Fun::Cot => "cot",
            Fun::Sec => "sec",
            Fun::Csc => "csc",
            Fun::Asin => "arcsin",
            Fun::Acos => "arccos",
            Fun::Atan => "arctan",
            Fun::Acot => "arccot",
            Fun::Asec => "arcsec",
            Fun::Acsc => "arccsc",
            Fun::Atan2 => "arctan2",
            Fun::Sinh => "sinh",
            Fun::Cosh => "cosh",
            Fun::Tanh => "tanh",
            Fun::Coth => "coth",
            Fun::Sech => "sech",
            Fun::Csch => "csch",
            Fun::Asinh => "arcsinh",
            Fun::Acosh => "arccosh",
            Fun::Atanh => "arctanh",
            Fun::Acoth => "arccoth",
            Fun::Asech => "arcsech",
            Fun::Acsch => "arccsch",
            Fun::Log => "log",
            Fun::Abs => "abs",
            Fun::Sign => "sgn",
            Fun::Floor => "floor",
            Fun::Ceil => "ceil",
            Fun::Gamma => "gamma",
            Fun::Factorial => "factorial",
            Fun::Binomial => "binomial",
            Fun::Erf => "erf",
            Fun::Conjugate => "conjugate",
            Fun::RealPart => "real_part",
            Fun::ImagPart => "imag_part",
            Fun::Heaviside => "heaviside",
            Fun::User(n) => return n.to_string(),
            Fun::Deriv(n, _) => return n.to_string(),
            Fun::Integral => "integrate",
            Fun::Limit => "limit",
        }
        .to_string()
    }

    /// The function with this name (Sage's names and common aliases).
    pub fn from_name(s: &str) -> Option<Fun> {
        Some(match s {
            "sin" => Fun::Sin,
            "cos" => Fun::Cos,
            "tan" => Fun::Tan,
            "cot" => Fun::Cot,
            "sec" => Fun::Sec,
            "csc" => Fun::Csc,
            "asin" | "arcsin" => Fun::Asin,
            "acos" | "arccos" => Fun::Acos,
            "atan" | "arctan" => Fun::Atan,
            "acot" | "arccot" => Fun::Acot,
            "asec" | "arcsec" => Fun::Asec,
            "acsc" | "arccsc" => Fun::Acsc,
            "atan2" | "arctan2" => Fun::Atan2,
            "sinh" => Fun::Sinh,
            "cosh" => Fun::Cosh,
            "tanh" => Fun::Tanh,
            "coth" => Fun::Coth,
            "sech" => Fun::Sech,
            "csch" => Fun::Csch,
            "asinh" | "arcsinh" => Fun::Asinh,
            "acosh" | "arccosh" => Fun::Acosh,
            "atanh" | "arctanh" => Fun::Atanh,
            "acoth" | "arccoth" => Fun::Acoth,
            "asech" | "arcsech" => Fun::Asech,
            "acsch" | "arccsch" => Fun::Acsch,
            "log" | "ln" => Fun::Log,
            "abs" => Fun::Abs,
            "sgn" | "sign" => Fun::Sign,
            "floor" => Fun::Floor,
            "ceil" => Fun::Ceil,
            "gamma" => Fun::Gamma,
            "factorial" => Fun::Factorial,
            "binomial" => Fun::Binomial,
            "erf" => Fun::Erf,
            "conjugate" => Fun::Conjugate,
            "real_part" | "real" => Fun::RealPart,
            "imag_part" | "imag" => Fun::ImagPart,
            "heaviside" | "unit_step" => Fun::Heaviside,
            _ => return None,
        })
    }

    pub fn arity(&self) -> Option<usize> {
        match self {
            Fun::Atan2 | Fun::Binomial => Some(2),
            Fun::User(_) | Fun::Deriv(..) | Fun::Integral | Fun::Limit => None,
            _ => Some(1),
        }
    }
}

// ------------------------------------------------------------------ evaluation

pub fn eval(f: Fun, args: Vec<Expr>) -> Expr {
    if let Some(n) = f.arity() {
        if args.len() != n {
            value_error(format!("{}() takes exactly {} argument{} ({} given)", f.name(), n, if n == 1 { "" } else { "s" }, args.len()));
        }
    }
    // floats in, a float out
    let numeric = args.iter().all(|a| a.is_num());
    if numeric && args.iter().any(|a| a.is_float()) {
        let v: Vec<(f64, f64)> = args.iter().map(|a| a.as_num().unwrap().to_c64()).collect();
        if let Some((re, im)) = float_eval(&f, &v) {
            return num(if im == 0.0 { Num::float(re) } else { Num::Float(re, im) });
        }
    }
    if let Some(v) = exact(&f, &args) {
        return v;
    }
    // a negative rational argument: odd functions change sign, even ones
    // do not (as Sage: sin(-6) = -sin(6), cos(-6) = cos(6))
    if args.len() == 1 {
        if let Some(r) = args[0].as_rat() {
            if r.is_negative() {
                let pos = qnum(-r.clone());
                match f {
                    Fun::Sin | Fun::Tan | Fun::Csc | Fun::Cot | Fun::Asin | Fun::Atan | Fun::Acsc | Fun::Acot | Fun::Sinh | Fun::Tanh
                    | Fun::Csch | Fun::Coth | Fun::Asinh | Fun::Atanh | Fun::Acsch | Fun::Acoth | Fun::Erf => return neg(&eval(f, vec![pos])),
                    Fun::Cos | Fun::Sec | Fun::Cosh | Fun::Sech => return eval(f, vec![pos]),
                    _ => {}
                }
            }
        }
    }
    raw(Kind::Fun(f, args))
}

/// e as k*pi for a rational k, if it is one.
pub fn pi_multiple(e: &Expr) -> Option<Q> {
    if e.is_zero() {
        return Some(Q::zero());
    }
    if e.is_const(Const::Pi) {
        return Some(Q::one());
    }
    if let Kind::Mul(v) = &e.kind {
        if v.len() == 2 && v[1].is_const(Const::Pi) {
            return v[0].as_rat().cloned();
        }
    }
    None
}

fn qq(n: i64, d: i64) -> Q {
    crate::num::qr(n, d)
}

/// sin(t*pi) for 0 <= t <= 1/2 in the table.
fn sin_first_quadrant(t: &Q) -> Option<Expr> {
    let s2 = sqrt(&int(2));
    let s3 = sqrt(&int(3));
    let s5 = sqrt(&int(5));
    let s6 = sqrt(&int(6));
    let quarter = rat(1, 4);
    let halfe = half();
    let table: Vec<(Q, Box<dyn Fn() -> Expr>)> = vec![
        (qq(0, 1), Box::new(zero)),
        (qq(1, 12), Box::new({ let (s2, s6, q) = (s2.clone(), s6.clone(), quarter.clone()); move || mul2(&q, &sub(&s6, &s2)) })),
        (qq(1, 10), Box::new({ let (s5, q) = (s5.clone(), quarter.clone()); move || mul2(&q, &sub(&s5, &one())) })),
        (qq(1, 8), Box::new({ let (s2, h) = (s2.clone(), halfe.clone()); move || mul2(&h, &sqrt(&sub(&int(2), &s2))) })),
        (qq(1, 6), Box::new(half)),
        (qq(1, 5), Box::new({ let (s5, q) = (s5.clone(), quarter.clone()); move || mul2(&q, &sqrt(&sub(&int(10), &mul2(&int(2), &s5)))) })),
        (qq(1, 4), Box::new({ let (s2, h) = (s2.clone(), halfe.clone()); move || mul2(&h, &s2) })),
        (qq(3, 10), Box::new({ let (s5, q) = (s5.clone(), quarter.clone()); move || mul2(&q, &add2(&s5, &one())) })),
        (qq(1, 3), Box::new({ let (s3, h) = (s3.clone(), halfe.clone()); move || mul2(&h, &s3) })),
        (qq(3, 8), Box::new({ let (s2, h) = (s2.clone(), halfe.clone()); move || mul2(&h, &sqrt(&add2(&int(2), &s2))) })),
        (qq(2, 5), Box::new({ let (s5, q) = (s5.clone(), quarter.clone()); move || mul2(&q, &sqrt(&add2(&int(10), &mul2(&int(2), &s5)))) })),
        (qq(5, 12), Box::new({ let (s2, s6, q) = (s2.clone(), s6.clone(), quarter.clone()); move || mul2(&q, &add2(&s6, &s2)) })),
        (qq(1, 2), Box::new(one)),
    ];
    table.into_iter().find(|(k, _)| k == t).map(|(_, f)| f())
}

/// sin(k*pi) exactly, if k reduces to a table entry.
fn sin_pi(k: &Q) -> Option<Expr> {
    let two = Q::from_integer(BigInt::from(2));
    let mut t = k - (k / &two).floor() * &two; // [0, 2)
    let mut sign = false;
    if t > Q::one() {
        t -= Q::one();
        sign = true;
    }
    if t > qq(1, 2) {
        t = Q::one() - t;
    }
    let v = sin_first_quadrant(&t)?;
    Some(if sign { neg(&v) } else { v })
}

fn cos_pi(k: &Q) -> Option<Expr> {
    sin_pi(&(qq(1, 2) - k))
}

/// The inverse of sin on the table: t with sin(t pi) = v, -1/2 <= t <= 1/2.
fn asin_table(v: &Expr) -> Option<Q> {
    for (n, d) in [(0, 1), (1, 12), (1, 10), (1, 8), (1, 6), (1, 5), (1, 4), (3, 10), (1, 3), (3, 8), (2, 5), (5, 12), (1, 2)] {
        let t = qq(n, d);
        let s = sin_first_quadrant(&t).unwrap();
        if &s == v {
            return Some(t);
        }
        if &neg(&s) == v {
            return Some(-t);
        }
    }
    None
}

fn atan_table(v: &Expr) -> Option<Q> {
    let s3 = sqrt(&int(3));
    let cands: Vec<(Expr, Q)> = vec![
        (zero(), qq(0, 1)),
        (one(), qq(1, 4)),
        (s3.clone(), qq(1, 3)),
        (mul2(&rat(1, 3), &s3), qq(1, 6)),
        (sub(&int(2), &s3), qq(1, 12)),
        (add2(&int(2), &s3), qq(5, 12)),
        (sub(&sqrt(&int(2)), &one()), qq(1, 8)),
        (add2(&sqrt(&int(2)), &one()), qq(3, 8)),
    ];
    for (e, t) in cands {
        if &e == v {
            return Some(t);
        }
        if &neg(&e) == v {
            return Some(-t);
        }
    }
    None
}

fn pi_times(t: Q) -> Expr {
    mul2(&qnum(t), &pi())
}

fn exact(f: &Fun, a: &[Expr]) -> Option<Expr> {
    let x = a.first()?;
    match f {
        Fun::Sin => sin_pi(&pi_multiple(x)?),
        Fun::Cos => cos_pi(&pi_multiple(x)?),
        Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc => {
            let k = pi_multiple(x)?;
            let (s, c) = (sin_pi(&k)?, cos_pi(&k)?);
            let (n, d) = match f {
                Fun::Tan => (s, c),
                Fun::Cot => (c, s),
                Fun::Sec => (one(), c),
                _ => (one(), s),
            };
            if d.is_zero() {
                return Some(constant(Const::UnsignedInfinity));
            }
            Some(div(&n, &d))
        }
        Fun::Asin => Some(pi_times(asin_table(x)?)),
        Fun::Acos => Some(pi_times(qq(1, 2) - asin_table(x)?)),
        Fun::Atan => {
            if x.is_const(Const::Infinity) {
                return Some(pi_times(qq(1, 2)));
            }
            if x.is_const(Const::MinusInfinity) {
                return Some(pi_times(qq(-1, 2)));
            }
            Some(pi_times(atan_table(x)?))
        }
        Fun::Acot if x.is_zero() => Some(pi_times(qq(1, 2))),
        Fun::Acot => {
            // arccot(x) = arctan(1/x): pi/2 - arctan(x) for x > 0, -pi/2 - arctan(x) for x < 0
            let t = atan_table(x)?;
            Some(pi_times(if t > qq(0, 1) { qq(1, 2) - t } else { qq(-1, 2) - t }))
        }
        Fun::Sinh | Fun::Tanh | Fun::Asinh | Fun::Atanh | Fun::Erf if x.is_zero() => Some(zero()),
        Fun::Cosh | Fun::Sech if x.is_zero() => Some(one()),
        Fun::Acosh if x.is_one() => Some(zero()),
        Fun::Log => {
            if x.is_one() {
                return Some(zero());
            }
            if x.is_zero() {
                return Some(constant(Const::MinusInfinity));
            }
            if x.is_const(Const::E) {
                return Some(one());
            }
            if x.is_const(Const::Infinity) {
                return Some(infinity());
            }
            if x.is_minus_one() {
                return Some(mul2(&i(), &pi()));
            }
            if let Kind::Pow(b, e) = &x.kind {
                if b.is_const(Const::E) && e.is_num() && e.as_num().unwrap().is_real() {
                    return Some(e.clone());
                }
            }
            None
        }
        Fun::Abs => {
            if let Some(n) = x.as_num() {
                return Some(match n {
                    Num::Exact(a, b) if b.is_zero() => qnum(a.abs()),
                    Num::Exact(a, b) => sqrt(&qnum(a * a + b * b)),
                    Num::Float(a, b) => float((a * a + b * b).sqrt()),
                });
            }
            if let Kind::Fun(Fun::Abs, _) = &x.kind {
                return Some(x.clone());
            }
            if x.is_const(Const::Pi) || x.is_const(Const::E) {
                return Some(x.clone());
            }
            // abs(c*y) = |c| abs(y) for real numbers c
            if let Kind::Mul(v) = &x.kind {
                if let Some(c) = v[0].as_num() {
                    if c.is_real() && !c.is_one() {
                        let rest = mul(v[1..].to_vec());
                        let ac = if c.is_negative() { num(c.neg()) } else { v[0].clone() };
                        return Some(mul2(&ac, &fun1(Fun::Abs, &rest)));
                    }
                }
            }
            None
        }
        Fun::Sign => {
            let n = x.as_num()?;
            Some(int(if n.is_zero() { 0 } else if n.is_negative() { -1 } else { 1 }))
        }
        Fun::Floor | Fun::Ceil => {
            if let Some(r) = x.as_rat() {
                return Some(big(if *f == Fun::Floor { r.floor().to_integer() } else { r.ceil().to_integer() }));
            }
            // a real constant (pi, sqrt(2)): numerically, with a safety margin
            if crate::expr::free_symbols(x).is_empty() {
                let v = crate::eval::to_f64(x)?;
                let r = if *f == Fun::Floor { v.floor() } else { v.ceil() };
                if (v - v.round()).abs() > 1e-9 {
                    return Some(big(BigInt::from(r as i64)));
                }
            }
            None
        }
        Fun::Factorial => {
            let n = x.as_int()?;
            if n.is_negative() {
                return None;
            }
            let mut r = BigInt::one();
            let mut k = BigInt::from(2);
            while k <= n {
                r *= &k;
                k += 1;
            }
            Some(big(r))
        }
        Fun::Gamma => {
            let r = x.as_rat()?;
            if r.is_integer() {
                if !r.is_positive() {
                    return Some(constant(Const::UnsignedInfinity));
                }
                return exact(&Fun::Factorial, &[big(r.to_integer() - 1)]);
            }
            if *r.denom() == BigInt::from(2) {
                // gamma(n + 1/2) = (2n)! / (4^n n!) sqrt(pi)
                let n = (r - qq(1, 2)).to_integer().to_i64()?;
                if !(-30..=60).contains(&n) {
                    return None;
                }
                let mut c = Q::one();
                if n >= 0 {
                    for k in 0..n {
                        c *= Q::new(BigInt::from(2 * k + 1), BigInt::from(2));
                    }
                } else {
                    for k in n..0 {
                        c /= Q::new(BigInt::from(2 * k + 1), BigInt::from(2));
                    }
                }
                return Some(mul2(&qnum(c), &sqrt(&pi())));
            }
            None
        }
        Fun::Binomial => {
            let (n, k) = (a[0].as_int()?, a[1].as_int()?);
            if k.is_negative() || n.is_negative() || k > n {
                return if !n.is_negative() { Some(zero()) } else { None };
            }
            let mut r = BigInt::one();
            let mut i = BigInt::zero();
            while i < k {
                r = r * (&n - &i) / (&i + 1);
                i += 1;
            }
            Some(big(r))
        }
        Fun::Conjugate => {
            let n = x.as_num()?;
            Some(num(match n {
                Num::Exact(a, b) => Num::Exact(a.clone(), -b.clone()),
                Num::Float(a, b) => Num::Float(*a, -b),
            }))
        }
        Fun::RealPart => {
            let n = x.as_num()?;
            Some(num(match n {
                Num::Exact(a, _) => Num::rat(a.clone()),
                Num::Float(a, _) => Num::float(*a),
            }))
        }
        Fun::ImagPart => {
            let n = x.as_num()?;
            Some(num(match n {
                Num::Exact(_, b) => Num::rat(b.clone()),
                Num::Float(_, b) => Num::float(*b),
            }))
        }
        Fun::Heaviside => {
            let n = x.as_num()?;
            if !n.is_real() || n.is_zero() {
                return None;
            }
            Some(int(if n.is_negative() { 0 } else { 1 }))
        }
        Fun::Atan2 => {
            let (y, xx) = (&a[0], &a[1]);
            if y.is_zero() && xx.as_num().map_or(false, |n| n.is_positive()) {
                return Some(zero());
            }
            // on an axis, with a real constant (sqrt(2), pi) as the other argument
            let konst = |e: &Expr| free_symbols(e).is_empty() && !e.is_num();
            if xx.is_zero() && konst(y) {
                if let Some(v) = crate::eval::to_f64(y).filter(|v| *v != 0.0) {
                    return Some(pi_times(if v < 0.0 { qq(-1, 2) } else { qq(1, 2) }));
                }
            }
            if y.is_zero() && konst(xx) {
                if let Some(v) = crate::eval::to_f64(xx).filter(|v| *v != 0.0) {
                    return Some(if v > 0.0 { zero() } else { pi_times(qq(1, 1)) });
                }
            }
            // exact real numbers at the table's angles: arctan(y/x), moved to the quadrant
            let (ny, nx) = (y.as_num()?, xx.as_num()?);
            if !ny.is_real() || !nx.is_real() {
                return None;
            }
            if nx.is_zero() {
                return if ny.is_zero() { None } else { Some(pi_times(if ny.is_negative() { qq(-1, 2) } else { qq(1, 2) })) };
            }
            let t = atan_table(&div(y, xx))?;
            Some(pi_times(if nx.is_positive() { t } else if ny.is_negative() { t - qq(1, 1) } else { t + qq(1, 1) }))
        }
        _ => None,
    }
}

// ------------------------------------------------------------------ complex floats

type C = (f64, f64);

fn cmul(a: C, b: C) -> C {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}
fn cdiv(a: C, b: C) -> C {
    let d = b.0 * b.0 + b.1 * b.1;
    ((a.0 * b.0 + a.1 * b.1) / d, (a.1 * b.0 - a.0 * b.1) / d)
}
fn clog(a: C) -> C {
    ((a.0 * a.0 + a.1 * a.1).sqrt().ln(), a.1.atan2(a.0))
}
fn csqrt(a: C) -> C {
    let r = (a.0 * a.0 + a.1 * a.1).sqrt();
    let re = ((r + a.0) / 2.0).sqrt();
    let im = ((r - a.0) / 2.0).sqrt();
    (re, if a.1 < 0.0 { -im } else { im })
}
fn csin(a: C) -> C {
    (a.0.sin() * a.1.cosh(), a.0.cos() * a.1.sinh())
}
fn ccos(a: C) -> C {
    (a.0.cos() * a.1.cosh(), -a.0.sin() * a.1.sinh())
}
fn csinh(a: C) -> C {
    (a.0.sinh() * a.1.cos(), a.0.cosh() * a.1.sin())
}
fn ccosh(a: C) -> C {
    (a.0.cosh() * a.1.cos(), a.0.sinh() * a.1.sin())
}
const I: C = (0.0, 1.0);
const ONE: C = (1.0, 0.0);
fn cadd(a: C, b: C) -> C {
    (a.0 + b.0, a.1 + b.1)
}
fn csub(a: C, b: C) -> C {
    (a.0 - b.0, a.1 - b.1)
}
// asin z = -i log(i z + sqrt(1 - z^2))
fn casin(z: C) -> C {
    let w = clog(cadd(cmul(I, z), csqrt(csub(ONE, cmul(z, z)))));
    cmul((0.0, -1.0), w)
}
fn cacos(z: C) -> C {
    csub((std::f64::consts::FRAC_PI_2, 0.0), casin(z))
}
// atan z = i/2 (log(1 - i z) - log(1 + i z))
fn catan(z: C) -> C {
    let iz = cmul(I, z);
    cmul((0.0, 0.5), csub(clog(csub(ONE, iz)), clog(cadd(ONE, iz))))
}

/// f at complex floats (real arguments in the real domain stay real).
pub fn float_eval(f: &Fun, v: &[C]) -> Option<C> {
    let z = v[0];
    let real = z.1 == 0.0;
    let x = z.0;
    let r = |y: f64| Some((y, 0.0));
    match f {
        Fun::Sin => if real { r(x.sin()) } else { Some(csin(z)) },
        Fun::Cos => if real { r(x.cos()) } else { Some(ccos(z)) },
        Fun::Tan => if real { r(x.tan()) } else { Some(cdiv(csin(z), ccos(z))) },
        Fun::Cot => if real { r(1.0 / x.tan()) } else { Some(cdiv(ccos(z), csin(z))) },
        Fun::Sec => if real { r(1.0 / x.cos()) } else { Some(cdiv(ONE, ccos(z))) },
        Fun::Csc => if real { r(1.0 / x.sin()) } else { Some(cdiv(ONE, csin(z))) },
        Fun::Asin => if real && x.abs() <= 1.0 { r(x.asin()) } else { Some(casin(z)) },
        Fun::Acos => if real && x.abs() <= 1.0 { r(x.acos()) } else { Some(cacos(z)) },
        Fun::Atan => if real { r(x.atan()) } else { Some(catan(z)) },
        Fun::Acot => if real { r((1.0 / x).atan()) } else { Some(catan(cdiv(ONE, z))) },
        Fun::Asec => if real && x.abs() >= 1.0 { r((1.0 / x).acos()) } else { Some(cacos(cdiv(ONE, z))) },
        Fun::Acsc => if real && x.abs() >= 1.0 { r((1.0 / x).asin()) } else { Some(casin(cdiv(ONE, z))) },
        Fun::Atan2 => {
            if real && v[1].1 == 0.0 {
                r(x.atan2(v[1].0))
            } else {
                None
            }
        }
        Fun::Sinh => if real { r(x.sinh()) } else { Some(csinh(z)) },
        Fun::Cosh => if real { r(x.cosh()) } else { Some(ccosh(z)) },
        Fun::Tanh => if real { r(x.tanh()) } else { Some(cdiv(csinh(z), ccosh(z))) },
        Fun::Coth => if real { r(1.0 / x.tanh()) } else { Some(cdiv(ccosh(z), csinh(z))) },
        Fun::Sech => if real { r(1.0 / x.cosh()) } else { Some(cdiv(ONE, ccosh(z))) },
        Fun::Csch => if real { r(1.0 / x.sinh()) } else { Some(cdiv(ONE, csinh(z))) },
        Fun::Asinh => if real { r(x.asinh()) } else { Some(clog(cadd(z, csqrt(cadd(cmul(z, z), ONE))))) },
        Fun::Acosh => if real && x >= 1.0 { r(x.acosh()) } else { Some(clog(cadd(z, cmul(csqrt(cadd(z, ONE)), csqrt(csub(z, ONE)))))) },
        Fun::Atanh => if real && x.abs() < 1.0 { r(x.atanh()) } else { Some(cmul((0.5, 0.0), csub(clog(cadd(ONE, z)), clog(csub(ONE, z))))) },
        Fun::Acoth => if real && x.abs() > 1.0 { r((1.0 / x).atanh()) } else { None },
        Fun::Asech => if real && x > 0.0 && x <= 1.0 { r((1.0 / x).acosh()) } else { None },
        Fun::Acsch => if real { r((1.0 / x).asinh()) } else { None },
        Fun::Log => if real && x > 0.0 { r(x.ln()) } else { Some(clog(z)) },
        Fun::Abs => r((z.0 * z.0 + z.1 * z.1).sqrt()),
        Fun::Sign => if real { r(if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { 0.0 }) } else { None },
        Fun::Floor => if real { r(x.floor()) } else { None },
        Fun::Ceil => if real { r(x.ceil()) } else { None },
        Fun::Gamma => if real { r(gamma(x)) } else { None },
        Fun::Factorial => if real { r(gamma(x + 1.0)) } else { None },
        Fun::Erf => if real { r(erf(x)) } else { None },
        Fun::Conjugate => Some((z.0, -z.1)),
        Fun::RealPart => r(z.0),
        Fun::ImagPart => r(z.1),
        Fun::Heaviside => if real && x != 0.0 { r(if x > 0.0 { 1.0 } else { 0.0 }) } else { None },
        Fun::Binomial => {
            if real && v[1].1 == 0.0 {
                let (n, k) = (x, v[1].0);
                r(gamma(n + 1.0) / (gamma(k + 1.0) * gamma(n - k + 1.0)))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// The gamma function (Lanczos, g = 7, n = 9: about 15 digits).
pub fn gamma(z: f64) -> f64 {
    if z < 0.5 {
        return std::f64::consts::PI / ((std::f64::consts::PI * z).sin() * gamma(1.0 - z));
    }
    let z = z - 1.0;
    let c = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    let mut a = c[0];
    for (i, ci) in c.iter().enumerate().skip(1) {
        a += ci / (z + i as f64);
    }
    let t = z + 7.5;
    (2.0 * std::f64::consts::PI).sqrt() * t.powf(z + 0.5) * (-t).exp() * a
}

/// erf (Abramowitz-Stegun 7.1.26 is too coarse; use the series / continued
/// fraction pair for about 15 digits).
pub fn erf(x: f64) -> f64 {
    if x < 0.0 {
        return -erf(-x);
    }
    if x < 2.5 {
        // Taylor series
        let mut sum = x;
        let mut term = x;
        let x2 = x * x;
        let mut n = 0.0;
        loop {
            n += 1.0;
            term *= -x2 / n;
            let t = term / (2.0 * n + 1.0);
            sum += t;
            if t.abs() < 1e-17 * sum.abs() {
                break;
            }
        }
        sum * 2.0 / std::f64::consts::PI.sqrt()
    } else {
        // continued fraction for erfc
        let mut f = 0.0;
        for k in (1..60).rev() {
            f = (k as f64 / 2.0) / (x + f);
        }
        1.0 - (-x * x).exp() / std::f64::consts::PI.sqrt() / (x + f)
    }
}
