// The wrapper's contract (C-2c scope r2 section 1.6): a reservation made in
// any closure is charged to the caller's chain; a closure's context is
// restored afterwards, also after a panic; in exclusive mode everything runs
// on the calling thread, in order.  The ledger is process-wide, so the tests
// take SERIAL.
use super::*;
use sagebrush_ledger::{chain_outstanding, current_chain, is_exclusive, reserve, set_total, Operation, Reservation, Total, TotalStatus};
use std::sync::Mutex;

static SERIAL: Mutex<()> = Mutex::new(());

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    set_total(Some(Total { bytes: 1 << 40, status: TotalStatus::Observed, joint: false, uncertified: false }));
    g
}

fn r(x: u64) -> Reservation {
    reserve("par test", x).unwrap()
}

#[test]
fn every_primitive_charges_the_callers_chain() {
    let _g = setup();
    let op = Operation::enter();
    let c = op.chain();
    assert_ne!(c, 0);
    let held: Vec<Reservation> = map_range(8, |_| r(10));
    assert_eq!(chain_outstanding(c), 80, "map_range");
    drop(held);
    let xs = [1u64, 2, 3];
    let held: Vec<Reservation> = map_slice(&xs, |&x| r(x));
    assert_eq!(chain_outstanding(c), 6, "map_slice");
    drop(held);
    let mut slots: Vec<Option<Reservation>> = (0..4).map(|_| None).collect();
    for_each_mut(&mut slots, |_, s| *s = Some(r(5)));
    assert_eq!(chain_outstanding(c), 20, "for_each_mut");
    for_each_chunk_mut(&mut slots, 2, |_, ch| ch.iter_mut().for_each(|s| *s = Some(r(1))));
    assert_eq!(chain_outstanding(c), 4, "for_each_chunk_mut");
    drop(slots);
    // join nested in map_range
    let held: Vec<(Reservation, Reservation)> = map_range(3, |_| join(|| r(2), || r(3)));
    assert_eq!(chain_outstanding(c), 15, "join in map_range");
    drop(held);
    // scope with spawns three deep
    let out = Mutex::new(Vec::new());
    scope(|s| {
        s.spawn(|s| {
            out.lock().unwrap().push(r(1));
            s.spawn(|s| {
                out.lock().unwrap().push(r(1));
                s.spawn(|_| out.lock().unwrap().push(r(1)));
            });
        });
    });
    assert_eq!(chain_outstanding(c), 3, "scope, nested spawns");
    drop(out);
    // thread_scope with a spawn inside a spawned thread's thread_scope
    let held: Vec<Reservation> = thread_scope(|sc| {
        let hs: Vec<_> = (0..3)
            .map(|_| sc.spawn(|| thread_scope(|sc2| sc2.spawn(|| r(7)).join().unwrap())))
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(chain_outstanding(c), 21, "thread_scope, nested");
    drop(held);
    let held = install(2, || map_range(4, |_| r(1)));
    assert_eq!(chain_outstanding(c), 4, "install");
    drop(held);
    assert_eq!(chain_outstanding(c), 0);
    op.finish().unwrap();
}

#[test]
fn a_closure_context_is_restored_also_after_a_panic() {
    let _g = setup();
    let _outer = Context { chain: 5, exclusive: false }.enter();
    let inner = Context { chain: 9, exclusive: true }.enter();
    assert_eq!((current_chain(), is_exclusive()), (9, true));
    drop(inner);
    assert_eq!((current_chain(), is_exclusive()), (5, false));
    let p = std::panic::catch_unwind(|| {
        let _g = Context { chain: 9, exclusive: true }.enter();
        panic!("in a closure");
    });
    assert!(p.is_err());
    assert_eq!((current_chain(), is_exclusive()), (5, false), "restored after the panic");
    // a pool of one thread: after a panicking closure, the next closure on
    // that worker sees its own context
    install(1, || {
        let caught = std::panic::catch_unwind(|| map_range(2, |i| if i == 0 { panic!("worker") } else { 0 }));
        assert!(caught.is_err());
        let seen = map_range(4, |_| (current_chain(), is_exclusive()));
        assert!(seen.iter().all(|&s| s == (5, false)), "{:?}", seen);
    });
    assert_eq!((current_chain(), is_exclusive()), (5, false));
}

#[test]
fn in_exclusive_mode_everything_runs_on_the_calling_thread_in_order() {
    let _g = setup();
    let _x = Context { chain: 11, exclusive: true }.enter();
    let me = std::thread::current().id();
    let seen = map_range(16, |i| (i, std::thread::current().id(), current_chain()));
    assert!(seen.iter().enumerate().all(|(k, &(i, t, c))| k == i && t == me && c == 11));
    let order = Mutex::new(Vec::new());
    scope(|s| {
        for i in 0..4 {
            let order = &order;
            s.spawn(move |_| order.lock().unwrap().push((i, std::thread::current().id())));
        }
    });
    let order = order.into_inner().unwrap();
    assert_eq!(order.iter().map(|&(i, _)| i).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
    assert!(order.iter().all(|&(_, t)| t == me));
    let ts = thread_scope(|sc| sc.spawn(|| std::thread::current().id()).join().unwrap());
    assert_eq!(ts, me);
    assert_eq!(install(4, || std::thread::current().id()), me);
    let (a, b) = join(|| std::thread::current().id(), || std::thread::current().id());
    assert_eq!((a, b), (me, me));
}
