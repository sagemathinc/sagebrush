//! `ntt::mul_words_local`'s live bytes beyond its inputs, measured by a
//! counting allocator: within `mul_words_local_peak` = 64N + 8m (m = la + lb,
//! N = m - 1 padded to a power of two), the output included, at the
//! transform boundary m = N + 1 (where 72N would be 8 bytes short), inside
//! it, unbalanced, zero-length factors, and at poly_mul's largest corner (N =
//! 2^19); nothing left live after a product or a Stop.  Natively
//! this is the 64-bit path, under wasm32-wasip1 the 32-bit one.  Its own
//! test binary: the counters are global.

use sagebrush_bigint::ntt::{mul_words_local, mul_words_local_peak};
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

#[test]
fn peak_within_64n_plus_8m() {
    let mut s = 11u64;
    let mut words = |n: usize| -> Vec<u64> {
        (0..n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                s
            })
            .collect()
    };
    // (a first product sets up the interrupt state, which stays)
    let _ = mul_words_local(&words(3), &words(3));
    for (la, lb) in [(2usize, 1usize), (3, 2), (513, 512), (512, 512), (1 << 12, 7), ((1 << 15) + 1, 1 << 15), ((1 << 18) + 1, 1 << 18)] {
        let (a, b) = (words(la), words(lb));
        let base = LIVE.load(Relaxed);
        PEAK.store(base, Relaxed);
        let z = mul_words_local(&a, &b);
        let grew = PEAK.load(Relaxed) - base;
        let bound = mul_words_local_peak(la, lb).unwrap();
        let (m, n) = ((la + lb) as u64, ((la + lb - 1) as u64).next_power_of_two());
        assert_eq!(bound, 64 * n + 8 * m);
        assert_eq!(z.len(), la + lb);
        drop(z);
        // (checked before printing: the harness's captured output allocates)
        assert_eq!(LIVE.load(Relaxed), base, "{} x {}: memory left live", la, lb);
        eprintln!("{} x {}: {} bytes at the peak, bound {} ({} to spare)", la, lb, grew, bound, bound as i64 - grew as i64);
        assert!(grew as u64 <= bound, "{} x {}: {} bytes live, bound {}", la, lb, grew, bound);
        if m == n + 1 {
            // (the boundary where 72N would not be an upper bound)
            assert!(bound > 72 * n);
        }
    }
    // (zero-length factors: the zero product, its exact rule)
    for (la, lb) in [(0usize, 5usize), (4, 0), (0, 0)] {
        let (a, b) = (words(la), words(lb));
        let base = LIVE.load(Relaxed);
        PEAK.store(base, Relaxed);
        let z = mul_words_local(&a, &b);
        let grew = PEAK.load(Relaxed) - base;
        assert_eq!(z, vec![0u64; la + lb]);
        drop(z);
        assert_eq!(LIVE.load(Relaxed), base);
        assert!(grew as u64 <= mul_words_local_peak(la, lb).unwrap());
        assert_eq!(mul_words_local_peak(la, lb), Some(8 * (la + lb) as u64));
    }
    // (a Stop at the first, a middle and the last poll leaves nothing live,
    // where a panic unwinds; in WebAssembly a Stop traps and the host discards
    // the instance)
    #[cfg(panic = "unwind")]
    {
        use sagebrush_interrupt::hooks;
        let (a, b) = (words(1 << 14), words(1 << 14));
        hooks::reset();
        hooks::trace();
        let _ = mul_words_local(&a, &b);
        let polls = hooks::total();
        hooks::reset();
        // (a first Stop sets up the unwinding machinery's one-time state)
        hooks::arm_at(1);
        let _ = sagebrush_interrupt::catch(|| mul_words_local(&a, &b));
        hooks::reset();
        sagebrush_interrupt::clear();
        for at in [1, polls / 2, polls] {
            let base = LIVE.load(Relaxed);
            hooks::reset();
            hooks::arm_at(at);
            let r = sagebrush_interrupt::catch(|| mul_words_local(&a, &b));
            hooks::reset();
            sagebrush_interrupt::clear();
            assert!(r.is_err(), "no Stop at poll {}", at);
            drop(r);
            assert_eq!(LIVE.load(Relaxed), base, "memory left live after a Stop at poll {}", at);
        }
    }
    // (the closed form fails closed on overflow)
    assert_eq!(mul_words_local_peak(usize::MAX, 1), None);
    assert_eq!(mul_words_local_peak(usize::MAX / 2 + 1, usize::MAX / 2), None);
}
