//! Codex audit A05: the incomplete Gamma function at a = -m + eps with m! past
//! the doubles, and complex reciprocal and division across the whole range.
use sagebrush_lfun::{gamma_inc, C64};

fn close(got: C64, re: f64, im: f64, tol: f64) -> bool {
    let d = (got.re - re).hypot(got.im - im);
    d <= tol * re.hypot(im).max(f64::MIN_POSITIVE)
}

#[test]
fn a05_f1_gamma_inc_near_poles_past_170() {
    // Gamma(a, 1) at negative a, mpmath and Sage 10.10 (PARI incgam) at 60+ digits; -170 is the
    // control (m! still a double), -171 onward overflowed m! and gave NaN
    let cases: [(f64, f64, f64, f64); 6] = [
        (-170.0, 0.0, 0.0021512677633681862079, 0.0),
        (-171.0, 0.0, 0.0021387612480004335403, 0.0),
        (-172.0, 0.0, 0.0021263993018804760933, 0.0),
        (-200.0, 0.0, 0.0018302004508904433815, 0.0),
        (-1000.0, 0.0, 0.00036751156209851746081, 0.0),
        (-200.125, 0.1, 0.0018290625784807580575, 0.00000090937052981173348306),
    ];
    for (ar, ai, re, im) in cases {
        let g = gamma_inc(C64::new(ar, ai), C64::real(1.0)).unwrap().value();
        assert!(g.is_finite() && close(g, re, im, 1e-12), "Gamma({} + {}i, 1) = {:?}, expected {} + {}i", ar, ai, g, re, im);
    }
}

#[test]
fn a05_f2_reciprocal_and_division_keep_representable_results() {
    // 1/(1e308 + 1e308 i) = (1 - i)/2e308, parts about 5e-309 (Smith's denominator overflowed: 0)
    for s in [1.0, -1.0] {
        let z = C64::new(1e308, s * 1e308);
        let r = z.recip();
        let want = 4.99999999999999994510468185279772e-309;
        assert!((r.re - want).abs() <= 1e-15 * want && (r.im + s * want).abs() <= 1e-15 * want, "1/{:?} = {:?}", z, r);
        assert_eq!(z / z, C64::ONE, "{:?} / itself", z);
    }
    // the quotient of a tiny number by itself is 1, though its reciprocal isn't a double (inf + NaN i)
    let t = C64::new(1e-309, 1e-309);
    assert_eq!(t / t, C64::ONE);
    let t = C64::new(5e-324, -5e-324);
    assert_eq!(t / t, C64::ONE);
    // across the range: (a z) / z = a for a few a, each z from 2^-1070 to 2^1020
    for k in [-1070, -900, -520, -100, 0, 100, 520, 900, 1020] {
        // (2^k built in two steps: powi(-1070) is 1 / 2^1070, which overflows first)
        let p2 = if k < -1000 { 2f64.powi(-1000) * 2f64.powi(k + 1000) } else { 2f64.powi(k) };
        let z = C64::new(p2 * 0.75, p2 * -0.5);
        assert!(close(z / z, 1.0, 0.0, 1e-15), "2^{}: {:?}", k, z / z);
        let r = z.recip() * z;
        if r.is_finite() {
            assert!(close(r, 1.0, 0.0, 1e-15), "2^{}: {:?}", k, r);
        }
    }
    // each part on its own: z / 1 and z / i are exact, whatever the parts' sizes, independently,
    // and the smaller part of a lopsided z survives (scaling the dividend by its own larger part
    // flushed it: (1e308 + 1e-308 i) / 1 was 1e308)
    let parts = [0.0, 5e-324, 1e-310, 1e-308, 1e-200, 1e-100, 0.5, 1.0, 3.0, 1e100, 1e200, 1e300, 1e308, f64::MAX];
    for &x in &parts {
        for &y in &parts {
            for (sx, sy) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
                let z = C64::new(sx * x, sy * y);
                let q1 = z / C64::ONE;
                assert!(q1.re == z.re && q1.im == z.im, "{:?} / 1 = {:?}", z, q1);
                let qi = z / C64::I;
                assert!(qi.re == z.im && qi.im == -z.re, "{:?} / i = {:?}", z, qi);
                let qm = z / C64::new(-2.0, 0.0);
                assert!(qm.re == z.re / -2.0 && qm.im == z.im / -2.0, "{:?} / -2 = {:?}", z, qm);
            }
        }
    }
    // a lopsided divisor of moderate quotient: (1e308 + 1e-308 i) / (2 + 0 i) keeps its 5e-309
    let q = C64::new(1e308, 1e-308) / C64::new(2.0, 0.0);
    assert_eq!((q.re, q.im), (5e307, 5e-309));
    // controls: moderate inputs keep the bits Smith's formulas gave
    let c = C64::new(3.0, 4.0).recip();
    assert_eq!((c.re, c.im), (0.12, -0.16));
    let c = C64::new(1e-308, 1e-308).recip();
    assert!(close(c, 5.0000000000000004534e307, -5.0000000000000004534e307, 1e-15), "{:?}", c);
    assert_eq!(C64::new(1.0, 2.0) / C64::new(3.0, -4.0), C64::new(1.0, 2.0) * C64::new(3.0, -4.0).recip());
}
