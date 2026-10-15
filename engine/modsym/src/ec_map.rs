//! The modular symbol map of an elliptic curve over Q, sign +1: the
//! functional X on the Manin symbols (c:d) of P^1(Z/NZ) that belongs to the
//! curve's newform (T_q X = a_q X for q not dividing N), as a primitive
//! integer vector, and its values at cusps by Manin's continued fractions.
//!
//! X is computed modulo several 31-bit primes p: the kernel of the stacked
//! T_q - a_q on the quotient of the Manin symbols by the 2- and 3-term
//! relations (presentation.rs, space.rs), for primes q not dividing N until
//! it is one-dimensional, extended to every symbol.  The kernel over Q has
//! dimension at most that over GF(p), so a one-dimensional kernel mod p
//! makes X unique up to a scalar.  The values are lifted by CRT and
//! rational reconstruction, scaled to a primitive integer vector, and then
//! checked exactly: every 3-term relation and T_q X = a_q X for every q
//! used.
//!
//! Evaluation follows psage's modular_symbol_map.pyx (William Stein, ported
//! with his permission: NOTICE.md): with q_0 = 1, q_1, ..., q_n the
//! denominators of the continued fraction convergents of a/b, the sum of
//! X(((-1)^(i-1) q_i : q_(i-1))) for i = 1..n is the symbol {0, a/b} in X's
//! units; the scale and the value at 0 are the caller's (lib/_sage_modular.py
//! normalizes by L-values).

use crate::p1::P1List;
use crate::presentation::Presentation;
use crate::space::Space;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

pub struct EcMap {
    pub n: u64,
    pub p1: P1List,
    /// X on each Manin symbol, by P1List index (primitive, integral)
    pub x: Vec<BigInt>,
    /// the primes q whose Hecke relations were checked
    pub hecke_primes: Vec<u64>,
}

fn kernel_mod(rows: &[Vec<u64>], d: usize, p: u64) -> Vec<Vec<u64>> {
    let (r, piv) = crate::linalg::rref_mod(rows.to_vec(), p);
    let is_piv: Vec<bool> = (0..d).map(|c| piv.contains(&c)).collect();
    (0..d).filter(|&c| !is_piv[c]).map(|f| {
        let mut v = vec![0u64; d];
        v[f] = 1;
        for (i, &pc) in piv.iter().enumerate() {
            v[pc] = (p - r[i][f] % p) % p;
        }
        v
    }).collect()
}

/// X modulo p, scaled so that X(j0) = 1 for the first nonzero j0, or None
/// if the kernel is not one-dimensional for these q.
fn x_mod(pres: &Presentation, p: u64, aps: &[(u64, i64)]) -> Option<(usize, Vec<u64>)> {
    let sp = Space::new(pres, p);
    let d = sp.dimension();
    let mut rows: Vec<Vec<u64>> = vec![];
    for &(q, a) in aps {
        sagebrush_interrupt::check();
        let mut t = sp.hecke_matrix(pres, q);
        let am = a.rem_euclid(p as i64) as u64;
        for (i, row) in t.iter_mut().enumerate() {
            row[i] = (row[i] + p - am) % p;
        }
        rows.extend(t);
    }
    let k = kernel_mod(&rows, d, p);
    if k.len() != 1 {
        return None;
    }
    let psi = sp.extend(&k[0]);
    let vals: Vec<u64> = pres.rep_of.iter().map(|r| match r {
        Some((g, neg)) => {
            let v = psi[*g as usize];
            if *neg { (p - v) % p } else { v }
        }
        None => 0,
    }).collect();
    let j0 = vals.iter().position(|&v| v != 0)?;
    let inv = powmod(vals[j0], p - 2, p);
    Some((j0, vals.iter().map(|&v| (v as u128 * inv as u128 % p as u128) as u64).collect()))
}

fn powmod(mut b: u64, mut e: u64, p: u64) -> u64 {
    let mut r = 1u64;
    b %= p;
    while e > 0 {
        if e & 1 == 1 {
            r = (r as u128 * b as u128 % p as u128) as u64;
        }
        b = (b as u128 * b as u128 % p as u128) as u64;
        e >>= 1;
    }
    r
}

/// n/d congruent to a mod m with |n|, d <= sqrt(m/2), or None.
fn ratrec(a: &BigInt, m: &BigInt) -> Option<(BigInt, BigInt)> {
    let bound = (m / BigInt::from(2u32)).sqrt();
    let (mut r0, mut r1) = (m.clone(), a.mod_floor_big(m));
    let (mut s0, mut s1) = (BigInt::zero(), BigInt::one());
    while r1 > bound {
        let q = &r0 / &r1;
        let r2 = &r0 - &q * &r1;
        r0 = std::mem::replace(&mut r1, r2);
        let s2 = &s0 - &q * &s1;
        s0 = std::mem::replace(&mut s1, s2);
    }
    if s1.is_zero() || s1.abs() > bound {
        return None;
    }
    if s1.is_negative() {
        Some((-r1, -s1))
    } else {
        Some((r1, s1))
    }
}

trait ModFloor {
    fn mod_floor_big(&self, m: &BigInt) -> BigInt;
}

impl ModFloor for BigInt {
    fn mod_floor_big(&self, m: &BigInt) -> BigInt {
        let r = self % m;
        if r.is_negative() { r + m } else { r }
    }
}

fn gcd_big(a: &BigInt, b: &BigInt) -> BigInt {
    let (mut a, mut b) = (a.abs(), b.abs());
    while !b.is_zero() {
        let r = &a % &b;
        a = std::mem::replace(&mut b, r);
    }
    a
}

/// The map for the curve of conductor n with Fourier coefficients a_q
/// (`aps`: (q, a_q) for primes q not dividing n, ascending; as many as
/// needed are used).  Each q must be a prime below 2^30 not dividing n,
/// and each a_q must satisfy the Hasse bound a_q^2 <= 4q.
pub fn ec_map(n: u64, aps: &[(u64, i64)]) -> Result<EcMap, String> {
    if n < 11 {
        return Err("there are no elliptic curves of conductor below 11".into());
    }
    for &(q, a) in aps {
        crate::validate(n, q, None)?;
        if (a as i128) * (a as i128) > 4 * q as i128 {
            return Err(format!("a_{} = {} violates the Hasse bound a_q^2 <= 4q", q, a));
        }
    }
    let aps = aps.to_vec();
    // the Sturm bound for weight 2 on Gamma0(n): [SL2(Z) : Gamma0(n)] / 6
    let sturm = sturm_bound(n);
    let have: std::collections::HashSet<u64> = aps.iter().map(|e| e.0).collect();
    if let Some(q) = (2..=sturm).find(|&q| crate::exact::is_prime(q) && n % q != 0 && !have.contains(&q)) {
        return Err(format!("a_q is needed for every prime q <= {} (the Sturm bound) not dividing N; {} is missing", sturm, q));
    }
    let pres = Presentation::new(n);
    // the Hecke operators needed: add q until the kernel mod the first
    // prime is one-dimensional
    let mut primes = (2u64..(1 << 31)).rev().filter(|&p| crate::exact::is_prime(p));
    let p0 = primes.next().unwrap();
    let mut used = 0;
    let mut first = None;
    for k in 1..=aps.len() {
        if let Some(r) = x_mod(&pres, p0, &aps[..k]) {
            used = k;
            first = Some(r);
            break;
        }
    }
    let Some((j0, v0)) = first else {
        return Err("the Hecke eigenvalues given do not cut out a one-dimensional space (more a_q, or not a newform of this level)".into());
    };
    let qs = &aps[..used];
    // CRT over primes with the same normalizing index j0
    let mut m = BigInt::from(p0);
    let mut res: Vec<BigInt> = v0.iter().map(|&v| BigInt::from(v)).collect();
    let mut last: Option<Vec<(BigInt, BigInt)>> = None;
    for _round in 0..64 {
        sagebrush_interrupt::check();
        let rec: Option<Vec<(BigInt, BigInt)>> = res.iter().map(|a| ratrec(a, &m)).collect();
        if let Some(rec) = rec {
            if last.as_ref() == Some(&rec) {
                // the primitive integer vector, then the exact checks
                let mut den = BigInt::one();
                for (_, d) in &rec {
                    den = &den / gcd_big(&den, d) * d;
                }
                let mut x: Vec<BigInt> = rec.iter().map(|(a, d)| a * (&den / d)).collect();
                let g = x.iter().fold(BigInt::zero(), |g, v| gcd_big(&g, v));
                if !g.is_zero() {
                    x = x.into_iter().map(|v| v / &g).collect();
                }
                if verify(&pres, &x, qs) {
                    all_eigenvalues_match(&pres, &x, &aps, p0, sturm)?;
                    return Ok(EcMap { n, p1: P1List::new(n), x, hecke_primes: qs.iter().map(|e| e.0).collect() });
                }
            }
            last = Some(rec);
        }
        // one more prime
        let p = primes.next().ok_or("out of primes")?;
        let Some((j, v)) = x_mod(&pres, p, qs) else { continue };
        if j != j0 {
            continue; // X(j0) = 0 mod p: an unlucky prime
        }
        let pb = BigInt::from(p);
        let minv = BigInt::from(powmod((&m % &pb).to_u64().unwrap(), p - 2, p));
        for (r, &vp) in res.iter_mut().zip(&v) {
            // r + m t = vp mod p
            let t = ((BigInt::from(vp) - &*r).mod_floor_big(&pb) * &minv).mod_floor_big(&pb);
            *r = &*r + &m * t;
        }
        m = &m * &pb;
    }
    Err("the modular symbol map did not stabilize".into())
}

/// [SL2(Z) : Gamma0(n)] / 6 = n prod_(p | n) (1 + 1/p) / 6, rounded up.
fn sturm_bound(n: u64) -> u64 {
    let mut idx = n;
    for (p, _) in crate::exact::factor(n) {
        idx = idx / p * (p + 1);
    }
    idx.div_ceil(6)
}

/// X spans the common kernel of T_q - a_q for the q used, which the other
/// Hecke operators preserve (they commute): so T_r X = b_r X with b_r an
/// integer (X is primitive integral and T_r integral), and b_r is a Hecke
/// eigenvalue of weight 2 on Gamma0(n): r + 1 (Eisenstein) or at most
/// 2 sqrt(r) in absolute value (cuspidal: Deligne), so |b_r| <= r + 1.
/// ec_map checks a_r^2 <= 4r, so |a_r| < r + 1, and r is a prime below
/// 2^30, so r <= 2^30 - 35 (the largest one) and |b_r - a_r| < 2(r + 1)
/// < 2^31 - 1 = p: two distinct such integers are not congruent modulo p
/// (both sides of the bound are needed, hence the factor 2).  Checking T_r X = a_r X modulo p (with X mod p
/// nonzero) for every given r (every good prime up to the Sturm bound, at
/// least) therefore proves b_r = a_r: X is the eigenvector of these
/// eigenvalues, not of another eigenform sharing the first few.
fn all_eigenvalues_match(pres: &Presentation, x: &[BigInt], aps: &[(u64, i64)], p: u64, sturm: u64) -> Result<(), String> {
    let pb = BigInt::from(p);
    let psi: Vec<u64> = pres.sym_of_gen.iter().map(|&(i, neg)| {
        let v = x[i as usize].mod_floor_big(&pb).to_u64().unwrap();
        if neg { (p - v) % p } else { v }
    }).collect();
    if psi.iter().all(|&v| v == 0) {
        return Err("the modular symbol map vanishes modulo the check prime".into());
    }
    for &(q, a) in aps {
        if q > sturm.max(2) && q > 100 {
            continue;
        }
        sagebrush_interrupt::check();
        let h = crate::linalg::heilbronn(q as i64);
        let am = a.rem_euclid(p as i64) as u64;
        for g in 0..pres.m as u32 {
            let img = Space::hecke_image(pres, &h, g);
            let s = img.iter().fold(0i128, |acc, &(g2, c)| (acc + c as i128 * psi[g2 as usize] as i128).rem_euclid(p as i128)) as u64;
            if s != (am as u128 * psi[g as usize] as u128 % p as u128) as u64 {
                return Err(format!("the eigenvalue of T_{} is not the a_q given ({}): these are not the newform's of this level", q, a));
            }
        }
    }
    Ok(())
}

/// The exact checks: X is consistent on each 2-term class, satisfies every
/// 3-term relation, and T_q X = a_q X for each q.
fn verify(pres: &Presentation, x: &[BigInt], qs: &[(u64, i64)]) -> bool {
    // X on the free generators, from their representing symbols
    let psi: Vec<BigInt> = pres.sym_of_gen.iter().map(|&(i, neg)| if neg { -x[i as usize].clone() } else { x[i as usize].clone() }).collect();
    for (i, r) in pres.rep_of.iter().enumerate() {
        let want = match r {
            Some((g, neg)) => if *neg { -psi[*g as usize].clone() } else { psi[*g as usize].clone() },
            None => BigInt::zero(),
        };
        if x[i] != want {
            return false;
        }
    }
    for row in &pres.rows {
        let s: BigInt = row.iter().map(|&(g, v)| &psi[g as usize] * BigInt::from(v)).sum();
        if !s.is_zero() {
            return false;
        }
    }
    for &(q, a) in qs {
        let h = crate::linalg::heilbronn(q as i64);
        for g in 0..pres.m as u32 {
            let img = Space::hecke_image(pres, &h, g);
            let s: BigInt = img.iter().map(|&(g2, c)| &psi[g2 as usize] * BigInt::from(c)).sum();
            if s != &psi[g as usize] * BigInt::from(a) {
                return false;
            }
        }
    }
    true
}

/// The denominators q_0 = 1, q_1, ..., q_n of the convergents of a/b
/// (after the integer part), as psage's contfrac_q.
fn contfrac_q(a: i64, b: i64) -> Vec<i64> {
    let mut q = vec![1i64];
    if a == 0 {
        return q;
    }
    let (mut a, mut b) = (b, a.rem_euclid(b));
    let mut i = 1;
    while b != 0 {
        let t = a / b;
        if i >= 2 {
            let next = q[i - 1] * t + q[i - 2];
            q.push(next);
        } else {
            q.push(t);
        }
        let r = a % b;
        a = b;
        b = r;
        i += 1;
    }
    q
}

impl EcMap {
    /// The symbol {0, a/b} in X's units (b > 0, gcd(a, b) = 1).
    pub fn eval(&self, a: i64, b: i64) -> BigInt {
        let q = contfrac_q(a, b);
        let n = self.n as i64;
        let mut s = BigInt::zero();
        let mut sign = 1i64;
        for i in 1..q.len() {
            let j = self.p1.index((sign * q[i]).rem_euclid(n), q[i - 1].rem_euclid(n));
            s += &self.x[j];
            sign = -sign;
        }
        s
    }

    /// X((0:1)), the symbol {0, oo}.
    pub fn at_zero_symbol(&self) -> BigInt {
        self.x[self.p1.index(0, 1)].clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aps(a: [i64; 5], n: u64) -> Vec<(u64, i64)> {
        let e = sagebrush_ap::EllipticCurve::new(a).unwrap();
        sagebrush_ap::primes_up_to(200).into_iter().filter(|q| n % q != 0).map(|q| (q, e.ap(q).unwrap())).collect()
    }

    /// 11a1: Sage's E.modular_symbol() is r -> -(1/10)({0, r} - X(0:1))
    /// with these values (f(0) = 1/5, f(1/7) = 7/10, f(-3/7) = -9/5,
    /// f(1/5) = 6/5, f(3/11) = 1/2: the oracle).
    #[test]
    fn eleven_a1() {
        let m = ec_map(11, &aps([0, -1, 1, -10, -20], 11)).unwrap();
        assert_eq!(m.at_zero_symbol(), BigInt::from(2));
        for (a, b, v) in [(1, 7, -5), (-3, 7, 20), (1, 5, -10), (3, 11, -3), (0, 1, 0)] {
            assert_eq!(m.eval(a, b), BigInt::from(v), "{}/{}", a, b);
        }
    }

    /// Eigenvalues that are not a newform's of this level are refused: 11a1's
    /// a_q at level 37, and a_2 of 37a1 changed.
    #[test]
    fn refuses_foreign_eigenvalues() {
        assert!(ec_map(37, &aps([0, -1, 1, -10, -20], 11 * 37)).is_err());
        let mut b = aps([0, 0, 1, -1, 0], 37);
        b[0].1 += 1;
        assert!(ec_map(37, &b).is_err());
        assert!(ec_map(37, &aps([0, 0, 1, -1, 0], 37)).is_ok());
    }

    /// Bad pairs are refused before any modular work: q = 2^30 (heilbronn's
    /// range), a composite or bad q, and a_q off the Hasse bound (a_3 of
    /// 11a1 shifted by the check prime, which agrees modulo it).
    #[test]
    fn refuses_bad_pairs() {
        let p = 2147483647i64;
        for bad in [vec![(1 << 30, 0), (2, -2)], vec![(2, -2), (4, 0)], vec![(2, -2), (11, 1)], vec![(2, -2), (3, -1 + p)], vec![(2, -2), (3, -1 - p)], vec![(2, -2), (3, 4)]] {
            let mut aps = aps([0, -1, 1, -10, -20], 11);
            aps.extend(bad.iter().copied());
            assert!(ec_map(11, &aps).is_err(), "{:?}", bad);
        }
        let mut aps = aps([0, -1, 1, -10, -20], 11);
        aps.push((1073741789, 0));
        assert!(ec_map(11, &aps).is_ok());
    }

    #[test]
    fn contfrac_denominators() {
        // psage's doctests: 7/97 and 137/93997
        assert_eq!(contfrac_q(7, 97), vec![1, 13, 14, 97]);
        assert_eq!(contfrac_q(137, 93997), vec![1, 686, 6175, 43911, 93997]);
    }
}
