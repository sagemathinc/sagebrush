//! num-bigint's results where the dashu facade differed (two audits,
//! each result checked against num-bigint, and Python, GMP, FLINT or Sage
//! 10.10): float32 conversion rounded once, num-bigint's text, modpow modulo
//! +-1, and bit indices and shift amounts past a 32-bit usize.  The same
//! rows run with feature num-backend and on wasm32 (cargo test --target
//! wasm32-wasip1, under Node's WASI), where usize has 32 bits.
use num_traits::{Num, ToPrimitive};
use sagebrush_bigint::{BigInt, BigUint};

#[test]
fn to_f32_rounds_once() {
    // (2^54 + 2^30 + 1: through f64 it rounded to 2^54 first, 5a800000)
    let n: BigInt = "18014399583223809".parse().unwrap();
    assert_eq!(n.to_f32().unwrap().to_bits(), 0x5a80_0001);
    assert_eq!((-&n).to_f32().unwrap().to_bits(), 0xda80_0001);
    let u: BigUint = "18014399583223809".parse().unwrap();
    assert_eq!(u.to_f32().unwrap().to_bits(), 0x5a80_0001);
    // (controls: exact, and a tie to even)
    assert_eq!(BigInt::from(1 << 24).to_f32(), Some(16777216.0));
    assert_eq!(BigInt::from((1 << 24) + 1).to_f32(), Some(16777216.0));
}

#[test]
fn text_as_num_bigint() {
    for bad in ["+-1", "++1", "_1", "-_1", "-+1", "--1", "+", "-", ""] {
        assert!(bad.parse::<BigInt>().is_err(), "{:?}", bad);
        assert!(BigInt::parse_bytes(bad.as_bytes(), 10).is_none(), "{:?}", bad);
    }
    for bad in ["++1", "_1", "+-1", "-1", "+_1"] {
        assert!(bad.parse::<BigUint>().is_err(), "{:?}", bad);
        assert!(BigUint::parse_bytes(bad.as_bytes(), 10).is_none(), "{:?}", bad);
    }
    assert!(BigInt::from_str_radix("+-ff", 16).is_err());
    // (controls: one sign, and underscores after a digit)
    let ok = |s: &str, v: i64| assert_eq!(s.parse::<BigInt>().ok(), Some(BigInt::from(v)), "{:?}", s);
    ok("+1", 1);
    ok("-1", -1);
    ok("1_0", 10);
    ok("1_", 1);
    ok("-1_0", -10);
    assert_eq!(BigInt::from_str_radix("-ff", 16).ok(), Some(BigInt::from(-255)));
    assert_eq!("+7".parse::<BigUint>().ok(), Some(BigUint::from(7u32)));
}

#[test]
fn modpow_modulo_one() {
    let b = |x: i64| BigInt::from(x);
    assert_eq!(b(7).modpow(&b(0), &b(1)), b(0));
    assert_eq!(b(7).modpow(&b(0), &b(-1)), b(0));
    assert_eq!(b(-7).modpow(&b(5), &b(1)), b(0));
    assert_eq!(BigUint::from(7u32).modpow(&BigUint::from(0u32), &BigUint::from(1u32)), BigUint::from(0u32));
    // (control: modulo 2)
    assert_eq!(b(7).modpow(&b(0), &b(2)), b(1));
}

#[test]
fn bit_indices_and_shifts_past_32_bits() {
    let b = |x: i64| BigInt::from(x);
    // (bit n of the two's complement: past every bit, the sign)
    for n in [1u64 << 32, (1 << 32) + 1, u64::MAX] {
        assert!(!b(5).bit(n), "{}", n);
        assert!(b(-2).bit(n), "{}", n);
        assert!(!BigUint::from(5u32).bit(n), "{}", n);
    }
    assert!(b(5).bit(0) && !b(5).bit(1) && b(5).bit(2) && !b(-2).bit(0) && b(-2).bit(1));
    // (a shift by 2^32: right, the sign; zero left, zero; no allocation)
    let big = 1u64 << 32;
    assert_eq!(b(-5) >> big, b(-1));
    assert_eq!(b(5) >> big, b(0));
    assert_eq!(&b(-5) >> big, b(-1));
    assert_eq!(b(0) << big, b(0));
    assert_eq!(&b(0) << big, b(0));
    let mut x = b(-5);
    x >>= big;
    assert_eq!(x, b(-1));
    let mut z = b(0);
    z <<= big;
    assert_eq!(z, b(0));
    assert_eq!(BigUint::from(5u32) >> big, BigUint::from(0u32));
    assert_eq!(BigUint::from(0u32) << big, BigUint::from(0u32));
    // (control: an ordinary shift)
    assert_eq!(b(-5) >> 1u64, b(-3));
}
