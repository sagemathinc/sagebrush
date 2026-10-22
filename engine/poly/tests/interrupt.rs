//! Interrupts, in their own test binary: the request flag is process-wide,
//! so it must not run alongside the other tests.

use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;

fn mul(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut r = vec![BigInt::zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            r[i + j] += x * y;
        }
    }
    r
}

/// S_5 = prod (x +- sqrt2 +- sqrt3 +- sqrt5 +- sqrt7 +- sqrt11), from its
/// 32 conjugate pairs: built as S_{k}(x) = Res_y(S_{k-1}(x - y), y^2 - p),
/// computed here as A^2 - p B^2 with S_{k-1}(x + sqrt p) = A + B sqrt p.
fn swinnerton_dyer(k: usize) -> Vec<BigInt> {
    let z = |v: &[i64]| -> Vec<BigInt> { v.iter().map(|&c| BigInt::from(c)).collect() };
    let mut s = z(&[-2, 0, 1]);
    for &p in &[3i64, 5, 7, 11][..k - 1] {
        let (mut a, mut c): (Vec<BigInt>, Vec<BigInt>) = (vec![BigInt::zero()], vec![BigInt::zero()]);
        for coef in s.iter().rev() {
            // (a + c sqrt p)(x + sqrt p) + coef
            let mut na = mul(&a, &z(&[0, 1]));
            let pc = mul(&c, &z(&[p]));
            for (i, v) in pc.iter().enumerate() {
                na[i] += v;
            }
            na[0] += coef;
            let mut nc = mul(&c, &z(&[0, 1]));
            for (i, v) in a.iter().enumerate() {
                nc[i] += v;
            }
            a = na;
            c = nc;
        }
        let mut r = mul(&a, &a);
        let c2 = mul(&mul(&c, &c), &z(&[p]));
        for (i, v) in c2.iter().enumerate() {
            r[i] -= v;
        }
        while r.last().map_or(false, |x| x.is_zero()) {
            r.pop();
        }
        s = r;
    }
    s
}

#[test]
fn interrupt_leaves_no_state() {
    let f = swinnerton_dyer(5);
    assert_eq!(f.len(), 33);
    assert!(f.last().unwrap().is_one());
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| sagebrush_poly::try_factor(&f));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "interrupted");
    assert_eq!(sagebrush_poly::try_factor(&f).unwrap().1, vec![(f.clone(), 1)]);
}
