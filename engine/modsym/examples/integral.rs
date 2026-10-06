//! integral OUT.jsonl (N... | FROM-TO): exact integral coordinates c_p of
//! a_p (a_p = sum_r beta_r c_{p,r}), p < 1000, for every newform orbit at
//! the given levels (in parallel), one JSON object per orbit.  VERBOSE=1
//! prints per-orbit sizes.
use rayon::prelude::*;
use sagebrush_modsym::integral::{integral_orbits, IntegralOrbit};
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let levels: Vec<u64> = match args[1].split_once('-') {
        Some((a, b)) => (a.parse().unwrap()..=b.parse().unwrap()).collect(),
        None => args[1..].iter().map(|s| s.parse().unwrap()).collect(),
    };
    let verbose = std::env::var("VERBOSE").is_ok();
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_flint::factor(f).1;
    let t0 = std::time::Instant::now();
    let all: Vec<(u64, Vec<IntegralOrbit>)> = levels
        .par_iter()
        .map(|&n| (n, integral_orbits(n, 999, &factor).unwrap_or_else(|e| panic!("{}", e))))
        .collect();
    let mut out = std::fs::File::create(&args[0]).unwrap();
    let (mut orbits, mut failed) = (0, 0);
    for (n, os) in &all {
        for o in os {
            orbits += 1;
            failed += !o.traces_check as usize;
            if verbose {
                let maxw = o.w.iter().flatten().map(|x| x.unsigned_abs()).max().unwrap_or(0);
                let bits: u64 = o.c.iter().flat_map(|x| x.1.iter()).map(|&x| 65 - x.unsigned_abs().leading_zeros() as u64).sum();
                eprintln!("N={} dim {:>2}: traces check {}, max |w| {}, {:.1} bits per a_p", n, o.orbit.dim, o.traces_check, maxw, bits as f64 / o.c.len() as f64);
            }
            let traces: Vec<i64> = o.orbit.traces.iter().map(|x| x.1).collect();
            let f: Vec<String> = o.orbit.f.iter().map(|x| x.to_string()).collect();
            writeln!(out, "{}", serde_json::json!({"level": n, "dim": o.orbit.dim, "traces": traces, "traces_check": o.traces_check, "c": o.c, "f": f, "ops": o.orbit.ops})).unwrap();
        }
    }
    eprintln!("{} levels, {} orbits, trace check failed for {}, {:.1} s", levels.len(), orbits, failed, t0.elapsed().as_secs_f64());
}
