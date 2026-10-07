//! galois_group against Magma on random polynomials (tests/data/random-magma.txt;
//! every third line, to keep the test short: examples/check runs them all).

use sagebrush_bigint::BigInt;

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
