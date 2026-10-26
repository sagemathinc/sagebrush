//! The transition gate of rank-3 plan r3, section 5, with delta 2 r2: the
//! full time of each real Stage-1 exit shape through Stage 2 to its
//! certificate, against Stage 1 certifying the same input normally.
//!
//!   cargo run --release -p sagebrush-poly --features test-faults \
//!     --example transition_bench -- CASE REPS
//!
//! CASE: S5, S6, S7 or S7xS6.  The five modes run interleaved, rotated per
//! round, REPS rounds:
//!   normal  Stage 1 certifies (no hook);
//!   a       column exhaustion: Stage 1's certificates are declined
//!           (STAGE1_NO_CERT), so it ends by its 32 columns;
//!   a+all   (a), and every Stage-2 pass before a level's last declines its
//!           certificate (S2_LAST_PASS): every level runs all its passes;
//!   b       level exhaustion: Stage 1 starts at precision 1 (STAGE1_LOW_PREC),
//!           its columns carry no information, it ends by its 3 levels;
//!   b+all   (b) with every pass, as above.
//! Every run checks its real counters (the exit shape actually taken, Stage
//! 2 entered, the passes) and the answer, then prints one line.
use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;
use sagebrush_poly::test_faults as tf;
use sagebrush_poly::Budget;
use std::time::Instant;

fn mul(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut r = vec![BigInt::zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            r[i + j] += x * y;
        }
    }
    r
}

/// S_k, the minimal polynomial of sqrt2 + sqrt3 + ... (k square roots).
fn sd(k: usize) -> Vec<BigInt> {
    let z = |v: &[i64]| -> Vec<BigInt> { v.iter().map(|&c| BigInt::from(c)).collect() };
    let mut s = z(&[-2, 0, 1]);
    for &p in &[3i64, 5, 7, 11, 13, 17, 19][..k - 1] {
        let (mut a, mut c) = (vec![BigInt::zero()], vec![BigInt::zero()]);
        for coef in s.iter().rev() {
            let mut na = mul(&a, &z(&[0, 1]));
            for (i, v) in mul(&c, &z(&[p])).iter().enumerate() {
                na[i] += v;
            }
            na[0] += coef;
            let mut nc = mul(&c, &z(&[0, 1]));
            for (i, v) in a.iter().enumerate() {
                nc[i] += v;
            }
            a = na;
            c = nc;
        }
        let mut r = mul(&a, &a);
        for (i, v) in mul(&mul(&c, &c), &z(&[p])).iter().enumerate() {
            r[i] -= v;
        }
        while r.last().is_some_and(|x| x.is_zero()) {
            r.pop();
        }
        s = r;
    }
    s
}

/// f(x + t).
fn shift(f: &[BigInt], t: i64) -> Vec<BigInt> {
    let mut out: Vec<BigInt> = vec![];
    for c in f.iter().rev() {
        out = if out.is_empty() { vec![BigInt::zero()] } else { mul(&out, &[BigInt::from(t), BigInt::one()]) };
        out[0] += c;
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let case = args.get(1).map(String::as_str).unwrap_or("S5");
    let reps: usize = args.get(2).and_then(|x| x.parse().ok()).unwrap_or(21);
    let (f, factors) = match case {
        "S5" => (sd(5), 1),
        "S6" => (sd(6), 1),
        "S7" => (sd(7), 1),
        "S7xS6" => (mul(&sd(7), &shift(&sd(6), 1)), 2),
        _ => panic!("CASE: S5, S6, S7 or S7xS6"),
    };
    let n = (f.len() - 1) as u64;
    let modes: [(&str, u8); 5] = [
        ("normal", 0),
        ("a", tf::STAGE1_NO_CERT),
        ("a+all", tf::STAGE1_NO_CERT | tf::S2_LAST_PASS),
        ("b", tf::STAGE1_LOW_PREC),
        ("b+all", tf::STAGE1_LOW_PREC | tf::S2_LAST_PASS),
    ];
    for round in 0..reps {
        for i in 0..modes.len() {
            let (name, hooks) = modes[(i + round) % modes.len()];
            let b = Budget::unlimited();
            let t = Instant::now();
            let r = tf::with_hooks(hooks, None, false, || sagebrush_poly::try_factor_with(&f, &b).map(|x| x.1.len()));
            let secs = t.elapsed().as_secs_f64();
            let reach = tf::reach();
            // the answer, and the shape actually taken (real-loop counters)
            assert_eq!(r.as_ref().ok(), Some(&factors), "{case} {name}: {r:?}");
            assert_eq!(reach.full_subsets_large, 0, "{case} {name}: {reach:?}");
            if name == "normal" {
                assert_eq!(reach.s2_entries, 0, "{case} {name}: {reach:?}");
            } else {
                assert_eq!(reach.s2_entries, 1, "{case} {name}: {reach:?}");
                assert!(reach.s2_cert_a > 0, "{case} {name}: {reach:?}");
                if name.starts_with('a') {
                    assert_eq!((reach.s1_exit_cols, reach.s1_exit_levels), (1, 0), "{case} {name}: {reach:?}");
                } else {
                    assert_eq!((reach.s1_exit_cols, reach.s1_exit_levels), (0, 1), "{case} {name}: {reach:?}");
                }
                if name.ends_with("all") {
                    // every level runs all its passes (a certificate is taken
                    // only after a level's last pass; a level below a* may
                    // still not certify, and the precision doubles)
                    assert!(reach.s2_levels >= 1, "{case} {name}: {reach:?}");
                    assert_eq!(reach.s2_passes, reach.s2_levels * n.div_ceil(4), "{case} {name}: all passes: {reach:?}");
                }
            }
            println!(
                "case {case} round {round} mode {name} seconds {secs:.6} factors {factors} s1_levels {} s1_cols {} s2_levels {} s2_passes {} s2_cols {} n {n} s2_cert_a {} a_star {}",
                reach.s1_levels, reach.s1_cols, reach.s2_levels, reach.s2_passes, reach.s2_cols, reach.s2_cert_a, reach.s2_a_star
            );
        }
    }
}
