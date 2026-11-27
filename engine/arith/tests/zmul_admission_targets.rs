//! poly_mul's admission is the same on every target: the admitted work, peak
//! and backend of each shape below are pinned, so this test passes natively
//! and under wasm32-wasip1 only if both compute the same.  The shapes cross
//! transform-size transitions, the schoolbook threshold and the largest
//! corner; at each, caps at exactly the admitted work and peak admit, and one
//! less refuses, naming the cap, with the heap back at its baseline (a
//! counting allocator).

use sagebrush_arith::zmul::{self, Caps, CAPS};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` with the caller's own arguments,
// so System's GlobalAlloc contract carries over; the counting only updates
// an atomic.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Relaxed);
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

fn list(n: usize, tok: &str) -> String {
    vec![tok; n].join(",")
}

/// (la, a's token, lb, b's token) -> (work, peak, schoolbook), pinned.
const PINNED: &[((usize, &str, usize, &str), (u64, u64, bool))] = &[
    ((1, "f", 1, "f"), (102, 1048763, true)),
    ((3, "ff", 3, "-ff"), (232, 1048810, true)),
    ((100, "f", 100, "f"), (6816, 1050764, true)),
    ((105, "9999999999999999", 262144, "7"), (52023197, 9606203, true)),
    ((1557, "f", 1557, "f"), (237924, 1136742, false)),
    ((1558, "f", 1558, "f"), (371660, 1202314, false)),
    ((20968, "f", 20968, "f"), (3854732, 2443186, false)),
    ((20969, "f", 20969, "f"), (6287860, 3491798, false)),
    ((289260, "f", 289260, "f"), (63779436, 23439298, false)),
    ((289261, "f", 289261, "f"), (107426516, 41265128, false)),
    ((524288, "f", 524288, "-f"), (127141628, 46628916, false)),
    ((4096, "9999999999999999", 4, "f"), (331281, 1237806, true)),
];

/// The transform's points for an l x l product of one-digit tokens.
fn points(l: usize) -> u64 {
    let a = list(l, "f");
    let c = zmul::scan(&a).unwrap();
    let plan = zmul::admit(&c, &c, 2 * a.len() as u64 + 20, &Caps { n: u64::MAX, o: u64::MAX, peak: u64::MAX, work: u64::MAX, ..CAPS }).unwrap().unwrap();
    ((plan.wa + plan.wb - 1) as u64).next_power_of_two()
}

fn shapes() -> Vec<(usize, &'static str, usize, &'static str)> {
    let mut v = vec![(1, "f", 1, "f"), (3, "ff", 3, "-ff"), (100, "f", 100, "f"), (105, "9999999999999999", 1 << 18, "7")];
    // (transform transitions: the longest l x l one-digit product at 2^k
    // points, and the next, at 2^(k + 1))
    for k in [10u32, 14, 18] {
        let (mut lo, mut hi) = (1usize, 1 << 20);
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if points(mid) <= 1 << k {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        assert!(points(lo) == 1 << k && points(lo + 1) == 2 << k);
        v.push((lo, "f", lo, "f"));
        v.push((lo + 1, "f", lo + 1, "f"));
    }
    v.push((1 << 19, "f", 1 << 19, "-f"));
    v.push((1 << 12, "9999999999999999", 4, "f"));
    v
}

#[test]
fn admission_is_pinned_and_exact_at_its_caps() {
    let mut got = Vec::new();
    for (la, ta, lb, tb) in shapes() {
        let (a, b) = (list(la, ta), list(lb, tb));
        let (ca, cb) = (zmul::scan(&a).unwrap(), zmul::scan(&b).unwrap());
        let r = (a.len() + b.len() + 20) as u64;
        let plan = zmul::admit(&ca, &cb, r, &CAPS).unwrap().unwrap();
        let adm = plan.admitted;
        got.push(((la, ta, lb, tb), (adm.work, adm.peak, plan.schoolbook)));
        // (exactly the admitted work and peak admit; one less refuses)
        let at = Caps { work: adm.work, peak: adm.peak, ..CAPS };
        assert!(zmul::admit(&ca, &cb, r, &at).unwrap().is_some());
        // (each refusal before anything is allocated: only its message, and
        // the heap back at its baseline once that is dropped)
        let base = LIVE.load(Relaxed);
        let e = zmul::admit(&ca, &cb, r, &Caps { work: adm.work - 1, ..CAPS }).err().unwrap();
        assert!(e.contains("the work (word operations)"), "{}", e);
        drop(e);
        let e = zmul::admit(&ca, &cb, r, &Caps { peak: adm.peak - 1, ..CAPS }).err().unwrap();
        assert!(e.contains("the memory (bytes)"), "{}", e);
        drop(e);
        assert_eq!(LIVE.load(Relaxed), base, "a refusal left memory live");
    }
    assert_eq!(got.as_slice(), PINNED, "the admitted values differ from the pinned ones (on this target)");
}
