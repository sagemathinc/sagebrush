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
pub use crate::ntt_core::{conv_work, restore_units, table_work, units};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

/// (p, primitive root); 2^50 divides p - 1.
pub const PRIMES: [(u64, u64); 3] = [
    (4601552919265804289, 3),
    (4546383823830515713, 10),
    (4522739925786820609, 37),
];
const MAX_LOG: u32 = 50;

/// The 32-bit primes of wasm32's op-local product (`ntt32`): (p, primitive
/// root, the 2-adic order of p - 1).
pub const PRIMES32: [(u32, u32, u32); 3] = [(469_762_049, 3, 26), (998_244_353, 3, 23), (754_974_721, 11, 24)];
/// The longest 32-bit transform: 2^23 points.
pub const LOCAL32_MAX_LOG: u32 = 23;

// The 32-bit product's Chinese remaindering is exact and its roots exist at
// every transform length up to 2^LOCAL32_MAX_LOG: a convolution of that many
// 32-bit digits has coefficients below 2^23 (2^32 - 1)^2 < p1 p2 p3, and
// 2^LOCAL32_MAX_LOG divides each p - 1 (the stated 2-adic orders exact).
const _: () = {
    let (p0, p1, p2) = (PRIMES32[0].0 as u128, PRIMES32[1].0 as u128, PRIMES32[2].0 as u128);
    let digit = (1u128 << 32) - 1;
    assert!((1u128 << LOCAL32_MAX_LOG) * digit * digit < p0 * p1 * p2);
    let mut i = 0;
    while i < 3 {
        let (p, _, order) = PRIMES32[i];
        assert!((p - 1).trailing_zeros() == order && order >= LOCAL32_MAX_LOG);
        i += 1;
    }
};
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
/// (the least such generator)
pub fn primitive_root(p: u64) -> u64 {
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

/// Whether the shared cache's lock is poisoned: a Stop inside a table's
/// build must never poison it (the tests check).
pub fn cache_poisoned() -> bool {
    CACHE.is_poisoned()
}

/// The tables the shared cache has built so far (two callers missing on
/// the same table build it once: the build is serialized under the lock).
pub fn cache_builds() -> usize {
    ntt_core::CACHE_BUILDS.load(Relaxed)
}

/// Empty the shared cache (tests: to make the next product build again).
#[doc(hidden)]
pub fn cache_clear() {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
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
    let k = primes_needed(m.n, a.len().min(b.len()));
    // (the CRT pass, counted once done: one reduction per prime per
    // coefficient)
    let crt_done = || crate::ntt_core::tally_reductions(k as u64 * len as u64);
    match k {
        1 => {
            let mut r = conv(0);
            sagebrush_interrupt::check_coarse();
            r.iter_mut().for_each(|x| *x = m.reduce(*x));
            crt_done();
            r
        }
        2 => {
            let (r0, r1) = (conv(0), conv(1));
            sagebrush_interrupt::check_coarse();
            let (p0, p1) = (PRIMES[0].0, PRIMES[1].0);
            let m1 = Modulus::new(p1);
            let c01 = m1.inv(p0 % p1).unwrap();
            let p0n = m.reduce(p0);
            let r = (0..len)
                .map(|i| {
                    let t1 = m1.mul(m1.sub(r1[i], m1.reduce(r0[i])), c01);
                    m.add(m.reduce(r0[i]), m.mul(p0n, m.reduce(t1)))
                })
                .collect();
            crt_done();
            r
        }
        _ => {
            let (r0, r1, r2) = (conv(0), conv(1), conv(2));
            sagebrush_interrupt::check_coarse();
            let c = crt();
            let p01n = m.reduce_u128(c.p01);
            let r = (0..len)
                .map(|i| {
                    let (v, t2) = c.garner(r0[i], r1[i], r2[i]);
                    m.add(m.reduce_u128(v), m.mul(p01n, m.reduce(t2)))
                })
                .collect();
            crt_done();
            r
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

    /// m's own table for products of length at most `max_len`, built from
    /// `root`, a primitive root of the NTT prime m (the caller's verified
    /// constant: no search for one here, so the build is [`table_work`]).
    /// Panics unless m has the shape of an NTT prime at max_len (2^32 < m <
    /// 2^62, 2^log | m - 1); its primality is the caller's (a tested
    /// constant), not re-proved here.
    pub fn with_root(m: &Modulus, root: u64, max_len: usize) -> LocalTables {
        let max_len = max_len.max(1);
        assert!(
            m.n > 1 << 32 && m.n < 1 << 62 && (m.n - 1).trailing_zeros() >= max_len.next_power_of_two().trailing_zeros(),
            "LocalTables::with_root: not an NTT modulus at this length"
        );
        let log = log2_len(max_len);
        let _phase = sagebrush_interrupt::enter("ntt");
        LocalTables {
            own: true,
            tabs: vec![Table::new(m.n, root, (m.n - 1).trailing_zeros(), log)],
        }
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
    if a.is_empty() || b.is_empty() {
        return vec![0u64; a.len() + b.len()];
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
    garner_words(&r0, &r1, &r2, a.len() + b.len())
}

/// [`mul_words`] with the op's own tables instead of the shared cache: each
/// prime's table is built here (from its root, no search) and dropped before
/// the next one, so the call's memory is its own sizes, whatever the cache
/// holds, and it never grows the cache.  Its word operations are at most
/// [`mul_words_local_work`], its live bytes at most [`mul_words_local_peak`].
///
/// On wasm32 the product runs on 32-bit digits instead (`ntt32`: three
/// primes below 2^30, whose products wasm32 has natively, where the 64-bit
/// primes' need u128): chosen at compile time, after the same admission;
/// native builds run the 64-bit path unchanged.
pub fn mul_words_local(a: &[u64], b: &[u64]) -> Vec<u64> {
    if a.is_empty() || b.is_empty() {
        return vec![0u64; a.len() + b.len()];
    }
    #[cfg(target_arch = "wasm32")]
    {
        crate::ntt32::mul_words_local(a, b)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        mul_words_local64(a, b)
    }
}

/// The 64-bit path of [`mul_words_local`].
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(crate) fn mul_words_local64(a: &[u64], b: &[u64]) -> Vec<u64> {
    let log = log2_len(a.len() + b.len() - 1);
    let conv = |i: usize| {
        let (p, g) = PRIMES[i];
        let t = {
            let _phase = sagebrush_interrupt::enter("ntt");
            Table::new(p, g, (p - 1).trailing_zeros(), log)
        };
        conv_table(a, b, &t)
    };
    let (r0, r1, r2) = (conv(0), conv(1), conv(2));
    garner_words(&r0, &r1, &r2, a.len() + b.len())
}

/// Word operations of [`mul_words_local`] for factors of `la` and `lb`
/// words, on every target (one form, so a request is admitted or refused
/// the same everywhere).  A word operation is one 64-bit operation of the
/// native path, or two counted 32-bit operations of wasm32's 32-bit path
/// (rounded up: a u32 operation weighs 1/2, the 32-bit path's time per
/// operation measured at well under half; the counters prove the bound).
/// With m = la + lb and N = m - 1 padded to a power of two:
/// - per prime, a table ([`table_work`] at N points: the 32-bit table at 2N
///   points weighs half of table_work at 2N, less) and a convolution
///   ([`conv_work`] at N points, plus one more butterfly stage, ceil(3N /
///   2): the 32-bit transform has twice the points, one more stage);
/// - Garner's combination and the carry, 16 per output word (the 32-bit
///   path's 16 per digit, two digits a word, at half weight);
/// - the 32-bit path's split of the inputs into digits and the repacking of
///   its result, 1 each per word (two counted per word, at half weight).
///
/// So per prime table_work + conv_work + ceil(3N / 2), three times, plus 18 m.
/// None on overflow.
pub const fn mul_words_local_work(la: usize, lb: usize) -> Option<u64> {
    if la == 0 || lb == 0 {
        return Some(0);
    }
    let m = match la.checked_add(lb) {
        Some(x) => x,
        None => return None,
    };
    let log = match (m - 1).checked_next_power_of_two() {
        Some(n) => n.trailing_zeros(),
        None => return None,
    };
    let stage = match (1u64 << log).checked_mul(3) {
        Some(x) => x.div_ceil(2),
        None => return None,
    };
    let per_prime = match (table_work(log), conv_work(log)) {
        (Some(t), Some(c)) => match t.checked_add(c) {
            Some(x) => match x.checked_add(stage) {
                Some(y) => y,
                None => return None,
            },
            None => return None,
        },
        _ => return None,
    };
    match (per_prime.checked_mul(3), (m as u64).checked_mul(18)) {
        (Some(x), Some(y)) => x.checked_add(y),
        _ => None,
    }
}

/// Live bytes of [`mul_words_local`] beyond its inputs, on every target: 64N
/// + 8m, with m = la + lb and N = m - 1 padded to a power of two.  The 64-bit
/// path's worst point (the third prime: the first two residue vectors at
/// their capacity N, the third's two transform buffers and its table of four
/// N-word vectors), or its Garner pass (three residue vectors and the
/// output), is within 64N; the 32-bit path has the same bytes at 2N points of
/// 4 bytes, plus its digit copies of the inputs, 8m, live through the third
/// convolution (then dropped: its Garner pass holds the residues and m words
/// of digits, its repacking 16m).  None on overflow.
pub const fn mul_words_local_peak(la: usize, lb: usize) -> Option<u64> {
    let m = match la.checked_add(lb) {
        Some(x) => x,
        None => return None,
    };
    if la == 0 || lb == 0 {
        return (m as u64).checked_mul(8);
    }
    let n = match (m - 1).checked_next_power_of_two() {
        Some(n) => n as u64,
        None => return None,
    };
    match (n.checked_mul(64), (m as u64).checked_mul(8)) {
        (Some(x), Some(y)) => x.checked_add(y),
        _ => None,
    }
}

/// The three residue vectors combined (Garner) into `words` little-endian
/// words, with the carry; polled every 2^12 positions.
fn garner_words(r0: &[u64], r1: &[u64], r2: &[u64], words: usize) -> Vec<u64> {
    let mut out = vec![0u64; words];
    let c = crt();
    let (plo, phi) = (c.p01 as u64, (c.p01 >> 64) as u64);
    let mut carry: u128 = 0;
    for i in 0..r0.len() {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
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

    /// The per-thread work counter (units) against the butterflies the
    /// transforms count where they happen: for products modulo m of many
    /// lengths, by every route (the NTT prime itself, one, two or three
    /// primes), a square or not, the counter's transform part minus the
    /// pointwise products equals the butterflies performed; its reductions
    /// are the inputs, the result per prime and the CRT pass.
    #[test]
    fn units_count_exactly_what_the_transforms_do() {
        let moduli = [Modulus::new(7), Modulus::new(65537), Modulus::new((1u64 << 31) - 1), Modulus::new(0x3ffffffffffe0001), Modulus::new((1 << 61) - 1)];
        for m in &moduli {
            for (la, lb) in [(1usize, 1usize), (3, 5), (40, 40), (100, 37), (513, 300), (1000, 1000)] {
                for square in [false, true] {
                    if square && la != lb {
                        continue;
                    }
                    let a: Vec<u64> = (0..la as u64).map(|i| (i * 7 + 3) % m.n).collect();
                    let b: Vec<u64> = (0..lb as u64).map(|i| (i * 11 + 5) % m.n).collect();
                    crate::ntt_core::BUTTERFLIES.with(|w| w.set(0));
                    let u0 = units();
                    let c = if square { mul_mod(&a, &a, m) } else { mul_mod(&a, &b, m) };
                    let u1 = units();
                    let fly = crate::ntt_core::BUTTERFLIES.with(|w| w.get());
                    let len = la + lb - 1;
                    assert_eq!(c.len(), len);
                    let n = len.next_power_of_two() as u64;
                    let convs = if is_ntt_prime(m, len) { 1 } else { primes_needed(m.n, la.min(lb)) as u64 };
                    let d = [u1[0].wrapping_sub(u0[0]), u1[1].wrapping_sub(u0[1]), u1[2].wrapping_sub(u0[2])];
                    assert_eq!(d[0] - convs * n, fly, "p={} {}x{} square={}: butterflies", m.n, la, lb, square);
                    let loads = if square { 1 } else { 2 };
                    assert_eq!(d[2], convs * loads * n, "zero fills");
                    let inputs = (la + if square { 0 } else { lb }) as u64;
                    let crt = if is_ntt_prime(m, len) { 0 } else { convs * len as u64 };
                    assert_eq!(d[1], convs * (inputs + len as u64) + crt, "reductions");
                }
            }
        }
    }
    use super::*;

    #[test]
    fn mul_words_local_matches_mul_words_within_its_work() {
        let mut s = 0x5eed_u64;
        for (la, lb) in [(1usize, 1usize), (2, 3), (50, 50), (1000, 7), (4097, 4096), (1 << 15, 3)] {
            let a: Vec<u64> = (0..la).map(|_| rng(&mut s)).collect();
            let b: Vec<u64> = (0..lb).map(|_| rng(&mut s)).collect();
            crate::ntt_core::WORK.with(|c| c.set(0));
            let z = mul_words_local(&a, &b);
            let counted = crate::ntt_core::WORK.with(|c| c.get());
            assert_eq!(z, mul_words(&a, &b), "{} x {}", la, lb);
            // (the tables and convolutions are counted at their loops; Garner's
            // pass is the formula's last term, 16 per output word)
            let w = mul_words_local_work(la, lb).unwrap();
            assert!(counted + 16 * (la + lb) as u64 <= w, "{} x {}: counted {} + Garner, bound {}", la, lb, counted, w);
        }
        assert_eq!(mul_words_local(&[], &[1, 2]), vec![0, 0]);
        assert_eq!(mul_words_local_work(0, 5), Some(0));
        // (the closed forms never wrap: None, not a small number)
        assert_eq!(mul_words_local_work(usize::MAX, 2), None);
        assert_eq!(mul_words_local_peak(usize::MAX, 2), None);
    }

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
