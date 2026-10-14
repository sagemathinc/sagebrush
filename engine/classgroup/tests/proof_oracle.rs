//! The unconditional certificate (nf/proof.rs) against Sage's
//! K.class_group(proof=True) and K.regulator() (PARI's bnfcertify) on 300
//! fields of degree 2 to 6 (tests/proof_fixture.txt, from
//! oracle/make_proof_fixture.sage; Sage only as an oracle).  The default
//! run takes every tenth field; `cargo test --release -- --ignored` all.

use sagebrush_bigint::BigInt;
use sagebrush_classgroup::nf::proof::{certify, Limits};

fn check(every: usize) {
    let text = include_str!("proof_fixture.txt");
    let mut n = 0;
    for (i, line) in text.lines().enumerate() {
        if i % every != 0 {
            continue;
        }
        let parts: Vec<&str> = line.split('|').map(|s| s.trim()).collect();
        let f: Vec<BigInt> = parts[0].split(',').map(|c| c.parse().unwrap()).collect();
        let disc: BigInt = parts[1].parse().unwrap();
        let cyc: Vec<BigInt> = if parts[2].is_empty() { vec![] } else { parts[2].split(',').map(|c| c.parse().unwrap()).collect() };
        let reg: f64 = parts[3].parse().unwrap();
        let p = certify(&f, &Limits::default()).unwrap_or_else(|e| panic!("{}: {}", parts[0], e));
        assert_eq!(p.disc, disc, "{}", parts[0]);
        assert_eq!(p.cyc, cyc, "{}", parts[0]);
        assert_eq!(p.h, cyc.iter().product::<BigInt>(), "{}", parts[0]);
        // Sage's regulator to 15 digits, inside our enclosure (widened by
        // that rounding)
        assert!(p.reg_lo <= reg * (1.0 + 1e-13) && p.reg_hi >= reg * (1.0 - 1e-13), "{}: {} not in [{}, {}]", parts[0], reg, p.reg_lo, p.reg_hi);
        n += 1;
    }
    assert!(n >= 300 / every, "{} fields", n);
}

#[test]
fn against_sage_sample() {
    check(10);
}

#[test]
#[ignore]
fn against_sage_all() {
    check(1);
}
