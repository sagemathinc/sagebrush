//! The Sagebrush engines' big integers.
//!
//! Engines write `use sagebrush_bigint::{BigInt, BigUint, BigRational}` and
//! num-bigint's API (with the num-traits and num-integer traits).  These
//! are newtypes over dashu's integers (MIT OR Apache-2.0) providing that
//! API; with the feature `num-backend` they are num-bigint's own types, so
//! the two can be compared on real workloads (bench/bigint/engines_ab.py:
//! number fields 1.4-1.7x faster with dashu, identical results).
//!
//! [`to_num`] and [`from_num`] convert to and from num-bigint at
//! boundaries that need it (PyO3's conversions).

#[cfg(feature = "num-backend")]
pub use num_bigint::{BigInt, BigUint, Sign};

#[cfg(not(feature = "num-backend"))]
mod dashu_impl;
#[cfg(not(feature = "num-backend"))]
pub mod hgcd;

/// Long loops in this crate check for Ctrl-C (engine/interrupt).
#[allow(dead_code)]
pub(crate) fn check_interrupt() {
    sagebrush_interrupt::check();
}
#[cfg(not(feature = "num-backend"))]
pub use dashu_impl::{BigInt, BigUint, Sign};

/// Rationals over [`BigInt`].
pub type BigRational = num_rational::Ratio<BigInt>;

/// The backend's name: "num-bigint" or "dashu".
pub const BACKEND: &str = if cfg!(feature = "num-backend") { "num-bigint" } else { "dashu" };

#[cfg(feature = "num-backend")]
pub fn to_num(x: &BigInt) -> num_bigint::BigInt {
    x.clone()
}

#[cfg(feature = "num-backend")]
pub fn from_num(x: &num_bigint::BigInt) -> BigInt {
    x.clone()
}

#[cfg(not(feature = "num-backend"))]
pub use dashu_impl::{from_num, to_num};

#[cfg(test)]
mod tests {
    use super::*;
    use num_integer::Integer;
    use num_traits::{FromPrimitive, Num, One, Signed, ToPrimitive, Zero};

    fn b(s: &str) -> BigInt {
        s.parse().unwrap()
    }

    /// The API surface the engines use, with num-bigint's semantics (these
    /// run for both backends: cargo test -p sagebrush-bigint [--features num-backend]).
    #[test]
    fn semantics() {
        let x = b("-123456789012345678901234567890");
        let y = b("9876543210987");
        assert_eq!((&x / &y).to_string(), "-12499999886094578");
        assert_eq!((&x % &y).to_string(), "-1249943839404");
        assert_eq!(x.div_floor(&y).to_string(), "-12499999886094579");
        assert_eq!(x.mod_floor(&y).to_string(), "8626599371583");
        assert_eq!(b("-7").mod_floor(&b("-3")), b("-1"));
        assert_eq!(b("7").div_floor(&b("-3")), b("-3"));
        let (q, r) = x.div_rem(&y);
        assert_eq!(&q * &y + &r, x);
        let (q, r) = x.div_mod_floor(&y);
        assert_eq!(&q * &y + &r, x);
        assert_eq!(b("-12").gcd(&b("18")), b("6"));
        assert_eq!(b("4").lcm(&b("-6")), b("12"));
        let e = b("240").extended_gcd(&b("46"));
        assert_eq!(e.gcd, b("2"));
        assert_eq!(&e.x * b("240") + &e.y * b("46"), b("2"));
        assert_eq!(x.abs().to_string(), "123456789012345678901234567890");
        assert!(x.is_negative() && !x.is_positive() && x.signum() == -BigInt::one());
        assert_eq!(x.bits(), 97);
        assert_eq!(b("2").pow(100u32).to_string(), "1267650600228229401496703205376");
        assert_eq!(b("1000000000000000000000").sqrt().to_string(), "31622776601");
        assert_eq!(b("12").pow(2u32), b("144"));
        assert_eq!((b("1") << 70usize) >> 69usize, b("2"));
        assert_eq!(b("-5") >> 1usize, b("-3"));
        assert_eq!(b("4096").trailing_zeros(), Some(12));
        assert!(b("5").bit(2) && !b("5").bit(1));
        assert_eq!(b("3").modpow(&b("200"), &b("1000007")), b("3").pow(200u32) % b("1000007"));
        assert_eq!(x.to_f64().unwrap(), -1.2345678901234568e29);
        assert_eq!(b("-17").to_i64(), Some(-17));
        assert_eq!(b("-17").to_u64(), None);
        assert_eq!(b("340282366920938463463374607431768211455").to_u128(), Some(u128::MAX));
        assert_eq!(BigInt::from_f64(-2.5e20).unwrap().to_string(), "-250000000000000000000");
        assert_eq!(BigInt::from_str_radix("-ff", 16).unwrap(), b("-255"));
        assert_eq!(b("255").to_str_radix(16), "ff");
        assert!(BigInt::zero().is_zero() && BigInt::one().is_one());
        assert!(b("6").is_even() && b("-7").is_odd());
        let (s, d) = b("-18446744073709551617").to_u64_digits();
        assert_eq!((s, d), (Sign::Minus, vec![1, 1]));
        assert_eq!(b("-9").to_biguint(), None);
        assert_eq!(BigInt::from_biguint(Sign::Minus, b("9").to_biguint().unwrap()), b("-9"));
        assert_eq!(b("-9").sign(), Sign::Minus);
        assert_eq!(BigInt::from(-3i64) * 7u32 + 2i32 - BigInt::from(5u8), b("-24"));
        assert_eq!(10i64 - &b("3"), b("7"));
        let mut z = b("10");
        z += &b("5");
        z *= 3;
        z -= 1;
        z /= 2;
        z %= 100;
        assert_eq!(z, b("22"));
        assert_eq!(vec![b("1"), b("2"), b("3")].iter().sum::<BigInt>(), b("6"));
        assert_eq!(vec![b("2"), b("3")].into_iter().product::<BigInt>(), b("6"));
        assert_eq!(b("3").modinv(&b("7")), Some(b("5")));
        assert_eq!(b("-3").modinv(&b("7")), Some(b("2")));
        assert_eq!(b("3").modinv(&b("-7")), Some(b("-2")));
        assert_eq!(b("6").modinv(&b("9")), None);
        assert_eq!(num_integer::Roots::nth_root(&b("-1000000000000000000000000000001"), 3), b("-10000000000"));
        assert_eq!(num_integer::Roots::sqrt(&b("99")), b("9"));
        assert_eq!(u64::try_from(b("12345678901")).unwrap(), 12345678901);
        assert!(u64::try_from(b("-1")).is_err());
        assert_eq!(BigInt::zero().gcd(&BigInt::zero()), BigInt::zero());
        assert_eq!(BigInt::zero().gcd(&b("-5")), b("5"));
        let e = BigInt::zero().extended_gcd(&BigInt::zero());
        assert_eq!((e.gcd, e.x, e.y), (b("0"), b("1"), b("0")));
        let e = BigInt::zero().extended_gcd(&b("-4"));
        assert_eq!(&e.x * b("0") + &e.y * b("-4"), e.gcd);
        assert_eq!(BigInt::zero().lcm(&b("3")), b("0"));
        assert_eq!(b("0").modinv(&b("1")), Some(b("0")));
        assert_eq!(b("0").modinv(&b("5")), None);
        // rationals
        let r = BigRational::new(b("6"), b("-4"));
        assert_eq!(r.to_string(), "-3/2");
        assert_eq!(r.floor().to_integer(), b("-2"));
        assert_eq!(r.to_f64().unwrap(), -1.5);
        assert_eq!((r.clone() + BigRational::from_integer(b("2"))).to_string(), "1/2");
        // boundary conversions
        assert_eq!(from_num(&to_num(&x)), x);
        let u: BigUint = BigUint::from(1u64) << 64usize;
        assert_eq!(u.to_string(), "18446744073709551616");
        assert_eq!(u.to_u64_digits(), vec![0, 1]);
        assert_eq!(BigInt::from(u.clone()), b("18446744073709551616"));
        assert_eq!((u.clone() * &u).bits(), 129);
    }
}
