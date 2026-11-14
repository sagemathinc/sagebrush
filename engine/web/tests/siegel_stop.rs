//! Stop during a siegel call at its caps (2^16 values of Z near 10^8), in its own test binary (the request flag
//! is process-wide): the call is interrupted between values, and the next call works.

#[test]
fn siegel_stops() {
    let ts = vec!["1e8"; 1 << 16].join(",");
    let req = format!(r#"{{"fn":"siegel","t":[{ts}]}}"#);
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| sagebrush_web::call(&req));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "Stop was not seen in siegel's loop");
    let ok = sagebrush_web::call(r#"{"fn":"siegel","t":[100]}"#);
    assert!(ok.starts_with(r#"{"ok":[2.69"#), "{}", ok);
}
