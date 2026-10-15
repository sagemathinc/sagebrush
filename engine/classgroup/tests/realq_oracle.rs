//! Real quadratic class groups and regulators (realq.rs, under GRH) against
//! Sage's QuadraticField(D).class_group() and regulator() for every
//! fundamental discriminant 1000 <= D < 6000 (tests/realq_fixture.txt:
//! D | invariants | regulator to 15 digits; Sage only as an oracle).  Many
//! of these used to fail: "no convergence" when the elimination left no
//! columns, and a panic (an empty slice indexed) at D = 2077.  The default
//! run takes every eighth discriminant; `cargo test --release -- --ignored`
//! all of them.  A seeded sweep over larger D checks that every one returns
//! a certified answer and never panics.

use sagebrush_bigint::BigInt;
use sagebrush_classgroup::realq::class_group_real;

fn check(every: usize) {
    let text = include_str!("realq_fixture.txt");
    let mut n = 0;
    for (i, line) in text.lines().enumerate() {
        if i % every != 0 {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        let d: BigInt = parts[0].parse().unwrap();
        let cyc: Vec<BigInt> = if parts[1].is_empty() { vec![] } else { parts[1].split(',').map(|c| c.parse().unwrap()).collect() };
        let reg: f64 = parts[2].parse().unwrap();
        let (r, _) = class_group_real(&d).unwrap_or_else(|e| panic!("D = {}: {}", d, e));
        assert_eq!(r.group.cyc, cyc, "D = {}", d);
        assert_eq!(r.group.h, cyc.iter().product::<BigInt>(), "D = {}", d);
        assert!(r.certified, "D = {}: not certified", d);
        // Sage's regulator to 15 significant digits
        assert!((r.regulator - reg).abs() <= 1e-12 * reg, "D = {}: regulator {} vs {}", d, r.regulator, reg);
        n += 1;
    }
    assert!(n >= 1524 / every, "{} discriminants", n);
}

#[test]
fn against_sage_sample() {
    check(8);
}

#[test]
#[ignore]
fn against_sage_all() {
    check(1);
}

fn squarefree(mut m: u64) -> bool {
    let mut p = 2;
    while p * p <= m {
        if m % (p * p) == 0 {
            return false;
        }
        while m % p == 0 {
            m /= p;
        }
        p += 1;
    }
    true
}

fn fundamental(d: u64) -> bool {
    match d % 4 {
        1 => squarefree(d),
        0 => matches!((d / 4) % 4, 2 | 3) && squarefree(d / 4),
        _ => false,
    }
}

/// Fundamental discriminants from 10^3 to 10^10 (a fixed pseudo-random
/// sample): each must give a certified class group with h the product of
/// the invariants and a positive regulator; a panic fails the test.
#[test]
fn larger_discriminants_never_panic() {
    let mut x: u64 = 0x9e3779b97f4a7c15;
    let mut done = 0;
    while done < 40 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let digits = 3 + (x % 8) as u32; // 10^3 .. 10^10
        let lo = 10u64.pow(digits);
        let d = lo + (x >> 8) % (9 * lo);
        if !fundamental(d) {
            continue;
        }
        let db = BigInt::from(d);
        let r = std::panic::catch_unwind(|| class_group_real(&db));
        let (r, _) = match r {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => panic!("D = {}: {}", d, e),
            Err(_) => panic!("D = {}: panicked", d),
        };
        assert_eq!(r.group.h, r.group.cyc.iter().product::<BigInt>(), "D = {}", d);
        assert!(r.regulator > 0.48, "D = {}", d);
        assert!(r.certified, "D = {}: not certified", d);
        done += 1;
    }
}
