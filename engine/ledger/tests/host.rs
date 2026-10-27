//! The native host's freshness (no-cliffs C-2a, carrying astra2's #164 r3
//! gate): a total left stale by a read that could not ask its source
//! (HostAnswer::NotAsked) certifies nothing, and a certification-dependent
//! chain refuses on it.  Its own test binary: the host is registered once
//! per process.
#![cfg(all(target_os = "linux", not(target_arch = "wasm32")))]

use sagebrush_ledger::*;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

/// whether the host asks its source (false: every read is NotAsked)
static ASK: AtomicBool = AtomicBool::new(true);

fn answer() -> HostAnswer {
    if !ASK.load(SeqCst) {
        return HostAnswer::NotAsked;
    }
    let bytes = 1u64 << 40;
    HostAnswer::Total(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }, vec![Row { kind: MeasureKind::Physical, figure: bytes }])
}

#[test]
fn a_stale_total_certifies_nothing_and_a_protected_chain_refuses_on_it() {
    set_total_host(answer);
    // (the total is asked again when 100 ms old)
    let past_refresh = || std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(certified(), "a fresh answer with a readable physical row certifies");
    let op = Operation::enter_certified().expect("certified at entry");
    assert!(reserve("fresh", 1024).is_ok());
    ASK.store(false, SeqCst);
    past_refresh();
    assert!(!certified(), "a stale total (the host did not ask) certifies nothing");
    assert!(Operation::enter_certified().is_none(), "no new certification-dependent entry on a stale total");
    assert!(matches!(reserve("stale", 1024), Err(EngineError::Memory(_))), "a certification-dependent chain refuses on a stale total");
    ASK.store(true, SeqCst);
    past_refresh();
    assert!(reserve("fresh again", 1024).is_ok(), "a fresh answer admits again");
    assert!(certified());
    assert_eq!(op.finish(), Ok(()));
}
