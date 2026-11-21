//! A metered region's progress moves during zmat's and the Smith form's own
//! work (published at their Stop checks), as it does for nmod's kernels: a
//! watcher thread sees a value strictly between 0 and the final charge.
//! (A file of its own: zmat_meter's Stop-check counts are global.  Native
//! only: it needs a second thread.)

#![cfg(not(target_arch = "wasm32"))]

use sagebrush_arith::cost::{metered_with, Meter, Progress};
use sagebrush_arith::snf;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

/// rows x cols entries of about `bits` bits.
fn big(rows: usize, cols: usize, bits: u32, seed: u64) -> ZMat {
    let mut s = seed | 1;
    let d = (0..rows * cols)
        .map(|_| {
            let mut x = BigInt::from(0);
            for _ in 0..bits.div_ceil(60) {
                x = (x << 60) + BigInt::from(rng(&mut s) >> 4);
            }
            if rng(&mut s) & 1 == 1 {
                -x
            } else {
                x
            }
        })
        .collect();
    ZMat { rows, cols, d }
}

/// Whether a watcher saw progress strictly inside (0, total) during `f`,
/// trying up to 200 times (a loaded machine may delay the watcher).
fn seen_mid(mut f: impl FnMut()) -> bool {
    for _ in 0..200 {
        let progress = Progress::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (p, seen, done) = (progress.clone(), seen.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Relaxed) {
                    seen.lock().unwrap().push(p.units().total().unwrap_or(0));
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
        if seen.lock().unwrap().iter().any(|&t| 0 < t && t < total) {
            return true;
        }
    }
    false
}

#[test]
fn progress_moves_during_bareiss_and_the_smith_big_path() {
    // det's Bareiss route (n <= 12 with entries over 200 bits): zmat's own
    // products and divisions, flushed at each elimination step
    let a = big(12, 12, 300, 3);
    assert!(seen_mid(|| drop(zmat::det(&a))), "Bareiss: progress seen mid-call");
    // the Smith form's big path (e above 2^62), flushed at each pass
    let b = big(16, 16, 40, 5);
    let e = (BigInt::from(1) << 200) + BigInt::from(3);
    assert!(seen_mid(|| drop(snf::smith_mod(&b, &e))), "the Smith big path: progress seen mid-call");
}
