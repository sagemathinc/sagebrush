//! Real quadratic fields F = Q(sqrt d): arithmetic in O_F = Z[w], ideals,
//! primes and factorization, the fundamental unit, the class group and the
//! narrow class group with explicit representatives, principality with
//! generators, and totally positive generators. Everything is exact and
//! unconditional (no GRH): it rests on the reduction theory of quadratic
//! irrationals.
//!
//! Notation. d > 1 squarefree, D the discriminant (d or 4d), w = (1 +
//! sqrt d)/2 if d = 1 mod 4 and w = sqrt d otherwise, so w^2 = t w + n with
//! (t, n) = (1, (d - 1)/4) or (0, d), D = t^2 + 4n and sqrt D = 2w - t.
//! The real embeddings are w -> (t + sqrt D)/2 (the first, "positive") and
//! w -> (t - sqrt D)/2.
//!
//! Reduction (the reduction theory of indefinite binary quadratic forms, in
//! the language of ideals: Buchmann and Vollmer, "Binary Quadratic Forms",
//! 2007; Cohen, "A Course in Computational Algebraic Number Theory", 1993,
//! chapter 5). A primitive ideal is J = Z a + Z (b + sqrt D)/2
//! with a > 0 and 4a | b^2 - D, that is J = a L with L = Z + Z theta,
//! theta = (b + sqrt D)/(2a). One step of the continued fraction of theta,
//! q = floor(theta) and theta_1 = 1/(theta - q), gives L = (theta - q) L_1;
//! with b_1 = 2aq - b and a_1 = (D - b_1^2)/(4a), theta_1 = (b_1 + sqrt
//! D)/(2a_1), and as lattices
//!
//! ```text
//! J = gamma J_1,   gamma = (sqrt D - b_1)/(2 a_1),   J_1 = a_1 L_1.
//! ```
//!
//! The expansion of theta becomes purely periodic, and then theta is
//! reduced: theta > 1 and -1 < theta' < 0, that is |sqrt D - 2a| < b <
//! sqrt D (Galois). Two ideals are equivalent (J = alpha J', alpha in F^x)
//! if and only if their reduced ideals lie on the same cycle, so the
//! cycles of all reduced ideals are the ideal classes, and the product of
//! the gamma over one period of the cycle of O_F is a fundamental unit (the
//! classical continued fraction algorithm for the unit). Results are
//! checked where it is cheap: every generator returned generates its ideal,
//! and every totally positive generator is totally positive. The narrow
//! class group refines
//! the classes by the sign of the norm of a generator when N(eps) = 1.

use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;
use std::collections::HashMap;

fn big(x: i128) -> BigInt {
    BigInt::from(x)
}

/// floor(sqrt(n)) for n >= 0.
pub fn isqrt(n: i128) -> i128 {
    if n < 2 {
        return n;
    }
    let mut x = (n as f64).sqrt() as i128;
    while x * x > n {
        x -= 1;
    }
    while (x + 1) * (x + 1) <= n {
        x += 1;
    }
    x
}

fn is_squarefree(n: i64) -> bool {
    let mut m = n;
    let mut p = 2i64;
    while p * p <= m {
        if m % (p * p) == 0 {
            return false;
        }
        if m % p == 0 {
            m /= p;
        }
        p += 1;
    }
    true
}

/// A real quadratic field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct QuadField {
    /// The squarefree d > 1 with F = Q(sqrt d).
    pub d: i64,
    /// The discriminant.
    pub disc: i64,
    /// w^2 = t w + n.
    pub t: i64,
    pub n: i64,
}

/// An element a + b w of O_F.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct QElt {
    pub a: BigInt,
    pub b: BigInt,
}

/// An element (a + b w)/den of F, in lowest terms with den > 0.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct QFrac {
    pub a: BigInt,
    pub b: BigInt,
    pub den: BigInt,
}

impl QElt {
    pub fn new(a: i64, b: i64) -> QElt {
        QElt { a: BigInt::from(a), b: BigInt::from(b) }
    }
    pub fn int(a: i64) -> QElt {
        QElt::new(a, 0)
    }
    pub fn is_zero(&self) -> bool {
        self.a.is_zero() && self.b.is_zero()
    }
    pub fn frac(&self) -> QFrac {
        QFrac { a: self.a.clone(), b: self.b.clone(), den: BigInt::one() }
    }
}

impl std::fmt::Display for QElt {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.a)?;
        if self.b.is_zero() {
            Ok(())
        } else if self.b.is_negative() {
            write!(f, " - {}w", -&self.b)
        } else {
            write!(f, " + {}w", self.b)
        }
    }
}

impl QFrac {
    pub fn new(a: BigInt, b: BigInt, den: BigInt) -> QFrac {
        assert!(!den.is_zero());
        let g = a.gcd(&b).gcd(&den);
        let (mut a, mut b, mut den) = (a / &g, b / &g, den / &g);
        if den.is_negative() {
            a = -a;
            b = -b;
            den = -den;
        }
        QFrac { a, b, den }
    }
    pub fn one() -> QFrac {
        QFrac { a: BigInt::one(), b: BigInt::zero(), den: BigInt::one() }
    }
    /// The element of O_F, if integral.
    pub fn integral(&self) -> Option<QElt> {
        if self.den.is_one() {
            Some(QElt { a: self.a.clone(), b: self.b.clone() })
        } else {
            None
        }
    }
}

/// A nonzero ideal Z a + Z (b + c w) in Hermite normal form: a, c > 0,
/// c | a, c | b, 0 <= b < a.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct QIdeal {
    pub a: i128,
    pub b: i128,
    pub c: i128,
}

impl QIdeal {
    pub fn norm(&self) -> i128 {
        self.a * self.c
    }
    pub fn is_one(&self) -> bool {
        self.a == 1 && self.c == 1
    }
}

/// How a rational prime decomposes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Splitting {
    Split,
    Inert,
    Ramified,
}

/// A prime ideal of O_F.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct QPrime {
    pub p: i64,
    pub norm: i128,
    pub kind: Splitting,
    pub ideal: QIdeal,
}

/// The 2-dimensional Hermite normal form of the Z-span of vectors (u, v)
/// (coordinates in 1, w): (a, b, c) with span = Z (a, 0) + Z (b, c), or None
/// if the span has rank < 2.
fn hnf2(vs: &[(i128, i128)]) -> Option<(i128, i128, i128)> {
    // gcd on the second coordinate
    let mut c = 0i128;
    let mut row = (0i128, 0i128); // a vector (b, c) with that c
    let mut rest: Vec<i128> = vec![]; // first coordinates of vectors with v = 0
    for &(u, v) in vs {
        if v == 0 {
            rest.push(u);
            continue;
        }
        if c == 0 {
            row = (u, v);
            c = v;
            continue;
        }
        // combine (row.0, c) and (u, v): x c + y v = g
        let (g, x, y) = xgcd(c, v);
        let new = (x * row.0 + y * u, g);
        // the vector v/g row - c/g (u, v) has second coordinate 0
        let z = (v / g) * row.0 - (c / g) * u;
        rest.push(z);
        row = new;
        c = g;
    }
    if c == 0 {
        return None;
    }
    let a = rest.iter().fold(0i128, |g, &x| gcd(g, x));
    if a == 0 {
        return None;
    }
    let (mut b, mut c) = row;
    if c < 0 {
        b = -b;
        c = -c;
    }
    Some((a, b.rem_euclid(a), c))
}

pub fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a
}

/// (g, x, y) with x a + y b = g = gcd(a, b) >= 0.
pub fn xgcd(a: i128, b: i128) -> (i128, i128, i128) {
    let (mut r0, mut r1) = (a, b);
    let (mut s0, mut s1) = (1i128, 0i128);
    let (mut t0, mut t1) = (0i128, 1i128);
    while r1 != 0 {
        let q = r0.div_euclid(r1);
        (r0, r1) = (r1, r0 - q * r1);
        (s0, s1) = (s1, s0 - q * s1);
        (t0, t1) = (t1, t0 - q * t1);
    }
    if r0 < 0 {
        (-r0, -s0, -t0)
    } else {
        (r0, s0, t0)
    }
}

/// The sign of u + v sqrt D.
fn sign_sqrt(u: &BigInt, v: &BigInt, disc: i64) -> Ordering {
    let su = u.sign_cmp();
    let sv = v.sign_cmp();
    if sv == Ordering::Equal {
        return su;
    }
    if su == Ordering::Equal || su == sv {
        return sv;
    }
    // opposite signs: compare u^2 and v^2 D
    if u * u > v * v * BigInt::from(disc) {
        su
    } else {
        sv
    }
}

trait SignCmp {
    fn sign_cmp(&self) -> Ordering;
}

impl SignCmp for BigInt {
    fn sign_cmp(&self) -> Ordering {
        if self.is_zero() {
            Ordering::Equal
        } else if self.is_negative() {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }
}

impl QuadField {
    /// Q(sqrt d) for squarefree d > 1.
    pub fn new(d: i64) -> Result<QuadField, String> {
        if d <= 1 || !is_squarefree(d) {
            return Err(format!("{} is not a squarefree integer > 1", d));
        }
        if d > 1 << 40 {
            return Err("d must be below 2^40".into());
        }
        Ok(if d % 4 == 1 { QuadField { d, disc: d, t: 1, n: (d - 1) / 4 } } else { QuadField { d, disc: 4 * d, t: 0, n: d } })
    }

    /// The field with discriminant `disc` (a fundamental discriminant > 1).
    pub fn from_disc(disc: i64) -> Result<QuadField, String> {
        let f = if disc % 4 == 1 { QuadField::new(disc)? } else if disc % 4 == 0 { QuadField::new(disc / 4)? } else { return Err(format!("{} is not a discriminant", disc)) };
        if f.disc != disc {
            return Err(format!("{} is not a fundamental discriminant", disc));
        }
        Ok(f)
    }

    // ---- elements

    pub fn add(&self, x: &QElt, y: &QElt) -> QElt {
        QElt { a: &x.a + &y.a, b: &x.b + &y.b }
    }
    pub fn sub(&self, x: &QElt, y: &QElt) -> QElt {
        QElt { a: &x.a - &y.a, b: &x.b - &y.b }
    }
    /// (a + b w)(c + e w) = ac + n be + (ae + bc + t be) w.
    pub fn mul(&self, x: &QElt, y: &QElt) -> QElt {
        let be = &x.b * &y.b;
        QElt { a: &x.a * &y.a + &be * BigInt::from(self.n), b: &x.a * &y.b + &x.b * &y.a + be * BigInt::from(self.t) }
    }
    /// The Galois conjugate: w -> t - w.
    pub fn conj(&self, x: &QElt) -> QElt {
        QElt { a: &x.a + &x.b * BigInt::from(self.t), b: -&x.b }
    }
    /// N(a + b w) = a^2 + t ab - n b^2.
    pub fn norm(&self, x: &QElt) -> BigInt {
        &x.a * &x.a + &x.a * &x.b * BigInt::from(self.t) - &x.b * &x.b * BigInt::from(self.n)
    }
    pub fn trace(&self, x: &QElt) -> BigInt {
        &x.a * BigInt::from(2) + &x.b * BigInt::from(self.t)
    }
    pub fn pow(&self, x: &QElt, e: u32) -> QElt {
        let mut r = QElt::int(1);
        for _ in 0..e {
            r = self.mul(&r, x);
        }
        r
    }

    pub fn fmul(&self, x: &QFrac, y: &QFrac) -> QFrac {
        let p = self.mul(&QElt { a: x.a.clone(), b: x.b.clone() }, &QElt { a: y.a.clone(), b: y.b.clone() });
        QFrac::new(p.a, p.b, &x.den * &y.den)
    }
    pub fn finv(&self, x: &QFrac) -> QFrac {
        let e = QElt { a: x.a.clone(), b: x.b.clone() };
        let c = self.conj(&e);
        let n = self.norm(&e);
        assert!(!n.is_zero(), "inverse of 0");
        QFrac::new(c.a * &x.den, c.b * &x.den, n)
    }

    /// The signs of x under the two real embeddings.
    pub fn signs(&self, x: &QElt) -> (Ordering, Ordering) {
        // 2x = (2a + bt) +- b sqrt D
        let u = &x.a * BigInt::from(2) + &x.b * BigInt::from(self.t);
        (sign_sqrt(&u, &x.b, self.disc), sign_sqrt(&u, &(-&x.b), self.disc))
    }
    pub fn is_totally_positive(&self, x: &QElt) -> bool {
        self.signs(x) == (Ordering::Greater, Ordering::Greater)
    }
    /// The value of x under the first embedding, as a float (for display).
    pub fn approx(&self, x: &QElt) -> f64 {
        let s = (self.disc as f64).sqrt();
        x.a.to_f64().unwrap_or(f64::NAN) + x.b.to_f64().unwrap_or(f64::NAN) * (self.t as f64 + s) / 2.0
    }

    // ---- ideals

    /// The ideal generated by the given elements (not all zero).
    pub fn ideal(&self, gens: &[QElt]) -> Result<QIdeal, String> {
        let mut vs = vec![];
        let w = QElt::new(0, 1);
        for g in gens {
            for h in [g.clone(), self.mul(g, &w)] {
                let u = h.a.to_i128().ok_or("ideal generator too large")?;
                let v = h.b.to_i128().ok_or("ideal generator too large")?;
                vs.push((u, v));
            }
        }
        let (a, b, c) = hnf2(&vs).ok_or("the zero ideal")?;
        Ok(QIdeal { a, b, c })
    }
    pub fn principal(&self, g: &QElt) -> Result<QIdeal, String> {
        self.ideal(std::slice::from_ref(g))
    }
    pub fn unit_ideal(&self) -> QIdeal {
        QIdeal { a: 1, b: 0, c: 1 }
    }
    /// The Z-basis a, b + c w.
    fn basis(&self, i: &QIdeal) -> [QElt; 2] {
        [QElt { a: big(i.a), b: BigInt::zero() }, QElt { a: big(i.b), b: big(i.c) }]
    }
    pub fn ideal_mul(&self, i: &QIdeal, j: &QIdeal) -> QIdeal {
        let mut vs = vec![];
        for x in self.basis(i) {
            for y in self.basis(j) {
                let p = self.mul(&x, &y);
                vs.push((p.a.to_i128().expect("ideal product overflow"), p.b.to_i128().expect("ideal product overflow")));
            }
        }
        let (a, b, c) = hnf2(&vs).expect("nonzero");
        QIdeal { a, b, c }
    }
    pub fn ideal_conj(&self, i: &QIdeal) -> QIdeal {
        let [x, y] = self.basis(i);
        self.ideal(&[x, self.conj(&y)]).expect("nonzero")
    }
    pub fn contains(&self, i: &QIdeal, x: &QElt) -> bool {
        let (u, v) = (&x.a, &x.b);
        if !(v % big(i.c)).is_zero() {
            return false;
        }
        let k = v / big(i.c);
        ((u - k * big(i.b)) % big(i.a)).is_zero()
    }
    /// I / k for an integer k dividing I.
    fn ideal_div_int(&self, i: &QIdeal, k: i128) -> Option<QIdeal> {
        if i.a % k != 0 || i.b % k != 0 || i.c % k != 0 {
            return None;
        }
        Some(QIdeal { a: i.a / k, b: (i.b / k).rem_euclid(i.a / k), c: i.c / k })
    }
    /// I J^-1 if it is integral.
    pub fn ideal_div(&self, i: &QIdeal, j: &QIdeal) -> Option<QIdeal> {
        // J^-1 = conj(J) / N(J)
        let p = self.ideal_mul(i, &self.ideal_conj(j));
        self.ideal_div_int(&p, j.norm())
    }

    // ---- primes

    /// The primes above the rational prime p, sorted by norm.
    pub fn primes_above(&self, p: i64) -> Vec<QPrime> {
        assert!(crate::field::is_prime(p as u64), "{} is not prime", p);
        // roots of x^2 - t x - n mod p
        let roots: Vec<i64> = (0..p).filter(|&r| (r as i128 * r as i128 - self.t as i128 * r as i128 - self.n as i128).rem_euclid(p as i128) == 0).take(2).collect();
        let mk = |kind, r: Option<i64>| -> QPrime {
            let ideal = match r {
                Some(r) => self.ideal(&[QElt::int(p), QElt::new(-r, 1)]).unwrap(),
                None => self.ideal(&[QElt::int(p)]).unwrap(),
            };
            QPrime { p, norm: ideal.norm(), kind, ideal }
        };
        if self.disc % p == 0 {
            vec![mk(Splitting::Ramified, Some(roots[0]))]
        } else if roots.is_empty() {
            vec![mk(Splitting::Inert, None)]
        } else {
            let mut v = vec![mk(Splitting::Split, Some(roots[0])), mk(Splitting::Split, Some(roots[1]))];
            v.sort_by_key(|q| q.ideal);
            v
        }
    }
    /// The primes of norm at most b, sorted by norm (then HNF).
    pub fn primes_of_bounded_norm(&self, bound: i64) -> Vec<QPrime> {
        let mut out = vec![];
        for p in 2..=bound {
            if !crate::field::is_prime(p as u64) {
                continue;
            }
            for q in self.primes_above(p) {
                if q.norm <= bound as i128 {
                    out.push(q);
                }
            }
        }
        out.sort_by_key(|q| (q.norm, q.ideal));
        out
    }
    /// The factorization of a nonzero ideal into primes.
    pub fn factor(&self, i: &QIdeal) -> Vec<(QPrime, u32)> {
        let mut out = vec![];
        let mut rest = *i;
        for (p, _) in crate::field::factor_u64(i.norm() as u64) {
            for q in self.primes_above(p as i64) {
                let mut e = 0;
                while let Some(r) = self.ideal_div(&rest, &q.ideal) {
                    rest = r;
                    e += 1;
                }
                if e > 0 {
                    out.push((q, e));
                }
            }
        }
        assert!(rest.is_one(), "factorization incomplete");
        out
    }

    // ---- reduction

    /// sqrt D = 2w - t as an element, over 1.
    fn sqrt_disc(&self) -> QElt {
        QElt::new(-self.t, 2)
    }

    /// (sqrt D - b1)/(2 a1).
    fn gamma(&self, b1: i128, a1: i128) -> QFrac {
        let s = self.sqrt_disc();
        QFrac::new(&s.a - big(b1), s.b, big(2 * a1))
    }

    /// The primitive part of I: I = k J with J = Z a + Z (b + sqrt D)/2,
    /// returned as (k, a, b).
    fn primitive(&self, i: &QIdeal) -> (i128, i128, i128) {
        let k = i.c;
        let a = i.a / k;
        let b = 2 * (i.b / k) + self.t as i128;
        (k, a, b)
    }

    /// One continued fraction step from (a, b) (a != 0): (a1, b1, gamma)
    /// with J = gamma J_1 as lattices.
    fn step(&self, a: i128, b: i128) -> (i128, i128, QFrac) {
        let s = isqrt(self.disc as i128);
        // q = floor((b + sqrt D)/(2a))
        let q = if a > 0 { (b + s).div_euclid(2 * a) } else { -((b + s).div_euclid(-2 * a)) - 1 };
        let b1 = 2 * a * q - b;
        let num = self.disc as i128 - b1 * b1;
        debug_assert_eq!(num % (4 * a), 0);
        let a1 = num / (4 * a);
        let g = self.gamma(b1, a1);
        (a1, b1, g)
    }

    fn is_reduced(&self, a: i128, b: i128) -> bool {
        // |sqrt D - 2a| < b < sqrt D with a > 0
        let dd = self.disc as i128;
        if a <= 0 || b <= 0 || b * b >= dd {
            return false;
        }
        // |sqrt D - 2a| < b  <=>  (2a - b)^2 < D and 2a + b > sqrt D... use
        // sqrt D - 2a < b and 2a - sqrt D < b
        let lo = 2 * a - b; // need sqrt D > 2a - b and sqrt D < 2a + b
        let hi = 2 * a + b;
        (lo <= 0 || lo * lo < dd) && hi * hi > dd
    }

    /// Reduce the primitive ideal (a, b): the reduced (a, b) of its class
    /// and gamma with J = gamma J_reduced.
    fn reduce(&self, mut a: i128, mut b: i128) -> (i128, i128, QFrac) {
        let mut g = QFrac::one();
        let mut steps = 0;
        while !self.is_reduced(a, b) {
            let (a1, b1, gm) = self.step(a, b);
            g = self.fmul(&g, &gm);
            a = a1;
            b = b1;
            steps += 1;
            assert!(steps < 10_000_000, "reduction did not terminate");
        }
        (a, b, g)
    }

    /// The cycle of reduced ideals starting at the reduced (a, b): the
    /// ideals and, for each, delta_i with J_0 = delta_i J_i; then the
    /// product over the whole period, a unit.
    fn cycle(&self, a: i128, b: i128) -> (Vec<(i128, i128)>, Vec<QFrac>, QFrac) {
        let mut ids = vec![(a, b)];
        let mut deltas = vec![QFrac::one()];
        let (mut x, mut y) = (a, b);
        let mut g = QFrac::one();
        loop {
            let (a1, b1, gm) = self.step(x, y);
            g = self.fmul(&g, &gm);
            if (a1, b1) == (a, b) {
                return (ids, deltas, g);
            }
            ids.push((a1, b1));
            deltas.push(g.clone());
            x = a1;
            y = b1;
        }
    }

    /// The reduced (a, b) in the class of O_F.
    fn reduced_one(&self) -> (i128, i128) {
        let s = isqrt(self.disc as i128);
        let b = if (s - self.disc as i128).rem_euclid(2) == 0 { s } else { s - 1 };
        (1, b)
    }

    /// The fundamental unit eps > 1 (first embedding) and its norm.
    pub fn fundamental_unit(&self) -> (QElt, i32) {
        let (a, b) = self.reduced_one();
        let (_, _, u) = self.cycle(a, b);
        let u = u.integral().expect("the period's product is a unit of O_F");
        let u = self.normalize_unit(&u);
        let n = self.norm(&u);
        assert!(n.abs().is_one(), "not a unit");
        (u, if n.is_positive() { 1 } else { -1 })
    }

    /// The element of {+-u, +-u^-1} that is > 1 under the first embedding.
    pub fn normalize_unit(&self, u: &QElt) -> QElt {
        let n = self.norm(u);
        let inv = {
            let c = self.conj(u);
            if n.is_negative() {
                QElt { a: -c.a, b: -c.b }
            } else {
                c
            }
        };
        let neg = |x: &QElt| QElt { a: -&x.a, b: -&x.b };
        for c in [u.clone(), neg(u), inv.clone(), neg(&inv)] {
            // c > 1 at the first embedding
            let m = self.sub(&c, &QElt::int(1));
            let (s1, _) = self.signs(&m);
            if s1 == Ordering::Greater {
                return c;
            }
        }
        unreachable!("a unit other than +-1 has a conjugate of absolute value > 1")
    }

    /// The generator of the totally positive units: eps if N(eps) = 1
    /// (then eps >> 0), eps^2 if N(eps) = -1.
    pub fn totally_positive_unit(&self) -> QElt {
        let (e, n) = self.fundamental_unit();
        if n == 1 {
            e
        } else {
            self.mul(&e, &e)
        }
    }

    /// The class group and narrow class group.
    pub fn class_group(&self) -> ClassGroup {
        ClassGroup::new(*self)
    }
}

/// The ideal classes of a real quadratic field (wide and narrow), with
/// representatives and the data to place any ideal in its class.
pub struct ClassGroup {
    pub field: QuadField,
    /// The fundamental unit (> 1) and its norm.
    pub eps: QElt,
    pub eps_norm: i32,
    /// Wide classes: representative ideals R_c (reduced, primitive); R_0 = O.
    pub reps: Vec<QIdeal>,
    /// reduced (a, b) -> (class, delta) with R_c = delta J_(a, b).
    place: HashMap<(i128, i128), (usize, QFrac)>,
    /// The structure: invariant factors (wide and narrow).
    pub cyc: Vec<i64>,
    pub narrow_cyc: Vec<i64>,
}

/// A narrow class: the wide class and the sign of the norm of alpha in
/// I = alpha R_c (always +1 when N(eps) = -1, where the groups agree).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NarrowClass {
    pub class: usize,
    pub sign: i8,
}

impl ClassGroup {
    fn new(f: QuadField) -> ClassGroup {
        let (eps, eps_norm) = f.fundamental_unit();
        // every reduced (a, b): 0 < b < sqrt D, b = D mod 2, a | (D - b^2)/4
        let dd = f.disc as i128;
        let s = isqrt(dd);
        let mut reduced = vec![];
        let mut b = if (s - dd).rem_euclid(2) == 0 { s } else { s - 1 };
        while b > 0 {
            let m = (dd - b * b) / 4;
            let mut a = 1;
            while a * a <= m {
                if m % a == 0 {
                    for x in [a, m / a] {
                        if f.is_reduced(x, b) {
                            reduced.push((x, b));
                        }
                    }
                }
                a += 1;
            }
            b -= 2;
        }
        reduced.sort();
        reduced.dedup();
        let mut place: HashMap<(i128, i128), (usize, QFrac)> = HashMap::new();
        let mut reps = vec![];
        // O_F first
        let mut starts = vec![f.reduced_one()];
        starts.extend(reduced.iter().copied());
        for st in starts {
            if place.contains_key(&st) {
                continue;
            }
            let c = reps.len();
            let (ids, deltas, _) = f.cycle(st.0, st.1);
            for (id, de) in ids.into_iter().zip(deltas) {
                place.insert(id, (c, de));
            }
            reps.push(QIdeal { a: st.0, b: (st.1 - f.t as i128) / 2 % st.0, c: 1 }.normalized());
        }
        let mut g = ClassGroup { field: f, eps, eps_norm, reps, place, cyc: vec![], narrow_cyc: vec![] };
        g.cyc = g.structure(false);
        g.narrow_cyc = g.structure(true);
        g
    }

    /// The class number h.
    pub fn h(&self) -> usize {
        self.reps.len()
    }
    /// The narrow class number h+.
    pub fn narrow_h(&self) -> usize {
        if self.eps_norm == -1 {
            self.h()
        } else {
            2 * self.h()
        }
    }

    /// The wide class c of I and alpha with I = alpha R_c.
    pub fn locate(&self, i: &QIdeal) -> (usize, QFrac) {
        let f = &self.field;
        let (k, a, b) = f.primitive(i);
        let (ra, rb, g) = f.reduce(a, b);
        let (c, delta) = self.place.get(&(ra, rb)).cloned().expect("every reduced ideal is in a cycle");
        // I = k g J_r and R_c = delta J_r, so I = (k g / delta) R_c
        let alpha = f.fmul(&f.fmul(&QFrac::new(big(k), BigInt::zero(), BigInt::one()), &g), &f.finv(&delta));
        (c, alpha)
    }

    /// The narrow class of I.
    pub fn narrow_class(&self, i: &QIdeal) -> NarrowClass {
        let (c, alpha) = self.locate(i);
        let n = self.field.norm(&QElt { a: alpha.a.clone(), b: alpha.b.clone() });
        let sign = if self.eps_norm == -1 || n.is_positive() { 1 } else { -1 };
        NarrowClass { class: c, sign }
    }

    /// The order of the class of I in the class group (narrow if `narrow`).
    pub fn class_order(&self, i: &QIdeal, narrow: bool) -> usize {
        let f = &self.field;
        let trivial = |j: &QIdeal| if narrow { self.narrow_class(j) == NarrowClass { class: 0, sign: 1 } } else { self.locate(j).0 == 0 };
        let mut j = *i;
        let mut k = 1;
        while !trivial(&j) {
            j = f.ideal_mul(&j, i);
            k += 1;
            assert!(k <= self.narrow_h(), "a class order exceeds the class number");
        }
        k
    }

    /// A generator of I if it is principal.
    pub fn generator(&self, i: &QIdeal) -> Option<QElt> {
        let (c, alpha) = self.locate(i);
        if c != 0 {
            return None;
        }
        // R_0 = O_F: I = alpha O_F
        let g = alpha.integral().expect("a generator of an integral ideal is integral");
        // checked: g generates I
        assert_eq!(self.field.principal(&g).unwrap(), *i, "a generator from the cycle does not generate the ideal");
        Some(g)
    }

    /// A totally positive generator of I, balanced (of least trace among
    /// its totally positive associates), if I is narrowly principal.
    pub fn totally_positive_generator(&self, i: &QIdeal) -> Option<QElt> {
        let f = &self.field;
        let mut g = self.generator(i)?;
        let neg = |x: &QElt| QElt { a: -&x.a, b: -&x.b };
        match f.signs(&g) {
            (Ordering::Greater, Ordering::Greater) => {}
            (Ordering::Less, Ordering::Less) => g = neg(&g),
            _ => {
                if self.eps_norm == 1 {
                    return None;
                }
                g = f.mul(&g, &self.eps);
                if !f.is_totally_positive(&g) {
                    g = neg(&g);
                }
            }
        }
        assert!(f.is_totally_positive(&g));
        // balance: multiply by the totally positive fundamental unit while
        // the trace decreases
        let eta = f.totally_positive_unit();
        let eta_inv = f.conj(&eta); // N(eta) = 1
        for u in [&eta, &eta_inv] {
            loop {
                let h = f.mul(&g, u);
                if f.trace(&h) < f.trace(&g) {
                    g = h;
                } else {
                    break;
                }
            }
        }
        Some(g)
    }

    /// The invariant factors of the class group (wide or narrow), from the
    /// group law on classes (h small).
    fn structure(&self, narrow: bool) -> Vec<i64> {
        let f = &self.field;
        // the elements: representatives, and for the narrow group, also
        // sqrt(D) times them (norm of the generator sqrt D is -D < 0)
        let mut elems: Vec<QIdeal> = self.reps.clone();
        if narrow && self.eps_norm == 1 {
            let sd = f.principal(&f.sqrt_disc()).unwrap();
            elems.extend(self.reps.iter().map(|r| f.ideal_mul(r, &sd)));
        }
        let key = |i: &QIdeal| -> (usize, i8) {
            if narrow {
                let c = self.narrow_class(i);
                (c.class, c.sign)
            } else {
                (self.locate(i).0, 1)
            }
        };
        let keys: Vec<(usize, i8)> = elems.iter().map(key).collect();
        let index: HashMap<(usize, i8), usize> = keys.iter().enumerate().map(|(i, k)| (*k, i)).collect();
        let n = elems.len();
        assert_eq!(index.len(), n, "class representatives are not distinct");
        // multiplication table
        let table: Vec<Vec<usize>> = (0..n).map(|i| (0..n).map(|j| index[&key(&f.ideal_mul(&elems[i], &elems[j]))]).collect()).collect();
        let e = index[&key(&f.unit_ideal())];
        abelian_invariants(&table, e)
    }
}

impl QIdeal {
    fn normalized(self) -> QIdeal {
        QIdeal { a: self.a, b: self.b.rem_euclid(self.a), c: self.c }
    }
}

/// The invariant factors d_1 | d_2 | ... (each > 1) of a finite abelian
/// group given by its multiplication table and identity: from the numbers
/// of elements killed by p^j for each prime p.
pub fn abelian_invariants(table: &[Vec<usize>], e: usize) -> Vec<i64> {
    let n = table.len();
    let pow = |x: usize, k: u64| -> usize {
        let mut r = e;
        for _ in 0..k {
            r = table[r][x];
        }
        r
    };
    let mut factors: Vec<Vec<u64>> = vec![]; // per prime: the cyclic p-power factors
    for (p, _) in crate::field::factor_u64(n as u64) {
        // n_j = log_p #{x : x^(p^j) = 1}
        let mut counts = vec![0u32];
        let mut pj = 1u64;
        loop {
            pj *= p;
            let c = (0..n).filter(|&x| pow(x, pj) == e).count() as u64;
            let mut l = 0u32;
            let mut m = c;
            while m > 1 {
                m /= p;
                l += 1;
            }
            // stable once p^j kills no new element
            let done = l == counts[counts.len() - 1];
            counts.push(l);
            if done || counts.len() > 64 {
                break;
            }
        }
        // the number of cyclic factors of order >= p^j is counts[j] - counts[j-1]
        let mut cyc = vec![];
        for j in 1..counts.len() {
            let ge_j = counts[j] - counts[j - 1];
            let ge_j1 = if j + 1 < counts.len() { counts[j + 1] - counts[j] } else { 0 };
            for _ in 0..(ge_j - ge_j1) {
                cyc.push(p.pow(j as u32));
            }
        }
        cyc.sort_unstable_by(|a, b| b.cmp(a));
        factors.push(cyc);
    }
    // combine: d_k = product over p of the k-th largest p-power
    let len = factors.iter().map(|v| v.len()).max().unwrap_or(0);
    let mut out: Vec<i64> = (0..len).map(|k| factors.iter().map(|v| v.get(k).copied().unwrap_or(1)).product::<u64>() as i64).collect();
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fundamental_units() {
        // eps for Q(sqrt 2), Q(sqrt 3), Q(sqrt 5), Q(sqrt 6), Q(sqrt 7), Q(sqrt 13)
        for (d, a, b, n) in [(2, 1, 1, -1), (3, 2, 1, 1), (5, 0, 1, -1), (6, 5, 2, 1), (7, 8, 3, 1), (13, 1, 1, -1), (94, 2143295, 221064, 1)] {
            let f = QuadField::new(d).unwrap();
            let (e, en) = f.fundamental_unit();
            assert_eq!((e, en), (QElt::new(a, b), n), "d = {}", d);
        }
    }

    #[test]
    fn class_numbers() {
        // h, h+ for some real quadratic fields
        for (d, h, hp) in [(2, 1, 1), (3, 1, 2), (5, 1, 1), (10, 2, 2), (15, 2, 4), (34, 2, 4), (79, 3, 6), (106, 2, 2), (226, 8, 8), (229, 3, 3)] {
            let g = QuadField::new(d).unwrap().class_group();
            assert_eq!((g.h(), g.narrow_h()), (h, hp), "d = {}", d);
            assert_eq!(g.cyc.iter().product::<i64>() as usize, h);
            assert_eq!(g.narrow_cyc.iter().product::<i64>() as usize, hp);
        }
    }

    #[test]
    fn primes_and_generators_match_sqrt5() {
        // Q(sqrt 5) against field.rs: the same primes, totally positive
        // generators generating the same ideals
        let f = QuadField::new(5).unwrap();
        let g = f.class_group();
        let mine = f.primes_of_bounded_norm(500);
        let theirs = crate::field::primes_of_bounded_norm(500);
        assert_eq!(mine.len(), theirs.len());
        for (p, q) in mine.iter().zip(&theirs) {
            assert_eq!((p.ideal.a, p.ideal.b, p.ideal.c), (q.hnf.a as i128, q.hnf.b as i128, q.hnf.c as i128));
            let t = g.totally_positive_generator(&p.ideal).unwrap();
            assert!(f.is_totally_positive(&t));
            assert_eq!(f.principal(&t).unwrap(), p.ideal);
            assert_eq!(f.trace(&t), BigInt::from(q.gen.trace()), "least trace at {:?}", q.gen);
        }
    }

    #[test]
    fn factorization_and_classes() {
        for d in [2i64, 10, 79, 106, 229] {
            let f = QuadField::new(d).unwrap();
            let g = f.class_group();
            for x in -20i64..20 {
                for y in 1i64..12 {
                    let e = QElt::new(x, y);
                    let i = f.principal(&e).unwrap();
                    // factorization multiplies back
                    let mut prod = f.unit_ideal();
                    for (p, k) in f.factor(&i) {
                        for _ in 0..k {
                            prod = f.ideal_mul(&prod, &p.ideal);
                        }
                    }
                    assert_eq!(prod, i);
                    // principal, with a generator generating it
                    let gen = g.generator(&i).expect("principal");
                    assert_eq!(f.principal(&gen).unwrap(), i);
                    // narrowly principal iff some generator is totally positive
                    let tp = g.totally_positive_generator(&i);
                    let expect = g.eps_norm == -1 || f.norm(&e).is_positive();
                    assert_eq!(tp.is_some(), expect, "d = {}, {}", d, e);
                }
            }
            // the class of a product is the product of classes: the ideal
            // P Q R with [P][Q][R] = 1 is principal
            for p in f.primes_of_bounded_norm(60) {
                let (c, _) = g.locate(&p.ideal);
                let pc = f.ideal_conj(&p.ideal);
                // P conj(P) = (N P) is principal
                assert!(g.generator(&f.ideal_mul(&p.ideal, &pc)).is_some());
                let _ = c;
            }
        }
    }
}
