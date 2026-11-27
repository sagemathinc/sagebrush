//! Stop inside a table's build on the shared cache path (ntt_core's
//! table_cached): at every poll of the build, the cache keeps its tables
//! and bytes, its lock is not poisoned, and the next product on the same
//! cache is right.  Its own test binary: Stop is process-wide.

use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::ntt::{cache_clear, cache_poisoned, cache_stats, conv_prime, LocalTables, PRIMES};
use sagebrush_interrupt::{catch, clear, hooks};

fn inputs(len: usize, p: u64) -> (Vec<u64>, Vec<u64>) {
    let mut s = 0x9e3779b97f4a7c15u64;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s % p
    };
    ((0..len).map(|_| next()).collect(), (0..len).map(|_| next()).collect())
}

/// The i-th coefficient of a b mod p, directly.
fn coefficient(a: &[u64], b: &[u64], i: usize, p: u64) -> u64 {
    let mut s = 0u128;
    for j in i.saturating_sub(b.len() - 1)..=i.min(a.len() - 1) {
        s = (s + a[j] as u128 * b[i - j] as u128) % p as u128;
    }
    s as u64
}

#[test]
fn shared_cache_stop_at_every_poll() {
    let (p, g) = PRIMES[0];
    // products of length 2^18 - 1: a table of 2^18 points, the series ops' cap
    let len = 1 << 17;
    let (a, b) = inputs(len, p);
    cache_clear();
    let want = conv_prime(&a, &b, 0);
    for i in [0, 1, 1000, len - 1, len, 2 * len - 2] {
        assert_eq!(want[i], coefficient(&a, &b, i, p), "coefficient {}", i);
    }
    // the polls of the table's build alone, at the same size (op-local, so
    // the shared cache is not involved)
    hooks::reset();
    drop(LocalTables::with_root(&Modulus::new(p), g, 2 * len - 1));
    let build_polls = hooks::total();
    hooks::reset();
    assert!(build_polls >= 100, "a table of 2^18 points polled only {} times", build_polls);
    // a Stop at each of them: in conv_prime the table is built first, so
    // these all land inside Table::new
    for k in 1..=build_polls {
        cache_clear();
        let before = cache_stats();
        hooks::reset();
        hooks::arm_after(k);
        let r = catch(|| conv_prime(&a, &b, 0));
        clear();
        hooks::reset();
        assert!(r.is_err(), "poll {} of the build: the product finished", k);
        assert!(!cache_poisoned(), "poll {}: the shared cache's lock is poisoned", k);
        let after = cache_stats();
        assert_eq!((after.1, after.2), (before.1, before.2), "poll {}: the cache changed", k);
        assert_eq!(conv_prime(&a, &b, 0), want, "poll {}: the next product", k);
    }
}
