//! Times multivariate factorization: f (f + 1) for f = (1 + x + y + z + t)^k
//! and a product of random sparse polynomials.
use sagebrush_bigint::BigInt;
use sagebrush_mpoly::{factor::factor_z, ZPoly};
use std::time::Instant;

fn lin(n: usize) -> ZPoly {
    let mut t = vec![(vec![0; n], BigInt::from(1))];
    for j in 0..n {
        let mut e = vec![0; n];
        e[j] = 1;
        t.push((e, BigInt::from(1)));
    }
    ZPoly::from_terms(n, t).unwrap()
}

fn rnd(n: usize, terms: usize, deg: u64, cmax: i64, seed: &mut u64) -> ZPoly {
    let mut next = || {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    };
    let t = (0..terms).map(|_| {
        let e: Vec<u64> = (0..n).map(|_| next() % (deg + 1)).collect();
        (e, BigInt::from((next() % (2 * cmax as u64 + 1)) as i64 - cmax))
    }).collect();
    ZPoly::from_terms(n, t).unwrap()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let which = args.get(1).map(|s| s.as_str()).unwrap_or("all");
    if which == "all" || which == "fateman" {
        for k in [5u64, 10, 15] {
            let f = lin(4).pow(k).unwrap();
            let one = ZPoly::from_terms(4, vec![(vec![0; 4], BigInt::from(1))]).unwrap();
            let g = f.mul(&f.add_signed(&one, false)).unwrap();
            let t = Instant::now();
            let (_, fs) = factor_z(&g).unwrap();
            println!("fateman k={:2}: {} factors in {:.3}s", k, fs.len(), t.elapsed().as_secs_f64());
        }
    }
    if which == "all" || which == "random" {
        let mut seed = 0x1234567u64;
        for d in [4u64, 6, 8] {
            let a = rnd(4, 8, d, 100, &mut seed);
            let b = rnd(4, 8, d, 100, &mut seed);
            let c = rnd(4, 6, d, 100, &mut seed);
            let g = a.mul(&b).unwrap().mul(&c).unwrap();
            let t = Instant::now();
            let (_, fs) = factor_z(&g).unwrap();
            println!("random deg {}: {} terms, {} factors in {:.3}s", d, g.len(), fs.len(), t.elapsed().as_secs_f64());
        }
    }
}
