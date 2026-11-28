//! scikit-learn's 32-bit XorShift, `our_rand_r`, and `rand_int` (sklearn 1.9.1: utils/_random.pxd `our_rand_r`,
//! tree/_utils.pyx `rand_int`), line by line.  The tree splitter draws its features with it, seeded once per fit by
//! Python's `random_state.randint(0, RAND_R_MAX)`; nothing here is a float, so its bits are the same everywhere.
//!
//! Ported from scikit-learn (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers; NOTICE.md).

/// `RAND_R_MAX`: the largest value `our_rand_r` returns (2^31 - 1).
pub const RAND_R_MAX: u32 = 2_147_483_647;
/// The seed a zero state is replaced by (`DEFAULT_SEED`).
pub const DEFAULT_SEED: u32 = 1;

/// `our_rand_r(seed)`: advance the state by one XorShift step (13, 17, 5) and return it modulo 2^31.  A zero state
/// is first replaced by [`DEFAULT_SEED`], as scikit-learn does.
#[inline]
pub fn our_rand_r(seed: &mut u32) -> u32 {
    if *seed == 0 {
        *seed = DEFAULT_SEED;
    }
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    // (`% ((uint32_t)RAND_R_MAX + 1)`: RAND_R_MAX is cast to uint32 before 1 is added)
    *seed % (RAND_R_MAX + 1)
}

/// `rand_int(low, high, state)`: an integer in `[low, high)`, as `low + our_rand_r(state) % (high - low)` with the
/// draw widened to intp first (C's usual conversions).  `high > low`: the splitter never asks for an empty range.
#[inline]
pub fn rand_int(low: i64, high: i64, state: &mut u32) -> i64 {
    debug_assert!(high > low);
    low + i64::from(our_rand_r(state)) % (high - low)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_state_is_the_default_seed_and_draws_stay_below_2_31() {
        let (mut a, mut b) = (0u32, DEFAULT_SEED);
        assert_eq!(our_rand_r(&mut a), our_rand_r(&mut b));
        assert_eq!(a, b);
        let mut s = u32::MAX;
        for _ in 0..10_000 {
            assert!(our_rand_r(&mut s) <= RAND_R_MAX);
        }
    }

    #[test]
    fn rand_int_is_low_plus_the_draw_modulo_the_width() {
        let (mut s, mut t) = (12345u32, 12345u32);
        for (lo, hi) in [(0, 1), (0, 7), (3, 11), (5, 6), (0, 1 << 40)] {
            let r = rand_int(lo, hi, &mut s);
            assert_eq!(r, lo + i64::from(our_rand_r(&mut t)) % (hi - lo));
            assert!(lo <= r && r < hi);
        }
    }
}
