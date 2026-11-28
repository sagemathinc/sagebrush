//! A sieve bound past the memory allowance is refused before the sieve is
//! built (A09b: on wasm32 a bound of 2^32 + 5 was truncated to 5 and the
//! sieve indexed past its end), and a small one still answers.

#[test]
fn aplist_bound_refused_before_the_sieve() {
    for f in ["aplist", "moments"] {
        let r = sagebrush_web::call(&format!(r#"{{"fn":"{}","a":[0,0,0,-1,0],"n":4611686018427387904}}"#, f));
        assert!(r.contains("refused") || r.contains("address space"), "{}: {}", f, r);
    }
    let r = sagebrush_web::call(r#"{"fn":"aplist_many","curves":[[0,0,0,-1,0]],"n":4611686018427387904}"#);
    assert!(r.contains("refused") || r.contains("address space") || r.contains("error"), "{}", r);
    let ok = sagebrush_web::call(r#"{"fn":"aplist","a":[0,0,0,-1,0],"n":13}"#);
    assert!(ok.contains("[13,6]") || ok.contains("[13, 6]"), "{}", ok);
}
