//! Hecke eigenvalues of every newform orbit (rational or not) against the
//! LMFDB's exact values (fixtures/lmfdb-2.2.5.1-eigen.txt: a_P as
//! polynomials in a root e of its Hecke polynomial, for every prime P of
//! norm <= 30, U_P at P | N). At each level every LMFDB orbit is matched with
//! one of ours through an explicit isomorphism of the coefficient fields,
//! and all its a_P are compared through that one isomorphism (joint/mod.rs).

mod joint;

use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm, Hnf, Prime};
use sagebrush_hmf::newspace::Newspaces;
use std::collections::HashMap;

fn hnf3(s: &str) -> Hnf {
    let v: Vec<u64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect();
    Hnf { a: v[0], b: v[1], c: v[2] }
}

/// level -> its orbits (field polynomial, a_P strings), and the fixture's
/// prime order
fn fixture() -> (HashMap<Hnf, Vec<(String, Vec<String>)>>, Vec<Hnf>) {
    let mut out: HashMap<Hnf, Vec<(String, Vec<String>)>> = HashMap::new();
    let mut order = vec![];
    for l in include_str!("fixtures/lmfdb-2.2.5.1-eigen.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').collect();
        let level = hnf3(p[1]);
        let d: usize = p[2].trim().parse().unwrap();
        let field = p[3].trim().strip_prefix("field:").unwrap().trim().to_string();
        assert_eq!(field.split(',').count(), d + 1);
        let toks: Vec<&str> = p[4].split_whitespace().collect();
        let mut hs = vec![];
        let mut aps = vec![];
        for c in toks.chunks(3) {
            let (last, a) = c[2].split_once(':').unwrap();
            hs.push(hnf3(&format!("{} {} {}", c[0], c[1], last)));
            aps.push(a.to_string());
        }
        if order.is_empty() {
            order = hs.clone();
        }
        assert_eq!(hs, order);
        out.entry(level).or_default().push((field, aps));
    }
    (out, order)
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
        let ours: Vec<_> = (0..orbits.orbits.len())
            .map(|k| {
                let e = ns.orbit_eigenspace(&orbits, k).unwrap();
                let aps: Vec<_> = order.iter().map(|h| e.eigenvalue(&ns, &primes[h]).unwrap()).collect();
                joint::ours(&e.g, &aps)
            })
            .collect();
        let theirs: Vec<_> = want
            .get(&n.hnf)
            .map_or(vec![], |v| v.iter().map(|(f, aps)| joint::theirs(f, &aps.iter().map(|s| s.as_str()).collect::<Vec<_>>())).collect());
        orbits_checked += joint::match_orbits(&ours, &theirs, &format!("level {} (norm {})", n.gen, n.norm()));
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
