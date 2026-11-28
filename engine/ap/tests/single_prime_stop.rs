//! A pending Stop is seen by a single-prime a_p (A09b), by counting and by
//! baby-step giant-step, and the next call answers.  (A file of its own:
//! the Stop request is process-wide.  Native only: a Stop unwinds.)

#![cfg(not(target_arch = "wasm32"))]

use sagebrush_ap::EllipticCurve;

#[test]
fn single_prime_ap_stops() {
    let e = EllipticCurve::new([0, 0, 0, -1, 0]).unwrap();
    for p in [101u64, 1009, 1000000007] {
        let want = e.ap(p);
        sagebrush_interrupt::request();
        let r = sagebrush_interrupt::catch(|| e.ap(p));
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "p = {}: stopped", p);
        assert_eq!(e.ap(p), want, "p = {}: answers after", p);
    }
}
