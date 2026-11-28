//! qpoly_eval's time per work unit on unit-heavy shapes (ignored: a
//! measurement, run with --ignored --nocapture natively; the production wasm
//! engine's rates come from the same shapes' requests): product-heavy
//! (a_i = 1/(i+1), D = lcm(1..n+1), at -7/3: Horner's A_k Q products),
//! the same at a multi-limb point, q = 1 (wide integers at a long integer:
//! no Q), token-heavy (many unit coefficients at -3/5), and gcd-heavy (the
//! final reduction's gcd against a large D q^n).  The cap's time bound is
//! the worst ns/unit times zmul::WORK_MAX.

use sagebrush_arith::coprime::Meter;
use sagebrush_arith::pdivrem::Words;
use sagebrush_arith::{peval, qpoly, zmul};

/// (units, seconds) for one call, its meter unbounded (the lcm included).
fn run(a: &str, v: &str) -> (u64, f64) {
    let (fa, fv) = (qpoly::scan(a).unwrap(), qpoly::scan(v).unwrap());
    let r = (a.len() + v.len() + 40) as u64;
    let Ok(Ok(plan)) = peval::admit(&fa, &fv, r, &qpoly::CAPS) else { panic!("not computed") };
    let t = std::time::Instant::now();
    let mut m = Meter::new(u64::MAX);
    let d = peval::clear(&fa, &plan, &mut m).unwrap();
    let (bound, _, limit) = peval::admit_b(&fa, &fv, &d, &plan, r, &qpoly::CAPS).unwrap();
    let led = Words::new(limit);
    let out = peval::reply_on(&fa, &fv, &d, &plan, bound, &led, &mut m);
    let s = t.elapsed().as_secs_f64();
    assert!(out.is_ok(), "{:?}", out.err());
    (m.used(), s)
}

/// The shapes' (name, a, v).
pub fn shapes() -> Vec<(&'static str, String, String)> {
    let harmonic = (0..6000).map(|i| format!("1/{:x}", i + 1)).collect::<Vec<_>>().join(",");
    let wide = (0..600).map(|i| format!("{:x}{}", i + 1, "5".repeat(100))).collect::<Vec<_>>().join(",");
    let ones = (0..35_000).map(|_| "1").collect::<Vec<_>>().join(",");
    let gcd_a = (0..1000).map(|i| format!("{:x}/{:x}{}", 3 * i + 1, 2 * i + 1, "9".repeat(30))).collect::<Vec<_>>().join(",");
    vec![
        ("product-heavy: a_i = 1/(i+1), 6000 terms, at -7/3", harmonic.clone(), "-7/3".to_string()),
        ("product-heavy at a multi-limb point: 600 terms of 1/(i+1)", harmonic.split(',').take(600).collect::<Vec<_>>().join(","), format!("{}/{}", "e7".repeat(100), "9".repeat(200))),
        ("q = 1: 600 400-bit integers at a 2000-bit integer", wide, "d".repeat(500)),
        ("token-heavy: 35,000 unit coefficients at -3/5", ones, "-3/5".to_string()),
        ("gcd-heavy: 1000 terms with 128-bit denominators at 9/3a", gcd_a, "9/3a".to_string()),
    ]
}

#[test]
#[ignore]
fn eval_ns_per_unit() {
    let mut worst = 0f64;
    for (name, a, v) in shapes() {
        let _ = run(&a, &v);
        let (units, s) = (0..3).map(|_| run(&a, &v)).min_by(|x, y| x.1.partial_cmp(&y.1).unwrap()).unwrap();
        let ns = s * 1e9 / units as f64;
        worst = worst.max(ns);
        eprintln!("{}: {} units, {:.4} s, {:.3} ns/unit", name, units, s, ns);
    }
    eprintln!("worst {:.3} ns/unit: at the cap (zmul::WORK_MAX units) {:.2} s", worst, worst * (zmul::WORK_MAX as f64) / 1e9);
}
