//! The hot-path refresh (C-2c-i, scope r3 section 1), with a host registered
//! like the Python one: an answer and its `may_ask` predicate together,
//! the answer's own first check being that predicate.  On a thread that may
//! not ask, the wrapper's refresh returns without touching the host or the
//! ledger; on the owner it is today's locked total().  Its own test binary:
//! the host is registered once per process.
// (with real pool threads: cargo test -p sagebrush-par --features parallel)
#![cfg(all(target_os = "linux", not(target_arch = "wasm32"), feature = "parallel"))]

use sagebrush_ledger::*;
use sagebrush_par::*;
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{mpsc, Mutex, Once};
use std::time::Duration;

thread_local! {
    /// this thread has an asking call (the Python host's ASKING > 0)
    static OWNER: Cell<bool> = const { Cell::new(false) };
}

/// the predicate, registered as may_ask AND called first by the answer
fn owner() -> bool {
    OWNER.with(|o| o.get())
}

static SOURCE: Mutex<Vec<String>> = Mutex::new(Vec::new());
static NOT_ASKED: AtomicUsize = AtomicUsize::new(0);
static SERIAL: Mutex<()> = Mutex::new(());
static REGISTER: Once = Once::new();

fn answer() -> HostAnswer {
    if !owner() {
        NOT_ASKED.fetch_add(1, SeqCst);
        return HostAnswer::NotAsked;
    }
    let who = std::thread::current().name().unwrap_or("?").to_string();
    SOURCE.lock().unwrap().push(who.clone());
    if who == "owner-b" {
        return HostAnswer::Unreadable;
    }
    let bytes = 1u64 << 40;
    HostAnswer::Total(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }, vec![Row { kind: MeasureKind::Physical, figure: bytes }])
}

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    REGISTER.call_once(|| set_total_host_asking(answer, owner));
    SOURCE.lock().unwrap().clear();
    NOT_ASKED.store(0, SeqCst);
    g
}

fn counts() -> (usize, usize) {
    (SOURCE.lock().unwrap().len(), NOT_ASKED.load(SeqCst))
}

/// (asked, reached the host)
type Probe = (bool, bool);

/// One refresh on a stale (None) total, here: whether it asked, and whether
/// it touched the host at all.  (may_ask and the answer must agree: asked
/// iff owner, and a non-owner never reaches the host from a refresh.)
fn probe() -> Probe {
    set_total(None);
    let (s0, n0) = counts();
    refresh_if_owner();
    let (s1, n1) = counts();
    (s1 > s0, s1 > s0 || n1 > n0)
}

#[test]
fn may_ask_and_the_answer_agree_at_every_depth_after_unwind_and_on_reused_workers() {
    let _g = setup();
    // depth 0: the owner asks; a plain thread with no asking call never
    // reaches the host
    OWNER.with(|o| o.set(true));
    assert_eq!(probe(), (true, true), "the owner asks");
    let plain = std::thread::spawn(probe).join().unwrap();
    assert_eq!(plain, (false, false), "a non-owner thread touches nothing");
    // depth 1 and deeper, on pool workers; then after an unwind on them; then
    // on a reused pool
    for round in 0..2 {
        let got: Vec<[Probe; 3]> = install(4, || {
            map_range(4, |_| {
                let d1 = probe();
                let d2 = map_range(2, |_| probe())[0];
                let unwound = std::panic::catch_unwind(|| map_range(2, |_| -> u8 { panic!("a worker failure") }));
                assert!(unwound.is_err());
                [d1, d2, probe()]
            })
        });
        assert!(got.iter().flatten().all(|&p| p == (false, false)), "round {}: {:?}", round, got);
    }
    // no worker refresh reached the host: every wrapper entry on a worker
    // returned before it (the old code asked and got NotAsked ~10^4 times)
    assert_eq!(NOT_ASKED.load(SeqCst), 0, "a worker refresh called the host");
    assert_eq!(probe(), (true, true), "and the owner still asks");
    OWNER.with(|o| o.set(false));
}

#[test]
fn a_stale_worker_refuses_a_protected_admission_and_the_owner_refreshes_once() {
    let _g = setup();
    OWNER.with(|o| o.set(true));
    let op = Operation::enter_certified().expect("certified at entry (the owner asked)");
    let asked_before = counts().0;
    let refused: Vec<bool> = install(4, || {
        map_range(4, |_| {
            // the total goes stale (past the 100 ms window) under the
            // workers; their nested entries don't refresh it (they never
            // reach the host), and their protected admission refuses
            std::thread::sleep(Duration::from_millis(150));
            let _ = map_range(2, |_| thread_scope(|sc| sc.spawn(|| 1).join().unwrap()));
            matches!(reserve("stale worker", 1), Err(EngineError::Memory(_)))
        })
    });
    assert!(refused.iter().all(|&r| r), "refused: {:?}", refused);
    assert_eq!(counts().0, asked_before, "a worker ran the source");
    assert_eq!(chain_outstanding(op.chain()), 0, "a refused admission allocated nothing");
    // back on the owner, with the total still stale: exactly one source call
    // refreshes it, and the owner admits
    let before = counts().0;
    assert!(reserve("owner", 1).is_ok());
    assert_eq!(counts().0, before + 1, "the owner asked exactly once");
    assert_eq!(op.finish(), Ok(()));
    OWNER.with(|o| o.set(false));
}

#[test]
fn an_owners_nested_entry_asks_after_another_owner_invalidated_with_no_later_admission() {
    // astra2's schedule: owner A refreshes (fresh); owner B, on another
    // thread, publishes Unreadable (the total is None); A's nested wrapper
    // entry on A's own thread then asks A's source, with no admission after
    let _g = setup();
    let (to_b, b_rx) = mpsc::channel::<()>();
    let (to_a, a_rx) = mpsc::channel::<()>();
    let a = std::thread::Builder::new()
        .name("owner-a".into())
        .spawn(move || {
            OWNER.with(|o| o.set(true));
            set_total(None);
            refresh_if_owner(); // A's source: fresh
            to_b.send(()).unwrap();
            a_rx.recv().unwrap(); // B has published None
            let _ = map_range(2, |i| i); // the nested entry, on A; no admission follows
        })
        .unwrap();
    let b = std::thread::Builder::new()
        .name("owner-b".into())
        .spawn(move || {
            OWNER.with(|o| o.set(true));
            b_rx.recv().unwrap();
            std::thread::sleep(Duration::from_millis(110)); // A's total is stale now
            refresh_if_owner(); // B's source: Unreadable, so None
            to_a.send(()).unwrap();
        })
        .unwrap();
    b.join().unwrap();
    a.join().unwrap();
    assert_eq!(*SOURCE.lock().unwrap(), vec!["owner-a", "owner-b", "owner-a"], "A's nested entry asked A's source");
    assert_eq!(NOT_ASKED.load(SeqCst), 0);
}

#[test]
fn the_owner_refresh_expires_with_the_unchanged_100_ms_window() {
    // (total() and its `>= 100 ms` staleness are unchanged; without a clock
    // hook this checks either side of the window, not the exact instant)
    let _g = setup();
    OWNER.with(|o| o.set(true));
    set_total(None);
    refresh_if_owner();
    assert_eq!(counts().0, 1, "a None total is asked at once");
    std::thread::sleep(Duration::from_millis(40));
    refresh_if_owner();
    assert_eq!(counts().0, 1, "inside the window: not asked again");
    std::thread::sleep(Duration::from_millis(80));
    refresh_if_owner();
    assert_eq!(counts().0, 2, "past the window: asked once more");
    OWNER.with(|o| o.set(false));
}
