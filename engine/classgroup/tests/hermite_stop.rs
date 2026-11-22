//! What a Stop partway through charges: the work done before it, never the
//! work to come.  A Stop is armed at the second check (after one full
//! column or row), and the units tallied up to it are pinned against a
//! prefix rebuilt here from the input: the input's setup, then the first
//! iteration's work, family by family.  A count moved ahead of its work
//! (before the iteration's flush and check) charges the next iteration's
//! share too and fails here.  (A file of its own: the Stop hooks are
//! global.  Native only: a Stop unwinds, and wasm32 aborts on a panic.)

#![cfg(not(target_arch = "wasm32"))]

use num_integer::Integer;
use sagebrush_arith::cost::{bigdiv_units, bigmul_units, bigxgcd_units, tallied, Family, Units, FAMILIES};
use sagebrush_arith::zmat::limbs;
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::linalg;
use sagebrush_interrupt::hooks;

/// The units tallied by `f` when a Stop is armed at its second check (the
/// call must be stopped there).
fn stopped_at_second_check<T>(f: impl FnOnce() -> T) -> [u64; FAMILIES] {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::arm_at(2);
    let before = tallied();
    let r = sagebrush_interrupt::catch(f);
    let after = tallied();
    assert!(r.is_err(), "stopped at the second check");
    assert_eq!(hooks::total(), 2, "the Stop came at the second check");
    // (the request stays set until cleared)
    sagebrush_interrupt::clear();
    hooks::reset();
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

/// The quotient steps of Euclid's algorithm on (a, b), counted here.
fn euclid_steps(mut a: i128, mut b: i128) -> u64 {
    let mut steps = 0;
    while b != 0 {
        (a, b) = (b, a.rem_euclid(b));
        steps += 1;
    }
    steps
}

fn add(acc: &mut [u64; FAMILIES], u: Units) {
    for (a, x) in acc.iter_mut().zip(u.0) {
        *a += x;
    }
}

#[test]
fn a_stop_charges_only_the_work_before_it() {
    // det_mod_p: the input's reductions, then column 0 (the second check
    // opens column 1).  Entries 1..=97, all nonzero mod p: no swap, every
    // row eliminated.
    let n = 6;
    let p: u64 = 1_000_003;
    let m: Vec<Vec<i64>> = (0..n).map(|i| (0..n).map(|j| ((7 * i + 11 * j + 3) % 97 + 1) as i64).collect()).collect();
    let got = stopped_at_second_check(|| linalg::det_mod_p(&m, p));
    let n64 = n as u64;
    let mut want = [0; FAMILIES];
    // (the input's n^2 reductions; the column's n; the det's Barrett
    // product; the inverse, its Euclid steps on (p, a_00) and the call; the
    // pivot row's n - 1; a Barrett product per eliminated row)
    let inverse = euclid_steps(p as i128, m[0][0] as i128) + 1;
    want[Family::ModArith as usize] = n64 * n64 + n64 + 1 + inverse + (n64 - 1) + (n64 - 1);
    // (the n - 1 rows' multiply-adds, n - 1 each)
    want[Family::MulSchool as usize] = (n64 - 1) * (n64 - 1);
    assert_eq!(got, want, "det_mod_p stopped at column 1: its input and column 0");

    // hnf_mod_until (through hnf_mod_small): the start, then row 0.  Row 0
    // is (x, 0, ..., 0) with x not a multiple of d, so it meets one pivot,
    // w_00 = d, by the extended gcd; the rest of v stays 0.
    let n = 5;
    let d: i128 = (1 << 61) - 1;
    let x: i64 = 1_000_003;
    let mut rows = vec![vec![0i64; n]; 3];
    rows[0][0] = x;
    rows[1][1] = 7;
    rows[2][2] = 11;
    let got = stopped_at_second_check(|| linalg::hnf_mod_small(&rows, n, d));
    let n64 = n as u64;
    let mut want = [0; FAMILIES];
    // (the start's n^2 entries)
    want[Family::Move as usize] = n64 * n64;
    // (row 0's n reductions; the pivot's divisibility test, two divisions
    // by g, a negation, the cofactors' two reductions, six operations per
    // entry of the n, g's reduction; and the extended gcd's steps)
    want[Family::ModArith as usize] = n64 + 6 + 6 * n64 + 1 + euclid_steps(d, x as i128);
    assert_eq!(got, want, "hnf_mod_until stopped at row 1: its start and row 0");

    // hnf_mod with a big d: the start, then row 0, again (x, 0, ..., 0),
    // now with BigInt arithmetic modulo d = 3^130 (x = 2 is prime to it)
    let n = 4;
    let d = num_traits::pow(BigInt::from(3), 130);
    let x = BigInt::from(2);
    let mut rows = vec![vec![0i64; n]; 3];
    rows[0][0] = 2;
    rows[1][1] = 5;
    rows[2][2] = 7;
    let got = stopped_at_second_check(|| linalg::hnf_mod(&rows, n, &d));
    let ld = limbs(&d);
    let mut want = [0; FAMILIES];
    // (the start: the n^2 - n zeros, d's copy and n of it on the diagonal)
    want[Family::Move as usize] = (n * n - n + (n + 1) * ld) as u64;
    // (row 0's n reductions mod d, a one-limb value each)
    for _ in 0..n {
        add(&mut want, bigdiv_units(1, ld));
    }
    // the pivot: the full gcd of (d, x), the divisions of d and x by g = 1,
    // the two new rows (Move), then per entry j the four products and two
    // reductions mod d, with w_0 = (d, 0, ...) and v = (x, 0, ...); then
    // g's two copies
    let e = d.extended_gcd(&x);
    assert!(e.gcd == BigInt::from(1));
    let (lx, ly, lg) = (limbs(&e.x), limbs(&e.y), limbs(&e.gcd));
    let (lwi, lvi) = (limbs(&(&d / &e.gcd)), limbs(&(&x / &e.gcd)));
    // (the extended gcd, checked on its coefficients)
    add(&mut want, bigxgcd_units(ld, limbs(&x), lg));
    add(&mut want, bigdiv_units(ld, lg));
    add(&mut want, bigdiv_units(limbs(&x), lg));
    want[Family::Move as usize] += 2 * n as u64;
    for j in 0..n {
        let (a, b) = if j == 0 { (ld, limbs(&x)) } else { (1, 1) };
        add(&mut want, bigmul_units(lx + lvi, a));
        add(&mut want, bigmul_units(ly + lwi, b));
        add(&mut want, bigdiv_units((lx + a).max(ly + b), ld));
        add(&mut want, bigdiv_units((lwi + b).max(lvi + a), ld));
    }
    want[Family::Move as usize] += 2 * lg as u64;
    assert_eq!(got, want, "hnf_mod stopped at row 1: its start and row 0");
}
