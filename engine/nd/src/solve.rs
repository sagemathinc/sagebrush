//! `nd::solve`: X = A \ B for a square real A, one call (numerics-core P2b-2, design 2c8e55e8 §2), in one of two
//! modes ([`Mode`], @sagebrush's ruling: fidelity first): **gesv** is LAPACK's dgesv as NumPy's `solve` calls
//! it: LU with partial pivoting whatever A is, no condition estimate; **MATLAB** is mldivide's: the steps below.
//!
//! 1. **One pass over A** ([`structure`]): that every entry is finite, the 1-norm, and the structure:
//!    diagonal, upper or lower triangular, or symmetric with a positive diagonal (a Cholesky candidate).
//!    The first asymmetry disables only the Cholesky candidate; the other checks run to the end.
//! 2. **Dispatch** (MATLAB's order): diagonal: each row of B divided by its diagonal element; triangular: the
//!    triangular solve; symmetric with a positive diagonal: Cholesky ([`crate::chol`]), and if it fails, LU
//!    on the untouched A; otherwise LU ([`crate::lu`]).
//! 3. **Report**: the status (solved, nearly singular: 0 < rcond < eps, singular: an exactly zero diagonal or
//!    pivot, with X holding what division by it gives; or not computed: an Inf or NaN in A or B), rcond from
//!    the factors ([`crate::cond`]) and the structure taken.

use crate::chol::{potrf, potrf_work_len, potrs, potrs_work_len};
use crate::cond::{asum, cond_work_len, diagcon, gecon, lower_col, pocon, trcon};
use crate::gemm::{scratch_len, span, Kernel};
use crate::lu::{getrf, getrf_work_len, getrs, getrs_work_len, nonfinite, trsm_upper, Refused};

/// Which solve [`solve`] does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// LAPACK's dgesv (NumPy's `solve`): the finiteness check, then LU with partial pivoting whatever A's
    /// structure ([`crate::lu::solve`], bit for bit); no condition estimate (rcond NaN), structure General
    Gesv,
    /// MATLAB's mldivide: the structure pass, the dispatch and rcond from the factors
    Matlab,
}

/// The structure [`solve`] found and solved by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Structure {
    /// LU with partial pivoting
    General,
    /// division by the diagonal
    Diagonal,
    /// upper triangular: back substitution
    Upper,
    /// lower triangular: forward substitution
    Lower,
    /// symmetric with a positive diagonal, positive definite: Cholesky
    Spd,
    /// symmetric with a positive diagonal but not positive definite: Cholesky failed, then LU
    SpdFallback,
}

/// What [`solve`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// solved; rcond is 0 or at least eps
    Solved,
    /// solved, but 0 < rcond < eps (MATLAB's "close to singular or badly scaled" warning)
    NearlySingular,
    /// an exactly zero diagonal element (diagonal, triangular) or LU pivot, the first in this column: X holds
    /// the Inf and NaN division by it gives (MATLAB's "singular to working precision"); rcond is 0
    Singular(usize),
    /// A or B has an Inf or NaN: nothing computed (rcond NaN)
    NonFinite,
}

/// [`solve`]'s result.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Report {
    pub status: Status,
    /// the 1-norm reciprocal condition estimate (MATLAB mode; Inf for n = 0); NaN when not estimated (gesv
    /// mode, or nothing computed)
    pub rcond: f64,
    pub structure: Structure,
}

/// What one pass over A found ([`structure`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub finite: bool,
    /// ||A||_1, the largest column sum of |a|
    pub anorm: f64,
    /// no nonzero below the diagonal
    pub upper: bool,
    /// no nonzero above the diagonal
    pub lower: bool,
    /// symmetric with every diagonal element positive
    pub spd_candidate: bool,
}

/// The structure pass over the n x n A, column by column: the 1-norm (each column's |a| sum in [`asum`]'s order),
/// finiteness (branch-free: the sum of a - a is 0 exactly when every a is finite), the triangles' zeros (-0
/// counts as zero; each check stops once it has failed), and a positive diagonal; then, only if the diagonal is
/// positive, symmetry (a_ij == a_ji) by 16 x 16 tiles, stopping at the first difference. The first asymmetry
/// thus disables only the Cholesky candidate: every other check has already run to the end.
pub fn structure(a: &[f64], n: usize, lda: usize) -> Shape {
    let mut sh = Shape { finite: true, anorm: 0.0, upper: true, lower: true, spd_candidate: true };
    let mut bad = 0.0;
    for j in 0..n {
        let col = &a[j * lda..j * lda + n];
        let s = asum(col);
        bad += nonfinite(col);
        if s > sh.anorm {
            sh.anorm = s;
        }
        if sh.upper && col[j + 1..].iter().any(|&v| v != 0.0) {
            sh.upper = false;
        }
        if sh.lower && col[..j].iter().any(|&v| v != 0.0) {
            sh.lower = false;
        }
        if !(col[j] > 0.0) {
            sh.spd_candidate = false;
        }
    }
    sh.finite = bad == 0.0;
    sh.spd_candidate = sh.spd_candidate && symmetric(a, n, lda);
    sh
}

/// a_ij == a_ji for every i < j, by 16 x 16 tiles (column j's rows against row j's columns within a tile, both
/// cache-resident), stopping at the first difference.
fn symmetric(a: &[f64], n: usize, lda: usize) -> bool {
    const T: usize = 16;
    let mut jb = 0;
    while jb < n {
        let je = (jb + T).min(n);
        let mut ib = 0;
        while ib <= jb {
            let ie = (ib + T).min(n);
            for j in jb..je {
                for i in ib..ie.min(j) {
                    if a[i + j * lda] != a[j + i * lda] {
                        return false;
                    }
                }
            }
            ib += T;
        }
        jb = je;
    }
    true
}

/// MATLAB's warning threshold for rcond (eps).
const EPS: f64 = f64::EPSILON;

/// The workspace [`solve`] needs for an n x n A and n x r B in `mode`: gesv's is [`crate::lu::solve_work_len`];
/// MATLAB's is n * n for the Cholesky factor (A stays untouched for the LU fallback), then the most any path
/// needs; `None` on overflow.
pub fn solve_work_len(mode: Mode, n: usize, r: usize) -> Option<usize> {
    if mode == Mode::Gesv {
        return crate::lu::solve_work_len(n, r);
    }
    let inner = [getrf_work_len(n, n)?, getrs_work_len(n, r)?, potrf_work_len(n)?, potrs_work_len(n, r)?, cond_work_len(n)?];
    n.checked_mul(n)?.checked_add(inner.into_iter().max()?)
}

/// The first zero on A's diagonal.
fn zero_diagonal(a: &[f64], n: usize, lda: usize) -> Option<usize> {
    (0..n).find(|&i| a[i + i * lda] == 0.0)
}

/// X = A \ B for the n x n A (leading dimension `lda`) and the n x r B (overwritten by X), in `mode`, as the
/// module describes. A is overwritten by its LU factors on the LU paths and left as it was on the others;
/// `ipiv` holds n pivots on the LU paths; `work` holds [`solve_work_len`] elements for the mode.
#[allow(clippy::too_many_arguments)]
pub fn solve(kern: Kernel, mode: Mode, a: &mut [f64], n: usize, lda: usize, b: &mut [f64], r: usize, ldb: usize, ipiv: &mut [usize], work: &mut [f64]) -> Result<Report, Refused> {
    if mode == Mode::Gesv {
        let status = match crate::lu::solve(kern, a, n, lda, b, r, ldb, ipiv, work)? {
            crate::lu::Status::Solved => Status::Solved,
            crate::lu::Status::Singular(k) => Status::Singular(k),
            crate::lu::Status::NonFinite => Status::NonFinite,
        };
        return Ok(Report { status, rcond: f64::NAN, structure: Structure::General });
    }
    match (span(n, n, lda), span(n, r, ldb)) {
        (Some(na), Some(nb)) if a.len() >= na && b.len() >= nb => {}
        _ => return Err(Refused::Layout),
    }
    if ipiv.len() < n {
        return Err(Refused::Pivots);
    }
    match solve_work_len(mode, n, r) {
        Some(need) if work.len() >= need => {}
        _ => return Err(Refused::Work),
    }
    if n == 0 {
        return Ok(Report { status: Status::Solved, rcond: f64::INFINITY, structure: Structure::General });
    }
    let sh = structure(a, n, lda);
    if !sh.finite || (0..r).map(|j| nonfinite(&b[j * ldb..j * ldb + n])).sum::<f64>() != 0.0 {
        return Ok(Report { status: Status::NonFinite, rcond: f64::NAN, structure: Structure::General });
    }
    let (wa, rest) = work.split_at_mut(n * n);
    let (structure, singular, rcond) = if sh.upper && sh.lower {
        // diagonal: each row divided by its element (0 / 0 is NaN here, as in MATLAB)
        for j in 0..r {
            for i in 0..n {
                b[i + j * ldb] /= a[i + i * lda];
            }
        }
        let z = zero_diagonal(a, n, lda);
        (Structure::Diagonal, z, if z.is_some() { 0.0 } else { diagcon(a, n, lda, sh.anorm) })
    } else if sh.upper || sh.lower {
        let z = zero_diagonal(a, n, lda);
        if sh.upper {
            let (scratch, tmp) = rest.split_at_mut(scratch_len());
            trsm_upper(kern, a, lda, n, b, ldb, r, tmp, scratch);
        } else {
            for j in 0..r {
                lower_col(a, lda, n, &mut b[j * ldb..j * ldb + n]);
            }
        }
        let rc = if z.is_some() { 0.0 } else { trcon(a, n, lda, sh.upper, sh.anorm, rest) };
        (if sh.upper { Structure::Upper } else { Structure::Lower }, z, rc)
    } else {
        let mut chol = false;
        if sh.spd_candidate {
            for j in 0..n {
                wa[j * n..(j + 1) * n].copy_from_slice(&a[j * lda..j * lda + n]);
            }
            if potrf(kern, wa, n, n, rest)?.is_none() {
                potrs(kern, wa, n, n, b, r, ldb, rest)?;
                chol = true;
            }
        }
        if chol {
            (Structure::Spd, None, pocon(wa, n, n, sh.anorm, rest))
        } else {
            let info = getrf(kern, a, n, n, lda, ipiv, rest)?;
            getrs(kern, a, n, lda, ipiv, b, r, ldb, rest)?;
            let rc = if info.is_some() { 0.0 } else { gecon(a, n, lda, sh.anorm, rest) };
            (if sh.spd_candidate { Structure::SpdFallback } else { Structure::General }, info, rc)
        }
    };
    let status = match singular {
        Some(k) => Status::Singular(k),
        None if rcond > 0.0 && rcond < EPS => Status::NearlySingular,
        None => Status::Solved,
    };
    Ok(Report { status, rcond, structure })
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::chol::tests::spd;
    use crate::gemm::tests::{fnv, seeded};
    use std::{vec, vec::Vec};

    const U: f64 = f64::EPSILON / 2.0;

    fn kernels() -> Vec<Kernel> {
        crate::chol::tests::kernels()
    }

    /// solve with fresh buffers; returns (X, report, A after)
    fn run(k: Kernel, a: &[f64], b: &[f64], n: usize, r: usize) -> (Vec<f64>, Report, Vec<f64>) {
        let mut a2 = a.to_vec();
        let mut x = b.to_vec();
        let mut ipiv = vec![0; n];
        let mut work = vec![0.0; solve_work_len(Mode::Matlab, n, r).unwrap()];
        let rep = solve(k, Mode::Matlab, &mut a2, n, n.max(1), &mut x, r, n.max(1), &mut ipiv, &mut work).unwrap();
        (x, rep, a2)
    }

    fn eta(a: &[f64], x: &[f64], b: &[f64], n: usize) -> f64 {
        let an = (0..n).map(|i| (0..n).map(|p| a[i + p * n].abs()).sum::<f64>()).fold(0.0, f64::max);
        let res = (0..n).map(|i| (b[i] - (0..n).map(|p| a[i + p * n] * x[p]).sum::<f64>()).abs()).fold(0.0, f64::max);
        let xn = x[..n].iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let bn = b[..n].iter().fold(0.0f64, |m, v| m.max(v.abs()));
        res / (an * xn + bn)
    }

    fn upper_of(a: &[f64], n: usize) -> Vec<f64> {
        let mut u = a.to_vec();
        for j in 0..n {
            for i in j + 1..n {
                u[i + j * n] = 0.0;
            }
            u[j + j * n] += 4.0;
        }
        u
    }

    fn transpose(a: &[f64], n: usize) -> Vec<f64> {
        (0..n * n).map(|k| a[k / n + (k % n) * n]).collect()
    }

    /// Every structure is taken by its path and solves within the oracle, for every kernel and through each
    /// path's recursion; the structure and status reported.
    #[test]
    fn each_structure_takes_its_path_within_the_oracle() {
        for k in kernels() {
            for n in [1usize, 2, 17, 65, 130] {
                let g = seeded(n * n, &mut (n as u32 + 100));
                let b = seeded(n * 3, &mut 7);
                let up = upper_of(&g, n);
                let mut dg = vec![0.0; n * n];
                for i in 0..n {
                    dg[i + i * n] = 1.0 + i as f64;
                }
                let cases: Vec<(Vec<f64>, Structure)> = vec![
                    (dg, Structure::Diagonal),
                    (up.clone(), if n == 1 { Structure::Diagonal } else { Structure::Upper }),
                    (transpose(&up, n), if n == 1 { Structure::Diagonal } else { Structure::Lower }),
                    (spd(n, 9), if n == 1 { Structure::Diagonal } else { Structure::Spd }),
                    (g.clone(), if n == 1 { Structure::Diagonal } else { Structure::General }),
                ];
                for (a, want) in cases {
                    let (x, rep, _) = run(k, &a, &b, n, 3);
                    assert_eq!(rep.structure, want, "{} n={n}", k.name());
                    assert!(matches!(rep.status, Status::Solved | Status::NearlySingular), "{} n={n} {want:?}: {rep:?}", k.name());
                    for j in 0..3 {
                        let e = eta(&a, &x[j * n..(j + 1) * n], &b[j * n..(j + 1) * n], n);
                        assert!(e <= 10.0 * n as f64 * U, "{} n={n} {want:?}: eta {e:e}", k.name());
                    }
                    assert!(rep.rcond > 0.0 && rep.rcond <= 1.0, "{want:?}: rcond {}", rep.rcond);
                }
            }
        }
    }

    /// Symmetric with a positive diagonal but indefinite: Cholesky fails and LU on the untouched A solves it.
    #[test]
    fn an_indefinite_candidate_falls_back_to_lu() {
        for n in [2usize, 40, 150] {
            // (diagonal 1/2, off-diagonal 1 + 0.1 s_ij symmetric: eigenvalues near -1/2 and n - 1/2: indefinite)
            let s = seeded(n * n, &mut 13);
            let mut a = vec![0.0; n * n];
            for j in 0..n {
                for i in 0..n {
                    a[i + j * n] = if i == j { 0.5 } else { 1.0 + 0.1 * s[i.min(j) + i.max(j) * n] };
                }
            }
            let b = seeded(n, &mut 14);
            let (x, rep, _) = run(Kernel::Scalar, &a, &b, n, 1);
            assert_eq!(rep.structure, Structure::SpdFallback, "n={n}");
            assert!(eta(&a, &x, &b, n) <= 10.0 * n as f64 * U);
            // the same as LU alone, bit for bit (the fallback starts from A as it was)
            let mut a2 = a.clone();
            let mut y = b.clone();
            let mut ipiv = vec![0; n];
            let mut work = vec![0.0; crate::lu::solve_work_len(n, 1).unwrap()];
            crate::lu::solve(Kernel::Scalar, &mut a2, n, n, &mut y, 1, n, &mut ipiv, &mut work).unwrap();
            assert!(x.iter().zip(&y).all(|(p, q)| p.to_bits() == q.to_bits()));
        }
    }

    /// Near misses of each structure take the next path (grader: structure near-misses).
    #[test]
    fn structure_near_misses() {
        let n = 6;
        let g = seeded(n * n, &mut 31);
        let up = upper_of(&g, n);
        // one tiny entry below the diagonal, at the last row: not upper, not lower: general
        let mut a = up.clone();
        a[(n - 1) + 0 * n] = 1e-300;
        assert_eq!(structure(&a, n, n).upper, false);
        assert_eq!(run(Kernel::Scalar, &a, &g[..n], n, 1).1.structure, Structure::General);
        // -0 below the diagonal is a zero: still upper
        let mut a = up.clone();
        a[(n - 1) + 0 * n] = -0.0;
        assert_eq!(run(Kernel::Scalar, &a, &g[..n], n, 1).1.structure, Structure::Upper);
        // diagonal except one entry above: upper; -0 off the diagonal: still diagonal
        let mut d = vec![0.0; n * n];
        for i in 0..n {
            d[i + i * n] = 2.0;
        }
        d[0 + (n - 1) * n] = -0.0;
        assert_eq!(run(Kernel::Scalar, &d, &g[..n], n, 1).1.structure, Structure::Diagonal);
        d[0 + (n - 1) * n] = 1e-300;
        assert_eq!(run(Kernel::Scalar, &d, &g[..n], n, 1).1.structure, Structure::Upper);
        // a lower triangle with one negative entry above the diagonal: not lower (nor upper): general
        let mut l = transpose(&up, n);
        l[1 + (n - 1) * n] = -0.25;
        assert_eq!(run(Kernel::Scalar, &l, &g[..n], n, 1).1.structure, Structure::General);
        // symmetric except the last pair: not a Cholesky candidate
        let mut s = spd(n, 32);
        s[(n - 2) + (n - 1) * n] += 1e-12;
        assert!(!structure(&s, n, n).spd_candidate);
        assert_eq!(run(Kernel::Scalar, &s, &g[..n], n, 1).1.structure, Structure::General);
        // symmetric with one non-positive diagonal entry (the last; or a -0): not a candidate
        let mut s = spd(n, 33);
        s[(n - 1) + (n - 1) * n] = -1.0;
        assert_eq!(run(Kernel::Scalar, &s, &g[..n], n, 1).1.structure, Structure::General);
        s[(n - 1) + (n - 1) * n] = -0.0;
        assert!(!structure(&s, n, n).spd_candidate);
        // the first asymmetry stops only the symmetry check: an Inf after it is still found, the norm still
        // counts every column, and a nonzero below the diagonal after it is still seen
        let mut t = up.clone();
        t[(n - 1) + (n - 1) * n] = f64::INFINITY;
        assert!(!structure(&t, n, n).finite);
        let mut t = up.clone();
        t[n - 1] = 0.5; // (row n-1, column 0: after the asymmetry at (0, 1))
        let sh = structure(&t, n, n);
        assert!(!sh.upper && !sh.lower && !sh.spd_candidate);
        let want = (0..n).map(|j| (0..n).map(|i| t[i + j * n].abs()).sum::<f64>()).fold(0.0, f64::max);
        assert_eq!(sh.anorm, want);
    }

    /// Singular structures: X has division's Inf and NaN, the first zero is reported, rcond is 0.
    #[test]
    fn singular_structures() {
        // diagonal: [1 0; 0 0] \ [1; 1] is [1; Inf]; \ [1; 0] is [1; NaN] (MATLAB's mldivide page)
        let a = [1.0, 0.0, 0.0, 0.0];
        let (x, rep, _) = run(Kernel::Scalar, &a, &[1.0, 1.0], 2, 1);
        assert_eq!((x[0], x[1], rep.status, rep.rcond, rep.structure), (1.0, f64::INFINITY, Status::Singular(1), 0.0, Structure::Diagonal));
        let (x, _, _) = run(Kernel::Scalar, &a, &[1.0, 0.0], 2, 1);
        assert!(x[0] == 1.0 && x[1].is_nan());
        // upper with a zero diagonal: Singular at its first zero, rcond 0
        let u = [1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 3.0, 4.0, 0.0];
        let (_, rep, _) = run(Kernel::Scalar, &u, &[1.0, 1.0, 1.0], 3, 1);
        assert_eq!((rep.status, rep.rcond, rep.structure), (Status::Singular(1), 0.0, Structure::Upper));
        let (_, rep, _) = run(Kernel::Scalar, &transpose(&u, 3), &[1.0, 1.0, 1.0], 3, 1);
        assert_eq!((rep.status, rep.structure), (Status::Singular(1), Structure::Lower));
        // general with a zero pivot
        // (rows (1 2 3), (2 4 6), (0 1 5): the second is twice the first)
        let g = [1.0, 2.0, 0.0, 2.0, 4.0, 1.0, 3.0, 6.0, 5.0];
        let (_, rep, _) = run(Kernel::Scalar, &g, &[1.0, 1.0, 1.0], 3, 1);
        assert!(matches!(rep.status, Status::Singular(_)) && rep.rcond == 0.0 && rep.structure == Structure::General, "{rep:?}");
    }

    /// The nearly-singular decision on each path, flipping across a constructed pair: rcond = d / 3-ish just
    /// below and above eps (general: [1 1; 1/2 1/2 + d]; upper: [1 1; 0 d]; diagonal: diag(1, d)).
    #[test]
    fn nearly_singular_on_each_path() {
        let eps = f64::EPSILON;
        for (scale, below) in [(0.9, true), (1.1, false)] {
            let d = 3.0 * eps * scale;
            let (_, rep, _) = run(Kernel::Scalar, &[1.0, 0.5, 1.0, 0.5 + d], &[1.0, 1.0], 2, 1);
            assert_eq!((rep.structure, rep.status == Status::NearlySingular), (Structure::General, below), "{rep:?}");
            let d = 2.0 * eps * scale; // (upper [1 1; 0 d]: ||A||_1 = 1 + d, ||A^-1||_1 = 2 / d)
            let (_, rep, _) = run(Kernel::Scalar, &[1.0, 0.0, 1.0, d], &[1.0, 1.0], 2, 1);
            assert_eq!((rep.structure, rep.status == Status::NearlySingular), (Structure::Upper, below), "{rep:?}");
            let d = eps * scale;
            let (_, rep, _) = run(Kernel::Scalar, &[1.0, 0.0, 0.0, d], &[1.0, 1.0], 2, 1);
            assert_eq!((rep.structure, rep.status == Status::NearlySingular), (Structure::Diagonal, below), "{rep:?}");
            assert!((rep.rcond - d).abs() <= 2.0 * eps * d, "diagonal rcond is (1 / max |1/d_i|) / max |d_i|: {rep:?}");
        }
    }

    /// An estimate that overflows (A graded by 10^+-150 on both sides): rcond is 0 and the solve is Solved,
    /// not NearlySingular (the Python warning needs 0 < rcond < eps).
    #[test]
    fn an_overflowing_estimate_gives_rcond_zero_and_solved() {
        let n = 8;
        let g = seeded(n * n, &mut 51);
        let d: Vec<f64> = (0..n).map(|i| 10f64.powf(-150.0 + 300.0 * i as f64 / (n - 1) as f64)).collect();
        let a: Vec<f64> = (0..n * n).map(|k| d[k % n] * g[k] * d[k / n]).collect();
        let (_, rep, _) = run(Kernel::Scalar, &a, &g[..n], n, 1);
        assert_eq!((rep.structure, rep.status, rep.rcond), (Structure::General, Status::Solved, 0.0), "{rep:?}");
    }

    /// rcond exactly eps is not "nearly singular" (0 < rcond < eps, strictly; grader G2): diag(1, eps) has
    /// ||A^-1||_1 = 1/eps = 2^52 exactly, so rcond = 2^-52 = eps exactly.
    #[test]
    fn rcond_exactly_eps_is_solved() {
        let (_, rep, _) = run(Kernel::Scalar, &[1.0, 0.0, 0.0, f64::EPSILON], &[1.0, 1.0], 2, 1);
        assert_eq!((rep.structure, rep.status, rep.rcond), (Structure::Diagonal, Status::Solved, f64::EPSILON), "{rep:?}");
    }

    #[test]
    fn empty_nonfinite_and_refused() {
        let mut work = vec![0.0; solve_work_len(Mode::Matlab, 4, 2).unwrap()];
        let rep = solve(Kernel::Scalar, Mode::Matlab, &mut [], 0, 1, &mut [], 0, 1, &mut [], &mut work).unwrap();
        assert_eq!((rep.status, rep.rcond), (Status::Solved, f64::INFINITY));
        // an Inf or NaN anywhere in A or B: nothing computed, A and B as they were
        let a0 = seeded(16, &mut 41);
        for (ai, bi, v) in [(Some(5), None, f64::NAN), (None, Some(7), f64::INFINITY), (Some(15), None, f64::NEG_INFINITY)] {
            let mut a = a0.clone();
            let mut b = seeded(8, &mut 42);
            if let Some(i) = ai {
                a[i] = v;
            }
            if let Some(i) = bi {
                b[i] = v;
            }
            let (a1, b1) = (a.clone(), b.clone());
            let mut ipiv = vec![0; 4];
            let rep = solve(Kernel::Scalar, Mode::Matlab, &mut a, 4, 4, &mut b, 2, 4, &mut ipiv, &mut work).unwrap();
            assert!(rep.status == Status::NonFinite && rep.rcond.is_nan());
            assert!(a.iter().zip(&a1).chain(b.iter().zip(&b1)).all(|(p, q)| p.to_bits() == q.to_bits()));
        }
        // refusals write nothing
        let mut a = a0.clone();
        let mut b = vec![1.0; 8];
        let mut ipiv = vec![0; 4];
        let need = solve_work_len(Mode::Matlab, 4, 2).unwrap();
        let k = Kernel::Scalar;
        for mode in [Mode::Matlab, Mode::Gesv] {
            let need = solve_work_len(mode, 4, 2).unwrap();
            assert_eq!(solve(k, mode, &mut a, 4, 4, &mut b, 2, 4, &mut ipiv, &mut work[..need - 1]), Err(Refused::Work));
            assert_eq!(solve(k, mode, &mut a, 4, 4, &mut b[..7], 2, 4, &mut ipiv, &mut work), Err(Refused::Layout));
            assert_eq!(solve(k, mode, &mut a[..15], 4, 4, &mut b, 2, 4, &mut ipiv, &mut work), Err(Refused::Layout));
            assert_eq!(solve(k, mode, &mut a, 4, 4, &mut b, 2, 4, &mut ipiv[..3], &mut work), Err(Refused::Pivots));
        }
        assert!(a == a0 && b.iter().all(|&v| v == 1.0));
        // (gesv's work is LU's, smaller than MATLAB mode's: enough for one, refused by the other)
        let g = solve_work_len(Mode::Gesv, 4, 2).unwrap();
        assert!(g < need);
        assert_eq!(solve(k, Mode::Matlab, &mut a, 4, 4, &mut b, 2, 4, &mut ipiv, &mut work[..g]), Err(Refused::Work));
        assert!(a == a0 && b.iter().all(|&v| v == 1.0));
        for mode in [Mode::Matlab, Mode::Gesv] {
            assert!(solve_work_len(mode, usize::MAX, 1).is_none() && solve_work_len(mode, 1 << 33, 1).is_none() && solve_work_len(mode, 4, usize::MAX).is_none());
        }
        // exactly enough work, with padded leading dimensions
        let (n, r, lda, ldb) = (5usize, 2usize, 7usize, 6usize);
        let mut a = vec![0.0; lda * n];
        let g = spd(n, 43);
        for j in 0..n {
            a[j * lda..j * lda + n].copy_from_slice(&g[j * n..(j + 1) * n]);
        }
        let mut b = vec![9.0; ldb * r];
        let mut w = vec![0.0; solve_work_len(Mode::Matlab, n, r).unwrap()];
        let mut p = vec![0; n];
        let rep = solve(Kernel::Scalar, Mode::Matlab, &mut a, n, lda, &mut b, r, ldb, &mut p, &mut w).unwrap();
        assert_eq!(rep.structure, Structure::Spd);
        assert!(b[n..ldb].iter().all(|&v| v == 9.0), "B's padding untouched");
    }

    /// gesv mode is LU whatever A is, bit for bit lu::solve's (SOLVE_FNV's family), with no estimate: on the
    /// structured matrices too (a triangular or SPD A is solved by LU there, as NumPy's solve does).
    #[test]
    fn gesv_mode_is_lu_whatever_the_structure() {
        for k in kernels() {
            let n = 70;
            let g = seeded(n * n, &mut 61);
            let b = seeded(n * 2, &mut 62);
            let up = upper_of(&g, n);
            for a in [g.clone(), up.clone(), transpose(&up, n), spd(n, 63)] {
                let mut a1 = a.clone();
                let mut x = b.clone();
                let mut ipiv = vec![0; n];
                let mut work = vec![0.0; solve_work_len(Mode::Gesv, n, 2).unwrap()];
                let rep = solve(k, Mode::Gesv, &mut a1, n, n, &mut x, 2, n, &mut ipiv, &mut work).unwrap();
                assert!(rep.status == Status::Solved && rep.structure == Structure::General && rep.rcond.is_nan(), "{rep:?}");
                let mut a2 = a.clone();
                let mut y = b.clone();
                let mut w2 = vec![0.0; crate::lu::solve_work_len(n, 2).unwrap()];
                crate::lu::solve(k, &mut a2, n, n, &mut y, 2, n, &mut ipiv, &mut w2).unwrap();
                assert!(x.iter().zip(&y).chain(a1.iter().zip(&a2)).all(|(p, q)| p.to_bits() == q.to_bits()), "{}", k.name());
            }
            // a zero pivot and a non-finite input, reported as lu::solve does
            let mut z = g.clone();
            z[7 * n..8 * n].fill(0.0);
            let mut x = b.clone();
            let mut ipiv = vec![0; n];
            let mut work = vec![0.0; solve_work_len(Mode::Gesv, n, 2).unwrap()];
            assert_eq!(solve(k, Mode::Gesv, &mut z, n, n, &mut x, 2, n, &mut ipiv, &mut work).unwrap().status, Status::Singular(7));
            let mut q = g.clone();
            q[3] = f64::NAN;
            assert_eq!(solve(k, Mode::Gesv, &mut q, n, n, &mut x, 2, n, &mut ipiv, &mut work).unwrap().status, Status::NonFinite);
        }
    }

    /// The magic(8) golden fixture (real MATLAB, /scratch/matlab-speed/oracle/matlab-magic8-2026-11-04.txt, sha256
    /// 25c3fb5b...; grader's notes, @sagebrush's ruling): A = magic(8), b = ones(8, 1). In MATLAB mode it takes
    /// the LU path (not symmetric, not triangular: the dispatch the fixture checks), its 8th pivot is exactly 0
    /// (rcond 0: singular, MATLAB's "Matrix is singular to working precision." is P2c's, from this status), and
    /// back substitution goes through it: x(1:5) NaN (isnan only: MATLAB's display shows no NaN bits), x(6) =
    /// +Inf and x(7) = -Inf exactly, x(8) within MATLAB's short format's -0.0312: [-0.03125, -0.03115).
    #[test]
    fn magic8_matches_matlab() {
        // (MATLAB's magic(8), column by column)
        let a: Vec<f64> = [
            [64, 9, 17, 40, 32, 41, 49, 8],
            [2, 55, 47, 26, 34, 23, 15, 58],
            [3, 54, 46, 27, 35, 22, 14, 59],
            [61, 12, 20, 37, 29, 44, 52, 5],
            [60, 13, 21, 36, 28, 45, 53, 4],
            [6, 51, 43, 30, 38, 19, 11, 62],
            [7, 50, 42, 31, 39, 18, 10, 63],
            [57, 16, 24, 33, 25, 48, 56, 1],
        ]
        .iter()
        .flatten()
        .map(|&v| f64::from(v))
        .collect();
        for k in kernels() {
            let (x, rep, _) = run(k, &a, &[1.0; 8], 8, 1);
            assert_eq!(rep.structure, Structure::General, "{}: magic(8) is solved by LU", k.name());
            assert!(matches!(rep.status, Status::Singular(_)) && rep.rcond == 0.0, "{}: {rep:?}", k.name());
            assert!(x[..5].iter().all(|v| v.is_nan()), "{}: {x:?}", k.name());
            assert_eq!((x[5], x[6]), (f64::INFINITY, f64::NEG_INFINITY), "{}: {x:?}", k.name());
            assert!(x[7] >= -0.03125 && x[7] < -0.03115, "{}: x(8) = {}", k.name(), x[7]);
        }
    }

    /// The per-structure bit pins (the triangular and Cholesky paths; the general path is lu's SOLVE_FNV):
    /// seeded 120 x 120 systems, 3 right-hand sides, per kernel family.
    pub(crate) const PATHS_FNV: u64 = 0xb95a3f8a53a7c959;
    pub(crate) const PATHS_FNV_FMA: u64 = 0x1a90e20c9e1608b5;

    pub(crate) fn paths_fnv(k: Kernel) -> u64 {
        let (n, r) = (120, 3);
        let g = seeded(n * n, &mut 2031);
        let b = seeded(n * r, &mut 2032);
        let up = upper_of(&g, n);
        let mut all = Vec::new();
        for a in [up.clone(), transpose(&up, n), spd(n, 2033)] {
            let (x, rep, _) = run(k, &a, &b, n, r);
            all.extend_from_slice(&x);
            all.push(rep.rcond);
        }
        fnv(&all)
    }

    #[test]
    fn path_bits_per_family() {
        assert_eq!(paths_fnv(Kernel::Scalar), PATHS_FNV, "no-FMA family: {:#018x}", paths_fnv(Kernel::Scalar));
        assert_eq!(paths_fnv(Kernel::ScalarFma), PATHS_FNV_FMA, "FMA family: {:#018x}", paths_fnv(Kernel::ScalarFma));
        #[cfg(target_arch = "x86_64")]
        if let Some(k) = crate::micro::Avx2Fma::detect() {
            assert_eq!(paths_fnv(Kernel::Avx2Fma(k)), PATHS_FNV_FMA, "AVX2+FMA");
        }
        #[cfg(target_arch = "aarch64")]
        assert_eq!(paths_fnv(Kernel::Neon), PATHS_FNV_FMA, "NEON");
    }
}
