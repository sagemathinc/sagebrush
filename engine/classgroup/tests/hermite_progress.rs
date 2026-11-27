//! A metered region's progress moves during the Hermite routes' own work
//! (published at their Stop checks): a watcher thread sees a value above
//! the setup's charge and below the final one.  (A file of its own:
//! hermite_meter's Stop-check counts are global.  Native only: it needs a
//! second thread.)

#![cfg(not(target_arch = "wasm32"))]

use num_traits::Signed;
use sagebrush_arith::cost::{metered_with, Family, Meter, Progress, Units};
use sagebrush_arith::zmat::{copy_units, limbs};
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::linalg;
use sagebrush_classgroup::nf::zlin;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn rand(rows: usize, cols: usize, range: i64, seed: u64) -> Vec<Vec<i64>> {
    let mut s = seed | 1;
    (0..rows).map(|_| (0..cols).map(|_| (rng(&mut s) % (2 * range as u64 + 1)) as i64 - range).collect()).collect()
}

/// Whether a watcher saw, during `f`, a published value for which `mid`
/// holds (given it and the final charge), trying up to 200 times (a loaded
/// machine may delay the watcher).
fn seen_by(mid: impl Fn(&Units, u64) -> bool, mut f: impl FnMut()) -> bool {
    for _ in 0..200 {
        let progress = Progress::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (p, seen, done) = (progress.clone(), seen.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Relaxed) {
                    seen.lock().unwrap().push(p.units());
                    std::thread::yield_now();
                }
            })
        };
        let mut meter = Meter::accounting(u64::MAX);
        metered_with(&mut meter, Some(progress.clone()), &mut f);
        done.store(true, Relaxed);
        watcher.join().unwrap();
        let total = meter.used();
        assert_eq!(progress.units().total(), Some(total), "the final publish equals the charge");
        if seen.lock().unwrap().iter().any(|u| mid(u, total)) {
            return true;
        }
    }
    false
}

/// Whether a watcher saw progress strictly inside (floor, total).
fn seen_mid(floor: u64, f: impl FnMut()) -> bool {
    seen_by(
        |u, total| {
            let t = u.total().unwrap_or(0);
            floor < t && t < total
        },
        f,
    )
}

#[test]
fn progress_moves_during_the_hermite_routes() {
    // det_mod_p, flushed at each column: above the input's reductions
    // (ModArith, published at the first column's check)
    let m = rand(200, 200, 1 << 40, 7);
    assert!(seen_mid(200 * 200, || {
        let _ = linalg::det_mod_p(&m, 1_000_003);
    }), "det_mod_p: progress seen mid-elimination");
    // det_crt's own count, flushed at each prime: its AddSub (the
    // symmetric-range test) is its alone (det_mod_p counts none), so AddSub
    // seen mid-call was published by det_crt's own flush, not by a
    // det_mod_p it called
    let a = rand(30, 30, 1 << 40, 3);
    assert!(seen_by(|u, total| u.get(Family::AddSub) > 0 && u.total().unwrap_or(0) < total, || drop(linalg::det_crt(&a))), "det_crt: its own count seen mid-call");
    // hnf_mod with a big d, flushed at each row: above the setup's charge
    // (the n x n start, Move, published at the first row's check), so the
    // rows' own publishing is what is seen
    let d = linalg::det_crt(&a).abs();
    let setup = (30 * 30 - 30 + 31 * limbs(&d)) as u64;
    assert!(seen_mid(setup, || drop(linalg::hnf_mod(&a, 30, &d))), "hnf_mod: progress seen mid-elimination");
    // hnf_mod_until (through hnf_mod_small), flushed at each row: above the
    // start's charge (n x n, Move)
    let rows = rand(600, 40, 1 << 30, 9);
    let d = (1i128 << 61) - 1;
    assert!(seen_mid(40 * 40, || drop(linalg::hnf_mod_small(&rows, 40, d))), "hnf_mod_until: progress seen mid-elimination");
    // zlin::hnf, flushed at each pass: above the input's copy (Move)
    let b: Vec<Vec<BigInt>> = rand(14, 14, 1 << 30, 5).into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect();
    let copy: u64 = b.iter().map(|r| copy_units(r)).sum();
    assert!(seen_mid(copy, || drop(zlin::hnf(&b))), "zlin::hnf: progress seen mid-elimination");
}
