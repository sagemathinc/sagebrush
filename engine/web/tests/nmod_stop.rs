//! Stop during nmod_charpoly's largest admitted request, in its own test
//! binary (the request flag is process-wide).

#[test]
fn nmod_charpoly_stops() {
    let n = sagebrush_web::NMOD_MAX_N;
    let m = vec![vec!["0"; n].join(","); n].join(";");
    let req = format!(r#"{{"fn":"nmod_charpoly","m":"{}","p":"7"}}"#, m);
    sagebrush_interrupt::request();
    let r = sagebrush_interrupt::catch(|| sagebrush_web::call(&req));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "stopped at the first row");
    // and the next call works
    let ok = sagebrush_web::call(r#"{"fn":"nmod_charpoly","m":"1,2;3,4","p":"7","wire":"csv"}"#);
    assert!(ok.contains("\"5,2,1\""), "{}", ok);
}
