// The la0 rows' shapes (p = 65537, n = 60, 160, 400) plus a word-size
// prime, for before/after timings of the dense F_p kernels.
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use std::time::Instant;
fn t<F: FnMut()>(mut f: F) -> f64 {
    let s = Instant::now();
    let mut k = 0;
    while s.elapsed().as_secs_f64() < 0.4 {
        f();
        k += 1;
    }
    s.elapsed().as_secs_f64() / k as f64 * 1e3
}
fn main() {
    for p in [65537u64, (1 << 31) - 1, 0xffff_ffff_ffff_ffc5] {
        let m = Modulus::new(p);
        for n in [60usize, 160, 400] {
            let mut s = 7u64;
            let a = Mat { rows: n, cols: n, m, d: (0..n * n).map(|_| { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s % p }).collect() };
            let b = Mat::from_rows(&(1..=n as u64).map(|x| vec![x % p]).collect::<Vec<_>>(), m);
            println!(
                "p~2^{} n={n}: det {:.3} rank {:.3} solve {:.3} mul {:.3} ms",
                64 - p.leading_zeros(),
                t(|| { a.det(); }),
                t(|| { a.rank(); }),
                t(|| { a.solve(&b); }),
                t(|| { a.mul(&a); })
            );
        }
    }
}
