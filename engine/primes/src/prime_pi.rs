//! pi(x), the number of primes p <= x, by the combinatorial method of Meissel, Lehmer, Lagarias, Miller and
//! Odlyzko:
//!
//! * J. C. Lagarias, V. S. Miller and A. M. Odlyzko, "Computing pi(x): the Meissel-Lehmer method",
//!   Math. Comp. 44 (1985), 537-560;
//! * M. Deleglise and J. Rivat, "Computing pi(x): the Meissel, Lehmer, Lagarias, Miller, Odlyzko method",
//!   Math. Comp. 65 (1996), 235-245;
//! * T. Oliveira e Silva, "Computing pi(x): the combinatorial method", Revista do DETUA 4 (2006), 759-768.
//!
//! With y between x^(1/3) and x^(1/2), a = pi(y) and p_1 < p_2 < ... the primes,
//!
//!   pi(x) = phi(x, a) + a - 1 - P2(x, a),
//!
//! where phi(z, b) counts the n <= z with no prime factor among p_1..p_b, and P2(x, a) counts the n <= x
//! with exactly two prime factors, both above p_a:
//!
//!   P2(x, a) = sum over a < k <= pi(sqrt x) of (pi(x / p_k) - (k - 1)).
//!
//! phi(x, a) is the sum of the leaves of the tree of phi(z, b) = phi(z, b - 1) - phi(z / p_b, b - 1),
//! a node (n, b) (n squarefree, standing for mu(n) phi(x / n, b)) being split only while n <= y:
//!
//! * the ordinary leaves, n <= y: their sum is S1 = sum over n <= y of mu(n) floor(x / n);
//! * the special leaves, n = m p_b with m <= y < m p_b and every prime factor of m above p_b:
//!   their sum is S2 = - sum over such (m, b) of mu(m) phi(x / (m p_b), b - 1).
//!
//! Each special leaf's argument x / (m p_b) is below x / y.  The leaves are evaluated in one pass of a
//! segmented sieve over [1, x / y): in each segment, for b = 1, 2, ..., a in turn, the numbers not yet crossed
//! off are those with no prime factor among p_1..p_(b-1), so phi(z, b - 1) for z in the segment is the count
//! before the segment plus a prefix count in it, which a binary indexed tree (Fenwick) over the segment's 64-bit
//! words answers in O(log) time; then the multiples of p_b are crossed off.  P2 needs pi(v) for v in
//! [sqrt x, x / y], from a segmented count of the primes up to x / y.
//!
//! Work O(x^(2/3)) up to logarithms, memory O(x^(1/3)) up to logarithms (the primes up to sqrt x aside),
//! for y = alpha x^(1/3) with a small alpha growing with x.

use crate::sieve::{isqrt, small_primes, SEGMENT};

/// The largest x the function takes: 10^16 (its square root, 10^8, bounds the table of small primes).
pub const PRIME_PI_MAX: u64 = 10_000_000_000_000_000;

/// Below this, pi(x) is counted directly from one sieve.
const DIRECT: u64 = 1 << 20;

/// The integer cube root: the largest r with r^3 <= n.
fn icbrt(n: u64) -> u64 {
    let mut r = (n as f64).cbrt() as u64;
    while r > 0 && (r as u128).pow(3) > n as u128 {
        r -= 1;
    }
    while ((r + 1) as u128).pow(3) <= n as u128 {
        r += 1;
    }
    r
}

/// mu(n) and the least prime factor of n (u32::MAX for n = 1) for n <= y: a linear sieve.
fn mu_and_lpf(y: usize) -> (Vec<i8>, Vec<u32>) {
    let mut mu = vec![0i8; y + 1];
    let mut lpf = vec![0u32; y + 1];
    let mut primes: Vec<u32> = Vec::new();
    if y >= 1 {
        mu[1] = 1;
        lpf[1] = u32::MAX;
    }
    for n in 2..=y {
        if lpf[n] == 0 {
            lpf[n] = n as u32;
            mu[n] = -1;
            primes.push(n as u32);
        }
        for &p in &primes {
            let m = n * p as usize;
            if p > lpf[n] || m > y {
                break;
            }
            lpf[m] = p;
            mu[m] = if p == lpf[n] { 0 } else { -mu[n] };
        }
    }
    (mu, lpf)
}

/// A binary indexed tree over the popcounts of a segment's words.
struct Fenwick(Vec<i32>);

impl Fenwick {
    fn build(counts: impl Iterator<Item = i32>) -> Self {
        let mut t: Vec<i32> = std::iter::once(0).chain(counts).collect();
        for i in 1..t.len() {
            let j = i + i.isolate_lowest_one();
            if j < t.len() {
                t[j] += t[i];
            }
        }
        Fenwick(t)
    }
    /// Add d at word w.
    fn add(&mut self, w: usize, d: i32) {
        let mut i = w + 1;
        while i < self.0.len() {
            self.0[i] += d;
            i += i.isolate_lowest_one();
        }
    }
    /// The sum over the words before w.
    fn before(&self, w: usize) -> i64 {
        let (mut i, mut s) = (w, 0i64);
        while i > 0 {
            s += i64::from(self.0[i]);
            i &= i - 1;
        }
        s
    }
}

/// The number of primes p <= x, for x <= PRIME_PI_MAX.
pub fn prime_pi(x: u64) -> u64 {
    prime_pi_alpha(x, None)
}

/// pi(x) with y = alpha x^(1/3) (None: the default alpha); for tuning and tests.
#[doc(hidden)]
pub fn prime_pi_alpha(x: u64, alpha: Option<f64>) -> u64 {
    assert!(x <= PRIME_PI_MAX, "prime_pi: x must be at most 10^16");
    if x < 2 {
        return 0;
    }
    if x < DIRECT {
        return small_primes(x).len() as u64;
    }
    // y between x^(1/3) and x^(1/2): alpha x^(1/3), alpha = (log10 x)^2 / 24, at least 1 (tuned by timing)
    let x13 = icbrt(x);
    let root = isqrt(x);
    let alpha = alpha.unwrap_or_else(|| ((x as f64).log10().powi(2) / 24.0).max(1.0));
    let y = ((alpha * x13 as f64) as u64).clamp(x13, root);
    let primes = small_primes(root.max(y));
    let a = primes.partition_point(|&p| u64::from(p) <= y) as u64;
    let phi = phi_x_a(x, y, a as usize, &primes);
    let p2 = p2(x, y, a as usize, &primes);
    (phi + a as i128 - 1 - p2) as u64
}

/// phi(x, a) = S1 + S2 (see the module's documentation).
fn phi_x_a(x: u64, y: u64, a: usize, primes: &[u32]) -> i128 {
    let (mu, lpf) = mu_and_lpf(y as usize);
    // the ordinary leaves
    let mut s: i128 = 0;
    for n in 1..=y {
        if mu[n as usize] != 0 {
            s += i128::from(mu[n as usize]) * i128::from(x / n);
        }
    }
    // the special leaves, from a segmented sieve of [1, limit)
    let limit = x / y + 1;
    let seg = SEGMENT.min(limit.div_ceil(64) * 64); // (numbers per segment, a multiple of 64)
    let words = (seg / 64) as usize;
    // before[b]: how many n in [1, low) have no prime factor among p_1..p_(b-1)
    let mut before = vec![0i64; a + 2];
    let mut bits = vec![0u64; words];
    let mut low = 1u64;
    while low < limit {
        let high = (low + seg).min(limit);
        let len = high - low;
        for (w, word) in bits.iter_mut().enumerate() {
            let start = 64 * w as u64;
            *word = if start + 64 <= len { !0 } else if start >= len { 0 } else { (1u64 << (len - start)) - 1 };
        }
        let mut tree = Fenwick::build(bits.iter().map(|w| w.count_ones() as i32));
        for b in 1..=a {
            let pb = u64::from(primes[b - 1]);
            // a special leaf (m, b) has m >= p_(b+1), so x / (m pb) < x / pb^2: once pb^2 > x / low, no
            // leaf of this b or a later one lies in this segment or a later one
            if pb * pb > x / low {
                break;
            }
            // the special leaves (m, b) with x / (m pb) in [low, high): m in (x / (pb high), x / (pb low)]
            // and m in (y / pb, y]
            let m_hi = (x / (pb * low)).min(y);
            let m_lo = (x / (pb * high)).max(y / pb);
            let leaf = |m: u64, tree: &Fenwick| {
                let i = x / (m * pb) - low;
                let w = (i / 64) as usize;
                let mask = if i % 64 == 63 { !0 } else { (1u64 << (i % 64 + 1)) - 1 };
                before[b] + tree.before(w) + i64::from((bits[w] & mask).count_ones())
            };
            if pb * pb > y {
                // m <= y with every prime factor above sqrt y is a prime, and mu(m) = -1
                let first = primes.partition_point(|&p| u64::from(p) <= m_lo.max(pb));
                let end = primes.partition_point(|&p| u64::from(p) <= m_hi);
                for &m in primes.get(first..end).unwrap_or(&[]) {
                    s += i128::from(leaf(u64::from(m), &tree));
                }
            } else {
                let mut m = m_hi;
                while m > m_lo {
                    let mi = m as usize;
                    if mu[mi] != 0 && u64::from(lpf[mi]) > pb {
                        s -= i128::from(mu[mi]) * i128::from(leaf(m, &tree));
                    }
                    m -= 1;
                }
            }
            // this segment's survivors so far count towards phi(., b - 1) of the later segments
            before[b] += tree.before(words);
            // cross off the multiples of pb
            let mut n = low.div_ceil(pb) * pb;
            while n < high {
                let i = n - low;
                let (w, bit) = ((i / 64) as usize, 1u64 << (i % 64));
                if bits[w] & bit != 0 {
                    bits[w] &= !bit;
                    tree.add(w, -1);
                }
                n += pb;
            }
        }
        low = high;
        sagebrush_interrupt::check_coarse();
    }
    s
}

/// P2(x, a) = the sum over a < k <= pi(sqrt x) of (pi(x / p_k) - (k - 1)).
fn p2(x: u64, y: u64, a: usize, primes: &[u32]) -> i128 {
    let root = isqrt(x);
    let b_end = primes.partition_point(|&p| u64::from(p) <= root);
    if b_end <= a {
        return 0;
    }
    // the targets v_k = x / p_k, increasing as k decreases from b_end - 1 down to a
    let limit = x / y + 1; // every target is below x / y + 1
    let base_primes = small_primes(isqrt(limit));
    let mut k = b_end; // the next target is x / p_(k-1), 0-based index k - 1
    let mut sum: i128 = 0;
    let mut count = 0u64; // primes in [1, low)
    let mut low = 1u64;
    let seg = SEGMENT;
    let mut is_prime = vec![0u64; (seg / 64) as usize];
    while k > a && low < limit {
        let high = (low + seg).min(limit);
        // a plain bit set of [low, high): bit i for low + i
        let len = high - low;
        for (w, word) in is_prime.iter_mut().enumerate() {
            let start = 64 * w as u64;
            *word = if start + 64 <= len { !0 } else if start >= len { 0 } else { (1u64 << (len - start)) - 1 };
        }
        for n in low..high.min(2) {
            let i = n - low;
            is_prime[(i / 64) as usize] &= !(1u64 << (i % 64));
        }
        for &p in &base_primes {
            let p = u64::from(p);
            if p * p >= high {
                break;
            }
            let mut n = (p * p).max(low.div_ceil(p) * p);
            while n < high {
                let i = n - low;
                is_prime[(i / 64) as usize] &= !(1u64 << (i % 64));
                n += p;
            }
        }
        // answer every target in [low, high)
        let mut words_counted = 0usize;
        let mut prefix = count;
        while k > a {
            let v = x / u64::from(primes[k - 1]);
            if v >= high {
                break;
            }
            let i = v - low;
            let w = (i / 64) as usize;
            while words_counted < w {
                prefix += u64::from(is_prime[words_counted].count_ones());
                words_counted += 1;
            }
            let mask = if i % 64 == 63 { !0 } else { (1u64 << (i % 64 + 1)) - 1 };
            let pi_v = prefix + u64::from((is_prime[w] & mask).count_ones());
            sum += i128::from(pi_v) - (k as i128 - 1);
            k -= 1;
        }
        count += is_prime.iter().map(|w| u64::from(w.count_ones())).sum::<u64>();
        low = high;
        sagebrush_interrupt::check_coarse();
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_x_by_the_sieve_and_by_the_method_agree() {
        // the combinatorial method on its own, at x where the direct count is cheap
        for x in [1u64 << 20, (1 << 20) + 1, 1_234_567, 2_000_003, 9_999_991, 10_000_000] {
            let x13 = icbrt(x);
            let root = isqrt(x);
            for y in [x13, x13 + 1, 2 * x13, root / 2, root] {
                let y = y.clamp(x13, root);
                let primes = small_primes(root.max(y));
                let a = primes.partition_point(|&p| u64::from(p) <= y);
                let got = phi_x_a(x, y, a, &primes) + a as i128 - 1 - p2(x, y, a, &primes);
                assert_eq!(got as u64, small_primes(x).len() as u64, "x = {x}, y = {y}");
            }
        }
    }

    #[test]
    fn mu_and_lpf_are_right() {
        let (mu, lpf) = mu_and_lpf(1000);
        assert_eq!(&mu[1..13], &[1, -1, -1, 0, -1, 1, -1, 0, 0, 1, -1, 0]);
        assert_eq!(&lpf[2..13], &[2, 3, 2, 5, 2, 7, 2, 3, 2, 11, 2]);
        assert_eq!((mu[30], mu[210], lpf[997], lpf[999]), (-1, 1, 997, 3));
    }

    #[test]
    fn icbrt_is_exact() {
        for n in (0..20_000u64).chain([PRIME_PI_MAX, PRIME_PI_MAX - 1, 999_999_999_999_999_999, u64::MAX]) {
            let r = icbrt(n);
            assert!((r as u128).pow(3) <= n as u128 && ((r + 1) as u128).pow(3) > n as u128, "n = {n}");
        }
    }
}
