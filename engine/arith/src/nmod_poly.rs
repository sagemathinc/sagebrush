//! Polynomials over Z/n (word-size n), as coefficient vectors with the
//! constant term first and no trailing zeros (the zero polynomial is
//! empty).  Products use schoolbook multiplication with delayed reduction
//! for short inputs and the NTT ([`crate::ntt::mul_mod`]) otherwise;
//! division by long divisors uses Newton iteration for the inverse of the
//! reversed divisor (von zur Gathen and Gerhard, Modern Computer Algebra,
//! section 9.1).

use crate::nmod::Modulus;
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
/// about every 2^16 multiply-adds.
pub(crate) struct Poll(u64);

impl Poll {
    pub(crate) fn new() -> Poll {
        Poll(0)
    }
    #[inline]
    pub(crate) fn add(&mut self, work: usize) {
        self.0 += work as u64;
        if self.0 >= 1 << 16 {
            self.0 = 0;
            sagebrush_interrupt::check_coarse();
        }
    }
}

/// Products with a factor shorter than this are schoolbook.
const MUL_CUTOFF: usize = 40;
/// Divisions with divisor and quotient both at least this long use Newton.
const DIV_CUTOFF: usize = 60;

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
        poll.add(a.len().min(b.len()));
        let lo = i.saturating_sub(b.len() - 1);
        let hi = i.min(a.len() - 1);
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
    let mut c = long.to_vec();
    for (x, &y) in c.iter_mut().zip(short) {
        *x = m.add(*x, y);
    }
    trim(c)
}

pub fn sub(a: &[u64], b: &[u64], m: &Modulus) -> Poly {
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
    trim(a.iter().map(|&x| m.mul(x, s)).collect())
}

pub fn neg(a: &[u64], m: &Modulus) -> Poly {
    a.iter().map(|&x| m.neg(x)).collect()
}

/// The monic associate (n prime, or a's leading coefficient a unit).
pub fn monic(a: &[u64], m: &Modulus) -> Poly {
    match a.last() {
        None => vec![],
        Some(&l) => scale(a, m.inv(l).expect("leading coefficient not a unit"), m),
    }
}

pub fn derivative(a: &[u64], m: &Modulus) -> Poly {
    trim(a.iter().enumerate().skip(1).map(|(i, &c)| m.mul(m.reduce(i as u64), c)).collect())
}

pub fn eval(a: &[u64], x: u64, m: &Modulus) -> u64 {
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

fn rev(a: &[u64], len: usize) -> Poly {
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
        poll.add(2 * db);
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
    for i in (0..r.len() - db).rev() {
        poll.add(db + 1);
        let c = m.mul(r[i + db], linv);
        if let Some(q) = q.as_deref_mut() {
            q[i] = c;
        }
        if c != 0 {
            axpy(&mut r[i..i + db], &b[..db], m.neg(c), m);
        }
    }
    r.truncate(db);
    while r.last() == Some(&0) {
        r.pop();
    }
}

fn divrem_classical(a: &[u64], b: &[u64], linv: u64, m: &Modulus) -> (Poly, Poly) {
    let _phase = sagebrush_interrupt::enter("classical-divide");
    let mut r = a.to_vec();
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
        poll.add(128);
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
        return (vec![], a.to_vec());
    }
    let linv = m.inv(*b.last().unwrap()).expect("leading coefficient not a unit");
    let ql = a.len() - b.len() + 1;
    if b.len() < DIV_CUTOFF || ql < DIV_CUTOFF {
        return divrem_classical(a, b, linv, m);
    }
    let binv = inv_series_t(&rev(b, b.len()), ql, m, t);
    divrem_with_inverse_t(a, b, &binv, m, t)
}

/// Division given binv = 1/rev(b) mod x^k with k >= the quotient length.
fn divrem_with_inverse(a: &[u64], b: &[u64], binv: &[u64], m: &Modulus) -> (Poly, Poly) {
    divrem_with_inverse_t(a, b, binv, m, Tabs::Shared)
}

fn divrem_with_inverse_t(a: &[u64], b: &[u64], binv: &[u64], m: &Modulus, t: Tabs) -> (Poly, Poly) {
    let _phase = sagebrush_interrupt::enter("newton-divide");
    sagebrush_interrupt::check_coarse();
    if a.len() < b.len() {
        return (vec![], a.to_vec());
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
    let (mut a, mut b) = (trim(a.to_vec()), trim(b.to_vec()));
    if a.len() < b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    while !b.is_empty() {
        sagebrush_interrupt::check();
        if b.len() <= GCD_CUTOFF {
            return gcd_euclid(a, b, m);
        }
        if a.len() > b.len() {
            let n = hgcd(&a, &b, m);
            let (x, y) = n.apply(&a, &b, m);
            a = x;
            b = y;
            if b.is_empty() {
                break;
            }
        }
        let r = rem(&a, &b, m);
        a = std::mem::replace(&mut b, r);
    }
    monic(&a, m)
}

/// Inputs to the half-gcd shorter than this use Euclid's steps directly.
const HGCD_CUTOFF: usize = 64;
/// gcds of inputs shorter than this use Euclid's algorithm.
const GCD_CUTOFF: usize = 1000;

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
    fn mul(&self, o: &Mat2, md: &Modulus) -> Mat2 {
        let [a, b, c, d] = &self.m;
        let [e, f, g, h] = &o.m;
        let p = |x: &Poly, y: &Poly, z: &Poly, w: &Poly| add(&mul(x, y, md), &mul(z, w, md), md);
        Mat2 { m: [p(a, e, b, g), p(a, f, b, h), p(c, e, d, g), p(c, f, d, h)] }
    }

    /// The Euclid step for quotient q, times self.
    fn step(&self, q: &[u64], md: &Modulus) -> Mat2 {
        let [a, b, c, d] = &self.m;
        Mat2 { m: [c.clone(), d.clone(), sub(a, &mul(q, c, md), md), sub(b, &mul(q, d, md), md)] }
    }

    /// self * (a, b).
    pub fn apply(&self, a: &[u64], b: &[u64], md: &Modulus) -> (Poly, Poly) {
        let [m11, m12, m21, m22] = &self.m;
        (
            add(&mul(m11, a, md), &mul(m12, b, md), md),
            add(&mul(m21, a, md), &mul(m22, b, md), md),
        )
    }
}

fn shift(a: &[u64], k: usize) -> Poly {
    if a.len() <= k {
        vec![]
    } else {
        a[k..].to_vec()
    }
}

/// The half-gcd (C. Yap, Fundamental Problems of Algorithmic Algebra,
/// Lecture VIII; Thull and Yap 1990): for deg a = n > deg b, the product N
/// of the Euclid steps after which (a', b') = N (a, b) are consecutive
/// remainders with deg a' >= ceil(n/2) > deg b'.
pub fn hgcd(a: &[u64], b: &[u64], md: &Modulus) -> Mat2 {
    let n = a.len() - 1;
    let m = n.div_ceil(2);
    if b.len() <= m {
        return Mat2::identity();
    }
    if n < HGCD_CUTOFF {
        // Euclid's steps until the degree drops below m
        let mut t = Mat2::identity();
        let (mut x, mut y) = (a.to_vec(), b.to_vec());
        while y.len() > m {
            let (q, r) = divrem(&x, &y, md);
            t = t.step(&q, md);
            x = std::mem::replace(&mut y, r);
        }
        return t;
    }
    let r = hgcd(&shift(a, m), &shift(b, m), md);
    let (a1, b1) = r.apply(a, b, md);
    if b1.len() <= m {
        return r;
    }
    let (q, d) = divrem(&a1, &b1, md);
    let qr = r.step(&q, md);
    if d.len() <= m {
        return qr;
    }
    let l = b1.len() - 1;
    let k = 2 * m - l;
    let s = hgcd(&shift(&b1, k), &shift(&d, k), md);
    s.mul(&qr, md)
}

/// (g, s, t) with g = s a + t b the monic gcd (n prime).
pub fn xgcd(a: &[u64], b: &[u64], m: &Modulus) -> (Poly, Poly, Poly) {
    let (mut r0, mut r1) = (trim(a.to_vec()), trim(b.to_vec()));
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
    pub m: Modulus,
}

impl PolyModulus {
    pub fn new(f: &[u64], m: &Modulus) -> PolyModulus {
        let f = trim(f.to_vec());
        assert!(!f.is_empty(), "zero modulus");
        let k = f.len().max(2) - 1;
        let finv = inv_series(&rev(&f, f.len()), k.max(1), m);
        PolyModulus { f, finv, m: *m }
    }

    /// x mod f, for deg x < 2 deg f.
    pub fn reduce(&self, x: &[u64]) -> Poly {
        if x.len() < self.f.len() {
            return trim(x.to_vec());
        }
        if self.f.len() < DIV_CUTOFF {
            let linv = self.m.inv(*self.f.last().unwrap()).unwrap();
            return divrem_classical(x, &self.f, linv, &self.m).1;
        }
        if x.len() - self.f.len() + 1 > self.finv.len() {
            return rem(x, &self.f, &self.m);
        }
        divrem_with_inverse(x, &self.f, &self.finv, &self.m).1
    }

    pub fn mulmod(&self, a: &[u64], b: &[u64]) -> Poly {
        self.reduce(&mul(a, b, &self.m))
    }

    /// a^e mod f, e given as little-endian 64-bit words.
    pub fn powmod(&self, a: &[u64], e: &[u64]) -> Poly {
        let a = self.reduce(a);
        let mut r = self.reduce(&[1 % self.m.n]);
        let bits = e.len() * 64;
        let mut started = false;
        for i in (0..bits).rev() {
            if started {
                r = self.mulmod(&r, &r);
            }
            if (e[i / 64] >> (i % 64)) & 1 == 1 {
                r = if started { self.mulmod(&r, &a) } else { a.clone() };
                started = true;
            }
            if i % 64 == 0 {
                sagebrush_interrupt::check();
            }
        }
        r
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
