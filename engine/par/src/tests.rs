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

#[test]
fn the_scope_body_runs_under_the_callers_context() {
    // astra2's probe: the root callback of a rayon scope may run on a pool
    // worker; it (a direct reservation, a nested wrapper) is the caller's
    let _g = setup();
    let op = Operation::enter();
    let c = op.chain();
    let (seen, held, nested) = scope(|_| (current_chain(), r(5), map_range(3, |_| r(1))));
    assert_eq!(seen, c, "the scope body saw the caller's chain");
    assert_eq!(chain_outstanding(c), 8, "a reservation in the scope body and a nested map_range are the caller's");
    drop((held, nested));
    // a panic in the body: the thread that ran it keeps its own context
    let _outer = Context { chain: 919, exclusive: false }.enter();
    let p = std::panic::catch_unwind(|| scope(|_| -> () { panic!("in the scope body") }));
    assert!(p.is_err());
    assert_eq!((current_chain(), is_exclusive()), (919, false));
    let seen: Vec<u64> = install(1, || scope(|_| vec![current_chain()]));
    assert_eq!(seen, vec![919], "a reused worker ran the next body under its caller's context");
    drop(_outer);
    op.finish().unwrap();
}

#[test]
fn every_spawn_takes_the_spawning_threads_context_at_the_spawn() {
    // astra2's probe and daybreak2's LIMIT-C2CI-2: a context entered between
    // the scope's construction and a spawn is the one the spawned closure
    // gets; an exclusive one makes the spawn run here, now
    let _g = setup();
    let _outer = Context { chain: 919, exclusive: false }.enter();
    // thread_scope, changed chain and mode: inline, on the caller, 929/exclusive
    let (child, me, after) = thread_scope(|sc| {
        let _inner = Context { chain: 929, exclusive: true }.enter();
        let child = sc.spawn(|| (current_chain(), is_exclusive(), std::thread::current().id())).join().unwrap();
        (child, std::thread::current().id(), Context::current())
    });
    assert_eq!(child, (929, true, me), "the spawn ran inline under the spawning context");
    assert_eq!(after, Context { chain: 929, exclusive: true });
    assert_eq!((current_chain(), is_exclusive()), (919, false), "the caller's context came back");
    // thread_scope, changed chain only: a real thread, charged to the new chain
    // (any chain id will do: the ledger attributes reservations to the current one)
    let op = 9393u64;
    let held = thread_scope(|sc| {
        let _inner = Context { chain: op, exclusive: false }.enter();
        let h = sc.spawn(|| (r(7), current_chain(), std::thread::current().id()));
        let (res, ch, _t) = h.join().unwrap();
        assert_eq!(ch, op);
        assert_eq!(current_chain(), op, "the spawning thread's context is unchanged by the spawn");
        res
    });
    assert_eq!(chain_outstanding(op), 7, "charged to the chain current at the spawn");
    drop(held);
    // rayon scope, changed chain and mode, nested spawns
    let out = Mutex::new(Vec::new());
    let out_ref = &out;
    scope(|s| {
        let body = std::thread::current().id();
        let _inner = Context { chain: 939, exclusive: true }.enter();
        s.spawn(move |s| {
            out_ref.lock().unwrap().push((current_chain(), is_exclusive(), std::thread::current().id() == body));
            let _deeper = Context { chain: 949, exclusive: false }.enter();
            s.spawn(move |_| out_ref.lock().unwrap().push((current_chain(), is_exclusive(), true)));
        });
    });
    let out = out.into_inner().unwrap();
    assert_eq!(out[0], (939, true, true), "exclusive at the spawn: inline, on the spawning thread");
    assert_eq!((out[1].0, out[1].1), (949, false), "a nested spawn takes the nested spawner's context");
    assert_eq!((current_chain(), is_exclusive()), (919, false));
}
