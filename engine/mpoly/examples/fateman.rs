//! Fateman's benchmark: f*(f + 1) with f = (1 + x + y + z + t)^n.
//!   cargo run --release -p sagebrush-mpoly --example fateman -- 20 30
use num_traits::One;
use sagebrush_bigint::BigInt;
use sagebrush_mpoly::ZPoly;
use std::time::Instant;

fn main() {
    let ns: Vec<u64> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let mut t = vec![(vec![0u64; 4], BigInt::one())];
    for i in 0..4 {
        let mut e = vec![0u64; 4];
        e[i] = 1;
        t.push((e, BigInt::one()));
    }
    let lin = ZPoly::from_terms(4, t).unwrap();
    let one = ZPoly::from_terms(4, vec![(vec![0; 4], BigInt::one())]).unwrap();
    for n in if ns.is_empty() { vec![10, 20, 30] } else { ns } {
        let t0 = Instant::now();
        let f = lin.pow(n).unwrap();
        let tp = t0.elapsed();
        let g = f.add_signed(&one, false);
        let t1 = Instant::now();
        let h = f.mul(&g).unwrap();
        let dt = t1.elapsed().as_secs_f64();
        // a checksum: sum of c_i * (i + 1) * (exponent word mod m) mod m
        let m = BigInt::from((1u64 << 61) - 1);
        let mut ck = BigInt::from(0);
        for i in 0..h.len() {
            ck = (ck + h.coeffs.big(i) * BigInt::from(i as u64 + 1) * BigInt::from(h.exps[i] % ((1u64 << 61) - 1))) % &m;
        }
        println!("n={} f: {} terms ({:.3} s)  f*(f+1): {} terms  {:.4} s  check {}", n, f.len(), tp.as_secs_f64(), h.len(), dt, ck);
    }
}
