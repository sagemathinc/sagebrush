//! The chain admission's own work (the interrupt crate's test hooks): its
//! orbit walk checks Stop once per point (mutant A8), and with no room for
//! the chain's known levels the refusal comes before any walk (the walk's
//! mark array, the degree's size, is reserved with them: the review's case).  One
//! test: the hooks, the request flag and the ledger's total are global.

use sagebrush_group::group::chain_certain_bytes;
use sagebrush_group::{Group, Perm};
use sagebrush_interrupt::{catch, hooks};
use sagebrush_ledger::{set_total, Total, TotalStatus};

#[test]
fn the_admission_walk_stops_and_the_known_part_is_reserved_first() {
    let n = 200_000usize;
    let cycle = Perm((1..n as u32).chain([0]).collect());
    // a Stop armed at the walk's 1000th check stops it
    hooks::reset();
    hooks::arm_after(1000);
    let r = catch(|| chain_certain_bytes(n, &[cycle.clone()], &[]));
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "the orbit walk of a 200000-cycle went on past a Stop");
    // with a total too small for even the known levels (a 1 MB engine: 256
    // KB to share), Group::with_base(1000003, [], [0]) is refused before the
    // walk: no Stop check is made (one would be, at its first point)
    set_total(Some(Total { bytes: 1 << 20, status: TotalStatus::Observed, joint: false, uncertified: false }));
    hooks::reset();
    hooks::arm_after(1);
    let r = catch(|| Group::with_base(1_000_003, vec![], &[0]));
    let checks = hooks::total();
    hooks::reset();
    sagebrush_interrupt::clear();
    set_total(None);
    let e = r.expect("refused, not stopped").unwrap_err();
    assert!(e.contains("a permutation group's stabilizer chain"), "{}", e);
    assert_eq!(checks, 0, "the walk ran before the refusal");
}
