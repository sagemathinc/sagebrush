//! The prime_pi and primes ops of the JSON dispatcher: pi(x) for x given as a number or a decimal
//! string, the primes in a window, and their limits.
use serde_json::{json, Value};

fn call(req: Value) -> Value {
    serde_json::from_str(&sagebrush_web::call(&req.to_string())).unwrap()
}

#[test]
fn prime_pi_of_numbers_and_strings() {
    assert_eq!(call(json!({"fn": "prime_pi", "x": 0}))["ok"], json!(0));
    assert_eq!(call(json!({"fn": "prime_pi", "x": 100}))["ok"], json!(25));
    assert_eq!(call(json!({"fn": "prime_pi", "x": "10000000000"}))["ok"], json!(455052511u64));
    // 2^32 + 15 and 2^32 + 16, either side of the prime 2^32 + 15
    assert_eq!(call(json!({"fn": "prime_pi", "x": 4294967310u64}))["ok"], json!(203280221u64));
    assert_eq!(call(json!({"fn": "prime_pi", "x": 4294967311u64}))["ok"], json!(203280222u64));
}

#[test]
fn primes_in_a_window() {
    assert_eq!(call(json!({"fn": "primes", "start": 0, "stop": 30}))["ok"], json!([2, 3, 5, 7, 11, 13, 17, 19, 23, 29]));
    assert_eq!(call(json!({"fn": "primes", "start": 2, "stop": 3}))["ok"], json!([2]));
    assert_eq!(call(json!({"fn": "primes", "start": 24, "stop": 29}))["ok"], json!([]));
    // the largest primes below 2^53
    let r = call(json!({"fn": "primes", "start": 9007199254740800u64, "stop": 9007199254740992u64}));
    let v = r["ok"].as_array().unwrap();
    assert_eq!(v.last().unwrap(), &json!(9007199254740881u64));
}

#[test]
fn prime_pi_and_primes_refuse_bad_requests() {
    for req in [
        json!({"fn": "prime_pi"}),
        json!({"fn": "prime_pi", "x": "10000000000000001"}),
        json!({"fn": "prime_pi", "x": " 10"}),
        // (Rust's parse would take a leading +; the digits-only check refuses it)
        json!({"fn": "prime_pi", "x": "+5"}),
        json!({"fn": "prime_pi", "x": ""}),
        json!({"fn": "prime_pi", "x": [10]}),
        json!({"fn": "primes", "start": 0, "stop": (1u64 << 24) + 1}),
        json!({"fn": "primes", "start": 0, "stop": (1u64 << 53) + 1}),
        json!({"fn": "primes", "start": 0.5, "stop": 10}),
    ] {
        let r = call(req.clone());
        assert!(r.get("error").is_some(), "{req}: {r}");
    }
}
