// The ledger's admission, ownership and exit rules (plan C r13).  The tests
// share the process-wide state, so each takes SERIAL and starts from a clean
// ledger; the usage measure is a fake (hooks::set_fake_usage), read under
// the lock at every check as the real one is.
use super::*;
use std::sync::{Arc, Barrier};

static SERIAL: Mutex<()> = Mutex::new(());

fn fresh(total_bytes: u64) -> std::sync::MutexGuard<'static, ()> {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = state();
    s.set_outstanding(0);
    s.set_resident(0);
    s.chains = [(0, 0); CHAIN_SLOTS];
    drop(s);
    hooks::set_fake_usage(Some((0, None)));
    set_total(Some(Total { bytes: total_bytes, status: TotalStatus::Observed, joint: false }));
    g
}

/// E = total / 4 and phi = 5/4: a total of 4 * 5/4 * n gives n usable bytes.
fn total_for_usable(n: u64) -> u64 {
    n * SHARE_DEN * FRAG_NUM / FRAG_DEN
}

#[test]
fn the_union_counts_pending_and_measured_bytes() {
    // astra2's witness (C r4) with a measured domain: 10 in use, then 40
    // reserved (not yet allocated), then the domain grows by 40 outside the
    // ledger (50 in use); a new 20 against 80 usable: 50 + 40 + 20 = 110,
    // refused; without the pending 40, 50 + 20 = 70 fits
    let _g = fresh(total_for_usable(80));
    hooks::set_fake_usage(Some((10, None)));
    let pending = reserve("pending", 40).unwrap();
    hooks::set_fake_usage(Some((50, None)));
    match reserve("new", 20) {
        Err(EngineError::Memory(r)) => assert_eq!((r.need, r.live, r.outstanding, r.measured), (20, 50, 40, true)),
        _ => panic!("the union must refuse"),
    }
    drop(pending);
    assert!(reserve("new", 20).is_ok());
}

#[test]
fn retained_growth_after_a_release_is_seen_by_the_next_check() {
    // astra2's C r12 case: usage 100; reserve 100; a covered allocation
    // grows the domain to 200; free it and release O, no resident; the next
    // check reads 200 (no cached measure).  (Usable figures are multiples of
    // 4 so that E = total / 4 is exact.)
    let _g = fresh(total_for_usable(252));
    hooks::set_fake_usage(Some((100, None)));
    let r = reserve("work", 100).unwrap();
    hooks::set_fake_usage(Some((200, None))); // (grown, and retained after the free)
    drop(r);
    match reserve("next", 53) {
        Err(EngineError::Memory(r)) => assert_eq!(r.live, 200),
        _ => panic!("200 + 53 > 252 must be refused"),
    }
    assert!(reserve("next", 52).is_ok());
}

#[test]
fn a_resident_conversion_is_counted_whatever_the_measure_says() {
    // L = max(U, R_res): a resident of 300 counts even if the measure
    // reads less (it is read at each check, under the lock)
    let _g = fresh(total_for_usable(1000));
    let r = reserve("cache entry", 300).unwrap();
    let res = r.register_resident();
    assert_eq!((outstanding_bytes(), resident_bytes()), (0, 300));
    assert!(reserve("next", 701).is_err());
    assert!(reserve("next", 700).is_ok());
    drop(res);
    assert_eq!(resident_bytes(), 0);
}

#[test]
fn machine_availability_refuses_when_others_use_the_machine() {
    // C r13 section 3: the process share fits, but external usage leaves
    // too little available (fake /proc/meminfo)
    let _g = fresh(total_for_usable(64 << 30));
    let avail = 300 << 20; // reserve(300 MiB) = 256 MiB + 30 MiB: room 14 MiB
    hooks::set_fake_usage(Some((1 << 20, Some(avail))));
    let room = avail - reserve_for(avail);
    assert!(reserve("fits", room).is_ok());
    match reserve("over", room + 1) {
        Err(EngineError::Memory(r)) => assert_eq!(r.available, Some(room)),
        _ => panic!("availability must refuse"),
    }
}

#[test]
fn two_admissions_before_either_allocates_cannot_both_fit() {
    let _g = fresh(total_for_usable(100));
    hooks::set_fake_usage(Some((30, None)));
    let (start, held) = (Arc::new(Barrier::new(2)), Arc::new(Barrier::new(2)));
    let hs: Vec<_> = (0..2)
        .map(|_| {
            let (start, held) = (start.clone(), held.clone());
            std::thread::spawn(move || {
                start.wait();
                let r = reserve("each", 50);
                held.wait();
                r.map(|r| r.amount()).ok()
            })
        })
        .collect();
    let got: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(got.iter().filter(|g| g.is_some()).count(), 1, "{:?}", got);
    assert_eq!(outstanding_bytes(), 0);
}

#[test]
fn a_transition_during_the_read_to_commit_window_waits() {
    // the read and the commit share one critical section: a release on
    // another thread waits until the paused admission has committed
    let _g = fresh(total_for_usable(100));
    let first = reserve("first", 40).unwrap();
    let b = Arc::new(Barrier::new(2));
    hooks::pause_next_admission(b.clone());
    let h = std::thread::spawn(move || reserve("paused", 50).map(|r| r.amount()).ok());
    b.wait(); // (the admission has read, holding the lock)
    let t = std::thread::spawn(move || drop(first));
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(!t.is_finished(), "the release must wait for the lock");
    b.wait();
    // 40 outstanding when it read: 40 + 50 = 90 <= 100
    assert_eq!(h.join().unwrap(), Some(50));
    t.join().unwrap();
}

#[test]
fn an_outer_exit_releases_what_remains_then_reports_it_as_internal() {
    let _g = fresh(total_for_usable(1000));
    let op = Operation::enter();
    let chain = op.chain();
    std::mem::forget(reserve("forgotten", 123).unwrap());
    let nested = Operation::enter();
    assert_eq!(nested.finish(), Ok(()));
    assert_eq!(chain_outstanding(chain), 123);
    match op.finish() {
        Err(EngineError::Internal(m)) => assert!(m.contains("123"), "{}", m),
        e => panic!("expected an internal error, got {:?}", e),
    }
    assert_eq!((outstanding_bytes(), current_chain()), (0, 0));
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
fn a_worker_joins_the_chain_without_taking_the_guard() {
    // (the guard is thread-bound, CORR-C1-2: compile_fail doctests on
    // Operation and Scope; a worker runs under the chain with with_chain)
    let _g = fresh(total_for_usable(1000));
    let op = Operation::enter();
    let chain = op.chain();
    std::thread::scope(|s| {
        s.spawn(|| {
            assert_eq!(current_chain(), 0);
            with_chain(chain, || {
                assert_eq!(current_chain(), chain);
                let r = reserve("worker", 300).unwrap();
                assert_eq!(chain_outstanding(chain), 300);
                drop(r);
            });
            assert_eq!(current_chain(), 0);
        });
    });
    assert_eq!(current_chain(), chain);
    assert_eq!(op.finish(), Ok(()));
    assert_eq!((outstanding_bytes(), current_chain()), (0, 0));
}

#[test]
fn an_observed_zero_refuses_and_no_total_is_nominal() {
    let _g = fresh(0);
    set_total(Some(Total { bytes: 0, status: TotalStatus::Zero, joint: false }));
    assert!(matches!(reserve("x", 1), Err(EngineError::Memory(r)) if r.allowance == 0 && r.status == TotalStatus::Zero));
    set_total(None);
    assert_eq!(total(), NOMINAL);
}

#[test]
fn an_unmeasured_platform_is_not_certified() {
    // fail-closed: no measure (no binding row, or one this build can't
    // read) means certified() is false
    let _g = fresh(total_for_usable(1000));
    #[cfg(not(target_arch = "wasm32"))]
    {
        set_total_and_measure(Some(Total { bytes: 1 << 30, status: TotalStatus::Observed, joint: true }), &[MeasureKind::WindowsJob]);
        assert!(!certified());
        set_total_and_measure(Some(Total { bytes: 1 << 30, status: TotalStatus::Observed, joint: true }), &[MeasureKind::Cgroup("/nonexistent/memory.current".into())]);
        assert!(!certified());
        if cfg!(target_os = "linux") {
            set_total_and_measure(Some(Total { bytes: 1 << 30, status: TotalStatus::Observed, joint: true }), &[MeasureKind::Physical]);
            assert!(certified());
            let r = state().measure.read().expect("the process's own measure");
            assert!(r.usage > 0 && r.available.unwrap() > 0, "{:?}", r);
        }
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
    for (b, s, j) in [(-1.0, 0, 0), (1.5, 0, 0), (f64::NAN, 0, 0), (f64::INFINITY, 0, 0), (1.0, 3, 0), (1.0, 0, 2), (1e300, 0, 0)] {
        assert_eq!(total_from_wasm(b, s, j), None, "{} {} {}", b, s, j);
    }
}

#[test]
fn proc_fields_parse_without_allocating() {
    let text = b"Name:\tx\nVmSize:\t  1234 kB\nRssAnon:\t 10 kB\nVmSwap:\t0 kB\n";
    assert_eq!(measure::kb_field(text, b"VmSize:"), Some(1234 * 1024));
    assert_eq!(measure::kb_field(text, b"RssAnon:"), Some(10 * 1024));
    assert_eq!(measure::kb_field(text, b"VmData:"), None);
    assert_eq!(measure::parse_uint(b"  4096\n"), Some(4096));
    assert_eq!(measure::parse_uint(b"none\n"), None);
}

#[test]
fn internal_errors_are_not_memory_errors() {
    let m = EngineError::Internal("x".into());
    assert!(!matches!(m, EngineError::Memory(_)));
    assert!(m.to_string().starts_with("internal error"));
}
