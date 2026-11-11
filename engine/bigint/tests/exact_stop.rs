//! Stop during a Bernoulli table build (exact.rs): the build ends, the
//! thread's old table stays, and later tables are exact.  Its own test binary:
//! Stop is process-wide, and no other test runs beside it.

use num_traits::{One, Zero};
use sagebrush_bigint::exact::{bernoulli, bernoulli_number};
use sagebrush_bigint::{BigInt, BigRational};
use sagebrush_interrupt::{catch, clear, hooks};

/// B_0..B_n by the defining recurrence, in rationals: the reference.
fn by_recurrence(n: usize) -> Vec<BigRational> {
    let mut b = vec![BigRational::one()];
    while b.len() <= n {
        let m = b.len();
        let mut s = BigRational::zero();
        let mut binom = BigInt::one();
        for (j, bj) in b.iter().enumerate() {
            s += BigRational::from_integer(binom.clone()) * bj;
            binom = binom * BigInt::from(m + 1 - j) / BigInt::from(j + 1);
        }
        b.push(-s / BigRational::from_integer(BigInt::from(m + 1)));
    }
    b
}

#[test]
fn a_stopped_build_keeps_the_old_table_and_later_ones_are_exact() {
    let reference = by_recurrence(240);
    // the thread's table now holds B_0..B_60 (at least)
    let small = bernoulli(60);
    assert_eq!(small, reference[..=60].to_vec());
    // Stop a few checks into a large build (the tangent recurrence's rows)
    hooks::reset();
    hooks::arm_after(3);
    let r = catch(|| bernoulli(2000));
    clear();
    hooks::reset();
    assert!(r.is_err(), "Stop reached the table's build");
    // the old table answers as before, and a later, larger table is exact
    assert_eq!(bernoulli(60), small);
    assert_eq!(bernoulli(240), reference);
    for n in [0, 1, 2, 3, 61, 120, 239, 240] {
        assert_eq!(bernoulli_number(n), reference[n], "B_{}", n);
    }
}
