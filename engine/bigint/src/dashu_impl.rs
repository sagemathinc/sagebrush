//! num-bigint's API on dashu's integers: newtypes over `IBig` and `UBig`
//! with the operators (including mixed with primitives and references),
//! the num-traits and num-integer traits, and the inherent methods the
//! engines call.  Semantics are num-bigint's: `/` and `%` truncate,
//! `div_floor`/`mod_floor` floor, `>>` rounds toward minus infinity.

use dashu_base::{Abs, BitTest, DivRem, ExtendedGcd, Gcd, SquareRoot, UnsignedAbs};
use dashu_int::{IBig, UBig};
use std::cmp::Ordering;
use std::fmt;
use std::iter::{Product, Sum};
use std::ops::*;
use std::str::FromStr;

/// num-bigint's `Sign`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Sign {
    Minus,
    NoSign,
    Plus,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct BigInt(pub IBig);

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct BigUint(pub UBig);

// ---- formatting and parsing

macro_rules! fmt_via_inner {
    ($t:ty) => {
        impl fmt::Display for $t {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }
        impl fmt::Debug for $t {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }
        impl fmt::LowerHex for $t {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::LowerHex::fmt(&self.0, f)
            }
        }
    };
}
fmt_via_inner!(BigInt);
fmt_via_inner!(BigUint);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseBigIntError;
impl fmt::Display for ParseBigIntError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid big integer literal")
    }
}
impl std::error::Error for ParseBigIntError {}

impl FromStr for BigInt {
    type Err = ParseBigIntError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        IBig::from_str_radix(s.strip_prefix('+').unwrap_or(s), 10).map(BigInt).map_err(|_| ParseBigIntError)
    }
}
impl FromStr for BigUint {
    type Err = ParseBigIntError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        UBig::from_str_radix(s.strip_prefix('+').unwrap_or(s), 10).map(BigUint).map_err(|_| ParseBigIntError)
    }
}

// ---- conversions from primitives

macro_rules! from_prims {
    ($($p:ty),*) => {$(
        impl From<$p> for BigInt {
            #[inline]
            fn from(x: $p) -> Self {
                BigInt(IBig::from(x))
            }
        }
    )*};
}
from_prims!(i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize);
macro_rules! from_uprims {
    ($($p:ty),*) => {$(
        impl From<$p> for BigUint {
            #[inline]
            fn from(x: $p) -> Self {
                BigUint(UBig::from(x))
            }
        }
    )*};
}
from_uprims!(u8, u16, u32, u64, u128, usize);
impl From<BigUint> for BigInt {
    fn from(x: BigUint) -> Self {
        BigInt(IBig::from(x.0))
    }
}

// ---- operators

/// Operands with at least this many 64-bit words (on both sides) are
/// multiplied by the 3-prime NTT (crate::ntt), 1.4-1.9x faster than
/// dashu's from 256K bits (bench: sagebrush-arith example nttbench).
pub const NTT_MUL_WORDS: usize = 4096;

/// a * b, by the NTT for huge operands (64-bit targets).
pub fn mul_ubig(a: &UBig, b: &UBig) -> UBig {
    #[cfg(target_pointer_width = "64")]
    {
        let (x, y) = (a.as_words(), b.as_words());
        if x.len().min(y.len()) >= NTT_MUL_WORDS {
            // (dashu's Word is u64 on 64-bit targets)
            let (x, y): (&[u64], &[u64]) = (x, y);
            let z = if std::ptr::eq(a, b) { crate::ntt::mul_words(x, x) } else { crate::ntt::mul_words(x, y) };
            return UBig::from_words(&z);
        }
    }
    a * b
}

/// a * b for signed integers (see [`mul_ubig`]).
pub fn mul_ibig(a: &IBig, b: &IBig) -> IBig {
    #[cfg(target_pointer_width = "64")]
    {
        let (sa, wa) = a.as_sign_words();
        let (sb, wb) = b.as_sign_words();
        if wa.len().min(wb.len()) >= NTT_MUL_WORDS {
            let mag = mul_ubig(&UBig::from_words(wa), &UBig::from_words(wb));
            let neg = (sa == dashu_int::Sign::Negative) != (sb == dashu_int::Sign::Negative);
            return IBig::from_parts(if neg { dashu_int::Sign::Negative } else { dashu_int::Sign::Positive }, mag);
        }
    }
    a * b
}

macro_rules! binop_mul {
    () => {
        impl Mul<BigInt> for BigInt {
            type Output = BigInt;
            #[inline]
            fn mul(self, r: BigInt) -> BigInt {
                BigInt(mul_ibig(&self.0, &r.0))
            }
        }
        impl Mul<&BigInt> for BigInt {
            type Output = BigInt;
            #[inline]
            fn mul(self, r: &BigInt) -> BigInt {
                BigInt(mul_ibig(&self.0, &r.0))
            }
        }
        impl Mul<BigInt> for &BigInt {
            type Output = BigInt;
            #[inline]
            fn mul(self, r: BigInt) -> BigInt {
                BigInt(mul_ibig(&self.0, &r.0))
            }
        }
        impl Mul<&BigInt> for &BigInt {
            type Output = BigInt;
            #[inline]
            fn mul(self, r: &BigInt) -> BigInt {
                BigInt(mul_ibig(&self.0, &r.0))
            }
        }
        impl MulAssign<BigInt> for BigInt {
            #[inline]
            fn mul_assign(&mut self, r: BigInt) {
                self.0 = mul_ibig(&self.0, &r.0);
            }
        }
        impl MulAssign<&BigInt> for BigInt {
            #[inline]
            fn mul_assign(&mut self, r: &BigInt) {
                self.0 = mul_ibig(&self.0, &r.0);
            }
        }
        binop_prims!(Mul, mul, MulAssign, mul_assign, *, i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize);
    };
}

macro_rules! ubinop_mul {
    () => {
        impl Mul<BigUint> for BigUint {
            type Output = BigUint;
            #[inline]
            fn mul(self, r: BigUint) -> BigUint {
                BigUint(mul_ubig(&self.0, &r.0))
            }
        }
        impl Mul<&BigUint> for BigUint {
            type Output = BigUint;
            #[inline]
            fn mul(self, r: &BigUint) -> BigUint {
                BigUint(mul_ubig(&self.0, &r.0))
            }
        }
        impl Mul<BigUint> for &BigUint {
            type Output = BigUint;
            #[inline]
            fn mul(self, r: BigUint) -> BigUint {
                BigUint(mul_ubig(&self.0, &r.0))
            }
        }
        impl Mul<&BigUint> for &BigUint {
            type Output = BigUint;
            #[inline]
            fn mul(self, r: &BigUint) -> BigUint {
                BigUint(mul_ubig(&self.0, &r.0))
            }
        }
        impl MulAssign<BigUint> for BigUint {
            #[inline]
            fn mul_assign(&mut self, r: BigUint) {
                self.0 = mul_ubig(&self.0, &r.0);
            }
        }
        impl MulAssign<&BigUint> for BigUint {
            #[inline]
            fn mul_assign(&mut self, r: &BigUint) {
                self.0 = mul_ubig(&self.0, &r.0);
            }
        }
        ubinop_prims!(Mul, mul, MulAssign, mul_assign, *, u8, u16, u32, u64, u128, usize);
    };
}



macro_rules! binop {
    ($tr:ident, $m:ident, $atr:ident, $am:ident, $op:tt) => {
        impl $tr<BigInt> for BigInt {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: BigInt) -> BigInt {
                BigInt(self.0 $op r.0)
            }
        }
        impl $tr<&BigInt> for BigInt {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: &BigInt) -> BigInt {
                BigInt(self.0 $op &r.0)
            }
        }
        impl $tr<BigInt> for &BigInt {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: BigInt) -> BigInt {
                BigInt(&self.0 $op r.0)
            }
        }
        impl $tr<&BigInt> for &BigInt {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: &BigInt) -> BigInt {
                BigInt(&self.0 $op &r.0)
            }
        }
        impl $atr<BigInt> for BigInt {
            #[inline]
            fn $am(&mut self, r: BigInt) {
                let a = std::mem::take(&mut self.0);
                self.0 = a $op r.0;
            }
        }
        impl $atr<&BigInt> for BigInt {
            #[inline]
            fn $am(&mut self, r: &BigInt) {
                let a = std::mem::take(&mut self.0);
                self.0 = a $op &r.0;
            }
        }
        binop_prims!($tr, $m, $atr, $am, $op, i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize);
    };
}
macro_rules! binop_prims {
    ($tr:ident, $m:ident, $atr:ident, $am:ident, $op:tt, $($p:ty),*) => {$(
        impl $tr<$p> for BigInt {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: $p) -> BigInt {
                BigInt(self.0 $op IBig::from(r))
            }
        }
        impl $tr<$p> for &BigInt {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: $p) -> BigInt {
                BigInt(&self.0 $op IBig::from(r))
            }
        }
        impl $tr<BigInt> for $p {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: BigInt) -> BigInt {
                BigInt(IBig::from(self) $op r.0)
            }
        }
        impl $tr<&BigInt> for $p {
            type Output = BigInt;
            #[inline]
            fn $m(self, r: &BigInt) -> BigInt {
                BigInt(IBig::from(self) $op &r.0)
            }
        }
        impl $atr<$p> for BigInt {
            #[inline]
            fn $am(&mut self, r: $p) {
                let a = std::mem::take(&mut self.0);
                self.0 = a $op IBig::from(r);
            }
        }
    )*};
}
binop!(Add, add, AddAssign, add_assign, +);
binop!(Sub, sub, SubAssign, sub_assign, -);
binop_mul!();
binop!(Div, div, DivAssign, div_assign, /);
binop!(Rem, rem, RemAssign, rem_assign, %);
binop!(BitAnd, bitand, BitAndAssign, bitand_assign, &);
binop!(BitOr, bitor, BitOrAssign, bitor_assign, |);
binop!(BitXor, bitxor, BitXorAssign, bitxor_assign, ^);

impl Neg for BigInt {
    type Output = BigInt;
    #[inline]
    fn neg(self) -> BigInt {
        BigInt(-self.0)
    }
}
impl Neg for &BigInt {
    type Output = BigInt;
    #[inline]
    fn neg(self) -> BigInt {
        BigInt(-&self.0)
    }
}

macro_rules! shifts {
    ($t:ident, $($p:ty),*) => {$(
        impl Shl<$p> for $t {
            type Output = $t;
            #[inline]
            fn shl(self, n: $p) -> $t {
                $t(self.0 << usize::try_from(n).expect("shift amount"))
            }
        }
        impl Shl<$p> for &$t {
            type Output = $t;
            #[inline]
            fn shl(self, n: $p) -> $t {
                $t(&self.0 << usize::try_from(n).expect("shift amount"))
            }
        }
        impl Shr<$p> for $t {
            type Output = $t;
            #[inline]
            fn shr(self, n: $p) -> $t {
                $t(self.0 >> usize::try_from(n).expect("shift amount"))
            }
        }
        impl Shr<$p> for &$t {
            type Output = $t;
            #[inline]
            fn shr(self, n: $p) -> $t {
                $t(&self.0 >> usize::try_from(n).expect("shift amount"))
            }
        }
        impl ShlAssign<$p> for $t {
            #[inline]
            fn shl_assign(&mut self, n: $p) {
                let a = std::mem::take(&mut self.0);
                self.0 = a << usize::try_from(n).expect("shift amount");
            }
        }
        impl ShrAssign<$p> for $t {
            #[inline]
            fn shr_assign(&mut self, n: $p) {
                let a = std::mem::take(&mut self.0);
                self.0 = a >> usize::try_from(n).expect("shift amount");
            }
        }
    )*};
}
shifts!(BigInt, u8, u16, u32, u64, usize, i32, i64);
shifts!(BigUint, u8, u16, u32, u64, usize, i32, i64);

// BigUint arithmetic (num-bigint's subtraction panics on underflow; so does dashu's)
macro_rules! ubinop {
    ($tr:ident, $m:ident, $atr:ident, $am:ident, $op:tt) => {
        impl $tr<BigUint> for BigUint {
            type Output = BigUint;
            #[inline]
            fn $m(self, r: BigUint) -> BigUint {
                BigUint(self.0 $op r.0)
            }
        }
        impl $tr<&BigUint> for BigUint {
            type Output = BigUint;
            #[inline]
            fn $m(self, r: &BigUint) -> BigUint {
                BigUint(self.0 $op &r.0)
            }
        }
        impl $tr<BigUint> for &BigUint {
            type Output = BigUint;
            #[inline]
            fn $m(self, r: BigUint) -> BigUint {
                BigUint(&self.0 $op r.0)
            }
        }
        impl $tr<&BigUint> for &BigUint {
            type Output = BigUint;
            #[inline]
            fn $m(self, r: &BigUint) -> BigUint {
                BigUint(&self.0 $op &r.0)
            }
        }
        impl $atr<BigUint> for BigUint {
            #[inline]
            fn $am(&mut self, r: BigUint) {
                let a = std::mem::take(&mut self.0);
                self.0 = a $op r.0;
            }
        }
        impl $atr<&BigUint> for BigUint {
            #[inline]
            fn $am(&mut self, r: &BigUint) {
                let a = std::mem::take(&mut self.0);
                self.0 = a $op &r.0;
            }
        }
        ubinop_prims!($tr, $m, $atr, $am, $op, u8, u16, u32, u64, u128, usize);
    };
}
macro_rules! ubinop_prims {
    ($tr:ident, $m:ident, $atr:ident, $am:ident, $op:tt, $($p:ty),*) => {$(
        impl $tr<$p> for BigUint {
            type Output = BigUint;
            #[inline]
            fn $m(self, r: $p) -> BigUint {
                BigUint(self.0 $op UBig::from(r))
            }
        }
        impl $tr<$p> for &BigUint {
            type Output = BigUint;
            #[inline]
            fn $m(self, r: $p) -> BigUint {
                BigUint(&self.0 $op UBig::from(r))
            }
        }
        impl $atr<$p> for BigUint {
            #[inline]
            fn $am(&mut self, r: $p) {
                let a = std::mem::take(&mut self.0);
                self.0 = a $op UBig::from(r);
            }
        }
    )*};
}
ubinop!(Add, add, AddAssign, add_assign, +);
ubinop!(Sub, sub, SubAssign, sub_assign, -);
ubinop_mul!();
ubinop!(Div, div, DivAssign, div_assign, /);
ubinop!(Rem, rem, RemAssign, rem_assign, %);

// ---- comparisons with primitives are by conversion in the engines; sums

impl Sum for BigInt {
    fn sum<I: Iterator<Item = BigInt>>(it: I) -> BigInt {
        BigInt(it.map(|x| x.0).sum())
    }
}
impl<'a> Sum<&'a BigInt> for BigInt {
    fn sum<I: Iterator<Item = &'a BigInt>>(it: I) -> BigInt {
        let mut s = IBig::ZERO;
        for x in it {
            s += &x.0;
        }
        BigInt(s)
    }
}
impl Product for BigInt {
    fn product<I: Iterator<Item = BigInt>>(it: I) -> BigInt {
        BigInt(it.map(|x| x.0).product())
    }
}
impl<'a> Product<&'a BigInt> for BigInt {
    fn product<I: Iterator<Item = &'a BigInt>>(it: I) -> BigInt {
        let mut s = IBig::ONE;
        for x in it {
            s *= &x.0;
        }
        BigInt(s)
    }
}
impl Sum for BigUint {
    fn sum<I: Iterator<Item = BigUint>>(it: I) -> BigUint {
        BigUint(it.map(|x| x.0).sum())
    }
}
impl Product for BigUint {
    fn product<I: Iterator<Item = BigUint>>(it: I) -> BigUint {
        BigUint(it.map(|x| x.0).product())
    }
}

// ---- num-traits

impl num_traits::Zero for BigInt {
    #[inline]
    fn zero() -> Self {
        BigInt(IBig::ZERO)
    }
    #[inline]
    fn is_zero(&self) -> bool {
        self.0.is_zero()
    }
}
impl num_traits::One for BigInt {
    #[inline]
    fn one() -> Self {
        BigInt(IBig::ONE)
    }
    #[inline]
    fn is_one(&self) -> bool {
        self.0.is_one()
    }
}
impl num_traits::Zero for BigUint {
    #[inline]
    fn zero() -> Self {
        BigUint(UBig::ZERO)
    }
    #[inline]
    fn is_zero(&self) -> bool {
        self.0.is_zero()
    }
}
impl num_traits::One for BigUint {
    #[inline]
    fn one() -> Self {
        BigUint(UBig::ONE)
    }
    #[inline]
    fn is_one(&self) -> bool {
        self.0.is_one()
    }
}
impl num_traits::Num for BigInt {
    type FromStrRadixErr = ParseBigIntError;
    fn from_str_radix(s: &str, radix: u32) -> Result<Self, ParseBigIntError> {
        IBig::from_str_radix(s.strip_prefix('+').unwrap_or(s), radix).map(BigInt).map_err(|_| ParseBigIntError)
    }
}
impl num_traits::Num for BigUint {
    type FromStrRadixErr = ParseBigIntError;
    fn from_str_radix(s: &str, radix: u32) -> Result<Self, ParseBigIntError> {
        UBig::from_str_radix(s.strip_prefix('+').unwrap_or(s), radix).map(BigUint).map_err(|_| ParseBigIntError)
    }
}
impl num_traits::Signed for BigInt {
    #[inline]
    fn abs(&self) -> Self {
        BigInt((&self.0).abs())
    }
    fn abs_sub(&self, other: &Self) -> Self {
        if self <= other {
            BigInt(IBig::ZERO)
        } else {
            self - other
        }
    }
    #[inline]
    fn signum(&self) -> Self {
        BigInt(self.0.signum())
    }
    #[inline]
    fn is_positive(&self) -> bool {
        self.0 > IBig::ZERO
    }
    #[inline]
    fn is_negative(&self) -> bool {
        self.0 < IBig::ZERO
    }
}

impl num_traits::ToPrimitive for BigInt {
    fn to_i64(&self) -> Option<i64> {
        i64::try_from(&self.0).ok()
    }
    fn to_u64(&self) -> Option<u64> {
        u64::try_from(&self.0).ok()
    }
    fn to_i128(&self) -> Option<i128> {
        i128::try_from(&self.0).ok()
    }
    fn to_u128(&self) -> Option<u128> {
        u128::try_from(&self.0).ok()
    }
    fn to_f64(&self) -> Option<f64> {
        Some(self.0.to_f64().value())
    }
    fn to_f32(&self) -> Option<f32> {
        Some(self.0.to_f64().value() as f32)
    }
}
impl num_traits::ToPrimitive for BigUint {
    fn to_i64(&self) -> Option<i64> {
        i64::try_from(&self.0).ok()
    }
    fn to_u64(&self) -> Option<u64> {
        u64::try_from(&self.0).ok()
    }
    fn to_i128(&self) -> Option<i128> {
        i128::try_from(&self.0).ok()
    }
    fn to_u128(&self) -> Option<u128> {
        u128::try_from(&self.0).ok()
    }
    fn to_f64(&self) -> Option<f64> {
        Some(self.0.to_f64().value())
    }
}
impl num_traits::FromPrimitive for BigInt {
    fn from_i64(n: i64) -> Option<Self> {
        Some(BigInt(IBig::from(n)))
    }
    fn from_u64(n: u64) -> Option<Self> {
        Some(BigInt(IBig::from(n)))
    }
    fn from_i128(n: i128) -> Option<Self> {
        Some(BigInt(IBig::from(n)))
    }
    fn from_u128(n: u128) -> Option<Self> {
        Some(BigInt(IBig::from(n)))
    }
    /// The integer part (toward zero); None for NaN and infinities, as num-bigint.
    fn from_f64(x: f64) -> Option<Self> {
        if !x.is_finite() {
            return None;
        }
        let t = x.trunc();
        if t.abs() < 9.007_199_254_740_992e15 {
            return Some(BigInt(IBig::from(t as i64)));
        }
        // |t| >= 2^53: an integer m 2^e exactly
        let bits = t.abs().to_bits();
        let e = ((bits >> 52) & 0x7ff) as i64 - 1075;
        let m = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
        let mag = IBig::from(m) << e as usize;
        Some(BigInt(if t < 0.0 { -mag } else { mag }))
    }
}
impl num_traits::Pow<u32> for BigInt {
    type Output = BigInt;
    fn pow(self, e: u32) -> BigInt {
        BigInt(self.0.pow(e as usize))
    }
}
impl num_traits::Pow<u32> for &BigInt {
    type Output = BigInt;
    fn pow(self, e: u32) -> BigInt {
        BigInt(self.0.pow(e as usize))
    }
}

// ---- num-integer

impl num_integer::Integer for BigInt {
    fn div_floor(&self, d: &Self) -> Self {
        self.div_mod_floor(d).0
    }
    fn mod_floor(&self, d: &Self) -> Self {
        self.div_mod_floor(d).1
    }
    fn div_mod_floor(&self, d: &Self) -> (Self, Self) {
        let (q, r) = (&self.0).div_rem(&d.0);
        if !r.is_zero() && ((r < IBig::ZERO) != (d.0 < IBig::ZERO)) {
            (BigInt(q - IBig::ONE), BigInt(r + &d.0))
        } else {
            (BigInt(q), BigInt(r))
        }
    }
    fn div_rem(&self, d: &Self) -> (Self, Self) {
        let (q, r) = (&self.0).div_rem(&d.0);
        (BigInt(q), BigInt(r))
    }
    fn gcd(&self, other: &Self) -> Self {
        // dashu panics for gcd(0, 0); num-bigint's is 0
        if self.0.is_zero() && other.0.is_zero() {
            return BigInt(IBig::ZERO);
        }
        let (a, b) = ((&self.0).unsigned_abs(), (&other.0).unsigned_abs());
        if a.bit_len().min(b.bit_len()) >= crate::hgcd::GCD_THRESHOLD_BITS {
            return BigInt(IBig::from(crate::hgcd::gcd(&a, &b)));
        }
        BigInt(IBig::from(a.gcd(&b)))
    }
    fn lcm(&self, other: &Self) -> Self {
        if self.0.is_zero() || other.0.is_zero() {
            return BigInt(IBig::ZERO);
        }
        let g = IBig::from((&self.0).gcd(&other.0));
        BigInt(((&self.0 / g) * &other.0).abs())
    }
    #[allow(deprecated)]
    fn divides(&self, other: &Self) -> bool {
        self.is_multiple_of(other)
    }
    fn is_multiple_of(&self, other: &Self) -> bool {
        if other.0.is_zero() {
            return self.0.is_zero();
        }
        (&self.0 % &other.0).is_zero()
    }
    fn is_even(&self) -> bool {
        !self.0.bit(0)
    }
    fn is_odd(&self) -> bool {
        self.0.bit(0)
    }
    fn extended_gcd(&self, other: &Self) -> num_integer::ExtendedGcd<Self> {
        if self.0.is_zero() && other.0.is_zero() {
            // num-integer's algorithm gives (0, 1, 0)
            return num_integer::ExtendedGcd { gcd: BigInt(IBig::ZERO), x: BigInt(IBig::ONE), y: BigInt(IBig::ZERO) };
        }
        let (g, x, y) = (&self.0).gcd_ext(&other.0);
        num_integer::ExtendedGcd { gcd: BigInt(IBig::from(g)), x: BigInt(x), y: BigInt(y) }
    }
}

impl num_integer::Integer for BigUint {
    fn div_floor(&self, d: &Self) -> Self {
        BigUint(&self.0 / &d.0)
    }
    fn mod_floor(&self, d: &Self) -> Self {
        BigUint(&self.0 % &d.0)
    }
    fn gcd(&self, other: &Self) -> Self {
        if self.0.is_zero() && other.0.is_zero() {
            return BigUint(UBig::ZERO);
        }
        if self.0.bit_len().min(other.0.bit_len()) >= crate::hgcd::GCD_THRESHOLD_BITS {
            return BigUint(crate::hgcd::gcd(&self.0, &other.0));
        }
        BigUint((&self.0).gcd(&other.0))
    }
    fn lcm(&self, other: &Self) -> Self {
        if self.0.is_zero() || other.0.is_zero() {
            return BigUint(UBig::ZERO);
        }
        BigUint(&self.0 / (&self.0).gcd(&other.0) * &other.0)
    }
    #[allow(deprecated)]
    fn divides(&self, other: &Self) -> bool {
        self.is_multiple_of(other)
    }
    fn is_multiple_of(&self, other: &Self) -> bool {
        if other.0.is_zero() {
            return self.0.is_zero();
        }
        (&self.0 % &other.0).is_zero()
    }
    fn is_even(&self) -> bool {
        !self.0.bit(0)
    }
    fn is_odd(&self) -> bool {
        self.0.bit(0)
    }
    fn div_rem(&self, d: &Self) -> (Self, Self) {
        let (q, r) = (&self.0).div_rem(&d.0);
        (BigUint(q), BigUint(r))
    }
}

impl num_integer::Roots for BigInt {
    /// The n-th root, truncated toward zero (num-bigint panics for an even
    /// root of a negative number; so does this).
    fn nth_root(&self, n: u32) -> Self {
        assert!(n > 0, "root degree 0");
        if self.0 < IBig::ZERO {
            assert!(n % 2 == 1, "even root of a negative number");
            return BigInt(-IBig::from((&self.0).unsigned_abs().nth_root(n as usize)));
        }
        BigInt(IBig::from((&self.0).unsigned_abs().nth_root(n as usize)))
    }
    fn sqrt(&self) -> Self {
        BigInt::sqrt(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TryFromBigIntError;
impl fmt::Display for TryFromBigIntError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("out of range conversion from a big integer")
    }
}
impl std::error::Error for TryFromBigIntError {}
macro_rules! try_into_prims {
    ($($p:ty),*) => {$(
        impl TryFrom<BigInt> for $p {
            type Error = TryFromBigIntError;
            fn try_from(x: BigInt) -> Result<$p, TryFromBigIntError> {
                <$p>::try_from(&x.0).map_err(|_| TryFromBigIntError)
            }
        }
        impl TryFrom<&BigInt> for $p {
            type Error = TryFromBigIntError;
            fn try_from(x: &BigInt) -> Result<$p, TryFromBigIntError> {
                <$p>::try_from(&x.0).map_err(|_| TryFromBigIntError)
            }
        }
        impl TryFrom<BigUint> for $p {
            type Error = TryFromBigIntError;
            fn try_from(x: BigUint) -> Result<$p, TryFromBigIntError> {
                <$p>::try_from(&x.0).map_err(|_| TryFromBigIntError)
            }
        }
        impl TryFrom<&BigUint> for $p {
            type Error = TryFromBigIntError;
            fn try_from(x: &BigUint) -> Result<$p, TryFromBigIntError> {
                <$p>::try_from(&x.0).map_err(|_| TryFromBigIntError)
            }
        }
    )*};
}
try_into_prims!(i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize);

/// num-rational's `Ratio::to_f64` goes through num-bigint.
impl num_bigint::ToBigInt for BigInt {
    fn to_bigint(&self) -> Option<num_bigint::BigInt> {
        Some(to_num(self))
    }
}

// ---- inherent methods (num-bigint's names)

const WORD_BITS: u64 = dashu_int::Word::BITS as u64;

fn le_bytes_to_u64(bytes: &[u8]) -> Vec<u64> {
    bytes
        .chunks(8)
        .map(|c| {
            let mut w = [0u8; 8];
            w[..c.len()].copy_from_slice(c);
            u64::from_le_bytes(w)
        })
        .collect()
}

impl BigInt {
    #[inline]
    pub fn bits(&self) -> u64 {
        let w = self.0.as_sign_words().1;
        match w.last() {
            None => 0,
            Some(top) => ((w.len() - 1) as u64) * WORD_BITS + (WORD_BITS - top.leading_zeros() as u64),
        }
    }
    #[inline]
    pub fn pow(&self, e: u32) -> BigInt {
        BigInt(self.0.pow(e as usize))
    }
    /// The integer square root (num-bigint panics on negative input; so does this).
    pub fn sqrt(&self) -> BigInt {
        assert!(self.0 >= IBig::ZERO, "square root of a negative number");
        BigInt(IBig::from((&self.0).unsigned_abs().sqrt()))
    }
    pub fn sign(&self) -> Sign {
        match self.0.cmp(&IBig::ZERO) {
            Ordering::Less => Sign::Minus,
            Ordering::Equal => Sign::NoSign,
            Ordering::Greater => Sign::Plus,
        }
    }
    pub fn magnitude(&self) -> BigUint {
        BigUint((&self.0).unsigned_abs())
    }
    pub fn to_biguint(&self) -> Option<BigUint> {
        if self.0 < IBig::ZERO {
            None
        } else {
            Some(BigUint((&self.0).unsigned_abs()))
        }
    }
    pub fn from_biguint(sign: Sign, mag: BigUint) -> BigInt {
        match sign {
            Sign::Minus => BigInt(-IBig::from(mag.0)),
            Sign::NoSign => BigInt(IBig::ZERO),
            Sign::Plus => BigInt(IBig::from(mag.0)),
        }
    }
    pub fn into_parts(self) -> (Sign, BigUint) {
        (self.sign(), BigUint((&self.0).unsigned_abs()))
    }
    pub fn to_u64_digits(&self) -> (Sign, Vec<u64>) {
        let mut d = le_bytes_to_u64(&(&self.0).unsigned_abs().to_le_bytes());
        while d.last() == Some(&0) {
            d.pop();
        }
        (self.sign(), d)
    }
    pub fn trailing_zeros(&self) -> Option<u64> {
        self.0.trailing_zeros().map(|t| t as u64)
    }
    /// Bit n of the two's complement representation (num-bigint's semantics).
    pub fn bit(&self, n: u64) -> bool {
        if self.0 >= IBig::ZERO {
            (&self.0).unsigned_abs().bit(n as usize)
        } else {
            // -x = ~(x - 1)
            !((&self.0).unsigned_abs() - UBig::ONE).bit(n as usize)
        }
    }
    /// self^e mod m, in [0, m) for m > 0 and (m, 0] for m < 0 (num-bigint's
    /// semantics; it panics for m = 0 or e < 0).
    pub fn modpow(&self, e: &BigInt, m: &BigInt) -> BigInt {
        assert!(e.0 >= IBig::ZERO, "negative exponent");
        assert!(!m.0.is_zero(), "zero modulus");
        let mm = (&m.0).unsigned_abs();
        let ring = dashu_int::fast_div::ConstDivisor::new(mm.clone());
        let base = self.0.clone();
        let eb = (&e.0).unsigned_abs();
        let r = if eb.bit_len() > 1024 && mm.bit_len() > 4096 {
            // a long exponentiation, bit by bit, so that Ctrl-C is observed
            let b = ring.reduce(base);
            let mut acc = ring.reduce(IBig::ONE);
            for i in (0..eb.bit_len()).rev() {
                // (sqr, and never mul with equal operands: dashu 0.6's
                // mul_in_place under-allocates when they are equal)
                acc = acc.sqr();
                if eb.bit(i) {
                    acc = if acc == b { acc.sqr() } else { &acc * &b };
                }
                if i % 16 == 0 {
                    crate::check_interrupt();
                }
            }
            IBig::from(acc.residue())
        } else {
            IBig::from(ring.reduce(base).pow(&eb).residue())
        };
        if m.0 < IBig::ZERO && !r.is_zero() {
            return BigInt(r - IBig::from(mm));
        }
        BigInt(r)
    }
    /// The inverse of self mod m, in [0, m) for m > 0 and (m, 0] for m < 0
    /// (num-bigint's semantics), or None.
    pub fn modinv(&self, m: &BigInt) -> Option<BigInt> {
        if m.0.is_zero() {
            return None;
        }
        let mm = IBig::from((&m.0).unsigned_abs());
        let a = {
            let r = &self.0 % &mm;
            if r < IBig::ZERO { r + &mm } else { r }
        };
        if a.is_zero() {
            return if mm.is_one() { Some(BigInt(IBig::ZERO)) } else { None };
        }
        let (g, x, _) = (&a).gcd_ext(&mm);
        if !g.is_one() {
            return None;
        }
        let mut x = x % &mm;
        if x < IBig::ZERO {
            x += &mm;
        }
        if m.0 < IBig::ZERO && !x.is_zero() {
            x -= &mm;
        }
        Some(BigInt(x))
    }
    pub fn to_str_radix(&self, radix: u32) -> String {
        self.0.in_radix(radix as u8).to_string()
    }
    pub fn parse_bytes(buf: &[u8], radix: u32) -> Option<BigInt> {
        let s = std::str::from_utf8(buf).ok()?;
        IBig::from_str_radix(s.strip_prefix('+').unwrap_or(s), radix).ok().map(BigInt)
    }
    pub fn from_bytes_le(sign: Sign, bytes: &[u8]) -> BigInt {
        BigInt::from_biguint(sign, BigUint(UBig::from_le_bytes(bytes)))
    }
    pub fn to_bytes_le(&self) -> (Sign, Vec<u8>) {
        (self.sign(), (&self.0).unsigned_abs().to_le_bytes().into_vec())
    }
}

impl BigUint {
    #[inline]
    pub fn bits(&self) -> u64 {
        self.0.bit_len() as u64
    }
    #[inline]
    pub fn pow(&self, e: u32) -> BigUint {
        BigUint(self.0.pow(e as usize))
    }
    pub fn sqrt(&self) -> BigUint {
        BigUint(self.0.sqrt())
    }
    pub fn to_u64_digits(&self) -> Vec<u64> {
        let mut d = le_bytes_to_u64(&self.0.to_le_bytes());
        while d.last() == Some(&0) {
            d.pop();
        }
        d
    }
    pub fn from_slice_u64(digits: &[u64]) -> BigUint {
        let bytes: Vec<u8> = digits.iter().flat_map(|w| w.to_le_bytes()).collect();
        BigUint(UBig::from_le_bytes(&bytes))
    }
    pub fn trailing_zeros(&self) -> Option<u64> {
        self.0.trailing_zeros().map(|t| t as u64)
    }
    pub fn bit(&self, n: u64) -> bool {
        self.0.bit(n as usize)
    }
    pub fn modpow(&self, e: &BigUint, m: &BigUint) -> BigUint {
        assert!(!m.0.is_zero(), "zero modulus");
        let ring = dashu_int::fast_div::ConstDivisor::new(m.0.clone());
        BigUint(ring.reduce(self.0.clone()).pow(&e.0).residue())
    }
    pub fn to_str_radix(&self, radix: u32) -> String {
        self.0.in_radix(radix as u8).to_string()
    }
    pub fn parse_bytes(buf: &[u8], radix: u32) -> Option<BigUint> {
        let s = std::str::from_utf8(buf).ok()?;
        UBig::from_str_radix(s.strip_prefix('+').unwrap_or(s), radix).ok().map(BigUint)
    }
    pub fn from_bytes_le(bytes: &[u8]) -> BigUint {
        BigUint(UBig::from_le_bytes(bytes))
    }
    pub fn to_bytes_le(&self) -> Vec<u8> {
        self.0.to_le_bytes().into_vec()
    }
    pub fn to_bigint(&self) -> BigInt {
        BigInt(IBig::from(self.0.clone()))
    }
}

// ---- num-bigint at the boundaries

pub fn to_num(x: &BigInt) -> num_bigint::BigInt {
    let (s, bytes) = x.to_bytes_le();
    let sign = match s {
        Sign::Minus => num_bigint::Sign::Minus,
        Sign::NoSign => num_bigint::Sign::NoSign,
        Sign::Plus => num_bigint::Sign::Plus,
    };
    num_bigint::BigInt::from_bytes_le(sign, &bytes)
}

pub fn from_num(x: &num_bigint::BigInt) -> BigInt {
    let (s, bytes) = x.to_bytes_le();
    let sign = match s {
        num_bigint::Sign::Minus => Sign::Minus,
        num_bigint::Sign::NoSign => Sign::NoSign,
        num_bigint::Sign::Plus => Sign::Plus,
    };
    BigInt::from_bytes_le(sign, &bytes)
}
