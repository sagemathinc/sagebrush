//! Newspaces, newform orbits and Hecke eigenvalues over real quadratic
//! fields (defnew.rs), and U_P for P dividing the level (definite.rs).
//!
//! - U_P against Magma 2.18 as a black box (fixtures/magma-up-general.m):
//!   the characteristic polynomial of HeckeOperator(HilbertCuspForms(F, N),
//!   P) for every prime P of norm <= 7 dividing N, every level N of norm
//!   <= 12, over the 10 fields of magma-definite.m.
//! - Dembélé-Voight Example 8.6 through the newform API: over Q(sqrt 106) at
//!   level 1, orbits of dimensions 1^4 2^6 4^2 26, and the a_P table of the
//!   four rational forms.
//! - Over Q(sqrt 5), against newspace.rs and eigen.rs (checked against
//!   LMFDB): at the levels of norm <= 61, the same new dimensions and orbit
//!   dimensions, and for each orbit the same characteristic polynomials of
//!   its a_P (U_P included) for N(P) <= 20. These do not depend on the
//!   separating operator either side chose.

use sagebrush_bigint::BigInt;
use sagebrush_hmf::defnew::Newspaces;
use sagebrush_hmf::definite::DefiniteSpace;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QPrime, QuadField};

#[test]
fn up_vs_magma() {
    use std::collections::HashMap;
    let mut spaces: HashMap<(i64, (i128, i128, i128)), (QuadField, DefiniteSpace)> = HashMap::new();
    let mut n = 0;
    for l in include_str!("fixtures/magma-up-general.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').map(str::trim).collect();
        let d: i64 = p[0].parse().unwrap();
        let nums = |s: &str| s.split(|c: char| c == ' ' || c == ';').filter(|t| !t.is_empty()).map(|t| t.parse::<i64>().unwrap()).collect::<Vec<_>>();
        let g = nums(p[1]);
        let f = QuadField::new(d).unwrap();
        let level = f.ideal(&[QElt::new(g[0], g[1]), QElt::new(g[2], g[3])]).unwrap();
        let (f, sp) = spaces.entry((d, level.hnf())).or_insert_with(|| {
            let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
            (f, DefiniteSpace::new(&o, &level).unwrap())
        });
        assert_eq!(sp.cusp_dimension(), p[2].parse::<usize>().unwrap());
        let q = nums(p[3]);
        let pr = f.primes_above(q[0]).unwrap().into_iter().find(|pr| f.contains(&pr.ideal, &QElt::new(q[1], q[2])).unwrap()).unwrap();
        assert!(f.ideal_div(&level, &pr.ideal).unwrap().is_some());
        let want: Vec<BigInt> = p[4].split_whitespace().map(|t| t.parse().unwrap()).collect();
        assert_eq!(sp.cusp_charpoly(&pr).unwrap(), want, "d = {}, N = {:?}, P = {:?}", d, level.hnf(), pr.ideal.hnf());
        n += 1;
    }
    assert_eq!(n, 111);
}

#[test]
fn dembele_voight_example_8_6_newforms() {
    let f = QuadField::new(106).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let ns = Newspaces::new(&o, &f.unit_ideal()).unwrap();
    assert_eq!(ns.new_dimension().unwrap(), 50);
    let orbits = ns.newform_orbits().unwrap();
    assert_eq!(orbits.dimensions(), vec![1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4, 4, 26]);
    let pr = |g: Vec<QElt>| -> QPrime { f.factor(&f.ideal(&g).unwrap()).unwrap()[0].0 };
    let g = |a: i64, b: i64| QElt::new(a, b);
    let ps = vec![
        pr(vec![QElt::int(2), g(0, 1)]),
        pr(vec![QElt::int(3), g(1, 1)]),
        pr(vec![QElt::int(3), g(-1, 1)]),
        pr(vec![QElt::int(5), g(1, 1)]),
        pr(vec![QElt::int(5), g(-1, 1)]),
        pr(vec![g(31, 3)]),
        pr(vec![g(-31, 3)]),
    ];
    let mut rows = vec![];
    for k in 0..4 {
        let es = ns.orbit_eigenspace(&orbits, k).unwrap();
        rows.push(ps.iter().map(|p| {
            let a = ns.eigenvalue(&es, p).unwrap();
            assert_eq!(a.den, BigInt::from(1));
            a.num[0].to_string().parse::<i64>().unwrap()
        }).collect::<Vec<i64>>());
    }
    rows.sort();
    let mut want = vec![vec![-1, -2, 3, 3, -2, 4, -1], vec![-1, 3, -2, -2, 3, -1, 4], vec![1, 2, -3, -3, 2, 4, -1], vec![1, -3, 2, 2, -3, -1, 4]];
    want.sort();
    assert_eq!(rows, want);
}

/// CORR-6F0-1 (astra): over Q(sqrt 10), N = P = (5, sqrt 10) (not narrowly
/// principal), the new space has one orbit of dimension 4, and U_P has
/// characteristic polynomial (x^2 + 1)^2 on it, as Magma's
/// NewSubspace(HilbertCuspForms(F, P)) gives: a_P^2 = -1, not +-1.
#[test]
fn up_eigenvalue_at_a_non_principal_prime() {
    let f = QuadField::new(10).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let p = f.primes_above(5).unwrap()[0];
    let ns = Newspaces::new(&o, &p.ideal).unwrap();
    assert_eq!(ns.new_dimension().unwrap(), 4);
    let orbits = ns.newform_orbits().unwrap();
    assert_eq!(orbits.dimensions(), vec![4]);
    let es = ns.orbit_eigenspace(&orbits, 0).unwrap();
    let a = ns.eigenvalue(&es, &p).unwrap();
    let cp: Vec<i64> = es.charpoly_of(&a).unwrap().iter().map(|c| c.to_string().parse().unwrap()).collect();
    assert_eq!(cp, vec![1, 0, 2, 0, 1]);
    // the whole cusp space, against Magma: x^8 + 4x^6 + 30x^4 + 52x^2 + 25
    let cusp: Vec<i64> = ns.top().cusp_charpoly(&p).unwrap().iter().map(|c| c.to_string().parse().unwrap()).collect();
    assert_eq!(cusp, vec![25, 0, 52, 0, 30, 0, 4, 0, 1]);
}

#[test]
fn agrees_with_the_sqrt5_newforms() {
    use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm};
    let f = QuadField::new(5).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let to_q = |a: u64, b: u64, c: u64| f.ideal(&[QElt::int(a as i64), QElt::new(b as i64, c as i64)]).unwrap();
    let mut checked = 0;
    for lev in ideals_of_bounded_norm(61) {
        let old = sagebrush_hmf::newspace::Newspaces::new(lev.clone()).unwrap();
        let ql = to_q(lev.hnf.a, lev.hnf.b, lev.hnf.c);
        let new = Newspaces::new(&o, &ql).unwrap();
        assert_eq!(new.new_dimension().unwrap(), old.new_dimension(), "level {:?}", lev.hnf);
        if old.new_dimension() == 0 {
            continue;
        }
        let (oo, no) = (old.newform_orbits().unwrap(), new.newform_orbits().unwrap());
        let mut od = oo.dimensions();
        od.sort();
        assert_eq!(no.dimensions(), od, "level {:?}", lev.hnf);
        // per orbit, the characteristic polynomials of its a_P, N(P) <= 20
        let primes = primes_of_bounded_norm(20);
        let qps: Vec<QPrime> = primes.iter().map(|p| f.primes_above(p.p as i64).unwrap().into_iter().find(|q| q.ideal == to_q(p.hnf.a, p.hnf.b, p.hnf.c)).unwrap()).collect();
        let mut a: Vec<Vec<Vec<BigInt>>> = (0..oo.orbits.len())
            .map(|k| {
                let es = old.orbit_eigenspace(&oo, k).unwrap();
                primes.iter().map(|p| es.charpoly_of(&es.eigenvalue(&old, p).unwrap()).unwrap()).collect()
            })
            .collect();
        let mut b: Vec<Vec<Vec<BigInt>>> = (0..no.orbits.len())
            .map(|k| {
                let es = new.orbit_eigenspace(&no, k).unwrap();
                qps.iter().map(|p| es.charpoly_of(&new.eigenvalue(&es, p).unwrap()).unwrap()).collect()
            })
            .collect();
        a.sort();
        b.sort();
        assert_eq!(a, b, "level {:?}", lev.hnf);
        checked += 1;
    }
    println!("{} levels with newforms checked", checked);
    assert!(checked > 5, "{}", checked);
}
