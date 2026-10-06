//! Our limits on corpus/limits.json against Maxima's (what Sage's limit
//! returns): cargo run --release --example limits
use sagebrush_sym::{expr::*, limit::{limit, Dir}, parse::parse, to_string};

fn main() {
    sagebrush_sym::err::install_quiet_hook();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/limits.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let (mut same, mut total) = (0, 0);
    for c in &cases {
        let f = c["in"].as_str().unwrap();
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
        if std::env::var("TRACE").is_ok() {
            eprintln!("... {}", f);
        }
        let ours = sagebrush_sym::err::catch(|| to_string(&limit(&parse(f), "x", &at, dir))).unwrap_or_else(|e| format!("error: {}", e));
        let Some(m) = c["maxima"].as_str() else { continue };
        total += 1;
        let theirs = match m {
            "+Infinity" | "-Infinity" | "Infinity" => m.to_string(),
            _ => sagebrush_sym::err::catch(|| to_string(&parse(m))).unwrap_or_else(|_| m.to_string()),
        };
        if ours == theirs {
            same += 1;
        } else {
            println!("{} at {} {:?}: ours {}   sage {}", f, c["at"], c["dir"].as_str().unwrap_or(""), ours, theirs);
        }
    }
    println!("{}/{} limits as Sage gives them", same, total);
}
