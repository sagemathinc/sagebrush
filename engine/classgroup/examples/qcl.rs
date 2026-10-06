//! cargo run --release -p sagebrush-classgroup --example qcl -- D [D ...]
//! The class group of each fundamental discriminant D (and for D > 0 the
//! regulator) with timings, one line each:
//!   D cyc [reg R] ms fb relations core rounds sieve_ms linalg_ms polys
//! The table of small primes is built once before timing (gp likewise
//! starts with its prime table); its cost is printed first.
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::{imag, realq};

/// x / 2^prec to `digits` decimals.
fn decimal(x: &BigInt, prec: u32, digits: u32) -> String {
    let s = ((x * BigInt::from(10).pow(digits)) >> prec as usize).to_string();
    let s = format!("{:0>width$}", s, width = digits as usize + 1);
    let (int, frac) = s.split_at(s.len() - digits as usize);
    format!("{}.{}", int, frac)
}

fn main() {
    let t = std::time::Instant::now();
    imag::h_estimate(&BigInt::from(-7), 2);
    eprintln!("prime table {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
    for a in std::env::args().skip(1) {
        let d: BigInt = a.parse().expect("an integer D");
        let t = std::time::Instant::now();
        let res = if d.sign() == sagebrush_bigint::Sign::Plus {
            realq::class_group_real(&d).map(|(r, tm)| (r.group, Some(decimal(&r.reg_fixed, r.prec, 15)), tm))
        } else {
            imag::class_group(&d).map(|(g, tm)| (g, None, tm))
        };
        match res {
            Ok((g, reg, tm)) => {
                let cyc: Vec<String> = g.cyc.iter().map(|x| x.to_string()).collect();
                let reg = reg.map_or(String::new(), |r| format!(" reg {}", r));
                println!(
                    "{} [{}]{} {:.1} ms  fb {} rels {} core {} rounds {} sieve {:.1} ms linalg {:.1} ms polys {}",
                    d,
                    cyc.join(", "),
                    reg,
                    t.elapsed().as_secs_f64() * 1e3,
                    tm.fb,
                    tm.relations,
                    tm.core,
                    tm.rounds,
                    tm.sieve_s * 1e3,
                    tm.linalg_s * 1e3,
                    tm.polys
                );
            }
            Err(e) => println!("{} error: {}", d, e),
        }
    }
}
