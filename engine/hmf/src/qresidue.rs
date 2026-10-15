//! The residue rings O_F / P^e for a prime P of a real quadratic field F
//! (rqf.rs): the representation of residue.rs, for any w^2 = t w + n.
//! With P^e = Z A + Z (B + C w) in Hermite normal form, every residue has
//! a unique representative x + y w with 0 <= x < A and 0 <= y < C (C = 1
//! for split and ramified P, so residues are integers modulo A = p^e for
//! split P; C = A = p^e for inert P).

use crate::field::inv_mod;
use crate::residue::Res;
use crate::rqf::{QElt, QPrime, QuadField, Splitting};
use num_integer::Integer;
use num_traits::ToPrimitive;
use sagebrush_bigint::BigInt;

pub const MAX_LOCAL: u64 = 1 << 31;

/// The fields are private to the crate: a ring is made only by `new`, from
/// a prime of its field.
#[derive(Clone, Debug)]
pub struct QLocalRing {
    pub(crate) f: QuadField,
    pub(crate) prime: QPrime,
    pub(crate) e: u32,
    /// The HNF (A, B, C) of P^e.
    pub(crate) a: u64,
    pub(crate) b: u64,
    pub(crate) c: u64,
    /// #O_F/P^e = A C.
    pub(crate) card: u64,
    /// The residue field size N(P).
    pub(crate) q: u64,
}

impl QLocalRing {
    /// O_F/P^e for a prime P of f (an error for anything else: the prime is
    /// looked up among f.primes_above(P.p), so a QPrime whose public fields
    /// were altered is refused) with N(P)^e < 2^31.
    pub fn new(f: &QuadField, prime: QPrime, e: u32) -> Result<QLocalRing, String> {
        if e == 0 {
            return Err("the exponent must be positive".into());
        }
        f.check(&prime.ideal)?;
        let prime = f.primes_above(prime.p)?.into_iter().find(|q| *q == prime).ok_or("not a prime of this field")?;
        let card = (prime.norm as u128).checked_pow(e).filter(|&c| c < MAX_LOCAL as u128);
        if card.is_none() {
            return Err(format!("O_F/P^e with N(P) = {}, e = {} has more than 2^31 elements", prime.norm, e));
        }
        let mut h = prime.ideal;
        for _ in 1..e {
            h = f.ideal_mul(&h, &prime.ideal)?;
        }
        let (a, b, c) = h.hnf();
        debug_assert_eq!((a * c) as u128, card.unwrap());
        Ok(QLocalRing { f: *f, prime, e, a: a as u64, b: b as u64, c: c as u64, card: (a * c) as u64, q: prime.norm as u64 })
    }
    pub fn prime(&self) -> QPrime {
        self.prime
    }
    pub fn exponent(&self) -> u32 {
        self.e
    }
    /// #O_F/P^e.
    pub fn card(&self) -> u64 {
        self.card
    }
    /// The canonical representative of u (u from another ring, or built by
    /// hand, is reduced first, so the products below cannot overflow).
    #[inline]
    fn canon(&self, u: Res) -> Res {
        if u.0 < self.a && u.1 < self.c {
            u
        } else {
            self.reduce(u.0 as i128, u.1 as i128)
        }
    }

    /// The reduction of x + y w (any x, y: x is reduced modulo A first).
    #[inline]
    pub fn reduce(&self, x: i128, y: i128) -> Res {
        let (a, c) = (self.a as i128, self.c as i128);
        let yr = y.rem_euclid(c);
        let k = (y - yr) / c;
        // |k mod A| < A and B < A < 2^31
        let xr = (x.rem_euclid(a) - (k % a) * self.b as i128).rem_euclid(a);
        Res(xr as u64, yr as u64)
    }
    pub fn from_qelt(&self, x: &QElt) -> Res {
        // reduce modulo A C first (A C lies in P^e), so the coordinates fit
        let m = BigInt::from(self.card);
        let x0 = x.a.mod_floor(&m).to_i128().unwrap();
        let y0 = x.b.mod_floor(&m).to_i128().unwrap();
        self.reduce(x0, y0)
    }
    pub fn lift(&self, x: Res) -> QElt {
        QElt::new(x.0 as i64, x.1 as i64)
    }
    pub fn zero(&self) -> Res {
        Res(0, 0)
    }
    pub fn one(&self) -> Res {
        self.reduce(1, 0)
    }
    pub fn add(&self, u: Res, v: Res) -> Res {
        self.reduce(u.0 as i128 + v.0 as i128, u.1 as i128 + v.1 as i128)
    }
    pub fn sub(&self, u: Res, v: Res) -> Res {
        self.reduce(u.0 as i128 - v.0 as i128, u.1 as i128 - v.1 as i128)
    }
    pub fn neg(&self, u: Res) -> Res {
        self.reduce(-(u.0 as i128), -(u.1 as i128))
    }
    /// (x + y w)(s + r w) = x s + n y r + (x r + y s + t y r) w; the
    /// coordinates are below 2^31 and |n| < 2^40, so this fits in i128.
    pub fn mul(&self, u: Res, v: Res) -> Res {
        let (u, v) = (self.canon(u), self.canon(v));
        let (x, y, s, r) = (u.0 as i128, u.1 as i128, v.0 as i128, v.1 as i128);
        let yr = y * r;
        self.reduce(x * s + self.f.n as i128 * yr, x * r + y * s + self.f.t as i128 * yr)
    }
    pub fn pow(&self, u: Res, mut e: u64) -> Res {
        let (mut r, mut x) = (self.one(), u);
        while e > 0 {
            if e & 1 == 1 {
                r = self.mul(r, x);
            }
            x = self.mul(x, x);
            e >>= 1;
        }
        r
    }
    /// Whether u lies in the maximal ideal P.
    pub fn in_p(&self, u: Res) -> bool {
        self.f.in_ideal(&self.prime.ideal, &self.lift(u))
    }
    pub fn is_unit(&self, u: Res) -> bool {
        !self.in_p(u)
    }
    /// The inverse of a unit: u^-1 = conj(u) N(u)^-1. N(u) is prime to p:
    /// for split P the representative u is an integer, and otherwise P is
    /// the only prime above p.
    pub fn inv(&self, u: Res) -> Option<Res> {
        let u = self.canon(u);
        if self.in_p(u) {
            return None;
        }
        let (x, y) = (u.0 as i128, u.1 as i128);
        let (t, n) = (self.f.t as i128, self.f.n as i128);
        let nm = (x * x + t * x * y - n * y * y).rem_euclid(self.a as i128) as u64;
        let ninv = inv_mod(nm, self.a)? as i128;
        // conj(x + y w) = x + t y - y w
        let v = self.reduce((x + t * y) * ninv, -y * ninv);
        debug_assert_eq!(self.mul(u, v), self.one());
        Some(v)
    }
    /// Elements are indexed by x + A y, 0 <= i < A C (i is taken modulo A C).
    pub fn element(&self, i: u64) -> Res {
        let i = i % self.card;
        Res(i % self.a, i / self.a)
    }

    /// Distinct roots in the residue field O_F/P (this ring must have e = 1)
    /// of T^2 - s T + n, if there are two.
    pub fn distinct_roots(&self, s: Res, n: Res) -> Option<(Res, Res)> {
        assert_eq!(self.e, 1);
        let f = |x: Res| self.add(self.sub(self.mul(x, x), self.mul(s, x)), n);
        if self.q <= 64 || self.prime.p == 2 {
            let roots: Vec<Res> = (0..self.card).map(|i| self.element(i)).filter(|&x| f(x) == self.zero()).collect();
            return if roots.len() == 2 { Some((roots[0], roots[1])) } else { None };
        }
        // odd characteristic: T = (s +- sqrt(s^2 - 4n)) / 2
        let d = self.sub(self.mul(s, s), self.mul(self.reduce(4, 0), n));
        if d == self.zero() {
            return None;
        }
        let r = self.sqrt(d)?;
        let half = self.inv(self.reduce(2, 0)).unwrap();
        let (x1, x2) = (self.mul(self.add(s, r), half), self.mul(self.sub(s, r), half));
        debug_assert!(f(x1) == self.zero() && f(x2) == self.zero());
        Some((x1, x2))
    }

    /// A square root in the residue field of odd order q (Tonelli-Shanks in
    /// the cyclic group of order q - 1), if one exists.
    pub fn sqrt(&self, d: Res) -> Option<Res> {
        assert_eq!(self.e, 1);
        let q = self.q;
        assert!(q % 2 == 1);
        if d == self.zero() {
            return Some(d);
        }
        let one = self.one();
        if self.pow(d, (q - 1) / 2) != one {
            return None;
        }
        let minus_one = self.neg(one);
        let (mut t, mut s) = (q - 1, 0u32);
        while t % 2 == 0 {
            t /= 2;
            s += 1;
        }
        let z = (2..self.card).map(|i| self.element(i)).find(|&z| self.pow(z, (q - 1) / 2) == minus_one)?;
        let (mut m, mut c, mut tt, mut r) = (s, self.pow(z, t), self.pow(d, t), self.pow(d, (t + 1) / 2));
        while tt != one {
            let (mut i, mut x) = (0u32, tt);
            while x != one {
                x = self.mul(x, x);
                i += 1;
            }
            let mut b = c;
            for _ in 0..(m - i - 1) {
                b = self.mul(b, b);
            }
            m = i;
            c = self.mul(b, b);
            tt = self.mul(tt, c);
            r = self.mul(r, b);
        }
        Some(r)
    }

    pub fn kind(&self) -> Splitting {
        self.prime.kind
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic_agrees_with_o_f() {
        for d in [2i64, 3, 13, 17, 106, 401] {
            let f = QuadField::new(d).unwrap();
            for p in [2i64, 3, 5, 7, 11, 13, 53] {
                for pr in f.primes_above(p).unwrap() {
                    for e in 1..=3u32 {
                        if (pr.norm as u128).pow(e) > 20000 {
                            continue;
                        }
                        let r = QLocalRing::new(&f, pr, e).unwrap();
                        let mut ideal = pr.ideal;
                        for _ in 1..e {
                            ideal = f.ideal_mul(&ideal, &pr.ideal).unwrap();
                        }
                        let xs: Vec<QElt> = (0..r.card).step_by(((r.card / 30) as usize).max(1)).map(|i| r.lift(r.element(i))).chain([QElt::new(-7, 12345), QElt::new(99991, -3)]).collect();
                        for x in &xs {
                            for y in &xs {
                                let (u, v) = (r.from_qelt(x), r.from_qelt(y));
                                assert!(f.in_ideal(&ideal, &f.sub(&r.lift(r.mul(u, v)), &f.mul(x, y))));
                                assert!(f.in_ideal(&ideal, &f.sub(&r.lift(r.add(u, v)), &f.add(x, y))));
                            }
                            let u = r.from_qelt(x);
                            assert_eq!(r.in_p(u), f.in_ideal(&pr.ideal, x));
                            match r.inv(u) {
                                Some(v) => assert_eq!(r.mul(u, v), r.one()),
                                None => assert!(r.in_p(u)),
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn square_roots() {
        let f = QuadField::new(13).unwrap();
        for p in [3i64, 5, 7, 11, 101, 1009] {
            for pr in f.primes_above(p).unwrap() {
                let k = QLocalRing::new(&f, pr, 1).unwrap();
                for i in 0..k.card.min(300) {
                    let x = k.element(i);
                    let s = k.mul(x, x);
                    let r = k.sqrt(s).unwrap();
                    assert_eq!(k.mul(r, r), s);
                }
            }
        }
    }

    #[test]
    fn forged_inputs() {
        let f = QuadField::new(13).unwrap();
        let mut p = f.primes_above(3).unwrap()[0];
        let r = QLocalRing::new(&f, p, 2).unwrap();
        // residues out of range are reduced, never overflowing
        let big = crate::residue::Res(u64::MAX, u64::MAX);
        let x = r.mul(big, big);
        assert_eq!(x, r.mul(r.reduce(u64::MAX as i128, u64::MAX as i128), r.reduce(u64::MAX as i128, u64::MAX as i128)));
        // reduce(i128::MIN, i128::MIN) is congruent to MIN + MIN w modulo P^2
        let m = r.reduce(i128::MIN, i128::MIN);
        let exact = QElt { a: BigInt::from(i128::MIN), b: BigInt::from(i128::MIN) };
        let p2 = f.ideal_mul(&p.ideal, &p.ideal).unwrap();
        assert!(m.0 < r.a && m.1 < r.c && f.in_ideal(&p2, &f.sub(&r.lift(m), &exact)));
        // an altered prime, and a prime of another field, are refused
        p.norm = 2;
        assert!(QLocalRing::new(&f, p, 1).is_err());
        let q = QuadField::new(5).unwrap().primes_above(11).unwrap()[0];
        assert!(QLocalRing::new(&f, q, 1).is_err());
    }
}
