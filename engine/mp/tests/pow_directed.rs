//! mpf_pow with a directed rounding: the result on its side of the true
//! value.  The reference rounds log s in the result's direction, which a
//! negative exponent turns around, so 8 of a 1500-case grid (precisions 1 to
//! 256, every rounding) came out on the wrong side: tests/data/pow-directed.txt
//! has them with MPFR's correctly rounded value, which a result rounded up
//! must be at least and one rounded down at most.  tests/data/pow-grid.txt,
//! the grid with mpmath 1.3.0's raw results: every other case is still
//! exactly the reference's.
use sagebrush_mp::elefun::mpf_pow;
use sagebrush_mp::fail::checked;
use sagebrush_mp::mpf::{mpf_add, Mpf, Rnd};
mod common;
use common::*;

fn case(line: &str) -> (String, Rnd, Mpf, Mpf, u64, String) {
    let (lhs, want) = line.split_once(" => ").unwrap();
    let w: Vec<&str> = lhs.split(' ').collect();
    assert_eq!(w[0], "pow");
    let rnd = Rnd::from_code("nfcdu".find(w[1]).unwrap() as u32).unwrap();
    (w[1].to_string(), rnd, parse(&w[3..7]), parse(&w[7..11]), w[2].parse().unwrap(), want.to_string())
}

#[test]
fn directed_powers_on_their_side() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/pow-directed.txt")).unwrap();
    let mut n = 0;
    for line in text.lines() {
        let (code, rnd, s, t, prec, mpfr) = case(line);
        let got = checked(|| mpf_pow(&s, &t, prec, rnd)).unwrap();
        let w: Vec<&str> = mpfr.split(' ').collect();
        let d = mpf_add(&got, &parse(&w), 0, Rnd::Down, true);
        let up = code == "c" || code == "u";
        // (got - MPFR's: at least 0 rounded up, at most 0 rounded down)
        let side_ok = d.man.is_zero() || (d.sign == 0) == up;
        assert!(side_ok, "{} => {}", line, show(&Ok(got)));
        n += 1;
    }
    assert_eq!(n, 8);
}

#[test]
fn every_other_power_is_the_references() {
    let directed = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/pow-directed.txt")).unwrap();
    let moved: Vec<&str> = directed.lines().map(|l| l.split_once(" => ").unwrap().0).collect();
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/pow-grid.txt")).unwrap();
    let (mut n, mut bad) = (0, vec![]);
    for line in text.lines() {
        if moved.contains(&line.split_once(" => ").unwrap().0) {
            continue;
        }
        let (_, rnd, s, t, prec, want) = case(line);
        let got = show(&checked(|| mpf_pow(&s, &t, prec, rnd)));
        if got != want {
            bad.push(format!("{} => {}", line, got));
        }
        n += 1;
    }
    assert_eq!(n, 1492);
    assert!(bad.is_empty(), "{} of {}:\n{}", bad.len(), n, bad.join("\n"));
}

/// Near-integer exponents, t = +-(n +- 2^-j) for n = 1, 2 and j = 64, 192,
/// of s = 2, 3, 10, at 1, 53 and 113 bits, every directed rounding, against
/// MPFR's correctly rounded value (tests/data/pow-near-integer.txt): each on
/// its side (a bound at a fixed precision left 2^-(1 - 2^-64) rounded up at
/// 1 bit as 1/2, below the true value, until the precision was raised).
#[test]
fn near_integer_exponents_on_their_side() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/pow-near-integer.txt")).unwrap();
    let (mut n, mut bad) = (0, vec![]);
    for line in text.lines() {
        let (code, rnd, s, t, prec, mpfr) = case(line);
        let got = checked(|| mpf_pow(&s, &t, prec, rnd)).unwrap();
        let w: Vec<&str> = mpfr.split(' ').collect();
        let d = mpf_add(&got, &parse(&w), 0, Rnd::Down, true);
        let up = code == "c" || code == "u";
        if !(d.man.is_zero() || (d.sign == 0) == up) {
            bad.push(format!("{} => {}", line, show(&Ok(got))));
        }
        n += 1;
    }
    assert_eq!(n, 576);
    assert!(bad.is_empty(), "{} of {} on the wrong side:\n{}", bad.len(), n, bad.join("\n"));
    // (the two cases from the review, exactly MPFR's: 2^-(1 - 2^-64) rounded
    // up at 1 bit is 1, and 2^-(1 - 2^-192) at 53 bits is 1/2 + 2^-53)
    let up = |t: &[&str], p| show(&checked(|| mpf_pow(&parse(&["0", "1", "1", "1"]), &parse(t), p, Rnd::Ceiling)));
    assert_eq!(up(&["1", "ffffffffffffffff", "-64", "64"], 1), "0 1 0 1");
    assert_eq!(up(&["1", &"f".repeat(48), "-192", "192"], 53), "0 10000000000001 -53 53");
}
