//! Arithmetic modulo a word-size integer n (2 <= n < 2^64).
//!
//! [`Modulus`] reduces double-word values with a precomputed reciprocal
//! (Möller and Granlund, "Improved division by invariant integers", IEEE
//! Trans. Computers 60 (2011), Algorithm 4), so no hardware division
//! is needed.  [`shoup`] and [`mul_shoup`] multiply by a fixed value
//! with one high product (Shoup's trick, as in NTL), for moduli below
//! 2^63.

/// A modulus n with its normalized reciprocal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Modulus {
    pub n: u64,
    norm: u32,
    d: u64,
    v: u64,
}

impl Modulus {
    pub fn new(n: u64) -> Modulus {
        assert!(n >= 2, "modulus must be at least 2");
        let norm = n.leading_zeros();
        let d = n << norm;
        let v = (u128::MAX / d as u128 - (1u128 << 64)) as u64;
        Modulus { n, norm, d, v }
    }

    /// (hi * 2^64 + lo) mod n, for hi < n.
    #[inline(always)]
    pub fn reduce_wide(&self, hi: u64, lo: u64) -> u64 {
        debug_assert!(hi < self.n);
        let (u1, u0) = if self.norm == 0 {
            (hi, lo)
        } else {
            ((hi << self.norm) | (lo >> (64 - self.norm)), lo << self.norm)
        };
        let q = (self.v as u128 * u1 as u128).wrapping_add(((u1 as u128) << 64) | u0 as u128);
        let q1 = ((q >> 64) as u64).wrapping_add(1);
        let q0 = q as u64;
        let mut r = u0.wrapping_sub(q1.wrapping_mul(self.d));
        if r > q0 {
            r = r.wrapping_add(self.d);
        }
        if r >= self.d {
            r -= self.d;
        }
        r >> self.norm
    }

    /// Shoup's quotient floor(w 2^64 / n) for w < n, by the same 2-by-1
    /// division (no hardware division).
    #[inline(always)]
    pub fn shoup(&self, w: u64) -> u64 {
        debug_assert!(w < self.n);
        let (u1, u0) = if self.norm == 0 { (w, 0) } else { (w << self.norm, 0u64) };
        let q = (self.v as u128 * u1 as u128).wrapping_add(((u1 as u128) << 64) | u0 as u128);
        let mut q1 = ((q >> 64) as u64).wrapping_add(1);
        let q0 = q as u64;
        let mut r = u0.wrapping_sub(q1.wrapping_mul(self.d));
        if r > q0 {
            q1 = q1.wrapping_sub(1);
            r = r.wrapping_add(self.d);
        }
        if r >= self.d {
            q1 += 1;
        }
        q1
    }

    /// x mod n for any u64.
    #[inline(always)]
    pub fn reduce(&self, x: u64) -> u64 {
        if x < self.n {
            x
        } else {
            self.reduce_wide(0, x)
        }
    }

    /// x mod n for any u128.
    #[inline(always)]
    pub fn reduce_u128(&self, x: u128) -> u64 {
        let hi = (x >> 64) as u64;
        let hi = if hi < self.n { hi } else { self.reduce_wide(0, hi) };
        self.reduce_wide(hi, x as u64)
    }

    /// a * b mod n, for a, b < n.
    #[inline(always)]
    pub fn mul(&self, a: u64, b: u64) -> u64 {
        let x = a as u128 * b as u128;
        self.reduce_wide((x >> 64) as u64, x as u64)
    }

    #[inline(always)]
    pub fn add(&self, a: u64, b: u64) -> u64 {
        // branch-free (the comparisons are unpredictable on random data)
        let (s, c) = a.overflowing_add(b);
        let (t, borrow) = s.overflowing_sub(self.n);
        if c || !borrow {
            t
        } else {
            s
        }
    }

    #[inline(always)]
    pub fn sub(&self, a: u64, b: u64) -> u64 {
        let (d, borrow) = a.overflowing_sub(b);
        d.wrapping_add(self.n & (borrow as u64).wrapping_neg())
    }

    #[inline(always)]
    pub fn neg(&self, a: u64) -> u64 {
        if a == 0 {
            0
        } else {
            self.n - a
        }
    }

    pub fn pow(&self, mut b: u64, mut e: u64) -> u64 {
        let mut r = 1 % self.n;
        b = self.reduce(b);
        while e > 0 {
            if e & 1 == 1 {
                r = self.mul(r, b);
            }
            b = self.mul(b, b);
            e >>= 1;
        }
        r
    }

    /// The inverse of a mod n, if gcd(a, n) = 1.
    pub fn inv(&self, a: u64) -> Option<u64> {
        // remainders as u64 (64-bit division), cofactors as i128
        let (mut r0, mut r1) = (self.n, self.reduce(a));
        let (mut s0, mut s1) = (0i128, 1i128);
        while r1 != 0 {
            let q = r0 / r1;
            (r0, r1) = (r1, r0 - q * r1);
            (s0, s1) = (s1, s0 - q as i128 * s1);
        }
        if r0 != 1 {
            return None;
        }
        Some(s0.rem_euclid(self.n as i128) as u64)
    }

    /// A signed integer mod n.
    #[inline]
    pub fn from_i64(&self, x: i64) -> u64 {
        if x >= 0 {
            self.reduce(x as u64)
        } else {
            self.neg(self.reduce(x.unsigned_abs()))
        }
    }

    /// The symmetric representative of a in (-n/2, n/2].
    #[inline]
    pub fn to_signed(&self, a: u64) -> i128 {
        if a > self.n / 2 {
            a as i128 - self.n as i128
        } else {
            a as i128
        }
    }
}

/// Shoup's precomputed quotient for multiplying by w modulo n < 2^63.
#[inline]
pub fn shoup(w: u64, n: u64) -> u64 {
    (((w as u128) << 64) / n as u128) as u64
}

/// a * w mod n given wp = shoup(w, n), for any a < 2^64; the result is in
/// [0, 2n) (n < 2^63).
#[inline(always)]
pub fn mul_shoup_lazy(a: u64, w: u64, wp: u64, n: u64) -> u64 {
    let q = ((a as u128 * wp as u128) >> 64) as u64;
    a.wrapping_mul(w).wrapping_sub(q.wrapping_mul(n))
}

/// a * w mod n given wp = shoup(w, n), reduced.
#[inline(always)]
pub fn mul_shoup(a: u64, w: u64, wp: u64, n: u64) -> u64 {
    let r = mul_shoup_lazy(a, w, wp, n);
    let (t, borrow) = r.overflowing_sub(n);
    if borrow {
        r
    } else {
        t
    }
}

/// Deterministic primality for 64-bit integers (Miller-Rabin with the
/// seven bases of Jim Sinclair, correct for all n < 2^64).
pub fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    for p in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        if n % p == 0 {
            return n == p;
        }
    }
    let m = Modulus::new(n);
    let s = (n - 1).trailing_zeros();
    let d = (n - 1) >> s;
    'bases: for a in [2u64, 325, 9375, 28178, 450775, 9780504, 1795265022] {
        let a = a % n;
        if a == 0 {
            continue;
        }
        let mut x = m.pow(a, d);
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 1..s {
            x = m.mul(x, x);
            if x == n - 1 {
                continue 'bases;
            }
        }
        return false;
    }
    true
}

/// The largest prime below n (n > 2).
pub fn prev_prime(n: u64) -> u64 {
    let mut p = n - 1;
    while !is_prime(p) {
        p -= 1;
    }
    p
}

/// Primes just below 2^62, descending: the moduli of the multimodular
/// algorithms (62 bits each, and 4p < 2^64 for lazy reductions).  The
/// primes below 2^62 and 2^31 are cached as they are found.
pub struct Primes {
    start: u64,
    i: usize,
    next: u64,
}

/// Marks the iterator over primes p = 1 mod 2^32 below 2^62.
const NTT_START: u64 = (1 << 62) | 1;

fn cached(start: u64, i: usize, next: u64) -> u64 {
    use std::sync::Mutex;
    static CACHE: Mutex<[Vec<u64>; 3]> = Mutex::new([Vec::new(), Vec::new(), Vec::new()]);
    let slot = match start {
        x if x == 1 << 62 => 0,
        x if x == 1 << 31 => 1,
        NTT_START => 2,
        _ => return prev_prime(next),
    };
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let v = &mut c[slot];
    while v.len() <= i {
        let from = v.last().copied().unwrap_or(start);
        let p = if slot == 2 {
            let mut p = ((from - 1) >> 32 << 32) + 1;
            loop {
                p -= 1 << 32;
                if is_prime(p) {
                    break p;
                }
            }
        } else {
            prev_prime(from)
        };
        v.push(p);
    }
    v[i]
}

impl Primes {
    pub fn new() -> Primes {
        Primes::below(1 << 62)
    }
    pub fn below(n: u64) -> Primes {
        Primes { start: n, i: 0, next: n }
    }
    /// Primes p = 1 mod 2^32 below 2^62, descending: products of
    /// polynomials modulo these take one number-theoretic transform.
    pub fn ntt() -> Primes {
        Primes { start: NTT_START, i: 0, next: NTT_START }
    }
}

impl Default for Primes {
    fn default() -> Self {
        Primes::new()
    }
}

impl Iterator for Primes {
    type Item = u64;
    fn next(&mut self) -> Option<u64> {
        let p = cached(self.start, self.i, self.next);
        self.i += 1;
        self.next = p;
        Some(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduction_agrees_with_u128() {
        let mut s = 0x9e3779b97f4a7c15u64;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for n in [2u64, 3, 1 << 32, (1 << 62) - 57, (1 << 63) + 29, u64::MAX, 1_000_000_007] {
            let m = Modulus::new(n);
            for _ in 0..2000 {
                let (a, b) = (rnd() % n, rnd() % n);
                assert_eq!(m.mul(a, b) as u128, a as u128 * b as u128 % n as u128);
                let x = (rnd() as u128) << 64 | rnd() as u128;
                assert_eq!(m.reduce_u128(x) as u128, x % n as u128);
                assert_eq!(m.add(a, b) as u128, (a as u128 + b as u128) % n as u128);
                assert_eq!(m.sub(a, b) as u128, (a as u128 + n as u128 - b as u128) % n as u128);
                if n < 1 << 63 {
                    let wp = shoup(b, n);
                    assert_eq!(m.shoup(b), wp);
                    let y = rnd();
                    assert_eq!(mul_shoup(y, b, wp, n) as u128, y as u128 * b as u128 % n as u128);
                }
                if let Some(i) = m.inv(a) {
                    assert_eq!(m.mul(a, i), 1 % n);
                }
            }
        }
    }

    #[test]
    fn primes() {
        let small: Vec<u64> = (0..100).filter(|&n| is_prime(n)).collect();
        assert_eq!(small.len(), 25);
        assert!(is_prime(4601552919265804289) && !is_prime(4601552919265804287));
        assert!(!is_prime(3215031751)); // strong pseudoprime to bases 2, 3, 5, 7
        let ps: Vec<u64> = Primes::new().take(3).collect();
        assert_eq!(ps[0], 4611686018427387847);
        assert!(ps[1] < ps[0] && ps[2] < ps[1]);
        let ns: Vec<u64> = Primes::ntt().take(5).collect();
        assert!(ns.iter().all(|&p| is_prime(p) && p % (1 << 32) == 1 && p < 1 << 62));
        assert!(ns.windows(2).all(|w| w[0] > w[1]));
    }
}
