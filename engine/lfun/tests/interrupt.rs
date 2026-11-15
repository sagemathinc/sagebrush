//! Stop is seen in the crate's long loops: anlist, the L-series sum and Gamma(a, z)'s series and
//! continued fraction each unwind with sagebrush_interrupt::Interrupted once an interrupt is
//! requested, and the next call works normally.  A single test, because the flag is global.
use sagebrush_lfun::{anlist, LSeries, Local, C64};

#[test]
fn the_long_loops_see_stop() {
    let loc = [Local { p: 11, ap: 1, good: false }];
    let an = anlist([0, -1, 1, -10, -20], &loc, 200_000).unwrap();
    let l = LSeries::new(&an, 11, 1).unwrap();
    let s = C64::new(1.0, 1000.0);
    sagebrush_interrupt::request();
    let a = sagebrush_interrupt::catch(|| anlist([0, -1, 1, -10, -20], &loc, 1_000_000));
    let v = sagebrush_interrupt::catch(|| l.value(s));
    // (a series of several hundred terms: the series checks every 256)
    let g = sagebrush_interrupt::catch(|| sagebrush_lfun::gamma_inc(C64::new(1.0, 3000.0), C64::new(1.0, 2600.0)));
    sagebrush_interrupt::clear();
    assert!(a.is_err(), "anlist did not see the interrupt");
    assert!(v.is_err(), "L(E, s) did not see the interrupt");
    assert!(g.is_err(), "Gamma(a, z) did not see the interrupt");
    assert!(sagebrush_interrupt::catch(|| l.value(s)).unwrap().is_ok());
}
