//! Finite fields F_q = F_p[t]/(m(t)) (p an odd prime below 2^31, m monic
//! irreducible of degree D) and the roots there of polynomials over F_p:
//! Cantor-Zassenhaus over F_q for one root of each irreducible factor, then
//! its conjugates by the Frobenius x -> x^p.

use sagebrush_bigint::BigUint;

pub type FpPoly = Vec<u64>;

fn trim(mut v: Vec<u64>) -> Vec<u64> {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

pub fn powmod_u(mut b: u64, mut e: u64, p: u64) -> u64 {
    let mut r = 1u64;
    b %= p;
    while e > 0 {
        if e & 1 == 1 {
            r = r * b % p;
        }
        b = b * b % p;
        e >>= 1;
    }
    r
}

pub fn inv_u(a: u64, p: u64) -> u64 {
    powmod_u(a, p - 2, p)
}

/// The field F_p[t]/(m).
#[derive(Clone, Debug)]
pub struct Fq {
    pub p: u64,
    /// monic, constant term first, degree D
    pub m: Vec<u64>,
}

pub type El = Vec<u64>; // length D

impl Fq {
    pub fn degree(&self) -> usize {
        self.m.len() - 1
    }
    pub fn zero(&self) -> El {
        vec![0; self.degree()]
    }
    pub fn one(&self) -> El {
        self.scalar(1)
    }
    pub fn scalar(&self, c: u64) -> El {
        let mut v = self.zero();
        v[0] = c % self.p;
        v
    }
    pub fn t(&self) -> El {
        let mut v = self.zero();
        if self.degree() == 1 {
            // t = -m_0
            v[0] = (self.p - self.m[0]) % self.p;
        } else {
            v[1] = 1;
        }
        v
    }
    pub fn is_zero(&self, a: &El) -> bool {
        a.iter().all(|&x| x == 0)
    }
    pub fn add(&self, a: &El, b: &El) -> El {
        a.iter().zip(b).map(|(x, y)| (x + y) % self.p).collect()
    }
    pub fn sub(&self, a: &El, b: &El) -> El {
        a.iter().zip(b).map(|(x, y)| (x + self.p - y) % self.p).collect()
    }
    pub fn neg(&self, a: &El) -> El {
        a.iter().map(|x| (self.p - x) % self.p).collect()
    }
    pub fn mul(&self, a: &El, b: &El) -> El {
        let d = self.degree();
        let p = self.p;
        let mut c = vec![0u64; 2 * d];
        for (i, &x) in a.iter().enumerate() {
            if x == 0 {
                continue;
            }
            for (j, &y) in b.iter().enumerate() {
                c[i + j] = (c[i + j] + x * y) % p;
            }
        }
        // reduce by the monic m from the top
        for i in (d..2 * d).rev() {
            let q = c[i];
            if q == 0 {
                continue;
            }
            c[i] = 0;
            for j in 0..d {
                c[i - d + j] = (c[i - d + j] + (p - q) * self.m[j]) % p;
            }
        }
        c.truncate(d);
        c
    }
    pub fn pow(&self, a: &El, e: &BigUint) -> El {
        let mut r = self.one();
        for i in (0..e.bits()).rev() {
            r = self.mul(&r, &r);
            if e.bit(i) {
                r = self.mul(&r, a);
            }
        }
        r
    }
    pub fn pow_u(&self, a: &El, e: u64) -> El {
        self.pow(a, &BigUint::from(e))
    }
    /// The inverse, by the extended Euclidean algorithm in F_p[t].
    pub fn inv(&self, a: &El) -> El {
        let p = self.p;
        let (g, s) = xgcd(&trim(a.clone()), &self.m, p);
        assert!(g.len() == 1, "not invertible");
        let c = inv_u(g[0], p);
        let mut v = self.zero();
        for (i, x) in s.iter().enumerate() {
            v[i] = x * c % p;
        }
        v
    }
    pub fn order(&self) -> BigUint {
        BigUint::from(self.p).pow(self.degree() as u32)
    }
}

// ------------------------------------------------------------- F_p[x]

pub fn pmul(a: &[u64], b: &[u64], p: u64) -> FpPoly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let mut c = vec![0u64; a.len() + b.len() - 1];
    for (i, &x) in a.iter().enumerate() {
        for (j, &y) in b.iter().enumerate() {
            c[i + j] = (c[i + j] + x * y) % p;
        }
    }
    trim(c)
}

pub fn pdivrem(a: &[u64], b: &[u64], p: u64) -> (FpPoly, FpPoly) {
    let mut r = trim(a.to_vec());
    let b = trim(b.to_vec());
    if r.len() < b.len() {
        return (vec![], r);
    }
    let inv = inv_u(*b.last().unwrap(), p);
    let mut q = vec![0u64; r.len() - b.len() + 1];
    while r.len() >= b.len() && !r.is_empty() {
        let k = r.len() - b.len();
        let c = r.last().unwrap() * inv % p;
        q[k] = c;
        for (j, &y) in b.iter().enumerate() {
            r[k + j] = (r[k + j] + (p - c) * y % p) % p;
        }
        r = trim(r);
    }
    (trim(q), r)
}

/// (g, s) with g = gcd(a, b) and s a = g mod b.
fn xgcd(a: &[u64], b: &[u64], p: u64) -> (FpPoly, FpPoly) {
    let (mut r0, mut r1) = (trim(a.to_vec()), trim(b.to_vec()));
    let (mut s0, mut s1): (FpPoly, FpPoly) = (vec![1], vec![]);
    while !r1.is_empty() {
        let (q, r) = pdivrem(&r0, &r1, p);
        let qs = pmul(&q, &s1, p);
        let mut s2 = s0.clone();
        s2.resize(s2.len().max(qs.len()), 0);
        for (i, x) in qs.iter().enumerate() {
            s2[i] = (s2[i] + p - x) % p;
        }
        r0 = std::mem::replace(&mut r1, r);
        s0 = std::mem::replace(&mut s1, trim(s2));
    }
    (r0, s0)
}

// ------------------------------------------------------------- F_q[x]

type QPoly = Vec<El>;

fn qtrim(f: &Fq, mut v: QPoly) -> QPoly {
    while v.last().map_or(false, |c| f.is_zero(c)) {
        v.pop();
    }
    v
}

fn qmul(f: &Fq, a: &[El], b: &[El]) -> QPoly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let mut c = vec![f.zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            c[i + j] = f.add(&c[i + j], &f.mul(x, y));
        }
    }
    qtrim(f, c)
}

fn qdivrem(f: &Fq, a: &[El], b: &[El]) -> (QPoly, QPoly) {
    let mut r = qtrim(f, a.to_vec());
    let b = qtrim(f, b.to_vec());
    if r.len() < b.len() {
        return (vec![], r);
    }
    let inv = f.inv(b.last().unwrap());
    let mut q = vec![f.zero(); r.len() - b.len() + 1];
    while r.len() >= b.len() && !r.is_empty() {
        let k = r.len() - b.len();
        let c = f.mul(r.last().unwrap(), &inv);
        for (j, y) in b.iter().enumerate() {
            r[k + j] = f.sub(&r[k + j], &f.mul(&c, y));
        }
        q[k] = c;
        r = qtrim(f, r);
    }
    (qtrim(f, q), r)
}

fn qgcd(f: &Fq, a: &[El], b: &[El]) -> QPoly {
    let (mut x, mut y) = (qtrim(f, a.to_vec()), qtrim(f, b.to_vec()));
    while !y.is_empty() {
        let r = qdivrem(f, &x, &y).1;
        x = std::mem::replace(&mut y, r);
    }
    // monic
    if let Some(l) = x.last().cloned() {
        let li = f.inv(&l);
        x = x.iter().map(|c| f.mul(c, &li)).collect();
    }
    x
}

fn qpowmod(f: &Fq, base: &[El], e: &BigUint, m: &[El]) -> QPoly {
    let mut r: QPoly = vec![f.one()];
    let b = qdivrem(f, base, m).1;
    for i in (0..e.bits()).rev() {
        r = qdivrem(f, &qmul(f, &r, &r), m).1;
        if e.bit(i) {
            r = qdivrem(f, &qmul(f, &r, &b), m).1;
        }
    }
    r
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// One root in F_q of g (monic over F_q, a product of distinct linear
/// factors over F_q), by Cantor-Zassenhaus.
fn one_root(f: &Fq, g: QPoly, rng: &mut Rng) -> El {
    let mut g = g;
    let e = (f.order() - BigUint::from(1u32)) / BigUint::from(2u32);
    while g.len() > 2 {
        let a: El = (0..f.degree()).map(|_| rng.next() % f.p).collect();
        let xa = vec![a, f.one()];
        let mut h = qpowmod(f, &xa, &e, &g);
        if h.is_empty() {
            continue;
        }
        h[0] = f.sub(&h[0], &f.one());
        let d = qgcd(f, &g, &h);
        if d.len() > 1 && d.len() < g.len() {
            // keep the smaller factor
            g = if 2 * (d.len() - 1) <= g.len() - 1 { d } else { qdivrem(f, &g, &d).0 };
            let l = f.inv(g.last().unwrap());
            g = g.iter().map(|c| f.mul(c, &l)).collect();
        }
    }
    // g = x + c
    f.neg(&g[0])
}

/// The roots in F_q of g, irreducible over F_p of degree dividing D:
/// rho, rho^p, rho^(p^2), ... (so the Frobenius cycles through them in order).
pub fn roots_of_irreducible(f: &Fq, g: &[u64], seed: u64) -> Vec<El> {
    let p = f.p;
    let d = g.len() - 1;
    let rho = if d == 1 {
        let c = (p - g[0] * inv_u(g[1], p) % p) % p;
        f.scalar(c)
    } else if f.m == g {
        f.t()
    } else {
        // x^q - x splits g completely over F_q: find one root
        let gq: QPoly = g.iter().map(|&c| f.scalar(c)).collect();
        let l = f.inv(gq.last().unwrap());
        let gq: QPoly = gq.iter().map(|c| f.mul(c, &l)).collect();
        one_root(f, gq, &mut Rng(0x9e3779b97f4a7c15 ^ seed ^ (p << 20)))
    };
    let mut out = vec![rho];
    for _ in 1..d {
        let r = f.pow_u(out.last().unwrap(), p);
        out.push(r);
    }
    out
}

/// A monic irreducible polynomial of degree d over F_p (found at random).
pub fn irreducible(d: usize, p: u64, seed: u64) -> FpPoly {
    let mut rng = Rng(0x2545f4914f6cdd1d ^ seed ^ (d as u64) << 40);
    loop {
        let mut m: Vec<u64> = (0..d).map(|_| rng.next() % p).collect();
        m.push(1);
        let mz: Vec<sagebrush_bigint::BigInt> = m.iter().map(|&c| sagebrush_bigint::BigInt::from(c)).collect();
        let fac = sagebrush_poly::factor_mod(&mz, p);
        if fac.len() == 1 && fac[0].1 == 1 && fac[0].0.len() == d + 1 {
            return m;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_in_extension() {
        // x^3 - 2 over F_7: irreducible (2 is not a cube mod 7)
        let p = 7;
        let g = vec![5, 0, 0, 1];
        let m = irreducible(6, p, 1);
        let f = Fq { p, m };
        let rs = roots_of_irreducible(&f, &g, 3);
        assert_eq!(rs.len(), 3);
        for r in &rs {
            let c = f.mul(&f.mul(r, r), r);
            assert_eq!(c, f.scalar(2));
        }
        assert!(rs[0] != rs[1] && rs[1] != rs[2] && rs[0] != rs[2]);
    }
}
