use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::nmod_mat::Mat;
use std::time::Instant;
fn t<F: FnMut()>(mut f: F) -> f64 { let s = Instant::now(); let mut k = 0; while s.elapsed().as_secs_f64() < 0.3 { f(); k += 1; } s.elapsed().as_secs_f64() / k as f64 * 1e3 }
fn main() {
    for p in [Primes::new().next().unwrap(), Primes::below(1 << 31).next().unwrap()] {
        let m = Modulus::new(p);
        for n in [30usize, 100, 200] {
            let mut s = 7u64;
            let a = Mat { rows: n, cols: n, m, d: (0..n * n).map(|_| { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s % p }).collect() };
            println!("p~2^{} n={n}: det {:.3} inverse {:.3} rref {:.3} charpoly {:.3} mul {:.3} ms", 64 - p.leading_zeros(),
                t(|| { a.det(); }), t(|| { a.inverse(); }), t(|| { a.clone().rref(); }), t(|| { a.charpoly(); }), t(|| { a.mul(&a); }));
        }
    }
}
