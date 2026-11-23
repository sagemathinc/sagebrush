//! The binomial route's units and a Stop, in its own test binary (the
//! interrupt flag and the check counters are process-wide):
//! - each step is counted after its work, so a Stop inside a step charges
//!   only the steps finished before it (the meter's rule, never ahead of
//!   the work);
//! - counts a trapped call leaves (a wasm trap runs no destructors) reach
//!   the next call unless the per-call reset drops them.

use num_traits::{One, Zero};
use sagebrush_arith::cost::{metered, Family, Meter};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_poly::{binomial_testing, reset_binomial_units, try_factor_with, Budget};

/// x^n - 1
fn xn1(n: usize) -> Vec<BigInt> {
    let mut v = vec![BigInt::zero(); n + 1];
    v[0] = -BigInt::one();
    v[n] = BigInt::one();
    v
}

/// The units a metered factor call charges, stopped or not.
fn units(f: &[BigInt]) -> [u64; 10] {
    let mut meter = Meter::accounting(u64::MAX);
    let _ = metered(&mut meter, || sagebrush_interrupt::catch(|| try_factor_with(f, &Budget::default()).map(|x| x.1.len())));
    meter.units().0
}

#[test]
fn a_stop_charges_only_finished_steps_and_a_traps_counts_are_reset() {
    let f = xn1(12);
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    let full = units(&f);
    let s5 = hooks::traced("cyclotomic S5 verification");
    let s6 = hooks::traced("cyclotomic S6 outputs");
    hooks::reset();
    assert!(s5.len() >= 2 && !s6.is_empty());
    assert_eq!(full, [38, 0, 4, 0, 0, 72, 0, 28, 0, 13]);
    let stopped = |at: u64, site: &str| {
        hooks::reset();
        hooks::arm_at(at);
        let u = units(&f);
        assert_eq!(hooks::stopped_in(), site);
        hooks::reset();
        sagebrush_interrupt::clear();
        u
    };
    // a Stop at the first product's second row (S5's second check): that
    // product is not finished, so none of S5's products is charged, the
    // same as a Stop at its first row; everything before S5 is
    let mid = stopped(s5[1], "cyclotomic S5 verification");
    assert_eq!(mid[Family::MulSchool as usize], 0, "an unfinished product was charged: {mid:?}");
    assert_eq!(mid, stopped(s5[0], "cyclotomic S5 verification"));
    assert!(mid[Family::AddSub as usize] > 0 && mid[Family::Div as usize] > 0);
    // a Stop in S6: every S5 product is finished and charged
    let late = stopped(s6[0], "cyclotomic S6 outputs");
    assert_eq!(late[Family::MulSchool as usize], full[Family::MulSchool as usize]);
    // and the next call charges the full run again
    assert_eq!(units(&f), full);

    // counts a trapped call leaves (one test: the check counters are the
    // process's)
    let fresh = full;
    // without the reset, the next call is charged them (the hazard)
    binomial_testing::leave(1000);
    let stale = units(&f);
    assert_eq!(stale[Family::MulSchool as usize], fresh[Family::MulSchool as usize] + 1000);
    // with it (engine/web's new_run), the next call is a fresh run's
    binomial_testing::leave(1000);
    reset_binomial_units();
    assert_eq!(binomial_testing::pending(), 0);
    assert_eq!(units(&f), fresh);
}
