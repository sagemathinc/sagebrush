//! Natural numbers: sagebrush-bigint's (dashu's limbs, with the NTT for
//! huge products on 64-bit targets), the engines' one big-integer
//! implementation, under the core's resource contract: every result is
//! admitted first, against the call's limb limit (the session's precision
//! limit, set by the host) and then against the heap, so a number too large
//! for the call is the call's refusal (design/mpmath-core.md §4.5), recorded
//! as the call's failure (fail.rs), the number made zero.  Limbs, at the
//! call boundary, are u64s, little-endian, whatever the word size inside.

use crate::fail::{raise, too_big};
use crate::Fail;
use core::cmp::Ordering;
use dashu_base::{BitTest, DivRem};
use dashu_int::{UBig, Word};
use sagebrush_bigint::BigUint;
use std::cell::Cell;

thread_local! {
    /// The most limbs any one number may have in this call (the host sets it
    /// from the session's limits before each call).
    static MAX_LIMBS: Cell<usize> = const { Cell::new(1 << 22) };
}

pub fn set_max_limbs(n: usize) {
    let _ = MAX_LIMBS.try_with(|m| m.set(n));
}

pub fn max_limbs() -> usize {
    MAX_LIMBS.try_with(|m| m.get()).unwrap_or(0)
}

/// Whether a result of n limbs may be made: Stop polled (every long loop
/// makes numbers at each step, §4.5), the limb limit, and for a large one
/// the heap, probed with a fallible reservation of its size.
fn room(n: usize) -> bool {
    sagebrush_interrupt::check();
    if n > max_limbs() {
        raise(Fail::Limit { limbs: n as u64 });
        return false;
    }
    if n >= 256 {
        let mut v: Vec<u64> = Vec::new();
        if v.try_reserve_exact(2 * n).is_err() {
            raise(Fail::Memory { bytes: (n as u64).saturating_mul(16) });
            return false;
        }
    }
    true
}

/// dashu's word: u64 on 64-bit targets, u32 in wasm32.
const WORD_BYTES: usize = core::mem::size_of::<Word>();

/// u64 limbs as dashu's words.
fn words_of(src: &[u64]) -> Vec<Word> {
    if WORD_BYTES == 8 {
        return src.iter().map(|&x| x as Word).collect();
    }
    src.iter().flat_map(|&x| [x as Word, (x >> 32) as Word]).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Nat {
    d: BigUint,
}

impl Nat {
    pub const fn zero() -> Nat {
        Nat { d: BigUint(UBig::ZERO) }
    }

    fn of(d: UBig) -> Nat {
        Nat { d: BigUint(d) }
    }

    pub fn from_u64(x: u64) -> Nat {
        Nat::of(UBig::from(x))
    }

    pub fn from_u128(x: u128) -> Nat {
        Nat::of(UBig::from(x))
    }

    pub fn from_limbs(src: &[u64]) -> Nat {
        if !room(src.len()) {
            return Nat::zero();
        }
        Nat::of(UBig::from_words(&words_of(src)))
    }

    /// The value's u64 limbs, little-endian, with no leading zero limb.
    pub fn limbs(&self) -> Vec<u64> {
        let w = self.d.0.as_words();
        if WORD_BYTES == 8 {
            return w.iter().map(|&x| x as u64).collect();
        }
        w.chunks(2).map(|c| c[0] as u64 | c.get(1).map_or(0, |&h| (h as u64) << 32)).collect()
    }

    /// The number of u64 limbs.
    pub fn len(&self) -> usize {
        self.bits().div_ceil(64) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.is_zero()
    }

    pub fn is_zero(&self) -> bool {
        self.d.0.is_zero()
    }

    /// The value, if it fits in a u64.
    pub fn to_u64(&self) -> Option<u64> {
        u64::try_from(&self.d.0).ok()
    }

    pub fn to_u128(&self) -> Option<u128> {
        u128::try_from(&self.d.0).ok()
    }

    /// The bit length (Python's int.bit_length()).
    pub fn bits(&self) -> u64 {
        self.d.0.bit_len() as u64
    }

    pub fn bit(&self, i: u64) -> bool {
        usize::try_from(i).is_ok_and(|i| self.d.0.bit(i))
    }

    pub fn is_odd(&self) -> bool {
        self.bit(0)
    }

    /// Whether any of the lowest k bits is set.
    pub fn low_nonzero(&self, k: u64) -> bool {
        self.d.0.trailing_zeros().is_some_and(|t| (t as u64) < k)
    }

    /// The number of trailing zero bits (0 for zero).
    pub fn trailing_zeros(&self) -> u64 {
        self.d.0.trailing_zeros().unwrap_or(0) as u64
    }

    pub fn shr(&self, k: u64) -> Nat {
        if k >= self.bits() {
            return Nat::zero();
        }
        if !room((self.bits() - k).div_ceil(64) as usize) {
            return Nat::zero();
        }
        Nat::of(&self.d.0 >> k as usize)
    }

    pub fn shl(&self, k: u64) -> Nat {
        if self.is_zero() {
            return Nat::zero();
        }
        let Some(n) = self.bits().checked_add(k).and_then(|b| usize::try_from(b.div_ceil(64)).ok()) else {
            too_big();
            return Nat::zero();
        };
        if !room(n) {
            return Nat::zero();
        }
        Nat::of(&self.d.0 << k as usize)
    }

    pub fn cmp_mag(&self, o: &Nat) -> Ordering {
        self.d.0.cmp(&o.d.0)
    }

    pub fn add(&self, o: &Nat) -> Nat {
        if !room(self.len().max(o.len()) + 1) {
            return Nat::zero();
        }
        Nat::of(&self.d.0 + &o.d.0)
    }

    pub fn add_u64(&self, x: u64) -> Nat {
        self.add(&Nat::from_u64(x))
    }

    /// self - o, for self >= o (after a failure, whatever its operands).
    pub fn sub(&self, o: &Nat) -> Nat {
        if self.cmp_mag(o) == Ordering::Less || !room(self.len()) {
            return Nat::zero();
        }
        Nat::of(&self.d.0 - &o.d.0)
    }

    pub fn sub_u64(&self, x: u64) -> Nat {
        self.sub(&Nat::from_u64(x))
    }

    pub fn mul(&self, o: &Nat) -> Nat {
        if self.is_zero() || o.is_zero() || !room(self.len() + o.len()) {
            return Nat::zero();
        }
        // (sagebrush-bigint's product: the NTT for huge operands)
        Nat { d: &self.d * &o.d }
    }

    pub fn mul_u64(&self, x: u64) -> Nat {
        if self.is_zero() || x == 0 || !room(self.len() + 1) {
            return Nat::zero();
        }
        Nat::of(&self.d.0 * x)
    }

    /// (self // o, self % o).  A zero o is the reference's ZeroDivisionError.
    pub fn divmod(&self, o: &Nat) -> (Nat, Nat) {
        if o.is_zero() {
            raise(Fail::ZeroDivision);
            return (Nat::zero(), Nat::zero());
        }
        if self.cmp_mag(o) == Ordering::Less {
            return (Nat::zero(), self.clone());
        }
        if !room(self.len() + 1) {
            return (Nat::zero(), Nat::zero());
        }
        let (q, r) = (&self.d.0).div_rem(&o.d.0);
        (Nat::of(q), Nat::of(r))
    }

    /// (floor(sqrt(self)), self - floor(sqrt(self))^2), exact.
    pub fn sqrtrem(&self) -> (Nat, Nat) {
        if self.is_zero() || !room(self.len()) {
            return (Nat::zero(), Nat::zero());
        }
        let s = self.d.sqrt().0;
        let r = &self.d.0 - &s * &s;
        (Nat::of(s), Nat::of(r))
    }
}

impl Nat {
    /// float(self): CPython's int-to-float conversion, rounded to nearest
    /// with ties to even (infinity past the double range; the callers stay
    /// far below it).
    pub fn to_f64(&self) -> f64 {
        let bits = self.bits();
        if bits <= 53 {
            return self.to_u64().map_or(0.0, |x| x as f64);
        }
        if bits > 1024 {
            return f64::INFINITY;
        }
        // the top 54 bits, and whether any bit below them is set
        let shift = bits - 54;
        let top = self.shr(shift).to_u64().unwrap_or(0);
        let sticky = self.low_nonzero(shift);
        let mut m = top >> 1;
        let half = top & 1 == 1;
        if half && (sticky || m & 1 == 1) {
            m += 1;
        }
        // m < 2^54 now; m * 2^(shift + 1) exactly
        let e = (shift + 1) as i32;
        if e >= 1024 {
            return f64::INFINITY;
        }
        (m as f64) * 2f64.powi(e)
    }

    /// int(x) for a finite x >= 0: its integer part.
    pub fn from_f64_trunc(x: f64) -> Nat {
        let x = x.trunc();
        if !(x >= 1.0) {
            return Nat::zero();
        }
        let b = x.to_bits();
        let e = ((b >> 52) & 0x7ff) as i64 - 1075;
        let m = (b & ((1u64 << 52) - 1)) | (1u64 << 52);
        let n = Nat::from_u64(m);
        if e >= 0 {
            n.shl(e as u64)
        } else {
            n.shr((-e) as u64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(x: u128) -> Nat {
        Nat::from_u128(x)
    }

    #[test]
    fn small_arithmetic() {
        assert_eq!(n(5).add(&n(7)), n(12));
        assert_eq!(n(u64::MAX as u128).add(&n(1)), n(1 << 64));
        assert_eq!(n(1 << 64).sub(&n(1)), n(u64::MAX as u128));
        assert_eq!(n(1 << 70).shr(70), n(1));
        assert_eq!(n(3).shl(100).bits(), 102);
        assert_eq!(n(0b1011000).trailing_zeros(), 3);
        assert!(n(0b1011000).low_nonzero(4));
        assert!(!n(0b1011000).low_nonzero(3));
        assert!(n(1 << 70).low_nonzero(71));
        assert!(!n(1 << 70).low_nonzero(70));
        let (q, r) = n(1_000_000_007u128 * 998_244_353 + 17).divmod(&n(998_244_353));
        assert_eq!((q, r), (n(1_000_000_007), n(17)));
        let (s, r) = n(1u128 << 100).add(&n(5)).sqrtrem();
        assert_eq!((s, r), (n(1 << 50), n(5)));
    }

    #[test]
    fn big_division_karatsuba_and_sqrt_are_exact() {
        // deterministic pseudo-random limbs
        let mut s = 0x9e3779b97f4a7c15u64;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for &(la, lb) in &[(3, 2), (40, 33), (70, 35), (31, 32), (32, 32), (33, 32), (90, 90)] {
            let a = Nat::from_limbs(&(0..la).map(|_| rnd()).collect::<Vec<_>>());
            let b = Nat::from_limbs(&(0..lb).map(|_| rnd()).collect::<Vec<_>>());
            let p = a.mul(&b);
            let mut school = vec![0u64; la + lb];
            for (i, &x) in a.limbs().iter().enumerate() {
                let mut c: u128 = 0;
                for (j, &y) in b.limbs().iter().enumerate() {
                    let t = x as u128 * y as u128 + school[i + j] as u128 + c;
                    school[i + j] = t as u64;
                    c = t >> 64;
                }
                school[i + b.len()] = c as u64;
            }
            assert_eq!(p, Nat::from_limbs(&school), "{} x {}", la, lb);
            let p2 = p.add(&n(12345));
            let (q, r) = p2.divmod(&b);
            assert_eq!(q.mul(&b).add(&r), p2);
            assert_eq!(r.cmp_mag(&b), Ordering::Less);
            let (sq, rem) = p.sqrtrem();
            let s1 = sq.add(&n(1));
            assert_eq!(s1.mul(&s1).cmp_mag(&p), Ordering::Greater);
            assert_eq!(sq.mul(&sq).add(&rem), p);
        }
    }

    #[test]
    fn the_limb_limit_refuses_before_allocating() {
        set_max_limbs(4);
        let r = crate::fail::checked(|| n(1).shl(64 * 10));
        set_max_limbs(1 << 22);
        assert!(matches!(r, Err(Fail::Limit { .. })));
    }
}
