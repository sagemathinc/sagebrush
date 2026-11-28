// The test-only audit allocator (feature ledger-audit, plan C r12 section
// 4): attribution on every allocation inside an engine entry, with the two
// required mutations, an uncovered allocate-and-free between two checks and
// an uncovered allocation masked by another reservation's headroom.
#![cfg(feature = "ledger-audit")]
use sagebrush_ledger::{audit, reserve, set_total, Operation, Total, TotalStatus};
use std::hint::black_box;

#[global_allocator]
static ALLOC: audit::Audit<std::alloc::System> = audit::Audit::new(std::alloc::System);

#[test]
fn every_allocation_inside_an_entry_is_attributed() {
    // (one test function: the audit's counters are process-wide)
    set_total(Some(Total { bytes: 1 << 34, status: TotalStatus::Observed, joint: false, uncertified: false }));
    audit::start(64 << 10);

    // covered: a reservation's scope
    let op = Operation::enter();
    let r = reserve("work", 1 << 20).unwrap();
    {
        let _s = r.scope();
        let v: Vec<u8> = black_box(Vec::with_capacity(1 << 20));
        drop(v);
    }
    assert_eq!(audit::violations().0, 0, "a covered allocation is attributed");

    // mutation 1: an uncovered allocate-and-free between two checks (no
    // check runs while it is live)
    let v: Vec<u8> = black_box(Vec::with_capacity(1 << 16));
    drop(v);
    let (n, last) = audit::violations();
    assert!(n >= 1 && last == 1 << 16, "the transient uncovered allocation is caught at the allocation: {} {}", n, last);

    // mutation 2: masked: another reservation (r) has 1 MiB of headroom,
    // so the sum check alone passes; attribution still catches it
    audit::start(64 << 10);
    let breaches = audit::breaches();
    let w: Vec<u8> = black_box(Vec::with_capacity(1 << 18));
    assert_eq!(audit::breaches(), breaches, "the sum check alone does not see it");
    assert!(audit::violations().0 >= 1, "attribution catches the masked allocation");
    drop(w);
    drop(r);

    // the per-scope check: an allocation under a reservation's scope past
    // that reservation (here one of 0 bytes, beside another with 1 MiB of
    // headroom, so the sum check passes) is a scope breach; within it, none
    audit::start(4 << 10);
    let big = reserve("headroom", 1 << 20).unwrap();
    let none = reserve("none", 0).unwrap();
    {
        let _s = none.scope();
        let v: Vec<u8> = black_box(Vec::with_capacity(64 << 10));
        drop(v);
    }
    assert_eq!(audit::breaches(), 0, "the sum check alone does not see it");
    assert!(audit::scope_breaches() >= 1, "the per-scope check catches the allocation its reservation doesn't cover");
    audit::start(4 << 10);
    let fits = reserve("fits", 128 << 10).unwrap();
    {
        let _s = fits.scope();
        let v: Vec<u8> = black_box(Vec::with_capacity(64 << 10));
        drop(v);
        // (and a scope inside it with no amount of its own, a span's, checks nothing)
        let _t = sagebrush_ledger::Scope::enter();
        let v: Vec<u8> = black_box(Vec::with_capacity(256 << 10));
        drop(v);
    }
    assert_eq!(audit::scope_breaches(), 0, "an allocation within its reservation, or under a scope without one");
    // nested: a child reservation's scope inside a parent's, its result kept
    // past its scope; each scope is charged only its own allocations, so the
    // parent's next allocation, within the parent's own amount, is no breach
    // (the child's retained bytes are the child's) ...
    audit::start(4 << 10);
    let parent = reserve("parent", 8 << 10).unwrap();
    let child = reserve("child", 64 << 10).unwrap();
    let kept: Vec<u8>;
    {
        let _p = parent.scope();
        {
            let _c = child.scope();
            kept = black_box(Vec::with_capacity(64 << 10));
        }
        let v: Vec<u8> = black_box(Vec::with_capacity(8 << 10));
        drop(v);
    }
    assert_eq!(audit::scope_breaches(), 0, "a child's retained result is not charged to its parent");
    // ... and the parent's own growth past its amount still is, with the
    // child's result still held
    {
        let _p = parent.scope();
        {
            let _c = child.scope();
            let v: Vec<u8> = black_box(Vec::with_capacity(32 << 10));
            drop(v);
        }
        let v: Vec<u8> = black_box(Vec::with_capacity(32 << 10));
        drop(v);
    }
    assert!(audit::scope_breaches() >= 1, "the parent's own allocation past its amount, after a child's scope");
    drop((kept, parent, child));
    drop((big, none, fits));
    op.finish().unwrap();

    // outside any engine entry nothing is attributed (the harness's own
    // allocations)
    audit::start(64 << 10);
    let x: Vec<u8> = black_box(Vec::with_capacity(4096));
    drop(x);
    assert_eq!(audit::violations().0, 0);
}
