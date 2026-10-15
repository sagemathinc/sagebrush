//! U_P (P dividing the level) against Magma 2.18 as a black box
//! (fixtures/magma-up.m): the characteristic polynomial of
//! HeckeOperator(HilbertCuspForms(F, N), P) on the whole of S_2(N), old forms
//! included, at composite levels. Our matrix acts on M_2(N); the constant
//! function is an eigenvector with eigenvalue the common row sum, so
//!   charpoly(ours) = (x - row sum) charpoly(Magma).

use sagebrush_arith::zmat::{charpoly, ZMat};
use sagebrush_arith::zpoly;
use sagebrush_bigint::BigInt;
use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::Space;

#[test]
fn up_vs_magma() {
    let mut n = 0;
    for l in include_str!("fixtures/magma-up.txt").lines().filter(|l| !l.starts_with('#')) {
        let parts: Vec<&str> = l.split('|').collect();
        let ints = |s: &str| -> Vec<i64> { s.split_whitespace().map(|x| x.parse().unwrap()).collect() };
        let (lv, pv, tr) = (ints(parts[0]), ints(parts[1]), ints(parts[2])[0]);
        let cp: Vec<BigInt> = parts[3].split_whitespace().map(|x| x.parse::<BigInt>().unwrap()).collect();
        let pi = Ideal::principal(Elt::new(pv[0], pv[1])).unwrap();
        let (p, _) = pi.factors[0];
        let s = Space::new(Elt::new(lv[0], lv[1])).unwrap();
        let t = s.hecke_matrix(&p).unwrap();
        let sum: u64 = t.rows[0].iter().map(|&(_, c)| c as u64).sum();
        let divides = s.level.factors.iter().any(|(q, _)| *q == p);
        assert_eq!(sum, if divides { p.norm } else { p.norm + 1 });
        assert_eq!(t.trace() - sum as i64, tr, "trace at level {}, P = {}", lv[0], p.gen);
        let rows = t.dense().iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect();
        let got = charpoly(&ZMat::from_rows(rows));
        let want = zpoly::mul(&[BigInt::from(-(sum as i64)), BigInt::from(1i64)], &cp);
        assert!(got == want, "charpoly at level {} + {} w, P = {}", lv[0], lv[1], p.gen);
        if divides {
            n += 1;
        }
    }
    assert!(n >= 12, "{} operators at primes dividing the level", n);
}
