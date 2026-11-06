//! Printing as Sage prints symbolic expressions, and Sage-style LaTeX.
//!
//! The operands of sums and products are stored in a canonical order
//! (expr.rs); here they are put in Sage's print order: sums by descending
//! degree with constants last (x^2 + 2*x + 1, x + sin(x) + 1), products
//! with sums first, then symbols, then functions ((x + 1)*x*sin(x)), and
//! negative powers as a denominator (1/2*x^2/y, 1/2/x, (x + 1)/(x - 1)).

use crate::expr::*;
use crate::num::{Num, Q};
use std::cell::RefCell;
use std::cmp::{Ordering, Reverse};
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







/// The order of the terms of a sum (Less: a is printed first): by the terms' keys.
pub fn sum_order(a: &Expr, b: &Expr) -> Ordering {
    sum_order_key(a, b)
}








/// The order of the factors of a product (Less: a is printed first): by the factors' keys.
pub fn mul_order(a: &Expr, b: &Expr) -> Ordering {
    mul_order_key(a, b)
}


fn sorted_terms(e: &Expr) -> Vec<Expr> {
    match &e.kind {
        Kind::Add(v) => memo(e, |m| &mut m.terms, || {
            let mut t = v.clone();
            sort_terms(&mut t);
            t
        }),
        _ => vec![e.clone()],
    }
}


// ------------------------------------------------------------------ Sage's print order
// One total order for the terms of a sum and the factors of a product, as Sage prints
// them (lane 4p; rules P0-P5 in sage2's spec, set by the counted Sage probe counted-3):
// Ordering::Greater = printed first.

/// an exact rational number
fn p_rat(e: &Expr) -> Option<Q> {
    e.as_num().filter(|n| n.is_exact() && n.is_real()).and_then(|n| n.as_rat().cloned())
}

/// a real number, exact or not, as a rational (x^1.5 has the exponent 3/2)
fn p_numq(e: &Expr) -> Option<Q> {
    match e.as_num()? {
        Num::Float(a, b) if *b == 0.0 => f64_q(*a),
        n => p_rat(&num(n.clone())),
    }
}

/// a finite double as the exact rational it is
fn f64_q(a: f64) -> Option<Q> {
    use sagebrush_bigint::BigInt;
    if !a.is_finite() {
        return None;
    }
    let bits = a.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i64;
    let m = if e == 0 { (bits & 0xf_ffff_ffff_ffff) << 1 } else { (bits & 0xf_ffff_ffff_ffff) | 0x10_0000_0000_0000 };
    let m = if bits >> 63 == 1 { -BigInt::from(m) } else { BigInt::from(m) };
    let e = e - 1075;
    Some(if e >= 0 { Q::from_integer(m << e as usize) } else { Q::new(m, BigInt::from(1) << (-e) as usize) })
}

/// P-pure: what the P order covers, for the terms of a sum and the factors of a
/// product alike (C0, C0b): symbols, pi and euler_gamma, numbers to a fractional power
/// (sqrt(2)), kernels, sums and products of these, and their rational powers
fn p_pure(e: &Expr) -> bool {
    match &e.kind {
        Kind::Sym(_) => true,
        Kind::Num(_) => false,
        Kind::Const(Const::Pi | Const::EulerGamma | Const::E) => true,
        Kind::Add(v) => v.iter().all(|t| { let r = split_coeff(t).1; r.is_one() || p_pure(&r) }),
        Kind::Mul(v) => v.iter().all(|f| f.is_num() || p_pure(f)),
        Kind::Pow(..) if p_kernel(e) => true,
        Kind::Pow(b, x) if x.as_i64().is_some() => p_pure(b),
        Kind::Pow(b, x) if p_numq(x).is_some() => p_numq(b).map_or(false, |r| r > Q::from_integer(0.into())) || p_pure(b),
        // a symbolic exponent (x^pi, x^y, 2^x, (x + 1)^y, 1.5^x)
        Kind::Pow(b, x) => !x.is_num() && p_pure(x) && (p_numq(b).map_or(false, |r| r > Q::from_integer(0.into())) || p_pure(b)),
        // a derivative of a function of P-pure arguments: after the kernels (Sage: sin(x) + diff(f(x), x))
        Kind::Fun(Fun::Deriv(..), args) => !args.is_empty() && args.iter().all(|a| a.as_num().map_or(false, |n| n.is_exact() && n.is_real()) || p_pure(a)),
        Kind::Fun(..) => p_kernel(e),
        _ => false,
    }
}

/// A function of P-pure arguments (or numbers), or e^u for such a u, or e (exp(1)):
/// a kernel, which Sage orders like a variable (C0's probes, order2-4): below the
/// symbols, by its name, then its arguments; a lone kernel as a term of a sum comes
/// after every other term.  Derivatives are left out.
fn p_kernel(e: &Expr) -> bool {
    let arg_ok = |a: &Expr| a.as_num().map_or(false, |n| n.is_exact() && n.is_real()) || p_pure(a);
    match &e.kind {
        Kind::Fun(f, args) => !matches!(f, Fun::Deriv(..)) && !args.is_empty() && args.iter().all(arg_ok),
        Kind::Pow(b, u) => b.is_const(Const::E) && arg_ok(u),
        Kind::Const(Const::E) => true,
        _ => false,
    }
}




/// a kernel's name and arguments (e^u: exp, [u])
fn p_kernel_parts(e: &Expr) -> (String, Vec<Expr>) {
    match &e.kind {
        Kind::Fun(f, args) => (f.name(), args.clone()),
        Kind::Pow(_, u) => ("exp".to_string(), vec![u.clone()]),
        Kind::Const(Const::E) => ("exp".to_string(), vec![one()]),
        _ => (String::new(), vec![]),
    }
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

fn p_be(f: &Expr) -> (Expr, Expr) {
    match &f.kind {
        Kind::Pow(..) if p_kernel(f) => (f.clone(), one()),
        // (a fractional or symbolic power keeps its base's sign: Sage's x*sqrt(-x + 1))
        Kind::Pow(b, x) => (if x.as_i64().is_some() { p_norm(b) } else { b.clone() }, x.clone()),
        _ => (p_norm(f), one()),
    }
}

/// P1: the degree; a sum factor counts its exponent (1), not its own degree
fn p_deg(e: &Expr) -> Q {
    let n = |k: i64| Q::from_integer(k.into());
    match &e.kind {
        Kind::Sym(_) | Kind::Add(_) | Kind::Fun(..) | Kind::Const(_) => n(1),
        Kind::Pow(..) if p_kernel(e) => n(1),
        // a symbolic exponent counts 1, or -1 when it is led by a negative term (x^pi, 2^x; 1/x^pi)
        Kind::Pow(_, x) => p_numq(x).unwrap_or_else(|| if split_coeff(&sorted_terms(x)[0]).0.looks_negative() { n(-1) } else { n(1) }),
        Kind::Mul(v) => v.iter().filter(|f| !f.is_num()).map(p_deg).fold(n(0), |a, b| a + b),
        _ => n(0),
    }
}

/// a product's factors (no number), smallest first (P2)
fn p_factors_up(e: &Expr) -> Vec<Expr> {
    memo(e, |m| &mut m.p_factors, || {
        let mut v: Vec<Expr> = match &e.kind {
            Kind::Mul(f) => f.iter().filter(|x| !x.is_num()).map(p_norm).collect(),
            _ => vec![p_norm(e)],
        };
        v.sort_by_cached_key(fkey);
        v
    })
}










// ------------------------------------------------------------------ the print order as keys
// One key per term (and per factor): Sage's print order is the order of the keys, compared
// lexicographically, so it is a total order by construction (C0, @sagebrush's ruling after
// daybreak3's reviews of #754). Greater = printed first. A term the P model does not cover
// gets a key of its own class (Other), ordered inside it by canon_cmp.

/// a number in a key (Num::cmp)
#[derive(Clone, Debug)]
struct NumK(Num);
impl PartialEq for NumK {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for NumK {}
impl PartialOrd for NumK {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for NumK {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0.cmp(&o.0)
    }
}

/// an expression in a key (canon_cmp)
#[derive(Clone, Debug)]
struct CanonK(Expr);
impl PartialEq for CanonK {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for CanonK {}
impl PartialOrd for CanonK {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for CanonK {
    fn cmp(&self, o: &Self) -> Ordering {
        canon_cmp(&self.0, &o.0)
    }
}

/// a sum as a key: its terms as printed (the greatest first), each a term key and a coefficient
type SKey = Vec<(TKey, NumK)>;

/// the key of a term (without its coefficient): its class first, in this order
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum TKey {
    /// the rest of a number term (1): last of all
    One,
    /// a term the P model does not cover
    Other(CanonK),
    /// a lone derivative: after the kernels
    Deriv(DKey),
    /// a lone kernel: after every other term
    Kernel(KKey),
    /// a product of powers: its degree, then its factors from the smallest (factor order), each by
    /// its base and then its exponent, the smaller exponent greater; then the longer greater
    Prod(Q, Vec<(BKey, EKey)>),
    /// a lone pi or euler_gamma (euler_gamma first): before every other term
    BareConst(u8),
}

/// an exponent in a term's factor: a number above a symbolic one, the smaller number greater
/// (x^2*y before x^3); symbolic ones as a kernel's argument (x > x^pi > x^x > x^(y + 1) > x^y)
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum EKey {
    Sym(AKey),
    Num(Reverse<Q>),
}

fn ekey(x: &Expr) -> EKey {
    match p_numq(x) {
        Some(q) => EKey::Num(Reverse(q)),
        None => EKey::Sym(akey(x)),
    }
}

/// an exponent in a product's factor: a number above a symbolic one, the larger number greater
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum FExp {
    Sym(AKey),
    Num(Q),
}

/// a derivative (Sage: diff(f(x), x) + diff(f(x), x, x) + diff(g(x, y), x) + diff(g(x, y), y)):
/// the alphabetically earlier function greater, then the fewer and smaller indices, then the arguments
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct DKey(Reverse<String>, Reverse<Vec<u32>>, Vec<AKey>);

fn dkey(e: &Expr) -> Option<DKey> {
    match &e.kind {
        Kind::Fun(Fun::Deriv(name, idx), args) => Some(DKey(Reverse(name.to_string()), Reverse(idx.clone()), args.iter().map(akey).collect())),
        _ => None,
    }
}

/// a kernel: the alphabetically earlier name greater, then its arguments one by one
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct KKey(Reverse<String>, Vec<AKey>);

/// a kernel's argument: a number above the rest, the larger first; otherwise its rest's terms
/// (as a sum key) closed by an end mark, then the larger coefficient. The end mark of a multiple
/// is above any term, a bare one's below: a multiple comes before a longer sum with the same
/// terms, a bare rest after it (Sage: sin(2*x) + sin(x + 1) + sin(x), sin(1/2*x) + sin(x + y))
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum AKey {
    Rest(Vec<AElem>, NumK),
    Num(NumK),
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum AElem {
    EndBare,
    Term(TKey, NumK),
    EndMultiple,
}

/// a base in a product: a kernel below all the rest; atoms by rank (number > euler_gamma > pi >
/// symbol) and value; an atom against a sum as the sum key of the atom alone
#[derive(Clone, Debug)]
enum BKey {
    Deriv(DKey),
    Kernel(KKey),
    Atom(u8, AtomV),
    Sum(SKey),
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum AtomV {
    Unit,
    Name(Reverse<String>),
    Num(NumK),
}

impl BKey {
    fn as_sum(&self) -> SKey {
        match self {
            BKey::Sum(s) => s.clone(),
            _ => vec![(TKey::Prod(q1(), vec![(self.clone(), EKey::Num(Reverse(q1())))]), NumK(Num::one()))],
        }
    }
}
impl PartialEq for BKey {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for BKey {}
impl PartialOrd for BKey {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for BKey {
    fn cmp(&self, o: &Self) -> Ordering {
        match (self, o) {
            (BKey::Deriv(a), BKey::Deriv(b)) => a.cmp(b),
            (BKey::Deriv(_), _) => Ordering::Less,
            (_, BKey::Deriv(_)) => Ordering::Greater,
            (BKey::Kernel(a), BKey::Kernel(b)) => a.cmp(b),
            (BKey::Kernel(_), _) => Ordering::Less,
            (_, BKey::Kernel(_)) => Ordering::Greater,
            (BKey::Atom(r, v), BKey::Atom(s, w)) => (r, v).cmp(&(s, w)),
            _ => self.as_sum().cmp(&o.as_sum()),
        }
    }
}

fn q1() -> Q {
    Q::from_integer(1.into())
}

/// an atom's rank and value, if e is one
fn atom_key(e: &Expr) -> Option<(u8, AtomV)> {
    match &e.kind {
        Kind::Num(n) => Some((3, AtomV::Num(NumK(n.clone())))),
        Kind::Const(Const::EulerGamma) => Some((2, AtomV::Unit)),
        Kind::Const(Const::Pi) => Some((1, AtomV::Unit)),
        Kind::Sym(s) => Some((0, AtomV::Name(Reverse(s.to_string())))),
        _ => None,
    }
}

/// the key of a term's rest (its coefficient split off)
fn tkey_term(e: &Expr) -> TKey {
    if e.is_one() {
        return TKey::One;
    }
    if !p_pure(e) {
        return TKey::Other(CanonK(e.clone()));
    }
    match &e.kind {
        Kind::Const(Const::EulerGamma) => TKey::BareConst(2),
        Kind::Const(Const::Pi) => TKey::BareConst(1),
        _ => tkey_p(e),
    }
}

/// the key of a P-pure expression that is not a sum, as a term of a comparison (no bare-constant
/// rule: pi is a power of an atom here)
fn tkey_p(e: &Expr) -> TKey {
    if let Some(d) = dkey(e) {
        return TKey::Deriv(d);
    }
    if p_kernel(e) {
        return TKey::Kernel(kkey(e));
    }
    let f = p_factors_up(e);
    TKey::Prod(p_deg(e), f.iter().map(|x| {
        let (b, k) = p_be(x);
        (bkey(&p_norm(&b)), ekey(&k))
    }).collect())
}

/// the key of a base (sign-normalized)
fn bkey(b: &Expr) -> BKey {
    if let Some(d) = dkey(b) {
        return BKey::Deriv(d);
    }
    if p_kernel(b) {
        return BKey::Kernel(kkey(b));
    }
    if let Some((r, v)) = atom_key(b) {
        return BKey::Atom(r, v);
    }
    BKey::Sum(gkey(b))
}

/// a general P-pure expression as a sum key: a sum's terms, or the expression as a one-term sum
fn gkey(e: &Expr) -> SKey {
    match &e.kind {
        Kind::Add(_) => skey(&p_norm(e)),
        _ => vec![(tkey_p(e), NumK(Num::one()))],
    }
}

fn skey(s: &Expr) -> SKey {
    sorted_terms(s).iter().map(|t| {
        let (c, r) = split_coeff(t);
        (tkey_term(&r), NumK(c))
    }).collect()
}

fn kkey(e: &Expr) -> KKey {
    let (name, args) = p_kernel_parts(e);
    KKey(Reverse(name), args.iter().map(akey).collect())
}

fn akey(u: &Expr) -> AKey {
    match u.as_num() {
        Some(n) => AKey::Num(NumK(n.clone())),
        None => {
            let (c, r) = split_coeff(u);
            let mut v: Vec<AElem> = gkey(&r).into_iter().map(|(t, n)| AElem::Term(t, n)).collect();
            v.push(if c.is_one() { AElem::EndBare } else { AElem::EndMultiple });
            AKey::Rest(v, NumK(c))
        }
    }
}

/// the key of a factor in a product (factor order): its base's class, then its exponent, the
/// higher greater
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum FBase {
    /// a factor the P model does not cover
    Other(CanonK),
    /// a derivative: after the kernels (sin(x)*diff(f(x), x))
    Deriv(DKey),
    /// a kernel: after the rest
    Kernel(KKey),
    /// a symbol or a sum, as a sum key (a fractional power keeps its sum's sign)
    Mid(SKey),
    /// a number, euler_gamma or pi: before the rest
    Konst(u8, AtomV),
}

fn fkey(f: &Expr) -> (FBase, FExp) {
    if !p_pure(f) {
        return (FBase::Other(CanonK(f.clone())), FExp::Num(q1()));
    }
    let f = p_norm(f);
    let (b, k) = p_be(&f);
    let base = if let Some(d) = dkey(&b) {
        FBase::Deriv(d)
    } else if p_kernel(&b) {
        FBase::Kernel(kkey(&b))
    } else {
        match atom_key(&b) {
            Some((r, v)) if r > 0 => FBase::Konst(r, v),
            Some(_) => FBase::Mid(vec![(tkey_p(&b), NumK(Num::one()))]),
            None => FBase::Mid(match &b.kind {
                Kind::Add(_) => skey(&b),
                _ => gkey(&b),
            }),
        }
    };
    (base, match p_numq(&k) { Some(q) => FExp::Num(q), None => FExp::Sym(akey(&k)) })
}

/// the terms of a sum in print order: each key computed once (the order of sum_order); the
/// number terms last without a key, and no key at all for a lone term besides them
fn sort_terms(v: &mut Vec<Expr>) {
    let (mut rest, nums): (Vec<Expr>, Vec<Expr>) = v.drain(..).partition(|t| !split_coeff(t).1.is_one());
    if rest.len() > 1 {
        rest.sort_by_cached_key(|t| {
            let (c, r) = split_coeff(t);
            (Reverse(tkey_term(&r)), Reverse(NumK(c)), CanonK(t.clone()))
        });
    }
    v.extend(rest);
    v.extend(nums);
}

/// the factors of a product in print order, each key computed once (the order of mul_order)
fn sort_factors(v: &mut Vec<Expr>) {
    if v.len() > 1 {
        v.sort_by_cached_key(|f| (Reverse(fkey(f)), CanonK(f.clone())));
    }
}

/// the order of the terms of a sum by the keys (Less: a is printed first)
pub fn sum_order_key(a: &Expr, b: &Expr) -> Ordering {
    let ((ca, ra), (cb, rb)) = (split_coeff(a), split_coeff(b));
    // a number term is TKey::One, below every other key: decided without the other's key (whose
    // computation walks the whole term: sqrt(sqrt(... + 1) + 1) nested 2000 deep)
    match (ra.is_one(), rb.is_one()) {
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    tkey_term(&rb).cmp(&tkey_term(&ra)).then_with(|| cb.cmp(&ca)).then_with(|| canon_cmp(a, b))
}

/// the order of the factors of a product by the keys (Less: a is printed first)
pub fn mul_order_key(a: &Expr, b: &Expr) -> Ordering {
    fkey(b).cmp(&fkey(a)).then_with(|| canon_cmp(a, b))
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
            sort_terms(&mut terms);
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
        Kind::Pow(b, x) if neg_led_power(b, x) == Some(true) => print_mul(&[e.clone()]),
        Kind::Pow(b, x) if neg_led_power(b, x) == Some(false) => print_pow(&neg(b), x, true),
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
    // (e to a number is exp(n) in Sage: e^(1/2), e^(-1), never sqrt(e) or 1/e)
    if let Some(n) = x.as_num().filter(|_| !b.is_const(Const::E)) {
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

/// a sum whose first printed term is negative (Sage prints it negated, the sign pulled out)
fn neg_led_sum(e: &Expr) -> bool {
    matches!(e.kind, Kind::Add(_)) && split_coeff(&sorted_terms(e)[0]).0.looks_negative()
}

/// an integer power of such a sum: Sage prints it of the negated sum, an odd power as a product
/// with the sign pulled out (-(pi - x)^3, -1/(pi - x)^3), an even one as a power ((pi - x)^(-2))
fn neg_led_power(b: &Expr, x: &Expr) -> Option<bool> {
    let k = x.as_i64()?;
    neg_led_sum(b).then_some(k % 2 != 0)
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
        if x.as_num().map_or(false, |n| n.is_negative()) && !b.is_const(Const::E) {
            denom.push(pow(&b, &neg(&x)));
        } else {
            numer.push(f.clone());
        }
    }

    // a sum factor led by a negative term prints negated, its sign pulled out
    // (Sage: -(x - 1)/y, -(2/x - 3)/(y - 1/x); render only, the expression is unchanged)
    for f in numer.iter_mut().chain(denom.iter_mut()) {
        if neg_led_sum(f) {
            *f = neg(f);
            coeff = coeff.neg();
        } else if let Kind::Pow(b, x) = &f.kind {
            // and an integer power of one: (x - pi)^3 prints -(pi - x)^3, (x - pi)^2 as (pi - x)^2
            if let (true, Some(k)) = (neg_led_sum(b), x.as_i64()) {
                if k % 2 != 0 {
                    coeff = coeff.neg();
                }
                *f = pow(&neg(b), x);
            }
        }
    }
    sort_factors(&mut numer);
    sort_factors(&mut denom);
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
            sort_terms(&mut terms);
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
        Kind::Pow(b, x) if neg_led_power(b, x) == Some(true) => latex_mul(&[e.clone()]),
        Kind::Pow(b, x) if neg_led_power(b, x) == Some(false) => latex_pow(&neg(b), x, true),
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
    if let Some(r) = x.as_rat().filter(|_| !b.is_const(Const::E)) {
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
    let pos_rat = x.as_rat().map_or(false, |r| r > &crate::num::q(0));
    let ex = if b.is_const(Const::E) && ex.1 < P_ATOM && !pos_rat { format!("\\left({}\\right)", ex.0) } else { ex.0 };
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
        if x.as_num().map_or(false, |n| n.is_negative()) && !b.is_const(Const::E) {
            denom.push(pow(&b, &neg(&x)));
        } else {
            numer.push(f.clone());
        }
    }

    // a sum factor led by a negative term prints negated, its sign pulled out
    // (Sage: -(x - 1)/y, -(2/x - 3)/(y - 1/x); render only, the expression is unchanged)
    for f in numer.iter_mut().chain(denom.iter_mut()) {
        if neg_led_sum(f) {
            *f = neg(f);
            coeff = coeff.neg();
        } else if let Kind::Pow(b, x) = &f.kind {
            // and an integer power of one: (x - pi)^3 prints -(pi - x)^3, (x - pi)^2 as (pi - x)^2
            if let (true, Some(k)) = (neg_led_sum(b), x.as_i64()) {
                if k % 2 != 0 {
                    coeff = coeff.neg();
                }
                *f = pow(&neg(b), x);
            }
        }
    }
    sort_factors(&mut numer);
    sort_factors(&mut denom);
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

    const TERM_SETS: [&[&str]; 10] = [
        // daybreak3's review of #754 (a cycle before C0's boundary covered every kind of term)
        &["sin(x)^2", "(x + 1)*sin(x)", "x^2"],
        &["x^2", "cos(x)^2", "(cos(x) + 1)*sin(x)", "x*e^x", "sqrt(2)*x", "pi"],
        &["sqrt(x)", "sqrt(sin(x))", "x^(3/2)", "sin(x)/x", "1/x", "e"],
        &["pi*x", "a*x", "y*cos(x)", "(y - 1)*cos(x)", "x/(x + 1)", "sin(1)"],
        &["a^2*b", "a^2*x", "2*a*b*x", "2*a*x^2", "b*x^2", "x^3"],
        &["(x + y)*x", "x^2", "x*y", "y^2", "(x - 1)*x"],
        &["a*b", "(a + b)*c", "a*c", "c*d", "(a - b)*c"],
        &["(a^2 - b^2)*a", "a*b^2", "a^3", "b^3"],
        &["b*y", "c*h", "f*h", "x*y", "a*d", "b*c"],
        &["(p^2 + q)*r", "p*q*r", "p^2*r", "q^3"],
    ];
    const FACTOR_SETS: [&[&str]; 7] = [
        // C0b: constants, e, kernels, sums and their fractional powers together
        &["x", "e", "cos(x)", "pi", "euler_gamma", "sqrt(2)"],
        &["x^2 + 1", "pi", "x^2 - y", "sqrt(-x + 1)", "x", "(x - 1)^3"],
        &["e^x + 1", "e^(2*x)", "sin(1)", "sqrt(log(2))", "log(x)", "f(x)"],
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

    /// a pool of every kind of term (symbols, kernels, products and sums with kernels, e, pi,
    /// radicals, rational powers, quotients): sum_order has no cycle on any triple
    const POOL: &[&str] = &[
        "x", "y", "x^2", "x*y", "y^2", "x^3", "2*x", "a", "a*x",
        "sin(x)", "sin(x)^2", "cos(x)", "cos(x)^2", "sin(2*x)", "e^x", "e^(2*x)", "log(x)", "f(x)", "sin(y)",
        "x*sin(x)", "x^2*sin(x)", "sin(x)*cos(x)", "x*e^x", "y*cos(x)", "sin(1)", "cos(x)^3",
        "(x + 1)*sin(x)", "(cos(x) + 1)*sin(x)", "(x + 1)*e^x", "(x + 1)^2*sin(x)", "(y - 1)*cos(x)", "(sin(x) + 1)*x",
        "sqrt(x)", "x^(3/2)", "1/x", "sin(x)/x", "x/(x + 1)", "sqrt(2)*x", "pi*x", "sin(x)^(1/2)",
        "e", "pi", "euler_gamma", "sqrt(2)", "2^(1/3)", "pi^2", "sqrt(2)*pi", "e*x", "e^2",
    ];

    fn triple_cycles(cmp: Cmp, xs: &[Expr]) -> (usize, Option<String>) {
        let mut n = 0;
        let mut first = None;
        for a in xs {
            for b in xs {
                if cmp(a, b) == Ordering::Greater {
                    continue;
                }
                for c in xs {
                    if cmp(b, c) != Ordering::Greater && cmp(a, c) == Ordering::Greater {
                        n += 1;
                        first.get_or_insert_with(|| format!("{} <= {} <= {}", to_string(a), to_string(b), to_string(c)));
                    }
                }
            }
        }
        (n, first)
    }

    #[test]
    fn term_order_is_total_on_the_pool() {
        let xs = exprs(POOL);
        let (n, first) = triple_cycles(sum_order, &xs);
        assert_eq!(n, 0, "sum_order cycles on the pool, first: {:?}", first);
        let (m, _) = triple_cycles(sum_order_mutant, &xs);
        assert!(m > 0, "the pool check accepts a non-transitive mutant of sum_order");
    }

    /// random terms (a fixed seed): symbols, constants, kernels, rational, float and symbolic
    /// exponents, nested sums and terms the P model leaves out
    fn random_terms(seed: u64, n: usize) -> Vec<Expr> {
        let mut st = seed;
        let mut next = move |k: usize| -> usize {
            st ^= st << 13;
            st ^= st >> 7;
            st ^= st << 17;
            (st % k as u64) as usize
        };
        const ATOMS: &[&str] = &["x", "y", "a", "pi", "euler_gamma", "e", "sqrt(2)", "2^(1/3)", "sin(x)", "cos(x)", "sin(y)", "e^x", "e^(2*x)",
            "log(x)", "f(x)", "f(x, y)", "(x + 1)", "(y - 1)", "(cos(x) + 1)", "(x + pi)", "(x^2 - y)", "sin(1)", "sin(x + 1)", "e^(x^y)",
            "sin(1.5*x)", "x^I", "sin(I)", "2^x", "pi^x", "abs(x)", "(sin(x) + x)"];
        const EXPS: &[&str] = &["1", "1", "1", "2", "3", "-1", "-2", "1/2", "3/2", "-1/2", "pi", "y", "x", "1.5", "(y + 1)", "-x"];
        const COEFS: &[&str] = &["1", "1", "2", "-3", "1/2", "-2/3", "1.5", "I"];
        let mut out = vec![];
        while out.len() < n {
            let k = 1 + next(3);
            let mut t = COEFS[next(COEFS.len())].to_string();
            for _ in 0..k {
                t = format!("{}*{}^({})", t, ATOMS[next(ATOMS.len())], EXPS[next(EXPS.len())]);
            }
            let e = parse(&t);
            if !e.is_num() {
                out.push(e);
            }
        }
        out
    }

    #[test]
    fn orders_are_total_on_random_terms() {
        for seed in [1u64, 7, 20261106] {
            let xs = random_terms(seed, 70);
            for (name, cmp) in [("sum_order", sum_order as Cmp), ("mul_order", mul_order as Cmp)] {
                for a in &xs {
                    for b in &xs {
                        assert_eq!(cmp(a, b), cmp(b, a).reverse(), "{} antisymmetry {} / {}", name, to_string(a), to_string(b));
                    }
                }
                let (n, first) = triple_cycles(cmp, &xs);
                assert_eq!(n, 0, "{} cycles on random terms (seed {}), first: {:?}", name, seed, first);
                // every shuffle of a random 8-term set sorts to one order
                for start in (0..xs.len() - 8).step_by(9) {
                    let set = &xs[start..start + 8];
                    let mut base: Vec<Expr> = set.to_vec();
                    base.sort_by(cmp);
                    let mut v = set.to_vec();
                    for r in 0..12 {
                        v.rotate_left(1 + r % 5);
                        v.swap(r % 8, (3 * r + 1) % 8);
                        let mut w = v.clone();
                        w.sort_by(cmp);
                        assert!(w == base, "{}: the input order changes the sort", name);
                    }
                }
            }
            let (m, _) = triple_cycles(sum_order_mutant, &xs);
            assert!(m > 0, "the random check accepts a non-transitive mutant of sum_order");
        }
    }

    #[test]
    fn factor_order_is_total_on_the_pool() {
        let xs = exprs(POOL);
        let (n, first) = triple_cycles(mul_order, &xs);
        assert_eq!(n, 0, "mul_order cycles on the pool, first: {:?}", first);
        let (m, _) = triple_cycles(mul_order_mutant, &xs);
        assert!(m > 0, "the pool check accepts a non-transitive mutant of mul_order");
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
