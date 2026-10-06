//! cargo run --release -p sagebrush-classgroup --example bnf -- c0,c1,...,1 ...
//! Class group and regulator of Q[x]/(f), f monic (coefficients from the
//! constant term): one line each.
use sagebrush_bigint::BigInt;
fn main() {
    for a in std::env::args().skip(1) {
        let f: Vec<BigInt> = a.split(',').map(|c| c.trim().parse().unwrap()).collect();
        let t = std::time::Instant::now();
        match sagebrush_classgroup::nf::bnf::bnfinit(&f) {
            Ok((b, tm)) => {
                let cyc: Vec<String> = b.group.cyc.iter().map(|x| x.to_string()).collect();
                println!("{} d {} [{}] reg {:.12} w {} {:.1} ms  fb {} rels {} core {} rounds {} rel {:.1} ms linalg {:.1} ms",
                    a, b.disc, cyc.join(", "), b.regulator, b.w, t.elapsed().as_secs_f64() * 1e3,
                    tm.fb, tm.relations, tm.core, tm.rounds, tm.sieve_s * 1e3, tm.linalg_s * 1e3);
            }
            Err(e) => println!("{} error: {}", a, e),
        }
    }
}
