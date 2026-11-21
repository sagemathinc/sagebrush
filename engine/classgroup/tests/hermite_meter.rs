//! The Hermite routes' units (`cost::tally`) on fixed inputs: pinned per
//! family, so that a change in what a site counts (or a site counting a
//! callee's work again) fails here; leaf checks (`hermite` adds nothing of
//! its own to the route it takes, the cyclic wrapper only its copies); the
//! word helpers' step counts; a metered region charging exactly the
//! tallied difference; and the Stop checks, whose count on each input must
//! equal the count before metering (pinned below from that code).  One
//! test: the hooks are global.

use num_traits::Signed;
use sagebrush_arith::cost::{metered, tallied, Family, Meter, Units, FAMILIES};
use sagebrush_arith::zmat::{self, copy_units};
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::nf::zlin;
use sagebrush_classgroup::{api, arith, linalg, relations};
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

/// rows x cols entries in [-range, range].
fn rand(rows: usize, cols: usize, range: i64, seed: u64) -> Vec<Vec<i64>> {
    let mut s = seed | 1;
    (0..rows).map(|_| (0..cols).map(|_| (rng(&mut s) % (2 * range as u64 + 1)) as i64 - range).collect()).collect()
}

fn big(m: &[Vec<i64>]) -> Vec<Vec<BigInt>> {
    m.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
}

fn names() -> [&'static str; FAMILIES] {
    ["MulSchool", "MulNtt", "Div", "DivNewton", "Gcd", "Move", "ModArith", "AddSub", "Walk", "Other"]
}

fn sum(a: &[u64; FAMILIES], b: &[u64; FAMILIES]) -> [u64; FAMILIES] {
    let mut s = [0; FAMILIES];
    for i in 0..FAMILIES {
        s[i] = a[i] + b[i];
    }
    s
}

#[test]
fn hermite_units_and_stop_checks() {
    assert_eq!(names().len(), FAMILIES);
    let print = std::env::var("PRINT_PINS").is_ok();
    let m10 = rand(10, 10, 1000, 3);
    let m8 = rand(8, 8, 1 << 40, 5);
    let tall = rand(20, 6, 50, 7);
    let def = rand(9, 7, 20, 11);
    let m12 = rand(12, 12, 100, 13);
    // (56: the cyclic route on every target, at or above its threshold and
    // below the modular one, native and WebAssembly alike)
    assert!(api::HERMITE_CYCLIC_MIN_N_NATIVE.max(api::HERMITE_CYCLIC_MIN_N_WASM) <= 56);
    assert!(api::HERMITE_MODULAR_MIN_N_NATIVE.min(api::HERMITE_MODULAR_MIN_N_WASM) > 56);
    let m56 = rand(56, 56, 100, 17);
    let (b10, b12, b56) = (big(&m10), big(&m12), big(&m56));
    // d for the tall input: |det| of its first 6 rows, a multiple of the
    // lattice's determinant (the lattice contains those rows)
    let d6 = linalg::det_crt(&tall[..6]).abs();
    assert!(d6 > BigInt::from(0));
    let d8 = linalg::det_crt(&m8).abs();
    // (two equal rows: det 0, so the early stop ends after three primes)
    let mut sing = m10.clone();
    sing[9] = sing[0].clone();
    let d10 = linalg::det_crt(&m10).abs();
    let m6 = rand(6, 6, 10, 19);
    let d6w: i128 = num_traits::ToPrimitive::to_i128(&linalg::det_crt(&m6).abs()).unwrap();
    assert!(d6w > 0 && d6w < 1 << 62);
    let p = 1_000_003;
    // (name, units, checks)
    let rows: Vec<(&str, [u64; FAMILIES], u64)> = vec![
        ("det_mod_p 10", measure(|| linalg::det_mod_p(&m10, p))),
        ("det_crt 10", measure(|| linalg::det_crt(&m10))),
        ("det_crt 8 (40-bit entries)", measure(|| linalg::det_crt(&m8))),
        ("det_crt_probable 10 (singular)", measure(|| linalg::det_crt_probable(&sing))),
        ("hnf_mod 20 x 6 (word finish)", measure(|| linalg::hnf_mod(&tall, 6, &d6))),
        ("hnf_mod 8 (big d)", measure(|| linalg::hnf_mod(&m8, 8, &d8))),
        ("hnf_mod_small 6", measure(|| linalg::hnf_mod_small(&m6, 6, d6w))),
        ("hermite_modular 10", measure(|| api::hermite_modular(&b10))),
        ("zlin hnf 9 x 7", measure(|| zlin::hnf(&big(&def)))),
        ("hermite 12 (elimination)", measure(|| api::hermite(&b12))),
        ("hermite 56 (cyclic)", measure(|| api::hermite(&b56))),
    ]
    .into_iter()
    .map(|(n, (u, c))| (n, u, c))
    .collect();
    // pinned: the per-family units, and the Stop checks (equal to the code
    // before metering: no check was added or moved)
    let pins: &[(&str, [u64; FAMILIES], u64)] = &[
        ("det_mod_p 10", [285, 0, 0, 0, 0, 0, 393, 0, 0, 0], 10),
        ("det_crt 10", [1250, 0, 10, 0, 0, 0, 2957, 10, 0, 0], 44),
        ("det_crt 8 (40-bit entries)", [1816, 0, 72, 0, 0, 0, 7435, 71, 0, 0], 108),
        ("det_crt_probable 10 (singular)", [851, 0, 4, 0, 0, 0, 2095, 4, 0, 0], 33),
        ("hnf_mod 20 x 6 (word finish)", [1126, 0, 1396, 0, 150, 1303, 66, 1, 0, 0], 27),
        ("hnf_mod 8 (big d)", [9629, 0, 10195, 0, 1176, 880, 0, 0, 0, 0], 8),
        ("hnf_mod_small 6", [0, 0, 0, 0, 0, 108, 658, 0, 0, 0], 6),
        ("hermite_modular 10", [6634, 0, 4681, 0, 280, 2110, 2957, 10, 0, 0], 64),
        ("zlin hnf 9 x 7", [826, 0, 22, 0, 224, 1321, 0, 0, 0, 0], 34),
        ("hermite 12 (elimination)", [6380, 0, 211, 0, 780, 6702, 0, 0, 0, 0], 112),
        ("hermite 56 (cyclic)", [646072, 0, 51916, 0, 21604, 32528, 56327, 0, 0, 0], 203),
    ];
    // (the Stop checks before metering, at the same inputs: 10, 44, 108,
    // 33, 27, 8, 6, 64, 34, 112, 203, the same as pinned; the inputs take
    // the same routes on every target, so the pins hold under WebAssembly)
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

    // the leaf rule: hermite adds nothing of its own to the route it takes
    // (below the cyclic size, the elimination)
    let (whole, _) = measure(|| api::hermite(&b12));
    let (route, _) = measure(|| zlin::hnf(&b12));
    assert_eq!(whole, route, "hermite = zlin::hnf below the cyclic size");
    // and the cyclic wrapper adds only its two copies (Move) to zmat's work
    let mut h = None;
    let (wrapped, _) = measure(|| h = api::hermite_cyclic(&b56));
    let h = h.expect("the cyclic form");
    let a = zmat::ZMat::from_rows(b56.clone());
    let (inner, _) = measure(|| zmat::hermite_cyclic(&a));
    let mut copies = [0; FAMILIES];
    copies[Family::Move as usize] = b56.iter().chain(&h).map(|r| copy_units(r)).sum();
    assert_eq!(wrapped, sum(&inner, &copies), "hermite_cyclic = zmat's + the copies in and out");
    // and hermite at that size takes the cyclic route (on every target):
    // the same units
    let (via, _) = measure(|| api::hermite(&b56));
    assert_eq!(via, wrapped);

    // hermite_modular counts its determinant and its hnf_mod once: what it
    // adds itself (the conversion, the reduction above the diagonal) is
    // only Move, Div and MulSchool, so a recount of either callee would
    // show in ModArith, AddSub or Gcd
    let (whole, _) = measure(|| api::hermite_modular(&b10));
    let (det, _) = measure(|| linalg::det_crt(&m10));
    let (hnf, _) = measure(|| linalg::hnf_mod(&m10, 10, &d10));
    let parts = sum(&det, &hnf);
    for f in [Family::ModArith, Family::AddSub, Family::Gcd] {
        assert_eq!(whole[f as usize], parts[f as usize], "hermite_modular's {f:?} is its callees' alone");
    }
    for i in 0..FAMILIES {
        assert!(whole[i] >= parts[i], "hermite_modular includes det_crt + hnf_mod");
    }

    // the word helpers' units: a quotient step each, plus one for invmod's
    // call; Miller-Rabin's trial divisions
    assert_eq!(arith::xgcd_steps(360, 7).3, 3);
    assert_eq!(arith::xgcd_steps(5, 0).3, 0);
    // (7 = 2 * 3 + 1, 3 = 3 * 1: two steps, and the call)
    assert_eq!(arith::invmod_units(3, 7), (5, 3));
    assert_eq!(relations::is_prime_u64_units(4), (false, 1));
    assert_eq!(relations::is_prime_u64_units(37), (true, 12));

    // a metered region charges exactly what was tallied inside it
    let mut meter = Meter::accounting(u64::MAX);
    let before = tallied();
    metered(&mut meter, || api::hermite_modular(&b10));
    assert_eq!(meter.units().0, delta(tallied(), before));
    assert!(meter.used() > 0);
}
