//! A sum where the smaller operand reaches into the larger one's extra bits
//! (an operand of more bits than the precision asked for): the exact sum
//! rounded once, as MPFR gives it, where mpmath 1.3.0's shortcut (the
//! smaller operand as one sticky bit) is wrong in 16 of these 80 cases,
//! precisions 1 to 256, both signs, every rounding.  tests/data/add-sticky.txt:
//! cases of corpus.rs's form, the expected value MPFR's (gmpy2 at 512 bits,
//! then rounded); then 53 bits to nearest, 1, not 1 + 2^-52; and last, from
//! a random corpus of mpmath's own cases, (2^64 + 1.5) - 1.7069... rounded
//! down to 23 bits: 0x7fffff 2^41, where mpmath gave 2^64, above the sum.
//! Then the same 82 with the operands swapped (the larger second: the
//! shortcut's mirrored branch), each expected value rounded independently
//! from the exact sum, so each branch's guard is needed on its own.
use sagebrush_mp::fail::checked;
use sagebrush_mp::mpf::{mpf_add, Rnd};
mod common;
use common::*;

#[test]
fn the_smaller_operand_within_the_larger_ones_bits() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/add-sticky.txt")).unwrap();
    let (mut n, mut bad, mut first, mut second) = (0, vec![], 0, 0);
    for line in text.lines() {
        let w: Vec<&str> = line.split(' ').collect();
        let rnd = Rnd::from_code("nfcdu".find(w[1]).unwrap() as u32).unwrap();
        let prec: u64 = w[2].parse().unwrap();
        let (s, t) = (parse(&w[3..7]), parse(&w[7..11]));
        match s.exp.cmp(&t.exp) {
            std::cmp::Ordering::Greater => first += 1,
            std::cmp::Ordering::Less => second += 1,
            std::cmp::Ordering::Equal => {}
        }
        let got = show(&checked(|| mpf_add(&s, &t, prec, rnd, w[0] == "sub")));
        if got != w[11..].join(" ") {
            bad.push(format!("{} => {}", line, got));
        }
        n += 1;
    }
    assert_eq!((n, first, second), (164, 82, 82));
    assert!(bad.is_empty(), "{} of {} wrong:\n{}", bad.len(), n, bad.join("\n"));
}
