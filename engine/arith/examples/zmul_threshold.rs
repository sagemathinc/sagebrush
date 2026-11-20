//! Where the word schoolbook stops beating the NTT for poly_mul's word
//! product: |x| of 2^15 words times |y| of w_b words, each backend's best
//! of several runs, in milliseconds.
//!
//!     cargo run --release -p sagebrush-arith --example zmul_threshold
//!
//! (and under wasm32-wasip1 with node's WASI)

use sagebrush_arith::zmul::mul_words_schoolbook;
use sagebrush_bigint::ntt::mul_words_local;
use std::time::Instant;

fn best(f: &dyn Fn() -> Vec<u64>, runs: usize) -> f64 {
    (0..runs)
        .map(|_| {
            let t = Instant::now();
            let z = f();
            assert!(!z.is_empty());
            t.elapsed().as_secs_f64() * 1e3
        })
        .fold(f64::MAX, f64::min)
}

fn main() {
    let mut s = 0x2545f4914f6cdd1du64;
    let mut rng = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    for wa in [1usize << 12, 1 << 15] {
        let x: Vec<u64> = (0..wa).map(|_| rng()).collect();
        for wb in [4usize, 8, 16, 24, 32, 48, 64, 96, 128] {
            let y: Vec<u64> = (0..wb).map(|_| rng()).collect();
            let sb = best(&|| mul_words_schoolbook(&x, &y), 5);
            let nt = best(&|| mul_words_local(&x, &y), 5);
            assert_eq!(mul_words_schoolbook(&x, &y), mul_words_local(&x, &y));
            println!("w_a {:6} w_b {:4}: schoolbook {:8.3} ms  ntt {:8.3} ms  ratio {:.2}", wa, wb, sb, nt, sb / nt);
        }
    }
}
