//! The Smith form with transforms at many nontrivial invariant factors:
//! route 2 for every k >= 2 (issue https://github.com/sagemathinc/sagebrush/issues/1512,
//! where a 48 x 48 input with k = 9 took the classical elimination,
//! 2.96e11 units in about 6 minutes).  Each input checks U A V = D, the
//! route, its units against a ceiling and its attempts.  (A file of its
//! own: the 48 x 48 case is the slowest of the Smith tests' inputs.)

use num_traits::{One, Zero};
use sagebrush_arith::cost::tallied;
use sagebrush_arith::smith::{smith_form, Route, SmithForm};
use sagebrush_arith::zmat::ZMat;
use sagebrush_bigint::BigInt;

/// splitmix64
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
}

/// A signed entry of `bits` bits (bits <= 64).
fn entry(rng: &mut Rng, bits: u32) -> BigInt {
    let x = rng.next() >> (64 - bits);
    let x = BigInt::from(x);
    if rng.next() & 1 == 1 {
        -x
    } else {
        x
    }
}

/// An n x n input of `bits`-bit entries with its first `scaled` rows times
/// `p` (so k is at least `scaled` when the rest is nonsingular).
fn input(seed: u64, n: usize, bits: u32, scaled: usize, p: i64) -> ZMat {
    let mut rng = Rng(seed);
    let mut rows: Vec<Vec<BigInt>> = (0..n).map(|_| (0..n).map(|_| entry(&mut rng, bits)).collect()).collect();
    for row in rows.iter_mut().take(scaled) {
        for v in row.iter_mut() {
            *v = &*v * BigInt::from(p);
        }
    }
    ZMat::from_rows(rows)
}

/// The run's (form, units, k), checked: U A V = D, D diagonal with the
/// invariant factors dividing in order, and |det D| = |det a| (so U and V
/// are unimodular).
fn run(a: &ZMat) -> (SmithForm, u64, usize) {
    let t0 = tallied();
    let f = smith_form(a).expect("smith_form");
    let t1 = tallied();
    let units: u64 = (0..t0.0.len()).map(|i| t1.0[i].wrapping_sub(t0.0[i])).sum();
    let n = a.rows;
    assert_eq!(f.u.mul(a).mul(&f.v).d, f.d.d, "U A V = D");
    let diag: Vec<BigInt> = (0..n).map(|i| f.d.get(i, i).clone()).collect();
    for i in 0..n {
        for j in 0..n {
            assert!(i == j || f.d.get(i, j).is_zero(), "D diagonal");
        }
    }
    for w in diag.windows(2) {
        assert!(!w[0].is_zero() && (&w[1] % &w[0]).is_zero(), "the invariant factors divide in order");
    }
    // (U and V are integral and U A V = D, so det U det V = det D / det a:
    // |det D| = |det a| makes both of them +-1, unimodular)
    let det_d = diag.iter().fold(BigInt::one(), |p, x| p * x);
    let det_a = sagebrush_arith::zmat::det(a);
    assert!(det_d == det_a || det_d == -det_a, "|det D| = |det a|: U and V unimodular");
    let k = diag.iter().filter(|x| !x.is_one()).count();
    (f, units, k)
}

#[test]
fn many_invariant_factors_take_route_two() {
    // the issue's shape: 48 x 48, 64-bit entries, nine rows times 3 (k = 9
    // here); route 2 instead of the classical elimination's 2.96e11 units
    let a = input(1512, 48, 64, 9, 3);
    let (f, units, k) = run(&a);
    println!("48 x 48, 64 bits: k = {k}, {units} units, {} attempts", f.attempts);
    assert!(k > 8, "more than 8 nontrivial invariant factors (k = {k})");
    assert_eq!(f.route, Route::Trailing);
    assert!(units <= 1_000_000_000, "{units} units: route 2's ceiling for this input");
    assert!(f.attempts <= 4, "{} attempts", f.attempts);

    // k = n and k = n - 1 (every row, or all but the last, times a prime)
    for (n, bits, p) in [(24usize, 16u32, 2i64), (16, 64, 3), (32, 8, 5)] {
        for scaled in [n, n - 1] {
            let a = input(n as u64 * 100 + scaled as u64, n, bits, scaled, p);
            let (f, units, k) = run(&a);
            println!("{n} x {n}, {bits} bits, {scaled} rows times {p}: k = {k}, {units} units, {} attempts", f.attempts);
            assert_eq!(k, scaled, "k = {k}, {scaled} rows scaled");
            assert_eq!(f.route, Route::Trailing);
            assert!(units <= 200_000_000, "{units} units: route 2's ceiling at k = {k}");
            assert!(f.attempts <= 4, "{} attempts at k = {k}", f.attempts);
        }
    }
}
