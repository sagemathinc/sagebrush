//! The li op of the JSON dispatcher: li and Li (offset) of a list of numbers,
//! the values JSON can't write as numbers written as strings, and its limits.
use serde_json::{json, Value};

fn call(req: Value) -> Value {
    serde_json::from_str(&sagebrush_web::call(&req.to_string())).unwrap()
}

#[test]
fn li_and_li_offset() {
    let r = call(json!({"fn": "li", "x": [0.0, 1.0, 2.0, 0.5, 1e6]}));
    let v = r["ok"].as_array().unwrap();
    assert_eq!(v[0], json!(0.0));
    assert_eq!(v[1], json!("-inf"));
    assert!((v[2].as_f64().unwrap() - 1.045163780117493).abs() < 1e-15);
    assert!((v[3].as_f64().unwrap() + 0.3786710430610880).abs() < 1e-15);
    assert!((v[4].as_f64().unwrap() / 78627.54915946218 - 1.0).abs() < 1e-15);
    let r = call(json!({"fn": "li", "x": [1e8], "offset": true}));
    assert!((r["ok"][0].as_f64().unwrap() / 5762208.330284251 - 1.0).abs() < 1e-15);
    let r = call(json!({"fn": "li", "x": [-1.0]}));
    assert_eq!(r["ok"][0], json!("nan"));
}

#[test]
fn li_refuses_bad_requests() {
    for req in [json!({"fn": "li"}), json!({"fn": "li", "x": [1, "a"]}), json!({"fn": "li", "x": [2], "offset": "yes"}),
                json!({"fn": "li", "x": vec![2.0; (1 << 16) + 1]})] {
        let r = call(req.clone());
        assert!(r.get("error").is_some(), "{req}: {r}");
    }
}
