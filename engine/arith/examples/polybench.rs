//! Polynomials over Z: Sagebrush (sagebrush-arith) against FLINT 3,
//! checking that the answers agree.
use sagebrush_arith::zpoly;
use sagebrush_bigint::BigInt;
use sagebrush_flint::FPoly;
use std::time::Instant;

fn time<T, F: FnMut() -> T>(mut f: F) -> (f64, T) {
    let t = Instant::now();
    let mut n = 0;
    let mut out;
    loop {
        out = f();
        n += 1;
        if t.elapsed().as_secs_f64() > 0.3 {
            break;
        }
    }
    (t.elapsed().as_secs_f64() / n as f64, out)
}

fn main() {
    let mut s = 0x9876_5432u64;
    let mut rnd = |bits: u32| -> BigInt {
        let mut x = BigInt::from(0);
        let mut b = 0;
        while b < bits {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let k = (bits - b).min(62);
            x = (x << k) + BigInt::from(s >> (64 - k));
            b += k;
        }
        if s & 1 == 1 { -x } else { x }
    };
    println!("{:<6} {:>6} {:>6} {:>12} {:>12} {:>7}", "op", "len", "bits", "sagebrush", "flint", "ratio");
    for (len, bits) in [(10, 10), (100, 10), (1000, 10), (10000, 10), (100, 1000), (1000, 1000), (100000, 20)] {
        let a: Vec<BigInt> = (0..len).map(|_| rnd(bits)).collect();
        let b: Vec<BigInt> = (0..len).map(|_| rnd(bits)).collect();
        let (fa, fb) = (FPoly::new(&a), FPoly::new(&b));
        let (ts, x) = time(|| zpoly::mul(&a, &b));
        let (tf, y) = time(|| fa.mul(&fb));
        assert_eq!(x, y.coeffs());
        println!("{:<6} {:>6} {:>6} {:>10.3}ms {:>10.3}ms {:>7.2}", "mul", len, bits, ts * 1e3, tf * 1e3, ts / tf);
        if len <= 10000 {
            // gcd of g a' and g b' with g of half the length
            let g: Vec<BigInt> = (0..len / 2).map(|_| rnd(bits)).collect();
            let a2: Vec<BigInt> = (0..len / 2).map(|_| rnd(bits)).collect();
            let b2: Vec<BigInt> = (0..len / 2 + 1).map(|_| rnd(bits)).collect();
            let (ga, gb) = (zpoly::mul(&g, &a2), zpoly::mul(&g, &b2));
            let (fga, fgb) = (FPoly::new(&ga), FPoly::new(&gb));
            let (ts, x) = time(|| zpoly::gcd(&ga, &gb));
            let (tf, y) = time(|| fga.gcd(&fgb));
            assert_eq!(x, y.coeffs());
            println!("{:<6} {:>6} {:>6} {:>10.3}ms {:>10.3}ms {:>7.2}", "gcd", len, bits, ts * 1e3, tf * 1e3, ts / tf);
        }
    }
}
