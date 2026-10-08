//! gcd(f*(f + 1), f*(f + 2)) with f = (1 + x + y + z + t)^k, timed by
//! parts.   cargo run --release -p sagebrush-mpoly --example gcdbench -- 10
use num_traits::One;
use sagebrush_bigint::BigInt;
use sagebrush_mpoly::{divide, gcd, ZPoly};
use std::time::Instant;

fn main() {
    let k: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(10);
    let mut t = vec![(vec![0u64; 4], BigInt::one())];
    for i in 0..4 {
        let mut e = vec![0u64; 4];
        e[i] = 1;
        t.push((e, BigInt::one()));
    }
    let f = ZPoly::from_terms(4, t).unwrap().pow(k).unwrap();
    let c = |v: i64| ZPoly::from_terms(4, vec![(vec![0; 4], BigInt::from(v))]).unwrap();
    let a = f.mul(&f.add_signed(&c(1), false)).unwrap();
    let b = f.mul(&f.add_signed(&c(2), false)).unwrap();
    let t0 = Instant::now();
    let g = gcd::gcd_z(&a, &b).unwrap();
    let tg = t0.elapsed().as_secs_f64();
    let t1 = Instant::now();
    let q = divide::divexact(&a, &f).unwrap();
    let td = t1.elapsed().as_secs_f64();
    println!("k={} gcd {} terms {:.4} s (== f: {}); one divexact {:.4} s ({} terms)", k, g.len(), tg, g.equals(&f), td, q.len());
}
