//! The ring Z_q / p^k = (Z/p^k)[t]/(M(t)), M a monic lift of the modulus of
//! F_q: the unramified extension of Z_p of degree D, to precision k.  The
//! roots of f mod p in F_q lift uniquely to roots here (Hensel, Newton's
//! iteration), since p does not divide the discriminant of f.

use crate::fq::{El, Fq};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

#[derive(Clone, Debug)]
pub struct Zq {
    pub p: u64,
    pub k: u32,
    pub pk: BigInt,
    /// the monic modulus, degree D, constant term first
    pub m: Vec<BigInt>,
}

pub type Elt = Vec<BigInt>;

impl Zq {
    pub fn new(fq: &Fq, k: u32) -> Zq {
        let pk = BigInt::from(fq.p).pow(k);
        Zq { p: fq.p, k, pk, m: fq.m.iter().map(|&c| BigInt::from(c)).collect() }
    }
    pub fn degree(&self) -> usize {
        self.m.len() - 1
    }
    fn red(&self, x: BigInt) -> BigInt {
        x.mod_floor(&self.pk)
    }
    pub fn zero(&self) -> Elt {
        vec![BigInt::zero(); self.degree()]
    }
    pub fn scalar(&self, c: &BigInt) -> Elt {
        let mut v = self.zero();
        v[0] = self.red(c.clone());
        v
    }
    pub fn from_fq(&self, a: &El) -> Elt {
        a.iter().map(|&c| BigInt::from(c)).collect()
    }
    pub fn add(&self, a: &Elt, b: &Elt) -> Elt {
        a.iter().zip(b).map(|(x, y)| self.red(x + y)).collect()
    }
    pub fn sub(&self, a: &Elt, b: &Elt) -> Elt {
        a.iter().zip(b).map(|(x, y)| self.red(x - y)).collect()
    }
    pub fn mul(&self, a: &Elt, b: &Elt) -> Elt {
        let d = self.degree();
        if d == 1 {
            return vec![self.red(&a[0] * &b[0])];
        }
        let mut c = vec![BigInt::zero(); 2 * d - 1];
        for (i, x) in a.iter().enumerate() {
            if x.is_zero() {
                continue;
            }
            for (j, y) in b.iter().enumerate() {
                c[i + j] += x * y;
            }
        }
        for i in (d..2 * d - 1).rev() {
            let q = std::mem::take(&mut c[i]);
            if q.is_zero() {
                continue;
            }
            // the m_j are below p: no need to reduce q first
            for j in 0..d {
                c[i - d + j] -= &q * &self.m[j];
            }
        }
        c.truncate(d);
        c.into_iter().map(|x| self.red(x)).collect()
    }
    pub fn mul_int(&self, a: &Elt, c: &BigInt) -> Elt {
        a.iter().map(|x| self.red(x * c)).collect()
    }
    pub fn pow(&self, a: &Elt, e: u32) -> Elt {
        let mut r = self.scalar(&BigInt::one());
        for i in (0..32 - e.leading_zeros()).rev() {
            r = self.mul(&r, &r);
            if e >> i & 1 == 1 {
                r = self.mul(&r, a);
            }
        }
        r
    }
    /// f(a) for f in Z[x] (Horner).
    pub fn eval(&self, f: &[BigInt], a: &Elt) -> Elt {
        let mut r = self.zero();
        for c in f.iter().rev() {
            r = self.mul(&r, a);
            r[0] = self.red(&r[0] + c);
        }
        r
    }
    /// The lift of the root r0 (in F_q) of f, by Newton's iteration
    /// r <- r - f(r) w, w <- w (2 - f'(r) w) with w ~ 1/f'(r), doubling the
    /// precision at each step.
    pub fn lift_root(&self, fq: &Fq, f: &[BigInt], r0: &El) -> Elt {
        let df: Vec<BigInt> = f.iter().enumerate().skip(1).map(|(i, c)| c * BigInt::from(i as u64)).collect();
        // f'(r0) in F_q, and its inverse
        let dfp: Vec<u64> = df.iter().map(|c| c.mod_floor(&BigInt::from(fq.p)).to_u64().unwrap()).collect();
        let mut d0 = fq.zero();
        for c in dfp.iter().rev() {
            d0 = fq.mul(&d0, r0);
            d0[0] = (d0[0] + c) % fq.p;
        }
        let mut w = self.from_fq(&fq.inv(&d0));
        let mut r = self.from_fq(r0);
        let mut precs = vec![self.k];
        while *precs.last().unwrap() > 1 {
            let k = *precs.last().unwrap();
            precs.push(k.div_ceil(2));
        }
        precs.pop();
        precs.reverse();
        for k in precs {
            let z = Zq { p: self.p, k, pk: BigInt::from(self.p).pow(k), m: self.m.clone() };
            let two = z.scalar(&BigInt::from(2u32));
            // w is good to half of k (or better): update r, then w
            r = z.sub(&r, &z.mul(&z.eval(f, &r), &w));
            let dr = z.eval(&df, &r);
            w = z.mul(&w, &z.sub(&two, &z.mul(&dr, &w)));
            // and once more for w, so that it keeps up with r
            w = z.mul(&w, &z.sub(&two, &z.mul(&dr, &w)));
        }
        r = self.sub(&r, &self.mul(&self.eval(f, &r), &w));
        assert!(self.eval(f, &r).iter().all(|c| c.is_zero()), "Hensel lifting failed");
        r
    }
    /// If a is (to this precision) an integer of absolute value < 2^bits:
    /// that integer (the symmetric residue).
    pub fn small_integer(&self, a: &Elt, bits: u64) -> Option<BigInt> {
        if a[1..].iter().any(|c| !c.is_zero()) {
            return None;
        }
        let mut c = a[0].clone();
        if &c + &c > self.pk {
            c -= &self.pk;
        }
        if c.abs().bits() <= bits {
            Some(c)
        } else {
            None
        }
    }
}

/// The same ring when p^k < 2^62: coefficients in machine words.
#[derive(Clone, Debug)]
pub struct Small {
    pub pk: u64,
    pub m: Vec<u64>,
}

pub type SElt = Vec<u64>;

impl Small {
    /// None if p^k is too big for words.
    pub fn new(z: &Zq) -> Option<Small> {
        let pk = z.pk.to_u64().filter(|&x| x < 1 << 62)?;
        Some(Small { pk, m: z.m.iter().map(|c| c.to_u64().unwrap() % pk).collect() })
    }
    pub fn from(&self, a: &Elt) -> SElt {
        a.iter().map(|c| c.to_u64().unwrap()).collect()
    }
    pub fn add(&self, a: &SElt, b: &SElt) -> SElt {
        a.iter().zip(b).map(|(x, y)| (x + y) % self.pk).collect()
    }
    pub fn sub(&self, a: &SElt, b: &SElt) -> SElt {
        a.iter().zip(b).map(|(x, y)| (x + self.pk - y) % self.pk).collect()
    }
    pub fn mul(&self, a: &SElt, b: &SElt) -> SElt {
        let d = self.m.len() - 1;
        let pk = self.pk as u128;
        if d == 1 {
            return vec![((a[0] as u128 * b[0] as u128) % pk) as u64];
        }
        let mut c = vec![0u128; 2 * d - 1];
        for (i, &x) in a.iter().enumerate() {
            if x == 0 {
                continue;
            }
            for (j, &y) in b.iter().enumerate() {
                c[i + j] = (c[i + j] + x as u128 * y as u128) % pk;
            }
        }
        for i in (d..2 * d - 1).rev() {
            let q = c[i] % pk;
            if q == 0 {
                continue;
            }
            c[i] = 0;
            for j in 0..d {
                // subtract q m_j
                let t = q * self.m[j] as u128 % pk;
                c[i - d + j] = (c[i - d + j] + pk - t) % pk;
            }
        }
        c.truncate(d);
        c.into_iter().map(|x| (x % pk) as u64).collect()
    }
    pub fn to_big(&self, a: &SElt) -> Elt {
        a.iter().map(|&c| BigInt::from(c)).collect()
    }
}
