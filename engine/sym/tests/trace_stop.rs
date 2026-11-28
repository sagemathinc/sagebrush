// A Stop during integrate_steps leaves tracing off: later ordinary
// integrations retain nothing (A12-F1: tracing stayed on, and each later
// call kept its step tree).  A test binary of its own: it counts the
// process's allocations and requests the process-wide Stop.
use sagebrush_interrupt as stop;
use sagebrush_sym::{integrate, parse};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering::Relaxed};

static LIVE: AtomicIsize = AtomicIsize::new(0);
struct Count;

// SAFETY: each method forwards to System with the caller's arguments and
// only adds the sizes System allocated or released to LIVE.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size() as isize, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size() as isize, Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = System.realloc(p, l, n);
        if !q.is_null() {
            LIVE.fetch_add(n as isize - l.size() as isize, Relaxed);
        }
        q
    }
}

#[global_allocator]
static A: Count = Count;

fn batch(f: &sagebrush_sym::Expr, n: usize) {
    for _ in 0..n {
        assert!(integrate::integrate(f, "x").is_some());
    }
}

#[test]
fn a_stopped_traced_integration_leaves_tracing_off() {
    let f = parse("x");
    stop::clear();
    batch(&f, 10);
    let a = LIVE.load(Relaxed);
    batch(&f, 1000);
    assert_eq!(LIVE.load(Relaxed), a, "ordinary calls retain nothing");
    stop::request();
    let r = stop::catch(|| integrate::integrate_steps(&f, "x"));
    stop::clear();
    assert!(r.is_err(), "the Stop unwound the traced call");
    // (warm again: the unwind may have dropped caches; then the same check)
    batch(&f, 10);
    let b = LIVE.load(Relaxed);
    batch(&f, 1000);
    assert_eq!(LIVE.load(Relaxed), b, "after a stopped trace, ordinary calls still retain nothing");
    // and a traced call still gives its answer and steps
    assert!(integrate::integrate_steps(&f, "x").is_some());
}
