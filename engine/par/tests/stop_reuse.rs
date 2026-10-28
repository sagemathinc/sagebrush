//! One-thread worker reuse after a Stop and after a panic (no-cliffs C-2c
//! scope r2 section 1.6; daybreak2's TEST-C2CI-3): after the unwind, the
//! caller changes its context, and the reused worker's next closures see
//! exactly that context; no chain or exclusive flag leaks, and the worker
//! has no asking authority (a source call off the owner is recorded and
//! fails the test).  Its own test binary: the host is registered once per
//! process.
// (with real pool threads: cargo test -p sagebrush-par --features parallel)
#![cfg(all(not(target_arch = "wasm32"), feature = "parallel"))]

use sagebrush_ledger::*;
use sagebrush_par::*;
use std::cell::Cell;
use std::sync::Mutex;
use std::thread::ThreadId;

thread_local! {
    /// this thread is the asking owner
    static OWNER: Cell<bool> = const { Cell::new(false) };
}

static SOURCE_RAN_ON: Mutex<Vec<ThreadId>> = Mutex::new(Vec::new());

fn answer() -> HostAnswer {
    if !OWNER.with(|o| o.get()) {
        return HostAnswer::NotAsked;
    }
    SOURCE_RAN_ON.lock().unwrap().push(std::thread::current().id());
    // (unreadable: the total stays stale, so every read on an owner asks again)
    HostAnswer::Unreadable
}

/// The worker's closures' identities, and an attempted refresh there (no
/// authority: NotAsked, no source call).
fn probe() -> Vec<(u64, bool, ThreadId)> {
    map_range(4, |_| {
        refresh_if_owner();
        (current_chain(), is_exclusive(), std::thread::current().id())
    })
}

#[test]
fn a_reused_worker_after_stop_and_after_panic_sees_exactly_its_callers_new_context() {
    set_total_host(answer);
    OWNER.with(|o| o.set(true));
    let me = std::thread::current().id();
    let _a = Context { chain: 101, exclusive: false }.enter();
    let worker = install(1, || {
        let w = std::thread::current().id();
        // a Stop in a closure on the one worker
        sagebrush_interrupt::request();
        let stopped = sagebrush_interrupt::catch(|| map_range(2, |_| sagebrush_interrupt::check()));
        sagebrush_interrupt::clear();
        assert!(stopped.is_err(), "the closure was stopped");
        assert_eq!((current_chain(), is_exclusive()), (101, false), "the worker's own context after the Stop");
        // the caller changes context: the reused worker sees exactly the new one
        {
            let _b = Context { chain: 202, exclusive: false }.enter();
            let seen = probe();
            assert!(seen.iter().all(|&s| s == (202, false, w)), "after the Stop: {:?}", seen);
        }
        // a panic in a closure, then another change
        let panicked = std::panic::catch_unwind(|| map_range(2, |i| if i == 0 { panic!("worker") } else { 0 }));
        assert!(panicked.is_err());
        {
            let _c = Context { chain: 303, exclusive: true }.enter();
            let seen = probe();
            assert!(seen.iter().all(|&s| s == (303, true, w)), "after the panic: {:?}", seen);
        }
        assert_eq!((current_chain(), is_exclusive()), (101, false), "nothing leaked into the worker");
        w
    });
    assert_ne!(worker, me, "the closures ran on the pool's worker");
    assert_eq!((current_chain(), is_exclusive()), (101, false));
    let ran = SOURCE_RAN_ON.lock().unwrap().clone();
    assert!(ran.iter().all(|&t| t == me), "the worker had no asking authority: the source ran on {:?} (owner {:?})", ran, me);
}
