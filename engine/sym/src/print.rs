//! Printing as Sage prints symbolic expressions, and Sage-style LaTeX.
//!
//! The operands of sums and products are stored in a canonical order
//! (expr.rs); here they are put in Sage's print order: sums by descending
//! degree with constants last (x^2 + 2*x + 1, x + sin(x) + 1), products
//! with sums first, then symbols, then functions ((x + 1)*x*sin(x)), and
//! negative powers as a denominator (1/2*x^2/y, 1/2/x, (x + 1)/(x - 1)).

use crate::expr::*;
use crate::num::Num;
use std::cmp::Ordering;

// ------------------------------------------------------------------ print order

/// The degree in the symbols (functions of symbols and e^f count 1, like a
/// variable; constants and numbers 0; a sum counts its largest term; b^x
/// with symbolic x counts 0).
fn degree(e: &Expr) -> f64 {
    match &e.kind {
        Kind::Sym(_) => 1.0,
        Kind::Fun(..) => has_symbol(e) as u8 as f64,
        Kind::Pow(b, x) if b.is_const(Const::E) => has_symbol(x) as u8 as f64,
        Kind::Add(v) => v.iter().map(degree).fold(f64::NEG_INFINITY, f64::max),
        Kind::Mul(v) => v.iter().map(degree).sum(),
        Kind::Pow(b, x) => match x.as_num() {
            Some(n) if n.is_real() => degree(b) * n.to_c64().0,
            _ => 0.0,
        },
        _ => 0.0,
    }
}

fn has_symbol(e: &Expr) -> bool {
    match &e.kind {
        Kind::Sym(_) => true,
        _ => e.children().iter().any(has_symbol),
    }
}

fn has_function(e: &Expr) -> bool {
    match &e.kind {
        Kind::Fun(..) => true,
        Kind::Pow(b, _) if b.is_const(Const::E) => true,
        _ => e.children().iter().any(has_function),
    }
}

/// A number raised to a symbolic power (2^x): Sage puts these first.
fn is_numeric_base_power(e: &Expr) -> bool {
    matches!(&e.kind, Kind::Pow(b, x) if b.is_num() && !x.is_num())
}

fn term_factors(e: &Expr) -> Vec<Expr> {
    let (_, rest) = split_coeff(e);
    let mut v = match &rest.kind {
        Kind::Mul(f) => f.clone(),
        _ if rest.is_one() => vec![],
        _ => vec![rest.clone()],
    };
    v.sort_by(mul_order);
    v
}

/// The order of the terms of a sum (Less: a is printed first).
pub fn sum_order(a: &Expr, b: &Expr) -> Ordering {
    let class = |e: &Expr| -> u8 {
        if e.is_num() {
            3
        } else if !has_symbol(e) && !has_function(e) && !is_numeric_base_power(&split_coeff(e).1) {
            2 // constants such as sqrt(2), pi
        } else {
            0
        }
    };
    let (ca, cb) = (class(a), class(b));
    if ca != cb {
        return ca.cmp(&cb);
    }
    let nb = |e: &Expr| term_factors(e).iter().any(is_numeric_base_power) as u8;
    let (pa, pb) = (nb(a), nb(b));
    if pa != pb {
        return pb.cmp(&pa);
    }
    let (da, db) = (degree(a), degree(b));
    if da != db {
        return db.partial_cmp(&da).unwrap_or(Ordering::Equal);
    }
    // same degree: the smaller denominator first (2*x/(x - 1) - (x^2 + 1)/(x - 1)^2)
    let (qa, qb) = (degree(&numer_denom(a).1), degree(&numer_denom(b).1));
    if qa != qb {
        return qa.partial_cmp(&qb).unwrap_or(Ordering::Equal);
    }
    // same degree: compare factor by factor
    let (fa, fb) = (term_factors(a), term_factors(b));
    for (x, y) in fa.iter().zip(&fb) {
        let c = atom_order(x, y);
        if c != Ordering::Equal {
            return c;
        }
    }
    fb.len().cmp(&fa.len()).then_with(|| canon_cmp(a, b))
}

/// Comparing two factors of terms of equal degree: symbols alphabetically,
/// higher powers first, symbols before functions, functions by name.
fn atom_order(a: &Expr, b: &Expr) -> Ordering {
    let (ba, xa) = base_exp(a);
    let (bb, xb) = base_exp(b);
    let rank = |e: &Expr| -> u8 {
        match &e.kind {
            Kind::Sym(_) => 1,
            Kind::Add(_) => 0,
            Kind::Const(_) | Kind::Num(_) => 2,
            Kind::Fun(..) => 3,
            _ => 4,
        }
    };
    let rb = |base: &Expr, e: &Expr| if base.is_const(Const::E) { 3 } else { rank(if matches!(e.kind, Kind::Pow(..)) { base } else { e }) };
    let (ra, rbb) = (rb(&ba, a), rb(&bb, b));
    if ra != rbb {
        return ra.cmp(&rbb);
    }
    match (&ba.kind, &bb.kind) {
        (Kind::Sym(s), Kind::Sym(t)) if s != t => return s.cmp(t),
        (Kind::Num(m), Kind::Num(n)) if m != n => return n.cmp(m),
        (Kind::Fun(f, x), Kind::Fun(g, y)) => {
            let c = f.name().cmp(&g.name());
            if c != Ordering::Equal {
                return c;
            }
            for (u, v) in x.iter().zip(y) {
                let c = sum_order(u, v);
                if c != Ordering::Equal {
                    return c;
                }
            }
        }
        _ => {}
    }
    // same base: the higher power first
    let (ea, eb) = (degree_of_exp(&xa), degree_of_exp(&xb));
    eb.partial_cmp(&ea).unwrap_or(Ordering::Equal)
}

fn degree_of_exp(x: &Expr) -> f64 {
    x.as_num().map(|n| n.to_c64().0).unwrap_or(0.5)
}

fn fun_name_key(e: &Expr) -> String {
    let (b, _) = base_exp(e);
    match &b.kind {
        Kind::Fun(f, _) => f.name(),
        Kind::Const(Const::E) => "exp".into(),
        _ => String::new(),
    }
}

/// The leading symbol of a sum (its first term's first symbol).
fn lead_symbol(e: &Expr) -> Option<String> {
    let syms = free_symbols(e);
    syms.into_iter().next()
}

/// The order of the factors of a product (Less: a is printed first).
pub fn mul_order(a: &Expr, b: &Expr) -> Ordering {
    let cat = |e: &Expr| -> u8 {
        let (base, x) = base_exp(e);
        if !has_symbol(e) && !has_function(e) && !is_numeric_base_power(e) {
            return 0; // pi, sqrt(2)
        }
        match &base.kind {
            Kind::Add(_) => {
                // led by a symbol: with the symbols; led by a function: after
                let lead = sorted_terms(&base).first().cloned().unwrap();
                let lead_factor = term_factors(&lead).first().cloned().unwrap_or(lead.clone());
                let (lb, _) = base_exp(&lead_factor);
                if matches!(lb.kind, Kind::Fun(..)) || lb.is_const(Const::E) {
                    4
                } else {
                    1
                }
            }
            Kind::Sym(_) => 2,
            Kind::Num(_) if !x.is_num() => 3,
            Kind::Const(Const::E) => 5,
            Kind::Fun(..) => 5,
            _ => 2,
        }
    };
    let (ca, cb) = (cat(a), cat(b));
    // a symbol-led sum goes before a symbol that is not before its leading symbol
    if (ca == 1 && cb == 2) || (ca == 2 && cb == 1) {
        let (s, t) = if ca == 1 { (a, b) } else { (b, a) };
        let ls = lead_symbol(&base_exp(s).0).unwrap_or_default();
        let ts = base_exp(t).0.as_sym().unwrap_or("").to_string();
        let sum_first = ls <= ts;
        return if (ca == 1) == sum_first { Ordering::Less } else { Ordering::Greater };
    }
    if ca != cb {
        return ca.cmp(&cb);
    }
    match ca {
        0 => {
            // constants: numeric powers by decreasing base, then pi, e
            let (ba, _) = base_exp(a);
            let (bb, _) = base_exp(b);
            match (ba.as_num(), bb.as_num()) {
                (Some(x), Some(y)) => y.cmp(x),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                _ => canon_cmp(a, b),
            }
        }
        1 | 4 => {
            // sums: by their terms, larger first
            let (ta, tb) = (sorted_terms(&base_exp(a).0), sorted_terms(&base_exp(b).0));
            for (x, y) in ta.iter().zip(&tb) {
                let (cx, rx) = split_coeff(x);
                let (cy, ry) = split_coeff(y);
                if rx != ry {
                    let c = sum_order(&rx, &ry);
                    if c != Ordering::Equal {
                        return c;
                    }
                }
                let c = cy.cmp(&cx);
                if c != Ordering::Equal {
                    return c;
                }
            }
            tb.len().cmp(&ta.len())
        }
        2 => atom_order(a, b),
        3 => {
            let (ba, _) = base_exp(a);
            let (bb, _) = base_exp(b);
            bb.as_num().unwrap().cmp(ba.as_num().unwrap())
        }
        _ => fun_name_key(a).cmp(&fun_name_key(b)).then_with(|| atom_order(a, b)),
    }
}

fn sorted_terms(e: &Expr) -> Vec<Expr> {
    match &e.kind {
        Kind::Add(v) => {
            let mut t = v.clone();
            t.sort_by(sum_order);
            t
        }
        _ => vec![e.clone()],
    }
}

// ------------------------------------------------------------------ Sage strings

const P_ADD: u8 = 1;
const P_MUL: u8 = 2;
const P_NEG: u8 = 3;
const P_POW: u8 = 4;
const P_ATOM: u8 = 5;

pub fn to_string(e: &Expr) -> String {
    let (s, _) = sage(e);
    s
}

/// A term or argument: a lone negative power prints as a fraction (1/x^2),
/// which Sage writes as x^(-2) only for a whole expression.
fn sage_inner(e: &Expr) -> (String, u8) {
    if let Kind::Pow(b, x) = &e.kind {
        if x.as_num().map_or(false, |n| n.is_negative()) && !b.is_const(Const::E) {
            return print_mul(&[e.clone()]);
        }
    }
    sage(e)
}

fn paren(s: (String, u8), need: u8) -> String {
    if s.1 < need {
        format!("({})", s.0)
    } else {
        s.0
    }
}

fn num_str(n: &Num) -> (String, u8) {
    let s = n.sage_str();
    let prec = match n {
        Num::Exact(a, b) => {
            if !b.is_zero_q() && !a.is_zero_q() {
                P_ADD
            } else if s.starts_with('-') {
                P_NEG
            } else if s.contains('/') || s.contains('*') {
                P_MUL
            } else {
                P_ATOM
            }
        }
        Num::Float(_, b) => {
            if *b != 0.0 {
                P_ADD
            } else if s.starts_with('-') {
                P_NEG
            } else {
                P_ATOM
            }
        }
    };
    (s, prec)
}

trait ZeroQ {
    fn is_zero_q(&self) -> bool;
}
impl ZeroQ for crate::num::Q {
    fn is_zero_q(&self) -> bool {
        use num_traits::Zero;
        self.is_zero()
    }
}

fn sage(e: &Expr) -> (String, u8) {
    match &e.kind {
        Kind::Num(n) => num_str(n),
        Kind::Sym(s) => (s.to_string(), P_ATOM),
        Kind::Const(c) => (
            match c {
                Const::Pi => "pi",
                Const::E => "e",
                Const::EulerGamma => "euler_gamma",
                Const::Infinity => "+Infinity",
                Const::MinusInfinity => "-Infinity",
                Const::UnsignedInfinity => "Infinity",
                Const::Undefined => "NaN",
            }
            .to_string(),
            if matches!(c, Const::MinusInfinity) { P_NEG } else { P_ATOM },
        ),
        Kind::Add(v) => {
            let mut terms = v.clone();
            terms.sort_by(sum_order);
            let mut s = String::new();
            for (k, t) in terms.iter().enumerate() {
                let (c, _) = split_coeff(t);
                if k == 0 {
                    s.push_str(&paren(sage_inner(t), P_ADD));
                } else if c.looks_negative() && c.is_real() {
                    s.push_str(" - ");
                    s.push_str(&paren(sage_inner(&neg(t)), P_MUL));
                } else {
                    s.push_str(" + ");
                    s.push_str(&paren(sage_inner(t), P_MUL));
                }
            }
            (s, P_ADD)
        }
        Kind::Mul(v) => print_mul(v),
        Kind::Pow(b, x) => print_pow(b, x, true),
        Kind::Fun(f, a) => (print_fun(f, a), P_ATOM),
        Kind::Rel(r, a, b) => {
            let op = match r {
                Rel::Eq => "==",
                Rel::Ne => "!=",
                Rel::Lt => "<",
                Rel::Le => "<=",
                Rel::Gt => ">",
                Rel::Ge => ">=",
            };
            (format!("{} {} {}", to_string(a), op, to_string(b)), 0)
        }
    }
}

fn print_fun(f: &Fun, a: &[Expr]) -> String {
    let args: Vec<String> = a.iter().map(|x| sage_inner(x).0).collect();
    match f {
        Fun::Deriv(name, idx) => {
            let ix: Vec<String> = idx.iter().map(|i| i.to_string()).collect();
            format!("diff({}({}), {})", name, args.join(", "), ix.iter().map(|i| a.get(i.parse::<usize>().unwrap()).map(to_string).unwrap_or_default()).collect::<Vec<_>>().join(", "))
        }
        _ => format!("{}({})", f.name(), args.join(", ")),
    }
}

fn print_pow(b: &Expr, x: &Expr, alone: bool) -> (String, u8) {
    if let Some(n) = x.as_num() {
        if let Some(r) = n.as_rat() {
            let half = crate::num::qr(1, 2);
            if *r == half {
                return (format!("sqrt({})", to_string(b)), P_ATOM);
            }
            if alone && *r == -half {
                return (format!("1/sqrt({})", to_string(b)), P_MUL);
            }
            if alone && *r == crate::num::q(-1) {
                return (format!("1/{}", paren(sage(b), P_POW)), P_MUL);
            }
        }
    }
    let base = if b.is_const(Const::E) { "e".to_string() } else { paren(sage(b), P_POW + 1) };
    let ex = sage(x);
    let ex = if ex.1 >= P_ATOM && !ex.0.starts_with('-') { ex.0 } else { format!("({})", ex.0) };
    (format!("{}^{}", base, ex), P_POW)
}

/// A product: coefficient, numerator factors, then "/" and the denominator.
fn print_mul(v: &[Expr]) -> (String, u8) {
    let mut coeff = Num::one();
    let mut numer: Vec<Expr> = vec![];
    let mut denom: Vec<Expr> = vec![];
    for f in v {
        if let Kind::Num(n) = &f.kind {
            coeff = coeff.mul(n);
            continue;
        }
        let (b, x) = base_exp(f);
        if x.as_num().map_or(false, |n| n.is_negative()) {
            denom.push(pow(&b, &neg(&x)));
        } else {
            numer.push(f.clone());
        }
    }
    numer.sort_by(mul_order);
    denom.sort_by(mul_order);
    let fac = |f: &Expr| -> String {
        match &f.kind {
            Kind::Pow(b, x) => paren(print_pow(b, x, false), P_MUL),
            _ => paren(sage(f), P_MUL),
        }
    };
    let nstr: Vec<String> = numer.iter().map(fac).collect();
    let mut s = String::new();
    let neg_sign = coeff.looks_negative() && coeff.is_real();
    let c = if neg_sign { coeff.neg() } else { coeff.clone() };
    if neg_sign {
        s.push('-');
    }
    let cstr = num_str(&c);
    if !c.is_one() {
        if numer.is_empty() {
            s.push_str(&cstr.0);
        } else {
            s.push_str(&paren(cstr, P_MUL));
            s.push('*');
        }
    }
    if numer.is_empty() && c.is_one() {
        s.push('1');
    }
    s.push_str(&nstr.join("*"));
    if !denom.is_empty() {
        s.push('/');
        if denom.len() == 1 {
            let d = &denom[0];
            s.push_str(&match &d.kind {
                Kind::Pow(b, x) => paren(print_pow(b, x, false), P_POW),
                _ => paren(sage(d), P_POW),
            });
        } else {
            let d: Vec<String> = denom.iter().map(fac).collect();
            s.push_str(&format!("({})", d.join("*")));
        }
    }
    (s, if neg_sign { P_NEG } else { P_MUL })
}

// ------------------------------------------------------------------ LaTeX

pub fn to_latex(e: &Expr) -> String {
    latex(e).0
}

fn lparen(s: (String, u8), need: u8) -> String {
    if s.1 < need {
        format!("\\left({}\\right)", s.0)
    } else {
        s.0
    }
}

fn latex_fun_name(f: &Fun) -> String {
    match f {
        Fun::Sin | Fun::Cos | Fun::Tan | Fun::Cot | Fun::Sec | Fun::Csc | Fun::Sinh | Fun::Cosh | Fun::Tanh | Fun::Coth | Fun::Log => format!("\\{}", f.name()),
        Fun::Asin | Fun::Acos | Fun::Atan => format!("\\{}", f.name()),
        Fun::Abs => "{\\left|".into(),
        _ => format!("{{\\rm {}}}", f.name()),
    }
}

fn latex(e: &Expr) -> (String, u8) {
    match &e.kind {
        Kind::Num(n) => {
            let s = n.latex();
            let p = if s.starts_with('-') { P_NEG } else if s.contains(' ') { P_ADD } else { P_ATOM };
            (s, p)
        }
        Kind::Sym(s) => (latex_symbol(s), P_ATOM),
        Kind::Const(c) => (
            match c {
                Const::Pi => "\\pi".into(),
                Const::E => "e".into(),
                Const::EulerGamma => "\\gamma_E".into(),
                Const::Infinity => "+\\infty".into(),
                Const::MinusInfinity => "-\\infty".into(),
                Const::UnsignedInfinity => "\\infty".into(),
                Const::Undefined => "\\text{NaN}".into(),
            },
            P_ATOM,
        ),
        Kind::Add(v) => {
            let mut terms = v.clone();
            terms.sort_by(sum_order);
            let mut s = String::new();
            for (k, t) in terms.iter().enumerate() {
                let (c, _) = split_coeff(t);
                if k == 0 {
                    s.push_str(&latex(t).0);
                } else if c.looks_negative() && c.is_real() {
                    s.push_str(" - ");
                    s.push_str(&latex(&neg(t)).0);
                } else {
                    s.push_str(" + ");
                    s.push_str(&latex(t).0);
                }
            }
            (s, P_ADD)
        }
        Kind::Mul(v) => latex_mul(v),
        Kind::Pow(b, x) => latex_pow(b, x, true),
        Kind::Fun(Fun::Abs, a) => (format!("{{\\left| {} \\right|}}", latex(&a[0]).0), P_ATOM),
        Kind::Fun(f, a) => {
            let args: Vec<String> = a.iter().map(|x| latex(x).0).collect();
            (format!("{}\\left({}\\right)", latex_fun_name(f), args.join(", ")), P_ATOM)
        }
        Kind::Rel(r, a, b) => {
            let op = match r {
                Rel::Eq => "=",
                Rel::Ne => "\\neq",
                Rel::Lt => "<",
                Rel::Le => "\\leq",
                Rel::Gt => ">",
                Rel::Ge => "\\geq",
            };
            (format!("{} {} {}", latex(a).0, op, latex(b).0), 0)
        }
    }
}

fn latex_symbol(s: &str) -> String {
    const GREEK: [&str; 24] = [
        "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau",
        "upsilon", "phi", "chi", "psi", "omega", "Gamma",
    ];
    if GREEK.contains(&s) {
        return format!("\\{}", s);
    }
    if let Some((a, b)) = s.split_once('_') {
        return format!("{}_{{{}}}", latex_symbol(a), b);
    }
    if s.len() > 1 {
        return format!("\\mathit{{{}}}", s);
    }
    s.to_string()
}

fn latex_pow(b: &Expr, x: &Expr, alone: bool) -> (String, u8) {
    if let Some(r) = x.as_rat() {
        if *r == crate::num::qr(1, 2) {
            return (format!("\\sqrt{{{}}}", latex(b).0), P_ATOM);
        }
        if alone && (*r == crate::num::qr(-1, 2) || *r == crate::num::q(-1)) {
            let d = if *r == crate::num::q(-1) { latex(b).0 } else { format!("\\sqrt{{{}}}", latex(b).0) };
            return (format!("\\frac{{1}}{{{}}}", d), P_ATOM);
        }
    }
    let base = if b.is_const(Const::E) {
        "e".to_string()
    } else {
        let l = latex(b);
        if l.1 < P_POW + 1 {
            format!("{{\\left({}\\right)}}", l.0)
        } else {
            l.0
        }
    };
    let ex = latex(x);
    let ex = if b.is_const(Const::E) && ex.1 < P_ATOM { format!("\\left({}\\right)", ex.0) } else { ex.0 };
    (format!("{}^{{{}}}", base, ex), P_POW)
}

fn latex_mul(v: &[Expr]) -> (String, u8) {
    let mut coeff = Num::one();
    let mut numer: Vec<Expr> = vec![];
    let mut denom: Vec<Expr> = vec![];
    for f in v {
        if let Kind::Num(n) = &f.kind {
            coeff = coeff.mul(n);
            continue;
        }
        let (b, x) = base_exp(f);
        if x.as_num().map_or(false, |n| n.is_negative()) {
            denom.push(pow(&b, &neg(&x)));
        } else {
            numer.push(f.clone());
        }
    }
    numer.sort_by(mul_order);
    denom.sort_by(mul_order);
    let neg_sign = coeff.looks_negative() && coeff.is_real();
    let c = if neg_sign { coeff.neg() } else { coeff.clone() };
    let fac = |f: &Expr| -> String {
        match &f.kind {
            Kind::Pow(b, x) => latex_pow(b, x, false).0,
            Kind::Add(_) => format!("{{\\left({}\\right)}}", latex(f).0),
            _ => lparen(latex(f), P_MUL),
        }
    };
    let n: Vec<String> = numer.iter().map(fac).collect();
    let mut body = n.join(" ");
    if !denom.is_empty() {
        let d: Vec<String> = denom.iter().map(|f| match &f.kind {
            Kind::Add(_) if denom.len() == 1 => latex(f).0,
            _ => fac(f),
        }).collect();
        let top = if body.is_empty() { "1".to_string() } else { body };
        // the rational coefficient's denominator joins the fraction
        let (cn, cd) = match c.as_rat() {
            Some(r) => (crate::num::Num::big(r.numer().clone()), crate::num::Num::big(r.denom().clone())),
            None => (c.clone(), Num::one()),
        };
        let top = if cn.is_one() { top } else if top == "1" { cn.latex() } else { format!("{} \\, {}", cn.latex(), top) };
        let bottom = if cd.is_one() { d.join(" ") } else { format!("{} \\, {}", cd.latex(), d.join(" ")) };
        let s = format!("\\frac{{{}}}{{{}}}", top, bottom);
        return (if neg_sign { format!("-{}", s) } else { s }, if neg_sign { P_NEG } else { P_MUL });
    }
    if !c.is_one() {
        body = if body.is_empty() { c.latex() } else { format!("{} \\, {}", lparen((c.latex(), if c.is_real() { P_ATOM } else { P_ADD }), P_MUL), body) };
    }
    (if neg_sign { format!("-{}", body) } else { body }, if neg_sign { P_NEG } else { P_MUL })
}
