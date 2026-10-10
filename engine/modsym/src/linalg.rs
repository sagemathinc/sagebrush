//! Sparse elimination, Heilbronn matrices, and the characteristic
//! polynomial over GF(p) (p < 2^31 so products fit in u64).

use crate::par;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

fn powmod(mut b: u64, mut e: u64, m: u64) -> u64 {
    let mut r = 1u64;
    b %= m;
    while e > 0 {
        if e & 1 == 1 {
            r = r * b % m;
        }
        b = b * b % m;
        e >>= 1;
    }
    r
}

/// Echelonize sparse rows over m columns.  Returns the pivot rows (pivot
/// coefficient 1, pivot entry omitted) in creation order and, per column,
/// the index of the pivot row that eliminates it (u32::MAX if none).
/// A new row is reduced by eliminating pivot columns in creation order,
/// which only introduces columns of later pivots, so the loop terminates.
pub fn sparse_echelon(rows: &[Vec<(u32, u64)>], m: usize, p: u64) -> (Vec<(u32, Vec<(u32, u64)>)>, Vec<u32>) {
    let mut pivots: Vec<(u32, Vec<(u32, u64)>)> = vec![];
    let mut pivot_of = vec![u32::MAX; m];
    let mut acc = vec![0u64; m];
    let mut touched: Vec<u32> = vec![];
    let mut heap = BinaryHeap::new();
    for row in rows {
        for &(c, v) in row {
            if acc[c as usize] == 0 {
                touched.push(c);
            }
            acc[c as usize] = (acc[c as usize] + v) % p;
            if pivot_of[c as usize] != u32::MAX {
                heap.push(Reverse((pivot_of[c as usize], c)));
            }
        }
        while let Some(Reverse((t, c))) = heap.pop() {
            sagebrush_interrupt::check();
            let f = acc[c as usize];
            if f == 0 {
                continue;
            }
            acc[c as usize] = 0;
            for &(k, v) in &pivots[t as usize].1 {
                let k_us = k as usize;
                if acc[k_us] == 0 {
                    touched.push(k);
                    if pivot_of[k_us] != u32::MAX {
                        heap.push(Reverse((pivot_of[k_us], k)));
                    }
                }
                acc[k_us] = (acc[k_us] + p - f * v % p) % p;
            }
        }
        let mut entries: Vec<(u32, u64)> = vec![];
        touched.sort_unstable();
        touched.dedup();
        for &c in &touched {
            let v = acc[c as usize];
            if v != 0 {
                entries.push((c, v));
            }
            acc[c as usize] = 0;
        }
        touched.clear();
        if entries.is_empty() {
            continue;
        }
        let (pc, pv) = entries[0];
        let inv = powmod(pv, p - 2, p);
        let rest = entries[1..].iter().map(|&(c, v)| (c, v * inv % p)).collect();
        pivot_of[pc as usize] = pivots.len() as u32;
        pivots.push((pc, rest));
    }
    (pivots, pivot_of)
}

/// Hecke primes are below 2^30: Heilbronn entries are at most q, so with
/// N <= 2^31 the products c a + d c' in the symbol action fit in an i64.
pub const MAX_HECKE_PRIME: u64 = 1 << 30;

pub fn check_hecke_prime(q: u64) -> Result<(), String> {
    if q >= MAX_HECKE_PRIME || !crate::exact::is_prime(q) {
        return Err(format!("q = {} must be a prime below 2^30", q));
    }
    Ok(())
}

pub fn heilbronn(q: i64) -> Vec<(i64, i64, i64, i64)> {
    assert!((2..MAX_HECKE_PRIME as i64).contains(&q), "Hecke prime {} out of range", q);
    if q == 2 {
        return vec![(1, 0, 0, 2), (2, 0, 0, 1), (2, 1, 0, 1), (1, 0, 1, 2)];
    }
    let mut out = vec![(1, 0, 0, q)];
    for r in -(q / 2)..=(q / 2) {
        let (mut x1, mut x2, mut y1, mut y2, mut a, mut b) = (q, -r, 0i64, 1i64, -q, r);
        out.push((x1, x2, y1, y2));
        while b != 0 {
            let mut qq = (a.abs() * 2 + b.abs()) / (2 * b.abs());
            if (a < 0) != (b < 0) {
                qq = -qq;
            }
            (a, b) = (-b, a - b * qq);
            (x1, x2) = (x2, qq * x2 - x1);
            (y1, y2) = (y2, qq * y2 - y1);
            out.push((x1, x2, y1, y2));
        }
    }
    out
}

/// Characteristic polynomial (low degree first) via Hessenberg form.
/// Each step applies all row operations, then the matching column
/// operations; the elementary transforms of one step commute, so this is
/// the same similarity transform as the one-at-a-time version.
pub fn charpoly(h: Vec<Vec<u64>>, p: u64) -> Vec<u64> {
    assert!(p < 1 << 31);
    let h: Vec<Vec<u32>> = h.into_iter().map(|r| r.into_iter().map(|x| x as u32).collect()).collect();
    charpoly_u32(h, p as u32)
}

// The leaf kernels are compiled twice, generic and with AVX2, and chosen at
// run time (closures run by rayon do not inherit #[target_feature]).
macro_rules! dispatch {
    ($name:ident, $generic:ident, ($($a:ident: $t:ty),*) -> $r:ty) => {
        #[inline]
        fn $name($($a: $t),*) -> $r {
            #[cfg(target_arch = "x86_64")]
            {
                #[target_feature(enable = "avx2")]
                unsafe fn avx2($($a: $t),*) -> $r {
                    $generic($($a),*)
                }
                if std::arch::is_x86_feature_detected!("avx2") {
                    // SAFETY: the CPU supports AVX2.
                    return unsafe { avx2($($a),*) };
                }
            }
            $generic($($a),*)
        }
    };
}
dispatch!(sub_mul, sub_mul_generic, (x: &mut [u32], y: &[u32], w: u32, ws: u32, p: u32) -> ());
dispatch!(dot_lazy, dot_lazy_generic, (y: &[u32], w: &[u32], ws: &[u32], p: u32) -> u64);
dispatch!(acc_mul, acc_mul_generic, (out: &mut [u64], y: &[u32], w: u32, ws: u32, p: u32) -> ());

/// x += w y elementwise mod p (w = p - u for x -= u y).
#[inline(always)]
fn sub_mul_generic(x: &mut [u32], y: &[u32], w: u32, ws: u32, p: u32) {
    for (x, &y) in x.iter_mut().zip(y) {
        let s = *x + reduce(mul_lazy(w, ws, y, p), p);
        *x = if s >= p { s - p } else { s };
    }
}

/// out += w y elementwise, each term in [0, 2p), without reduction.
#[inline(always)]
fn acc_mul_generic(out: &mut [u64], y: &[u32], w: u32, ws: u32, p: u32) {
    for (o, &y) in out.iter_mut().zip(y) {
        *o += mul_lazy(w, ws, y, p) as u64;
    }
}

/// Hessenberg reduction, then the Hessenberg recurrence.  Entries are u32
/// (p < 2^31) and every product w z mod p uses Shoup's precomputed
/// quotient floor(w 2^32 / p), so the inner loops are divisionless and
/// vectorize (four or eight lanes with AVX2).
fn charpoly_u32(mut h: Vec<Vec<u32>>, p: u32) -> Vec<u64> {
    let n = h.len();
    let pp = p as u64;
    for m in 1..n.saturating_sub(1) {
        sagebrush_interrupt::check();
        let Some(i) = (m..n).find(|&i| h[i][m - 1] != 0) else { continue };
        if i != m {
            h.swap(i, m);
            for row in h.iter_mut() {
                row.swap(i, m);
            }
        }
        let inv = powmod(h[m][m - 1] as u64, pp - 2, pp);
        let u: Vec<u32> = (0..n).map(|i| if i > m { (h[i][m - 1] as u64 * inv % pp) as u32 } else { 0 }).collect();
        let us: Vec<u32> = u.iter().map(|&w| shoup32(w, p)).collect();
        // Rows below m: row_i -= u_i row_m; columns before m - 1 are zero in both.
        let pivot = h[m][m - 1..].to_vec();
        par::for_each_chunk_mut(&mut h[m + 1..], 8, |c, rows| {
            for (k, row) in rows.iter_mut().enumerate() {
                let i = m + 1 + 8 * c + k;
                if u[i] != 0 {
                    let w = p - u[i];
                    sub_mul(&mut row[m - 1..], &pivot, w, shoup32(w, p), p);
                }
            }
        });
        // Column m += sum_{i > m} u_i column_i: a dot product per row.
        let (uu, ss) = (&u[m + 1..], &us[m + 1..]);
        par::for_each_chunk_mut(&mut h, 8, |_, rows| {
            for row in rows {
                row[m] = ((row[m] as u64 + dot_lazy(&row[m + 1..], uu, ss, p)) % pp) as u32;
            }
        });
    }
    // polys[k] = charpoly of the leading k x k block:
    // polys[m] = x polys[m-1] - sum_j coef_j polys[j].
    let mut polys: Vec<Vec<u32>> = vec![vec![1]];
    for m in 1..=n {
        sagebrush_interrupt::check();
        let mut terms: Vec<(usize, u32)> = vec![(m - 1, h[m - 1][m - 1])];
        let mut t = 1u64;
        for i in 1..m {
            t = t * h[m - i][m - i - 1] as u64 % pp;
            terms.push((m - i - 1, (t * h[m - i - 1][m - 1] as u64 % pp) as u32));
        }
        terms.retain(|t| t.1 != 0);
        let mut acc = vec![0u64; m + 1];
        for k in 1..=m {
            acc[k] = polys[m - 1][k - 1] as u64;
        }
        let polys_ref = &polys;
        let chunk = 256;
        par::for_each_chunk_mut(&mut acc, chunk, |c, out| {
            let k0 = c * chunk;
            for &(j, coef) in &terms {
                let pj = &polys_ref[j];
                if pj.len() <= k0 {
                    continue;
                }
                let (w, end) = (p - coef, (pj.len() - k0).min(out.len()));
                acc_mul(&mut out[..end], &pj[k0..k0 + end], w, shoup32(w, p), p);
            }
        });
        polys.push(acc.into_iter().map(|x| (x % pp) as u32).collect());
    }
    polys.pop().unwrap().into_iter().map(|x| x as u64).collect()
}

/// floor(w 2^32 / p) for w < p.
#[inline(always)]
fn shoup32(w: u32, p: u32) -> u32 {
    (((w as u64) << 32) / p as u64) as u32
}

/// w y mod p, up to one extra p: the result is in [0, 2p).
#[inline(always)]
fn mul_lazy(w: u32, ws: u32, y: u32, p: u32) -> u32 {
    let q = ((ws as u64 * y as u64) >> 32) as u32;
    w.wrapping_mul(y).wrapping_sub(q.wrapping_mul(p))
}

#[inline(always)]
fn reduce(r: u32, p: u32) -> u32 {
    if r >= p { r - p } else { r }
}

/// sum_k w_k y_k, each term in [0, 2p), as u64 (no overflow below 2^32 terms).
#[inline(always)]
fn dot_lazy_generic(y: &[u32], w: &[u32], ws: &[u32], p: u32) -> u64 {
    let mut lanes = [0u64; 8];
    let k8 = y.len() / 8 * 8;
    for ((yc, wc), sc) in y[..k8].chunks_exact(8).zip(w[..k8].chunks_exact(8)).zip(ws[..k8].chunks_exact(8)) {
        for j in 0..8 {
            lanes[j] += mul_lazy(wc[j], sc[j], yc[j], p) as u64;
        }
    }
    let mut s: u64 = lanes.iter().sum();
    for k in k8..y.len() {
        s += mul_lazy(w[k], ws[k], y[k], p) as u64;
    }
    s
}

/// Reduced row echelon form mod p < 2^31, zero rows removed, and the pivot
/// columns.  Entries are u32 and row operations use the Shoup kernels
/// (AVX2 when available), in parallel over rows.
pub fn rref_mod(m: Vec<Vec<u64>>, p: u64) -> (Vec<Vec<u64>>, Vec<usize>) {
    assert!(p < 1 << 31);
    let p32 = p as u32;
    let mut a: Vec<Vec<u32>> = m.into_iter().map(|r| r.into_iter().map(|x| x as u32).collect()).collect();
    let cols = a.first().map_or(0, |r| r.len());
    let mut pivots = vec![];
    let mut r = 0;
    for c in 0..cols {
        if r == a.len() {
            break;
        }
        let Some(i) = (r..a.len()).find(|&i| a[i][c] != 0) else { continue };
        a.swap(r, i);
        // Scale the pivot row to 1; it is zero left of column c.
        let iv = powmod(a[r][c] as u64, p - 2, p);
        for x in a[r][c..].iter_mut() {
            *x = (*x as u64 * iv % p) as u32;
        }
        let pivot = a[r][c..].to_vec();
        par::for_each_chunk_mut(&mut a, 16, |ci, rows| {
            for (k, row) in rows.iter_mut().enumerate() {
                let f = row[c];
                if ci * 16 + k != r && f != 0 {
                    let w = p32 - f;
                    sub_mul(&mut row[c..], &pivot, w, shoup32(w, p32), p32);
                }
            }
        });
        pivots.push(c);
        r += 1;
    }
    a.truncate(r);
    (a.into_iter().map(|row| row.into_iter().map(|x| x as u64).collect()).collect(), pivots)
}

pub fn matmul(a: &[Vec<u64>], b: &[Vec<u64>], p: u64) -> Vec<Vec<u64>> {
    let n = b.first().map_or(0, |r| r.len());
    par::map_slice(a, |row| {
        let mut out = vec![0u64; n];
        for (k, &x) in row.iter().enumerate() {
            if x != 0 {
                for (o, &y) in out.iter_mut().zip(&b[k]) {
                    *o = (*o + x * y) % p;
                }
            }
        }
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: u64) -> impl FnMut() -> u64 {
        let mut x = seed | 1;
        move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        }
    }

    /// det(a) mod p by Gaussian elimination (an independent check).
    fn det(mut a: Vec<Vec<u64>>, p: u64) -> u64 {
        let n = a.len();
        let mut d = 1u64;
        for c in 0..n {
            let Some(r) = (c..n).find(|&r| a[r][c] != 0) else { return 0 };
            if r != c {
                a.swap(r, c);
                d = (p - d) % p;
            }
            d = (d as u128 * a[c][c] as u128 % p as u128) as u64;
            let inv = powmod(a[c][c], p - 2, p);
            for r in c + 1..n {
                let f = (a[r][c] as u128 * inv as u128 % p as u128) as u64;
                for k in c..n {
                    let s = (a[c][k] as u128 * f as u128 % p as u128) as u64;
                    a[r][k] = (a[r][k] + p - s) % p;
                }
            }
        }
        d
    }

    fn eval(f: &[u64], x: u64, p: u64) -> u64 {
        f.iter().rev().fold(0u64, |acc, &c| ((acc as u128 * x as u128 + c as u128) % p as u128) as u64)
    }

    /// charpoly(A)(x) = det(x I - A) at several points, for dense, sparse
    /// (pivot swaps and skipped steps) and block-diagonal matrices.
    #[test]
    fn charpoly_agrees_with_determinants() {
        let mut r = rng(7);
        for &p in &[3u64, 65537, 67108859, 2147483647] {
            for &n in &[0usize, 1, 2, 3, 5, 9, 17, 40, 70] {
                for density in [100u64, 30, 5] {
                    let mut a: Vec<Vec<u64>> = (0..n).map(|_| (0..n).map(|_| if r() % 100 < density { r() % p } else { 0 }).collect()).collect();
                    if density == 5 && n > 4 {
                        for i in 0..n / 2 {
                            for j in n / 2..n {
                                a[i][j] = 0;
                                a[j][i] = 0;
                            }
                        }
                    }
                    let f = charpoly(a.clone(), p);
                    assert_eq!(f.len(), n + 1);
                    assert_eq!(f[n], 1 % p);
                    for _ in 0..3 {
                        let x = r() % p;
                        let m: Vec<Vec<u64>> = (0..n).map(|i| (0..n).map(|j| ((if i == j { x } else { 0 }) + p - a[i][j]) % p).collect()).collect();
                        assert_eq!(eval(&f, x, p), det(m, p), "p={} n={} density={}", p, n, density);
                    }
                }
            }
        }
    }

    /// The AVX2 and portable kernels compute the same thing.
    #[test]
    fn kernels_agree_with_portable_versions() {
        let mut r = rng(11);
        for &p in &[3u32, 65537, 2147483647] {
            for len in 0..40 {
                let y: Vec<u32> = (0..len).map(|_| (r() % p as u64) as u32).collect();
                let w: Vec<u32> = (0..len).map(|_| (r() % p as u64) as u32).collect();
                let ws: Vec<u32> = w.iter().map(|&w| shoup32(w, p)).collect();
                let x0: Vec<u32> = (0..len).map(|_| (r() % p as u64) as u32).collect();
                let (w1, w1s) = (w.first().copied().unwrap_or(1 % p), shoup32(w.first().copied().unwrap_or(1 % p), p));
                let (mut a, mut b) = (x0.clone(), x0.clone());
                sub_mul(&mut a, &y, w1, w1s, p);
                sub_mul_generic(&mut b, &y, w1, w1s, p);
                assert_eq!(a, b);
                for (i, &v) in a.iter().enumerate() {
                    assert_eq!(v as u64, (x0[i] as u64 + w1 as u64 * y[i] as u64) % p as u64);
                }
                let d = dot_lazy(&y, &w, &ws, p);
                assert_eq!(d, dot_lazy_generic(&y, &w, &ws, p));
                let exact: u64 = y.iter().zip(&w).map(|(&y, &w)| w as u64 * y as u64 % p as u64).sum::<u64>() % p as u64;
                assert_eq!(d % p as u64, exact);
                let (mut c, mut e) = (vec![5u64; len], vec![5u64; len]);
                acc_mul(&mut c, &y, w1, w1s, p);
                acc_mul_generic(&mut e, &y, w1, w1s, p);
                assert_eq!(c, e);
            }
        }
    }
}
