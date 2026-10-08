//! Sparse polynomials over a field in a monomial order: the setting of
//! division with remainder, normal forms and Groebner bases.  Terms are kept
//! in decreasing order of their keys ([`crate::order::Packing::key`]).
//!
//! Fields: GF(p) for p < 2^62 ([`Fp`], words) and Q ([`QQ`], rationals).

use crate::order::{Order, Packing};
use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::{BigInt, BigRational};
use std::collections::BTreeMap;

pub trait Field: Clone + Send + Sync {
    type E: Clone + PartialEq + std::fmt::Debug + Send + Sync;
    fn zero(&self) -> Self::E;
    fn one(&self) -> Self::E;
    fn is_zero(&self, a: &Self::E) -> bool;
    fn add(&self, a: &Self::E, b: &Self::E) -> Self::E;
    fn sub(&self, a: &Self::E, b: &Self::E) -> Self::E;
    fn mul(&self, a: &Self::E, b: &Self::E) -> Self::E;
    fn neg(&self, a: &Self::E) -> Self::E;
    fn inv(&self, a: &Self::E) -> Self::E;
}

/// GF(p), p < 2^62.
#[derive(Clone, Copy, Debug)]
pub struct Fp {
    pub p: u64,
}

impl Fp {
    pub fn pow(&self, mut a: u64, mut e: u64) -> u64 {
        let mut r = 1u64;
        while e > 0 {
            if e & 1 == 1 {
                r = self.mul(&r, &a);
            }
            a = self.mul(&a, &a);
            e >>= 1;
        }
        r
    }
}

impl Field for Fp {
    type E = u64;
    fn zero(&self) -> u64 {
        0
    }
    fn one(&self) -> u64 {
        1
    }
    fn is_zero(&self, a: &u64) -> bool {
        *a == 0
    }
    #[inline]
    fn add(&self, a: &u64, b: &u64) -> u64 {
        let s = a + b;
        if s >= self.p {
            s - self.p
        } else {
            s
        }
    }
    #[inline]
    fn sub(&self, a: &u64, b: &u64) -> u64 {
        if a >= b {
            a - b
        } else {
            a + self.p - b
        }
    }
    #[inline]
    fn mul(&self, a: &u64, b: &u64) -> u64 {
        ((*a as u128 * *b as u128) % self.p as u128) as u64
    }
    fn neg(&self, a: &u64) -> u64 {
        if *a == 0 {
            0
        } else {
            self.p - a
        }
    }
    fn inv(&self, a: &u64) -> u64 {
        // extended Euclid
        let (mut r0, mut r1) = (self.p as i128, *a as i128);
        let (mut s0, mut s1) = (0i128, 1i128);
        while r1 != 0 {
            let q = r0 / r1;
            (r0, r1) = (r1, r0 - q * r1);
            (s0, s1) = (s1, s0 - q * s1);
        }
        assert!(r0 == 1, "not invertible mod p");
        s0.rem_euclid(self.p as i128) as u64
    }
}

/// The rationals.
#[derive(Clone, Copy, Debug)]
pub struct QQ;

impl Field for QQ {
    type E = BigRational;
    fn zero(&self) -> BigRational {
        BigRational::zero()
    }
    fn one(&self) -> BigRational {
        BigRational::one()
    }
    fn is_zero(&self, a: &BigRational) -> bool {
        a.is_zero()
    }
    fn add(&self, a: &BigRational, b: &BigRational) -> BigRational {
        a + b
    }
    fn sub(&self, a: &BigRational, b: &BigRational) -> BigRational {
        a - b
    }
    fn mul(&self, a: &BigRational, b: &BigRational) -> BigRational {
        a * b
    }
    fn neg(&self, a: &BigRational) -> BigRational {
        -a.clone()
    }
    fn inv(&self, a: &BigRational) -> BigRational {
        a.recip()
    }
}

/// An exponent outgrew its field: repack with more bits and redo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overflow;

/// A term: its order key, packed word and coefficient.
#[derive(Clone, Debug)]
pub struct Term<E> {
    pub key: u128,
    pub w: u64,
    pub c: E,
}

/// A polynomial over the field F in the order o (terms decreasing).
#[derive(Clone, Debug)]
pub struct Poly<F: Field> {
    pub pk: Packing,
    pub o: Order,
    pub t: Vec<Term<F::E>>,
}

impl<F: Field> Poly<F> {
    pub fn zero(pk: Packing, o: Order) -> Self {
        Poly { pk, o, t: vec![] }
    }

    pub fn is_zero(&self) -> bool {
        self.t.is_empty()
    }

    pub fn len(&self) -> usize {
        self.t.len()
    }

    /// From (word, coefficient) pairs in any order (repeats added).
    pub fn from_terms(f: &F, pk: Packing, o: Order, ts: Vec<(u64, F::E)>) -> Self {
        let mut m: BTreeMap<u128, (u64, F::E)> = BTreeMap::new();
        for (w, c) in ts {
            let k = pk.key(o, w);
            match m.get_mut(&k) {
                Some(e) => e.1 = f.add(&e.1, &c),
                None => {
                    m.insert(k, (w, c));
                }
            }
        }
        let t = m.into_iter().rev().filter(|(_, (_, c))| !f.is_zero(c)).map(|(key, (w, c))| Term { key, w, c }).collect();
        Poly { pk, o, t }
    }

    pub fn lead(&self) -> &Term<F::E> {
        &self.t[0]
    }

    /// The polynomial with leading coefficient 1.
    pub fn monic(&self, f: &F) -> Self {
        if self.is_zero() {
            return self.clone();
        }
        let i = f.inv(&self.t[0].c);
        self.scale(f, &i)
    }

    pub fn scale(&self, f: &F, c: &F::E) -> Self {
        Poly { pk: self.pk, o: self.o, t: self.t.iter().map(|x| Term { key: x.key, w: x.w, c: f.mul(&x.c, c) }).collect() }
    }

    /// Whether a term reached the guard bits (an exponent too big for the
    /// packing: the caller repacks wider and starts over).
    pub fn overflowed(&self) -> bool {
        let g = self.pk.guard();
        self.t.iter().any(|x| x.w & g != 0)
    }

    /// c * x^m * self (the order is kept by monomial multiplication).
    pub fn mul_term(&self, f: &F, m: u64, c: &F::E) -> Self {
        Poly {
            pk: self.pk,
            o: self.o,
            t: self.t.iter().map(|x| {
                let w = x.w + m;
                Term { key: self.pk.key(self.o, w), w, c: f.mul(&x.c, c) }
            }).collect(),
        }
    }

    /// self + s*other (s a field element).
    pub fn add_scaled(&self, f: &F, other: &Self, s: &F::E) -> Self {
        let (a, b) = (&self.t, &other.t);
        let (mut i, mut j) = (0, 0);
        let mut out = Vec::with_capacity(a.len() + b.len());
        while i < a.len() || j < b.len() {
            if j == b.len() || (i < a.len() && a[i].key > b[j].key) {
                out.push(a[i].clone());
                i += 1;
            } else if i == a.len() || b[j].key > a[i].key {
                out.push(Term { key: b[j].key, w: b[j].w, c: f.mul(&b[j].c, s) });
                j += 1;
            } else {
                let c = f.add(&a[i].c, &f.mul(&b[j].c, s));
                if !f.is_zero(&c) {
                    out.push(Term { key: a[i].key, w: a[i].w, c });
                }
                i += 1;
                j += 1;
            }
        }
        Poly { pk: self.pk, o: self.o, t: out }
    }

    /// The S-polynomial of f and g (both nonzero).
    pub fn spoly(fld: &F, f: &Self, g: &Self) -> Self {
        let (lf, lg) = (f.lead(), g.lead());
        let l = f.pk.lcm(lf.w, lg.w);
        let a = f.mul_term(fld, l - lf.w, &fld.inv(&lf.c));
        let b = g.mul_term(fld, l - lg.w, &fld.inv(&lg.c));
        a.add_scaled(fld, &b, &fld.neg(&fld.one()))
    }

    /// Division with remainder by a list: self = sum q_j g_j + r, no term of
    /// r divisible by a leading monomial of the g_j (the first divisor that
    /// divides the current term is used).  With `full = false` only the
    /// leading terms are reduced (r's tail is left alone: top reduction).
    pub fn divrem(&self, f: &F, gs: &[&Self], want_q: bool, full: bool) -> Result<(Vec<Self>, Self), Overflow> {
        let pk = self.pk;
        let guard = pk.guard();
        let mut qs: Vec<Vec<(u64, F::E)>> = vec![vec![]; gs.len()];
        let lead_inv: Vec<F::E> = gs.iter().map(|g| f.inv(&g.lead().c)).collect();
        let mut map: BTreeMap<u128, (u64, F::E)> = self.t.iter().map(|x| (x.key, (x.w, x.c.clone()))).collect();
        let mut r: Vec<Term<F::E>> = vec![];
        let mut steps = 0u64;
        while let Some((k, (w, c))) = map.pop_last() {
            steps += 1;
            if steps & 0xfff == 0 {
                sagebrush_interrupt::check();
            }
            let mut done = false;
            for (j, g) in gs.iter().enumerate() {
                let lw = g.lead().w;
                if pk.divides(lw, w) {
                    let m = w - lw;
                    let q = f.mul(&c, &lead_inv[j]);
                    for x in &g.t[1..] {
                        let tw = x.w + m;
                        if tw & guard != 0 {
                            return Err(Overflow);
                        }
                        let tk = pk.key(self.o, tw);
                        let d = f.mul(&q, &x.c);
                        match map.get_mut(&tk) {
                            Some(e) => {
                                e.1 = f.sub(&e.1, &d);
                                if f.is_zero(&e.1) {
                                    map.remove(&tk);
                                }
                            }
                            None => {
                                map.insert(tk, (tw, f.neg(&d)));
                            }
                        }
                    }
                    if want_q {
                        qs[j].push((m, q));
                    }
                    done = true;
                    break;
                }
            }
            if !done {
                r.push(Term { key: k, w, c });
                if !full {
                    // the rest unchanged
                    r.extend(std::mem::take(&mut map).into_iter().rev().map(|(key, (w, c))| Term { key, w, c }));
                    break;
                }
            }
        }
        let qs = qs.into_iter().map(|q| Poly::from_terms(f, pk, self.o, q)).collect();
        Ok((qs, Poly { pk, o: self.o, t: r }))
    }

    /// The same polynomial with b bits per variable.
    pub fn repack(&self, b: u32) -> Self {
        let pk = Packing { n: self.pk.n, bits: b };
        let t = self.t.iter().map(|x| {
            let w = pk.pack(&self.pk.unpack(x.w));
            Term { key: pk.key(self.o, w), w, c: x.c.clone() }
        }).collect();
        Poly { pk, o: self.o, t }
    }
}

// ---- conversions with the Z/Q/GF(p) representation of the front end

use crate::{Coeffs, QPoly, ZPoly};

/// QPoly (over Q) as a polynomial over QQ in the order o.
pub fn to_q(p: &QPoly, o: Order) -> Poly<QQ> {
    let pk = Packing { n: p.num.n.max(1), bits: p.num.bits };
    let ts = (0..p.num.len()).map(|i| (p.num.exps[i], BigRational::new(p.num.coeffs.big(i), p.den.clone()))).collect();
    Poly::from_terms(&QQ, pk, o, ts)
}

pub fn from_q(p: &Poly<QQ>, n: usize) -> QPoly {
    // the common denominator
    let mut den = BigInt::one();
    for x in &p.t {
        den = den.lcm(x.c.denom());
    }
    let mut t: Vec<(u64, BigInt)> = p.t.iter().map(|x| (x.w, x.c.numer() * (&den / x.c.denom()))).collect();
    t.sort_by(|a, b| b.0.cmp(&a.0));
    let exps = t.iter().map(|x| x.0).collect();
    let cs = t.into_iter().map(|x| x.1).collect();
    let num = ZPoly { n, bits: p.pk.bits, exps, coeffs: Coeffs::Big(cs) }.shrunk();
    QPoly { num, den: if den.is_negative() { -den } else { den }, p: 0 }.normalized()
}

pub fn to_p(p: &QPoly, o: Order) -> Poly<Fp> {
    let pk = Packing { n: p.num.n.max(1), bits: p.num.bits };
    let ts = (0..p.num.len()).map(|i| (p.num.exps[i], p.num.coeffs.big(i).mod_floor(&BigInt::from(p.p)).try_into().unwrap_or(0u64))).collect();
    Poly::from_terms(&Fp { p: p.p }, pk, o, ts)
}

pub fn from_p(p: &Poly<Fp>, n: usize, modulus: u64) -> QPoly {
    let mut t: Vec<(u64, i64)> = p.t.iter().map(|x| (x.w, x.c as i64)).collect();
    t.sort_by(|a, b| b.0.cmp(&a.0));
    let num = ZPoly { n, bits: p.pk.bits, exps: t.iter().map(|x| x.0).collect(), coeffs: Coeffs::Small(t.iter().map(|x| x.1).collect()) };
    QPoly { num, den: BigInt::one(), p: modulus }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divrem_q() {
        // (x^2*y + x + 1) quo_rem (x*y) in degrevlex: (x, x + 1)
        let f = QPoly::from_text(2, "2,1:1;1,0:1;0,0:1").unwrap();
        let g = QPoly::from_text(2, "1,1:1").unwrap();
        let (q, r) = to_q(&f, Order::DegRevLex).repack(8).divrem(&QQ, &[&to_q(&g, Order::DegRevLex).repack(8)], true, true).unwrap();
        assert_eq!(from_q(&q[0], 2).to_text(), "1,0:1");
        assert_eq!(from_q(&r, 2).to_text(), "1,0:1;0,0:1");
    }

    #[test]
    fn spoly_fp() {
        let pk = Packing { n: 2, bits: 8 };
        let fl = Fp { p: 7 };
        let f = Poly::from_terms(&fl, pk, Order::Lex, vec![(pk.pack(&[2, 0]), 1), (pk.pack(&[0, 1]), 3)]);
        let g = Poly::from_terms(&fl, pk, Order::Lex, vec![(pk.pack(&[1, 1]), 2), (pk.pack(&[0, 0]), 1)]);
        let s = Poly::spoly(&fl, &f, &g);
        // y*f - (x/2)*g = 3y^2 - x/2 = 3y^2 + 3x (mod 7)
        let want = Poly::from_terms(&fl, pk, Order::Lex, vec![(pk.pack(&[0, 2]), 3), (pk.pack(&[1, 0]), 3)]);
        assert_eq!(s.t.iter().map(|x| (x.w, x.c)).collect::<Vec<_>>(), want.t.iter().map(|x| (x.w, x.c)).collect::<Vec<_>>());
    }
}
