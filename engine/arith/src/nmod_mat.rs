//! Dense matrices over Z/p (p a word-size prime): reduced row echelon
//! form, rank, determinant, inverse, solving, nullspace, products and the
//! characteristic polynomial (Hessenberg reduction, H. Cohen, A Course in
//! Computational Algebraic Number Theory, Algorithm 2.2.9).  Row
//! operations multiply by a fixed scalar with Shoup's trick.

use crate::nmod::{mul_shoup, Modulus};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mat {
    pub rows: usize,
    pub cols: usize,
    pub m: Modulus,
    /// Row-major entries, reduced mod p.
    pub d: Vec<u64>,
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
        let m = self.m;
        let mut pivots = vec![];
        let mut r = 0;
        for col in 0..self.cols {
            if r == self.rows {
                break;
            }
            let Some(pr) = (r..self.rows).find(|&i| self.get(i, col) != 0) else { continue };
            self.swap_rows(r, pr);
            let inv = m.inv(self.get(r, col)).expect("modulus not prime");
            let c = self.cols;
            scale(&mut self.d[r * c + col..(r + 1) * c], inv, &m);
            for i in 0..self.rows {
                if i != r {
                    let f = self.get(i, col);
                    if f != 0 {
                        let (dst, src) = self.rows2(i, r);
                        axpy(&mut dst[col..], &src[col..], m.neg(f), &m);
                    }
                }
            }
            pivots.push(col);
            r += 1;
            if r % 16 == 0 {
                sagebrush_interrupt::check();
            }
        }
        pivots
    }

    pub fn rank(&self) -> usize {
        self.clone().rref().len()
    }

    pub fn det(&self) -> u64 {
        assert_eq!(self.rows, self.cols, "determinant of a non-square matrix");
        let m = self.m;
        let n = self.rows;
        let mut a = self.clone();
        let mut det = 1 % m.n;
        for col in 0..n {
            let Some(pr) = (col..n).find(|&i| a.get(i, col) != 0) else { return 0 };
            if pr != col {
                a.swap_rows(col, pr);
                det = m.neg(det);
            }
            let piv = a.get(col, col);
            det = m.mul(det, piv);
            let inv = m.inv(piv).expect("modulus not prime");
            for i in col + 1..n {
                let f = a.get(i, col);
                if f != 0 {
                    let (dst, src) = a.rows2(i, col);
                    axpy(&mut dst[col..], &src[col..], m.neg(m.mul(f, inv)), &m);
                }
            }
            if col % 16 == 15 {
                sagebrush_interrupt::check();
            }
        }
        det
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
        if piv.len() < n || piv[n - 1] != n - 1 {
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

    /// The characteristic polynomial det(x I - self), constant term first.
    pub fn charpoly(&self) -> Vec<u64> {
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
            for i in k + 1..n {
                let u = m.mul(h.get(i, k - 1), tinv);
                if u != 0 {
                    let (dst, src) = h.rows2(i, k);
                    axpy(&mut dst[k - 1..], &src[k - 1..], m.neg(u), &m);
                    for r in 0..n {
                        let v = m.add(h.d[r * n + k], m.mul(u, h.d[r * n + i]));
                        h.d[r * n + k] = v;
                    }
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
