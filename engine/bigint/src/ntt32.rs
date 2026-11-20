//! The wasm32 parameters and carry pass for the shared NTT, and wasm32's
//! op-local product of u64 words ([`mul_words_local`], behind
//! `ntt::mul_words_local` there).
//!
//! Transform tables, butterflies, cache policy and convolution are the same
//! generic implementation as native builds use in [`crate::ntt_core`].

use crate::ntt_core::{self, conv_table_cyclic, count, NttWord, Table};
use std::sync::{Arc, Mutex};

// All three primes are below 2^30. Thus lazy values below 4p fit in u32.
// Their product is > 2^88, enough for a 2^23-long convolution of base-2^32
// digits. The roots have orders 2^26, 2^23 and 2^24 respectively (asserted
// with the CRT bound where they are defined, ntt::PRIMES32).
const PRIMES: [(u32, u32, u32); 3] = crate::ntt::PRIMES32;
const MAX_LOG: u32 = crate::ntt::LOCAL32_MAX_LOG;
const BLOCK: usize = 1 << 12;

#[inline(always)]
fn mul_mod(a: u32, b: u32, p: u32) -> u32 {
    (a as u64 * b as u64 % p as u64) as u32
}

fn pow_mod(mut a: u32, mut n: u64, p: u32) -> u32 {
    let mut r = 1;
    while n != 0 {
        if n & 1 != 0 {
            r = mul_mod(r, a, p);
        }
        a = mul_mod(a, a, p);
        n >>= 1;
    }
    r
}

impl NttWord for u32 {
    type Modulus = u32;
    #[inline(always)]
    fn from_usize(x: usize) -> Self {
        x as u32
    }
    #[inline(always)]
    fn modulus(p: Self) -> Self::Modulus {
        p
    }
    #[inline(always)]
    fn reduce(x: Self, p: Self::Modulus) -> Self {
        if x >= p {
            x % p
        } else {
            x
        }
    }
    #[inline(always)]
    fn mul_mod(a: Self, b: Self, p: Self::Modulus) -> Self {
        mul_mod(a, b, p)
    }
    #[inline(always)]
    fn inv_mod(a: Self, p: Self::Modulus) -> Self {
        pow_mod(a, p as u64 - 2, p)
    }
    #[inline(always)]
    fn pointwise(a: Self, b: Self, ninv: Self, _ninvp: Self, _p: Self, m: Self::Modulus) -> Self {
        mul_mod(mul_mod(a, b, m), ninv, m)
    }
    fn root(p: Self::Modulus, primitive_root: Self, log: u32) -> (Self, Self) {
        let root = pow_mod(primitive_root, (p as u64 - 1) >> log, p);
        (root, pow_mod(root, p as u64 - 2, p))
    }
    #[inline(always)]
    fn shoup(w: Self, p: Self) -> Self {
        (((w as u64) << 32) / p as u64) as u32
    }
    #[inline(always)]
    fn mul_shoup_lazy(a: Self, w: Self, wp: Self, p: Self) -> Self {
        let q = ((a as u64 * wp as u64) >> 32) as u32;
        a.wrapping_mul(w).wrapping_sub(q.wrapping_mul(p))
    }
}

static CACHE: Mutex<Vec<Arc<Table<u32>>>> = Mutex::new(Vec::new());

fn table(prime: usize, log: u32) -> Arc<Table<u32>> {
    let (p, g, max_log) = PRIMES[prime];
    ntt_core::table_cached(&CACHE, p, g, max_log, log.max(8), usize::MAX)
}

fn convolution(a: &[u32], b: &[u32], prime: usize) -> Vec<u32> {
    let len = a.len() + b.len() - 1;
    let log = len.next_power_of_two().trailing_zeros();
    ntt_core::conv_table(a, b, &table(prime, log))
}

/// Whether one shared NTT can represent this product. Callers above this
/// exact transform domain fall back to Dashu instead of trapping.
pub(crate) fn supports_words(a: usize, b: usize) -> bool {
    a != 0
        && b != 0
        && a.checked_add(b)
            .and_then(|x| x.checked_sub(1))
            .and_then(usize::checked_next_power_of_two)
            .is_some_and(|n| n <= 1usize << MAX_LOG)
}

/// Product of nonnegative integers represented as little-endian u32 limbs.
pub fn mul_words(a: &[u32], b: &[u32]) -> Vec<u32> {
    let _phase = sagebrush_interrupt::enter("bigint.ntt32");
    assert!(supports_words(a.len(), b.len()));
    let mut out = vec![0; a.len() + b.len()];
    let (p0, p1, p2) = (PRIMES[0].0, PRIMES[1].0, PRIMES[2].0);
    let (r0, r1, r2) = (
        convolution(a, b, 0),
        convolution(a, b, 1),
        convolution(a, b, 2),
    );
    let c01 = pow_mod(p0 % p1, p1 as u64 - 2, p1);
    let p01 = p0 as u64 * p1 as u64;
    let c012 = pow_mod((p01 % p2 as u64) as u32, p2 as u64 - 2, p2);
    let mut carry = 0u128;
    for i in 0..r0.len() {
        if i & (BLOCK - 1) == 0 {
            sagebrush_interrupt::check_coarse();
        }
        let d1 = if r1[i] >= r0[i] % p1 {
            r1[i] - r0[i] % p1
        } else {
            r1[i] + p1 - r0[i] % p1
        };
        let t1 = mul_mod(d1, c01, p1);
        let v = r0[i] as u128 + p0 as u128 * t1 as u128;
        let vm2 = (v % p2 as u128) as u32;
        let d2 = if r2[i] >= vm2 {
            r2[i] - vm2
        } else {
            r2[i] + p2 - vm2
        };
        let t2 = mul_mod(d2, c012, p2);
        let total = v + p01 as u128 * t2 as u128 + carry;
        out[i] = total as u32;
        carry = total >> 32;
    }
    let mut i = r0.len();
    while carry != 0 {
        out[i] = carry as u32;
        carry >>= 32;
        i += 1;
    }
    out
}

// (tests only: the counted 32-bit operations of [`mul_words_local`] by
// category, against the halves of mul_words_local_work's terms)
#[cfg(test)]
thread_local! {
    pub(crate) static LOCAL_TALLY: std::cell::Cell<[u64; 5]> = const { std::cell::Cell::new([0; 5]) };
}
pub(crate) const SPLIT: usize = 0;
pub(crate) const TABLES: usize = 1;
pub(crate) const CONVS: usize = 2;
pub(crate) const GARNER: usize = 3;
pub(crate) const REPACK: usize = 4;

/// The counter's units since `mark`, added to category `c` (tests only).
#[inline(always)]
fn tally(c: usize, mark: &mut u64) {
    #[cfg(test)]
    {
        let now = ntt_core::WORK.with(|w| w.get());
        LOCAL_TALLY.with(|t| {
            let mut v = t.get();
            v[c] += now - *mark;
            t.set(v);
        });
        *mark = now;
    }
    let _ = (c, &mark);
}

fn now() -> u64 {
    #[cfg(test)]
    {
        ntt_core::WORK.with(|w| w.get())
    }
    #[cfg(not(test))]
    {
        0
    }
}

/// The product of two nonempty nonnegative integers given as little-endian
/// u64 words, on 32-bit digits (wasm32's `ntt::mul_words_local`): each word
/// split into two u32 digits; per prime a table built here from its root
/// (no search, no shared cache) and dropped after its convolution; the
/// digits' copies dropped after the third; Garner's combination with the
/// carry into u32 digits; then the digits joined back into words.  The
/// result has a.len() + b.len() words.  Every loop polls at least every
/// BLOCK steps; its counted 32-bit operations are within twice
/// `ntt::mul_words_local_work`'s terms, its live bytes beyond the inputs
/// within `ntt::mul_words_local_peak` (64N + 8m).
pub(crate) fn mul_words_local(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut mark = now();
    let (x, y) = {
        let _phase = sagebrush_interrupt::enter("ntt32.split");
        (split(a), split(b))
    };
    tally(SPLIT, &mut mark);
    // (2N points, N the 64-bit path's: the digit product has 2m - 1
    // coefficients, at most 2N + 1; the last one wraps and is added back)
    let m = a.len() + b.len();
    let log = (m - 1).next_power_of_two().trailing_zeros() + 1;
    assert!(log <= MAX_LOG, "transform too long");
    let wraps = 2 * m - 1 > 1usize << log;
    let top = (*x.last().unwrap_or(&0) as u64) * (*y.last().unwrap_or(&0) as u64);
    let mut r: [Vec<u32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (i, slot) in r.iter_mut().enumerate() {
        let (p, g, order) = PRIMES[i];
        let t = {
            let _phase = sagebrush_interrupt::enter("ntt");
            Table::new(p, g, order, log)
        };
        tally(TABLES, &mut mark);
        *slot = conv_table_cyclic(&x, &y, &t);
        tally(CONVS, &mut mark);
    }
    drop((x, y));
    let digits = {
        let _phase = sagebrush_interrupt::enter("ntt32.garner");
        garner(&r, 2 * m, if wraps { Some(top) } else { None })
    };
    tally(GARNER, &mut mark);
    drop(r);
    let out = {
        let _phase = sagebrush_interrupt::enter("ntt32.repack");
        join(&digits)
    };
    tally(REPACK, &mut mark);
    out
}

/// x's words as u32 digits, low first: two counted per word.
fn split(x: &[u64]) -> Vec<u32> {
    let mut d = Vec::with_capacity(2 * x.len());
    for chunk in x.chunks(BLOCK) {
        sagebrush_interrupt::check_coarse();
        for &w in chunk {
            d.push(w as u32);
            d.push((w >> 32) as u32);
        }
        count(2 * chunk.len() as u64);
    }
    d
}

/// u32 digits (an even count) joined into words: two counted per word.
fn join(d: &[u32]) -> Vec<u64> {
    let mut out = Vec::with_capacity(d.len() / 2);
    for chunk in d.chunks(2 * BLOCK) {
        sagebrush_interrupt::check_coarse();
        for pair in chunk.chunks_exact(2) {
            out.push(pair[0] as u64 | (pair[1] as u64) << 32);
        }
        count(chunk.len() as u64);
    }
    out
}

/// The residues modulo the three primes combined into `digits` u32 digits
/// with the carry (Garner), then `top`, the exact coefficient past the
/// residues when the product wrapped: 16 counted per digit (its zero fill
/// and 15 in the loop), polled every BLOCK.
fn garner(r: &[Vec<u32>; 3], digits: usize, top: Option<u64>) -> Vec<u32> {
    let (r0, r1, r2) = (&r[0], &r[1], &r[2]);
    let (p0, p1, p2) = (PRIMES[0].0, PRIMES[1].0, PRIMES[2].0);
    let c01 = pow_mod(p0 % p1, p1 as u64 - 2, p1);
    let p01 = p0 as u64 * p1 as u64;
    let c012 = pow_mod((p01 % p2 as u64) as u32, p2 as u64 - 2, p2);
    let mut out = vec![0u32; digits];
    count(digits as u64);
    let mut carry = 0u128;
    for i in 0..r0.len() {
        if i & (BLOCK - 1) == 0 {
            sagebrush_interrupt::check_coarse();
            count(15 * (r0.len() - i).min(BLOCK) as u64);
        }
        let d1 = if r1[i] >= r0[i] % p1 { r1[i] - r0[i] % p1 } else { r1[i] + p1 - r0[i] % p1 };
        let t1 = mul_mod(d1, c01, p1);
        let v = r0[i] as u128 + p0 as u128 * t1 as u128;
        let vm2 = (v % p2 as u128) as u32;
        let d2 = if r2[i] >= vm2 { r2[i] - vm2 } else { r2[i] + p2 - vm2 };
        let t2 = mul_mod(d2, c012, p2);
        let total = v + p01 as u128 * t2 as u128 + carry;
        out[i] = total as u32;
        carry = total >> 32;
    }
    // (the exact top coefficient, then the carry past it, fill at most the
    // remaining digits)
    let mut i = r0.len();
    if let Some(t) = top {
        count(15);
        let total = t as u128 + carry;
        out[i] = total as u32;
        carry = total >> 32;
        i += 1;
    }
    while carry != 0 {
        out[i] = carry as u32;
        carry >>= 32;
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use dashu_int::UBig;
    use std::process::Command;

    fn rng(seed: &mut u64) -> u32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed as u32
    }

    fn ubig(words: &[u32]) -> UBig {
        UBig::from_le_bytes(
            &words
                .iter()
                .flat_map(|w| w.to_le_bytes())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn products_match_dashu() {
        let mut seed = 17;
        for (la, lb) in [
            (1, 1),
            (2, 3),
            (31, 33),
            (100, 73),
            (4096, 4095),
            (10_000, 10_000),
        ] {
            let a: Vec<_> = (0..la).map(|_| rng(&mut seed)).collect();
            let b: Vec<_> = (0..lb).map(|_| rng(&mut seed)).collect();
            assert_eq!(ubig(&mul_words(&a, &b)), ubig(&a) * ubig(&b), "{la}x{lb}");
            assert_eq!(ubig(&mul_words(&a, &a)), ubig(&a).pow(2), "square {la}");
        }
        let ones = vec![u32::MAX; 5000];
        assert_eq!(ubig(&mul_words(&ones, &ones)), ubig(&ones).pow(2));
    }

    #[test]
    fn transforms_match_schoolbook() {
        let mut seed = 91;
        for prime in 0..3 {
            let p = PRIMES[prime].0 as u64;
            for (la, lb) in [(1, 1), (2, 3), (31, 33), (100, 73)] {
                let a: Vec<_> = (0..la).map(|_| rng(&mut seed)).collect();
                let b: Vec<_> = (0..lb).map(|_| rng(&mut seed)).collect();
                let mut want = vec![0u64; la + lb - 1];
                for (i, &x) in a.iter().enumerate() {
                    for (j, &y) in b.iter().enumerate() {
                        want[i + j] = (want[i + j] + x as u64 * y as u64) % p;
                    }
                }
                assert_eq!(
                    convolution(&a, &b, prime),
                    want.iter().map(|&x| x as u32).collect::<Vec<_>>()
                );
            }
        }
    }

    #[test]
    fn routing_pins_the_transform_domain_without_large_allocations() {
        let n = 1usize << MAX_LOG;
        assert!(supports_words(n - 4095, 4096));
        assert!(!supports_words(n - 4094, 4096));
        assert!(!supports_words(usize::MAX, 4096));
        assert!(!supports_words(0, 4096));
    }

    #[test]
    fn cache_and_fresh_memory_have_separate_bounds() {
        let a = vec![u32::MAX; 10_000];
        let _ = mul_words(&a, &a);
        let (tables, bytes) = ntt_core::cache_stats(&CACHE);
        assert_eq!(tables, 3);
        assert_eq!(bytes, 3 * 16 * (1 << 15));
        assert!(bytes <= 1 << 28); // retained tables only
                                   // Three 4-vector tables, three n-word residue allocations and two
                                   // n-word transform buffers. truncate keeps each residue's capacity n.
        let fresh_peak_bound = |a: usize, b: usize| {
            let n = (a + b - 1).next_power_of_two();
            64 * n + 4 * (a + b)
        };
        assert!(fresh_peak_bound(104_000, 104_000) < 20 << 20);
        // A replacement table may transiently coexist with the retained
        // cache; caller inputs are outside this fresh-operation bound.
    }

    #[test]
    fn stop_unwinds_and_the_next_product_recovers() {
        const CHILD: &str = "SAGEBRUSH_NTT32_STOP_CHILD";
        if std::env::var_os(CHILD).is_some() {
            sagebrush_interrupt::clear();
            sagebrush_interrupt::hooks::reset();
            sagebrush_interrupt::hooks::arm_after(3);
            let a = vec![u32::MAX; 20_000];
            assert_eq!(
                sagebrush_interrupt::catch(|| mul_words(&a, &a)),
                Err(sagebrush_interrupt::Interrupted)
            );
            assert_eq!(sagebrush_interrupt::hooks::stopped_in(), "bigint.ntt32");
            sagebrush_interrupt::clear();
            sagebrush_interrupt::hooks::reset();
            let got = mul_words(&a[..5000], &a[..5000]);
            assert_eq!(ubig(&got), ubig(&a[..5000]).pow(2));
            return;
        }
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ntt32::tests::stop_unwinds_and_the_next_product_recovers",
            ])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
    }
}

#[cfg(test)]
mod local_tests {
    //! wasm32's op-local 32-bit product (also built natively for these
    //! tests): equal to the 64-bit path, its counted 32-bit operations within
    //! twice mul_words_local_work's terms category by category, and a Stop at
    //! the first, a middle and the last poll of each phase.
    use super::*;
    use crate::ntt::{conv_work, mul_words_local64, mul_words_local_work, table_work};
    use std::process::Command;

    fn rng(s: &mut u64) -> u64 {
        *s ^= *s << 13;
        *s ^= *s >> 7;
        *s ^= *s << 17;
        *s
    }

    fn words(n: usize, s: &mut u64, ones: bool) -> Vec<u64> {
        (0..n).map(|_| if ones { u64::MAX } else { rng(s) }).collect()
    }

    /// Every power-of-two transform size up to poly_mul's corner (N = 2^19):
    /// at N's boundary m - 1 = N (the digit product wraps), just inside it,
    /// unbalanced shapes, random and all-ones words (every digit 2^32 - 1, the
    /// largest coefficients and carries).
    #[test]
    fn equals_the_64_bit_path_at_every_size() {
        let mut s = 0x77u64;
        for k in 0..=19u32 {
            let n = 1usize << k;
            let mut shapes = vec![(n / 2 + 1, n - n / 2), (n.max(2) / 2, n.max(2) / 2), (n, 1), (1, n)];
            if n > 4 {
                shapes.push((n - 3, 4));
            }
            for (la, lb) in shapes {
                for ones in [false, true] {
                    if ones && k > 16 && la != n / 2 + 1 {
                        continue;
                    }
                    let (a, b) = (words(la, &mut s, ones), words(lb, &mut s, ones));
                    assert_eq!(mul_words_local(&a, &b), mul_words_local64(&a, &b), "{} x {} (ones {})", la, lb, ones);
                }
            }
        }
        for (la, lb) in [(1usize, 1usize), (2, 1), (3, 5), (1000, 999), (4096, 4097)] {
            let (a, b) = (words(la, &mut s, false), words(lb, &mut s, false));
            assert_eq!(mul_words_local(&a, &b), mul_words_local64(&a, &b), "{} x {}", la, lb);
        }
    }

    /// The transform's edges past poly_mul's caps, up to the 32-bit path's
    /// longest transform (2^23 points): at each N's boundary m = N + 1, the
    /// wrapped case, equal to the 64-bit path.
    #[test]
    fn equals_the_64_bit_path_at_the_transform_edges() {
        let mut s = 0x2323u64;
        for k in [20u32, 21, 22] {
            let n = 1usize << k;
            let (a, b) = (words(n / 2 + 1, &mut s, false), words(n - n / 2, &mut s, true));
            assert_eq!(mul_words_local(&a, &b), mul_words_local64(&a, &b), "N = 2^{}", k);
        }
    }

    /// The counted 32-bit operations, by category, halved and rounded up,
    /// within mul_words_local_work's terms, at the corners: N's boundary (m =
    /// N + 1, the wrapped case), inside it, and the largest admitted corner.
    /// And each term is needed: a form without the table terms, the extra
    /// butterfly stage, the split and repack, or Garner would fail.
    #[test]
    fn counted_work_fits_the_form_term_by_term() {
        let mut s = 0x5u64;
        for (la, lb) in [(1usize, 1usize), (3, 2), (513, 512), (1000, 24), (1 << 12, 1 << 12), ((1 << 18) + 1, 1 << 18)] {
            let (a, b) = (words(la, &mut s, false), words(lb, &mut s, false));
            ntt_core::WORK.with(|w| w.set(0));
            ntt_core::BUTTERFLIES.with(|w| w.set(0));
            LOCAL_TALLY.with(|t| t.set([0; 5]));
            let z = mul_words_local(&a, &b);
            let fly = ntt_core::BUTTERFLIES.with(|w| w.get()).div_ceil(2);
            assert_eq!(z.len(), la + lb);
            let t = LOCAL_TALLY.with(|t| t.get());
            let half = |c: usize| t[c].div_ceil(2);
            let m = (la + lb) as u64;
            let log = (la + lb - 1).next_power_of_two().trailing_zeros();
            let n = 1u64 << log;
            let terms = [m, 3 * table_work(log).unwrap(), 3 * (conv_work(log).unwrap() + (3 * n).div_ceil(2)), 16 * m, m];
            for c in 0..5 {
                assert!(half(c) <= terms[c], "{} x {}: category {} counted {} (half {}), term {}", la, lb, c, t[c], half(c), terms[c]);
                assert!(t[c] > 0, "{} x {}: category {} counted nothing", la, lb, c);
            }
            assert_eq!(terms.iter().sum::<u64>(), mul_words_local_work(la, lb).unwrap());
            // (the butterflies within the form's butterfly term, three primes of
            // three transforms of N stages at log N + 1: exactly it, so a form
            // at log N, without the extra stage, would fail)
            let fly_term = 3 * (3 * (n / 2) * log as u64 + (3 * n).div_ceil(2));
            assert!(fly <= fly_term, "{} x {}: butterflies {} > {}", la, lb, fly, fly_term);
            if log >= 1 {
                assert_eq!(fly, fly_term, "{} x {}: butterflies", la, lb);
                assert!(fly > 3 * 3 * (n / 2) * log as u64, "{} x {}", la, lb);
            }
            assert!(half(CONVS) - fly <= terms[CONVS] - fly_term, "{} x {}: the convolutions' other operations", la, lb);
            // (the split and repack terms are exact and Garner within 16 of its
            // term: a form short of any would fail; from 2^10 points on, the
            // tables' half is above table_work at N / 2)
            assert_eq!((half(SPLIT), half(REPACK)), (m, m), "{} x {}", la, lb);
            assert!(half(GARNER) + 16 > 16 * m, "{} x {}: Garner {}", la, lb, half(GARNER));
            if log >= 10 {
                assert!(half(TABLES) > 3 * table_work(log - 1).unwrap(), "{} x {}: tables", la, lb);
            }
        }
    }

    /// (ignored: run under wasm32-wasip1 in release) the 32-bit product's
    /// time against the 64-bit path's at sizes from 130 to 2^18 words: the
    /// measurement behind the u32 operation's half weight.
    #[test]
    #[ignore]
    fn time_against_the_64_bit_path() {
        let mut s = 0x1234u64;
        for (la, lb) in [(130usize, 130usize), (1024, 1024), (8192, 8192), (1 << 16, 1 << 16), (1 << 17, 200), (1 << 18, 1 << 18)] {
            let (a, b) = (words(la, &mut s, false), words(lb, &mut s, false));
            let reps = (1usize << 22) / (la + lb) + 1;
            let time = |f: &dyn Fn() -> Vec<u64>| {
                let t = std::time::Instant::now();
                for _ in 0..reps {
                    std::hint::black_box(f());
                }
                t.elapsed().as_secs_f64() / reps as f64 * 1e3
            };
            let (t64, t32) = (time(&|| mul_words_local64(&a, &b)), time(&|| mul_words_local(&a, &b)));
            eprintln!("{:>7} x {:<7} 64-bit {:9.3} ms  32-bit {:9.3} ms  ratio {:.2}", la, lb, t64, t32, t32 / t64);
        }
    }

    /// A Stop at the first, a middle and the last poll of each phase (the
    /// split, the tables, Garner, the repacking) stops the product (an unwind,
    /// where a panic unwinds), and the next product is the same.  In its own
    /// process: the interrupt hooks are global.
    #[cfg(panic = "unwind")]
    #[test]
    fn stops_at_every_phase() {
        const CHILD: &str = "SAGEBRUSH_NTT32_LOCAL_STOP_CHILD";
        if std::env::var_os(CHILD).is_some() {
            use sagebrush_interrupt::hooks;
            let mut s = 3u64;
            let (a, b) = (words(1 << 15, &mut s, false), words(1 << 15, &mut s, true));
            let want = mul_words_local64(&a, &b);
            sagebrush_interrupt::clear();
            hooks::reset();
            hooks::trace();
            assert_eq!(mul_words_local(&a, &b), want);
            let phases = ["ntt32.split", "ntt", "ntt32.garner", "ntt32.repack"].map(|p| (p, hooks::traced(p)));
            hooks::reset();
            for (phase, polls) in &phases {
                assert!(polls.len() >= 3, "{}: {} polls", phase, polls.len());
                for at in [polls[0], polls[polls.len() / 2], polls[polls.len() - 1]] {
                    hooks::reset();
                    hooks::arm_at(at);
                    let r = sagebrush_interrupt::catch(|| mul_words_local(&a, &b));
                    let stopped = hooks::stopped_in();
                    hooks::reset();
                    sagebrush_interrupt::clear();
                    assert!(r.is_err(), "{}: no Stop at poll {}", phase, at);
                    assert_eq!(stopped, *phase, "poll {}", at);
                }
            }
            assert_eq!(mul_words_local(&a, &b), want, "the product after the Stops");
            return;
        }
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ntt32::local_tests::stops_at_every_phase"])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
