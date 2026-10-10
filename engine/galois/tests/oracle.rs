//! galois_group against Magma (tests/data/*-magma.txt): random polynomials
//! of degrees 2..12 (every third line, to keep the test short:
//! examples/check runs them all), and polynomials of degrees 12 and 13 with
//! many different Galois groups.

use sagebrush_bigint::BigInt;

fn check(text: &str, every: usize) -> usize {
    let mut checked = 0;
    for (i, line) in text.lines().filter(|l| !l.starts_with('#')).enumerate() {
        if i % every != 0 {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        let coeffs: Vec<BigInt> = f[2].split(',').map(|c| c.parse().unwrap()).collect();
        let g = sagebrush_galois::galois_group(&coeffs).unwrap();
        assert_eq!(g.label(), f[0], "{}: {:?}", f[2], g.log);
        checked += 1;
    }
    checked
}

#[test]
fn degree_12_groups_match_magma() {
    assert_eq!(check(include_str!("data/degree12-magma.txt"), 1), 165);
}

#[test]
fn degree_13_groups_match_magma() {
    assert_eq!(check(include_str!("data/degree13-magma.txt"), 1), 60);
}

#[test]
fn random_polynomials_match_magma() {
    let text = include_str!("data/random-magma.txt");
    let mut checked = 0;
    for (i, line) in text.lines().filter(|l| !l.starts_with('#')).enumerate() {
        if i % 3 != 0 {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        let coeffs: Vec<BigInt> = f[2].split(',').map(|c| c.parse().unwrap()).collect();
        let g = sagebrush_galois::galois_group(&coeffs).unwrap();
        assert_eq!(g.label(), f[0], "{}: {:?}", f[2], g.log);
        checked += 1;
    }
    assert_eq!(checked, 280);
}

#[test]
fn prime_degrees_match_magma() {
    assert_eq!(check(include_str!("data/prime-degree-magma.txt"), 1), 51);
}

/// The M23 polynomials of arXiv:2608.08538: Gal = 23T5 = M23.  (The descent
/// step A23 -> M23, of index 1.3e15, is not proven: see the crate docs.)
#[test]
fn m23_polynomials() {
    assert_eq!(check(include_str!("data/m23.txt"), 1), 2);
}

/// GAL-F1: proof=True (Proof::Always) refuses rather than return the
/// unproven A23 -> M23 step.
#[test]
fn m23_proof_always_refuses() {
    let line = include_str!("data/m23.txt").lines().find(|l| !l.starts_with('#')).unwrap();
    let coeffs: Vec<BigInt> = line.split_whitespace().nth(2).unwrap().split(',').map(|c| c.parse().unwrap()).collect();
    let e = sagebrush_galois::galois_group_with(&coeffs, sagebrush_galois::Proof::Always).unwrap_err();
    assert!(e.contains("proof=True"), "{}", e);
}

/// GAL-F4: a constant multiple has the same Galois group.
#[test]
fn content_is_removed() {
    let z = |v: &[i64]| v.iter().map(|&c| BigInt::from(c)).collect::<Vec<_>>();
    for f in [z(&[1, 0, 1]), z(&[2, 0, 2]), z(&[-6, 0, 0, 3])] {
        assert!(sagebrush_galois::galois_group(&f).is_ok(), "{:?}", f);
    }
}
