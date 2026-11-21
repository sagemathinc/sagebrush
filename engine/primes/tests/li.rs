// li(x) and Li(x) against tests/li_reference.txt: about 850 exact doubles from
// the smallest subnormal to near the largest double, with li(x) to 30 digits
// computed by mpmath at 60 digits.  The error is measured in units in the last
// place of the true value.
use sagebrush_primes::{li, li_offset};

/// The size of one unit in the last place of a double of magnitude |v|.
fn ulp(v: f64) -> f64 {
    let a = v.abs();
    if a < f64::MIN_POSITIVE {
        return f64::from_bits(1);
    }
    let e = a.log2().floor();
    2f64.powf(e - 52.0)
}

fn reference() -> Vec<(f64, f64, String)> {
    include_str!("li_reference.txt")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(|l| {
            let mut it = l.split_whitespace();
            let x = parse_hex(it.next().unwrap());
            let v: String = it.next().unwrap().to_string();
            (x, v.parse::<f64>().unwrap(), v)
        })
        .collect()
}

/// A C99 hexadecimal float (Python's float.hex()).
fn parse_hex(s: &str) -> f64 {
    let (mant, exp) = s.split_once('p').unwrap();
    let mant = mant.trim_start_matches("0x");
    let (int, frac) = mant.split_once('.').unwrap_or((mant, ""));
    let mut m: u64 = u64::from_str_radix(int, 16).unwrap();
    for c in frac.chars() {
        m = m * 16 + c.to_digit(16).unwrap() as u64;
    }
    let e: i32 = exp.parse::<i32>().unwrap() - 4 * frac.len() as i32;
    // (exact: m < 2^53 and the scaling is by a power of two, in two steps for subnormals)
    (m as f64) * 2f64.powi(e / 2) * 2f64.powi(e - e / 2)
}

#[test]
fn li_matches_the_table() {
    let rows = reference();
    assert!(rows.len() > 800);
    let mut worst = (0.0f64, 0.0f64);
    for (x, want, text) in &rows {
        let got = li(*x);
        if want.is_infinite() {
            assert_eq!(got, *want, "li({x:e})");
            continue;
        }
        let err = (got - want).abs() / ulp(*want);
        // (near li's zero at x = 1.4513692..., the relative error is not
        // meaningful: there the absolute error is held to 2^-52 instead)
        let near_zero = want.abs() < 1e-3;
        if near_zero {
            assert!(
                (got - want).abs() <= 2f64.powi(-52),
                "li({x:e}) = {got:e}, want {text} (near li's zero)"
            );
        } else {
            // (3 ulp: 2.00 measured natively; the wasm build's log may round its last bit differently)
            assert!(err <= 3.0, "li({x:e}) = {got:e}, want {text}: {err:.2} ulp");
        }
        if !near_zero && err > worst.1 {
            worst = (*x, err);
        }
    }
    eprintln!(
        "li: {} values, worst {:.2} ulp at x = {:e}",
        rows.len(),
        worst.1,
        worst.0
    );
}

#[test]
fn li_offset_is_li_minus_li_2() {
    // Li(2) = 0, and Li(10^k) against values computed by mpmath (li(x, offset=True))
    // (li(2) to a double, less the double nearest li(2): within one rounding)
    assert!(
        li_offset(2.0).abs() <= 2f64.powi(-52),
        "Li(2) = {:e}",
        li_offset(2.0)
    );
    for (x, want) in [
        (10.0, 5.120435724669806),
        (1e6, 78626.50399568207),
        (1e8, 5762208.330284251),
        (1e24, 1.8435599767366349e+22),
    ] {
        let got = li_offset(x);
        assert!(
            (got - want).abs() <= 2.0 * ulp(want),
            "Li({x:e}) = {got:e}, want {want:e}"
        );
    }
}

#[test]
fn li_special_values() {
    assert_eq!(li(0.0), 0.0);
    assert_eq!(li(1.0), f64::NEG_INFINITY);
    assert_eq!(li(f64::INFINITY), f64::INFINITY);
    assert!(li(-1.0).is_nan());
    assert!(li(f64::NAN).is_nan());
    // li is increasing on (1, infinity) and decreasing on (0, 1)
    let mut prev = li(1.0 + 1e-9);
    for k in 1..2000 {
        let x = 1.0 + 1e-9 + (k as f64) * 0.05;
        let v = li(x);
        assert!(v > prev, "li is not increasing at {x}");
        prev = v;
    }
}
