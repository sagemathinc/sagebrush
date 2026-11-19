//! qpoly_mul's live memory, measured by a counting allocator: at the
//! ledger's corners within the admitted peak; a peak cap at exactly the
//! prediction admits and one byte less refuses; and the heap returns to its
//! baseline after a success and after each phase's refusal.  One test (the
//! counters are global); natively and under wasm32-wasip1.

use sagebrush_arith::{qpoly, zmul};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` with the caller's own arguments,
// so System's GlobalAlloc contract carries over; the counting only updates
// atomics.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
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

fn list(t: usize, tok: &str) -> String {
    vec![tok; t].join(",")
}

/// The call's admitted plan, from the op's own closed forms.
fn plan(a: &str, b: &str, r: u64) -> qpoly::PlanB {
    let (fa, fb) = (qpoly::scan(a).unwrap(), qpoly::scan(b).unwrap());
    let pa = qpoly::admit_a(&fa, &fb, r, &qpoly::CAPS).unwrap().unwrap();
    let l = qpoly::lcms(&fa, &fb, &pa).unwrap();
    qpoly::admit_b(&fa, &fb, &l, &pa, r, &qpoly::CAPS).unwrap()
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
fn peaks_caps_and_baselines() {
    // (a first call sets up the call's one-time state, which stays)
    // (first calls set up the call's and the NTT's one-time state, which
    // stays)
    let _ = sagebrush_web::call(r#"{"fn":"qpoly_mul","a":"1/2","b":"1/3"}"#);
    let _ = sagebrush_web::call(&format!(r#"{{"fn":"qpoly_mul","a":"{}","b":"{}"}}"#, list(1000, "1/2"), list(1000, "3")));
    let (_, again) = measure(|| sagebrush_web::call(&format!(r#"{{"fn":"qpoly_mul","a":"{}","b":"{}"}}"#, list(1000, "1/2"), list(1000, "3"))), |_| ());
    assert_eq!(again, 0, "a second call kept memory");
    let n_big = "f".repeat(4000);
    let d_big = format!("1{}", "0".repeat(999));
    // a multi-limb D with gcd 1: odd numerators over powers of 2, and over
    // odd coprime denominators
    let pow2: Vec<String> = (0..20).map(|i| format!("{:x}/{}", 2 * i + 1, format!("1{}", "0".repeat(60)))).collect();
    let odd: Vec<String> = (0..8).map(|i| format!("-{}/{:x}", "d".repeat(30), (1u64 << 63) + 2 * i + 1)).collect();
    let cases: Vec<(&str, String, String)> = vec![
        // all halves, long (phase A's 131 units per token; the NTT backend)
        ("all halves 2^17 x 2^17", list(1 << 17, "7/2"), list(1 << 17, "-5/2")),
        // integers, long
        ("integers 2^17 x 2^17", list(1 << 17, "7"), list(1 << 17, "-3")),
        // the scaling row: one token with the largest numerator and the
        // largest denominator together, among small ones
        ("n* and d* in one token", format!("{}/{},{}", n_big, d_big, list(10, "1/3")), "-5/7".to_string()),
        // the reduction row: a multi-limb D and gcd 1
        ("multi-limb D, gcd 1", pow2.join(","), odd.join(",")),
        // the schoolbook backend
        ("schoolbook 2^14 x 3", list(1 << 14, "9/4"), "1/3,-1/5,1/7".to_string()),
    ];
    for (what, a, b) in &cases {
        let req = format!(r#"{{"fn":"qpoly_mul","a":"{}","b":"{}"}}"#, a, b);
        let p = plan(a, b, req.len() as u64);
        let (peak, after) = measure(|| sagebrush_web::call(&req), |r| assert!(r.starts_with("{\"ok\":\""), "{}: {}", what, &r[..r.len().min(300)]));
        eprintln!("{}: measured {:.2} MiB, admitted {:.2} MiB ({} bytes to spare); rows {:?}", what, peak as f64 / (1 << 20) as f64, p.peak as f64 / (1 << 20) as f64, p.peak as i64 - peak as i64, p.rows);
        assert!(peak as u64 <= p.peak, "{}: {} bytes live at the peak, admitted {}", what, peak, p.peak);
        assert_eq!(after, 0, "{}: the heap did not return to its baseline", what);
    }
    // the peak cap at exactly the prediction admits; one byte less refuses
    // (before the refused phase's allocations), back at the baseline
    for (what, a, b) in &cases[2..] {
        let (fa, fb) = (qpoly::scan(a).unwrap(), qpoly::scan(b).unwrap());
        let r = (a.len() + b.len() + 32) as u64;
        let p = plan(a, b, r);
        // (phase A's own row: admitted at exactly its prediction, refused
        // at one byte less before phase A allocates anything)
        let pa = qpoly::admit_a(&fa, &fb, r, &qpoly::CAPS).unwrap().unwrap();
        let at_a = qpoly::Caps { int: zmul::Caps { peak: pa.peak, ..zmul::CAPS }, ..qpoly::CAPS };
        assert!(qpoly::admit_a(&fa, &fb, r, &at_a).unwrap().is_some());
        let less_a = qpoly::Caps { int: zmul::Caps { peak: pa.peak - 1, ..zmul::CAPS }, ..qpoly::CAPS };
        let (grew, after) = measure(|| qpoly::reply(&fa, &fb, r, &less_a), |x| assert!(x.as_ref().err().is_some_and(|e| e.contains("the memory (bytes)") && e.contains(&pa.peak.to_string())), "{}: {:?}", what, x.as_ref().map(|s| s.len())));
        assert_eq!(after, 0);
        assert!(grew < 256, "{}: phase A allocated {} bytes before its refusal", what, grew);
        let at = qpoly::Caps { int: zmul::Caps { peak: p.peak, ..zmul::CAPS }, ..qpoly::CAPS };
        let (_, after) = measure(|| qpoly::reply(&fa, &fb, r, &at), |x| assert!(x.is_ok(), "{}: {:?}", what, x.as_ref().err()));
        assert_eq!(after, 0);
        let less = qpoly::Caps { int: zmul::Caps { peak: p.peak - 1, ..zmul::CAPS }, ..qpoly::CAPS };
        let (_, after) = measure(|| qpoly::reply(&fa, &fb, r, &less), |x| assert!(x.as_ref().err().is_some_and(|e| e.contains("the memory (bytes)") && e.contains(&(p.peak - 1).to_string())), "{}: {:?}", what, x.as_ref().map(|s| s.len())));
        assert_eq!(after, 0, "{}: the heap did not return to its baseline after the refusal", what);
    }
    // each phase's refusal returns to the baseline (phase A's memory, above,
    // at its exact cap less one): phase A's metered work, phase B's output
    // bits
    let coprime = (0..12_000u64).map(|i| format!("1/{:x}", (1u64 << 62) + 2 * i + 1)).collect::<Vec<_>>().join(",");
    let big = list(4096, &format!("{}/2", "f".repeat(2000)));
    let refusals = [
        ("phase A work", format!(r#"{{"fn":"qpoly_mul","a":"{}","b":"1/3"}}"#, coprime), "the denominators' lcm needs more than"),
        ("phase B bits", format!(r#"{{"fn":"qpoly_mul","a":"{}","b":"{}"}}"#, big, big), "the product's bits"),
    ];
    for (what, req, says) in &refusals {
        let (_, after) = measure(|| sagebrush_web::call(req), |r| assert!(r.contains(says), "{}: {}", what, &r[..r.len().min(300)]));
        assert_eq!(after, 0, "{}: the heap did not return to its baseline", what);
    }
}
