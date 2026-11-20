//! qpoly_eval's live memory after the lcm phase, measured by a counting
//! allocator (one test: the counters are global; natively and under
//! wasm32-wasip1):
//! - the heap's peak during Horner and the reply is within the ledger's
//!   prediction, 8 (fixed rows + the ledger's high-water) bytes;
//! - the ledger's requirement admits and one word below refuses, the same on
//!   both targets (pinned constants); the meter's count likewise;
//! - writing the reply allocates nothing (emit, against its reservation);
//! - every allocation after the lcm, failed in turn, is the memory refusal,
//!   never an abort;
//! - the heap is back at its baseline after a success, after each refusal,
//!   after an allocation failure and after a Stop at the first and last poll
//!   of each phase.

use sagebrush_arith::coprime::Meter;
use sagebrush_arith::pdivrem::{DivFault, Words};
use sagebrush_arith::{peval, qpoly};
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

/// The lcm phase on the call's meter, then the rest on its own ledger: the
/// reply or the fault, the ledger's requirement, the fixed rows, the
/// high-water and the units used (the lcm's included).
fn call(a: &str, v: &str, limit: Option<u64>, work: Option<u64>) -> (Result<String, DivFault>, u64, u64, u64, u64) {
    let (fa, fv) = (qpoly::scan(a).unwrap(), qpoly::scan(v).unwrap());
    let r = (a.len() + v.len() + 40) as u64;
    let Ok(Ok(plan)) = peval::admit(&fa, &fv, r, &qpoly::CAPS) else { panic!("not computed") };
    let mut m = Meter::new(work.unwrap_or(plan.work));
    let d = peval::clear(&fa, &plan, &mut m).unwrap();
    let (bound, fixed, lim) = peval::admit_b(&fa, &fv, &d, &plan, r, &qpoly::CAPS).unwrap();
    let led = Words::new(limit.unwrap_or(lim));
    let out = peval::reply_on(&fa, &fv, &d, &plan, bound, &led, &mut m);
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    (out, led.required(), fixed, led.high(), m.used())
}

/// The call with the k-th allocation after the lcm failed (0: none): the
/// outcome and the allocations made after the lcm.
fn call_failing(a: &str, v: &str, k: usize) -> (Result<String, DivFault>, usize) {
    let (fa, fv) = (qpoly::scan(a).unwrap(), qpoly::scan(v).unwrap());
    let r = (a.len() + v.len() + 40) as u64;
    let Ok(Ok(plan)) = peval::admit(&fa, &fv, r, &qpoly::CAPS) else { panic!("not computed") };
    let mut m = Meter::new(plan.work);
    let d = peval::clear(&fa, &plan, &mut m).unwrap();
    let (bound, _, lim) = peval::admit_b(&fa, &fv, &d, &plan, r, &qpoly::CAPS).unwrap();
    let led = Words::new(lim);
    let b0 = ALLOCS.load(Relaxed);
    if k != 0 {
        FAIL_AT.store(b0 + k, Relaxed);
    }
    let out = peval::reply_on(&fa, &fv, &d, &plan, bound, &led, &mut m);
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
fn eval_peaks_caps_and_baselines() {
    let harmonic = (0..400).map(|i| format!("1/{:x}", i + 1)).collect::<Vec<_>>().join(",");
    let wide = (0..300).map(|i| format!("{:x}{}", i + 1, "f".repeat(150))).collect::<Vec<_>>().join(",");
    let rat = (0..300).map(|i| format!("{:x}{}/{:x}", (i * 7919) % 1000 + 1, "9".repeat(60), (i % 13) * 977 + 1)).collect::<Vec<_>>().join(",");
    let zeros = format!("1/3,-2/5{}", ",0".repeat(5000));
    let big_v = format!("-{}/{}", "e7".repeat(40), "9".repeat(70));
    // (a, v, the ledger's requirement: the same on both targets)
    let cases: [(&str, &str, &str, u64); 6] = [
        ("a_i = 1/(i+1) at -7/3", &harmonic, "-7/3", 280),
        ("a_i = 1/(i+1) at a multi-limb point", &harmonic, &big_v, 23_106),
        ("wide integers at an integer (q = 1)", &wide, "-123456789abcdef0123", 1_553),
        ("rational coefficients at 3/4", &rat, "3/4", 191),
        ("trailing zeros stepped over", &zeros, "b/2", 22),
        ("a cancellation to zero: 2 - 6x at 1/3", "2,-6", "1/3", 13),
    ];
    // (a warm-up call: the interrupt hooks' phase names are a one-time global
    // allocation)
    let _ = call(&rat, "1/3", None, None);
    for (what, a, v, pinned) in cases {
        let (peak, after) = measure(|| call(a, v, None, None), |x| assert!(x.0.is_ok(), "{}: {:?}", what, x.0));
        let (_, need, fixed, high, used) = call(a, v, None, None);
        eprintln!("{}: measured {} bytes, predicted {} (fixed {} + high-water {} words; required {}; {} units)", what, peak, 8 * (fixed + high), fixed, high, need, used);
        assert!(peak as u64 <= 8 * (fixed + high), "{}: {} > {}", what, peak, 8 * (fixed + high));
        assert_eq!(after, 0, "{}: after the call", what);
        assert_eq!(need, pinned, "{}: the requirement is target-independent", what);
        assert!(call(a, v, Some(need), None).0.is_ok(), "{}", what);
        let (_, after) = measure(|| call(a, v, Some(need - 1), None), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Memory, "{}", what));
        assert_eq!(after, 0, "{}: after the ledger's refusal", what);
        assert!(call(a, v, None, Some(used)).0.is_ok(), "{}", what);
        let (_, after) = measure(|| call(a, v, None, Some(used - 1)), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Work, "{}", what));
        assert_eq!(after, 0, "{}: after the meter's refusal", what);
    }

    // the reply is written without allocating beyond its exact reservation:
    // one allocation of exactly the reply's bytes once Horner is done
    {
        let before = ALLOCS.load(Relaxed);
        let (out, _, _, _, _) = call("1,0,1", "-1/3", None, None);
        let out = out.unwrap();
        assert!(ALLOCS.load(Relaxed) > before);
        assert_eq!(out, "{\"ok\":\"a/9\"}");
        assert_eq!(out.len(), out.capacity(), "the reply fills its reservation exactly");
    }

    // every allocation after the lcm, failed in turn, is the memory refusal
    // (never an abort), and the heap is back at its baseline
    for (a, v) in [("1/2,3,-5/7,1,0,2/9,1", "-6/35"), ("1,2,3", "1/3"), ("4,-1,7,0,0", "5")] {
        let k_total = {
            let (o, n) = call_failing(a, v, 0);
            o.unwrap();
            n
        };
        assert!(k_total > 10, "{}: only {} allocations", a, k_total);
        for k in 1..=k_total {
            let (_, after) = measure(|| call_failing(a, v, k).0, |x| assert_eq!(x.as_ref().unwrap_err(), &DivFault::Memory, "{}: allocation {} of {}", a, k, k_total));
            assert_eq!(after, 0, "{}: after failing allocation {} of {}", a, k, k_total);
        }
        eprintln!("{} at {}: each of {} allocations failed in turn: the memory refusal, at the baseline", a, v, k_total);
    }

    // a Stop at the first and the last poll of each phase: back at the
    // baseline (a warm-up Stop first, for the unwinder's own allocations)
    #[cfg(panic = "unwind")]
    {
        use sagebrush_interrupt::hooks;
        let long = (0..1500).map(|i| format!("1/{:x}", i + 1)).collect::<Vec<_>>().join(",");
        let mut first = true;
        hooks::reset();
        hooks::trace();
        let _ = call(&long, "-7/3", None, None);
        let phases: Vec<(&str, Vec<u64>)> = ["eval clear", "eval horner", "eval emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
        hooks::reset();
        for (phase, idx) in &phases {
            assert!(!idx.is_empty(), "no poll in {}", phase);
            for at in [idx[0], *idx.last().unwrap()] {
                for _ in 0..if first { 2 } else { 1 } {
                    hooks::reset();
                    hooks::arm_at(at);
                    let (_, after) = measure(|| sagebrush_interrupt::catch(|| call(&long, "-7/3", None, None)), |x| assert!(x.is_err(), "no Stop at poll {} ({})", at, phase));
                    hooks::reset();
                    sagebrush_interrupt::clear();
                    assert!(first || after == 0, "{}: {} bytes after a Stop at poll {}", phase, after, at);
                    first = false;
                }
            }
        }
    }
}
