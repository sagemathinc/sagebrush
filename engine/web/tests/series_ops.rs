//! The series ops through the dispatcher (series_ops.rs): the strict
//! request schema, the caps' refusals (naming the cap), the answers decided
//! before admission, a value per op, and the closed forms at the admitted
//! corners (peak and work within the ops' constants).

use sagebrush_arith::zseries::{self, Csv};
use sagebrush_web::call;
use sagebrush_web::series_ops::OPS;
use serde_json::Value;

fn ok(req: &str) -> Value {
    let r: Value = serde_json::from_str(&call(req)).unwrap();
    assert!(r.get("error").is_none(), "{} -> {}", &req[..req.len().min(200)], r);
    r["ok"].clone()
}

fn err(req: &str) -> String {
    let r: Value = serde_json::from_str(&call(req)).unwrap();
    assert!(r.get("internal").is_none(), "{}", r);
    r.get("error").and_then(Value::as_str).unwrap_or_else(|| panic!("{} was accepted: {}", &req[..req.len().min(200)], r)).to_string()
}

#[test]
fn values_through_the_dispatcher() {
    // (1 + q)(1 - q) = 1 - q^2; over Q: (1/2 + q)(1/3) = 1/6 + q/3
    assert_eq!(ok(r#"{"fn":"series_mul","a":"1,1","b":"1,-1","n":5}"#), serde_json::json!({"c": "1,0,-1", "d": "1"}));
    assert_eq!(ok(r#"{"fn":"series_mul","a":"1,2","b":"1","n":5,"da":"2","db":"3"}"#), serde_json::json!({"c": "1/6,1/3"}));
    assert_eq!(ok(r#"{"fn":"series_mul","a":"1,2","b":"1","n":5,"da":"2","db":"3","raw":true}"#), serde_json::json!({"c": "1,2", "d": "6"}));
    // (1 + q)^3 = 1 + 3q + 3q^2 + q^3, to q^3
    assert_eq!(ok(r#"{"fn":"series_pow","a":"1,1","k":3,"n":3}"#), serde_json::json!({"c": "1,3,3", "d": "1"}));
    // (q/2)^2 = q^2/4
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0,1","k":2,"n":4,"da":"2"}"#), serde_json::json!({"c": "0,0,1/4"}));
    assert_eq!(ok(r#"{"fn":"series_euler","n":8}"#), serde_json::json!("1,-1,-1,0,0,1,0,1"));
    // sigma_1(1..6) = 1, 3, 4, 7, 6, 12
    assert_eq!(ok(r#"{"fn":"sigma_table","k":1,"n":6}"#), serde_json::json!("1,3,4,7,6,c"));
}

#[test]
fn answers_decided_before_admission() {
    let zero = serde_json::json!({"c": "", "d": "1"});
    let one = serde_json::json!({"c": "1", "d": "1"});
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0,1","k":0,"n":4}"#), one);
    // f^0 = 1 even when f(0) = 0, and for the zero series
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0","k":0,"n":4}"#), one);
    assert_eq!(ok(r#"{"fn":"series_pow","a":"","k":7,"n":0}"#), zero);
    // (inputs longer than n are refused: the callers send at most n)
    assert!(err(r#"{"fn":"series_pow","a":"5","k":7,"n":0}"#).contains("more than 0 coefficients"));
    // all-zero input of any length, with a denominator
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0,0,0","k":2,"n":4,"da":"3"}"#), zero);
    assert_eq!(ok(r#"{"fn":"series_mul","a":"0,0","b":"1","n":4,"da":"3"}"#), zero);
    // k v >= n (decided by division) and k v < n
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0,0,1","k":2,"n":4}"#), zero);
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0,0,1","k":2,"n":5}"#), serde_json::json!({"c": "0,0,0,0,1", "d": "1"}));
    assert_eq!(ok(r#"{"fn":"series_pow","a":"0,0,1","k":18446744073709551615,"n":5}"#), zero);
    // k = 1 is the general path
    assert_eq!(ok(r#"{"fn":"series_pow","a":"1,2","k":1,"n":2}"#), serde_json::json!({"c": "1,2", "d": "1"}));
    assert_eq!(ok(r#"{"fn":"series_pow","a":"1,2","k":1,"n":3,"da":"4"}"#), serde_json::json!({"c": "1/4,1/2"}));
    assert_eq!(ok(r#"{"fn":"sigma_table","k":3,"n":0}"#), serde_json::json!(""));
    assert_eq!(ok(r#"{"fn":"series_euler","n":0}"#), serde_json::json!(""));
}

#[test]
fn the_strict_schema() {
    // an unknown key, refused before its value: 10^5 nested arrays under it
    let deep = format!(r#"{{"fn":"series_mul","x":{}1{},"a":"1","b":"1","n":1}}"#, "[".repeat(100_000), "]".repeat(100_000));
    let e = err(&deep);
    assert!(e.contains("unknown key"), "{}", e);
    // (multi-byte UTF-8 across the error previews' 40-byte cut: a key and a
    // token, each refused by its message, never a panic)
    for (k, ch) in [(39, "é"), (39, "界"), (38, "界"), (37, "😀"), (39, "😀")] {
        let e = err(&format!(r#"{{"fn":"poly_mul","{}{}":"1","a":"1","b":"1"}}"#, "k".repeat(k), ch));
        assert!(e.contains("unknown key"), "{}", e);
    }
    let e = err(&format!(r#"{{"fn":"poly_mul","a":"{}界","b":"1"}}"#, "a".repeat(39)));
    assert!(e.contains("is not a hex integer"), "{}", e);
    let e = err(&format!(r#"{{"fn":"qpoly_mul","a":"1/{}界","b":"1"}}"#, "a".repeat(37)));
    assert!(e.contains("is not a hex rational"), "{}", e);
    let e = err(r#"{"fn":"series_mul","a":"1","a":"2","b":"1","n":1}"#);
    assert!(e.contains("twice"), "{}", e);
    let e = err(r#"{"fn":"series_mul","fn":"series_mul","a":"1","b":"1","n":1}"#);
    assert!(e.contains("twice"), "{}", e);
    // (an escaped "1": a backslash, then u0031)
    let e = err(&format!(r#"{{"fn":"series_mul","a":"{}u0031","b":"1","n":1}}"#, char::from(92u8)));
    assert!(e.contains("escapes"), "{}", e);
    for (req, what) in [
        (r#"{"fn":"series_mul","a":1,"b":"1","n":1}"#, "string"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":"1"}"#, "integer"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1.5}"#, "integer"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1e3}"#, "integer"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":-1}"#, "at least 0"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1,"raw":1}"#, "true or false"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1,"raw":true,"raw":false}"#, "twice"),
        (r#"{"fn":"series_mul","a":["1"],"b":"1","n":1}"#, "no lists"),
        (r#"{"fn":"series_mul","a":{"x":1},"b":"1","n":1}"#, "no lists"),
        (r#"{"fn":"series_mul","b":"1","n":1}"#, "missing"),
        (r#"{"fn":"series_pow","a":"1","k":-2,"n":3}"#, "series inverse"),
        (r#"{"fn":"series_pow","a":"1","k":2,"n":3,"db":"2"}"#, "unknown key"),
        (r#"{"fn":"sigma_table","k":1,"n":3,"raw":true}"#, "unknown key"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1} x"#, "after"),
        (r#"{"fn":"series_mul","a":"01","b":"1","n":1}"#, "hex integer"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1,"da":"0"}"#, "positive"),
        (r#"{"fn":"series_mul","a":"1","b":"1","n":1,"da":"-2"}"#, "positive"),
        (r#"{"fn":"series_mul","a":"1,2","b":"1","n":1}"#, "more than 1 coefficients"),
    ] {
        let e = err(req);
        assert!(e.contains(what), "{} -> {}", req, e);
    }
}

#[test]
fn caps_name_the_limit_and_the_way_around() {
    let e = err(r#"{"fn":"series_mul","a":"1","b":"1","n":1000000}"#);
    assert!(e.contains("131072") && e.contains("fewer coefficients per call") && e.contains("future op"), "{}", e);
    let e = err(r#"{"fn":"sigma_table","k":1,"n":2000000}"#);
    assert!(e.contains("1048576"), "{}", e);
    let e = err(r#"{"fn":"sigma_table","k":2000000,"n":10}"#);
    assert!(e.contains("1048576") && e.contains("smaller k"), "{}", e);
    // output bits: (2^4096-ish)^100 in one coefficient
    let a = format!(r#"{{"fn":"series_pow","a":"{}","k":100,"n":1}}"#, "f".repeat(1024));
    let e = err(&a);
    assert!(e.contains("16384"), "{}", e);
    // the request's own cap, before any parse
    let big = format!(r#"{{"fn":"series_mul","a":"{}","b":"1","n":1}}"#, "1,".repeat(9_000_000));
    let e = err(&big);
    assert!(e.contains("16777216"), "{}", e);
}

/// Every admitted corner's peak and work within the op's constants; the
/// largest of each, printed (the constants are set from them, with room).
#[test]
fn closed_forms_at_the_corners() {
    let csv = |t: usize, d: usize| Csv { text: "", tokens: t, max_digits: d, limbs: (t * d.div_ceil(16)) as u64, all_zero: false, valuation: 0 };
    let den = |d: usize| Csv { text: "", tokens: 1, max_digits: d, limbs: d.div_ceil(16) as u64, all_zero: false, valuation: 0 };
    let (mul_op, pow_op, sigma_op) = (&OPS[0], &OPS[1], &OPS[3]);
    let (mut peak, mut work) = (0u64, 0u64);
    let mut admitted = 0;
    for &t in &[1usize, 64, 1 << 12, 1 << 16, 1 << 17] {
        for &d in &[1usize, 16, 256, 1024] {
            // a request this size must exist: the two lists' text
            let req = (2 * t * (d + 1) + 200) as u64;
            if req > mul_op.max_request as u64 {
                continue;
            }
            for &n in &[t, 1 << 17] {
                for dd in [None, Some(1024usize)] {
                    for raw in [false, true] {
                        let c = csv(t, d);
                        let dc = dd.map(den);
                        if let Ok(a) = zseries::mul_admit(&c, &c, dc.as_ref(), dc.as_ref(), n, raw, req) {
                            admitted += 1;
                            peak = peak.max(a.peak);
                            work = work.max(a.work);
                        }
                        for &k in &[2u64, 24, 1000] {
                            if let Ok(a) = zseries::pow_admit(&c, k, dc.as_ref(), n, raw, req) {
                                admitted += 1;
                                peak = peak.max(a.peak);
                                work = work.max(a.work);
                            }
                        }
                    }
                }
            }
        }
    }
    eprintln!("series ops: {} admitted corners; largest peak {} bytes ({:.1} MiB), largest work {:.3e}", admitted, peak, peak as f64 / (1 << 20) as f64, work as f64);
    assert!(admitted > 50);
    assert!(peak <= mul_op.peak.min(pow_op.peak), "a series corner needs {} bytes", peak);
    assert!(work <= zseries::WORK_MAX);
    let (mut sp, mut sw) = (0u64, 0u64);
    for &n in &[1usize, 1 << 10, 1 << 16, 1 << 20] {
        for &k in &[0u64, 1, 11, 100, 1000, 1 << 20] {
            if let Ok(a) = zseries::sigma_admit(k, n, 64) {
                sp = sp.max(a.peak);
                sw = sw.max(a.work);
            }
        }
    }
    eprintln!("sigma_table: largest peak {:.1} MiB, largest work {:.3e}", sp as f64 / (1 << 20) as f64, sw as f64);
    assert!(sp <= sigma_op.peak && sw <= zseries::WORK_MAX);
}
