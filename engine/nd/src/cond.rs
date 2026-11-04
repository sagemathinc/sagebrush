//! The 1-norm reciprocal condition estimate (numerics-core P2b-2, design 2c8e55e8 §1): rcond = 1 / (||A||_1
//! est), est Higham's estimate of ||A^-1||_1 (N. J. Higham, ACM TOMS 14, 1988, Algorithm 674; LAPACK's dlacn2)
//! from A's factors, as LAPACK's dgecon (LU), dtrcon (a triangular A itself) and dpocon (Cholesky).
//!
//! [`lacn2`] is the same algorithm as the Python `_rcond_estimate` (lib/_matlab.py), step for step: x = B(1/n),
//! est = ||x||_1; then up to 4 more steps from the sign vector (B' sgn, the largest |x_j| (the first; a NaN
//! first, as numpy's argmax), B e_j), stopping when the sign vector repeats, the estimate does not grow, or the
//! largest entry repeats (x_last == |x_j|, dlacn2's test); then Higham's extra estimate from the alternating
//! vector (-1)^i (1 + i / (n - 1)), 2 ||B alt||_1 / (3n), taken if larger. The sign of x_i is +1 when x_i >= 0,
//! else -1 (NaN: -1). The solves are column-oriented substitutions here, row dot products there: the rounding
//! differs, the decisions are the same in practice (agreement to 1e-10 relative is tested on a corpus).

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

fn asum(x: &[f64]) -> f64 {
    let mut s = 0.0;
    for v in x {
        s += v.abs();
    }
    s
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
        let t = 2.0 * asum(x) / (3.0 * n as f64);
        if t > est {
            est = t;
        }
    }
    est
}

/// rcond from an estimate of ||A^-1||_1 and ||A||_1: (1 / est) / anorm, or 0 when the estimate is not finite
/// or zero (as the Python estimate).
fn rcond_from(est: f64, anorm: f64) -> f64 {
    if !est.is_finite() || est == 0.0 {
        0.0
    } else {
        (1.0 / est) / anorm
    }
}

/// x := U^-T x (U upper, non-unit): x_i := (x_i - u_0i x_0 - ... ) / u_ii, column i of U (dtrsv 'U', 'T').
fn upper_t(u: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for i in 0..n {
        let ui = &u[i * ld..i * ld + i + 1];
        let mut t = x[i];
        for k in 0..i {
            t -= ui[k] * x[k];
        }
        x[i] = t / ui[i];
    }
}

/// x := L^-T x (L unit lower): from the bottom, x_i := x_i - l_(i+1)i x_(i+1) - ..., column i of L.
fn lower_unit_t(l: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for i in (0..n).rev() {
        let li = &l[i * ld..i * ld + n];
        let mut t = x[i];
        for k in i + 1..n {
            t -= li[k] * x[k];
        }
        x[i] = t;
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

/// x := L^-T x (L lower, non-unit): from the bottom, x_i := (x_i - l_(i+1)i x_(i+1) - ...) / l_ii.
fn lower_t(l: &[f64], ld: usize, n: usize, x: &mut [f64]) {
    for i in (0..n).rev() {
        let li = &l[i * ld..i * ld + n];
        let mut t = x[i];
        for k in i + 1..n {
            t -= li[k] * x[k];
        }
        x[i] = t / li[i];
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

    #[test]
    fn diagonal_and_triangular_estimates_are_exact_on_small_cases() {
        // diag(2, -4, 0.5): ||A||_1 = 4, ||A^-1||_1 = 2, rcond = 1/8
        let d = [2.0, 0.0, 0.0, 0.0, -4.0, 0.0, 0.0, 0.0, 0.5];
        assert_eq!(diagcon(&d, 3, 3, 4.0), 0.125);
        // upper [1 -1; 0 1]: A^-1 = [1 1; 0 1], ||A^-1||_1 = 2, ||A||_1 = 2
        let u = [1.0, 0.0, -1.0, 1.0];
        let mut w = [0.0; 4];
        assert_eq!(trcon(&u, 2, 2, true, 2.0, &mut w), 0.25);
        let l = [1.0, -1.0, 0.0, 1.0];
        assert_eq!(trcon(&l, 2, 2, false, 2.0, &mut w), 0.25);
        assert_eq!(gecon(&[], 0, 1, 0.0, &mut w), f64::INFINITY);
        assert_eq!(gecon(&[0.0], 1, 1, 0.0, &mut w), 0.0);
    }

    #[test]
    fn argmax_and_sign_follow_numpy() {
        assert_eq!(argmax_abs(&[1.0, -3.0, 3.0]), 1);
        assert_eq!(argmax_abs(&[1.0, f64::NAN, 5.0]), 1);
        assert_eq!(argmax_abs(&[f64::NAN, 5.0]), 0);
        assert_eq!((sgn(0.0), sgn(-0.0), sgn(-1e-300), sgn(f64::NAN)), (1.0, 1.0, -1.0, -1.0));
    }
}
