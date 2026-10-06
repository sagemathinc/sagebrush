//! Arithmetic modulo an odd n of up to 1024 bits in Montgomery form (u64
//! limbs, CIOS multiplication), Pollard-Brent rho on it, and Lenstra's
//! elliptic curve method (Montgomery curves with Suyama's parametrization,
//! x-only ladder for stage 1, baby-step giant-step stage 2).

use sagebrush_bigint::{BigInt, BigUint, Sign};
use num_integer::Integer;
use num_traits::{One, Zero};

const MAXL: usize = 16;

/// t + a b + c as (low, high) words (it fits: (2^64 - 1)^2 + 2 (2^64 - 1) =
/// 2^128 - 1).  One 64 x 64 -> 128-bit product on 64-bit targets; wasm32 has
/// no such instruction (a u128 product calls a 128 x 128-bit library
/// routine, which made ECM ~30 times slower than native), so there four
/// 32 x 32 -> 64-bit products.
#[inline(always)]
fn mac(t: u64, a: u64, b: u64, c: u64) -> (u64, u64) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let s = t as u128 + a as u128 * b as u128 + c as u128;
        (s as u64, (s >> 64) as u64)
    }
    #[cfg(target_arch = "wasm32")]
    {
        mac_split(t, a, b, c)
    }
}

/// mac by 32-bit halves (used on wasm32; tested everywhere).
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
#[inline(always)]
fn mac_split(t: u64, a: u64, b: u64, c: u64) -> (u64, u64) {
    const M: u64 = 0xffff_ffff;
    let (a0, a1, b0, b1) = (a & M, a >> 32, b & M, b >> 32);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 32) + (p01 & M) + (p10 & M); // < 3 2^32
    let lo = (p00 & M) | (mid << 32);
    let hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
    let (lo, c1) = lo.overflowing_add(t);
    let (lo, c2) = lo.overflowing_add(c);
    (lo, hi + c1 as u64 + c2 as u64)
}

pub struct Mont {
    k: usize,
    n: [u64; MAXL],
    ninv: u64, // -n^-1 mod 2^64
    r2: [u64; MAXL],
    one: [u64; MAXL],
    nbig: BigUint,
}

pub type E = [u64; MAXL];

fn to_limbs(x: &BigUint, k: usize) -> E {
    let mut out = [0u64; MAXL];
    for (i, d) in x.to_u64_digits().into_iter().enumerate().take(k) {
        out[i] = d;
    }
    out
}

fn from_limbs(x: &E, k: usize) -> BigUint {
    let mut v = BigUint::zero();
    for i in (0..k).rev() {
        v = (v << 64usize) + x[i];
    }
    v
}

impl Mont {
    pub fn new(n: &BigUint) -> Option<Mont> {
        if n.is_even() || n.bits() > 64 * MAXL as u64 {
            return None;
        }
        let k = ((n.bits() + 63) / 64) as usize;
        let nl = to_limbs(n, k);
        // -n^-1 mod 2^64 by Newton
        let mut inv: u64 = nl[0];
        for _ in 0..6 {
            inv = inv.wrapping_mul(2u64.wrapping_sub(nl[0].wrapping_mul(inv)));
        }
        let r = BigUint::one() << (64 * k);
        let r2 = (&r * &r) % n;
        let one = &r % n;
        Some(Mont { k, n: nl, ninv: inv.wrapping_neg(), r2: to_limbs(&r2, k), one: to_limbs(&one, k), nbig: n.clone() })
    }

    pub fn to_mont(&self, x: &BigUint) -> E {
        let x = x % &self.nbig;
        self.mul(&to_limbs(&x, self.k), &self.r2)
    }

    pub fn from_mont(&self, x: &E) -> BigUint {
        let mut one = [0u64; MAXL];
        one[0] = 1;
        from_limbs(&self.mul(x, &one), self.k)
    }

    pub fn one(&self) -> E {
        self.one
    }

    /// a b R^-1 mod n (CIOS), for this modulus' number of limbs.
    #[inline]
    pub fn mul(&self, a: &E, b: &E) -> E {
        // a copy of the loop for each k, which the compiler unrolls: three
        // times faster for small moduli than one loop over k
        match self.k {
            1 => self.mul_k::<1>(a, b),
            2 => self.mul_k::<2>(a, b),
            3 => self.mul_k::<3>(a, b),
            4 => self.mul_k::<4>(a, b),
            5 => self.mul_k::<5>(a, b),
            6 => self.mul_k::<6>(a, b),
            7 => self.mul_k::<7>(a, b),
            8 => self.mul_k::<8>(a, b),
            9 => self.mul_k::<9>(a, b),
            10 => self.mul_k::<10>(a, b),
            11 => self.mul_k::<11>(a, b),
            12 => self.mul_k::<12>(a, b),
            13 => self.mul_k::<13>(a, b),
            14 => self.mul_k::<14>(a, b),
            15 => self.mul_k::<15>(a, b),
            _ => self.mul_k::<16>(a, b),
        }
    }

    #[inline(always)]
    fn mul_k<const K: usize>(&self, a: &E, b: &E) -> E {
        let mut t = [0u64; MAXL + 2];
        for i in 0..K {
            let mut c = 0u64;
            let bi = b[i];
            for j in 0..K {
                (t[j], c) = mac(t[j], a[j], bi, c);
            }
            let (s, hi) = t[K].overflowing_add(c);
            t[K] = s;
            t[K + 1] = hi as u64;
            let m = t[0].wrapping_mul(self.ninv);
            let (_, mut c) = mac(t[0], m, self.n[0], 0);
            for j in 1..K {
                (t[j - 1], c) = mac(t[j], m, self.n[j], c);
            }
            let (s, hi) = t[K].overflowing_add(c);
            t[K - 1] = s;
            t[K] = t[K + 1] + hi as u64;
        }
        let mut out = [0u64; MAXL];
        out[..K].copy_from_slice(&t[..K]);
        // out >= n (or a carry out): subtract n once
        let mut ge = t[K] != 0;
        if !ge {
            ge = true;
            for j in (0..K).rev() {
                if out[j] != self.n[j] {
                    ge = out[j] > self.n[j];
                    break;
                }
            }
        }
        if ge {
            let mut borrow = 0u64;
            for j in 0..K {
                let (d, b1) = out[j].overflowing_sub(self.n[j]);
                let (d, b2) = d.overflowing_sub(borrow);
                out[j] = d;
                borrow = (b1 | b2) as u64;
            }
        }
        out
    }

    fn less_than_n(&self, a: &E) -> bool {
        for i in (0..self.k).rev() {
            if a[i] != self.n[i] {
                return a[i] < self.n[i];
            }
        }
        false
    }

    fn sub_n(&self, a: &mut E) {
        let mut borrow = 0u64;
        for i in 0..self.k {
            let (d1, b1) = a[i].overflowing_sub(self.n[i]);
            let (d2, b2) = d1.overflowing_sub(borrow);
            a[i] = d2;
            borrow = (b1 || b2) as u64;
        }
    }

    #[inline]
    pub fn add(&self, a: &E, b: &E) -> E {
        let mut out = [0u64; MAXL];
        let mut carry = 0u64;
        for i in 0..self.k {
            let (s1, c1) = a[i].overflowing_add(b[i]);
            let (s2, c2) = s1.overflowing_add(carry);
            out[i] = s2;
            carry = (c1 || c2) as u64;
        }
        if carry != 0 || !self.less_than_n(&out) {
            self.sub_n(&mut out);
        }
        out
    }

    #[inline]
    pub fn sub(&self, a: &E, b: &E) -> E {
        let mut out = [0u64; MAXL];
        let mut borrow = 0u64;
        for i in 0..self.k {
            let (d1, b1) = a[i].overflowing_sub(b[i]);
            let (d2, b2) = d1.overflowing_sub(borrow);
            out[i] = d2;
            borrow = (b1 || b2) as u64;
        }
        if borrow != 0 {
            // add n back
            let mut carry = 0u64;
            for i in 0..self.k {
                let (s1, c1) = out[i].overflowing_add(self.n[i]);
                let (s2, c2) = s1.overflowing_add(carry);
                out[i] = s2;
                carry = (c1 || c2) as u64;
            }
        }
        out
    }

    /// gcd of the (standard representative of the) element with n.
    pub fn gcd_n(&self, a: &E) -> BigUint {
        from_limbs(a, self.k).gcd(&self.nbig)
    }
}

fn rng(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

/// Pollard-Brent rho for at most `iters` steps.
pub fn rho(n: &BigUint, iters: u64, seed: u64) -> Option<BigUint> {
    let m = Mont::new(n)?;
    let mut s = seed | 1;
    let c = m.to_mont(&BigUint::from(rng(&mut s) % 1000 + 1));
    let f = |x: &E| m.add(&m.mul(x, x), &c);
    let mut y = m.to_mont(&BigUint::from(rng(&mut s) % 1000 + 2));
    let (mut r, mut q) = (1u64, m.one());
    let mut x;
    let mut ys;
    let mut done = 0u64;
    let batch = 128u64;
    loop {
        sagebrush_interrupt::check();
        x = y;
        for _ in 0..r {
            y = f(&y);
        }
        let mut k = 0;
        while k < r {
            sagebrush_interrupt::check();
            ys = y;
            for _ in 0..batch.min(r - k) {
                y = f(&y);
                q = m.mul(&q, &m.sub(&x, &y));
            }
            let g = m.gcd_n(&m.from_mont_raw(&q));
            done += batch;
            if !g.is_one() {
                if &g == n {
                    // back up
                    loop {
                        ys = f(&ys);
                        let g = m.gcd_n(&m.from_mont_raw(&m.sub(&x, &ys)));
                        if !g.is_one() {
                            return (&g != n).then_some(g);
                        }
                    }
                }
                return Some(g);
            }
            k += batch;
            if done > iters {
                return None;
            }
        }
        r *= 2;
    }
}

impl Mont {
    /// The limbs as stored (a R mod n): gcd with n is the same as for a.
    fn from_mont_raw(&self, a: &E) -> E {
        *a
    }
}

/// Montgomery ladder: [k](x : z) on the curve with a24 = (A + 2)/4.
fn ladder(m: &Mont, x: &E, z: &E, k: &BigUint, a24: &E) -> (E, E) {
    let (mut x1, mut z1) = (*x, *z);
    let (mut x2, mut z2) = dbl(m, x, z, a24);
    let bits = k.bits();
    for i in (0..bits.saturating_sub(1)).rev() {
        if k.bit(i) {
            let (xa, za) = add(m, &x2, &z2, &x1, &z1, x, z);
            let (xd, zd) = dbl(m, &x2, &z2, a24);
            x1 = xa;
            z1 = za;
            x2 = xd;
            z2 = zd;
        } else {
            let (xa, za) = add(m, &x1, &z1, &x2, &z2, x, z);
            let (xd, zd) = dbl(m, &x1, &z1, a24);
            x2 = xa;
            z2 = za;
            x1 = xd;
            z1 = zd;
        }
    }
    (x1, z1)
}

#[inline]
fn dbl(m: &Mont, x: &E, z: &E, a24: &E) -> (E, E) {
    let s = m.add(x, z);
    let d = m.sub(x, z);
    let s2 = m.mul(&s, &s);
    let d2 = m.mul(&d, &d);
    let t = m.sub(&s2, &d2);
    (m.mul(&s2, &d2), m.mul(&t, &m.add(&d2, &m.mul(a24, &t))))
}

/// P + Q from P, Q and P - Q.
#[inline]
fn add(m: &Mont, xp: &E, zp: &E, xq: &E, zq: &E, xd: &E, zd: &E) -> (E, E) {
    let u = m.mul(&m.sub(xp, zp), &m.add(xq, zq));
    let v = m.mul(&m.add(xp, zp), &m.sub(xq, zq));
    let s = m.add(&u, &v);
    let d = m.sub(&u, &v);
    (m.mul(zd, &m.mul(&s, &s)), m.mul(xd, &m.mul(&d, &d)))
}

/// One ECM curve (Suyama's sigma) with bounds B1, B2: a nontrivial factor.
pub fn ecm_curve(n: &BigUint, sigma: u64, b1: u64, b2: u64, primes: &[u64]) -> Option<BigUint> {
    let m = Mont::new(n)?;
    let nn = BigInt::from_biguint(Sign::Plus, n.clone());
    let s = BigInt::from(sigma);
    let u: BigInt = (&s * &s - BigInt::from(5)).mod_floor(&nn);
    let v: BigInt = (&s * BigInt::from(4)).mod_floor(&nn);
    let x0 = (&u * &u * &u).mod_floor(&nn);
    let z0 = (&v * &v * &v).mod_floor(&nn);
    // a24 = (v - u)^3 (3u + v) / (16 u^3 v)
    let num: BigInt = ((&v - &u).pow(3) * (&u * BigInt::from(3) + &v)).mod_floor(&nn);
    let den = (BigInt::from(16) * &x0 * &v).mod_floor(&nn);
    let e = den.extended_gcd(&nn);
    if !e.gcd.is_one() {
        let g = e.gcd.to_biguint().unwrap();
        return (&g != n).then_some(g);
    }
    let a24 = (num * e.x).mod_floor(&nn).to_biguint().unwrap();
    let a24 = m.to_mont(&a24);
    let (mut x, mut z) = (m.to_mont(&x0.to_biguint().unwrap()), m.to_mont(&z0.to_biguint().unwrap()));
    // stage 1: multiply by every prime power <= B1
    for &p in primes.iter().take_while(|&&p| p <= b1) {
        sagebrush_interrupt::check();
        let mut q = p;
        while q <= b1 / p {
            q *= p;
        }
        let (nx, nz) = ladder(&m, &x, &z, &BigUint::from(q), &a24);
        x = nx;
        z = nz;
    }
    let g = m.gcd_n(&z);
    if !g.is_one() {
        return (&g != n).then_some(g);
    }
    // stage 2: primes q in (B1, B2] as k D +- j, D = 2310
    let d: u64 = 2310;
    let half = d / 2;
    let js: Vec<u64> = (1..half).step_by(2).filter(|j| j.gcd(&d) == 1).collect();
    // [j] P for those j, by stepping 2P
    let (x2, z2) = dbl(&m, &x, &z, &a24);
    let mut baby: Vec<(E, E)> = Vec::with_capacity(js.len());
    let (mut xa, mut za) = (x, z); // 1 P
    let (mut xb, mut zb) = add(&m, &x2, &z2, &x, &z, &x, &z); // 3 P
    let mut jcur = 1u64;
    let mut ji = 0;
    while ji < js.len() {
        if jcur == js[ji] {
            baby.push((xa, za));
            ji += 1;
        }
        // next odd: (j + 2) P = j P + 2P with difference (j - 2) P
        let (xn, zn) = add(&m, &xb, &zb, &x2, &z2, &xa, &za);
        xa = xb;
        za = zb;
        xb = xn;
        zb = zn;
        jcur += 2;
    }
    // giant steps R_k = (k D) P from k0 = max(B1 / D, 1): R_{k+1} = R_k + D P
    // with difference R_{k-1}
    let (xd, zd) = ladder(&m, &x, &z, &BigUint::from(d), &a24);
    let k0 = (b1 / d).max(1);
    let (mut xk, mut zk) = ladder(&m, &x, &z, &BigUint::from(k0 * d), &a24);
    let (mut xn, mut zn) = ladder(&m, &x, &z, &BigUint::from((k0 + 1) * d), &a24);
    let mut acc = m.one();
    let mut k = k0;
    let mut pi = primes.partition_point(|&p| p <= b1);
    while k * d <= b2 + half {
        sagebrush_interrupt::check();
        let lo = k * d - half;
        let hi = k * d + half;
        while pi < primes.len() && primes[pi] < lo {
            pi += 1;
        }
        let mut idx = pi;
        while idx < primes.len() && primes[idx] <= hi && primes[idx] <= b2 {
            let q = primes[idx];
            let j = q.abs_diff(k * d);
            if let Ok(t) = js.binary_search(&j) {
                let (xj, zj) = &baby[t];
                acc = m.mul(&acc, &m.sub(&m.mul(&xk, zj), &m.mul(xj, &zk)));
            }
            idx += 1;
        }
        let (xm, zm) = add(&m, &xn, &zn, &xd, &zd, &xk, &zk);
        xk = xn;
        zk = zn;
        xn = xm;
        zn = zm;
        k += 1;
    }
    let g = m.gcd_n(&acc);
    if !g.is_one() && &g != n {
        return Some(g);
    }
    None
}

/// A nontrivial factor of a composite odd n by ECM with growing bounds
/// (B1 = 2000, 11000, 50000, 250000, 1000000; B2 = 50 B1 up to 10^7),
/// or None.
pub fn ecm(n: &BigUint, seed: u64) -> Option<BigUint> {
    let schedule: [(u64, usize); 5] = [(2000, 25), (11000, 90), (50000, 300), (250000, 700), (1_000_000, 1800)];
    let mut primes: Vec<u64> = vec![];
    let mut s = seed | 1;
    for &(b1, curves) in &schedule {
        // B2 = 50 B1, at most 10^7 (the primes are sieved up to B2)
        let b2 = (50 * b1).min(10_000_000).max(b1);
        if primes.last().map_or(true, |&p| p < b2) {
            primes = crate::arith::primes_up_to(b2 + 2310);
        }
        for _ in 0..curves {
            sagebrush_interrupt::check();
            let sigma = 6 + rng(&mut s) % (1 << 30);
            if let Some(g) = ecm_curve(n, sigma, b1, b2, &primes) {
                return Some(g);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_by_halves_is_exact() {
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let edge = [0, 1, u32::MAX as u64, 1 << 32, u64::MAX - 1, u64::MAX];
        for i in 0..200_000 {
            let v: [u64; 4] = if i < 6 * 6 * 6 * 6 { [edge[i % 6], edge[i / 6 % 6], edge[i / 36 % 6], edge[i / 216 % 6]] } else { [next(), next(), next(), next()] };
            let s = v[0] as u128 + v[1] as u128 * v[2] as u128 + v[3] as u128;
            assert_eq!(mac_split(v[0], v[1], v[2], v[3]), (s as u64, (s >> 64) as u64), "{:?}", v);
        }
    }

    #[test]
    fn montgomery_arithmetic() {
        let n: BigUint = "340282366920938463463374607431768211457".parse().unwrap(); // 2^128 + 1
        let m = Mont::new(&n).unwrap();
        let a: BigUint = "123456789012345678901234567890".parse().unwrap();
        let b: BigUint = "98765432109876543210987654321".parse().unwrap();
        let p = m.from_mont(&m.mul(&m.to_mont(&a), &m.to_mont(&b)));
        assert_eq!(p, (&a * &b) % &n);
        let s = m.from_mont(&m.sub(&m.to_mont(&b), &m.to_mont(&a)));
        assert_eq!(s, (&n + &b - &a) % &n);
    }

    #[test]
    fn finds_factors() {
        // 2^128 + 1 = 59649589127497217 * 5704689200685129054721
        let n: BigUint = "340282366920938463463374607431768211457".parse().unwrap();
        let g = ecm(&n, 1).expect("ECM finds a factor of 2^128 + 1");
        assert!((&n % &g).is_zero() && !g.is_one() && g != n);
        // rho on a product of two ~32-bit primes
        let n: BigUint = BigUint::from(4294967291u64) * BigUint::from(4294967279u64);
        let g = rho(&n, 1 << 22, 7).unwrap();
        assert!((&n % &g).is_zero() && !g.is_one() && g != n);
    }
}
