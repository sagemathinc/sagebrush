//! Stop during the a_p kernels (the interrupt crate's test hooks: every check
//! counted per phase, Stop requested at a chosen one): the sieve, aplist,
//! aplist_many and moments stop in the phase asked, promptly, and the next
//! call works; with no Stop the results are unchanged.  One test: the hooks
//! and the request flag are process-wide.

use sagebrush_ap::{aplist, aplist_many, moments, primes_up_to, EllipticCurve};
use sagebrush_interrupt::{catch, hooks};
use std::time::Instant;

/// (length, sum of a_p, FNV-1a over (p, a_p)): the shape of a whole aplist.
fn digest(v: &[(u64, Option<i64>)]) -> (usize, i64, u64) {
    let mut h: u64 = 1469598103934665603;
    for (p, a) in v {
        h = (h ^ *p).wrapping_mul(1099511628211);
        h = (h ^ (a.unwrap_or(i64::MIN) as u64)).wrapping_mul(1099511628211);
    }
    (v.len(), v.iter().map(|x| x.1.unwrap_or(0)).sum(), h)
}

fn curve() -> EllipticCurve {
    EllipticCurve::new([0, 0, 1, -1, 0]).unwrap()
}

/// Run f traced: (its result, the checks of each named phase, the longest gap
/// between two checks, the longest gap between two simulated WebAssembly host
/// polls), in ms.
fn traced<T>(phases: &[&str], f: impl FnOnce() -> T) -> (T, Vec<usize>, f64, f64) {
    hooks::reset();
    hooks::trace();
    let r = f();
    let counts = phases.iter().map(|p| hooks::traced(p).len()).collect();
    let (gap, poll) = (hooks::max_gap_ns() as f64 / 1e6, hooks::max_poll_gap_ns() as f64 / 1e6);
    hooks::reset();
    (r, counts, gap, poll)
}

/// Call f with a Stop armed at check `at` (1-based, since the last reset),
/// and time the Stop from its request (the instant the arming check called
/// request(), recorded by the test hooks) to f's return.  Returns (stopped?,
/// the phase stopped in, ms from the request to the return).
fn stop_at<T>(at: u64, f: impl Fn() -> T) -> (bool, &'static str, f64) {
    hooks::reset();
    hooks::arm_at(at);
    let r = catch(&f);
    let back = Instant::now();
    let asked = hooks::stop_requested_at();
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    let ms = asked.map_or(f64::INFINITY, |t| back.duration_since(t).as_secs_f64() * 1e3);
    (r.is_err(), at, ms)
}

/// Stop at the median check of `phase` (from a traced run): f must stop in
/// that phase within 2 s of the Stop's request (in any build: the time to
/// reach the median check isn't counted).
fn stops_in<T>(phase: &str, f: impl Fn() -> T) {
    hooks::reset();
    hooks::trace();
    let _ = f();
    let idx = hooks::traced(phase);
    hooks::reset();
    assert!(!idx.is_empty(), "{phase}: no checks");
    let (stopped, at, ms) = stop_at(idx[idx.len() / 2], &f);
    assert!(stopped, "{phase}: not stopped");
    assert_eq!(at, phase, "stopped in the phase asked");
    eprintln!("{phase}: Stop at its median check, returned {ms:.2} ms after the request");
    assert!(ms < 2000.0, "{phase}: returned {ms:.0} ms after the Stop's request");
}

#[test]
fn ap_kernels_stop_everywhere_and_change_nothing_otherwise() {
    let e = curve();
    let e2 = EllipticCurve::new([0, 1, 1, -2, 0]).unwrap();

    // 1. No Stop: the same results as before the checks (recorded on master 2999416e).
    let p = primes_up_to(1_000_000);
    assert_eq!((p.len(), p.iter().sum::<u64>()), (78498, 37550402023));
    assert_eq!(digest(&aplist(&e, 1000)), (168, 64, 7745706942851138522));
    let many = aplist_many(&[e.clone(), e2.clone()], 1_000_000);
    assert_eq!(digest(&many[0]), (78498, -13432, 1200204480577255510));
    assert_eq!(digest(&many[1]), (78498, -127823, 3087228803289693509));

    // 2. aplist(2e7): checks in the sieve and at every prime; the longest gap
    // between two checks, and between two WebAssembly host polls, is short.
    let (v, counts, gap, poll) = traced(&["ap.sieve", "ap.aplist"], || aplist(&e, 20_000_000));
    assert_eq!(digest(&v), (1270607, -851781, 4957559860084813400), "aplist(2e7) unchanged");
    eprintln!("aplist(2e7): sieve {} checks, aplist {} checks; longest gap {gap:.2} ms, poll gap {poll:.2} ms", counts[0], counts[1]);
    assert!(counts[0] >= 100, "the sieve checks throughout");
    assert_eq!(counts[1], 1270607, "one check per prime");
    // (wall time, generous for a loaded CI runner: without the checks the whole
    // call, about 0.2 s natively here, went unchecked)
    assert!(gap < 50.0 && poll < 100.0, "gap {gap:.2} ms, poll gap {poll:.2} ms");

    // 3. Stop in each phase of each entry point; the next call works.
    stops_in("ap.sieve", || aplist(&e, 20_000_000));
    stops_in("ap.aplist", || aplist(&e, 20_000_000));
    stops_in("ap.aplist_many", || aplist_many(&[e.clone(), e2.clone()], 2_000_000));
    assert_eq!(digest(&aplist(&e, 1000)), (168, 64, 7745706942851138522), "reusable after a Stop");

    // 4. moments(2e8): the sieve alone, traced (a 100 MB sieve), then a Stop
    // early in moments' sieve and one in its loop.
    let (_, counts, gap, poll) = traced(&["ap.sieve"], || primes_up_to(200_000_000));
    eprintln!("primes_up_to(2e8): {} checks; longest gap {gap:.2} ms, poll gap {poll:.2} ms", counts[0]);
    assert!(gap < 50.0 && poll < 100.0, "sieve(2e8): gap {gap:.2} ms, poll gap {poll:.2} ms");
    let (stopped, at, ms) = stop_at(counts[0] as u64 / 2, || moments(&e, 200_000_000, 4));
    assert!(stopped && at == "ap.sieve", "moments(2e8) stopped in its sieve ({at})");
    eprintln!("moments(2e8): Stop half-way through its sieve, returned {ms:.2} ms after the request");
    assert!(ms < 2000.0, "moments(2e8): returned {ms:.0} ms after the Stop's request");
    stops_in("ap.moments", || moments(&e, 2_000_000, 4));
    assert_eq!(digest(&aplist(&e, 1000)), (168, 64, 7745706942851138522), "reusable after a Stop");
}
