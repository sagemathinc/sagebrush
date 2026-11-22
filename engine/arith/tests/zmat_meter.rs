//! zmat's and the Smith form's units (`cost::tally`) on fixed inputs:
//! pinned per family, so that a change in what a site counts (or a site
//! counting a callee's work again) fails here; a leaf check (rank proven by
//! a prime adds nothing of its own to the reduction and the elimination it
//! calls); a metered region charging exactly the tallied difference; and
//! the Stop checks, whose count on each input must equal the count before
//! metering (pinned below from that code).  One test: the hooks are global.

use sagebrush_arith::cost::{metered, tallied, Family, Meter, Units, FAMILIES};
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::snf;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use num_traits::Signed;
use sagebrush_interrupt::hooks;

fn delta(after: Units, before: Units) -> [u64; FAMILIES] {
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

/// (the units tallied by f, the Stop checks it made)
fn measure<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], u64) {
    hooks::reset();
    let before = tallied();
    let _ = f();
    let d = delta(tallied(), before);
    let checks = hooks::total();
    hooks::reset();
    (d, checks)
}

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn rand(rows: usize, cols: usize, range: i64, seed: u64) -> ZMat {
    let mut s = seed | 1;
    let d = (0..rows * cols).map(|_| BigInt::from((rng(&mut s) % (2 * range as u64 + 1)) as i64 - range)).collect();
    ZMat { rows, cols, d }
}

/// A product through an inner dimension h: rank h (generically).
fn deficient(n: usize, h: usize, seed: u64) -> ZMat {
    rand(n, h, 9, seed).mul(&rand(h, n, 9, seed + 1))
}

/// U diag(1, p, ..., p) V with unimodular U, V (the large-e family).
fn hard(n: usize, p: i64, seed: u64) -> ZMat {
    let mut s = seed | 1;
    let uni = |s: &mut u64| -> ZMat {
        let mut r = ZMat::identity(n).to_rows();
        for _ in 0..3 * n {
            let (i, j) = ((rng(s) % n as u64) as usize, (rng(s) % n as u64) as usize);
            if i != j {
                let q = BigInt::from((rng(s) % 5) as i64 - 2);
                let rj = r[j].clone();
                for (x, y) in r[i].iter_mut().zip(&rj) {
                    *x += &q * y;
                }
            }
        }
        ZMat::from_rows(r)
    };
    let mut d = ZMat::zero(n, n);
    for i in 0..n {
        d.d[i * n + i] = BigInt::from(if i == 0 { 1 } else { p });
    }
    uni(&mut s).mul(&d).mul(&uni(&mut s))
}

/// The bench's det_input: entry (i, j) = (i + 2)^(j + 3) mod 1000003 - 500001
/// (at n = 12 its Smith form's modulus e is 6: the word path runs).
fn bench(n: usize) -> ZMat {
    let pm = |b: u64, e: u64| -> i64 {
        let (mut r, mut b, mut e) = (1u128, b as u128, e);
        while e > 0 {
            if e & 1 == 1 {
                r = r * b % 1_000_003;
            }
            b = b * b % 1_000_003;
            e >>= 1;
        }
        r as i64
    };
    ZMat { rows: n, cols: n, d: (0..n * n).map(|k| BigInt::from(pm((k / n + 2) as u64, (k % n + 3) as u64) - 500_001)).collect() }
}

fn names() -> [&'static str; FAMILIES] {
    ["MulSchool", "MulNtt", "Div", "DivNewton", "Gcd", "Move", "ModArith", "AddSub", "Walk", "Other"]
}

#[test]
fn zmat_units_and_stop_checks() {
    assert_eq!(names().len(), FAMILIES);
    let print = std::env::var("PRINT_PINS").is_ok();
    let a10 = rand(10, 10, 1000, 3);
    let a44 = rand(44, 44, 1 << 20, 5);
    let small = rand(5, 5, 50, 7);
    let def = deficient(12, 6, 11);
    let wide = rand(6, 14, 30, 13);
    let b1 = rand(10, 1, 100, 17);
    let hard8 = hard(8, 1_000_003, 19);
    let bench12 = bench(12);
    let content44 = a44.scale(&BigInt::from(6));
    // (name, units, checks)
    let rows: Vec<(&str, [u64; FAMILIES], u64)> = vec![
        ("det bareiss 5", measure(|| zmat::det(&small))),
        ("det crt 10", measure(|| zmat::det(&a10))),
        ("det with solve 44", measure(|| zmat::det(&a44))),
        ("solve 10", measure(|| zmat::solve(&a10, &b1))),
        ("rank full 10", measure(|| zmat::rank(&a10))),
        ("rank deficient 12", measure(|| zmat::rank(&def))),
        ("rref wide 6x14", measure(|| zmat::rref(&wide))),
        ("kernel 12", measure(|| zmat::kernel(&def))),
        ("inverse 10", measure(|| zmat::inverse(&a10))),
        ("charpoly 10", measure(|| zmat::charpoly(&a10))),
        ("mul 10", measure(|| a10.mul(&a10))),
        ("smith bench 12 (word e = 6)", measure(|| snf::invariants_square(&bench12))),
        ("smith content 6 x 44", measure(|| snf::invariants_square(&content44))),
        ("smith hard 8 (big e)", measure(|| snf::invariants_square(&hard8))),
        ("smith_mod 12 mod 360", measure(|| snf::smith_mod(&def, &BigInt::from(360)))),
    ]
    .into_iter()
    .map(|(n, (u, c))| (n, u, c))
    .collect();
    // pinned: the per-family units, and the Stop checks (equal to the code
    // before metering, no check added or moved, except a product's: mul
    // checks once a row on its i128 path too, as on its multi-limb one,
    // so mul 10 makes 10, and smith hard 8 makes 8 more, for its solve's
    // check a x of 8 rows)
    let pins: &[(&str, [u64; FAMILIES], u64)] = &[
        ("det bareiss 5", [60, 0, 60, 0, 0, 25, 0, 0, 0, 0], 4),
        ("det crt 10", [776, 0, 0, 0, 0, 272, 510, 0, 0, 0], 1),
        ("det with solve 44", [279280, 0, 47348, 0, 47964, 10318, 22581, 0, 0, 0], 76),
        ("solve 10", [1738, 0, 288, 0, 374, 226, 428, 0, 0, 0], 14),
        ("rank full 10", [285, 0, 0, 0, 0, 136, 236, 0, 0, 0], 0),
        // (with the CRT's setup charged: one prime for the three below,
        // [1, 0, 0, 0, 0, 3, 4, ..], two for inverse and charpoly, [4, 0, 0,
        // 0, 0, 8, 20, ..]; MultiCrt::setup_units)
        ("rank deficient 12", [2640, 0, 73, 0, 144, 829, 1609, 0, 0, 0], 0),
        ("rref wide 6x14", [1258, 0, 85, 0, 168, 213, 813, 0, 0, 0], 0),
        ("kernel 12", [1738, 0, 73, 0, 144, 539, 965, 0, 0, 0], 0),
        ("inverse 10", [4154, 0, 0, 0, 12, 1130, 1766, 0, 0, 0], 1),
        ("charpoly 10", [3634, 0, 0, 0, 0, 646, 922, 0, 0, 0], 1),
        ("mul 10", [1000, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10),
        ("smith bench 12 (word e = 6)", [7243, 0, 1208, 0, 2106, 1199, 3531, 0, 0, 0], 39),
        ("smith content 6 x 44", [338442, 0, 49400, 0, 50798, 17776, 35823, 0, 0, 0], 78),
        ("smith hard 8 (big e)", [2743, 0, 3320, 0, 240, 497, 971, 0, 0, 0], 24),
        ("smith_mod 12 mod 360", [0, 0, 0, 0, 0, 0, 1361, 0, 0, 0], 6),
    ];
    // (the Stop checks before metering, at the same inputs: 4, 1, 76, 14,
    // 0, 0, 0, 0, 1, 1, 0, 39, 78, 16, 6, the same as pinned but for the
    // products' rows above)
    if print {
        for (n, u, c) in &rows {
            println!("        (\"{n}\", {u:?}, {c}),");
        }
    }
    if !print {
        assert_eq!(pins.len(), rows.len(), "a pin per row");
        for ((n, u, c), (pn, pu, pc)) in rows.iter().zip(pins) {
            assert_eq!(n, pn);
            assert_eq!(u, pu, "{n}: units by family {:?}", names());
            assert_eq!(c, pc, "{n}: Stop checks");
        }
    }
    // every row counts something, and nothing lands in Other
    for (n, u, _) in &rows {
        assert!(u.iter().sum::<u64>() > 0, "{n}: no units");
        assert_eq!(u[Family::Other as usize], 0, "{n}: units in Other");
    }

    // the leaf rule: rank proven by its first prime counts exactly the
    // reduction and the elimination it calls, nothing of its own
    let p = Primes::new().next().unwrap();
    let m = Modulus::new(p);
    let (whole, _) = measure(|| zmat::rank(&a10));
    let (reduce, _) = measure(|| a10.reduce(&m));
    let r = a10.reduce(&m);
    let (elim, _) = measure(|| r.rank());
    let mut parts = [0; FAMILIES];
    for i in 0..FAMILIES {
        parts[i] = reduce[i] + elim[i];
    }
    assert_eq!(whole, parts, "rank = its reduction + its elimination, counted once");

    // the word path's gcd with e counts one ModArith unit per quotient
    // step: [7] mod 360 is the residue (1) and gcd(360, 7)'s three steps
    // (360 = 51 * 7 + 3, 7 = 2 * 3 + 1, 3 = 3 * 1); [0] mod 360 the residue
    // and the all-zero block's one call to gcd(360, 0), which takes no step
    let one = |x: i64| ZMat { rows: 1, cols: 1, d: vec![BigInt::from(x)] };
    let (u7, _) = measure(|| snf::smith_mod(&one(7), &BigInt::from(360)));
    let (u0, _) = measure(|| snf::smith_mod(&one(0), &BigInt::from(360)));
    let mut want = [0; FAMILIES];
    want[Family::ModArith as usize] = 4;
    assert_eq!(u7, want, "[7] mod 360");
    want[Family::ModArith as usize] = 2;
    assert_eq!(u0, want, "[0] mod 360");

    // one level up: the Smith form of a square matrix counts exactly its
    // determinant (with the solve it made) and the invariants from them,
    // nothing of its own and nothing twice, with and without a content
    for a in [&a44, &content44] {
        let (whole, _) = measure(|| snf::invariants_square(a));
        let mut solved = None;
        let (det, _) = measure(|| solved = Some(zmat::det_with_solve(a)));
        let (d, s) = solved.unwrap();
        let d = d.abs();
        let (inv, _) = measure(|| snf::invariants_nonsingular(a, &d, s));
        let mut parts = [0; FAMILIES];
        for i in 0..FAMILIES {
            parts[i] = det[i] + inv[i];
        }
        assert_eq!(whole, parts, "invariants_square = det_with_solve + invariants_nonsingular, counted once");
    }

    // a metered region charges exactly what was tallied inside it
    let mut meter = Meter::accounting(u64::MAX);
    let before = tallied();
    metered(&mut meter, || snf::invariants_square(&a44));
    assert_eq!(meter.units().0, delta(tallied(), before));
    assert!(meter.used() > 0);
}
