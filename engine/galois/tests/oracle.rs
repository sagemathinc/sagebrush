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
