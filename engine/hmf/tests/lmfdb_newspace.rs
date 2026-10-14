//! Newspaces, newform orbits and rational newforms against the LMFDB
//! (fixtures/lmfdb.py) and Bober et al. 2012.

use sagebrush_bigint::BigInt;
use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm, Elt, Hnf};
use sagebrush_hmf::newspace::Newspaces;
use std::collections::HashMap;

fn hnf3(s: &str) -> Hnf {
    let v: Vec<u64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
    Hnf { a: v[0], b: v[1], c: v[2] }
}

fn lmfdb_newdims() -> HashMap<Hnf, usize> {
    include_str!("fixtures/lmfdb-2.2.5.1-newdims.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().map(|x| x.parse().unwrap()).collect();
            (Hnf { a: v[1], b: v[2], c: v[3] }, v[4] as usize)
        })
        .collect()
}

fn lmfdb_orbits() -> HashMap<Hnf, Vec<usize>> {
    include_str!("fixtures/lmfdb-2.2.5.1-orbits.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let p: Vec<&str> = l.split('|').collect();
            (hnf3(p[0]), p[1].split_whitespace().map(|x| x.parse().unwrap()).collect())
        })
        .collect()
}

/// label, level, [(prime HNF, a_P)]
fn lmfdb_rational() -> Vec<(String, Hnf, Vec<(Hnf, i64)>)> {
    include_str!("fixtures/lmfdb-2.2.5.1-rational.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let p: Vec<&str> = l.split('|').collect();
            let aps = p[2]
                .split_whitespace()
                .collect::<Vec<_>>()
                .chunks(3)
                .map(|c| {
                    let (last, ap) = c[2].split_once(':').unwrap();
                    (hnf3(&format!("{} {} {}", c[0], c[1], last)), ap.parse().unwrap())
                })
                .collect();
            (p[0].trim().to_string(), hnf3(p[1]), aps)
        })
        .collect()
}

fn check_orbits(bound: u64) {
    let dims = lmfdb_newdims();
    let orbits = lmfdb_orbits();
    for n in ideals_of_bounded_norm(bound) {
        if n.norm() == 2069 {
            continue; // the LMFDB lacks two orbits here (lmfdb.rs)
        }
        let ns = Newspaces::new(n.clone()).unwrap();
        assert_eq!(ns.new_dimension(), dims[&n.hnf], "level {}", n.gen);
        let got = ns.newform_orbits().unwrap().dimensions();
        let want = orbits.get(&n.hnf).cloned().unwrap_or_default();
        assert_eq!(got, want, "level {} (norm {})", n.gen, n.norm());
    }
}

/// New dimensions and the dimensions of the Galois orbits of newforms, at
/// every level of norm <= 600 (all of the LMFDB's range with --ignored).
#[test]
fn newform_orbits_vs_lmfdb() {
    check_orbits(600);
}

#[test]
#[ignore]
fn newform_orbits_vs_lmfdb_4999() {
    check_orbits(4999);
}

fn check_rational(bound: u64) -> usize {
    let want = lmfdb_rational();
    let mut count = 0;
    for n in ideals_of_bounded_norm(bound) {
        let ns = Newspaces::new(n.clone()).unwrap();
        let forms = ns.rational_newforms().unwrap();
        let mut got: Vec<Vec<(Hnf, i64)>> = forms
            .iter()
            .map(|f| f.aplist(ns.top(), 50).unwrap().into_iter().filter_map(|(p, a)| a.map(|a| (p.hnf, a))).collect())
            .collect();
        let mut theirs: Vec<Vec<(Hnf, i64)>> = want
            .iter()
            .filter(|(_, h, _)| *h == n.hnf)
            .map(|(_, _, aps)| {
                // our aplist omits primes exactly dividing N (+-1, not yet computed)
                let mut v: Vec<(Hnf, i64)> = aps
                    .iter()
                    .filter(|(p, _)| n.factors.iter().all(|(q, e)| q.hnf != *p || *e >= 2))
                    .cloned()
                    .collect();
                v.sort();
                v
            })
            .collect();
        for g in got.iter_mut() {
            g.sort();
        }
        got.sort();
        theirs.sort();
        assert_eq!(got, theirs, "level {} (norm {})", n.gen, n.norm());
        count += got.len();
    }
    count
}

/// Rational newforms and their a_P at the primes of norm <= 50, at every
/// level of norm <= 400.
#[test]
fn rational_newforms_vs_lmfdb() {
    assert!(check_rational(400) > 50);
}

/// Bober et al. 2012, Table 1: 1414 isogeny classes of elliptic curves over
/// Q(sqrt 5) of norm conductor <= 1831, one for each rational newform.
#[test]
#[ignore]
fn rational_newforms_1831_bober_et_al() {
    assert_eq!(check_rational(1831), 1414);
}

/// hmf.py's new_subspace example (level of norm 1364): the newspace
/// dimension agrees with the LMFDB (PSAGE's degeneracy kernels give 21 cusp
/// forms; newspace.rs).
#[test]
fn newspace_1364() {
    let n = Newspaces::new(sagebrush_hmf::field::Ideal::principal(Elt::new(-38, 2)).unwrap()).unwrap();
    assert_eq!(n.new_dimension(), lmfdb_newdims()[&n.level.hnf]);
}

/// The characteristic polynomial of T_P on S_2^new(N) itself, for every
/// level of norm <= 300 and prime of norm <= 30 not dividing it.
#[test]
fn new_charpolys_vs_lmfdb() {
    let table: HashMap<(Hnf, Hnf), Vec<BigInt>> = include_str!("fixtures/lmfdb-2.2.5.1-hecke.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let p: Vec<&str> = l.split('|').collect();
            ((hnf3(p[0]), hnf3(p[1])), p[2].split_whitespace().map(|x| BigInt::from(x.parse::<i64>().unwrap())).collect())
        })
        .collect();
    let mut n_checked = 0;
    for n in ideals_of_bounded_norm(300) {
        let ns = Newspaces::new(n.clone()).unwrap();
        for p in primes_of_bounded_norm(30).into_iter().filter(|p| n.factors.iter().all(|(q, _)| q != p)) {
            let got = ns.new_charpoly(&vec![(p, 1)]).unwrap().new;
            let want = table.get(&(n.hnf, p.hnf)).cloned().unwrap_or_else(|| vec![BigInt::from(1i64)]);
            assert!(got == want, "level {}, T at {}", n.gen, p.gen);
            n_checked += 1;
        }
    }
    assert!(n_checked > 900);
}
