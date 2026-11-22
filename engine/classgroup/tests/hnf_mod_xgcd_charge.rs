//! hnf_mod's extended gcd: with the checked extended gcd's fallback forced
//! (the test hook), the same HNF, and the fallback's work charged (its Gcd
//! units rise); a multi-limb modulus, so the extended gcds are dashu's
//! large path.

use sagebrush_arith::cost::{tallied, Family};
use sagebrush_bigint::{with_xgcd_fallback_forced, BigInt};
use sagebrush_classgroup::linalg::hnf_mod;

fn gcd_units<T>(f: impl FnOnce() -> T) -> (u64, T) {
    let t0 = tallied();
    let x = f();
    (tallied().0[Family::Gcd as usize].wrapping_sub(t0.0[Family::Gcd as usize]), x)
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
    let (normal, h1) = gcd_units(|| hnf_mod(&rows, n, &d));
    let (forced, h2) = gcd_units(|| with_xgcd_fallback_forced(|| hnf_mod(&rows, n, &d)));
    assert_eq!(h1, h2, "the same HNF");
    println!("hnf_mod: Gcd units {normal}, {forced} with the fallback forced");
    assert!(forced > normal, "the forced fallback's work is charged");
}
