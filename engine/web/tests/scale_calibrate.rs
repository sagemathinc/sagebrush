//! qpoly_scale's, qpoly_derivative's and qpoly_integral's time per work
//! unit on three unit-heavy shapes (ignored: a measurement, run with
//! --ignored --nocapture natively; the production wasm engine's rates come
//! from the same shapes' requests): gcd-heavy (rational coefficients by a
//! large rational s, two gcds each), product-heavy (a 64th derivative of
//! wide coefficients, F_j's products and exact divisions) and token-heavy
//! (an integral of many small coefficients: the parse, the word gcd and the
//! emit per token), sum-heavy (a sum with large coprime denominators: both
//! of a pair's gcds run), and division-heavy (zpoly_fdiv: wide coefficients
//! by a multi-limb divisor, and many small ones by a one-limb divisor).  The
//! cap's time is the worst ns/unit times zmul::WORK_MAX, an extrapolation
//! from these shapes, not a bound for every input.

use sagebrush_arith::coprime::Meter;
use sagebrush_arith::pdivrem::Words;
use sagebrush_arith::pscale::{self, Kind};
use sagebrush_arith::{qpoly, zmul};

/// (units, seconds) for one call, its meter unbounded.
fn run(kind: Kind, a: &str, b: &str) -> (u64, f64) {
    let fa = qpoly::scan(a).unwrap();
    let fb = if matches!(kind, Kind::Derivative | Kind::FloorDiv) { qpoly::scan_ints(b) } else { qpoly::scan(b) }.unwrap();
    let r = (a.len() + b.len() + 40) as u64;
    let Ok(Ok(plan)) = pscale::admit(kind, &fa, &fb, r, &qpoly::CAPS) else { panic!("not computed") };
    let t = std::time::Instant::now();
    let led = Words::new(plan.limit);
    let mut m = Meter::new(u64::MAX);
    let out = pscale::reply_on(&fa, &fb, &plan, &led, &mut m);
    let s = t.elapsed().as_secs_f64();
    assert!(out.is_ok(), "{:?}", out.err());
    (m.used(), s)
}

/// The three shapes' (name, kind, a, b).
pub fn shapes() -> Vec<(&'static str, Kind, String, String)> {
    let gcd_a = (0..2000).map(|i| format!("{:x}{}/{:x}{}", i * 7 + 1, "d".repeat(150), i % 97 + 3, "b".repeat(100))).collect::<Vec<_>>().join(",");
    let gcd_s = format!("-{}/{}", "e7".repeat(62), "9".repeat(100));
    let prod_a = (0..20000).map(|i| format!("{:x}{}", i + 1, "a".repeat(75))).collect::<Vec<_>>().join(",");
    // (large coprime denominators: both gcds of every pair run)
    let sum_a = (0..20_000).map(|i| format!("{:x}{}/{:x}{}", i + 1, "c".repeat(60), 2 * i + 1, "f".repeat(40))).collect::<Vec<_>>().join(",");
    let sum_b = (0..20_000).map(|i| format!("-{:x}{}/{:x}{}", i + 7, "9".repeat(60), 2 * i + 3, "e".repeat(40))).collect::<Vec<_>>().join(",");
    let fdiv_wide = (0..3000).map(|i| format!("{}{:x}{}", if i % 2 == 0 { "-" } else { "" }, i + 1, "d".repeat(600))).collect::<Vec<_>>().join(",");
    let fdiv_many = (0..200_000).map(|i| format!("{}{:x}", if i % 2 == 0 { "-" } else { "" }, (i * 7919) % 1_000_003 + 1)).collect::<Vec<_>>().join(",");
    let tok_a = (0..200_000).map(|i| format!("{:x}/{:x}", (i * 31) % 4093 + 1, i % 61 + 2)).collect::<Vec<_>>().join(",");
    vec![
        ("gcd-heavy: 2000 rationals by a 500/400-bit rational", Kind::Scale, gcd_a, gcd_s),
        ("product-heavy: the 64th derivative of 20,000 300-bit integers", Kind::Derivative, prod_a, "40".to_string()),
        ("token-heavy: the integral of 200,000 small rationals", Kind::Integral, tok_a, "1/3".to_string()),
        ("sum-heavy: two 20,000-term polynomials with large coprime denominators", Kind::Add, sum_a, sum_b),
        // (the floor division: the divisions dominate, prepaid; signs mixed
        // so about half the quotients take the correction)
        ("division-heavy: 3000 2400-bit integers by a 800-bit divisor", Kind::FloorDiv, fdiv_wide, format!("-{}", "b".repeat(200))),
        ("division-heavy: 200,000 small integers by a one-limb divisor", Kind::FloorDiv, fdiv_many, "-7f3".to_string()),
    ]
}

#[test]
#[ignore]
fn scale_ns_per_unit() {
    let mut worst = 0f64;
    for (name, kind, a, b) in shapes() {
        let _ = run(kind, &a, &b);
        let (units, s) = (0..3).map(|_| run(kind, &a, &b)).min_by(|x, y| x.1.partial_cmp(&y.1).unwrap()).unwrap();
        let ns = s * 1e9 / units as f64;
        worst = worst.max(ns);
        eprintln!("{}: {} units, {:.4} s, {:.3} ns/unit", name, units, s, ns);
    }
    eprintln!("worst {:.3} ns/unit: at the cap (zmul::WORK_MAX units) {:.2} s", worst, worst * (zmul::WORK_MAX as f64) / 1e9);
}

/// (each shape's compute and emit apart: units and seconds)
#[test]
#[ignore]
fn scale_phases() {
    for (name, kind, a, b) in shapes() {
        let fa = qpoly::scan(&a).unwrap();
        let fb = if matches!(kind, Kind::Derivative | Kind::FloorDiv) { qpoly::scan_ints(&b) } else { qpoly::scan(&b) }.unwrap();
        let Ok(Ok(plan)) = pscale::admit(kind, &fa, &fb, (a.len() + 64) as u64, &qpoly::CAPS) else { panic!() };
        let led = Words::new(plan.limit);
        let mut m = Meter::new(u64::MAX);
        let t = std::time::Instant::now();
        let mp = pscale::compute(&fa, &fb, &plan, &led, &mut m).unwrap();
        let (u1, s1) = (m.used(), t.elapsed().as_secs_f64());
        let bytes = pscale::reply_bytes(&mp, &mut m).unwrap() as usize;
        let mut out = String::with_capacity(bytes);
        let t = std::time::Instant::now();
        pscale::emit(&mp, &mut out, &mut m).unwrap();
        let (u2, s2) = (m.used() - u1, t.elapsed().as_secs_f64());
        eprintln!("{}: compute {} units {:.4} s ({:.3} ns/unit); emit {} units {:.4} s ({:.3} ns/unit), {} bytes", name, u1, s1, s1 * 1e9 / u1 as f64, u2, s2, s2 * 1e9 / u2 as f64, bytes);
    }
}
