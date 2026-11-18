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
use crate::nmod_mat::{Lu, Mat};
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

/// The values (in (-P/2, P/2]) with residues res[j][i] modulo primes[j].
fn crt_all(primes: &[u64], res: &[Vec<u64>]) -> Vec<BigInt> {
    let crt = crate::crt::MultiCrt::new(primes);
    let n = res.first().map_or(0, |r| r.len());
    let mut r = vec![0u64; primes.len()];
    (0..n)
        .map(|i| {
            for (rj, v) in r.iter_mut().zip(res) {
                *rj = v[i];
            }
            crt.reconstruct(&r)
        })
        .collect()
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
/// `tries` primes; its LU factorization.
fn invertible_mod(a: &ZMat, below: u64, tries: usize) -> Option<(Modulus, Lu)> {
    for p in Primes::below(below).take(tries) {
        let m = Modulus::new(p);
        if let Some(lu) = a.reduce(&m).lu() {
            return Some((m, lu));
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
    // a 62-bit lifting prime when a * digit sums fit in i128, else 31 bits
    let a64 = a.as_i64().filter(|_| a.max_bits() <= 62);
    let logn = (usize::BITS - n.leading_zeros()) as u64;
    let below = if a64.is_some() && a.max_bits() + 62 + logn + 2 <= 126 { 1u64 << 62 } else { 1 << 31 };
    let (m, ainv) = match invertible_mod(a, below, 3) {
        Some(x) => x,
        None => {
            if det_multimodular(a).is_zero() {
                return None;
            }
            // nonsingular, but every prime tried divides det a: keep looking
            // (det a can hold many of them; one elimination per prime)
            let _phase = sagebrush_interrupt::enter("arith.solve_prime");
            let mut found = None;
            for p in Primes::below(below).skip(3) {
                sagebrush_interrupt::check();
                let m = Modulus::new(p);
                if let Some(lu) = a.reduce(&m).lu() {
                    found = Some((m, lu));
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

    let mut r: Vec<BigInt> = b.d.clone();
    // the residual as i128 once it fits (it stays below n |a| + |r| / p)
    let mut r128: Option<Vec<i128>> = None;
    // 1/p mod 2^128: exact division by p is a multiplication
    let pinv = {
        let mut x: u128 = 1;
        for _ in 0..7 {
            x = x.wrapping_mul(2u128.wrapping_sub((p as u128).wrapping_mul(x)));
        }
        x
    };
    let mut x: Vec<BigInt> = vec![BigInt::zero(); n * k];
    let mut pk = BigInt::one();
    let mut check = 4usize.min(max_iters);
    let mut iter = 0;
    loop {
        if r128.is_none() && a64.is_some() {
            let lim = BigInt::from(1i128 << 120);
            if r.iter().all(|v| v.abs() < lim) {
                r128 = Some(r.iter().map(|v| v.to_i128().unwrap()).collect());
            }
        }
        // digit = ainv (r mod p)
        let rd: Vec<u64> = match &r128 {
            Some(rv) => rv
                .iter()
                .map(|&v| if v >= 0 { m.reduce_u128(v as u128) } else { m.neg(m.reduce_u128(v.unsigned_abs())) })
                .collect(),
            None => r.iter().map(|v| mod_u64(v, &m)).collect(),
        };
        // digit = a^-1 (r mod p), column by column through the LU
        let digit = if k == 1 {
            Mat { rows: n, cols: 1, m, d: ainv.solve_vec(&rd) }
        } else {
            let mut d = vec![0u64; n * k];
            for j in 0..k {
                let col: Vec<u64> = (0..n).map(|i| rd[i * k + j]).collect();
                for (i, v) in ainv.solve_vec(&col).into_iter().enumerate() {
                    d[i * k + j] = v;
                }
            }
            Mat { rows: n, cols: k, m, d }
        };
        // r = (r - a digit) / p
        match (&mut r128, &a64) {
            (Some(rv), Some(a64)) => {
                for i in 0..n {
                    for j in 0..k {
                        let mut s = 0i128;
                        for l in 0..n {
                            s += a64[i * n + l] as i128 * digit.d[l * k + j] as i128;
                        }
                        let v = rv[i * k + j] - s;
                        rv[i * k + j] = (v as u128).wrapping_mul(pinv) as i128;
                    }
                }
            }
            _ => {
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
    // few primes, or a small matrix: plain multimodular
    if h < 62.0 * 4.0 || n < 40 {
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

/// Is pivot list x better than y: larger rank, then lexicographically
/// smaller (pivots modulo a prime are never better than over Q).
fn better(x: &[usize], y: &[usize]) -> bool {
    x.len() > y.len() || (x.len() == y.len() && x < y)
}

/// log2 of the product of the r largest row norms: a bound for every r x r
/// minor (Hadamard).
fn minor_bound_log2(a: &ZMat, r: usize) -> f64 {
    let mut l: Vec<f64> = a.row_norm_log2().into_iter().filter(|x| x.is_finite()).collect();
    l.sort_by(|x, y| y.partial_cmp(x).unwrap());
    l.iter().take(r).map(|x| x.max(0.0)).sum()
}

/// The reduced row echelon form over Q of an integer matrix, as
/// (N, den, pivots): the nonzero rows are N / den (rank = pivots.len()).
///
/// One prime's elimination gives pivots P and rank k first.  If k is the
/// number of columns the form is [I; 0]: the rank over Q is at least the
/// rank modulo a prime, and at most the number of columns.  If only a few
/// columns F are free (|F| <= k / DIXON_FREE_RATIO), the rest of the form
/// is X = A[S, P]^-1 A[S, F] for independent rows S, by Dixon's lifting
/// (`solve`), certified exactly (`rref_dixon`); a prime that was unlucky
/// fails the certificate.  Otherwise, or then, `rref_multimodular`.
pub fn rref(a: &ZMat) -> (ZMat, BigInt, Vec<usize>) {
    if a.d.iter().all(|x| x.is_zero()) {
        return (ZMat::zero(0, a.cols), BigInt::one(), vec![]);
    }
    let cols = a.cols;
    let p = Primes::new().next().expect("a prime");
    let m = Modulus::new(p);
    let mut r = a.reduce(&m);
    let piv = r.rref();
    let k = piv.len();
    if k == cols {
        let mut id = ZMat::zero(k, cols);
        for i in 0..k {
            id.d[i * cols + i] = BigInt::one();
        }
        return (id, BigInt::one(), piv);
    }
    if k > 0 && (cols - k) * DIXON_FREE_RATIO <= k {
        if let Some(f) = rref_dixon(a, &piv, &m) {
            return f;
        }
    }
    rref_multimodular(a)
}

/// Dixon's lifting pays for itself while few columns are free.  Measured
/// natively (release build, one core) on random 200-row matrices of rank
/// 200 with entries in [-2, 2]: with 2 free columns it was 5 times faster
/// than the multimodular elimination, with 20 about as fast, and with 40
/// slower.
const DIXON_FREE_RATIO: usize = 16;

/// The reduced echelon form from the pivots `piv` found modulo the prime
/// of `m`, or None if they are not the form's pivots over Q.  With S the
/// rows of A independent in its pivot columns modulo p (so A[S, P] is
/// nonsingular over Q), N = den A[S, P]^-1 A[S, :] has den I in the
/// columns P, X = solve(A[S, P], A[S, F]) in the free columns, and the
/// row space of A[S, :].  It is den times the reduced echelon form of A
/// exactly when (a) each row of N is zero left of its pivot, and (b) every
/// row of A outside S is in its row space: A[r, :] den = A[r, P] N.  Both
/// are checked exactly; a failure means the prime was unlucky.
fn rref_dixon(a: &ZMat, piv: &[usize], m: &Modulus) -> Option<(ZMat, BigInt, Vec<usize>)> {
    let cols = a.cols;
    let k = piv.len();
    let mut t = a.select(&(0..a.rows).collect::<Vec<_>>(), piv).transpose().reduce(m);
    let srows = t.rref();
    if srows.len() != k {
        return None;
    }
    let free: Vec<usize> = (0..cols).filter(|c| !piv.contains(c)).collect();
    let (x, den) = solve(&a.select(&srows, piv), &a.select(&srows, &free))?;
    let mut nm = ZMat::zero(k, cols);
    for i in 0..k {
        nm.d[i * cols + piv[i]] = den.clone();
        for (j, &f) in free.iter().enumerate() {
            nm.d[i * cols + f] = x.get(i, j).clone();
        }
    }
    // (a) zero left of each pivot
    for i in 0..k {
        if free.iter().any(|&f| f < piv[i] && !nm.get(i, f).is_zero()) {
            return None;
        }
    }
    // (b) the other rows in the row space
    for row in (0..a.rows).filter(|i| !srows.contains(i)) {
        sagebrush_interrupt::check();
        for c in 0..cols {
            let mut s = a.get(row, c) * &den;
            for (i, &pc) in piv.iter().enumerate() {
                let w = a.get(row, pc);
                if !w.is_zero() {
                    s -= w * nm.get(i, c);
                }
            }
            if !s.is_zero() {
                return None;
            }
        }
    }
    // lowest terms (solve's den is the least common denominator already)
    Some((nm, den, piv.to_vec()))
}

/// The reduced echelon form by multimodular elimination alone (`rref`'s
/// general case, and its fallback).
///
/// Modulo each prime, the rref R_p and d_p = det A[S, P]
/// for a fixed nonsingular pivot minor (rows S, pivot columns P: the rows
/// the first prime's elimination took, whose pivots give d_p) give
/// N = d R modulo p, reconstructed by CRT (|N|, |d| are r x r minors, so
/// below the Hadamard bound B).  The identity A d = A[:, P] N holds
/// modulo every prime used, and its entries are below (r + 1) |A| B, so
/// once the primes' product exceeds twice that it holds over Z: then the
/// rows of A lie in the row space of N, which has rank r = rank A[S, P]
/// <= rank A, so N / d is the reduced echelon form.  Primes whose pivots
/// differ from the best seen are skipped (an unlucky prime only loses
/// rank or moves pivots right).
pub fn rref_multimodular(a: &ZMat) -> (ZMat, BigInt, Vec<usize>) {
    if a.d.iter().all(|x| x.is_zero()) {
        return (ZMat::zero(0, a.cols), BigInt::one(), vec![]);
    }
    let cols = a.cols;
    let amax = a.max_bits() as f64;
    let mut best: Option<Vec<usize>> = None;
    let mut srows: Vec<usize> = vec![];
    let mut primes: Vec<u64> = vec![];
    let mut res: Vec<Vec<u64>> = vec![];
    let mut bits = 0.0f64;
    let mut target = f64::INFINITY;
    for p in Primes::new() {
        let m = Modulus::new(p);
        let mut r = a.reduce(&m);
        // the elimination's own pivot rows, and det A[those rows, P]
        let (piv, prows, pdet) = r.rref_rows();
        let reset = match &best {
            None => true,
            Some(b) => better(&piv, b),
        };
        if reset {
            if piv.is_empty() {
                continue;
            }
            // rows S: the rows the pivots were found in (A[S, P] is
            // nonsingular modulo p, so over Q)
            srows = prows.clone();
            let k = piv.len();
            let bound = minor_bound_log2(a, k);
            target = bound + ((k + 1) as f64).log2() + amax + 2.0;
            primes.clear();
            res.clear();
            bits = 0.0;
            best = Some(piv.clone());
        } else if Some(&piv) != best.as_ref() {
            continue;
        }
        let pv = best.as_ref().unwrap();
        // d_p = det A[S, P] modulo p: from the elimination when it took the
        // same rows, else computed
        let dp = if prows == srows { pdet } else { a.select(&srows, pv).reduce(&m).det() };
        if dp == 0 {
            continue;
        }
        let k = pv.len();
        let mut v: Vec<u64> = r.d[..k * cols].iter().map(|&x| m.mul(dp, x)).collect();
        v.push(dp);
        primes.push(p);
        res.push(v);
        bits += (p as f64).log2();
        if bits > target {
            break;
        }
        sagebrush_interrupt::check();
    }
    let piv = best.unwrap();
    let k = piv.len();
    let mut all = crt_all(&primes, &res);
    let mut den = all.pop().unwrap();
    let mut nm = ZMat { rows: k, cols, d: all };
    // lowest terms, positive denominator
    let g = nm.d.iter().fold(den.clone(), |g, x| g.gcd(x));
    if den.is_negative() {
        den = -den;
        for x in nm.d.iter_mut() {
            *x = -std::mem::take(x);
        }
    }
    if !g.is_one() {
        den = &den / &g;
        for x in nm.d.iter_mut() {
            *x = &*x / &g;
        }
    }
    (nm, den, piv)
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

/// The Hermite normal form (upper triangular rows generating the row
/// lattice L of a, positive pivots, entries above a pivot in [0, pivot))
/// of a square nonsingular matrix, attempted for the form
/// [[I, h], [0, d]] (Z^n / L cyclic of order d = |det a|, generated by the
/// last unit vector), or None: for every other form, and for that one when
/// the right-hand sides below do not find h (the caller then falls back).
///
/// For a vector b, x = d a^-1 b (an integer vector: adj(a) b up to sign;
/// a Dixon solve) has a x = d b = 0 (mod d).  If a = U H with H as above,
/// x = (d c - c_n h, c_n) for c = U^-1 b, so when x_n = c_n is invertible
/// modulo d, w = x / x_n (mod d) = (-h, 1).  b is random (a fixed sequence,
/// so results are reproducible): with b = e_n, c_n is an entry of U^-1 that
/// can share a factor with d even in this case.  When the first b's c_n
/// does, more right-hand sides are solved and combined so that the last
/// entry is 1 (mod d); anything else is left to the caller.  The first
/// solve's denominator, a large divisor of det a, also leaves few primes
/// for d (as in `det`).  `hermite_cyclic_holds` then checks a H^-1
/// integral exactly: with det H = d = |det a| that makes the row lattices
/// equal (Pernet and Stein, "Fast computation of Hermite normal forms of
/// random integer matrices", J. Number Theory 130 (2010): the last-column
/// step).
pub fn hermite_cyclic(a: &ZMat) -> Option<ZMat> {
    let n = a.rows;
    if n == 0 || a.cols != n {
        return None;
    }
    let hb = hadamard_log2(a);
    if hb == f64::NEG_INFINITY {
        return None;
    }
    let mut seed = 0x9e3779b97f4a7c15u64;
    let mut rhs = |k: usize| -> ZMat {
        let mut b = ZMat::zero(n, k);
        for x in b.d.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *x = BigInt::from((seed % 201) as i64 - 100);
        }
        b
    };
    let (u, den) = solve(a, &rhs(1))?;
    let d = det_crt(a, &den, hb - den.bits() as f64 + 1.0).abs();
    if d.is_zero() {
        return None;
    }
    if n == 1 {
        return Some(ZMat {
            rows: 1,
            cols: 1,
            d: vec![d],
        });
    }
    // the columns x = d u / den modulo d (integral: den divides det a)
    let cols = |u: &ZMat, den: &BigInt| -> Option<Vec<Vec<BigInt>>> {
        let (f, r) = d.div_rem(den);
        if !r.is_zero() {
            return None;
        }
        Some((0..u.cols).map(|j| (0..n).map(|i| (u.get(i, j) * &f).mod_floor(&d)).collect()).collect())
    };
    let mut xs = cols(&u, &den)?;
    let mut g = xs[0][n - 1].gcd(&d);
    for &k in HERMITE_CYCLIC_MORE_RHS {
        if g.is_one() {
            break;
        }
        let (u, den) = solve(a, &rhs(k))?;
        let more = cols(&u, &den)?;
        for x in &more {
            g = g.gcd(&x[n - 1]);
        }
        xs.extend(more);
    }
    // In the form above each column is x = c (-h, 1) (mod d), c = x_n.
    // Combine the columns: sum mu_j c_j = gcd(c_1, .., c_k, d) (mod d); if
    // that is 1, w = sum mu_j x_j (mod d) has w_n = 1 and w = (-h, 1).  When
    // Z^n / L is not cyclic, of exponent e < d, every x is d/e times an
    // integer vector, so the gcd is never 1.
    if !g.is_one() {
        return None;
    }
    let mut g = d.clone();
    let mut mu = vec![BigInt::zero(); xs.len()];
    for (j, x) in xs.iter().enumerate() {
        let e = g.extended_gcd(&x[n - 1]);
        for m in mu.iter_mut() {
            *m = (&*m * &e.x).mod_floor(&d);
        }
        mu[j] = e.y.mod_floor(&d);
        g = e.gcd;
        if g.is_one() {
            break;
        }
    }
    if !g.is_one() {
        return None;
    }
    let w = |i: usize| -> BigInt {
        let mut t = BigInt::zero();
        for (m, x) in mu.iter().zip(&xs) {
            if !m.is_zero() {
                t += m * &x[i];
            }
        }
        t.mod_floor(&d)
    };
    if !(w(n - 1) - 1u32).mod_floor(&d).is_zero() {
        return None;
    }
    let h: Vec<BigInt> = (0..n - 1).map(|i| (-w(i)).mod_floor(&d)).collect();
    if !hermite_cyclic_holds(a, &h, &d) {
        return None;
    }
    let mut out = ZMat::zero(n, n);
    for i in 0..n - 1 {
        out.d[i * n + i] = BigInt::one();
        out.d[i * n + n - 1] = h[i].clone();
    }
    out.d[n * n - 1] = d;
    Some(out)
}

/// The further random right-hand sides hermite_cyclic solves for, a batch
/// at a time, while the last entries' gcd with d is not 1.
const HERMITE_CYCLIC_MORE_RHS: &[usize] = &[2, 5];

/// Whether H = [[I, h], [0, d]] (h of length n - 1) generates the row
/// lattice L of the square matrix a, given d = |det a|: a H^-1 is integral
/// exactly when every row r of a has r_n - sum_(i<n) r_i h_i = 0 (mod d),
/// which puts L inside the lattice of H; both have determinant d, so they
/// are equal.
pub fn hermite_cyclic_holds(a: &ZMat, h: &[BigInt], d: &BigInt) -> bool {
    let n = a.rows;
    if a.cols != n || h.len() + 1 != n || d.is_zero() {
        return false;
    }
    for r in 0..n {
        sagebrush_interrupt::check();
        let mut s = a.get(r, n - 1).clone();
        for (i, hi) in h.iter().enumerate() {
            s -= a.get(r, i) * hi;
        }
        if !s.mod_floor(d).is_zero() {
            return false;
        }
    }
    true
}

/// (N, den) with a^-1 = N / den in lowest terms, or None if a is
/// singular.  Multimodular: modulo each prime, one elimination of [a | I]
/// gives det a and a^-1, so the adjugate det(a) a^-1; both are (n-1)- or
/// n-minors, below the Hadamard bound, which fixes the number of primes.
pub fn inverse(a: &ZMat) -> Option<(ZMat, BigInt)> {
    assert_eq!(a.rows, a.cols, "inverse of a non-square matrix");
    let n = a.rows;
    if n == 0 {
        return Some((ZMat::zero(0, 0), BigInt::one()));
    }
    let h = hadamard_log2(a);
    if h == f64::NEG_INFINITY {
        return None;
    }
    let target = h.max(0.0) + 2.0;
    let mut primes: Vec<u64> = vec![];
    let mut res: Vec<Vec<u64>> = vec![];
    let mut bits = 0.0f64;
    let mut singular = 0;
    for p in Primes::new() {
        let m = Modulus::new(p);
        let mut aug = a.reduce(&m).augment(&Mat::identity(n, m));
        let (piv, det) = aug.echelon(true, true);
        if piv.len() < n || piv[n - 1] != n - 1 {
            singular += 1;
            if singular == 2 && det_multimodular(a).is_zero() {
                return None;
            }
            continue;
        }
        // [adj entries, det] modulo p
        let mut v = Vec::with_capacity(n * n + 1);
        for i in 0..n {
            for j in 0..n {
                v.push(m.mul(det, aug.d[i * 2 * n + n + j]));
            }
        }
        v.push(det);
        primes.push(p);
        res.push(v);
        bits += (p as f64).log2();
        if bits > target {
            break;
        }
        sagebrush_interrupt::check();
    }
    let mut all = crt_all(&primes, &res);
    let mut den = all.pop().unwrap();
    let mut adj = ZMat { rows: n, cols: n, d: all };
    let g = adj.d.iter().fold(den.clone(), |g, x| g.gcd(x));
    if den.is_negative() {
        den = -den;
        for x in adj.d.iter_mut() {
            *x = -std::mem::take(x);
        }
    }
    if !g.is_one() {
        den = &den / &g;
        for x in adj.d.iter_mut() {
            *x = &*x / &g;
        }
    }
    Some((adj, den))
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
    let mut primes: Vec<u64> = vec![];
    let mut res: Vec<Vec<u64>> = vec![];
    let mut bits = 0.0f64;
    for p in Primes::new() {
        let m = Modulus::new(p);
        res.push(a.reduce(&m).charpoly());
        primes.push(p);
        bits += (p as f64).log2();
        if bits > bound {
            break;
        }
        sagebrush_interrupt::check();
    }
    crt_all(&primes, &res)
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
    /// The pivot rows can differ between primes with the same pivots: here
    /// row 0 is the first prime times (1009, 0, 1), zero modulo that prime,
    /// so its elimination takes rows {1, 2} and the next prime's takes
    /// {0, 1}.  The minor's determinant must then be the first rows' modulo
    /// every prime (computed, not the elimination's own): with different
    /// minors the primes reconstruct different multiples of the form, which
    /// denominators as large as 1009 and 1013 do not survive by chance.
    #[test]
    fn rref_multimodular_when_primes_take_other_rows() {
        let p1 = Primes::new().next().unwrap();
        let z = |v: &[i64]| v.iter().map(|&x| BigInt::from(x)).collect::<Vec<_>>();
        let r0: Vec<BigInt> = [1009u64, 0, 1].iter().map(|&x| BigInt::from(x) * BigInt::from(p1)).collect();
        let a = ZMat::from_rows(vec![r0, z(&[0, 1013, 1]), z(&[1009, 1013, 2])]);
        let (nm, den, piv) = rref_multimodular(&a);
        assert_eq!(piv, vec![0, 1]);
        // [[1, 0, 1/1009], [0, 1, 1/1013]]
        assert_eq!(den, BigInt::from(1009 * 1013));
        assert_eq!(nm, ZMat::from_rows(vec![z(&[1009 * 1013, 0, 1013]), z(&[0, 1009 * 1013, 1009])]));
    }


    /// rref (with its one-prime, [I; 0] and Dixon paths) against the
    /// multimodular elimination alone, on random and rank-deficient matrices.
    #[test]
    fn rref_paths_agree_with_multimodular() {
        let mut s = 31u64;
        let mut cases: Vec<(&str, ZMat)> = vec![];
        // full column rank: square and tall, small and large entries
        for (n, range) in [(1, 3), (5, 2), (30, 2), (80, 2), (20, 1 << 40)] {
            cases.push(("square", rand_zmat(n, n, range, &mut s)));
        }
        cases.push(("tall", rand_zmat(40, 25, 5, &mut s)));
        // a few free columns: the Dixon path
        for f in [1, 2, 3] {
            cases.push(("near full", rand_zmat(48, 48 + f, 3, &mut s)));
        }
        // singular square: rank n - 1, one free column
        let mut b = rand_zmat(40, 40, 4, &mut s);
        for j in 0..40 {
            b.d[39 * 40 + j] = b.get(0, j) + b.get(1, j) * 3;
        }
        cases.push(("rank n-1", b));
        // many free columns or low rank: the multimodular path
        cases.push(("wide", rand_zmat(20, 40, 9, &mut s)));
        cases.push(("rank 4", rand_zmat(7, 4, 50, &mut s).mul(&rand_zmat(4, 9, 50, &mut s))));
        cases.push(("rank 30 of 60", rand_zmat(60, 30, 3, &mut s).mul(&rand_zmat(30, 31, 3, &mut s))));
        for (what, a) in &cases {
            assert_eq!(rref(a), rref_multimodular(a), "{what} {}x{}", a.rows, a.cols);
        }
    }

    /// A prime whose pivots are wrong fails rref_dixon's certificate, and
    /// rref falls back to the multimodular elimination.
    #[test]
    fn rref_unlucky_first_prime_falls_back() {
        let p0 = Primes::new().next().unwrap();
        let m = Modulus::new(p0);
        let mut s = 41u64;
        // column 0 a multiple of p0: modulo p0 the pivots are 1..=20, over Q 0..20
        let mut a = rand_zmat(20, 21, 7, &mut s);
        for i in 0..20 {
            a.d[i * 21] = BigInt::from(p0) * BigInt::from(i as i64 + 1);
        }
        let piv_p = a.reduce(&m).rref();
        assert_eq!(piv_p, (1..21).collect::<Vec<_>>());
        assert!(rref_dixon(&a, &piv_p, &m).is_none(), "zeros left of a pivot");
        let (_, _, piv) = rref(&a);
        assert_eq!(piv, (0..20).collect::<Vec<_>>());
        assert_eq!(rref(&a), rref_multimodular(&a));
        // a row that is in the row space modulo p0 only: rank 32 modulo p0, 33 over Q
        let mut b = rand_zmat(33, 33, 7, &mut s);
        for j in 0..33 {
            b.d[32 * 33 + j] = b.get(0, j).clone() + if j == 5 { BigInt::from(p0) } else { BigInt::zero() };
        }
        let piv_p = b.reduce(&m).rref();
        assert_eq!(piv_p.len(), 32);
        assert!(rref_dixon(&b, &piv_p, &m).is_none(), "a row outside the row space");
        assert_eq!(rref(&b), (ZMat::identity(33), BigInt::one(), (0..33).collect()));
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
