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
use sagebrush_arith::cost::{bigdiv_units, biggcd_units, bigmul_units, tallied, Family, Units, FAMILIES};
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
    // check follows the residues of N (9); attempt 0 then checks once a row
    // of Y (k = 2) and a pivot (2); the sixth check opens attempt 1,
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
    let got = stopped_at_check(6, || smith::trailing_route(&nm, &den, &det, 2));
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

    // the divisibility scan counts the tests it makes: diag(2, 1, 1) modulo
    // 12.  Pivot 0's first pass has nothing to eliminate; gcd(2, 12) takes
    // one quotient step; the scan's first test (a_11 = 1 by 2) fails, so one
    // test; then row 1 is added to row 0, 3 additions (ModArith).  The second
    // check opens the next pass.
    let got = stopped_at_second_check(|| smith::small_smith_route(&z(&[&[2, 0, 0], &[0, 1, 0], &[0, 0, 1]]), &BigInt::from(12)));
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = euclid_steps(12, 2) + 1 + 3;
    assert_eq!(got, want, "the small Smith form's divisibility scan: the tests made only");

    // route 2 at k = n, stopped inside its k x k small Smith form: a =
    // diag(2, 4), a^-1 = diag(2, 1) / 4, |det| = 8, invariants (2, 4), so
    // k = n = 2 and no top rows.  The first check opens attempt 0, after
    // N's residues (4); the attempt checks at each of Y's 2 rows and 2
    // pivots, and generates with nothing to eliminate
    // (Y = N mod 4 = diag(2, 1)): gcd(2, 4) and gcd(1, 4), a Euclid step
    // each, and the order test (2 word divisions, ModArith; 2 products,
    // MulSchool); then the inverses of s_j / g_j modulo delta / g_j (1 mod 2
    // and 1 mod 4: 2 + 2 Euclid steps each, ModArith) and the relations
    // (delta / g_j) P_j mod delta, P = I (a division and 2 x 2 products and
    // reductions: 1 + 4 per j, ModArith), checking at each of their 2 rows.
    // The eighth check opens the small Smith form's pivot 0 on [[2, 0], [0,
    // 0]]: nothing to eliminate, gcd(2, 4) in one step and the scan's one
    // test; pivot 0 is d_1 = 2.  The ninth opens pivot 1: the Stop there
    // charges pivot 0's pass (counted locally, charged at this check) and
    // nothing of pivot 1's.
    let a = z(&[&[2, 0], &[0, 4]]);
    let (nm, den, det) = zmat::inverse_det(&a).unwrap();
    assert_eq!((nm.d.clone(), den.clone(), det.clone()), ([2i64, 0, 0, 1].map(BigInt::from).to_vec(), BigInt::from(4), BigInt::from(8)));
    let got = stopped_at_check(9, || smith::trailing_route(&nm, &den, &det, 2));
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = 4 + (euclid_steps(4, 2) + euclid_steps(4, 1)) + 2 + (2 + euclid_steps(1, 2)) + (2 + euclid_steps(1, 4)) + 2 * (1 + 4) + (euclid_steps(4, 2) + 1);
    want[Family::MulSchool as usize] = 2;
    assert_eq!(got, want, "route 2 at k = n stopped at the small Smith form's pivot 1: everything before it and pivot 0's pass");
    // the tenth check is the first of the transforms' factors (one a
    // column of each O(k^3) pass, k reaching n): pivot 1's pass found the
    // 1 x 1 rest zero (one entry read, Move) and ended the pivots
    let got = stopped_at_check(10, || smith::trailing_route(&nm, &den, &det, 2));
    want[Family::Move as usize] += 1;
    assert_eq!(got, want, "route 2 at k = n stopped at its transforms' first check: the whole small Smith form");
    // the eleventh, at column 1, charges column 0's work, held locally until
    // then: V' = I (no column operations), so gcd(1, 4) twice and the
    // inverse of 1 mod 4, a Euclid step each (ModArith), nothing below it
    let got = stopped_at_check(11, || smith::trailing_route(&nm, &den, &det, 2));
    want[Family::ModArith as usize] += 3 * euclid_steps(4, 1);
    assert_eq!(got, want, "route 2 at k = n stopped inside its transforms' factors: column 0's held work");
    // W's bottom row 0 between its check and the next: checks 10 to 17 are
    // the factors' four passes (k each); then a check a row of each k x k
    // product and unipotent inverse, in their order: V's two products (18
    // to 21), V^-1's inverses of f3 and f2 (22 to 25), a product (26, 27),
    // the inverse of f1 (28, 29) and a product (30, 31); 32 and 33 the rows
    // of R N_top (k), 34 and 35 W's bottom rows (no top rows).  B = D_B V_2^-1 = diag(2, 4) (V_2 = I),
    // the rows of C^-1 N those of N, diag(2, 1); row 0 of W: 2 * 2 and 2 *
    // 0 (the products with B's one nonzero entry, MulSchool) and their
    // divisions by delta (Div), charged at check 35, none of row 1's
    let (at34, at35) = (stopped_at_check(34, || smith::trailing_route(&nm, &den, &det, 2)), stopped_at_check(35, || smith::trailing_route(&nm, &den, &det, 2)));
    let l = |v: i64| zmat::limbs(&BigInt::from(v));
    let mut row0 = [0; FAMILIES];
    row0[Family::MulSchool as usize] = bigmul_units(l(2), l(2)).get(Family::MulSchool) + bigmul_units(l(2), l(0)).get(Family::MulSchool);
    row0[Family::Div as usize] = bigdiv_units(l(4), l(4)).get(Family::Div) + bigdiv_units(l(0), l(4)).get(Family::Div);
    let step: Vec<u64> = (0..FAMILIES).map(|i| at35[i] - at34[i]).collect();
    assert_eq!(step, row0.to_vec(), "route 2 at k = n: one row of W between two checks");

    // route 2 with top rows and a multi-limb delta (the big ring, every
    // operation counted by its operands' sizes): a = diag(1, 1, B), B =
    // [[3, -3], [0, 3 q]], q = 2^70 + 1, so B's entries have gcd 3 and the
    // invariants are (1, 1, 3, 3 q): k = 2, top = 2, delta = 3 q (2 limbs).
    // N = delta a^-1 = diag(3 q, 3 q, [[q, 1], [0, 1]]).
    let q = (BigInt::from(1) << 70usize) + BigInt::from(1);
    let mut a = ZMat::zero(4, 4);
    for (i, j, x) in [(0, 0, BigInt::from(1)), (1, 1, BigInt::from(1)), (2, 2, BigInt::from(3)), (2, 3, BigInt::from(-3)), (3, 3, &q * BigInt::from(3))] {
        a.d[i * 4 + j] = x;
    }
    let (nm, den, det) = zmat::inverse_det(&a).unwrap();
    let delta = &q * BigInt::from(3);
    let n_want: Vec<BigInt> = [[&delta, &BigInt::from(0), &BigInt::from(0), &BigInt::from(0)], [&BigInt::from(0), &delta, &BigInt::from(0), &BigInt::from(0)], [&BigInt::from(0), &BigInt::from(0), &q, &BigInt::from(1)], [&BigInt::from(0), &BigInt::from(0), &BigInt::from(0), &BigInt::from(1)]].iter().flatten().map(|x| (*x).clone()).collect();
    assert_eq!((nm.d.clone(), den.clone(), det.clone()), (n_want, delta.clone(), &delta * BigInt::from(3)));
    let lb = |x: &BigInt| zmat::limbs(x);
    let (l0, l1, lq, ld) = (lb(&BigInt::from(0)), lb(&BigInt::from(1)), lb(&q), lb(&delta));
    let lneg1 = lb(&(&delta - BigInt::from(1)));
    let red = bigdiv_units(2 * ld + 1, ld);
    let mut want = Units::default();
    // N's residues, one division by delta an entry
    for x in &nm.d {
        want.add(&bigdiv_units(lb(x), ld));
    }
    // attempt 0 (R = 0) checks at its opening, at Y's 2 rows and at pivot
    // 0's pass; that pass, on Y = [[0, 0, q, 1], [0, 0, 0, 1]]: the search
    // reads 3 entries and swaps columns 0 and 2 (2 + k, Move); then column
    // 3: 1 is not a multiple of q (a division), so a Bezout step on (q, 1)
    // (a gcd and two reductions), giving (s, u, a / g, p / g) = (0, 1, 1,
    // q), applied to both rows (two lin's a row: two products and a
    // reduction each), Y = [[1, 0, 0, 0], [1, 0, 0, q]]; then row 1 by row
    // 0: the quotient 1 / 1 and 1 times row 0 off Y's row 1 (4 entries)
    // and P's (2), a product and a reduction each.  Row 0 is then clear:
    // the fifth check opens pivot 1 and charges the ring's tally, held
    // since the fourth.
    want.0[Family::Move as usize] += 3 + (2 + 2);
    want.add(&bigdiv_units(l1, lq));
    want.add(&biggcd_units(lq, l1));
    want.add(&bigdiv_units(2 * ld, ld));
    want.add(&bigdiv_units(2 * ld, ld));
    for (xr, xj) in [(&q, &BigInt::from(1)), (&BigInt::from(0), &BigInt::from(1))] {
        want.add(&bigmul_units(l0, lb(xr)));
        want.add(&bigmul_units(l1, lb(xj)));
        want.add(&red);
        want.add(&bigmul_units(lneg1, lb(xr)));
        want.add(&bigmul_units(lq, lb(xj)));
        want.add(&red);
    }
    want.add(&bigdiv_units(l1, l1));
    for y in [l1, l0, l0, l0, l1, l0] {
        want.add(&bigmul_units(l1, y));
        want.add(&red);
    }
    let got = stopped_at_check(5, || smith::trailing_route(&nm, &den, &det, 2));
    assert_eq!(got, want.0, "route 2, multi-limb delta: stopped at pivot 1, the big ring's tally of pivot 0 charged before the check");
    // W's top rows: X = N's top rows mod delta = 0, so q = 0 and c = 0, and
    // W's top row 0 is N's row 0 divided by delta: four divisions (Div), no
    // product.  Its checks are the 43rd and 44th of this run (counted from
    // the run's checks; the step's value is derived above from the code):
    // between them, exactly row 0's work.
    let (at43, at44) = (stopped_at_check(43, || smith::trailing_route(&nm, &den, &det, 2)), stopped_at_check(44, || smith::trailing_route(&nm, &den, &det, 2)));
    let mut top0 = [0; FAMILIES];
    top0[Family::Div as usize] = bigdiv_units(lb(&delta), ld).get(Family::Div) + 3 * bigdiv_units(l0, ld).get(Family::Div);
    let step: Vec<u64> = (0..FAMILIES).map(|i| at44[i] - at43[i]).collect();
    assert_eq!(step, top0.to_vec(), "route 2, multi-limb delta: one top row of W between two checks");

    // a product of one-word entries (the transforms' k x k products take
    // this path): a check at the end of each row, after its charge, c sums
    // of k one-limb products; stopped at the second, rows 0 and 1, 2 x 3 x
    // 3 products, and nothing of row 2's
    let m = z(&[&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]]);
    let got = stopped_at_check(2, || m.mul(&m));
    let mut want = [0; FAMILIES];
    want[Family::MulSchool as usize] = 2 * 3 * 3 * bigmul_units(1, 1).get(Family::MulSchool);
    assert_eq!(got, want, "a one-word product stopped at its second row's check: rows 0 and 1");
}
