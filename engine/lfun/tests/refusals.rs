// L(E, s) and the root number refuse what they cannot do, and say why.
use sagebrush_lfun::{anlist, root_number, terms_needed, LSeries, Local, C64};

fn an11(n: usize) -> Vec<i64> {
    anlist([0, -1, 1, -10, -20], &[Local { p: 11, ap: 1, good: false }], n).unwrap()
}

#[test]
fn too_few_coefficients() {
    let s = C64::new(1.0, 10.0);
    let need = terms_needed(11, s).unwrap();
    let l = LSeries::new(&an11(need - 1), 11, 1).unwrap();
    let e = l.value(s).unwrap_err();
    assert!(e.contains("coefficients are needed"), "{}", e);
    assert!(LSeries::new(&an11(need), 11, 1).unwrap().value(s).is_ok());
}

#[test]
fn s_out_of_range() {
    let l = LSeries::new(&an11(2000), 11, 1).unwrap();
    for s in [C64::new(1.0, 2e4), C64::new(-11.0, 0.0), C64::new(13.0, 1.0), C64::new(f64::NAN, 0.0)] {
        assert!(l.value(s).is_err(), "{:?}", s);
        assert!(terms_needed(11, s).is_err(), "{:?}", s);
    }
}

#[test]
fn bad_parameters() {
    let an = an11(100);
    assert!(LSeries::new(&an, 0, 1).is_err());
    assert!(LSeries::new(&an, 11, 0).is_err());
    assert!(LSeries::new(&[0, 2, 3], 11, 1).is_err());
    assert!(LSeries::new(&[0], 11, 1).is_err());
}

#[test]
fn the_root_number_needs_the_right_conductor() {
    let an = an11(5000);
    assert_eq!(root_number(&an, 11), Ok(1));
    let e = root_number(&an, 13).unwrap_err();
    assert!(e.contains("functional equation"), "{}", e);
    assert!(root_number(&an11(3), 11).unwrap_err().contains("coefficients are needed"));
}

#[test]
fn trivial_zeros() {
    let l = LSeries::new(&an11(2000), 11, 1).unwrap();
    for k in 0..4 {
        assert_eq!(l.value(C64::new(-(k as f64), 0.0)).unwrap(), C64::ZERO);
    }
}

#[test]
fn the_functional_equation() {
    // Lambda(s) = eps Lambda(2 - s) at points off the line, for eps = 1 (11a1) and -1 (37a1)
    let pi2 = 2.0 * std::f64::consts::PI;
    for (a, loc, n, eps) in [
        ([0, -1, 1, -10, -20], Local { p: 11, ap: 1, good: false }, 11u64, 1),
        ([0, 0, 1, -1, 0], Local { p: 37, ap: -1, good: false }, 37, -1),
    ] {
        let an = anlist(a, &[loc], 20_000).unwrap();
        let l = LSeries::new(&an, n, eps).unwrap();
        let q = (n as f64).sqrt() / pi2;
        let lambda = |s: C64| (s * q.ln() + sagebrush_lfun::ln_gamma(s).unwrap()).exp() * l.value(s).unwrap();
        for s in [C64::new(0.3, 4.0), C64::new(1.7, -2.5), C64::new(-0.5, 1.0), C64::new(2.2, 0.0)] {
            let (x, y) = (lambda(s), lambda(C64::new(2.0, 0.0) - s) * eps as f64);
            assert!((x - y).abs() <= 1e-12 * x.abs().max(1e-3), "{:?}: {:?} vs {:?}", s, x, y);
        }
    }
}
