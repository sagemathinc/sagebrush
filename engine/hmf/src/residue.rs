//! The residue rings O_F / P^e for a prime P of O_F = Z[w].
//!
//! PSAGE (sqrt5_fast.pyx; Bober et al. 2012, section 2.2) used four
//! representations: Z/p^e for split P, (Z/p^e)[x]/(x^2 - x - 1) for inert
//! P and for even powers of P = (sqrt 5), and pairs a + b sqrt 5 for odd
//! powers of (sqrt 5). All four are instances of one: O_F/P^e is
//! Z^2 / L for the lattice L of P^e, and with L = Z A + Z (B + C w) in
//! Hermite normal form (field::Hnf) every residue has a unique
//! representative x + y w with 0 <= x < A, 0 <= y < C. (Split: C = 1;
//! inert and even ramified: A = C, B = 0; odd ramified: C = A/5.) We use
//! that one representation.
//!
//! The maximal ideal P/P^e is enumerated for the projective line
//! (p1.rs): for split and ramified P (whose HNF has C = 1) its elements are
//! x + y w with x = y B_P mod A_P; for inert P they are p(x' + y' w).

use crate::field::{inv_mod, Elt, Hnf, Kind, Prime};

/// x + y w with 0 <= x < A, 0 <= y < C.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Res(pub u64, pub u64);

#[derive(Clone, Debug)]
pub struct LocalRing {
    pub prime: Prime,
    pub e: u32,
    /// The HNF (A, B, C) of P^e.
    pub a: u64,
    pub b: u64,
    pub c: u64,
    /// #O_F/P^e = A C.
    pub card: u64,
    /// The residue field size N(P).
    pub q: u64,
}

pub const MAX_LOCAL: u64 = 1 << 31;

impl LocalRing {
    pub fn new(prime: Prime, e: u32) -> Result<LocalRing, String> {
        let card = (prime.norm as u128).checked_pow(e).filter(|&c| c < MAX_LOCAL as u128);
        if card.is_none() {
            return Err(format!("O_F/P^e with N(P) = {}, e = {} has more than 2^31 elements", prime.norm, e));
        }
        let h = Hnf::principal(prime.gen.pow(e));
        Ok(LocalRing { prime, e, a: h.a, b: h.b, c: h.c, card: h.a * h.c, q: prime.norm })
    }

    /// The reduction of x + y w.
    #[inline]
    pub fn reduce(&self, x: i128, y: i128) -> Res {
        let c = self.c as i128;
        let yr = y.rem_euclid(c);
        let k = (y - yr) / c;
        let xr = (x - (k % self.a as i128) * self.b as i128).rem_euclid(self.a as i128);
        Res(xr as u64, yr as u64)
    }
    pub fn from_elt(&self, x: Elt) -> Res {
        self.reduce(x.a as i128, x.b as i128)
    }
    pub fn lift(&self, x: Res) -> Elt {
        Elt::new(x.0 as i64, x.1 as i64)
    }
    pub fn zero(&self) -> Res {
        Res(0, 0)
    }
    pub fn one(&self) -> Res {
        self.reduce(1, 0)
    }
    #[inline]
    pub fn add(&self, u: Res, v: Res) -> Res {
        self.reduce(u.0 as i128 + v.0 as i128, u.1 as i128 + v.1 as i128)
    }
    #[inline]
    pub fn sub(&self, u: Res, v: Res) -> Res {
        self.reduce(u.0 as i128 - v.0 as i128, u.1 as i128 - v.1 as i128)
    }
    pub fn neg(&self, u: Res) -> Res {
        self.reduce(-(u.0 as i128), -(u.1 as i128))
    }
    /// (x + y w)(x' + y' w) = x x' + y y' + (x y' + x' y + y y') w.
    #[inline]
    pub fn mul(&self, u: Res, v: Res) -> Res {
        let (x, y, s, t) = (u.0 as i128, u.1 as i128, v.0 as i128, v.1 as i128);
        self.reduce(x * s + y * t, x * t + s * y + y * t)
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
    #[inline]
    pub fn in_p(&self, u: Res) -> bool {
        let h = &self.prime.hnf;
        if h.c == 1 {
            (u.0 as i128 - (u.1 as i128) * h.b as i128).rem_euclid(h.a as i128) == 0
        } else {
            u.0 % self.prime.p == 0 && u.1 % self.prime.p == 0
        }
    }
    #[inline]
    pub fn is_unit(&self, u: Res) -> bool {
        !self.in_p(u)
    }
    /// The inverse of a unit: u^-1 = conj(u) N(u)^-1, where N(u) is an integer
    /// prime to p, hence invertible modulo A (P^e meets Z in A Z).
    pub fn inv(&self, u: Res) -> Option<Res> {
        if self.in_p(u) {
            return None;
        }
        let (x, y) = (u.0 as i128, u.1 as i128);
        let n = (x * x + x * y - y * y).rem_euclid(self.a as i128) as u64;
        let ninv = inv_mod(n, self.a)? as i128;
        Some(self.reduce((x + y) * ninv, -y * ninv))
    }
    /// Elements are indexed by x + A y.
    #[inline]
    pub fn index(&self, u: Res) -> u64 {
        u.0 + self.a * u.1
    }
    #[inline]
    pub fn element(&self, i: u64) -> Res {
        Res(i % self.a, i / self.a)
    }
    /// The number of elements of P/P^e.
    pub fn card_p(&self) -> u64 {
        self.card / self.q
    }
    /// The index in P/P^e of u, which must lie in P.
    #[inline]
    pub fn index_in_p(&self, u: Res) -> u64 {
        let h = &self.prime.hnf;
        if h.c == 1 {
            // u = (y B_P mod A_P) + A_P k + y w with 0 <= k < A / A_P
            let base = (u.1 as u128 * h.b as u128 % h.a as u128) as u64;
            let k = (u.0 - base) / h.a;
            u.1 + self.c * k
        } else {
            let p = self.prime.p;
            u.0 / p + (self.a / p) * (u.1 / p)
        }
    }
    #[inline]
    pub fn element_in_p(&self, i: u64) -> Res {
        let h = &self.prime.hnf;
        if h.c == 1 {
            let (y, k) = (i % self.c, i / self.c);
            let base = (y as u128 * h.b as u128 % h.a as u128) as u64;
            Res(base + h.a * k, y)
        } else {
            let p = self.prime.p;
            let m = self.a / p;
            Res(p * (i % m), p * (i / m))
        }
    }

    /// Distinct roots in the residue field O_F/P (this ring must have e = 1)
    /// of t^2 - s t + n, if there are two.
    pub fn distinct_roots(&self, s: Res, n: Res) -> Option<(Res, Res)> {
        assert_eq!(self.e, 1);
        let f = |t: Res| self.add(self.sub(self.mul(t, t), self.mul(s, t)), n);
        if self.q <= 64 || self.prime.p == 2 {
            let roots: Vec<Res> = (0..self.card).map(|i| self.element(i)).filter(|&t| f(t) == self.zero()).collect();
            return if roots.len() == 2 { Some((roots[0], roots[1])) } else { None };
        }
        // odd characteristic: t = (s +- sqrt(s^2 - 4n)) / 2
        let four = self.reduce(4, 0);
        let d = self.sub(self.mul(s, s), self.mul(four, n));
        if d == self.zero() {
            return None;
        }
        let r = self.sqrt(d)?;
        let half = self.inv(self.reduce(2, 0)).unwrap();
        let t1 = self.mul(self.add(s, r), half);
        let t2 = self.mul(self.sub(s, r), half);
        debug_assert!(f(t1) == self.zero() && f(t2) == self.zero());
        Some((t1, t2))
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

    pub fn kind(&self) -> Kind {
        self.prime.kind
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{primes_above, rational_primes};

    /// PSAGE tests.py residue_ring_arith: arithmetic agrees with O_F.
    #[test]
    fn arithmetic_agrees_with_o_f() {
        for p in rational_primes(30) {
            for pr in primes_above(p) {
                for e in 1..=4u32 {
                    if (pr.norm as u128).pow(e) > 20000 {
                        continue;
                    }
                    let r = LocalRing::new(pr, e).unwrap();
                    let ideal = Hnf::principal(pr.gen.pow(e));
                    let xs: Vec<Elt> = (0..r.card).step_by(((r.card / 40) as usize).max(1)).map(|i| r.lift(r.element(i))).collect();
                    for &x in &xs {
                        for &y in &xs {
                            let (u, v) = (r.from_elt(x), r.from_elt(y));
                            assert!(ideal.contains(r.lift(r.mul(u, v)).sub(x.mul(y))));
                            assert!(ideal.contains(r.lift(r.add(u, v)).sub(x.add(y))));
                            assert!(ideal.contains(r.lift(r.sub(u, v)).sub(x.sub(y))));
                        }
                        let u = r.from_elt(x);
                        assert_eq!(r.in_p(u), pr.contains(x));
                        if let Some(v) = r.inv(u) {
                            assert_eq!(r.mul(u, v), r.one());
                        }
                    }
                    // the enumeration of P/P^e is a bijection
                    let mut seen = vec![false; r.card_p() as usize];
                    for i in 0..r.card_p() {
                        let u = r.element_in_p(i);
                        assert!(r.in_p(u) && u.0 < r.a && u.1 < r.c);
                        assert_eq!(r.index_in_p(u), i);
                        assert!(!seen[i as usize]);
                        seen[i as usize] = true;
                    }
                    assert_eq!((0..r.card).filter(|&i| r.in_p(r.element(i))).count() as u64, r.card_p());
                }
            }
        }
    }

    #[test]
    fn square_roots() {
        for p in [3u64, 7, 11, 13, 41, 101, 1009] {
            for pr in primes_above(p) {
                let k = LocalRing::new(pr, 1).unwrap();
                if k.q <= 64 {
                    continue;
                }
                for i in 0..k.card.min(500) {
                    let x = k.element(i);
                    let s = k.mul(x, x);
                    let r = k.sqrt(s).unwrap();
                    assert_eq!(k.mul(r, r), s);
                }
            }
        }
    }
}
