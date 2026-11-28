//! The 1-norm reciprocal condition estimate (numerics-core P2b-2, design 2c8e55e8 §1): rcond = 1 / (||A||_1
//! est), est Higham's estimate of ||A^-1||_1 (N. J. Higham, ACM TOMS 14, 1988, Algorithm 674; LAPACK's dlacn2)
//! from A's factors, as LAPACK's dgecon (LU), dtrcon (a triangular A itself) and dpocon (Cholesky).
//!
//! [`lacn2`] is the same algorithm as the Python `_rcond_estimate` (lib/_matlab.py), step for step: x = B(1/n),
//! est = ||x||_1; then up to 4 more steps from the sign vector (B' sgn, the largest |x_j| (the first; a NaN
//! first, as numpy's argmax), B e_j), stopping when the sign vector repeats, the estimate does not grow, or the
//! largest entry repeats (x_last == |x_j|, dlacn2's test); then Higham's extra estimate from the alternating
//! vector (-1)^i (1 + i / (n - 1)), 2 ||B alt||_1 / (3n), taken if larger. The sign of x_i is +1 when x_i >= 0,
//! else -1 (NaN: -1). The solves here are column-oriented substitutions (B) and dot products in four partial
//! sums (B'), there row dot products: the rounding differs, the decisions are the same in practice (agreement to
//! 1e-10 relative on the same factors is tested on a corpus, evidence proto/rcond-agree.py).

use crate::lu::{lower_unit_col, upper_col};

/// dlacn2's iteration limit (ITMAX): the first estimate and at most 4 more.
const ITMAX: usize = 5;

/// +1 for x >= 0, -1 otherwise (NaN: -1), as numpy's where(x >= 0, 1, -1) and dlacn2's sign test.
#[inline(always)]
fn sgn(x: f64) -> f64 {
    if x >= 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// The index of the first largest |x_i|, a NaN winning at its first occurrence (numpy's argmax of |x|).
fn argmax_abs(x: &[f64]) -> usize {
    let mut best = 0;
    let mut big = x[0].abs();
    if big.is_nan() {
        return 0;
    }
    for (i, v) in x.iter().enumerate().skip(1) {
        let a = v.abs();
        if a.is_nan() {
            return i;
        }
        if a > big {
            best = i;
            big = a;
        }
    }
    best
}

/// sum a_i b_i in four partial sums by i mod 4, the tail into the first ones, combined as (s0 + s1) + (s2 + s3):
/// a fixed order (so the same bits on every backend: no FMA, no reassociation by the compiler), and independent
/// chains the compiler can keep in vector lanes (a single running sum is bound by the add latency).
#[inline(always)]
pub(crate) fn dot(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut s = [0.0f64; 4];
    let (ac, bc) = (a.chunks_exact(4), b.chunks_exact(4));
    let (ar, br) = (ac.remainder(), bc.remainder());
    for (x, y) in ac.zip(bc) {
        for l in 0..4 {
            s[l] += x[l] * y[l];
        }
    }
    for (l, (x, y)) in ar.iter().zip(br).enumerate() {
        s[l] += x * y;
    }
    (s[0] + s[1]) + (s[2] + s[3])
}

/// sum |x_i| in the same four partial sums as [`dot`].
#[inline(always)]
pub(crate) fn asum(x: &[f64]) -> f64 {
    let mut s = [0.0f64; 4];
    let c = x.chunks_exact(4);
    let r = c.remainder();
    for v in c {
        for l in 0..4 {
            s[l] += v[l].abs();
        }
    }
    for (l, v) in r.iter().enumerate() {
        s[l] += v.abs();
    }
    (s[0] + s[1]) + (s[2] + s[3])
}

/// sum |x_i| / d in [`asum`]'s four partial sums: a sum that does not overflow while every entry is finite.
fn asum_over(x: &[f64], d: f64) -> f64 {
    let mut q = [0.0f64; 4];
    for (i, v) in x.iter().enumerate() {
        q[i % 4] += v.abs() / d;
    }
    (q[0] + q[1]) + (q[2] + q[3])
}

/// Higham's estimate of ||B||_1 for the n x n linear map `apply(x, transposed)` (x overwritten by B x, or by B'x
/// when `transposed`), n >= 1; `x` and `xi` hold n elements each (the iterate and its sign vector).
pub fn lacn2(n: usize, x: &mut [f64], xi: &mut [f64], apply: &mut dyn FnMut(&mut [f64], bool)) -> f64 {
    let (x, xi) = (&mut x[..n], &mut xi[..n]);
    x.fill(1.0 / n as f64);
    apply(x, false);
    let mut est = asum(x);
    if n > 1 && est.is_finite() {
        for (s, v) in xi.iter_mut().zip(x.iter()) {
            *s = sgn(*v);
        }
        x.copy_from_slice(xi);
        apply(x, true);
        let mut j = argmax_abs(x);
        let mut it = 2;
        loop {
            x.fill(0.0);
            x[j] = 1.0;
            apply(x, false);
            let old = est;
            est = asum(x);
            if x.iter().zip(xi.iter()).all(|(v, s)| sgn(*v) == *s) || est <= old {
                break;
            }
            for (s, v) in xi.iter_mut().zip(x.iter()) {
                *s = sgn(*v);
            }
            x.copy_from_slice(xi);
            apply(x, true);
            let last = j;
            j = argmax_abs(x);
            if x[last] == x[j].abs() || it >= ITMAX {
                break;
            }
            it += 1;
        }
        // (Higham's extra estimate from the alternating vector)
        for (i, v) in x.iter_mut().enumerate() {
            let m = 1.0 + i as f64 / (n - 1) as f64;
            *v = if i % 2 == 0 { m } else { -m };
        }
        apply(x, false);
        // divided before doubled, as dlacn2: 2 * sum overflows on a finite sum near the largest double. And when
        // the sum itself rounds past the largest double with every entry finite (an SPD n = 32 at 2^-1018), each
        // entry divided by 3n first, in asum's order: the sum is used unchanged wherever it is finite
        let d = 3.0 * n as f64;
        let s = asum(x);
        let t = 2.0 * if s.is_finite() { s / d } else { asum_over(x, d) };
        if t > est {
            est = t;
        }
    }
    est
}

/// rcond from an estimate of ||A^-1||_1 and ||A||_1: (1 / est) / anorm, or 0 when the estimate is not finite
/// or zero (as the Python estimate). When 1 / est overflows (est a subnormal, as for [f64::MAX], whose rcond
/// is 1), (1 / anorm) / est instead, dtrcon's order: the same value wherever the first form is finite.
fn rcond_from(est: f64, anorm: f64) -> f64 {
    if !est.is_finite() || est == 0.0 {
        return 0.0;
    }
    let r = (1.0 / est) / anorm;
    if r.is_infinite() {
        (1.0 / anorm) / est
    } else {
        r
    }
}

/// x := U^-T x (U upper, non-unit): x_i := (x_i - [`dot`](u_.i, x)) / u_ii over k < i, column i of U.
pub(crate) fn upper_t(u: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for i in 0..n {
        let ui = &u[i * ld..i * ld + i + 1];
        let (head, tail) = x.split_at_mut(i);
        tail[0] = (tail[0] - dot(&ui[..i], head)) / ui[i];
    }
}

/// x := L^-T x (L unit lower): from the bottom, x_i := x_i - [`dot`](l_.i, x) over k > i, column i of L.
fn lower_unit_t(l: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for i in (0..n).rev() {
        let li = &l[i * ld + i + 1..i * ld + n];
        let (head, tail) = x.split_at_mut(i + 1);
        head[i] -= dot(li, tail);
    }
}

/// x := L^-1 x (L lower, non-unit), column-oriented with the reference dtrsv's skip of a zero x_k.
pub(crate) fn lower_col(l: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for k in 0..n {
        if x[k] != 0.0 {
            x[k] /= l[k + k * ld];
            let xk = x[k];
            for i in k + 1..n {
                x[i] -= xk * l[i + k * ld];
            }
        }
    }
}

/// x := L^-T x (L lower, non-unit): from the bottom, x_i := (x_i - [`dot`](l_.i, x) over k > i) / l_ii.
fn lower_t(l: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for i in (0..n).rev() {
        let li = &l[i * ld + i..i * ld + n];
        let (head, tail) = x.split_at_mut(i + 1);
        head[i] = (head[i] - dot(&li[1..], tail)) / li[0];
    }
}

/// The workspace the estimates need: two n-vectors.
pub fn cond_work_len(n: usize) -> Option<usize> {
    n.checked_mul(2)
}

/// rcond of the n x n A (1-norm `anorm`) from [`crate::lu::getrf`]'s nonsingular factors (dgecon): B = U^-1
/// L^-1 (the row interchanges leave the 1-norm of A^-1 = U^-1 L^-1 P unchanged), B' = L^-T U^-T. `work` holds
/// [`cond_work_len`] elements. 0 if anorm is 0.
pub fn gecon(lu: &[f64], n: usize, lda: usize, anorm: f64, work: &mut [f64]) -> f64 {
    if n == 0 {
        return f64::INFINITY;
    }
    if anorm == 0.0 {
        return 0.0;
    }
    let (x, xi) = work.split_at_mut(n);
    let est = lacn2(n, x, xi, &mut |v: &mut [f64], t: bool| {
        if t {
            upper_t(lu, lda, n, v);
            lower_unit_t(lu, lda, n, v);
        } else {
            lower_unit_col(lu, lda, n, v);
            upper_col(lu, lda, n, v);
        }
    });
    rcond_from(est, anorm)
}

/// rcond of the n x n triangular A itself (dtrcon, 1-norm), upper or lower, non-unit, with no zero diagonal.
pub fn trcon(a: &[f64], n: usize, lda: usize, upper: bool, anorm: f64, work: &mut [f64]) -> f64 {
    if n == 0 {
        return f64::INFINITY;
    }
    if anorm == 0.0 {
        return 0.0;
    }
    let (x, xi) = work.split_at_mut(n);
    let est = lacn2(n, x, xi, &mut |v: &mut [f64], t: bool| match (upper, t) {
        (true, false) => upper_col(a, lda, n, v),
        (true, true) => upper_t(a, lda, n, v),
        (false, false) => lower_col(a, lda, n, v),
        (false, true) => lower_t(a, lda, n, v),
    });
    rcond_from(est, anorm)
}

/// rcond of the n x n symmetric positive definite A (1-norm `anorm`) from [`crate::chol::potrf`]'s R (dpocon):
/// B = A^-1 = R^-1 R^-T, symmetric, so B' = B.
pub fn pocon(r: &[f64], n: usize, lda: usize, anorm: f64, work: &mut [f64]) -> f64 {
    if n == 0 {
        return f64::INFINITY;
    }
    if anorm == 0.0 {
        return 0.0;
    }
    let (x, xi) = work.split_at_mut(n);
    let est = lacn2(n, x, xi, &mut |v: &mut [f64], _| {
        upper_t(r, lda, n, v);
        upper_col(r, lda, n, v);
    });
    rcond_from(est, anorm)
}

/// rcond of a diagonal A with no zero on it, exactly: ||A^-1||_1 = max |1 / d_i| (what the estimate reaches on
/// a diagonal: its column norms), so (1 / that) / ||A||_1.
pub fn diagcon(a: &[f64], n: usize, lda: usize, anorm: f64) -> f64 {
    if n == 0 {
        return f64::INFINITY;
    }
    if anorm == 0.0 {
        return 0.0;
    }
    let mut est = 0.0f64;
    for i in 0..n {
        let v = (1.0 / a[i + i * lda]).abs();
        if v > est {
            est = v;
        }
    }
    rcond_from(est, anorm)
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::gemm::tests::seeded;
    use crate::gemm::Kernel;
    use std::{vec, vec::Vec};

    /// The exact 1-norm of A^-1 for a small nonsingular A (columns of A^-1 by solving with LU, in f64).
    fn inv_norm1(a: &[f64], n: usize) -> f64 {
        let mut f = a.to_vec();
        let mut ipiv = vec![0; n];
        let mut work = vec![0.0; crate::lu::solve_work_len(n, n).unwrap()];
        let mut x = vec![0.0; n * n];
        for i in 0..n {
            x[i + i * n] = 1.0;
        }
        crate::lu::solve(Kernel::Scalar, &mut f, n, n, &mut x, n, n, &mut ipiv, &mut work).unwrap();
        (0..n).map(|j| asum(&x[j * n..(j + 1) * n])).fold(0.0, f64::max)
    }

    fn norm1(a: &[f64], n: usize) -> f64 {
        (0..n).map(|j| asum(&a[j * n..(j + 1) * n])).fold(0.0, f64::max)
    }

    fn lu_rcond(a: &[f64], n: usize) -> (f64, Option<usize>) {
        let mut f = a.to_vec();
        let mut ipiv = vec![0; n];
        let mut work = vec![0.0; crate::lu::getrf_work_len(n, n).unwrap()];
        let info = crate::lu::getrf(Kernel::Scalar, &mut f, n, n, n, &mut ipiv, &mut work).unwrap();
        let mut w = vec![0.0; cond_work_len(n).unwrap()];
        (gecon(&f, n, n, norm1(a, n), &mut w), info)
    }

    /// The estimate never exceeds ||A^-1||_1, so rcond_est >= the true rcond, and it is exact or close on small
    /// matrices (Higham: within a factor 3 in practice; here, within 10).
    #[test]
    fn the_estimate_bounds_the_true_rcond() {
        for n in [1usize, 2, 3, 5, 8, 12, 20] {
            for seed in 0..5u32 {
                let a = seeded(n * n, &mut (seed * 31 + n as u32));
                let (rc, info) = lu_rcond(&a, n);
                assert_eq!(info, None);
                let truth = 1.0 / (norm1(&a, n) * inv_norm1(&a, n));
                assert!(rc >= truth * (1.0 - 1e-12), "n={n} seed={seed}: {rc} < {truth}");
                assert!(rc <= 10.0 * truth, "n={n} seed={seed}: {rc} vs {truth}");
            }
        }
        // a Hilbert matrix (exact estimate is typical there)
        let n = 8;
        let h: Vec<f64> = (0..n * n).map(|k| 1.0 / ((k % n + k / n + 1) as f64)).collect();
        let (rc, _) = lu_rcond(&h, n);
        let truth = 1.0 / (norm1(&h, n) * inv_norm1(&h, n));
        assert!(rc >= truth * (1.0 - 1e-6) && rc <= 3.0 * truth, "hilbert: {rc} vs {truth}");
    }

    /// The nearly-singular decision (rcond < eps) flips across a constructed pair: A = [1 1; 1/2 1/2 + d]
    /// (neither triangular nor symmetric), rcond = d / (2 (3/2 + d)) exactly, estimated exactly at n = 2.
    #[test]
    fn the_eps_decision_flips_on_a_constructed_pair() {
        let eps = f64::EPSILON;
        for (scale, below) in [(0.9, true), (1.1, false)] {
            // (d as A holds it: 0.5 + d rounds to a multiple of 0.5's ulp)
            let d = (0.5 + 3.0 * eps * scale) - 0.5;
            let a = [1.0, 0.5, 1.0, 0.5 + d];
            let (rc, _) = lu_rcond(&a, 2);
            let exact = d / (2.0 * (1.5 + d));
            assert!((rc - exact).abs() <= 1e-6 * exact, "{rc} vs {exact}");
            assert_eq!(rc < eps, below, "scale {scale}: rcond {rc:e}");
        }
    }

    /// Unit lower L given by rows (strict lower part), column-major.
    fn unit_lower(rows: &[&[f64]]) -> Vec<f64> {
        let n = rows.len();
        let mut l = vec![0.0; n * n];
        for (i, r) in rows.iter().enumerate() {
            for (j, &v) in r.iter().enumerate() {
                l[i + j * n] = v;
            }
            l[i + i * n] = 1.0;
        }
        l
    }

    fn est_inv(l: &[f64], n: usize) -> f64 {
        let mut w = vec![0.0; 2 * n];
        let (x, xi) = w.split_at_mut(n);
        lacn2(n, x, xi, &mut |v: &mut [f64], t: bool| if t { lower_t(l, n, n, v) } else { lower_col(l, n, n, v) })
    }

    /// Each guard of the iteration matters (witnesses found by search, exact in integers;
    /// proto/lacn2-witness.py): on this 4 x 4 unit lower L the estimates of ||L^-1||_1 go 1.5 (B 1/n), 9 (first
    /// B e_j), 12 (second B e_j: the iteration past its first step), and 12 is exact; on the 3 x 3 one the
    /// iteration stops at 1 and only Higham's alternating vector raises it: 2 ||L^-1 alt||_1 / 9 = 11/9.
    #[test]
    fn the_iteration_and_the_extra_estimate_raise_the_estimate() {
        let l = unit_lower(&[&[], &[2.0], &[-1.0, -2.0], &[-3.0, 0.0, -3.0]]);
        assert!((inv_norm1(&l, 4) - 12.0).abs() <= 1e-13, "(the reference, through pivoted LU)");
        assert_eq!(est_inv(&l, 4), 12.0, "the iteration's later steps");
        let l = unit_lower(&[&[], &[1.0], &[0.0, 0.0]]);
        assert!((inv_norm1(&l, 3) - 2.0).abs() <= 1e-13);
        assert!((est_inv(&l, 3) - 11.0 / 9.0).abs() <= 1e-15, "the alternating estimate: {}", est_inv(&l, 3));
    }

    /// The estimate of ||M||_1 for a matrix M applied directly (B x = M x, B'x = M'x), exactly in integers.
    fn est_direct(m: &[f64], n: usize) -> f64 {
        let mut w = vec![0.0; 2 * n];
        let (x, xi) = w.split_at_mut(n);
        lacn2(n, x, xi, &mut |v: &mut [f64], t: bool| {
            let y: Vec<f64> = (0..n).map(|i| (0..n).map(|k| if t { m[k + i * n] * v[k] } else { m[i + k * n] * v[k] }).sum()).collect();
            v.copy_from_slice(&y);
        })
    }

    /// Two more guards, witnesses found by search (proto/lacn2-witness2.py, exact in integers): with M = [0 -2;
    /// 1 -1] the first B e_j does not raise the estimate (est == old: the iteration must stop there, then the
    /// alternating vector gives 2 * 7 / 6; going on would reach 3); with M = [1 3 -3; -1 0 -2; 0 -1 0] (row
    /// sums nonzero: every sign exact) the start from 1/n gives 5, from all ones 4. (dlacn2's x(jlast) test
    /// needs no abs: x_last = (B e_last)' sgn(B e_last) = ||B e_last||_1 >= 0, so that mutant is equivalent.)
    #[test]
    fn the_tie_and_the_starting_vector() {
        let m = [0.0, 1.0, -2.0, -1.0];
        assert_eq!(est_direct(&m, 2), 2.0 * 7.0 / 6.0, "a tie stops the iteration");
        let m = [1.0, -1.0, 0.0, 3.0, 0.0, -1.0, -3.0, -2.0, 0.0];
        assert_eq!(est_direct(&m, 3), 5.0, "the first estimate from 1/n");
        // (grader G11: the iteration limit, pinned at 5: on M = [0 -1 1 3; 4 -3 1 3; 2 -4 -4 0; -3 0 0 1] (row sums
        // nonzero) the 5th estimate, 9, is the answer; stopping after the 4th would give 8;
        // proto/lacn2-witness-itmax.py)
        let m = [0.0, 4.0, 2.0, -3.0, -1.0, -3.0, -4.0, 0.0, 1.0, 1.0, -4.0, 0.0, 3.0, 3.0, 0.0, 1.0];
        assert_eq!(ITMAX, 5);
        assert_eq!(est_direct(&m, 4), 9.0, "the fifth estimate");
    }

    /// gecon applies B = U^-1 L^-1 and B' = L^-T U^-T: the same estimate (within rounding) as the estimator run
    /// on the explicit inverse of A, B x = A^-1 x and B'x = A^-T x, on seeded nonsymmetric matrices.
    #[test]
    fn gecon_is_the_estimate_of_the_inverse() {
        for n in [3usize, 4, 5, 8, 12] {
            for seed in 0..4u32 {
                let a = seeded(n * n, &mut (seed * 17 + n as u32 + 300));
                let (rc, info) = lu_rcond(&a, n);
                assert_eq!(info, None);
                let mut inv = a.clone();
                let mut ipiv = vec![0; n];
                let mut work = vec![0.0; crate::lu::solve_work_len(n, n).unwrap()];
                let mut x = vec![0.0; n * n];
                for i in 0..n {
                    x[i + i * n] = 1.0;
                }
                crate::lu::solve(Kernel::Scalar, &mut inv, n, n, &mut x, n, n, &mut ipiv, &mut work).unwrap();
                let direct = (1.0 / est_direct(&x, n)) / norm1(&a, n);
                assert!((rc - direct).abs() <= 1e-10 * direct, "n={n} seed={seed}: {rc} vs {direct}");
            }
        }
    }

    #[test]
    fn diagonal_and_triangular_estimates_are_exact_on_small_cases() {
        // diag(2, -4, 0.5): ||A||_1 = 4, ||A^-1||_1 = 2, rcond = 1/8
        let d = [2.0, 0.0, 0.0, 0.0, -4.0, 0.0, 0.0, 0.0, 0.5];
        assert_eq!(diagcon(&d, 3, 3, 4.0), 0.125);
        // (the largest |1 / d_i| from a negative d_i: diag(2, -1/4), ||A^-1||_1 = 4, rcond = (1/4) / 2)
        assert_eq!(diagcon(&[2.0, 0.0, 0.0, -0.25], 2, 2, 2.0), 0.125);
        // upper [1 -1; 0 1]: A^-1 = [1 1; 0 1], ||A^-1||_1 = 2, ||A||_1 = 2
        let u = [1.0, 0.0, -1.0, 1.0];
        let mut w = [0.0; 4];
        assert_eq!(trcon(&u, 2, 2, true, 2.0, &mut w), 0.25);
        let l = [1.0, -1.0, 0.0, 1.0];
        assert_eq!(trcon(&l, 2, 2, false, 2.0, &mut w), 0.25);
        assert_eq!(gecon(&[], 0, 1, 0.0, &mut w), f64::INFINITY);
        assert_eq!(gecon(&[0.0], 1, 1, 0.0, &mut w), 0.0);
    }

    /// At the largest double the estimate is finite (||A^-1||_1 = 2^-1024, a subnormal) but its reciprocal is not:
    /// rcond of [f64::MAX] is exactly 1 (LAPACK's dtrcon, (1 / anorm) / est, gives 1; dgecon and dpocon, which
    /// divide in the other order, give Infinity), so every path gives 1. At 2^-1074 the inverse itself overflows,
    /// and every path gives 0, as LAPACK's three routines do.
    #[test]
    fn rcond_of_the_largest_and_smallest_scalars() {
        let mut w = [0.0; 8];
        for (v, want) in [(f64::MAX, 1.0), (-f64::MAX, 1.0), (f64::from_bits(1), 0.0)] {
            assert_eq!(diagcon(&[v], 1, 1, v.abs()), want, "diagcon {v:e}");
            assert_eq!(trcon(&[v], 1, 1, true, v.abs(), &mut w), want, "trcon upper {v:e}");
            assert_eq!(trcon(&[v], 1, 1, false, v.abs(), &mut w), want, "trcon lower {v:e}");
            assert_eq!(gecon(&[v], 1, 1, v.abs(), &mut w), want, "gecon {v:e}");
            if v > 0.0 {
                assert_eq!(pocon(&[v.sqrt()], 1, 1, v, &mut w), want, "pocon {v:e}");
            }
        }
        // (lower [MAX 0; 1 MAX]: ||A||_1 = MAX + 1 = MAX, ||A^-1||_1 = 1 / MAX + 1 / MAX^2, rcond 1 to rounding)
        let l = [f64::MAX, 1.0, 0.0, f64::MAX];
        let rc = trcon(&l, 2, 2, false, f64::MAX, &mut w);
        assert!((rc - 1.0).abs() <= 2.0 * f64::EPSILON, "trcon lower 2 x 2: {rc}");
    }

    #[test]
    fn argmax_and_sign_follow_numpy() {
        assert_eq!(argmax_abs(&[1.0, -3.0, 3.0]), 1);
        assert_eq!(argmax_abs(&[1.0, f64::NAN, 5.0]), 1);
        assert_eq!(argmax_abs(&[f64::NAN, 5.0]), 0);
        assert_eq!((sgn(0.0), sgn(-0.0), sgn(-1e-300), sgn(f64::NAN)), (1.0, 1.0, -1.0, -1.0));
    }

    /// A power-of-two scaling leaves rcond unchanged, bit for bit, through the scales where ||A^-1||_1 is
    /// finite: C = I + P/8 (P the cyclic shift, n = 8; exact rcond 7/9, LAPACK's dgecon 0.7777777777777778 at
    /// every scale here) by LU, and the SPD I + (P + P')/8 (n = 16) by Cholesky (even powers to 2^-1018, where
    /// dpocon gives 0.6; it gives 0 at 2^-1020). For C at 2^-1020 the alternating vector's solved sum is about
    /// 1.54e308, finite: 2 * sum before the division by 3n overflowed, and the infinite extra estimate made
    /// rcond 0.
    #[test]
    fn rcond_is_scale_invariant_up_to_the_largest_scales() {
        let mut kernels = vec![Kernel::Scalar];
        #[cfg(target_arch = "x86_64")]
        kernels.extend(crate::micro::Avx2Fma::detect().map(Kernel::Avx2Fma));
        #[cfg(target_arch = "aarch64")]
        kernels.push(Kernel::Neon);
        let shift = |n: usize, sym: bool| {
            let mut c = vec![0.0; n * n];
            for i in 0..n {
                c[i + i * n] = 1.0;
                c[i + ((i + 1) % n) * n] = 0.125;
                if sym {
                    c[(i + 1) % n + i * n] = 0.125;
                }
            }
            c
        };
        let lu_rc = |kern: Kernel, a: &[f64], n: usize| {
            let mut f = a.to_vec();
            let mut ipiv = vec![0; n];
            let mut work = vec![0.0; crate::lu::getrf_work_len(n, n).unwrap()];
            assert_eq!(crate::lu::getrf(kern, &mut f, n, n, n, &mut ipiv, &mut work).unwrap(), None);
            let mut w = vec![0.0; cond_work_len(n).unwrap()];
            gecon(&f, n, n, norm1(a, n), &mut w)
        };
        let chol_rc = |kern: Kernel, a: &[f64], n: usize| {
            let mut r = a.to_vec();
            let mut work = vec![0.0; crate::chol::potrf_work_len(n).unwrap()];
            assert_eq!(crate::chol::potrf(kern, &mut r, n, n, &mut work).unwrap(), None);
            let mut w = vec![0.0; cond_work_len(n).unwrap()];
            pocon(&r, n, n, norm1(a, n), &mut w)
        };
        let (c, s, s18) = (shift(8, false), shift(16, true), shift(18, true));
        for kern in kernels {
            let (rc, rs, rs18) = (lu_rc(kern, &c, 8), chol_rc(kern, &s, 16), chol_rc(kern, &s18, 18));
            assert_eq!(rc.to_bits(), (7.0f64 / 9.0).to_bits());
            for k in -1000..=1020 {
                let t = 2.0f64.powi(-k);
                let a: Vec<f64> = c.iter().map(|v| v * t).collect();
                assert_eq!(lu_rc(kern, &a, 8).to_bits(), rc.to_bits(), "LU 2^{}", -k);
                if k % 2 != 0 || k > 1018 {
                    // R scales by the square root of the scale, a power of two only for even k; at 2^-1020
                    // dpocon's own estimate overflows (LAPACK gives 0 there too)
                    continue;
                }
                let a: Vec<f64> = s.iter().map(|v| v * t).collect();
                assert_eq!(chol_rc(kern, &a, 16).to_bits(), rs.to_bits(), "Cholesky 2^{}", -k);
                // (n = 18: where 2 * sum before the division by 3n overflowed at 2^-1018, which n = 16 does not
                // reach)
                let a: Vec<f64> = s18.iter().map(|v| v * t).collect();
                assert_eq!(chol_rc(kern, &a, 18).to_bits(), rs18.to_bits(), "Cholesky n = 18, 2^{}", -k);
            }
        }
    }
}
