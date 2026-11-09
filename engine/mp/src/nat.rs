//! Natural numbers as little-endian u64 limbs with no leading zero limb (zero
//! is the empty vector).  Every allocation is checked first: against the
//! call's limb limit (the session's precision limit, set by the host), then
//! fallibly against the heap, so a number too large for the call is the
//! call's refusal, never an abort (design/mpmath-core.md §4.5).

use crate::Fail;
use core::cmp::Ordering;
use std::cell::Cell;

thread_local! {
    /// The most limbs any one number may have in this call (the host sets it
    /// from the session's limits before each call).
    static MAX_LIMBS: Cell<usize> = const { Cell::new(1 << 22) };
}

pub fn set_max_limbs(n: usize) {
    MAX_LIMBS.with(|m| m.set(n));
}

pub fn max_limbs() -> usize {
    MAX_LIMBS.with(|m| m.get())
}

/// Products at and above this many limbs (in both operands) use Karatsuba.
pub const KARATSUBA: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Nat {
    d: Vec<u64>,
}

/// A vector for n limbs, checked against the limit and the heap.
fn limbs(n: usize) -> Result<Vec<u64>, Fail> {
    if n > max_limbs() {
        return Err(Fail::Limit { limbs: n as u64 });
    }
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| Fail::Memory { bytes: (n as u64).saturating_mul(8) })?;
    Ok(v)
}

fn zeros(n: usize) -> Result<Vec<u64>, Fail> {
    let mut v = limbs(n)?;
    v.resize(n, 0);
    Ok(v)
}

impl Nat {
    pub fn zero() -> Nat {
        Nat { d: Vec::new() }
    }

    fn from_vec(mut d: Vec<u64>) -> Nat {
        while d.last() == Some(&0) {
            d.pop();
        }
        Nat { d }
    }

    pub fn from_u64(x: u64) -> Nat {
        Nat::from_vec(vec![x])
    }

    pub fn from_u128(x: u128) -> Nat {
        Nat::from_vec(vec![x as u64, (x >> 64) as u64])
    }

    pub fn from_limbs(src: &[u64]) -> Result<Nat, Fail> {
        let mut v = limbs(src.len())?;
        v.extend_from_slice(src);
        Ok(Nat::from_vec(v))
    }

    pub fn limbs(&self) -> &[u64] {
        &self.d
    }

    pub fn len(&self) -> usize {
        self.d.len()
    }

    pub fn is_empty(&self) -> bool {
        self.d.is_empty()
    }

    pub fn is_zero(&self) -> bool {
        self.d.is_empty()
    }

    /// The value, if it fits in a u64.
    pub fn to_u64(&self) -> Option<u64> {
        match self.d.len() {
            0 => Some(0),
            1 => Some(self.d[0]),
            _ => None,
        }
    }

    pub fn to_u128(&self) -> Option<u128> {
        match self.d.len() {
            0 => Some(0),
            1 => Some(self.d[0] as u128),
            2 => Some(self.d[0] as u128 | (self.d[1] as u128) << 64),
            _ => None,
        }
    }

    /// The bit length (Python's int.bit_length()).
    pub fn bits(&self) -> u64 {
        match self.d.last() {
            None => 0,
            Some(&top) => (self.d.len() as u64 - 1) * 64 + (64 - top.leading_zeros() as u64),
        }
    }

    pub fn bit(&self, i: u64) -> bool {
        let w = (i / 64) as usize;
        w < self.d.len() && (self.d[w] >> (i % 64)) & 1 == 1
    }

    pub fn is_odd(&self) -> bool {
        self.bit(0)
    }

    /// Whether any of the lowest k bits is set.
    pub fn low_nonzero(&self, k: u64) -> bool {
        let w = (k / 64) as usize;
        let r = k % 64;
        if self.d[..w.min(self.d.len())].iter().any(|&x| x != 0) {
            return true;
        }
        r != 0 && w < self.d.len() && self.d[w] & ((1u64 << r) - 1) != 0
    }

    /// The number of trailing zero bits (0 for zero).
    pub fn trailing_zeros(&self) -> u64 {
        for (i, &x) in self.d.iter().enumerate() {
            if x != 0 {
                return i as u64 * 64 + x.trailing_zeros() as u64;
            }
        }
        0
    }

    pub fn shr(&self, k: u64) -> Result<Nat, Fail> {
        let w = usize::try_from(k / 64).unwrap_or(usize::MAX);
        let r = (k % 64) as u32;
        if w >= self.d.len() {
            return Ok(Nat::zero());
        }
        let m = self.d.len() - w;
        let mut v = limbs(m)?;
        for i in 0..m {
            let lo = self.d[i + w] >> r;
            let hi = if r != 0 && i + w + 1 < self.d.len() { self.d[i + w + 1] << (64 - r) } else { 0 };
            v.push(lo | hi);
        }
        Ok(Nat::from_vec(v))
    }

    pub fn shl(&self, k: u64) -> Result<Nat, Fail> {
        if self.is_zero() {
            return Ok(Nat::zero());
        }
        let w = usize::try_from(k / 64).map_err(|_| Fail::Limit { limbs: u64::MAX })?;
        let r = (k % 64) as u32;
        let n = self.d.len().checked_add(w).and_then(|n| n.checked_add(1)).ok_or(Fail::Limit { limbs: u64::MAX })?;
        let mut v = zeros(n)?;
        for (i, &x) in self.d.iter().enumerate() {
            v[i + w] |= x << r;
            if r != 0 {
                v[i + w + 1] |= x >> (64 - r);
            }
        }
        Ok(Nat::from_vec(v))
    }

    pub fn cmp_mag(&self, o: &Nat) -> Ordering {
        if self.d.len() != o.d.len() {
            return self.d.len().cmp(&o.d.len());
        }
        for i in (0..self.d.len()).rev() {
            if self.d[i] != o.d[i] {
                return self.d[i].cmp(&o.d[i]);
            }
        }
        Ordering::Equal
    }

    pub fn add(&self, o: &Nat) -> Result<Nat, Fail> {
        let (a, b) = if self.d.len() >= o.d.len() { (&self.d, &o.d) } else { (&o.d, &self.d) };
        let mut v = limbs(a.len() + 1)?;
        let mut c = false;
        for i in 0..a.len() {
            let (s1, c1) = a[i].overflowing_add(if i < b.len() { b[i] } else { 0 });
            let (s2, c2) = s1.overflowing_add(c as u64);
            v.push(s2);
            c = c1 | c2;
        }
        v.push(c as u64);
        Ok(Nat::from_vec(v))
    }

    pub fn add_u64(&self, x: u64) -> Result<Nat, Fail> {
        self.add(&Nat::from_u64(x))
    }

    /// self - o, for self >= o.
    pub fn sub(&self, o: &Nat) -> Result<Nat, Fail> {
        debug_assert!(self.cmp_mag(o) != Ordering::Less);
        let mut v = limbs(self.d.len())?;
        let mut br = false;
        for i in 0..self.d.len() {
            let (d1, b1) = self.d[i].overflowing_sub(if i < o.d.len() { o.d[i] } else { 0 });
            let (d2, b2) = d1.overflowing_sub(br as u64);
            v.push(d2);
            br = b1 | b2;
        }
        Ok(Nat::from_vec(v))
    }

    pub fn sub_u64(&self, x: u64) -> Result<Nat, Fail> {
        self.sub(&Nat::from_u64(x))
    }

    pub fn mul(&self, o: &Nat) -> Result<Nat, Fail> {
        if self.is_zero() || o.is_zero() {
            return Ok(Nat::zero());
        }
        let n = self.d.len() + o.d.len();
        let mut v = zeros(n)?;
        mul_into(&self.d, &o.d, &mut v)?;
        Ok(Nat::from_vec(v))
    }

    pub fn mul_u64(&self, x: u64) -> Result<Nat, Fail> {
        self.mul(&Nat::from_u64(x))
    }

    /// (self // o, self % o), o nonzero: Knuth's algorithm D (TAOCP 4.3.1).
    pub fn divmod(&self, o: &Nat) -> Result<(Nat, Nat), Fail> {
        assert!(!o.is_zero(), "division by zero");
        if self.cmp_mag(o) == Ordering::Less {
            return Ok((Nat::zero(), self.clone()));
        }
        if o.d.len() == 1 {
            let dv = o.d[0] as u128;
            let mut q = zeros(self.d.len())?;
            let mut r: u128 = 0;
            for i in (0..self.d.len()).rev() {
                let cur = (r << 64) | self.d[i] as u128;
                q[i] = (cur / dv) as u64;
                r = cur % dv;
            }
            return Ok((Nat::from_vec(q), Nat::from_u64(r as u64)));
        }
        // normalize so that the divisor's top bit is set
        let s = o.d.last().copied().unwrap_or(1).leading_zeros() as u64;
        let v = o.shl(s)?;
        let mut u = self.shl(s)?.d;
        while u.len() < self.d.len() + 1 {
            u.push(0);
        }
        let n = v.d.len();
        let m = u.len() - n;
        let mut q = zeros(m)?;
        let vt = v.d[n - 1] as u128;
        let vs = v.d[n - 2] as u128;
        let b: u128 = 1 << 64;
        for j in (0..m).rev() {
            let num = ((u[j + n] as u128) << 64) | u[j + n - 1] as u128;
            let mut qh = num / vt;
            let mut rh = num % vt;
            while qh >= b || qh * vs > ((rh << 64) | u[j + n - 2] as u128) {
                qh -= 1;
                rh += vt;
                if rh >= b {
                    break;
                }
            }
            // u[j..=j+n] -= qh * v
            let mut borrow: i128 = 0;
            let mut carry: u128 = 0;
            for i in 0..n {
                let p = qh * v.d[i] as u128 + carry;
                carry = p >> 64;
                let t = u[i + j] as i128 - (p as u64) as i128 + borrow;
                u[i + j] = t as u64;
                borrow = t >> 64;
            }
            let t = u[j + n] as i128 - carry as i128 + borrow;
            u[j + n] = t as u64;
            if t < 0 {
                // qh was one too large: add v back
                qh -= 1;
                let mut c: u128 = 0;
                for i in 0..n {
                    let s2 = u[i + j] as u128 + v.d[i] as u128 + c;
                    u[i + j] = s2 as u64;
                    c = s2 >> 64;
                }
                u[j + n] = u[j + n].wrapping_add(c as u64);
            }
            q[j] = qh as u64;
        }
        u.truncate(n);
        let r = Nat::from_vec(u).shr(s)?;
        Ok((Nat::from_vec(q), r))
    }

    /// (floor(sqrt(self)), self - floor(sqrt(self))^2), exact: Newton's
    /// iteration from a start at or above the root.
    pub fn sqrtrem(&self) -> Result<(Nat, Nat), Fail> {
        if self.is_zero() {
            return Ok((Nat::zero(), Nat::zero()));
        }
        let mut x = Nat::from_u64(1).shl(self.bits().div_ceil(2))?;
        loop {
            let (q, _) = self.divmod(&x)?;
            let y = x.add(&q)?.shr(1)?;
            if y.cmp_mag(&x) != Ordering::Less {
                break;
            }
            x = y;
        }
        let r = self.sub(&x.mul(&x)?)?;
        Ok((x, r))
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
        let top = self.shr(shift).ok().and_then(|t| t.to_u64()).unwrap_or(0);
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
    pub fn from_f64_trunc(x: f64) -> Result<Nat, Fail> {
        let x = x.trunc();
        if x < 1.0 {
            return Ok(Nat::zero());
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

/// out (zeroed, a.len() + b.len() limbs) = a * b.
fn mul_into(a: &[u64], b: &[u64], out: &mut [u64]) -> Result<(), Fail> {
    if a.len() >= KARATSUBA && b.len() >= KARATSUBA {
        return karatsuba(a, b, out);
    }
    for (i, &x) in a.iter().enumerate() {
        if x == 0 {
            continue;
        }
        let mut c: u128 = 0;
        let xi = x as u128;
        for (j, &y) in b.iter().enumerate() {
            let t = xi * y as u128 + out[i + j] as u128 + c;
            out[i + j] = t as u64;
            c = t >> 64;
        }
        let mut k = i + b.len();
        while c != 0 {
            let t = out[k] as u128 + c;
            out[k] = t as u64;
            c = t >> 64;
            k += 1;
        }
    }
    Ok(())
}

/// out += x at limb offset `at` (out long enough to hold the sum).
fn add_at(out: &mut [u64], x: &[u64], at: usize) {
    let mut c = false;
    let mut i = 0;
    while i < x.len() || c {
        let (s1, c1) = out[at + i].overflowing_add(if i < x.len() { x[i] } else { 0 });
        let (s2, c2) = s1.overflowing_add(c as u64);
        out[at + i] = s2;
        c = c1 | c2;
        i += 1;
    }
}

/// Karatsuba: split at k limbs; z1 = (a0 + a1)(b0 + b1) - z0 - z2.
fn karatsuba(a: &[u64], b: &[u64], out: &mut [u64]) -> Result<(), Fail> {
    let k = a.len().max(b.len()).div_ceil(2);
    let split = |x: &[u64]| -> Result<(Nat, Nat), Fail> {
        if x.len() <= k {
            Ok((Nat::from_limbs(x)?, Nat::zero()))
        } else {
            Ok((Nat::from_limbs(&x[..k])?, Nat::from_limbs(&x[k..])?))
        }
    };
    let (a0, a1) = split(a)?;
    let (b0, b1) = split(b)?;
    let z0 = a0.mul(&b0)?;
    let z2 = a1.mul(&b1)?;
    let z1 = a0.add(&a1)?.mul(&b0.add(&b1)?)?.sub(&z0)?.sub(&z2)?;
    add_at(out, &z0.d, 0);
    add_at(out, &z1.d, k);
    add_at(out, &z2.d, 2 * k);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(x: u128) -> Nat {
        Nat::from_u128(x)
    }

    #[test]
    fn small_arithmetic() {
        assert_eq!(n(5).add(&n(7)).unwrap(), n(12));
        assert_eq!(n(u64::MAX as u128).add(&n(1)).unwrap(), n(1 << 64));
        assert_eq!(n(1 << 64).sub(&n(1)).unwrap(), n(u64::MAX as u128));
        assert_eq!(n(1 << 70).shr(70).unwrap(), n(1));
        assert_eq!(n(3).shl(100).unwrap().bits(), 102);
        assert_eq!(n(0b1011000).trailing_zeros(), 3);
        assert!(n(0b1011000).low_nonzero(4));
        assert!(!n(0b1011000).low_nonzero(3));
        assert!(n(1 << 70).low_nonzero(71));
        assert!(!n(1 << 70).low_nonzero(70));
        let (q, r) = n(1_000_000_007u128 * 998_244_353 + 17).divmod(&n(998_244_353)).unwrap();
        assert_eq!((q, r), (n(1_000_000_007), n(17)));
        let (s, r) = n(1u128 << 100).add(&n(5)).unwrap().sqrtrem().unwrap();
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
            let a = Nat::from_vec((0..la).map(|_| rnd()).collect());
            let b = Nat::from_vec((0..lb).map(|_| rnd()).collect());
            let p = a.mul(&b).unwrap();
            let mut school = vec![0u64; la + lb];
            for (i, &x) in a.d.iter().enumerate() {
                let mut c: u128 = 0;
                for (j, &y) in b.d.iter().enumerate() {
                    let t = x as u128 * y as u128 + school[i + j] as u128 + c;
                    school[i + j] = t as u64;
                    c = t >> 64;
                }
                school[i + b.d.len()] = c as u64;
            }
            assert_eq!(p, Nat::from_vec(school), "{} x {}", la, lb);
            let p2 = p.add(&n(12345)).unwrap();
            let (q, r) = p2.divmod(&b).unwrap();
            assert_eq!(q.mul(&b).unwrap().add(&r).unwrap(), p2);
            assert_eq!(r.cmp_mag(&b), Ordering::Less);
            let (sq, rem) = p.sqrtrem().unwrap();
            let s1 = sq.add(&n(1)).unwrap();
            assert_eq!(s1.mul(&s1).unwrap().cmp_mag(&p), Ordering::Greater);
            assert_eq!(sq.mul(&sq).unwrap().add(&rem).unwrap(), p);
        }
    }

    #[test]
    fn the_limb_limit_refuses_before_allocating() {
        set_max_limbs(4);
        let r = n(1).shl(64 * 10);
        set_max_limbs(1 << 22);
        assert!(matches!(r, Err(Fail::Limit { .. })));
    }
}
