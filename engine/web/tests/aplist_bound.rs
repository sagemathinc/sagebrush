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

/// The result is reserved with the sieve: 2000 curves to 10^7 need about
/// 223 GB of entries and JSON (664,579 primes each), refused before any
/// a_p is computed, though the sieve alone (about 10 MB) would fit.
#[test]
fn aplist_many_result_refused_before_the_work() {
    let curves = vec!["[0,0,0,-1,0]"; 2000].join(",");
    let t = std::time::Instant::now();
    let r = sagebrush_web::call(&format!(r#"{{"fn":"aplist_many","curves":[{}],"n":10000000}}"#, curves));
    assert!(r.contains("refused"), "{}", &r[..r.len().min(300)]);
    assert!(t.elapsed().as_secs() < 30, "refused up front");
}
