//! Dimensions against Magma 2.18 used as a black box (fixtures/magma-dims.m):
//! the rational integer levels n = 2..100, which include the levels where
//! PSAGE's todo.txt recorded disagreements with Magma ((27), (49), (61),
//! (63), (81), (87), (93), (99)), and the primes of norm 2069.

use sagebrush_hmf::field::Elt;
use sagebrush_hmf::Space;

#[test]
fn dimensions_vs_magma() {
    let text = include_str!("fixtures/magma-dims.txt");
    let mut n = 0;
    for l in text.lines().filter(|l| !l.starts_with('#')) {
        let v: Vec<i64> = l.split_whitespace().map(|x| x.parse().unwrap()).collect();
        let s = Space::new(Elt::new(v[0], v[1])).unwrap();
        assert_eq!(s.cusp_dimension(), v[2] as usize, "level {}", Elt::new(v[0], v[1]));
        n += 1;
    }
    assert_eq!(n, 101);
}
