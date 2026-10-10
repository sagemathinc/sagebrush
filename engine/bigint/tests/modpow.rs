//! modpow: num-bigint's sign convention for negative moduli (systematic
//! review ARI-F4), and the bit-by-bit route for long exponentiations.
use sagebrush_bigint::BigInt;

#[test]
fn negative_modulus_and_long_exponents() {
    let b = |x: i64| BigInt::from(x);
    assert_eq!(b(2).modpow(&b(3), &b(-5)), b(-2));
    assert_eq!(b(2).modpow(&b(3), &b(5)), b(3));
    assert_eq!(b(5).modpow(&b(1), &b(-5)), b(0));
    // a 5000-bit modulus and a 2000-bit exponent: the interruptible loop
    // agrees with Fermat (m prime is not needed: compare two routes)
    let m: BigInt = (BigInt::from(1) << 5000usize) - BigInt::from(1);
    let e: BigInt = (BigInt::from(1) << 2000usize) + BigInt::from(12345);
    let x = BigInt::from(3);
    let long = x.modpow(&e, &m);
    // the same exponent split as e = 2^2000 + 12345: x^(2^2000) by squaring
    let mut y = x.clone();
    for _ in 0..2000 {
        y = (&y * &y) % &m;
    }
    let short = (&y * x.modpow(&BigInt::from(12345), &m)) % &m;
    assert_eq!(long, short);
    // base 1: the operands of every multiplication are equal
    assert_eq!(BigInt::from(1).modpow(&e, &m), BigInt::from(1));
}
