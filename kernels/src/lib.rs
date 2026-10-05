//! WebAssembly SIMD kernels for sagebrush's numpy (src/runtime/numpy*.ts):
//! matmul and LU here, QR, eigenproblems and the SVD in eigen.rs, the FFT
//! in fft.rs, glibc's exp and log over arrays in libm.rs.
//!
//! Plain exported functions on row-major f64 matrices in this module's
//! linear memory; the TypeScript side copies operands in and results out.
//! Every kernel performs exactly the floating-point operations of the
//! JavaScript code it replaces, in the same order (two lanes at a time, no
//! fused multiply-add), so results are bit-for-bit the same with or without
//! WebAssembly.
#![no_std]

use core::arch::wasm32::*;

mod eigen;
mod fft;
mod libm;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[inline(always)]
pub(crate) unsafe fn ld(p: *const f64) -> v128 {
    v128_load(p as *const v128)
}
#[inline(always)]
pub(crate) unsafe fn st(p: *mut f64, v: v128) {
    v128_store(p as *mut v128, v)
}
#[inline(always)]
pub(crate) fn abs(x: f64) -> f64 {
    f64::from_bits(x.to_bits() & !(1u64 << 63))
}
#[inline(always)]
pub(crate) fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}
/// JavaScript's Math.max of two numbers that are not -0
#[inline(always)]
pub(crate) fn jsmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}
/// V8's Math.hypot of two numbers (src/builtins/math.tq, whose Kahan sum
/// has no compensation to carry with two terms), as hypot() in the TS.
pub(crate) fn hypot(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return if abs(a) == f64::INFINITY || abs(b) == f64::INFINITY { f64::INFINITY } else { f64::NAN };
    }
    let (a, b) = (abs(a), abs(b));
    let max = if a > b { a } else { b };
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (x, y) = (a / max, b / max);
    sqrt(x * x + y * y) * max
}

/// C (m x n) = A (m x k) . B (k x n); `bp` is scratch of k * 4 doubles.
/// Each element of C sums its k products in order, starting from 0.
#[no_mangle]
pub unsafe extern "C" fn dgemm(a: *const f64, b: *const f64, c: *mut f64, m: usize, n: usize, k: usize, bp: *mut f64) {
    let mut j = 0;
    while j + 4 <= n {
        // pack the k x 4 panel of B contiguously
        for kk in 0..k {
            let src = b.add(kk * n + j);
            st(bp.add(4 * kk), ld(src));
            st(bp.add(4 * kk + 2), ld(src.add(2)));
        }
        let mut i = 0;
        while i + 4 <= m {
            let (mut c00, mut c01, mut c10, mut c11) = (f64x2_splat(0.0), f64x2_splat(0.0), f64x2_splat(0.0), f64x2_splat(0.0));
            let (mut c20, mut c21, mut c30, mut c31) = (f64x2_splat(0.0), f64x2_splat(0.0), f64x2_splat(0.0), f64x2_splat(0.0));
            let (r0, r1, r2, r3) = (a.add(i * k), a.add((i + 1) * k), a.add((i + 2) * k), a.add((i + 3) * k));
            for kk in 0..k {
                let b0 = ld(bp.add(4 * kk));
                let b1 = ld(bp.add(4 * kk + 2));
                let a0 = f64x2_splat(*r0.add(kk));
                let a1 = f64x2_splat(*r1.add(kk));
                let a2 = f64x2_splat(*r2.add(kk));
                let a3 = f64x2_splat(*r3.add(kk));
                c00 = f64x2_add(c00, f64x2_mul(a0, b0));
                c01 = f64x2_add(c01, f64x2_mul(a0, b1));
                c10 = f64x2_add(c10, f64x2_mul(a1, b0));
                c11 = f64x2_add(c11, f64x2_mul(a1, b1));
                c20 = f64x2_add(c20, f64x2_mul(a2, b0));
                c21 = f64x2_add(c21, f64x2_mul(a2, b1));
                c30 = f64x2_add(c30, f64x2_mul(a3, b0));
                c31 = f64x2_add(c31, f64x2_mul(a3, b1));
            }
            st(c.add(i * n + j), c00);
            st(c.add(i * n + j + 2), c01);
            st(c.add((i + 1) * n + j), c10);
            st(c.add((i + 1) * n + j + 2), c11);
            st(c.add((i + 2) * n + j), c20);
            st(c.add((i + 2) * n + j + 2), c21);
            st(c.add((i + 3) * n + j), c30);
            st(c.add((i + 3) * n + j + 2), c31);
            i += 4;
        }
        while i < m {
            let r = a.add(i * k);
            let (mut c0, mut c1) = (f64x2_splat(0.0), f64x2_splat(0.0));
            for kk in 0..k {
                let av = f64x2_splat(*r.add(kk));
                c0 = f64x2_add(c0, f64x2_mul(av, ld(bp.add(4 * kk))));
                c1 = f64x2_add(c1, f64x2_mul(av, ld(bp.add(4 * kk + 2))));
            }
            st(c.add(i * n + j), c0);
            st(c.add(i * n + j + 2), c1);
            i += 1;
        }
        j += 4;
    }
    // remaining columns, scalar
    while j < n {
        for i in 0..m {
            let mut s = 0.0;
            for kk in 0..k {
                s += *a.add(i * k + kk) * *b.add(kk * n + j);
            }
            *c.add(i * n + j) = s;
        }
        j += 1;
    }
}

/// The dot product of x[0..n] and y[0..n] with four partial sums (of the
/// terms i = 0, 1, 2, 3 mod 4), combined as (s0 + s2) + (s1 + s3), then the
/// n mod 4 last terms in order: dot4() in the TS.
#[inline(always)]
pub(crate) unsafe fn dot4(x: *const f64, y: *const f64, n: usize) -> f64 {
    let mut a0 = f64x2_splat(0.0);
    let mut a1 = f64x2_splat(0.0);
    let mut i = 0;
    while i + 4 <= n {
        a0 = f64x2_add(a0, f64x2_mul(ld(x.add(i)), ld(y.add(i))));
        a1 = f64x2_add(a1, f64x2_mul(ld(x.add(i + 2)), ld(y.add(i + 2))));
        i += 4;
    }
    let t = f64x2_add(a0, a1);
    let mut r = f64x2_extract_lane::<0>(t) + f64x2_extract_lane::<1>(t);
    while i < n {
        r += *x.add(i) * *y.add(i);
        i += 1;
    }
    r
}

/// dst (cols x rows) = the transpose of src (rows x cols), both row-major
#[no_mangle]
pub unsafe extern "C" fn transpose(src: *const f64, rows: usize, cols: usize, dst: *mut f64) {
    const B: usize = 32;
    let mut i0 = 0;
    while i0 < rows {
        let i1 = if i0 + B < rows { i0 + B } else { rows };
        let mut j0 = 0;
        while j0 < cols {
            let j1 = if j0 + B < cols { j0 + B } else { cols };
            for i in i0..i1 {
                for j in j0..j1 {
                    *dst.add(j * rows + i) = *src.add(i * cols + j);
                }
            }
            j0 = j1;
        }
        i0 = i1;
    }
}

/// y[0..len] += t * x[0..len]
#[inline(always)]
pub(crate) unsafe fn axpy(y: *mut f64, x: *const f64, t: f64, len: usize) {
    let tv = f64x2_splat(t);
    let mut i = 0;
    while i + 2 <= len {
        st(y.add(i), f64x2_add(ld(y.add(i)), f64x2_mul(tv, ld(x.add(i)))));
        i += 2;
    }
    if i < len {
        *y.add(i) += t * *x.add(i);
    }
}

/// y[0..len] -= f * x[0..len]
#[inline(always)]
pub(crate) unsafe fn axpy_neg(y: *mut f64, x: *const f64, f: f64, len: usize) {
    let fv = f64x2_splat(f);
    let mut t = 0;
    while t + 2 <= len {
        st(y.add(t), f64x2_sub(ld(y.add(t)), f64x2_mul(fv, ld(x.add(t)))));
        t += 2;
    }
    if t < len {
        *y.add(t) -= f * *x.add(t);
    }
}

/// LU with partial pivoting of the n x n matrix a, in place (L below the
/// diagonal with unit diagonal, U on and above), as sagebrush's JS lu().
/// piv[i] receives the original row of row i.  Returns the sign of the
/// permutation, 1 or -1, doubled when a pivot was exactly zero (singular).
#[no_mangle]
pub unsafe extern "C" fn dgetrf(a: *mut f64, n: usize, piv: *mut i32) -> i32 {
    for i in 0..n {
        *piv.add(i) = i as i32;
    }
    let mut sign = 1i32;
    let mut singular = false;
    for k in 0..n {
        let mut p = k;
        let mut big = (*a.add(k * n + k)).abs();
        for i in k + 1..n {
            let v = (*a.add(i * n + k)).abs();
            if v > big {
                big = v;
                p = i;
            }
        }
        if p != k {
            for j in 0..n {
                let t = *a.add(k * n + j);
                *a.add(k * n + j) = *a.add(p * n + j);
                *a.add(p * n + j) = t;
            }
            let t = *piv.add(k);
            *piv.add(k) = *piv.add(p);
            *piv.add(p) = t;
            sign = -sign;
        }
        let d = *a.add(k * n + k);
        if d == 0.0 {
            singular = true;
            continue;
        }
        let rowk = a.add(k * n + k + 1);
        for i in k + 1..n {
            let f = *a.add(i * n + k) / d;
            *a.add(i * n + k) = f;
            if f == 0.0 {
                continue;
            }
            axpy_neg(a.add(i * n + k + 1), rowk, f, n - k - 1);
        }
    }
    if singular {
        2 * sign
    } else {
        sign
    }
}

/// Solve with the factors of dgetrf: x (n x m) holds B with rows already
/// permuted by piv; overwritten with the solution, as sagebrush's luSolve().
#[no_mangle]
pub unsafe extern "C" fn dgetrs(lu: *const f64, n: usize, x: *mut f64, m: usize) {
    for k in 0..n {
        for i in k + 1..n {
            let f = *lu.add(i * n + k);
            if f != 0.0 {
                axpy_neg(x.add(i * m), x.add(k * m), f, m);
            }
        }
    }
    for k in (0..n).rev() {
        let d = *lu.add(k * n + k);
        let row = x.add(k * m);
        for j in 0..m {
            *row.add(j) /= d;
        }
        for i in 0..k {
            let f = *lu.add(i * n + k);
            if f != 0.0 {
                axpy_neg(x.add(i * m), row, f, m);
            }
        }
    }
}
