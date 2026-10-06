//! Big-integer products: our NTT (mul_words) against dashu's.
use dashu_int::UBig;
use sagebrush_arith::ntt::mul_words;
use std::time::Instant;

fn time<F: FnMut()>(mut f: F) -> f64 {
    let t = Instant::now();
    let mut n = 0;
    while t.elapsed().as_secs_f64() < 0.5 {
        f();
        n += 1;
    }
    t.elapsed().as_secs_f64() / n as f64
}

fn main() {
    let mut s = 1u64;
    for log in 12..24 {
        let bits = 1usize << log;
        let words = bits / 64;
        let mut r = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
        let a: Vec<u64> = (0..words).map(|_| r()).collect();
        let b: Vec<u64> = (0..words).map(|_| r()).collect();
        let ua = UBig::from_words(&a);
        let ub = UBig::from_words(&b);
        let tn = time(|| { std::hint::black_box(mul_words(&a, &b)); });
        let td = time(|| { std::hint::black_box(&ua * &ub); });
        println!("{bits:>9} bits  ntt {:>9.3} ms  dashu {:>9.3} ms  ratio {:.2}", tn * 1e3, td * 1e3, td / tn);
    }
}
