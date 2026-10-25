//! Calibration builds only (feature `phi-probe`, never shipped): a counting
//! allocator over the system one, so that the calibration of the ledger's
//! fragmentation factor phi (no-cliffs plan C r4 section 1.2, r13: phi = 5/4
//! is a placeholder) can compare the bytes requested at a workload's peak
//! with the committed pages the WebAssembly memory grew by.  The shipped
//! engine has no global allocator of its own (C r11); this module exists
//! only when the feature is on.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);

fn grew(n: usize) {
    let live = LIVE.fetch_add(n as u64, Relaxed) + n as u64;
    PEAK.fetch_max(live, Relaxed);
}

fn shrank(n: usize) {
    LIVE.fetch_sub(n as u64, Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        System.dealloc(p, layout);
        shrank(layout.size());
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let q = System.realloc(p, layout, new_size);
        if !q.is_null() {
            // (the new block before the old one is freed: both live while the
            // copy runs)
            grew(new_size);
            shrank(layout.size());
        }
        q
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// The bytes requested and not yet freed.
#[no_mangle]
pub extern "C" fn sb_probe_live() -> f64 {
    LIVE.load(Relaxed) as f64
}

/// The highest live figure since the last call, then reset to the current
/// live bytes.
#[no_mangle]
pub extern "C" fn sb_probe_peak_reset() -> f64 {
    let live = LIVE.load(Relaxed);
    PEAK.swap(live, Relaxed) as f64
}
