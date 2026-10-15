//! Hecke eigenvalues of every newform orbit against Magma 2.18 as a black
//! box (fixtures/magma-eigen.m), at levels beyond the LMFDB's range: (71),
//! (81), (87), (93), (99), 112 orbits ((71) and (81) by default). Magma's
//! exact eigenvalues (in its absolute field of the eigenvalues of each
//! Eigenform, at every prime of norm <= 30, U_P at P | N) are compared with
//! ours through one explicit isomorphism of fields per orbit, as in
//! lmfdb_eigen.rs (joint/mod.rs).

mod joint;

use sagebrush_hmf::field::{Elt, Ideal, Prime};
use sagebrush_hmf::newspace::Newspaces;
use std::collections::BTreeMap;

fn check(levels: &[i64]) -> usize {
    let mut want: BTreeMap<i64, Vec<(String, Vec<String>)>> = BTreeMap::new();
    let mut order: Vec<(i64, i64)> = vec![];
    for l in include_str!("fixtures/magma-eigen.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').collect();
        let n: i64 = p[0].split_whitespace().next().unwrap().parse().unwrap();
        let d: usize = p[1].trim().parse().unwrap();
        let field = p[2].trim().strip_prefix("field:").unwrap().trim().to_string();
        assert_eq!(field.split(',').count(), d + 1);
        let toks: Vec<&str> = p[3].split_whitespace().collect();
        let mut gens = vec![];
        let mut aps = vec![];
        for c in toks.chunks(2) {
            let (b, a) = c[1].split_once(':').unwrap();
            gens.push((c[0].parse().unwrap(), b.parse().unwrap()));
            aps.push(a.to_string());
        }
        if order.is_empty() {
            order = gens.clone();
        }
        assert_eq!(gens, order);
        want.entry(n).or_default().push((field, aps));
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
    for (n, theirs) in want.iter().filter(|(n, _)| levels.contains(n)) {
        let ns = Newspaces::new(Ideal::principal(Elt::int(*n)).unwrap()).unwrap();
        let orbits = ns.newform_orbits().unwrap();
        let ours: Vec<_> = (0..orbits.orbits.len())
            .map(|k| {
                let e = ns.orbit_eigenspace(&orbits, k).unwrap();
                let aps: Vec<_> = primes.iter().map(|p| e.eigenvalue(&ns, p).unwrap()).collect();
                joint::ours(&e.g, &aps)
            })
            .collect();
        let theirs: Vec<_> = theirs.iter().map(|(f, aps)| joint::theirs(f, &aps.iter().map(|s| s.as_str()).collect::<Vec<_>>())).collect();
        total += joint::match_orbits(&ours, &theirs, &format!("level ({})", n));
    }
    total
}

/// (71) and (81): 46 orbits, the default run.
#[test]
fn eigenvalues_vs_magma() {
    assert_eq!(check(&[71, 81]), 46);
}

/// All five levels, 112 orbits (run with --ignored).
#[test]
#[ignore]
fn eigenvalues_vs_magma_all() {
    assert_eq!(check(&[71, 81, 87, 93, 99]), 112);
}
