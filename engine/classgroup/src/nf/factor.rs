//! Factoring integers: trial division, Miller-Rabin, Pollard-Brent rho.
//! Enough for the discriminants of the number fields we meet (the
//! cofactors that matter have small prime factors or are prime).

use num_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};

/// Miller-Rabin with the first 20 primes as bases (deterministic below
/// 3.3e24, and a probable-prime test beyond).
pub fn is_probable_prime(n: &BigInt) -> bool {
    let n = n.abs();
    if n < BigInt::from(2) {
        return false;
    }
    if let Some(m) = n.to_u64() {
        return crate::relations::is_prime_u64(m);
    }
    let small = [2u32, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];
    for &p in &small {
        if (&n % p).is_zero() {
            return false;
        }
    }
    let nm1: BigInt = &n - 1;
    let s = nm1.trailing_zeros().unwrap();
    let d = &nm1 >> s;
    'outer: for &a in &small {
        let mut x = BigInt::from(a).modpow(&d, &n);
        if x.is_one() || x == nm1 {
            continue;
        }
        for _ in 1..s {
            x = (&x * &x) % &n;
            if x == nm1 {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

/// A nontrivial factor of a composite n (Pollard rho, Brent's variant with
/// batched gcds), or None after many tries.
fn rho(n: &BigInt) -> Option<BigInt> {
    if n.is_even() {
        return Some(BigInt::from(2));
    }
    for c in 1u32..50 {
        let f = |x: &BigInt| (x * x + c) % n;
        let (mut y, m) = (BigInt::from(2), 128usize);
        let (mut g, mut r, mut q) = (BigInt::one(), 1usize, BigInt::one());
        let (mut x, mut ys) = (BigInt::zero(), BigInt::zero());
        while g.is_one() {
            x = y.clone();
            for _ in 0..r {
                y = f(&y);
            }
            let mut k = 0;
            while k < r && g.is_one() {
                ys = y.clone();
                for _ in 0..m.min(r - k) {
                    y = f(&y);
                    q = (q * (&x - &y).abs()) % n;
                }
                g = q.gcd(n);
                k += m;
            }
            r *= 2;
            if r > 1 << 26 {
                break;
            }
        }
        if &g == n {
            loop {
                ys = f(&ys);
                g = (&x - &ys).abs().gcd(n);
                if !g.is_one() {
                    break;
                }
            }
        }
        if !g.is_one() && &g != n {
            return Some(g);
        }
    }
    None
}

/// The factorization of |n| > 0 as sorted (prime, exponent) pairs.  A
/// cofactor rho cannot split is returned as if prime (`is_probable_prime`
/// tells the caller).
pub fn factor(n: &BigInt) -> Vec<(BigInt, u32)> {
    let mut n = n.abs();
    let mut out: Vec<(BigInt, u32)> = vec![];
    let push = |p: BigInt, out: &mut Vec<(BigInt, u32)>| {
        if let Some(e) = out.iter_mut().find(|(q, _)| *q == p) {
            e.1 += 1;
        } else {
            out.push((p, 1));
        }
    };
    for p in crate::arith::primes_up_to(1 << 16) {
        let bp = BigInt::from(p);
        if &bp * &bp > n {
            break;
        }
        while (&n % p).is_zero() {
            n /= p;
            push(bp.clone(), &mut out);
        }
    }
    let mut stack = vec![];
    if n > BigInt::one() {
        stack.push(n);
    }
    while let Some(m) = stack.pop() {
        if is_probable_prime(&m) {
            push(m, &mut out);
        } else if let Some(d) = rho(&m) {
            stack.push(&m / &d);
            stack.push(d);
        } else {
            push(m, &mut out);
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factors() {
        let n: BigInt = "1000000000000000000000000000000000000321".parse().unwrap();
        assert_eq!(factor(&n), vec![(n.clone(), 1)]);
        let p: BigInt = "1000000007".parse().unwrap();
        let q: BigInt = "998244353".parse().unwrap();
        let m = &p * &q * &q * BigInt::from(12);
        assert_eq!(factor(&m), vec![(BigInt::from(2), 2), (BigInt::from(3), 1), (q, 2), (p, 1)]);
        assert!(!is_probable_prime(&"3825123056546413051".parse().unwrap()));
    }
}
