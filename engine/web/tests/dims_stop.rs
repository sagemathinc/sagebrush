//! A pending Stop interrupts dims at small valid levels (its scans over the
//! level poll), in its own test binary (the request flag is process-wide).

#[test]
fn dims_stops() {
    for n in [11, 42, 101] {
        let req = format!(r#"{{"fn":"dims","n":{},"k":2}}"#, n);
        sagebrush_interrupt::request();
        let r = sagebrush_interrupt::catch(|| sagebrush_web::call(&req));
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "level {}: stopped", n);
    }
    // and the next call works: S_2(Gamma0(11)) and its new part, dimension 1
    let ok = sagebrush_web::call(r#"{"fn":"dims","n":11,"k":2}"#);
    assert!(ok.contains("\"cusp\":1") && ok.contains("\"new\":1"), "{}", ok);
}
