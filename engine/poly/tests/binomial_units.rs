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
    // (S6's first check is its first output's debit; its second is inside
    // that output's copy: that output is not charged either, the whole
    // array the same)
    assert_eq!(stopped(s6[1], "cyclotomic S6 outputs"), late, "an unfinished S6 output was charged");
    // stage B's certificate (S10): a Stop inside a piece's zero scan (its
    // second S10 check) charges that piece's scan no more than a Stop at
    // its debit (the first)
    let mut g = vec![BigInt::zero(); 7];
    g[0] = BigInt::from(-9);
    g[6] = BigInt::from(4);
    hooks::reset();
    hooks::trace();
    let gfull = units(&g);
    let s10 = hooks::traced("homogenize S10 certificate");
    hooks::reset();
    assert!(s10.len() >= 2, "{s10:?}");
    assert_eq!(gfull, [233, 0, 5, 0, 0, 162, 7474, 3, 0, 3]);
    let stopped_g = |at: u64| {
        hooks::reset();
        hooks::arm_at(at);
        let u = units(&g);
        assert_eq!(hooks::stopped_in(), "homogenize S10 certificate");
        hooks::reset();
        sagebrush_interrupt::clear();
        u
    };
    assert_eq!(stopped_g(s10[1]), stopped_g(s10[0]), "an unfinished certificate scan was charged");

    // every other step with a check inside it: a Stop at its first inner
    // check charges the same as a Stop at its own debit's check, the one
    // just before (spend polls)
    let stop_any = |f: &[BigInt], at: u64| {
        hooks::reset();
        hooks::arm_at(at);
        let u = units(f);
        hooks::reset();
        sagebrush_interrupt::clear();
        u
    };
    // S2's extra unit (debited before the trial loop, counted after it):
    // its second check is the loop's first debit
    hooks::reset();
    hooks::trace();
    units(&f);
    let s2 = hooks::traced("binomial S2 enumeration");
    let s3 = hooks::traced("cyclotomic S3 kernels");
    let s4 = hooks::traced("cyclotomic S4 sparse");
    hooks::reset();
    assert_eq!(s2[1], s2[0] + 1);
    assert_eq!(stop_any(&f, s2[1]), stop_any(&f, s2[0]), "S2's extra unit was charged before the loop");
    // the sparse products and divisions (S4): each call's check, against its
    // debit (S3's check just before it)
    assert!(!s4.is_empty());
    for &c in &s4 {
        assert!(s3.contains(&(c - 1)), "S4 check {c} not right after a debit");
        assert_eq!(stop_any(&f, c), stop_any(&f, c - 1), "an unfinished S4 step was charged (check {c})");
    }
    // the residue prefilter's two fold passes over a 65536-bit coefficient:
    // a Stop at a pass's first own check, against its debit's check
    let n = (BigInt::one() << 65535u32) + BigInt::from(3);
    let fold_units = |plus: bool, at: Option<u64>| {
        hooks::reset();
        if let Some(at) = at {
            hooks::arm_at(at);
        }
        let mut meter = Meter::accounting(u64::MAX);
        let _ = metered(&mut meter, || sagebrush_interrupt::catch(|| binomial_testing::fold_passes(&n, plus)));
        let total = hooks::total();
        hooks::reset();
        sagebrush_interrupt::clear();
        (meter.units().0, total)
    };
    let (_, first) = fold_units(false, None);
    let (both, _) = fold_units(true, None);
    assert!(first >= 3 && both[Family::ModArith as usize] > 0);
    // (the first pass: checks 1 (its check), 2 (its debit), 3.. (its own);
    // the second: first + 1, first + 2, first + 3..)
    assert_eq!(fold_units(true, Some(3)).0, fold_units(true, Some(2)).0, "an unfinished first fold pass was charged");
    assert_eq!(fold_units(true, Some(first + 3)).0, fold_units(true, Some(first + 2)).0, "an unfinished second fold pass was charged");
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
