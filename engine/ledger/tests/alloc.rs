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
    set_total(Some(Total { bytes: 1 << 34, status: TotalStatus::Observed, joint: false }));
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
    op.finish().unwrap();

    // outside any engine entry nothing is attributed (the harness's own
    // allocations)
    audit::start(64 << 10);
    let x: Vec<u8> = black_box(Vec::with_capacity(4096));
    drop(x);
    assert_eq!(audit::violations().0, 0);
}
