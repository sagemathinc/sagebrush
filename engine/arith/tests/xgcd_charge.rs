//! The checked extended gcd's charges: the check is in [`bigxgcd_units`] at
//! every metered extended-gcd site; the plain-Euclid fallback (taken only
//! when dashu's coefficients fail their check, forced here through the
//! test hook) is priced step by step at its own sizes, and charged at each
//! metered site when it ran: each site on an input that reaches it alone,
//! or with sites pinned on an earlier row.

use num_traits::Num;
use sagebrush_arith::cost::{bigeuclid_units, bigmul_units, tallied, xgcd_fallback_units, Family, Local, Units, FAMILIES};
use sagebrush_arith::smith::route3::{compress, hnf_modulus, pivot_columns};
use sagebrush_arith::smith::smith_form;
use sagebrush_arith::snf::smith_mod;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::{extended_gcd_metered, with_xgcd_fallback_forced, with_xgcd_fallback_recorded, BigInt};

/// The pair on which the dashu fork's gcd_ext once returned wrong
/// coefficients (1034 bits each).
fn pair() -> (BigInt, BigInt) {
    (BigInt::from_str_radix("3e305effa6bf927ddf078324565301a9e1aab659637a2771aa0f4de1fbe63cba2e987e1d4b50035ca373247017db5b73878e5189174fe80eb41e140024dcb69e88efd1beb1543647c167689a59794e7c4ed41516c42df9c75908b4ca6fe41a48c0581cba7c9a90d286c0df21198ac314f9d2e53248d790d152fb8651e6338a1aba6", 16).unwrap(), BigInt::from_str_radix("21a005a143e3b14283ba84db2d9700a84d51263e60a4e8eb97ba35712a94628e4418db57e691913e5ad7e9aaf4cc7314ef57d93935791caf77d7da3d3da1aae6be8ebe887be1e6b19ead96d799e0d2f126a4ebc4390f4b9df621e9ec0037feeaaab3034a917352b217a375c4c48b835626442bfa1df42bc85e9f104468a5737c727", 16).unwrap())
}

fn units<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], T) {
    let t0 = tallied();
    let x = f();
    let t1 = tallied();
    let mut d = [0; FAMILIES];
    for (i, v) in d.iter_mut().enumerate() {
        *v = t1.0[i].wrapping_sub(t0.0[i]);
    }
    (d, x)
}

/// The fallback's steps on the pair, and their price: each step's
/// remainder update at its dividend's and divisor's sizes, and its two
/// coefficient updates at the coefficients' sizes (a pin; pricing them at
/// the inputs' sizes, 17 limbs each, would move it).
#[test]
fn the_fallback_is_priced_at_its_running_sizes() {
    let (p, a) = pair();
    let (e, fallback) = with_xgcd_fallback_forced(|| extended_gcd_metered(&p, &a));
    assert_eq!(&e.x * &p + &e.y * &a, e.gcd, "the fallback's result");
    let f = fallback.expect("the fallback ran");
    let mut want = Units::default();
    for &[la, lb, ls, lt] in &f.steps {
        let (la, lb) = (la.max(lb), la.min(lb));
        want.add(&bigeuclid_units(la, lb));
        let q = la - lb + 1;
        want.0[Family::Gcd as usize] += bigmul_units(q, ls).total().unwrap() + bigmul_units(q, lt).total().unwrap();
    }
    let got = xgcd_fallback_units(Some(&f));
    assert_eq!(got, want);
    assert_eq!((f.steps.len(), got.0), (PIN_STEPS, PIN_UNITS), "the fallback's steps and units on the pair");
    // (at the inputs' sizes it would cost more: the remainders shrink)
    let flat: u64 = (0..f.steps.len()).map(|_| bigeuclid_units(17, 17).total().unwrap() + 2 * bigmul_units(1, 17).total().unwrap()).sum();
    assert!(got.total().unwrap() < flat);
    // no fallback: nothing
    assert_eq!(xgcd_fallback_units(None), Units::default());
    let (e2, none) = extended_gcd_metered(&p, &a);
    assert_eq!((none, e2.gcd), (None, e.gcd));
}

const PIN_STEPS: usize = 187;
const PIN_UNITS: [u64; FAMILIES] = [0, 0, 0, 0, 6700, 0, 0, 0, 0, 0];

/// `f`'s Gcd units without and with the fallback forced (the same result),
/// and the forced run's units less the normal run's against the price of
/// the fallbacks it took (the check, paid by both, cancels): exactly equal.
fn gcd_units<T: PartialEq + std::fmt::Debug>(site: &str, f: impl Fn() -> T) -> (u64, u64) {
    let (normal, x) = units(&f);
    let (forced, (y, taken)) = units(|| with_xgcd_fallback_recorded(&f));
    assert_eq!(x, y, "{site}: the same result with the fallback");
    assert!(!taken.is_empty(), "{site}: a fallback taken");
    let mut want = [0u64; FAMILIES];
    for fb in &taken {
        for (w, u) in want.iter_mut().zip(xgcd_fallback_units(Some(fb)).0) {
            *w += u;
        }
    }
    let delta: Vec<u64> = (0..FAMILIES).map(|i| forced[i].wrapping_sub(normal[i])).collect();
    assert_eq!(delta, want.to_vec(), "{site}: the forced run's units less the normal run's = the fallbacks' price ({} taken)", taken.len());
    (normal[Family::Gcd as usize], forced[Family::Gcd as usize])
}

fn big(rows: usize, cols: usize, seed: u64) -> ZMat {
    let mut s = seed;
    let mut nx = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        BigInt::from(s >> 4)
    };
    ZMat::from_rows((0..rows).map(|_| (0..cols).map(|_| nx()).collect()).collect())
}

/// The 4 x 7 input X Y (X with 40-bit entries, Y with 4-bit ones) of
/// compress_units_pins' third row, on which Compress's G and delta are both
/// multi-limb (asserted), and its pivot columns.
fn route3_big_rings() -> (ZMat, Vec<usize>) {
    let mut s = 3u64;
    let mut e = |b: u32| {
        let mut nx = || {
            s = s.wrapping_add(0x9e3779b97f4a7c15);
            let mut z = s;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
            z ^ (z >> 31)
        };
        let x = BigInt::from(nx() >> (64 - b));
        if nx() & 1 == 1 {
            -x
        } else {
            x
        }
    };
    let (r, n) = (4, 7);
    let x = ZMat::from_rows((0..r).map(|_| (0..r).map(|_| e(40)).collect()).collect());
    let y = ZMat::from_rows((0..r).map(|_| (0..n).map(|_| e(4)).collect()).collect());
    let b = x.mul(&y);
    let j = pivot_columns(&b);
    let bj = ZMat::from_rows((0..r).map(|i| j.iter().map(|&c| b.get(i, c).clone()).collect()).collect());
    let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
    let jp: Vec<usize> = (0..n).filter(|c| !j.contains(c)).collect();
    let q = nm.mul(&ZMat::from_rows((0..r).map(|i| jp.iter().map(|&c| b.get(i, c).clone()).collect()).collect()));
    let g = hnf_modulus(&q, &delta, &det, &mut Local::new());
    assert!(g.bits() > 62 && delta.bits() > 62, "G and delta multi-limb (at least 2^62)");
    (b, j)
}

fn z(rows: &[&[i64]]) -> ZMat {
    ZMat::from_rows(rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect())
}

/// Each metered site, on an input whose only extended gcds are that
/// site's (route 3's row also takes the big ring's Bezout steps, pinned on
/// the third row): a forced fallback changes no result, and the run's units rise
/// by exactly the price of the fallbacks it took (recorded through the
/// hook).  Dropping any one site's fallback charge, or charging a multiple
/// of it, fails its row.
#[test]
fn each_site_charges_the_fallback_when_it_ran() {
    // route 1, multi-limb delta: the unit combination (no Bezout step)
    let a = big(12, 12, 0x2545f4914f6cdd1d);
    let (n1, f1) = gcd_units("route 1's unit combination", || {
        let f = smith_form(&a).unwrap();
        assert_eq!(f.route, sagebrush_arith::smith::Route::Cyclic);
        f.d.d
    });
    // route 2, word delta: the inverses of s_j / g_j only (the word ring's
    // Bezout steps take no extended gcd)
    let b = z(&[&[2, 0, 0], &[0, 2, -1], &[0, 0, 1]]);
    let (n2, f2) = gcd_units("route 2's inverses", || {
        let f = smith_form(&b).unwrap();
        assert_eq!(f.route, sagebrush_arith::smith::Route::Trailing);
        (f.d.d, f.u.d, f.v.d)
    });
    // the multi-limb ring's Bezout steps: smith_mod modulo a big e
    let c = big(6, 6, 0x9e3779b97f4a7c15);
    let e = BigInt::from(1u64 << 62) * BigInt::from(1u64 << 62) * BigInt::from(6) + BigInt::from(1);
    let (n3, f3) = gcd_units("the big ring's Bezout steps", || smith_mod(&c, &e));
    // hermite_cyclic's unit combination
    // (a cyclic lattice of multi-limb index d = 2^127 - 1: H = [[I, h], [0,
    // d]] with rows mixed by a unimodular matrix)
    let n = 6;
    let d = (BigInt::from(1) << 127usize) - BigInt::from(1);
    let mut rows: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as u8)).collect()).collect();
    let hs = big(1, n - 1, 0x1234_5678_9abc_def1);
    for i in 0..n - 1 {
        rows[i][n - 1] = hs.get(0, i) % &d;
    }
    rows[n - 1][n - 1] = d.clone();
    for t in 0..4 * n {
        let (i, j) = (t % n, (3 * t + 1) % n);
        if i != j {
            let rj = rows[j].clone();
            for (x, y) in rows[i].iter_mut().zip(rj) {
                *x += BigInt::from(1 + (t % 3) as i64) * y;
            }
        }
    }
    let h = ZMat::from_rows(rows);
    assert!(zmat::hermite_cyclic(&h).is_some(), "the cyclic path is taken");
    let (n4, f4) = gcd_units("hermite_cyclic", || zmat::hermite_cyclic(&h).map(|m| m.d));
    // route 3's Compress with G and delta both multi-limb: the big ring's
    // gcd_cofactor_e (compress_units_pins' third row; its Bezout steps,
    // the third row's site, run here too, so the row's delta is both sites')
    let (b, j) = route3_big_rings();
    let (n5, f5) = gcd_units("route 3's gcd_cofactor_e", || compress(&b, &j).unwrap());
    for (site, n, f) in [("route 1's unit combination", n1, f1), ("route 2's inverses", n2, f2), ("the big ring's Bezout steps", n3, f3), ("hermite_cyclic", n4, f4), ("route 3's gcd_cofactor_e", n5, f5)] {
        println!("{site}: Gcd units {n}, {f} with the fallback forced");
        assert!(f > n, "{site}: the forced fallback's work is charged");
    }
}
