//! mpmath's dense linear algebra on real matrices (matrices/linalg.py,
//! mpmath 1.4.1, BSD-3-Clause, Copyright (c) 2005-2025 Fredrik Johansson and
//! mpmath contributors), ported operation for operation: LU_decomp's pivoting
//! (each row's scaled pivot, the tolerance from the 1-norm), L_solve, U_solve,
//! and on them inverse, det and lu_solve, each a whole matrix operation in one
//! call.  Each mpf operation is the one the reference's mpf type makes at the
//! context's precision and rounding (its `absmin` is abs rounded to them, its
//! `fsum` is mpf_sum), so the results are its results, bit for bit.
//!
//! Matrices are row-major `Vec<Mpf>`, n x n; vectors `Vec<Mpf>` of n.  A
//! numerically singular matrix is the reference's ZeroDivisionError
//! ('matrix is numerically singular'): `Err(Singular)`.

use crate::exp::Exp;
use crate::fail::failed;
use crate::mpc::mpf_abs;
use crate::mpf::{fone, fzero, mpf_add, mpf_div, mpf_mul, mpf_mul_int, mpf_sign, Mpf, Rnd};
use crate::nat::Nat;
use core::cmp::Ordering;

/// The reference's ZeroDivisionError('matrix is numerically singular').
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Singular;

fn sub(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    mpf_add(s, t, prec, rnd, true)
}

/// mpf_cmp(s, t) for numbers that are not nan.
fn cmp(s: &Mpf, t: &Mpf) -> Ordering {
    if s.man.is_zero() || t.man.is_zero() {
        if s.is_fzero() {
            return 0.cmp(&mpf_sign(t));
        }
        if t.is_fzero() {
            return mpf_sign(s).cmp(&0);
        }
        if s == t {
            return Ordering::Equal;
        }
        if s.is_finf() || t.is_fninf() {
            return Ordering::Greater;
        }
        return Ordering::Less;
    }
    if s.sign != t.sign {
        return if s.sign == 0 { Ordering::Greater } else { Ordering::Less };
    }
    // (finite, same sign: the sign of their exact difference)
    let d = sub(s, t, 0, Rnd::Floor);
    match mpf_sign(&d) {
        0 => Ordering::Equal,
        x if x > 0 => Ordering::Greater,
        _ => Ordering::Less,
    }
}

/// s <= t, s > t: False with a nan, as the reference's mpf_le and mpf_gt.
fn le(s: &Mpf, t: &Mpf) -> bool {
    !(s.is_fnan() || t.is_fnan()) && cmp(s, t) != Ordering::Greater
}
fn gt(s: &Mpf, t: &Mpf) -> bool {
    !(s.is_fnan() || t.is_fnan()) && cmp(s, t) == Ordering::Greater
}

/// mpf_sum(xs, prec, rnd, absolute): the exact sum, rounded once.
fn mpf_sum(xs: &[Mpf], prec: u64, rnd: Rnd, absolute: bool) -> Mpf {
    use crate::int::Int;
    let mut man = Int::zero();
    let mut exp: i64 = 0;
    let max_extra = if prec == 0 { 1_000_000 } else { 2 * prec as i64 };
    let mut special: Option<Mpf> = None;
    for x in xs {
        if !x.man.is_zero() {
            let xman = Int::new(x.sign == 1 && !absolute, x.man.clone());
            let xexp = x.exp.as_i64().unwrap_or(0);
            let delta = xexp - exp;
            if xexp >= exp {
                if delta > max_extra && (man.is_zero() || delta - man.bits() as i64 > max_extra) {
                    man = xman;
                    exp = xexp;
                } else {
                    man = man.add(&xman.shl(delta as u64));
                }
            } else {
                let delta = -delta;
                if delta - x.bc > max_extra {
                    if man.is_zero() {
                        man = xman;
                        exp = xexp;
                    }
                } else {
                    man = man.shl(delta as u64).add(&xman);
                    exp = xexp;
                }
            }
        } else if !x.exp.is_zero() {
            let x = if absolute { mpf_abs(x, 0, Rnd::Down) } else { x.clone() };
            special = Some(mpf_add(&special.unwrap_or_else(fzero), &x, 1, Rnd::Down, false));
        }
    }
    if let Some(s) = special {
        return s;
    }
    crate::mpf::from_int_man_exp(&man, &Exp::S(exp), prec, rnd)
}

/// ctx.eps at prec: 2^(1 - prec).
fn eps(prec: u64) -> Mpf {
    Mpf { sign: 0, man: Nat::from_u64(1), exp: Exp::S(1 - prec as i64), bc: 1 }
}

/// LU_decomp(A): A overwritten with L (below the diagonal, unit) and U, and
/// the pivots p (n - 1 of them).
pub fn lu_decomp(a: &mut [Mpf], n: usize, prec: u64, rnd: Rnd) -> Result<Vec<usize>, Singular> {
    let absmin = |x: &Mpf| mpf_abs(x, prec, rnd);
    // tol = absmin(mnorm(A, 1) * eps): the largest column sum of |a|, the first on ties (Python's max)
    let mut norm: Option<Mpf> = None;
    for j in 0..n {
        let col: Vec<Mpf> = (0..n).map(|i| mpf_abs(&a[i * n + j], 0, Rnd::Down)).collect();
        let s = mpf_sum(&col, prec, rnd, true);
        norm = Some(match norm {
            Some(m) if !gt(&s, &m) => m,
            _ => s,
        });
    }
    let norm = norm.unwrap_or_else(fzero);
    let tol = absmin(&mpf_mul(&norm, &eps(prec), prec, rnd));
    let mut p = vec![0usize; n.saturating_sub(1)];
    for j in 0..n.saturating_sub(1) {
        if failed() {
            return Ok(p);
        }
        let mut biggest: Option<Mpf> = None;
        let mut pj: Option<usize> = None;
        for k in j..n {
            let row: Vec<Mpf> = (j..n).map(|l| absmin(&a[k * n + l])).collect();
            let s = mpf_sum(&row, prec, rnd, false);
            if le(&absmin(&s), &tol) {
                return Err(Singular);
            }
            let current = mpf_mul(&mpf_div(&fone(), &s, prec, rnd), &absmin(&a[k * n + j]), prec, rnd);
            // (biggest starts as the int 0)
            if gt(&current, biggest.as_ref().unwrap_or(&fzero())) {
                biggest = Some(current);
                pj = Some(k);
            }
        }
        let Some(pj) = pj else { return Err(Singular) };
        p[j] = pj;
        if pj != j {
            for k in 0..n {
                a.swap(j * n + k, pj * n + k);
            }
        }
        if le(&absmin(&a[j * n + j]), &tol) {
            return Err(Singular);
        }
        for i in j + 1..n {
            a[i * n + j] = mpf_div(&a[i * n + j], &a[j * n + j], prec, rnd);
            for k in j + 1..n {
                let t = mpf_mul(&a[i * n + j], &a[j * n + k], prec, rnd);
                a[i * n + k] = sub(&a[i * n + k], &t, prec, rnd);
            }
        }
    }
    if n > 1 && le(&absmin(&a[(n - 1) * n + n - 1]), &tol) {
        return Err(Singular);
    }
    Ok(p)
}

/// L_solve(L, b, p): b permuted by p, then forward substitution (unit L).
pub fn l_solve(l: &[Mpf], b: &[Mpf], p: &[usize], n: usize, prec: u64, rnd: Rnd) -> Vec<Mpf> {
    let mut b = b.to_vec();
    for (k, &pk) in p.iter().enumerate() {
        b.swap(k, pk);
    }
    for i in 1..n {
        for j in 0..i {
            let t = mpf_mul(&l[i * n + j], &b[j], prec, rnd);
            b[i] = sub(&b[i], &t, prec, rnd);
        }
    }
    b
}

/// U_solve(U, y): back substitution.
pub fn u_solve(u: &[Mpf], y: &[Mpf], n: usize, prec: u64, rnd: Rnd) -> Vec<Mpf> {
    let mut x = y.to_vec();
    for i in (0..n).rev() {
        for j in i + 1..n {
            let t = mpf_mul(&u[i * n + j], &x[j], prec, rnd);
            x[i] = sub(&x[i], &t, prec, rnd);
        }
        x[i] = mpf_div(&x[i], &u[i * n + i], prec, rnd);
    }
    x
}

/// inverse(A) at the caller's prec (the reference works at prec + 10).
pub fn inverse(a: &[Mpf], n: usize, prec: u64, rnd: Rnd) -> Result<Vec<Mpf>, Singular> {
    let wp = prec + 10;
    let mut lu = a.to_vec();
    let p = lu_decomp(&mut lu, n, wp, rnd)?;
    let mut inv = vec![fzero(); n * n];
    for c in 0..n {
        let e: Vec<Mpf> = (0..n).map(|r| if r == c { fone() } else { fzero() }).collect();
        let y = l_solve(&lu, &e, &p, n, wp, rnd);
        let x = u_solve(&lu, &y, n, wp, rnd);
        for (r, v) in x.into_iter().enumerate() {
            inv[r * n + c] = v;
        }
        if failed() {
            break;
        }
    }
    Ok(inv)
}

/// lu_solve(A, b) for a square A at the caller's prec (the reference works at prec + 10).
pub fn lu_solve(a: &[Mpf], b: &[Mpf], n: usize, prec: u64, rnd: Rnd) -> Result<Vec<Mpf>, Singular> {
    let wp = prec + 10;
    let mut lu = a.to_vec();
    let p = lu_decomp(&mut lu, n, wp, rnd)?;
    let y = l_solve(&lu, b, &p, n, wp, rnd);
    Ok(u_solve(&lu, &y, n, wp, rnd))
}

/// det(A): None where the reference returns the int 0 (a singular A).
pub fn det(a: &[Mpf], n: usize, prec: u64, rnd: Rnd) -> Option<Mpf> {
    let mut lu = a.to_vec();
    let p = lu_decomp(&mut lu, n, prec, rnd).ok()?;
    let mut negative = false;
    for (i, &e) in p.iter().enumerate() {
        if i != e {
            negative = !negative;
        }
    }
    // (z starts as the int +-1: its first product is mpf_mul_int, then mpf_mul)
    let mut z: Option<Mpf> = None;
    for i in 0..n {
        let d = &lu[i * n + i];
        z = Some(match z {
            None => mpf_mul_int(d, negative as u32, &Nat::from_u64(1), prec, rnd),
            Some(z) => mpf_mul(&z, d, prec, rnd),
        });
    }
    // (n = 0: the int +-1 itself)
    Some(z.unwrap_or_else(|| Mpf { sign: negative as u32, ..fone() }))
}
