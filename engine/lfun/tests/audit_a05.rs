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
    // a dividend with one part subnormal and the other huge, over non-powers of two: each part as
    // its own real division gives it (z.re / d, correctly rounded), not rounded small, then
    // scaled up ((2^-1074, 2^1020) / 0.1 gave 16 ulps, not 10)
    for d in [0.1, 0.3, 3.0, 7.5, 1e-5, 1e5] {
        for (x, y) in [(f64::from_bits(1), 2f64.powi(1020)), (f64::from_bits(7), 1e300), (1e300, f64::from_bits(3)), (2f64.powi(-1030), 1e308)] {
            let q = C64::new(x, y) / C64::real(d);
            assert!(q.re == x / d && q.im == y / d, "({:e}, {:e}) / {} = {:?}, want ({:e}, {:e})", x, y, d, q, x / d, y / d);
        }
    }
    // controls: moderate inputs keep the bits Smith's formulas gave
    let c = C64::new(3.0, 4.0).recip();
    assert_eq!((c.re, c.im), (0.12, -0.16));
    let c = C64::new(1e-308, 1e-308).recip();
    assert!(close(c, 5.0000000000000004534e307, -5.0000000000000004534e307, 1e-15), "{:?}", c);
    assert_eq!(C64::new(1.0, 2.0) / C64::new(3.0, -4.0), C64::new(1.0, 2.0) * C64::new(3.0, -4.0).recip());
}

/// A hex double ("0x1.8p+3", "-0x0.0p+0", "inf"), as Python's float.hex writes it.
fn hexf(s: &str) -> f64 {
    let (neg, s) = s.strip_prefix('-').map_or((false, s), |r| (true, r));
    let v = if s == "inf" {
        f64::INFINITY
    } else {
        let s = s.strip_prefix("0x").unwrap();
        let (m, e) = s.split_once('p').unwrap();
        let (ip, fp) = m.split_once('.').unwrap_or((m, ""));
        let mut mant = u64::from_str_radix(ip, 16).unwrap() as f64;
        let mut scale = 1.0 / 16.0;
        for ch in fp.chars() {
            mant += ch.to_digit(16).unwrap() as f64 * scale;
            scale /= 16.0;
        }
        // (mant < 2^53 exactly; then the binary exponent, in two steps past the doubles' range)
        let e: i32 = e.parse().unwrap();
        let half = e / 2;
        mant * 2f64.powi(half) * 2f64.powi(e - half)
    };
    if neg { -v } else { v }
}

#[test]
fn a05_division_against_exact_references() {
    // 3000 quotients with independent exponents for all four parts (zeros, subnormals, both ends,
    // tiny ratios times huge parts), each part against its exact rational quotient correctly
    // rounded, within 8 eps (|n1| + |n2|) / (c^2 + d^2) + 4 * 2^-1074, n1 and n2 that part's two
    // products: the componentwise bound complex division can promise (tests/complex_div_reference.json,
    // made with Python's fractions; the note there says how)
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/complex_div_reference.json");
    let d: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let rows = d["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3000);
    let mut bad = vec![];
    for row in rows {
        let v: Vec<f64> = row.as_array().unwrap().iter().map(|x| hexf(x.as_str().unwrap())).collect();
        let q = C64::new(v[0], v[1]) / C64::new(v[2], v[3]);
        let ok = |got: f64, want: f64, tol: f64| got.is_finite() && (got - want).abs() <= tol;
        if !ok(q.re, v[4], v[6]) || !ok(q.im, v[5], v[7]) {
            bad.push(format!("({:e} + {:e} i) / ({:e} + {:e} i) = {:?}, want ({:e}, {:e})", v[0], v[1], v[2], v[3], q, v[4], v[5]));
        }
    }
    assert!(bad.is_empty(), "{} of 3000 off, first: {:?}", bad.len(), &bad[..bad.len().min(5)]);
}

#[test]
fn a05_huge_part_over_a_divisor_with_a_tiny_part() {
    // a huge dividend part over a divisor whose smaller part is tiny, on both sides of Smith's
    // branch (the round before scaled y before multiplying by r: inf); against exact references
    // (Python fractions on the exact doubles; 1e-320 is the subnormal 9.99988671826831e-321)
    let cases: [(f64, f64, f64, f64, f64, f64); 5] = [
        (0.0, 1e308, 1.0, 1e-308, 0.9999999999999999, 1e308),
        (0.0, 1e308, 1.0, 5e-324, 4.9406564584124655e-16, 1e308),
        (0.0, 1e300, 1.0, 1e-320, 9.99988867182683e-21, 1e300),
        (1e300, 0.0, 1.0, 1e-320, 1e300, -9.99988867182683e-21),
        (0.0, 1e300, 1e-320, 1.0, 1e300, 9.99988867182683e-21),
    ];
    for (a, b, c, d, re, im) in cases {
        let q = C64::new(a, b) / C64::new(c, d);
        assert!(q.is_finite() && (q.re - re).abs() <= 4.0 * f64::EPSILON * re.abs().max(1e-300) && (q.im - im).abs() <= 4.0 * f64::EPSILON * im.abs().max(1e-300),
            "({:e} + {:e} i) / ({:e} + {:e} i) = {:?}, want ({:e}, {:e})", a, b, c, d, q, re, im);
    }
}
