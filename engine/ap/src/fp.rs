//! Arithmetic modulo an odd prime p < 2^62 in Montgomery form (R = 2^64):
//! a value a is stored as a R mod p, so a product needs one 64x64 -> 128
//! multiplication and one reduction (REDC), with no division.
//!
//! On wasm32, which has no 64x64 -> 128 multiplication (u128 products are
//! library calls), primes p < 2^31 use R = 2^32 instead: products and
//! reductions then fit in u64.  The results are the same.

#[derive(Clone, Copy)]
pub struct Fp {
    pub p: u64,
    pinv: u64, // -p^{-1} mod 2^64
    r2: u64,   // R^2 mod p
    pub one: u64,
    #[cfg(target_arch = "wasm32")]
    small: bool, // R = 2^32 (p < 2^31)
}

impl Fp {
    pub fn new(p: u64) -> Self {
        debug_assert!(p % 2 == 1 && p < 1 << 62);
        let mut inv = 1u64; // Newton iteration for p^{-1} mod 2^64
        for _ in 0..6 {
            inv = inv.wrapping_mul(2u64.wrapping_sub(p.wrapping_mul(inv)));
        }
        #[cfg(target_arch = "wasm32")]
        if p < 1 << 31 {
            let r = (1u64 << 32) % p;
            return Fp { p, pinv: inv.wrapping_neg() & 0xffff_ffff, r2: r * r % p, one: r, small: true };
        }
        let r = ((1u128 << 64) % p as u128) as u64;
        let r2 = (r as u128 * r as u128 % p as u128) as u64;
        Fp {
            p,
            pinv: inv.wrapping_neg(),
            r2,
            one: r,
            #[cfg(target_arch = "wasm32")]
            small: false,
        }
    }

    /// REDC with R = 2^32, for t < p 2^32 and p < 2^31.
    #[cfg(target_arch = "wasm32")]
    #[inline(always)]
    fn redc32(&self, t: u64) -> u64 {
        let m = (t as u32).wrapping_mul(self.pinv as u32) as u64;
        let u = (t + m * self.p) >> 32;
        let (d, borrow) = u.overflowing_sub(self.p);
        if borrow { u } else { d }
    }

    #[inline(always)]
    fn redc(&self, t: u128) -> u64 {
        let m = (t as u64).wrapping_mul(self.pinv);
        let u = ((t + m as u128 * self.p as u128) >> 64) as u64;
        let (d, borrow) = u.overflowing_sub(self.p);
        if borrow { u } else { d }
    }

    #[inline(always)]
    pub fn mul(&self, a: u64, b: u64) -> u64 {
        #[cfg(target_arch = "wasm32")]
        if self.small {
            return self.redc32(a * b);
        }
        self.redc(a as u128 * b as u128)
    }

    #[inline(always)]
    pub fn sqr(&self, a: u64) -> u64 {
        self.mul(a, a)
    }

    // add, sub and neg are branchless: their outcomes are unpredictable,
    // and a mispredicted branch costs more than the arithmetic.
    #[inline(always)]
    pub fn add(&self, a: u64, b: u64) -> u64 {
        self.sub(a, self.p - b)
    }

    #[inline(always)]
    pub fn sub(&self, a: u64, b: u64) -> u64 {
        let (d, borrow) = a.overflowing_sub(b);
        d.wrapping_add(self.p & (borrow as u64).wrapping_neg())
    }

    #[inline(always)]
    pub fn neg(&self, a: u64) -> u64 {
        self.sub(0, a)
    }

    /// The Montgomery form of an integer.
    pub fn from_i128(&self, x: i128) -> u64 {
        self.mul(x.rem_euclid(self.p as i128) as u64, self.r2)
    }

    /// The integer in [0, p) represented by a.
    pub fn to_u64(&self, a: u64) -> u64 {
        #[cfg(target_arch = "wasm32")]
        if self.small {
            return self.redc32(a);
        }
        self.redc(a as u128)
    }

    pub fn pow(&self, mut b: u64, mut e: u64) -> u64 {
        let mut r = self.one;
        while e > 0 {
            if e & 1 == 1 {
                r = self.mul(r, b);
            }
            b = self.sqr(b);
            e >>= 1;
        }
        r
    }

    pub fn inv(&self, a: u64) -> u64 {
        self.pow(a, self.p - 2)
    }

    /// Replaces each nonzero element by its inverse with one inversion
    /// (Montgomery's trick); zeros are left alone.  The prefix products run
    /// as four interleaved chains so the multiplications overlap instead of
    /// waiting on each other.
    pub fn batch_inv(&self, xs: &mut [u64], scratch: &mut Vec<u64>) {
        const W: usize = 4;
        scratch.clear();
        scratch.resize(xs.len(), 0);
        let mut acc = [self.one; W];
        for (i, &x) in xs.iter().enumerate() {
            let c = i % W;
            scratch[i] = acc[c];
            if x != 0 {
                acc[c] = self.mul(acc[c], x);
            }
        }
        // Inverses of the four chain products from one inversion.
        let a01 = self.mul(acc[0], acc[1]);
        let a23 = self.mul(acc[2], acc[3]);
        let inv = self.inv(self.mul(a01, a23));
        let (i01, i23) = (self.mul(inv, a23), self.mul(inv, a01));
        let mut inv = [self.mul(i01, acc[1]), self.mul(i01, acc[0]), self.mul(i23, acc[3]), self.mul(i23, acc[2])];
        for i in (0..xs.len()).rev() {
            let x = xs[i];
            if x != 0 {
                let c = i % W;
                xs[i] = self.mul(inv[c], scratch[i]);
                inv[c] = self.mul(inv[c], x);
            }
        }
    }
}

/// The Jacobi symbol (a / n) for odd n.
pub fn jacobi(mut a: u64, mut n: u64) -> i32 {
    a %= n;
    let mut t = 1;
    while a != 0 {
        let z = a.trailing_zeros();
        a >>= z;
        if z & 1 == 1 && (n % 8 == 3 || n % 8 == 5) {
            t = -t;
        }
        if a % 4 == 3 && n % 4 == 3 {
            t = -t;
        }
        std::mem::swap(&mut a, &mut n);
        a %= n;
    }
    if n == 1 { t } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn montgomery_matches_plain_arithmetic() {
        for &p in &[3u64, 5, 1009, 65537, 2147483647, (1 << 61) - 1] {
            let f = Fp::new(p);
            let mut x = 12345u64;
            for _ in 0..200 {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let (a, b) = (x % p, (x >> 7) % p);
                let (am, bm) = (f.from_i128(a as i128), f.from_i128(b as i128));
                assert_eq!(f.to_u64(f.mul(am, bm)) as u128, a as u128 * b as u128 % p as u128);
                assert_eq!(f.to_u64(f.add(am, bm)), ((a as u128 + b as u128) % p as u128) as u64);
                assert_eq!(f.to_u64(f.sub(am, bm)), ((a as i128 - b as i128).rem_euclid(p as i128)) as u64);
                if a != 0 {
                    assert_eq!(f.mul(f.inv(am), am), f.one);
                }
            }
        }
    }

    #[test]
    fn jacobi_matches_euler_criterion() {
        for &p in &[3u64, 7, 11, 101, 65537] {
            let f = Fp::new(p);
            for a in 0..300u64 {
                let e = f.to_u64(f.pow(f.from_i128(a as i128), (p - 1) / 2));
                let expect = if a % p == 0 { 0 } else if e == 1 { 1 } else { -1 };
                assert_eq!(jacobi(a, p), expect, "a={} p={}", a, p);
            }
        }
    }
}
