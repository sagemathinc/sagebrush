//! Hecke eigenvalues of every newform orbit against Magma 2.18 as a black
//! box (fixtures/magma-eigen.m), at levels beyond the LMFDB's range: (71),
//! (81), (87), (93), (99), 112 orbits ((71) and (81) by default). Orbits are compared through their
//! signatures, as in lmfdb_eigen.rs: the dimension, the characteristic
//! polynomial of a_P at every prime of norm <= 30 (U_P at P | N), and that
//! of z = sum_k (k + 1) a_(P_k) over the good primes in Magma's order.

use sagebrush_bigint::BigInt;
use sagebrush_hmf::eigen::Eigenvalue;
use sagebrush_hmf::field::{Elt, Ideal, Prime};
use sagebrush_hmf::newspace::Newspaces;
use std::collections::BTreeMap;

type Sig = (usize, Vec<(i64, i64, Vec<String>)>, Vec<String>);

fn check(levels: &[i64]) -> usize {
    let mut want: BTreeMap<i64, Vec<Sig>> = BTreeMap::new();
    let mut order: Vec<(i64, i64)> = vec![];
    for l in include_str!("fixtures/magma-eigen.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').collect();
        let n: i64 = p[0].split_whitespace().next().unwrap().parse().unwrap();
        let d: usize = p[1].trim().parse().unwrap();
        let toks: Vec<&str> = p[2].split_whitespace().collect();
        let mut aps = vec![];
        for c in toks.chunks(2) {
            let (b, cp) = c[1].split_once(':').unwrap();
            aps.push((c[0].parse().unwrap(), b.parse().unwrap(), cp.split(',').map(String::from).collect::<Vec<_>>()));
        }
        if order.is_empty() {
            order = aps.iter().map(|(a, b, _)| (*a, *b)).collect();
        }
        let z = p[3].trim().strip_prefix("z:").unwrap().trim().split(',').map(String::from).collect();
        want.entry(n).or_default().push((d, aps, z));
    }
    let primes: Vec<Prime> = order
        .iter()
        .map(|&(a, b)| {
            let i = Ideal::principal(Elt::new(a, b)).unwrap();
            assert!(i.factors.len() == 1 && i.factors[0].1 == 1);
            i.factors[0].0
        })
        .collect();
    let mut total = 0;
    for (n, theirs) in want.iter_mut().filter(|(n, _)| levels.contains(n)) {
        let ns = Newspaces::new(Ideal::principal(Elt::int(*n)).unwrap()).unwrap();
        let orbits = ns.newform_orbits().unwrap();
        let mut got: Vec<Sig> = vec![];
        for k in 0..orbits.orbits.len() {
            let e = ns.orbit_eigenspace(&orbits, k).unwrap();
            let d = e.degree();
            let mut aps = vec![];
            let mut z = Eigenvalue { num: vec![BigInt::from(0i64); d], den: BigInt::from(1i64) };
            let mut kk = 0i64;
            for (t, p) in primes.iter().enumerate() {
                let a = e.eigenvalue(&ns, p).unwrap();
                let cp: Vec<String> = e.charpoly_of(&a).unwrap().iter().map(|c| c.to_string()).collect();
                aps.push((order[t].0, order[t].1, cp));
                if ns.level.factors.iter().all(|(q, _)| q != p) {
                    kk += 1;
                    let num: Vec<BigInt> = (0..d).map(|j| &z.num[j] * &a.den + &a.num[j] * &z.den * BigInt::from(kk + 1)).collect();
                    z = Eigenvalue { num, den: &z.den * &a.den };
                }
            }
            got.push((d, aps, e.charpoly_of(&z).unwrap().iter().map(|c| c.to_string()).collect()));
        }
        got.sort();
        theirs.sort();
        assert_eq!(&got, theirs, "level ({})", n);
        total += got.len();
    }
    total
}

/// (71) and (81): 46 orbits, the default run.
#[test]
fn eigenvalues_vs_magma() {
    assert_eq!(check(&[71, 81]), 46);
}

/// All five levels, 112 orbits (run with --ignored; about 15 s).
#[test]
#[ignore]
fn eigenvalues_vs_magma_all() {
    assert_eq!(check(&[71, 81, 87, 93, 99]), 112);
}
