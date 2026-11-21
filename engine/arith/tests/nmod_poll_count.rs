//! How often nmod_poly's and nmod_mat's kernels poll Stop on fixed inputs
//! (check_coarse calls counted by the interrupt crate's test hooks).
//! Metering must not make Stop rarer: each count is at least the count
//! before metering (pinned below from the code before it).  One test: the
//! hooks are global.

use sagebrush_arith::cost::{metered, Family, Meter};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::nmod_poly as np;
use sagebrush_interrupt::hooks;

fn poly(len: usize, seed: u64, m: &Modulus) -> Vec<u64> {
    let mut s = seed | 1;
    (0..len)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % m.n
        })
        .collect()
}

fn mat(r: usize, c: usize, m: Modulus, seed: u64) -> Mat {
    let rows: Vec<Vec<u64>> = (0..r).map(|i| poly(c, 2 * (seed + i as u64) + 1, &m)).collect();
    Mat::from_rows(&rows, m)
}

fn coarse_checks(f: impl FnOnce()) -> u64 {
    hooks::reset();
    f();
    let n = hooks::total();
    hooks::reset();
    n
}

#[test]
fn metering_polls_stop_at_least_as_often() {
    let m = Modulus::new(65537);
    let big = Modulus::new((1u64 << 61) - 1);
    let f = poly(900, 1, &m);
    let g = poly(800, 2, &m);
    let rows: Vec<(&str, u64)> = vec![
        ("mul 39x2000 schoolbook", coarse_checks(|| drop(np::mul(&poly(39, 3, &m), &poly(2000, 4, &m), &m)))),
        ("divrem 3000/50 classical", coarse_checks(|| drop(np::divrem(&poly(3000, 5, &m), &poly(50, 6, &m), &m)))),
        ("divrem 3000/50 classical, p = 2^61 - 1", coarse_checks(|| drop(np::divrem(&poly(3000, 5, &big), &poly(50, 6, &big), &big)))),
        ("gcd 900,800 Euclid", coarse_checks(|| drop(np::gcd(&f, &g, &m)))),
        ("powmod 65537 mod deg 300", coarse_checks(|| {
            let pm = np::PolyModulus::new(&poly(301, 7, &m), &m);
            drop(pm.powmod(&[0, 1], &[65537]));
        })),
    ];
    let big62 = Modulus::new((1u64 << 62) - 57);
    let a = mat(200, 200, m, 1);
    let b = mat(200, 10, m, 500);
    let ab = mat(120, 120, big62, 3);
    let w = mat(150, 220, m, 9);
    let lu = a.lu().unwrap();
    let v = poly(200, 11, &m);
    let mut rows = rows;
    rows.extend(vec![
        ("mul 200x200 200x10", coarse_checks(|| drop(a.mul(&b)))),
        ("mul 120x120 big p", coarse_checks(|| drop(ab.mul(&ab)))),
        ("mul_vec 200", coarse_checks(|| drop(a.mul_vec(&v)))),
        ("rank 200x200", coarse_checks(|| { let _ = a.rank(); })),
        ("det 120x120 big p", coarse_checks(|| { let _ = ab.det(); })),
        ("rref 150x220", coarse_checks(|| drop(w.clone().rref()))),
        ("lu 200", coarse_checks(|| drop(a.lu()))),
        ("solve_vec 200", coarse_checks(|| drop(lu.solve_vec(&v)))),
        ("solve 200 by 10", coarse_checks(|| drop(a.solve(&b)))),
        ("nullspace 150x220", coarse_checks(|| drop(w.nullspace()))),
        ("charpoly 200 small p (Hessenberg)", coarse_checks(|| drop(a.charpoly()))),
        ("charpoly 120 big p (Krylov)", coarse_checks(|| drop(ab.charpoly()))),
    ]);
    assert_eq!(rows.len(), BEFORE.len());
    for (name, n) in &rows {
        eprintln!("{:>40}: {} coarse checks", name, n);
    }
    for ((name, n), (bn, before)) in rows.iter().zip(BEFORE.iter()) {
        assert_eq!(name, bn);
        assert!(n >= before, "{}: {} coarse checks, fewer than {} before metering", name, n, before);
    }

    // A Stop inside a metered region: the unwinding ends the call (no abort
    // from the region's Drop guard), and the work done before it is charged.
    let stopped = |arm: u64, f: &dyn Fn()| -> Meter {
        let mut meter = Meter::accounting(u64::MAX);
        hooks::reset();
        hooks::arm_after(arm);
        let r = sagebrush_interrupt::catch(|| metered(&mut meter, f));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "the Stop ended the call");
        assert!(meter.used() > 0, "the work before the Stop is charged");
        assert_eq!(meter.units().total(), Some(meter.used()));
        meter
    };
    let pm = np::PolyModulus::new(&poly(301, 7, &m), &m);
    stopped(100, &|| drop(pm.powmod(&[0, 1], &[65537])));
    // the schoolbook product's one poll comes after the row that reaches
    // 2^16 multiply-adds (rows of at most 39): exactly those are charged
    let (x, y) = (poly(39, 3, &m), poly(2000, 4, &m));
    let u = stopped(1, &|| drop(np::mul(&x, &y, &m))).units();
    assert!((1 << 16..(1 << 16) + 39).contains(&u.get(Family::MulSchool)), "{:?}", u);
    // nmod_mat: a Stop in the middle of an elimination charges the work
    // before it, part of the whole
    let mut full = Meter::accounting(u64::MAX);
    metered(&mut full, || { let _ = a.rank(); });
    let u = stopped(30, &|| { let _ = a.rank(); }).units();
    assert!(u.get(Family::MulSchool) > 0 && u.get(Family::MulSchool) < full.units().get(Family::MulSchool), "{:?}", u);
}

// The counts before metering (nmod_poly and nmod_mat at track/math
// aba5e297, the same calls run there).
const BEFORE: [(&str, u64); 17] = [
    ("mul 39x2000 schoolbook", 1),
    ("divrem 3000/50 classical", 2),
    ("divrem 3000/50 classical, p = 2^61 - 1", 2),
    ("gcd 900,800 Euclid", 13),
    ("powmod 65537 mod deg 300", 243),
    ("mul 200x200 200x10", 6),
    ("mul 120x120 big p", 24),
    ("mul_vec 200", 0),
    ("rank 200x200", 57),
    ("det 120x120 big p", 12),
    ("rref 150x220", 65),
    ("lu 200", 57),
    ("solve_vec 200", 0),
    ("solve 200 by 10", 114),
    ("nullspace 150x220", 65),
    ("charpoly 200 small p (Hessenberg)", 112),
    ("charpoly 120 big p (Krylov)", 48),
];
