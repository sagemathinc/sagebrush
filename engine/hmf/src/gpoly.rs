//! Polynomials over O_F for any real quadratic field F (rqf.rs, O_F = Z[w]
//! with w^2 = t w + n): fpoly.rs, written for Q(sqrt 5), over every F.
//! Arithmetic, recovery from reductions at pairs of conjugate degree-one
//! primes, and factorization over F (Trager's norm method).
//!
//! An element c = a + b w of O_F is recovered from its reductions r, r' at
//! the two primes P = (p, w - s), P' = (p, w - s') above a split p
//! (s + s' = t): a + b s = r and a + b s' = r' give b = (r - r')/(s - s')
//! (s - s' is a square root of the discriminant D, invertible as p does not
//! divide D) and a = r - b s modulo p; then a and b by Chinese remaindering
//! over several p. If |c| <= C under both real embeddings then |a|, |b| <=
//! C: with sigma_+-(w) = (t +- sqrt D)/2, b = (sigma_+(c) - sigma_-(c)) /
//! sqrt D, so |b| <= 2C / sqrt D < C (D >= 5); and a = (sigma_+(c)
//! sigma_-(w) - sigma_-(c) sigma_+(w)) / (sigma_-(w) - sigma_+(w)), so |a| <=
//! C (|sigma_+(w)| + |sigma_-(w)|) / sqrt D, and |sigma_+(w)| +
//! |sigma_-(w)| = sqrt D (t = 1, D = d > 1: (1 + sqrt d)/2 + (sqrt d - 1)/2)
//! or 2 sqrt d = sqrt D (t = 0, D = 4d).

use crate::fpoly::{bitlen, coefficient_bits, pairs_needed};
use crate::rqf::{QElt, QuadField};
use num_integer::{Integer, Roots};
use num_traits::{One, Signed, Zero};
use sagebrush_arith::crt::MultiCrt;
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::nmod_poly;
use sagebrush_arith::zpoly;
use sagebrush_bigint::BigInt;

/// A prime of F of degree one, (p, w - s): the reduction O_F -> Z/p with
/// w -> s; t is the trace of w (w + conj(w) = t).
#[derive(Clone, Copy, Debug)]
pub struct GPlace {
    pub md: Modulus,
    pub s: u64,
    pub t: u64,
}

impl GPlace {
    pub fn p(&self) -> u64 {
        self.md.n
    }
    /// The image of the integer x.
    pub fn red_int(&self, x: &BigInt) -> u64 {
        let p = BigInt::from(self.md.n);
        u64::try_from(&x.mod_floor(&p)).expect("a residue below p")
    }
    /// The image of x.
    pub fn red(&self, x: &QElt) -> u64 {
        self.md.add(self.red_int(&x.a), self.md.mul(self.red_int(&x.b), self.s))
    }
    /// The conjugate place (p, w - s'), s + s' = t: reducing conj(x) here
    /// is reducing x there.
    pub fn conj(&self) -> GPlace {
        GPlace { md: self.md, s: self.md.sub(self.t, self.s), t: self.t }
    }
    /// The two places above p, if p > 2 is prime, splits in F and does not
    /// divide its discriminant (p is assumed prime).
    pub fn pair(f: &QuadField, p: u64) -> Option<(GPlace, GPlace)> {
        if p <= 2 {
            return None;
        }
        let md = Modulus::new(p);
        let disc = md.from_i64(f.disc);
        if disc == 0 {
            return None;
        }
        let r = crate::field::sqrt_mod_p(disc, p)?;
        // w = (t + sqrt D)/2 is a root of x^2 - t x - n
        let t = md.from_i64(f.t);
        let s = md.mul(md.add(t, r), md.inv(2)?);
        debug_assert_eq!(md.sub(md.sub(md.mul(s, s), md.mul(t, s)), md.from_i64(f.n)), 0);
        let a = GPlace { md, s, t };
        Some((a, a.conj()))
    }
}

/// Pairs of conjugate places of F above word-size split primes, from below
/// 2^62 descending.
pub fn place_pairs(f: QuadField) -> impl Iterator<Item = (GPlace, GPlace)> {
    // a check per prime: the primality tests and square roots modulo p are
    // slow in wasm, where 128-bit products are emulated
    Primes::new().filter_map(move |p| {
        sagebrush_interrupt::check();
        GPlace::pair(&f, p)
    })
}

/// A polynomial over O_F, constant term first, without leading zeros.
pub type QPoly = Vec<QElt>;

pub fn trim(mut f: QPoly) -> QPoly {
    while f.last().map_or(false, |c| c.is_zero()) {
        f.pop();
    }
    f
}

pub fn mul(fld: &QuadField, f: &[QElt], g: &[QElt]) -> QPoly {
    if f.is_empty() || g.is_empty() {
        return vec![];
    }
    let mut h = vec![QElt::int(0); f.len() + g.len() - 1];
    for (i, x) in f.iter().enumerate() {
        if x.is_zero() {
            continue;
        }
        for (j, y) in g.iter().enumerate() {
            h[i + j] = fld.add(&h[i + j], &fld.mul(x, y));
        }
    }
    trim(h)
}

pub fn conj(fld: &QuadField, f: &[QElt]) -> QPoly {
    f.iter().map(|c| fld.conj(c)).collect()
}

pub fn from_z(f: &[BigInt]) -> QPoly {
    trim(f.iter().map(|c| QElt { a: c.clone(), b: BigInt::zero() }).collect())
}

/// f(x + c).
pub fn shift(fld: &QuadField, f: &[QElt], c: &QElt) -> QPoly {
    let mut out: QPoly = vec![];
    for a in f.iter().rev() {
        // out = out (x + c) + a
        let mut next = vec![QElt::int(0); out.len() + 1];
        for (i, y) in out.iter().enumerate() {
            next[i + 1] = fld.add(&next[i + 1], y);
            next[i] = fld.add(&next[i], &fld.mul(y, c));
        }
        next[0] = fld.add(&next[0], a);
        out = next;
    }
    trim(out)
}

/// The norm f conj(f), in Z[x].
pub fn norm(fld: &QuadField, f: &[QElt]) -> Result<Vec<BigInt>, String> {
    let n = mul(fld, f, &conj(fld, f));
    if n.iter().any(|c| !c.b.is_zero()) {
        return Err("the norm of a polynomial over O_F is not rational".into());
    }
    Ok(n.into_iter().map(|c| c.a).collect())
}

/// The quotient f / g for monic g, if the division is exact.
pub fn div_exact_monic(fld: &QuadField, f: &[QElt], g: &[QElt]) -> Option<QPoly> {
    let dg = g.len().checked_sub(1)?;
    if !g[dg].a.is_one() || !g[dg].b.is_zero() {
        return None;
    }
    let mut r: QPoly = f.to_vec();
    if r.len() < g.len() {
        return if trim(r).is_empty() { Some(vec![]) } else { None };
    }
    let mut q = vec![QElt::int(0); r.len() - dg];
    for k in (0..q.len()).rev() {
        let c = r[k + dg].clone();
        if c.is_zero() {
            continue;
        }
        for (i, gi) in g.iter().enumerate() {
            r[k + i] = fld.sub(&r[k + i], &fld.mul(&c, gi));
        }
        q[k] = c;
    }
    if trim(r).is_empty() {
        Some(trim(q))
    } else {
        None
    }
}

pub fn reduce(f: &[QElt], pl: &GPlace) -> Vec<u64> {
    nmod_poly::trim(f.iter().map(|c| pl.red(c)).collect())
}

/// Recovers elements of O_F from their reductions at pairs of conjugate
/// places, given the residues at each pair (r at the first place, r' at
/// the second).
pub struct PairCrt {
    crt: MultiCrt,
    pairs: Vec<(GPlace, GPlace)>,
}

impl PairCrt {
    pub fn new(pairs: &[(GPlace, GPlace)]) -> PairCrt {
        let primes: Vec<u64> = pairs.iter().map(|(a, _)| a.p()).collect();
        PairCrt { crt: MultiCrt::new(&primes), pairs: pairs.to_vec() }
    }
    /// The element with reductions res[k] = (r, r') at pairs[k], assuming
    /// |a|, |b| < (product of the p)/2.
    pub fn reconstruct(&self, res: &[(u64, u64)]) -> QElt {
        sagebrush_interrupt::check();
        let mut ra = vec![];
        let mut rb = vec![];
        for ((pl, pl2), &(r, r2)) in self.pairs.iter().zip(res) {
            let md = &pl.md;
            let d = md.inv(md.sub(pl.s, pl2.s)).expect("s - s' is invertible");
            let b = md.mul(md.sub(r, r2), d);
            let a = md.sub(r, md.mul(b, pl.s));
            ra.push(a);
            rb.push(b);
        }
        QElt { a: self.crt.reconstruct(&ra), b: self.crt.reconstruct(&rb) }
    }
}

/// Every modulus is a prime above 2^61, as in fpoly.rs. Checked.
const MIN_PRIME_BITS: u64 = 61;

/// Enough pairs of places above distinct primes for coefficients of fewer
/// than `bits` bits (|a|, |b| < 2^bits), as fpoly::pairs_for_bits.
pub fn pairs_for_bits(f: &QuadField, bits: u64) -> Result<Vec<(GPlace, GPlace)>, String> {
    let k = pairs_needed(bits)?;
    let out: Vec<(GPlace, GPlace)> = place_pairs(*f).take(k).collect();
    assert!(out.iter().all(|pp| pp.0.p() >> MIN_PRIME_BITS >= 1), "a modulus below 2^61");
    Ok(out)
}

/// An integer bound for |w| under both embeddings: 1 + isqrt(D) >= sqrt D
/// >= |(t +- sqrt D)/2| (t is 0 or 1).
pub fn w_bound(f: &QuadField) -> BigInt {
    BigInt::from(1 + (f.disc as u64).sqrt())
}

/// The monic gcd over F of f (monic, in O_F[x]) and h (monic, in Z[x]),
/// where every root of f has absolute value at most root_bound under every
/// embedding, as fpoly::gcd_with_z: computed modulo pairs of places, where
/// the gcd of the reductions has the right degree except at finitely many
/// places (those of least degree are kept), recovered with the coefficient
/// bound, and checked to divide f and h exactly.
pub fn gcd_with_z(fld: &QuadField, f: &[QElt], h: &[BigInt], root_bound: &BigInt) -> Result<QPoly, String> {
    let hf = from_z(h);
    let mut kept: Vec<((GPlace, GPlace), Vec<u64>, Vec<u64>)> = vec![];
    let mut deg = usize::MAX;
    let mut checked_with = 0usize;
    for (n, pp) in place_pairs(*fld).enumerate() {
        if n > 2000 {
            break;
        }
        sagebrush_interrupt::check();
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
            return Ok(vec![QElt::int(1)]);
        }
        let need = pairs_needed(coefficient_bits(deg, root_bound))?;
        assert!(pp.0.p() >> MIN_PRIME_BITS >= 1, "a modulus below 2^61");
        if kept.len() < need || kept.len() < checked_with * 2 {
            continue;
        }
        checked_with = kept.len();
        let pairs: Vec<(GPlace, GPlace)> = kept.iter().map(|(pp, _, _)| *pp).collect();
        let crt = PairCrt::new(&pairs);
        let g: QPoly = (0..=deg).map(|i| crt.reconstruct(&kept.iter().map(|(_, a, b)| (a[i], b[i])).collect::<Vec<_>>())).collect();
        if div_exact_monic(fld, f, &g).is_some() && div_exact_monic(fld, &hf, &g).is_some() {
            return Ok(g);
        }
    }
    Err("the gcd over F did not stabilize".into())
}

/// The irreducible factors over F of a monic squarefree f in O_F[x], monic
/// in O_F[x], where every root of f has absolute value at most root_bound
/// under both embeddings: Trager's method as in fpoly::factor_squarefree
/// (Cohen, "A Course in Computational Algebraic Number Theory", Algorithm
/// 3.6.4), shifting by k w with |w| <= w_bound.
pub fn factor_squarefree(fld: &QuadField, f: &[QElt], root_bound: &BigInt) -> Result<Vec<QPoly>, String> {
    let f = trim(f.to_vec());
    if f.len() <= 1 {
        return Ok(vec![]);
    }
    if f.len() == 2 {
        return Ok(vec![f]);
    }
    let wb = w_bound(fld);
    for t in 0..40i64 {
        sagebrush_interrupt::check();
        let k = if t % 2 == 1 { (t + 1) / 2 } else { -(t / 2) };
        // f_k(x) = f(x - k w)
        let fk = shift(fld, &f, &QElt::new(0, -k));
        let n = norm(fld, &fk)?;
        let dn = zpoly::trim(n.iter().enumerate().skip(1).map(|(i, c)| c * &BigInt::from(i as i64)).collect());
        if zpoly::gcd(&n, &dn).len() != 1 {
            continue;
        }
        let bound = root_bound + &wb * BigInt::from(k.abs());
        let mut out = vec![];
        for (h, e) in sagebrush_poly::try_factor(&n).map_err(|e| e.to_string())?.1 {
            if e != 1 {
                return Err("the norm is not squarefree".into());
            }
            let g = gcd_with_z(fld, &fk, &h, &bound)?;
            if g.len() > 1 {
                // back: g(x + k w)
                out.push(shift(fld, &g, &QElt::new(0, k)));
            }
        }
        // the factors must multiply to f
        let mut prod = vec![QElt::int(1)];
        for g in &out {
            prod = mul(fld, &prod, g);
        }
        if prod != f {
            return Err("the factors over F do not multiply to the polynomial".into());
        }
        out.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
        return Ok(out);
    }
    Err("no shift with a squarefree norm found".into())
}

/// A bound for the absolute value of x under both real embeddings, as an
/// integer: |a| + |b| (1 + isqrt D).
pub fn elt_bound(f: &QuadField, x: &QElt) -> BigInt {
    x.a.abs() + x.b.abs() * w_bound(f)
}

/// The bit length of the bound, for the recovery of elements bounded by x.
pub fn bits_of(x: &BigInt) -> u64 {
    bitlen(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(a: i64, b: i64) -> QElt {
        QElt::new(a, b)
    }

    #[test]
    fn places_are_conjugate_roots() {
        for d in [2i64, 3, 5, 6, 10, 13, 106] {
            let f = QuadField::new(d).unwrap();
            for (a, b) in place_pairs(f).take(3) {
                for pl in [a, b] {
                    let md = pl.md;
                    // s^2 = t s + n
                    assert_eq!(md.mul(pl.s, pl.s), md.add(md.mul(pl.t, pl.s), md.from_i64(f.n)));
                }
                assert_ne!(a.s, b.s);
                // the reduction is a ring map
                let (x, y) = (q(3, -7), q(-11, 5));
                assert_eq!(a.red(&f.mul(&x, &y)), a.md.mul(a.red(&x), a.red(&y)));
                assert_eq!(b.red(&x), a.red(&f.conj(&x)));
            }
        }
    }

    #[test]
    fn pair_reconstruction() {
        for d in [2i64, 3, 13, 106] {
            let f = QuadField::new(d).unwrap();
            let pairs = pairs_for_bits(&f, 100).unwrap();
            let crt = PairCrt::new(&pairs);
            for c in [q(3, -7), QElt { a: BigInt::from(-123456789012i64), b: BigInt::from(98765432109i64) }, q(0, 1), q(-1, 0)] {
                let res: Vec<(u64, u64)> = pairs.iter().map(|(a, b)| (a.red(&c), b.red(&c))).collect();
                assert_eq!(crt.reconstruct(&res), c);
            }
        }
    }

    #[test]
    fn factor_over_f() {
        for d in [2i64, 3, 13] {
            let f = QuadField::new(d).unwrap();
            // (x - w)(x - conj w)(x^2 + w x + 3)(x^2 - 7): the first two are
            // conjugate, the last is rational and irreducible over F
            let cw = f.conj(&q(0, 1));
            let a = vec![q(0, -1), q(1, 0)];
            let b = vec![QElt { a: -&cw.a, b: -&cw.b }, q(1, 0)];
            let c = vec![q(3, 0), q(0, 1), q(1, 0)];
            let e = vec![q(-7, 0), q(0, 0), q(1, 0)];
            let g = mul(&f, &mul(&f, &mul(&f, &a, &b), &c), &e);
            let mut got = factor_squarefree(&f, &g, &BigInt::from(20)).unwrap();
            let mut want = vec![a, b, c, e];
            got.sort();
            want.sort();
            assert_eq!(got, want, "d = {}", d);
        }
        // x^2 - 2 splits over Q(sqrt 2)
        let f = QuadField::new(2).unwrap();
        assert_eq!(factor_squarefree(&f, &[q(-2, 0), q(0, 0), q(1, 0)], &BigInt::from(3)).unwrap().len(), 2);
    }

    #[test]
    fn factor_refusal_is_an_error() {
        let f = QuadField::new(2).unwrap();
        let g = [q(-2, 0), q(0, 0), q(1, 0)];
        let tight = sagebrush_poly::Limits { max_degree: 0, ..sagebrush_poly::Limits::DEFAULT };
        let e = sagebrush_poly::with_default_limits(tight, || factor_squarefree(&f, &g, &BigInt::from(3))).unwrap_err();
        assert!(e.starts_with("factor: resource limit exceeded"), "{}", e);
        assert_eq!(factor_squarefree(&f, &g, &BigInt::from(3)).unwrap().len(), 2);
    }
}
