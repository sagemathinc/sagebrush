// The audit allocator counts a growing reallocation at its peak, the old
// block and the new one at once (A12-F2: it added only new - old after the
// wrapped call, so a moving growth's overlap went unchecked).  The wrapped
// allocator here always moves: allocate, copy, free.  A test binary of its
// own: the audit's counters are process-wide.
#![cfg(feature = "ledger-audit")]
use sagebrush_ledger::{audit, reserve, set_total, Operation, Total, TotalStatus};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;

struct Moving;

// SAFETY: alloc and dealloc forward to System; realloc allocates a new block
// of the new size with the old alignment, copies the smaller of the two
// sizes and frees the old block, as GlobalAlloc's default realloc does.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Moving {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = System.alloc(Layout::from_size_align_unchecked(n, l.align()));
        if !q.is_null() {
            std::ptr::copy_nonoverlapping(p, q, l.size().min(n));
            System.dealloc(p, l);
        }
        q
    }
}

#[global_allocator]
static ALLOC: audit::Audit<Moving> = audit::Audit::new(Moving);

fn grow(reserved: u64) -> u64 {
    audit::start(64 << 10);
    let op = Operation::enter();
    let r = reserve("growth", reserved).unwrap();
    {
        let _s = r.scope();
        let mut v: Vec<u8> = black_box(Vec::with_capacity(1 << 20));
        v.reserve_exact(2 << 20);
        black_box(&v);
    }
    drop(r);
    op.finish().unwrap();
    audit::breaches()
}

#[test]
fn a_moving_growth_is_checked_at_its_peak() {
    set_total(Some(Total { bytes: 1 << 34, status: TotalStatus::Observed, joint: false, uncertified: false }));
    // 1 MiB grown to 2 MiB moves: 3 MiB at once, more than a 2 MiB
    // reservation covers
    assert!(grow(2 << 20) > 0, "the overlap of a moving growth is a breach");
    // covered at its peak: no breach
    assert_eq!(grow(3 << 20), 0);
}
