// ln Gamma(z) and Gamma(a, z) against tests/gamma_reference.txt: mpmath at 40 digits (run as an
// oracle by gen/gamma_reference.py) at about 200 points for ln Gamma and 890 for Gamma(a, z), over
// the region the L-series uses, near and at the poles of Gamma(a), and on the real line.
use sagebrush_lfun::{gamma_inc, ln_gamma, C64};

fn lines(kind: &str) -> Vec<Vec<f64>> {
    include_str!("gamma_reference.txt")
        .lines()
        .filter(|l| l.starts_with(kind))
        .map(|l| l.split_whitespace().skip(1).map(|x| x.parse().unwrap()).collect())
        .collect()
}

#[test]
fn ln_gamma_against_mpmath() {
    let mut worst = 0f64;
    for v in lines("lg ") {
        let z = C64::new(v[0], v[1]);
        let want = C64::new(v[2], v[3]);
        let got = ln_gamma(z).unwrap();
        // the values' relative error; the logarithm's imaginary part grows like |z| ln |z|, and its
        // rounding with it, so the bound allows for that
        let err = ((got - want).exp() - 1.0).abs();
        let allow = 1e-15 * (got.abs() + 20.0);
        worst = worst.max(err / allow);
        assert!(err < allow, "ln Gamma({:?}) = {:?}, mpmath {:?} (error {:.1e})", z, got, want, err);
    }
    eprintln!("ln Gamma: largest error {:.2} of the allowance", worst);
}

#[test]
fn gamma_inc_against_mpmath() {
    let mut worst = 0f64;
    for v in lines("inc ") {
        let (a, z) = (C64::new(v[0], v[1]), C64::new(v[2], v[3]));
        let (want, ln_scale) = (C64::new(v[4], v[5]), v[6]);
        let g = gamma_inc(a, z).unwrap();
        // |Gamma(a, z) - reference| / max(|Gamma(a, z)|, |Gamma(a)|) (|z^a e^-z| at the poles)
        let err = ((g.ln - ln_scale).exp() * g.m - (want - ln_scale).exp()).abs();
        worst = worst.max(err);
        assert!(err < 2e-12, "Gamma({:?}, {:?}): error {:.1e}", a, z, err);
    }
    eprintln!("Gamma(a, z): largest error {:.2e}", worst);
}

#[test]
fn gamma_inc_refuses_outside_its_domain() {
    let a = C64::new(1.0, 2.0);
    assert!(gamma_inc(a, C64::new(-1.0, 0.5)).is_err());
    assert!(gamma_inc(a, C64::ZERO).is_err());
    assert!(gamma_inc(C64::new(f64::NAN, 0.0), C64::ONE).is_err());
    assert!(gamma_inc(C64::new(-2000.0, 0.0), C64::ONE).is_err());
    assert!(ln_gamma(C64::new(-3.0, 0.0)).is_none());
    assert!(ln_gamma(C64::ZERO).is_none());
}

#[test]
fn special_values() {
    // Gamma(1, z) = e^-z, Gamma(1/2, x) = sqrt(pi) erfc(sqrt x), Gamma(0, x) = E_1(x)
    for z in [C64::new(0.3, 0.0), C64::new(2.5, -1.0), C64::new(40.0, 7.0), C64::new(0.01, 3.0)] {
        let g = gamma_inc(C64::ONE, z).unwrap().value();
        assert!((g - (-z).exp()).abs() <= 1e-14 * (-z).exp().abs(), "Gamma(1, {:?}) = {:?}", z, g);
    }
    // E_1(1) = 0.219383934395520273677163775460...
    let e1 = gamma_inc(C64::ZERO, C64::ONE).unwrap().value();
    assert!((e1.re - 0.219_383_934_395_520_3).abs() < 1e-15 && e1.im.abs() < 1e-16, "E_1(1) = {:?}", e1);
    // ln Gamma(1/2) = ln sqrt(pi) (to a few units of 1e-15: the shift to |z| >= 15 adds fifteen
    // logarithms, and Stirling's leading term is about 40 there)
    let h = ln_gamma(C64::new(0.5, 0.0)).unwrap();
    assert!((h.re - 0.572_364_942_924_700_1).abs() < 1e-14 && h.im == 0.0, "ln Gamma(1/2) = {:?}", h);
}
