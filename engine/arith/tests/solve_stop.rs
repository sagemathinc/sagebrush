//! solve looks for a lifting prime that does not divide det a; when the
//! first three all do, it goes on through the primes, one elimination
//! each, and that search polls for Stop (in its own phase). Here det a
//! holds the first three lifting primes and a 72-bit factor (which makes
//! the lifting primes the ones below 2^31). One test: the hooks and the
//! request flag are process-wide.

use num_traits::One;
use sagebrush_arith::nmod::Primes;
use sagebrush_arith::zmat::{solve, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::{catch, hooks};

#[test]
fn the_search_for_a_lifting_prime_stops() {
    let n = 55;
    let q: Vec<u64> = Primes::below(1 << 31).take(3).collect();
    let big = BigInt::from(1u64 << 62) * BigInt::from(1u64 << 10) + BigInt::one();
    let a = ZMat::from_rows(
        (0..n)
            .map(|i| {
                (0..n)
                    .map(|j| match (i == j, i) {
                        (true, 0..=2) => BigInt::from(q[i]),
                        (true, 3) => big.clone(),
                        (true, _) => BigInt::one(),
                        _ => BigInt::from(0u64),
                    })
                    .collect()
            })
            .collect(),
    );
    let b = ZMat::from_rows((0..n).map(|i| vec![BigInt::from(i as u64 + 1)]).collect());
    let phase = "arith.solve_prime";
    hooks::reset();
    hooks::trace();
    let (x, den) = solve(&a, &b).expect("nonsingular");
    let idx = hooks::traced(phase);
    hooks::reset();
    assert!(!idx.is_empty(), "the search for a lifting prime has no checks of its own");
    hooks::arm_at(idx[0]);
    let r = catch(|| solve(&a, &b));
    let at = hooks::stopped_in();
    hooks::reset();
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "not stopped");
    assert_eq!(at, phase, "stopped in the search for a lifting prime");
    // and after the Stop, the same answer
    assert_eq!(solve(&a, &b).unwrap(), (x, den));
}
