//! Hecke eigenvalues of every newform orbit (rational or not) against the
//! LMFDB (fixtures/lmfdb-2.2.5.1-eigen.txt): at each level, the orbits are
//! compared through their signatures: the dimension, the characteristic
//! polynomial over Q of a_P for every prime P of norm <= 30 (U_P at P | N),
//! and that of z = sum_k (k + 1) a_(P_k) over the primes not dividing N in
//! the fixture's order, which checks the whole system of eigenvalues up to
//! Galois conjugation when z generates the coefficient field.

use sagebrush_bigint::BigInt;
use sagebrush_hmf::eigen::Eigenvalue;
use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm, Hnf, Prime};
use sagebrush_hmf::newspace::Newspaces;
use std::collections::HashMap;

type Sig = (usize, Vec<(Hnf, Vec<String>)>, Vec<String>);

fn hnf3(s: &str) -> Hnf {
    let v: Vec<u64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
    Hnf { a: v[0], b: v[1], c: v[2] }
}

/// level -> the signatures of its orbits, and the fixture's prime order
fn fixture() -> (HashMap<Hnf, Vec<Sig>>, Vec<Hnf>) {
    let mut out: HashMap<Hnf, Vec<Sig>> = HashMap::new();
    let mut order = vec![];
    for l in include_str!("fixtures/lmfdb-2.2.5.1-eigen.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').collect();
        let level = hnf3(p[1]);
        let d: usize = p[2].trim().parse().unwrap();
        let toks: Vec<&str> = p[3].split_whitespace().collect();
        let mut aps = vec![];
        for c in toks.chunks(3) {
            let (last, cp) = c[2].split_once(':').unwrap();
            let h = hnf3(&format!("{} {} {}", c[0], c[1], last));
            aps.push((h, cp.split(',').map(String::from).collect::<Vec<_>>()));
        }
        if order.is_empty() {
            order = aps.iter().map(|(h, _)| *h).collect();
        }
        let z = p[4].trim().strip_prefix("z:").unwrap().trim().split(',').map(String::from).collect();
        out.entry(level).or_default().push((d, aps, z));
    }
    (out, order)
}

fn strs(v: &[BigInt]) -> Vec<String> {
    v.iter().map(|c| c.to_string()).collect()
}

fn check(bound: u64) -> usize {
    let (want, order) = fixture();
    let primes: HashMap<Hnf, Prime> = primes_of_bounded_norm(30).into_iter().map(|p| (p.hnf, p)).collect();
    let mut orbits_checked = 0;
    for n in ideals_of_bounded_norm(bound) {
        if n.is_one() {
            continue;
        }
        let ns = Newspaces::new(n.clone()).unwrap();
        let orbits = ns.newform_orbits().unwrap();
        let mut got: Vec<Sig> = vec![];
        for k in 0..orbits.orbits.len() {
            let e = ns.orbit_eigenspace(&orbits, k).unwrap();
            let d = e.degree();
            let mut aps = vec![];
            let mut z = Eigenvalue { num: vec![BigInt::from(0i64); d], den: BigInt::from(1i64) };
            let mut kk = 0i64;
            for h in &order {
                let p = primes[h];
                let a = e.eigenvalue(&ns, &p).unwrap();
                aps.push((*h, strs(&e.charpoly_of(&a).unwrap())));
                if n.factors.iter().all(|(q, _)| *q != p) {
                    kk += 1;
                    // z += (kk + 1) a, over the common denominator
                    let num: Vec<BigInt> = (0..d)
                        .map(|t| &z.num[t] * &a.den + &a.num[t] * &z.den * BigInt::from(kk + 1))
                        .collect();
                    z = Eigenvalue { num, den: &z.den * &a.den };
                }
            }
            got.push((d, aps, strs(&e.charpoly_of(&z).unwrap())));
        }
        let mut theirs = want.get(&n.hnf).cloned().unwrap_or_default();
        got.sort();
        theirs.sort();
        assert_eq!(got, theirs, "level {} (norm {})", n.gen, n.norm());
        orbits_checked += got.len();
    }
    orbits_checked
}

/// Every orbit at every level of norm <= 250.
#[test]
fn eigenvalues_vs_lmfdb() {
    assert!(check(250) > 100);
}

/// The fixture's whole range, norm <= 500 (run with --ignored).
#[test]
#[ignore]
fn eigenvalues_vs_lmfdb_500() {
    assert_eq!(check(500), 462);
}
