//! Our integrator on corpus/integrals.json against Maxima's answers (what
//! Sage's integrate returns): how many we find (every answer is verified by
//! differentiation), and how many print exactly as Sage prints Maxima's.
//!
//!     cargo run --release --example integrals [-- -v]
use sagebrush_sym::{integrate::integrate, parse::parse, to_string};
// (errors inside catch() are expected: quiet)

fn main() {
    let verbose = std::env::args().any(|a| a == "-v");
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/integrals.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let (mut found, mut maxima, mut same, mut missed, mut extra) = (0, 0, 0, vec![], vec![]);
    let mut differ = vec![];
    let t0 = std::time::Instant::now();
    for c in &cases {
        let f = c["in"].as_str().unwrap();
        let ours = sagebrush_sym::err::catch(|| integrate(&parse(f), "x")).ok().flatten();
        let theirs = c["maxima"].as_str().and_then(|s| sagebrush_sym::err::catch(|| to_string(&parse(s))).ok());
        if ours.is_some() {
            found += 1;
        }
        if c["maxima"].is_string() {
            maxima += 1;
        }
        match (&ours, &theirs) {
            (Some(o), Some(t)) => {
                let o = to_string(o);
                if &o == t {
                    same += 1;
                } else {
                    differ.push(format!("{}\n    ours:  {}\n    sage:  {}", f, o, t));
                }
            }
            (None, Some(t)) => missed.push(format!("{}  (sage: {})", f, t)),
            (Some(o), None) => extra.push(format!("{}  = {}", f, to_string(o))),
            (None, None) => {}
        }
    }
    println!("{} integrands: we find {} (verified), Maxima {}; identical to Sage's form: {}; {:.2} s",
             cases.len(), found, maxima, same, t0.elapsed().as_secs_f64());
    println!("missed ({}):", missed.len());
    for m in &missed {
        println!("  {}", m);
    }
    if !extra.is_empty() {
        println!("found where Maxima did not ({}):", extra.len());
        for m in &extra {
            println!("  {}", m);
        }
    }
    if verbose {
        println!("different forms ({}):", differ.len());
        for d in &differ {
            println!("  {}", d);
        }
    }
}
