//! What a Stop partway through the Smith form with transforms charges: the
//! work done before it, never the work to come.  A Stop is armed at the
//! second check of each route (the start of its second attempt, or of the
//! classical elimination's second pass), and the units tallied up to it
//! are pinned against a prefix rebuilt here from the input, family by
//! family.  A count moved ahead of its iteration's flush and check charges
//! the next iteration's share too and fails here.  (A file of its own: the
//! Stop hooks are global.  Native only: a Stop unwinds, and wasm32 aborts
//! on a panic.)

#![cfg(not(target_arch = "wasm32"))]

use num_integer::Integer;
use sagebrush_arith::cost::{bigmul_units, tallied, Family, FAMILIES};
use sagebrush_arith::smith;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;

/// The units tallied by `f` when a Stop is armed at its second check (the
/// call must be stopped there).
fn stopped_at_second_check<T>(f: impl FnOnce() -> T) -> [u64; FAMILIES] {
    stopped_at_check(2, f)
}

/// The units tallied by `f` when a Stop is armed at its `at`-th check.
fn stopped_at_check<T>(at: u64, f: impl FnOnce() -> T) -> [u64; FAMILIES] {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::arm_at(at);
    let before = tallied();
    let r = sagebrush_interrupt::catch(f);
    let after = tallied();
    assert!(r.is_err(), "stopped at the second check");
    assert_eq!(hooks::total(), at, "the Stop came at the armed check");
    // (the request stays set until cleared)
    sagebrush_interrupt::clear();
    hooks::reset();
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

fn z(rows: &[&[i64]]) -> ZMat {
    ZMat::from_rows(rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect())
}

/// The quotient steps of Euclid's algorithm on (a, b), counted here.
fn euclid_steps(mut a: i64, mut b: i64) -> u64 {
    let mut steps = 0;
    while b != 0 {
        (a, b) = (b, a.rem_euclid(b));
        steps += 1;
    }
    steps
}

#[test]
fn a_stop_charges_only_the_work_before_it() {
    // route 1, word delta: a = [[3, 8], [6, 1]], a^-1 = [[-1, 8], [6, -3]] / 45.
    // The first check follows the residues of N (4, one ModArith unit each);
    // the second opens attempt 1, after attempt 0 (r = 0): y = N_2 mod 45 =
    // (6, 42), the gcd fold from g = 45 (Euclid steps, plus a multiplier
    // update per earlier multiplier), which does not reach 1 (both are
    // multiples of 3).
    let a = z(&[&[3, 8], &[6, 1]]);
    let (nm, den, _) = zmat::inverse_det(&a).unwrap();
    assert_eq!((nm.d.clone(), den.clone()), ([-1i64, 8, 6, -3].map(BigInt::from).to_vec(), BigInt::from(45)));
    let got = stopped_at_second_check(|| smith::cyclic_route(&nm, &den));
    let y = [6i64.rem_euclid(45), (-3i64).rem_euclid(45)];
    let mut fold = 0;
    let (mut g, mut multipliers) = (45i64, 0u64);
    for &yj in &y {
        fold += euclid_steps(g, yj) + multipliers;
        g = g.gcd(&yj);
        multipliers += 1;
    }
    assert_eq!(g, 3);
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = 4 + fold;
    assert_eq!(got, want, "route 1 stopped at attempt 1: N's residues and attempt 0");
    // and at the third check (attempt 2), after attempt 1 too: its one
    // entry r is drawn from [0, 2) by the fixed xorshift (one word, Move),
    // here r = 1 (the sequence is rebuilt below), so y = N_1 + N_2 = (5, 5)
    // mod 45 costs the residue of r and a product-and-sum per entry (3
    // ModArith), and its fold from g = 45 (Euclid steps, multiplier
    // updates) again does not reach 1 (both are multiples of 5)
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    s ^= s << 13;
    s ^= s >> 7;
    s ^= s << 17;
    let r1 = (s & 1) as i64;
    assert_eq!(r1, 1, "attempt 1 draws r = 1");
    let got = stopped_at_check(3, || smith::cyclic_route(&nm, &den));
    let y1 = [(6 - r1).rem_euclid(45), (r1 * 8 - 3).rem_euclid(45)];
    let mut fold1 = 0;
    let (mut g, mut multipliers) = (45i64, 0u64);
    for &yj in &y1 {
        fold1 += euclid_steps(g, yj) + multipliers;
        g = g.gcd(&yj);
        multipliers += 1;
    }
    assert_eq!(g, 5);
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = 4 + fold + 3 + fold1;
    want[Family::Move as usize] = 1;
    assert_eq!(got, want, "route 1 stopped at attempt 2: N's residues, attempts 0 and 1");

    // route 2, word delta: a = [[2, 0, 0], [0, 2, -1], [0, 0, 1]], a^-1 =
    // [[1, 0, 0], [0, 1, 1], [0, 0, 2]] / 2 (k = 2, |det| = 4).  The first
    // check follows the residues of N (9); the second opens attempt 1,
    // after attempt 0 (R = 0): Y = the last two rows of N mod 2 =
    // [[0, 1, 1], [0, 0, 0]].  Its pivot needs a column swap (Move: the two
    // columns of Y's k = 2 rows), then one plain elimination of column 2 by
    // the pivot (ModArith: the entry's test, and a product-and-reduction on
    // each of Y's 2 rows); the second pivot is missing (rank 1).  Then the
    // gcds with delta: gcd(1, 2) in one Euclid step, gcd(0, 2) in none
    // (ModArith); and the order test, prod delta / g_j: two divisions of
    // delta (Div) and two products (MulSchool), one limb each.  The attempt
    // fails (rank 1 < 2), so its charge is a failed attempt's.  (The pivot
    // searches read entries, Move: up to (0, 1), 2; then the empty block
    // of rows >= 1 and columns >= 1, 2.  With a word delta the order
    // test's divisions are ModArith.)
    let a = z(&[&[2, 0, 0], &[0, 2, -1], &[0, 0, 1]]);
    let (nm, den, det) = zmat::inverse_det(&a).unwrap();
    assert_eq!((nm.d.clone(), den.clone(), det.clone()), ([1i64, 0, 0, 0, 1, 1, 0, 0, 2].map(BigInt::from).to_vec(), BigInt::from(2), BigInt::from(4)));
    let got = stopped_at_second_check(|| smith::trailing_route(&nm, &den, &det, 2));
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = 9 + (1 + 2) + euclid_steps(2, 1) + euclid_steps(2, 0) + 2;
    want[Family::Move as usize] = (2 + 2) + (2 + 2);
    want[Family::MulSchool as usize] = 2;
    assert_eq!(got, want, "route 2 stopped at attempt 1: N's residues and the failed attempt 0");

    // the classical elimination: a = [[2, 4], [6, 8]].  The first check
    // follows the setup (a's copy, 4 one-limb entries, and the two
    // identities' 4 + 4 entries: Move); the second opens pass 2, after pass
    // 1: the pivot search (4 nonzero entries, an absolute value each) and
    // the swaps (m + n = 4), Move; the quotients 6 // 2 and 4 // 2 and the
    // divisibility test of -4 by 2, Div; the products row_1 -= 3 row_0 on
    // a (2 nonzero entries) and on U (1), col_1 -= 2 col_0 on a (1 nonzero:
    // a_10 is then 0) and on V (1), MulSchool.
    let a = z(&[&[2, 4], &[6, 8]]);
    let got = stopped_at_second_check(|| smith::smith_classical(&a));
    let mut want = [0; FAMILIES];
    want[Family::Move as usize] = 4 + 8 + 4 + 4;
    want[Family::Div as usize] = 3;
    want[Family::MulSchool as usize] = 2 + 1 + 1 + 1;
    assert_eq!(got, want, "the classical elimination stopped at pass 2: its setup and pass 1");

    // route 2's small Smith form: generators [[4, 6], [6, 9]] modulo
    // delta = 12.  The first check opens pivot 0's first pass (nothing
    // before it); the second opens pivot 1, after pivot 0's pass: column 1
    // by a Bezout step on (4, 6) over Z (x 4 + y 6 = 2 with x = -1, y = 1:
    // Euclid's 3 quotient steps and the 2 divisions by g; the test of 6 by
    // 4, and the 2 x 2 update
    // of the working rows and of V', 2 operations a row: ModArith), the
    // exact transform's update (4 two-term products a row on V and V^-1,
    // MulSchool by the operands' limbs); then column 0 by a row step on (2,
    // 3) (3 quotient steps, the test, 2 operations on each of the 2
    // columns); then gcd(1, 12) in one step and the divisibility test of
    // the 1 x 1 rest (ModArith).  Pivot 0 is then 1 = d_1.  (The pass's
    // word operations are counted locally and charged at the next check:
    // that check moved ahead of the charge loses them, and this pin fails;
    // pivot 1's work charged before it would show here too.  Charges
    // already in the accumulator are flushed by its Drop when the Stop
    // unwinds, so their order against the check is not observable.)
    let got = stopped_at_second_check(|| smith::small_smith_route(&z(&[&[4, 6], &[6, 9]]), &BigInt::from(12)));
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = (euclid_steps(4, 6) + 2) + (1 + 4 + 4) + euclid_steps(2, 3) + (1 + 4) + euclid_steps(12, 1) + 1;
    // (x, y, -a/g, p/g) = (-1, 1, -3, 2) on V = I's rows, and (p/g, a/g,
    // -y, x) = (2, 3, -1, -1) on V^-1 = I's columns
    let (x, y, na, p, a, ny) = (-1i64, 1i64, -3i64, 2i64, 3i64, -1i64);
    let mut mul = 0u64;
    for (ct, cj) in [(1i64, 0i64), (0, 1)] {
        for (s, w) in [(x, y), (na, p), (p, a), (ny, x)] {
            let l = |v: i64| zmat::limbs(&BigInt::from(v));
            mul += bigmul_units(l(s), l(ct)).get(Family::MulSchool) + bigmul_units(l(w), l(cj)).get(Family::MulSchool);
        }
    }
    want[Family::MulSchool as usize] = mul;
    assert_eq!(got, want, "the small Smith form stopped at pivot 1: pivot 0's pass");
}
