//! Stop during the a_p kernels (the interrupt crate's test hooks: every check
//! counted per phase, Stop requested at a chosen one): the sieve, aplist,
//! aplist_many and moments stop in the phase asked, promptly, and the next
//! call works; with no Stop the results are unchanged.  One test: the hooks
//! and the request flag are process-wide.

use sagebrush_ap::{aplist, aplist_many, moments, primes_up_to, EllipticCurve};
use sagebrush_interrupt::{catch, hooks};

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

/// Call f with a Stop armed at check `at` (1-based, since the last reset):
/// (stopped?, the phase it stopped in).  How soon a Stop is seen is pinned by
/// the traced runs' gap bounds, not by wall time here.
fn stop_at<T>(at: u64, f: impl Fn() -> T) -> (bool, &'static str) {
    hooks::reset();
    hooks::arm_at(at);
    let r = catch(&f);
    let phase = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    (r.is_err(), phase)
}

/// Stop at the median check of `phase` (from a traced run): f must stop in
/// that phase.
fn stops_in<T>(phase: &str, f: impl Fn() -> T) {
    hooks::reset();
    hooks::trace();
    let _ = f();
    let idx = hooks::traced(phase);
    hooks::reset();
    assert!(!idx.is_empty(), "{phase}: no checks");
    let (stopped, at) = stop_at(idx[idx.len() / 2], &f);
    assert!(stopped, "{phase}: not stopped");
    assert_eq!(at, phase, "stopped in the phase asked");
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
    // Exact, and deterministic (the sieve runs on one thread): from n and
    // SIEVE_BLOCK = 2^16 alone, as engine/web/tests/wasm_designated.mjs derives
    // its 2e6 count: 2 around the allocation, one per block of each marking pass,
    // and ceil(half / 2^16) for the collection.  A dropped or thinned check
    // changes it; a deliberate retune updates it.
    assert_eq!(counts[0], 957, "the sieve's checks for n = 2e7");
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
    assert_eq!(counts[0], 5763, "the sieve's checks for n = 2e8 (derived as for 2e7)");
    assert!(gap < 50.0 && poll < 100.0, "sieve(2e8): gap {gap:.2} ms, poll gap {poll:.2} ms");
    let (stopped, at) = stop_at(counts[0] as u64 / 2, || moments(&e, 200_000_000, 4));
    assert!(stopped && at == "ap.sieve", "moments(2e8) stopped in its sieve ({at})");
    stops_in("ap.moments", || moments(&e, 2_000_000, 4));
    assert_eq!(digest(&aplist(&e, 1000)), (168, 64, 7745706942851138522), "reusable after a Stop");
}
