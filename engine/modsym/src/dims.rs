//! Dimension formulas, independent of any modular symbols presentation:
//! S_k(N, eps) by Cohen-Oesterle, E_k(N, eps) by counting eps-regular cusps,
//! and the modular symbols space M_k(Gamma0(N), eps) (sign 0) via
//! Eichler-Shimura, dim = 2 dim S_k + dim E_k (k >= 2).
//!
//! These certify the dimensions found mod ell (which can only be too
//! large): equality proves that ell is good for the presentation.  For sign
//! +1 or -1 no split formula is needed: M = M^+ (+) M^-, so
//! dim_ell M^+ + dim_ell M^- = dim M certifies both.

use crate::exact::{factor, level_data};
use crate::general::Character;

fn parity_ok(eps: &Character, k: usize) -> bool {
    eps.is_even() == (k % 2 == 0)
}

/// Cohen-Oesterle's lambda(r_p, s_p, p).
fn lambda(r: u32, s: u32, p: u64) -> u64 {
    if 2 * s <= r {
        if r % 2 == 0 {
            p.pow(r / 2) + p.pow(r / 2 - 1)
        } else {
            2 * p.pow((r - 1) / 2)
        }
    } else {
        2 * p.pow(r - s)
    }
}

/// sum of eps(x) over x mod N with f(x) = 0 mod N, as a complex number.
fn character_sum(eps: &Character, f: impl Fn(u64) -> u64) -> (f64, f64) {
    let n = eps.n;
    let mut s = (0.0, 0.0);
    for x in 0..n {
        if f(x) % n == 0 {
            let e = eps.exponent(x as i64).expect("a root of x^2+1 or x^2+x+1 is a unit");
            let t = 2.0 * std::f64::consts::PI * e as f64 / eps.order as f64;
            s.0 += t.cos();
            s.1 += t.sin();
        }
    }
    s
}

/// dim S_k(Gamma0(N), eps) for k >= 2 (Cohen-Oesterle).
pub fn dim_cusp_forms(eps: &Character, k: usize) -> u64 {
    assert!(k >= 2);
    if !parity_ok(eps, k) {
        return 0;
    }
    let n = eps.n;
    let f = eps.conductor();
    let psi = level_data(n).0 as f64;
    let lam: u64 = factor(n).iter().map(|&(p, r)| {
        let s = factor(f).iter().find(|&&(q, _)| q == p).map_or(0, |&(_, s)| s);
        lambda(r, s, p)
    }).product();
    let g4 = match k % 4 { 2 => -0.25, 0 => 0.25, _ => 0.0 };
    let g3 = match k % 3 { 2 => -1.0 / 3.0, 0 => 1.0 / 3.0, _ => 0.0 };
    let nn = n as u128;
    let s4 = if g4 != 0.0 { character_sum(eps, |x| ((x as u128 * x as u128 + 1) % nn) as u64) } else { (0.0, 0.0) };
    let s3 = if g3 != 0.0 { character_sum(eps, |x| ((x as u128 * x as u128 + x as u128 + 1) % nn) as u64) } else { (0.0, 0.0) };
    // dim S_k - dim M_{2-k}; M_0 is the constants when eps = 1.
    let m2k = if k == 2 && eps.is_trivial() { 1.0 } else { 0.0 };
    let re = (k - 1) as f64 / 12.0 * psi - 0.5 * lam as f64 + g4 * s4.0 + g3 * s3.0 + m2k;
    let im = g4 * s4.1 + g3 * s3.1;
    let d = re.round();
    assert!((re - d).abs() < 1e-6 && im.abs() < 1e-6 && d >= 0.0, "Cohen-Oesterle gave {} + {} i", re, im);
    d as u64
}

/// dim E_k(Gamma0(N), eps) for k >= 2: the number of eps-regular cusps,
/// sum over c | N of phi(gcd(c, N/c)) with cond(eps) | N / gcd(c, N/c)
/// (a cusp with denominator c is fixed by d = 1 mod N / gcd(c, N/c)),
/// less one for k = 2 and eps = 1.  It factors over the primes of N.
pub fn dim_eisenstein(eps: &Character, k: usize) -> u64 {
    assert!(k >= 2);
    if !parity_ok(eps, k) {
        return 0;
    }
    let f = factor(eps.conductor());
    let count: u64 = factor(eps.n).iter().map(|&(p, r)| {
        let s = f.iter().find(|&&(q, _)| q == p).map_or(0, |&(_, s)| s);
        (0..=r).map(|a| {
            let g = a.min(r - a);
            if g <= r - s { if g == 0 { 1 } else { p.pow(g) - p.pow(g - 1) } } else { 0 }
        }).sum::<u64>()
    }).product();
    count - (k == 2 && eps.is_trivial()) as u64
}

/// dim of the sign-0 modular symbols space M_k(Gamma0(N), eps).
pub fn dim_modsym(eps: &Character, k: usize) -> u64 {
    2 * dim_cusp_forms(eps, k) + dim_eisenstein(eps, k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::general::GeneralSpace;

    #[test]
    fn level_one_and_classical() {
        let one = Character::trivial(1);
        let s: Vec<u64> = (2..=26).step_by(2).map(|k| dim_cusp_forms(&one, k)).collect();
        assert_eq!(s, vec![0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 2, 1]);
        // Genus of X0(N) = dim S_2(N).
        for n in 1..300 {
            assert_eq!(dim_cusp_forms(&Character::trivial(n), 2), level_data(n).1, "N = {}", n);
        }
    }

    #[test]
    fn trivial_character_matches_presentations() {
        // Sign 0 and sign +-1 against the mod-ell presentations.
        for n in 1..80 {
            let eps = Character::trivial(n);
            for k in [2, 4, 6] {
                let want = dim_modsym(&eps, k) as usize;
                let d0 = GeneralSpace::new(n, k, &eps, 0).unwrap().dimension();
                let dp = GeneralSpace::new(n, k, &eps, 1).unwrap().dimension();
                let dm = GeneralSpace::new(n, k, &eps, -1).unwrap().dimension();
                assert_eq!((d0, dp + dm), (want, want), "N = {} k = {}", n, k);
            }
        }
    }
}
