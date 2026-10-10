//! Symbolic expressions: immutable, shared trees in a canonical form that
//! the constructors maintain (automatic simplification, as in J. S. Cohen,
//! Computer Algebra and Symbolic Computation: Mathematical Methods, ch. 3,
//! tuned to what Sage's symbolic ring does):
//!
//! - sums flatten, numbers add up, like terms combine (2*x + 3*x = 5*x);
//! - products flatten, numbers multiply, powers of the same base combine
//!   (x*x^2 = x^3, e^x*e^y = e^(x + y), sqrt(2)*sqrt(2) = 2, but 2^x*2^y
//!   stays as Sage leaves it); a number times a single sum distributes
//!   (2*(x + 1) = 2*x + 2);
//! - powers: x^0 = 1, x^1 = x, (x^a)^n = x^(a n) and (x y)^n = x^n y^n for
//!   integers n, exact powers of numbers, roots of rationals with perfect
//!   powers extracted (sqrt(12) = 2*sqrt(3)), sqrt(-4) = 2*I, e^log(x) = x;
//! - functions evaluate at floats and at special exact values (func.rs).

use crate::err::{throw, value_error, SymError};
use crate::num::{Num, Q};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

pub type Expr = Arc<Node>;

#[derive(Debug)]
pub struct Node {
    pub kind: Kind,
    hash: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Const {
    Pi,
    E,
    EulerGamma,
    /// +Infinity
    Infinity,
    /// -Infinity
    MinusInfinity,
    /// Infinity (unsigned, e.g. 1/0 in a limit)
    UnsignedInfinity,
    /// an undefined value (oo - oo)
    Undefined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Rel {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Fun {
    Sin,
    Cos,
    Tan,
    Cot,
    Sec,
    Csc,
    Asin,
    Acos,
    Atan,
    Acot,
    Asec,
    Acsc,
    Atan2,
    Sinh,
    Cosh,
    Tanh,
    Coth,
    Sech,
    Csch,
    Asinh,
    Acosh,
    Atanh,
    Acoth,
    Asech,
    Acsch,
    Log,
    Abs,
    Sign,
    Floor,
    Ceil,
    Gamma,
    Factorial,
    Binomial,
    Erf,
    Conjugate,
    RealPart,
    ImagPart,
    Heaviside,
    /// a symbolic function f(x, ...)
    User(Arc<str>),
    /// the derivative D[i, j, ...](f) of a symbolic function, applied
    Deriv(Arc<str>, Vec<u32>),
    /// an unevaluated integral: integrate(f, x) or integrate(f, x, a, b)
    Integral,
    /// an unevaluated limit(f, x, a)
    Limit,
}

#[derive(Debug, Clone)]
pub enum Kind {
    Num(Num),
    Sym(Arc<str>),
    Const(Const),
    Add(Vec<Expr>),
    Mul(Vec<Expr>),
    Pow(Expr, Expr),
    Fun(Fun, Vec<Expr>),
    Rel(Rel, Expr, Expr),
}

impl PartialEq for Node {
    fn eq(&self, o: &Node) -> bool {
        if self.hash != o.hash {
            return false;
        }
        match (&self.kind, &o.kind) {
            (Kind::Num(a), Kind::Num(b)) => a == b,
            (Kind::Sym(a), Kind::Sym(b)) => a == b,
            (Kind::Const(a), Kind::Const(b)) => a == b,
            (Kind::Add(a), Kind::Add(b)) | (Kind::Mul(a), Kind::Mul(b)) => a == b,
            (Kind::Pow(a, b), Kind::Pow(c, d)) => a == c && b == d,
            (Kind::Fun(f, a), Kind::Fun(g, b)) => f == g && a == b,
            (Kind::Rel(r, a, b), Kind::Rel(s, c, d)) => r == s && a == c && b == d,
            _ => false,
        }
    }
}
impl Eq for Node {}
impl Hash for Node {
    fn hash<H: Hasher>(&self, h: &mut H) {
        self.hash.hash(h);
    }
}

fn hash_kind(k: &Kind) -> u64 {
    let mut h = DefaultHasher::new();
    match k {
        Kind::Num(n) => (0u8, n).hash(&mut h),
        Kind::Sym(s) => (1u8, s).hash(&mut h),
        Kind::Const(c) => (2u8, c).hash(&mut h),
        Kind::Add(v) => {
            3u8.hash(&mut h);
            for e in v {
                e.hash.hash(&mut h);
            }
        }
        Kind::Mul(v) => {
            4u8.hash(&mut h);
            for e in v {
                e.hash.hash(&mut h);
            }
        }
        Kind::Pow(a, b) => (5u8, a.hash, b.hash).hash(&mut h),
        Kind::Fun(f, v) => {
            (6u8, f).hash(&mut h);
            for e in v {
                e.hash.hash(&mut h);
            }
        }
        Kind::Rel(r, a, b) => (7u8, r, a.hash, b.hash).hash(&mut h),
    }
    h.finish()
}

/// A node exactly as given (no simplification).
pub fn raw(kind: Kind) -> Expr {
    let hash = hash_kind(&kind);
    Arc::new(Node { kind, hash })
}

// ------------------------------------------------------------------ atoms

pub fn num(n: Num) -> Expr {
    raw(Kind::Num(n))
}
pub fn int(n: i64) -> Expr {
    num(Num::int(n))
}
pub fn rat(n: i64, d: i64) -> Expr {
    num(Num::rat(crate::num::qr(n, d)))
}
pub fn big(n: BigInt) -> Expr {
    num(Num::big(n))
}
pub fn qnum(x: Q) -> Expr {
    num(Num::rat(x))
}
pub fn float(x: f64) -> Expr {
    num(Num::float(x))
}
pub fn sym(name: &str) -> Expr {
    raw(Kind::Sym(name.into()))
}
pub fn constant(c: Const) -> Expr {
    raw(Kind::Const(c))
}
pub fn pi() -> Expr {
    constant(Const::Pi)
}
pub fn e() -> Expr {
    constant(Const::E)
}
pub fn i() -> Expr {
    num(Num::i())
}
pub fn zero() -> Expr {
    int(0)
}
pub fn one() -> Expr {
    int(1)
}
pub fn half() -> Expr {
    rat(1, 2)
}
pub fn infinity() -> Expr {
    constant(Const::Infinity)
}

// ------------------------------------------------------------------ inspection

impl Node {
    pub fn as_num(&self) -> Option<&Num> {
        match &self.kind {
            Kind::Num(n) => Some(n),
            _ => None,
        }
    }
    pub fn is_num(&self) -> bool {
        matches!(self.kind, Kind::Num(_))
    }
    pub fn is_zero(&self) -> bool {
        matches!(&self.kind, Kind::Num(n) if n.is_zero())
    }
    pub fn is_one(&self) -> bool {
        matches!(&self.kind, Kind::Num(n) if n.is_one())
    }
    pub fn is_minus_one(&self) -> bool {
        matches!(&self.kind, Kind::Num(n) if n.is_minus_one())
    }
    pub fn as_sym(&self) -> Option<&str> {
        match &self.kind {
            Kind::Sym(s) => Some(s),
            _ => None,
        }
    }
    pub fn is_const(&self, c: Const) -> bool {
        matches!(&self.kind, Kind::Const(d) if *d == c)
    }
    pub fn as_int(&self) -> Option<BigInt> {
        self.as_num().and_then(|n| n.as_int())
    }
    pub fn as_i64(&self) -> Option<i64> {
        self.as_num().and_then(|n| n.as_i64())
    }
    pub fn as_rat(&self) -> Option<&Q> {
        self.as_num().and_then(|n| n.as_rat())
    }
    pub fn is_float(&self) -> bool {
        matches!(&self.kind, Kind::Num(Num::Float(..)))
    }
    pub fn is_infinite(&self) -> bool {
        matches!(&self.kind, Kind::Const(Const::Infinity | Const::MinusInfinity | Const::UnsignedInfinity))
    }
    pub fn children(&self) -> Vec<Expr> {
        match &self.kind {
            Kind::Add(v) | Kind::Mul(v) | Kind::Fun(_, v) => v.clone(),
            Kind::Pow(a, b) | Kind::Rel(_, a, b) => vec![a.clone(), b.clone()],
            _ => vec![],
        }
    }
}

/// Rebuild e with new children, simplifying.
pub fn rebuild(e: &Expr, ch: Vec<Expr>) -> Expr {
    match &e.kind {
        Kind::Add(_) => add(ch),
        Kind::Mul(_) => mul(ch),
        Kind::Pow(..) => pow(&ch[0], &ch[1]),
        Kind::Fun(f, _) => fun(f.clone(), ch),
        Kind::Rel(r, ..) => relation(*r, &ch[0], &ch[1]),
        _ => e.clone(),
    }
}

/// Apply f to every child and rebuild.
pub fn map(e: &Expr, f: &mut dyn FnMut(&Expr) -> Expr) -> Expr {
    let ch = e.children();
    if ch.is_empty() {
        return e.clone();
    }
    let new: Vec<Expr> = ch.iter().map(|c| f(c)).collect();
    if new.iter().zip(&ch).all(|(a, b)| Arc::ptr_eq(a, b)) {
        return e.clone();
    }
    rebuild(e, new)
}

// ------------------------------------------------------------------ canonical order

fn rank(e: &Expr) -> u8 {
    match &e.kind {
        Kind::Num(_) => 0,
        Kind::Const(_) => 1,
        Kind::Sym(_) => 2,
        Kind::Pow(..) => 3,
        Kind::Mul(_) => 4,
        Kind::Add(_) => 5,
        Kind::Fun(..) => 6,
        Kind::Rel(..) => 7,
    }
}

/// A total order on expressions, for canonical sorting of operands.
pub fn canon_cmp(a: &Expr, b: &Expr) -> Ordering {
    if Arc::ptr_eq(a, b) {
        return Ordering::Equal;
    }
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (&a.kind, &b.kind) {
        (Kind::Num(x), Kind::Num(y)) => x.cmp(y).then((x.is_exact() as u8).cmp(&(y.is_exact() as u8))),
        (Kind::Const(x), Kind::Const(y)) => x.cmp(y),
        (Kind::Sym(x), Kind::Sym(y)) => x.cmp(y),
        (Kind::Pow(x, y), Kind::Pow(u, v)) => canon_cmp(x, u).then_with(|| canon_cmp(y, v)),
        (Kind::Add(x), Kind::Add(y)) | (Kind::Mul(x), Kind::Mul(y)) => cmp_vec(x, y),
        (Kind::Fun(f, x), Kind::Fun(g, y)) => f.cmp(g).then_with(|| cmp_vec(x, y)),
        (Kind::Rel(r, x, y), Kind::Rel(s, u, v)) => r.cmp(s).then_with(|| canon_cmp(x, u)).then_with(|| canon_cmp(y, v)),
        _ => Ordering::Equal,
    }
}

fn cmp_vec(x: &[Expr], y: &[Expr]) -> Ordering {
    for (a, b) in x.iter().zip(y) {
        let c = canon_cmp(a, b);
        if c != Ordering::Equal {
            return c;
        }
    }
    x.len().cmp(&y.len())
}

// ------------------------------------------------------------------ sums

/// (coefficient, rest): 3*x*y -> (3, x*y), x -> (1, x), 5 -> (5, 1).
pub fn split_coeff(e: &Expr) -> (Num, Expr) {
    match &e.kind {
        Kind::Num(n) => (n.clone(), one()),
        Kind::Mul(v) => {
            if let Kind::Num(n) = &v[0].kind {
                let rest = if v.len() == 2 { v[1].clone() } else { raw(Kind::Mul(v[1..].to_vec())) };
                (n.clone(), rest)
            } else {
                (Num::one(), e.clone())
            }
        }
        _ => (Num::one(), e.clone()),
    }
}

/// c * rest without redistributing (rest is a term from split_coeff).
fn scale_term(c: &Num, rest: &Expr) -> Expr {
    if c.is_one() {
        return rest.clone();
    }
    if rest.is_one() {
        return num(c.clone());
    }
    let mut v = vec![num(c.clone())];
    match &rest.kind {
        Kind::Mul(f) => v.extend(f.iter().cloned()),
        _ => v.push(rest.clone()),
    }
    raw(Kind::Mul(v))
}

pub fn add(terms: Vec<Expr>) -> Expr {
    let mut flat: Vec<Expr> = Vec::with_capacity(terms.len());
    for t in terms {
        match &t.kind {
            Kind::Add(v) => flat.extend(v.iter().cloned()),
            _ => flat.push(t),
        }
    }
    let mut numsum = Num::zero();
    let mut infinities: Vec<Const> = vec![];
    let mut order: Vec<Expr> = vec![];
    let mut coeffs: HashMap<Expr, Num> = HashMap::new();
    for t in flat {
        if let Kind::Num(n) = &t.kind {
            numsum = numsum.add(n);
            continue;
        }
        if let Kind::Const(c @ (Const::Infinity | Const::MinusInfinity | Const::UnsignedInfinity | Const::Undefined)) = t.kind {
            infinities.push(c);
            continue;
        }
        let (c, rest) = split_coeff(&t);
        match coeffs.get_mut(&rest) {
            Some(s) => *s = s.add(&c),
            None => {
                order.push(rest.clone());
                coeffs.insert(rest, c);
            }
        }
    }
    if !infinities.is_empty() {
        let pos = infinities.contains(&Const::Infinity);
        let neg = infinities.contains(&Const::MinusInfinity);
        if infinities.contains(&Const::Undefined) || (pos && neg) || (infinities.contains(&Const::UnsignedInfinity) && infinities.len() > 1) {
            return constant(Const::Undefined);
        }
        return constant(infinities[0]);
    }
    let mut out: Vec<Expr> = vec![];
    for r in order {
        let c = coeffs.remove(&r).unwrap();
        if c.is_zero() && c.is_exact() {
            continue;
        }
        if c.is_zero() {
            // 0.0*x: Sage keeps a float zero only as a number
            numsum = numsum.add(&Num::float(0.0));
            continue;
        }
        out.push(scale_term(&c, &r));
    }
    let keep_num = !numsum.is_zero() || (!numsum.is_exact() && out.is_empty());
    if out.is_empty() {
        return num(numsum);
    }
    if keep_num {
        out.push(num(numsum));
    }
    if out.len() == 1 {
        return out.pop().unwrap();
    }
    out.sort_by(canon_cmp);
    raw(Kind::Add(out))
}

pub fn add2(a: &Expr, b: &Expr) -> Expr {
    add(vec![a.clone(), b.clone()])
}
pub fn sub(a: &Expr, b: &Expr) -> Expr {
    add(vec![a.clone(), neg(b)])
}
pub fn neg(a: &Expr) -> Expr {
    mul(vec![int(-1), a.clone()])
}

// ------------------------------------------------------------------ products

/// (base, exponent): x^3 -> (x, 3), x -> (x, 1).
pub fn base_exp(e: &Expr) -> (Expr, Expr) {
    match &e.kind {
        Kind::Pow(b, x) => (b.clone(), x.clone()),
        _ => (e.clone(), one()),
    }
}

pub fn mul(factors: Vec<Expr>) -> Expr {
    let mut flat: Vec<Expr> = Vec::with_capacity(factors.len());
    for f in factors {
        match &f.kind {
            Kind::Mul(v) => flat.extend(v.iter().cloned()),
            _ => flat.push(f),
        }
    }
    let mut coeff = Num::one();
    let mut infinity: Option<Const> = None;
    let mut order: Vec<Expr> = vec![];
    let mut exps: HashMap<Expr, Vec<Expr>> = HashMap::new();
    let mut first: HashMap<Expr, Expr> = HashMap::new();
    let mut zero_factor = false;
    for f in flat {
        match &f.kind {
            Kind::Num(n) => {
                if n.is_zero() {
                    zero_factor = true;
                }
                coeff = coeff.mul(n);
                continue;
            }
            Kind::Const(c @ (Const::Infinity | Const::MinusInfinity | Const::UnsignedInfinity | Const::Undefined)) => {
                infinity = Some(match (infinity, *c) {
                    (Some(Const::Undefined), _) | (_, Const::Undefined) => Const::Undefined,
                    (None, c) => c,
                    (Some(Const::MinusInfinity), Const::MinusInfinity) => Const::Infinity,
                    (Some(Const::Infinity), c) => c,
                    (Some(c), Const::Infinity) => c,
                    _ => Const::UnsignedInfinity,
                });
                continue;
            }
            _ => {}
        }
        let (b, x) = base_exp(&f);
        // a numeric base with a symbolic exponent (2^x) does not combine
        let key = if b.is_num() && !x.is_num() { f.clone() } else { b.clone() };
        let x = if b.is_num() && !x.is_num() { one() } else { x };
        match exps.get_mut(&key) {
            Some(v) => v.push(x),
            None => {
                order.push(key.clone());
                first.insert(key.clone(), f.clone());
                exps.insert(key, vec![x]);
            }
        }
    }
    if let Some(c) = infinity {
        if zero_factor || c == Const::Undefined {
            return constant(Const::Undefined);
        }
        if !order.is_empty() {
            // c * x * oo: keep symbolic
            let mut v: Vec<Expr> = order.iter().map(|b| raw_pow_sum(b, &exps[b])).collect();
            v.push(constant(c));
            if !coeff.is_one() {
                v.insert(0, num(coeff));
            }
            return raw(Kind::Mul(v));
        }
        // a non-real coefficient: no sign (I*oo was +oo, so the limit of
        // sin(I x)/e^x went wrong: the fourth review's U5)
        let complex = match &coeff {
            Num::Exact(_, im) => !num_traits::Zero::is_zero(im),
            Num::Float(_, im) => *im != 0.0,
        };
        if complex && c != Const::UnsignedInfinity {
            return constant(Const::UnsignedInfinity);
        }
        return match (c, coeff.is_negative()) {
            (Const::Infinity, true) => constant(Const::MinusInfinity),
            (Const::MinusInfinity, true) => constant(Const::Infinity),
            (c, _) => constant(c),
        };
    }
    if coeff.is_zero() && coeff.is_exact() {
        return zero();
    }
    let mut out: Vec<Expr> = vec![];
    for b in order {
        let xs = exps.remove(&b).unwrap();
        let p = if xs.len() == 1 {
            // a single factor is already simplified
            first.remove(&b).unwrap()
        } else {
            pow(&b, &add(xs))
        };
        // the power may have become a number, or a product with a number
        match &p.kind {
            Kind::Num(n) => coeff = coeff.mul(n),
            Kind::Mul(v) => {
                for f in v {
                    match &f.kind {
                        Kind::Num(n) => coeff = coeff.mul(n),
                        _ => out.push(f.clone()),
                    }
                }
            }
            _ => out.push(p),
        }
    }
    if coeff.is_zero() && coeff.is_exact() {
        return zero();
    }
    // merge factors that became equal bases again (sqrt(2)*sqrt(2) from 8^(1/2)*sqrt(2))
    if out.len() > 1 {
        let mut seen: HashMap<Expr, usize> = HashMap::new();
        let mut again = false;
        for f in &out {
            let (b, x) = base_exp(f);
            if !(b.is_num() && !x.is_num()) {
                let c = seen.entry(b).or_insert(0);
                *c += 1;
                if *c > 1 {
                    again = true;
                }
            }
        }
        if again {
            let mut v = out;
            v.push(num(coeff));
            return mul(v);
        }
    }
    if out.is_empty() {
        return num(coeff);
    }
    // a number times a single sum distributes: 2*(x + 1) = 2*x + 2
    if out.len() == 1 && !coeff.is_one() {
        if let Kind::Add(terms) = &out[0].kind {
            return add(terms.iter().map(|t| mul(vec![num(coeff.clone()), t.clone()])).collect());
        }
    }
    out.sort_by(canon_cmp);
    if !coeff.is_one() {
        out.insert(0, num(coeff));
    }
    if out.len() == 1 {
        return out.pop().unwrap();
    }
    raw(Kind::Mul(out))
}

fn raw_pow_sum(b: &Expr, xs: &[Expr]) -> Expr {
    let x = if xs.len() == 1 { xs[0].clone() } else { add(xs.to_vec()) };
    if x.is_one() {
        b.clone()
    } else {
        raw(Kind::Pow(b.clone(), x))
    }
}

pub fn mul2(a: &Expr, b: &Expr) -> Expr {
    mul(vec![a.clone(), b.clone()])
}
pub fn div(a: &Expr, b: &Expr) -> Expr {
    if b.is_zero() {
        if crate::err::soft_division() {
            return constant(Const::UnsignedInfinity);
        }
        throw(SymError::DivisionByZero);
    }
    mul(vec![a.clone(), pow(b, &int(-1))])
}
pub fn recip(a: &Expr) -> Expr {
    pow(a, &int(-1))
}
pub fn sqrt(a: &Expr) -> Expr {
    pow(a, &half())
}

// ------------------------------------------------------------------ powers

pub fn pow(b: &Expr, x: &Expr) -> Expr {
    if let Kind::Num(n) = &x.kind {
        if n.is_zero() && n.is_exact() {
            return one();
        }
        if n.is_one() {
            return b.clone();
        }
    }
    if b.is_one() {
        return one();
    }
    if b.is_zero() {
        if let Some(n) = x.as_num() {
            if n.is_negative() {
                if crate::err::soft_division() {
                    return constant(Const::UnsignedInfinity);
                }
                throw(SymError::DivisionByZero);
            }
            if n.is_positive() {
                return zero();
            }
        }
    }
    match (&b.kind, &x.kind) {
        (Kind::Num(nb), Kind::Num(nx)) => return num_pow(nb, nx),
        (Kind::Const(Const::E), Kind::Fun(Fun::Log, a)) if a.len() == 1 => return a[0].clone(),
        (Kind::Const(Const::E), Kind::Mul(v)) => {
            // e^(c log u) = u^c for rational c; e^(x log 2) = 2^x (as Sage)
            let logs: Vec<usize> = (0..v.len()).filter(|&i| matches!(&v[i].kind, Kind::Fun(Fun::Log, a) if a.len() == 1)).collect();
            if logs.len() == 1 {
                let Kind::Fun(_, a) = &v[logs[0]].kind else { unreachable!() };
                let rest: Vec<Expr> = v.iter().enumerate().filter(|(i, _)| *i != logs[0]).map(|(_, t)| t.clone()).collect();
                let c = mul(rest);
                let positive_number = a[0].as_rat().map_or(false, |q| q > &Q::zero());
                if c.as_rat().is_some() || positive_number {
                    return pow(&a[0], &c);
                }
            }
        }
        (Kind::Const(Const::E), Kind::Num(n)) if !n.is_exact() => {
            let (re, im) = n.to_c64();
            let m = re.exp();
            return num(if im == 0.0 { Num::float(m) } else { Num::Float(m * im.cos(), m * im.sin()) });
        }
        (Kind::Const(Const::Infinity), Kind::Num(n)) if n.is_positive() => return infinity(),
        (Kind::Const(Const::Infinity), Kind::Num(n)) if n.is_negative() => return zero(),
        _ => {}
    }
    if let Some(n) = x.as_num() {
        let integer = n.is_integer();
        match &b.kind {
            // (y^a)^n = y^(a n) for integers n (and sqrt(x)^2 = x)
            Kind::Pow(y, a) if integer => return pow(y, &mul2(a, x)),
            // (x*y)^n = x^n*y^n for integers n
            Kind::Mul(fs) if integer => return mul(fs.iter().map(|f| pow(f, x)).collect()),
            // (c*x)^r with a positive number c: c^r*x^r (Sage: sqrt(4*x) = 2*sqrt(x))
            Kind::Mul(fs) if fs[0].as_num().map_or(false, |c| c.is_positive() && c.is_exact()) && n.as_rat().is_some() => {
                let c = pow(&fs[0], x);
                let rest = if fs.len() == 2 { fs[1].clone() } else { raw(Kind::Mul(fs[1..].to_vec())) };
                return mul2(&c, &raw(Kind::Pow(rest, x.clone())));
            }
            _ => {}
        }
    }
    raw(Kind::Pow(b.clone(), x.clone()))
}

fn num_pow(b: &Num, x: &Num) -> Expr {
    if !b.is_exact() || !x.is_exact() {
        return num(float_pow(b, x));
    }
    if let Some(n) = x.as_i64() {
        return num(b.pow_int(n));
    }
    let r = match x.as_rat() {
        Some(r) => r.clone(),
        None => return raw(Kind::Pow(num(b.clone()), num(x.clone()))), // complex exponent
    };
    let Some(br) = b.as_rat().cloned() else {
        return raw(Kind::Pow(num(b.clone()), num(x.clone())));
    };
    // b real rational, x = p/k not an integer
    if br.is_one() {
        return one();
    }
    let (p, k) = (r.numer().clone(), r.denom().clone());
    let k32 = match k.to_u32() {
        Some(k) => k,
        None => return raw(Kind::Pow(num(b.clone()), num(x.clone()))),
    };
    if br.is_negative() {
        let pos = num_pow(&Num::rat(-br), x);
        if k32 == 2 {
            // (-n)^(p/2) = I^p n^(p/2)
            let ip = Num::i().pow_int(p.mod_floor(&BigInt::from(4)).to_i64().unwrap());
            return mul2(&num(ip), &pos);
        }
        return mul2(&raw(Kind::Pow(int(-1), num(x.clone()))), &pos);
    }
    // positive rational: integer part of the exponent, then perfect powers
    let fl = r.floor().to_integer();
    let frac = &r - Q::from_integer(fl.clone());
    let int_part = Num::rat(br.clone()).pow_int(fl.to_i64().unwrap_or(0));
    let fp = frac.numer().to_u32().unwrap(); // 0 < fp < k
    let (an, bn) = power_parts(br.numer(), fp, k32);
    let (ad, bd) = power_parts(br.denom(), fp, k32);
    // n^(fp/k) = an * leftover_n; similarly for the denominator
    let mut factors = vec![num(int_part), qnum(Q::new(an, ad))];
    for (base, e) in bn {
        factors.push(raw(Kind::Pow(big(base), qnum(e))));
    }
    for (base, e) in bd {
        factors.push(raw(Kind::Pow(big(base), qnum(-e))));
    }
    // nothing extracted: the power stays as written (sqrt(1/2), 2^(5/6), 12^(1/3))
    if factors[0].is_one() && factors[1].is_one() {
        return raw(Kind::Pow(num(b.clone()), num(x.clone())));
    }
    mul(factors)
}

/// n^(f/k) = a * prod base_i^(e_i): a an integer, the leftover grouped by
/// reduced exponent (2^(5/6) stays 2^(5/6); 12^(1/2) = 2 * 3^(1/2)).
fn power_parts(n: &BigInt, f: u32, k: u32) -> (BigInt, Vec<(BigInt, Q)>) {
    if n.is_one() {
        return (BigInt::one(), vec![]);
    }
    let fac = small_factor(n);
    let mut a = BigInt::one();
    let mut groups: Vec<(Q, BigInt)> = vec![];
    for (p, e) in fac {
        let t = e as u64 * f as u64;
        let whole = t / k as u64;
        let rest = t % k as u64;
        a *= crate::num::pow_big(&p, whole as u32);
        if rest > 0 {
            let ex = Q::new(BigInt::from(rest), BigInt::from(k));
            match groups.iter_mut().find(|g| g.0 == ex) {
                Some(g) => g.1 *= &p,
                None => groups.push((ex, p)),
            }
        }
    }
    (a, groups.into_iter().map(|(e, b)| (b, e)).collect())
}

/// Factor by trial division to 10^4; the cofactor counts as one prime
/// (or a perfect power of one).
fn small_factor(n: &BigInt) -> Vec<(BigInt, u32)> {
    let mut out = vec![];
    let mut m = n.clone();
    let mut p = 2u32;
    while p < 10000 {
        let bp = BigInt::from(p);
        if &bp * &bp > m {
            break;
        }
        let mut e = 0;
        while (&m % &bp).is_zero() {
            m /= &bp;
            e += 1;
        }
        if e > 0 {
            out.push((bp, e));
        }
        p += if p == 2 { 1 } else { 2 };
    }
    if m > BigInt::one() {
        for k in (2..=8u32).rev() {
            if let Some(r) = crate::num::exact_root(&m, k) {
                out.push((r, k));
                return out;
            }
        }
        out.push((m, 1));
    }
    out
}

pub fn float_pow(b: &Num, x: &Num) -> Num {
    let (br, bi) = b.to_c64();
    let (xr, xi) = x.to_c64();
    if bi == 0.0 && xi == 0.0 && (br >= 0.0 || xr.fract() == 0.0) {
        return Num::float(br.powf(xr));
    }
    if br == 0.0 && bi == 0.0 {
        return Num::float(0.0);
    }
    // exp(x log b)
    let lr = (br * br + bi * bi).sqrt().ln();
    let li = bi.atan2(br);
    let (er, ei) = (xr * lr - xi * li, xr * li + xi * lr);
    let m = er.exp();
    Num::Float(m * ei.cos(), m * ei.sin())
}

// ------------------------------------------------------------------ functions and relations

pub fn fun(f: Fun, args: Vec<Expr>) -> Expr {
    crate::func::eval(f, args)
}

pub fn fun1(f: Fun, a: &Expr) -> Expr {
    fun(f, vec![a.clone()])
}

pub fn exp(a: &Expr) -> Expr {
    pow(&e(), a)
}
pub fn log(a: &Expr) -> Expr {
    fun1(Fun::Log, a)
}
pub fn sin(a: &Expr) -> Expr {
    fun1(Fun::Sin, a)
}
pub fn cos(a: &Expr) -> Expr {
    fun1(Fun::Cos, a)
}

pub fn relation(r: Rel, a: &Expr, b: &Expr) -> Expr {
    raw(Kind::Rel(r, a.clone(), b.clone()))
}

// ------------------------------------------------------------------ traversal helpers

/// The symbols in e, sorted by name.
pub fn free_symbols(e: &Expr) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    fn walk(e: &Expr, out: &mut std::collections::BTreeSet<String>) {
        match &e.kind {
            Kind::Sym(s) => {
                out.insert(s.to_string());
            }
            _ => {
                for c in e.children() {
                    walk(&c, out);
                }
            }
        }
    }
    walk(e, &mut out);
    out.into_iter().collect()
}

/// Does e contain x (structurally)?
pub fn has(e: &Expr, x: &Expr) -> bool {
    if e == x {
        return true;
    }
    e.children().iter().any(|c| has(c, x))
}

/// Substitute: every occurrence of a key (structurally) by its value, all
/// at once, then simplify.
pub fn subs(e: &Expr, rules: &[(Expr, Expr)]) -> Expr {
    for (k, v) in rules {
        if e == k {
            return v.clone();
        }
    }
    map(e, &mut |c| subs(c, rules))
}

/// The numerator and denominator (negative powers), as Sage's
/// numerator()/denominator() of a product.
pub fn numer_denom(e: &Expr) -> (Expr, Expr) {
    match &e.kind {
        Kind::Mul(v) => {
            let mut n = vec![];
            let mut d = vec![];
            for f in v {
                match &f.kind {
                    Kind::Num(c) => {
                        if let Some(r) = c.as_rat() {
                            n.push(big(r.numer().clone()));
                            d.push(big(r.denom().clone()));
                        } else {
                            n.push(f.clone());
                        }
                    }
                    _ => {
                        let (b, x) = base_exp(f);
                        if x.as_num().map_or(false, |c| c.is_negative()) {
                            d.push(pow(&b, &neg(&x)));
                        } else {
                            n.push(f.clone());
                        }
                    }
                }
            }
            (mul(n), mul(d))
        }
        Kind::Pow(b, x) if x.as_num().map_or(false, |c| c.is_negative()) => (one(), pow(b, &neg(x))),
        Kind::Num(c) => match c.as_rat() {
            Some(r) => (big(r.numer().clone()), big(r.denom().clone())),
            None => (e.clone(), one()),
        },
        _ => (e.clone(), one()),
    }
}

/// e as a number (exact), if it is one.
pub fn to_num(e: &Expr) -> Option<Num> {
    e.as_num().cloned()
}

/// A positive integer exponent of a power, if any.
pub fn int_exponent(x: &Expr) -> Option<i64> {
    x.as_i64()
}

pub fn value_check(cond: bool, msg: &str) {
    if !cond {
        value_error(msg.to_string());
    }
}
