//! Compute newspaces for the atlas (web/atlas): one JSON line per space,
//! {n, k, dims, newforms: [{letter, dim, traces, charpoly}], T, status,
//! checks, seconds}, by the very calls the browser makes, so that a page
//! can be recomputed in the browser and compared.
//!
//!     cargo run --release -p sagebrush-web --example atlas -- SPACES BOUND [THREADS] > out.jsonl
//!
//! SPACES is a list like 1-1000:2,1-250:4 (levels:weight); BOUND the number
//! of traces a_1..a_BOUND.  With ATLAS_ESTIMATE=1 it prints the cost
//! model's prediction for each space instead (estimate_newforms).
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut spaces = vec![];
    for part in args[1].split(',') {
        let (r, k) = part.split_once(':').unwrap_or((part, "2"));
        let (a, b) = r.split_once('-').unwrap_or((r, r));
        let k: u64 = k.parse().unwrap();
        for n in a.parse::<u64>().unwrap()..=b.parse::<u64>().unwrap() {
            spaces.push((n, k));
        }
    }
    let bound: u64 = args[2].parse().unwrap();
    let threads: usize = args.get(3).map(|t| t.parse().unwrap()).unwrap_or(8);
    // largest levels first, so that the slowest spaces do not finish last
    spaces.sort_by_key(|&(n, k)| std::cmp::Reverse(n * k * k));
    let next = AtomicUsize::new(0);
    let out = Mutex::new(std::io::stdout());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= spaces.len() {
                    break;
                }
                let (n, k) = spaces[i];
                if std::env::var("ATLAS_ESTIMATE").is_ok() {
                    // the cost model's prediction only (web/atlas/fit-cost.py)
                    let e = sagebrush_web::call(&format!(r#"{{"fn":"estimate_newforms","n":{},"k":{},"bound":{}}}"#, n, k, bound));
                    use std::io::Write;
                    writeln!(out.lock().unwrap(), "{}", e).unwrap();
                    continue;
                }
                let t = Instant::now();
                let dims = sagebrush_web::call(&format!(r#"{{"fn":"dims","n":{},"k":{}}}"#, n, k));
                let nf = sagebrush_web::call(&format!(r#"{{"fn":"newforms","n":{},"k":{},"bound":{}}}"#, n, k, bound));
                let line = format!(r#"{{"n":{},"k":{},"dims":{},"newforms":{},"seconds":{:.3}}}"#, n, k, dims, nf, t.elapsed().as_secs_f64());
                use std::io::Write;
                let mut o = out.lock().unwrap();
                writeln!(o, "{}", line).unwrap();
            });
        }
    });
}
