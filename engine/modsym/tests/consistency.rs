//! Different paths through the engine agree with each other and with the
//! theory: Hecke operators commute, the mod-p charpoly is the exact one
//! reduced mod p, and the estimator predicts the computed dimension.

use sagebrush_modsym::estimate::estimate;
use sagebrush_modsym::exact::exact_charpoly;
use sagebrush_modsym::{hecke_charpoly, hecke_commute};
use sagebrush_bigint::BigInt;

fn small_prime_not_dividing(n: u64) -> u64 {
    [2, 3, 5, 7, 11, 13].into_iter().find(|q| n % q != 0).unwrap()
}

#[test]
fn hecke_operators_commute() {
    for n in [11, 37, 64, 100, 389, 720, 1001] {
        let qs: Vec<u64> = [2, 3, 5, 7, 11].into_iter().filter(|q| n % q != 0).take(2).collect();
        assert!(hecke_commute(n, qs[0], qs[1], 67108859).unwrap(), "N={}", n);
    }
}

#[test]
fn mod_p_is_the_exact_charpoly_reduced() {
    let p = 2147483629u64;
    for n in (1..300).step_by(13) {
        let q = small_prime_not_dividing(n);
        let exact = exact_charpoly(n, q).unwrap();
        let modp = hecke_charpoly(n, q, p).unwrap();
        let pb = BigInt::from(p);
        let reduced: Vec<u64> = exact.coeffs.iter().map(|c| ((c % &pb + &pb) % &pb).try_into().unwrap()).collect();
        assert_eq!(modp.charpoly, reduced, "N={} q={}", n, q);
    }
}

#[test]
fn estimate_predicts_the_dimension() {
    for n in (1..2000).step_by(37) {
        let q = small_prime_not_dividing(n);
        let e = estimate(n, q);
        assert_eq!(e.dim as usize, hecke_charpoly(n, q, 67108859).unwrap().dim, "N={}", n);
        assert!(e.primes <= e.primes_max);
    }
}
