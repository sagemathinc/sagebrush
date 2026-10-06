//! Sparse multivariate polynomials over Q in named generators, converted
//! from and to expressions, with exact division and factorization
//! (Kronecker substitution: factor f(x, x^D1, x^D2, ...) in Z[x], then
//! recombine the factors and confirm each candidate by exact division).

use crate::expand::expand;
use crate::expr::*;
use crate::num::Q;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct MPoly {
    pub gens: Vec<Expr>,
    /// exponent vector -> coefficient (no zeros)
    pub terms: BTreeMap<Vec<u32>, Q>,
}

impl MPoly {
    pub fn zero(gens: &[Expr]) -> MPoly {
        MPoly { gens: gens.to_vec(), terms: BTreeMap::new() }
    }
    pub fn constant(gens: &[Expr], c: Q) -> MPoly {
        let mut p = MPoly::zero(gens);
        if !c.is_zero() {
            p.terms.insert(vec![0; gens.len()], c);
        }
        p
    }
    pub fn is_zero(&self) -> bool {
        self.terms.is_empty()
    }
    pub fn n(&self) -> usize {
        self.gens.len()
    }

    /// e (expanded) as a polynomial in gens with rational coefficients.
    pub fn from_expr(e: &Expr, gens: &[Expr]) -> Option<MPoly> {
        let ex = expand(e);
        let terms = match &ex.kind {
            Kind::Add(v) => v.clone(),
            _ => vec![ex.clone()],
        };
        let mut p = MPoly::zero(gens);
        for t in terms {
            let (c, rest) = split_coeff(&t);
            let c = c.as_rat()?.clone();
            let mut exps = vec![0u32; gens.len()];
            let factors = match &rest.kind {
                Kind::Mul(v) => v.clone(),
                _ if rest.is_one() => vec![],
                _ => vec![rest.clone()],
            };
            for f in factors {
                let (b, x) = base_exp(&f);
                let k = x.as_i64().filter(|k| *k > 0)? as u32;
                let i = gens.iter().position(|g| *g == b)?;
                exps[i] += k;
            }
            let e = p.terms.entry(exps.clone()).or_insert_with(Q::zero);
            *e += c;
            if e.is_zero() {
                p.terms.remove(&exps);
            }
        }
        Some(p)
    }

    pub fn to_expr(&self) -> Expr {
        add(self
            .terms
            .iter()
            .map(|(e, c)| {
                let mut f = vec![qnum(c.clone())];
                for (g, k) in self.gens.iter().zip(e) {
                    if *k > 0 {
                        f.push(pow(g, &int(*k as i64)));
                    }
                }
                mul(f)
            })
            .collect())
    }

    pub fn mul(&self, o: &MPoly) -> MPoly {
        sagebrush_interrupt::check();
        let mut r = MPoly::zero(&self.gens);
        for (a, c) in &self.terms {
            for (b, d) in &o.terms {
                let e: Vec<u32> = a.iter().zip(b).map(|(x, y)| x + y).collect();
                let v = r.terms.entry(e.clone()).or_insert_with(Q::zero);
                *v += c * d;
                if v.is_zero() {
                    r.terms.remove(&e);
                }
            }
        }
        r
    }

    pub fn sub(&self, o: &MPoly) -> MPoly {
        let mut r = self.clone();
        for (e, c) in &o.terms {
            let v = r.terms.entry(e.clone()).or_insert_with(Q::zero);
            *v -= c;
            if v.is_zero() {
                r.terms.remove(e);
            }
        }
        r
    }

    /// The leading term in lex order (exponents compared left to right).
    fn lead(&self) -> Option<(&Vec<u32>, &Q)> {
        self.terms.iter().next_back()
    }

    /// self / d if d divides self exactly.
    pub fn divexact(&self, d: &MPoly) -> Option<MPoly> {
        sagebrush_interrupt::check();
        let (dl, dc) = d.lead()?;
        let mut r = self.clone();
        let mut q = MPoly::zero(&self.gens);
        let mut steps = 0;
        while let Some((rl, rc)) = r.lead() {
            if rl.iter().zip(dl).any(|(a, b)| a < b) {
                return None;
            }
            let e: Vec<u32> = rl.iter().zip(dl).map(|(a, b)| a - b).collect();
            let c = rc / dc;
            let mut t = MPoly::zero(&self.gens);
            t.terms.insert(e, c);
            q = add_poly(&q, &t);
            r = r.sub(&t.mul(d));
            steps += 1;
            if steps % 64 == 0 {
                sagebrush_interrupt::check();
            }
        }
        Some(q)
    }

    pub fn degree_in(&self, i: usize) -> u32 {
        self.terms.keys().map(|e| e[i]).max().unwrap_or(0)
    }

    /// The Kronecker image in one variable: exponent vector -> mixed radix.
    fn kronecker(&self, radix: &[u64]) -> Vec<BigInt> {
        let mut out: BTreeMap<u64, Q> = BTreeMap::new();
        for (e, c) in &self.terms {
            let mut k = 0u64;
            let mut w = 1u64;
            for (j, x) in e.iter().enumerate() {
                k += *x as u64 * w;
                w *= radix[j];
            }
            *out.entry(k).or_insert_with(Q::zero) += c;
        }
        let deg = out.keys().max().copied().unwrap_or(0) as usize;
        let mut den = BigInt::one();
        for c in out.values() {
            den = num_integer::lcm(den, c.denom().clone());
        }
        let mut v = vec![BigInt::zero(); deg + 1];
        for (k, c) in out {
            v[k as usize] = (c * Q::from_integer(den.clone())).to_integer();
        }
        v
    }

    fn from_kronecker(gens: &[Expr], f: &[BigInt], radix: &[u64]) -> MPoly {
        let mut p = MPoly::zero(gens);
        for (k, c) in f.iter().enumerate() {
            if c.is_zero() {
                continue;
            }
            let mut k = k as u64;
            let mut e = vec![0u32; gens.len()];
            for j in 0..gens.len() {
                e[j] = (k % radix[j]) as u32;
                k /= radix[j];
            }
            p.terms.insert(e, Q::from_integer(c.clone()));
        }
        p
    }
}

fn add_poly(a: &MPoly, b: &MPoly) -> MPoly {
    let mut r = a.clone();
    for (e, c) in &b.terms {
        let v = r.terms.entry(e.clone()).or_insert_with(Q::zero);
        *v += c;
        if v.is_zero() {
            r.terms.remove(e);
        }
    }
    r
}

fn zmul(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut r = vec![BigInt::zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            r[i + j] += x * y;
        }
    }
    r
}

/// The irreducible factorization over Q: (content, [(factor, multiplicity)])
/// with primitive integer factors.
pub fn factor(p: &MPoly) -> (Q, Vec<(MPoly, u32)>) {
    let gens = p.gens.clone();
    if p.is_zero() {
        return (Q::zero(), vec![]);
    }
    let n = gens.len();
    if n == 0 {
        return (p.terms.values().next().cloned().unwrap_or_else(Q::zero), vec![]);
    }
    // Kronecker: radix_j = 1 + deg_j (enough for every factor)
    let radix: Vec<u64> = (0..n).map(|j| p.degree_in(j) as u64 + 1).collect();
    let image = p.kronecker(&radix);
    let (_, ifac) = sagebrush_poly::factor(&image);
    // content of p (rational) from the leading coefficient
    let mut pieces: Vec<Vec<BigInt>> = vec![];
    for (g, e) in &ifac {
        for _ in 0..*e {
            pieces.push(g.clone());
        }
    }
    let mut rest = p.clone();
    let mut found: Vec<MPoly> = vec![];
    // try subsets of growing size, removing each factor found
    let mut avail: Vec<usize> = (0..pieces.len()).collect();
    let mut size = 1;
    while size <= avail.len() {
        let mut comb: Vec<usize> = (0..size).collect();
        let mut hit = false;
        loop {
            sagebrush_interrupt::check();
            let chosen: Vec<usize> = comb.iter().map(|&c| avail[c]).collect();
            let mut g = vec![BigInt::one()];
            for &c in &chosen {
                g = zmul(&g, &pieces[c]);
            }
            let cand = MPoly::from_kronecker(&gens, &g, &radix);
            if !is_constant(&cand) {
                if let Some(q) = rest.divexact(&cand) {
                    found.push(cand);
                    rest = q;
                    avail.retain(|i| !chosen.contains(i));
                    hit = true;
                    break;
                }
            }
            if !next_comb(&mut comb, avail.len()) {
                break;
            }
        }
        if !hit {
            size += 1;
        }
    }
    // what is left is a constant (or an irreducible we could not split)
    let mut content = Q::one();
    if is_constant(&rest) {
        content = rest.terms.values().next().cloned().unwrap_or_else(Q::one);
    } else {
        found.push(rest);
    }
    // normalize: primitive, positive leading coefficient; collect powers
    let mut out: Vec<(MPoly, u32)> = vec![];
    for f in found {
        let (c, g) = primitive(&f);
        content *= c;
        match out.iter_mut().find(|(h, _)| *h == g) {
            Some(h) => h.1 += 1,
            None => out.push((g, 1)),
        }
    }
    (content, out)
}

fn next_comb(comb: &mut [usize], n: usize) -> bool {
    let k = comb.len();
    let mut i = k;
    while i > 0 {
        i -= 1;
        if comb[i] < n - k + i {
            comb[i] += 1;
            for j in i + 1..k {
                comb[j] = comb[j - 1] + 1;
            }
            return true;
        }
    }
    false
}

fn is_constant(p: &MPoly) -> bool {
    p.terms.keys().all(|e| e.iter().all(|x| *x == 0))
}

/// (c, g) with p = c g, g with coprime integer coefficients and a
/// positive leading coefficient.
pub fn primitive(p: &MPoly) -> (Q, MPoly) {
    let mut den = BigInt::one();
    for c in p.terms.values() {
        den = num_integer::lcm(den, c.denom().clone());
    }
    let mut g = BigInt::zero();
    for c in p.terms.values() {
        g = num_integer::gcd(g, (c * Q::from_integer(den.clone())).to_integer());
    }
    let mut c = Q::new(g, den);
    if p.lead().map_or(false, |(_, l)| l.is_negative()) {
        c = -c;
    }
    let mut q = p.clone();
    for v in q.terms.values_mut() {
        *v = &*v / &c;
    }
    (c, q)
}

/// The generators of e: its symbols, and other non-polynomial kernels
/// (sin(x), e^x, sqrt(x)) treated as variables.
pub fn generators(e: &Expr) -> Vec<Expr> {
    let mut out: Vec<Expr> = vec![];
    fn walk(e: &Expr, out: &mut Vec<Expr>) {
        match &e.kind {
            Kind::Num(_) => {}
            Kind::Add(v) | Kind::Mul(v) => v.iter().for_each(|t| walk(t, out)),
            Kind::Pow(b, x) if x.as_i64().map_or(false, |k| k > 0) => walk(b, out),
            _ => {
                if !out.contains(e) {
                    out.push(e.clone());
                }
            }
        }
    }
    walk(&expand(e), &mut out);
    out.sort_by(canon_cmp);
    out
}
