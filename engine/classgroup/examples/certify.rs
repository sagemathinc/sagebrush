//! cargo run --release -p sagebrush-classgroup --example certify -- c0,c1,...,1 ...
//! The unconditional certificate (nf/proof.rs) for Q[x]/(f), f monic
//! (coefficients from the constant term): one line each, with the bounds
//! and the time of each stage.
use sagebrush_bigint::BigInt;
fn main() {
    let limits = sagebrush_classgroup::nf::proof::Limits {
        norm_max: std::env::var("NORM_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(u64::MAX),
        index_max: std::env::var("INDEX_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(u64::MAX),
    };
    for a in std::env::args().skip(1) {
        let f: Vec<BigInt> = a.split(',').map(|c| c.trim().parse().unwrap()).collect();
        let t = std::time::Instant::now();
        match sagebrush_classgroup::nf::proof::certify(&f, &limits) {
            Ok(p) => {
                let cyc: Vec<String> = p.cyc.iter().map(|x| x.to_string()).collect();
                let tm: Vec<String> = p.timing.iter().map(|(s, x)| format!("{} {:.0}", s, x * 1e3)).collect();
                println!("{} d {} h {} [{}] R [{:.15}, {:.15}] M {} ({}) fb {} shown {} Rlow {:.4} B {} l's {} class {:?} total {:.0} ms ({})",
                    a, p.disc, p.h, cyc.join(", "), p.reg_lo, p.reg_hi, p.norm_bound, p.norm_bound_kind.name(), p.fb_bound, p.primes_shown,
                    p.reg_lower, p.index_bound, p.unit_primes, p.class_primes.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
                    t.elapsed().as_secs_f64() * 1e3, tm.join(", "));
            }
            Err(e) => println!("{} error: {} ({:.0} ms)", a, e, t.elapsed().as_secs_f64() * 1e3),
        }
    }
}
