//! Route 3's work model, term by term: on pinned inputs (wide, tall,
//! square of corank 1 and of corank n / 2, a word and a multi-limb G),
//! each term of stage 2's model is within a factor of the units its phase
//! charged, as the route records them; so a term the model dropped (0)
//! fails here, as does one gone far off.  The three inverses each have
//! their own check (B_J's on both sides, and T's, measured on T itself).

use num_traits::Zero;
use sagebrush_arith::cost::{tallied, Local};
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::smith::estimate::{self, stage2_route3_terms};
use sagebrush_arith::smith::route3::{compress, hnf_modulus, record_phases};
use sagebrush_arith::smith::smith_form;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use std::collections::BTreeMap;

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
fn e(r: &mut Rng, b: u32) -> BigInt {
    let x = BigInt::from(r.next() >> (64 - b));
    if r.next() & 1 == 1 {
        -x
    } else {
        x
    }
}
fn units<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let t0 = tallied();
    let x = f();
    let t1 = tallied();
    (x, (0..t0.0.len()).map(|i| t1.0[i].wrapping_sub(t0.0[i])).sum())
}

/// The input: X Y (X m x rank of `bits`-bit entries, Y rank x n of
/// 4-bit), or plain random (`plain`), with the last row the sum of the
/// first two when square.
fn input(rg: &mut Rng, m: usize, n: usize, rank: usize, bits: u32, plain: bool) -> ZMat {
    if plain {
        let mut x: Vec<Vec<BigInt>> = (0..m).map(|_| (0..n).map(|_| e(rg, bits)).collect()).collect();
        if m == n {
            x[m - 1] = x[0].iter().zip(&x[1]).map(|(p, q)| p + q).collect();
        }
        ZMat::from_rows(x)
    } else {
        let x = ZMat::from_rows((0..m).map(|_| (0..rank).map(|_| e(rg, bits)).collect()).collect());
        x.mul(&ZMat::from_rows((0..rank).map(|_| (0..n).map(|_| e(rg, 4)).collect()).collect()))
    }
}

/// The measured phases and the model's terms on `a`, by name (the failed
/// inverse pass, before route 3's entry, is in its entry phase; T's
/// inverse in the core's), and T's inverse alone, measured and modeled.
fn phases(a: &ZMat) -> (BTreeMap<String, u64>, BTreeMap<String, u64>, (u64, u64)) {
    let (m, n) = (a.rows, a.cols);
    let t0 = tallied();
    let (_, ph) = record_phases(|| smith_form(a).unwrap());
    let t1 = tallied();
    let actual: u64 = (0..t0.0.len()).map(|i| t1.0[i].wrapping_sub(t0.0[i])).sum();
    let mut meas: BTreeMap<String, u64> = BTreeMap::new();
    for (k, v) in ph {
        *meas.entry(k).or_default() += v;
    }
    assert_eq!(meas.values().sum::<u64>(), actual, "every unit in a phase");
    // stage 2's inputs, as the route computes them
    let p = Primes::new().next().unwrap();
    let (js, is, _) = a.reduce(&Modulus::new(p)).rref_rows();
    let r = is.len();
    let first = if r < n { ZMat::from_rows(is.iter().map(|&i| (0..n).map(|j| a.get(i, j).clone()).collect()).collect()) } else { a.transpose() };
    let fj = if r < n { js.clone() } else { is.clone() };
    let bj = ZMat::from_rows((0..r).map(|i| fj.iter().map(|&j| first.get(i, j).clone()).collect()).collect());
    let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
    let jp: Vec<usize> = (0..first.cols).filter(|x| !fj.contains(x)).collect();
    let q = nm.mul(&ZMat::from_rows((0..r).map(|i| jp.iter().map(|&j| first.get(i, j).clone()).collect()).collect()));
    let g = hnf_modulus(&q, &delta, &det, &mut Local::new());
    let mut model: BTreeMap<String, u64> = BTreeMap::new();
    let mut t_model = 0;
    for (k, u) in stage2_route3_terms(a, &is, &js, &nm, &delta, &det, &g, &estimate::FITTED) {
        let v: u64 = u.0.iter().sum();
        if k == "T inverse" {
            t_model = v;
        }
        let k = match k.as_str() {
            "T inverse" => "core".to_string(),
            "failed pass" => "entry".to_string(),
            _ => k,
        };
        *model.entry(k).or_default() += v;
    }
    // T, rebuilt from the two Compresses, and its inverse's units
    let (v0, c) = compress(&first, &fj).unwrap();
    let t = if r < n && r < m {
        let x = ZMat::from_rows((0..n).map(|i| (0..r).map(|j| v0.get(i, j).clone()).collect()).collect());
        compress(&a.mul(&x).transpose(), &is).unwrap().1.transpose()
    } else if r < n {
        c
    } else {
        c.transpose()
    };
    let (_, t_meas) = units(|| zmat::inverse_det(&t).unwrap());
    (meas, model, (t_meas, t_model))
}

#[test]
fn route3_model_terms_against_their_phases() {
    let mut rg = Rng(37);
    // (m, n, rank, bits, plain): square corank 1 (word G, XY big G), corank
    // n / 2, wide and tall (plain: word G; XY: big G), and multi-limb
    // entries
    let rows: &[(usize, usize, usize, u32, bool)] = &[
        (16, 16, 15, 16, true),
        (16, 16, 15, 16, false),
        (24, 24, 12, 16, false),
        (16, 22, 16, 16, true),
        (16, 18, 16, 16, false),
        (24, 12, 12, 16, true),
        (20, 14, 14, 16, false),
        (8, 120, 8, 16, false),
        (10, 14, 10, 64, true),
        (12, 12, 11, 64, true),
    ];
    let print = std::env::var("PRINT_TERMS").is_ok();
    let mut checked: BTreeMap<String, usize> = BTreeMap::new();
    let mut worst = 0.0f64;
    for &(m, n, rank, bits, plain) in rows {
        let a = input(&mut rg, m, n, rank, bits, plain);
        let (meas, model, (t_meas, t_model)) = phases(&a);
        let keys: std::collections::BTreeSet<&String> = meas.keys().chain(model.keys()).collect();
        for k in keys {
            let (x, y) = (*meas.get(k).unwrap_or(&0), *model.get(k).unwrap_or(&0));
            if x == 0 && y == 0 {
                continue;
            }
            let ratio = (y.max(1) as f64 / x.max(1) as f64).max(x.max(1) as f64 / y.max(1) as f64);
            if print {
                println!("{m}x{n} r{rank} {bits}b plain={plain}: {k:20} measured {x:>10} model {y:>10} ({ratio:.2})");
            }
            // (phases of a few units: a single entry's copy, say)
            if x >= 64 {
                *checked.entry(k.clone()).or_default() += 1;
                worst = worst.max(ratio);
                assert!(ratio <= FACTOR, "{m}x{n} r{rank}: the model's {k} is {y} units against the {x} its phase charged");
            }
        }
        let ratio = (t_model.max(1) as f64 / t_meas.max(1) as f64).max(t_meas.max(1) as f64 / t_model.max(1) as f64);
        if print {
            println!("{m}x{n} r{rank}: T inverse measured {t_meas} model {t_model} ({ratio:.2})");
        }
        assert!(ratio <= FACTOR, "{m}x{n} r{rank}: T's inverse modeled {t_model}, measured {t_meas}");
        *checked.entry("T inverse".into()).or_default() += 1;
    }
    println!("checked terms: {checked:?}; worst ratio {worst:.2}");
    for k in [
        "entry", "profile", "col: blocks", "col: B_J inverse", "col: Q", "col: G", "col: C echelon", "col: C solve", "col: lift", "col: N C", "col: H echelon", "col: K and X", "certificate", "A X", "left: blocks", "left: B_J inverse", "left: Q",
        "left: G", "left: C echelon", "left: N C", "left: H echelon", "left: K and X", "core", "combine", "T inverse",
    ] {
        assert!(checked.get(k).is_some_and(|&c| c > 0), "the term {k} is checked on some row");
    }
}

/// The factor every term stays within.
const FACTOR: f64 = 5.0;

#[allow(dead_code)]
fn _z(x: &BigInt) -> bool {
    x.is_zero()
}

/// The model's own cost: its steps (each `times` and each loop iteration)
/// at synthetic sizes do not depend on m or n, and grow at most linearly
/// in r (no loop over r (n - r) r).
#[test]
fn route3_models_cost_does_not_grow_with_the_input() {
    use estimate::{route3_model, Route3Sizes, Side};
    let steps = |m: usize, n: usize, r: usize| {
        let side = |w: usize| Side { r, w, lb: 1, ld: 4, delta_bits: 250, ln: 4, lg: 3, g_bits: 190, folds: 2, nd: 1.0, piv: 3, lgq: 1, sparse_x: false, khat: 1 };
        let z = Route3Sizes {
            m,
            n,
            r,
            la: 1,
            cols: Some(side(n)),
            left: Some(Side { sparse_x: true, ..side(m) }),
            inv_bj: Default::default(),
            inv_ct: Default::default(),
            inv_t: Default::default(),
            t_delta_bits: 1,
            failed_pass: Default::default(),
        };
        let s0 = estimate::model_steps();
        let u = route3_model(&z, &estimate::FITTED);
        assert!(u.0.iter().any(|&x| x > 0));
        estimate::model_steps() - s0
    };
    let (a, b, c) = (steps(300, 2000, 199), steps(600, 4000, 199), steps(600, 4000, 399));
    println!("route3_model steps: r = 199: {a} (m, n doubled: {b}); r = 399: {c}");
    assert_eq!(a, b, "the model's steps do not depend on m or n");
    assert!(c <= 2 * a + 64, "the model's steps grow at most linearly in r: {a} at r = 199, {c} at r = 399");
}
