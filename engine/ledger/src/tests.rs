// The ledger's admission, ownership and exit rules (plan C r5 section 1.4,
// r10 section 4).  The tests share the process-wide state, so each takes
// SERIAL and starts from a clean ledger; live bytes are simulated with the
// hooks (the counting allocator itself is tested in tests/alloc.rs, where it
// is installed).
use super::*;
use std::sync::{Arc, Barrier};

static SERIAL: Mutex<()> = Mutex::new(());

fn fresh(total_bytes: u64) -> std::sync::MutexGuard<'static, ()> {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = state();
    s.outstanding = 0;
    s.by_chain.clear();
    drop(s);
    let live = LIVE.load(Relaxed);
    hooks::sub_live(live);
    set_total(Some(Total { bytes: total_bytes, status: TotalStatus::Observed, joint: false }));
    g
}

/// E = total / 4 and phi = 5/4: a total of 4 * 5/4 * n gives exactly n
/// usable bytes.
fn total_for_usable(n: u64) -> u64 {
    n * SHARE_DEN * FRAG_NUM / FRAG_DEN
}

#[test]
fn the_union_counts_pending_and_unregistered_bytes() {
    // astra2's witness (C r4): 10 registered live, 40 reserved and not yet
    // allocated, 40 live outside the ledger; with 75 usable, a new 20 is
    // refused (10 + 40 + 40 + 20 = 110), where max(registered, live) + x
    // = 70 would have admitted it
    let _g = fresh(total_for_usable(75));
    hooks::add_live(10);
    let resident = reserve("resident", 10).unwrap();
    resident.register_resident();
    let pending = reserve("pending", 40).unwrap();
    hooks::add_live(40); // (a non-ledger allocation)
    match reserve("new", 20) {
        Err(EngineError::Memory(r)) => {
            assert_eq!((r.need, r.live, r.outstanding, r.allowance), (20, 50, 40, total_for_usable(75) / 4));
            assert_eq!(r.status, TotalStatus::Observed);
        }
        _ => panic!("the union must refuse"),
    }
    drop(pending);
    // without the pending 40: 50 live + 20 = 70 fits
    assert!(reserve("new", 20).is_ok());
}

#[test]
fn two_admissions_before_either_allocates_cannot_both_fit() {
    // pre-existing non-ledger live memory, then two threads reserve at once
    let _g = fresh(total_for_usable(100));
    hooks::add_live(30);
    let (start, held) = (Arc::new(Barrier::new(2)), Arc::new(Barrier::new(2)));
    let hs: Vec<_> = (0..2)
        .map(|_| {
            let (start, held) = (start.clone(), held.clone());
            std::thread::spawn(move || {
                start.wait();
                let r = reserve("each", 50);
                // (both admissions are decided before either is released)
                held.wait();
                r.map(|r| r.amount()).ok()
            })
        })
        .collect();
    let got: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(got.iter().filter(|g| g.is_some()).count(), 1, "{:?}", got);
    // (the winner's reservation was dropped when its thread returned)
    assert_eq!(outstanding_bytes(), 0);
}

#[test]
fn a_resident_leaves_the_outstanding_sum_and_stays_live() {
    let _g = fresh(total_for_usable(1000));
    let r = reserve("cache entry", 300).unwrap();
    hooks::add_live(300); // (its bytes are allocated)
    assert_eq!(outstanding_bytes(), 300);
    r.register_resident();
    assert_eq!(outstanding_bytes(), 0);
    assert_eq!(live_bytes(), 300);
    // the resident's bytes still count: 300 live + 701 > 1000
    assert!(reserve("next", 701).is_err());
    assert!(reserve("next", 700).is_ok());
}

#[test]
fn an_outer_exit_releases_what_remains_then_reports_it_as_internal() {
    let _g = fresh(total_for_usable(1000));
    let op = Operation::enter();
    let chain = op.chain();
    assert_eq!(current_chain(), chain);
    let leaked = reserve("forgotten", 123).unwrap();
    std::mem::forget(leaked); // (a reservation that outlives its call)
    let nested = Operation::enter();
    assert_eq!(nested.chain(), chain);
    assert_eq!(nested.finish(), Ok(())); // (a nested exit checks nothing)
    assert_eq!(chain_outstanding(chain), 123);
    match op.finish() {
        Err(EngineError::Internal(m)) => assert!(m.contains("123"), "{}", m),
        e => panic!("expected an internal error, got {:?}", e),
    }
    // cleanup came first: nothing is left outstanding, and the next call
    // starts a new chain
    assert_eq!(outstanding_bytes(), 0);
    assert_eq!(current_chain(), 0);
}

#[test]
fn a_clean_exit_and_an_unwind_both_leave_nothing() {
    let _g = fresh(total_for_usable(1000));
    let op = Operation::enter();
    {
        let _r = reserve("work", 400).unwrap();
    }
    assert_eq!(op.finish(), Ok(()));
    let r = std::panic::catch_unwind(|| {
        let _op = Operation::enter();
        let _r = reserve("work", 400).unwrap();
        panic!("Stop");
    });
    assert!(r.is_err());
    assert_eq!((outstanding_bytes(), current_chain()), (0, 0));
}

#[test]
fn an_observed_zero_refuses_and_no_total_is_nominal() {
    let _g = fresh(0);
    set_total(Some(Total { bytes: 0, status: TotalStatus::Zero, joint: false }));
    match reserve("x", 1) {
        Err(EngineError::Memory(r)) => assert_eq!((r.allowance, r.status), (0, TotalStatus::Zero)),
        _ => panic!("an observed zero refuses everything"),
    }
    set_total(None);
    assert_eq!(total(), Total { bytes: NOMINAL_TOTAL, status: TotalStatus::Nominal, joint: false });
    match reserve("x", NOMINAL_TOTAL) {
        Err(EngineError::Memory(r)) => assert_eq!(r.status, TotalStatus::Nominal),
        _ => panic!("the nominal total's quarter is less than the total"),
    }
}

#[test]
fn a_credit_grows_by_new_admissions() {
    let _g = fresh(total_for_usable(100));
    let mut c = reserve("credit", 60).unwrap();
    assert!(c.grow("credit", 40).is_ok());
    assert_eq!((c.amount(), outstanding_bytes()), (100, 100));
    assert!(c.grow("credit", 1).is_err());
    drop(c);
    assert_eq!(outstanding_bytes(), 0);
}

#[test]
fn wasm_totals_are_checked() {
    assert_eq!(total_from_wasm(4294967296.0, 0, 1), Some(Total { bytes: 1 << 32, status: TotalStatus::Observed, joint: true }));
    assert_eq!(total_from_wasm(0.0, 1, 0), Some(Total { bytes: 0, status: TotalStatus::Zero, joint: false }));
    for (b, s, j) in [(-1.0, 0, 0), (1.5, 0, 0), (f64::NAN, 0, 0), (f64::INFINITY, 0, 0), (1.0, 3, 0), (1.0, 0, 2), (1e300, 0, 0)] {
        assert_eq!(total_from_wasm(b, s, j), None, "{} {} {}", b, s, j);
    }
}

#[test]
fn internal_errors_are_not_memory_errors() {
    let m = EngineError::Internal("x".into());
    assert!(!matches!(m, EngineError::Memory(_)));
    assert!(m.to_string().starts_with("internal error"));
}
