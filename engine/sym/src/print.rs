//! Printing as Sage prints symbolic expressions, and Sage-style LaTeX.
//!
//! The operands of sums and products are stored in a canonical order
//! (expr.rs); here they are put in Sage's print order: sums by descending
//! degree with constants last (x^2 + 2*x + 1, x + sin(x) + 1), products
//! with sums first, then symbols, then functions ((x + 1)*x*sin(x)), and
//! negative powers as a denominator (1/2*x^2/y, 1/2/x, (x + 1)/(x - 1)).

use crate::expr::*;
use crate::num::Num;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::HashMap;

// ------------------------------------------------------------------ the sorts of one print
// The order functions below compare subexpressions through their sorted terms
// and factors, and each comparison sorts again: without a memo a nested
// unexpanded product (an adjugate's entries) is sorted again at every level, a
// cost that grows exponentially with the nesting.  During one print (to_string,
// to_latex) each distinct subexpression's sorts are computed once.  The keys are
// the expressions themselves (structural, hashed once), so the memo holds them
// alive and a freed temporary can't alias another; it is dropped when the
// outermost print returns.

#[derive(Default)]
struct Memo {
    terms: HashMap<Expr, Vec<Expr>>,
    factors: HashMap<Expr, Vec<Expr>>,
    p_factors: HashMap<Expr, Vec<Expr>>,
}

thread_local! {
    static MEMO: RefCell<Option<Memo>> = const { RefCell::new(None) };
}

#[cfg(test)]
thread_local! {
    /// (tests) the sorts computed (memo misses and unmemoized calls)
    static SORTS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// f with the memo on (the outermost print creates it and drops it, also on a panic).
fn with_memo<T>(f: impl FnOnce() -> T) -> T {
    struct Drop_(bool);
    impl Drop for Drop_ {
        fn drop(&mut self) {
            if self.0 {
                MEMO.with(|m| *m.borrow_mut() = None);
            }
        }
    }
    let outer = MEMO.with(|m| {
        let mut m = m.borrow_mut();
        if m.is_none() {
            *m = Some(Memo::default());
            true
        } else {
            false
        }
    });
    let _g = Drop_(outer);
    f()
}

/// The memoized value of compute(e) in the table pick selects (computed without
/// the memo outside a print).  The memo isn't borrowed while compute runs: it
/// recurses into the same tables.
fn memo(e: &Expr, pick: fn(&mut Memo) -> &mut HashMap<Expr, Vec<Expr>>, compute: impl FnOnce() -> Vec<Expr>) -> Vec<Expr> {
    #[cfg(test)]
    let compute = || {
        SORTS.with(|s| s.set(s.get() + 1));
        compute()
    };
    let hit = MEMO.with(|m| m.borrow_mut().as_mut().map(|m| pick(m).get(e).cloned()));
    match hit {
        Some(Some(v)) => v,
        Some(None) => {
            let v = compute();
            MEMO.with(|m| {
                if let Some(m) = m.borrow_mut().as_mut() {
                    pick(m).insert(e.clone(), v.clone());
                }
            });
            v
        }
        None => compute(),
    }
}

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
    memo(e, |m| &mut m.factors, || term_factors_sorted(e))
}

fn term_factors_sorted(e: &Expr) -> Vec<Expr> {
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
    // a function times powers of symbols before a lone function, whatever the
    // degrees (Sage: sin(x)/x^2 + cos(x), cos(x^2)/x^2 + sin(x^2))
    let (ma, mb) = (fun_times_symbols(a), fun_times_symbols(b));
    if ma != mb && (ma && lone_fun(b) || mb && lone_fun(a)) {
        return if ma { Ordering::Less } else { Ordering::Greater };
    }
    // pure symbolic terms: Sage's print order (P1-P4; Greater = printed first)
    {
        let (ra, rb) = (split_coeff(a).1, split_coeff(b).1);
        if !ra.is_one() && !rb.is_one() && p_order(&ra) && p_order(&rb) {
            let c = pcmp(&rb, &ra);
            if c != Ordering::Equal {
                return c;
            }
        }
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
    // same degree: the transcendental kernels (functions, exponentials)
    // first, whatever the coefficients (_K2*cos(x) + _K1*sin(x)), then
    // the polynomial factors one by one
    let (fa, fb) = (term_factors(a), term_factors(b));
    let kernel = |f: &&Expr| -> bool {
        let (b, _) = base_exp(f);
        matches!(b.kind, Kind::Fun(..)) || b.is_const(Const::E)
    };
    let (ka, kb): (Vec<&Expr>, Vec<&Expr>) = (fa.iter().filter(kernel).collect(), fb.iter().filter(kernel).collect());
    if !ka.is_empty() && !kb.is_empty() {
        // compared from the last kernel (Sage: -y*u_x(x, y) + sin(x*y)*u_z(x, y))
        for (x, y) in ka.iter().rev().zip(kb.iter().rev()) {
            let c = is_deriv(x).cmp(&is_deriv(y)).then_with(|| fun_name_key(x).cmp(&fun_name_key(y))).then_with(|| atom_order(x, y));
            if c != Ordering::Equal {
                return c;
            }
        }
    }
    for (x, y) in fa.iter().zip(&fb) {
        let c = atom_order(x, y);
        if c != Ordering::Equal {
            return c;
        }
    }
    fb.len().cmp(&fa.len()).then_with(|| canon_cmp(a, b))
}

fn is_fun_like(e: &Expr) -> bool {
    match &e.kind {
        Kind::Fun(..) => true,
        Kind::Pow(b, _) => b.is_const(Const::E),
        _ => false,
    }
}

fn lone_fun(e: &Expr) -> bool {
    is_fun_like(&split_coeff(e).1)
}

fn fun_times_symbols(e: &Expr) -> bool {
    let f = term_factors(e);
    f.len() >= 2
        && f.iter().any(is_fun_like)
        && f.iter().all(|t| is_fun_like(t) || matches!(&base_exp(t).0.kind, Kind::Sym(_)))
        && f.iter().any(|t| matches!(&base_exp(t).0.kind, Kind::Sym(_)))
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
            // derivatives after the other functions (sin(x)*diff(f(x), x),
            // zz(x, y) + diff(a(x, y), x))
            let (da, db) = (matches!(f, Fun::Deriv(..)), matches!(g, Fun::Deriv(..)));
            if da != db {
                return da.cmp(&db);
            }
            let c = f.name().cmp(&g.name());
            if c != Ordering::Equal {
                return c;
            }
            // derivatives of one function: by the indices (D[0](f) before D[1](f))
            if let (Fun::Deriv(_, i), Fun::Deriv(_, j)) = (f, g) {
                let c = i.cmp(j);
                if c != Ordering::Equal {
                    return c;
                }
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
    let c = eb.partial_cmp(&ea).unwrap_or(Ordering::Equal);
    if c != Ordering::Equal || xa == xb {
        return c;
    }
    // exponents of one degree: products before a bare symbol, larger
    // coefficients first (e^(2*x) + e^(-x) + e^x)
    match (&xa.kind, &xb.kind) {
        (Kind::Mul(_), Kind::Sym(_)) => Ordering::Less,
        (Kind::Sym(_), Kind::Mul(_)) => Ordering::Greater,
        _ => {
            let (ca, cb) = (split_coeff(&xa).0.to_c64().0, split_coeff(&xb).0.to_c64().0);
            cb.partial_cmp(&ca).unwrap_or(Ordering::Equal)
        }
    }
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
    // pure symbolic factors: Sage's factor order (P5; Greater = printed first)
    if p_order(a) && p_order(b) {
        let c = pmul_cmp(b, a);
        if c != Ordering::Equal {
            return c;
        }
    }
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
        _ => is_deriv(a).cmp(&is_deriv(b)).then_with(|| fun_name_key(a).cmp(&fun_name_key(b))).then_with(|| atom_order(a, b)),
    }
}

fn is_deriv(e: &Expr) -> bool {
    matches!(&base_exp(e).0.kind, Kind::Fun(Fun::Deriv(..), _))
}

fn sorted_terms(e: &Expr) -> Vec<Expr> {
    match &e.kind {
        Kind::Add(v) => memo(e, |m| &mut m.terms, || {
            let mut t = v.clone();
            t.sort_by(sum_order);
            t
        }),
        _ => vec![e.clone()],
    }
}


// ------------------------------------------------------------------ Sage's print order
// One total order for the terms of a sum and the factors of a product, as Sage prints
// them (lane 4p; rules P0-P5 in sage2's spec, set by the counted Sage probe counted-3):
// Ordering::Greater = printed first.

fn p_pure(e: &Expr) -> bool {
    match &e.kind {
        Kind::Sym(_) => true,
        Kind::Num(_) => false,
        Kind::Add(v) => v.iter().all(|t| { let r = split_coeff(t).1; r.is_one() || p_pure(&r) }),
        Kind::Mul(v) => v.iter().all(|f| f.is_num() || p_pure(f)),
        Kind::Pow(..) if p_kernel(e) => true,
        Kind::Pow(b, x) => x.as_i64().is_some() && p_pure(b),
        Kind::Fun(..) => p_kernel(e),
        _ => false,
    }
}

/// A function of P-pure arguments (or numbers), or e^u for such a non-numeric
/// u: a kernel, which Sage orders like a variable (C0's probes, order2-4):
/// below the symbols, by its name, then its arguments; a lone kernel as a term
/// of a sum comes after every other term.  Derivatives are left out.
fn p_kernel(e: &Expr) -> bool {
    let arg_ok = |a: &Expr| a.as_num().map_or(false, |n| n.is_exact() && n.is_real()) || p_pure(a);
    match &e.kind {
        Kind::Fun(f, args) => !matches!(f, Fun::Deriv(..)) && !args.is_empty() && args.iter().all(arg_ok),
        Kind::Pow(b, u) => b.is_const(Const::E) && !u.is_num() && arg_ok(u),
        _ => false,
    }
}

/// P-pure, without a sum of kernels among its factors (or as itself), nor a
/// sum and a kernel as factors: those keep the older rule, a kernel-led sum
/// before the functions in a product (-(psi(x + y) - psi(x))*beta(x, y),
/// (cos(x) + 1)*sin(x))
fn p_order(e: &Expr) -> bool {
    fn kernel_sum(f: &Expr) -> bool {
        let b = match &f.kind { Kind::Pow(b, _) => b, _ => f };
        matches!(&b.kind, Kind::Add(v) if v.iter().any(has_function))
    }
    // (and a product of a sum and a kernel: (x + 1)*sin(x) + x^2 keeps the older rule)
    let sum_and_kernel = matches!(&e.kind, Kind::Mul(v) if v.iter().any(|f| matches!(&f.kind, Kind::Add(_)) || matches!(&f.kind, Kind::Pow(b, _) if matches!(b.kind, Kind::Add(_))))
        && v.iter().any(|f| p_kernel(f) || matches!(&f.kind, Kind::Pow(b, _) if p_kernel(b))));
    p_pure(e) && !kernel_sum(e) && !sum_and_kernel && !matches!(&e.kind, Kind::Mul(v) if v.iter().any(kernel_sum))
}

/// a kernel's name and arguments (e^u: exp, [u])
fn p_kernel_parts(e: &Expr) -> (String, Vec<Expr>) {
    match &e.kind {
        Kind::Fun(f, args) => (f.name(), args.clone()),
        Kind::Pow(_, u) => ("exp".to_string(), vec![u.clone()]),
        _ => (String::new(), vec![]),
    }
}

/// Two kernels (greater = printed first): the alphabetically earlier name,
/// then argument by argument: a number before the rest, the larger number
/// first; then the arguments' own order, then the larger coefficient
/// (sin(2) + sin(1), cos(1)*cos(x), sin(3*x) + sin(2*x) + sin(x)).
fn p_kernel_cmp(a: &Expr, b: &Expr) -> Ordering {
    let ((na, xa), (nb, xb)) = (p_kernel_parts(a), p_kernel_parts(b));
    let c = nb.cmp(&na);
    if c != Ordering::Equal { return c; }
    for (u, v) in xa.iter().zip(&xb) {
        let c = match (u.as_num(), v.as_num()) {
            (Some(m), Some(n)) => m.cmp(n),
            (Some(_), None) => Ordering::Greater,
            (None, Some(_)) => Ordering::Less,
            _ => {
                let ((cu, ru), (cv, rv)) = (split_coeff(u), split_coeff(v));
                let c = pcmp(&ru, &rv);
                // one rest: a multiple before the bare one, then the larger
                // coefficient (e^(2*x) + e^(-x) + e^x, sin(2*x) + sin(x))
                if c != Ordering::Equal {
                    c
                } else if cu.is_one() != cv.is_one() {
                    if cu.is_one() { Ordering::Less } else { Ordering::Greater }
                } else {
                    cu.cmp(&cv)
                }
            }
        };
        if c != Ordering::Equal { return c; }
    }
    xa.len().cmp(&xb.len())
}

/// a sum compared in its sign-normalized form: led by a positive term (Sage stores -(x + y), not -x - y)
fn p_norm(e: &Expr) -> Expr {
    if let Kind::Add(_) = &e.kind {
        let lead = sorted_terms(e)[0].clone();
        if split_coeff(&lead).0.looks_negative() {
            return neg(e);
        }
    }
    e.clone()
}

fn p_be(f: &Expr) -> (Expr, i64) {
    match &f.kind {
        Kind::Pow(..) if p_kernel(f) => (f.clone(), 1),
        Kind::Pow(b, x) => (p_norm(b), x.as_i64().unwrap_or(1)),
        _ => (p_norm(f), 1),
    }
}

/// P1: the degree; a sum factor counts its exponent (1), not its own degree
fn p_deg(e: &Expr) -> i64 {
    match &e.kind {
        Kind::Sym(_) => 1,
        Kind::Add(_) => 1,
        Kind::Fun(..) => 1,
        Kind::Pow(..) if p_kernel(e) => 1,
        Kind::Pow(_, x) => x.as_i64().unwrap_or(1),
        Kind::Mul(v) => v.iter().filter(|f| !f.is_num()).map(p_deg).sum(),
        _ => 0,
    }
}

/// a product's factors (no number), smallest first (P2)
fn p_factors_up(e: &Expr) -> Vec<Expr> {
    memo(e, |m| &mut m.p_factors, || {
        let mut v: Vec<Expr> = match &e.kind {
            Kind::Mul(f) => f.iter().filter(|x| !x.is_num()).map(p_norm).collect(),
            _ => vec![p_norm(e)],
        };
        v.sort_by(|a, b| pmul_cmp(a, b));
        v
    })
}

fn pcmp(a: &Expr, b: &Expr) -> Ordering {
    let (a, b) = (&p_norm(a), &p_norm(b));
    // a lone kernel is below everything else; two by p_kernel_cmp
    match (p_kernel(a), p_kernel(b)) {
        (true, true) => return p_kernel_cmp(a, b),
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    match (&a.kind, &b.kind) {
        (Kind::Add(_), Kind::Add(_)) => p_add_add(a, b),
        (Kind::Add(_), _) => p_add_x(a, b),
        (_, Kind::Add(_)) => p_add_x(b, a).reverse(),
        (Kind::Mul(_), Kind::Mul(_)) => p_mul_mul(a, b),
        (Kind::Mul(_), _) => p_mul_x(a, b),
        (_, Kind::Mul(_)) => p_mul_x(b, a).reverse(),
        _ => p_pow_pow(a, b),
    }
}

/// P3: a sum is compared through its greatest term (its first term as printed)
fn p_key_term(s: &Expr) -> Expr {
    sorted_terms(s)[0].clone()
}

fn p_add_x(s: &Expr, x: &Expr) -> Ordering {
    let g = p_key_term(s);
    let (gc, gr) = split_coeff(&g);
    let c = if gr.is_one() { Ordering::Less } else { pcmp(&gr, x) };
    if c != Ordering::Equal { return c; }
    let c = gc.cmp(&Num::one());
    if c != Ordering::Equal { return c; }
    if sorted_terms(s).len() == 1 { Ordering::Equal } else { Ordering::Greater }
}

fn p_add_add(a: &Expr, b: &Expr) -> Ordering {
    let (ta, tb) = (sorted_terms(a), sorted_terms(b));
    for (x, y) in ta.iter().zip(&tb) {
        let (cx, rx) = split_coeff(x);
        let (cy, ry) = split_coeff(y);
        let c = match (rx.is_one(), ry.is_one()) { (true, true) => Ordering::Equal, (true, false) => Ordering::Less, (false, true) => Ordering::Greater, _ => pcmp(&rx, &ry) };
        if c != Ordering::Equal { return c; }
        let c = cx.cmp(&cy);
        if c != Ordering::Equal { return c; }
    }
    ta.len().cmp(&tb.len())
}

fn p_mul_mul(a: &Expr, b: &Expr) -> Ordering {
    let c = p_deg(a).cmp(&p_deg(b));
    if c != Ordering::Equal { return c; }
    let (fa, fb) = (p_factors_up(a), p_factors_up(b));
    for (x, y) in fa.iter().zip(&fb) {
        let ((bx, ex), (by, ey)) = (p_be(x), p_be(y));
        let c = pcmp(&bx, &by);
        if c != Ordering::Equal { return c; }
        let c = ey.cmp(&ex); // the smaller exponent is greater
        if c != Ordering::Equal { return c; }
    }
    fa.len().cmp(&fb.len())
}

fn p_mul_x(m: &Expr, x: &Expr) -> Ordering {
    let (bx, ex) = p_be(x);
    let c = p_deg(m).cmp(&ex);
    if c != Ordering::Equal { return c; }
    let f = p_factors_up(m);
    let (bm, em) = p_be(&f[0]);
    let c = pcmp(&bm, &bx);
    if c != Ordering::Equal { return c; }
    let c = ex.cmp(&em);
    if c != Ordering::Equal { return c; }
    if f.len() == 1 { Ordering::Equal } else { Ordering::Greater }
}

/// P5: the order of a product's FACTORS (greater first): two powers (a symbol = power 1) by their bases
/// first (by P), then the higher exponent; a sum by its greatest term against the other factor's BASE, then
/// that term's coefficient against 1, then the sum is greater
fn pmul_cmp(a: &Expr, b: &Expr) -> Ordering {
    let (a, b) = (p_norm(a), p_norm(b));
    match (&a.kind, &b.kind) {
        (Kind::Add(_), Kind::Add(_)) => p_add_add(&a, &b),
        (Kind::Add(_), _) => p_add_base(&a, &b),
        (_, Kind::Add(_)) => p_add_base(&b, &a).reverse(),
        _ => {
            let ((ba, xa), (bb, xb)) = (p_be(&a), p_be(&b));
            let c = match (&ba.kind, &bb.kind) {
                (Kind::Sym(s), Kind::Sym(t)) => t.cmp(s),
                _ => pcmp(&ba, &bb),
            };
            if c != Ordering::Equal { return c; }
            xa.cmp(&xb)
        }
    }
}

fn p_add_base(s: &Expr, x: &Expr) -> Ordering {
    let g = p_key_term(s);
    let (gc, gr) = split_coeff(&g);
    let (bx, _) = p_be(x);
    let c = if gr.is_one() { Ordering::Less } else { pcmp(&gr, &bx) };
    if c != Ordering::Equal { return c; }
    let c = gc.cmp(&Num::one());
    if c != Ordering::Equal { return c; }
    if sorted_terms(s).len() == 1 { Ordering::Equal } else { Ordering::Greater }
}

/// P4: symbols and powers (a symbol = a power 1): the higher exponent is greater, then the base
/// (two symbols: the alphabetically earlier name is greater)
fn p_pow_pow(a: &Expr, b: &Expr) -> Ordering {
    let ((ba, xa), (bb, xb)) = (p_be(a), p_be(b));
    if xa != xb { return xa.cmp(&xb); }
    match (&ba.kind, &bb.kind) {
        (Kind::Sym(s), Kind::Sym(t)) => t.cmp(s),
        _ => pcmp(&ba, &bb),
    }
}

// ------------------------------------------------------------------ Sage strings

const P_ADD: u8 = 1;
const P_MUL: u8 = 2;
const P_NEG: u8 = 3;
const P_POW: u8 = 4;
const P_ATOM: u8 = 5;

pub fn to_string(e: &Expr) -> String {
    with_memo(|| sage(e).0)
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
                if k == 0 {
                    s.push_str(&paren(sage_inner(t), P_ADD));
                } else if let Kind::Num(n) = &t.kind {
                    // a number's own sign (x - 2*I + 1), as Sage prints it
                    let ns = num_str(n).0;
                    match ns.strip_prefix('-') {
                        Some(rest) => {
                            s.push_str(" - ");
                            s.push_str(rest);
                        }
                        None => {
                            s.push_str(" + ");
                            s.push_str(&ns);
                        }
                    }
                } else {
                    // the sign as the term prints it (a negated sum factor carries it: x - (y - 1)*z)
                    let ts = sage_inner(t);
                    match ts.0.strip_prefix('-') {
                        Some(rest) => {
                            s.push_str(" - ");
                            s.push_str(rest);
                        }
                        None => {
                            s.push_str(" + ");
                            s.push_str(&paren(ts, P_MUL));
                        }
                    }
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
            // diff(f(x, y), x) when the arguments are distinct symbols, else
            // D[0](f)(r*cos(ph), r*sin(ph)), as Sage prints them
            let distinct = a.iter().all(|x| matches!(x.kind, Kind::Sym(_)))
                && (0..a.len()).all(|i| (0..i).all(|j| a[i] != a[j]));
            if distinct {
                format!("diff({}({}), {})", name, args.join(", "), idx.iter().map(|i| a.get(*i as usize).map(to_string).unwrap_or_default()).collect::<Vec<_>>().join(", "))
            } else {
                let ix: Vec<String> = idx.iter().map(|i| i.to_string()).collect();
                format!("D[{}]({})({})", ix.join(", "), name, args.join(", "))
            }
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

    // a sum factor led by a negative term prints negated, its sign pulled out
    // (Sage: -(x - 1)/y, -(2/x - 3)/(y - 1/x); render only, the expression is unchanged)
    for f in numer.iter_mut().chain(denom.iter_mut()) {
        if matches!(f.kind, Kind::Add(_)) {
            let lead = sorted_terms(f)[0].clone();
            if split_coeff(&lead).0.looks_negative() {
                *f = neg(f);
                coeff = coeff.neg();
            }
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
    let neg_sign = coeff.looks_negative();
    let c = if neg_sign { coeff.neg() } else { coeff.clone() };
    if neg_sign {
        s.push('-');
    }
    let cstr = num_str(&c);
    if !c.is_one() {
        if numer.is_empty() && denom.is_empty() {
            s.push_str(&cstr.0);
        } else if numer.is_empty() {
            // the whole numerator: grouped when it is a sum (-(I + 1)/x)
            s.push_str(&paren(cstr, P_MUL));
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
    with_memo(|| latex(e).0)
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
                if k == 0 {
                    s.push_str(&latex(t).0);
                } else if matches!(t.kind, Kind::Num(_)) {
                    let ns = latex(t).0;
                    match ns.strip_prefix('-') {
                        Some(rest) => {
                            s.push_str(" - ");
                            s.push_str(rest);
                        }
                        None => {
                            s.push_str(" + ");
                            s.push_str(&ns);
                        }
                    }
                } else {
                    // the sign as the term prints it (a negated sum factor carries it: x - (y - 1)*z)
                    let ts = latex(t).0;
                    match ts.strip_prefix('-') {
                        Some(rest) => {
                            s.push_str(" - ");
                            s.push_str(rest);
                        }
                        None => {
                            s.push_str(" + ");
                            s.push_str(&ts);
                        }
                    }
                }
            }
            (s, P_ADD)
        }
        Kind::Mul(v) => latex_mul(v),
        Kind::Pow(b, x) => latex_pow(b, x, true),
        Kind::Fun(Fun::Abs, a) => (format!("{{\\left| {} \\right|}}", latex(&a[0]).0), P_ATOM),
        Kind::Fun(f, a) => {
            let args: Vec<String> = a.iter().map(|x| latex(x).0).collect();
            if let Some(s) = crate::special::latex(f, &args) {
                return (s, P_ATOM);
            }
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

    // a sum factor led by a negative term prints negated, its sign pulled out
    // (Sage: -(x - 1)/y, -(2/x - 3)/(y - 1/x); render only, the expression is unchanged)
    for f in numer.iter_mut().chain(denom.iter_mut()) {
        if matches!(f.kind, Kind::Add(_)) {
            let lead = sorted_terms(f)[0].clone();
            if split_coeff(&lead).0.looks_negative() {
                *f = neg(f);
                coeff = coeff.neg();
            }
        }
    }
    numer.sort_by(mul_order);
    denom.sort_by(mul_order);
    let neg_sign = coeff.looks_negative();
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
        let (cn, cd) = match (&c, c.as_rat()) {
            (_, Some(r)) => (crate::num::Num::big(r.numer().clone()), crate::num::Num::big(r.denom().clone())),
            // an exact complex coefficient: its common denominator too
            // (-\frac{i - 3}{2 \, x}, as Sage)
            (Num::Exact(re, im), None) => {
                use num_integer::Integer;
                let l = re.denom().lcm(im.denom());
                let lq = crate::num::Q::from_integer(l.clone());
                (Num::Exact(re * &lq, im * &lq), crate::num::Num::big(l))
            }
            _ => (c.clone(), Num::one()),
        };
        let cn_one_term = cn.is_real() || matches!(&cn, Num::Exact(a, _) if num_traits::Zero::is_zero(a)) || matches!(&cn, Num::Float(a, _) if *a == 0.0);
        // a lone sum numerator prints bare (\frac{x + 1}{x - 1}, as Sage)
        let top = if cn.is_one() && numer.len() == 1 && matches!(numer[0].kind, Kind::Add(_)) { latex(&numer[0]).0 } else { top };
        let top = if cn.is_one() { top } else if top == "1" { cn.latex() } else { format!("{} \\, {}", lparen((cn.latex(), if cn_one_term { P_ATOM } else { P_ADD }), P_MUL), top) };
        // a factor in front of the denominator groups a sum
        // (\frac{1}{2 \, {\left(x + 1\right)}}, as Sage)
        let bottom = if cd.is_one() { d.join(" ") } else { format!("{} \\, {}", cd.latex(), denom.iter().map(fac).collect::<Vec<_>>().join(" ")) };
        let s = format!("\\frac{{{}}}{{{}}}", top, bottom);
        return (if neg_sign { format!("-{}", s) } else { s }, if neg_sign { P_NEG } else { P_MUL });
    }
    if !c.is_one() {
        // (a pure imaginary coefficient is one term: 10 i \, x, as Sage)
        let one_term = c.is_real() || matches!(&c, Num::Exact(a, _) if num_traits::Zero::is_zero(a)) || matches!(&c, Num::Float(a, _) if *a == 0.0);
        body = if body.is_empty() { c.latex() } else { format!("{} \\, {}", lparen((c.latex(), if one_term { P_ATOM } else { P_ADD }), P_MUL), body) };
    }
    (if neg_sign { format!("-{}", body) } else { body }, if neg_sign { P_NEG } else { P_MUL })
}

#[cfg(test)]
mod print_order_tests {
    //! Lane 4p's code criteria (S7): the print order is a consistent total order, and printing only
    //! renders. Each check also runs on a mutant that it must reject, so a pass means something.
    use super::*;
    use crate::parse::parse;

    type Cmp = fn(&Expr, &Expr) -> Ordering;

    fn exprs(v: &[&str]) -> Vec<Expr> {
        v.iter().map(|s| parse(s)).collect()
    }

    /// None if cmp is antisymmetric and transitive on xs and every permutation of xs sorts to one
    /// order; otherwise the first failure
    fn inconsistency(cmp: Cmp, xs: &[Expr]) -> Option<String> {
        for a in xs {
            if cmp(a, a) != Ordering::Equal {
                return Some(format!("{} vs itself", to_string(a)));
            }
            for b in xs {
                if cmp(a, b) != cmp(b, a).reverse() {
                    return Some(format!("antisymmetry {} / {}", to_string(a), to_string(b)));
                }
                for c in xs {
                    if cmp(a, b) != Ordering::Greater && cmp(b, c) != Ordering::Greater && cmp(a, c) == Ordering::Greater {
                        return Some(format!("transitivity {} <= {} <= {}", to_string(a), to_string(b), to_string(c)));
                    }
                }
            }
        }
        // Heap's algorithm over every permutation (n <= 6: at most 720)
        fn heap(k: usize, idx: &mut Vec<usize>, f: &mut dyn FnMut(&[usize])) {
            if k == 1 {
                f(idx);
                return;
            }
            for i in 0..k {
                heap(k - 1, idx, f);
                let j = if k % 2 == 0 { i } else { 0 };
                idx.swap(j, k - 1);
            }
        }
        let mut idx: Vec<usize> = (0..xs.len()).collect();
        let mut first: Option<Vec<String>> = None;
        let mut bad = None;
        heap(xs.len(), &mut idx, &mut |p: &[usize]| {
            let mut v: Vec<Expr> = p.iter().map(|&i| xs[i].clone()).collect();
            v.sort_by(cmp);
            let s: Vec<String> = v.iter().map(to_string).collect();
            match &first {
                None => first = Some(s),
                Some(f) if bad.is_none() && &s != f => bad = Some(format!("input order changes the sort: {:?} / {:?}", f, s)),
                _ => {}
            }
        });
        bad
    }

    /// the control for (a): the real order, except that elements whose printed lengths differ mod 3
    /// are ranked cyclically (0 < 1 < 2 < 0), a tie-break that is antisymmetric but not transitive
    fn cyclic(real: Cmp, a: &Expr, b: &Expr) -> Ordering {
        let (ka, kb) = (to_string(a).len() % 3, to_string(b).len() % 3);
        if ka == kb {
            real(a, b)
        } else if (ka + 1) % 3 == kb {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }
    fn sum_order_mutant(a: &Expr, b: &Expr) -> Ordering {
        cyclic(sum_order, a, b)
    }
    fn mul_order_mutant(a: &Expr, b: &Expr) -> Ordering {
        cyclic(mul_order, a, b)
    }

    const TERM_SETS: [&[&str]; 6] = [
        &["a^2*b", "a^2*x", "2*a*b*x", "2*a*x^2", "b*x^2", "x^3"],
        &["(x + y)*x", "x^2", "x*y", "y^2", "(x - 1)*x"],
        &["a*b", "(a + b)*c", "a*c", "c*d", "(a - b)*c"],
        &["(a^2 - b^2)*a", "a*b^2", "a^3", "b^3"],
        &["b*y", "c*h", "f*h", "x*y", "a*d", "b*c"],
        &["(p^2 + q)*r", "p*q*r", "p^2*r", "q^3"],
    ];
    const FACTOR_SETS: [&[&str]; 4] = [
        &["x^2", "y - 1/x", "x", "y"],
        &["a", "f*h - x*y", "b*y - c*h", "d", "g"],
        &["a + b", "c^2", "c", "a", "b^2"],
        &["x + 1", "x^2", "x", "y + 1"],
    ];

    #[test]
    fn term_order_is_consistent() {
        for set in TERM_SETS {
            assert_eq!(inconsistency(sum_order, &exprs(set)), None, "sum_order on {:?}", set);
        }
        let mut caught = 0;
        for set in TERM_SETS {
            let r = inconsistency(sum_order_mutant, &exprs(set));
            eprintln!("control sum_order_mutant on {:?}: {}", set, r.as_deref().unwrap_or("accepted"));
            caught += r.is_some() as usize;
        }
        assert!(caught > 0, "the check accepts a non-transitive mutant of sum_order");
    }

    #[test]
    fn factor_order_is_consistent() {
        for set in FACTOR_SETS {
            assert_eq!(inconsistency(mul_order, &exprs(set)), None, "mul_order on {:?}", set);
        }
        let mut caught = 0;
        for set in FACTOR_SETS {
            let r = inconsistency(mul_order_mutant, &exprs(set));
            eprintln!("control mul_order_mutant on {:?}: {}", set, r.as_deref().unwrap_or("accepted"));
            caught += r.is_some() as usize;
        }
        assert!(caught > 0, "the check accepts a non-transitive mutant of mul_order");
    }

    const RENDER_CASES: [&str; 9] = [
        "(y - 1/x)*x^2",
        "-(2/x - 3)/(y - 1/x)",
        "(1 - x)/y",
        "x - (1 - y)*z",
        "(b - a)*(d - c)",
        "a^2*b + a^2*x + 2*a*b*x + 2*a*x^2 + b*x^2 + x^3",
        "-(f*h - x*y)*a + (c*h - b*y)*d + (b*f - c*x)*g",
        "(x + 1)/(x - 1) + x*y*z",
        "1/((a + b)*c^2) - (p - q)^2",
    ];

    /// None if printing e leaves encode() byte-equal and the printed string re-parses to e, decided by
    /// expanding the difference to canonical form (no simplify); otherwise the failure
    fn render_failure(printer: fn(&Expr) -> String, s: &str) -> Option<String> {
        let e = parse(s);
        let before = crate::api::encode(&e);
        let p = printer(&e);
        let _ = to_latex(&e);
        if crate::api::encode(&e) != before {
            return Some(format!("printing changed the expression: {}", s));
        }
        let r = parse(&p);
        if crate::expand::expand(&sub(&r, &e)).is_zero() {
            None
        } else {
            Some(format!("{} printed as {}, which re-parses to a different value", s, p))
        }
    }

    /// the controls for (b): the real printer, then the first top-level " - " / " + " swapped (a
    /// flipped sign; the whole negated when there is no top-level sum), or the last top-level term
    /// dropped (" + 1" added when there is only one term)
    fn top_level_ops(p: &str) -> Vec<usize> {
        let (mut depth, mut v) = (0i32, vec![]);
        for (i, ch) in p.char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => depth -= 1,
                '+' | '-' if depth == 0 && i > 0 && p[..i].ends_with(' ') => v.push(i),
                _ => {}
            }
        }
        v
    }
    fn flip_sign_printer(e: &Expr) -> String {
        let p = to_string(e);
        match top_level_ops(&p).first() {
            Some(&i) => format!("{}{}{}", &p[..i], if &p[i..i + 1] == "-" { "+" } else { "-" }, &p[i + 1..]),
            None => format!("-({})", p),
        }
    }
    fn drop_term_printer(e: &Expr) -> String {
        let p = to_string(e);
        match top_level_ops(&p).last() {
            Some(&i) => p[..i - 1].to_string(),
            None => format!("{} + 1", p),
        }
    }

    #[test]
    fn printing_only_renders() {
        for s in RENDER_CASES {
            assert_eq!(render_failure(to_string, s), None);
        }
        for (name, m) in [("flip-sign", flip_sign_printer as fn(&Expr) -> String), ("drop-term", drop_term_printer)] {
            for s in RENDER_CASES {
                let r = render_failure(m, s);
                eprintln!("control {}: {}", name, r.as_deref().unwrap_or("accepted"));
                assert!(r.is_some(), "the check accepts the {} mutant on {}", name, s);
            }
        }
    }
}

#[cfg(test)]
mod print_memo_tests {
    //! The sorts of one print are memoized: a nested unexpanded product (an adjugate's entry) is sorted once
    //! per distinct subexpression, and prints exactly as without the memo.
    use super::*;
    use crate::parse::parse;

    /// ((...((x + 1)*(x + y) + 2)*(x + y) + 3)...): depth n
    fn nested(n: usize) -> Expr {
        let mut e = parse("x + 1");
        for k in 0..n {
            e = add(vec![mul2(&e, &parse("x + y")), int(k as i64 + 2)]);
        }
        e
    }

    fn sorts(f: impl FnOnce() -> String) -> (String, u64) {
        SORTS.with(|s| s.set(0));
        let r = f();
        (r, SORTS.with(|s| s.get()))
    }

    #[test]
    fn the_memo_prints_exactly_as_without_it() {
        for n in 0..7 {
            let e = nested(n);
            let (memo, _) = sorts(|| to_string(&e));
            let (plain, _) = sorts(|| sage(&e).0);
            assert_eq!(memo, plain, "depth {}", n);
            assert_eq!(to_latex(&e), latex(&e).0, "depth {}", n);
        }
        for s in ["(x + 1)*(x - 1)*sin(x + y) + (a + b)^2*(a - b)", "-(f*h - x*y)*a + (c*h - b*y)*d + (b*f - c*x)*g", "1/2*x^2/y + (x + 1)/(x - 1)"] {
            let e = parse(s);
            assert_eq!(to_string(&e), sage(&e).0, "{}", s);
        }
    }

    #[test]
    fn a_nested_product_is_sorted_once_per_subexpression() {
        // without the memo the sorts grow exponentially with the depth; with it, linearly
        let (_, s10) = sorts(|| to_string(&nested(10)));
        let (_, s20) = sorts(|| to_string(&nested(20)));
        let (_, s40) = sorts(|| to_string(&nested(40)));
        assert!(s40 - s20 <= 2 * (s20 - s10) + 8, "{} {} {}", s10, s20, s40);
        assert!(s40 < 40 * 12, "{}", s40);
        // and the memo is gone after the print
        assert!(MEMO.with(|m| m.borrow().is_none()));
    }
}
