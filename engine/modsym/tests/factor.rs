//! The pure-Rust factorer (sagebrush-poly) against FLINT on Hecke polynomials.
use num_bigint::BigInt;
use std::time::Instant;

fn sorted(mut fs: Vec<(Vec<BigInt>, u32)>) -> Vec<(Vec<BigInt>, u32)> {
    fs.sort();
    fs
}

#[test]
fn hecke_polynomials_factor_as_with_flint() {
    let mut worst = (0.0f64, 0u64);
    let levels: Vec<u64> = (11..400).step_by(3).chain([389, 997, 1009, 2003].into_iter()).collect();
    for n in levels {
        for q in [2u64, 3] {
            if n % q == 0 {
                continue;
            }
            let e = match sagebrush_modsym::exact::exact_charpoly(n, q) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let t = Instant::now();
            let ours = sagebrush_poly::factor(&e.coeffs);
            let dt = t.elapsed().as_secs_f64();
            if dt > worst.0 {
                worst = (dt, n);
            }
            let theirs = sagebrush_flint::factor(&e.coeffs);
            assert_eq!((ours.0, sorted(ours.1)), (theirs.0, sorted(theirs.1)), "T_{} at level {}", q, n);
        }
    }
    eprintln!("slowest factorization: {:.3} s (level {})", worst.0, worst.1);
}
