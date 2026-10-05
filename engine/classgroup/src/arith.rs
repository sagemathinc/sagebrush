//! Word-sized number theory: the hot paths use u64/i128 only.

pub fn gcd_u(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

pub fn gcd_i(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// (g, x, y) with a x + b y = g = gcd(a, b) >= 0.
pub fn xgcd(a: i128, b: i128) -> (i128, i128, i128) {
    let (mut r0, mut r1, mut s0, mut s1, mut t0, mut t1) = (a, b, 1i128, 0i128, 0i128, 1i128);
    while r1 != 0 {
        let q = r0.div_euclid(r1);
        (r0, r1) = (r1, r0 - q * r1);
        (s0, s1) = (s1, s0 - q * s1);
        (t0, t1) = (t1, t0 - q * t1);
    }
    if r0 < 0 {
        (-r0, -s0, -t0)
    } else {
        (r0, s0, t0)
    }
}

#[inline]
pub fn mulmod(a: u64, b: u64, p: u64) -> u64 {
    if p <= u32::MAX as u64 && a < p && b < p {
        a * b % p // the common case, without the slow 128-bit division
    } else {
        ((a as u128 * b as u128) % p as u128) as u64
    }
}

pub fn powmod(mut b: u64, mut e: u64, p: u64) -> u64 {
    let mut r = 1 % p;
    b %= p;
    while e > 0 {
        if e & 1 == 1 {
            r = mulmod(r, b, p);
        }
        b = mulmod(b, b, p);
        e >>= 1;
    }
    r
}

pub fn invmod(a: u64, p: u64) -> u64 {
    // extended Euclid on (a mod p, p), tracking the coefficient of a only
    let (mut r0, mut r1) = (p, a % p);
    let (mut s0, mut s1) = (0i64, 1i64);
    if p < 1 << 62 {
        while r1 != 0 {
            let q = r0 / r1;
            (r0, r1) = (r1, r0 - q * r1);
            (s0, s1) = (s1, s0 - q as i64 * s1);
        }
        debug_assert_eq!(r0, 1);
        return s0.rem_euclid(p as i64) as u64;
    }
    let (g, x, _) = xgcd(a as i128, p as i128);
    debug_assert_eq!(g, 1);
    x.rem_euclid(p as i128) as u64
}

/// a mod p for a signed 128-bit a.
#[inline]
pub fn reduce(a: i128, p: u64) -> u64 {
    if let Ok(x) = u64::try_from(a) {
        x % p
    } else {
        a.rem_euclid(p as i128) as u64
    }
}

/// The Kronecker symbol (D / p) for a prime p.
pub fn kronecker(d: i128, p: u64) -> i32 {
    if p == 2 {
        return match d.rem_euclid(8) {
            1 | 7 => 1,
            3 | 5 => -1,
            _ => 0,
        };
    }
    jacobi(reduce(d, p), p)
}

/// The Jacobi symbol (a / n) for odd n, by the binary algorithm.
pub fn jacobi(a: u64, n: u64) -> i32 {
    debug_assert!(n % 2 == 1);
    let (mut a, mut n) = (a % n, n);
    let mut t = 1;
    while a != 0 {
        let z = a.trailing_zeros();
        a >>= z;
        if z % 2 == 1 && (n % 8 == 3 || n % 8 == 5) {
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

/// A square root of a (a square) modulo an odd prime p (Tonelli-Shanks).
pub fn sqrt_mod(a: u64, p: u64) -> u64 {
    let a = a % p;
    if a == 0 {
        return 0;
    }
    if p % 4 == 3 {
        return powmod(a, (p + 1) / 4, p);
    }
    let (mut q, mut s) = (p - 1, 0);
    while q % 2 == 0 {
        q /= 2;
        s += 1;
    }
    let mut z = 2;
    while powmod(z, (p - 1) / 2, p) != p - 1 {
        z += 1;
    }
    let (mut m, mut c, mut t, mut r) = (s, powmod(z, q, p), powmod(a, q, p), powmod(a, (q + 1) / 2, p));
    while t != 1 {
        let mut i = 0;
        let mut tt = t;
        while tt != 1 {
            tt = mulmod(tt, tt, p);
            i += 1;
        }
        let b = powmod(c, 1 << (m - i - 1), p);
        m = i;
        c = mulmod(b, b, p);
        t = mulmod(t, c, p);
        r = mulmod(r, b, p);
    }
    r
}

pub fn primes_up_to(n: u64) -> Vec<u64> {
    let n = n as usize;
    let mut s = vec![true; n + 1];
    let mut out = vec![];
    for i in 2..=n {
        if s[i] {
            out.push(i as u64);
            let mut j = i * i;
            while j <= n {
                s[j] = false;
                j += i;
            }
        }
    }
    out
}

pub fn isqrt_u128(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = (n as f64).sqrt() as u128;
    while x * x > n {
        x -= 1;
    }
    while (x + 1) * (x + 1) <= n {
        x += 1;
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_and_symbols() {
        for &p in &primes_up_to(2000)[1..] {
            for a in 1..60u64 {
                if kronecker(a as i128, p) == 1 {
                    let r = sqrt_mod(a, p);
                    assert_eq!(mulmod(r, r, p), a % p, "sqrt {} mod {}", a, p);
                }
            }
        }
        for &p in &primes_up_to(3000)[1..] {
            for a in [0i128, 1, 2, -3, -4, 7, -1000000007, -(10i128.pow(30) + 57)] {
                let e = powmod(reduce(a, p), (p - 1) / 2, p);
                let euler = if e == 0 { 0 } else if e == 1 { 1 } else { -1 };
                assert_eq!(kronecker(a, p), euler, "({} / {})", a, p);
            }
        }
        for p in [3u64, 101, 65521, (1 << 61) - 1, 4611686018427387847] {
            for a in [1u64, 2, 12346, p - 1, p / 3 + 7].into_iter().filter(|a| a % p != 0) {
                assert_eq!(mulmod(a % p, invmod(a, p), p), 1, "1/{} mod {}", a, p);
            }
        }
        assert_eq!(kronecker(-23, 2), 1); // -23 = 1 mod 8: 2 splits
        assert_eq!(kronecker(-19, 2), -1);
        assert_eq!(kronecker(-23, 3), 1);
        for (a, b) in [(240i128, 46i128), (-17, 5), (12, -18), (0, 7)] {
            let (g, x, y) = xgcd(a, b);
            assert!(g >= 0 && a * x + b * y == g && gcd_i(a, b) == g);
        }
    }
}
