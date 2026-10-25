// The ledger's admission, ownership and exit rules (plan C r13).  The tests
// share the process-wide state, so each takes SERIAL and starts from a clean
// ledger; the usage measures are fakes (hooks::set_fake_usage, set_fake_rows), read under
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
    set_total(Some(Total { bytes: total_bytes, status: TotalStatus::Observed, joint: false, uncertified: false }));
    g
}

/// E = total / 4 and phi = FRAG_NUM / FRAG_DEN (21/8): a total of 4 phi n
/// gives exactly n usable bytes when n is a multiple of FRAG_DEN (then E is
/// exact), which every test's figure is.
fn total_for_usable(n: u64) -> u64 {
    assert_eq!(n % FRAG_DEN, 0, "usable figures are multiples of FRAG_DEN");
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
    // check reads 200 (no cached measure).
    let _g = fresh(total_for_usable(256));
    hooks::set_fake_usage(Some((100, None)));
    let r = reserve("work", 100).unwrap();
    hooks::set_fake_usage(Some((200, None))); // (grown, and retained after the free)
    drop(r);
    match reserve("next", 57) {
        Err(EngineError::Memory(r)) => assert_eq!(r.live, 200),
        _ => panic!("200 + 57 > 256 must be refused"),
    }
    assert!(reserve("next", 56).is_ok());
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
    // 30 in use: one 50 fits (80 <= 104), both don't (130 > 104)
    let _g = fresh(total_for_usable(104));
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
    let _g = fresh(total_for_usable(96));
    let first = reserve("first", 40).unwrap();
    let b = Arc::new(Barrier::new(2));
    hooks::pause_next_admission(b.clone());
    let h = std::thread::spawn(move || reserve("paused", 50).map(|r| r.amount()).ok());
    b.wait(); // (the admission has read, holding the lock)
    let t = std::thread::spawn(move || drop(first));
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(!t.is_finished(), "the release must wait for the lock");
    b.wait();
    // 40 outstanding when it read: 40 + 50 = 90 <= 96
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
fn an_observed_zero_refuses_and_no_total_is_nominal() {
    let _g = fresh(0);
    set_total(Some(Total { bytes: 0, status: TotalStatus::Zero, joint: false, uncertified: false }));
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
        let t = Some(Total { bytes: 1 << 30, status: TotalStatus::Observed, joint: true, uncertified: false });
        let row = |kind| Row { kind, figure: 1 << 30 };
        set_total_and_measure(t, &[row(MeasureKind::WindowsJob)]);
        assert!(!certified());
        set_total_and_measure(t, &[row(MeasureKind::Cgroup("/nonexistent/memory.current".into()))]);
        assert!(!certified());
        if cfg!(target_os = "linux") {
            set_total_and_measure(t, &[row(MeasureKind::Physical)]);
            assert!(certified());
            let mut seen = vec![];
            assert!(state().measure.read_each(|r| seen.push(r)), "the process's own measure");
            assert!(seen.len() == 1 && seen[0].usage > 0 && seen[0].available.unwrap() > 0, "{:?}", seen);
            // (C r17 section 1.2: one unknown row among measured ones is
            // enough to fail closed)
            set_total_and_measure(t, &[row(MeasureKind::Physical), row(MeasureKind::Unknown)]);
            assert!(!certified());
            set_total_and_measure(t, &[row(MeasureKind::Physical), Row { kind: MeasureKind::AddressSpace, figure: 1 << 40 }]);
            assert!(certified());
            let mut n = 0;
            assert!(state().measure.read_each(|r| n += (r.figure == 1 << 40) as u32));
            assert_eq!(n, 1, "each row is read with its own figure");
        }
    }
}

#[test]
fn a_credit_grows_by_new_admissions() {
    let _g = fresh(total_for_usable(104));
    let mut c = reserve("credit", 64).unwrap();
    assert!(c.grow("credit", 40).is_ok());
    assert_eq!((c.amount(), outstanding_bytes()), (104, 104));
    assert!(c.grow("credit", 1).is_err());
    drop(c);
    assert_eq!(outstanding_bytes(), 0);
}

#[test]
fn wasm_totals_are_checked() {
    // (the third number is now the host's classification, C r17 section
    // 1.3: 1 when some applicable row is joint or unknown)
    assert_eq!(total_from_wasm(4294967296.0, 0, 1), Some(Total { bytes: 1 << 32, status: TotalStatus::Observed, joint: true, uncertified: true }));
    assert_eq!(total_from_wasm(4294967296.0, 0, 0).map(|t| t.uncertified), Some(false));
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

#[test]
fn every_applicable_row_is_checked_not_only_the_least() {
    // astra2's probe (C r17 section 1.1), natively: the least figure is 4 GiB
    // (here 256 MiB used), a larger joint row is 8 GiB (2304 MiB used).  With
    // phi = 21/8, 32 MiB fits the least row (21/8 (256 + 32) = 756 <= 1024
    // MiB) but not the joint one (21/8 (2304 + 32) > 2048 MiB): refused, on
    // the joint row's figures.
    const MIB: u64 = 1 << 20;
    let _g = fresh(4096 * MIB);
    hooks::set_fake_rows(Some(vec![(4096 * MIB, 256 * MIB, None), (8192 * MIB, 2304 * MIB, None)]));
    match reserve("probe", 32 * MIB) {
        Err(EngineError::Memory(r)) => assert_eq!((r.total, r.allowance, r.live), (8192 * MIB, 2048 * MIB, 2304 * MIB)),
        other => panic!("the joint row must refuse: {:?}", other.map(|r| r.amount())),
    }
    assert_eq!(outstanding_bytes(), 0);
    // the least row alone (what a check of the least rows only would see)
    // admits it: the difference this test pins
    hooks::set_fake_rows(Some(vec![(4096 * MIB, 256 * MIB, None)]));
    let r = reserve("probe", 32 * MIB).unwrap();
    drop(r);
    // the order of the rows doesn't matter; the first refusing row is reported
    hooks::set_fake_rows(Some(vec![(8192 * MIB, 2304 * MIB, None), (4096 * MIB, 256 * MIB, None)]));
    assert!(matches!(reserve("probe", 32 * MIB), Err(EngineError::Memory(r)) if r.total == 8192 * MIB));
}

#[test]
fn a_physical_row_among_others_keeps_its_availability_check() {
    const MIB: u64 = 1 << 20;
    let _g = fresh(1 << 40);
    let avail = 1024 * MIB; // reserve 256 + 103 MiB: room about 665 MiB
    hooks::set_fake_rows(Some(vec![(1 << 40, 0, None), (1 << 40, 0, Some(avail))]));
    assert!(matches!(reserve("big", 700 * MIB), Err(EngineError::Memory(r)) if r.available.is_some()));
    let r = reserve("ok", 600 * MIB).unwrap();
    drop(r);
}
