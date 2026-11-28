// factor_integer's memory refusal (the quadratic sieve's reservation, refused
// by the memory ledger) is the typed "memory" reply, never a factorization by
// another route; admitted, the factors.  (A test binary of its own: the
// ledger's total is process-wide.)
use sagebrush_ledger::{set_total, Total, TotalStatus};
use serde_json::Value;

fn total(bytes: u64) {
    set_total(Some(Total { bytes, status: TotalStatus::Observed, joint: false, uncertified: false }));
}

#[test]
fn a_refused_sieve_is_the_memory_reply() {
    // (2^50 - 27)(2^50 - 35): in the sieve's range, beyond rho
    let req = r#"{"fn": "factor_integer", "n": "1267650600228159595702478963633"}"#;
    total(1 << 40);
    let ok: Value = serde_json::from_str(&sagebrush_web::call(req)).unwrap();
    assert_eq!(ok["ok"], serde_json::json!([["1125899906842589", 1], ["1125899906842597", 1]]), "{}", ok);
    total(1 << 16);
    let r: Value = serde_json::from_str(&sagebrush_web::call(req)).unwrap();
    assert_eq!(r["memory"]["what"], "the quadratic sieve", "{}", r);
    assert!(r.get("ok").is_none() && r.get("error").is_none(), "{}", r);
    // the next call starts clean: an error is an error again
    let e: Value = serde_json::from_str(&sagebrush_web::call(r#"{"fn": "factor_integer"}"#)).unwrap();
    assert!(e.get("error").is_some() && e.get("memory").is_none(), "{}", e);
    total(1 << 40);
}
