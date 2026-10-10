//! Dense matrices over Z/p (p a word-size prime): reduced row echelon
//! form, rank, determinant, inverse, solving, nullspace, products and the
//! characteristic polynomial (Hessenberg reduction, H. Cohen, A Course in
//! Computational Algebraic Number Theory, Algorithm 2.2.9).  Row
//! operations multiply by a fixed scalar with Shoup's trick.

use crate::nmod::{mul_shoup, Modulus};

/// P A = L U modulo p: L lower triangular (the pivots on its diagonal),
/// U unit upper triangular, stored together in `a`; row i of P A is row
/// perm[i] of A.
#[derive(Clone, Debug)]
pub struct Lu {
    a: Mat,
    perm: Vec<usize>,
}

impl Lu {
    /// x with A x = b.
    pub fn solve_vec(&self, b: &[u64]) -> Vec<u64> {
        let n = self.a.rows;
        let m = self.a.m;
        let batch = batch_len(&m);
        let d = &self.a.d;
        let dot = |row: &[u64], v: &[u64]| -> u64 {
            let mut r = 0u64;
            for (ca, cb) in row.chunks(batch).zip(v.chunks(batch)) {
                let mut acc = 0u128;
                for (&x, &y) in ca.iter().zip(cb) {
                    acc += x as u128 * y as u128;
                }
                r = m.add(r, m.reduce_u128(acc));
            }
            r
        };
        let mut y = vec![0u64; n];
        for i in 0..n {
            let s = dot(&d[i * n..i * n + i], &y[..i]);
            let pv = d[i * n + i];
            y[i] = m.mul(m.sub(b[self.perm[i]], s), m.inv(pv).expect("singular"));
        }
        let mut x = vec![0u64; n];
        for i in (0..n).rev() {
            let s = dot(&d[i * n + i + 1..(i + 1) * n], &x[i + 1..]);
            x[i] = m.sub(y[i], s);
        }
        x
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mat {
    pub rows: usize,
    pub cols: usize,
    pub m: Modulus,
    /// Row-major entries, reduced mod p.
    pub d: Vec<u64>,
}

/// How many products of reduced residues fit in a u128 sum.
fn batch_len(m: &Modulus) -> usize {
    let sq = (m.n as u128 - 1) * (m.n as u128 - 1);
    if sq == 0 {
        usize::MAX
    } else {
        (u128::MAX / sq).min(1 << 30) as usize
    }
}

/// row[j] -= sum_t row[blk[t]] * src(t)[j] for j >= from: the products
/// summed in u128 (`batch` at a time), one reduction per entry.
#[inline]
fn update_row<'a, F: Fn(usize) -> &'a [u64]>(row: &mut [u64], from: usize, blk: &[usize], src: F, m: &Modulus, batch: usize, acc: &mut [u128]) {
    let len = row.len() - from;
    let acc = &mut acc[..len];
    let mut part: Option<Vec<u64>> = None;
    acc.iter_mut().for_each(|x| *x = 0);
    let mut cnt = 0;
    for (t, &ct) in blk.iter().enumerate() {
        let f = row[ct];
        if f == 0 {
            continue;
        }
        let s = &src(t)[from..];
        for (a, &y) in acc.iter_mut().zip(s) {
            *a += f as u128 * y as u128;
        }
        cnt += 1;
        if cnt == batch {
            let p = part.get_or_insert_with(|| vec![0u64; len]);
            for (q, a) in p.iter_mut().zip(acc.iter_mut()) {
                *q = m.add(*q, m.reduce_u128(*a));
                *a = 0;
            }
            cnt = 0;
        }
    }
    let tail = &mut row[from..];
    match part {
        None => {
            for (x, &a) in tail.iter_mut().zip(acc.iter()) {
                *x = m.sub(*x, m.reduce_u128(a));
            }
        }
        Some(p) => {
            for ((x, &a), &q) in tail.iter_mut().zip(acc.iter()).zip(&p) {
                *x = m.sub(*x, m.add(q, m.reduce_u128(a)));
            }
        }
    }
}

/// dst += c * src (mod p), c reduced.
#[inline]
fn axpy(dst: &mut [u64], src: &[u64], c: u64, m: &Modulus) {
    if c == 0 {
        return;
    }
    if m.n < 1 << 63 {
        let cp = m.shoup(c);
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = m.add(*x, mul_shoup(y, c, cp, m.n));
        }
    } else {
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = m.add(*x, m.mul(y, c));
        }
    }
}

#[inline]
fn scale(v: &mut [u64], c: u64, m: &Modulus) {
    if m.n < 1 << 63 {
        let cp = m.shoup(c);
        for x in v.iter_mut() {
            *x = mul_shoup(*x, c, cp, m.n);
        }
    } else {
        for x in v.iter_mut() {
            *x = m.mul(*x, c);
        }
    }
}

impl Mat {
    pub fn zero(rows: usize, cols: usize, m: Modulus) -> Mat {
        Mat { rows, cols, m, d: vec![0; rows * cols] }
    }

    pub fn identity(n: usize, m: Modulus) -> Mat {
        let mut a = Mat::zero(n, n, m);
        for i in 0..n {
            a.d[i * n + i] = 1 % m.n;
        }
        a
    }

    pub fn from_rows(rows: &[Vec<u64>], m: Modulus) -> Mat {
        let r = rows.len();
        let c = rows.first().map_or(0, |x| x.len());
        Mat { rows: r, cols: c, m, d: rows.iter().flat_map(|row| row.iter().map(|&x| m.reduce(x))).collect() }
    }

    #[inline]
    pub fn get(&self, i: usize, j: usize) -> u64 {
        self.d[i * self.cols + j]
    }

    #[inline]
    pub fn set(&mut self, i: usize, j: usize, x: u64) {
        self.d[i * self.cols + j] = x;
    }

    pub fn row(&self, i: usize) -> &[u64] {
        &self.d[i * self.cols..(i + 1) * self.cols]
    }

    fn swap_rows(&mut self, i: usize, j: usize) {
        if i != j {
            let c = self.cols;
            for k in 0..c {
                self.d.swap(i * c + k, j * c + k);
            }
        }
    }

    /// Two distinct rows, the first mutable.
    fn rows2(&mut self, i: usize, j: usize) -> (&mut [u64], &[u64]) {
        let c = self.cols;
        if i < j {
            let (a, b) = self.d.split_at_mut(j * c);
            (&mut a[i * c..(i + 1) * c], &b[..c])
        } else {
            let (a, b) = self.d.split_at_mut(i * c);
            (&mut b[..c], &a[j * c..(j + 1) * c])
        }
    }

    /// Reduce to reduced row echelon form in place; the pivot columns.
    pub fn rref(&mut self) -> Vec<usize> {
        let (piv, _) = self.echelon(true, false);
        piv
    }

    pub fn rank(&self) -> usize {
        self.clone().echelon(false, false).0.len()
    }

    pub fn det(&self) -> u64 {
        assert_eq!(self.rows, self.cols, "determinant of a non-square matrix");
        let (piv, d) = self.clone().echelon(false, true);
        if piv.len() < self.rows {
            0
        } else {
            d
        }
    }

    /// Gaussian elimination with delayed updates: pivots are collected in
    /// blocks of up to BLOCK, and the rows below are brought up to date
    /// one column at a time (to find the next pivot) and then all at once
    /// when the block is full, summing the block's products in u128 with
    /// one reduction per entry (a matrix-product shape, which also keeps
    /// the rows in cache).  Pivot rows end normalized to 1 at the pivot.
    /// With `reduced`, back substitution gives the reduced form, again as
    /// products: R_i = U_i - sum_{t > i} U_i[c_t] R_t.  Returns the pivot
    /// columns and the product of the pivots times the sign of the row
    /// permutation (the determinant, for a square matrix of full rank;
    /// computed only if `want_det`).
    pub fn echelon(&mut self, reduced: bool, want_det: bool) -> (Vec<usize>, u64) {
        self.echelon_impl(reduced, want_det, None)
    }

    /// An LU factorization of a square matrix, if it is nonsingular.
    pub fn lu(&self) -> Option<Lu> {
        assert_eq!(self.rows, self.cols);
        let n = self.rows;
        let mut a = self.clone();
        let mut perm: Vec<usize> = (0..n).collect();
        let (piv, _) = a.echelon_impl(false, false, Some((&mut perm, &mut vec![])));
        if piv.len() < n {
            return None;
        }
        Some(Lu { a, perm })
    }

    /// With `lu` = Some((perm, _)): keep the multipliers below the pivots
    /// (L, with the pivot values on its diagonal) and record the row
    /// permutation, for a square matrix.
    fn echelon_impl(&mut self, reduced: bool, want_det: bool, mut lu: Option<(&mut Vec<usize>, &mut Vec<u64>)>) -> (Vec<usize>, u64) {
        const BLOCK: usize = 16;
        let keep = lu.is_some();
        let m = self.m;
        let (rows, cols) = (self.rows, self.cols);
        let batch = batch_len(&m);
        let mut pivots: Vec<usize> = vec![];
        let mut det = 1 % m.n;
        let mut r = 0;
        let mut block_start = 0; // first pivot row of the pending block
        let mut col = 0;
        let mut acc = vec![0u128; cols];
        while col < cols && r < rows {
            let blk = &pivots[block_start..];
            // column col of the rows below, up to date with the block
            if !blk.is_empty() {
                for i in r..rows {
                    let mut s = 0u128;
                    let mut red = 0u64;
                    for (t, &ct) in blk.iter().enumerate() {
                        let f = self.d[i * cols + ct];
                        s += f as u128 * self.d[(block_start + t) * cols + col] as u128;
                        if (t + 1) % batch == 0 {
                            red = m.add(red, m.reduce_u128(s));
                            s = 0;
                        }
                    }
                    let red = m.add(red, m.reduce_u128(s));
                    self.d[i * cols + col] = m.sub(self.d[i * cols + col], red);
                }
            }
            let Some(pr) = (r..rows).find(|&i| self.d[i * cols + col] != 0) else {
                col += 1;
                continue;
            };
            if pr != r {
                self.swap_rows(r, pr);
                det = m.neg(det);
                if let Some((perm, _)) = lu.as_mut() {
                    perm.swap(r, pr);
                }
            }
            // the pivot row, up to date for the columns after col
            if !blk.is_empty() {
                let (head, tail) = self.d.split_at_mut(r * cols);
                let row = &mut tail[..cols];
                update_row(row, col + 1, blk, |t| &head[(block_start + t) * cols..(block_start + t + 1) * cols], &m, batch, &mut acc);
                if !keep {
                    for &ct in blk {
                        row[ct] = 0;
                    }
                }
            }
            let pv = self.d[r * cols + col];
            if want_det {
                det = m.mul(det, pv);
            }
            let inv = m.inv(pv).expect("modulus not prime");
            scale(&mut self.d[r * cols + col + 1..(r + 1) * cols], inv, &m);
            // the pivot value stays (as L's diagonal) when keeping L
            self.d[r * cols + col] = if keep { pv } else { 1 % m.n };
            pivots.push(col);
            r += 1;
            col += 1;
            if pivots.len() - block_start == BLOCK {
                self.flush(block_start, &pivots[block_start..], r, col, batch, &mut acc, keep);
                block_start = pivots.len();
                sagebrush_interrupt::check();
            }
        }
        if pivots.len() > block_start {
            let blk = pivots[block_start..].to_vec();
            self.flush(block_start, &blk, r, col, batch, &mut acc, keep);
        }
        // rows r.. are zero (every column was processed or no rows remain)
        if !keep {
            for x in self.d[r * cols..].iter_mut() {
                *x = 0;
            }
        }
        if reduced {
            self.back_substitute(&pivots, batch, &mut acc);
        }
        (pivots, det)
    }

    /// The rows below the block (from row `below`) up to date with the
    /// block's pivots in the columns from `from`, and zero in the block's
    /// pivot columns.
    fn flush(&mut self, start: usize, blk: &[usize], below: usize, from: usize, batch: usize, acc: &mut [u128], keep: bool) {
        let cols = self.cols;
        let m = self.m;
        let (head, tail) = self.d.split_at_mut(below * cols);
        for row in tail.chunks_exact_mut(cols) {
            if blk.iter().all(|&ct| row[ct] == 0) {
                continue;
            }
            update_row(row, from, blk, |t| &head[(start + t) * cols..(start + t + 1) * cols], &m, batch, acc);
            if !keep {
                for &ct in blk {
                    row[ct] = 0;
                }
            }
        }
    }

    /// From the echelon form with normalized pivot rows to the reduced
    /// form: R_i = U_i - sum_{t > i} U_i[c_t] R_t, bottom up.
    fn back_substitute(&mut self, piv: &[usize], batch: usize, acc: &mut [u128]) {
        let cols = self.cols;
        let m = self.m;
        let k = piv.len();
        for i in (0..k).rev() {
            let later = &piv[i + 1..];
            if later.is_empty() || later.iter().all(|&ct| self.d[i * cols + ct] == 0) {
                continue;
            }
            let (head, tail) = self.d.split_at_mut((i + 1) * cols);
            let row = &mut head[i * cols..];
            update_row(row, piv[i] + 1, later, |t| &tail[t * cols..(t + 1) * cols], &m, batch, acc);
            for &ct in later {
                row[ct] = 0;
            }
            if i % 16 == 0 {
                sagebrush_interrupt::check();
            }
        }
    }

    /// [self | other] (same number of rows).
    pub fn augment(&self, other: &Mat) -> Mat {
        assert_eq!(self.rows, other.rows);
        let cols = self.cols + other.cols;
        let mut d = Vec::with_capacity(self.rows * cols);
        for i in 0..self.rows {
            d.extend_from_slice(self.row(i));
            d.extend_from_slice(other.row(i));
        }
        Mat { rows: self.rows, cols, m: self.m, d }
    }

    /// Columns lo..hi.
    pub fn columns(&self, lo: usize, hi: usize) -> Mat {
        let mut d = Vec::with_capacity(self.rows * (hi - lo));
        for i in 0..self.rows {
            d.extend_from_slice(&self.row(i)[lo..hi]);
        }
        Mat { rows: self.rows, cols: hi - lo, m: self.m, d }
    }

    /// X with self X = b, for self square and nonsingular; None if singular.
    pub fn solve(&self, b: &Mat) -> Option<Mat> {
        assert_eq!(self.rows, self.cols);
        let n = self.rows;
        let mut a = self.augment(b);
        let piv = a.rref();
        // (n = 0: the empty solution; piv[n - 1] would panic)
        if n > 0 && (piv.len() < n || piv[n - 1] != n - 1) {
            return None;
        }
        Some(a.columns(n, a.cols))
    }

    pub fn inverse(&self) -> Option<Mat> {
        self.solve(&Mat::identity(self.rows, self.m))
    }

    /// A basis of the right kernel {x : self x = 0}, as the rows of the result.
    pub fn nullspace(&self) -> Mat {
        let mut a = self.clone();
        let piv = a.rref();
        let free: Vec<usize> = (0..self.cols).filter(|c| !piv.contains(c)).collect();
        let mut k = Mat::zero(free.len(), self.cols, self.m);
        for (t, &f) in free.iter().enumerate() {
            k.set(t, f, 1 % self.m.n);
            for (i, &pc) in piv.iter().enumerate() {
                k.set(t, pc, self.m.neg(a.get(i, f)));
            }
        }
        k
    }

    pub fn transpose(&self) -> Mat {
        let mut t = Mat::zero(self.cols, self.rows, self.m);
        for i in 0..self.rows {
            for j in 0..self.cols {
                t.d[j * self.rows + i] = self.d[i * self.cols + j];
            }
        }
        t
    }

    pub fn mul(&self, o: &Mat) -> Mat {
        assert_eq!(self.cols, o.rows);
        let m = self.m;
        let bt = o.transpose();
        let sq = (m.n as u128 - 1) * (m.n as u128 - 1);
        let batch = if sq == 0 { usize::MAX } else { (u128::MAX / sq).min(1 << 30) as usize };
        let mut c = Mat::zero(self.rows, o.cols, m);
        for i in 0..self.rows {
            let a = self.row(i);
            for j in 0..o.cols {
                let b = bt.row(j);
                let mut r = 0u64;
                for (ca, cb) in a.chunks(batch).zip(b.chunks(batch)) {
                    let mut acc = 0u128;
                    for (&x, &y) in ca.iter().zip(cb) {
                        acc += x as u128 * y as u128;
                    }
                    r = m.add(r, m.reduce_u128(acc));
                }
                c.d[i * o.cols + j] = r;
            }
            if i % 16 == 15 {
                sagebrush_interrupt::check();
            }
        }
        c
    }

    /// self * v for a vector v (dot products summed in u128).
    pub fn mul_vec(&self, v: &[u64]) -> Vec<u64> {
        let m = self.m;
        let batch = batch_len(&m);
        (0..self.rows)
            .map(|i| {
                let mut r = 0u64;
                for (ca, cb) in self.row(i).chunks(batch).zip(v.chunks(batch)) {
                    let mut acc = 0u128;
                    for (&x, &y) in ca.iter().zip(cb) {
                        acc += x as u128 * y as u128;
                    }
                    r = m.add(r, m.reduce_u128(acc));
                }
                r
            })
            .collect()
    }

    /// The characteristic polynomial det(x I - self), constant term first.
    /// By the Krylov sequence of a pseudo-random vector when it spans
    /// (then the minimal polynomial of the vector has degree n and is the
    /// characteristic polynomial: matrix-vector products and one
    /// elimination), else by Hessenberg reduction.
    pub fn charpoly(&self) -> Vec<u64> {
        assert_eq!(self.rows, self.cols);
        if let Some(c) = self.charpoly_krylov() {
            return c;
        }
        self.charpoly_hessenberg()
    }

    fn charpoly_krylov(&self) -> Option<Vec<u64>> {
        let n = self.rows;
        let m = self.m;
        if n == 0 || m.n < 1 << 20 {
            return None;
        }
        let mut seed = 0x9e3779b97f4a7c15u64 ^ m.n;
        let mut v: Vec<u64> = (0..n)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                m.reduce(seed)
            })
            .collect();
        // S has columns v, Av, ..., A^n v
        let mut s = Mat::zero(n, n + 1, m);
        for i in 0..=n {
            for j in 0..n {
                s.d[j * (n + 1) + i] = v[j];
            }
            if i < n {
                v = self.mul_vec(&v);
            }
            if i % 32 == 31 {
                sagebrush_interrupt::check();
            }
        }
        let piv = s.rref();
        if piv.len() != n || piv[n - 1] != n - 1 {
            return None;
        }
        // A^n v = sum c_i A^i v: the charpoly is x^n - sum c_i x^i
        let mut c: Vec<u64> = (0..n).map(|i| m.neg(s.d[i * (n + 1) + n])).collect();
        c.push(1 % m.n);
        Some(c)
    }

    /// The characteristic polynomial by Hessenberg reduction.
    pub fn charpoly_hessenberg(&self) -> Vec<u64> {
        assert_eq!(self.rows, self.cols);
        let m = self.m;
        let n = self.rows;
        let mut h = self.clone();
        // Hessenberg form by similarity transformations
        for k in 1..n.saturating_sub(1) {
            let Some(i) = (k..n).find(|&i| h.get(i, k - 1) != 0) else { continue };
            if i != k {
                h.swap_rows(i, k);
                for r in 0..n {
                    h.d.swap(r * n + i, r * n + k);
                }
            }
            let tinv = m.inv(h.get(k, k - 1)).expect("modulus not prime");
            // H <- L^-1 H L with L = I + sum_i u_i e_i e_k^T: the elementary
            // factors commute, so all the row operations, then column k +=
            // sum_i u_i column_i as one dot product per row
            let us: Vec<u64> = (k + 1..n).map(|i| m.mul(h.get(i, k - 1), tinv)).collect();
            for (t, &u) in us.iter().enumerate() {
                if u != 0 {
                    let (dst, src) = h.rows2(k + 1 + t, k);
                    axpy(&mut dst[k - 1..], &src[k - 1..], m.neg(u), &m);
                }
            }
            if us.iter().any(|&u| u != 0) {
                let batch = batch_len(&m);
                for r in 0..n {
                    let row = &h.d[r * n + k + 1..(r + 1) * n];
                    let mut add = 0u64;
                    for (ca, cb) in row.chunks(batch).zip(us.chunks(batch)) {
                        let mut acc = 0u128;
                        for (&x, &y) in ca.iter().zip(cb) {
                            acc += x as u128 * y as u128;
                        }
                        add = m.add(add, m.reduce_u128(acc));
                    }
                    h.d[r * n + k] = m.add(h.d[r * n + k], add);
                }
            }
            if k % 16 == 15 {
                sagebrush_interrupt::check();
            }
        }
        // p_{k+1} = (x - h_kk) p_k - sum_i (prod_j h_{j,j-1}) h_{k-i,k} p_{k-i}
        let mut p: Vec<Vec<u64>> = vec![vec![1 % m.n]];
        for k in 0..n {
            let mut next = vec![0u64; k + 2];
            for (j, &c) in p[k].iter().enumerate() {
                next[j + 1] = m.add(next[j + 1], c);
                next[j] = m.sub(next[j], m.mul(h.get(k, k), c));
            }
            let mut t = 1 % m.n;
            for i in 1..=k {
                t = m.mul(t, h.get(k - i + 1, k - i));
                if t == 0 {
                    break;
                }
                let f = m.mul(t, h.get(k - i, k));
                if f != 0 {
                    for (j, &c) in p[k - i].iter().enumerate() {
                        next[j] = m.sub(next[j], m.mul(f, c));
                    }
                }
            }
            p.push(next);
        }
        p.pop().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    fn rand_mat(r: usize, c: usize, m: Modulus, s: &mut u64) -> Mat {
        Mat { rows: r, cols: c, m, d: (0..r * c).map(|_| rng(s) % m.n).collect() }
    }

    #[test]
    fn inverse_det_charpoly() {
        let mut s = 5u64;
        for p in [2u64, 7, 1_000_000_007, (1 << 62) - 57, 18446744073709551557] {
            let m = Modulus::new(p);
            for n in [1usize, 2, 5, 17, 40] {
                let a = rand_mat(n, n, m, &mut s);
                let d = a.det();
                match a.inverse() {
                    Some(ai) => {
                        assert_ne!(d, 0);
                        assert_eq!(a.mul(&ai), Mat::identity(n, m));
                    }
                    None => assert_eq!(d, 0),
                }
                // det(AB) = det A det B
                let b = rand_mat(n, n, m, &mut s);
                assert_eq!(a.mul(&b).det(), m.mul(d, b.det()));
                // charpoly: constant term (-1)^n det, trace, and Cayley-Hamilton
                let cp = a.charpoly();
                assert_eq!(cp, a.charpoly_hessenberg(), "Krylov and Hessenberg agree p={p} n={n}");
                assert_eq!(cp.len(), n + 1);
                assert_eq!(cp[0], if n % 2 == 0 { d } else { m.neg(d) });
                let tr = (0..n).fold(0, |t, i| m.add(t, a.get(i, i)));
                assert_eq!(cp[n - 1], m.neg(tr));
                let mut acc = Mat::zero(n, n, m);
                for &c in cp.iter().rev() {
                    acc = acc.mul(&a);
                    for i in 0..n {
                        acc.d[i * n + i] = m.add(acc.d[i * n + i], c);
                    }
                }
                assert_eq!(acc, Mat::zero(n, n, m), "Cayley-Hamilton p={p} n={n}");
            }
        }
    }

    #[test]
    fn lu_solves() {
        let mut s = 77u64;
        for p in [7u64, 1_000_000_007, (1 << 62) - 57] {
            let m = Modulus::new(p);
            for n in [1usize, 2, 17, 40, 70] {
                let a = rand_mat(n, n, m, &mut s);
                let b: Vec<u64> = (0..n).map(|_| rng(&mut s) % p).collect();
                match a.lu() {
                    None => assert_eq!(a.det(), 0),
                    Some(lu) => {
                        let x = lu.solve_vec(&b);
                        assert_eq!(a.mul_vec(&x), b, "p={p} n={n}");
                    }
                }
            }
        }
    }

    #[test]
    fn charpoly_derogatory() {
        // the identity, a diagonal matrix with repeats and a Jordan-like
        // block: the Krylov space is too small and Hessenberg takes over
        let m = Modulus::new((1 << 62) - 57);
        for n in [1usize, 3, 10] {
            let id = Mat::identity(n, m);
            let mut want = vec![1u64];
            for _ in 0..n {
                want = crate::nmod_poly::mul(&want, &[m.neg(1), 1], &m);
            }
            assert_eq!(id.charpoly(), want);
        }
        let mut d = Mat::zero(6, 6, m);
        for (i, x) in [2u64, 2, 3, 3, 3, 5].iter().enumerate() {
            d.d[i * 6 + i] = *x;
        }
        assert_eq!(d.charpoly(), d.charpoly_hessenberg());
    }

    #[test]
    fn rank_and_nullspace() {
        let mut s = 8u64;
        let m = Modulus::new(1_000_000_007);
        // rank 3 product of 6x3 and 3x8
        let a = rand_mat(6, 3, m, &mut s).mul(&rand_mat(3, 8, m, &mut s));
        assert_eq!(a.rank(), 3);
        let k = a.nullspace();
        assert_eq!(k.rows, 5);
        assert_eq!(a.mul(&k.transpose()), Mat::zero(6, 5, m));
        let mut r = a.clone();
        let piv = r.rref();
        assert_eq!(piv, vec![0, 1, 2]);
        for i in 3..6 {
            assert!(r.row(i).iter().all(|&x| x == 0));
        }
    }
}
