//! Compare the engine with Sage on the corpus files (corpus/*.json: an
//! input in Sage syntax and what Sage prints).
//!
//!   cargo run --release -p sagebrush-sym --example corpus [-- -v]

fn run(line: &str) -> Result<String, String> {
    sagebrush_sym::ops::run_line(line)
}

fn main() {
    sagebrush_sym::err::install_quiet_hook();
    let verbose = std::env::args().any(|a| a == "-v");
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/");
    let (mut ok, mut total, mut skipped) = (0, 0, 0);
    for file in ["corpus.json", "order.json"] {
        let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{}{}", dir, file)).unwrap()).unwrap();
        for case in data.as_array().unwrap() {
            let input = case["in"].as_str().unwrap();
            let Some(want) = case["out"].as_str() else {
                skipped += 1;
                continue;
            };
            total += 1;
            if std::env::var("TRACE").is_ok() {
                eprintln!("> {}", input);
            }
            match run(input.trim()) {
                Ok(g) if g == want => ok += 1,
                Ok(g) => {
                    if verbose {
                        println!("DIFF {:<36} sage: {:<36} ours: {}", input, want, g);
                    }
                }
                Err(e) => {
                    if verbose {
                        println!("ERR  {:<36} sage: {:<36} error: {}", input, want, e);
                    }
                }
            }
        }
    }
    println!("{}/{} identical to Sage ({} cases Sage could not run)", ok, total, skipped);
}
