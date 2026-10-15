//! Newform orbits against Magma 2.18 as a black box
//! (fixtures/magma-newforms.m), at levels beyond the LMFDB's range,
//! including PSAGE's todo.txt levels (81), (87), (93), (99).

use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::newspace::Newspaces;

#[test]
fn newform_orbits_vs_magma() {
    let mut n = 0;
    for l in include_str!("fixtures/magma-newforms.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').collect();
        let g: Vec<i64> = p[0].split_whitespace().map(|x| x.parse().unwrap()).collect();
        let want: Vec<usize> = p[1].split_whitespace().map(|x| x.parse().unwrap()).collect();
        let ns = Newspaces::new(Ideal::principal(Elt::new(g[0], g[1])).unwrap()).unwrap();
        assert_eq!(ns.newform_orbits().unwrap().dimensions(), want, "level {}", g[0]);
        n += 1;
    }
    assert_eq!(n, 7);
}
