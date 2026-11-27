//! The float primitives against CPython (design/mpmath-core.md §6.1, the
//! parameter-choice pins): when MP_FLOATS names a file of `log x r` and
//! `pow x y r` lines (f64 bit patterns in hex, from CPython's math.log and
//! x ** y), every result must be identical bit for bit.

use sagebrush_mp::glibm::{log, pow};

#[test]
fn floats() {
    let Ok(path) = std::env::var("MP_FLOATS") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let h = |s: &str| f64::from_bits(u64::from_str_radix(s, 16).unwrap());
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split(' ').collect();
        let (got, want) = match w[0] {
            "log" => (log(h(w[1])), h(w[2])),
            "pow" => (pow(h(w[1]), h(w[2])), h(w[3])),
            op => panic!("op {}", op),
        };
        n += 1;
        if got.to_bits() != want.to_bits() && !(got.is_nan() && want.is_nan()) {
            bad += 1;
            if bad <= 8 {
                eprintln!("MISMATCH {}  got {:x} ({:e})", line, got.to_bits(), got);
            }
        }
    }
    eprintln!("{} cases, {} mismatches", n, bad);
    assert_eq!(bad, 0);
}
