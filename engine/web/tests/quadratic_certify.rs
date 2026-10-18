//! quadratic_class_group's certify option through the dispatcher: the
//! analytic certificate is skipped only when asked, and the reply says
//! which kind of result it is.
use serde_json::Value;

fn call(req: &str) -> Value {
    serde_json::from_str(&sagebrush_web::call(req)).unwrap()
}

fn ok(req: &str) -> Value {
    let r = call(req);
    r.get("ok").unwrap_or_else(|| panic!("{} -> {}", req, r)).clone()
}

#[test]
fn certified_by_default_conditional_when_asked() {
    for d in ["-67128026883063", "-718243867543907291096", "1000000009", "54475728456"] {
        let certified = "certified (assuming GRH)";
        let conditional = "conditional on GRH and the stopping rule's estimate, not certified";
        for req in [format!(r#"{{"fn":"quadratic_class_group","d":"{}"}}"#, d),
                    format!(r#"{{"fn":"quadratic_class_group","d":"{}","certify":true}}"#, d),
                    format!(r#"{{"fn":"quadratic_class_group","d":"{}","certify":null}}"#, d)] {
            let r = ok(&req);
            assert_eq!(r["certified"], true, "{}", req);
            assert_eq!(r["status"], certified, "{}", req);
            assert_eq!(r["assumes"], serde_json::json!(["GRH"]), "{}", req);
        }
        let req = format!(r#"{{"fn":"quadratic_class_group","d":"{}","certify":false}}"#, d);
        let r = ok(&req);
        assert_eq!(r["certified"], false, "{}", req);
        assert_eq!(r["status"], conditional, "{}", req);
        let assumes: Vec<&str> = r["assumes"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        assert!(assumes.contains(&"GRH") && assumes.iter().any(|a| a.contains("estimate")), "{}: {:?}", req, assumes);
        let c = ok(&format!(r#"{{"fn":"quadratic_class_group","d":"{}"}}"#, d));
        assert_eq!((&r["h"], &r["cyc"]), (&c["h"], &c["cyc"]), "{}", req);
    }
    // below the exhaustive bound h is proven either way
    let r = ok(r#"{"fn":"quadratic_class_group","d":"-8888","certify":false}"#);
    assert_eq!((r["certified"].clone(), r["status"].clone()), (Value::Bool(true), Value::from("certified (assuming GRH)")));
}

#[test]
fn certify_must_be_a_boolean() {
    for bad in [r#""false""#, "0", "1", "[]"] {
        let req = format!(r#"{{"fn":"quadratic_class_group","d":"-23","certify":{}}}"#, bad);
        let r = call(&req);
        let e = r.get("error").unwrap_or_else(|| panic!("{} -> {}", req, r));
        assert!(e.as_str().unwrap().starts_with("certify must be true or false"), "{} -> {}", req, e);
    }
}
