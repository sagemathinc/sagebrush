//! Stop inside the integer matrix product and inside a lifting step of
//! solve: both poll every 2^16 multiply-adds or so (a big-integer one
//! counted by its entries' sizes in words, and counted as it is done once
//! that is large), within a row and across the right-hand sides' solves,
//! not only between rows or steps.  A lifting step's parts are phases of
//! their own (the solves, the residual, the digits' accumulation; the step
//! itself keeps one check), so each part's polls are counted alone: each
//! case requires its part's share, arms Stop at its middle check and checks
//! the call unwinds there; the same call then gives the same answer.  One
//! test: the hooks and the request flag are process-wide.

use num_traits::One;
use sagebrush_arith::zmat::{solve, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::{catch, hooks};

fn ones(r: usize, c: usize, v: &BigInt) -> ZMat {
    ZMat::from_rows((0..r).map(|_| vec![v.clone(); c]).collect())
}

fn diagonal(n: usize, v: &BigInt) -> ZMat {
    ZMat::from_rows((0..n).map(|i| (0..n).map(|j| if i == j { v.clone() } else { BigInt::from(0u64) }).collect()).collect())
}

/// The checks `f` makes in each of `phases`.
fn traced<T>(phases: &[&str], f: impl Fn() -> T) -> Vec<usize> {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    let _ = f();
    let n = phases.iter().map(|p| hooks::traced(p).len()).collect();
    hooks::reset();
    n
}

/// The checks `f` makes in `phase`; Stop at the middle one unwinds there.
fn stops_in<T: PartialEq + std::fmt::Debug>(phase: &str, f: impl Fn() -> T) -> usize {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    let want = f();
    let idx = hooks::traced(phase);
    hooks::reset();
    assert!(!idx.is_empty(), "{}: no checks", phase);
    hooks::arm_at(idx[idx.len() / 2]);
    let r = catch(&f);
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "{}: not stopped", phase);
    assert_eq!(at, phase);
    assert_eq!(f(), want, "{}: after the Stop, the same answer", phase);
    idx.len()
}

#[test]
fn the_product_and_a_lifting_step_poll_within() {
    let one = BigInt::one();
    // the small-entry product (i128 accumulation): 256^3 multiply-adds
    let a = ones(256, 256, &one);
    let n = stops_in("arith.mul", || a.mul(&a));
    assert!(n >= (256 * 256 * 256) >> 16, "the small-entry product: {} checks", n);
    // the product of large entries (BigInt), 48^3 of them
    let big = BigInt::from(1u64 << 63) * BigInt::from(1u64 << 63);
    let b = ones(48, 48, &big);
    let n = stops_in("arith.mul", || b.mul(&b));
    assert!(n >= (48 * 48 * 48) >> 16, "the large-entry product: {} checks", n);
    // a product of few multiply-adds (16^3 = 4096, under one poll's count)
    // of 2^16-bit entries: each counts as its entries' sizes in words
    // (about a million word products), so it polls (16 rows: 16 checks of
    // their own, the rest the weighted polls)
    let huge = BigInt::from(1u64) << 65536usize;
    let h = ones(16, 16, &huge);
    let n = stops_in("arith.mul", || h.mul(&h));
    assert!(n >= 16 * 16, "the product of 2^16-bit entries: {} checks", n);
    // one entry of 128 terms of 4097-bit entries (64 words: 4097 word
    // products a multiply-add, past 2^10): counted as each is done, it
    // polls within the entry, 8 times (and the row's one check); counted
    // once for the entry, once
    let l = ZMat::from_rows(vec![vec![BigInt::from(1u64) << 4096usize; 128]]);
    let r = ones(128, 1, &(BigInt::from(1u64) << 4096usize));
    let n = stops_in("arith.mul", || l.mul(&r));
    assert!(n >= 1 + ((128 * 4097) >> 16), "one entry of large terms: {} checks", n);
    // the solves of a lifting step (the digits), on the step's count: I_64
    // with 256 right-hand sides, n (n + 1) = 4160 multiply-adds a solve,
    // under one poll's count, so they poll only across the right-hand
    // sides: 256 * 4160 a step, at least 16 polls (each of the two
    // triangular solves is half of it); the step's own phase has its one
    // check a step
    let i64m = diagonal(64, &one);
    let wide = ones(64, 256, &one);
    let c = traced(&["arith.solve_digits", "arith.solve_lift"], || solve(&i64m, &wide));
    assert!(c[1] >= 1 && c[0] >= c[1] * ((256 * 64 * 65) >> 16), "the solves: {} checks in {} steps", c[0], c[1]);
    stops_in("arith.solve_digits", || solve(&i64m, &wide));
    // the residual of a step (i128 path): I_128 with 128 right-hand sides,
    // 128^3 multiply-adds a step
    let i128m = diagonal(128, &one);
    let rhs = ones(128, 128, &one);
    let c = traced(&["arith.solve_residual", "arith.solve_lift"], || solve(&i128m, &rhs));
    assert!(c[1] >= 1 && c[0] >= c[1] * ((128 * 128 * 128) >> 16), "the i128 residual: {} checks in {} steps", c[0], c[1]);
    stops_in("arith.solve_residual", || solve(&i128m, &rhs));
    // the residual past i128 (a's entries leave i64: always the big-integer
    // path, each multiply-add counted by a's entries' size), and the
    // digits' accumulation into x (by p^iter's size): a diagonal of
    // 2^70 + 1 with 64 right-hand sides of 2^3000, whose solution's
    // numerators (about 2^2930) take about 100 steps to lift
    let d = diagonal(32, &((BigInt::from(1u64) << 70usize) + BigInt::one()));
    let rhs = ones(32, 64, &(BigInt::from(1u64) << 3000usize));
    let n = stops_in("arith.solve_residual", || solve(&d, &rhs));
    assert!(n >= 1, "the big-integer residual: {} checks", n);
    let n = stops_in("arith.solve_x", || solve(&d, &rhs));
    assert!(n >= 1, "the digits' accumulation: {} checks", n);
}
