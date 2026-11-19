//! Stop inside each phase of the factorization modulo p (square-free
//! decomposition, distinct-degree, equal-degree), in its own test binary:
//! the interrupt flag and the check counters are process-wide.  Each
//! phase's checks are traced on a full run, then Stop is armed at the
//! middle one: the call unwinds with the interrupt, in that phase, leaving
//! no live reservation and no live allocation (this binary's allocator
//! counts every byte, after a full run has warmed up what is created once,
//! such as the phase names), and the next call gives the same
//! factorization.

use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_poly::{try_factor_mod_with, Budget};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

// The counting allocator of engine/web/tests/nmod_alloc.rs, token for token
// (the same audited item in test/unsafe-allow-inventory.json): LIVE holds
// the process's live bytes (one test here: nothing else allocates).
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Armed (1): the live bytes just after the next allocation are recorded
/// in FIRST_LIVE, with its size in FIRST_SIZE.  (Unused here; kept so the
/// allocator stays the audited one.)
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
static A: Counting = Counting;

/// (x^n - 1)^2 (x + 3): repeated factors for the square-free phase, then
/// pieces of several degrees, each with several factors to split.
fn input(n: usize) -> Vec<BigInt> {
    let mut a = vec![BigInt::zero(); n + 1];
    a[0] = -BigInt::one();
    a[n] = BigInt::one();
    let mut sq = vec![BigInt::zero(); 2 * n + 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in a.iter().enumerate() {
            sq[i + j] += x * y;
        }
    }
    let mut f = vec![BigInt::zero(); 2 * n + 2];
    for (i, c) in sq.iter().enumerate() {
        f[i] += c * BigInt::from(3);
        f[i + 1] += c;
    }
    f
}

#[test]
fn stop_in_every_phase() {
    sagebrush_interrupt::clear();
    for (p, n) in [(65537u64, 120usize), (2, 105)] {
        let f = input(n);
        hooks::reset();
        hooks::trace();
        let full = try_factor_mod_with(&f, p, &Budget::default()).expect("within the default budget");
        let gap = hooks::max_gap_ns();
        let idx: Vec<(&str, Vec<u64>)> = ["sqf", "ddf", "edf"].iter().map(|&ph| (ph, hooks::traced(ph))).collect();
        hooks::reset();
        assert!(gap < 250_000_000, "p={}: {} ns between two checks", p, gap);
        // one unmeasured Stop first: the unwinding machinery allocates once
        // on its first use (16 bytes, kept for the thread's life)
        {
            let b = Budget::default();
            hooks::arm_at(idx[0].1[0]);
            let _ = sagebrush_interrupt::catch(|| try_factor_mod_with(&f, p, &b).map(|x| x.len()));
            hooks::reset();
            sagebrush_interrupt::clear();
        }
        for (ph, ix) in idx {
            assert!(!ix.is_empty(), "p={}: no checks in {}", p, ph);
            hooks::reset();
            let before = LIVE.load(Relaxed);
            let (stopped, at, reserved) = {
                let b = Budget::default();
                hooks::arm_at(ix[ix.len() / 2]);
                let r = sagebrush_interrupt::catch(|| try_factor_mod_with(&f, p, &b).map(|x| x.len()));
                let at = hooks::stopped_in();
                hooks::reset();
                sagebrush_interrupt::clear();
                (r.is_err(), at, b.live())
            };
            let left = LIVE.load(Relaxed) as i64 - before as i64;
            assert!(stopped, "p={}: not interrupted in {}", p, ph);
            assert_eq!(at, ph, "p={}: stopped in {} instead of {}", p, at, ph);
            assert_eq!(reserved, 0, "p={}: live reservation after Stop in {}", p, ph);
            assert_eq!(left, 0, "p={}: {} bytes still allocated after Stop in {}", p, left, ph);
            println!("STOP p={:5} {:3} {:6} checks, longest gap {:.3} ms (whole run)", p, ph, ix.len(), gap as f64 / 1e6);
        }
        // and the next call works normally
        assert_eq!(try_factor_mod_with(&f, p, &Budget::default()).unwrap(), full, "p={}: the next call", p);
    }
}
