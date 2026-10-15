//! Traces of Hecke operators against Magma 2.18 as a black box
//! (fixtures/magma-hecke.m), at primes of norm up to 10009. Magma works on
//! S_2(N); our matrix is on M_2(N), which adds the Eisenstein eigenvalue
//! N(P) + 1.

use sagebrush_hmf::field::{primes_above, Elt, Ideal};
use sagebrush_hmf::Space;

#[test]
fn traces_vs_magma() {
    let mut n = 0;
    for l in include_str!("fixtures/magma-hecke.txt").lines().filter(|l| !l.starts_with('#')) {
        let parts: Vec<Vec<i64>> = l.split('|').map(|s| s.split_whitespace().map(|x| x.parse().unwrap()).collect()).collect();
        let level = Elt::new(parts[0][0], parts[0][1]);
        let g = Elt::new(parts[1][0], parts[1][1]);
        let pi = Ideal::principal(g).unwrap();
        assert_eq!(pi.factors.len(), 1);
        let (prime, _) = pi.factors[0];
        assert!(primes_above(prime.p).contains(&prime));
        let s = Space::new(level).unwrap();
        let t = s.hecke_matrix(&prime).unwrap();
        assert_eq!(t.trace() - (prime.norm as i64 + 1), parts[2][0], "level {}, T at {}", level, g);
        n += 1;
    }
    assert_eq!(n, 13);
}
