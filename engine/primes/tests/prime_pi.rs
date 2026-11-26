// pi(x) against the known values pi(10^k) (OEIS A006880) and against a direct count of the primes, at
// x on both sides of where the combinatorial method takes over from the direct count, and at random x.
use sagebrush_primes::{count_in, prime_pi, primes_in};

/// pi(10^k) for k = 0..=16 (OEIS A006880).
const PI_POWERS_OF_TEN: [u64; 17] = [
    0, 4, 25, 168, 1229, 9592, 78498, 664579, 5761455, 50847534, 455052511, 4118054813, 37607912018,
    346065536839, 3204941750802, 29844570422669, 279238341033925,
];

#[test]
fn powers_of_ten_up_to_10_to_the_13() {
    // 10^13 takes seconds in a release build; a debug build (the workspace tests in CI) stops at 10^11
    let last = if cfg!(debug_assertions) { 11 } else { 13 };
    let mut x = 1u64;
    for (k, &want) in PI_POWERS_OF_TEN.iter().enumerate().take(last + 1) {
        assert_eq!(prime_pi(x), want, "pi(10^{k})");
        x *= 10;
    }
}

#[test]
#[ignore = "seconds in a release build; run with --ignored"]
fn powers_of_ten_10_to_the_14_to_16() {
    for k in 14..=16u32 {
        assert_eq!(prime_pi(10u64.pow(k)), PI_POWERS_OF_TEN[k as usize], "pi(10^{k})");
    }
}

#[test]
fn around_the_switch_and_at_primes() {
    // the direct count below 2^20, the method from there
    let all = primes_in(0, 3_000_000);
    for x in [(1u64 << 20) - 1, 1 << 20, (1 << 20) + 1, 1_048_573, 1_048_583, 2_999_999, 2_999_957, 2_999_958] {
        let want = all.partition_point(|&p| p <= x) as u64;
        assert_eq!(prime_pi(x), want, "x = {x}");
    }
}

#[test]
fn random_x_against_a_segmented_count() {
    // a small linear congruential generator: the same x every run
    let mut s = 0x2545_f491_4f6c_dd1du64;
    for _ in 0..40 {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let x = (s >> 20) % if cfg!(debug_assertions) { 20_000_000 } else { 200_000_000 } + 1;
        assert_eq!(prime_pi(x), count_in(0, x + 1), "x = {x}");
    }
}

#[test]
fn tiny_x() {
    let all = primes_in(0, 2000);
    for x in 0..2000u64 {
        assert_eq!(prime_pi(x), all.partition_point(|&p| p <= x) as u64, "x = {x}");
    }
}
