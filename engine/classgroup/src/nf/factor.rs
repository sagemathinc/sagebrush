//! Factoring integers: trial division, Miller-Rabin, perfect powers,
//! Pollard-Brent rho and the elliptic curve method (ecm.rs).

use sagebrush_bigint::BigInt;
use num_traits::{One, Signed, ToPrimitive, Zero};

/// Whether n is prime: proven below 2^64 (is_prime_u64 is deterministic
/// there); beyond, Baillie-PSW (a strong probable-prime test to base 2 and
/// a strong Lucas test with Selfridge's parameters), with no known
/// counterexample, but not a proof.  Miller-Rabin to fixed bases alone is
/// not enough: Arnault's 1318-bit composite passes the first 20 primes as
/// bases (the systematic review's ARITH finding).  "Composite" is proven.
pub fn is_probable_prime(n: &BigInt) -> bool {
    let n = n.abs();
    if n < BigInt::from(2) {
        return false;
    }
    if let Some(m) = n.to_u64() {
        return crate::relations::is_prime_u64(m);
    }
    for p in [2u32, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71] {
        if (&n % p).is_zero() {
            return false;
        }
    }
    strong_prp(&n, &BigInt::from(2)) && strong_lucas_prp(&n)
}

/// The strong probable-prime test to base a (odd n > a).
fn strong_prp(n: &BigInt, a: &BigInt) -> bool {
    let nm1: BigInt = n - 1;
    let s = nm1.trailing_zeros().unwrap();
    let d = &nm1 >> s;
    let mut x = a.modpow(&d, n);
    if x.is_one() || x == nm1 {
        return true;
    }
    for _ in 1..s {
        sagebrush_interrupt::check();
        x = (&x * &x) % n;
        if x == nm1 {
            return true;
        }
    }
    false
}

/// The Jacobi symbol (a / n), n odd and positive.
fn jacobi(a: &BigInt, n: &BigInt) -> i32 {
    use num_integer::Integer;
    let (mut a, mut n) = (a.mod_floor(n), n.clone());
    let mut r = 1;
    while !a.is_zero() {
        while a.is_even() {
            a >>= 1usize;
            let m8 = (&n % 8u32).to_u32().unwrap();
            if m8 == 3 || m8 == 5 {
                r = -r;
            }
        }
        std::mem::swap(&mut a, &mut n);
        if (&a % 4u32).to_u32() == Some(3) && (&n % 4u32).to_u32() == Some(3) {
            r = -r;
        }
        a = a.mod_floor(&n);
    }
    if n.is_one() { r } else { 0 }
}

/// The strong Lucas probable-prime test with Selfridge's parameters: D the
/// first of 5, -7, 9, -11, ... with (D/n) = -1, P = 1, Q = (1 - D)/4 (odd n,
/// no small factors).
fn strong_lucas_prp(n: &BigInt) -> bool {
    use num_integer::Integer;
    let mut d = 5i64;
    loop {
        let j = jacobi(&BigInt::from(d), n);
        if j == -1 {
            break;
        }
        if j == 0 && BigInt::from(d.abs()) != *n {
            return false;
        }
        d = if d > 0 { -d - 2 } else { -d + 2 };
        if d == 13 {
            let r = num_integer::Roots::sqrt(n);
            if &r * &r == *n {
                return false; // a square never gets (D/n) = -1
            }
        }
    }
    let (p, q) = (BigInt::one(), BigInt::from((1 - d) / 4));
    let dd = BigInt::from(d);
    let mut k: BigInt = n + 1;
    let s = k.trailing_zeros().unwrap();
    k >>= s;
    let half = |x: BigInt| -> BigInt { (if x.is_odd() { x + n } else { x } >> 1usize).mod_floor(n) };
    let (mut u, mut v, mut qk) = (BigInt::one(), p.clone(), q.mod_floor(n));
    let bits = k.bits();
    for i in (0..bits - 1).rev() {
        if i % 16 == 0 {
            sagebrush_interrupt::check();
        }
        // double: U_2k = U_k V_k, V_2k = V_k^2 - 2 Q^k
        u = (&u * &v).mod_floor(n);
        v = (&v * &v - &qk * BigInt::from(2)).mod_floor(n);
        qk = (&qk * &qk).mod_floor(n);
        if k.bit(i) {
            // add one: U_(k+1) = (P U + V)/2, V_(k+1) = (D U + P V)/2
            let (nu, nv) = (&p * &u + &v, &dd * &u + &p * &v);
            u = half(nu);
            v = half(nv);
            qk = (&qk * &q).mod_floor(n);
        }
    }
    if u.is_zero() || v.is_zero() {
        return true;
    }
    for _ in 1..s {
        sagebrush_interrupt::check();
        v = (&v * &v - &qk * BigInt::from(2)).mod_floor(n);
        if v.is_zero() {
            return true;
        }
        qk = (&qk * &qk).mod_floor(n);
    }
    false
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
        // Arnault's 1318-bit strong pseudoprime to the first 20 prime
        // bases, p (313 (p - 1) + 1) (353 (p - 1) + 1): composite
        let p: BigInt = "29674495668685510550154174642905332730771991799853043350995075531276838753171770199594238596428121188033664754218345562493168782883".parse().unwrap();
        let arnault = &p * (&p * 313u32 - 312u32) * (&p * 353u32 - 352u32);
        assert!(!is_probable_prime(&arnault));
        // strong Lucas pseudoprimes are caught by base 2 and vice versa;
        // primes pass: 2^127 - 1, 2^521 - 1, 10^100 + 267
        for s in ["170141183460469231731687303715884105727", "6864797660130609714981900799081393217269435300143305409394463459185543183397656052122559640661454554977296311391480858037121987999716643812574028291115057151"] {
            assert!(is_probable_prime(&s.parse().unwrap()), "{}", s);
        }
        assert!(is_probable_prime(&(num_traits::pow(BigInt::from(10), 100) + 267u32)));
        assert!(!is_probable_prime(&(num_traits::pow(BigInt::from(10), 100) + 1u32)));
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
