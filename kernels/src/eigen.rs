//! Householder QR, the symmetric eigenproblem (tred2 + tql2), the general
//! eigenproblem (orthes + hqr2) and the SVD (Golub-Kahan-Reinsch), ported
//! operation for operation from src/runtime/numpy_linalg.ts (which follows
//! JAMA, public domain).  Matrices whose columns the algorithms walk are
//! stored transposed, so that those walks are contiguous and the
//! elementwise ones run two lanes at a time.

use crate::{abs, axpy, axpy_neg, dot4, hypot, jsmax, ld, sqrt, st};
use core::arch::wasm32::*;

/// Euclidean norm of x[0..n], scaled to avoid overflow (nrm2 in the TS).
unsafe fn nrm2(x: *const f64, n: usize) -> f64 {
    let mut big = 0.0;
    for i in 0..n {
        let a = abs(*x.add(i));
        if a > big {
            big = a;
        }
    }
    if big == 0.0 || !big.is_finite() {
        return big;
    }
    let mut sum = 0.0;
    let inv = 1.0 / big;
    for i in 0..n {
        let a = *x.add(i) * inv;
        sum += a * a;
    }
    big * sqrt(sum)
}

/// x' = cs x + sn y, y' = -sn x + cs y
unsafe fn rot(x: *mut f64, y: *mut f64, len: usize, cs: f64, sn: f64) {
    let (c, s, ms) = (f64x2_splat(cs), f64x2_splat(sn), f64x2_splat(-sn));
    let mut i = 0;
    while i + 2 <= len {
        let (xv, yv) = (ld(x.add(i)), ld(y.add(i)));
        st(x.add(i), f64x2_add(f64x2_mul(c, xv), f64x2_mul(s, yv)));
        st(y.add(i), f64x2_add(f64x2_mul(ms, xv), f64x2_mul(c, yv)));
        i += 2;
    }
    if i < len {
        let (xv, yv) = (*x.add(i), *y.add(i));
        *x.add(i) = cs * xv + sn * yv;
        *y.add(i) = -sn * xv + cs * yv;
    }
}

unsafe fn swap(x: *mut f64, y: *mut f64, len: usize) {
    for i in 0..len {
        let t = *y.add(i);
        *y.add(i) = *x.add(i);
        *x.add(i) = t;
    }
}

// ------------------------------------------------------------------ QR

/// Householder QR of the m x n matrix c, stored by columns (overwritten:
/// R is on and above the diagonal).  v: k = min(m, n) columns of length m
/// (Householder vectors), beta: k scalars, q: qc columns of length m
/// receiving Q.  As qr() in the TS.
#[no_mangle]
pub unsafe extern "C" fn dgeqr(c: *mut f64, m: usize, n: usize, v: *mut f64, beta: *mut f64, q: *mut f64, qc: usize) {
    let k = if m < n { m } else { n };
    for j in 0..k {
        let cj = c.add(j * m);
        let norm = nrm2(cj.add(j), m - j);
        let vj = v.add(j * m);
        for i in 0..m {
            *vj.add(i) = 0.0;
        }
        if norm == 0.0 {
            *beta.add(j) = 0.0;
            continue;
        }
        let alpha = if *cj.add(j) > 0.0 { -norm } else { norm };
        // v = (x - alpha e_j) / (x_j - alpha) (entries at most 1: v.v does
        // not underflow or overflow at extreme scales), as in the TS
        let d = *cj.add(j) - alpha;
        for i in j..m {
            *vj.add(i) = *cj.add(i) / d;
        }
        *vj.add(j) = 1.0;
        let vv = dot4(vj.add(j), vj.add(j), m - j);
        let b = if vv == 0.0 { 0.0 } else { 2.0 / vv };
        for col in j..n {
            let cc = c.add(col * m);
            let mut sum = dot4(vj.add(j), cc.add(j), m - j);
            sum *= b;
            axpy_neg(cc.add(j), vj.add(j), sum, m - j);
        }
        *beta.add(j) = b;
    }
    for col in 0..qc {
        let qq = q.add(col * m);
        for i in 0..m {
            *qq.add(i) = 0.0;
        }
        if col < m {
            *qq.add(col) = 1.0;
        }
    }
    for j in (0..k).rev() {
        let (vj, b) = (v.add(j * m), *beta.add(j));
        if b == 0.0 {
            continue;
        }
        for col in 0..qc {
            let qq = q.add(col * m);
            let mut sum = dot4(vj.add(j), qq.add(j), m - j);
            if sum == 0.0 {
                continue;
            }
            sum *= b;
            axpy_neg(qq.add(j), vj.add(j), sum, m - j);
        }
    }
}

// ------------------------------------------------------------------ symmetric eigenproblem

/// tred2 + tql2.  w (n x n): on entry the transpose of the symmetric
/// matrix; on exit row j is the eigenvector of d[j] (unsorted).  d, e: n
/// doubles each.  Returns 0, or 1 if QL did not converge.  As symEig() in
/// the TS, whose V[r][c] is w[c * n + r] here.
#[no_mangle]
pub unsafe extern "C" fn dsyev(w: *mut f64, n: usize, d: *mut f64, e: *mut f64) -> i32 {
    macro_rules! v {
        ($r:expr, $c:expr) => {
            *w.add(($c) * n + ($r))
        };
    }
    macro_rules! d {
        ($i:expr) => {
            *d.add($i)
        };
    }
    macro_rules! e {
        ($i:expr) => {
            *e.add($i)
        };
    }
    for j in 0..n {
        d!(j) = v!(n - 1, j);
        e!(j) = 0.0;
    }
    // Householder reduction to tridiagonal form
    for i in (1..n).rev() {
        let mut scale = 0.0;
        let mut h = 0.0;
        for k in 0..i {
            scale += abs(d!(k));
        }
        if scale == 0.0 {
            e!(i) = d!(i - 1);
            for j in 0..i {
                d!(j) = v!(i - 1, j);
                v!(i, j) = 0.0;
                v!(j, i) = 0.0;
            }
        } else {
            for k in 0..i {
                d!(k) /= scale;
                h += d!(k) * d!(k);
            }
            let mut f = d!(i - 1);
            let mut g = sqrt(h);
            if f > 0.0 {
                g = -g;
            }
            e!(i) = scale * g;
            h -= f * g;
            d!(i - 1) = f - g;
            for j in 0..i {
                e!(j) = 0.0;
            }
            for j in 0..i {
                f = d!(j);
                v!(j, i) = f;
                g = e!(j) + v!(j, j) * f;
                let col = w.add(j * n);
                for k in j + 1..i {
                    g += *col.add(k) * d!(k);
                }
                axpy(e.add(j + 1), col.add(j + 1), f, i - j - 1);
                e!(j) = g;
            }
            f = 0.0;
            for j in 0..i {
                e!(j) /= h;
                f += e!(j) * d!(j);
            }
            let hh = f / (h + h);
            axpy_neg(e, d, hh, i);
            for j in 0..i {
                f = d!(j);
                g = e!(j);
                // V[k][j] -= f e[k] + g d[k], k = j..i-1
                let col = w.add(j * n);
                let (fv, gv) = (f64x2_splat(f), f64x2_splat(g));
                let mut k = j;
                while k + 2 <= i {
                    let t = f64x2_add(f64x2_mul(fv, ld(e.add(k))), f64x2_mul(gv, ld(d.add(k))));
                    st(col.add(k), f64x2_sub(ld(col.add(k)), t));
                    k += 2;
                }
                if k < i {
                    *col.add(k) -= f * e!(k) + g * d!(k);
                }
                d!(j) = v!(i - 1, j);
                v!(i, j) = 0.0;
            }
        }
        d!(i) = h;
    }
    // accumulate the transformations
    for i in 0..n - 1 {
        v!(n - 1, i) = v!(i, i);
        v!(i, i) = 1.0;
        let h = d!(i + 1);
        let ci = w.add((i + 1) * n);
        if h != 0.0 {
            for k in 0..=i {
                d!(k) = *ci.add(k) / h;
            }
            for j in 0..=i {
                let cj = w.add(j * n);
                let mut g = 0.0;
                for k in 0..=i {
                    g += *ci.add(k) * *cj.add(k);
                }
                axpy_neg(cj, d, g, i + 1);
            }
        }
        for k in 0..=i {
            *ci.add(k) = 0.0;
        }
    }
    for j in 0..n {
        d!(j) = v!(n - 1, j);
        v!(n - 1, j) = 0.0;
    }
    v!(n - 1, n - 1) = 1.0;
    e!(0) = 0.0;
    // implicit QL
    for i in 1..n {
        e!(i - 1) = e!(i);
    }
    e!(n - 1) = 0.0;
    let mut f = 0.0;
    let mut tst1 = 0.0;
    let eps = f64::EPSILON;
    for l in 0..n {
        tst1 = jsmax(tst1, abs(d!(l)) + abs(e!(l)));
        let mut m = l;
        while m < n {
            if abs(e!(m)) <= eps * tst1 {
                break;
            }
            m += 1;
        }
        if m > l {
            let mut iter = 0;
            loop {
                iter += 1;
                if iter > 300 {
                    return 1;
                }
                let mut g = d!(l);
                let mut p = (d!(l + 1) - g) / (2.0 * e!(l));
                let mut r = hypot(p, 1.0);
                if p < 0.0 {
                    r = -r;
                }
                d!(l) = e!(l) / (p + r);
                d!(l + 1) = e!(l) * (p + r);
                let dl1 = d!(l + 1);
                let mut h = g - d!(l);
                for i in l + 2..n {
                    d!(i) -= h;
                }
                f += h;
                p = d!(m);
                let mut c = 1.0;
                let mut c2 = c;
                let mut c3 = c;
                let el1 = e!(l + 1);
                let mut s = 0.0;
                let mut s2 = 0.0;
                for i in (l..m).rev() {
                    c3 = c2;
                    c2 = c;
                    s2 = s;
                    g = c * e!(i);
                    h = c * p;
                    r = hypot(p, e!(i));
                    e!(i + 1) = s * r;
                    s = e!(i) / r;
                    c = p / r;
                    p = c * d!(i) - s * g;
                    d!(i + 1) = h + s * (c * g + s * d!(i));
                    // V[k][i+1] = s V[k][i] + c V[k][i+1]; V[k][i] = c V[k][i] - s V[k][i+1]
                    let (x, y) = (w.add(i * n), w.add((i + 1) * n));
                    let (sv, cv) = (f64x2_splat(s), f64x2_splat(c));
                    let mut k = 0;
                    while k + 2 <= n {
                        let (xv, yv) = (ld(x.add(k)), ld(y.add(k)));
                        st(y.add(k), f64x2_add(f64x2_mul(sv, xv), f64x2_mul(cv, yv)));
                        st(x.add(k), f64x2_sub(f64x2_mul(cv, xv), f64x2_mul(sv, yv)));
                        k += 2;
                    }
                    if k < n {
                        let (xv, yv) = (*x.add(k), *y.add(k));
                        *y.add(k) = s * xv + c * yv;
                        *x.add(k) = c * xv - s * yv;
                    }
                }
                p = (-s * s2 * c3 * el1 * e!(l)) / dl1;
                e!(l) = s * p;
                d!(l) = c * p;
                if !(abs(e!(l)) > eps * tst1) {
                    break;
                }
            }
        }
        d!(l) = d!(l) + f;
        e!(l) = 0.0;
    }
    0
}

// ------------------------------------------------------------------ general eigenproblem

fn cdiv(xr: f64, xi: f64, yr: f64, yi: f64) -> (f64, f64) {
    if abs(yr) > abs(yi) {
        let rr = yi / yr;
        let dd = yr + rr * yi;
        ((xr + rr * xi) / dd, (xi - rr * xr) / dd)
    } else {
        let rr = yr / yi;
        let dd = yi + rr * yr;
        ((rr * xr + xi) / dd, (rr * xi - xr) / dd)
    }
}

/// orthes + hqr2.  h: the n x n matrix by rows (destroyed); w: n x n,
/// receives the transposed eigenvector matrix V (row j = column j of V);
/// d, e: real and imaginary parts of the eigenvalues; ort: n doubles of
/// scratch; tmp: n doubles of scratch.  Returns 0, or 1 if QR did not
/// converge.  As genEig() in the TS, up to the normalization.
#[no_mangle]
#[allow(unused_assignments)]
pub unsafe extern "C" fn dgeev(hm: *mut f64, n: usize, w: *mut f64, d: *mut f64, e: *mut f64, ort: *mut f64, tmp: *mut f64) -> i32 {
    macro_rules! h {
        ($r:expr, $c:expr) => {
            *hm.add(($r) * n + ($c))
        };
    }
    macro_rules! v {
        ($r:expr, $c:expr) => {
            *w.add(($c) * n + ($r))
        };
    }
    macro_rules! o {
        ($i:expr) => {
            *ort.add($i)
        };
    }
    macro_rules! d {
        ($i:expr) => {
            *d.add($i)
        };
    }
    macro_rules! e {
        ($i:expr) => {
            *e.add($i)
        };
    }
    for i in 0..n {
        for j in 0..n {
            v!(i, j) = if i == j { 1.0 } else { 0.0 };
        }
        o!(i) = 0.0;
        d!(i) = 0.0;
        e!(i) = 0.0;
    }
    let low = 0usize;
    let high = n - 1;
    // reduce to Hessenberg form (orthes)
    for m in low + 1..high {
        let mut scale = 0.0;
        for i in m..=high {
            scale += abs(h!(i, m - 1));
        }
        if scale != 0.0 {
            let mut hh = 0.0;
            for i in (m..=high).rev() {
                o!(i) = h!(i, m - 1) / scale;
                hh += o!(i) * o!(i);
            }
            let mut g = sqrt(hh);
            if o!(m) > 0.0 {
                g = -g;
            }
            hh -= o!(m) * g;
            o!(m) -= g;
            // columns j = m..n: f_j = sum over i descending of ort[i] H[i][j],
            // accumulated for all j at once along the rows
            let fj = tmp.add(m);
            let cnt = n - m;
            for j in 0..cnt {
                *fj.add(j) = 0.0;
            }
            for i in (m..=high).rev() {
                axpy(fj, hm.add(i * n + m), o!(i), cnt);
            }
            for j in 0..cnt {
                *fj.add(j) /= hh;
            }
            for i in m..=high {
                axpy_neg(hm.add(i * n + m), fj, o!(i), cnt);
            }
            for i in 0..=high {
                let mut f = 0.0;
                for j in (m..=high).rev() {
                    f += o!(j) * h!(i, j);
                }
                f /= hh;
                axpy_neg(hm.add(i * n + m), ort.add(m), f, high - m + 1);
            }
            o!(m) = scale * o!(m);
            h!(m, m - 1) = scale * g;
        }
    }
    for m in (low + 1..high).rev() {
        if h!(m, m - 1) != 0.0 {
            for i in m + 1..=high {
                o!(i) = h!(i, m - 1);
            }
            for j in m..=high {
                let col = w.add(j * n);
                let mut g = 0.0;
                for i in m..=high {
                    g += o!(i) * *col.add(i);
                }
                g = g / o!(m) / h!(m, m - 1);
                axpy(col.add(m), ort.add(m), g, high - m + 1);
            }
        }
    }
    // hqr2: real Schur form and eigenvectors
    let nn = n as isize;
    let mut big_n: isize = nn - 1;
    let eps = f64::EPSILON;
    let mut exshift = 0.0;
    let (mut p, mut q, mut r, mut s, mut z) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut t, mut wv, mut x, mut y): (f64, f64, f64, f64) = (0.0, 0.0, 0.0, 0.0);
    let mut norm = 0.0;
    for i in 0..n {
        let j0 = if i > 0 { i - 1 } else { 0 };
        for j in j0..n {
            norm += abs(h!(i, j));
        }
    }
    let mut iter = 0;
    let low = low as isize;
    let high = high as isize;
    macro_rules! H {
        ($r:expr, $c:expr) => {
            h!(($r) as usize, ($c) as usize)
        };
    }
    macro_rules! V {
        ($r:expr, $c:expr) => {
            v!(($r) as usize, ($c) as usize)
        };
    }
    macro_rules! D {
        ($i:expr) => {
            d!(($i) as usize)
        };
    }
    macro_rules! E {
        ($i:expr) => {
            e!(($i) as usize)
        };
    }
    while big_n >= low {
        let nb = big_n;
        let mut l = nb;
        while l > low {
            s = abs(H!(l - 1, l - 1)) + abs(H!(l, l));
            if s == 0.0 {
                s = norm;
            }
            if abs(H!(l, l - 1)) < eps * s || H!(l, l - 1) == 0.0 {
                break;
            }
            l -= 1;
        }
        if l == nb {
            H!(nb, nb) = H!(nb, nb) + exshift;
            D!(nb) = H!(nb, nb);
            E!(nb) = 0.0;
            big_n -= 1;
            iter = 0;
        } else if l == nb - 1 {
            wv = H!(nb, nb - 1) * H!(nb - 1, nb);
            p = (H!(nb - 1, nb - 1) - H!(nb, nb)) / 2.0;
            q = p * p + wv;
            z = sqrt(abs(q));
            H!(nb, nb) = H!(nb, nb) + exshift;
            H!(nb - 1, nb - 1) = H!(nb - 1, nb - 1) + exshift;
            x = H!(nb, nb);
            if q >= 0.0 {
                z = if p >= 0.0 { p + z } else { p - z };
                D!(nb - 1) = x + z;
                D!(nb) = D!(nb - 1);
                if z != 0.0 {
                    D!(nb) = x - wv / z;
                }
                E!(nb - 1) = 0.0;
                E!(nb) = 0.0;
                x = H!(nb, nb - 1);
                s = abs(x) + abs(z);
                p = x / s;
                q = z / s;
                r = sqrt(p * p + q * q);
                p /= r;
                q /= r;
                for j in nb - 1..nn {
                    z = H!(nb - 1, j);
                    H!(nb - 1, j) = q * z + p * H!(nb, j);
                    H!(nb, j) = q * H!(nb, j) - p * z;
                }
                for i in 0..=nb {
                    z = H!(i, nb - 1);
                    H!(i, nb - 1) = q * z + p * H!(i, nb);
                    H!(i, nb) = q * H!(i, nb) - p * z;
                }
                for i in low..=high {
                    z = V!(i, nb - 1);
                    V!(i, nb - 1) = q * z + p * V!(i, nb);
                    V!(i, nb) = q * V!(i, nb) - p * z;
                }
            } else {
                D!(nb - 1) = x + p;
                D!(nb) = x + p;
                E!(nb - 1) = z;
                E!(nb) = -z;
            }
            big_n -= 2;
            iter = 0;
        } else {
            x = H!(nb, nb);
            y = 0.0;
            wv = 0.0;
            if l < nb {
                y = H!(nb - 1, nb - 1);
                wv = H!(nb, nb - 1) * H!(nb - 1, nb);
            }
            if iter == 10 {
                exshift += x;
                for i in low..=nb {
                    H!(i, i) -= x;
                }
                s = abs(H!(nb, nb - 1)) + abs(H!(nb - 1, nb - 2));
                x = 0.75 * s;
                y = x;
                wv = -0.4375 * s * s;
            }
            if iter == 30 {
                s = (y - x) / 2.0;
                s = s * s + wv;
                if s > 0.0 {
                    s = sqrt(s);
                    if y < x {
                        s = -s;
                    }
                    s = x - wv / ((y - x) / 2.0 + s);
                    for i in low..=nb {
                        H!(i, i) -= s;
                    }
                    exshift += s;
                    x = 0.964;
                    y = x;
                    wv = x;
                }
            }
            iter += 1;
            if iter > 1000 {
                return 1;
            }
            let mut m = nb - 2;
            while m >= l {
                z = H!(m, m);
                r = x - z;
                s = y - z;
                p = (r * s - wv) / H!(m + 1, m) + H!(m, m + 1);
                q = H!(m + 1, m + 1) - z - r - s;
                r = H!(m + 2, m + 1);
                s = abs(p) + abs(q) + abs(r);
                p /= s;
                q /= s;
                r /= s;
                if m == l {
                    break;
                }
                if abs(H!(m, m - 1)) * (abs(q) + abs(r)) < eps * (abs(p) * (abs(H!(m - 1, m - 1)) + abs(z) + abs(H!(m + 1, m + 1)))) {
                    break;
                }
                m -= 1;
            }
            for i in m + 2..=nb {
                H!(i, i - 2) = 0.0;
                if i > m + 2 {
                    H!(i, i - 3) = 0.0;
                }
            }
            let mut k = m;
            while k <= nb - 1 {
                let notlast = k != nb - 1;
                if k != m {
                    p = H!(k, k - 1);
                    q = H!(k + 1, k - 1);
                    r = if notlast { H!(k + 2, k - 1) } else { 0.0 };
                    x = abs(p) + abs(q) + abs(r);
                    if x == 0.0 {
                        k += 1;
                        continue;
                    }
                    p /= x;
                    q /= x;
                    r /= x;
                }
                s = sqrt(p * p + q * q + r * r);
                if p < 0.0 {
                    s = -s;
                }
                if s != 0.0 {
                    if k != m {
                        H!(k, k - 1) = -s * x;
                    } else if l != m {
                        H!(k, k - 1) = -H!(k, k - 1);
                    }
                    p += s;
                    x = p / s;
                    y = q / s;
                    z = r / s;
                    q /= p;
                    r /= p;
                    for j in k..nn {
                        p = H!(k, j) + q * H!(k + 1, j);
                        if notlast {
                            p += r * H!(k + 2, j);
                            H!(k + 2, j) -= p * z;
                        }
                        H!(k, j) -= p * x;
                        H!(k + 1, j) -= p * y;
                    }
                    let top = if nb < k + 3 { nb } else { k + 3 };
                    for i in 0..=top {
                        p = x * H!(i, k) + y * H!(i, k + 1);
                        if notlast {
                            p += z * H!(i, k + 2);
                            H!(i, k + 2) -= p * r;
                        }
                        H!(i, k) -= p;
                        H!(i, k + 1) -= p * q;
                    }
                    // V's columns k, k+1, k+2 are rows of w
                    let c0 = w.add(k as usize * n);
                    let c1 = c0.add(n);
                    let (xv, yv, zv, rv, qv) = (f64x2_splat(x), f64x2_splat(y), f64x2_splat(z), f64x2_splat(r), f64x2_splat(q));
                    let (lo, hi) = (low as usize, high as usize + 1);
                    let mut i = lo;
                    if notlast {
                        let c2 = c1.add(n);
                        while i + 2 <= hi {
                            let mut pv = f64x2_add(f64x2_mul(xv, ld(c0.add(i))), f64x2_mul(yv, ld(c1.add(i))));
                            pv = f64x2_add(pv, f64x2_mul(zv, ld(c2.add(i))));
                            st(c2.add(i), f64x2_sub(ld(c2.add(i)), f64x2_mul(pv, rv)));
                            st(c0.add(i), f64x2_sub(ld(c0.add(i)), pv));
                            st(c1.add(i), f64x2_sub(ld(c1.add(i)), f64x2_mul(pv, qv)));
                            i += 2;
                        }
                        while i < hi {
                            p = x * *c0.add(i) + y * *c1.add(i);
                            p += z * *c2.add(i);
                            *c2.add(i) -= p * r;
                            *c0.add(i) -= p;
                            *c1.add(i) -= p * q;
                            i += 1;
                        }
                    } else {
                        while i + 2 <= hi {
                            let pv = f64x2_add(f64x2_mul(xv, ld(c0.add(i))), f64x2_mul(yv, ld(c1.add(i))));
                            st(c0.add(i), f64x2_sub(ld(c0.add(i)), pv));
                            st(c1.add(i), f64x2_sub(ld(c1.add(i)), f64x2_mul(pv, qv)));
                            i += 2;
                        }
                        while i < hi {
                            p = x * *c0.add(i) + y * *c1.add(i);
                            *c0.add(i) -= p;
                            *c1.add(i) -= p * q;
                            i += 1;
                        }
                    }
                }
                k += 1;
            }
        }
    }
    // back substitution for the eigenvectors of the Schur form
    if norm != 0.0 {
        big_n = nn - 1;
        while big_n >= 0 {
            let nb = big_n;
            p = D!(nb);
            q = E!(nb);
            if q == 0.0 {
                let mut l = nb;
                H!(nb, nb) = 1.0;
                let mut i = nb - 1;
                while i >= 0 {
                    wv = H!(i, i) - p;
                    r = 0.0;
                    for j in l..=nb {
                        r += H!(i, j) * H!(j, nb);
                    }
                    if E!(i) < 0.0 {
                        z = wv;
                        s = r;
                    } else {
                        l = i;
                        if E!(i) == 0.0 {
                            H!(i, nb) = if wv != 0.0 { -r / wv } else { -r / (eps * norm) };
                        } else {
                            x = H!(i, i + 1);
                            y = H!(i + 1, i);
                            q = (D!(i) - p) * (D!(i) - p) + E!(i) * E!(i);
                            t = (x * s - z * r) / q;
                            H!(i, nb) = t;
                            H!(i + 1, nb) = if abs(x) > abs(z) { (-r - wv * t) / x } else { (-s - y * t) / z };
                        }
                        t = abs(H!(i, nb));
                        if eps * t * t > 1.0 {
                            for j in i..=nb {
                                H!(j, nb) /= t;
                            }
                        }
                    }
                    i -= 1;
                }
            } else if q < 0.0 {
                let mut l = nb - 1;
                if abs(H!(nb, nb - 1)) > abs(H!(nb - 1, nb)) {
                    H!(nb - 1, nb - 1) = q / H!(nb, nb - 1);
                    H!(nb - 1, nb) = -(H!(nb, nb) - p) / H!(nb, nb - 1);
                } else {
                    let (cr, ci) = cdiv(0.0, -H!(nb - 1, nb), H!(nb - 1, nb - 1) - p, q);
                    H!(nb - 1, nb - 1) = cr;
                    H!(nb - 1, nb) = ci;
                }
                H!(nb, nb - 1) = 0.0;
                H!(nb, nb) = 1.0;
                let mut i = nb - 2;
                while i >= 0 {
                    let mut ra = 0.0;
                    let mut sa = 0.0;
                    for j in l..=nb {
                        ra += H!(i, j) * H!(j, nb - 1);
                        sa += H!(i, j) * H!(j, nb);
                    }
                    wv = H!(i, i) - p;
                    if E!(i) < 0.0 {
                        z = wv;
                        r = ra;
                        s = sa;
                    } else {
                        l = i;
                        if E!(i) == 0.0 {
                            let (cr, ci) = cdiv(-ra, -sa, wv, q);
                            H!(i, nb - 1) = cr;
                            H!(i, nb) = ci;
                        } else {
                            x = H!(i, i + 1);
                            y = H!(i + 1, i);
                            let mut vr = (D!(i) - p) * (D!(i) - p) + E!(i) * E!(i) - q * q;
                            let vi = (D!(i) - p) * 2.0 * q;
                            if vr == 0.0 && vi == 0.0 {
                                vr = eps * norm * (abs(wv) + abs(q) + abs(x) + abs(y) + abs(z));
                            }
                            let (cr, ci) = cdiv(x * r - z * ra + q * sa, x * s - z * sa - q * ra, vr, vi);
                            H!(i, nb - 1) = cr;
                            H!(i, nb) = ci;
                            if abs(x) > abs(z) + abs(q) {
                                H!(i + 1, nb - 1) = (-ra - wv * H!(i, nb - 1) + q * H!(i, nb)) / x;
                                H!(i + 1, nb) = (-sa - wv * H!(i, nb) - q * H!(i, nb - 1)) / x;
                            } else {
                                let (cr, ci) = cdiv(-r - y * H!(i, nb - 1), -s - y * H!(i, nb), z, q);
                                H!(i + 1, nb - 1) = cr;
                                H!(i + 1, nb) = ci;
                            }
                        }
                        t = jsmax(abs(H!(i, nb - 1)), abs(H!(i, nb)));
                        if eps * t * t > 1.0 {
                            for j in i..=nb {
                                H!(j, nb - 1) /= t;
                                H!(j, nb) /= t;
                            }
                        }
                    }
                    i -= 1;
                }
            }
            big_n -= 1;
        }
        // back transformation: V[i][j] = sum over k <= j of V[i][k] H[k][j],
        // for all i at once (each sum still in order of k)
        let (lo, hi) = (low as usize, high as usize + 1);
        for j in (lo..n).rev() {
            for i in lo..hi {
                *tmp.add(i) = 0.0;
            }
            let kmax = if j < hi - 1 { j } else { hi - 1 };
            for k in lo..=kmax {
                axpy(tmp.add(lo), w.add(k * n + lo), h!(k, j), hi - lo);
            }
            for i in lo..hi {
                v!(i, j) = *tmp.add(i);
            }
        }
    }
    0
}

// ------------------------------------------------------------------ SVD

/// Golub-Kahan-Reinsch SVD of an m x n matrix, m >= n, as gkrSVD() in the
/// TS.  a: the matrix by columns (destroyed); u: n columns of length m;
/// v: n columns of length n; s: n + 1 doubles; e: n doubles; work: m
/// doubles.  Returns 0, or 1 if it did not converge.
#[no_mangle]
pub unsafe extern "C" fn dgesvd(a: *mut f64, m: usize, n: usize, u: *mut f64, v: *mut f64, s: *mut f64, e: *mut f64, work: *mut f64) -> i32 {
    macro_rules! A {
        ($r:expr, $c:expr) => {
            *a.add(($c) * m + ($r))
        };
    }
    macro_rules! U {
        ($r:expr, $c:expr) => {
            *u.add(($c) * m + ($r))
        };
    }
    macro_rules! V {
        ($r:expr, $c:expr) => {
            *v.add(($c) * n + ($r))
        };
    }
    macro_rules! S {
        ($i:expr) => {
            *s.add($i)
        };
    }
    macro_rules! E {
        ($i:expr) => {
            *e.add($i)
        };
    }
    let col = |p: *mut f64, len: usize, c: usize| p.add(c * len);
    let nu = if m < n { m } else { n };
    let nct = if m - 1 < n { m - 1 } else { n };
    let nrt = {
        let t = n as isize - 2;
        let t = if t < m as isize { t } else { m as isize };
        if t > 0 { t as usize } else { 0 }
    };
    for i in 0..=n {
        S!(i) = 0.0;
    }
    for i in 0..n {
        E!(i) = 0.0;
    }
    for i in 0..m * nu {
        *u.add(i) = 0.0;
    }
    for i in 0..n * n {
        *v.add(i) = 0.0;
    }
    let kmax = if nct > nrt { nct } else { nrt };
    for k in 0..kmax {
        let ak = col(a, m, k);
        if k < nct {
            S!(k) = nrm2(ak.add(k), m - k);
            if S!(k) != 0.0 {
                if A!(k, k) < 0.0 {
                    S!(k) = -S!(k);
                }
                let sk = S!(k);
                for i in k..m {
                    *ak.add(i) /= sk;
                }
                A!(k, k) += 1.0;
            }
            S!(k) = -S!(k);
        }
        for j in k + 1..n {
            if k < nct && S!(k) != 0.0 {
                let aj = col(a, m, j);
                let mut t = 0.0;
                for i in k..m {
                    t += *ak.add(i) * *aj.add(i);
                }
                t = -t / A!(k, k);
                axpy(aj.add(k), ak.add(k), t, m - k);
            }
            E!(j) = A!(k, j);
        }
        if k < nct {
            for i in k..m {
                U!(i, k) = A!(i, k);
            }
        }
        if k < nrt {
            E!(k) = nrm2(e.add(k + 1), n - k - 1);
            if E!(k) != 0.0 {
                if E!(k + 1) < 0.0 {
                    E!(k) = -E!(k);
                }
                let ek = E!(k);
                for i in k + 1..n {
                    E!(i) /= ek;
                }
                E!(k + 1) += 1.0;
            }
            E!(k) = -E!(k);
            if k + 1 < m && E!(k) != 0.0 {
                for i in k + 1..m {
                    *work.add(i) = 0.0;
                }
                for j in k + 1..n {
                    axpy(work.add(k + 1), col(a, m, j).add(k + 1), E!(j), m - k - 1);
                }
                for j in k + 1..n {
                    let t = -E!(j) / E!(k + 1);
                    axpy(col(a, m, j).add(k + 1), work.add(k + 1), t, m - k - 1);
                }
            }
            for i in k + 1..n {
                V!(i, k) = E!(i);
            }
        }
    }
    let mut p = if n < m + 1 { n } else { m + 1 };
    if nct < n {
        S!(nct) = A!(nct, nct);
    }
    if m < p {
        S!(p - 1) = 0.0;
    }
    if nrt + 1 < p {
        E!(nrt) = A!(nrt, p - 1);
    }
    E!(p - 1) = 0.0;
    for j in nct..nu {
        for i in 0..m {
            U!(i, j) = 0.0;
        }
        U!(j, j) = 1.0;
    }
    for k in (0..nct).rev() {
        let uk = col(u, m, k);
        if S!(k) != 0.0 {
            for j in k + 1..nu {
                let uj = col(u, m, j);
                let mut t = 0.0;
                for i in k..m {
                    t += *uk.add(i) * *uj.add(i);
                }
                t = -t / U!(k, k);
                axpy(uj.add(k), uk.add(k), t, m - k);
            }
            for i in k..m {
                U!(i, k) = -U!(i, k);
            }
            U!(k, k) = 1.0 + U!(k, k);
            if k >= 1 {
                for i in 0..k - 1 {
                    U!(i, k) = 0.0;
                }
            }
        } else {
            for i in 0..m {
                U!(i, k) = 0.0;
            }
            U!(k, k) = 1.0;
        }
    }
    for k in (0..n).rev() {
        if k < nrt && E!(k) != 0.0 {
            let vk = col(v, n, k);
            for j in k + 1..nu {
                let vj = col(v, n, j);
                let mut t = 0.0;
                for i in k + 1..n {
                    t += *vk.add(i) * *vj.add(i);
                }
                t = -t / V!(k + 1, k);
                axpy(vj.add(k + 1), vk.add(k + 1), t, n - k - 1);
            }
        }
        for i in 0..n {
            V!(i, k) = 0.0;
        }
        V!(k, k) = 1.0;
    }
    let pp = p - 1;
    let eps = f64::EPSILON;
    let tiny = f64::from_bits(((1023 - 966) as u64) << 52);
    let mut iter = 0usize;
    while p > 0 {
        let pi = p as isize;
        let mut k: isize = pi - 2;
        while k >= -1 {
            if k == -1 {
                break;
            }
            let ku = k as usize;
            if abs(E!(ku)) <= tiny + eps * (abs(S!(ku)) + abs(S!(ku + 1))) {
                E!(ku) = 0.0;
                break;
            }
            k -= 1;
        }
        let kase;
        if k == pi - 2 {
            kase = 4;
        } else {
            let mut ks: isize = pi - 1;
            while ks >= k {
                if ks == k {
                    break;
                }
                let ksu = ks as usize;
                let t = (if ks != pi { abs(E!(ksu)) } else { 0.0 }) + (if ks != k + 1 { abs(E!(ksu - 1)) } else { 0.0 });
                if abs(S!(ksu)) <= tiny + eps * t {
                    S!(ksu) = 0.0;
                    break;
                }
                ks -= 1;
            }
            if ks == k {
                kase = 3;
            } else if ks == pi - 1 {
                kase = 1;
            } else {
                kase = 2;
                k = ks;
            }
        }
        k += 1;
        let k = k as usize;
        iter += 1;
        if iter > 75 * n + 1000 {
            return 1;
        }
        if kase == 1 {
            let mut f = E!(p - 2);
            E!(p - 2) = 0.0;
            let mut j = p - 2;
            loop {
                let t = hypot(S!(j), f);
                let cs = S!(j) / t;
                let sn = f / t;
                S!(j) = t;
                if j != k {
                    f = -sn * E!(j - 1);
                    E!(j - 1) = cs * E!(j - 1);
                }
                rot(col(v, n, j), col(v, n, p - 1), n, cs, sn);
                if j == k {
                    break;
                }
                j -= 1;
            }
        } else if kase == 2 {
            let mut f = E!(k - 1);
            E!(k - 1) = 0.0;
            for j in k..p {
                let t = hypot(S!(j), f);
                let cs = S!(j) / t;
                let sn = f / t;
                S!(j) = t;
                f = -sn * E!(j);
                E!(j) = cs * E!(j);
                rot(col(u, m, j), col(u, m, k - 1), m, cs, sn);
            }
        } else if kase == 3 {
            let scale = jsmax(jsmax(jsmax(jsmax(abs(S!(p - 1)), abs(S!(p - 2))), abs(E!(p - 2))), abs(S!(k))), abs(E!(k)));
            let sp = S!(p - 1) / scale;
            let spm1 = S!(p - 2) / scale;
            let epm1 = E!(p - 2) / scale;
            let sk = S!(k) / scale;
            let ek = E!(k) / scale;
            let b = ((spm1 + sp) * (spm1 - sp) + epm1 * epm1) / 2.0;
            let c = sp * epm1 * (sp * epm1);
            let mut shift = 0.0;
            if b != 0.0 || c != 0.0 {
                shift = sqrt(b * b + c);
                if b < 0.0 {
                    shift = -shift;
                }
                shift = c / (b + shift);
            }
            let mut f = (sk + sp) * (sk - sp) + shift;
            let mut g = sk * ek;
            for j in k..p - 1 {
                let mut t = hypot(f, g);
                let mut cs = f / t;
                let mut sn = g / t;
                if j != k {
                    E!(j - 1) = t;
                }
                f = cs * S!(j) + sn * E!(j);
                E!(j) = cs * E!(j) - sn * S!(j);
                g = sn * S!(j + 1);
                S!(j + 1) = cs * S!(j + 1);
                rot(col(v, n, j), col(v, n, j + 1), n, cs, sn);
                t = hypot(f, g);
                cs = f / t;
                sn = g / t;
                S!(j) = t;
                f = cs * E!(j) + sn * S!(j + 1);
                S!(j + 1) = -sn * E!(j) + cs * S!(j + 1);
                g = sn * E!(j + 1);
                E!(j + 1) = cs * E!(j + 1);
                if j < m - 1 {
                    rot(col(u, m, j), col(u, m, j + 1), m, cs, sn);
                }
            }
            E!(p - 2) = f;
        } else {
            let mut k = k;
            if S!(k) <= 0.0 {
                S!(k) = if S!(k) < 0.0 { -S!(k) } else { 0.0 };
                for i in 0..=pp {
                    V!(i, k) = -V!(i, k);
                }
            }
            while k < pp {
                if S!(k) >= S!(k + 1) {
                    break;
                }
                let t = S!(k);
                S!(k) = S!(k + 1);
                S!(k + 1) = t;
                if k < n - 1 {
                    swap(col(v, n, k), col(v, n, k + 1), n);
                }
                if k < m - 1 {
                    swap(col(u, m, k), col(u, m, k + 1), m);
                }
                k += 1;
            }
            iter = 0;
            p -= 1;
        }
    }
    0
}
