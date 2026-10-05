//! cargo run --release -p sagebrush-classgroup --example qcl -- D [D ...]
//! The class group of each D < 0 with timings, one line each:
//!   D cyc ms fb relations core rounds sieve_ms linalg_ms polys
//! The table of small primes is built once before timing (gp likewise
//! starts with its prime table); its cost is printed first.
fn main() {
    let t = std::time::Instant::now();
    sagebrush_classgroup::imag::h_estimate(-7, 2);
    eprintln!("prime table {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
    for a in std::env::args().skip(1) {
        let d: i128 = a.parse().expect("an integer D < 0");
        let t = std::time::Instant::now();
        match sagebrush_classgroup::imag::class_group(d) {
            Ok((g, tm)) => {
                let cyc: Vec<String> = g.cyc.iter().map(|x| x.to_string()).collect();
                println!("{} [{}] {:.1} ms  fb {} rels {} core {} rounds {} sieve {:.1} ms linalg {:.1} ms polys {}",
                    d, cyc.join(", "), t.elapsed().as_secs_f64() * 1e3, tm.fb, tm.relations, tm.core, tm.rounds,
                    tm.sieve_s * 1e3, tm.linalg_s * 1e3, tm.polys);
            }
            Err(e) => println!("{} error: {}", d, e),
        }
    }
}
