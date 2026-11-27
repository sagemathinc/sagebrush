//! A session's Stop (with_session_stop): a call stops on its own session's flag only; the flag is cleared
//! on entry (an idle or late request is not the call's); another session's flag is never read or cleared;
//! the previous session is restored on return and on unwind; the process-wide request is untouched.
use sagebrush_interrupt::{catch, check, requested, with_session_stop};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Arc;

#[test]
fn a_session_stops_on_its_own_flag_only() {
    let mine = Arc::new(AtomicBool::new(true)); // an idle request, before the call
    let other = Arc::new(AtomicBool::new(true));
    // cleared on entry: the idle request doesn't stop the call
    let r = catch(|| with_session_stop(mine.clone(), || { check(); 1 }));
    assert_eq!(r.ok(), Some(1));
    // set during the call: it stops; the other session's flag is neither read nor cleared
    let m2 = mine.clone();
    let r = catch(|| with_session_stop(mine.clone(), move || { m2.store(true, Relaxed); check(); 2 }));
    assert!(r.is_err());
    assert!(other.load(Relaxed));
    // after the unwind, no session: checks outside a call see neither flag
    assert!(!requested());
    check();
    // nested: the inner session's flag stops the inner call; the outer is restored after it
    let outer = Arc::new(AtomicBool::new(false));
    let o2 = outer.clone();
    let r = catch(|| with_session_stop(outer.clone(), move || {
        let inner = Arc::new(AtomicBool::new(false));
        let i2 = inner.clone();
        let x = catch(|| with_session_stop(inner, move || { i2.store(true, Relaxed); check(); 0 }));
        assert!(x.is_err());
        check(); // the outer's flag is clear: goes on
        o2.store(true, Relaxed);
        requested()
    }));
    assert_eq!(r.ok(), Some(true));
}
