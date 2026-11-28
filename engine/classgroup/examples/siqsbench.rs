//! SIQS timing on products of two random primes:
//!   cargo run --release --example siqsbench -- BITS [COUNT [FB_SIZE M LP_MULT SLACK]]
//! BITS is the size of n; the parameters default to siqs::params(BITS).
use sagebrush_bigint::{BigInt, BigUint};
use sagebrush_classgroup::nf::{factor::is_probable_prime, siqs};
use std::time::Instant;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn prime(bits: u64, s: &mut u64) -> BigUint {
    loop {
        // the top bit and the low bit set
        let mut v = BigUint::from(1u32);
        for _ in 1..bits {
            v = (v << 1usize) + BigUint::from(rng(s) >> 63);
        }
        if v.bits() == bits && (&v % 2u32) == BigUint::from(1u32) && is_probable_prime(&BigInt::from(v.clone())) {
            return v;
        }
    }
}

fn main() {
    let args: Vec<u64> = std::env::args().skip(1).map(|a| a.parse().expect("a number")).collect();
    let bits = *args.first().unwrap_or(&160);
    let count = *args.get(1).unwrap_or(&5);
    let mut par = siqs::params(bits);
    if args.len() >= 6 {
        par = siqs::Params { fb_size: args[2] as usize, m: args[3] as usize, lp_mult: args[4], slack: args[5] as u32 };
    }
    println!("{} bits: {:?}, memory bound {} MB", bits, par, siqs::memory_bound(bits) >> 20);
    let mut s = 0x1234_5678_9abc_def1u64;
    let mut total = 0.0;
    for _ in 0..count {
        let n = prime(bits / 2, &mut s) * prime(bits - bits / 2, &mut s);
        let mut st = siqs::Stats::default();
        let t = Instant::now();
        let g = siqs::siqs_with(&n, &par, 1, &mut st).expect("the sieve's memory");
        let dt = t.elapsed().as_secs_f64();
        total += dt;
        println!("{:.3} s {} {:?}", dt, if g.is_some() { "ok" } else { "FAILED" }, st);
    }
    println!("mean {:.3} s", total / count as f64);
}
