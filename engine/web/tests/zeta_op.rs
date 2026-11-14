//! The zeta_zeros and siegel ops of the JSON dispatcher: the zeros of zeta on the critical line, the
//! Riemann-Siegel Z and theta functions, and their limits.
use serde_json::{json, Value};

fn call(req: Value) -> Value {
    serde_json::from_str(&sagebrush_web::call(&req.to_string())).unwrap()
}

#[test]
fn zeta_zeros_in_a_run() {
    let r = call(json!({"fn": "zeta_zeros", "start": 1, "count": 3}));
    let v: Vec<f64> = r["ok"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
    for (g, want) in v.iter().zip([14.134725141734694, 21.022039638771555, 25.01085758014569]) {
        assert!((g - want).abs() < 1e-13, "{g} vs {want}");
    }
    assert_eq!(call(json!({"fn": "zeta_zeros", "start": 7, "count": 0}))["ok"], json!([]));
}

#[test]
fn siegel_z_and_theta() {
    let r = call(json!({"fn": "siegel", "t": [0.0, 14.134725141734694, 100.0]}));
    let v = r["ok"].as_array().unwrap();
    // Z(0) = zeta(1/2) = -1.4603545088095868... (mpmath); Z vanishes at gamma_1; Z(100) = 2.6926970566644634... (mpmath)
    assert!((v[0].as_f64().unwrap() + 1.4603545088095868).abs() < 1e-14);
    assert!(v[1].as_f64().unwrap().abs() < 1e-13);
    assert!((v[2].as_f64().unwrap() - 2.6926970566644635).abs() < 1e-13);
    let r = call(json!({"fn": "siegel", "t": [100.0], "what": "theta"}));
    // theta(100) = 87.972165231787219... (mpmath)
    assert!((r["ok"][0].as_f64().unwrap() - 87.97216523178722).abs() < 1e-13);
}

#[test]
fn zeta_zeros_and_siegel_refuse_bad_requests() {
    for req in [
        json!({"fn": "zeta_zeros", "start": 0, "count": 1}),
        json!({"fn": "zeta_zeros", "start": 1}),
        json!({"fn": "zeta_zeros", "start": 1, "count": (1 << 16) + 1}),
        json!({"fn": "zeta_zeros", "start": 10_000_000, "count": 2}),
        json!({"fn": "zeta_zeros", "start": 1.5, "count": 1}),
        json!({"fn": "siegel", "t": 3}),
        json!({"fn": "siegel", "t": ["a"]}),
        json!({"fn": "siegel", "t": [1e8 + 2.0]}),
        json!({"fn": "siegel", "t": [1], "what": "zeta"}),
        json!({"fn": "siegel", "t": vec![1.0; (1 << 16) + 1]}),
    ] {
        let r = call(req.clone());
        assert!(r.get("error").is_some(), "{req}: {r}");
    }
}
