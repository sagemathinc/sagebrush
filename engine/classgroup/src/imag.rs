//! Class groups of imaginary quadratic orders of fundamental discriminant
//! D < 0 (|D| < 2^118: the sieve's arithmetic is u64/i128), assuming GRH:
//! the factor base holds the primes up to Bach's bound 6 log^2 |D|, which
//! generate the group; relations come from the sieve (relations.rs); the
//! group is Z^n / L for the relation lattice L, whose determinant is h once
//! it is below sqrt 2 times the analytic estimate of h (the true h is above
//! 1/sqrt 2 times it, and det L is a multiple of h).

use crate::arith::*;
use crate::linalg::{cokernel_small, det_crt_probable, eliminate, hnf_mod, hnf_mod_small_until, independent_rows, smith, Reduced};
use crate::relations::{collect, FactorBase, Params, Stats};
use num_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};

#[derive(Debug, Clone, PartialEq)]
pub struct ClassGroup {
    pub h: BigInt,
    /// The invariants d_1 >= d_2 >= ... (d_{i+1} | d_i), as PARI's .cyc.
    pub cyc: Vec<BigInt>,
}

#[derive(Debug, Default)]
pub struct Timing {
    pub fb: usize,
    pub relations: usize,
    pub core: usize,
    pub rounds: usize,
    pub sieve_s: f64,
    pub linalg_s: f64,
    pub h_est: f64,
    pub polys: u64,
}

/// h estimated from the Euler product of L(1, chi_D) over p < bound.
pub fn h_estimate(d: i128, bound: u64) -> f64 {
    let mut l = 1.0f64;
    for p in primes_up_to(bound) {
        let k = kronecker(d, p) as f64;
        l /= 1.0 - k / p as f64;
    }
    ((-d) as f64).sqrt() / std::f64::consts::PI * l
}

struct Tuning {
    sieve: Params,
    /// relations to collect before the first linear algebra, per prime
    excess: f64,
    /// the heaviest pivot row structured elimination may use
    pivot_weight: usize,
}

fn tuning(d: i128) -> Tuning {
    let digits = ((-d) as f64).log10();
    let m = if digits < 14.0 { 1 << 10 } else if digits < 22.0 { 1 << 13 } else if digits < 30.0 { 1 << 14 } else { 1 << 15 };
    Tuning { sieve: Params { m, small: 30, lp_mult: 40, slack: 2 }, excess: 2.0, pivot_weight: 80 }
}

pub fn class_group(d: i128) -> Result<(ClassGroup, Timing), String> {
    if d >= 0 || !(d.rem_euclid(4) == 0 || d.rem_euclid(4) == 1) {
        return Err(format!("{} is not a negative discriminant", d));
    }
    if d == -3 || d == -4 {
        return Ok((ClassGroup { h: BigInt::one(), cyc: vec![] }, Timing::default()));
    }
    if (-d) as u128 >= 1u128 << 118 {
        return Err("|D| >= 2^118 is not supported yet".into());
    }
    let debug = std::env::var("QCL_DEBUG").is_ok();
    let mut tm = Timing::default();
    let ld = ((-d) as f64).ln();
    let bach = (6.0 * ld * ld).ceil() as u64;
    let fb = FactorBase::new(d, bach.max(60));
    let n = fb.primes.len();
    tm.fb = n;
    let h_est = h_estimate(d, (1 << 17).max(bach));
    tm.h_est = h_est;
    let tu = tuning(d);
    let mut rels = vec![];
    let mut stats = Stats { polys: 0, candidates: 0, full: 0, partial_pairs: 0 };
    let mut want = (tu.excess * n as f64) as usize + 20;
    let mut counts = vec![0u32; n];
    for round in 0..200 {
        tm.rounds = round + 1;
        let t = std::time::Instant::now();
        let more = collect(&fb, want - rels.len(), &tu.sieve, round as u64 + 1, &mut stats, &mut counts);
        rels.extend(more);
        tm.sieve_s += t.elapsed().as_secs_f64();
        let t = std::time::Instant::now();
        let found = match eliminate(n, &rels, tu.pivot_weight) {
            Reduced::Deficient(col) => {
                if debug {
                    eprintln!("round {} rels {}: column {} (p = {}) has no relation", round, rels.len(), col, fb.primes[col].p);
                }
                None
            }
            Reduced::Core(cols, dense) => {
                tm.core = cols.len();
                if debug {
                    eprintln!("round {} rels {}: core {} x {} after {:.1} ms", round, rels.len(), dense.len(), cols.len(), t.elapsed().as_secs_f64() * 1e3);
                }
                core_group(&dense, cols.len(), h_est, round as u64, debug)
            }
        };
        tm.linalg_s += t.elapsed().as_secs_f64();
        if let Some(g) = found {
            tm.relations = rels.len();
            tm.polys = stats.polys;
            return Ok((g, tm));
        }
        want = rels.len() + (rels.len() / 5).max(10);
    }
    Err("no convergence".into())
}

/// Z^c / L for the lattice L spanned by `rows`, if its order is below
/// sqrt 2 h_est (so is h); None if L is not yet the full relation lattice.
fn core_group(rows: &[Vec<i64>], c: usize, h_est: f64, seed: u64, debug: bool) -> Option<ClassGroup> {
    if c == 0 {
        return Some(ClassGroup { h: BigInt::one(), cyc: vec![] });
    }
    let t = std::time::Instant::now();
    let ms = || t.elapsed().as_secs_f64() * 1e3;
    let Some(sel) = independent_rows(rows, c) else {
        if debug {
            eprintln!("  not of full rank");
        }
        return None;
    };
    // a multiple of det L: the gcd of the determinants of a few independent
    // square subsets, until it is word-sized
    let square = |sel: &[usize], from: &[Vec<i64>]| -> Vec<Vec<i64>> { sel.iter().map(|&k| from[k].clone()).collect() };
    let mut d0: BigInt = det_crt_probable(&square(&sel, rows)).abs();
    if debug {
        eprintln!("  first det {} bits at {:.1} ms", d0.bits(), ms());
    }
    for t in 1..4u64 {
        if t > 1 && d0.bits() < 62 {
            break;
        }
        // the rows in another order give another subset
        let mut order: Vec<usize> = (0..rows.len()).collect();
        let mut x = 0x2545_F491_4F6C_DD1Du64 ^ t ^ seed << 32;
        for i in (1..order.len()).rev() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            order.swap(i, (x % (i as u64 + 1)) as usize);
        }
        let shuffled = square(&order, rows);
        if let Some(sel2) = independent_rows(&shuffled, c) {
            d0 = d0.gcd(&det_crt_probable(&square(&sel2, &shuffled)).abs());
        }
    }
    if debug {
        eprintln!("  det multiple {} bits at {:.1} ms", d0.bits(), ms());
    }
    if d0.is_zero() {
        return None;
    }
    let enough = h_est * std::f64::consts::SQRT_2;
    // the independent rows first, so the HNF reaches full rank (and then
    // the early stop) quickly
    let mut used = vec![false; rows.len()];
    sel.iter().for_each(|&k| used[k] = true);
    let ordered: Vec<Vec<i64>> = sel.iter().chain((0..rows.len()).filter(|&k| !used[k]).collect::<Vec<_>>().iter()).map(|&k| rows[k].clone()).collect();
    let (h, red) = if d0 < BigInt::from(1u64 << 62) {
        let d = d0.to_i128().unwrap();
        let w = hnf_mod_small_until(&ordered, c, d, enough);
        let h: BigInt = (0..c).map(|i| BigInt::from(w[i][i])).product();
        (h, cokernel_small(&w, d))
    } else {
        let w = hnf_mod(&ordered, c, &d0);
        ((0..c).map(|i| w[i][i].clone()).product(), w)
    };
    let ratio = h.to_f64().unwrap_or(f64::INFINITY) / h_est;
    if debug {
        eprintln!("  hnf at {:.1} ms: det/h_est {:.3}", ms(), ratio);
    }
    (ratio <= std::f64::consts::SQRT_2).then(|| ClassGroup { h, cyc: smith(&red) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::form::class_number_brute;

    #[test]
    fn small_discriminants_against_brute_force() {
        // fundamental discriminants -p, p = 3 mod 4 prime, and -4m
        let mut checked = 0;
        for p in primes_up_to(200_000).into_iter().filter(|p| p % 4 == 3 && *p > 1000).step_by(97) {
            let d = -(p as i128);
            let (g, _) = class_group(d).unwrap();
            assert_eq!(g.h, BigInt::from(class_number_brute(d as i64)), "h({})", d);
            checked += 1;
        }
        assert!(checked > 10);
    }
}
