//! Hilbert modular forms over real quadratic fields by the definite method
//! (definite.rs).
//!
//! - Dembélé-Voight, "Explicit methods for Hilbert modular forms" (2013),
//!   Example 8.6, F = Q(sqrt 106) (h = h+ = 2), level 1:
//!   - dim S_2(1) = 50;
//!   - the constituents have dimensions 1, 1, 1, 1, 2 (six times), 4, 4 and
//!     26. A combination of three Hecke operators has a squarefree
//!     characteristic polynomial with exactly those irreducible factors,
//!     besides the two Eisenstein ones;
//!   - the table of a_P of the four rational forms f1..f4, at the seven
//!     primes of norm <= 7 it lists, read off the rational eigenvectors.
//! - Over Q(sqrt 5) the space agrees with the icosian code of lib.rs (ported
//!   from PSAGE and checked against it and LMFDB): the same dimension and the
//!   same characteristic polynomials of T_P at every level of norm <= 30 (60
//!   in an ignored test), for
//!   the primes of norm <= 30 not dividing it, and the same characteristic
//!   polynomials on the new part as newspace.rs (checked against LMFDB).
//! - Magma 2.18 as a black box (fixtures/magma-definite.m): dim S_2(N) and
//!   the characteristic polynomials of T_P on S_2(N) over 10 fields, of
//!   class numbers 1 and 2 and narrow class numbers 1, 2 and 4, for every
//!   level of norm <= 12.

use sagebrush_arith::zmat::{charpoly, kernel, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_hmf::definite::DefiniteSpace;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QPrime, QuadField};

fn space(d: i64, level: &[QElt]) -> (QuadField, DefiniteSpace) {
    let f = QuadField::new(d).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let n = if level.is_empty() { f.unit_ideal() } else { f.ideal(level).unwrap() };
    let sp = DefiniteSpace::new(&o, &n).unwrap();
    (f, sp)
}

fn prime(f: &QuadField, gens: &[QElt]) -> QPrime {
    let fac = f.factor(&f.ideal(gens).unwrap()).unwrap();
    assert!(fac.len() == 1 && fac[0].1 == 1, "not a prime");
    fac[0].0
}

fn dense(sp: &DefiniteSpace, p: &QPrime) -> Vec<Vec<i64>> {
    sp.hecke_matrix(p).unwrap().dense()
}

#[test]
fn dembele_voight_example_8_6() {
    let (f, sp) = space(106, &[]);
    assert_eq!((sp.dimension(), sp.cusp_dimension()), (52, 50));
    // DV's primes, w = sqrt 106
    let g = |a: i64, b: i64| QElt::new(a, b);
    let ps: Vec<QPrime> = vec![
        prime(&f, &[QElt::int(2), g(0, 1)]),
        prime(&f, &[QElt::int(3), g(1, 1)]),
        prime(&f, &[QElt::int(3), g(-1, 1)]),
        prime(&f, &[QElt::int(5), g(1, 1)]),
        prime(&f, &[QElt::int(5), g(-1, 1)]),
        prime(&f, &[g(31, 3)]),
        prime(&f, &[g(-31, 3)]),
    ];
    assert_eq!(ps.iter().map(|p| p.norm).collect::<Vec<_>>(), vec![2, 3, 3, 5, 5, 7, 7]);
    let ts: Vec<Vec<Vec<i64>>> = ps.iter().map(|p| dense(&sp, p)).collect();
    // T = T_(3, w+1) + 5 T_(2, w) + 7 T_(5, w+1)
    let n = sp.dimension();
    let t: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| BigInt::from(ts[1][i][j] + 5 * ts[0][i][j] + 7 * ts[3][i][j])).collect()).collect();
    let cp = charpoly(&ZMat::from_rows(t.clone()));
    let (_, fac) = sagebrush_poly::factor(&cp);
    assert!(fac.iter().all(|(_, e)| *e == 1), "the combination separates the constituents");
    let mut degs: Vec<usize> = fac.iter().map(|(g, _)| g.len() - 1).collect();
    degs.sort_unstable();
    // four rational forms, two Eisenstein eigenvalues, 2^6, 4^2, 26
    assert_eq!(degs, vec![1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4, 4, 26]);
    // the rational eigenvectors and their a_P
    let mut rows: Vec<Vec<i64>> = vec![];
    for (g, _) in fac.iter().filter(|(g, _)| g.len() == 2) {
        let lambda = -&g[0];
        let a: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| if i == j { &t[i][j] - &lambda } else { t[i][j].clone() }).collect()).collect();
        let k = kernel(&ZMat::from_rows(a));
        assert_eq!(k.rows, 1);
        let v: Vec<BigInt> = k.row(0).to_vec();
        let piv = v.iter().position(|x| x != &BigInt::from(0)).unwrap();
        let mut row = vec![];
        for tp in &ts {
            let tv: Vec<BigInt> = (0..n).map(|i| (0..n).map(|j| BigInt::from(tp[i][j]) * &v[j]).fold(BigInt::from(0), |s, x| s + x)).collect();
            let ap = &tv[piv] / &v[piv];
            assert!((0..n).all(|i| tv[i] == &ap * &v[i]), "a simultaneous eigenvector");
            row.push(ap.to_string().parse::<i64>().unwrap());
        }
        rows.push(row);
    }
    // drop the two Eisenstein series (a_P = +-(N(P) + 1))
    rows.retain(|r| r[0].abs() != 3);
    rows.sort();
    let mut want = vec![
        vec![-1, -2, 3, 3, -2, 4, -1], // f1
        vec![-1, 3, -2, -2, 3, -1, 4], // f2
        vec![1, 2, -3, -3, 2, 4, -1],  // f3
        vec![1, -3, 2, 2, -3, -1, 4],  // f4
    ];
    want.sort();
    assert_eq!(rows, want);
}

fn icosians(bound: u64) -> usize {
    use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm};
    let f = QuadField::new(5).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let to_q = |a: u64, b: u64, c: u64| f.ideal(&[QElt::int(a as i64), QElt::new(b as i64, c as i64)]).unwrap();
    let mut n_checked = 0;
    for lev in ideals_of_bounded_norm(bound) {
        let old = sagebrush_hmf::Space::from_ideal(lev.clone()).unwrap();
        let ql = to_q(lev.hnf.a, lev.hnf.b, lev.hnf.c);
        let new = DefiniteSpace::new(&o, &ql).unwrap();
        assert_eq!(new.dimension(), old.dimension(), "level {:?}", lev.hnf);
        // the new part, against newspace.rs (checked against LMFDB)
        if let Some(p) = primes_of_bounded_norm(30).into_iter().find(|p| lev.factors.iter().all(|(q, _)| q.hnf != p.hnf)) {
            let qp = f.primes_above(p.p as i64).unwrap().into_iter().find(|q| q.ideal == to_q(p.hnf.a, p.hnf.b, p.hnf.c)).unwrap();
            let theirs = sagebrush_hmf::newspace::Newspaces::new(lev.clone()).unwrap().new_charpoly(&vec![(p, 1)]).unwrap().new;
            let ours = sagebrush_hmf::definite::new_charpoly(&o, &ql, &qp).unwrap();
            assert_eq!(ours, theirs, "new part at level {:?}", lev.hnf);
        }
        for p in primes_of_bounded_norm(30) {
            if lev.factors.iter().any(|(q, _)| q.hnf == p.hnf) {
                continue;
            }
            let qp = f.primes_above(p.p as i64).unwrap().into_iter().find(|q| q.ideal == to_q(p.hnf.a, p.hnf.b, p.hnf.c)).unwrap();
            let a = ZMat::from_rows(old.hecke_matrix(&p).unwrap().dense().into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect());
            let b = ZMat::from_rows(dense(&new, &qp).into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect());
            assert_eq!(charpoly(&a), charpoly(&b), "level {:?}, P = {:?}", lev.hnf, p.hnf);
            n_checked += 1;
        }
    }
    n_checked
}

#[test]
fn agrees_with_the_icosian_code() {
    assert!(icosians(30) > 50);
}

#[test]
#[ignore]
fn agrees_with_the_icosian_code_to_60() {
    assert!(icosians(60) > 100);
}

/// Magma 2.18 as a black box (fixtures/magma-definite.m): dim S_2(N) and
/// the characteristic polynomials of T_P on S_2(N) over 10 fields, for every
/// level of norm <= 12 and every prime of norm <= 7 not dividing it.
#[test]
fn cusp_spaces_vs_magma() {
    use std::collections::HashMap;
    let mut spaces: HashMap<(i64, (i128, i128, i128)), (QuadField, DefiniteSpace)> = HashMap::new();
    let (mut n_dims, mut n_polys) = (0, 0);
    for l in include_str!("fixtures/magma-definite.txt").lines().filter(|l| !l.starts_with('#')) {
        // d | x1 y1 ; x2 y2 | dim | p x y | c_0 ... c_n
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
        let dim: usize = p[2].parse().unwrap();
        assert_eq!(sp.cusp_dimension(), dim, "d = {}, N = {:?}", d, level.hnf());
        n_dims += 1;
        let q = nums(p[3]);
        if q[0] == 0 {
            continue;
        }
        let pr = f.primes_above(q[0]).unwrap().into_iter().find(|pr| f.contains(&pr.ideal, &QElt::new(q[1], q[2])).unwrap()).unwrap();
        let want: Vec<BigInt> = p[4].split_whitespace().map(|t| t.parse().unwrap()).collect();
        assert_eq!(sp.cusp_charpoly(&pr).unwrap(), want, "d = {}, N = {:?}, P = {:?}", d, level.hnf(), pr.ideal.hnf());
        n_polys += 1;
    }
    assert_eq!((n_dims, n_polys), (299, 267));
}
