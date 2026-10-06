//! desolve on corpus/odes.json (37 equations of a first course): all are
//! solved (explicit solutions are verified by substitution in desolve).
use sagebrush_sym::{ode::desolve, parse::parse};

#[test]
fn corpus() {
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/odes.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for c in &cases {
        let de = c["in"].as_str().unwrap();
        let ics: Vec<_> = c["ics"].as_array().unwrap().iter().map(|v| parse(v.as_str().unwrap())).collect();
        assert!(sagebrush_sym::err::catch(|| desolve(&parse(de), "y", "x", &ics)).is_ok(), "desolve({})", de);
    }
}
