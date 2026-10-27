//! Stop at each named poll site of binomials (plan factor-binomial r3,
//! 4.6, sites S1-S10), in its own test binary: the interrupt flag and the
//! check counters are process-wide.  Each site's checks are traced on a
//! full run, then Stop is armed at the middle one: the call unwinds with
//! the interrupt, at that site, leaving no live reservation.

use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_poly::{try_factor_with, Budget};

/// x^n + c
fn xn(n: usize, c: i64) -> Vec<BigInt> {
    let mut v = vec![BigInt::zero(); n + 1];
    v[0] = BigInt::from(c);
    v[n] = BigInt::one();
    v
}

#[test]
fn stop_at_every_site() {
    let stage_a = xn(5040, -1);
    let mut stage_b = xn(12, -81);
    stage_b[12] = BigInt::from(16);
    // many pieces: 2^5040 x^5040 - 3^5040 (60 of them)
    let mut many = xn(5040, 0);
    many[0] = -BigInt::from(3u32).pow(5040u32);
    many[5040] = BigInt::from(2u32).pow(5040u32);
    let cases: Vec<(&Vec<BigInt>, &str)> = vec![
        (&stage_a, "binomial S1 scan"),
        (&stage_a, "binomial S2 enumeration"),
        (&stage_a, "cyclotomic S3 kernels"),
        (&stage_a, "cyclotomic S4 sparse"),
        (&stage_a, "cyclotomic S5 verification"),
        (&stage_a, "cyclotomic S6 outputs"),
        (&stage_b, "binomial S2 enumeration"),
        (&stage_b, "perfect power S7"),
        (&stage_b, "homogenize S8"),
        (&stage_b, "homogenize S9 pieces"),
        (&stage_b, "homogenize S10 certificate"),
        (&many, "perfect power S7"),
        (&many, "homogenize S8"),
        (&many, "homogenize S10 certificate"),
    ];
    sagebrush_interrupt::clear();
    for (f, site) in cases {
        hooks::reset();
        hooks::trace();
        let b = Budget::default();
        assert!(try_factor_with(f, &b).is_ok());
        let idx = hooks::traced(site);
        let gap = hooks::max_gap_ns();
        hooks::reset();
        assert!(!idx.is_empty(), "no checks at {}", site);
        hooks::arm_at(idx[idx.len() / 2]);
        let b = Budget::default();
        let r = sagebrush_interrupt::catch(|| try_factor_with(f, &b).map(|x| x.1.len()));
        let at = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "{}: not interrupted ({:?})", site, r);
        assert_eq!(at, site);
        assert_eq!(b.live(), 0, "{}: live reservation after Stop", site);
        println!("STOP {:28} {:6} checks, longest gap {:.3} ms (whole run)", site, idx.len(), gap as f64 / 1e6);
        // and the next call works normally
        assert!(try_factor_with(f, &Budget::default()).is_ok());
    }
}
