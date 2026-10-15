//! Polynomials over O_F = Z[w] with big coefficients: arithmetic, recovery
//! from reductions at pairs of conjugate degree-one primes, and
//! factorization over F (Trager's norm method).
//!
//! An element c = a + b w of O_F is recovered from its reductions r, r' at
//! the two primes (p, w - s), (p, w - s') above a split p (s + s' = 1):
//! a + b s = r and a + b s' = r' give b = (r - r')/(2s - 1) (2s - 1 is a
//! square root of 5, invertible) and a = r - b s modulo p; then a and b by
//! Chinese remaindering over several p. If |c| <= C under both real
//! embeddings then |a|, |b| <= C: b = (c - c')/sqrt 5 and
//! a = (phi c' - phi' c)/sqrt 5 with phi = (1 + sqrt 5)/2, phi' = 1 - phi.

use crate::weight::{place_pairs, Place};
use sagebrush_arith::crt::MultiCrt;
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_poly;
use sagebrush_arith::zpoly;
use sagebrush_bigint::BigInt;
use num_traits::{One, Zero};

/// a + b w.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FInt {
    pub a: BigInt,
    pub b: BigInt,
}

impl FInt {
    pub fn new(a: BigInt, b: BigInt) -> FInt {
        FInt { a, b }
    }
    pub fn int(a: BigInt) -> FInt {
        FInt { a, b: BigInt::zero() }
    }
    pub fn zero() -> FInt {
        FInt::int(BigInt::zero())
    }
    pub fn one() -> FInt {
        FInt::int(BigInt::one())
    }
    pub fn is_zero(&self) -> bool {
        self.a.is_zero() && self.b.is_zero()
    }
    pub fn add(&self, o: &FInt) -> FInt {
        FInt { a: &self.a + &o.a, b: &self.b + &o.b }
    }
    pub fn sub(&self, o: &FInt) -> FInt {
        FInt { a: &self.a - &o.a, b: &self.b - &o.b }
    }
    pub fn neg(&self) -> FInt {
        FInt { a: -&self.a, b: -&self.b }
    }
    /// (a + b w)(c + d w) = ac + bd + (ad + bc + bd) w.
    pub fn mul(&self, o: &FInt) -> FInt {
        let bd = &self.b * &o.b;
        FInt { a: &self.a * &o.a + &bd, b: &self.a * &o.b + &self.b * &o.a + bd }
    }
    /// w -> 1 - w.
    pub fn conj(&self) -> FInt {
        FInt { a: &self.a + &self.b, b: -&self.b }
    }
    pub fn red(&self, pl: &Place) -> u64 {
        let p = BigInt::from(pl.p());
        let r = |x: &BigInt| -> u64 { u64::try_from(&num_integer::Integer::mod_floor(x, &p)).unwrap() };
        pl.md.add(r(&self.a), pl.md.mul(r(&self.b), pl.s))
    }
    pub fn from_elt(x: crate::field::Elt) -> FInt {
        FInt { a: BigInt::from(x.a), b: BigInt::from(x.b) }
    }
}

impl std::fmt::Display for FInt {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.a)?;
        if self.b.is_zero() {
            return Ok(());
        }
        if self.b < BigInt::zero() {
            write!(f, " - {}w", -&self.b)
        } else {
            write!(f, " + {}w", self.b)
        }
    }
}

/// A polynomial over O_F, constant term first, without leading zeros.
pub type FPoly = Vec<FInt>;

pub fn trim(mut f: FPoly) -> FPoly {
    while f.last().map_or(false, |c| c.is_zero()) {
        f.pop();
    }
    f
}

pub fn mul(f: &[FInt], g: &[FInt]) -> FPoly {
    if f.is_empty() || g.is_empty() {
        return vec![];
    }
    let mut h = vec![FInt::zero(); f.len() + g.len() - 1];
    for (i, x) in f.iter().enumerate() {
        if x.is_zero() {
            continue;
        }
        for (j, y) in g.iter().enumerate() {
            h[i + j] = h[i + j].add(&x.mul(y));
        }
    }
    trim(h)
}

pub fn conj(f: &[FInt]) -> FPoly {
    f.iter().map(|c| c.conj()).collect()
}

pub fn from_z(f: &[BigInt]) -> FPoly {
    trim(f.iter().map(|c| FInt::int(c.clone())).collect())
}

/// f(x + c).
pub fn shift(f: &[FInt], c: &FInt) -> FPoly {
    let mut out: FPoly = vec![];
    for a in f.iter().rev() {
        // out = out (x + c) + a
        let mut next = vec![FInt::zero(); out.len() + 1];
        for (i, y) in out.iter().enumerate() {
            next[i + 1] = next[i + 1].add(y);
            next[i] = next[i].add(&y.mul(c));
        }
        next[0] = next[0].add(a);
        out = next;
    }
    trim(out)
}

/// The norm f conj(f), in Z[x].
pub fn norm(f: &[FInt]) -> Result<Vec<BigInt>, String> {
    let n = mul(f, &conj(f));
    if n.iter().any(|c| !c.b.is_zero()) {
        return Err("the norm of a polynomial over O_F is not rational".into());
    }
    Ok(n.into_iter().map(|c| c.a).collect())
}

/// The quotient f / g for monic g, if the division is exact.
pub fn div_exact_monic(f: &[FInt], g: &[FInt]) -> Option<FPoly> {
    let dg = g.len().checked_sub(1)?;
    if !g[dg].a.is_one() || !g[dg].b.is_zero() {
        return None;
    }
    let mut r: FPoly = f.to_vec();
    if r.len() < g.len() {
        return if trim(r).is_empty() { Some(vec![]) } else { None };
    }
    let mut q = vec![FInt::zero(); r.len() - dg];
    for k in (0..q.len()).rev() {
        let c = r[k + dg].clone();
        if c.is_zero() {
            continue;
        }
        for (i, gi) in g.iter().enumerate() {
            r[k + i] = r[k + i].sub(&c.mul(gi));
        }
        q[k] = c;
    }
    if trim(r).is_empty() {
        Some(trim(q))
    } else {
        None
    }
}

pub fn reduce(f: &[FInt], pl: &Place) -> Vec<u64> {
    nmod_poly::trim(f.iter().map(|c| c.red(pl)).collect())
}

/// Recovers elements of O_F from their reductions at pairs of conjugate
/// places, given the residues at each pair (r at the first place, r' at
/// the second).
pub struct PairCrt {
    crt: MultiCrt,
    pairs: Vec<(Place, Place)>,
}

impl PairCrt {
    pub fn new(pairs: &[(Place, Place)]) -> PairCrt {
        let primes: Vec<u64> = pairs.iter().map(|(a, _)| a.p()).collect();
        PairCrt { crt: MultiCrt::new(&primes), pairs: pairs.to_vec() }
    }
    /// The element with reductions res[k] = (r, r') at pairs[k], assuming
    /// |a|, |b| < (product of the p)/2.
    pub fn reconstruct(&self, res: &[(u64, u64)]) -> FInt {
        let mut ra = vec![];
        let mut rb = vec![];
        for ((pl, _), &(r, r2)) in self.pairs.iter().zip(res) {
            let md = &pl.md;
            let d = md.inv(md.sub(md.add(pl.s, pl.s), 1)).expect("2s - 1 is invertible");
            let b = md.mul(md.sub(r, r2), d);
            let a = md.sub(r, md.mul(b, pl.s));
            ra.push(a);
            rb.push(b);
        }
        FInt::new(self.crt.reconstruct(&ra), self.crt.reconstruct(&rb))
    }
}

/// The largest recovery this module undertakes, in bits per coefficient:
/// a request whose proven bound needs more is refused (daybreak
/// HARD-DDD-1), before any modular work. About 4300 pairs of places.
pub const MAX_BITS: u64 = 1 << 18;

/// Every modulus is a prime above 2^61: Primes descends from 2^62, and
/// MAX_BITS needs far fewer of them than lie in (2^61, 2^62). Checked.
const MIN_PRIME_BITS: u64 = 61;

/// The bit length of x >= 0: x < 2^bitlen(x).
pub fn bitlen(x: &BigInt) -> u64 {
    x.bits()
}

/// The number of pairs of places that suffice for coefficients a, b with
/// |a|, |b| < 2^bits: k primes above 2^61 have a product
/// >= 2^(61 k) >= 2^(bits + 2) > 2 max(|a|, |b|) + 1. An Err above
/// MAX_BITS.
pub fn pairs_needed(bits: u64) -> Result<usize, String> {
    if bits > MAX_BITS {
        return Err(format!("this computation needs {} bits per coefficient, more than the limit of {}", bits, MAX_BITS));
    }
    Ok(((bits + 2 + MIN_PRIME_BITS - 1) / MIN_PRIME_BITS) as usize)
}

/// Enough pairs of places above distinct primes for coefficients of fewer
/// than `bits` bits (|a|, |b| < 2^bits).
pub fn pairs_for_bits(bits: u64) -> Result<Vec<(Place, Place)>, String> {
    let k = pairs_needed(bits)?;
    let out: Vec<(Place, Place)> = place_pairs().take(k).collect();
    assert!(out.iter().all(|pp| pp.0.p() >> MIN_PRIME_BITS >= 1), "a modulus below 2^61");
    Ok(out)
}

/// An integer upper bound for log2 of the coefficient bound of a monic
/// polynomial of degree d whose roots have absolute value at most b under
/// every embedding: binom(d, i) b^i <= (1 + b)^d < 2^(d bitlen(1 + b)).
/// Exact integer arithmetic (daybreak PROOF-DDD-2).
pub fn coefficient_bits(d: usize, b: &BigInt) -> u64 {
    d as u64 * bitlen(&(b + BigInt::one()))
}

/// The monic gcd over F of f (monic, in O_F[x]) and h (monic, in Z[x]),
/// where every root of f has absolute value at most root_bound under every
/// embedding. Computed modulo pairs of places, where the gcd of the
/// reductions has the right degree except at finitely many places (those
/// of least degree are kept), recovered with the coefficient bound, and
/// checked to divide f and h exactly.
pub fn gcd_with_z(f: &[FInt], h: &[BigInt], root_bound: &BigInt) -> Result<FPoly, String> {
    let hf = from_z(h);
    let mut kept: Vec<((Place, Place), Vec<u64>, Vec<u64>)> = vec![];
    let mut deg = usize::MAX;
    let mut checked_with = 0usize;
    for (n, pp) in place_pairs().enumerate() {
        if n > 2000 {
            break;
        }
        let g1 = nmod_poly::gcd(&reduce(f, &pp.0), &reduce(&hf, &pp.0), &pp.0.md);
        let g2 = nmod_poly::gcd(&reduce(f, &pp.1), &reduce(&hf, &pp.1), &pp.1.md);
        let (d1, d2) = (nmod_poly::degree(&g1), nmod_poly::degree(&g2));
        if d1 != d2 || d1 < 0 {
            continue;
        }
        let d = d1 as usize;
        if d > deg {
            continue;
        }
        if d < deg {
            deg = d;
            kept.clear();
            checked_with = 0;
        }
        kept.push((pp, nmod_poly::monic(&g1, &pp.0.md), nmod_poly::monic(&g2, &pp.1.md)));
        if deg == 0 {
            return Ok(vec![FInt::one()]);
        }
        let need = pairs_needed(coefficient_bits(deg, root_bound))?;
        assert!(pp.0.p() >> MIN_PRIME_BITS >= 1, "a modulus below 2^61");
        if kept.len() < need || kept.len() < checked_with * 2 {
            continue;
        }
        checked_with = kept.len();
        let pairs: Vec<(Place, Place)> = kept.iter().map(|(pp, _, _)| *pp).collect();
        let crt = PairCrt::new(&pairs);
        let g: FPoly = (0..=deg).map(|i| crt.reconstruct(&kept.iter().map(|(_, a, b)| (a[i], b[i])).collect::<Vec<_>>())).collect();
        if div_exact_monic(f, &g).is_some() && div_exact_monic(&hf, &g).is_some() {
            return Ok(g);
        }
    }
    Err("the gcd over F did not stabilize".into())
}

/// The irreducible factors over F of a monic squarefree f in O_F[x], monic
/// in O_F[x] (Gauss's lemma: O_F is integrally closed), where every root of
/// f has absolute value at most root_bound under both embeddings. Trager's
/// method (Cohen, "A Course in Computational Algebraic Number Theory",
/// Algorithm 3.6.4): for the first k = 0, 1, -1, 2, ... with
/// N(x) = norm(f(x - k w)) squarefree over Q, the irreducible factors over F
/// of f(x - k w) are its gcds with the irreducible factors of N over Q.
pub fn factor_squarefree(f: &[FInt], root_bound: &BigInt) -> Result<Vec<FPoly>, String> {
    let f = trim(f.to_vec());
    if f.len() <= 1 {
        return Ok(vec![]);
    }
    if f.len() == 2 {
        return Ok(vec![f]);
    }
    for t in 0..40i64 {
        let k = if t % 2 == 1 { (t + 1) / 2 } else { -(t / 2) };
        // f_k(x) = f(x - k w)
        let kw = FInt::new(BigInt::zero(), BigInt::from(-k));
        let fk = shift(&f, &kw);
        let n = norm(&fk)?;
        let dn = zpoly::trim(n.iter().enumerate().skip(1).map(|(i, c)| c * &BigInt::from(i as i64)).collect());
        if zpoly::gcd(&n, &dn).len() != 1 {
            continue;
        }
        // |w| < 2 under both embeddings
        let bound = root_bound + BigInt::from(2 * k.abs());
        let mut out = vec![];
        for (h, e) in sagebrush_poly::factor(&n).1 {
            if e != 1 {
                return Err("the norm is not squarefree".into());
            }
            let g = gcd_with_z(&fk, &h, &bound)?;
            if g.len() > 1 {
                // back: g(x + k w)
                out.push(shift(&g, &FInt::new(BigInt::zero(), BigInt::from(k))));
            }
        }
        // the factors must multiply to f
        let mut prod = vec![FInt::one()];
        for g in &out {
            prod = mul(&prod, g);
        }
        if prod != f {
            return Err("the factors over F do not multiply to the polynomial".into());
        }
        out.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
        return Ok(out);
    }
    Err("no shift with a squarefree norm found".into())
}

/// Modular helper: the residues modulo md of x as u64.
pub fn modulus_red(x: &BigInt, md: &Modulus) -> u64 {
    let p = BigInt::from(md.n);
    u64::try_from(&num_integer::Integer::mod_floor(x, &p)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fi(a: i64, b: i64) -> FInt {
        FInt::new(BigInt::from(a), BigInt::from(b))
    }

    #[test]
    fn pair_reconstruction() {
        let pairs = pairs_for_bits(100).unwrap();
        let crt = PairCrt::new(&pairs);
        for c in [fi(3, -7), fi(-123456789012, 98765432109), fi(0, 1), fi(-1, 0)] {
            let res: Vec<(u64, u64)> = pairs.iter().map(|(a, b)| (c.red(a), c.red(b))).collect();
            assert_eq!(crt.reconstruct(&res), c);
        }
    }

    #[test]
    fn factor_over_f() {
        // (x - w)(x - (1 - w))(x^2 + w x + 3)(x^2 - 2): the first two are
        // conjugate, the last is rational and irreducible over F
        let a = vec![fi(0, -1), fi(1, 0)];
        let b = vec![fi(-1, 1), fi(1, 0)];
        let c = vec![fi(3, 0), fi(0, 1), fi(1, 0)];
        let d = vec![fi(-2, 0), fi(0, 0), fi(1, 0)];
        let f = mul(&mul(&mul(&a, &b), &c), &d);
        let mut got = factor_squarefree(&f, &BigInt::from(10)).unwrap();
        let mut want = vec![a, b, c, d];
        got.sort();
        want.sort();
        assert_eq!(got, want);
        // x^2 - 5 = (x - (2w - 1))(x + (2w - 1)) over F
        let g = vec![fi(-5, 0), fi(0, 0), fi(1, 0)];
        assert_eq!(factor_squarefree(&g, &BigInt::from(3)).unwrap().len(), 2);
    }
}
