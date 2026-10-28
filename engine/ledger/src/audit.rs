//! Tests and CI only (feature `ledger-audit`, never shipped): an auditing
//! global allocator that runs on EVERY alloc, realloc and free (no-cliffs
//! plan C r12 section 4).
//!
//! - Attribution: an allocation made on a thread that is inside an engine
//!   entry (its chain is not 0) must be made inside a coverage scope
//!   ([`crate::Scope`]: a reservation or credit being materialised, a span,
//!   a fenced child, a resident under construction).  One that isn't is
//!   counted in [`violations`], with the size of the last one.
//! - The sum check: the counted live bytes may not exceed the baseline at
//!   the audit's start plus residents, outstanding obligations and a slack
//!   ([`set_slack`]); a breach is counted in [`breaches`].
//!
//! Install it in a test binary:
//!
//! ```ignore
//! #[global_allocator]
//! static A: sagebrush_ledger::audit::Audit<std::alloc::System> =
//!     sagebrush_ledger::audit::Audit::new(std::alloc::System);
//! ```

use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

static LIVE: AtomicU64 = AtomicU64::new(0);
static BASE: AtomicU64 = AtomicU64::new(0);
static SLACK: AtomicU64 = AtomicU64::new(0);
static VIOLATIONS: AtomicU64 = AtomicU64::new(0);
static LAST_VIOLATION: AtomicU64 = AtomicU64::new(0);
static BREACHES: AtomicU64 = AtomicU64::new(0);

thread_local! {
    // (re-entry guard: the checks themselves never allocate, but a panic
    // message might)
    static BUSY: Cell<bool> = const { Cell::new(false) };
}

pub struct Audit<A>(A);

impl<A> Audit<A> {
    pub const fn new(inner: A) -> Self {
        Audit(inner)
    }
}

fn check_alloc(size: u64) {
    let _ = BUSY.try_with(|busy| {
        if busy.replace(true) {
            return;
        }
        let in_engine = crate::CHAIN.try_with(|c| c.get() != 0).unwrap_or(false);
        let covered = crate::COVER.try_with(|c| c.get() > 0).unwrap_or(true);
        if in_engine && !covered {
            VIOLATIONS.fetch_add(1, Relaxed);
            LAST_VIOLATION.store(size, Relaxed);
        }
        let live = LIVE.load(Relaxed);
        let bound = BASE.load(Relaxed) + crate::RES_MIRROR.load(Relaxed) + crate::O_MIRROR.load(Relaxed) + SLACK.load(Relaxed);
        if in_engine && live > bound {
            BREACHES.fetch_add(1, Relaxed);
        }
        busy.set(false);
    });
}

// SAFETY: every method forwards to the wrapped allocator with the caller's own
// arguments, so its GlobalAlloc contract carries over unchanged; the bookkeeping
// around it only updates atomics and reads the thread's chain and coverage cells
// (it creates no ledger object).  Tests and CI only (feature `ledger-audit`).
#[allow(unsafe_code)]
unsafe impl<A: GlobalAlloc> GlobalAlloc for Audit<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = self.0.alloc(layout);
        if !p.is_null() {
            LIVE.fetch_add(layout.size() as u64, Relaxed);
            check_alloc(layout.size() as u64);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = self.0.alloc_zeroed(layout);
        if !p.is_null() {
            LIVE.fetch_add(layout.size() as u64, Relaxed);
            check_alloc(layout.size() as u64);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        self.0.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size() as u64, Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let q = self.0.realloc(ptr, layout, new_size);
        if !q.is_null() {
            let (old, new) = (layout.size() as u64, new_size as u64);
            if new >= old {
                LIVE.fetch_add(new - old, Relaxed);
                check_alloc(new - old);
            } else {
                LIVE.fetch_sub(old - new, Relaxed);
            }
        }
        q
    }
}

/// Start an audited window: the current live count becomes the baseline,
/// and the counters reset.
pub fn start(slack: u64) {
    BASE.store(LIVE.load(Relaxed), Relaxed);
    SLACK.store(slack, Relaxed);
    VIOLATIONS.store(0, Relaxed);
    BREACHES.store(0, Relaxed);
}

pub fn set_slack(slack: u64) {
    SLACK.store(slack, Relaxed);
}

/// Allocations made inside an engine entry without a coverage scope, and
/// the size of the last one.
pub fn violations() -> (u64, u64) {
    (VIOLATIONS.load(Relaxed), LAST_VIOLATION.load(Relaxed))
}

/// Allocations after which the counted live bytes exceeded the covered sum.
pub fn breaches() -> u64 {
    BREACHES.load(Relaxed)
}

/// The counted live bytes.
pub fn live() -> u64 {
    LIVE.load(Relaxed)
}
