//! Huge gcds and products through the facade (half-gcd with NTT products).
use num_integer::Integer;
use sagebrush_bigint::BigInt;
use std::time::Instant;
fn main() {
    for bits in [1u32 << 20, 1 << 21, 1 << 22, 1 << 23] {
        let a = BigInt::from(3u32).pow(bits * 100 / 158) + 17u32;
        let b = BigInt::from(5u32).pow(bits * 100 / 232) + 29u32;
        let t = Instant::now();
        let g = a.gcd(&b);
        let tg = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let p = &a * &b;
        let tm = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let q = &a.0 * &b.0;
        let td = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let (_, wa) = a.0.as_sign_words();
        let (_, wb) = b.0.as_sign_words();
        let r = sagebrush_bigint::ntt::mul_words(wa, wb);
        let tn = t.elapsed().as_secs_f64();
        assert_eq!(p.0.as_sign_words().1, &r[..r.iter().rposition(|&w| w != 0).unwrap() + 1]);
        println!("{:>9} bits: gcd {:.3} s, mul {:.4} s, dashu {:.4} s, ntt {:.4} s ({} {} {})", bits, tg, tm, td, tn, g.bits(), p.bits(), q == p.0);
    }
}
