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

use crate::nmod::Modulus;
use crate::ntt_core::{self, NttWord, Table};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

/// (p, primitive root); 2^50 divides p - 1.
pub const PRIMES: [(u64, u64); 3] = [
    (4601552919265804289, 3),
    (4546383823830515713, 10),
    (4522739925786820609, 37),
];
const MAX_LOG: u32 = 50;
impl NttWord for u64 {
    type Modulus = Modulus;
    #[inline(always)]
    fn from_usize(x: usize) -> Self {
        x as u64
    }
    #[inline(always)]
    fn modulus(p: Self) -> Self::Modulus {
        Modulus::new(p)
    }
    #[inline(always)]
    fn reduce(x: Self, m: Self::Modulus) -> Self {
        m.reduce(x)
    }
    #[inline(always)]
    fn mul_mod(a: Self, b: Self, m: Self::Modulus) -> Self {
        m.mul(a, b)
    }
    #[inline(always)]
    fn inv_mod(a: Self, m: Self::Modulus) -> Self {
        m.inv(a).unwrap()
    }
    #[inline(always)]
    fn pointwise(a: Self, b: Self, ninv: Self, ninvp: Self, p: Self, m: Self::Modulus) -> Self {
        crate::nmod::mul_shoup(m.mul(a, b), ninv, ninvp, p)
    }
    fn root(m: Self::Modulus, primitive_root: Self, log: u32) -> (Self, Self) {
        let root = m.pow(primitive_root, (m.n - 1) >> log);
        (root, m.inv(root).unwrap())
    }
    #[inline(always)]
    fn shoup(w: Self, p: Self) -> Self {
        crate::nmod::shoup(w, p)
    }
    #[inline(always)]
    fn mul_shoup_lazy(a: Self, w: Self, wp: Self, p: Self) -> Self {
        crate::nmod::mul_shoup_lazy(a, w, wp, p)
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
        // (trial division to 2^23 for an NTT prime near 2^62 with 2^16 | p - 1)
        if d & 0x1ffff == 1 {
            sagebrush_interrupt::check_coarse();
        }
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
    (2..)
        .find(|&g| qs.iter().all(|&q| m.pow(g, (p - 1) / q) != 1))
        .unwrap()
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
static CACHE: Mutex<Vec<Arc<Table<u64>>>> = Mutex::new(Vec::new());
static TABLE_FOR_CALLS: AtomicUsize = AtomicUsize::new(0);

/// (calls of the shared table cache so far, its tables, their bytes): the
/// tests check that the op-local paths ([`LocalTables`]) never use it.
pub fn cache_stats() -> (usize, usize, usize) {
    let (tables, bytes) = ntt_core::cache_stats(&CACHE);
    (TABLE_FOR_CALLS.load(Relaxed), tables, bytes)
}

fn table_for(p: u64, log: u32) -> Arc<Table<u64>> {
    TABLE_FOR_CALLS.fetch_add(1, Relaxed);
    let g = PRIMES
        .iter()
        .find(|x| x.0 == p)
        .map_or_else(|| root_cached(p), |x| x.1);
    // (at least 2^8 entries, to be reused, but never beyond the 2-power of
    // p - 1: a table of 2^8 for p with v2(p - 1) = 7 squared 64 ones to a
    // wrong constant, the systematic review's ARITH finding)
    let max_root_log = (p - 1).trailing_zeros();
    let table_log = log.max(8).min(max_root_log).max(log);
    ntt_core::table_cached(&CACHE, p, g, max_root_log, table_log, 64)
}

fn table(idx: usize, log: u32) -> Arc<Table<u64>> {
    table_for(PRIMES[idx].0, log)
}

/// Whether products modulo m of length len can be done by one transform
/// modulo m itself (m prime below 2^62 with 2^log | m - 1).
pub fn is_ntt_prime(m: &Modulus, len: usize) -> bool {
    m.n > 1 << 32
        && m.n < 1 << 62
        && (m.n - 1).trailing_zeros() >= len.next_power_of_two().trailing_zeros()
        && crate::nmod::is_prime(m.n)
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

fn conv_table(a: &[u64], b: &[u64], t: &Table<u64>) -> Vec<u64> {
    let _phase = sagebrush_interrupt::enter("ntt");
    ntt_core::conv_table(a, b, t)
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
    Crt {
        m1,
        m2,
        c01,
        c012,
        p01: p0 as u128 * p1 as u128,
    }
}

impl Crt {
    /// x = r0 + p0 t1 + p0 p1 t2 (0 <= x < p0 p1 p2) as (v, t2) with
    /// v = r0 + p0 t1 < p0 p1.
    #[inline(always)]
    pub fn garner(&self, r0: u64, r1: u64, r2: u64) -> (u128, u64) {
        let p0 = PRIMES[0].0;
        let t1 = self.m1.mul(self.m1.sub(r1, self.m1.reduce(r0)), self.c01);
        let v = r0 as u128 + p0 as u128 * t1 as u128;
        let t2 = self
            .m2
            .mul(self.m2.sub(r2, self.m2.reduce_u128(v)), self.c012);
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
        return if square {
            conv_ntt_prime(a, a, m.n)
        } else {
            conv_ntt_prime(a, b, m.n)
        };
    }
    let log = log2_len(len);
    combine(a, b, m, |i| {
        let t = table(i, log);
        if square {
            conv_table(a, a, &t)
        } else {
            conv_table(a, b, &t)
        }
    })
}

/// The products modulo the primes needed, combined modulo m.n (CRT).
fn combine(a: &[u64], b: &[u64], m: &Modulus, conv: impl Fn(usize) -> Vec<u64>) -> Vec<u64> {
    let len = a.len() + b.len() - 1;
    match primes_needed(m.n, a.len().min(b.len())) {
        1 => {
            let mut r = conv(0);
            sagebrush_interrupt::check_coarse();
            r.iter_mut().for_each(|x| *x = m.reduce(*x));
            r
        }
        2 => {
            let (r0, r1) = (conv(0), conv(1));
            sagebrush_interrupt::check_coarse();
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
            sagebrush_interrupt::check_coarse();
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

/// The transform tables of one computation modulo m with products of
/// length at most `max_len`, owned by the caller and freed with it: built
/// once at that length (a table serves every shorter transform), without
/// the shared cache ([`table_for`]) or its primitive-root list, so a
/// computation's memory is bounded by its own sizes, whatever other
/// computations left in the cache.  Either m's own table (when m is an NTT
/// prime at max_len: [`is_ntt_prime`]) or the tables of the primes that
/// products of that length need; 32 2^log bytes each, at most three.
pub struct LocalTables {
    own: bool,
    tabs: Vec<Table<u64>>,
}

impl LocalTables {
    pub fn new(m: &Modulus, max_len: usize) -> LocalTables {
        let max_len = max_len.max(1);
        let log = log2_len(max_len);
        let _phase = sagebrush_interrupt::enter("ntt");
        if is_ntt_prime(m, max_len) {
            let t = Table::new(m.n, primitive_root(m.n), (m.n - 1).trailing_zeros(), log);
            return LocalTables {
                own: true,
                tabs: vec![t],
            };
        }
        // (primes_needed grows with the shorter factor, at most max_len)
        let k = primes_needed(m.n, max_len);
        let mut tabs = Vec::with_capacity(k);
        for &(p, g) in &PRIMES[..k] {
            sagebrush_interrupt::check_coarse();
            tabs.push(Table::new(p, g, (p - 1).trailing_zeros(), log));
        }
        LocalTables { own: false, tabs }
    }

    /// The bytes the tables hold.
    pub fn bytes(&self) -> usize {
        self.tabs.iter().map(Table::bytes).sum()
    }

    fn get(&self, i: usize, len: usize) -> &Table<u64> {
        let t = &self.tabs[i];
        assert!(
            log2_len(len) <= t.log,
            "LocalTables: a product longer than its tables"
        );
        t
    }
}

/// [`mul_mod`] with the caller's tables (built for products at least this
/// long): the same product.
pub fn mul_mod_in(a: &[u64], b: &[u64], m: &Modulus, lt: &LocalTables) -> Vec<u64> {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let len = a.len() + b.len() - 1;
    let square = std::ptr::eq(a, b);
    let conv = |i: usize| {
        let t = lt.get(i, len);
        if square {
            conv_table(a, a, t)
        } else {
            conv_table(a, b, t)
        }
    };
    if lt.own {
        // (exact modulo m.n itself: conv_table reduces into [0, p))
        return conv(0);
    }
    combine(a, b, m, conv)
}

/// The product of two nonnegative integers given as little-endian 64-bit
/// words; the result has a.len() + b.len() words.
pub fn mul_words(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut out = vec![0u64; a.len() + b.len()];
    if a.is_empty() || b.is_empty() {
        return out;
    }
    let square = std::ptr::eq(a, b);
    let conv = |i| {
        if square {
            conv_prime(a, a, i)
        } else {
            conv_prime(a, b, i)
        }
    };
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
        for (p, v) in [
            (4294967311u64, 1u32),
            (4294967357, 2),
            (4294967497, 3),
            (4294967377, 4),
            (4294967969, 5),
            (4294968001, 6),
            (4294967681, 7),
            (4294977793, 8),
        ] {
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
        for n in [
            2u64,
            17,
            65537,
            (1 << 31) - 1,
            1_000_000_007,
            (1 << 61) - 1,
            u64::MAX - 58,
        ] {
            let m = Modulus::new(n);
            for (la, lb) in [
                (1, 1),
                (1, 7),
                (3, 5),
                (64, 64),
                (100, 33),
                (1000, 999),
                (5000, 3),
            ] {
                let a: Vec<u64> = (0..la).map(|_| rng(&mut s) % n).collect();
                let b: Vec<u64> = (0..lb).map(|_| rng(&mut s) % n).collect();
                assert_eq!(
                    mul_mod(&a, &b, &m),
                    naive_mod(&a, &b, &m),
                    "n={n} {la}x{lb}"
                );
                assert_eq!(mul_mod(&a, &a, &m), naive_mod(&a, &a, &m));
            }
        }
    }

    #[test]
    fn primes_needed_boundaries_match_naive() {
        let p0 = PRIMES[0].0 as u128;
        for (name, target, range) in [
            ("just below p0", p0 - 1, 0),
            ("between p0 and twice p0", p0 + p0 / 2, 1),
        ] {
            // Four equal terms make the middle coefficient 4 * x^2.  Pin
            // both sides of primes_needed's first boundary with real
            // products, not just the selector's return value.
            let x = (target / 4).isqrt();
            let bound = 4 * x * x;
            if range == 0 {
                assert!(bound < p0, "{name}: {bound} is not below {p0}");
            } else {
                assert!(
                    p0 <= bound && bound < 2 * p0,
                    "{name}: {bound} is not in [{p0}, {})",
                    2 * p0
                );
            }
            let m = Modulus::new(x as u64 + 1);
            let a = vec![x as u64; 4];
            assert_eq!(mul_mod(&a, &a, &m), naive_mod(&a, &a, &m), "{name}");
        }
    }

    #[test]
    fn shared_cache_evicts_beyond_table_capacity() {
        // p = c*2^20 + 1 keeps primitive-root factorization cheap while
        // giving more than 64 distinct admissible NTT moduli above 2^32.
        let mut c = 4097u64;
        let mut found = 0;
        while found < 66 {
            let p = c * (1 << 20) + 1;
            let m = Modulus::new(p);
            if is_ntt_prime(&m, 2) {
                let a = [p - 1, p - 2];
                let b = [p - 3];
                assert_eq!(conv_ntt_prime(&a, &b, p), naive_mod(&a, &b, &m), "p={p}");
                found += 1;
            }
            c += 2;
        }
        assert!(
            cache_stats().1 <= 64,
            "the shared cache exceeded its 64-table capacity"
        );
    }

    #[test]
    fn local_tables_same_products_without_the_cache() {
        let mut s = 31u64;
        for n in [
            2u64,
            65537,
            (1 << 61) - 1,
            4601552919265804289,
            (1 << 20) * 4097 + 1,
        ] {
            let m = Modulus::new(n);
            let lt = LocalTables::new(&m, 5000);
            assert!(lt.bytes() <= 3 * 32 * 8192);
            let calls = cache_stats().0;
            for (la, lb) in [(1, 1), (40, 40), (1000, 999), (4000, 1001), (2500, 2500)] {
                let a: Vec<u64> = (0..la).map(|_| rng(&mut s) % n).collect();
                let b: Vec<u64> = (0..lb).map(|_| rng(&mut s) % n).collect();
                assert_eq!(
                    mul_mod_in(&a, &b, &m, &lt),
                    naive_mod(&a, &b, &m),
                    "n={n} {la}x{lb}"
                );
                assert_eq!(mul_mod_in(&a, &a, &m, &lt), naive_mod(&a, &a, &m));
            }
            // (other tests may use the cache meanwhile: only this thread's
            // calls are certain, so the count cannot have gone down)
            assert!(cache_stats().0 >= calls);
        }
    }

    #[test]
    fn mul_words_matches_dashu() {
        use dashu_int::UBig;
        let mut s = 777u64;
        for (la, lb) in [
            (1, 1),
            (2, 3),
            (50, 50),
            (300, 7),
            (5000, 4999),
            (20000, 20000),
        ] {
            let a: Vec<u64> = (0..la).map(|_| rng(&mut s)).collect();
            let mut b: Vec<u64> = (0..lb).map(|_| rng(&mut s)).collect();
            if la == 2 {
                b = vec![u64::MAX; lb];
            }
            let words = |v: &[u64]| {
                UBig::from_le_bytes(&v.iter().flat_map(|w| w.to_le_bytes()).collect::<Vec<u8>>())
            };
            let want = words(&a) * words(&b);
            assert_eq!(words(&mul_words(&a, &b)), want);
            assert_eq!(words(&mul_words(&a, &a)), words(&a) * words(&a));
        }
        let ones = vec![u64::MAX; 4096];
        let w = |v: &[u64]| {
            UBig::from_le_bytes(&v.iter().flat_map(|w| w.to_le_bytes()).collect::<Vec<u8>>())
        };
        assert_eq!(w(&mul_words(&ones, &ones)), w(&ones) * w(&ones));
    }
}
