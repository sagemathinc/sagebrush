//! ntt::mul_words at transform lengths of 2^16, 2^19 and 2^22 points (two
//! factors of N / 2 words each): the median of several runs after a
//! warm-up that builds the tables, in milliseconds.  It times the shared
//! NTT's hot loops, so a change to them shows here.
//!
//!     cargo run --release -p sagebrush-bigint --example mulwords_bench
//!
//! (and under wasm32-wasip1: build with --target wasm32-wasip1 and run the
//! .wasm with node's WASI)

use sagebrush_bigint::ntt::mul_words;
use std::time::Instant;

fn main() {
    let mut s = 0x9e3779b97f4a7c15u64;
    let mut rng = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    for log in [16u32, 19, 22] {
        let half = 1usize << (log - 1);
        let a: Vec<u64> = (0..half).map(|_| rng()).collect();
        let b: Vec<u64> = (0..half).map(|_| rng()).collect();
        let _ = mul_words(&a, &b);
        let runs = if log >= 22 { 3 } else { 7 };
        let mut t: Vec<f64> = (0..runs)
            .map(|_| {
                let t0 = Instant::now();
                let z = mul_words(&a, &b);
                let ms = t0.elapsed().as_secs_f64() * 1e3;
                assert_eq!(z.len(), 2 * half);
                ms
            })
            .collect();
        t.sort_by(|x, y| x.partial_cmp(y).unwrap());
        println!("mul_words 2^{} points: median {:.2} ms (min {:.2}, max {:.2}, {} runs)", log, t[runs / 2], t[0], t[runs - 1], runs);
    }
}
