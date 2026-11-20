//! mpmath's integer square roots against the python backend: when MP_ISQRT
//! names a file of `fast x r`, `small x r` and `sqrtrem x y rem` lines
//! (hex), every result must be identical.

use sagebrush_mp::intmath::{isqrt_fast_python, isqrt_small_python, sqrtrem_python};
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
fn isqrt() {
    let Ok(path) = std::env::var("MP_ISQRT") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split(' ').collect();
        let x = hex_nat(w[1]);
        let ok = match w[0] {
            "fast" => isqrt_fast_python(&x) == hex_nat(w[2]),
            "small" => isqrt_small_python(&x) == hex_nat(w[2]),
            "sqrtrem" => sqrtrem_python(&x) == (hex_nat(w[2]), hex_nat(w[3])),
            op => panic!("op {}", op),
        };
        n += 1;
        if !ok {
            bad += 1;
            if bad <= 6 {
                eprintln!("MISMATCH {}", &line[..line.len().min(200)]);
            }
        }
    }
    eprintln!("{} cases, {} mismatches", n, bad);
    assert_eq!(bad, 0);
}
