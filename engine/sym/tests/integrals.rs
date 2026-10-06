//! The integration corpus (corpus/integrals.json, Maxima's answers): every
//! integral we return is verified by differentiation inside integrate();
//! this guards how many we find and how many print as Sage prints them.
use sagebrush_sym::{integrate::integrate, parse::parse, to_string};

#[test]
fn corpus() {
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/integrals.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let (mut found, mut same) = (0, 0);
    for c in &cases {
        let f = c["in"].as_str().unwrap();
        let Some(r) = sagebrush_sym::err::catch(|| integrate(&parse(f), "x")).ok().flatten() else { continue };
        found += 1;
        if let Some(m) = c["maxima"].as_str() {
            if sagebrush_sym::err::catch(|| to_string(&parse(m))).ok().as_deref() == Some(to_string(&r).as_str()) {
                same += 1;
            }
        }
    }
    assert!(found >= 164, "found {} of {}", found, cases.len());
    assert!(same >= 151, "{} print as Sage does", same);
}
