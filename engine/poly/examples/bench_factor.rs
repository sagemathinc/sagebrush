//! Factor a polynomial (coefficients from x^0 up, whitespace-separated, in a
//! file) with sagebrush-poly and with FLINT, and time both:
//!     cargo run --release -p sagebrush-poly --example bench_factor -- FILE
use num_bigint::BigInt;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("FILE");
    let f: Vec<BigInt> = std::fs::read_to_string(path).unwrap().split_whitespace().map(|s| s.parse().unwrap()).collect();
    let t = Instant::now();
    let (_, ours) = sagebrush_poly::factor(&f);
    let a = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let (_, flint) = sagebrush_flint::factor(&f);
    let b = t.elapsed().as_secs_f64();
    let degs = |v: &[(Vec<BigInt>, u32)]| { let mut d: Vec<usize> = v.iter().map(|(g, _)| g.len() - 1).collect(); d.sort(); d };
    println!("degree {}: sagebrush-poly {:.2} s, FLINT {:.2} s; factor degrees {:?} / {:?}", f.len() - 1, a, b, degs(&ours), degs(&flint));
}
