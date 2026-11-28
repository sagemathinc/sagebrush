//! qpoly_divrem's time per work unit on three unit-heavy shapes (ignored:
//! a measurement, run with --ignored --nocapture natively and under
//! wasm32-wasip1): cancel-heavy (dense 1000 / non-monic 500), update-heavy (a
//! long non-monic divisor, little cancellation) and reduce-heavy (x^n / (3x -
//! 1), each quotient coefficient's reduction on growing numbers).  The cap's
//! time bound is the worst ns/unit times DIVREM_Q_WORK_MAX.

use sagebrush_arith::coprime::Meter;
use sagebrush_arith::pdivrem::{self, Words};
use sagebrush_arith::qpoly;

fn tok(n: i64, d: i64) -> String {
    let s = if n < 0 { "-" } else { "" };
    if d == 1 { format!("{}{:x}", s, n.unsigned_abs()) } else { format!("{}{:x}/{:x}", s, n.unsigned_abs(), d) }
}

/// (units, seconds) for one Q division, its meter unbounded.
fn run(a: &str, b: &str) -> (u64, f64) {
    let (fa, fb) = (qpoly::scan(a).unwrap(), qpoly::scan(b).unwrap());
    let caps = pdivrem::DIVREM_Q_CAPS;
    let r = (a.len() + b.len() + 20) as u64;
    let pa = qpoly::admit_a(&fa, &fb, r, &caps).unwrap().unwrap();
    let t = std::time::Instant::now();
    let mut m = Meter::new(u64::MAX);
    let l = pdivrem::clear_q(&fa, &fb, &pa, &mut m).unwrap();
    let (n, mm) = (pdivrem::norm_len(&fa) - 1, pdivrem::norm_len(&fb) - 1);
    let fixed = pdivrem::fixed_rows_q(&fb, mm, r, &pa, l.nb as u64).unwrap();
    let plan = pdivrem::Plan { n, m: mm, k: if n >= mm { n - mm + 1 } else { 0 }, fixed, limit: caps.int.peak / 8 - fixed, work: u64::MAX };
    let led = Words::new(plan.limit);
    let out = pdivrem::reply_q_on(&fa, &fb, &plan, &pa, l, &led, &mut m);
    let s = t.elapsed().as_secs_f64();
    assert!(out.is_ok(), "{:?}", out.err());
    (m.used(), s)
}

/// The three shapes' (name, a, b).
pub fn shapes() -> Vec<(&'static str, String, String)> {
    let dense_a = (0..1001).map(|i| tok(3 * i + 1, i % 12 + 1)).collect::<Vec<_>>().join(",");
    let dense_b = (0..501).map(|i| tok(3 * i + 6, i % 12 + 1)).collect::<Vec<_>>().join(",");
    // (a long divisor with lc 3 and small coprime coefficients: the window
    // is long, the content gcd stops at 1 at once)
    let upd_a = (0..1601).map(|i| tok((i * 7919) % 201 - 100, 1)).collect::<Vec<_>>().join(",");
    let upd_b = (0..801).map(|i| if i == 800 { "3".to_string() } else { tok((i * 104_729) % 19 - 9, 1) }).collect::<Vec<_>>().join(",");
    // (x^n / (3x - 1): q_j = 3^-(n-j), r = 3^-n, each reduction on a growing
    // denominator)
    let mut red_a = vec!["0".to_string(); 6001];
    red_a[6000] = "1".to_string();
    vec![
        ("cancel-heavy: dense 1000 / non-monic 500", dense_a, dense_b),
        ("update-heavy: 1600 / non-monic 800", upd_a, upd_b),
        ("reduce-heavy: x^6000 / (3x - 1)", red_a.join(","), "-1,3".to_string()),
    ]
}

#[test]
#[ignore]
fn qpoly_divrem_ns_per_unit() {
    let mut worst = 0f64;
    for (name, a, b) in shapes() {
        let _ = run(&a, &b);
        let (units, s) = (0..3).map(|_| run(&a, &b)).min_by(|x, y| x.1.partial_cmp(&y.1).unwrap()).unwrap();
        let ns = s * 1e9 / units as f64;
        worst = worst.max(ns);
        eprintln!("{}: {} units, {:.3} s, {:.3} ns/unit", name, units, s, ns);
    }
    eprintln!("worst {:.3} ns/unit: at the cap (DIVREM_Q_WORK_MAX units) {:.2} s", worst, worst * (pdivrem::DIVREM_Q_WORK_MAX as f64) / 1e9);
}
