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
use std::hint::black_box;
use std::ops::Range;

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

/// The entries per call of the pre-scans' helpers.
const SCAN_CHUNK: usize = 1 << 12;

#[cfg(test)]
thread_local! {
    /// Tests only: the capacity of the last failed i64 conversion's vector
    /// when it gave up (the allocation control for a non-i64 entry).
    static FAILED_CONVERSION_CAPACITY: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}
/// The inner dimension from which [`ZMat::mul`]'s dot products are made
/// one output at a time (each by [`dot_run_i64`] or [`dot_run_big`]).
const MUL_STEP: usize = 1 << 16;

/// [`ZMat::prepare_product`]'s decision, made before any product is
/// allocated.
pub enum Prepared<'a> {
    Small(SmallPrep),
    Big(BigPrep<'a>),
}

/// An r x k by k x c product whose entries are all i64 and whose dot
/// products fit in i128 (proved by [`ZMat::prepare_product`]), with the
/// entries converted.
pub struct SmallPrep {
    r: usize,
    k: usize,
    c: usize,
    a: Vec<i64>,
    b: Vec<i64>,
}

/// A product in BigInt arithmetic, with the largest entries' bits.
pub struct BigPrep<'a> {
    a: &'a ZMat,
    o: &'a ZMat,
    #[allow(dead_code)]
    ba: u64,
    #[allow(dead_code)]
    bb: u64,
}

impl SmallPrep {
    /// The product's (rows, columns).
    pub fn rows_cols(&self) -> (usize, usize) {
        (self.r, self.c)
    }

    /// The product as a ZMat.
    pub fn compute_bigint(self) -> ZMat {
        let SmallPrep { r, k, c, a, b } = self;
        let mut d = Vec::with_capacity(r * c);
        if k < MUL_STEP {
            dot_block_i64(&a, &b, k, c, black_box(0..r), black_box(0..c), &mut d);
        } else {
            for i in 0..r {
                for j in 0..c {
                    let s = dot_run_i64(&a[i * k..(i + 1) * k], &b, c, j, black_box(0..k), 0);
                    d.push(BigInt::from(s));
                }
            }
        }
        ZMat { rows: r, cols: c, d }
    }
}

impl BigPrep<'_> {
    /// The product as a ZMat.
    pub fn compute(self) -> ZMat {
        let (a, o) = (self.a, self.o);
        let (r, k, c) = (a.rows, a.cols, o.cols);
        let mut d = Vec::with_capacity(r * c);
        for i in 0..r {
            for j in 0..c {
                let mut s = BigInt::zero();
                dot_run_big(&a.d[i * k..(i + 1) * k], &o.d, c, j, black_box(0..k), &mut s);
                d.push(s);
            }
            sagebrush_interrupt::check();
        }
        ZMat { rows: r, cols: c, d }
    }
}

// ---- the hot loops of ZMat::mul, each outlined (#[inline(never)], no
// closures, not generic) so that it compiles the same whatever the loop
// around it; the ranges come through black_box at every call

/// The largest bit length in a chunk of entries.
#[inline(never)]
fn scan_max_bits(chunk: &[BigInt]) -> u64 {
    chunk.iter().map(bits).max().unwrap_or(0)
}

/// Each entry of a chunk as an i64, pushed in order (growing `out` as
/// pushes do); false at the first that is not one.
#[inline(never)]
fn scan_to_i64(chunk: &[BigInt], out: &mut Vec<i64>) -> bool {
    for x in chunk {
        match x.to_i64() {
            Some(v) => out.push(v),
            None => return false,
        }
    }
    true
}

/// The i64 products' outputs (i, j) for i in rows, j in cols, row by row,
/// each dot product of k terms in i128, pushed in order.
#[inline(never)]
fn dot_block_i64(a: &[i64], b: &[i64], k: usize, c: usize, rows: Range<usize>, cols: Range<usize>, out: &mut Vec<BigInt>) {
    for i in rows {
        for j in cols.clone() {
            let mut s = 0i128;
            for l in 0..k {
                s += a[i * k + l] as i128 * b[l * c + j] as i128;
            }
            out.push(BigInt::from(s));
        }
    }
}

/// s plus the terms l in ls of row a (one row of A) times column j of B.
#[inline(never)]
fn dot_run_i64(a: &[i64], b: &[i64], c: usize, j: usize, ls: Range<usize>, s: i128) -> i128 {
    let mut s = s;
    for l in ls {
        s += a[l] as i128 * b[l * c + j] as i128;
    }
    s
}

/// The BigInt terms l in ls of row a times column j of B, added to s
/// (zero entries of a skipped).
#[inline(never)]
fn dot_run_big(a: &[BigInt], b: &[BigInt], c: usize, j: usize, ls: Range<usize>, s: &mut BigInt) {
    for l in ls {
        if !a[l].is_zero() {
            *s += &a[l] * &b[l * c + j];
        }
    }
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
        match self.prepare_product(o) {
            Prepared::Small(p) => p.compute_bigint(),
            Prepared::Big(p) => p.compute(),
        }
    }

    /// The product's path, decided once and before any product is
    /// allocated: Small (every entry an i64 and every dot product within
    /// i128: the largest entries' bits plus the bits of k under 126) with
    /// the entries converted, else Big.
    pub fn prepare_product<'a>(&'a self, o: &'a ZMat) -> Prepared<'a> {
        assert_eq!(self.cols, o.rows, "matrix dimensions do not match");
        let k = self.cols;
        let (ba, bb) = (self.max_bits_scanned(), o.max_bits_scanned());
        let small = ba + bb + (64 - (k as u64).leading_zeros() as u64) < 126;
        if small {
            if let (Some(a), Some(b)) = (self.as_i64_scanned(), o.as_i64_scanned()) {
                return Prepared::Small(SmallPrep { r: self.rows, k, c: o.cols, a, b });
            }
        }
        Prepared::Big(BigPrep { a: self, o, ba, bb })
    }

    /// [`max_bits`](ZMat::max_bits) in chunks of SCAN_CHUNK entries.
    fn max_bits_scanned(&self) -> u64 {
        let mut m = 0;
        for chunk in self.d.chunks(SCAN_CHUNK) {
            m = m.max(scan_max_bits(black_box(chunk)));
        }
        m
    }

    /// [`as_i64`](ZMat::as_i64) in chunks of SCAN_CHUNK entries, growing
    /// as it converts, as master's collect into `Option<Vec<i64>>` does:
    /// nothing is reserved before an entry is known to fit, so a failing
    /// conversion holds no more than the entries before its failure
    /// (never a whole-operand buffer for an operand that then takes the Big
    /// path).
    fn as_i64_scanned(&self) -> Option<Vec<i64>> {
        let mut v = Vec::new();
        for chunk in self.d.chunks(SCAN_CHUNK) {
            if !scan_to_i64(black_box(chunk), &mut v) {
                #[cfg(test)]
                FAILED_CONVERSION_CAPACITY.with(|c| c.set(Some(v.capacity())));
                return None;
            }
        }
        Some(v)
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
            let mut found = None;
            for p in Primes::below(below).skip(3) {
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
/// Multimodular: modulo each prime, the rref R_p and d_p = det A[S, P]
/// for a fixed nonsingular pivot minor (rows S, pivot columns P) give
/// N = d R modulo p, reconstructed by CRT (|N|, |d| are r x r minors, so
/// below the Hadamard bound B).  The identity A d = A[:, P] N holds
/// modulo every prime used, and its entries are below (r + 1) |A| B, so
/// once the primes' product exceeds twice that it holds over Z: then the
/// rows of A lie in the row space of N, which has rank r = rank A[S, P]
/// <= rank A, so N / d is the reduced echelon form.  Primes whose pivots
/// differ from the best seen are skipped (an unlucky prime only loses
/// rank or moves pivots right).
pub fn rref(a: &ZMat) -> (ZMat, BigInt, Vec<usize>) {
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
        let piv = r.rref();
        let reset = match &best {
            None => true,
            Some(b) => better(&piv, b),
        };
        if reset {
            if piv.is_empty() {
                continue;
            }
            // rows S: independent rows of A[:, P] modulo p
            let mut t = a.select(&(0..a.rows).collect::<Vec<_>>(), &piv).transpose().reduce(&m);
            srows = t.rref();
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
        let dp = a.select(&srows, pv).reduce(&m).det();
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

    /// master's ZMat::mul before the outlining, verbatim: the reference.
    fn mul_reference(a: &ZMat, o: &ZMat) -> ZMat {
        let (r, k, c) = (a.rows, a.cols, o.cols);
        let small = a.max_bits() + o.max_bits() + (64 - (k as u64).leading_zeros() as u64) < 126;
        if small {
            if let (Some(x), Some(y)) = (a.as_i64(), o.as_i64()) {
                let mut d = Vec::with_capacity(r * c);
                for i in 0..r {
                    for j in 0..c {
                        let mut s = 0i128;
                        for l in 0..k {
                            s += x[i * k + l] as i128 * y[l * c + j] as i128;
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
                    if !a.d[i * k + l].is_zero() {
                        s += &a.d[i * k + l] * &o.d[l * c + j];
                    }
                }
                d.push(s);
            }
        }
        ZMat { rows: r, cols: c, d }
    }

    fn big_zmat(r: usize, c: usize, bits: u32, s: &mut u64) -> ZMat {
        ZMat {
            rows: r,
            cols: c,
            d: (0..r * c)
                .map(|_| {
                    let x = (BigInt::from(rng(s)) << (bits.saturating_sub(64) as usize)) + BigInt::from(rng(s));
                    if rng(s) & 1 == 0 { -x } else { x }
                })
                .collect(),
        }
    }

    #[test]
    fn outlined_mul_equals_the_reference() {
        let mut s = 0x241a_u64;
        // small (i64 path), both sides of MUL_STEP, empty dimensions, K = 0
        for (r, k, c, range) in [(1, 1, 1, 9), (3, 5, 4, 1 << 40), (1, 4095, 1, 1 << 30), (1, 4097, 1, 1 << 30), (2, MUL_STEP - 1, 3, 1000),
                                 (2, MUL_STEP, 2, 1000), (1, MUL_STEP + 5, 2, 1 << 20), (0, 3, 4, 9), (3, 0, 4, 9), (3, 4, 0, 9), (4, 1, 4, 1 << 62)] {
            let (a, b) = (rand_zmat(r, k, range, &mut s), rand_zmat(k, c, range, &mut s));
            assert_eq!(a.mul(&b), mul_reference(&a, &b), "{r}x{k}x{c} range {range}");
        }
        // i64::MIN and extremes: i64 entries whose bits sum past 126 go Big
        let mut a = rand_zmat(2, 3, 5, &mut s);
        a.d[0] = BigInt::from(i64::MIN);
        a.d[4] = BigInt::from(i64::MAX);
        let b = a.transpose();
        assert_eq!(a.mul(&b), mul_reference(&a, &b));
        // BigInt path: large entries, zeros inside (the zero skip)
        for (r, k, c, bits) in [(2, 3, 2, 100), (1, 50, 1, 300), (3, 7, 5, 70), (2, MUL_STEP + 1, 1, 65)] {
            let (mut a, b) = (big_zmat(r, k, bits, &mut s), big_zmat(k, c, bits, &mut s));
            for x in a.d.iter_mut().step_by(3) {
                *x = BigInt::zero();
            }
            assert_eq!(a.mul(&b), mul_reference(&a, &b), "big {r}x{k}x{c} {bits} bits");
        }
    }

    #[test]
    fn prepare_product_decides_once_as_before() {
        let mut s = 7u64;
        let (a, b) = (rand_zmat(3, 4, 1000, &mut s), rand_zmat(4, 2, 1000, &mut s));
        match a.prepare_product(&b) {
            Prepared::Small(p) => {
                assert_eq!(p.rows_cols(), (3, 2));
                assert_eq!(p.compute_bigint(), mul_reference(&a, &b));
            }
            Prepared::Big(_) => panic!("small entries must take the i64 path"),
        }
        // bits at the bound: 62 + 62 + bitlen(4) = 127 is not under 126
        let x = ZMat { rows: 1, cols: 4, d: vec![BigInt::from(1i64 << 61); 4] };
        let y = x.transpose();
        assert!(matches!(x.prepare_product(&y), Prepared::Big(_)));
        // fits the bits test but an entry is not an i64: Big too
        let mut z = ZMat { rows: 1, cols: 1, d: vec![BigInt::from(1u64 << 63)] };
        let one = ZMat { rows: 1, cols: 1, d: vec![BigInt::from(1)] };
        assert!(matches!(z.prepare_product(&one), Prepared::Big(_)));
        z.d[0] = BigInt::from(5);
        assert!(matches!(z.prepare_product(&one), Prepared::Small(_)));
    }

    /// The failed conversion's allocation control: a first or early non-i64
    /// entry, in either operand, with the bit test still passing and a tall
    /// A over a small result.  The exact Big result, and the failed
    /// conversion holds at most what master's collect would have (nothing
    /// when the first entry fails; the doubling capacity of the entries
    /// before the failure otherwise), never a whole-operand buffer.
    #[test]
    fn failed_conversion_keeps_masters_allocation() {
        let probe = || FAILED_CONVERSION_CAPACITY.with(|c| c.take());
        let (r, k) = (512, 512);
        let big = BigInt::from(1u64 << 63);
        for (at, max_cap) in [(0usize, 0usize), (5, 8), (4095, 4096), (4096, 4096)] {
            // A: tall, zeros but one 2^63 at `at`; B: k x 1 zeros (64 + 0 + 10 bits < 126)
            let mut a = ZMat::zero(r, k);
            a.d[at] = big.clone();
            let b = ZMat::zero(k, 1);
            probe();
            assert_eq!(a.mul(&b), mul_reference(&a, &b), "A fails at {at}");
            let cap = probe().expect("A's conversion failed");
            assert!(cap <= max_cap, "A fails at {at}: the failed conversion held {cap} entries, at most {max_cap} allowed");
            assert!(cap < r * k, "never a whole-operand buffer");
            // B fails instead (A converts, as master's tuple converts both)
            let a2 = ZMat::zero(1, k);
            let mut b2 = ZMat::zero(k, r);
            b2.d[at] = big.clone();
            probe();
            assert_eq!(a2.mul(&b2), mul_reference(&a2, &b2), "B fails at {at}");
            let cap = probe().expect("B's conversion failed");
            assert!(cap <= max_cap && cap < k * r, "B fails at {at}: the failed conversion held {cap} entries");
        }
        // a successful conversion still converts everything (the Small path)
        let (a, b) = (ZMat::zero(r, k), ZMat::zero(k, 1));
        probe();
        assert!(matches!(a.prepare_product(&b), Prepared::Small(_)));
        assert_eq!(probe(), None);
    }

    #[test]
    fn outlined_helpers_equal_their_loops() {
        let mut s = 11u64;
        let (r, k, c) = (3, 9, 5);
        let a: Vec<i64> = (0..r * k).map(|_| rng(&mut s) as i64 >> 2).collect();
        let b: Vec<i64> = (0..k * c).map(|_| rng(&mut s) as i64 >> 2).collect();
        let dot = |i: usize, j: usize| (0..k).fold(0i128, |s, l| s + a[i * k + l] as i128 * b[l * c + j] as i128);
        // a block of outputs, in order
        let mut out = Vec::new();
        dot_block_i64(&a, &b, k, c, 1..3, 2..4, &mut out);
        assert_eq!(out, vec![BigInt::from(dot(1, 2)), BigInt::from(dot(1, 3)), BigInt::from(dot(2, 2)), BigInt::from(dot(2, 3))]);
        // a run continues a partial sum
        let half = dot_run_i64(&a[2 * k..3 * k], &b, c, 4, 0..4, 0);
        assert_eq!(dot_run_i64(&a[2 * k..3 * k], &b, c, 4, 4..k, half), dot(2, 4));
        // BigInt runs the same way
        let (ab, bb): (Vec<BigInt>, Vec<BigInt>) = (a.iter().map(|&x| BigInt::from(x)).collect(), b.iter().map(|&x| BigInt::from(x)).collect());
        let mut t = BigInt::zero();
        dot_run_big(&ab[k..2 * k], &bb, c, 0, 0..5, &mut t);
        dot_run_big(&ab[k..2 * k], &bb, c, 0, 5..k, &mut t);
        assert_eq!(t, BigInt::from(dot(1, 0)));
        // the scans
        let m = big_zmat(2, 3, 130, &mut s);
        assert_eq!(scan_max_bits(&m.d), m.max_bits());
        let mut v = Vec::with_capacity(ab.len());
        assert!(scan_to_i64(&ab, &mut v) && v == a);
        let mut w = Vec::with_capacity(m.d.len());
        assert!(!scan_to_i64(&m.d, &mut w));
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
