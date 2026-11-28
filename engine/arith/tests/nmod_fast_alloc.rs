//! The fast product's allocations, by a counting allocator: its peak live
//! memory is exactly the plan's peak words (the schedule the admission
//! counts), on classical shapes of both branches, the gate's flips, odd
//! and rectangular shapes and several levels; and its admission: with no
//! allowance, or one smaller than its extra words, the product runs
//! classical (its result, units and peak); with enough, it runs fast
//! within its peak and gives the words back.  One test (the counters are
//! global).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Armed (1): the live bytes just after the next allocation are recorded
/// in FIRST_LIVE, with its size in FIRST_SIZE.
static FIRST_ARMED: AtomicUsize = AtomicUsize::new(0);
static FIRST_LIVE: AtomicUsize = AtomicUsize::new(0);
static FIRST_SIZE: AtomicUsize = AtomicUsize::new(0);

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
            if FIRST_ARMED.swap(0, Relaxed) == 1 {
                FIRST_LIVE.store(live, Relaxed);
                FIRST_SIZE.store(l.size(), Relaxed);
            }
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
static COUNTING: Counting = Counting;

/// f's result and its peak live bytes above the live bytes before it.
fn measured<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let out = f();
    (out, (PEAK.load(Relaxed) - base) as u64)
}

use sagebrush_arith::cost::{metered, Meter, Units};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::{fast_allowance_left, fast_n0, set_fast_n0, with_fast_product, Mat};

fn mat(r: usize, c: usize, p: u64, seed: u64) -> Mat {
    let mut s = seed | 1;
    let d = (0..r * c)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % p
        })
        .collect();
    Mat { rows: r, cols: c, m: Modulus::new(p), d }
}

#[test]
fn the_fast_product_allocates_its_planned_peak() {
    // (warm the thread's tallies and the interrupt state)
    let w = mat(70, 70, 65537, 1);
    drop(w.mul_planned(&w, 2));
    let rows: &[(u64, usize, usize, usize)] = &[
        (65537, 10, 20, 30),
        ((1 << 62) - 57, 10, 20, 30),
        (65537, 64, 64, 64),
        (65537, 66, 66, 66),
        (65537, 85, 85, 85),
        (65537, 132, 132, 132),
        (65537, 200, 100, 160),
        (65537, 160, 100, 200),
        (65537, 133, 131, 135),
        ((1 << 31) - 1, 78, 78, 78),
        ((1 << 31) - 1, 113, 113, 113),
        ((1 << 31) - 1, 156, 157, 155),
        ((1 << 62) - 57, 74, 74, 74),
        ((1 << 62) - 57, 97, 97, 97),
        ((1 << 62) - 57, 101, 101, 101),
        ((1 << 62) - 57, 149, 148, 147),
    ];
    for &(p, m, k, n) in rows {
        let (a, b) = (mat(m, k, p, 3), mat(k, n, p, 5));
        let want = Mat::planned_peak(m, k, n, &Modulus::new(p), 2).unwrap() * 8;
        let (c, got) = measured(|| a.mul_planned(&b, 2));
        assert_eq!(c, a.mul(&b));
        assert_eq!(got, want, "p {} {}x{}x{}: measured {} bytes, planned {}", p, m, k, n, got, want);
        if (p, m, k, n) == (65537, 132, 132, 132) {
            assert_eq!(Mat::planned_levels(m, k, n, &Modulus::new(p), 2), Some(8));
        }
    }

    // admission, at the crossover's own n0
    for p in [65537u64, (1 << 62) - 57] {
        let md = Modulus::new(p);
        let n0 = fast_n0(&md);
        let s = 2 * n0 + 4;
        let (a, b) = (mat(s, s, p, 7), mat(s, s, p, 9));
        let want = a.mul_classical(&b);
        let run = |allowance: Option<u64>| -> (Mat, Units, u64) {
            let mut meter = Meter::accounting(u64::MAX);
            let (c, peak) = measured(|| match allowance {
                None => metered(&mut meter, || a.mul(&b)),
                Some(w) => with_fast_product(w, || metered(&mut meter, || a.mul(&b))),
            });
            (c, meter.units(), peak)
        };
        let (c0, classical, cpeak) = run(None);
        let fast_peak = Mat::planned_peak(s, s, s, &md, n0).unwrap() * 8;
        let extra = fast_peak / 8 - cpeak / 8;
        assert!(extra > 0, "p {}", p);
        let (c1, short, speak) = run(Some(extra - 1));
        let (c2, fast, fpeak) = run(Some(extra));
        assert_eq!((&c0, &c1, &c2), (&want, &want, &want), "p {}", p);
        assert_eq!((short, speak), (classical, cpeak), "p {}: one word short runs classical", p);
        assert_eq!(fpeak, fast_peak, "p {}", p);
        assert!(fast.total().unwrap() < classical.total().unwrap(), "p {}", p);
        // the words are given back: two products in a row both run fast,
        // and the allowance is off again outside
        let mut meter = Meter::accounting(u64::MAX);
        with_fast_product(extra, || {
            metered(&mut meter, || {
                drop(a.mul(&b));
                drop(a.mul(&b));
            });
            assert_eq!(fast_allowance_left(), Some(extra));
        });
        assert_eq!(fast_allowance_left(), None);
        assert_eq!(meter.used(), 2 * fast.total().unwrap(), "p {}", p);
        // the crossover's neighbours through Mat::mul with ample allowance:
        // n0 - 1 runs classical (its units and peak); n0 and n0 + 1 run as
        // their plan at this same n0 says (fast: fewer units), each peak the
        // one planned at this n0
        for t in [n0 - 1, n0, n0 + 1] {
            let fast_expected = Mat::planned_levels(t, t, t, &md, n0).unwrap() > 0;
            assert!(t >= n0 || !fast_expected);
            let (x, y) = (mat(t, t, p, 11), mat(t, t, p, 13));
            let mut mc = Meter::accounting(u64::MAX);
            let (wc, pc) = measured(|| metered(&mut mc, || x.mul_classical(&y)));
            let mut mf = Meter::accounting(u64::MAX);
            let (wf, pf) = measured(|| with_fast_product(u64::MAX / 4, || metered(&mut mf, || x.mul(&y))));
            assert_eq!(wf, wc, "p {} n {}", p, t);
            assert_eq!(pf, Mat::planned_peak(t, t, t, &md, n0).unwrap() * 8, "p {} n {}: peak", p, t);
            if fast_expected {
                assert!(mf.used() < mc.used(), "p {} n {}: fast", p, t);
            } else {
                assert_eq!((mf.units(), pf), (mc.units(), pc), "p {} n {}: classical", p, t);
            }
        }
        // oversized shapes plan nothing (and so run classical)
        assert!(Mat::planned_peak(usize::MAX / 2, usize::MAX / 2, 4, &md, n0).is_none());
    }
    // a test build's crossover override: Mat::mul plans with it (here one
    // above a shape the constant takes fast, so classical), and the
    // constant is back after
    let md = Modulus::new(65537);
    let n0 = fast_n0(&md);
    let t = 2 * n0 + 4;
    let (x, y) = (mat(t, t, 65537, 17), mat(t, t, 65537, 19));
    let mut mc = Meter::accounting(u64::MAX);
    let want = metered(&mut mc, || x.mul_classical(&y));
    assert!(Mat::planned_levels(t, t, t, &md, n0).unwrap() > 0);
    set_fast_n0(Some(t + 1));
    assert_eq!(fast_n0(&md), t + 1);
    let mut mo = Meter::accounting(u64::MAX);
    let got = with_fast_product(u64::MAX / 4, || metered(&mut mo, || x.mul(&y)));
    set_fast_n0(None);
    assert_eq!(fast_n0(&md), n0);
    assert_eq!(got, want);
    assert_eq!(mo.units(), mc.units());
    let mut mf = Meter::accounting(u64::MAX);
    with_fast_product(u64::MAX / 4, || metered(&mut mf, || drop(x.mul(&y))));
    assert!(mf.used() < mc.used());
}
