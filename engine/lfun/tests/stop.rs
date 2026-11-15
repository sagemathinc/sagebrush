//! Stop at a chosen check of each of the crate's own loops (the interrupt crate's test hooks: every
//! check counted per phase, Stop requested at a chosen one): anlist's coefficient loop, the
//! L-series sum, and Gamma(a, z)'s series and continued fraction each stop in their own phase, and
//! the next call gives the same result as before.  Each phase's checks are that loop's own polls
//! (nested calls check in their own phases), so removing one fails here.  One test: the hooks and
//! the request flag are process-wide.

use sagebrush_interrupt::{catch, hooks};
use sagebrush_lfun::{anlist, gamma_inc, LSeries, Local, C64};

/// Stop at the median check of `phase` (from a traced run): f must stop in that phase.
fn stops_in<T>(phase: &str, f: impl Fn() -> T) {
    hooks::reset();
    hooks::trace();
    let _ = f();
    let idx = hooks::traced(phase);
    hooks::reset();
    assert!(!idx.is_empty(), "{phase}: no checks of its own");
    hooks::arm_at(idx[idx.len() / 2]);
    let r = catch(&f);
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "{phase}: not stopped");
    assert_eq!(at, phase, "stopped in the phase asked");
}

#[test]
fn each_loop_stops_in_its_own_phase_and_the_next_call_is_unchanged() {
    let loc = [Local { p: 11, ap: 1, good: false }];
    let a = [0, -1, 1, -10, -20];
    let an = anlist(a, &loc, 20_000).unwrap();
    let l = LSeries::new(&an, 11, 1).unwrap();
    let s = C64::new(1.0, 300.0);
    // a long series (|z| just below |a|), and the longest continued fraction found in the
    // L-series' domain (|z| just above |a|, about 130 steps)
    let (aa, zs) = (C64::new(1.0, 3000.0), C64::new(1.0, 2600.0));
    let (ac, zc) = (C64::new(-3.0, 1000.0), C64::new(0.797_126_624_489_594_3, 1_001.004_187_103_203_1));
    let before = (anlist(a, &loc, 1_000_000).unwrap(), l.value(s).unwrap(), gamma_inc(aa, zs).unwrap().value(), gamma_inc(ac, zc).unwrap().value());

    stops_in("lfun.anlist", || anlist(a, &loc, 1_000_000));
    stops_in("lfun.value", || l.value(s));
    stops_in("lfun.gamma_series", || gamma_inc(aa, zs));
    stops_in("lfun.gamma_cf", || gamma_inc(ac, zc));

    let after = (anlist(a, &loc, 1_000_000).unwrap(), l.value(s).unwrap(), gamma_inc(aa, zs).unwrap().value(), gamma_inc(ac, zc).unwrap().value());
    assert!(before.0 == after.0 && before.1 == after.1 && before.2 == after.2 && before.3 == after.3, "unchanged after the Stops");
}
