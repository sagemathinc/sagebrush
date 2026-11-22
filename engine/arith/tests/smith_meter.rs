//! The Smith form with transforms' units (`cost::tally`) on fixed inputs:
//! pinned per family, for each route and each width of delta (word and
//! multi-limb), with the Stop checks; leaf checks (`smith_form` is exactly
//! its parts: the inverse, part A for route 2, and the route, nothing of
//! its own and nothing twice); a metered region charging exactly the
//! tallied difference.  One test: the hooks are global.

use num_traits::{One, Signed};
use sagebrush_arith::cost::{metered, tallied, Family, Meter, Units, FAMILIES};
use sagebrush_arith::smith::{self, Route};
use sagebrush_arith::snf;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;

fn delta(after: Units, before: Units) -> [u64; FAMILIES] {
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

/// (the units tallied by f, the Stop checks it made)
fn measure<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], u64, T) {
    hooks::reset();
    let before = tallied();
    let r = f();
    let d = delta(tallied(), before);
    let checks = hooks::total();
    hooks::reset();
    (d, checks, r)
}

fn sum(a: &[u64; FAMILIES], b: &[u64; FAMILIES]) -> [u64; FAMILIES] {
    let mut s = [0; FAMILIES];
    for i in 0..FAMILIES {
        s[i] = a[i] + b[i];
    }
    s
}

fn z(rows: &[&[i64]]) -> ZMat {
    ZMat::from_rows(rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect())
}

fn pm(b: u64, e: u64) -> i64 {
    let (mut r, mut b, mut e) = (1u128, b as u128, e);
    while e > 0 {
        if e & 1 == 1 {
            r = r * b % 1_000_003;
        }
        b = b * b % 1_000_003;
        e >>= 1;
    }
    r as i64
}

/// The bench's input: entry (i, j) = (i + 2 + v)^(j + 3) mod 1000003 - 500001.
fn bench(n: usize, v: u64) -> ZMat {
    ZMat { rows: n, cols: n, d: (0..n * n).map(|k| BigInt::from(pm((k / n) as u64 + 2 + v, (k % n) as u64 + 3) - 500_001)).collect() }
}

fn names() -> [&'static str; FAMILIES] {
    ["MulSchool", "MulNtt", "Div", "DivNewton", "Gcd", "Move", "ModArith", "AddSub", "Walk", "Other"]
}

#[test]
fn smith_units_and_stop_checks() {
    let print = std::env::var("PRINT_PINS").is_ok();
    // route 1: word delta (45) and multi-limb delta (bench 12 v = 3, 231 bits);
    // route 2: word delta (D = diag(1, 2, 2): its first attempt fails after
    // an elimination step, so a failed attempt's charge is pinned too) and
    // multi-limb (bench 12 v = 0); route 3: singular and rectangular
    let cyc_word = z(&[&[3, 8], &[6, 1]]);
    let cyc_big = bench(12, 3);
    let tr_word = z(&[&[2, 0, 0], &[0, 2, -1], &[0, 0, 1]]);
    let tr_big = bench(12, 0);
    let sing = z(&[&[1, 2, 3], &[2, 4, 6], &[1, 0, 1]]);
    let wide = z(&[&[6, 10, 15], &[4, 8, 12]]);
    let inputs: Vec<(&str, &ZMat, Route)> = vec![
        ("route 1, word delta", &cyc_word, Route::Cyclic),
        ("route 1, big delta", &cyc_big, Route::Cyclic),
        ("route 2, word delta", &tr_word, Route::Trailing),
        ("route 2, big delta", &tr_big, Route::Trailing),
        ("route 3, singular", &sing, Route::Hermite),
        ("route 3, wide", &wide, Route::Hermite),
    ];
    let rows: Vec<(&str, [u64; FAMILIES], u64)> = inputs
        .iter()
        .map(|(name, a, route)| {
            let (u, c, s) = measure(|| smith::smith_form(a).unwrap());
            assert_eq!(s.route, *route, "{name}");
            (*name, u, c)
        })
        .collect();
    let pins: &[(&str, [u64; FAMILIES], u64)] = &[
        // (the inverse's CRT setup is charged: one prime on the word
        // inputs, [1, 0, 0, 0, 0, 3, 4, ..], four on the big ones, [23, 0, 0,
        // 0, 0, 16, 95, ..]; MultiCrt::setup_units)
        ("route 1, word delta", [45, 0, 2, 0, 2, 27, 59, 0, 0, 0], 3),
        ("route 1, big delta", [17755, 0, 4843, 0, 280, 3402, 5147, 71, 0, 0], 5),
        // (route 2's checks beyond one an attempt and one a pass of the
        // small Smith form, k = 2 here: in each attempt one a row of Y (k)
        // and a pass of each pivot it reaches (one pass a pivot here, and k
        // pivots: a failed attempt has rank 1, then the empty pivot 1),
        // and in the generating one a column operation, a row of X's
        // divisibility tests (multi-limb delta) and a row of q (top); then a
        // row of c (top) and of the relations (k); after the small Smith
        // form 4 k in its transforms' factors, 3 k in their unipotent
        // inverses, and a row of R N_top (k), W (top + k) and V (top + k).
        // Word input: top 1, 3 attempts, 2 column operations, 9 + (4 + 4 +
        // 7) + 3 + 22 = 49; big input: top 10, 5 attempts, 25 column
        // operations, its last attempt's pivot 0 in two passes, 46 + (4 * 4
        // + 50) + 12 + 40 = 164.  And a check a row of each product of
        // one-word entries: for the word input the transforms' 4 k x k
        // products (4 k) and part A's N b (n = 3), 49 + 8 + 3 = 60; the big
        // input's products have multi-limb entries, checked already)
        ("route 2, word delta", [148, 0, 35, 0, 30, 100, 212, 4, 0, 0], 60),
        ("route 2, big delta", [34719, 0, 36619, 0, 1678, 3590, 6409, 82, 0, 0], 164),
        // (route 3's checks: the entry's, the profile's, both Compresses'
        // echelon pivots, rows and solved columns, the products' rows, and
        // the core's (route 1 here); counted by the route 3 prefix pins)
        ("route 3, singular", [304, 0, 20, 0, 24, 365, 296, 0, 0, 0], 35),
        ("route 3, wide", [120, 0, 20, 0, 18, 133, 127, 0, 0, 0], 17),
    ];
    if print {
        for (n, u, c) in &rows {
            println!("        (\"{n}\", {u:?}, {c}),");
        }
    } else {
        assert_eq!(pins.len(), rows.len(), "a pin per row");
        for ((n, u, c), (pn, pu, pc)) in rows.iter().zip(pins) {
            assert_eq!(n, pn);
            assert_eq!(u, pu, "{n}: units by family {:?}", names());
            assert_eq!(c, pc, "{n}: Stop checks");
        }
    }
    for (n, u, _) in &rows {
        assert!(u.iter().sum::<u64>() > 0, "{n}: no units");
        assert_eq!(u[Family::Other as usize], 0, "{n}: units in Other");
    }
    // the word path counts ModArith and no Gcd; the big path Gcd and no
    // ModArith of its own (route 1 here; route 2 below)
    let (nm, den, _) = zmat::inverse_det(&cyc_word).unwrap();
    assert_eq!(den, BigInt::from(45));
    let (word, _, _) = measure(|| smith::cyclic_route(&nm, &den));
    assert!(word[Family::ModArith as usize] > 0 && word[Family::Gcd as usize] == 0, "word delta: {word:?}");
    let (nm, den, _) = zmat::inverse_det(&cyc_big).unwrap();
    let (big, _, _) = measure(|| smith::cyclic_route(&nm, &den));
    assert!(big[Family::ModArith as usize] == 0 && big[Family::Gcd as usize] > 0, "big delta: {big:?}");

    let (nm, den, det) = zmat::inverse_det(&tr_word).unwrap();
    let (word2, _, _) = measure(|| smith::trailing_route(&nm, &den, &det.abs(), 2));
    assert!(word2[Family::ModArith as usize] > 0 && word2[Family::Gcd as usize] == 0, "route 2, word delta: {word2:?}");
    let (nm, den, det) = zmat::inverse_det(&tr_big).unwrap();
    let (big2, _, _) = measure(|| smith::trailing_route(&nm, &den, &det.abs(), 2));
    assert!(big2[Family::ModArith as usize] == 0 && big2[Family::Gcd as usize] > 0, "route 2, big delta: {big2:?}");

    // route 2's small Smith form: word delta (30030: units are scarce, so
    // the unit-leading-minor step's combinations run too) counts ModArith
    // and no Gcd (its integer parts, the lifts' reductions modulo d_j, are
    // one-limb divisions: Div); big delta counts no ModArith of its own
    let mut seed: u64 = 0x9e3779b97f4a7c15;
    for delta in [BigInt::from(30030), (BigInt::from(30030) << 70usize) + BigInt::from(30030)] {
        let word = delta.bits() < 62;
        for k in 2..=5usize {
            for _ in 0..4 {
                let rel = ZMat::from_rows(
                    (0..k)
                        .map(|_| {
                            (0..k)
                                .map(|_| {
                                    seed ^= seed << 13;
                                    seed ^= seed >> 7;
                                    seed ^= seed << 17;
                                    BigInt::from(seed >> 2) * BigInt::from([2u64, 3, 5, 6][(seed % 4) as usize])
                                })
                                .collect()
                        })
                        .collect(),
                );
                let (u, _, _) = measure(|| smith::small_smith_route(&rel, &delta));
                if word {
                    assert!(u[Family::ModArith as usize] > 0 && u[Family::Gcd as usize] == 0 && u[Family::Div as usize] > 0, "small Smith, word delta: {u:?}");
                } else {
                    assert!(u[Family::ModArith as usize] == 0 && u[Family::Gcd as usize] > 0, "small Smith, big delta: {u:?}");
                }
                assert_eq!(u[Family::Other as usize], 0);
            }
        }
    }

    // the leaf rule: smith_form is exactly the inverse and the route (route
    // 1), the inverse, part A and the route (route 2)
    for a in [&cyc_word, &cyc_big] {
        let (whole, _, _) = measure(|| smith::smith_form(a).unwrap());
        let (inv, _, r) = measure(|| zmat::inverse_det(a).unwrap());
        let (route, _, _) = measure(|| smith::cyclic_route(&r.0, &r.1));
        assert_eq!(whole, sum(&inv, &route), "smith_form = inverse_det + route 1");
    }
    for a in [&tr_word, &tr_big] {
        let (whole, _, _) = measure(|| smith::smith_form(a).unwrap());
        let (inv, _, r) = measure(|| zmat::inverse_det(a).unwrap());
        // (part A from the inverse's own solve: x = N b / delta)
        let (part_a, _, t) = measure(|| snf::invariants_nonsingular(a, &r.2.abs(), Some((r.0.mul(&zmat::det_rhs(a.rows)), r.1.clone()))));
        let k = t.iter().filter(|x| !x.is_one()).count();
        let (route, _, _) = measure(|| smith::trailing_route(&r.0, &r.1, &r.2.abs(), k));
        assert_eq!(whole, sum(&sum(&inv, &part_a), &route), "smith_form = inverse_det + invariants_nonsingular (given d and the solve) + route 2");
    }
    // a forced fallback: the same D, valid transforms, different units
    let (forced, _, f) = measure(|| smith::smith_classical(&cyc_big));
    let (route1, _, s) = measure(|| smith::smith_form(&cyc_big).unwrap());
    assert_eq!(f.d.d, s.d.d);
    assert_eq!(f.u.mul(&cyc_big).mul(&f.v).d, f.d.d);
    assert_ne!(forced, route1);

    // a metered region charges exactly what was tallied inside it
    let mut meter = Meter::accounting(u64::MAX);
    let before = tallied();
    metered(&mut meter, || smith::smith_form(&tr_big).unwrap());
    assert_eq!(meter.units().0, delta(tallied(), before));
    assert!(meter.used() > 0);
}
