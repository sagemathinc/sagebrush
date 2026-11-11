//! The constants' memo against the reference: MP_CONSTS names a file of
//! `name prec hex` lines written by one python-backend session; replayed in
//! order in one fresh session, every value must be identical.

use sagebrush_mp::consts::{e_fixed, ln2_fixed, pi_fixed, reset};
use sagebrush_mp::nat::Nat;

fn hex_nat(s: &str) -> Nat {
    let mut limbs = Vec::new();
    let mut end = s.len();
    while end > 0 {
        let start = end.saturating_sub(16);
        limbs.push(u64::from_str_radix(&s[start..end], 16).unwrap());
        end = start;
    }
    Nat::from_limbs(&limbs)
}

#[test]
fn consts() {
    let Ok(path) = std::env::var("MP_CONSTS") else { return };
    reset();
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split(' ').collect();
        let p: i64 = w[1].parse().unwrap();
        let got = match w[0] {
            "pi" => pi_fixed(p),
            "ln2" => ln2_fixed(p),
            "e" => e_fixed(p),
            f => panic!("{}", f),
        };
        n += 1;
        if got != hex_nat(w[2]) {
            bad += 1;
            if bad <= 5 {
                eprintln!("MISMATCH {} {}", w[0], w[1]);
            }
        }
    }
    eprintln!("{} cases, {} mismatches", n, bad);
    assert_eq!(bad, 0);
}
