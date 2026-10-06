//! The limits corpus (corpus/limits.json, Maxima's answers).
use sagebrush_sym::{expr::*, limit::{limit, Dir}, parse::parse, to_string};

#[test]
fn corpus() {
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/limits.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut same = 0;
    for c in &cases {
        let at = match c["at"].as_str().unwrap() {
            "oo" => infinity(),
            "-oo" => constant(Const::MinusInfinity),
            s => parse(s),
        };
        let dir = match c["dir"].as_str() {
            Some("plus") => Dir::Plus,
            Some("minus") => Dir::Minus,
            _ => Dir::Both,
        };
        let ours = sagebrush_sym::err::catch(|| to_string(&limit(&parse(c["in"].as_str().unwrap()), "x", &at, dir))).ok();
        let m = c["maxima"].as_str().unwrap();
        let theirs = match m {
            "+Infinity" | "-Infinity" | "Infinity" => Some(m.to_string()),
            _ => sagebrush_sym::err::catch(|| to_string(&parse(m))).ok(),
        };
        if ours.is_some() && ours == theirs {
            same += 1;
        }
    }
    assert!(same >= 61, "{} of {} limits as Sage gives them", same, cases.len());
}
