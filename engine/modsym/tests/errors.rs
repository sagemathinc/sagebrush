//! Invalid input is an error (never a panic), level 1 is the zero space,
//! and a batch keeps going past bad levels.

use sagebrush_modsym::exact::{batch_exact, exact_charpoly};
use sagebrush_modsym::{hecke_charpoly, hecke_commute, validate};
use sagebrush_bigint::BigInt;

const P: u64 = 67108859;

#[test]
fn q_must_be_a_prime_not_dividing_n() {
    for q in [0, 1, 4, 9, 15] {
        assert!(exact_charpoly(11, q).is_err(), "q={}", q);
        assert!(hecke_charpoly(11, q, P).is_err(), "q={}", q);
    }
    let e = exact_charpoly(22, 11).unwrap_err();
    assert!(e.contains("q = 11") && e.contains("N = 22"), "{}", e);
    assert!(hecke_charpoly(2310, 7, P).is_err());
}

#[test]
fn p_must_be_an_odd_prime_below_2_31() {
    for p in [0u64, 1, 2, 4, 100, 1 << 31, 2147483659] {
        assert!(hecke_charpoly(11, 2, p).is_err(), "p={}", p);
    }
    assert!(validate(11, 2, Some(2147483647)).is_ok());
}

#[test]
fn level_zero_is_an_error() {
    assert!(exact_charpoly(0, 2).is_err());
    assert!(hecke_charpoly(0, 2, P).is_err());
}

#[test]
fn level_one_is_the_zero_space() {
    let e = exact_charpoly(1, 2).unwrap();
    assert_eq!((e.dim, e.status), (0, "proven"));
    assert_eq!(e.coeffs, vec![BigInt::from(1)]);
    let r = hecke_charpoly(1, 2, P).unwrap();
    assert_eq!((r.dim, r.charpoly.clone()), (0, vec![1]));
}

#[test]
fn batch_reports_bad_levels_and_continues() {
    let rs = batch_exact(&[0, 1, 11, 22, 37], 11);
    let ok: Vec<bool> = rs.iter().map(|r| r.is_ok()).collect();
    assert_eq!(ok, vec![false, true, false, false, true]);
    assert_eq!(rs[4].as_ref().unwrap().coeffs.len(), 4);
}

#[test]
fn commute_validates_both_operators() {
    assert!(hecke_commute(37, 2, 37, P).is_err());
    assert!(hecke_commute(37, 2, 4, P).is_err());
    assert!(hecke_commute(37, 2, 3, P).unwrap());
}
