//! Stop inside the rational-point search's numerator scan (A17-F1): one check
//! per wheel block of 5005 numerators, and one before a result is returned,
//! so a Stop is seen within microseconds of scanning and never answered with
//! success.  (A file of its own: the hooks and the Stop request are
//! process-wide.  Native only: a Stop unwinds.)

#![cfg(not(target_arch = "wasm32"))]

use sagebrush_ap::search::x_coordinates;
use sagebrush_interrupt::{catch, hooks};

const W: u64 = 5 * 7 * 11 * 13;

// y^2 + y = x^3 - x: b2 = 0, b4 = -2, b6 = 1
fn search(rmax: u64, smax: u64, limit: usize) -> Vec<(i128, u64)> {
    x_coordinates(0, -2, 1, rmax, smax, limit).unwrap()
}

#[test]
fn search_stops_inside_the_scan_and_at_the_limit() {
    // the checks: one per denominator, one per block of W numerators in
    // [-rmax, rmax], one at the end
    let rmax = 2_000_000u64;
    hooks::reset();
    hooks::trace();
    let want = search(rmax, 1, 1000);
    let total = hooks::total();
    let gap_ms = hooks::max_gap_ns() as f64 / 1e6;
    hooks::reset();
    assert_eq!(total, 1 + (2 * rmax + 1).div_ceil(W) + 1);
    assert!(gap_ms < 50.0, "longest gap between checks {} ms", gap_ms);
    for x in [(0, 1), (1, 1), (-1, 1), (2, 1), (6, 1)] {
        assert!(want.contains(&x), "{:?}", x);
    }
    // a Stop at a quarter, half and the last block of the scan stops it, and
    // the next call gives the same points
    for at in [total / 4, total / 2, total - 1] {
        hooks::reset();
        hooks::arm_at(at);
        let r = catch(|| search(rmax, 1, 1000));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "Stop at check {} of {}", at, total);
        assert_eq!(search(rmax, 1, 1000), want);
    }

    // (one test: the hooks are process-wide) limit 1 at rmax 10: the checks
    // of the denominator and of the only block, and the one before the first
    // point is returned
    hooks::reset();
    let want = search(10, 1, 1);
    let total = hooks::total();
    hooks::reset();
    assert_eq!((want.len(), total), (1, 3));
    hooks::arm_at(total);
    let r = catch(|| search(10, 1, 1));
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "a Stop before the result is returned");
    assert_eq!(search(10, 1, 1), want);
}
