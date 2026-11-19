//! Two callers missing on the same table of the shared cache: the build is
//! serialized under the cache's lock, so the table is built once (no second
//! copy of a large table is ever being built), and both products are right.
//! Its own test binary: it counts the cache's builds.

use sagebrush_bigint::ntt::{cache_builds, cache_clear, conv_prime, PRIMES};
use std::sync::{Arc, Barrier};

#[test]
fn two_callers_one_build() {
    let p = PRIMES[0].0;
    let len = 1 << 16;
    let a: Vec<u64> = (0..len as u64).map(|i| (i * i + 7) % p).collect();
    let b: Vec<u64> = (0..len as u64).map(|i| (3 * i + 1) % p).collect();
    cache_clear();
    let want = conv_prime(&a, &b, 0);
    for _ in 0..5 {
        cache_clear();
        let before = cache_builds();
        let start = Arc::new(Barrier::new(2));
        let runs: Vec<_> = (0..2)
            .map(|_| {
                let (a, b, start) = (a.clone(), b.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    conv_prime(&a, &b, 0)
                })
            })
            .collect();
        for r in runs {
            assert_eq!(r.join().unwrap(), want);
        }
        assert_eq!(cache_builds() - before, 1, "two callers built the same table twice");
    }
}
