//! Exact constants of number theory shared by the engines: the Bernoulli
//! numbers, as one table for everything that needs them. engine/ball's
//! Stirling series and dilogarithm and engine/sym's exact zeta and Hurwitz
//! zeta values use it; the multiprecision core's gamma and zeta, and Sage's
//! bernoulli, are to move onto it.
//!
//! B_2k comes from the tangent numbers T_k = tan^(2k-1)(0), made by Brent and
//! Harvey's recurrence (R. P. Brent and D. Harvey, "Fast computation of
//! Bernoulli, Tangent and Secant numbers", 2011, Algorithm TangentNumbers):
//! integers only, each step a product by a small integer and a sum, so the
//! whole table to n costs O(n^2) such steps on numbers of O(n log n) bits,
//! with no rational arithmetic until the end:
//!   B_2k = (-1)^(k-1) 2k T_k / (2^2k (2^2k - 1)).

use crate::{BigInt, BigRational};
use num_integer::Integer;
use num_traits::{One, Zero};
use std::cell::RefCell;

thread_local! {
    /// B_0 .. B_m for the largest m made so far in this thread.
    static TABLE: RefCell<Vec<BigRational>> = const { RefCell::new(Vec::new()) };
}

/// The tangent numbers T_1 .. T_m (index 0 unused).
fn tangent_numbers(m: usize) -> Vec<BigInt> {
    let mut t = vec![BigInt::zero(); m + 1];
    if m == 0 {
        return t;
    }
    t[1] = BigInt::one();
    for k in 2..=m {
        t[k] = &t[k - 1] * BigInt::from(k - 1);
    }
    for k in 2..=m {
        crate::check_interrupt();
        for j in k..=m {
            t[j] = &t[j - 1] * BigInt::from(j - k) + &t[j] * BigInt::from(j - k + 2);
        }
    }
    t
}

/// The table B_0 .. B_n (B_1 = -1/2, B_odd = 0 past it), each in lowest terms.
fn make(n: usize) -> Vec<BigRational> {
    let m = n / 2;
    let t = tangent_numbers(m);
    let mut b = vec![BigRational::zero(); n + 1];
    b[0] = BigRational::one();
    if n >= 1 {
        b[1] = BigRational::new(BigInt::from(-1), BigInt::from(2));
    }
    for k in 1..=m {
        let four_k = BigInt::one() << (2 * k);
        let num = &t[k] * BigInt::from(2 * k);
        let den = &four_k * (&four_k - BigInt::one());
        let g = num.gcd(&den);
        let (num, den) = (num / &g, den / &g);
        b[2 * k] = BigRational::new_raw(if k % 2 == 1 { num } else { -num }, den);
    }
    b
}

/// B_0 .. B_n exactly, in lowest terms (B_1 = -1/2).  The table is the
/// thread's, made again (at least twice as long) when a larger n is asked.
pub fn bernoulli(n: usize) -> Vec<BigRational> {
    TABLE.with(|c| {
        let mut b = c.borrow_mut();
        if b.len() <= n {
            *b = make(n.max(2 * b.len()));
        }
        b[..=n].to_vec()
    })
}

/// B_n exactly, in lowest terms.
pub fn bernoulli_number(n: usize) -> BigRational {
    if n > 1 && n % 2 == 1 {
        return BigRational::zero();
    }
    TABLE.with(|c| {
        let mut b = c.borrow_mut();
        if b.len() <= n {
            *b = make(n.max(2 * b.len()));
        }
        b[n].clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_traits::Signed;

    /// The reference: sum_(j<=m) C(m+1, j) B_j = 0, in rationals.
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
    fn known_values_and_the_recurrence() {
        let q = |n: i64, d: i64| BigRational::new(BigInt::from(n), BigInt::from(d));
        let b = bernoulli(30);
        assert_eq!(b[0], q(1, 1));
        assert_eq!(b[1], q(-1, 2));
        assert_eq!(b[2], q(1, 6));
        assert_eq!(b[3], q(0, 1));
        assert_eq!(b[12], q(-691, 2730));
        assert_eq!(b[30], BigRational::new("8615841276005".parse().unwrap(), BigInt::from(14322)));
        let r = by_recurrence(120);
        assert_eq!(bernoulli(120), r);
        for n in 0..=120 {
            assert_eq!(bernoulli_number(n), r[n], "B_{}", n);
            assert!(r[n].denom().is_positive());
        }
    }

    #[test]
    fn the_denominators_are_von_staudt_clausens() {
        // the denominator of B_2k is the product of the primes p with (p - 1) | 2k
        let b = bernoulli(200);
        for k in 1..=100usize {
            let mut d = BigInt::one();
            for p in 2..=2 * k + 1 {
                if (2..p).all(|f| p % f != 0) && (2 * k) % (p - 1) == 0 {
                    d *= BigInt::from(p);
                }
            }
            assert_eq!(b[2 * k].denom(), &d, "B_{}", 2 * k);
        }
    }
}
