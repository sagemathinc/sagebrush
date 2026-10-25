// The counting allocator, installed in this test binary: allocations,
// zeroed allocations, growth and shrinking reallocations and frees move
// live_bytes by exactly their sizes.
use sagebrush_ledger::{live_bytes, CountingAlloc};
use std::alloc::System;

#[global_allocator]
static ALLOC: CountingAlloc<System> = CountingAlloc::new(System);

#[test]
fn live_bytes_follow_allocations() {
    // (one test function: the test harness's own threads allocate too, so
    // only differences within this thread's quiet window are compared, with
    // a margin for the harness)
    let before = live_bytes();
    let mut v: Vec<u8> = Vec::with_capacity(1 << 20);
    let after_alloc = live_bytes();
    assert!(after_alloc >= before + (1 << 20), "{} -> {}", before, after_alloc);
    v.reserve_exact(3 << 20); // a growing reallocation to 4 MiB
    let grown = live_bytes();
    assert!(grown >= before + (4 << 20), "{} -> {}", before, grown);
    v.shrink_to(1 << 16);
    let shrunk = live_bytes();
    assert!(shrunk < grown - (3 << 20), "{} -> {}", grown, shrunk);
    drop(v);
    let z = vec![0u8; 2 << 20]; // alloc_zeroed
    assert!(live_bytes() >= before + (2 << 20));
    drop(z);
    let end = live_bytes();
    assert!(end < before + (1 << 16), "{} -> {}", before, end);
}
