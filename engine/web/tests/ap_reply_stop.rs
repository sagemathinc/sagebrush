//! A Stop unwinding through a native call() releases the a_p lists' held
//! reservations (a drop guard). (A file of its own: the Stop request is
//! process-wide.)

/// A Stop unwinding through a native call() releases the reply's holds
/// too (a drop guard), so no stale reservation stays charged.
#[test]
fn a_stop_releases_the_holds() {
    let held = sagebrush_web::sb_outstanding_bytes();
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| sagebrush_web::call(r#"{"fn":"aplist","a":[0,0,0,-1,0],"n":100000}"#));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "stopped");
    assert_eq!(sagebrush_web::sb_outstanding_bytes(), held, "released after the unwind");
}
