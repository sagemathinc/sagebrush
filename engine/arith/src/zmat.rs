//! Dense matrices over Z (and so over Q, by clearing denominators), by
//! multimodular and p-adic methods with certified results.
//!
//! - [`solve`]: Dixon's p-adic lifting (J. D. Dixon, "Exact solution of
//!   linear equations using p-adic expansions", Numer. Math. 40 (1982))
//!   with rational reconstruction (Wang; von zur Gathen and Gerhard,
//!   section 5.10) at geometrically spaced checkpoints; every answer is
//!   verified exactly (A X = d B) before it is returned.
//! - [`det`]: a large divisor d of det A from the denominator of a solve
//!   with a random right-hand side, then det A / d from a few primes up to
//!   the Hadamard bound (Abbott, Bronstein and Mulders, "Fast deterministic
//!   computation of determinants of dense matrices", ISSAC 1999).
//! - [`rref`]: pivots from a reduction modulo a prime, the rows of the
//!   echelon form from a solve, then the exact check A d = A[:, P] N and
//!   the echelon shape, which together prove the result.
//! - [`charpoly`]: modulo primes until the product exceeds twice a bound
//!   on the coefficients (elementary symmetric functions of row or column
//!   norms, bounding the sums of principal minors by Hadamard).

use crate::nmod::{Modulus, Primes};
use crate::nmod_mat::Mat;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZMat {
    pub rows: usize,
    pub cols: usize,
    /// Row-major entries.
    pub d: Vec<BigInt>,
}

/// x mod p in [0, p).
pub fn mod_u64(x: &BigInt, m: &Modulus) -> u64 {
    if let Some(v) = x.to_i64() {
        return m.from_i64(v);
    }
    x.mod_floor(&BigInt::from(m.n)).to_u64().unwrap()
}

fn bits(x: &BigInt) -> u64 {
    x.bits()
}

impl ZMat {
    pub fn zero(rows: usize, cols: usize) -> ZMat {
        ZMat { rows, cols, d: vec![BigInt::zero(); rows * cols] }
    }

    pub fn identity(n: usize) -> ZMat {
        let mut a = ZMat::zero(n, n);
        for i in 0..n {
            a.d[i * n + i] = BigInt::one();
        }
        a
    }

    pub fn from_rows(rows: Vec<Vec<BigInt>>) -> ZMat {
        let r = rows.len();
        let c = rows.first().map_or(0, |x| x.len());
        assert!(rows.iter().all(|x| x.len() == c), "rows of different lengths");
        ZMat { rows: r, cols: c, d: rows.into_iter().flatten().collect() }
    }

    pub fn to_rows(&self) -> Vec<Vec<BigInt>> {
        (0..self.rows).map(|i| self.row(i).to_vec()).collect()
    }

    #[inline]
    pub fn get(&self, i: usize, j: usize) -> &BigInt {
        &self.d[i * self.cols + j]
    }

    pub fn row(&self, i: usize) -> &[BigInt] {
        &self.d[i * self.cols..(i + 1) * self.cols]
    }

    pub fn reduce(&self, m: &Modulus) -> Mat {
        Mat { rows: self.rows, cols: self.cols, m: *m, d: self.d.iter().map(|x| mod_u64(x, m)).collect() }
    }

    /// The entries as i64, if they all fit.
    fn as_i64(&self) -> Option<Vec<i64>> {
        self.d.iter().map(|x| x.to_i64()).collect()
    }

    pub fn max_bits(&self) -> u64 {
        self.d.iter().map(bits).max().unwrap_or(0)
    }

    pub fn transpose(&self) -> ZMat {
        let mut d = Vec::with_capacity(self.d.len());
        for j in 0..self.cols {
            for i in 0..self.rows {
                d.push(self.get(i, j).clone());
            }
        }
        ZMat { rows: self.cols, cols: self.rows, d }
    }

    /// The submatrix on the given rows and columns.
    pub fn select(&self, rows: &[usize], cols: &[usize]) -> ZMat {
        let mut d = Vec::with_capacity(rows.len() * cols.len());
        for &i in rows {
            for &j in cols {
                d.push(self.get(i, j).clone());
            }
        }
        ZMat { rows: rows.len(), cols: cols.len(), d }
    }

    pub fn mul(&self, o: &ZMat) -> ZMat {
        assert_eq!(self.cols, o.rows, "matrix dimensions do not match");
        let (r, k, c) = (self.rows, self.cols, o.cols);
        let small = self.max_bits() + o.max_bits() + (64 - (k as u64).leading_zeros() as u64) < 126;
        if small {
            if let (Some(a), Some(b)) = (self.as_i64(), o.as_i64()) {
                let mut d = Vec::with_capacity(r * c);
                for i in 0..r {
                    for j in 0..c {
                        let mut s = 0i128;
                        for l in 0..k {
                            s += a[i * k + l] as i128 * b[l * c + j] as i128;
                        }
                        d.push(BigInt::from(s));
                    }
                }
                return ZMat { rows: r, cols: c, d };
            }
        }
        let mut d = Vec::with_capacity(r * c);
        for i in 0..r {
            for j in 0..c {
                let mut s = BigInt::zero();
                for l in 0..k {
                    if !self.d[i * k + l].is_zero() {
                        s += &self.d[i * k + l] * &o.d[l * c + j];
                    }
                }
                d.push(s);
            }
            sagebrush_interrupt::check();
        }
        ZMat { rows: r, cols: c, d }
    }

    pub fn scale(&self, s: &BigInt) -> ZMat {
        ZMat { rows: self.rows, cols: self.cols, d: self.d.iter().map(|x| x * s).collect() }
    }

    /// log2 of the product of the Euclidean norms of the rows (an upper
    /// bound, rounded up).
    fn row_norm_log2(&self) -> Vec<f64> {
        (0..self.rows).map(|i| norm_log2(self.row(i))).collect()
    }

    fn col_norm_log2(&self) -> Vec<f64> {
        self.transpose().row_norm_log2()
    }
}

/// log2 ||v||_2, rounded up generously (0 for the zero vector).
fn norm_log2(v: &[BigInt]) -> f64 {
    let s: BigInt = v.iter().map(|x| x * x).sum();
    if s.is_zero() {
        return f64::NEG_INFINITY;
    }
    // log2(s) <= bits(s); s < 2^bits, so ||v|| < 2^(bits/2)
    let b = s.bits();
    if b <= 1000 {
        (s.to_f64().unwrap() * (1.0 + 1e-12)).log2() / 2.0 + 1e-9
    } else {
        b as f64 / 2.0
    }
}

/// Incremental Chinese remaindering.
pub struct Crt {
    pub x: BigInt,
    pub m: BigInt,
}

impl Crt {
    pub fn new() -> Crt {
        Crt { x: BigInt::zero(), m: BigInt::one() }
    }

    pub fn add(&mut self, r: u64, mp: &Modulus) {
        let xm = mod_u64(&self.x, mp);
        let minv = mp.inv(mod_u64(&self.m, mp)).expect("moduli not coprime");
        let t = mp.mul(mp.sub(r, xm), minv);
        self.x += &self.m * BigInt::from(t);
        self.m *= BigInt::from(mp.n);
    }

    /// The representative in (-m/2, m/2].
    pub fn signed(&self) -> BigInt {
        if &self.x * 2 > self.m {
            &self.x - &self.m
        } else {
            self.x.clone()
        }
    }
}

impl Default for Crt {
    fn default() -> Self {
        Crt::new()
    }
}

/// Rational reconstruction: (a, b) with a = b u mod m, |a| <= nb,
/// 0 < b <= db and gcd(a, b) = 1, if one exists (unique when 2 nb db < m).
pub fn ratrecon(u: &BigInt, m: &BigInt, nb: &BigInt, db: &BigInt) -> Option<(BigInt, BigInt)> {
    let (mut r0, mut r1) = (m.clone(), u.mod_floor(m));
    let (mut t0, mut t1) = (BigInt::zero(), BigInt::one());
    while &r1 > nb {
        let (q, r) = r0.div_rem(&r1);
        r0 = std::mem::replace(&mut r1, r);
        let t = &t0 - &q * &t1;
        t0 = std::mem::replace(&mut t1, t);
    }
    if t1.is_zero() || &t1.abs() > db {
        return None;
    }
    let (a, b) = if t1.is_negative() { (-r1, -t1) } else { (r1, t1) };
    if !a.gcd(&b).is_one() {
        return None;
    }
    Some((a, b))
}

/// Reconstruct a vector of residues mod m as N / den with one common
/// denominator, every |N_i| <= nb and den <= db.
fn ratrecon_vec(u: &[BigInt], m: &BigInt, nb: &BigInt, db: &BigInt) -> Option<(Vec<BigInt>, BigInt)> {
    let mut den = BigInt::one();
    let sym = |x: BigInt| if &x * 2 > *m { x - m } else { x };
    for x in u {
        let v = sym((x * &den).mod_floor(m));
        if &v.abs() <= nb {
            continue;
        }
        let dbound = db / &den;
        if dbound.is_zero() {
            return None;
        }
        let (_, b) = ratrecon(&v, m, nb, &dbound)?;
        den *= b;
    }
    let nums: Vec<BigInt> = u.iter().map(|x| sym((x * &den).mod_floor(m))).collect();
    if nums.iter().any(|v| &v.abs() > nb) {
        return None;
    }
    Some((nums, den))
}

/// Choose a prime below `below` for which a is invertible mod p, trying
/// `tries` primes.
fn invertible_mod(a: &ZMat, below: u64, tries: usize) -> Option<(Modulus, Mat)> {
    for p in Primes::below(below).take(tries) {
        let m = Modulus::new(p);
        if let Some(inv) = a.reduce(&m).inverse() {
            return Some((m, inv));
        }
    }
    None
}

/// X = N / den with a X = b, for a square and nonsingular (None if a is
/// singular).  den > 0 is the least common denominator.
pub fn solve(a: &ZMat, b: &ZMat) -> Option<(ZMat, BigInt)> {
    assert_eq!(a.rows, a.cols, "solve needs a square matrix");
    assert_eq!(a.rows, b.rows, "right-hand side has the wrong number of rows");
    let n = a.rows;
    let k = b.cols;
    if n == 0 {
        return Some((ZMat::zero(0, k), BigInt::one()));
    }
    let (m, ainv) = match invertible_mod(a, 1 << 31, 3) {
        Some(x) => x,
        None => {
            if det_multimodular(a).is_zero() {
                return None;
            }
            // nonsingular, but every prime tried divides det a: keep looking
            let mut found = None;
            for p in Primes::below(1 << 31).skip(3) {
                let m = Modulus::new(p);
                if let Some(inv) = a.reduce(&m).inverse() {
                    found = Some((m, inv));
                    break;
                }
            }
            found.unwrap()
        }
    };
    let p = m.n;
    let bp = BigInt::from(p);
    // bounds: den <= H(a); numerators <= H(a with a column replaced by b)
    let rl = a.row_norm_log2();
    let cl = a.col_norm_log2();
    let ha = rl.iter().sum::<f64>().min(cl.iter().sum::<f64>()).max(0.0);
    let bmax = (0..k).map(|j| (0..n).map(|i| b.get(i, j).bits()).max().unwrap_or(0)).max().unwrap_or(0) as f64;
    let hn: f64 = rl.iter().map(|&x| (x.max(bmax) + 0.5).max(0.0)).sum::<f64>();
    let need_bits = ha + hn + 2.0;
    let max_iters = (need_bits / (p as f64).log2()).ceil() as usize + 2;

    let a64 = a.as_i64().filter(|_| a.max_bits() <= 62);
    let mut r: Vec<BigInt> = b.d.clone();
    let mut x: Vec<BigInt> = vec![BigInt::zero(); n * k];
    let mut pk = BigInt::one();
    let mut check = 4usize.min(max_iters);
    let mut iter = 0;
    loop {
        // digit = ainv (r mod p)
        let rm = Mat { rows: n, cols: k, m, d: r.iter().map(|v| mod_u64(v, &m)).collect() };
        let digit = ainv.mul(&rm);
        // r = (r - a digit) / p
        for i in 0..n {
            for j in 0..k {
                let s: BigInt = match &a64 {
                    Some(a64) => {
                        let mut s = 0i128;
                        for l in 0..n {
                            s += a64[i * n + l] as i128 * digit.d[l * k + j] as i128;
                        }
                        BigInt::from(s)
                    }
                    None => (0..n).map(|l| a.get(i, l) * BigInt::from(digit.d[l * k + j])).sum(),
                };
                let v = &r[i * k + j] - s;
                debug_assert!((&v % &bp).is_zero());
                r[i * k + j] = v / &bp;
            }
        }
        for (xi, &di) in x.iter_mut().zip(&digit.d) {
            if di != 0 {
                *xi += &pk * BigInt::from(di);
            }
        }
        pk *= &bp;
        iter += 1;
        sagebrush_interrupt::check();
        if iter == check {
            // N, D with 2 N D < p^iter
            let half = (&pk / 2u32).sqrt();
            if let Some((nums, den)) = ratrecon_vec(&x, &pk, &half, &half) {
                let nm = ZMat { rows: n, cols: k, d: nums };
                if a.mul(&nm) == b.scale(&den) {
                    return Some((nm, den));
                }
            }
            if iter >= max_iters {
                // the bound guarantees success with balanced bounds only
                // when 2 N D < p^iter; widen once more and retry
                check = iter + max_iters.max(4);
                continue;
            }
            check = (2 * check).min(max_iters);
        }
    }
}

/// Fraction-free Gaussian elimination (Bareiss): exact determinant with
/// O(n^3) operations on integers no larger than the minors.
pub fn det_bareiss(a: &ZMat) -> BigInt {
    assert_eq!(a.rows, a.cols);
    let n = a.rows;
    if n == 0 {
        return BigInt::one();
    }
    let mut m = a.d.clone();
    let mut sign = 1;
    let mut prev = BigInt::one();
    for k in 0..n - 1 {
        if m[k * n + k].is_zero() {
            let Some(i) = (k + 1..n).find(|&i| !m[i * n + k].is_zero()) else { return BigInt::zero() };
            for j in 0..n {
                m.swap(k * n + j, i * n + j);
            }
            sign = -sign;
        }
        for i in k + 1..n {
            for j in k + 1..n {
                let v = &m[i * n + j] * &m[k * n + k] - &m[i * n + k] * &m[k * n + j];
                m[i * n + j] = v / &prev;
            }
        }
        prev = m[k * n + k].clone();
        sagebrush_interrupt::check();
    }
    let d = m[n * n - 1].clone();
    if sign < 0 {
        -d
    } else {
        d
    }
}

/// log2 of the Hadamard bound (min of row and column versions).
fn hadamard_log2(a: &ZMat) -> f64 {
    let r: f64 = a.row_norm_log2().iter().sum();
    let c: f64 = a.col_norm_log2().iter().sum();
    r.min(c)
}

/// det a modulo primes up to the Hadamard bound, divided by a known
/// divisor (det a / divisor is what is reconstructed).
fn det_crt(a: &ZMat, divisor: &BigInt, bound_log2: f64) -> BigInt {
    let mut crt = Crt::new();
    let target = bound_log2 + 2.0;
    for p in Primes::new() {
        let m = Modulus::new(p);
        let dm = mod_u64(divisor, &m);
        if dm == 0 {
            continue;
        }
        let r = m.mul(a.reduce(&m).det(), m.inv(dm).unwrap());
        crt.add(r, &m);
        if crt.m.bits() as f64 > target {
            break;
        }
        sagebrush_interrupt::check();
    }
    crt.signed() * divisor
}

fn det_multimodular(a: &ZMat) -> BigInt {
    let h = hadamard_log2(a);
    if h == f64::NEG_INFINITY {
        return BigInt::zero();
    }
    det_crt(a, &BigInt::one(), h)
}

/// The determinant of a square integer matrix.
pub fn det(a: &ZMat) -> BigInt {
    assert_eq!(a.rows, a.cols, "determinant of a non-square matrix");
    let n = a.rows;
    if n <= 6 || (n <= 12 && a.max_bits() > 200) {
        return det_bareiss(a);
    }
    let h = hadamard_log2(a);
    if h == f64::NEG_INFINITY {
        return BigInt::zero();
    }
    // few primes suffice: plain multimodular
    if h < 62.0 * 4.0 {
        return det_crt(a, &BigInt::one(), h);
    }
    // a random right-hand side gives a large divisor of det a
    let mut seed = 0x2545f4914f6cdd1du64;
    let b = ZMat {
        rows: n,
        cols: 1,
        d: (0..n)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                BigInt::from((seed % 201) as i64 - 100)
            })
            .collect(),
    };
    match solve(a, &b) {
        None => BigInt::zero(),
        Some((_, den)) => det_crt(a, &den, h - den.bits() as f64 + 1.0),
    }
}

/// The reduced row echelon form over Q of an integer matrix, as
/// (N, den, pivots): the nonzero rows are N / den (rank = pivots.len()).
pub fn rref(a: &ZMat) -> (ZMat, BigInt, Vec<usize>) {
    for p in Primes::new().take(20) {
        let m = Modulus::new(p);
        let mut am = a.reduce(&m);
        let piv = am.rref();
        let r = piv.len();
        if r == 0 {
            if a.d.iter().all(|x| x.is_zero()) {
                return (ZMat::zero(0, a.cols), BigInt::one(), vec![]);
            }
            continue;
        }
        // r independent rows of a[:, piv]
        let mut t = a.select(&(0..a.rows).collect::<Vec<_>>(), &piv).transpose().reduce(&m);
        let rows = t.rref();
        if rows.len() < r {
            continue;
        }
        let c = a.select(&rows, &piv);
        let rhs = a.select(&rows, &(0..a.cols).collect::<Vec<_>>());
        let Some((nm, den)) = solve(&c, &rhs) else { continue };
        // shape: identity on the pivots, zeros before each pivot
        let shaped = (0..r).all(|i| {
            (0..piv[i]).all(|j| nm.get(i, j).is_zero())
                && piv.iter().enumerate().all(|(t, &pc)| if t == i { nm.get(i, pc) == &den } else { nm.get(i, pc).is_zero() })
        });
        if !shaped {
            continue;
        }
        // every row of a is in the row space: a den = a[:, piv] N
        let ap = a.select(&(0..a.rows).collect::<Vec<_>>(), &piv);
        if ap.mul(&nm) == a.scale(&den) {
            return (nm, den, piv);
        }
    }
    panic!("rref: no good prime among 20 (this should not happen)");
}

pub fn rank(a: &ZMat) -> usize {
    rref(a).2.len()
}

/// A basis of the right kernel {x : a x = 0} over Q, scaled to integer
/// vectors, as the rows of the result (one per non-pivot column, in order).
pub fn kernel(a: &ZMat) -> ZMat {
    let (nm, den, piv) = rref(a);
    let free: Vec<usize> = (0..a.cols).filter(|c| !piv.contains(c)).collect();
    let mut k = ZMat::zero(free.len(), a.cols);
    for (t, &f) in free.iter().enumerate() {
        k.d[t * a.cols + f] = den.clone();
        for (i, &pc) in piv.iter().enumerate() {
            k.d[t * a.cols + pc] = -nm.get(i, f).clone();
        }
    }
    k
}

/// (N, den) with a^-1 = N / den, or None if a is singular.
pub fn inverse(a: &ZMat) -> Option<(ZMat, BigInt)> {
    solve(a, &ZMat::identity(a.rows))
}

/// The characteristic polynomial det(x I - a), constant term first.
pub fn charpoly(a: &ZMat) -> Vec<BigInt> {
    assert_eq!(a.rows, a.cols, "charpoly of a non-square matrix");
    let n = a.rows;
    // |c_{n-j}| <= e_j(norms), for row norms and for column norms
    let e = |logs: Vec<f64>| {
        // elementary symmetric functions in log2 space, upper bounds
        let mut e = vec![f64::NEG_INFINITY; n + 1];
        e[0] = 0.0;
        for &l in &logs {
            for j in (1..=n).rev() {
                let t = e[j - 1] + l;
                e[j] = if e[j] == f64::NEG_INFINITY {
                    t
                } else if t == f64::NEG_INFINITY {
                    e[j]
                } else {
                    let (hi, lo) = if e[j] > t { (e[j], t) } else { (t, e[j]) };
                    hi + (1.0 + (lo - hi).exp2()).log2()
                };
            }
        }
        e
    };
    let er = e(a.row_norm_log2());
    let ec = e(a.col_norm_log2());
    let bound = (0..=n).map(|j| er[j].min(ec[j])).fold(0.0f64, f64::max) * (1.0 + 1e-9) + 4.0;
    let mut crts: Vec<Crt> = (0..=n).map(|_| Crt::new()).collect();
    for p in Primes::new() {
        let m = Modulus::new(p);
        let cp = a.reduce(&m).charpoly();
        for (c, &r) in crts.iter_mut().zip(&cp) {
            c.add(r, &m);
        }
        if crts[0].m.bits() as f64 > bound {
            break;
        }
        sagebrush_interrupt::check();
    }
    crts.iter().map(|c| c.signed()).collect()
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

    fn rand_zmat(r: usize, c: usize, range: i64, s: &mut u64) -> ZMat {
        ZMat { rows: r, cols: c, d: (0..r * c).map(|_| BigInt::from((rng(s) % (2 * range as u64 + 1)) as i64 - range)).collect() }
    }

    #[test]
    fn det_agrees_with_bareiss() {
        let mut s = 3u64;
        for (n, range) in [(1, 5), (3, 100), (7, 1), (13, 1000), (25, 10), (40, 1 << 40), (60, 3)] {
            let a = rand_zmat(n, n, range, &mut s);
            assert_eq!(det(&a), det_bareiss(&a), "n={n}");
            // a singular one: last row the sum of the first two
            let mut b = a.clone();
            if n >= 3 {
                for j in 0..n {
                    b.d[(n - 1) * n + j] = a.get(0, j) + a.get(1, j);
                }
                assert!(det(&b).is_zero());
                assert!(solve(&b, &ZMat::identity(n)).is_none());
            }
        }
    }

    #[test]
    fn solve_inverse_rref_kernel() {
        let mut s = 11u64;
        for (n, range) in [(1, 3), (4, 10), (20, 100), (35, 1 << 20)] {
            let a = rand_zmat(n, n, range, &mut s);
            let Some((ai, den)) = inverse(&a) else {
                assert!(det_bareiss(&a).is_zero());
                continue;
            };
            assert_eq!(a.mul(&ai), ZMat::identity(n).scale(&den));
            // den is the least common denominator
            let g = ai.d.iter().fold(den.clone(), |g, x| g.gcd(x));
            assert!(g.is_one());
        }
        // rank 4 matrix 7 x 9
        let a = rand_zmat(7, 4, 50, &mut s).mul(&rand_zmat(4, 9, 50, &mut s));
        let (nm, den, piv) = rref(&a);
        assert_eq!(piv, vec![0, 1, 2, 3]);
        assert_eq!(nm.rows, 4);
        let k = kernel(&a);
        assert_eq!(k.rows, 5);
        assert!(a.mul(&k.transpose()).d.iter().all(|x| x.is_zero()));
        assert!(den > BigInt::zero());
        // a matrix whose pivots are not the leading columns
        let b = ZMat::from_rows(vec![
            vec![0.into(), 2.into(), 4.into(), 1.into()],
            vec![0.into(), 1.into(), 2.into(), 3.into()],
            vec![0.into(), 3.into(), 6.into(), 4.into()],
        ]);
        let (nm, den, piv) = rref(&b);
        assert_eq!(piv, vec![1, 3]);
        assert_eq!(nm.row(0), &[BigInt::zero(), den.clone(), &den * 2, BigInt::zero()]);
        assert_eq!(rank(&ZMat::zero(3, 3)), 0);
    }

    #[test]
    fn charpoly_cayley_hamilton() {
        let mut s = 21u64;
        for (n, range) in [(1, 5), (2, 7), (6, 1000), (15, 1 << 30), (30, 2)] {
            let a = rand_zmat(n, n, range, &mut s);
            let cp = charpoly(&a);
            assert_eq!(cp[n], BigInt::one());
            let mut acc = ZMat::zero(n, n);
            for c in cp.iter().rev() {
                acc = acc.mul(&a);
                for i in 0..n {
                    acc.d[i * n + i] += c;
                }
            }
            assert!(acc.d.iter().all(|x| x.is_zero()), "n={n}");
            let d = det(&a);
            assert_eq!(cp[0], if n % 2 == 0 { d } else { -d });
        }
    }
}
