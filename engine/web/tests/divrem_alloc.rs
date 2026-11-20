//! zpoly_divrem's live memory, measured by a counting allocator (one test:
//! the counters are global; natively and under wasm32-wasip1):
//! - the heap's peak during a call is within the ledger's prediction, 8
//!   (fixed rows + the ledger's high-water) bytes;
//! - the ledger's high-water admits and one word below refuses, with the
//!   same high-water on both targets (pinned constants: E1);
//! - writing the reply allocates nothing (emit, against its reservation);
//! - the heap is back at its baseline after a success, after the ledger's
//!   refusal, after the meter's, after an allocation failure and after a
//!   Stop at the first and last poll of each phase.

use sagebrush_arith::coprime::Meter;
use sagebrush_arith::pdivrem::{self, DivFault, Words};
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

/// One call on its own ledger and meter: the reply or the fault, the
/// ledger's high-water, the fixed rows and the units used.
fn call(a: &str, b: &str, limit: Option<u64>, work: Option<u64>) -> (Result<String, DivFault>, u64, u64, u64) {
    let (fa, fb) = (qpoly::scan_ints(a).unwrap(), qpoly::scan_ints(b).unwrap());
    let r = (a.len() + b.len() + 20) as u64;
    let Ok(Ok(plan)) = pdivrem::admit_z(&fa, &fb, r, &qpoly::CAPS) else { panic!("not a division") };
    let led = Words::new(limit.unwrap_or(plan.limit));
    let mut m = Meter::new(work.unwrap_or(plan.work));
    let out = pdivrem::reply_z_on(&fa, &fb, &plan, &led, &mut m);
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    (out, led.high(), plan.fixed, m.used())
}

/// One Q call on its own ledger (phase A on the call's meter): the reply or
/// the fault, the ledger's requirement (its high-water less d_b's words,
/// credited after Q1), the fixed rows, the high-water, and the units used.
fn qcall(a: &str, b: &str, limit: Option<u64>, work: Option<u64>) -> (Result<String, DivFault>, u64, u64, u64, u64) {
    let (fa, fb) = (qpoly::scan(a).unwrap(), qpoly::scan(b).unwrap());
    let r = (a.len() + b.len() + 20) as u64;
    let pa = qpoly::admit_a(&fa, &fb, r, &pdivrem::DIVREM_Q_CAPS).unwrap().unwrap();
    let mut m = Meter::new(work.unwrap_or(pa.limit));
    let l = pdivrem::clear_q(&fa, &fb, &pa, &mut m).unwrap();
    let (n, mm) = (pdivrem::norm_len(&fa) - 1, pdivrem::norm_len(&fb) - 1);
    let fixed = pdivrem::fixed_rows_q(&fb, mm, r, &pa, l.nb as u64).unwrap();
    let plan = pdivrem::Plan { n, m: mm, k: if n >= mm { n - mm + 1 } else { 0 }, fixed, limit: pdivrem::DIVREM_Q_CAPS.int.peak / 8 - fixed, work: pa.limit };
    let led = Words::new(limit.unwrap_or(plan.limit));
    let out = pdivrem::reply_q_on(&fa, &fb, &plan, &pa, l, &led, &mut m);
    assert_eq!(led.live(), 0, "the ledger holds words after the call");
    (out, led.required(), fixed, led.high(), m.used())
}

/// Q's division after phase A, with the k-th allocation from there failed
/// (0: none): the outcome (the call must refuse, never abort).
fn qcall_failing(a: &str, b: &str, k: usize) -> (Result<String, DivFault>, usize) {
    let (fa, fb) = (qpoly::scan(a).unwrap(), qpoly::scan(b).unwrap());
    let r = (a.len() + b.len() + 20) as u64;
    let pa = qpoly::admit_a(&fa, &fb, r, &pdivrem::DIVREM_Q_CAPS).unwrap().unwrap();
    let mut m = Meter::new(pa.limit);
    let l = pdivrem::clear_q(&fa, &fb, &pa, &mut m).unwrap();
    let (n, mm) = (pdivrem::norm_len(&fa) - 1, pdivrem::norm_len(&fb) - 1);
    let fixed = pdivrem::fixed_rows_q(&fb, mm, r, &pa, l.nb as u64).unwrap();
    let plan = pdivrem::Plan { n, m: mm, k: if n >= mm { n - mm + 1 } else { 0 }, fixed, limit: pdivrem::DIVREM_Q_CAPS.int.peak / 8 - fixed, work: pa.limit };
    let led = Words::new(plan.limit);
    let b0 = ALLOCS.load(Relaxed);
    if k != 0 {
        FAIL_AT.store(b0 + k, Relaxed);
    }
    let out = pdivrem::reply_q_on(&fa, &fb, &plan, &pa, l, &led, &mut m);
    FAIL_AT.store(0, Relaxed);
    (out, ALLOCS.load(Relaxed) - b0)
}

/// Z's division with the k-th allocation from its start failed.
fn zcall_failing(a: &str, b: &str, k: usize) -> (Result<String, DivFault>, usize) {
    let (fa, fb) = (qpoly::scan_ints(a).unwrap(), qpoly::scan_ints(b).unwrap());
    let r = (a.len() + b.len() + 20) as u64;
    let Ok(Ok(plan)) = pdivrem::admit_z(&fa, &fb, r, &qpoly::CAPS) else { panic!("not a division") };
    let led = Words::new(plan.limit);
    let mut m = Meter::new(plan.work);
    let b0 = ALLOCS.load(Relaxed);
    if k != 0 {
        FAIL_AT.store(b0 + k, Relaxed);
    }
    let out = pdivrem::reply_z_on(&fa, &fb, &plan, &led, &mut m);
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

fn power_less_one(n: usize) -> String {
    let mut a = vec!["0"; n + 1];
    a[0] = "-1";
    a[n] = "1";
    a.join(",")
}

#[test]
fn divrem_peaks_caps_and_baselines() {
    let long = (0..=3000).map(|i| format!("{:x}", (i * 7919) % 97 + 1)).collect::<Vec<_>>().join(",");
    let wide = (0..300).map(|i| format!("{:x}{}", i + 1, "f".repeat(150))).collect::<Vec<_>>().join(",");
    let grow = {
        let mut a = vec!["0"; 501];
        a[500] = "1";
        a.join(",")
    };
    let p20k = power_less_one(20_000);
    // (input, divisor, the ledger's high-water: the same on both targets)
    let cases: [(&str, &str, &str, u64); 5] = [
        ("(t^20000 - 1) / (t - 1)", &p20k, "-1,1", 100_148),
        ("a long quotient of small coefficients", &long, "1,1", 13_200),
        ("wide coefficients by a constant", &wide, "3", 10_481),
        ("x^500 / (x - (2^63 - 1))", &grow, "-7fffffffffffffff,1", 426_103),
        ("a 3-term divisor", &long, "3,-5,7", 16_799),
    ];
    // (a warm-up call: the interrupt hooks' phase names are a one-time global
    // allocation)
    let _ = call(&long, "1,1", None, None);
    for (what, a, b, pinned) in cases {
        // the call within the ledger's prediction, and back at the baseline
        let (peak, after) = measure(|| call(a, b, None, None), |x| assert!(x.0.is_ok(), "{}: {:?}", what, x.0));
        let (_, high, fixed, used) = call(a, b, None, None);
        eprintln!("{}: measured {} bytes, predicted {} (fixed {} + high-water {} words)", what, peak, 8 * (fixed + high), fixed, high);
        assert!(peak as u64 <= 8 * (fixed + high), "{}: {} > {}", what, peak, 8 * (fixed + high));
        assert_eq!(after, 0, "{}: after the call", what);
        assert_eq!(high, pinned, "{}: the high-water is target-independent", what);
        // the high-water admits; one word below refuses, back at the baseline
        assert!(call(a, b, Some(high), None).0.is_ok(), "{}", what);
        let (_, after) = measure(|| call(a, b, Some(high - 1), None), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Memory, "{}", what));
        assert_eq!(after, 0, "{}: after the ledger's refusal", what);
        // the meter at exactly its count admits; one unit less refuses
        assert!(call(a, b, None, Some(used)).0.is_ok(), "{}", what);
        let (_, after) = measure(|| call(a, b, None, Some(used - 1)), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Work, "{}", what));
        assert_eq!(after, 0, "{}: after the meter's refusal", what);
    }

    // Q: (the phase A row is closed form and freed before the ledger's
    // first reservation; the ledger's part is measured here)
    let qa = (0..1500).map(|i| format!("{:x}/{:x}", (i * 7919) % 1000 + 1, (i % 13) + 1)).collect::<Vec<_>>().join(",");
    let qb = format!("{}/3,-{}/5,{}/7", "6".repeat(40), "c".repeat(40), "12".repeat(20));
    let mut half = vec!["0"; 20_001];
    half[0] = "-1";
    half[20_000] = "1";
    let half = half.join(",");
    // (large coefficients and few steps, where a step's temporaries are a
    // large share: four 20,000-hex-digit coefficients over 7 by a large linear
    // divisor; and a large T, a non-monic divisor whose powers of c stay in
    // the denominators)
    let big = "f".repeat(20_000);
    let wide4 = vec![format!("{}/7", big); 4].join(",");
    let wideb = format!("5,{}", "e".repeat(20_000));
    let tall = vec!["1"; 41].join(",");
    let tallb = format!("1,{}", "7".repeat(400));
    let qcases: [(&str, &str, &str, u64); 5] = [
        ("Q1 with content and coprime denominators", &qa, &qb, 654_979),
        ("(t^20000 - 1) / (2t - 2)", &half, "-2,2", 127_472),
        ("a constant -2/3", &qa, "-2/3", 7_610),
        ("four 20,000-digit coefficients over 7 / a large linear divisor", &wide4, &wideb, 62_834),
        ("a large T: 40 steps by a 400-digit leading coefficient", &tall, &tallb, 129_308),
    ];
    // (a warm-up: Q's phase names are registered once)
    let _ = qcall(&qa, "-2/3", None, None);
    for (what, a, b, pinned) in qcases {
        let (peak, after) = measure(|| qcall(a, b, None, None), |x| assert!(x.0.is_ok(), "{}: {:?}", what, x.0));
        let (_, need, fixed, high, used) = qcall(a, b, None, None);
        eprintln!("{}: measured {} bytes, predicted {} (fixed {} + high-water {} words; required {})", what, peak, 8 * (fixed + high), fixed, high, need);
        assert!(peak as u64 <= 8 * (fixed + high), "{}: {} > {}", what, peak, 8 * (fixed + high));
        assert_eq!(after, 0, "{}: after the call", what);
        assert_eq!(need, pinned, "{}: the requirement is target-independent", what);
        assert!(qcall(a, b, Some(need), None).0.is_ok(), "{}", what);
        let (_, after) = measure(|| qcall(a, b, Some(need - 1), None), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Memory, "{}", what));
        assert_eq!(after, 0, "{}: after the ledger's refusal", what);
        let (_, after) = measure(|| qcall(a, b, None, Some(used - 1)), |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Work, "{}", what));
        assert_eq!(after, 0, "{}: after the meter's refusal", what);
    }
    let (_, after) = measure(
        || {
            FAIL_FROM.store(100_000, Relaxed);
            let x = qcall(&half, "-2,2", None, None);
            FAIL_FROM.store(0, Relaxed);
            x
        },
        |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Memory),
    );
    assert_eq!(after, 0, "Q: after an allocation failure");

    // the reply is written without allocating: emit against its reservation
    {
        let (fa, fb) = (qpoly::scan_ints(&long).unwrap(), qpoly::scan_ints("3,-5,7").unwrap());
        let Ok(Ok(plan)) = pdivrem::admit_z(&fa, &fb, 64, &qpoly::CAPS) else { panic!() };
        let led = Words::new(plan.limit);
        let mut m = Meter::new(plan.work);
        let dv = pdivrem::divide_z(&fa, &fb, &plan, &led, &mut m).unwrap();
        let bytes = pdivrem::reply_bytes(&dv).unwrap() as usize;
        let mut out = String::with_capacity(bytes);
        let before = ALLOCS.load(Relaxed);
        pdivrem::emit(&dv, &mut out, &mut m).unwrap();
        assert_eq!(ALLOCS.load(Relaxed), before, "emit allocated");
        assert_eq!((out.len(), out.capacity()), (bytes, bytes), "the reply fills its reservation exactly");
    }

    // Q's reply is written without allocating too: emit against its
    // reservation, with non-unit denominators in q and in r
    {
        let (fa, fb) = (qpoly::scan("1,0,0,1").unwrap(), qpoly::scan("1,2").unwrap());
        let pa = qpoly::admit_a(&fa, &fb, 64, &pdivrem::DIVREM_Q_CAPS).unwrap().unwrap();
        let mut m = Meter::new(pa.limit);
        let l = pdivrem::clear_q(&fa, &fb, &pa, &mut m).unwrap();
        let fixed = pdivrem::fixed_rows_q(&fb, 1, 64, &pa, l.nb as u64).unwrap();
        let plan = pdivrem::Plan { n: 3, m: 1, k: 3, fixed, limit: pdivrem::DIVREM_Q_CAPS.int.peak / 8 - fixed, work: pa.limit };
        let led = Words::new(plan.limit);
        let dv = pdivrem::divide_q(&fa, &fb, &plan, &pa, l, &led, &mut m).unwrap();
        let bytes = pdivrem::reply_bytes(&dv).unwrap() as usize;
        let mut out = String::with_capacity(bytes);
        let before = ALLOCS.load(Relaxed);
        pdivrem::emit(&dv, &mut out, &mut m).unwrap();
        assert_eq!(ALLOCS.load(Relaxed), before, "Q's emit allocated");
        assert_eq!(out, "{\"ok\":{\"q\":\"1/8,-1/4,1/2\",\"r\":\"7/8\"}}");
        assert_eq!((out.len(), out.capacity()), (bytes, bytes), "Q's reply fills its reservation exactly");
    }

    // every allocation of a division, failed in turn, is the memory refusal
    // (never an abort), and the heap is back at its baseline: Q after phase
    // A, on a divisor with content and a non-monic primitive part, and Z
    for (what, k_total, run) in [
        ("Q", { let (o, n) = qcall_failing("1/2,3,-5/7,1,0,2/9,1", "6,-4,10/3", 0); o.unwrap(); n }, 0),
        ("Z", { let (o, n) = zcall_failing("7,-3,5,1,0,2,9,4", "3,-5,7", 0); o.unwrap(); n }, 1),
    ] {
        assert!(k_total > 10, "{}: only {} allocations", what, k_total);
        for k in 1..=k_total {
            let (_, after) = measure(
                || if run == 0 { qcall_failing("1/2,3,-5/7,1,0,2/9,1", "6,-4,10/3", k).0 } else { zcall_failing("7,-3,5,1,0,2,9,4", "3,-5,7", k).0 },
                |x| assert_eq!(x.as_ref().unwrap_err(), &DivFault::Memory, "{}: allocation {} of {}", what, k, k_total),
            );
            assert_eq!(after, 0, "{}: after failing allocation {} of {}", what, k, k_total);
        }
        eprintln!("{}: each of {} allocations failed in turn: the memory refusal, at the baseline", what, k_total);
    }

    // an allocation failure (the first block of at least 100 KB: an arena's
    // growth) is the memory refusal, and the heap is back at its baseline
    let (_, after) = measure(
        || {
            FAIL_FROM.store(100_000, Relaxed);
            let x = call(&p20k, "-1,1", None, None);
            FAIL_FROM.store(0, Relaxed);
            x
        },
        |x| assert_eq!(x.0.as_ref().unwrap_err(), &DivFault::Memory),
    );
    assert_eq!(after, 0, "after an allocation failure");

    // a Stop at the first and the last poll of each phase: back at the
    // baseline (a warm-up Stop first, for the unwinder's own allocations)
    #[cfg(panic = "unwind")]
    {
        use sagebrush_interrupt::hooks;
        hooks::reset();
        hooks::trace();
        let _ = call(&p20k, "1,1,1", None, None);
        let phases: Vec<(&str, Vec<u64>)> = ["divrem load", "divrem divide", "divrem emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
        hooks::reset();
        let mut first = true;
        for (phase, idx) in &phases {
            assert!(!idx.is_empty(), "no poll in {}", phase);
            for at in [idx[0], *idx.last().unwrap()] {
                for _ in 0..if first { 2 } else { 1 } {
                    hooks::reset();
                    hooks::arm_at(at);
                    let (_, after) = measure(|| sagebrush_interrupt::catch(|| call(&p20k, "1,1,1", None, None)), |x| assert!(x.is_err(), "no Stop at poll {} ({})", at, phase));
                    hooks::reset();
                    sagebrush_interrupt::clear();
                    assert!(first || after == 0, "{}: {} bytes after a Stop at poll {}", phase, after, at);
                    first = false;
                }
            }
        }
        // Q: each of its four phases
        hooks::reset();
        hooks::trace();
        let _ = qcall(&qa, &qb, None, None);
        let phases: Vec<(&str, Vec<u64>)> = ["divrem clear", "divrem load", "divrem divide", "divrem emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
        hooks::reset();
        for (phase, idx) in &phases {
            assert!(!idx.is_empty(), "Q: no poll in {}", phase);
            for at in [idx[0], *idx.last().unwrap()] {
                hooks::reset();
                hooks::arm_at(at);
                let (_, after) = measure(|| sagebrush_interrupt::catch(|| qcall(&qa, &qb, None, None)), |x| assert!(x.is_err(), "Q: no Stop at poll {} ({})", at, phase));
                hooks::reset();
                sagebrush_interrupt::clear();
                assert_eq!(after, 0, "Q {}: {} bytes after a Stop at poll {}", phase, after, at);
            }
        }
    }
}
