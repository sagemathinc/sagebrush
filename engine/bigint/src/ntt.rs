//! Number-theoretic transforms over three primes p = c 2^50 + 1 just
//! below 2^62, and the convolutions built on them: polynomial products
//! modulo any n < 2^64 ([`mul_mod`]) and products of big integers given
//! as 64-bit words ([`mul_words`]).
//!
//! The transforms are Harvey's ("Faster arithmetic for number-theoretic
//! transforms", J. Symbolic Comput. 60 (2014)): Gentleman-Sande forward
//! (natural order in, bit-reversed out) and Cooley-Tukey inverse, with
//! Shoup multiplications and lazy reduction (values stay in [0, 4p)), so
//! no bit-reversal permutation is ever done.  Large transforms recurse on
//! halves, so the inner levels run in cache.
//!
//! The three primes multiply to about 2^186 > 2^57 (2^64)^2, so one
//! transform per prime suffices for 64-bit pieces at any feasible length.

use crate::nmod::{mul_shoup, mul_shoup_lazy, shoup, Modulus};
use std::sync::{Arc, Mutex};

/// (p, primitive root); 2^50 divides p - 1.
pub const PRIMES: [(u64, u64); 3] = [
    (4601552919265804289, 3),
    (4546383823830515713, 10),
    (4522739925786820609, 37),
];
const MAX_LOG: u32 = 50;
/// Transforms longer than this recurse on halves (fits in L2 cache).
const BLOCK: usize = 1 << 12;

struct Table {
    p: u64,
    log: u32,
    // tw[m + j] = w_{2m}^j for m = 1, 2, 4, ..., 2^(log-1), j < m
    tw: Vec<u64>,
    twp: Vec<u64>,
    itw: Vec<u64>,
    itwp: Vec<u64>,
}

impl Table {
    fn new(p: u64, g: u64, log: u32) -> Table {
        // a root of unity of order 2^log exists only when 2^log | p - 1
        assert!(log <= (p - 1).trailing_zeros(), "no 2^{} root of unity modulo {}", log, p);
        let n = 1usize << log;
        let m = Modulus::new(p);
        let root = m.pow(g, (p - 1) >> log);
        let iroot = m.inv(root).unwrap();
        let mut tw = vec![0u64; n.max(2)];
        let mut itw = vec![0u64; n.max(2)];
        let half = n / 2;
        let (mut w, mut iw) = (1u64, 1u64);
        for j in 0..half {
            tw[half + j] = w;
            itw[half + j] = iw;
            w = m.mul(w, root);
            iw = m.mul(iw, iroot);
        }
        let mut k = half / 2;
        while k >= 1 {
            for j in 0..k {
                tw[k + j] = tw[2 * k + 2 * j];
                itw[k + j] = itw[2 * k + 2 * j];
            }
            k /= 2;
        }
        let twp = tw.iter().map(|&w| shoup(w, p)).collect();
        let itwp = itw.iter().map(|&w| shoup(w, p)).collect();
        Table { p, log, tw, twp, itw, itwp }
    }
}

/// A generator of (Z/p)^*, for p - 1 = c 2^k with c small enough to
/// factor by trial division.
fn primitive_root(p: u64) -> u64 {
    let m = Modulus::new(p);
    let mut qs = vec![2u64];
    let mut c = (p - 1) >> (p - 1).trailing_zeros();
    let mut d = 3;
    while d * d <= c {
        if c % d == 0 {
            qs.push(d);
            while c % d == 0 {
                c /= d;
            }
        }
        d += 2;
    }
    if c > 1 {
        qs.push(c);
    }
    (2..).find(|&g| qs.iter().all(|&q| m.pow(g, (p - 1) / q) != 1)).unwrap()
}

fn root_cached(p: u64) -> u64 {
    static ROOTS: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());
    let mut r = ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(&(_, g)) = r.iter().find(|x| x.0 == p) {
        return g;
    }
    let g = primitive_root(p);
    r.push((p, g));
    g
}

/// The table for p of length at least 2^log (cached; at most a few primes
/// are kept, the most recently used).
fn table_for(p: u64, log: u32) -> Arc<Table> {
    static CACHE: Mutex<Vec<Arc<Table>>> = Mutex::new(Vec::new());
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = cache.iter().position(|t| t.p == p && t.log >= log) {
        let t = cache.remove(i);
        cache.push(t.clone());
        return t;
    }
    let g = PRIMES.iter().find(|x| x.0 == p).map_or_else(|| root_cached(p), |x| x.1);
    // (at least 2^8 entries, to be reused, but never beyond the 2-power of
    // p - 1: a table of 2^8 for p with v2(p - 1) = 7 squared 64 ones to a
    // wrong constant, the systematic review's ARITH finding)
    let t = Arc::new(Table::new(p, g, log.max(8).min((p - 1).trailing_zeros()).max(log)));
    cache.retain(|t| t.p != p);
    // at most 64 tables (multimodular products cycle through many primes)
    // and about 256 MB of them
    let mut total: usize = cache.iter().map(|t| t.tw.len() * 32).sum::<usize>() + t.tw.len() * 32;
    while !cache.is_empty() && (cache.len() >= 64 || total > 1 << 28) {
        total -= cache[0].tw.len() * 32;
        cache.remove(0);
    }
    cache.push(t.clone());
    t
}

fn table(idx: usize, log: u32) -> Arc<Table> {
    table_for(PRIMES[idx].0, log)
}

/// Whether products modulo m of length len can be done by one transform
/// modulo m itself (m prime below 2^62 with 2^log | m - 1).
pub fn is_ntt_prime(m: &Modulus, len: usize) -> bool {
    m.n > 1 << 32 && m.n < 1 << 62 && (m.n - 1).trailing_zeros() >= len.next_power_of_two().trailing_zeros() && crate::nmod::is_prime(m.n)
}

#[inline(always)]
fn dif_layer(lo: &mut [u64], hi: &mut [u64], w: &[u64], wp: &[u64], p: u64) {
    let p2 = 2 * p;
    for j in 0..lo.len() {
        let (x, y) = (lo[j], hi[j]);
        let s = x + y;
        lo[j] = if s >= p2 { s - p2 } else { s };
        hi[j] = mul_shoup_lazy(x + p2 - y, w[j], wp[j], p);
    }
}

#[inline(always)]
fn dit_layer(lo: &mut [u64], hi: &mut [u64], w: &[u64], wp: &[u64], p: u64) {
    let p2 = 2 * p;
    for j in 0..lo.len() {
        let mut x = lo[j];
        if x >= p2 {
            x -= p2;
        }
        let t = mul_shoup_lazy(hi[j], w[j], wp[j], p);
        lo[j] = x + t;
        hi[j] = x + p2 - t;
    }
}

/// Forward transform: input in [0, 2p) natural order, output in [0, 2p)
/// bit-reversed order.
fn dif(a: &mut [u64], t: &Table) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    if n > BLOCK {
        let m = n / 2;
        crate::check_interrupt(); // (once per large block: Ctrl-C in long products)
        let (lo, hi) = a.split_at_mut(m);
        dif_layer(lo, hi, &t.tw[m..2 * m], &t.twp[m..2 * m], t.p);
        dif(lo, t);
        dif(hi, t);
        return;
    }
    let mut m = n / 2;
    while m >= 1 {
        for chunk in a.chunks_exact_mut(2 * m) {
            let (lo, hi) = chunk.split_at_mut(m);
            dif_layer(lo, hi, &t.tw[m..2 * m], &t.twp[m..2 * m], t.p);
        }
        m /= 2;
    }
}

/// Inverse transform without the 1/n: input in [0, 4p) bit-reversed,
/// output in [0, 4p) natural order.
fn dit(a: &mut [u64], t: &Table) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    if n > BLOCK {
        let m = n / 2;
        crate::check_interrupt();
        let (lo, hi) = a.split_at_mut(m);
        dit(lo, t);
        dit(hi, t);
        dit_layer(lo, hi, &t.itw[m..2 * m], &t.itwp[m..2 * m], t.p);
        return;
    }
    let mut m = 1;
    while m < n {
        for chunk in a.chunks_exact_mut(2 * m) {
            let (lo, hi) = chunk.split_at_mut(m);
            dit_layer(lo, hi, &t.itw[m..2 * m], &t.itwp[m..2 * m], t.p);
        }
        m *= 2;
    }
}

fn log2_len(len: usize) -> u32 {
    let log = len.next_power_of_two().trailing_zeros();
    assert!(log <= MAX_LOG, "transform too long");
    log
}

/// The product of a and b modulo PRIMES[idx], inputs arbitrary u64
/// (reduced here), length a.len() + b.len() - 1.
pub fn conv_prime(a: &[u64], b: &[u64], idx: usize) -> Vec<u64> {
    let log = log2_len(a.len() + b.len() - 1);
    conv_table(a, b, &table(idx, log))
}

/// The product modulo an NTT prime p (see [`is_ntt_prime`]).
pub fn conv_ntt_prime(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let log = log2_len(a.len() + b.len() - 1);
    if std::ptr::eq(a, b) {
        return conv_table(a, a, &table_for(p, log));
    }
    conv_table(a, b, &table_for(p, log))
}

fn conv_table(a: &[u64], b: &[u64], t: &Table) -> Vec<u64> {
    let len = a.len() + b.len() - 1;
    let log = log2_len(len);
    let n = 1usize << log;
    let p = t.p;
    let m = Modulus::new(p);
    let load = |x: &[u64]| {
        let mut f = vec![0u64; n];
        for (d, &s) in f.iter_mut().zip(x) {
            *d = m.reduce(s);
        }
        f
    };
    let mut fa = load(a);
    dif(&mut fa, t);
    let square = std::ptr::eq(a, b);
    let fb = if square {
        None
    } else {
        let mut fb = load(b);
        dif(&mut fb, t);
        Some(fb)
    };
    let ninv = m.inv(n as u64 % p).unwrap();
    let ninvp = shoup(ninv, p);
    let red = |x: u64| if x >= p { x - p } else { x };
    match &fb {
        None => {
            for x in fa.iter_mut() {
                let y = red(*x);
                *x = mul_shoup(m.mul(y, y), ninv, ninvp, p);
            }
        }
        Some(fb) => {
            for (x, &y) in fa.iter_mut().zip(fb) {
                *x = mul_shoup(m.mul(red(*x), red(y)), ninv, ninvp, p);
            }
        }
    }
    dit(&mut fa, t);
    fa.truncate(len);
    for x in fa.iter_mut() {
        let mut y = *x;
        if y >= 2 * p {
            y -= 2 * p;
        }
        *x = red(y);
    }
    fa
}

/// Garner's constants for the three primes.
pub struct Crt {
    m1: Modulus,
    m2: Modulus,
    c01: u64,      // 1/p0 mod p1
    c012: u64,     // 1/(p0 p1) mod p2
    pub p01: u128, // p0 p1
}

pub fn crt() -> Crt {
    let (p0, p1, p2) = (PRIMES[0].0, PRIMES[1].0, PRIMES[2].0);
    let m1 = Modulus::new(p1);
    let m2 = Modulus::new(p2);
    let c01 = m1.inv(p0 % p1).unwrap();
    let c012 = m2.inv(m2.mul(p0 % p2, p1 % p2)).unwrap();
    Crt { m1, m2, c01, c012, p01: p0 as u128 * p1 as u128 }
}

impl Crt {
    /// x = r0 + p0 t1 + p0 p1 t2 (0 <= x < p0 p1 p2) as (v, t2) with
    /// v = r0 + p0 t1 < p0 p1.
    #[inline(always)]
    pub fn garner(&self, r0: u64, r1: u64, r2: u64) -> (u128, u64) {
        let p0 = PRIMES[0].0;
        let t1 = self.m1.mul(self.m1.sub(r1, self.m1.reduce(r0)), self.c01);
        let v = r0 as u128 + p0 as u128 * t1 as u128;
        let t2 = self.m2.mul(self.m2.sub(r2, self.m2.reduce_u128(v)), self.c012);
        (v, t2)
    }
}

/// How many of the primes a product with coefficients below `bound`
/// needs (bound as u128, saturating).
fn primes_needed(n: u64, len: usize) -> usize {
    let b = ((n - 1) as u128)
        .checked_mul((n - 1) as u128)
        .and_then(|x| x.checked_mul(len as u128));
    let p0 = PRIMES[0].0 as u128;
    match b {
        Some(b) if b < p0 => 1,
        Some(b) if b < p0 * PRIMES[1].0 as u128 => 2,
        _ => 3,
    }
}

/// The product of polynomials a and b (coefficients reduced mod m.n,
/// constant term first) modulo m.n, by NTT.  Length a.len() + b.len() - 1.
pub fn mul_mod(a: &[u64], b: &[u64], m: &Modulus) -> Vec<u64> {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let len = a.len() + b.len() - 1;
    let square = std::ptr::eq(a, b);
    if is_ntt_prime(m, len) {
        return if square { conv_ntt_prime(a, a, m.n) } else { conv_ntt_prime(a, b, m.n) };
    }
    let conv = |i| if square { conv_prime(a, a, i) } else { conv_prime(a, b, i) };
    match primes_needed(m.n, a.len().min(b.len())) {
        1 => conv(0).into_iter().map(|x| m.reduce(x)).collect(),
        2 => {
            let (r0, r1) = (conv(0), conv(1));
            let (p0, p1) = (PRIMES[0].0, PRIMES[1].0);
            let m1 = Modulus::new(p1);
            let c01 = m1.inv(p0 % p1).unwrap();
            let p0n = m.reduce(p0);
            (0..len)
                .map(|i| {
                    let t1 = m1.mul(m1.sub(r1[i], m1.reduce(r0[i])), c01);
                    m.add(m.reduce(r0[i]), m.mul(p0n, m.reduce(t1)))
                })
                .collect()
        }
        _ => {
            let (r0, r1, r2) = (conv(0), conv(1), conv(2));
            let c = crt();
            let p01n = m.reduce_u128(c.p01);
            (0..len)
                .map(|i| {
                    let (v, t2) = c.garner(r0[i], r1[i], r2[i]);
                    m.add(m.reduce_u128(v), m.mul(p01n, m.reduce(t2)))
                })
                .collect()
        }
    }
}

/// The product of two nonnegative integers given as little-endian 64-bit
/// words; the result has a.len() + b.len() words.
pub fn mul_words(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut out = vec![0u64; a.len() + b.len()];
    if a.is_empty() || b.is_empty() {
        return out;
    }
    let square = std::ptr::eq(a, b);
    let conv = |i| if square { conv_prime(a, a, i) } else { conv_prime(a, b, i) };
    let (r0, r1, r2) = (conv(0), conv(1), conv(2));
    let c = crt();
    let (plo, phi) = (c.p01 as u64, (c.p01 >> 64) as u64);
    let mut carry: u128 = 0;
    for i in 0..r0.len() {
        let (v, t2) = c.garner(r0[i], r1[i], r2[i]);
        // x = v + p0 p1 t2 = lo + hi 2^64
        let (s, o) = v.overflowing_add(plo as u128 * t2 as u128);
        let hi = (s >> 64) + phi as u128 * t2 as u128 + ((o as u128) << 64);
        let (w, c1) = (s as u64).overflowing_add(carry as u64);
        out[i] = w;
        carry = (carry >> 64) + hi + c1 as u128;
    }
    let mut i = r0.len();
    while carry != 0 {
        out[i] = carry as u64;
        carry >>= 64;
        i += 1;
    }
    out
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

    fn naive_mod(a: &[u64], b: &[u64], m: &Modulus) -> Vec<u64> {
        let mut c = vec![0u64; a.len() + b.len() - 1];
        for (i, &x) in a.iter().enumerate() {
            for (j, &y) in b.iter().enumerate() {
                c[i + j] = m.add(c[i + j], m.mul(x, y));
            }
        }
        c
    }

    #[test]
    fn short_transforms_modulo_primes_with_few_twos() {
        // primes with v2(p - 1) = 1..8, each at the longest transform it has
        for (p, v) in [(4294967311u64, 1u32), (4294967357, 2), (4294967497, 3), (4294967377, 4), (4294967969, 5), (4294968001, 6), (4294967681, 7), (4294977793, 8)] {
            assert_eq!((p - 1).trailing_zeros(), v);
            let len = (1usize << v) / 2;
            let a = vec![1u64; len];
            let m = Modulus::new(p);
            let want = naive_mod(&a, &a, &m);
            assert_eq!(conv_ntt_prime(&a, &a, p), want, "p = {}", p);
        }
    }

    #[test]
    fn primes_have_roots() {
        for &(p, g) in &PRIMES {
            assert!(crate::nmod::is_prime(p) && (p - 1) % (1 << 50) == 0 && p < 1 << 62);
            let m = Modulus::new(p);
            assert_eq!(m.pow(g, (p - 1) / 2), p - 1); // g is a non-residue: order divisible by 2^50
        }
    }

    #[test]
    fn mul_mod_matches_naive() {
        let mut s = 12345u64;
        for n in [2u64, 17, 65537, (1 << 31) - 1, 1_000_000_007, (1 << 61) - 1, u64::MAX - 58] {
            let m = Modulus::new(n);
            for (la, lb) in [(1, 1), (1, 7), (3, 5), (64, 64), (100, 33), (1000, 999), (5000, 3)] {
                let a: Vec<u64> = (0..la).map(|_| rng(&mut s) % n).collect();
                let b: Vec<u64> = (0..lb).map(|_| rng(&mut s) % n).collect();
                assert_eq!(mul_mod(&a, &b, &m), naive_mod(&a, &b, &m), "n={n} {la}x{lb}");
                assert_eq!(mul_mod(&a, &a, &m), naive_mod(&a, &a, &m));
            }
        }
    }

    #[test]
    fn mul_words_matches_dashu() {
        use dashu_int::UBig;
        let mut s = 777u64;
        for (la, lb) in [(1, 1), (2, 3), (50, 50), (300, 7), (5000, 4999), (20000, 20000)] {
            let a: Vec<u64> = (0..la).map(|_| rng(&mut s)).collect();
            let mut b: Vec<u64> = (0..lb).map(|_| rng(&mut s)).collect();
            if la == 2 {
                b = vec![u64::MAX; lb];
            }
            let words = |v: &[u64]| UBig::from_le_bytes(&v.iter().flat_map(|w| w.to_le_bytes()).collect::<Vec<u8>>());
            let want = words(&a) * words(&b);
            assert_eq!(words(&mul_words(&a, &b)), want);
            assert_eq!(words(&mul_words(&a, &a)), words(&a) * words(&a));
        }
        let ones = vec![u64::MAX; 4096];
        let w = |v: &[u64]| UBig::from_le_bytes(&v.iter().flat_map(|w| w.to_le_bytes()).collect::<Vec<u8>>());
        assert_eq!(w(&mul_words(&ones, &ones)), w(&ones) * w(&ones));
    }
}
