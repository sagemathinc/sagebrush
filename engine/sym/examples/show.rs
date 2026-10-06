//! Evaluate lines (from the command line, or the corpus cases Sage could
//! not run) and print the results.
fn main() {
    sagebrush_sym::err::install_quiet_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let lines: Vec<String> = if args.is_empty() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/corpus.json");
        let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir).unwrap()).unwrap();
        data.as_array().unwrap().iter().filter(|c| c.get("error").is_some()).map(|c| c["in"].as_str().unwrap().to_string()).collect()
    } else {
        args
    };
    for l in lines {
        match sagebrush_sym::ops::run_line(&l) {
            Ok(s) => println!("{:<44} => {}", l, s),
            Err(e) => println!("{:<44} => ERROR {}", l, e),
        }
    }
}
