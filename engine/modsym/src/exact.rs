//! Exact characteristic polynomials over Z, with a proof sketch.
//!
//! Let L be the integral plus-quotient of weight-2 modular symbols for
//! Gamma0(N) modulo torsion.  Its rank is g + e, where g is the genus of
//! X0(N) and e + 1 is the number of cusps up to the involution x -> -x
//! (the Eisenstein part of the plus space is the degree-zero part of the
//! cusp divisors fixed by that involution).  T_q acts on L integrally.
//! Over GF(p) the Manin-symbol presentation gives M(Z) (x) GF(p) (right
//! exactness); if its dimension equals g + e the torsion vanishes at p, so
//! the mod-p characteristic polynomial is the reduction of the integral
//! one.  Eigenvalues satisfy |a| <= 2 sqrt(q) on cusp forms (Eichler-Shimura
//! + Weil) and |a| <= 1 + q on Eisenstein series, which bounds the
//! coefficients; CRT over enough good primes then determines the
//! polynomial exactly.

use crate::linalg;
use crate::par;
use crate::presentation::Presentation;
use crate::space::Space;
use num_bigint::{BigInt, BigUint};
use num_traits::{One, Signed, ToPrimitive, Zero};

pub fn factor(mut n: u64) -> Vec<(u64, u32)> {
    let mut out = vec![];
    let mut p = 2;
    while p * p <= n {
        let mut e = 0;
        while n % p == 0 {
            n /= p;
            e += 1;
        }
        if e > 0 {
            out.push((p, e));
        }
        p += 1;
    }
    if n > 1 {
        out.push((n, 1));
    }
    out
}

fn kronecker_minus(d: i64, p: u64) -> i64 {
    // (d/p) for d in {-1, -3}, p prime
    let p = p as i64;
    if d == -1 {
        return if p == 2 { 0 } else if p % 4 == 1 { 1 } else { -1 };
    }
    if p == 3 {
        0
    } else if p % 3 == 1 {
        1
    } else {
        -1
    }
}

/// Level data for X0(N): (psi(N), genus, cusps, Eisenstein dimension of the
/// sign +1 space, dimension of the sign +1 space).
pub fn level_data(n: u64) -> (u64, u64, u64, u64, u64) {
    let f = factor(n);
    let psi = f.iter().fold(n, |acc, &(p, _)| acc / p * (p + 1));
    let nu2: i64 = if n % 4 == 0 { 0 } else { f.iter().map(|&(p, _)| 1 + kronecker_minus(-1, p)).product() };
    let nu3: i64 = if n % 9 == 0 { 0 } else { f.iter().map(|&(p, _)| 1 + kronecker_minus(-3, p)).product() };
    // Cusps over d | N: phi(gcd(d, N/d)) of them, paired by x -> -x when
    // gcd(d, N/d) > 2.
    let (mut cusps, mut orbits) = (0u64, 0u64);
    for d in 1..=n {
        if n % d == 0 {
            let g = crate::p1::gcd(d, n / d);
            let phi = factor(g).iter().fold(g, |acc, &(p, _)| acc / p * (p - 1));
            cusps += phi;
            orbits += if g > 2 { phi / 2 } else { phi };
        }
    }
    // 12 g = 12 + psi - 3 nu2 - 4 nu3 - 6 c
    let g12 = 12 + psi as i64 - 3 * nu2 - 4 * nu3 - 6 * cusps as i64;
    let genus = (g12 / 12) as u64;
    (psi, genus, cusps, orbits - 1, genus + orbits - 1)
}

pub fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    for p in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        if n % p == 0 {
            return n == p;
        }
    }
    let (mut d, mut s) = (n - 1, 0);
    while d % 2 == 0 {
        d /= 2;
        s += 1;
    }
    let mulmod = |a: u64, b: u64| ((a as u128 * b as u128) % n as u128) as u64;
    'outer: for a in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        let mut x = 1u64;
        let (mut b, mut e) = (a, d);
        while e > 0 {
            if e & 1 == 1 {
                x = mulmod(x, b);
            }
            b = mulmod(b, b);
            e >>= 1;
        }
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 1..s {
            x = mulmod(x, x);
            if x == n - 1 {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

#[derive(Debug, Clone)]
pub struct Exact {
    pub n: u64,
    pub q: u64,
    pub genus: u64,
    pub cusps: u64,
    /// Dimension of the Eisenstein part of the sign +1 space.
    pub eis: u64,
    pub dim: u64,
    /// Coefficients, constant term first; monic of degree dim.
    pub coeffs: Vec<BigInt>,
    pub primes_used: Vec<u64>,
    pub primes_rejected: Vec<u64>,
    pub bound_bits: f64,
    pub status: &'static str,
    pub checks: Vec<String>,
}

/// Bits of a bound on |coefficient| (plus sign and margin).
pub fn bound_bits(q: u64, genus: u64, eis: u64) -> f64 {
    let qf = q as f64;
    genus as f64 * (1.0 + 2.0 * qf.sqrt()).log2() + eis as f64 * (2.0 + qf).log2() + 2.0
}

/// A sharper proven bound from the sum of squares of all eigenvalues,
/// p2 = e1^2 - 2 e2 (read off a charpoly mod p).  Cusp eigenvalues are real,
/// so by Jensen (log(1 + sqrt x) is concave) prod (1 + |l|) <= (1 + r)^g with
/// r^2 = (sum over cusp eigenvalues of l^2) / g.  Eisenstein eigenvalues
/// chi(q) + psi(q) q have |l| <= 1 + q; for squarefree N they all equal q + 1.
pub fn bound_bits_from_squares(n: u64, q: u64, genus: u64, eis: u64, p2: i128) -> f64 {
    let qf = q as f64;
    let squarefree = factor(n).iter().all(|&(_, e)| e == 1);
    let eis_sq = eis as f64 * (1.0 + qf) * (1.0 + qf);
    let cusp_sq = if squarefree { p2 as f64 - eis_sq } else { p2 as f64 + eis_sq };
    let r = if genus == 0 { 0.0 } else { (cusp_sq.max(0.0) / genus as f64).sqrt() };
    genus as f64 * (1.0 + r).log2() + eis as f64 * (2.0 + qf).log2() + 2.0
}

/// The exact sum of squares of the eigenvalues from a charpoly mod p, if p
/// is large enough for the symmetric residue to be the integer.
fn sum_of_squares(f: &[u64], p: u64, dim: u64, q: u64) -> Option<i128> {
    let d = dim as usize;
    if d < 2 || 2 * dim as u128 * (1 + q as u128).pow(2) >= p as u128 {
        return None;
    }
    let (c1, c2) = (f[d - 1] as u128, f[d - 2] as u128);
    let v = ((c1 * c1 + 2 * (p as u128 - c2)) % p as u128) as i128;
    Some(if v > p as i128 / 2 { v - p as i128 } else { v })
}

pub fn exact_charpoly(n: u64, q: u64) -> Result<Exact, String> {
    crate::validate(n, q, None)?;
    let (_, genus, cusps, eis, dim) = level_data(n);
    let worst = bound_bits(q, genus, eis);
    let mut need = worst;
    let mut refined: Option<i128> = None;
    // Batch sizing only: the Sato-Tate guess r = sqrt(q).
    let guess = genus as f64 * (1.0 + (q as f64).sqrt()).log2() + eis as f64 * (2.0 + q as f64).log2() + 2.0;
    let pres = Presentation::new(n);
    let (mut used, mut rejected) = (vec![], vec![]);
    let mut residues: Vec<(u64, Vec<u64>)> = vec![];
    let mut bits = 0.0;
    let mut next = 1u64 << 31;
    while bits < need {
        sagebrush_interrupt::check();
        // A batch of primes, computed in parallel: no more than are still
        // needed (each prime adds 30.99 bits), and at most 8 for memory.
        let target = if refined.is_some() { need } else { guess.min(need) };
        let want = (((target - bits) / 30.99).ceil() as usize).clamp(1, 8);
        let mut batch = vec![];
        while batch.len() < want {
            sagebrush_interrupt::check();
            next -= 1;
            if is_prime(next) {
                batch.push(next);
            }
        }
        let results = charpolys_mod(&pres, q, dim, &batch);
        for (p, r) in results {
            if let (None, Some(f)) = (refined, &r) {
                if let Some(p2) = sum_of_squares(f, p, dim, q) {
                    refined = Some(p2);
                    need = need.min(bound_bits_from_squares(n, q, genus, eis, p2));
                }
            }
            match r {
                Some(f) if bits < need => {
                    bits += (p as f64).log2();
                    used.push(p);
                    residues.push((p, f));
                }
                Some(_) => {}
                None => rejected.push(p),
            }
        }
        if rejected.len() > 16 {
            return Err(format!("too many primes with the wrong dimension (expected {})", dim));
        }
    }
    let coeffs = crt(&residues, dim as usize);
    let mut checks = vec![];
    let monic = coeffs.last().map_or(false, |c| c.is_one());
    checks.push(format!("monic of degree {}: {}", dim, monic));
    let x = BigInt::from(q + 1);
    let at = coeffs.iter().rev().fold(BigInt::zero(), |acc, c| acc * &x + c);
    let eis_ok = eis == 0 || at.is_zero();
    checks.push(format!("q + 1 is a root (an Eisenstein eigenvalue): {}", eis_ok));
    let max_bits = coeffs.iter().map(|c| c.abs().bits()).max().unwrap_or(0);
    checks.push(format!("largest coefficient has {} bits, bound {:.0}", max_bits, need));
    if let Some(p2) = refined {
        checks.push(format!("bound from the sum of squares of the eigenvalues {} (worst case {:.0} bits)", p2, worst));
    }
    let status = if monic && eis_ok && (max_bits as f64) < need { "proven" } else { "inconsistent" };
    Ok(Exact { n, q, genus, cusps, eis, dim, coeffs, primes_used: used, primes_rejected: rejected, bound_bits: need, status, checks })
}

/// Charpolys of T_q modulo each prime of a batch (None where the dimension
/// is wrong), the primes in parallel.  Measured against building the Hecke
/// matrices one prime at a time and running 8 primes through one
/// interleaved SIMD kernel: that halves memory but was 1.5x slower.
fn charpolys_mod(pres: &Presentation, q: u64, dim: u64, batch: &[u64]) -> Vec<(u64, Option<Vec<u64>>)> {
    par::map_slice(batch, |&p| {
        let sp = Space::new(pres, p);
        if sp.dimension() as u64 != dim {
            return (p, None);
        }
        (p, Some(linalg::charpoly(sp.hecke_matrix(pres, q), p)))
    })
}

/// Chinese remaindering to symmetric representatives.
fn crt(residues: &[(u64, Vec<u64>)], dim: usize) -> Vec<BigInt> {
    let mut modulus = BigUint::one();
    let mut acc = vec![BigUint::zero(); dim + 1];
    for (p, f) in residues {
        let pb = BigUint::from(*p);
        let m_mod_p = (&modulus % &pb).to_u64().unwrap();
        let inv = modpow(m_mod_p, p - 2, *p);
        for (k, a) in acc.iter_mut().enumerate() {
            let r = (&*a % &pb).to_u64().unwrap();
            let t = ((f[k] + p - r) % p) as u128 * inv as u128 % *p as u128;
            *a += &modulus * BigUint::from(t as u64);
        }
        modulus *= pb;
    }
    let half = &modulus >> 1;
    acc.into_iter().map(|a| if a > half { BigInt::from(a) - BigInt::from(modulus.clone()) } else { BigInt::from(a) }).collect()
}

fn modpow(mut b: u64, mut e: u64, m: u64) -> u64 {
    let mut r = 1u128;
    let mut bb = (b % m) as u128;
    while e > 0 {
        if e & 1 == 1 {
            r = r * bb % m as u128;
        }
        bb = bb * bb % m as u128;
        e >>= 1;
    }
    b = r as u64;
    b
}

/// Exact characteristic polynomials of T_q for many levels, in parallel over
/// levels; each entry is independent (an invalid level is an `Err`).
pub fn batch_exact(levels: &[u64], q: u64) -> Vec<Result<Exact, String>> {
    par::map_slice(levels, |&n| exact_charpoly(n, q))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_prime_matches_trial_division() {
        let slow = |n: u64| n >= 2 && (2..).take_while(|d| d * d <= n).all(|d| n % d != 0);
        for n in 0..20000 {
            assert_eq!(is_prime(n), slow(n), "{}", n);
        }
        for p in [2147483647u64, 2305843009213693951, 18446744073709551557] {
            assert!(is_prime(p), "{}", p);
        }
        // Carmichael numbers and strong pseudoprimes to small bases.
        for c in [561u64, 41041, 825265, 3215031751, 3825123056546413051] {
            assert!(!is_prime(c), "{}", c);
        }
    }

    #[test]
    fn crt_recovers_signed_integers() {
        let primes = [2147483647u64, 2147483629, 2147483587, 2147483579];
        let values: Vec<BigInt> = ["0", "1", "-1", "123456789012345678901234567890", "-98765432109876543210987654321"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        let residues: Vec<(u64, Vec<u64>)> = primes
            .iter()
            .map(|&p| {
                let pb = BigInt::from(p);
                (p, values.iter().map(|v| ((v % &pb + &pb) % &pb).to_u64().unwrap()).collect())
            })
            .collect();
        assert_eq!(crt(&residues, values.len() - 1), values);
    }

    /// X0(N) has genus 0 exactly for these N (a classical list).
    #[test]
    fn genus_zero_levels() {
        let zero: Vec<u64> = (1..=200).filter(|&n| level_data(n).1 == 0).collect();
        assert_eq!(zero, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 18, 25]);
        assert_eq!(level_data(11).1, 1);
        assert_eq!(level_data(37).1, 2);
        assert_eq!(level_data(389).1, 32);
    }

    /// The sharpened bound is never weaker than Deligne's, and the result
    /// actually fits in it.
    #[test]
    fn sharpened_bound_is_sound_and_no_weaker() {
        for n in (11..400).step_by(7) {
            let q = [2u64, 3, 5, 7, 11].into_iter().find(|q| n % q != 0).unwrap();
            let e = exact_charpoly(n, q).unwrap();
            assert_eq!(e.status, "proven", "N={}", n);
            assert!(e.bound_bits <= bound_bits(q, e.genus, e.eis) + 1e-9, "N={}", n);
            let max_bits = e.coeffs.iter().map(|c| c.abs().bits()).max().unwrap();
            assert!((max_bits as f64) < e.bound_bits, "N={}", n);
        }
    }
}

/// The characteristic polynomial over Z (constant term first) of the
/// combination T = sum r_i T_{q_i}, for primes q_i not dividing N.  Same
/// method as `exact_charpoly`: CRT over primes with the dimension check,
/// and a proven bound: cusp eigenvalues are real with |l| <= B_c =
/// sum |r_i| 2 sqrt(q_i), Eisenstein ones |l| <= B_e = sum |r_i| (1 + q_i);
/// the sum of squares p2 from the first prime gives sum_cusp l^2 <=
/// p2 + e B_e^2, and then Jensen as before.
pub fn exact_charpoly_combo(n: u64, ops: &[(u64, i64)]) -> Result<Vec<BigInt>, String> {
    for &(q, _) in ops {
        crate::validate(n, q, None)?;
    }
    let (_, genus, _, eis, dim) = level_data(n);
    let bc: f64 = ops.iter().map(|&(q, r)| r.unsigned_abs() as f64 * 2.0 * (q as f64).sqrt()).sum();
    let be: f64 = ops.iter().map(|&(q, r)| r.unsigned_abs() as f64 * (1.0 + q as f64)).sum();
    let mut need = genus as f64 * (1.0 + bc).log2() + eis as f64 * (1.0 + be).log2() + 2.0;
    let mut refined = false;
    let pres = Presentation::new(n);
    let mut residues: Vec<(u64, Vec<u64>)> = vec![];
    let (mut bits, mut rejected) = (0.0, 0);
    let mut next = 1u64 << 31;
    while bits < need {
        sagebrush_interrupt::check();
        let want = (((need - bits) / 30.99).ceil() as usize).clamp(1, 8);
        let mut batch = vec![];
        while batch.len() < want {
            sagebrush_interrupt::check();
            next -= 1;
            if is_prime(next) {
                batch.push(next);
            }
        }
        let results = par::map_slice(&batch, |&p| {
            let sp = Space::new(&pres, p);
            if sp.dimension() as u64 != dim {
                return (p, None);
            }
            let mut t = vec![vec![0u64; dim as usize]; dim as usize];
            for &(q, r) in ops {
                let rq = r.rem_euclid(p as i64) as u64;
                for (row, hrow) in t.iter_mut().zip(sp.hecke_matrix(&pres, q)) {
                    for (x, h) in row.iter_mut().zip(hrow) {
                        *x = ((*x as u128 + rq as u128 * h as u128) % p as u128) as u64;
                    }
                }
            }
            (p, Some(linalg::charpoly(t, p)))
        });
        for (p, r) in results {
            match r {
                Some(f) => {
                    if !refined && dim >= 2 && (p as f64) > 4.0 * dim as f64 * be.max(bc) * be.max(bc) {
                        let d = dim as usize;
                        let (c1, c2) = (f[d - 1] as u128, f[d - 2] as u128);
                        let v = ((c1 * c1 + 2 * (p as u128 - c2)) % p as u128) as i128;
                        let p2 = if v > p as i128 / 2 { v - p as i128 } else { v } as f64;
                        let cusp_sq = (p2 + eis as f64 * be * be).max(0.0);
                        let r = if genus == 0 { 0.0 } else { (cusp_sq / genus as f64).sqrt() };
                        need = need.min(genus as f64 * (1.0 + r).log2() + eis as f64 * (1.0 + be).log2() + 2.0);
                        refined = true;
                    }
                    if bits < need {
                        bits += (p as f64).log2();
                        residues.push((p, f));
                    }
                }
                None => rejected += 1,
            }
        }
        if rejected > 16 {
            return Err(format!("too many primes with the wrong dimension (expected {})", dim));
        }
    }
    let coeffs = crt(&residues, dim as usize);
    let max_bits = coeffs.iter().map(|c| c.abs().bits()).max().unwrap_or(0) as f64;
    if !coeffs.last().map_or(true, |c| c.is_one()) || max_bits >= need {
        return Err(format!("N = {}: inconsistent multimodular charpoly ({} bits, bound {:.0})", n, max_bits, need));
    }
    Ok(coeffs)
}
