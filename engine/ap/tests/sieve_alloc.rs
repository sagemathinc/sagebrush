//! The sieve's peak heap is within what the dispatchers reserve for it:
//! its (n - 1) / 2 flags and prime_count_bound(n) primes, the primes' Vec
//! allocated once at that capacity (no growth, no old-and-new overlap).
//! (A file of its own: a counting global allocator, token-identical to the
//! audited engine/arith/tests/nmod_fast_alloc.rs one, realloc's old and
//! new blocks counted together.)


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

#[test]
fn the_sieve_stays_within_its_reservation() {
    // (once first: the interrupt hooks' phase table, a test feature's
    // bookkeeping allocated at its first use, is not the sieve's)
    drop(sagebrush_ap::primes_up_to(10));
    for n in [100u64, 10_000, 1_000_000, 20_000_000] {
        let base = LIVE.load(Relaxed);
        PEAK.store(base, Relaxed);
        let p = sagebrush_ap::primes_up_to(n);
        let peak = PEAK.load(Relaxed) - base;
        let reserved = (n as usize - 1) / 2 + 8 * sagebrush_ap::prime_count_bound(n);
        assert!(peak <= reserved, "n = {}: peak {} bytes, reserved {}", n, peak, reserved);
        assert!(p.len() <= sagebrush_ap::prime_count_bound(n) && p.capacity() == sagebrush_ap::prime_count_bound(n), "n = {}", n);
        drop(p);
    }
}
