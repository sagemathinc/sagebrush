//! Factoring integers: trial division, Miller-Rabin, perfect powers,
//! Pollard-Brent rho and the elliptic curve method (ecm.rs).

use sagebrush_bigint::BigInt;
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


/// A nontrivial factor of a composite n (no factors below 2^16): a perfect
/// power's root, then Pollard-Brent rho (in Montgomery arithmetic; factors
/// up to ~10^12), then the elliptic curve method with bounds that keep
/// growing until it succeeds (Stop interrupts).  None only when no method
/// applies: rho and ECM work on at most 1024 bits.
fn split(n: &BigInt) -> Option<BigInt> {
    for k in (2..=n.bits() as u32 / 16).rev() {
        let r = num_integer::Roots::nth_root(n, k);
        if r.pow(k) == *n {
            return Some(r);
        }
    }
    let nu = n.to_biguint()?;
    if let Some(d) = super::ecm::rho(&nu, 1 << 20, 0x9E37_79B9) {
        return Some(BigInt::from(d));
    }
    super::ecm::ecm_until_found(&nu, 0x2545_F491_4F6C_DD1D).map(BigInt::from)
}

/// The factorization of |n| > 0 as sorted (prime, exponent) pairs; the
/// primes are probable primes (Miller-Rabin to 20 bases: proven below
/// 3.3e24).  A composite is never reported as a prime: one that cannot be
/// split (beyond 1024 bits, where rho and ECM do not apply) is an error.
pub fn factor(n: &BigInt) -> Result<Vec<(BigInt, u32)>, String> {
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
        sagebrush_interrupt::check();
        if is_probable_prime(&m) {
            push(m, &mut out);
        } else if let Some(d) = split(&m) {
            stack.push(&m / &d);
            stack.push(d);
        } else {
            return Err(format!("cannot factor a composite of {} bits: rho and ECM work on at most 1024 bits", m.bits()));
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factors() {
        let n: BigInt = "1000000000000000000000000000000000000321".parse().unwrap();
        assert_eq!(factor(&n).unwrap(), vec![(n.clone(), 1)]);
        let p: BigInt = "1000000007".parse().unwrap();
        let q: BigInt = "998244353".parse().unwrap();
        let m = &p * &q * &q * BigInt::from(12);
        assert_eq!(factor(&m).unwrap(), vec![(BigInt::from(2), 2), (BigInt::from(3), 1), (q, 2), (p, 1)]);
        assert!(!is_probable_prime(&"3825123056546413051".parse().unwrap()));
    }

    // A composite that cannot be split is an error, never a "prime" (Astra's
    // audit, F1: (2^521 - 1)(2^607 - 1) came back as one prime factor).
    #[test]
    fn unsplittable_composite_is_an_error() {
        let one = BigInt::one();
        let n = ((&one << 521usize) - &one) * ((&one << 607usize) - &one);
        assert!(!is_probable_prime(&n));
        let e = factor(&n).unwrap_err();
        assert!(e.contains("1128 bits"), "{}", e);
    }

    // Every factor reported is a probable prime and the product is n.
    #[test]
    fn factors_are_prime_and_multiply_back() {
        for s in ["340282366920938463463374607431768211457", "1000000016000000063", "18446744073709551617", "99999999999999999999999999999999"] {
            let n: BigInt = s.parse().unwrap();
            let f = factor(&n).unwrap();
            let mut prod = BigInt::one();
            for (p, e) in &f {
                assert!(is_probable_prime(p), "{} in {}", p, s);
                prod *= p.pow(*e);
            }
            assert_eq!(prod, n);
        }
    }
}
