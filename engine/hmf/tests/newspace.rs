//! Degeneracy maps, newspaces and rational newforms against PSAGE's
//! docstrings (the LMFDB comparisons are in lmfdb_newspace.rs).

use sagebrush_arith::zmat::{rank, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_above, primes_of_bounded_norm, Elt, Ideal};
use sagebrush_hmf::newspace::Newspaces;
use sagebrush_hmf::Space;
use std::collections::HashMap;

/// hmf.py, Space.new_subspace docstring: level P Q R with N(P) = 31,
/// N(Q) = 11, R = (2), "dimension 32, level 2*a-38 (norm 1364)"; the kernels
/// of PSAGE's degeneracy matrices have dimensions 31, 28, 24 and their
/// intersection 22. The newspace is smaller.
#[test]
fn psage_degeneracy_kernels_1364() {
    let s = Space::new(Elt::new(-38, 2)).unwrap();
    assert_eq!(s.dimension(), 32);
    let mut kernels = HashMap::new();
    let mut all: Vec<Vec<i64>> = vec![vec![]; 32];
    for &(p, _) in &s.level.factors {
        let d = s.degeneracy(&p).unwrap().matrix();
        let z = ZMat::from_rows(d.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect());
        kernels.insert(p.norm, 32 - rank(&z));
        for (i, r) in d.iter().enumerate() {
            all[i].extend(r);
        }
    }
    assert_eq!(kernels[&31], 31);
    assert_eq!(kernels[&11], 28);
    assert_eq!(kernels[&4], 24);
    let z = ZMat::from_rows(all.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect());
    assert_eq!(32 - rank(&z), 22);
    // PSAGE's "new subspace" (22, Eisenstein series excluded: 21 cusp forms)
    // is larger than the newspace (lmfdb_newspace.rs checks its dimension
    // against the LMFDB):
    let n = Newspaces::new(s.level.clone()).unwrap();
    assert!(n.new_dimension() < 21, "new dimension {}", n.new_dimension());
}

/// The degeneracy map is surjective and agrees with an independently built
/// lower space in dimension.
#[test]
fn degeneracy_lower_spaces() {
    for n in ideals_of_bounded_norm(300) {
        let s = Space::from_ideal(n.clone()).unwrap();
        for &(p, _) in &n.factors {
            let d = s.degeneracy(&p).unwrap();
            let fresh = Space::from_ideal(d.lower.level.clone()).unwrap();
            assert_eq!(d.lower.dimension(), fresh.dimension());
            let mut hit = vec![false; d.lower.dimension()];
            for &j in &d.map {
                hit[j as usize] = true;
            }
            assert!(hit.iter().all(|&h| h));
        }
    }
}

/// hmf.py docstrings: EllipticCurveFactor.ap and aplist.
#[test]
fn psage_aplists() {
    // level F.primes_above(31)[0]: ap at a prime above 11 is 4, at (sqrt 5)
    // -2, at 7 2 (which prime above 11 depends on Sage's order: one of them)
    for p31 in primes_above(31) {
        let ns = Newspaces::new(Ideal::principal(p31.gen).unwrap()).unwrap();
        let f = ns.rational_newforms().unwrap();
        assert_eq!(f.len(), 1);
        let ap = |p| f[0].ap(ns.top(), &p).unwrap();
        assert_eq!(ap(primes_above(5)[0]), -2);
        assert_eq!(ap(primes_above(7)[0]), 2);
        let a11: Vec<i64> = primes_above(11).into_iter().map(ap).collect();
        assert!(a11.contains(&4));
    }
    // H = HilbertModularForms(F.primes_above(71)[1]).elliptic_curve_factors()[0];
    // H.aplist(50) = [-1, 0, -2, 0, 0, 2, -4, 6, -6, 8, 2, 6, 12, -4], for the
    // primes of norm < 50 by norm; within a norm Sage's order is not
    // reproduced, so compare by norm as multisets (both levels of norm 71 are
    // Galois conjugate, so both match).
    let psage = [-1i64, 0, -2, 0, 0, 2, -4, 6, -6, 8, 2, 6, 12, -4];
    let norms: Vec<u64> = primes_of_bounded_norm(50).iter().map(|p| p.norm).collect();
    for p71 in primes_above(71) {
        let ns = Newspaces::new(Ideal::principal(p71.gen).unwrap()).unwrap();
        let f = ns.rational_newforms().unwrap();
        assert_eq!(f.len(), 1);
        let got: Vec<i64> = f[0].aplist(ns.top(), 50).unwrap().into_iter().map(|(_, a)| a.unwrap()).collect();
        assert_eq!(got.len(), psage.len());
        let mut by_norm: HashMap<u64, (Vec<i64>, Vec<i64>)> = HashMap::new();
        for k in 0..got.len() {
            let e = by_norm.entry(norms[k]).or_default();
            e.0.push(got[k]);
            e.1.push(psage[k]);
        }
        for (n, (mut a, mut b)) in by_norm {
            a.sort();
            b.sort();
            assert_eq!(a, b, "norm {}", n);
        }
    }
}

/// daybreak CORR-C4F-1: Hecke operators with huge coefficients are an Err,
/// never an overflow (which would panic, or wrap and void the CRT bound).
#[test]
fn huge_hecke_operator_coefficients_are_errors() {
    use sagebrush_hmf::newspace::{eigenvalue_bound, op_matrix, NewformOrbits, MAX_OP_BOUND};
    let p2 = primes_above(2)[0];
    let p3 = primes_above(3)[0];
    let p5 = primes_above(5)[0];
    let one = Newspaces::new(Ideal::principal(Elt::int(1)).unwrap()).unwrap();
    let n31 = Newspaces::new(Ideal::principal(Elt::new(-2, 5)).unwrap()).unwrap();
    // the reproducer, and extreme coefficients of both signs
    for c in [i64::MAX, i64::MIN, i64::MIN + 1, -(1 << 62), 1 << 62] {
        for ns in [&one, &n31] {
            assert!(ns.new_charpoly(&vec![(p2, c)]).is_err(), "c = {}", c);
            assert!(ns.new_charpolys(&vec![(p3, c)]).is_err());
            assert!(ns.op_matrix(&ns.level, &vec![(p5, c)]).is_err());
            assert!(op_matrix(ns.top(), &vec![(p2, c)]).is_err());
        }
    }
    // several summands, each allowed alone, overflowing together: L is the
    // sum of |c| (N(p) + 1)
    let c = (MAX_OP_BOUND / 10) as i64; // (N(2) + 1) c = 5c < 2^61, but 5c + 6c + 10c > 2^61
    assert!(eigenvalue_bound(&vec![(p2, c)]).is_ok());
    let op = vec![(p2, c), (p5, -c), (p3, c)];
    assert!(eigenvalue_bound(&op).is_err());
    assert!(n31.new_charpoly(&op).is_err());
    assert!(n31.op_matrix(&n31.level, &op).is_err());
    // accumulation: the same prime repeated, each term allowed alone
    let op = vec![(p2, c); 3];
    assert!(n31.op_matrix(&n31.level, &op).is_err());
    assert!(n31.new_charpoly(&op).is_err());
    // the largest allowed operator works and agrees with a scaled T_2
    let c = (MAX_OP_BOUND / 5) as i64;
    let big = n31.new_charpoly(&vec![(p2, c)]).unwrap().new;
    let small = n31.new_charpoly(&vec![(p2, 1)]).unwrap().new;
    // new space of dimension 1: x - c a  versus  x - a
    assert_eq!(big.len(), 2);
    assert!(big[0] == &small[0] * &sagebrush_bigint::BigInt::from(c));
    // a hand-made orbit list with an out-of-range operator
    let orbits = NewformOrbits { op: vec![(p2, i64::MAX)], orbits: vec![] };
    assert!(n31.rational_newforms_of(&orbits).is_err());
}
