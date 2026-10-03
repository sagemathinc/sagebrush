//! Exact characteristic polynomials of T_q on M_k(Gamma0(N), eps)^sign,
//! with coefficients in Z[zeta_m], m = ord(eps), in the power basis
//! 1, zeta_m, ..., zeta_m^(phi(m)-1) (the basis of Sage's CyclotomicField(m)).
//!
//! Multimodular: for primes ell = 1 mod m, the charpoly is computed over
//! F_ell under all phi(m) embeddings zeta_m -> z^j (j a unit mod m), which
//! are the Galois-conjugate characters eps^j.  Inverting the Vandermonde
//! matrix (z^(j i)) gives every power-basis coordinate mod ell, and the
//! coordinates are then CRT-lifted over enough primes to exceed a proven
//! bound.  (Using one embedding per prime instead costs the same number of
//! charpolys for the same bits, but needs lattice reduction to lift.)
//!
//! Bound.  Every eigenvalue of T_q (or U_q) has |l| <= 1 + q^(k-1)
//! (Eisenstein, at most #cusps of Gamma0(N) of them) or |l| <= 2 q^((k-1)/2)
//! (cuspidal, Deligne), so every complex embedding of the coefficient of
//! x^(d-j) is at most A_j = e_j(those bounds).  For a in Z[zeta_m] with all
//! |sigma(a)| <= A, the coordinates in the powerful basis (the tensor product
//! of the power bases of Z[zeta_q] over the prime powers q || m) satisfy
//! a_t^2 <= (G^-1)_tt sum_sigma |sigma(a)|^2, where G is the trace Gram
//! matrix; G is a Kronecker product of q^(r-1) (p I - J) blocks, so
//! (G^-1)_tt = prod 2/q and a_t^2 <= prod_{p | m} 2 (1 - 1/p) A^2
//! <= 2^(odd primes of m) A^2.  Power-basis coordinates are integer
//! combinations of powerful ones, with row-sum norm ||C|| computed exactly.
//!
//! Dimension.  dim over F_ell >= dim over Q(zeta_m), with equality outside
//! finitely many ell; when they are equal the F_ell charpoly is the
//! reduction of the true one.  Primes (or conjugates) giving a larger
//! dimension are rejected, a smaller one restarts the computation.  There is
//! no independent dimension formula here yet, so the result is "proven
//! given the dimension" (status "conditional"), unlike weight 2.

use crate::exact::{factor, level_data};
use crate::general::{mul, powmod, primes_one_mod, root_of_unity, Character, GeneralSpace};
use crate::p1::gcd;
use crate::par;
use num_bigint::{BigInt, BigUint};
use num_traits::{One, Zero};

#[derive(Debug, Clone)]
pub struct ExactGeneral {
    pub n: u64,
    pub k: usize,
    pub sign: i32,
    pub q: u64,
    /// Order of the character: coefficients lie in Z[zeta_m].
    pub m: u64,
    pub dim: usize,
    /// coeffs[j][i] is the coefficient of zeta_m^i in the coefficient of x^j
    /// (constant term first, i < phi(m)); monic of degree dim.
    pub coeffs: Vec<Vec<BigInt>>,
    pub primes_used: Vec<u64>,
    pub primes_rejected: Vec<u64>,
    pub bound_bits: f64,
    pub status: &'static str,
    pub checks: Vec<String>,
}

/// The cyclotomic polynomial Phi_m, constant term first.
pub fn cyclotomic_poly(m: u64) -> Vec<i128> {
    // x^m - 1 divided by Phi_d for the proper divisors d of m.
    let mut f = vec![0i128; m as usize + 1];
    f[0] = -1;
    f[m as usize] = 1;
    for d in 1..m {
        if m % d == 0 {
            f = div_exact(&f, &cyclotomic_poly(d));
        }
    }
    f
}

fn div_exact(f: &[i128], g: &[i128]) -> Vec<i128> {
    // g monic.
    let mut r = f.to_vec();
    let (n, dg) = (f.len() - 1, g.len() - 1);
    let mut q = vec![0i128; n - dg + 1];
    for i in (0..=n - dg).rev() {
        let c = r[i + dg];
        q[i] = c;
        for (t, &gt) in g.iter().enumerate() {
            r[i + t] -= c * gt;
        }
    }
    debug_assert!(r.iter().all(|&x| x == 0));
    q
}

/// x^t mod Phi_m for t = 0..m-1, as power-basis vectors of length phi(m).
fn power_table(m: u64, phi_m: &[i128]) -> Vec<Vec<i128>> {
    let deg = (phi_m.len() - 1).max(1);
    let mut v = vec![0i128; deg];
    v[0] = 1;
    let mut out = vec![];
    for _ in 0..m.max(1) {
        out.push(v.clone());
        // multiply by x, then reduce x^deg = -(Phi_m - x^deg)
        let top = v[deg - 1];
        for i in (1..deg).rev() {
            v[i] = v[i - 1];
        }
        v[0] = 0;
        if top != 0 && phi_m.len() > 1 {
            for i in 0..deg {
                v[i] -= top * phi_m[i];
            }
        }
    }
    out
}

/// Row-sum norm max_i sum_t |C_it| of the matrix taking powerful-basis
/// coordinates to power-basis coordinates.
pub fn powerful_to_power_norm(m: u64) -> u128 {
    let f = factor(m);
    let phi_m = cyclotomic_poly(m);
    let deg = phi_m.len() - 1;
    if deg <= 1 {
        return 1;
    }
    // Each powerful basis element is prod zeta_q^(a_q) = zeta_m^(sum a_q m/q).
    let mut exps = vec![0u64];
    for &(p, r) in &f {
        let qq = p.pow(r);
        let phiq = qq / p * (p - 1);
        exps = exps.iter().flat_map(|&e| (0..phiq).map(move |a| (e + a * (m / qq)) % m)).collect();
    }
    let table = power_table(m, &phi_m);
    let mut rows = vec![0u128; deg];
    for t in exps {
        for (i, &c) in table[t as usize].iter().enumerate() {
            rows[i] += c.unsigned_abs();
        }
    }
    rows.into_iter().max().unwrap()
}

/// Inverse of a square matrix mod p (p prime), or None if singular.
fn invert_mod(a: &[Vec<u64>], p: u64) -> Option<Vec<Vec<u64>>> {
    let n = a.len();
    let mut m: Vec<Vec<u64>> = a.iter().enumerate().map(|(i, row)| {
        let mut r = row.clone();
        r.extend((0..n).map(|j| (i == j) as u64));
        r
    }).collect();
    for c in 0..n {
        let piv = (c..n).find(|&r| m[r][c] != 0)?;
        m.swap(c, piv);
        let iv = powmod(m[c][c], p - 2, p);
        for x in m[c].iter_mut() {
            *x = mul(*x, iv, p);
        }
        for r in 0..n {
            if r != c && m[r][c] != 0 {
                let f = m[r][c];
                for t in 0..2 * n {
                    m[r][t] = (m[r][t] + p - mul(f, m[c][t], p)) % p;
                }
            }
        }
    }
    Some(m.into_iter().map(|r| r[n..].to_vec()).collect())
}

/// Bound A_j on every complex embedding of the coefficient of x^(d-j), as
/// the coefficients of (1 + bE x)^nE (1 + bS x)^(d-nE).
fn embedding_bounds(d: usize, n_e: usize, b_e: &BigUint, b_s: &BigUint) -> Vec<BigUint> {
    let mut poly = vec![BigUint::one()];
    for t in 0..d {
        let b = if t < n_e { b_e } else { b_s };
        let mut next = vec![BigUint::zero(); poly.len() + 1];
        for (i, c) in poly.iter().enumerate() {
            next[i] += c;
            next[i + 1] += c * b;
        }
        poly = next;
    }
    poly
}

pub fn exact_charpoly(n: u64, k: usize, eps: &Character, sign: i32, q: u64) -> Result<ExactGeneral, String> {
    if !crate::exact::is_prime(q) {
        return Err(format!("q = {} must be prime", q));
    }
    let eps = eps.minimal();
    let m = eps.order;
    let units: Vec<u64> = (0..m.max(1)).filter(|&j| gcd(j, m) == 1).collect();
    let phi = units.len();
    let odd_primes = factor(m).iter().filter(|&&(p, _)| p != 2).count() as u64;
    let c_norm = powerful_to_power_norm(m);
    let cusps = level_data(n).2 as usize;
    let qk = BigUint::from(q).pow(k as u32 - 1);
    let b_e = &qk + 1u32;
    let b_s = (&qk * 4u32).sqrt() + 1u32;

    let (mut used, mut rejected) = (vec![], vec![]);
    // residues[r][j][i]: prime r, coefficient of x^j, coordinate i.
    let mut residues: Vec<(u64, Vec<Vec<u64>>)> = vec![];
    let mut dim: Option<usize> = None;
    let mut modulus = BigUint::one();
    // Need modulus^2 > need_sq = 4 ||C||^2 2^odd max_j A_j^2.
    let mut need_sq: Option<BigUint> = None;
    let mut primes = primes_one_mod(m, 1 << 31);
    loop {
        if let Some(ns) = &need_sq {
            if &modulus * &modulus > *ns {
                break;
            }
        }
        // A batch of primes (in parallel with their conjugates): enough for
        // the bound if known (31 bits each), at most 8 for memory.
        let want = match &need_sq {
            Some(ns) => ((ns.bits() as f64 / 2.0 - modulus.bits() as f64) / 30.9).ceil().clamp(1.0, 8.0) as usize,
            None => 1,
        };
        let batch: Vec<u64> = primes.by_ref().take(want).collect();
        if batch.is_empty() {
            return Err("ran out of primes".into());
        }
        let jobs: Vec<(u64, u64)> = batch.iter().flat_map(|&l| units.iter().map(move |&j| (l, j))).collect();
        let roots: Vec<(u64, u64)> = batch.iter().map(|&l| (l, root_of_unity(m, l))).collect();
        let out = par::map_slice(&jobs, |&(l, j)| {
            let z = roots.iter().find(|r| r.0 == l).unwrap().1;
            let sp = GeneralSpace::new_mod(n, k, &eps, sign, l, powmod(z, j, l))?;
            Ok::<_, String>((sp.dimension(), sp.hecke_charpoly(q)?))
        });
        for (b, &l) in batch.iter().enumerate() {
            let res: Vec<(usize, Vec<u64>)> = out[b * phi..(b + 1) * phi].iter().cloned().collect::<Result<_, _>>()?;
            let dmin = res.iter().map(|r| r.0).min().unwrap();
            let all_equal = res.iter().all(|r| r.0 == dmin);
            if dim.map_or(false, |d| dmin < d) {
                // Everything so far had too large a dimension.
                rejected.extend(used.drain(..));
                residues.clear();
                modulus = BigUint::one();
                need_sq = None;
                dim = None;
            }
            if !all_equal || dim.map_or(false, |d| dmin > d) {
                rejected.push(l);
                continue;
            }
            if dim.is_none() {
                dim = Some(dmin);
                let bounds = embedding_bounds(dmin, cusps.min(dmin), &b_e, &b_s);
                let amax = bounds.into_iter().max().unwrap();
                need_sq = Some(&amax * &amax * (4u128 * c_norm * c_norm) << odd_primes as usize);
            }
            // Coordinates mod l: V[j][i] = z^(u_j i), solve V a = values.
            let z = roots[b].1;
            let v: Vec<Vec<u64>> = units.iter().map(|&u| {
                let w = powmod(z, u, l);
                (0..phi).map(|i| powmod(w, i as u64, l)).collect()
            }).collect();
            let vinv = invert_mod(&v, l).ok_or("singular Vandermonde")?;
            let d = dmin;
            let coords: Vec<Vec<u64>> = (0..=d).map(|jdx| {
                (0..phi).map(|i| (0..phi).fold(0u64, |acc, t| (acc + mul(vinv[i][t], res[t].1[jdx], l)) % l)).collect()
            }).collect();
            residues.push((l, coords));
            used.push(l);
            modulus *= l;
        }
        if rejected.len() > 32 {
            return Err("too many primes with an inconsistent dimension".into());
        }
    }
    let d = dim.unwrap();
    let coeffs = crt(&residues, d, phi);
    let need_sq = need_sq.unwrap();
    let bound_bits = need_sq.bits() as f64 / 2.0;
    let mut checks = vec![];
    let monic = coeffs[d][0].is_one() && coeffs[d][1..].iter().all(|c| c.is_zero());
    checks.push(format!("monic of degree {}: {}", d, monic));
    let max_bits = coeffs.iter().flatten().map(|c| c.bits()).max().unwrap_or(0);
    checks.push(format!("largest coordinate has {} bits; modulus {} bits, need > {:.0}", max_bits, modulus.bits(), bound_bits));
    checks.push(format!("dimension {} at all {} primes x {} embeddings (not certified by a formula)", d, used.len(), phi));
    let status = if monic && (max_bits as f64) < bound_bits { "conditional" } else { "inconsistent" };
    Ok(ExactGeneral { n, k, sign, q, m, dim: d, coeffs, primes_used: used, primes_rejected: rejected, bound_bits, status, checks })
}

/// CRT to symmetric representatives; parallel over the coordinates.
fn crt(residues: &[(u64, Vec<Vec<u64>>)], d: usize, phi: usize) -> Vec<Vec<BigInt>> {
    // Mixed-radix (Garner) digits in u64, then one Horner pass in BigUint.
    let ls: Vec<u64> = residues.iter().map(|r| r.0).collect();
    let r = ls.len();
    // inv[a][b] = (l_0 ... l_(a-1))^-1 mod l_a, computed as a product.
    let inv: Vec<u64> = (0..r).map(|a| {
        let prod = (0..a).fold(1u64, |acc, b| mul(acc, ls[b] % ls[a], ls[a]));
        powmod(prod, ls[a] - 2, ls[a])
    }).collect();
    let modulus = ls.iter().fold(BigUint::one(), |acc, &l| acc * l);
    let half = &modulus >> 1;
    let idx: Vec<(usize, usize)> = (0..=d).flat_map(|j| (0..phi).map(move |i| (j, i))).collect();
    let flat = par::map_slice(&idx, |&(j, i)| {
        let mut digits = vec![0u64; r];
        for a in 0..r {
            let l = ls[a];
            // value of the mixed-radix prefix mod l
            let mut acc = 0u64;
            for b in (0..a).rev() {
                acc = (mul(acc, ls[b] % l, l) + digits[b] % l) % l;
            }
            digits[a] = mul((residues[a].1[j][i] + l - acc) % l, inv[a], l);
        }
        let mut x = BigUint::zero();
        for a in (0..r).rev() {
            x = x * ls[a] + digits[a];
        }
        if x > half { BigInt::from(x) - BigInt::from(modulus.clone()) } else { BigInt::from(x) }
    });
    flat.chunks(phi).map(|c| c.to_vec()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_traits::ToPrimitive;

    #[test]
    fn cyclotomic() {
        assert_eq!(cyclotomic_poly(1), vec![-1, 1]);
        assert_eq!(cyclotomic_poly(6), vec![1, -1, 1]);
        assert_eq!(cyclotomic_poly(12), vec![1, 0, -1, 0, 1]);
        // Phi_105 is the first with a coefficient -2.
        assert!(cyclotomic_poly(105).contains(&-2));
        // Prime powers: powerful basis = power basis.
        for m in [1, 2, 3, 4, 8, 9, 25, 27] {
            assert_eq!(powerful_to_power_norm(m), 1, "m = {}", m);
        }
    }

    #[test]
    fn level_one_weight_12_exact() {
        let e = exact_charpoly(1, 12, &Character::trivial(1), 1, 2).unwrap();
        assert_eq!(e.status, "conditional");
        let c: Vec<i64> = e.coeffs.iter().map(|v| v[0].to_i64().unwrap()).collect();
        assert_eq!(c, vec![-49176, -2025, 1]);
    }

    #[test]
    fn order_3_mod_13_weight_2() {
        // A genuinely cyclotomic case (m = 3): the lift is monic with small
        // coordinates; examples/general_vs_sage.rs compares with Sage.
        let mut exps = vec![u32::MAX; 13];
        let mut x = 1u64;
        for t in 0..12u32 {
            exps[x as usize] = t % 3;
            x = x * 2 % 13;
        }
        let eps = Character::from_exponents(13, 3, exps).unwrap();
        let e = exact_charpoly(13, 2, &eps, 0, 2).unwrap();
        assert_eq!(e.status, "conditional", "{:?}", e.checks);
        assert_eq!(e.m, 3);
        assert!(e.coeffs.iter().flatten().all(|c| c.bits() < 8));
    }
}
