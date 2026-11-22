//! Route 3's Stop prefixes: what a Stop at a check charges is the work
//! before it, never the work to come.  The prefix at a check inside each
//! new loop (the column echelon for C, at a pivot that adds a Howell
//! generator, on a word and on a multi-limb G and on the left side; the
//! row echelon for K and X; the solved columns) is pinned against one
//! rebuilt here: the public pieces before the loop measured on their own,
//! and the loop's own work counted by hand.  A count moved ahead of its
//! iteration's check, or a check polled before the held counts are
//! charged, fails here.  (A file of its own: the Stop hooks are global.
//! Native only: a Stop unwinds, and wasm32 aborts on a panic.)

#![cfg(not(target_arch = "wasm32"))]

use sagebrush_arith::cost::{bigdiv_units, biggcd_units, bigmul_units, bigxgcd_units, tallied, Family, Local, Units, FAMILIES};
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::smith::{self, route3};
use sagebrush_arith::zmat::{self, copy_units, limbs, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;

/// The tests' lock: the hooks are global, and the tests of a file run on
/// threads of their own.
static HOOKS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The units and the checks of `f`, run to completion.
fn piece<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], u64, T) {
    sagebrush_interrupt::clear();
    hooks::reset();
    let before = tallied();
    let x = f();
    let after = tallied();
    let checks = hooks::total();
    hooks::reset();
    let mut d = [0; FAMILIES];
    for (i, v) in d.iter_mut().enumerate() {
        *v = after.0[i].wrapping_sub(before.0[i]);
    }
    (d, checks, x)
}

/// The units tallied by `f` when a Stop is armed at its `at`-th check.
fn stopped_at_check<T>(at: u64, f: impl FnOnce() -> T) -> [u64; FAMILIES] {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::arm_at(at);
    let before = tallied();
    let r = sagebrush_interrupt::catch(f);
    let after = tallied();
    assert!(r.is_err(), "stopped");
    assert_eq!(hooks::total(), at, "the Stop came at the armed check");
    sagebrush_interrupt::clear();
    hooks::reset();
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

fn add(a: &mut [u64; FAMILIES], b: &[u64; FAMILIES]) {
    for (x, y) in a.iter_mut().zip(b) {
        *x += y;
    }
}
fn units(a: &mut [u64; FAMILIES], u: Units) {
    add(a, &u.0);
}
fn fam(a: &mut [u64; FAMILIES], f: Family, n: u64) {
    a[f as usize] += n;
}
fn z(rows: &[&[BigInt]]) -> ZMat {
    ZMat::from_rows(rows.iter().map(|r| r.to_vec()).collect())
}
fn b(x: i64) -> BigInt {
    BigInt::from(x)
}

/// The block of `a` in `rows` x `cols` (as route 3 copies it).
fn block(a: &ZMat, rows: &[usize], cols: &[usize]) -> ZMat {
    ZMat::from_rows(rows.iter().map(|&i| cols.iter().map(|&j| a.get(i, j).clone()).collect()).collect())
}

/// The pieces of Compress(B, J) before the column echelon, as measured
/// on their own: B_J's and B_J''s copies, B_J's inverse, Q = N B_J' and G;
/// with the checks among them, and (N, delta, G).
fn before_echelon(bm: &ZMat, j: &[usize]) -> ([u64; FAMILIES], u64, ZMat, BigInt, BigInt) {
    let r = bm.rows;
    let all: Vec<usize> = (0..r).collect();
    let jp: Vec<usize> = (0..bm.cols).filter(|c| !j.contains(c)).collect();
    let mut want = [0; FAMILIES];
    let bj = block(bm, &all, j);
    let bjp = block(bm, &all, &jp);
    fam(&mut want, Family::Move, copy_units(&bj.d) + copy_units(&bjp.d));
    let (u, c1, (nm, delta, det)) = piece(|| zmat::inverse_det(&bj).unwrap());
    add(&mut want, &u);
    let (u, c2, q) = piece(|| nm.mul(&bjp));
    add(&mut want, &u);
    let (u, c3, g) = piece(|| {
        let mut acc = Local::new();
        let g = route3::hnf_modulus(&q, &delta, &det, &mut acc);
        acc.flush();
        g
    });
    add(&mut want, &u);
    (want, c1 + c2 + c3, nm, delta, g)
}

/// The rank profile's pieces: the entry's charge and check, the echelon
/// modulo the first prime, and A's row and column contents for k^ (C's
/// switch): each a gcd fold at its running sizes, stopped at 1, then its
/// residues modulo the 25 primes below 100 (no check among them).
fn entry_and_profile(a: &ZMat) -> ([u64; FAMILIES], u64) {
    let (m, n) = (a.rows, a.cols);
    let mut want = [0; FAMILIES];
    fam(&mut want, Family::Move, copy_units(&a.d) + (m * m + n * n) as u64);
    let p = Primes::new().next().unwrap();
    let (u, c, _) = piece(|| a.reduce(&Modulus::new(p)).rref_rows());
    add(&mut want, &u);
    let fold = |xs: Vec<&BigInt>, want: &mut [u64; FAMILIES]| {
        let mut g = b(0);
        for x in xs {
            if *x != b(0) && g != b(1) {
                units(want, biggcd_units(limbs(&g), limbs(x)));
                g = num_integer::Integer::gcd(&g, x);
            }
        }
        for _ in 0..25 {
            units(want, bigdiv_units(limbs(&g), 1));
        }
    };
    for i in 0..m {
        fold((0..n).map(|j| a.get(i, j)).collect(), &mut want);
    }
    for j in 0..n {
        fold((0..m).map(|i| a.get(i, j)).collect(), &mut want);
    }
    (want, 1 + c)
}

/// The column echelon's row 0 on B = [[2, 0, 0, 4 P], [1, 4 P, 8 P, 0]]
/// modulo G = 4 P: the columns past the first are 0 modulo G (3 zero
/// columns dropped, 2 reads each, and the first column's first entry),
/// the pivot 2 = gcd(2, G) needs no Bezout step and keeps its column, and
/// (G / 2) col_0 = (0, 2 P) is a Howell generator pushed: its two entries
/// scaled, and G / 2 divided.
fn row0(want: &mut [u64; FAMILIES], g: &BigInt) {
    fam(want, Family::Move, 1 + 3 * 2 + 1);
    units(want, bigdiv_units(limbs(g), 1));
    if g.bits() < 62 {
        // the word ring: gcd_cofactor_e's Euclid steps on (G, 2) and the
        // generator's 2 entries, ModArith
        let (mut r0, mut r1, mut steps) = (g.clone(), b(2), 0u64);
        while r1 != b(0) {
            (r0, r1) = (r1.clone(), &r0 % &r1);
            steps += 1;
        }
        fam(want, Family::ModArith, steps + 2);
    } else {
        // the multi-limb ring: gcd_cofactor_e's gcd and reduction, and the
        // generator's two scalings lin(G / 2, x, 0, 0), x = 2 and 1
        let le = limbs(g);
        // (gcd_cofactor_e: the extended gcd with the check on its
        // coefficients)
        units(want, bigxgcd_units(le, 1, 1));
        units(want, bigdiv_units(2 * le, le));
        let half = g / b(2);
        for _ in 0..2 {
            units(want, bigmul_units(limbs(&half), 1));
            units(want, bigmul_units(1, 1));
            units(want, bigdiv_units(2 * le + 1, le));
        }
    }
}

/// The column echelon's second check on a wide input (rank 2 = m < n):
/// the entry, the profile, B's copy, Compress's pieces, B's residues
/// modulo G, and row 0.
#[test]
fn route3_stop_in_the_column_echelon() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    for pp in [b(1), (b(1) << 70usize) + b(1)] {
        let p4 = &pp * b(4);
        let a = z(&[&[b(2), b(0), b(0), p4.clone()], &[b(1), p4.clone(), &pp * b(8), b(0)]]);
        let (mut want, mut at) = entry_and_profile(&a);
        fam(&mut want, Family::Move, copy_units(&a.d));
        let (u, c, _, _, g) = before_echelon(&a, &[0, 1]);
        assert_eq!(g, p4, "G = 4 P");
        add(&mut want, &u);
        at += c;
        // B's residues modulo G, flushed at row 0's check
        if g.bits() < 62 {
            fam(&mut want, Family::ModArith, a.d.iter().map(|x| limbs(x) as u64).sum());
        } else {
            for x in &a.d {
                units(&mut want, bigdiv_units(limbs(x), limbs(&g)));
            }
        }
        row0(&mut want, &g);
        at += 2;
        let got = stopped_at_check(at, || smith::smith_form(&a));
        assert_eq!(got, want, "G of {} bits", g.bits());
    }
}

/// The same check on the left side: a tall input of rank 2 = n < m skips
/// the column side, and the left Compress runs on A^T (charged by the
/// transpose) with J = I, the B above.
#[test]
fn route3_stop_in_the_left_echelon() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    let a = z(&[&[b(2), b(1)], &[b(0), b(4)], &[b(0), b(8)], &[b(4), b(0)]]);
    let (mut want, mut at) = entry_and_profile(&a);
    let (u, c, bl) = piece(|| a.transpose());
    add(&mut want, &u);
    at += c;
    let (u, c, _, _, g) = before_echelon(&bl, &[0, 1]);
    assert_eq!(g, b(4));
    add(&mut want, &u);
    at += c;
    fam(&mut want, Family::ModArith, bl.d.iter().map(|x| limbs(x) as u64).sum());
    row0(&mut want, &g);
    at += 2;
    let got = stopped_at_check(at, || smith::smith_form(&a));
    assert_eq!(got, want);
}

/// The row echelon's first check and the first solved column's, on the
/// wide word input: after the column echelon's row 1 (its pushed
/// generator (0, 2) the pivot, gcd(2, 4) = 2, its own generator 0) and the
/// lift (C = [[2, 0], [1, 2]]: a division, quotient 0), then N C and the
/// residues of Q and N C modulo delta = 8.  The row echelon: column 0 has
/// no pivot (two reads), column 1 the pivot 4 (gcd(4, 8) = 4, its
/// generator 0, and both rows left zero: 8 reads); the first kernel
/// column x = e_0 (free), B_J' x = (0, 8), N (0, -8) / 8 exactly.
#[test]
fn route3_stop_in_the_row_echelon_and_the_solves() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    let a = z(&[&[b(2), b(0), b(0), b(4)], &[b(1), b(4), b(8), b(0)]]);
    let (mut want, mut at) = entry_and_profile(&a);
    fam(&mut want, Family::Move, copy_units(&a.d));
    let (u, c, nm, delta, g) = before_echelon(&a, &[0, 1]);
    assert_eq!((delta.clone(), g.clone()), (b(8), b(4)));
    add(&mut want, &u);
    at += c;
    fam(&mut want, Family::ModArith, a.d.iter().map(|x| limbs(x) as u64).sum());
    row0(&mut want, &g);
    // row 1: (0, 2) read to its nonzero (2), the pool's length (1); one
    // Euclid step on (4, 2), G / 2, the generator's 2 entries
    fam(&mut want, Family::Move, 2 + 1);
    units(&mut want, bigdiv_units(1, 1));
    fam(&mut want, Family::ModArith, 1 + 2);
    // the lift: C's 4 entries placed, one division (1 by 2)
    fam(&mut want, Family::Move, 4);
    units(&mut want, bigdiv_units(1, 1));
    // C's index (2 x 2 = 4) divides G = 4: two products, one division
    units(&mut want, bigmul_units(1, 1));
    units(&mut want, bigmul_units(1, 1));
    units(&mut want, bigdiv_units(1, 1));
    let c_mat = z(&[&[b(2), b(0)], &[b(1), b(2)]]);
    let (u, c2, _) = piece(|| nm.mul(&c_mat));
    add(&mut want, &u);
    // Q's and N C's residues modulo 8 (one-limb: one unit each)
    fam(&mut want, Family::ModArith, 8);
    // checks: rows 0 and 1, the echelon's last, N C's, row echelon column 0
    at += 3 + c2 + 1;
    let got = stopped_at_check(at, || smith::smith_form(&a));
    assert_eq!(got, want, "the row echelon's first check");
    // column 0 (2 reads), column 1's check; then its pivot and the end
    fam(&mut want, Family::Move, 2 + 2 + 8);
    units(&mut want, bigdiv_units(1, 1));
    fam(&mut want, Family::ModArith, 1 + 4);
    // the first kernel column: B_J' y (one product), N t (one product, two
    // exact divisions by 8), x's 3 entries
    units(&mut want, bigmul_units(1, 1));
    units(&mut want, bigmul_units(1, 1));
    units(&mut want, bigdiv_units(1, 1));
    units(&mut want, bigdiv_units(1, 1));
    fam(&mut want, Family::Move, 3);
    at += 3;
    let got = stopped_at_check(at, || smith::smith_form(&a));
    assert_eq!(got, want, "the first solved column's check");
}

/// One iteration's work as the difference of the prefixes at two
/// consecutive checks, where the counts held across the check are word ops
/// (not a Local's, which a Stop's unwinding flushes anyway): the row
/// echelon's column 0 and the second solved column, on B = [[2, 0, -3,
/// -3], [0, 3, 0, 1]] (J = {0, 1}, delta = 6, N = diag(3, 2), Q = N B_J' =
/// [[3, 3], [0, 2]] modulo 6).
///
/// - Column 0 of [Q | N C]: the pool's length (2), the pivot 3 (row 1 is 0
///   there: no Bezout step), gcd(3, 6) = 3 in one Euclid step, 6 / 3, the
///   generator 2 row_0 (its 4 entries) pushed, then the zero rows dropped
///   (row 1 read to its 2, the generator to its first nonzero).
/// - The second kernel column x (pivot coordinate 1, g = 2): its lead 6 / 2
///   = 3; back substitution through row 0 (H_01 = 3: s = -9 = 3, two ring
///   operations, then 3 / 3 exactly: y_0 = 1); then B_J' y (three nonzero
///   products), N t (two products, two exact divisions by 6) and x's 4
///   entries.
#[test]
fn route3_stop_iterations_holding_word_ops() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    let a = z(&[&[b(2), b(0), b(-3), b(-3)], &[b(0), b(3), b(0), b(1)]]);
    let (_, mut at) = entry_and_profile(&a);
    let (_, c, nm, delta, _) = before_echelon(&a, &[0, 1]);
    assert_eq!(delta, b(6));
    at += c;
    let (_, cmat) = route3::compress(&a, &[0, 1]).unwrap();
    let (_, c2, nc) = piece(|| nm.mul(&cmat));
    // (G = 1 here, Delta = delta = 6 and gcd(6, Q) = 1: C = I with no
    // echelon) N C's checks, the row echelon's column 0's
    assert_eq!(cmat.d, vec![b(1), b(0), b(0), b(1)], "C = I");
    at += c2 + 1;
    let first = stopped_at_check(at, || smith::smith_form(&a));
    let second = stopped_at_check(at + 1, || smith::smith_form(&a));
    let mut want = [0; FAMILIES];
    fam(&mut want, Family::Move, 2);
    units(&mut want, bigdiv_units(1, 1));
    fam(&mut want, Family::ModArith, 1 + 4);
    // the drop: row 1 = [0, 2 | ..] read to its 2; the generator [0, 0 | 2
    // (N C)_0] to its first nonzero, or all 4 entries
    let gen: Vec<BigInt> = (0..2).map(|t| num_integer::Integer::mod_floor(&(b(2) * nc.get(0, t)), &b(6))).collect();
    let reads = match gen.iter().position(|x| *x != b(0)) {
        Some(t) => 2 + t as u64 + 1,
        None => 4,
    };
    fam(&mut want, Family::Move, 2 + reads);
    let mut d = second;
    for (x, y) in d.iter_mut().zip(&first) {
        *x -= y;
    }
    assert_eq!(d, want, "the row echelon's column 0");
    // the solved columns' checks: the row echelon's column 1 and last
    // check, then x = 0's, x = 1's
    let s0 = stopped_at_check(at + 3, || smith::smith_form(&a));
    let s1 = stopped_at_check(at + 4, || smith::smith_form(&a));
    let mut want = [0; FAMILIES];
    for _ in 0..4 {
        units(&mut want, bigdiv_units(1, 1));
    }
    for _ in 0..5 {
        units(&mut want, bigmul_units(1, 1));
    }
    fam(&mut want, Family::Move, 4);
    fam(&mut want, Family::ModArith, 2);
    let mut d = s1;
    for (x, y) in d.iter_mut().zip(&s0) {
        *x -= y;
    }
    assert_eq!(d, want, "the second solved column");
    // X's second column (w = 1, c = C's column 1): back substitution from
    // the right-hand sides (N C)_(i, 1) modulo 6 of the two pivot rows
    // (both kept: their pivots 3 and 2 divide 6), last pivot first; then
    // c - B_J' y, N t / 6 and x's entries, as for K
    let x0 = stopped_at_check(at + 5, || smith::smith_form(&a));
    let x1 = stopped_at_check(at + 6, || smith::smith_form(&a));
    let six = b(6);
    let md = |x: &BigInt| num_integer::Integer::mod_floor(x, &six);
    let mut want = [0; FAMILIES];
    let mut ops = 0u64;
    let s1 = md(nc.get(1, 1));
    units(&mut want, bigdiv_units(limbs(&s1), 1));
    assert_eq!(md(&s1) % b(2), b(0), "the Howell property");
    let q1 = &s1 / b(2);
    let mut y: Vec<(usize, BigInt)> = vec![];
    if q1 != b(0) {
        y.push((1, md(&q1)));
    }
    let mut s0 = md(nc.get(0, 1));
    if let Some((_, y1)) = y.first() {
        // H_01 = 3
        ops += 2;
        s0 = md(&(&s0 - b(3) * y1));
    }
    units(&mut want, bigdiv_units(limbs(&s0), 1));
    let q0 = &s0 / b(3);
    if q0 != b(0) {
        y.push((0, md(&q0)));
    }
    let bjp = z(&[&[b(-3), b(-3)], &[b(0), b(1)]]);
    let mut t: Vec<BigInt> = (0..2).map(|i| cmat.get(i, 1).clone()).collect();
    for (jj, yj) in &y {
        for (i, ti) in t.iter_mut().enumerate() {
            let bij = bjp.get(i, *jj);
            if *bij != b(0) {
                units(&mut want, bigmul_units(limbs(bij), limbs(yj)));
                *ti -= bij * yj;
            }
        }
    }
    for i in 0..2 {
        let mut sum = b(0);
        for (l, tl) in t.iter().enumerate() {
            let nil = nm.get(i, l);
            if *nil != b(0) && *tl != b(0) {
                units(&mut want, bigmul_units(limbs(nil), limbs(tl)));
                sum += nil * tl;
            }
        }
        units(&mut want, bigdiv_units(limbs(&sum), 1));
    }
    fam(&mut want, Family::Move, 2 + y.len() as u64);
    fam(&mut want, Family::ModArith, ops);
    assert!(ops > 0, "a word op held across the check");
    let mut d = x1;
    for (x, y) in d.iter_mut().zip(&x0) {
        *x -= y;
    }
    assert_eq!(d, want, "X's second column");
}

/// The prefix at the tail path's first check (its echelon's column 0), on
/// a wide input whose C takes the tail path: the entry, the profile with
/// A's contents, B's copy, Compress's pieces, then the tail's residues
/// (-Q's and N's entries modulo delta) and its rows' copy, all charged
/// before the check.  `big`: delta = G = a 71-bit prime (the multi-limb
/// ring), else delta = 4, G = 2 (the word ring).  (Both inputs' contents
/// give k^ = 0, so the switch takes the tail path.)
fn tail_first_check(a: &ZMat, big: bool) -> ([u64; FAMILIES], u64) {
    let (mut want, mut at) = entry_and_profile(a);
    fam(&mut want, Family::Move, copy_units(&a.d));
    let (u, c, nm, delta, g) = before_echelon(a, &[0, 1]);
    add(&mut want, &u);
    at += c;
    let all: Vec<usize> = (0..2).collect();
    let q = nm.mul(&block(a, &all, &[2]));
    if big {
        assert!(delta.bits() > 62 && g == delta, "the multi-limb ring, G = delta");
        for x in q.d.iter().chain(&nm.d) {
            units(&mut want, bigdiv_units(limbs(x), limbs(&delta)));
        }
    } else {
        assert_eq!((delta.clone(), g.clone()), (b(4), b(2)));
        fam(&mut want, Family::ModArith, q.d.iter().chain(&nm.d).map(|x| limbs(x) as u64).sum());
    }
    // the rows [-Q | N reversed], r (nz + r) entries
    fam(&mut want, Family::Move, 2 * 3);
    (want, at + 1)
}

/// The tail path's first check, on both rings: what a Stop there charges
/// is the work before it (its residues and rows charged before their
/// check).  Word: A = [[4, 1, 5], [0, 1, 3]] (B_J = [[4, 1], [0, 1]], N =
/// [[1, -1], [0, 4]], delta = 4, Q = (2, 12), G = 2).  Multi-limb: A = [[P,
/// 0, 0], [0, 1, 5]], P a 71-bit prime (delta = G = P, Lambda's index P).
#[test]
fn route3_stop_in_the_tail_echelon() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    let p = (b(1) << 70usize) + b(37);
    for (a, big) in [(word_tail(), false), (z(&[&[p.clone(), b(0), b(0)], &[b(0), b(1), b(5)]]), true)] {
        let (want, at) = tail_first_check(&a, big);
        let got = stopped_at_check(at, || smith::smith_form(&a));
        assert_eq!(got, want, "the tail echelon's first check ({})", if big { "multi-limb" } else { "word" });
    }
}

/// The tail echelon's column 0 (z's), on the word input, as the
/// difference of the prefixes at its first two checks: the pool's length
/// (2); the pivot 2's gcd with 4 (one Euclid step) and, row 1 being zero
/// there, no clearing; the pivot kept (g = 2), its generator 2 row_0 =
/// (0, 2, 2) (4 / 2 divided, 3 ring operations); the zero rows dropped
/// (row 1 read through, 3; the generator to its first nonzero, 2); then
/// the next column's stop test, the generator read again (2), before its
/// check.
#[test]
fn route3_stop_in_the_tail_echelon_column() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    let a = word_tail();
    let (_, first) = tail_first_check(&a, false);
    let s0 = stopped_at_check(first, || smith::smith_form(&a));
    let s1 = stopped_at_check(first + 1, || smith::smith_form(&a));
    let mut want = [0; FAMILIES];
    fam(&mut want, Family::Move, 2 + 3 + 2 + 2);
    units(&mut want, bigdiv_units(1, 1));
    fam(&mut want, Family::ModArith, 1 + 3);
    let mut d = [0; FAMILIES];
    for (i, v) in d.iter_mut().enumerate() {
        *v = s1[i] - s0[i];
    }
    assert_eq!(d, want, "z's column and the stop test before the next check");
}

/// The word input of the tail path's pins.
fn word_tail() -> ZMat {
    z(&[&[b(4), b(1), b(5)], &[b(0), b(1), b(3)]])
}

/// The tail path's solved columns, on the word input above, as the
/// difference of the prefixes at consecutive checks.  Its echelon modulo
/// 4, over the rows [-Q | N reversed] = [[2, 3, 1], [0, 0, 0]]: z's column
/// pivots on row 0 (g = 2, its generator (0, 2, 2) pushed); x_1's on the
/// generator (g = 2, its own generator 0); the leftover rows then vanish,
/// so k = 1 and C = [[1, 0], [1, 2]].  After the echelon's last check:
/// C's columns placed (r^2 = 4 Move) and T's column x_1 (a pivot: its lead
/// 4 / 2, a division; no tail pivot before it), then its check; then H's
/// column x_0: back substitution through x_1's pivot row (one term, two
/// ring operations; the division of -2 by 2), then its check.
#[test]
fn route3_stop_in_the_tail_solves() {
    let _lock = HOOKS.lock().unwrap_or_else(|e| e.into_inner());
    let a = word_tail();
    let (_, first) = tail_first_check(&a, false);
    // the echelon's checks: columns 0 (z) and 1, and its last
    let last = first + 2;
    let s0 = stopped_at_check(last, || smith::smith_form(&a));
    let s1 = stopped_at_check(last + 1, || smith::smith_form(&a));
    let s2 = stopped_at_check(last + 2, || smith::smith_form(&a));
    let diff = |x: &[u64; FAMILIES], y: &[u64; FAMILIES]| -> [u64; FAMILIES] {
        let mut d = [0; FAMILIES];
        for (i, v) in d.iter_mut().enumerate() {
            *v = x[i] - y[i];
        }
        d
    };
    let mut want = [0; FAMILIES];
    fam(&mut want, Family::Move, 4);
    units(&mut want, bigdiv_units(1, 1));
    assert_eq!(diff(&s1, &s0), want, "T's column x_1");
    let mut want = [0; FAMILIES];
    units(&mut want, bigdiv_units(1, 1));
    fam(&mut want, Family::ModArith, 2);
    assert_eq!(diff(&s2, &s1), want, "H's column x_0");
    let (_, c) = route3::compress(&a, &[0, 1]).unwrap();
    assert_eq!(c.d, vec![b(1), b(0), b(1), b(2)], "C");
}
