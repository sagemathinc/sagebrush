//! The wasm32 parameters and carry pass for the shared NTT.
//!
//! Transform tables, butterflies, cache policy and convolution are the same
//! generic implementation as native builds use in [`crate::ntt_core`].

use crate::ntt_core::{self, NttWord, Table};
use std::sync::{Arc, Mutex};

// All three primes are below 2^30. Thus lazy values below 4p fit in u32.
// Their product is > 2^88, enough for a 2^23-long convolution of base-2^32
// digits. The roots have orders 2^26, 2^23 and 2^24 respectively.
const PRIMES: [(u32, u32, u32); 3] = [
    (469_762_049, 3, 26),
    (998_244_353, 3, 23),
    (754_974_721, 11, 24),
];
const MAX_LOG: u32 = 23;
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
