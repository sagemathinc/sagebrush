//! hnf_mod's extended gcd: with the checked extended gcd's fallback forced
//! (the test hook), the same HNF, and the run's units rise by exactly the
//! price of the fallbacks taken; a multi-limb modulus, so the extended gcds
//! are dashu's large path.

use sagebrush_arith::cost::{tallied, xgcd_fallback_units, FAMILIES};
use sagebrush_bigint::{with_xgcd_fallback_recorded, BigInt};
use sagebrush_classgroup::linalg::hnf_mod;

fn units<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], T) {
    let t0 = tallied();
    let x = f();
    let t1 = tallied();
    let mut d = [0; FAMILIES];
    for (i, v) in d.iter_mut().enumerate() {
        *v = t1.0[i].wrapping_sub(t0.0[i]);
    }
    (d, x)
}

#[test]
fn hnf_mod_charges_the_fallback_when_it_ran() {
    let mut s = 0x2545f4914f6cdd1du64;
    let mut nx = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 34) as i64 - (1 << 29)
    };
    let n = 5;
    let rows: Vec<Vec<i64>> = (0..12).map(|_| (0..n).map(|_| nx()).collect()).collect();
    // d: a multi-limb multiple of the lattice's determinant (it contains d Z^n)
    let d = (BigInt::from(1) << 200usize) * BigInt::from(3);
    let (normal, h1) = units(|| hnf_mod(&rows, n, &d));
    let (forced, (h2, taken)) = units(|| with_xgcd_fallback_recorded(|| hnf_mod(&rows, n, &d)));
    assert_eq!(h1, h2, "the same HNF");
    assert!(!taken.is_empty(), "a fallback taken");
    // the forced run's units less the normal run's: exactly the fallbacks'
    // price (the check, paid by both, cancels)
    let mut want = [0u64; FAMILIES];
    for fb in &taken {
        for (w, u) in want.iter_mut().zip(xgcd_fallback_units(Some(fb)).0) {
            *w += u;
        }
    }
    let delta: Vec<u64> = (0..FAMILIES).map(|i| forced[i].wrapping_sub(normal[i])).collect();
    println!("hnf_mod: {} fallbacks, their price {want:?}", taken.len());
    assert_eq!(delta, want.to_vec(), "the forced run's units less the normal run's = the fallbacks' price");
}
