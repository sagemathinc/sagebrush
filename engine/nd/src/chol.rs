//! Cholesky factorization and solve (numerics-core P2b-2, design 2c8e55e8 §1): A = R'R for a symmetric A,
//! from its upper triangle (LAPACK's dpotrf / dpotrf2, upper), and X = A^-1 B from R (dpotrs).
//!
//! **The recursive Cholesky** (dpotrf2) on the n x n upper triangle, n1 = n / 2, n2 = n - n1:
//! 1. R11 := chol(A11), recursively; a non-positive pivot stops here (reported);
//! 2. A12 := R11^-T A12 ([`trsm_upper_t`]: a forward substitution with R11', by rows of R11's columns);
//! 3. A22 := A22 - A12' A12 (dsyrk's update, on the GEMM layer; it writes A22's strictly lower part too,
//!    which is never read: only the upper triangle holds R);
//! 4. R22 := chol(A22), recursively; its pivot is offset by n1.
//!
//! At or below [`POTRF_SMALL`] columns it is factored unblocked (dpotf2): for each column j, r_jj =
//! sqrt(a_jj - r_.j' r_.j) and row j to its right (a_j. - r_.j' R_..) / r_jj. Only the upper triangle is read
//! or relied on. The first pivot that is not positive (or is NaN) stops the factorization: it is stored as
//! computed, and its column is reported (dpotrf's info > 0); the caller falls back to LU.

use crate::gemm::{scratch_len, span, Kernel, Mat};
use crate::lu::{trsm_upper, Refused, TRSM_SMALL};

/// At or below this many columns, the Cholesky factorization is unblocked (dpotf2); above it, recursive.
pub const POTRF_SMALL: usize = 64;

/// The correctly rounded square root (IEEE round to nearest, ties to even), in integer arithmetic, the same
/// code on every backend (`core` has no f64 sqrt for no_std Wasm): x = m 2^e with m a 53-bit integer and e
/// even (m doubled when it isn't), then the 54-bit floor square root of m 2^54 digit by digit, rounded at its
/// last bit with the remainder as the sticky bit. Equal to the hardware sqrt (tested natively).
pub(crate) fn sqrt(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 || x == f64::INFINITY {
        return x; // (sqrt(-0) = -0)
    }
    let bits = x.to_bits();
    let (mut m, mut e) = (bits & ((1 << 52) - 1), ((bits >> 52) & 0x7ff) as i32);
    if e == 0 {
        // (subnormal: normalize the mantissa to 53 bits)
        let shift = m.leading_zeros() - 11;
        m <<= shift;
        e = 1 - shift as i32;
    } else {
        m |= 1 << 52;
    }
    // x = m 2^(e - 1075), m in [2^52, 2^53); make the exponent even
    let mut e = e - 1075;
    if e & 1 != 0 {
        m <<= 1;
        e -= 1;
    }
    // floor(sqrt(m 2^54)) in [2^53, 2^54), digit by digit; the remainder left says whether it was exact
    let mut rest = (m as u128) << 54;
    let mut root: u128 = 0;
    let mut bit: u128 = 1 << 126;
    while bit > rest {
        bit >>= 2;
    }
    while bit != 0 {
        if rest >= root + bit {
            rest -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    let mut q = (root >> 1) as u64;
    if root & 1 == 1 && (rest != 0 || q & 1 == 1) {
        q += 1;
    }
    // the root is q 2^((e - 54) / 2 + 1)
    let mut re = (e - 54) / 2 + 1;
    if q == 1 << 53 {
        q >>= 1;
        re += 1;
    }
    f64::from_bits((((re + 52 + 1023) as u64) << 52) | (q & ((1 << 52) - 1)))
}

/// Unblocked Cholesky of the n x n upper triangle (dpotf2, upper): column j's pivot a_jj - (r_.j' r_.j) (the
/// dot product summed first, k increasing, as ddot then the subtraction), its square root, then row j to the
/// right: each a_jc - (r_.j' r_.c) (dgemv 'T', alpha = -1, beta = 1), times 1 / r_jj (dscal). Returns the first
/// column whose pivot is not positive (stored as computed).
fn potf2(a: &mut [f64], lda: usize, n: usize) -> Option<usize> {
    for j in 0..n {
        // (column j and those to its right; columns left of j are not needed)
        let tail = &mut a[j * lda..];
        let mut d = 0.0;
        for &r in &tail[..j] {
            d += r * r;
        }
        let ajj = tail[j] - d;
        if !(ajj > 0.0) {
            tail[j] = ajj;
            return Some(j);
        }
        let ajj = sqrt(ajj);
        tail[j] = ajj;
        if j + 1 < n {
            let inv = 1.0 / ajj;
            let (colj, rest) = tail.split_at_mut(lda);
            let colj = &colj[..j];
            for c in 0..n - j - 1 {
                let col = &mut rest[c * lda..c * lda + j + 1];
                let mut s = 0.0;
                for (x, y) in colj.iter().zip(&col[..j]) {
                    s += x * y;
                }
                col[j] = (col[j] - s) * inv;
            }
        }
    }
    None
}

/// The recursive Cholesky of the n x n upper triangle (the module's steps 1-4). `work` holds a GEMM scratch,
/// then at least 2 * (n / 2) * (n - n / 2) more elements for A12's two copies (checked by [`potrf`]).
fn potrf_rec(kern: Kernel, a: &mut [f64], lda: usize, n: usize, work: &mut [f64]) -> Option<usize> {
    if n <= POTRF_SMALL {
        return potf2(a, lda, n);
    }
    let (n1, n2) = (n / 2, n - n / 2);
    let (left, right) = a.split_at_mut(n1 * lda);
    // 1. R11
    if let Some(k) = potrf_rec(kern, left, lda, n1, work) {
        return Some(k);
    }
    // 2. A12 := R11^-T A12 (A12: rows 0..n1 of the right columns)
    let (scratch, rest) = work.split_at_mut(scratch_len());
    trsm_upper_t(kern, left, lda, n1, right, lda, n2, rest, scratch);
    // 3. A22 := A22 - A12' A12, from A12' and a copy of A12 (A12 and A22 share columns)
    let (at, rest) = rest.split_at_mut(n2 * n1);
    let (ac, _) = rest.split_at_mut(n1 * n2);
    for c in 0..n2 {
        for k in 0..n1 {
            let v = right[k + c * lda];
            at[c + k * n2] = v;
            ac[k + c * n1] = v;
        }
    }
    let a12t = Mat::new(at, n2, n1, n2).expect("A12' copy");
    let a12 = Mat::new(ac, n1, n2, n1).expect("A12 copy");
    let ok = kern.gemm_update(&a12t, &a12, &mut right[n1..], lda, scratch);
    debug_assert!(ok);
    // 4. R22
    potrf_rec(kern, &mut right[n1..], lda, n2, work).map(|k| k + n1)
}

/// X := R^-T X for the n x n upper triangle R (non-unit diagonal; leading dimension `ldr`) and the n x r X
/// (leading dimension `ldx`): a forward substitution with R' (dtrsm, left, upper, transpose, non-unit).
/// Directly at or below [`TRSM_SMALL`] rows, as the reference dtrsm: x_i := (x_i - r_0i x_0 - r_1i x_1 - ...)
/// / r_ii, the subtractions in k order, reading column i of R; above, it recurses: X1 := R11^-T X1, then X2 :=
/// X2 - R12' X1 (on the GEMM layer, from copies), then X2 := R22^-T X2. `tmp` holds at least n * r elements.
#[allow(clippy::too_many_arguments)]
pub(crate) fn trsm_upper_t(kern: Kernel, r: &[f64], ldr: usize, n: usize, x: &mut [f64], ldx: usize, nr: usize, tmp: &mut [f64], scratch: &mut [f64]) {
    if n == 0 || nr == 0 {
        return;
    }
    if n <= TRSM_SMALL {
        for j in 0..nr {
            let col = &mut x[j * ldx..j * ldx + n];
            for i in 0..n {
                let ri = &r[i * ldr..i * ldr + i + 1];
                let mut t = col[i];
                for k in 0..i {
                    t -= ri[k] * col[k];
                }
                col[i] = t / ri[i];
            }
        }
        return;
    }
    let h = n / 2;
    trsm_upper_t(kern, r, ldr, h, x, ldx, nr, tmp, scratch);
    // X2 := X2 - R12' X1, R12 rows 0..h of columns h..n: its transpose and X1 copied
    let (rt, rest) = tmp.split_at_mut((n - h) * h);
    let (x1, rest) = rest.split_at_mut(h * nr);
    for c in 0..n - h {
        for k in 0..h {
            rt[c + k * (n - h)] = r[k + (h + c) * ldr];
        }
    }
    for j in 0..nr {
        x1[j * h..(j + 1) * h].copy_from_slice(&x[j * ldx..j * ldx + h]);
    }
    let r12t = Mat::new(rt, n - h, h, n - h).expect("R12' copy");
    let x1m = Mat::new(x1, h, nr, h).expect("X1 copy");
    let ok = kern.gemm_update(&r12t, &x1m, &mut x[h..], ldx, scratch);
    debug_assert!(ok);
    trsm_upper_t(kern, &r[h + h * ldr..], ldr, n - h, &mut x[h..], ldx, nr, rest, scratch);
}

/// The workspace [`potrf`] needs for an n x n matrix; `None` on overflow. A GEMM scratch, then n * n: at each
/// level (n1 = n / 2, n2 = n - n1) either A12's two copies, 2 n1 n2 <= n^2 / 2, or the transposed solve's
/// copies, at most (n1^2 / 4 + n1 n2 / 2) per halving of its triangle, < n1^2 / 3 + n1 n2 <= n^2 / 2 in all;
/// the levels run one after another in the same space.
pub fn potrf_work_len(n: usize) -> Option<usize> {
    n.checked_mul(n)?.checked_add(scratch_len())
}

/// The workspace [`potrs`] needs for an n x n R and n x r right-hand sides; `None` on overflow.
pub fn potrs_work_len(n: usize, r: usize) -> Option<usize> {
    n.checked_mul(n)?.checked_add(n.checked_mul(r)?.checked_mul(2)?)?.checked_add(scratch_len())
}

/// A = R'R of the n x n symmetric `a` (leading dimension `lda`) from its upper triangle, in place: R in the
/// upper triangle (the strictly lower part is not meaningful afterwards). Returns the first column whose pivot
/// is not positive (A is not positive definite; dpotrf's info > 0), or why it was refused.
pub fn potrf(kern: Kernel, a: &mut [f64], n: usize, lda: usize, work: &mut [f64]) -> Result<Option<usize>, Refused> {
    match span(n, n, lda) {
        Some(need) if a.len() >= need => {}
        _ => return Err(Refused::Layout),
    }
    match potrf_work_len(n) {
        Some(need) if work.len() >= need => {}
        _ => return Err(Refused::Work),
    }
    Ok(potrf_rec(kern, a, lda, n, work))
}

/// X = A^-1 B from [`potrf`]'s R of the n x n A: B (n x r, leading dimension `ldb`) is overwritten by X:
/// R' Y = B, then R X = Y (dpotrs).
#[allow(clippy::too_many_arguments)]
pub fn potrs(kern: Kernel, rf: &[f64], n: usize, lda: usize, b: &mut [f64], r: usize, ldb: usize, work: &mut [f64]) -> Result<(), Refused> {
    match (span(n, n, lda), span(n, r, ldb)) {
        (Some(na), Some(nb)) if rf.len() >= na && b.len() >= nb => {}
        _ => return Err(Refused::Layout),
    }
    match potrs_work_len(n, r) {
        Some(need) if work.len() >= need => {}
        _ => return Err(Refused::Work),
    }
    if n == 0 || r == 0 {
        return Ok(());
    }
    let (scratch, tmp) = work.split_at_mut(scratch_len());
    trsm_upper_t(kern, rf, lda, n, b, ldb, r, tmp, scratch);
    trsm_upper(kern, rf, lda, n, b, ldb, r, tmp, scratch);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    extern crate std;
    use super::*;
    use crate::gemm::tests::{fnv, seeded};
    use std::{vec, vec::Vec};

    const U: f64 = f64::EPSILON / 2.0;

    /// A seeded n x n symmetric positive definite matrix: M'M + n I (M seeded).
    pub(crate) fn spd(n: usize, seed: u32) -> Vec<f64> {
        let m = seeded(n * n, &mut (seed + 1));
        let mut a = vec![0.0; n * n];
        for j in 0..n {
            for i in 0..n {
                let mut s = 0.0;
                for k in 0..n {
                    s += m[k + i * n] * m[k + j * n];
                }
                a[i + j * n] = s + if i == j { n as f64 } else { 0.0 };
            }
        }
        a
    }

    pub(crate) fn kernels() -> Vec<Kernel> {
        let mut k = vec![Kernel::Scalar, Kernel::ScalarFma];
        #[cfg(target_arch = "x86_64")]
        k.extend(crate::micro::Avx2Fma::detect().map(Kernel::Avx2Fma));
        #[cfg(target_arch = "aarch64")]
        k.push(Kernel::Neon);
        k
    }

    /// ||A - R'R||_inf / (n ||A||_inf), from the upper triangle of `r`.
    fn chol_residual(a: &[f64], r: &[f64], n: usize, lda: usize) -> f64 {
        let mut worst = 0.0f64;
        let mut an = 0.0f64;
        for i in 0..n {
            let mut row = 0.0;
            let mut arow = 0.0;
            for j in 0..n {
                let mut s = 0.0;
                for k in 0..=i.min(j) {
                    s += r[k + i * lda] * r[k + j * lda];
                }
                row += (a[i + j * n] - s).abs();
                arow += a[i + j * n].abs();
            }
            worst = worst.max(row);
            an = an.max(arow);
        }
        worst / (n as f64 * an)
    }

    fn factor(k: Kernel, a: &[f64], n: usize, lda: usize) -> (Vec<f64>, Option<usize>) {
        let mut f = vec![f64::NAN; lda * n.max(1)];
        for j in 0..n {
            f[j * lda..j * lda + n].copy_from_slice(&a[j * n..(j + 1) * n]);
        }
        let mut work = vec![0.0; potrf_work_len(n).unwrap()];
        let info = potrf(k, &mut f, n, lda, &mut work).unwrap();
        (f, info)
    }

    /// The integer square root equals the hardware one, bit for bit: edge cases, every binade's ends,
    /// subnormals, and a million seeded bit patterns.
    #[test]
    fn the_square_root_is_the_correctly_rounded_one() {
        let same = |x: f64| {
            let (a, b) = (sqrt(x), x.sqrt());
            assert!(a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()), "sqrt({x:e}) = {a:e}, hardware {b:e}");
        };
        for x in [0.0, -0.0, 1.0, 2.0, 3.0, 4.0, 0.25, f64::MIN_POSITIVE, f64::MAX, f64::EPSILON, 5e-324, 1e-310, -1.0, -5e-324, f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            same(x);
        }
        for e in 0..2047u64 {
            for m in [0u64, 1, (1 << 52) - 1, 1 << 51, 0x5555_5555_5555_5] {
                same(f64::from_bits((e << 52) | (m & ((1 << 52) - 1))));
            }
        }
        let mut s = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..1_000_000 {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            same(f64::from_bits(s & !(1 << 63)));
        }
    }

    #[test]
    fn factors_within_the_oracle_every_kernel_and_size() {
        for k in kernels() {
            for n in [1usize, 2, 3, 15, 16, 17, 63, 64, 65, 97, 130, 256] {
                let a = spd(n, n as u32);
                for lda in [n, n + 3] {
                    let (f, info) = factor(k, &a, n, lda);
                    assert_eq!(info, None, "{} n={n}", k.name());
                    assert!(chol_residual(&a, &f, n, lda) <= 10.0 * U, "{} n={n} lda={lda}", k.name());
                    // (only the upper triangle is R: the padding rows below n are never touched)
                    for j in 0..n {
                        assert!(f[j * lda + n..(j + 1) * lda].iter().all(|v| v.is_nan()), "padding written");
                    }
                }
            }
        }
    }

    /// The first non-positive pivot is reported (dpotrf's info), unblocked and through the recursion, and the
    /// strictly lower part of an unblocked factorization is never read: garbage there changes nothing.
    #[test]
    fn the_first_non_positive_pivot_is_reported() {
        // [[1, 2], [2, 1]]: r_11 = 1, then 1 - 4 = -3 at column 1
        let (f, info) = factor(Kernel::Scalar, &[1.0, 2.0, 2.0, 1.0], 2, 2);
        assert_eq!(info, Some(1));
        assert_eq!(f[3], -3.0, "the failed pivot is stored as computed");
        // a zero pivot is not positive either, nor a NaN one
        assert_eq!(factor(Kernel::Scalar, &[1.0, 1.0, 1.0, 1.0], 2, 2).1, Some(1));
        assert_eq!(factor(Kernel::Scalar, &[0.0], 1, 1).1, Some(0));
        assert_eq!(factor(Kernel::Scalar, &[f64::NAN], 1, 1).1, Some(0));
        // an SPD matrix minus a multiple of I past its smallest eigenvalue, at sizes through the recursion: the
        // reported column is where the unblocked factorization stops too
        for n in [10usize, 100, 200] {
            let mut a = spd(n, 3);
            for i in 0..n {
                a[i + i * n] -= 2.0 * n as f64 + 1e3;
            }
            a[0] = 1e6; // (column 0 still positive: the failure comes later)
            let (_, info) = factor(Kernel::Scalar, &a, n, n);
            let mut g = a.clone();
            let unblocked = potf2(&mut g, n, n);
            assert!(info.is_some() && info == unblocked, "n={n}: {info:?} vs {unblocked:?}");
        }
        // garbage below the diagonal is never read
        let n = 40;
        let a = spd(n, 5);
        let mut g = a.clone();
        for j in 0..n {
            for i in j + 1..n {
                g[i + j * n] = f64::NAN;
            }
        }
        let (f1, _) = factor(Kernel::Scalar, &a, n, n);
        let (f2, _) = factor(Kernel::Scalar, &g, n, n);
        for j in 0..n {
            for i in 0..=j {
                assert_eq!(f1[i + j * n].to_bits(), f2[i + j * n].to_bits());
            }
        }
    }

    /// The Cholesky threshold, pinned at its value: at 64 the factorization is dpotf2's exactly; at 65 it
    /// recurses (GEMM updates: other bits, still within the oracle).
    #[test]
    fn the_cholesky_threshold_is_where_the_recursion_starts() {
        assert_eq!(POTRF_SMALL, 64);
        for n in [63usize, 64, 65] {
            let a = spd(n, 7);
            let (f, _) = factor(Kernel::Scalar, &a, n, n);
            let mut g = a.clone();
            potf2(&mut g, n, n);
            let same = (0..n).all(|j| (0..=j).all(|i| f[i + j * n].to_bits() == g[i + j * n].to_bits()));
            assert_eq!(same, n <= 64, "n={n}");
        }
    }

    /// The transposed triangular solve: plain forward substitution with R' (reference dtrsm order) at and below
    /// TRSM_SMALL, and within the oracle above it, with padded leading dimensions.
    #[test]
    fn the_transposed_solve() {
        for n in [1usize, 5, 64, 65, 150] {
            let a = spd(n, 11);
            let (r, _) = factor(Kernel::Scalar, &a, n, n);
            for nr in [1usize, 3] {
                let ldx = n + 2;
                let x0 = seeded(ldx * nr, &mut 12);
                let mut x = x0.clone();
                let mut tmp = vec![0.0; n * n + n * nr];
                let mut scratch = vec![0.0; scratch_len()];
                trsm_upper_t(Kernel::Scalar, &r, n, n, &mut x, ldx, nr, &mut tmp, &mut scratch);
                let mut y = x0.clone();
                for j in 0..nr {
                    for i in 0..n {
                        let mut t = y[i + j * ldx];
                        for k in 0..i {
                            t -= r[k + i * n] * y[k + j * ldx];
                        }
                        y[i + j * ldx] = t / r[i + i * n];
                    }
                }
                let same = x.iter().zip(&y).all(|(p, q)| p.to_bits() == q.to_bits());
                assert_eq!(same, n <= TRSM_SMALL, "n={n} nr={nr}");
                // the padding is untouched; the solution agrees within u-scaled bounds
                for j in 0..nr {
                    assert_eq!(&x[j * ldx + n..(j + 1) * ldx], &x0[j * ldx + n..(j + 1) * ldx]);
                    for i in 0..n {
                        let (p, q) = (x[i + j * ldx], y[i + j * ldx]);
                        assert!((p - q).abs() <= 1e3 * n as f64 * U * q.abs().max(1.0), "n={n}: {p} vs {q}");
                    }
                }
            }
        }
    }

    #[test]
    fn solves_within_the_oracle() {
        for k in kernels() {
            for (n, r) in [(1usize, 1usize), (16, 3), (65, 1), (100, 17), (200, 2)] {
                let a = spd(n, 21);
                let (f, info) = factor(k, &a, n, n);
                assert_eq!(info, None);
                let b = seeded(n * r, &mut 22);
                let mut x = b.clone();
                let mut work = vec![0.0; potrs_work_len(n, r).unwrap()];
                potrs(k, &f, n, n, &mut x, r, n, &mut work).unwrap();
                for j in 0..r {
                    let xj = &x[j * n..(j + 1) * n];
                    let bj = &b[j * n..(j + 1) * n];
                    let an = (0..n).map(|i| (0..n).map(|p| a[i + p * n].abs()).sum::<f64>()).fold(0.0, f64::max);
                    let res = (0..n).map(|i| (bj[i] - (0..n).map(|p| a[i + p * n] * xj[p]).sum::<f64>()).abs()).fold(0.0, f64::max);
                    let xn = xj.iter().fold(0.0f64, |m, v| m.max(v.abs()));
                    let bn = bj.iter().fold(0.0f64, |m, v| m.max(v.abs()));
                    assert!(res / (an * xn + bn) <= 10.0 * n as f64 * U, "{} n={n}", k.name());
                }
            }
        }
    }

    #[test]
    fn refusals() {
        let n = 5;
        let mut a = spd(n, 1);
        let mut work = vec![0.0; potrf_work_len(n).unwrap()];
        assert_eq!(potrf(Kernel::Scalar, &mut a[..n * n - 1], n, n, &mut work), Err(Refused::Layout));
        assert_eq!(potrf(Kernel::Scalar, &mut a, n, n - 1, &mut work), Err(Refused::Layout));
        let short = potrf_work_len(n).unwrap() - 1;
        assert_eq!(potrf(Kernel::Scalar, &mut a, n, n, &mut work[..short]), Err(Refused::Work));
        assert!(potrf_work_len(usize::MAX).is_none() && potrs_work_len(usize::MAX, 1).is_none() && potrs_work_len(4, usize::MAX).is_none());
        let mut b = vec![1.0; n];
        let mut w2 = vec![0.0; potrs_work_len(n, 1).unwrap()];
        assert_eq!(potrs(Kernel::Scalar, &a, n, n, &mut b[..n - 1], 1, n, &mut w2), Err(Refused::Layout));
        let short = w2.len() - 1;
        assert_eq!(potrs(Kernel::Scalar, &a, n, n, &mut b, 1, n, &mut w2[..short]), Err(Refused::Work));
        assert!(b.iter().all(|&v| v == 1.0));
        // empty systems
        assert_eq!(potrf(Kernel::Scalar, &mut [], 0, 1, &mut work), Ok(None));
        assert_eq!(potrs(Kernel::Scalar, &[], 0, 1, &mut [], 0, 1, &mut w2), Ok(()));
    }

    /// The per-family bit pins of the Cholesky solve: one seeded 120 x 120 SPD system, 3 right-hand sides.
    pub(crate) const CHOL_FNV: u64 = 0x010a6d67d546e60b;
    pub(crate) const CHOL_FNV_FMA: u64 = 0xc7fde5aeda90a0c2;

    #[test]
    fn cholesky_bits_per_family() {
        let (n, r) = (120, 3);
        let a = spd(n, 2029);
        let b = seeded(n * r, &mut 2030);
        let run = |k: Kernel| {
            let (f, _) = factor(k, &a, n, n);
            let mut x = b.clone();
            let mut work = vec![0.0; potrs_work_len(n, r).unwrap()];
            potrs(k, &f, n, n, &mut x, r, n, &mut work).unwrap();
            fnv(&x)
        };
        assert_eq!(run(Kernel::Scalar), CHOL_FNV, "no-FMA family: {:#018x}", run(Kernel::Scalar));
        assert_eq!(run(Kernel::ScalarFma), CHOL_FNV_FMA, "FMA family: {:#018x}", run(Kernel::ScalarFma));
        #[cfg(target_arch = "x86_64")]
        if let Some(k) = crate::micro::Avx2Fma::detect() {
            assert_eq!(run(Kernel::Avx2Fma(k)), CHOL_FNV_FMA, "AVX2+FMA");
        }
        #[cfg(target_arch = "aarch64")]
        assert_eq!(run(Kernel::Neon), CHOL_FNV_FMA, "NEON");
    }
}
