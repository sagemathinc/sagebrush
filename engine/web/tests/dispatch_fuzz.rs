//! Invalid requests to the JSON dispatcher are errors, never panics (a
//! panic is a PanicException in Python and kills the WebAssembly instance):
//! each argument of a valid request is replaced in turn by malformed
//! values, and the session must stay usable afterwards (audit F7).

use serde_json::{json, Value};

fn requests() -> Vec<Value> {
    vec![
        json!({"fn": "perm_group", "n": 4, "gens": [[1, 2, 3, 0]], "what": ["order", "orbit"], "point": 0}),
        json!({"fn": "perm_group_named", "n": 4, "name": "symmetric"}),
        json!({"fn": "perm_group_named", "n": 7, "name": "psl2"}),
        json!({"fn": "characters", "n": 15}),
        json!({"fn": "dims", "n": 15, "k": 2, "chi": [2, [11, 7], [1, 0]]}),
        json!({"fn": "charpoly", "n": 11, "k": 2, "q": 2, "chi": null}),
        json!({"fn": "charpoly_mod", "n": 11, "k": 2, "q": 2}),
        json!({"fn": "hecke_charpoly", "n": 11, "q": 2}),
        json!({"fn": "weight2", "n": 11, "q": 2}),
        json!({"fn": "batch_exact", "levels": [11, 14], "q": 2}),
        json!({"fn": "level_data", "n": 11}),
        json!({"fn": "commute", "n": 11, "q": 2, "r": 3}),
        json!({"fn": "estimate", "n": 11, "q": 2}),
        json!({"fn": "estimate_newforms", "n": 11, "k": 2, "bound": 10}),
        json!({"fn": "rational_newforms", "n": 11, "bound": 20}),
        json!({"fn": "factor_integer", "n": "60"}),
        json!({"fn": "is_prime", "n": "7"}),
        json!({"fn": "nf_data", "f": [2, 0, 1]}),
        json!({"fn": "primes_above", "f": [2, 0, 1], "p": 3}),
        json!({"fn": "bnf", "f": [5, 0, 1]}),
        json!({"fn": "bnf_relations", "f": [5, 0, 1], "extra": [7]}),
        json!({"fn": "quadratic_class_group", "d": "-20"}),
        json!({"fn": "hermite_form", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "elementary_divisors", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "lll", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "complex_roots", "f": [2, 0, 1], "digits": 10}),
        json!({"fn": "factor_mod", "f": [2, 0, 1], "p": 7}),
        json!({"fn": "galois_group", "f": [2, 0, 0, 1], "proof": true}),
        json!({"fn": "transitive_group", "n": 4, "k": 2}),
        json!({"fn": "factor", "f": [-1, 0, 1]}),
        json!({"fn": "mat_det", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "mat_rank", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "mat_rref", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "mat_solve", "a": [[1, 2], [3, 4]], "b": [[1], [2]]}),
        json!({"fn": "mat_inverse", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "mat_charpoly", "m": [[1, 2], [3, 4]]}),
        json!({"fn": "mat_kernel", "m": [[1, 2], [2, 4]]}),
        json!({"fn": "mat_mul", "a": [[1, 2], [3, 4]], "b": [[1], [2]]}),
        json!({"fn": "poly_mul", "a": [1, 1], "b": [1, -1]}),
        json!({"fn": "poly_gcd", "a": [1, 1], "b": [1, -1]}),
        json!({"fn": "poly_divexact", "a": [-1, 0, 1], "b": [1, 1]}),
        json!({"fn": "newspace", "n": 11, "k": 2}),
        json!({"fn": "newforms", "n": 11, "k": 2, "bound": 10}),
        json!({"fn": "ap", "a": [0, -1, 1, -10, -20], "p": 5}),
        json!({"fn": "aplist", "a": [0, -1, 1, -10, -20], "n": 30}),
        json!({"fn": "ec_point_search", "b": ["-4", "-40", "-79"], "rmax": 10, "smax": 4}),
        json!({"fn": "quartic_search", "I": "48", "J": "-432", "max_cost": 1000}),
        json!({"fn": "aplist_many", "curves": [[0, -1, 1, -10, -20]], "n": 30}),
        json!({"fn": "moments", "a": [0, -1, 1, -10, -20], "n": 30, "kmax": 2}),
    ]
}

fn bad_values() -> Vec<Value> {
    vec![
        json!(0),
        json!(1),
        json!(-1),
        json!(3),
        json!(4),
        json!(9),
        json!(1.5),
        json!(""),
        json!("x"),
        json!(","),
        json!(";"),
        json!([]),
        json!([[]]),
        json!([0]),
        json!([1]),
        json!([0, 0]),
        json!([[1, 2], [3]]),
        json!([[1, 2]]),
        json!([[0, 0], [0, 0]]),
        json!(["a"]),
        json!([1, [], []]),
        json!([2, [3], [1, 2]]),
        json!([2, [3, 5], [1]]),
        json!([0, [2], [0]]),
        json!([[1, 2, 3, 4]]),
        json!([[4, 0, 1, 2]]),
        json!({}),
        json!(true),
        // a missing argument
        json!(null),
    ]
}

#[test]
fn malformed_requests_are_errors_not_panics() {
    // quiet for the probe threads (unnamed), not for the test's own asserts
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().name().is_some() {
            default(info)
        }
    }));
    let (mut panics, mut slow) = (vec![], vec![]);
    for req in requests() {
        // the valid request works
        let ok = sagebrush_web::call(&req.to_string());
        assert!(ok.starts_with("{\"ok\""), "{} -> {}", req, ok);
        let keys: Vec<String> = req.as_object().unwrap().keys().filter(|k| *k != "fn").cloned().collect();
        for k in keys {
            for bad in bad_values() {
                let mut r = req.clone();
                if bad.is_null() {
                    r.as_object_mut().unwrap().remove(&k);
                } else {
                    r[&k] = bad;
                }
                let s = r.to_string();
                if std::env::var("FUZZ_VERBOSE").is_ok() {
                    eprintln!("{}", s);
                }
                let (tx, rx) = std::sync::mpsc::channel();
                let s2 = s.clone();
                std::thread::spawn(move || {
                    let r = std::panic::catch_unwind(|| sagebrush_web::call(&s2));
                    let _ = tx.send(r.is_err());
                });
                match rx.recv_timeout(std::time::Duration::from_secs(20)) {
                    Ok(false) => {}
                    Ok(true) => panics.push(s),
                    // a thread that panicked without sending, or still running
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panics.push(s),
                    Err(_) => slow.push(s),
                }
            }
        }
        // and still works
        assert!(sagebrush_web::call(&req.to_string()).starts_with("{\"ok\""), "{} stopped working", req);
    }
    let _ = std::panic::take_hook();
    assert!(panics.is_empty() && slow.is_empty(), "{} requests panicked:\n{}\n{} took over 20 s:\n{}", panics.len(), panics.join("\n"), slow.len(), slow.join("\n"));
}

/// Requests that must be errors (not panics, not answers): structure the
/// one-argument mutations above cannot reach (the second review's R5), and
/// sizes that a cast to a 32-bit usize would change.  The same fixtures run
/// against the WebAssembly engine (tests/wasm_designated.mjs).
#[test]
fn designated_invalid_requests_are_errors() {
    for line in include_str!("designated_errors.jsonl").lines().filter(|l| !l.trim().is_empty()) {
        let r = sagebrush_web::call(line);
        assert!(r.starts_with("{\"error\""), "{} -> {}", line, r);
    }
    // and at the boundary, valid ones still work
    for line in include_str!("designated_ok.jsonl").lines().filter(|l| !l.trim().is_empty()) {
        let r = sagebrush_web::call(line);
        assert!(r.starts_with("{\"ok\""), "{} -> {}", line, r);
    }
}
