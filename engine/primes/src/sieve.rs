//! The sieve of Eratosthenes, whole and segmented.
//!
//! * `small_primes(n)`: every prime up to n, from one sieve of the odd numbers up to n;
//! * `primes_in(lo, hi)`: the primes p with lo <= p < hi, from a segmented sieve: the primes up to the square
//!   root of hi, then the window [lo, hi) in segments of `SEGMENT` odd numbers, so the memory is that of the
//!   small primes and one segment, whatever the size of the window;
//! * `count_in(lo, hi)`: how many primes lie in [lo, hi), the same way, without listing them.
//!
//! The method is Eratosthenes's; the segmented form is the one described by Bays and Hudson, "The segmented
//! sieve of Eratosthenes and primes in arithmetic progressions to 10^12", BIT 17 (1977), 121-127.  Each segment
//! is a bit set of the odd numbers in it (bit i stands for the odd number base + 2i).  Long windows are checked
//! for interruption between segments.

/// Odd numbers in one segment of the segmented sieve (2^21 bits: 256 KiB).
pub const SEGMENT: u64 = 1 << 21;

/// The integer square root: the largest r with r * r <= n.
pub fn isqrt(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    let mut r = (n as f64).sqrt() as u64;
    while r.checked_mul(r).is_none_or(|s| s > n) {
        r -= 1;
    }
    while (r + 1).checked_mul(r + 1).is_some_and(|s| s <= n) {
        r += 1;
    }
    r
}

/// Every prime p <= n, in increasing order (n below 2^32, so that each prime fits a u32).
pub fn small_primes(n: u64) -> Vec<u32> {
    assert!(n < 1 << 32, "small_primes: n must be below 2^32");
    if n < 2 {
        return Vec::new();
    }
    // composite[i] stands for the odd number 2i + 1
    let half = (n as usize - 1) / 2 + 1;
    let mut composite = vec![false; half];
    let mut i = 1;
    while (2 * i + 1) * (2 * i + 1) <= n as usize {
        if !composite[i] {
            let p = 2 * i + 1;
            let mut j = p * p / 2;
            while j < half {
                composite[j] = true;
                j += p;
            }
        }
        i += 1;
    }
    let mut out = Vec::with_capacity(if n < 100 { 25 } else { (1.3 * n as f64 / (n as f64).ln()) as usize });
    out.push(2);
    out.extend((1..half).filter(|&i| !composite[i]).map(|i| (2 * i + 1) as u32));
    out
}

/// The odd primes in [base, base + 2 * bits.len() * 64), base odd, as the set bits of `bits` (bit i: base + 2i),
/// given the odd primes up to the square root of the window's end.  1 is never set.
fn sieve_segment(base: u64, count: u64, primes: &[u32], bits: &mut Vec<u64>) {
    debug_assert!(base % 2 == 1);
    let words = count.div_ceil(64) as usize;
    bits.clear();
    bits.resize(words, !0u64);
    if !count.is_multiple_of(64) {
        bits[words - 1] = (1u64 << (count % 64)) - 1;
    }
    if base == 1 {
        bits[0] &= !1; // 1 is not prime
    }
    let end = base + 2 * count; // (exclusive)
    for &p in primes.iter().skip(1) {
        let p = p as u64;
        let pp = p * p;
        if pp >= end {
            break;
        }
        // the first odd multiple of p that is at least max(p^2, base)
        let mut m = if pp >= base { pp } else { base.div_ceil(p) * p };
        if m % 2 == 0 {
            m += p;
        }
        let mut i = (m - base) / 2;
        while i < count {
            bits[(i / 64) as usize] &= !(1u64 << (i % 64));
            i += p;
        }
    }
}

/// Run `f(base, count, bits)` on the segments of the odd numbers in [lo, hi), each sieved.
fn for_segments(lo: u64, hi: u64, mut f: impl FnMut(u64, u64, &[u64])) {
    if hi <= lo || hi <= 3 {
        return;
    }
    let primes = small_primes(isqrt(hi - 1));
    let mut base = (lo.max(3)) | 1; // the first odd number >= max(lo, 3)
    let mut bits = Vec::new();
    while base < hi {
        let count = SEGMENT.min((hi - base).div_ceil(2));
        sieve_segment(base, count, &primes, &mut bits);
        f(base, count, &bits);
        base += 2 * count;
        sagebrush_interrupt::check_coarse();
    }
}

/// The primes p with lo <= p < hi, in increasing order.
pub fn primes_in(lo: u64, hi: u64) -> Vec<u64> {
    let mut out = Vec::new();
    if lo <= 2 && 2 < hi {
        out.push(2);
    }
    for_segments(lo, hi, |base, _, bits| {
        for (w, &word) in bits.iter().enumerate() {
            let mut word = word;
            while word != 0 {
                let i = word.trailing_zeros() as u64;
                out.push(base + 2 * (64 * w as u64 + i));
                word &= word - 1;
            }
        }
    });
    out
}

/// The number of primes p with lo <= p < hi.
pub fn count_in(lo: u64, hi: u64) -> u64 {
    let mut n = u64::from(lo <= 2 && 2 < hi);
    for_segments(lo, hi, |_, _, bits| n += bits.iter().map(|w| u64::from(w.count_ones())).sum::<u64>());
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_prime_slow(n: u64) -> bool {
        n >= 2 && (2..).take_while(|d| d * d <= n).all(|d| !n.is_multiple_of(d))
    }

    #[test]
    fn small_primes_are_the_primes() {
        for n in 0..2000u64 {
            let want: Vec<u32> = (0..=n).filter(|&k| is_prime_slow(k)).map(|k| k as u32).collect();
            assert_eq!(small_primes(n), want, "n = {n}");
        }
    }

    #[test]
    fn windows_agree_with_the_whole_sieve() {
        let all: Vec<u64> = small_primes(100_000).into_iter().map(u64::from).collect();
        for (lo, hi) in [(0, 0), (0, 3), (2, 3), (3, 4), (0, 100_000), (99_000, 100_000), (1, 2), (89, 97), (89, 98)] {
            let want: Vec<u64> = all.iter().copied().filter(|&p| lo <= p && p < hi).collect();
            assert_eq!(primes_in(lo, hi), want, "[{lo}, {hi})");
            assert_eq!(count_in(lo, hi), want.len() as u64, "[{lo}, {hi})");
        }
    }

    #[test]
    fn isqrt_is_exact() {
        for n in (0..10_000u64).chain([u64::MAX, u64::MAX - 1, (1 << 32) * ((1 << 32) - 1), 999_999_999_999_999_999]) {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1).checked_mul(r + 1).is_none_or(|s| s > n), "n = {n}");
        }
    }
}
