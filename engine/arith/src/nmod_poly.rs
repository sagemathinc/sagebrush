//! Polynomials over Z/n (word-size n), as coefficient vectors with the
//! constant term first and no trailing zeros (the zero polynomial is
//! empty).  Products use schoolbook multiplication with delayed reduction
//! for short inputs and the NTT ([`crate::ntt::mul_mod`]) otherwise;
//! division by long divisors uses Newton iteration for the inverse of the
//! reversed divisor (von zur Gathen and Gerhard, Modern Computer Algebra,
//! section 9.1).

use crate::cost::Family;
use crate::nmod::Modulus;
use crate::cost::FAMILIES;
use crate::cost::{publish_progress, tally, tally_all};
use crate::ntt;

pub type Poly = Vec<u64>;

/// Where products get their transform tables: the shared cache, or a
/// computation's own ([`ntt::LocalTables`], bounded by its sizes).
#[derive(Clone, Copy)]
enum Tabs<'a> {
    Shared,
    Local(&'a ntt::LocalTables),
}

/// Asks for Stop (check_coarse, which asks the wasm host at every call)
/// about every 2^16 units of work; counts the units by family
/// ([`cost::tally`](crate::cost::tally)) and publishes a metered region's
/// progress at each poll.
pub(crate) struct Poll {
    since: u64,
    /// The part of `since` already counted: the rest is multiply-adds
    /// (MulSchool), so on the hot path the Stop counter is the unit
    /// counter and a row costs one add, as before metering.
    mark: u64,
    /// Units counted since the last flush, per family: flushed to the
    /// thread's counter at each poll and when the Poll drops (one
    /// thread-local access per kernel call, not per row).
    acc: [u64; FAMILIES],
}

impl Poll {
    pub(crate) fn new() -> Poll {
        Poll { since: 0, mark: 0, acc: [0; FAMILIES] }
    }
    /// `work` units of family `f`, of which `poll` count toward the next
    /// Stop poll (the poll interval keeps its old weights where a unit is
    /// cheaper than its weight: an inverse).
    #[inline]
    pub(crate) fn add_weighted(&mut self, f: Family, work: usize, poll: usize) {
        self.settle();
        self.acc[f as usize] += work as u64;
        self.since += poll as u64;
        self.mark = self.since;
        self.check();
    }
    /// `work` multiply-adds (MulSchool), all counting toward the next poll.
    #[inline]
    pub(crate) fn mul_adds(&mut self, work: usize) {
        self.since += work as u64;
        self.check();
    }
    #[inline]
    fn settle(&mut self) {
        self.acc[Family::MulSchool as usize] += self.since - self.mark;
        self.mark = self.since;
    }
    #[inline]
    fn check(&mut self) {
        if self.since >= 1 << 16 {
            self.flush();
            self.since = 0;
            self.mark = 0;
            sagebrush_interrupt::check_coarse();
            publish_progress();
        }
    }
    fn flush(&mut self) {
        self.settle();
        if self.acc.iter().any(|&x| x != 0) {
            tally_all(&self.acc);
            self.acc = [0; FAMILIES];
        }
    }
}

impl Drop for Poll {
    fn drop(&mut self) {
        // (also while unwinding: work done before a Stop is still counted)
        self.flush();
    }
}

/// Products with a factor shorter than this are schoolbook.
pub const MUL_CUTOFF: usize = 40;
/// Divisions with divisor and quotient both at least this long use Newton.
pub const DIV_CUTOFF: usize = 60;

pub fn trim(mut v: Poly) -> Poly {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

/// The degree (-1 for zero).
pub fn degree(a: &[u64]) -> isize {
    a.len() as isize - 1
}

/// How many products of reduced residues fit in a u128 sum.
fn batch(m: &Modulus) -> usize {
    let sq = (m.n as u128 - 1) * (m.n as u128 - 1);
    if sq == 0 {
        usize::MAX
    } else {
        (u128::MAX / sq).min(usize::MAX as u128) as usize
    }
}

fn mul_classical(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
    let len = a.len() + b.len() - 1;
    let k = batch(m);
    let mut c = Vec::with_capacity(len);
    let mut poll = Poll::new();
    for i in 0..len {
        let lo = i.saturating_sub(b.len() - 1);
        let hi = i.min(a.len() - 1);
        poll.mul_adds(hi - lo + 1);
        let mut acc = 0u128;
        let mut cnt = 0;
        let mut r = 0u64;
        for j in lo..=hi {
            acc += a[j] as u128 * b[i - j] as u128;
            cnt += 1;
            if cnt == k {
                r = m.add(r, m.reduce_u128(acc));
                acc = 0;
                cnt = 0;
            }
        }
        c.push(m.add(r, m.reduce_u128(acc)));
    }
    c
}

/// a * b mod n.
pub fn mul(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
    mul_t(a, b, m, Tabs::Shared)
}

/// [`mul`] with the caller's transform tables (for products of length at
/// least a.len() + b.len() - 1).
pub fn mul_in(a: &[u64], b: &[u64], m: &Modulus, lt: &ntt::LocalTables) -> Poly {
    mul_t(a, b, m, Tabs::Local(lt))
}

fn mul_t(a: &[u64], b: &[u64], m: &Modulus, t: Tabs) -> Poly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let square = std::ptr::eq(a, b);
    let c = if a.len().min(b.len()) < MUL_CUTOFF {
        mul_classical(a, b, m)
    } else {
        let b = if square { a } else { b };
        match t {
            Tabs::Shared => ntt::mul_mod(a, b, m),
            Tabs::Local(lt) => ntt::mul_mod_in(a, b, m, lt),
        }
    };
    trim(c)
}

/// The longest product [`mul_in`] transforms for factors of these lengths
/// (0 when the product is schoolbook): the LocalTables to build.
pub fn mul_table_len(la: usize, lb: usize) -> usize {
    if la == 0 || lb == 0 || la.min(lb) < MUL_CUTOFF {
        0
    } else {
        la + lb - 1
    }
}

/// a * b mod (n, x^k).
pub fn mullow(a: &[u64], b: &[u64], k: usize, m: &Modulus) -> Poly {
    mullow_t(a, b, k, m, Tabs::Shared)
}

fn mullow_t(a: &[u64], b: &[u64], k: usize, m: &Modulus, t: Tabs) -> Poly {
    let a = &a[..a.len().min(k)];
    let b = &b[..b.len().min(k)];
    let mut c = mul_t(a, b, m, t);
    c.truncate(k);
    trim(c)
}

pub fn add(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
    let (long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    tally(Family::Move, long.len() as u64);
    tally(Family::ModArith, short.len() as u64);
    let mut c = long.to_vec();
    for (x, &y) in c.iter_mut().zip(short) {
        *x = m.add(*x, y);
    }
    trim(c)
}

pub fn sub(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
    tally(Family::Move, a.len().max(b.len()) as u64);
    tally(Family::ModArith, b.len() as u64);
    let mut c = a.to_vec();
    if c.len() < b.len() {
        c.resize(b.len(), 0);
    }
    for (x, &y) in c.iter_mut().zip(b) {
        *x = m.sub(*x, y);
    }
    trim(c)
}

pub fn scale(a: &[u64], s: u64, m: &Modulus) -> Poly {
    tally(Family::ModArith, a.len() as u64);
    trim(a.iter().map(|&x| m.mul(x, s)).collect())
}

pub fn neg(a: &[u64], m: &Modulus) -> Poly {
    tally(Family::ModArith, a.len() as u64);
    a.iter().map(|&x| m.neg(x)).collect()
}

/// The monic associate (n prime, or a's leading coefficient a unit).
pub fn monic(a: &[u64], m: &Modulus) -> Poly {
    match a.last() {
        None => vec![],
        Some(&l) => {
            // (the inverse: one ModArith unit; the scaling: a.len())
            tally(Family::ModArith, 1);
            scale(a, m.inv(l).expect("leading coefficient not a unit"), m)
        }
    }
}

pub fn derivative(a: &[u64], m: &Modulus) -> Poly {
    tally(Family::ModArith, a.len().saturating_sub(1) as u64);
    trim(a.iter().enumerate().skip(1).map(|(i, &c)| m.mul(m.reduce(i as u64), c)).collect())
}

pub fn eval(a: &[u64], x: u64, m: &Modulus) -> u64 {
    tally(Family::MulSchool, a.len() as u64);
    a.iter().rev().fold(0, |acc, &c| m.add(m.mul(acc, x), c))
}

/// The inverse of f modulo x^k (f[0] a unit), by Newton iteration.
pub fn inv_series(f: &[u64], k: usize, m: &Modulus) -> Poly {
    inv_series_t(f, k, m, Tabs::Shared)
}

fn inv_series_t(f: &[u64], k: usize, m: &Modulus, t: Tabs) -> Poly {
    let _phase = sagebrush_interrupt::enter("newton-inverse");
    let mut g = vec![m.inv(f[0]).expect("constant term not a unit")];
    let mut len = 1;
    while len < k {
        sagebrush_interrupt::check_coarse();
        len = (2 * len).min(k);
        // g <- g (2 - f g) mod x^len
        let mut h = neg(&mullow_t(f, &g, len, m, t), m);
        if h.is_empty() {
            h.push(0);
        }
        h[0] = m.add(h[0], 2 % m.n);
        g = mullow_t(&g, &trim(h), len, m, t);
    }
    g
}

/// A copy of a polynomial, counted as Move.
#[inline]
fn copy(a: &[u64]) -> Poly {
    tally(Family::Move, a.len() as u64);
    a.to_vec()
}

fn rev(a: &[u64], len: usize) -> Poly {
    tally(Family::Move, len.max(a.len()) as u64);
    let mut r: Poly = a.iter().rev().cloned().collect();
    r.resize(len, 0);
    r
}

/// dst += c * src (mod n), c reduced.
#[inline]
fn axpy(dst: &mut [u64], src: &[u64], c: u64, m: &Modulus) {
    if m.n < 1 << 63 {
        let cp = m.shoup(c);
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = m.add(*x, crate::nmod::mul_shoup(y, c, cp, m.n));
        }
    } else {
        for (x, &y) in dst.iter_mut().zip(src) {
            *x = m.add(*x, m.mul(y, c));
        }
    }
}

/// x mod n for x < 2^64 and 2 <= n < 2^32, given v = floor(2^64 / n):
/// v > 2^64/n - 1, so q = floor(x v / 2^64) > x/n - x/2^64 - 1 > x/n - 2,
/// hence 0 <= x - q n < 2n, and one masked subtraction reduces it.
#[inline(always)]
fn barrett(x: u64, n: u64, v: u64) -> u64 {
    let q = ((x as u128 * v as u128) >> 64) as u64;
    let r = x - q * n;
    r - (n & ((r >= n) as u64).wrapping_neg())
}

/// r <- r mod b in place, recording the quotient if asked.
/// (Stop is polled through `poll`, a row of db multiply-adds at a time.)
fn rem_in_place(r: &mut Poly, b: &[u64], linv: u64, m: &Modulus, mut q: Option<&mut Poly>, poll: &mut Poll) {
    let db = b.len() - 1;
    if r.len() <= db {
        return;
    }
    if let Some(q) = q.as_deref_mut() {
        q.clear();
        q.resize(r.len() - db, 0);
    }
    if r.len() - db <= 2 && db >= 1 && m.n < 1 << 62 {
        // the usual Euclid step: both quotient coefficients first, then one
        // fused pass (row by row, each row would wait on the previous one)
        let ql = r.len() - db;
        poll.mul_adds(2 * db);
        let q1 = m.mul(r[r.len() - 1], linv);
        let q0 = if ql == 2 { m.mul(m.sub(r[db], m.mul(q1, b[db - 1])), linv) } else { 0 };
        let (q0, q1) = if ql == 2 { (q0, q1) } else { (q1, 0) };
        if let Some(q) = q.as_deref_mut() {
            q[0] = q0;
            if ql == 2 {
                q[1] = q1;
            }
        }
        let (n0, n1) = (m.neg(q0), m.neg(q1));
        let (p0, p1) = (m.shoup(n0), m.shoup(n1));
        let n = m.n;
        if db > 0 {
            r[0] = m.add(r[0], crate::nmod::mul_shoup(b[0], n0, p0, n));
        }
        for j in 1..db {
            // < 3n < 2^64, then two branch-free conditional subtractions
            let s = r[j] + crate::nmod::mul_shoup(b[j], n0, p0, n) + crate::nmod::mul_shoup(b[j - 1], n1, p1, n);
            let s = s - (n & ((s >= n) as u64).wrapping_neg());
            r[j] = s - (n & ((s >= n) as u64).wrapping_neg());
        }
        r.truncate(db);
        while r.last() == Some(&0) {
            r.pop();
        }
        return;
    }
    if m.n >= 2 && m.n < 1 << 32 {
        // A half-word modulus: every row update x + c' y (x, c', y < n) is
        // below n + n^2 <= 2^64 and is reduced by one Barrett step with no
        // division and no data-dependent branch.  The Shoup rows below ran
        // about 3x slower on varying inputs than on a repeated one (and 5x
        // slower than these) on an AMD Zen 3; the results are identical.
        let n = m.n;
        let v = ((1u128 << 64) / n as u128) as u64;
        for i in (0..r.len() - db).rev() {
            poll.mul_adds(db + 1);
            let c = barrett(r[i + db] * linv, n, v);
            if let Some(q) = q.as_deref_mut() {
                q[i] = c;
            }
            if c != 0 {
                let nc = n - c;
                for (x, &y) in r[i..i + db].iter_mut().zip(&b[..db]) {
                    *x = barrett(*x + nc * y, n, v);
                }
            }
        }
    } else {
        for i in (0..r.len() - db).rev() {
            poll.mul_adds(db + 1);
            let c = m.mul(r[i + db], linv);
            if let Some(q) = q.as_deref_mut() {
                q[i] = c;
            }
            if c != 0 {
                axpy(&mut r[i..i + db], &b[..db], m.neg(c), m);
            }
        }
    }
    r.truncate(db);
    while r.last() == Some(&0) {
        r.pop();
    }
}

fn divrem_classical(a: &[u64], b: &[u64], linv: u64, m: &Modulus) -> (Poly, Poly) {
    let _phase = sagebrush_interrupt::enter("classical-divide");
    let mut r = copy(a);
    let mut q = vec![];
    rem_in_place(&mut r, b, linv, m, Some(&mut q), &mut Poll::new());
    (trim(q), r)
}

/// The monic gcd by Euclid's algorithm, in place: at most
/// lb (la + lb) + 129 lb + 128 multiply-adds for inputs of lengths la >=
/// lb (the quotient rows of all steps number at most la + lb), polled
/// every 2^16 of them.
fn gcd_euclid(mut a: Poly, mut b: Poly, m: &Modulus) -> Poly {
    let _phase = sagebrush_interrupt::enter("euclid");
    let mut poll = Poll::new();
    while !b.is_empty() {
        // (one inverse of the leading coefficient: one ModArith unit, weighted
        // 128 toward the next Stop poll as before)
        poll.add_weighted(Family::ModArith, 1, 128);
        let linv = m.inv(*b.last().unwrap()).expect("modulus not prime");
        rem_in_place(&mut a, &b, linv, m, None, &mut poll);
        std::mem::swap(&mut a, &mut b);
    }
    monic(&a, m)
}

/// The monic gcd by Euclid's algorithm alone (n prime), of a and b taken
/// by value (no copies); gcd(0, 0) = 0.  The same gcd as [`gcd`].
pub fn gcd_classical(a: Poly, b: Poly, m: &Modulus) -> Poly {
    let (mut a, mut b) = (trim(a), trim(b));
    if a.len() < b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    gcd_euclid(a, b, m)
}

/// Quotient and remainder of a by b (b nonzero with unit leading
/// coefficient).
pub fn divrem(a: &[u64], b: &[u64], m: &Modulus) -> (Poly, Poly) {
    divrem_t(a, b, m, Tabs::Shared)
}

/// [`divrem`] with the caller's transform tables, for products up to
/// length a.len() (see [`divrem_table_len`]).
pub fn divrem_in(a: &[u64], b: &[u64], m: &Modulus, lt: &ntt::LocalTables) -> (Poly, Poly) {
    divrem_t(a, b, m, Tabs::Local(lt))
}

/// The longest product [`divrem_in`] computes for these lengths (0 when
/// it computes none): the LocalTables to build.
pub fn divrem_table_len(la: usize, lb: usize) -> usize {
    if lb == 0 || la < lb || lb < DIV_CUTOFF || la - lb + 1 < DIV_CUTOFF {
        return 0;
    }
    // inv_series and the quotient: factors cut to at most ql, products
    // shorter than 2 ql; the remainder: factors cut to lb - 1, shorter
    // than 2 lb
    let ql = la - lb + 1;
    2 * ql.max(lb)
}

fn divrem_t(a: &[u64], b: &[u64], m: &Modulus, t: Tabs) -> (Poly, Poly) {
    assert!(!b.is_empty(), "division by zero polynomial");
    if a.len() < b.len() {
        return (vec![], copy(a));
    }
    let linv = m.inv(*b.last().unwrap()).expect("leading coefficient not a unit");
    tally(Family::ModArith, 1);
    let ql = a.len() - b.len() + 1;
    if b.len() < DIV_CUTOFF || ql < DIV_CUTOFF {
        return divrem_classical(a, b, linv, m);
    }
    let binv = inv_series_t(&rev(b, b.len()), ql, m, t);
    divrem_with_inverse_t(a, b, &binv, m, t)
}

/// Division given binv = 1/rev(b) mod x^k with k >= the quotient length.
fn divrem_with_inverse_t(a: &[u64], b: &[u64], binv: &[u64], m: &Modulus, t: Tabs) -> (Poly, Poly) {
    let _phase = sagebrush_interrupt::enter("newton-divide");
    sagebrush_interrupt::check_coarse();
    if a.len() < b.len() {
        return (vec![], copy(a));
    }
    let ql = a.len() - b.len() + 1;
    let ra = rev(a, a.len());
    let mut q = mullow_t(&ra[..ql], binv, ql, m, t);
    q.resize(ql, 0);
    q.reverse();
    let q = trim(q);
    sagebrush_interrupt::check_coarse();
    let db = b.len() - 1;
    let r = sub(&a[..db.min(a.len())], &mullow_t(&q, b, db, m, t), m);
    (q, r)
}

pub fn rem(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
    divrem(a, b, m).1
}

/// The monic gcd (n prime): Euclid for short inputs, otherwise the
/// half-gcd ([`hgcd`]), O(M(n) log n).
pub fn gcd(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
    gcd_t(copy(a), copy(b), m, Tabs::Shared)
}

/// [`gcd`] of a and b taken by value, with the caller's transform tables
/// (for products up to [`gcd_table_len`] of their lengths).
pub fn gcd_in(a: Poly, b: Poly, m: &Modulus, lt: &ntt::LocalTables) -> Poly {
    gcd_t(a, b, m, Tabs::Local(lt))
}

/// The longest product [`gcd_in`] computes for inputs of these lengths (0
/// when it computes none: Euclid's algorithm alone): the LocalTables to
/// build.  Every product of the half-gcd and of the remainders between
/// its calls is shorter than 2 max(la, lb): a division of a polynomial of
/// length at most L needs tables of 2 max(ql, lb) <= 2 L
/// ([`divrem_table_len`]), and the matrix products are shorter than 3 L / 2.
pub fn gcd_table_len(la: usize, lb: usize) -> usize {
    if la.min(lb) <= GCD_CUTOFF {
        0
    } else {
        2 * la.max(lb)
    }
}

fn gcd_t(a: Poly, b: Poly, m: &Modulus, t: Tabs) -> Poly {
    let (mut a, mut b) = (trim(a), trim(b));
    if a.len() < b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    while !b.is_empty() {
        sagebrush_interrupt::check();
        if b.len() <= GCD_CUTOFF {
            return gcd_euclid(a, b, m);
        }
        if a.len() > b.len() {
            let _phase = sagebrush_interrupt::enter("half-gcd");
            let n = hgcd_t(&a, &b, m, t);
            let (x, y) = n.apply_t(&a, &b, m, t);
            a = x;
            b = y;
            if b.is_empty() {
                break;
            }
        }
        let r = divrem_t(&a, &b, m, t).1;
        a = std::mem::replace(&mut b, r);
    }
    monic(&a, m)
}

/// Inputs to the half-gcd shorter than this use Euclid's steps directly.
pub const HGCD_CUTOFF: usize = 64;
/// gcds of inputs shorter than this use Euclid's algorithm.
pub const GCD_CUTOFF: usize = 1000;

/// A 2x2 matrix of polynomials: the product of Euclid steps
/// (a, b) -> (b, a - q b), acting on column vectors.
#[derive(Clone, Debug)]
pub struct Mat2 {
    pub m: [Poly; 4],
}

impl Mat2 {
    fn identity() -> Mat2 {
        Mat2 { m: [vec![1], vec![], vec![], vec![1]] }
    }

    /// self * o.
    fn mul_t(&self, o: &Mat2, md: &Modulus, t: Tabs) -> Mat2 {
        let [a, b, c, d] = &self.m;
        let [e, f, g, h] = &o.m;
        let p = |x: &Poly, y: &Poly, z: &Poly, w: &Poly| add(&mul_t(x, y, md, t), &mul_t(z, w, md, t), md);
        Mat2 { m: [p(a, e, b, g), p(a, f, b, h), p(c, e, d, g), p(c, f, d, h)] }
    }

    /// The Euclid step for quotient q, times self.
    fn step_t(&self, q: &[u64], md: &Modulus, t: Tabs) -> Mat2 {
        let [a, b, c, d] = &self.m;
        Mat2 { m: [copy(c), copy(d), sub(a, &mul_t(q, c, md, t), md), sub(b, &mul_t(q, d, md, t), md)] }
    }

    /// self * (a, b).
    pub fn apply(&self, a: &[u64], b: &[u64], md: &Modulus) -> (Poly, Poly) {
        self.apply_t(a, b, md, Tabs::Shared)
    }

    fn apply_t(&self, a: &[u64], b: &[u64], md: &Modulus, t: Tabs) -> (Poly, Poly) {
        let [m11, m12, m21, m22] = &self.m;
        (
            add(&mul_t(m11, a, md, t), &mul_t(m12, b, md, t), md),
            add(&mul_t(m21, a, md, t), &mul_t(m22, b, md, t), md),
        )
    }
}

fn shift(a: &[u64], k: usize) -> Poly {
    if a.len() <= k {
        vec![]
    } else {
        copy(&a[k..])
    }
}

/// The half-gcd (C. Yap, Fundamental Problems of Algorithmic Algebra,
/// Lecture VIII; Thull and Yap 1990): for deg a = n > deg b, the product N
/// of the Euclid steps after which (a', b') = N (a, b) are consecutive
/// remainders with deg a' >= ceil(n/2) > deg b'.
pub fn hgcd(a: &[u64], b: &[u64], md: &Modulus) -> Mat2 {
    hgcd_t(a, b, md, Tabs::Shared)
}

fn hgcd_t(a: &[u64], b: &[u64], md: &Modulus, t: Tabs) -> Mat2 {
    let n = a.len() - 1;
    let m = n.div_ceil(2);
    if b.len() <= m {
        return Mat2::identity();
    }
    if n < HGCD_CUTOFF {
        // Euclid's steps until the degree drops below m
        let mut m2 = Mat2::identity();
        let (mut x, mut y) = (copy(a), copy(b));
        while y.len() > m {
            let (q, r) = divrem_t(&x, &y, md, t);
            m2 = m2.step_t(&q, md, t);
            x = std::mem::replace(&mut y, r);
        }
        return m2;
    }
    let r = hgcd_t(&shift(a, m), &shift(b, m), md, t);
    let (a1, b1) = r.apply_t(a, b, md, t);
    if b1.len() <= m {
        return r;
    }
    let (q, d) = divrem_t(&a1, &b1, md, t);
    let qr = r.step_t(&q, md, t);
    if d.len() <= m {
        return qr;
    }
    let l = b1.len() - 1;
    let k = 2 * m - l;
    let s = hgcd_t(&shift(&b1, k), &shift(&d, k), md, t);
    s.mul_t(&qr, md, t)
}

/// (g, s, t) with g = s a + t b the monic gcd (n prime).
pub fn xgcd(a: &[u64], b: &[u64], m: &Modulus) -> (Poly, Poly, Poly) {
    let (mut r0, mut r1) = (trim(copy(a)), trim(copy(b)));
    let (mut s0, mut s1) = (vec![1 % m.n], vec![]);
    let (mut t0, mut t1) = (vec![], vec![1 % m.n]);
    while !r1.is_empty() {
        sagebrush_interrupt::check();
        let (q, r) = divrem(&r0, &r1, m);
        let s = sub(&s0, &mul(&q, &s1, m), m);
        let t = sub(&t0, &mul(&q, &t1, m), m);
        (r0, r1) = (r1, r);
        (s0, s1) = (s1, s);
        (t0, t1) = (t1, t);
    }
    match r0.last() {
        None => (vec![], vec![], vec![]),
        Some(&l) => {
            let li = m.inv(l).unwrap();
            (scale(&r0, li, m), scale(&s0, li, m), scale(&t0, li, m))
        }
    }
}

/// Reduction modulo a fixed polynomial f (unit leading coefficient), with
/// the inverse of its reversal precomputed.
pub struct PolyModulus {
    pub f: Poly,
    finv: Poly,
    /// The precision of finv: 1/rev(f) mod x^prec.  finv itself may be
    /// shorter (its top coefficients zero, as for a sparse f), so the
    /// branch in reduce reads this, never finv.len(), as reduce_work does.
    prec: usize,
    pub m: Modulus,
}

impl PolyModulus {
    pub fn new(f: &[u64], m: &Modulus) -> PolyModulus {
        PolyModulus::new_t(f, m, Tabs::Shared)
    }

    /// [`PolyModulus::new`] with the caller's transform tables (for
    /// products up to 2 f.len()).
    pub fn new_in(f: &[u64], m: &Modulus, lt: &ntt::LocalTables) -> PolyModulus {
        PolyModulus::new_t(f, m, Tabs::Local(lt))
    }

    fn new_t(f: &[u64], m: &Modulus, t: Tabs) -> PolyModulus {
        let f = trim(copy(f));
        assert!(!f.is_empty(), "zero modulus");
        let prec = f.len().max(2) - 1;
        let finv = inv_series_t(&rev(&f, f.len()), prec, m, t);
        PolyModulus { f, finv, prec, m: *m }
    }

    /// x mod f, for deg x < 2 deg f.
    pub fn reduce(&self, x: &[u64]) -> Poly {
        self.reduce_t(x, Tabs::Shared)
    }

    /// [`PolyModulus::reduce`] with the caller's transform tables.
    pub fn reduce_in(&self, x: &[u64], lt: &ntt::LocalTables) -> Poly {
        self.reduce_t(x, Tabs::Local(lt))
    }

    fn reduce_t(&self, x: &[u64], t: Tabs) -> Poly {
        if x.len() < self.f.len() {
            return trim(copy(x));
        }
        if self.f.len() < DIV_CUTOFF {
            let linv = self.m.inv(*self.f.last().unwrap()).unwrap();
            tally(Family::ModArith, 1);
            return divrem_classical(x, &self.f, linv, &self.m).1;
        }
        if x.len() - self.f.len() + 1 > self.prec {
            return divrem_t(x, &self.f, &self.m, t).1;
        }
        divrem_with_inverse_t(x, &self.f, &self.finv, &self.m, t).1
    }

    pub fn mulmod(&self, a: &[u64], b: &[u64]) -> Poly {
        self.mulmod_t(a, b, Tabs::Shared)
    }

    /// [`PolyModulus::mulmod`] with the caller's transform tables.
    pub fn mulmod_in(&self, a: &[u64], b: &[u64], lt: &ntt::LocalTables) -> Poly {
        self.mulmod_t(a, b, Tabs::Local(lt))
    }

    fn mulmod_t(&self, a: &[u64], b: &[u64], t: Tabs) -> Poly {
        self.reduce_t(&mul_t(a, b, &self.m, t), t)
    }

    /// a^e mod f, e given as little-endian 64-bit words.
    pub fn powmod(&self, a: &[u64], e: &[u64]) -> Poly {
        self.powmod_t(a, e, Tabs::Shared)
    }

    /// [`PolyModulus::powmod`] with the caller's transform tables.
    pub fn powmod_in(&self, a: &[u64], e: &[u64], lt: &ntt::LocalTables) -> Poly {
        self.powmod_t(a, e, Tabs::Local(lt))
    }

    fn powmod_t(&self, a: &[u64], e: &[u64], t: Tabs) -> Poly {
        let a = self.reduce_t(a, t);
        let mut r = self.reduce_t(&[1 % self.m.n], t);
        let bits = e.len() * 64;
        let mut started = false;
        for i in (0..bits).rev() {
            if started {
                r = self.mulmod_t(&r, &r, t);
            }
            if (e[i / 64] >> (i % 64)) & 1 == 1 {
                r = if started { self.mulmod_t(&r, &a, t) } else { copy(&a) };
                started = true;
            }
            if i % 64 == 0 {
                sagebrush_interrupt::check();
            }
        }
        r
    }
}

// ------------------------------------------------------------------ work bounds

// Closed-form bounds on the work of the operations above, in
// multiply-adds and butterflies, for callers that charge a budget before
// each call (the units of the web ops' declared work).  Every bound is
// computed with checked arithmetic: None when it does not fit in a u64,
// which a caller treats as a refusal.

/// Checked arithmetic in const fns: the value, or None from the function.
macro_rules! ck {
    ($e:expr) => {
        match $e {
            Some(x) => x,
            None => return None,
        }
    };
}

/// The linear allowance per transform point of [`product_work`]: the
/// residues' combination and the linear passes around a product (sums,
/// differences, copies); also a bound on a schoolbook product per point
/// of its length, its shorter factor having fewer than MUL_CUTOFF
/// coefficients.
const LINEAR: u64 = 40;
const _: () = assert!(MUL_CUTOFF as u64 <= LINEAR);

/// One inversion modulo n (an extended Euclid on words) and a step's
/// bookkeeping.
const INV_WORK: u64 = 129;

/// ceil(log2(x)) (0 for x <= 1).
const fn clog2(x: u64) -> u64 {
    if x <= 1 {
        0
    } else {
        64 - (x - 1).leading_zeros() as u64
    }
}

/// A bound on one product of length at most `len` (len >= 1), with N =
/// len padded to a power of two: at most three primes times three
/// transforms of (N / 2) log2 N butterflies, plus LINEAR N.  P(N) / N
/// grows with N, so P(N / 2) <= P(N) / 2.
pub const fn product_work(len: usize) -> Option<u64> {
    let n = ck!((if len == 0 { 1 } else { len } as u64).checked_next_power_of_two());
    let log = n.trailing_zeros() as u64;
    let butterflies = ck!(ck!((n / 2).checked_mul(9)).checked_mul(log));
    butterflies.checked_add(ck!(n.checked_mul(LINEAR)))
}

/// [`mul`] (and [`mul_in`]) of factors with la and lb coefficients: the
/// schoolbook's la lb multiply-adds and its result below MUL_CUTOFF, else
/// one product ([`product_work`]).
pub const fn mul_work(la: usize, lb: usize) -> Option<u64> {
    if la == 0 || lb == 0 {
        return Some(0);
    }
    let len = ck!(ck!(la.checked_add(lb)).checked_sub(1));
    if la < MUL_CUTOFF || lb < MUL_CUTOFF {
        return ck!((la as u64).checked_mul(lb as u64)).checked_add(len as u64);
    }
    product_work(len)
}

/// [`inv_series`] to k terms: per doubling step to `len` terms, two
/// products of factors of at most len coefficients, the linear passes
/// and a step's bookkeeping; and the inversion of the constant term.
pub const fn inv_series_work(k: usize) -> Option<u64> {
    let mut w = INV_WORK;
    let mut len = 1;
    while len < k {
        len = match len.checked_mul(2) {
            Some(d) if d < k => d,
            _ => k,
        };
        let step = ck!(ck!(ck!(mul_work(len, len)).checked_mul(2)).checked_add(ck!((len as u64).checked_mul(4))));
        w = ck!(w.checked_add(step));
    }
    Some(w)
}

/// [`divrem`] (and [`divrem_in`]) of a by b with la >= 0 and lb >= 1
/// coefficients.  Classical: ql rows of lb multiply-adds, the copy of a
/// and the inversion of b's leading coefficient.  Newton: the inverse
/// series to ql terms, then the quotient's product (factors of at most
/// ql coefficients) and the remainder's (at most ql and lb - 1), the
/// reversed copy and the difference.
pub const fn divrem_work(la: usize, lb: usize) -> Option<u64> {
    if lb == 0 {
        // (a zero divisor: refused, never charged)
        return None;
    }
    if la < lb {
        return Some(la as u64);
    }
    let ql = ck!(ck!(la.checked_sub(lb)).checked_add(1));
    if lb < DIV_CUTOFF || ql < DIV_CUTOFF {
        return ck!(ck!((ql as u64).checked_mul(lb as u64)).checked_add(la as u64)).checked_add(INV_WORK);
    }
    let products = ck!(ck!(mul_work(ql, ql)).checked_add(ck!(mul_work(ql, lb - 1))));
    ck!(ck!(inv_series_work(ql)).checked_add(products)).checked_add(ck!((la as u64).checked_mul(2)))
}

/// Euclid's algorithm on inputs of hi >= lo coefficients (see [`gcd_work`]).
const fn euclid_work(hi: u64, lo: u64) -> Option<u64> {
    ck!(ck!(lo.checked_mul(ck!(hi.checked_add(lo)))).checked_add(ck!(lo.checked_mul(INV_WORK)))).checked_add(128)
}

/// A bound on a half-gcd base case (inputs shorter than HGCD_CUTOFF).
const HGCD_BASE_WORK: u64 = 1 << 14;
const _: () = assert!(HGCD_CUTOFF == 64);

/// [`gcd`] (and [`gcd_in`]) of polynomials with la and lb coefficients,
/// L = max(la, lb), l = min(la, lb).
/// - l = 0: the monic associate of the other (an inversion, a scale).
/// - l <= GCD_CUTOFF: Euclid, l (L + l) + 129 l + 128: the quotient rows
///   of all steps number at most L + l, each at most l multiply-adds; an
///   inversion per step and the final normalization.
/// - Otherwise the half-gcd.  With P = [`product_work`] at N = 2 L padded
///   ([`gcd_table_len`]): a half-gcd node for inputs of length L' does at
///   most 20 products' work at its own N' (4 applying its first matrix,
///   6 in its division, 2 in the Euclid step, 8 in the final matrix
///   product) and calls itself twice on inputs of at most ceil(L' / 2)
///   coefficients, whose N is at most half its own; so the 2^j nodes of
///   level j cost at most 20 P(N) together.  The levels whose inputs are
///   longer than HGCD_CUTOFF number at most ceil(log2(L / HGCD_CUTOFF))
///   (level j has inputs of at most ceil(L / 2^j) coefficients), and the
///   base cases below them at most 2^levels < 2 L / HGCD_CUTOFF, each at
///   most HGCD_BASE_WORK.  The gcd's loop: each turn's half-gcd, its
///   application and a division (10 products more), on lengths that at
///   least halve each turn, so at most twice the first turn's bound; then
///   Euclid's tail on a shorter input of at most GCD_CUTOFF coefficients.
pub const fn gcd_work(la: usize, lb: usize) -> Option<u64> {
    let (big, small) = if la >= lb { (la as u64, lb as u64) } else { (lb as u64, la as u64) };
    if small == 0 {
        return big.checked_add(INV_WORK);
    }
    if small <= GCD_CUTOFF as u64 {
        return euclid_work(big, small);
    }
    let p = ck!(product_work(ck!((big as usize).checked_mul(2))));
    let cut = HGCD_CUTOFF as u64;
    let levels = clog2(big.div_ceil(cut));
    let bases = ck!(HGCD_BASE_WORK.checked_mul(ck!(big.checked_mul(2)).div_ceil(cut)));
    let turn = ck!(ck!(ck!(ck!(p.checked_mul(20)).checked_mul(levels)).checked_add(bases)).checked_add(ck!(p.checked_mul(10))));
    ck!(turn.checked_mul(2)).checked_add(ck!(euclid_work(big, GCD_CUTOFF as u64)))
}

/// The bytes [`gcd`] (and [`gcd_in`]) allocates beyond its inputs (which
/// it owns), its transform tables and one product's transform buffers,
/// each polynomial counted by its capacity.  Euclid works in place and
/// allocates only the monic result (at most l words).  The half-gcd: a
/// frame for inputs of length L' holds at most 16.5 L' + 33 words, and
/// 11 L' + 20 while its second call runs, so the recursion holds at most
/// max(16.5 L + 33, 11 L + 20 + S(ceil(L / 2))) <= 23 L + 1024 words
/// (1024: a base case); the gcd's loop adds at most 0.5 L + 2 words (its
/// later operands' capacities): at most 188 L + 8208 bytes <= 320 L for
/// L > GCD_CUTOFF.
pub const fn gcd_frame_bytes(la: usize, lb: usize) -> Option<u64> {
    let (big, small) = if la >= lb { (la as u64, lb as u64) } else { (lb as u64, la as u64) };
    if small <= GCD_CUTOFF as u64 {
        // (l = 0: the monic associate of the other, a new vector)
        let l = if small == 0 { big } else { small };
        return l.checked_mul(8);
    }
    big.checked_mul(320)
}
const _: () = assert!(188 * (GCD_CUTOFF as u64 + 1) + 8208 <= 320 * (GCD_CUTOFF as u64 + 1));

/// [`PolyModulus::new`] (and new_in) for a modulus with lf coefficients:
/// the inverse series of the reversal to k = max(lf - 1, 1) terms, and
/// the copies.
pub const fn polymod_new_work(lf: usize) -> Option<u64> {
    let k = if lf > 2 { lf - 1 } else { 1 };
    ck!(inv_series_work(k)).checked_add(ck!((lf as u64).checked_mul(2)))
}

/// [`PolyModulus::reduce`] (and reduce_in) of lx coefficients modulo one
/// of lf, branch by branch as it runs: a copy; the classical division;
/// the general division (a quotient longer than the stored inverse); or
/// the products with the stored inverse (the quotient's, of factors of at
/// most ql coefficients, and the remainder's, at most ql and lf - 1),
/// the reversed copy and the difference.
pub const fn reduce_work(lf: usize, lx: usize) -> Option<u64> {
    if lf == 0 {
        // (a zero modulus: refused, never charged)
        return None;
    }
    if lx < lf {
        return Some(lx as u64);
    }
    let ql = ck!(ck!(lx.checked_sub(lf)).checked_add(1));
    if lf < DIV_CUTOFF {
        return ck!(ck!((ql as u64).checked_mul(lf as u64)).checked_add(lx as u64)).checked_add(INV_WORK);
    }
    let k = if lf > 2 { lf - 1 } else { 1 };
    if ql > k {
        return divrem_work(lx, lf);
    }
    let products = ck!(ck!(mul_work(ql, ql)).checked_add(ck!(mul_work(ql, lf - 1))));
    products.checked_add(ck!((lx as u64).checked_mul(2)))
}

/// [`PolyModulus::mulmod`] (and mulmod_in) of factors with la and lb
/// coefficients modulo one of lf.
pub const fn mulmod_work(lf: usize, la: usize, lb: usize) -> Option<u64> {
    let lp = if la == 0 || lb == 0 { 0 } else { ck!(ck!(la.checked_add(lb)).checked_sub(1)) };
    ck!(mul_work(la, lb)).checked_add(ck!(reduce_work(lf, lp)))
}

/// [`PolyModulus::powmod`] (and powmod_in) of a (la coefficients) to an
/// exponent of `words` words whose highest set bit is bit ebits - 1 (0:
/// a zero exponent), modulo f with lf >= 1 coefficients: the reductions
/// of a and of 1; a check per bit of the words; and from the highest set
/// bit down, per bit at most a squaring and a multiplication of operands
/// shorter than f.
pub const fn powmod_work(lf: usize, la: usize, words: usize, ebits: u64) -> Option<u64> {
    let first = ck!(ck!(reduce_work(lf, la)).checked_add(ck!(reduce_work(lf, 1))));
    let l = lf.saturating_sub(1);
    let step = ck!(ck!(ck!(mulmod_work(lf, l, l)).checked_mul(2)).checked_add(1));
    let scan = ck!((words as u64).checked_mul(64));
    ck!(first.checked_add(scan)).checked_add(ck!(ebits.checked_mul(step)))
}

// (its helpers use dashu's u64-word API: native targets only)
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    fn rand_poly(len: usize, m: &Modulus, s: &mut u64) -> Poly {
        let mut v: Poly = (0..len).map(|_| rng(s) % m.n).collect();
        if let Some(l) = v.last_mut() {
            if *l == 0 {
                *l = 1;
            }
        }
        v
    }

    #[test]
    fn work_bounds_refuse_instead_of_panicking() {
        // every bound is None (a refusal) or a number at any lengths, never
        // an arithmetic overflow: callers debit them before the work.  A
        // Some is checked against a lower bound of the work it stands for,
        // so an intermediate that wrapped (release builds don't panic on
        // overflow) and gave a small number fails here as well
        let ls = [0usize, 1, 2, 39, 40, 59, 60, 1000, 1 << 32, usize::MAX / 2, usize::MAX / 2 + 1, usize::MAX - 1, usize::MAX];
        let at_least = |w: Option<u64>, lo: u128, what: &str| {
            if let Some(w) = w {
                assert!(w as u128 >= lo, "{what}: {w} < {lo}");
            }
        };
        for &a in &ls {
            let _ = product_work(a);
            at_least(product_work(a), a as u128, "product_work");
            if a > 1 {
                at_least(inv_series_work(a), 4 * a as u128, "inv_series_work");
            }
            at_least(polymod_new_work(a), 2 * a as u128, "polymod_new_work");
            for &b in &ls {
                if a > 0 && b > 0 {
                    at_least(mul_work(a, b), a.max(b) as u128, "mul_work");
                }
                at_least(divrem_work(a, b), a as u128, "divrem_work");
                at_least(gcd_work(a, b), a.max(b) as u128, "gcd_work");
                let _ = gcd_frame_bytes(a, b);
                at_least(reduce_work(a, b), b as u128, "reduce_work");
                for &c in &ls {
                    if b > 0 && c > 0 {
                        at_least(mulmod_work(a, b, c), b as u128 + c as u128 - 1, "mulmod_work");
                    }
                    for e in [0u64, 1, 64, u64::MAX] {
                        at_least(powmod_work(a, b, c, e), b as u128, "powmod_work");
                    }
                }
            }
        }
        // zero lengths where a nonzero one is required: refused
        for &x in &ls {
            assert_eq!(reduce_work(0, x), None, "reduce_work(0, {x})");
            assert_eq!(divrem_work(x, 0), None, "divrem_work({x}, 0)");
        }
        // the extremes that overflowed before
        assert_eq!(reduce_work(1, usize::MAX), None);
        assert_eq!(divrem_work(usize::MAX, 1), None);
        assert_eq!(mulmod_work(usize::MAX, usize::MAX, 2), None);
        assert_eq!(mulmod_work(1000, usize::MAX, 2), None);
        assert!(mulmod_work(1000, 999, 999).is_some());
    }

    #[test]
    fn barrett_reduction_edges() {
        let mut s = 5u64;
        // (powers of two: v = 2^64 / n exactly)
        for n in [2u64, 3, 1 << 16, 65537, 1 << 31, (1 << 31) - 1, (1 << 32) - 5, (1 << 32) - 1] {
            let v = ((1u128 << 64) / n as u128) as u64;
            let mut xs: Vec<u64> = vec![0, 1, n - 1, n, n + 1, 2 * n - 1, u64::MAX, u64::MAX - 1, u64::MAX - n];
            let top = u64::MAX / n * n;
            xs.extend([top, top - 1, top.wrapping_add(n - 1)]);
            xs.extend((0..2000).map(|_| rng(&mut s)));
            // the row inputs at their largest: (n - 1) + (n - 1)^2
            xs.push((n - 1) + (n - 1) * (n - 1));
            for x in xs {
                assert_eq!(barrett(x, n, v), x % n, "x={x} n={n}");
            }
        }
    }

    #[test]
    fn division_and_gcd() {
        let mut s = 99u64;
        for n in [2u64, 3, 101, 1_000_000_007, (1 << 62) - 57, 18446744073709551557] {
            let m = Modulus::new(n);
            for (la, lb) in [(1, 1), (5, 3), (80, 70), (300, 100), (400, 61), (1000, 500), (2000, 64)] {
                let a = rand_poly(la, &m, &mut s);
                let b = rand_poly(lb, &m, &mut s);
                let (q, r) = divrem(&a, &b, &m);
                assert!(r.len() < b.len());
                assert_eq!(add(&mul(&q, &b, &m), &r, &m), a, "n={n} {la}/{lb}");
                let pm = PolyModulus::new(&b, &m);
                assert_eq!(pm.reduce(&mul(&a[..a.len().min(b.len())], &a[..a.len().min(b.len())], &m)),
                           rem(&mul(&a[..a.len().min(b.len())], &a[..a.len().min(b.len())], &m), &b, &m));
                let c = rand_poly(lb / 2 + 1, &m, &mut s);
                let g = gcd(&mul(&a, &c, &m), &mul(&b, &c, &m), &m);
                assert!(rem(&g, &monic(&c, &m), &m).is_empty());
                let (g2, u, v) = xgcd(&a, &b, &m);
                assert_eq!(add(&mul(&u, &a, &m), &mul(&v, &b, &m), &m), g2);
            }
        }
    }

    #[test]
    fn gcd_in_its_own_tables() {
        // gcd_in with tables of exactly gcd_table_len (a product longer
        // than its tables panics): three-prime moduli, small ones, an NTT
        // prime's own table; random pairs (gcd 1), common factors, very
        // unequal lengths, and long quotients (powers of a linear factor)
        let mut s = 7u64;
        for p in [2u64, 7, 65537, 1_000_000_007, 4601552919265804289, (1 << 62) - 57, 18446744073709551557] {
            let m = Modulus::new(p);
            for (la, lb, lc) in [(1001, 1001, 0), (1500, 1200, 0), (3000, 1001, 0), (2048, 2047, 0), (1200, 1100, 600), (2000, 1500, 1400), (1002, 1001, 1001)] {
                let (mut a, mut b) = (rand_poly(la, &m, &mut s), rand_poly(lb, &m, &mut s));
                if lc > 0 {
                    let c = rand_poly(lc, &m, &mut s);
                    // (cofactors with leading coefficient 1: lengths exact)
                    let cut = |x: &[u64], k: usize| -> Poly {
                        let mut v = x[..k].to_vec();
                        v[k - 1] = 1;
                        v
                    };
                    let mut c = c;
                    c[lc - 1] = 1;
                    a = mul(&cut(&a, la - lc + 1), &c, &m);
                    b = mul(&cut(&b, lb - lc + 1), &c, &m);
                    assert_eq!((a.len(), b.len()), (la, lb));
                }
                let len = gcd_table_len(a.len(), b.len());
                assert!(len > 0, "p={p} {la}/{lb}");
                let lt = ntt::LocalTables::new(&m, len);
                assert_eq!(gcd_in(a.clone(), b.clone(), &m, &lt), gcd_slow(&a, &b, &m), "p={p} {la}/{lb}/{lc}");
            }
            let mut f = vec![1u64];
            for _ in 0..1500 {
                f = mul(&f, &[3 % p, 1], &m);
            }
            let mut h = rand_poly(400, &m, &mut s);
            h[399] = 1;
            let g = mul(&f[..1101], &h, &m);
            let lt = ntt::LocalTables::new(&m, gcd_table_len(f.len(), g.len()));
            assert_eq!(gcd_in(f.clone(), g.clone(), &m, &lt), gcd_slow(&f, &g, &m), "p={p} powers");
        }
        assert_eq!(gcd_table_len(16384, 1000), 0);
        assert_eq!(gcd_table_len(1001, 16384), 2 * 16384);
    }

    fn gcd_slow(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
        let (mut a, mut b) = (trim(a.to_vec()), trim(b.to_vec()));
        while !b.is_empty() {
            let r = rem(&a, &b, m);
            a = std::mem::replace(&mut b, r);
        }
        monic(&a, m)
    }

    #[test]
    fn half_gcd() {
        let mut s = 31u64;
        for p in [2u64, 3, 7, 1_000_000_007, (1 << 62) - 57] {
            let m = Modulus::new(p);
            for (la, lb) in [(70, 69), (130, 100), (200, 199), (513, 300), (1000, 999), (1500, 20)] {
                let a = rand_poly(la, &m, &mut s);
                let b = rand_poly(lb, &m, &mut s);
                // the half-gcd property, and a', b' in the remainder sequence
                let n = hgcd(&a, &b, &m);
                let (x, y) = n.apply(&a, &b, &m);
                let half = (la - 1).div_ceil(2);
                assert!(x.len() > half && y.len() <= half, "p={p} {la}/{lb}: {} {}", x.len(), y.len());
                let (mut u, mut v) = (a.clone(), b.clone());
                while u.len() > x.len() && !v.is_empty() {
                    let r = rem(&u, &v, &m);
                    u = std::mem::replace(&mut v, r);
                }
                assert_eq!((&u, &v), (&x, &y), "remainder sequence p={p} {la}/{lb}");
                // gcds with a common factor
                let c = rand_poly(la / 3 + 1, &m, &mut s);
                let (ac, bc) = (mul(&a, &c, &m), mul(&b, &c, &m));
                assert_eq!(gcd(&ac, &bc, &m), gcd_slow(&ac, &bc, &m));
            }
        }
        // remainder sequences with long quotients: powers of a linear factor
        let m = Modulus::new(101);
        let mut f = vec![1u64];
        for _ in 0..300 {
            f = mul(&f, &[3, 1], &m);
        }
        let g = mul(&f[..150].to_vec(), &[5, 0, 1], &m);
        assert_eq!(gcd(&f, &g, &m), gcd_slow(&f, &g, &m));
    }

    #[test]
    fn powmod_frobenius() {
        // x^(p^d) = x mod f for f irreducible of degree d over GF(p):
        // f = x^2 + 1 is irreducible for p = 3 mod 4.
        let p = 1_000_000_007u64;
        let m = Modulus::new(p);
        let pm = PolyModulus::new(&[1, 0, 1], &m);
        let e = (p as u128 * p as u128) as u128;
        let words = [e as u64, (e >> 64) as u64];
        assert_eq!(pm.powmod(&[0, 1], &words), vec![0, 1]);
        // and the same with a long modulus: x^p - x has all of GF(p) as roots, so
        // gcd(x^p - x, f) for f a product of distinct linear factors is f
        let mut f = vec![1u64];
        for r in 0..100u64 {
            f = mul(&f, &[m.neg(r * 7 + 3), 1], &m);
        }
        let pm = PolyModulus::new(&f, &m);
        let xp = pm.powmod(&[0, 1], &[p]);
        let g = gcd(&sub(&xp, &[0, 1], &m), &f, &m);
        assert_eq!(g, f);
    }
}
