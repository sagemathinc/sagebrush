//! Stop inside the integer matrix product and inside a lifting step of
//! solve: both poll every 2^16 multiply-adds or so, within a row and across
//! the right-hand sides, not only between rows or steps.  Each case traces
//! its phase's checks, requires about one per 2^16 multiply-adds, arms Stop
//! at the middle one and checks the call unwinds there; the same call then
//! gives the same answer.  One test: the hooks and the request flag are
//! process-wide.

use num_traits::One;
use sagebrush_arith::zmat::{solve, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::{catch, hooks};

fn ones(r: usize, c: usize, v: &BigInt) -> ZMat {
    ZMat::from_rows((0..r).map(|_| vec![v.clone(); c]).collect())
}

fn identity(n: usize) -> ZMat {
    ZMat::from_rows((0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as u64)).collect()).collect())
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
    // the small-entry product (i128 accumulation): 256^3 multiply-adds
    let one = BigInt::one();
    let a = ones(256, 256, &one);
    let n = stops_in("arith.mul", || a.mul(&a));
    assert!(n >= (256 * 256 * 256) >> 16, "the small-entry product: {} checks", n);
    // the product of large entries (BigInt), 48^3 of them
    let big = BigInt::from(1u64 << 63) * BigInt::from(1u64 << 63);
    let b = ones(48, 48, &big);
    let n = stops_in("arith.mul", || b.mul(&b));
    assert!(n >= (48 * 48 * 48) >> 16, "the large-entry product: {} checks", n);
    // solve I x = B for 128 right-hand sides: a lifting step is 128^3
    // multiply-adds (the solves through the LU and the residual)
    let i = identity(128);
    let rhs = ones(128, 128, &one);
    let n = stops_in("arith.solve_lift", || solve(&i, &rhs));
    assert!(n >= (128 * 128 * 128) >> 16, "a lifting step: {} checks", n);
}
