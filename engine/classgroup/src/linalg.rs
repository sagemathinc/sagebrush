//! The relation lattice: structured Gaussian elimination of the sparse
//! relations, then a Hermite normal form modulo a multiple of its
//! determinant, and the Smith normal form (the group structure).

use crate::relations::Relation;
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};

pub enum Reduced {
    /// The remaining columns (indices into the factor base) and the dense
    /// rows over them.
    Core(Vec<usize>, Vec<Vec<i64>>),
    /// A column without relations: the lattice is not full rank yet.
    Deficient(usize),
}

/// Eliminate every column that has a +-1 entry in some row (the pivot row
/// is the lightest such row): Z^n / L does not change when a generator is
/// expressed through the others.  Large primes first.  Rows are sorted
/// sparse vectors; a pivot row longer than `max_weight` is not used.
pub fn eliminate(n: usize, rels: &[Relation], max_weight: usize) -> Reduced {
    eliminate_with(n, rels, max_weight, None).0
}

/// eliminate, applying the same row operations to a payload per relation
/// (e.g. logarithms of the elements, for real quadratic fields).  Also
/// returns the indices of the relations giving the core rows, in order, and
/// of those that became zero (kernel vectors: their payloads are units).
pub fn eliminate_with(n: usize, rels: &[Relation], max_weight: usize, payload: Option<&mut [Vec<BigInt>]>) -> (Reduced, Vec<usize>, Vec<usize>) {
    eliminate_tracked(n, rels, max_weight, payload, None)
}

/// eliminate_with, also carrying an upper bound on each payload's error:
/// when a row becomes r - f pivot, its bound becomes err(r) + |f| err(pivot)
/// (rounded up), so that the payloads of the result, exact integer
/// combinations of the inputs, have certified error bounds.
pub fn eliminate_tracked(n: usize, rels: &[Relation], max_weight: usize, mut payload: Option<&mut [Vec<BigInt>]>, mut errs: Option<&mut [f64]>) -> (Reduced, Vec<usize>, Vec<usize>) {
    let mut rows: Vec<Vec<(u32, i64)>> = rels.iter().map(|r| r.iter().map(|&(c, e)| (c as u32, e)).collect()).collect();
    let mut dead = vec![false; rows.len()];
    let mut alive = vec![true; n];
    let mut col_rows: Vec<Vec<u32>> = vec![vec![]; n];
    for (k, r) in rows.iter().enumerate() {
        for &(c, _) in r {
            col_rows[c as usize].push(k as u32);
        }
    }
    if let Some(c) = (0..n).find(|&c| col_rows[c].is_empty()) {
        return (Reduced::Deficient(c), vec![], vec![]);
    }
    let get = |r: &Vec<(u32, i64)>, c: u32| -> i64 { r.binary_search_by_key(&c, |x| x.0).map_or(0, |i| r[i].1) };
    let mut scratch: Vec<(u32, i64)> = vec![];
    let mut progress = true;
    while progress {
        progress = false;
        for c in (0..n).rev() {
            sagebrush_interrupt::check();
            if !alive[c] {
                continue;
            }
            let cu = c as u32;
            // live rows still containing c
            let mut list = std::mem::take(&mut col_rows[c]);
            list.sort_unstable();
            list.dedup();
            list.retain(|&k| !dead[k as usize] && get(&rows[k as usize], cu) != 0);
            let mut best: Option<(usize, u32)> = None;
            for &k in &list {
                let r = &rows[k as usize];
                if get(r, cu).unsigned_abs() == 1 && best.map_or(true, |(bw, _)| r.len() < bw) {
                    best = Some((r.len(), k));
                }
            }
            let Some((_, pk)) = best.filter(|&(w, _)| w <= max_weight) else {
                col_rows[c] = list;
                continue;
            };
            // entries stay far below 2^63: refuse a pivot whose multiples
            // could exceed 2^50
            let pmax = rows[pk as usize].iter().map(|x| x.1.unsigned_abs()).max().unwrap_or(0);
            let emax = list.iter().map(|&k| get(&rows[k as usize], cu).unsigned_abs()).max().unwrap_or(0);
            // and the entries they are subtracted from: r - f pivot stays
            // below 2^61 (the systematic review's LIN-F6: an entry near
            // i64::MIN wrapped around)
            let rmax = list.iter().flat_map(|&k| rows[k as usize].iter().map(|x| x.1.unsigned_abs())).max().unwrap_or(0);
            if pmax.saturating_mul(emax) > 1 << 50 || rmax > 1 << 60 {
                col_rows[c] = list;
                continue;
            }
            let pivot = std::mem::take(&mut rows[pk as usize]);
            dead[pk as usize] = true;
            let pc = get(&pivot, cu);
            for &k in &list {
                if k == pk {
                    continue;
                }
                let r = &rows[k as usize];
                let e = get(r, cu);
                if e == 0 {
                    continue;
                }
                let f = e * pc; // r -= f * pivot
                scratch.clear();
                let (mut i, mut j) = (0, 0);
                while i < r.len() || j < pivot.len() {
                    let take_r = j >= pivot.len() || (i < r.len() && r[i].0 < pivot[j].0);
                    let take_p = i >= r.len() || (j < pivot.len() && pivot[j].0 < r[i].0);
                    if take_r {
                        scratch.push(r[i]);
                        i += 1;
                    } else if take_p {
                        scratch.push((pivot[j].0, -f * pivot[j].1));
                        col_rows[pivot[j].0 as usize].push(k);
                        j += 1;
                    } else {
                        let v = r[i].1 - f * pivot[j].1;
                        if v != 0 {
                            scratch.push((r[i].0, v));
                        }
                        i += 1;
                        j += 1;
                    }
                }
                rows[k as usize].clear();
                rows[k as usize].extend_from_slice(&scratch);
                if let Some(pl) = payload.as_deref_mut() {
                    let delta: Vec<BigInt> = pl[pk as usize].iter().map(|x| x * f).collect();
                    for (y, d) in pl[k as usize].iter_mut().zip(delta) {
                        *y -= d;
                    }
                }
                if let Some(er) = errs.as_deref_mut() {
                    er[k as usize] = (er[k as usize] + (f.unsigned_abs() as f64) * er[pk as usize]) * (1.0 + 1e-15);
                }
            }
            alive[c] = false;
            progress = true;
        }
    }
    let cols: Vec<usize> = (0..n).filter(|&c| alive[c]).collect();
    let mut pos = vec![usize::MAX; n];
    for (i, &c) in cols.iter().enumerate() {
        pos[c] = i;
    }
    let mut dense = vec![];
    let (mut core_rows, mut zero_rows) = (vec![], vec![]);
    for (k, r) in rows.into_iter().enumerate() {
        if dead[k] {
            continue;
        }
        if r.is_empty() {
            zero_rows.push(k);
            continue;
        }
        core_rows.push(k);
        let mut v = vec![0i64; cols.len()];
        for (c, e) in r {
            v[pos[c as usize]] = e;
        }
        dense.push(v);
    }
    (Reduced::Core(cols, dense), core_rows, zero_rows)
}

/// The determinant of a square integer matrix (Bareiss, fraction-free).
pub fn det(m: &[Vec<BigInt>]) -> BigInt {
    let n = m.len();
    if n == 0 {
        return BigInt::one();
    }
    let mut a: Vec<Vec<BigInt>> = m.to_vec();
    let mut sign = BigInt::one();
    let mut prev = BigInt::one();
    for k in 0..n - 1 {
        sagebrush_interrupt::check();
        if a[k][k].is_zero() {
            let Some(i) = (k + 1..n).find(|&i| !a[i][k].is_zero()) else { return BigInt::zero() };
            a.swap(k, i);
            sign = -sign;
        }
        for i in k + 1..n {
            for j in k + 1..n {
                let v = (&a[i][j] * &a[k][k] - &a[i][k] * &a[k][j]) / &prev;
                a[i][j] = v;
            }
        }
        prev = a[k][k].clone();
    }
    sign * &a[n - 1][n - 1]
}

/// det(m) mod p for a square matrix (Gaussian elimination over F_p).
pub fn det_mod_p(m: &[Vec<i64>], p: u64) -> u64 {
    let n = m.len();
    assert!(p < 1 << 31 && (n as u128 + 1) * (p as u128) * (p as u128) < 1 << 64);
    let br = Barrett::new(p);
    // entries are reduced lazily: each step adds at most one product < p^2
    let mut a: Vec<Vec<u64>> = m.iter().map(|r| r.iter().map(|&x| x.rem_euclid(p as i64) as u64).collect()).collect();
    let mut pivot = vec![0u64; n];
    let mut det = 1u64;
    for k in 0..n {
        sagebrush_interrupt::check();
        for i in k..n {
            a[i][k] %= p;
        }
        let Some(piv) = (k..n).find(|&i| a[i][k] != 0) else { return 0 };
        if piv != k {
            a.swap(piv, k);
            det = (p - det) % p;
        }
        det = br.mul(det, a[k][k]);
        let inv = crate::arith::invmod(a[k][k], p);
        for j in k + 1..n {
            pivot[j] = a[k][j] % p;
        }
        let rk = &pivot[k + 1..];
        for i in k + 1..n {
            if a[i][k] == 0 {
                continue;
            }
            let f = p - br.mul(a[i][k], inv);
            for (x, &y) in a[i][k + 1..].iter_mut().zip(rk) {
                *x += f * y;
            }
        }
    }
    det
}

/// The largest prime size (bits, at most 31) for which det_mod_p of an
/// n x n matrix cannot overflow.
fn det_prime_bits(n: usize) -> u32 {
    let lg = 64 - (n as u64 + 1).leading_zeros();
    ((63 - lg) / 2).min(31)
}

/// Reduction modulo a prime p < 2^31 of x < 2^63 by one multiplication.
#[derive(Clone, Copy)]
struct Barrett {
    p: u64,
    m: u64, // floor(2^64 / p)
}

impl Barrett {
    fn new(p: u64) -> Self {
        Barrett { p, m: (u64::MAX / p) }
    }
    #[inline(always)]
    fn reduce(&self, x: u64) -> u64 {
        let q = ((x as u128 * self.m as u128) >> 64) as u64;
        let r = x - q * self.p;
        if r >= self.p { r - self.p } else { r }
    }
    #[inline(always)]
    fn mul(&self, a: u64, b: u64) -> u64 {
        self.reduce(a * b)
    }
}

/// The determinant of a square integer matrix, by CRT over 31-bit primes up
/// to the Hadamard bound.
pub fn det_crt(m: &[Vec<i64>]) -> BigInt {
    det_crt_impl(m, false)
}

/// The determinant by CRT, stopping early once the symmetric residue has
/// not changed for two more primes (actual determinants are usually far
/// below the Hadamard bound, so this is much cheaper).  A heuristic, not a
/// probability bound: the primes are a fixed sequence, so a determinant
/// divisible by the first ones fools it (the systematic review's LIN-F2:
/// the product of the first two primes came out 0).  Callers that need the
/// exact value use det_crt or check what they derive from it.
pub fn det_crt_probable(m: &[Vec<i64>]) -> BigInt {
    det_crt_impl(m, true)
}

fn det_crt_impl(m: &[Vec<i64>], early: bool) -> BigInt {
    let n = m.len();
    if n == 0 {
        return BigInt::one();
    }
    let log2_bound: f64 = m.iter().map(|r| 0.5 * r.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().log2().max(0.0)).sum::<f64>() + 2.0;
    let mut modulus = BigInt::one();
    let mut value = BigInt::zero(); // symmetric residue mod modulus
    let mut stable = 0;
    let mut p: u64 = (1 << det_prime_bits(n)) - 1;
    while (modulus.bits() as f64) < log2_bound && !(early && stable >= 2) {
        sagebrush_interrupt::check();
        while !crate::relations::is_prime_u64(p) {
            p -= 2;
        }
        let r = det_mod_p(m, p);
        let bp = BigInt::from(p);
        let vm = value.mod_floor(&bp).to_u64().unwrap();
        // (the first prime never counts as stable: the initial 0 agrees with
        // a residue 0 by accident)
        if vm == r && !modulus.is_one() {
            stable += 1;
        } else {
            stable = 0;
            // value += modulus * ((r - value) / modulus mod p)
            let mm = modulus.mod_floor(&bp).to_u64().unwrap();
            let t = crate::arith::mulmod((r + p - vm) % p, crate::arith::invmod(mm, p), p);
            value += &modulus * BigInt::from(t);
        }
        modulus *= &bp;
        if &value * 2 > modulus {
            value -= &modulus;
        }
        p -= 2;
    }
    value
}

/// det(A) and y = v adj(A) (so y A = det(A) v) modulo a prime p < 2^31,
/// for a square A and rows v: Gauss-Jordan on [A^T | V^T].
fn solve_mod_p(a: &[Vec<i64>], vs: &[Vec<i64>], p: u64) -> (u64, Vec<Vec<u64>>) {
    let n = a.len();
    let k = vs.len();
    let br = Barrett::new(p);
    let red = |x: i64| x.rem_euclid(p as i64) as u64;
    // m = [A^T | V^T], n x (n + k)
    let mut m: Vec<Vec<u64>> = (0..n).map(|i| (0..n).map(|j| red(a[j][i])).chain(vs.iter().map(|v| red(v[i]))).collect()).collect();
    let mut det = 1u64;
    for col in 0..n {
        sagebrush_interrupt::check();
        let Some(piv) = (col..n).find(|&i| m[i][col] != 0) else { return (0, vec![vec![0; n]; k]) };
        if piv != col {
            m.swap(piv, col);
            det = (p - det) % p;
        }
        det = br.mul(det, m[col][col]);
        let inv = crate::arith::invmod(m[col][col], p);
        for x in m[col].iter_mut() {
            *x = br.mul(*x, inv);
        }
        let pr = m[col].clone();
        for (i, row) in m.iter_mut().enumerate() {
            if i == col || row[col] == 0 {
                continue;
            }
            let f = p - row[col];
            for (x, &y) in row.iter_mut().zip(&pr) {
                *x = br.reduce(*x + f * y);
            }
        }
    }
    // A^T X = V^T: x_v = column n + t; y = det x
    let ys = (0..k).map(|t| (0..n).map(|i| br.mul(det, m[i][n + t])).collect()).collect();
    (det, ys)
}

/// det(A) and the integer vectors y_t = v_t adj(A) (y_t A = det(A) v_t),
/// by CRT over 31-bit primes, stopping once every value has been stable
/// for two primes, then checked exactly (y_t A = det v_t), else continued
/// to the Hadamard bound.  Primes dividing det(A) are skipped: modulo them
/// the solve gives no adjugate (the systematic review's LIN-F1: [[p]] with
/// p the second prime got a wrong y).  Each y_t with -det(A) e_v is a
/// kernel vector of the rows [A; v_t].
pub fn kernel_crt(a: &[Vec<i64>], vs: &[Vec<i64>]) -> (BigInt, Vec<Vec<BigInt>>) {
    let r = kernel_crt_impl(a, vs, true);
    if kernel_identity_holds(a, vs, &r) {
        return r;
    }
    kernel_crt_impl(a, vs, false)
}

/// y_t A = det v_t for every t, exactly.
fn kernel_identity_holds(a: &[Vec<i64>], vs: &[Vec<i64>], (det, ys): &(BigInt, Vec<Vec<BigInt>>)) -> bool {
    let n = a.len();
    let m = a.first().map_or(0, |r| r.len());
    ys.iter().zip(vs).all(|(y, v)| (0..m).all(|j| (0..n).map(|i| &y[i] * a[i][j]).sum::<BigInt>() == det * v[j]))
}

fn kernel_crt_impl(a: &[Vec<i64>], vs: &[Vec<i64>], early: bool) -> (BigInt, Vec<Vec<BigInt>>) {
    let n = a.len();
    let k = vs.len();
    // all values: det, then the y's
    let mut value: Vec<BigInt> = vec![BigInt::zero(); 1 + n * k];
    let mut modulus = BigInt::one();
    let mut stable = 0;
    let mut p: u64 = (1 << 31) - 1;
    let log2_bound: f64 = a.iter().chain(vs).map(|r| 0.5 * r.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().log2().max(0.0)).sum::<f64>() + 2.0;
    let mut skipped_bits = 0.0f64;
    while !(early && stable >= 2) && (modulus.bits() as f64) < log2_bound {
        sagebrush_interrupt::check();
        while !crate::relations::is_prime_u64(p) {
            p -= 2;
        }
        let (det, ys) = solve_mod_p(a, vs, p);
        if det == 0 {
            // p | det(A): no adjugate from this prime.  When the skipped
            // primes alone exceed the bound, det(A) = 0.
            skipped_bits += (p as f64).log2();
            if skipped_bits >= log2_bound {
                return (BigInt::zero(), vec![vec![BigInt::zero(); n]; k]);
            }
            p -= 2;
            continue;
        }
        let residues: Vec<u64> = std::iter::once(det).chain(ys.into_iter().flatten()).collect();
        let bp = BigInt::from(p);
        let mm = modulus.mod_floor(&bp).to_u64().unwrap();
        let minv = crate::arith::invmod(mm, p);
        let mut changed = modulus.is_one();
        let new_modulus = &modulus * &bp;
        for (v, &r) in value.iter_mut().zip(&residues) {
            let vm = v.mod_floor(&bp).to_u64().unwrap();
            if vm != r {
                changed = true;
                let t = crate::arith::mulmod((r + p - vm) % p, minv, p);
                *v += &modulus * BigInt::from(t);
            }
            if &*v * 2 > new_modulus {
                *v -= &new_modulus;
            }
        }
        stable = if changed { 0 } else { stable + 1 };
        modulus = new_modulus;
        p -= 2;
    }
    let det = value[0].clone();
    let ys = (0..k).map(|t| value[1 + t * n..1 + (t + 1) * n].to_vec()).collect();
    (det, ys)
}

/// n rows of `rows` that are linearly independent (greedy, modulo a
/// prime), or if there are none, the columns without a pivot (one way to
/// complete the rank).
pub fn independent_rows(rows: &[Vec<i64>], n: usize) -> Result<Vec<usize>, Vec<usize>> {
    const P: u64 = 2147483647; // 2^31 - 1: products fit in u64
    let mut basis: Vec<Option<Vec<u64>>> = vec![None; n]; // by pivot column, pivot = 1
    let mut chosen = vec![];
    let mut v = vec![0u64; n];
    for (k, r) in rows.iter().enumerate() {
        sagebrush_interrupt::check();
        for j in 0..n {
            v[j] = (r[j] as i128).rem_euclid(P as i128) as u64;
        }
        let mut piv = None;
        for j in 0..n {
            if v[j] == 0 {
                continue;
            }
            match &basis[j] {
                Some(b) => {
                    let f = P - v[j];
                    for t in j..n {
                        v[t] = (v[t] + f * b[t]) % P;
                    }
                }
                None => {
                    piv = Some(j);
                    break;
                }
            }
        }
        if let Some(j) = piv {
            let inv = crate::arith::invmod(v[j], P);
            let b: Vec<u64> = v.iter().map(|&x| x * inv % P).collect();
            basis[j] = Some(b);
            chosen.push(k);
            if chosen.len() == n {
                return Ok(chosen);
            }
        }
    }
    Err((0..n).filter(|&j| basis[j].is_none()).collect())
}

/// The Hermite normal form of the lattice spanned by `rows` and d Z^n (d a
/// multiple of the lattice's determinant): an upper triangular basis whose
/// diagonal product is the determinant.
pub fn hnf_mod(rows: &[Vec<i64>], n: usize, d0: &BigInt) -> Vec<Vec<BigInt>> {
    // w[i]: a row with w[i][i] the pivot, w[i][j] = 0 for j < i
    let mut d = d0.clone();
    let mut w: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| if i == j { d.clone() } else { BigInt::zero() }).collect()).collect();
    for (k, r) in rows.iter().enumerate() {
        sagebrush_interrupt::check();
        // the lattice so far has determinant prod w_ii, a multiple of the
        // final one: a smaller modulus (word-sized: finish in i128)
        if k % 16 == 15 {
            let delta: BigInt = (0..n).map(|i| if w[i][i].is_zero() { d.clone() } else { w[i][i].clone() }).product();
            if delta < d {
                d = delta;
                for row in w.iter_mut() {
                    for x in row.iter_mut() {
                        *x = x.mod_floor(&d);
                    }
                }
                for i in 0..n {
                    if w[i][i].is_zero() {
                        w[i][i] = d.clone();
                    }
                }
                if d < BigInt::from(1u64 << 62) {
                    let dd: i128 = num_traits::ToPrimitive::to_i128(&d).unwrap();
                    let mut rest: Vec<Vec<i64>> = w.iter().map(|row| row.iter().map(|x| num_traits::ToPrimitive::to_i64(x).unwrap()).collect()).collect();
                    rest.extend(rows[k..].iter().cloned());
                    return hnf_mod_small(&rest, n, dd).into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect();
                }
            }
        }
        let mut v: Vec<BigInt> = r.iter().map(|&x| BigInt::from(x).mod_floor(&d)).collect();
        for i in 0..n {
            if v[i].is_zero() {
                continue;
            }
            let e = w[i][i].extended_gcd(&v[i]); // x w_ii + y v_i = g
            let g = e.gcd.clone();
            let (wi, vi) = (&w[i][i] / &g, &v[i] / &g);
            // new w_i = x w_i + y v ; new v = wi_coef * v - vi_coef * w_i
            let mut nw: Vec<BigInt> = vec![BigInt::zero(); n];
            let mut nv: Vec<BigInt> = vec![BigInt::zero(); n];
            for j in i..n {
                nw[j] = (&e.x * &w[i][j] + &e.y * &v[j]).mod_floor(&d);
                nv[j] = (&wi * &v[j] - &vi * &w[i][j]).mod_floor(&d);
            }
            nw[i] = g.clone();
            w[i] = nw;
            v = nv;
            debug_assert!(v[i].is_zero());
        }
    }
    // make each diagonal entry a positive divisor of d
    for i in 0..n {
        if w[i][i].is_zero() {
            w[i][i] = d.clone();
        }
    }
    w
}

/// hnf_mod with a word-sized modulus d < 2^62.
pub fn hnf_mod_small(rows: &[Vec<i64>], n: usize, d: i128) -> Vec<Vec<i128>> {
    hnf_mod_small_until(rows, n, d, 0.0)
}

/// hnf_mod_small, stopping once the determinant (the diagonal product) is
/// at most `enough` (0: process every row).
pub fn hnf_mod_small_until(rows: &[Vec<i64>], n: usize, d: i128, enough: f64) -> Vec<Vec<i128>> {
    hnf_mod_until(rows, n, ModD::new(d as u64), enough).into_iter().map(|r| r.into_iter().map(|x| x as i128).collect()).collect()
}

/// Residues modulo d, in [0, d) (d itself is allowed as an HNF diagonal).
pub trait Modulus: Copy {
    type E: Copy + PartialEq + Into<u128>;
    fn d(&self) -> Self::E;
    /// x < 2^127, reduced
    fn from_u128(&self, x: u128) -> Self::E;
    fn add(&self, a: Self::E, b: Self::E) -> Self::E;
    fn mul(&self, a: Self::E, b: Self::E) -> Self::E;
}

/// The HNF of the lattice spanned by `rows` and d Z^n, by rows modulo d,
/// stopping once the diagonal product is at most `enough` (0: never).
pub fn hnf_mod_until<M: Modulus>(rows: &[Vec<i64>], n: usize, md: M, enough: f64) -> Vec<Vec<u128>> {
    let du = md.d();
    let d: u128 = du.into();
    let di = d as i128;
    let zero = md.from_u128(0);
    let mut w: Vec<Vec<M::E>> = (0..n).map(|i| (0..n).map(|j| if i == j { du } else { zero }).collect()).collect();
    let mut v = vec![zero; n];
    let neg = |x: M::E| -> M::E { md.from_u128((d - x.into()) % d) };
    for (k, r) in rows.iter().enumerate() {
        sagebrush_interrupt::check();
        if enough > 0.0 && k % 8 == 7 && k >= n {
            let delta: f64 = (0..n).map(|i| w[i][i].into() as f64).product();
            if delta <= enough {
                break;
            }
        }
        for j in 0..n {
            v[j] = md.from_u128((r[j] as i128).rem_euclid(di) as u128);
        }
        for i in 0..n {
            let vi: u128 = v[i].into();
            if vi == 0 {
                continue;
            }
            let wii: u128 = w[i][i].into();
            if vi % wii == 0 {
                // v -= (v_i / w_ii) w_i: no change to w
                let f = neg(md.from_u128(vi / wii));
                for j in i..n {
                    v[j] = md.add(v[j], md.mul(f, w[i][j]));
                }
                continue;
            }
            let (g, x, y) = crate::arith::xgcd(wii as i128, vi as i128);
            let wi = md.from_u128((wii as i128 / g) as u128);
            let nvi = neg(md.from_u128((vi as i128 / g) as u128));
            let (x, y) = (md.from_u128(x.rem_euclid(di) as u128), md.from_u128(y.rem_euclid(di) as u128));
            for j in i..n {
                let (a, b) = (w[i][j], v[j]);
                w[i][j] = md.add(md.mul(x, a), md.mul(y, b));
                v[j] = md.add(md.mul(wi, b), md.mul(nvi, a));
            }
            w[i][i] = md.from_u128(g as u128);
        }
    }
    w.into_iter().map(|r| r.into_iter().map(|x| x.into()).collect()).collect()
}

/// Arithmetic modulo d < 2^62 (any d), by Barrett reduction: with
/// k = bits(d) and mu = floor(2^2k / d), the quotient estimate
/// ((x >> (k-1)) mu) >> (k+1) is at most 2 too small.
#[derive(Clone, Copy)]
pub struct ModD {
    d: u64,
    mu: u64,
    k: u32,
}

impl ModD {
    pub fn new(d: u64) -> Self {
        assert!(d > 0 && d < 1 << 62);
        let k = 64 - d.leading_zeros();
        ModD { d, mu: ((1u128 << (2 * k)) / d as u128) as u64, k }
    }
}

impl Modulus for ModD {
    type E = u64;
    fn d(&self) -> u64 {
        self.d
    }
    #[inline(always)]
    fn from_u128(&self, x: u128) -> u64 {
        x as u64
    }
    #[inline(always)]
    fn add(&self, a: u64, b: u64) -> u64 {
        let s = a + b;
        if s >= self.d { s - self.d } else { s }
    }
    #[inline(always)]
    fn mul(&self, a: u64, b: u64) -> u64 {
        let x = a as u128 * b as u128;
        let q = (((x >> (self.k - 1)) as u64 as u128 * self.mu as u128) >> (self.k + 1)) as u64;
        let mut r = (x as u64).wrapping_sub(q.wrapping_mul(self.d));
        while r >= self.d {
            r -= self.d;
        }
        r
    }
}

/// The 256-bit product of two u128, as (high, low).
#[inline(always)]
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a0, a1) = (a as u64 as u128, a >> 64);
    let (b0, b1) = (b as u64 as u128, b >> 64);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
    ((p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64)), (p00 as u64 as u128) | (mid << 64))
}

/// Arithmetic modulo d < 2^126 (any d): Barrett as in ModD, with 256-bit
/// intermediate products.
#[derive(Clone, Copy)]
pub struct ModD128 {
    d: u128,
    mu: u128,
    k: u32,
}

impl ModD128 {
    pub fn new(d: u128) -> Self {
        assert!(d > 1 && d < 1 << 126);
        let k = 128 - d.leading_zeros();
        let mu = ((BigInt::one() << (2 * k)) / BigInt::from(d)).to_u128().unwrap();
        ModD128 { d, mu, k }
    }
}

impl Modulus for ModD128 {
    type E = u128;
    fn d(&self) -> u128 {
        self.d
    }
    #[inline(always)]
    fn from_u128(&self, x: u128) -> u128 {
        x
    }
    #[inline(always)]
    fn add(&self, a: u128, b: u128) -> u128 {
        let s = a + b;
        if s >= self.d { s - self.d } else { s }
    }
    #[inline(always)]
    fn mul(&self, a: u128, b: u128) -> u128 {
        let k = self.k;
        let (hi, lo) = mul_wide(a, b);
        // t = x >> (k - 1) < 2^(k+1)
        let t = if k == 1 { lo } else { (hi << (129 - k)) | (lo >> (k - 1)) };
        let (qh, ql) = mul_wide(t, self.mu);
        let q = (qh << (127 - k)) | (ql >> (k + 1));
        let mut r = lo.wrapping_sub(q.wrapping_mul(self.d));
        while r >= self.d {
            r -= self.d;
        }
        r
    }
}

/// The matrix of relations among the generators with HNF diagonal > 1,
/// after substituting away the others (each e_i with w_ii = 1 is minus a
/// combination of later generators).  `w` is a mod-d HNF whose lattice
/// contains d Z^n; the result has the same cokernel and is usually 1x1 to
/// 3x3, so Smith form is then cheap.
pub fn cokernel<M: Modulus>(w: &[Vec<u128>], md: M) -> Vec<Vec<BigInt>> {
    let n = w.len();
    let d: u128 = md.d().into();
    let big: Vec<usize> = (0..n).filter(|&i| w[i][i] != 1).collect();
    let mut out = vec![];
    for &k in &big {
        let mut r: Vec<M::E> = w[k].iter().map(|&x| md.from_u128(x % d)).collect();
        for i in k + 1..n {
            let ri: u128 = r[i].into();
            if ri == 0 || w[i][i] != 1 {
                continue;
            }
            let f = md.from_u128(d - ri);
            for j in i..n {
                r[j] = md.add(r[j], md.mul(f, md.from_u128(w[i][j])));
            }
        }
        // the diagonal entry itself (d when w_kk = d)
        out.push(big.iter().map(|&j| BigInt::from(if j == k { w[k][k] } else { r[j].into() })).collect());
    }
    out
}

/// cokernel for a word-sized modulus.
pub fn cokernel_small(w: &[Vec<i128>], d: i128) -> Vec<Vec<BigInt>> {
    let w: Vec<Vec<u128>> = w.iter().map(|r| r.iter().map(|&x| x as u128).collect()).collect();
    cokernel(&w, ModD::new(d as u64))
}

/// The Smith normal form invariants (> 1) of a square nonsingular matrix,
/// d_1 | d_2 | ..., as Magma and PARI list them (largest first).
pub fn smith(m: &[Vec<BigInt>]) -> Vec<BigInt> {
    let n = m.len();
    let mut a: Vec<Vec<BigInt>> = m.to_vec();
    let mut diag = vec![];
    for t in 0..n {
        loop {
            // the smallest nonzero entry of the remaining block as pivot
            let mut best: Option<(usize, usize)> = None;
            for i in t..n {
                for j in t..n {
                    if !a[i][j].is_zero() && best.map_or(true, |(bi, bj)| a[i][j].abs() < a[bi][bj].abs()) {
                        best = Some((i, j));
                    }
                }
            }
            let Some((bi, bj)) = best else {
                diag.push(BigInt::zero());
                break;
            };
            a.swap(t, bi);
            for row in a.iter_mut() {
                row.swap(t, bj);
            }
            let p = a[t][t].clone();
            let mut clean = true;
            for i in t + 1..n {
                let q = a[i][t].div_floor(&p);
                if !q.is_zero() {
                    for j in t..n {
                        let v = &a[t][j] * &q;
                        a[i][j] -= v;
                    }
                }
                if !a[i][t].is_zero() {
                    clean = false;
                }
            }
            for j in t + 1..n {
                let q = a[t][j].div_floor(&p);
                if !q.is_zero() {
                    for i in t..n {
                        let v = &a[i][t] * &q;
                        a[i][j] -= v;
                    }
                }
                if !a[t][j].is_zero() {
                    clean = false;
                }
            }
            if !clean {
                continue;
            }
            // p must divide the rest of the block
            let mut bad = None;
            'f: for i in t + 1..n {
                for j in t + 1..n {
                    if !(&a[i][j] % &p).is_zero() {
                        bad = Some(i);
                        break 'f;
                    }
                }
            }
            if let Some(i) = bad {
                for j in t..n {
                    let v = a[i][j].clone();
                    a[t][j] += v;
                }
                continue;
            }
            diag.push(p.abs());
            break;
        }
    }
    let mut out: Vec<BigInt> = diag.into_iter().filter(|d| !d.is_one()).collect();
    out.sort();
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn crt_review_counterexamples() {
        use super::*;
        // LIN-F1: the second prime divides det [[p]]: y = adj = [1]
        let (d, ys) = kernel_crt(&[vec![2147483629]], &[vec![1]]);
        assert_eq!((d, ys), (BigInt::from(2147483629i64), vec![vec![BigInt::one()]]));
        // the product of the first two primes as a 1 x 1 determinant
        let (d, ys) = kernel_crt(&[vec![2147483647i64 * 2147483629]], &[vec![3]]);
        assert_eq!(d, BigInt::from(2147483647i64 * 2147483629));
        assert_eq!(ys, vec![vec![BigInt::from(3)]]);
        // LIN-F2: the first two primes of det_crt_probable for a 1 x 1
        let x = 1073741789i64 * 1073741783;
        assert_eq!(det_crt(&[vec![x]]), BigInt::from(x));
        assert_ne!(det_crt_probable(&[vec![x]]), BigInt::zero());
        // LIN-F6: no wrapped entries
        if let Reduced::Core(_, dense) = eliminate(2, &[vec![(0, 1), (1, 2)], vec![(0, 1), (1, i64::MIN)]], 2) {
            assert!(dense.iter().flatten().all(|&v| v != 9223372036854775806), "{:?}", dense);
        }
    }

    use super::*;

    fn bm(v: &[&[i64]]) -> Vec<Vec<BigInt>> {
        v.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    #[test]
    fn barrett_128() {
        let mut x = 0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C835u128;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for bits in [2u32, 3, 40, 63, 64, 65, 100, 125, 126] {
            for _ in 0..200 {
                let d = (next() >> (128 - bits)).max(2) | (1 << (bits - 1)) >> 1;
                let d = d.max(2);
                if d >= 1 << 126 {
                    continue;
                }
                let md = ModD128::new(d);
                let (a, b) = (next() % d, next() % d);
                let want = (BigInt::from(a) * BigInt::from(b)) % BigInt::from(d);
                assert_eq!(BigInt::from(md.mul(a, b)), want, "{} * {} mod {}", a, b, d);
                assert_eq!(md.add(a, b), ((BigInt::from(a) + b) % d).to_u128().unwrap());
            }
        }
        // the HNF through the 128-bit path: Z^2 / <(2,0),(0,4)> with d = 2^100
        let w = hnf_mod_until(&[vec![2, 0], vec![0, 4], vec![2, 4]], 2, ModD128::new(1 << 100), 0.0);
        assert_eq!(smith(&cokernel(&w, ModD128::new(1 << 100))), vec![BigInt::from(4), BigInt::from(2)]);
    }

    #[test]
    fn kernel_vectors() {
        let a = vec![vec![2, 1, 0], vec![1, 3, 1], vec![0, 1, 4]];
        let vs = vec![vec![5, -2, 7], vec![1, 1, 1]];
        let (det, ys) = kernel_crt(&a, &vs);
        assert_eq!(det, BigInt::from(18));
        for (y, v) in ys.iter().zip(&vs) {
            for j in 0..3 {
                let lhs: BigInt = (0..3).map(|i| &y[i] * a[i][j]).sum();
                assert_eq!(lhs, &det * v[j]);
            }
        }
    }

    #[test]
    fn small_matrices() {
        assert_eq!(det(&bm(&[&[2, 0], &[0, 3]])), BigInt::from(6));
        assert_eq!(det(&bm(&[&[0, 1, 2], &[3, 4, 5], &[6, 7, 9]])), BigInt::from(-3));
        // Z^2 / <(2,0),(0,4)> = Z/4 x Z/2; <(2,0),(0,3)> = Z/6
        assert_eq!(smith(&bm(&[&[2, 0], &[0, 4]])), vec![BigInt::from(4), BigInt::from(2)]);
        assert_eq!(smith(&bm(&[&[2, 0], &[0, 3]])), vec![BigInt::from(6)]);
        assert_eq!(smith(&bm(&[&[4, 6], &[6, 4]])), vec![BigInt::from(10), BigInt::from(2)]);
        let w = hnf_mod(&[vec![2, 0], vec![0, 4], vec![2, 4]], 2, &BigInt::from(8));
        assert_eq!(&w[0][0] * &w[1][1], BigInt::from(8));
    }
}
