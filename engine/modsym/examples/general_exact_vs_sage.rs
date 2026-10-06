//! Compare general_exact::exact_charpoly with Sage's exact charpolys over
//! CyclotomicField(ord eps), from examples/sage/general_exact.sage:
//!   cargo run --release --example general_exact_vs_sage -- FILE.jsonl [--table]
use sagebrush_bigint::BigInt;
use sagebrush_modsym::general::Character;
use sagebrush_modsym::general_exact::exact_charpoly;
use serde_json::Value;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let table = args.iter().any(|a| a == "--table");
    let text = std::fs::read_to_string(&args[1]).unwrap();
    let (mut ok, mut bad) = (0, 0);
    if table {
        println!("| N | k | sign | ord eps | q | dim | largest coefficient | bound | primes x embeddings | Sage | ours |");
        println!("|---|---|---|---|---|---|---|---|---|---|---|");
    }
    for line in text.lines() {
        let r: Value = serde_json::from_str(line).unwrap();
        let g = |key: &str| r[key].as_u64().unwrap();
        let (n, k, q) = (g("N"), g("k") as usize, g("q"));
        let sign = r["sign"].as_i64().unwrap() as i32;
        let exps: Vec<u32> = r["exps"].as_array().unwrap().iter().map(|x| x.as_u64().map_or(u32::MAX, |v| v as u32)).collect();
        let eps = Character::from_exponents(n, g("e").max(1), exps).unwrap();
        let want: Vec<Vec<BigInt>> = r["coeffs"].as_array().unwrap().iter().map(|c| {
            c.as_array().unwrap().iter().map(|x| x.as_str().unwrap().parse::<BigInt>().unwrap()).collect()
        }).collect();
        let t = Instant::now();
        let e = exact_charpoly(n, k, &eps, sign, q).unwrap();
        let secs = t.elapsed().as_secs_f64();
        // Sage drops trailing zero coordinates only for QQ; compare padded.
        let pad = |v: &Vec<BigInt>, len: usize| {
            let mut v = v.clone();
            v.resize(len, BigInt::from(0));
            v
        };
        let phi = e.coeffs.first().map_or(1, |c| c.len());
        let same = e.status == "proven" && e.m == g("order").max(1) && e.coeffs.len() == want.len() && e.coeffs.iter().zip(&want).all(|(a, b)| pad(a, phi) == pad(b, phi));
        if same {
            ok += 1;
        } else {
            bad += 1;
            if bad <= 10 {
                println!("N={} k={} sign={} q={} m={}: differ ({:?})", n, k, sign, q, e.m, e.checks);
            }
        }
        if table {
            let bits = e.coeffs.iter().flatten().map(|c| c.bits()).max().unwrap_or(0);
            println!("| {} | {} | {} | {} | {} | {} | {} bits | {:.0} bits | {} x {} | {:.2} s | {:.3} s |", n, k, sign, e.m, q, e.dim, bits, e.bound_bits, e.primes_used.len(), phi, r["sage_seconds"].as_f64().unwrap(), secs);
        }
    }
    println!("{} agree, {} differ", ok, bad);
}
