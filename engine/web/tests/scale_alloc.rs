//! qpoly_scale's, qpoly_derivative's, qpoly_integral's, qpoly_add's and
//! qpoly_sub's live memory, measured by a counting allocator (one test: the
//! counters are global; natively and under wasm32-wasip1):
//! - the heap's peak during a call is within the ledger's prediction, 8
//!   (fixed rows + the ledger's high-water) bytes;
//! - the ledger's requirement admits and one word below refuses, the same on
//!   both targets (pinned constants); the meter's count likewise;
//! - writing the reply allocates nothing (emit, against its reservation);
//!   a copied reply (s = -1) allocates its reservation only;
//! - every allocation of a call, failed in turn, is the memory refusal,
//!   never an abort;
//! - the heap is back at its baseline after a success, after each refusal,
//!   after an allocation failure and after a Stop at the first and last poll
//!   of each phase.

use sagebrush_arith::coprime::Meter;
use sagebrush_arith::pscale::{self, Kind};
use sagebrush_arith::pdivrem::{DivFault, Words};
use sagebrush_arith::qpoly;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
/// fail the first allocation of at least this many bytes (0: none)
static FAIL_FROM: AtomicUsize = AtomicUsize::new(0);
/// fail the allocation whose ALLOCS count reaches this (0: none)
static FAIL_AT: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` with the caller's own arguments
// (or returns null for an allocation the test asks to fail, which the
// GlobalAlloc contract allows), so System's contract carries over; the
// counting only updates atomics.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let f = FAIL_FROM.load(Relaxed);
        if f != 0 && l.size() >= f {
            FAIL_FROM.store(0, Relaxed);
            return std::ptr::null_mut();
        }
        let n = FAIL_AT.load(Relaxed);
        if n != 0 && ALLOCS.load(Relaxed) + 1 >= n {
            FAIL_AT.store(0, Relaxed);
            return std::ptr::null_mut();
        }
        let p = System.alloc(l);
        if !p.is_null() {
            ALLOCS.fetch_add(1, Relaxed);
            let live = LIVE.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(live, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            ALLOCS.fetch_add(1, Relaxed);
            // (the old and new blocks may coexist while copying)
            PEAK.fetch_max(LIVE.load(Relaxed) + new, Relaxed);
            if new >= l.size() {
                LIVE.fetch_add(new - l.size(), Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

fn scans<'a>(kind: Kind, a: &'a str, b: &'a str) -> (qpoly::Factor<'a>, qpoly::Factor<'a>) {
    let fb = if kind == Kind::Derivative { qpoly::scan_ints(b) } else { qpoly::scan(b) };
    (qpoly::scan(a).unwrap(), fb.unwrap())
}

/// One computed call on its own ledger and meter: the reply or the fault,
/// the ledger's requirement, the fixed rows, the high-water and the units
/// used.
fn call(kind: Kind, a: &str, b: &str, limit: Option<u64>, work: Option<u64>) -> (Result<String, DivFault>, u64, u64, u64, u64) {
    let (fa, fb) = scans(kind, a, b);
    let r = (a.len() + b.len() + 40) as u64;
    let Ok(Ok(plan)) = pscale::admit(kind, &fa, &fb, r, &qpoly::CAPS) else { panic!("not computed") };
    let led = Words::new(limit.unwrap_or(plan.limit));
    let mut m = Meter::new(work.unwrap_or(plan.work));
    let out = pscale::reply_on(&fa, &fb, &plan, &led, &mut m);
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    (out, led.required(), plan.fixed, led.high(), m.used())
}

/// The call with the k-th allocation from its start failed (0: none): the
/// outcome and the allocations made.
fn call_failing(kind: Kind, a: &str, b: &str, k: usize) -> (Result<String, DivFault>, usize) {
    let (fa, fb) = scans(kind, a, b);
    let r = (a.len() + b.len() + 40) as u64;
    let Ok(Ok(plan)) = pscale::admit(kind, &fa, &fb, r, &qpoly::CAPS) else { panic!("not computed") };
    let led = Words::new(plan.limit);
    let mut m = Meter::new(plan.work);
    let b0 = ALLOCS.load(Relaxed);
    if k != 0 {
        FAIL_AT.store(b0 + k, Relaxed);
    }
    let out = pscale::reply_on(&fa, &fb, &plan, &led, &mut m);
    FAIL_AT.store(0, Relaxed);
    (out, ALLOCS.load(Relaxed) - b0)
}

/// (the growth of live memory during f, the live bytes after it less
/// before it), f's result dropped inside.
fn measure<T>(f: impl FnOnce() -> T, keep: impl FnOnce(&T)) -> (usize, isize) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let r = f();
    keep(&r);
    let peak = PEAK.load(Relaxed) - base;
    drop(r);
    (peak, LIVE.load(Relaxed) as isize - base as isize)
}

#[test]
fn scale_peaks_caps_and_baselines() {
    let rat = (0..300).map(|i| format!("{:x}{}/{:x}", (i * 7919) % 1000 + 1, "9".repeat(60), (i % 13) * 977 + 1)).collect::<Vec<_>>().join(",");
    let wide = (0..300).map(|i| format!("{:x}{}", i + 1, "f".repeat(150))).collect::<Vec<_>>().join(",");
    let small = (0..3000).map(|i| format!("{:x}/{:x}", (i * 31) % 257 + 1, i % 7 + 2)).collect::<Vec<_>>().join(",");
    let big_s = format!("-{}/{}", "7".repeat(100), "b".repeat(90));
    let x399 = (0..400).map(|i| if i == 399 { "1" } else { "0" }).collect::<Vec<_>>().join(",");
    // (kind, input, b, the ledger's requirement: the same on both targets)
    let rat2 = (0..280).map(|i| format!("{:x}{}/{:x}", (i * 104_729) % 997 + 1, "5".repeat(50), (i % 11) * 1291 + 3)).collect::<Vec<_>>().join(",");
    let cases: [(&str, Kind, &str, &str, u64); 9] = [
        ("rational coefficients by a large rational", Kind::Scale, &rat, &big_s, 16_671),
        ("wide integers by 7/3", Kind::Scale, &wide, "7/3", 10_596),
        ("a 64th derivative", Kind::Derivative, &rat, "40", 9_612),
        ("a first derivative of 3000 coefficients", Kind::Derivative, &small, "1", 17_046),
        ("x^399, its 200th derivative: the largest F_j last", Kind::Derivative, &x399, "c8", 804),
        ("an integral of 3000 coefficients", Kind::Integral, &small, "-5/7", 17_111),
        ("a sum of two rational polynomials of unequal length", Kind::Add, &rat, &rat2, 5_433),
        ("a difference of 3000-term rational polynomials", Kind::Sub, &small, &rat2, 19_728),
        ("f - f: everything cancels", Kind::Sub, &rat, &rat, 1_191),
    ];
    // (a warm-up call: the interrupt hooks' phase names are a one-time global
    // allocation)
    let _ = call(Kind::Scale, &small, "1/3", None, None);
    for (what, kind, a, b, pinned) in cases {
        let (peak, after) = measure(|| call(kind, a, b, None, None), |x| assert!(x.0.is_ok(), "{}: {:?}", what, x.0));
        let (_, need, fixed, high, used) = call(kind, a, b, None, None);
        eprintln!("{}: measured {} bytes, predicted {} (fixed {} + high-water {} words; required {}; {} units)", what, peak, 8 * (fixed + high), fixed, high, need, used);
        assert!(peak as u64 <= 8 * (fixed + high), "{}: {} > {}", what, peak, 8 * (fixed + high));
        assert_eq!(after, 0, "{}: after the call", what);
        assert_eq!(need, pinned, "{}: the requirement is target-independent", what);
        assert!(call(kind, a, b, Some(need), None).0.is_ok(), "{}", what);
        let (_, after) = measure(|| call(kind, a, b, Some(need - 1), None), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Memory, "{}", what));
        assert_eq!(after, 0, "{}: after the ledger's refusal", what);
        assert!(call(kind, a, b, None, Some(used)).0.is_ok(), "{}", what);
        let (_, after) = measure(|| call(kind, a, b, None, Some(used - 1)), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Work, "{}", what));
        assert_eq!(after, 0, "{}: after the meter's refusal", what);
    }

    // the reply is written without allocating: emit against its reservation,
    // with a sign, a denominator, a zero and an integral coefficient
    {
        let (fa, fb) = scans(Kind::Scale, "3,0,-4/5,10", "5/6");
        let Ok(Ok(plan)) = pscale::admit(Kind::Scale, &fa, &fb, 64, &qpoly::CAPS) else { panic!() };
        let led = Words::new(plan.limit);
        let mut m = Meter::new(plan.work);
        let mp = pscale::compute(&fa, &fb, &plan, &led, &mut m).unwrap();
        let bytes = pscale::reply_bytes(&mp).unwrap() as usize;
        let mut out = String::with_capacity(bytes);
        let before = ALLOCS.load(Relaxed);
        pscale::emit(&mp, &mut out, &mut m).unwrap();
        assert_eq!(ALLOCS.load(Relaxed), before, "emit allocated");
        assert_eq!(out, "{\"ok\":\"5/2,0,-2/3,28/3\"}");
        assert_eq!((out.len(), out.capacity()), (bytes, bytes), "the reply fills its reservation exactly");
    }
    // a trimmed reply (the top coefficients cancel) is written without
    // allocating too, filling its exact reservation
    {
        let (fa, fb) = scans(Kind::Sub, "1,0,3,4,5,6", "0,0,2,4,5,6");
        let Ok(Ok(plan)) = pscale::admit(Kind::Sub, &fa, &fb, 64, &qpoly::CAPS) else { panic!() };
        let led = Words::new(plan.limit);
        let mut m = Meter::new(plan.work);
        let mp = pscale::compute(&fa, &fb, &plan, &led, &mut m).unwrap();
        let bytes = pscale::reply_bytes(&mp).unwrap() as usize;
        let mut out = String::with_capacity(bytes);
        let before = ALLOCS.load(Relaxed);
        pscale::emit(&mp, &mut out, &mut m).unwrap();
        assert_eq!(ALLOCS.load(Relaxed), before, "a trimmed emit allocated");
        assert_eq!(out, "{\"ok\":\"1,0,1\"}");
        assert_eq!((out.len(), out.capacity()), (bytes, bytes), "the trimmed reply fills its reservation exactly");
    }
    // a copied reply (s = -1): one allocation, its exact reservation
    {
        let (fa, fb) = scans(Kind::Scale, "3,0,-4/5,10", "-1");
        let before = ALLOCS.load(Relaxed);
        let out = pscale::reply(Kind::Scale, &fa, &fb, 64, &qpoly::CAPS).unwrap();
        assert_eq!(ALLOCS.load(Relaxed) - before, 1, "the copy allocated more than its reply");
        assert_eq!(out, "{\"ok\":\"-3,0,4/5,-10\"}");
        assert_eq!(out.len(), out.capacity());
    }

    // every allocation of a call, failed in turn, is the memory refusal
    // (never an abort), and the heap is back at its baseline
    for (kind, a, b) in [(Kind::Scale, "1/2,3,-5/7,1,0,2/9,1", "-6/35"), (Kind::Derivative, "1/2,3,-5/7,1,0,2/9,1", "3"), (Kind::Integral, "1/2,3,-5/7,1,0,2/9,1", "4/3"), (Kind::Add, "1/2,3,-5/7,1,0,2/9,1", "1/6,-3,5/14,2/3"), (Kind::Sub, "1/2,3,-5/7", "1/2,3,-5/7,0,1/9")] {
        let k_total = {
            let (o, n) = call_failing(kind, a, b, 0);
            o.unwrap();
            n
        };
        assert!(k_total > 10, "{:?}: only {} allocations", kind, k_total);
        for k in 1..=k_total {
            let (_, after) = measure(|| call_failing(kind, a, b, k).0, |x| assert_eq!(x.as_ref().unwrap_err(), &DivFault::Memory, "{:?}: allocation {} of {}", kind, k, k_total));
            assert_eq!(after, 0, "{:?}: after failing allocation {} of {}", kind, k, k_total);
        }
        eprintln!("{:?}: each of {} allocations failed in turn: the memory refusal, at the baseline", kind, k_total);
    }

    // a Stop at the first and the last poll of each phase: back at the
    // baseline (a warm-up Stop first, for the unwinder's own allocations)
    #[cfg(panic = "unwind")]
    {
        use sagebrush_interrupt::hooks;
        let long = (0..100_000).map(|i| format!("{:x}/{:x}", i * 7 + 1, i % 97 + 2)).collect::<Vec<_>>().join(",");
        let mut first = true;
        let long_b = (0..100_000).map(|i| format!("{:x}/{:x}", i * 5 + 3, i % 89 + 3)).collect::<Vec<_>>().join(",");
        for (kind, b) in [(Kind::Scale, "-15/22"), (Kind::Derivative, "3"), (Kind::Integral, "1/2"), (Kind::Add, long_b.as_str()), (Kind::Sub, long_b.as_str())] {
            hooks::reset();
            hooks::trace();
            let _ = call(kind, &long, b, None, None);
            let phases: Vec<(&str, Vec<u64>)> = ["scale compute", "scale trim", "scale emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
            hooks::reset();
            for (phase, idx) in &phases {
                assert!(!idx.is_empty(), "no poll in {}", phase);
                for at in [idx[0], *idx.last().unwrap()] {
                    for _ in 0..if first { 2 } else { 1 } {
                        hooks::reset();
                        hooks::arm_at(at);
                        let (_, after) = measure(|| sagebrush_interrupt::catch(|| call(kind, &long, b, None, None)), |x| assert!(x.is_err(), "no Stop at poll {} ({})", at, phase));
                        hooks::reset();
                        sagebrush_interrupt::clear();
                        assert!(first || after == 0, "{:?} {}: {} bytes after a Stop at poll {}", kind, phase, after, at);
                        first = false;
                    }
                }
            }
        }
    }
}
