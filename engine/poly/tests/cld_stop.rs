//! Stop inside the CLD bounds of van Hoeij's recombination (Codex A14-F2), in its own test binary: the
//! interrupt flag and the check counters are process-wide.  The bounds' checks are traced on a full
//! factorization of S_5, then Stop is armed at the middle one: the call unwinds there, with no live
//! reservation, and the next call works normally.

use num_traits::Zero;
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_poly::{try_factor_with, Budget};

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
fn stop_inside_the_cld_bounds() {
    let f = swinnerton_dyer(5);
    let site = "cld bounds";
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    assert_eq!(try_factor_with(&f, &Budget::default()).unwrap().1, vec![(f.clone(), 1)]);
    let idx = hooks::traced(site);
    hooks::reset();
    // a check at each of the 32 bounds of every call (before, only the debit's one ahead of them all)
    assert!(idx.len() >= 32, "{} checks in the bounds", idx.len());
    hooks::arm_at(idx[idx.len() / 2]);
    let b = Budget::default();
    let r = sagebrush_interrupt::catch(|| try_factor_with(&f, &b).map(|x| x.1.len()));
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "not interrupted ({r:?})");
    assert_eq!(at, site);
    assert_eq!(b.live(), 0, "live reservation after Stop");
    assert_eq!(try_factor_with(&f, &Budget::default()).unwrap().1, vec![(f.clone(), 1)]);
}
