// Check galois_group against a file of lines "nTk anything c0,c1,...,cn"
// (expected label, a name, coefficients constant term first), e.g. number
// fields from the LMFDB:  cargo run --release --example check -- FILE [max]
// Prints mismatches and errors, then a summary with the slowest cases.
use sagebrush_bigint::BigInt;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&args[1]).unwrap();
    let max: usize = args.get(2).map_or(usize::MAX, |s| s.parse().unwrap());
    let (mut ok, mut bad, mut err, mut proven) = (0, 0, 0, 0);
    let mut times: Vec<(f64, String)> = vec![];
    for line in text.lines().filter(|l| !l.starts_with('#')).take(max) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let coeffs: Vec<BigInt> = f[2].split(',').map(|c| c.parse().unwrap()).collect();
        if std::env::var_os("CHECK_VERBOSE").is_some() {
            eprintln!("{} {} ...", f[0], f[2]);
        }
        let t0 = Instant::now();
        let proof = match std::env::var("CHECK_PROOF").as_deref() {
            Ok("always") => sagebrush_galois::Proof::Always,
            Ok("never") => sagebrush_galois::Proof::Never,
            _ => sagebrush_galois::Proof::WhenCheap,
        };
        let r = sagebrush_galois::galois_group_with(&coeffs, proof);
        let dt = t0.elapsed().as_secs_f64();
        times.push((dt, format!("{} {}", f[0], f[1])));
        match r {
            Ok(g) if g.label() == f[0] => {
                ok += 1;
                proven += g.proven as usize;
            }
            Ok(g) => {
                bad += 1;
                println!("MISMATCH {} {}: got {} ({:.2}s)\n  {}", f[0], f[1], g.label(), dt, g.log.join("\n  "));
            }
            Err(e) => {
                err += 1;
                println!("ERROR {} {}: {}", f[0], f[1], e);
            }
        }
    }
    times.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let total: f64 = times.iter().map(|t| t.0).sum();
    println!("ok {} (proven {}), mismatches {}, errors {}; total {:.1}s", ok, proven, bad, err, total);
    println!("profile: {}", sagebrush_galois::profile_report());
    for (t, name) in times.iter().take(8) {
        println!("  {:.2}s {}", t, name);
    }
}
