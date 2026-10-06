//! desolve on corpus/odes.json: how many we solve (explicit solutions are
//! verified by substitution inside desolve), with Maxima's answers beside.
//!     cargo run --release --example odes
use sagebrush_sym::{ode::desolve, parse::parse, to_string};

fn main() {
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/odes.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut solved = 0;
    for c in &cases {
        let de = c["in"].as_str().unwrap();
        let ics: Vec<_> = c["ics"].as_array().unwrap().iter().map(|v| parse(v.as_str().unwrap())).collect();
        let ours = sagebrush_sym::err::catch(|| to_string(&desolve(&parse(de), "y", "x", &ics)));
        if ours.is_ok() {
            solved += 1;
        }
        println!("{}  {:?}\n    ours:   {}\n    maxima: {}", de, c["ics"], ours.unwrap_or_else(|e| format!("error: {}", e)), c["maxima"].as_str().unwrap_or("-"));
    }
    println!("{}/{} solved", solved, cases.len());
}
