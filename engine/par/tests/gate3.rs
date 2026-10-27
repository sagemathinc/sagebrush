//! Gate 3 (no-cliffs C-2c scope r2 section 2), with a host like the Python
//! one: only the asking owner thread may run the source; any other thread's
//! read is NotAsked (the total in force, its age unchanged).  The wrapper
//! hands work out after refreshing on the owner, and a nested worker never
//! asks: after the freshness window, its protected admission refuses before
//! allocating.  Its own test binary: the host is registered once per process.
// (with real pool threads: cargo test -p sagebrush-par --features parallel)
#![cfg(all(target_os = "linux", not(target_arch = "wasm32"), feature = "parallel"))]

use sagebrush_ledger::*;
use sagebrush_par::*;
use std::cell::Cell;
use std::sync::Mutex;
use std::thread::ThreadId;
use std::time::Duration;

thread_local! {
    /// this thread is the asking owner (the Python host: an asking call is
    /// active on it)
    static OWNER: Cell<bool> = const { Cell::new(false) };
}

/// the threads the source ran on
static SOURCE_RAN_ON: Mutex<Vec<ThreadId>> = Mutex::new(Vec::new());

fn answer() -> HostAnswer {
    if !OWNER.with(|o| o.get()) {
        return HostAnswer::NotAsked;
    }
    SOURCE_RAN_ON.lock().unwrap().push(std::thread::current().id());
    let bytes = 1u64 << 40;
    HostAnswer::Total(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }, vec![Row { kind: MeasureKind::Physical, figure: bytes }])
}

fn ms(n: u64) {
    std::thread::sleep(Duration::from_millis(n));
}

#[test]
fn only_the_owner_asks_and_a_nested_worker_refuses_a_stale_protected_admission() {
    set_total_host(answer);
    OWNER.with(|o| o.set(true));
    let me = std::thread::current().id();
    let op = Operation::enter_certified().expect("certified at entry (the owner asked)");

    // just below the window: the owner's handoff refreshes (the total is
    // stale first), so a worker 30 ms later admits, in nested entries of
    // every kind
    ms(110);
    let fresh: Vec<bool> = install(4, || {
        map_range(4, |_| {
            ms(30);
            let (a, b) = join(|| reserve("join", 1).is_ok(), || thread_scope(|sc| sc.spawn(|| reserve("thread_scope", 1).is_ok()).join().unwrap()));
            let c = std::sync::atomic::AtomicBool::new(false);
            scope(|s| s.spawn(|_| c.store(reserve("scope", 1).is_ok(), std::sync::atomic::Ordering::SeqCst)));
            a && b && c.into_inner()
        })
    });
    assert!(fresh.iter().all(|&ok| ok), "admitted inside the window: {:?}", fresh);

    // at and past the window: nested workers never ask; their protected
    // admissions refuse (a typed memory refusal, before allocating)
    ms(110);
    let stale: Vec<bool> = install(4, || {
        map_range(4, |_| {
            ms(150);
            let nested = thread_scope(|sc| sc.spawn(|| matches!(reserve("stale", 1), Err(EngineError::Memory(_)))).join().unwrap());
            let here = matches!(reserve("stale", 1), Err(EngineError::Memory(_)));
            nested && here
        })
    });
    assert!(stale.iter().all(|&refused| refused), "refused past the window: {:?}", stale);
    assert_eq!(chain_outstanding(op.chain()), 0, "nothing was allocated by a refused admission");

    // the source ran on the owner only, never on a worker
    let ran = SOURCE_RAN_ON.lock().unwrap().clone();
    assert!(!ran.is_empty() && ran.iter().all(|&t| t == me), "the source ran off the owner: {:?} (owner {:?})", ran, me);

    // back on the owner: its read asks again, and admits
    assert!(reserve("owner", 1).is_ok());
    assert_eq!(op.finish(), Ok(()));
}
