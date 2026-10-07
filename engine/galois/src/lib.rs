//! Galois groups of irreducible polynomials over Q, of degree up to 12, as
//! transitive groups nTk in the standard numbering (clean-room, MIT OR
//! Apache-2.0; PARI, Magma and GAP were used only as oracles for testing).
//!
//! The method (Stauduhar's descent with p-adic roots, as in Geissler and
//! Klueners, "Galois group computation for rational polynomials", J.
//! Symbolic Comput. 30 (2000), and Fieker and Klueners, "Computation of
//! Galois groups of rational polynomials", LMS J. Comput. Math. 17 (2014)):
//!
//! 1. The cycle types of Frobenius elements: for primes p not dividing the
//!    discriminant, the degrees of the factors of f mod p form the cycle
//!    type of an element of Gal(f) (Dedekind).  With the parity of Gal(f)
//!    (is the discriminant a square?) this leaves the candidates: the
//!    transitive groups having all those cycle types and that parity.
//!    Gal(f) is one of them; if only one is left, that is the answer.
//! 2. Otherwise descend from G = Sym(n) or Alt(n): the roots of f are
//!    computed p-adically, in the unramified extension of Q_p of degree D
//!    (the lcm of the factor degrees mod p), so that the Frobenius acts on
//!    them as a known permutation.  For each maximal transitive subgroup K
//!    of G (from our tables) whose type is a candidate, a polynomial F in n
//!    variables with stabilizer K in G (a K-orbit sum of a monomial) is
//!    evaluated at the roots permuted by representatives s of the cosets
//!    sK of K in G.  Gal(f) <= s K s^-1 forces the value to be a rational
//!    integer of known size, so a value that is not one rules out that
//!    conjugate, rigorously.  Only cosets fixed by the Frobenius can work
//!    ("short cosets").  If some value is an integer (and differs from the
//!    other values), Gal(f) <= s K s^-1: renumber the roots and continue
//!    with G = K.  If no maximal subgroup takes it, Gal(f) = G.
//!    Repeated values are separated by a Tschirnhausen transformation.
//!
//! `proven` is true when every step is rigorous: when the cycle types alone
//! decide, or when each descent step's value is proven to be an integer
//! (a norm bound with the p-adic precision raised accordingly) and to
//! differ from the values at all other cosets.  Otherwise (large indices)
//! the result is what the numerical evidence says, with an error
//! probability far below 2^-40 per step, like Magma's GaloisGroup before
//! GaloisProof.

pub mod fq;
pub mod tables;
pub mod zq;

use fq::{El, Fq};
use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;
use sagebrush_group::{Group, Perm};
use std::collections::{HashMap, HashSet};
use tables::{transitive_groups, TGroup};
use zq::{Elt, Zq};

#[derive(Clone, Debug)]
pub struct GaloisGroup {
    pub degree: usize,
    /// k, for the transitive group nTk
    pub number: usize,
    pub order: u64,
    pub name: String,
    pub proven: bool,
    /// what was done, step by step
    pub log: Vec<String>,
}

impl GaloisGroup {
    pub fn label(&self) -> String {
        format!("{}T{}", self.degree, self.number)
    }
}

// ------------------------------------------------------------ permutations as functions

/// a o b: i -> a(b(i))
fn comp(a: &Perm, b: &Perm) -> Perm {
    b.mul(a)
}

/// x^-1 o h o x
fn conjf(h: &Perm, x: &Perm) -> Perm {
    comp(&x.inv(), &comp(h, x))
}

fn centralizer_order(t: &[usize]) -> f64 {
    let mut mult: HashMap<usize, u32> = HashMap::new();
    for &l in t {
        *mult.entry(l).or_default() += 1;
    }
    mult.iter().map(|(&l, &m)| (l as f64).powi(m as i32) * (1..=m).map(|i| i as f64).product::<f64>()).product()
}

// ------------------------------------------------------------ integers

/// The determinant of an integer matrix (Bareiss).
fn det(mut a: Vec<Vec<BigInt>>) -> BigInt {
    let n = a.len();
    let mut sign = BigInt::one();
    let mut prev = BigInt::one();
    for k in 0..n {
        if a[k][k].is_zero() {
            match (k + 1..n).find(|&i| !a[i][k].is_zero()) {
                Some(i) => {
                    a.swap(i, k);
                    sign = -sign;
                }
                None => return BigInt::zero(),
            }
        }
        for i in k + 1..n {
            for j in k + 1..n {
                let v = &a[i][j] * &a[k][k] - &a[i][k] * &a[k][j];
                a[i][j] = v / &prev;
            }
        }
        prev = a[k][k].clone();
    }
    sign * &a[n - 1][n - 1]
}

/// The discriminant of a monic polynomial: (-1)^(n(n-1)/2) Res(f, f').
pub fn discriminant(f: &[BigInt]) -> BigInt {
    let n = f.len() - 1;
    if n < 1 {
        return BigInt::zero();
    }
    if n == 1 {
        return BigInt::one();
    }
    let df: Vec<BigInt> = f.iter().enumerate().skip(1).map(|(i, c)| c * BigInt::from(i as u64)).collect();
    let size = 2 * n - 1;
    let mut s = vec![vec![BigInt::zero(); size]; size];
    // rows: n-1 shifts of f, n shifts of f' (coefficients highest first)
    for r in 0..n - 1 {
        for (i, c) in f.iter().rev().enumerate() {
            s[r][r + i] = c.clone();
        }
    }
    for r in 0..n {
        for (i, c) in df.iter().rev().enumerate() {
            s[n - 1 + r][r + i] = c.clone();
        }
    }
    let res = det(s);
    if (n * (n - 1) / 2) % 2 == 1 {
        -res
    } else {
        res
    }
}

fn is_square(d: &BigInt) -> bool {
    if d.is_negative() {
        return false;
    }
    let r = d.sqrt();
    &(&r * &r) == d
}

/// log2 of an upper bound for |a|.
fn log2_bound(a: &BigInt) -> f64 {
    if a.is_zero() {
        f64::NEG_INFINITY
    } else {
        a.abs().bits() as f64
    }
}

/// log2 of Fujiwara's bound on the absolute values of the roots of a monic f.
fn root_bound_log2(f: &[BigInt]) -> f64 {
    let n = f.len() - 1;
    let mut m = f64::NEG_INFINITY;
    for i in 1..=n {
        let mut l = log2_bound(&f[n - i]);
        if i == n {
            l -= 1.0;
        }
        m = m.max(l / i as f64);
    }
    1.0 + m.max(0.0)
}

fn primes_from(mut p: u64) -> impl Iterator<Item = u64> {
    std::iter::from_fn(move || {
        loop {
            p += 1;
            if p > 2 && (2..).take_while(|d| d * d <= p).all(|d| p % d != 0) {
                return Some(p);
            }
        }
    })
}

// ------------------------------------------------------------ invariants

/// F = the sum of a K-orbit of monomials prod x_i^e_i (terms), or, if
/// `diffs` is not empty, F = prod (x_a - x_b) over the pairs (a, b) in it.
#[derive(Clone, Debug)]
struct Invariant {
    terms: Vec<Vec<(u8, u8)>>,
    degree: u32,
    max_exp: u8,
    diffs: Vec<(u8, u8)>,
}

impl Invariant {
    /// log2 of a bound for |F| when the roots are bounded by 2^log2_root
    fn log2_bound(&self, log2_root: f64) -> f64 {
        if self.diffs.is_empty() {
            (self.terms.len() as f64).log2() + self.degree as f64 * log2_root
        } else {
            self.diffs.len() as f64 * (log2_root + 1.0)
        }
    }
    /// a rough cost of one evaluation
    fn cost(&self, log2_root: f64) -> f64 {
        let words = 1.0 + self.log2_bound(log2_root) / 64.0;
        let mults = if self.diffs.is_empty() { (self.terms.len() * self.degree as usize) as f64 } else { self.diffs.len() as f64 };
        mults * words * words
    }
    /// F o s as a canonical form: (sorted terms, sign) or (sorted pairs, sign)
    fn image_key(&self, s: &Perm) -> (Vec<Vec<(u8, u8)>>, bool) {
        if self.diffs.is_empty() {
            let mut v: Vec<Vec<(u8, u8)>> = self.terms.iter().map(|m| act(m, s)).collect();
            v.sort();
            (v, false)
        } else {
            let (v, odd) = act_pairs(&self.diffs, s);
            (vec![v.into_iter().map(|(a, b)| (a, b)).collect()], odd)
        }
    }
}

/// The oriented pairs mapped by g, normalized to a < b, sorted, and whether
/// an odd number of them were reversed.
fn act_pairs(ps: &[(u8, u8)], g: &Perm) -> (Vec<(u8, u8)>, bool) {
    let mut odd = false;
    let mut v: Vec<(u8, u8)> = ps
        .iter()
        .map(|&(a, b)| {
            let (x, y) = (g.image(a as u32) as u8, g.image(b as u32) as u8);
            if x < y {
                (x, y)
            } else {
                odd = !odd;
                (y, x)
            }
        })
        .collect();
    v.sort_unstable();
    (v, odd)
}

/// A product of differences prod (x_a - x_b) over unions of one or two
/// K-orbits of pairs, invariant under K but not under G (sign characters).
fn find_difference_product(n: usize, g: &Group, k: &Group) -> Option<Vec<(u8, u8)>> {
    let mut seen = vec![vec![false; n]; n];
    let mut orbits: Vec<Vec<(u8, u8)>> = vec![];
    for a in 0..n {
        for b in a + 1..n {
            if seen[a][b] {
                continue;
            }
            let o = orbit(vec![(a as u8, 1), (b as u8, 1)], &k.gens, usize::MAX).unwrap_or_else(|e| e);
            let pairs: Vec<(u8, u8)> = o.iter().map(|m| (m[0].0, m[1].0)).collect();
            for &(x, y) in &pairs {
                seen[x as usize][y as usize] = true;
            }
            orbits.push(pairs);
        }
    }
    let ok = |p: &Vec<(u8, u8)>| -> bool {
        let mut sorted = p.clone();
        sorted.sort_unstable();
        // K-invariant: each generator maps the set to itself with an even number of reversals
        let kinv = k.gens.iter().all(|x| {
            let (v, odd) = act_pairs(&sorted, x);
            v == sorted && !odd
        });
        kinv && g.gens.iter().any(|x| {
            let (v, odd) = act_pairs(&sorted, x);
            v != sorted || odd
        })
    };
    let mut best: Option<Vec<(u8, u8)>> = None;
    let mut consider = |p: Vec<(u8, u8)>| {
        if best.as_ref().map_or(true, |b| p.len() < b.len()) && ok(&p) {
            best = Some(p);
        }
    };
    for i in 0..orbits.len() {
        consider(orbits[i].clone());
        for j in i + 1..orbits.len() {
            let mut p = orbits[i].clone();
            p.extend(orbits[j].iter().copied());
            consider(p);
        }
    }
    best
}

fn act(m: &[(u8, u8)], g: &Perm) -> Vec<(u8, u8)> {
    let mut v: Vec<(u8, u8)> = m.iter().map(|&(i, e)| (g.image(i as u32) as u8, e)).collect();
    v.sort_unstable();
    v
}

/// The orbit of a monomial under the group generated by gens: Ok if it has
/// at most `cap` elements, else Err with the part found.
fn orbit(m: Vec<(u8, u8)>, gens: &[Perm], cap: usize) -> Result<Vec<Vec<(u8, u8)>>, Vec<Vec<(u8, u8)>>> {
    let mut seen: HashSet<Vec<(u8, u8)>> = HashSet::new();
    seen.insert(m.clone());
    let mut out = vec![m];
    let mut i = 0;
    while i < out.len() {
        for g in gens {
            let x = act(&out[i], g);
            if seen.insert(x.clone()) {
                if out.len() >= cap {
                    return Err(out);
                }
                out.push(x);
            }
        }
        i += 1;
    }
    Ok(out)
}

/// Monomials with the exponents `pattern` (largest first) placed on distinct
/// points, at most `limit` of them.
fn placements(n: usize, pattern: &[u8], limit: usize) -> Vec<Vec<(u8, u8)>> {
    let mut out = vec![];
    fn rec(n: usize, pattern: &[u8], cur: &mut Vec<(u8, u8)>, used: &mut Vec<bool>, out: &mut Vec<Vec<(u8, u8)>>, limit: usize) {
        if out.len() >= limit {
            return;
        }
        let i = cur.len();
        if i == pattern.len() {
            let mut v = cur.clone();
            v.sort_unstable();
            out.push(v);
            return;
        }
        // equal exponents: increasing points
        let start = if i > 0 && pattern[i] == pattern[i - 1] { cur[i - 1].0 as usize + 1 } else { 0 };
        for x in start..n {
            if !used[x] {
                used[x] = true;
                cur.push((x as u8, pattern[i]));
                rec(n, pattern, cur, used, out, limit);
                cur.pop();
                used[x] = false;
            }
        }
    }
    rec(n, pattern, &mut vec![], &mut vec![false; n], &mut out, limit);
    out
}

/// An invariant F with Stab_G(F) = K, for K maximal in G: an orbit sum
/// of monomials or a product of differences that G does not preserve, the
/// cheapest we find.
fn find_invariant(n: usize, g: &Group, k: &Group, log2_root: f64) -> Invariant {
    let mut patterns: Vec<Vec<u8>> = vec![];
    for s in 2..n {
        patterns.push(vec![1; s]);
        let mut p = vec![1u8; s];
        p[0] = 2;
        patterns.push(p);
    }
    for s in 3..n {
        patterns.push((1..=s as u8).rev().collect());
    }
    patterns.sort_by_key(|p| (p.iter().map(|&e| e as u32).sum::<u32>(), p.len()));
    let mut best: Option<Invariant> = find_difference_product(n, g, k).map(|d| Invariant { terms: vec![], degree: d.len() as u32, max_exp: 1, diffs: d });
    let cap = 20_000;
    // monomials: up to two degrees past the first that works (and degree 6
    // if a product of differences works already)
    let mut first: Option<u32> = if best.is_some() { Some(4) } else { None };
    for pat in &patterns {
        let degree: u32 = pat.iter().map(|&e| e as u32).sum();
        if first.map_or(false, |d| degree > d + 2) {
            break;
        }
        let mut seen: HashSet<Vec<(u8, u8)>> = HashSet::new();
        for m in placements(n, pat, 20_000) {
            if seen.contains(&m) {
                continue;
            }
            let o = match orbit(m, &k.gens, cap) {
                Ok(o) => o,
                Err(part) => {
                    // too big: skip the rest of this orbit too
                    seen.extend(part);
                    continue;
                }
            };
            seen.extend(o.iter().cloned());
            let set: HashSet<&Vec<(u8, u8)>> = o.iter().collect();
            let invariant_under_g = g.gens.iter().all(|x| o.iter().all(|t| set.contains(&act(t, x))));
            if !invariant_under_g {
                first = Some(first.map_or(degree, |d| d.min(degree)));
                let c = Invariant { terms: o, degree, max_exp: pat[0], diffs: vec![] };
                if best.as_ref().map_or(true, |b| c.cost(log2_root) < b.cost(log2_root)) {
                    best = Some(c);
                }
            }
        }
    }
    if let Some(b) = best {
        return b;
    }
    // the generic one: x_1^(n-1) x_2^(n-2) ... has trivial stabilizer
    let m: Vec<(u8, u8)> = (0..n - 1).map(|i| (i as u8, (n - 1 - i) as u8)).collect();
    let terms = orbit(m, &k.gens, usize::MAX).unwrap_or_else(|e| e);
    Invariant { terms, degree: (n * (n - 1) / 2) as u32, max_exp: (n - 1) as u8, diffs: vec![] }
}

// ------------------------------------------------------------ cosets

/// The canonical representative of the coset s o K (minimal images of K's base).
fn canonical(s: &Perm, k: &Group) -> Perm {
    let mut s = s.clone();
    for lv in &k.chain.levels {
        let best = lv.orbit.iter().copied().min_by_key(|&p| s.image(p)).unwrap();
        let u = &lv.trans[best as usize].as_ref().unwrap().0;
        s = comp(&s, u);
    }
    s
}

/// Representatives of all cosets s o K in G, if there are at most `limit`.
fn transversal(g: &Group, k: &Group, limit: usize) -> Option<Vec<Perm>> {
    let id = Perm::identity(g.n);
    let first = canonical(&id, k);
    let mut seen: HashSet<Perm> = HashSet::new();
    seen.insert(first.clone());
    let mut reps = vec![first];
    let mut i = 0;
    while i < reps.len() {
        sagebrush_interrupt::check();
        for x in &g.gens {
            let c = canonical(&comp(x, &reps[i]), k);
            if seen.insert(c.clone()) {
                if reps.len() >= limit {
                    return None;
                }
                reps.push(c);
            }
        }
        i += 1;
    }
    Some(reps)
}

/// For G = Sym(n) or Alt(n): representatives of the cosets s o K fixed by
/// the permutation pi (s^-1 pi s in K), through the elements of K
/// conjugate to pi in Sym(n).
fn fixed_cosets_sym(g: &Group, alt: bool, k: &Group, pi: &Perm) -> Result<Vec<Perm>, String> {
    let n = g.n;
    let ty = pi.cycle_type();
    let els = k.elements(5_000_000).ok_or("the subgroup is too large for the short coset search")?;
    // classes of K of pi's cycle type
    let mut seen: HashSet<Perm> = HashSet::new();
    let mut reps: Vec<Perm> = vec![];
    for e in els.iter().filter(|e| e.cycle_type() == ty) {
        if seen.contains(e) {
            continue;
        }
        reps.push(e.clone());
        let mut orb = vec![e.clone()];
        seen.insert(e.clone());
        let mut i = 0;
        while i < orb.len() {
            for x in &k.gens {
                let c = conjf(&orb[i], x);
                if seen.insert(c.clone()) {
                    orb.push(c);
                }
            }
            i += 1;
        }
    }
    let pcycles = cycles_with_fixed(pi);
    let mut keys: HashSet<Perm> = HashSet::new();
    let mut out = vec![];
    for kk in reps {
        // all s with s o kk = pi o s: map the cycles of kk onto those of pi
        let kc = cycles_with_fixed(&kk);
        let mut s = vec![u32::MAX; n];
        let mut used = vec![false; pcycles.len()];
        fn rec(i: usize, kc: &[Vec<u32>], pc: &[Vec<u32>], used: &mut Vec<bool>, s: &mut Vec<u32>, found: &mut dyn FnMut(&Perm)) {
            if i == kc.len() {
                found(&Perm(s.clone()));
                return;
            }
            let l = kc[i].len();
            for j in 0..pc.len() {
                if used[j] || pc[j].len() != l {
                    continue;
                }
                used[j] = true;
                for off in 0..l {
                    for (t, &c) in kc[i].iter().enumerate() {
                        s[c as usize] = pc[j][(off + t) % l];
                    }
                    rec(i + 1, kc, pc, used, s, found);
                }
                used[j] = false;
            }
        }
        rec(0, &kc, &pcycles, &mut used, &mut s, &mut |s: &Perm| {
            if alt && s.sign() != 1 {
                return;
            }
            let c = canonical(s, k);
            if keys.insert(c.clone()) {
                out.push(c);
            }
        });
    }
    Ok(out)
}

/// Cycles including fixed points, each in order x, p(x), p(p(x)), ...
fn cycles_with_fixed(p: &Perm) -> Vec<Vec<u32>> {
    let n = p.degree();
    let mut seen = vec![false; n];
    let mut out = vec![];
    for s in 0..n as u32 {
        if seen[s as usize] {
            continue;
        }
        let mut c = vec![];
        let mut x = s;
        while !seen[x as usize] {
            seen[x as usize] = true;
            c.push(x);
            x = p.image(x);
        }
        out.push(c);
    }
    out
}

// ------------------------------------------------------------ the roots

struct Roots {
    f: Vec<BigInt>,
    fq: Fq,
    /// the roots mod p, in the current numbering
    r0: Vec<El>,
    /// Tschirnhausen transformation applied to the roots (None: identity)
    tsch: Option<Vec<BigInt>>,
    log2_root: f64,
    zq: Zq,
    lifted: Vec<Elt>,
    /// the Frobenius in the current numbering: Frob(r_i) = r_pi(i)
    pi: Perm,
}

impl Roots {
    fn log2_bound(&self) -> f64 {
        match &self.tsch {
            None => self.log2_root,
            Some(t) => {
                let b = self.log2_root;
                // log2 sum |c_j| B^j
                let mut m = f64::NEG_INFINITY;
                let terms: Vec<f64> = t.iter().enumerate().filter(|(_, c)| !c.is_zero()).map(|(j, c)| log2_bound(c) + j as f64 * b).collect();
                for &x in &terms {
                    m = m.max(x);
                }
                m + (terms.len() as f64).log2() + 1.0
            }
        }
    }

    /// The roots to precision k (at least), transformed.
    fn at(&mut self, k: u32) -> &Vec<Elt> {
        if self.lifted.is_empty() || self.zq.k < k {
            self.zq = Zq::new(&self.fq, k);
            let zq = &self.zq;
            self.lifted = self.r0.iter().map(|r| zq.lift_root(&self.fq, &self.f, r)).collect();
            if let Some(t) = &self.tsch {
                self.lifted = self.lifted.iter().map(|r| zq.eval(t, r)).collect();
            }
        }
        &self.lifted
    }

    /// The roots to precision k, without keeping them.
    fn lifted(&self, k: u32) -> (Zq, Vec<Elt>) {
        let zq = Zq::new(&self.fq, k);
        let mut rs: Vec<Elt> = self.r0.iter().map(|r| zq.lift_root(&self.fq, &self.f, r)).collect();
        if let Some(t) = &self.tsch {
            rs = rs.iter().map(|r| zq.eval(t, r)).collect();
        }
        (zq, rs)
    }

    fn renumber(&mut self, s: &Perm) {
        let n = self.r0.len();
        self.r0 = (0..n).map(|i| self.r0[s.image(i as u32) as usize].clone()).collect();
        if !self.lifted.is_empty() {
            self.lifted = (0..n).map(|i| self.lifted[s.image(i as u32) as usize].clone()).collect();
        }
        self.pi = conjf(&self.pi, s);
    }

    fn set_tschirnhausen(&mut self, t: Option<Vec<BigInt>>) {
        self.tsch = t;
        self.lifted.clear();
    }
}

/// F(r o s) = sum over the terms of prod r_s(i)^e (or the product of differences).
fn evaluate(zq: &Zq, pows: &[Vec<Elt>], inv: &Invariant, s: &Perm) -> Elt {
    if !inv.diffs.is_empty() {
        let mut acc = zq.scalar(&BigInt::one());
        for &(a, b) in &inv.diffs {
            let d = zq.sub(&pows[s.image(a as u32) as usize][1], &pows[s.image(b as u32) as usize][1]);
            acc = zq.mul(&acc, &d);
        }
        return acc;
    }
    let mut acc = zq.zero();
    for t in &inv.terms {
        let mut prod: Option<Elt> = None;
        for &(i, e) in t {
            let x = &pows[s.image(i as u32) as usize][e as usize];
            prod = Some(match prod {
                None => x.clone(),
                Some(p) => zq.mul(&p, x),
            });
        }
        acc = zq.add(&acc, &prod.unwrap());
    }
    acc
}

fn powers(zq: &Zq, roots: &[Elt], max_exp: u8) -> Vec<Vec<Elt>> {
    roots
        .iter()
        .map(|r| {
            let mut v = vec![zq.scalar(&BigInt::one()), r.clone()];
            for e in 2..=max_exp as usize {
                let x = zq.mul(&v[e - 1], r);
                v.push(x);
            }
            v
        })
        .collect()
}

// ------------------------------------------------------------ the descent

const PROOF_INDEX: usize = 20_000;
const PROOF_BITS: f64 = 60_000.0;
const SAFETY_BITS: f64 = 48.0;

/// Seconds since some fixed time, for traces (0 in WebAssembly, which has no clock).
fn clock() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        static T0: OnceLock<std::time::Instant> = OnceLock::new();
        T0.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()
    }
    #[cfg(target_arch = "wasm32")]
    {
        0.0
    }
}

fn trace(msg: impl FnOnce() -> String) {
    if std::env::var_os("SAGEBRUSH_GALOIS_TRACE").is_some() {
        eprintln!("[galois] {}", msg());
    }
}

fn poly_string(t: &[BigInt]) -> String {
    let mut s = String::new();
    for (j, c) in t.iter().enumerate().rev() {
        if c.is_zero() {
            continue;
        }
        let a = c.abs();
        s += match (c.is_negative(), s.is_empty()) {
            (true, true) => "-",
            (true, false) => " - ",
            (false, true) => "",
            (false, false) => " + ",
        };
        let coef = if a.is_one() && j > 0 { String::new() } else { a.to_string() };
        s += &match j {
            0 => coef,
            1 => format!("{}x", coef),
            _ => format!("{}x^{}", coef, j),
        };
    }
    s
}

/// The Galois group of an irreducible polynomial over Z (coefficients
/// constant term first) of degree at most 12.
pub fn galois_group(f: &[BigInt]) -> Result<GaloisGroup, String> {
    let mut f: Vec<BigInt> = f.to_vec();
    while f.last().map_or(false, |c| c.is_zero()) {
        f.pop();
    }
    if f.len() < 2 {
        return Err("the polynomial must have positive degree".into());
    }
    let n = f.len() - 1;
    if n > tables::MAX_DEGREE {
        return Err(format!("Galois groups are implemented for degrees up to {} so far, not {}", tables::MAX_DEGREE, n));
    }
    if !sagebrush_poly::is_irreducible(&f) {
        return Err("the polynomial must be irreducible".into());
    }
    let mut log = vec![];
    let groups = transitive_groups(n);
    let result = |t: &TGroup, proven: bool, log: Vec<String>| GaloisGroup { degree: n, number: t.k, order: t.order, name: t.name.clone(), proven, log };
    if n == 1 {
        return Ok(result(&groups[0], true, log));
    }
    // monic: a^(n-1) f(x/a)
    let a = f[n].clone();
    // g_i = f_i a^(n-1-i)
    let g: Vec<BigInt> = (0..=n).map(|i| if i == n { BigInt::one() } else { &f[i] * a.pow((n - 1 - i) as u32) }).collect();
    let disc = discriminant(&g);
    let even = is_square(&disc);
    log.push(format!("discriminant {} a square", if even { "is" } else { "is not" }));

    // 1. Frobenius cycle types
    let mut frob: Vec<(u64, Vec<(Vec<u64>, u32)>)> = vec![];
    let mut types: HashSet<Vec<usize>> = HashSet::new();
    for p in primes_from(2) {
        if frob.len() >= 120 {
            break;
        }
        if (&disc % BigInt::from(p)).is_zero() {
            continue;
        }
        let fac = sagebrush_poly::factor_mod(&g, p);
        let mut t: Vec<usize> = fac.iter().map(|(h, _)| h.len() - 1).collect();
        t.sort_unstable_by(|a, b| b.cmp(a));
        types.insert(t);
        frob.push((p, fac));
    }
    let candidates: Vec<usize> = (0..groups.len()).filter(|&i| groups[i].is_even() == even && types.iter().all(|t| groups[i].has_type(t))).collect();
    log.push(format!(
        "{} Frobenius cycle types from {} primes leave {} candidate{}: {}",
        types.len(),
        frob.len(),
        candidates.len(),
        if candidates.len() == 1 { "" } else { "s" },
        candidates.iter().map(|&i| groups[i].label()).collect::<Vec<_>>().join(", ")
    ));
    if candidates.is_empty() {
        return Err("internal error: no transitive group fits the Frobenius cycle types".into());
    }
    if candidates.len() == 1 {
        return Ok(result(&groups[candidates[0]], true, log));
    }
    let cand: HashSet<usize> = candidates.iter().copied().collect();

    // 2. p-adic roots, at a prime whose Frobenius has a small centralizer
    let score = |fac: &Vec<(Vec<u64>, u32)>| {
        let t: Vec<usize> = fac.iter().map(|(h, _)| h.len() - 1).collect();
        let d = t.iter().fold(1usize, |a, &b| a.lcm(&b));
        let penalty = if d > 24 { 1e12 } else { 1.0 };
        centralizer_order(&t) * (d * d) as f64 * penalty
    };
    let (p, fac) = frob.iter().min_by(|a, b| score(&a.1).partial_cmp(&score(&b.1)).unwrap()).unwrap().clone();
    let degs: Vec<usize> = fac.iter().map(|(h, _)| h.len() - 1).collect();
    let dd = degs.iter().fold(1usize, |a, &b| a.lcm(&b));
    let m = match fac.iter().find(|(h, _)| h.len() - 1 == dd) {
        Some((h, _)) => h.clone(),
        None => fq::irreducible(dd, p, 1),
    };
    let fqf = Fq { p, m };
    let mut r0: Vec<El> = vec![];
    let mut pi_img: Vec<u32> = vec![];
    for (i, (h, _)) in fac.iter().enumerate() {
        let off = r0.len() as u32;
        let rs = fq::roots_of_irreducible(&fqf, h, i as u64);
        let d = rs.len() as u32;
        r0.extend(rs);
        pi_img.extend((0..d).map(|j| off + (j + 1) % d));
    }
    let pi = Perm(pi_img);
    log.push(format!("p-adic roots: p = {}, unramified degree {}, Frobenius cycle type {:?}", p, dd, pi.cycle_type()));
    let mut roots = Roots { f: g.clone(), zq: Zq::new(&fqf, 1), fq: fqf, r0, tsch: None, log2_root: root_bound_log2(&g), lifted: vec![], pi };

    // the descent
    let top = if even { groups.len() - 2 } else { groups.len() - 1 };
    let mut cur = top; // index of the type of G
    let mut c = Perm::identity(n); // G = conjf(H_cur, c)
    let mut proven = true;
    let mut rng_state: u64 = 0x1234_5678;
    'descent: loop {
        let h = &groups[cur];
        let gg = Group::new(n, h.gens.iter().map(|x| conjf(x, &c)).collect()).unwrap();
        debug_assert!(gg.contains(&roots.pi));
        let is_symalt = cur >= groups.len() - 2;
        let maxes: Vec<&(usize, Perm)> = h.maximal.iter().filter(|(j, _)| cand.contains(&(j - 1))).collect();
        if maxes.is_empty() {
            log.push(format!("{}: no maximal subgroup is a candidate", h.label()));
            break;
        }
        // the maximal subgroups, in order of size (largest first)
        for &(j, y) in &maxes {
            let kt = &groups[j - 1];
            // K = conjf(H_j, y^-1 o c)
            let kc = comp(&y.inv(), &c);
            let kk = Group::new(n, kt.gens.iter().map(|x| conjf(x, &kc)).collect()).unwrap();
            let index = (h.order / kt.order) as usize;
            assert!(kk.gens.iter().all(|x| gg.contains(x)), "{} is not in {}", kt.label(), h.label());
            let t_inv = clock();
            let inv = find_invariant(n, &gg, &kk, roots.log2_bound());
            trace(|| format!("{} in {}: invariant of degree {} with {} terms{} in {:.2}s", kt.label(), h.label(), inv.degree, inv.terms.len(), if inv.diffs.is_empty() { "" } else { " (product of differences)" }, clock() - t_inv));
            let mut attempts = 0;
            loop {
                attempts += 1;
                // cosets fixed by the Frobenius
                let t_cos = clock();
                let all = if index <= 200_000 { transversal(&gg, &kk, 200_000) } else { None };
                let fixed: Vec<Perm> = match &all {
                    Some(t) => t.iter().filter(|s| kk.contains(&conjf(&roots.pi, s))).cloned().collect(),
                    None if is_symalt => fixed_cosets_sym(&gg, cur == groups.len() - 2, &kk, &roots.pi)?,
                    None => return Err("coset enumeration: index too large".into()),
                };
                trace(|| format!("  {} Frobenius-fixed cosets in {:.2}s", fixed.len(), clock() - t_cos));
                if std::env::var_os("SAGEBRUSH_GALOIS_CHECK").is_some() {
                    if let Some(t) = &all {
                        // F o s differs for different cosets (Stab_G(F) = K)
                        let mut seen: HashSet<(Vec<Vec<(u8, u8)>>, bool)> = HashSet::new();
                        for s in t {
                            // (F o s)(x) = F(x o s): the term with points i becomes points s(i)
                            assert!(seen.insert(inv.image_key(s)), "F o s repeats: {} cosets, {} in {}", t.len(), kt.label(), h.label());
                        }
                        assert_eq!(t.len(), index);
                    }
                }
                let bound = inv.log2_bound(roots.log2_bound());
                let k = ((bound + 1.0 + SAFETY_BITS) / (p as f64).log2()).ceil() as u32;
                let rts = roots.at(k).clone();
                let zq = roots.zq.clone();
                let pows = powers(&zq, &rts, inv.max_exp);
                let vals: Vec<Elt> = fixed.iter().map(|s| evaluate(&zq, &pows, &inv, s)).collect();
                let ints: Vec<usize> = (0..vals.len()).filter(|&i| zq.small_integer(&vals[i], bound.ceil() as u64 + 1).is_some()).collect();
                trace(|| format!("  index {}, {} fixed cosets, {} integral {:?}, precision p^{}", index, fixed.len(), ints.len(), ints.iter().map(|&i| zq.small_integer(&vals[i], 4096).unwrap().to_string()).collect::<Vec<_>>(), k));
                if ints.is_empty() {
                    break; // Gal(f) is in no conjugate of K
                }
                // the values at all cosets, when there are few: an integral value
                // must differ from all of them (a simple root of the resolvent)
                let others: Vec<Elt> = match &all {
                    Some(t) if index <= PROOF_INDEX => t.iter().map(|s| evaluate(&zq, &pows, &inv, s)).collect(),
                    _ => vals.clone(),
                };
                let simple = |i: usize| others.iter().filter(|v| **v == vals[i]).count() == 1;
                let good: Vec<usize> = ints.iter().copied().filter(|&i| simple(i)).collect();
                if good.is_empty() {
                    if attempts > 12 {
                        return Err("could not separate the resolvent values".into());
                    }
                    // a random Tschirnhausen transformation of degree n - 1 (low
                    // degrees keep the structure of compositions g(h(x)))
                    let mut t = vec![BigInt::zero()];
                    for j in 1..n {
                        rng_state ^= rng_state << 13;
                        rng_state ^= rng_state >> 7;
                        rng_state ^= rng_state << 17;
                        let c = (rng_state % 5) as i64 - 2;
                        t.push(BigInt::from(if j == n - 1 && c == 0 { 1 } else { c }));
                    }
                    log.push(format!("{} in {}: repeated values, Tschirnhausen transformation {}", kt.label(), h.label(), poly_string(&t)));
                    roots.set_tschirnhausen(Some(t));
                    continue;
                }
                let i = good[0];
                let s = fixed[i].clone();
                let value = zq.small_integer(&vals[i], bound.ceil() as u64 + 1).unwrap();
                // rigor: the value differs from those at all other cosets, and is an integer
                let mut step_proven = false;
                if all.is_some() && index <= PROOF_INDEX && index as f64 * (bound + 1.0) < PROOF_BITS {
                    // the norm of F(r o s) - value is an integer below (2B)^index divisible by p^k1
                    let t_proof = clock();
                    let k1 = ((index as f64 * (bound + 1.0) + 2.0) / (p as f64).log2()).ceil() as u32;
                    let (zq1, rts1) = roots.lifted(k1.max(k));
                    let pows1 = powers(&zq1, &rts1, inv.max_exp);
                    let v1 = evaluate(&zq1, &pows1, &inv, &s);
                    step_proven = zq1.small_integer(&v1, bound.ceil() as u64 + 1) == Some(value.clone());
                    trace(|| format!("  proof at precision p^{}: {} in {:.2}s", k1, step_proven, clock() - t_proof));
                }
                proven &= step_proven;
                log.push(format!(
                    "{} -> {} (index {}, {} of {} Frobenius-fixed cosets integral, invariant of degree {} with {} terms, value {}){}",
                    h.label(),
                    kt.label(),
                    index,
                    ints.len(),
                    fixed.len(),
                    inv.degree,
                    inv.terms.len(),
                    value,
                    if step_proven { ", proven" } else { "" }
                ));
                // in the numbering r o s, Gal(f) <= K itself
                roots.renumber(&s);
                c = kc;
                cur = j - 1;
                continue 'descent;
            }
        }
        log.push(format!("{}: in no maximal transitive subgroup", h.label()));
        break;
    }
    Ok(result(&groups[cur], proven, log))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(v: &[i64]) -> Vec<BigInt> {
        v.iter().map(|&x| BigInt::from(x)).collect()
    }

    #[test]
    fn discriminants() {
        // x^2 + 1: -4; x^3 - 2: -108
        assert_eq!(discriminant(&z(&[1, 0, 1])), BigInt::from(-4));
        assert_eq!(discriminant(&z(&[-2, 0, 0, 1])), BigInt::from(-108));
        assert_eq!(discriminant(&z(&[1, 1, 1])), BigInt::from(-3));
    }

    #[test]
    fn small_groups() {
        let cases: &[(&[i64], &str)] = &[
            (&[1, 0, 1], "2T1"),
            (&[-2, 0, 0, 1], "3T2"),
            (&[1, -3, 0, 1], "3T1"), // x^3 - 3x + 1, cyclic
            (&[-2, 0, 0, 0, 1], "4T3"),
            (&[1, 0, 0, 0, 1], "4T2"),
            (&[1, 1, 1, 1, 1], "4T1"),
            (&[-2, 0, 0, 0, 0, 1], "5T3"),
            (&[-1, -1, 0, 0, 0, 1], "5T5"),
            (&[1, 1, 1, 1, 1, 1, 1], "6T1"),
            (&[-2, 0, 0, 0, 0, 0, 1], "6T3"),
        ];
        for (f, want) in cases {
            let g = galois_group(&z(f)).unwrap();
            assert_eq!(&g.label(), want, "{:?}: {:?}", f, g.log);
        }
    }
}

