//! The checked extended gcd and modular inverse against the plain extended
//! Euclid, on a fixed seed and count: uniform pairs, and pairs built near
//! where a Lehmer extended gcd can go wrong (near-equal lengths, sizes near
//! the multiplication thresholds, Fibonacci-like pairs whose quotients are
//! small, pairs one Lehmer step from x' = y', and a pair on which the dashu
//! fork's gcd_ext once returned wrong coefficients, with its neighbours).
//! Each result: x a + y b = g, g the reference's, and no fallback taken (the
//! check passes on dashu's own coefficients); each inverse: x a = 1 mod m.

#![cfg(not(feature = "num-backend"))]

use num_integer::Integer;
use num_traits::{Num, One, Zero};
use sagebrush_bigint::BigInt;

/// splitmix64.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    fn words(&mut self, n: usize) -> BigInt {
        let mut x = BigInt::zero();
        for _ in 0..n {
            x = (x << 64usize) + BigInt::from(self.next());
        }
        x
    }
}

/// The fork's regression pair (1034 bits).
fn pair() -> (BigInt, BigInt) {
    let p = BigInt::from_str_radix("3e305effa6bf927ddf078324565301a9e1aab659637a2771aa0f4de1fbe63cba2e987e1d4b50035ca373247017db5b73878e5189174fe80eb41e140024dcb69e88efd1beb1543647c167689a59794e7c4ed41516c42df9c75908b4ca6fe41a48c0581cba7c9a90d286c0df21198ac314f9d2e53248d790d152fb8651e6338a1aba6", 16).unwrap();
    let a = BigInt::from_str_radix("21a005a143e3b14283ba84db2d9700a84d51263e60a4e8eb97ba35712a94628e4418db57e691913e5ad7e9aaf4cc7314ef57d93935791caf77d7da3d3da1aae6be8ebe887be1e6b19ead96d799e0d2f126a4ebc4390f4b9df621e9ec0037feeaaab3034a917352b217a375c4c48b835626442bfa1df42bc85e9f104468a5737c727", 16).unwrap();
    (p, a)
}

fn check(a: &BigInt, b: &BigInt) {
    let (e, fallback) = sagebrush_bigint::extended_gcd_metered(a, b);
    assert_eq!(fallback, None, "the check failed on dashu's coefficients: {a}, {b}");
    assert_eq!(&e.x * a + &e.y * b, e.gcd, "x a + y b = g: {a}, {b}");
    let (g, _, _) = sagebrush_bigint::xgcd_euclid(&a.0, &b.0, &mut vec![]);
    assert_eq!(e.gcd.0, g, "the reference's gcd: {a}, {b}");
    if !b.is_zero() {
        let (inv, fallback) = sagebrush_bigint::modinv_metered(a, b);
        assert_eq!(fallback, None, "the inverse's check failed: {a} mod {b}");
        match inv {
            Some(x) => assert!((&x * a - BigInt::one()).mod_floor(b).is_zero(), "x a = 1 mod m: {a} mod {b}"),
            None => assert!(!e.gcd.is_one() || b.abs_is_one(), "no inverse, but gcd 1: {a} mod {b}"),
        }
    }
}

trait AbsOne {
    fn abs_is_one(&self) -> bool;
}
impl AbsOne for BigInt {
    fn abs_is_one(&self) -> bool {
        self.is_one() || (-self.clone()).is_one()
    }
}

#[test]
fn the_checked_extended_gcd_matches_the_reference() {
    let t0 = std::time::Instant::now();
    let mut rng = Rng(0x1567);
    let mut cases = 0u32;
    // uniform, 1 to 64 words, signs mixed
    for _ in 0..1500 {
        let (la, lb) = (1 + (rng.next() % 64) as usize, 1 + (rng.next() % 64) as usize);
        let (mut a, mut b) = (rng.words(la) + BigInt::one(), rng.words(lb) + BigInt::one());
        if rng.next() & 1 == 1 {
            a = -a;
        }
        if rng.next() & 1 == 1 {
            b = -b;
        }
        check(&a, &b);
        cases += 1;
    }
    // near-equal lengths and sizes near the thresholds (in words)
    for &n in &[2usize, 3, 4, 7, 8, 9, 15, 16, 17, 23, 24, 25, 31, 32, 33, 47, 48, 49, 63, 64, 65, 95, 96, 97] {
        for _ in 0..12 {
            let a = rng.words(n) + BigInt::one();
            let b = rng.words(n) + BigInt::one();
            let c = &a + (BigInt::from(rng.next()) >> (rng.next() % 64) as usize);
            check(&a, &b);
            check(&c, &a);
            cases += 2;
        }
    }
    // Fibonacci-like (quotients 1) with a perturbation
    for steps in [100usize, 300, 600, 1000, 1500] {
        let (mut f0, mut f1) = (BigInt::from(rng.next() | 1), BigInt::from(rng.next() | 1));
        for _ in 0..steps {
            let f2 = &f0 + &f1;
            f0 = f1;
            f1 = f2;
        }
        for k in 0..8u64 {
            check(&(&f1 + BigInt::from(k)), &f0);
            cases += 1;
        }
    }
    // one Lehmer step from x' = y' + small: (x, y) = M (x', y') for M a
    // product of [[q, 1], [1, 0]] with small q
    for _ in 0..300 {
        let n = 3 + (rng.next() % 24) as usize;
        let y = rng.words(n);
        let x = &y + (BigInt::from(rng.next()) >> (rng.next() % 64) as usize);
        let (mut m, mut mm) = ((BigInt::one(), BigInt::zero()), (BigInt::zero(), BigInt::one()));
        for _ in 0..1 + rng.next() % 12 {
            let q = BigInt::from(1 + rng.next() % 1000);
            m = (&m.0 * &q + &m.1, m.0);
            mm = (&mm.0 * &q + &mm.1, mm.0);
        }
        check(&(&m.0 * &x + &m.1 * &y), &(&mm.0 * &x + &mm.1 * &y));
        cases += 1;
    }
    // the regression pair, both orders and signs, and its neighbours
    let (p, a) = pair();
    for (x, y) in [(&p, &a), (&a, &p)] {
        for (sx, sy) in [(1i64, 1i64), (-1, 1), (1, -1), (-1, -1)] {
            check(&(x * BigInt::from(sx)), &(y * BigInt::from(sy)));
            cases += 1;
        }
    }
    for k in -64i64..64 {
        check(&(&p + BigInt::from(k)), &a);
        check(&p, &(&a + BigInt::from(k)));
        cases += 2;
    }
    println!("{cases} cases in {:.2} s", t0.elapsed().as_secs_f64());
}
