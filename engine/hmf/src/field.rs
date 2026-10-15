//! The ring of integers O_F = Z[w] of F = Q(sqrt 5), w = (1 + sqrt 5)/2,
//! w^2 = w + 1: elements, ideals (Hermite normal form), prime ideals with
//! totally positive generators, and factorization of principal ideals.
//!
//! F has class number one and narrow class number one (the fundamental
//! unit w has norm -1), so every ideal has a totally positive generator;
//! we choose one of small trace (Dembélé 2005, section 3: the Hecke
//! operator T_p uses a totally positive generator pi_p of p).

use std::cmp::Ordering;

/// a + b w.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Elt {
    pub a: i64,
    pub b: i64,
}

pub const ZERO: Elt = Elt { a: 0, b: 0 };
pub const ONE: Elt = Elt { a: 1, b: 0 };
/// The golden ratio w, a fundamental unit of norm -1.
pub const W: Elt = Elt { a: 0, b: 1 };

fn narrow(x: i128) -> i64 {
    i64::try_from(x).expect("Z[w] coefficient overflow")
}

impl Elt {
    pub const fn new(a: i64, b: i64) -> Elt {
        Elt { a, b }
    }
    pub const fn int(a: i64) -> Elt {
        Elt { a, b: 0 }
    }
    pub fn is_zero(&self) -> bool {
        self.a == 0 && self.b == 0
    }
    pub fn add(self, o: Elt) -> Elt {
        Elt { a: self.a + o.a, b: self.b + o.b }
    }
    pub fn sub(self, o: Elt) -> Elt {
        Elt { a: self.a - o.a, b: self.b - o.b }
    }
    pub fn neg(self) -> Elt {
        Elt { a: -self.a, b: -self.b }
    }
    pub fn scale(self, k: i64) -> Elt {
        Elt { a: self.a * k, b: self.b * k }
    }
    /// (a + b w)(c + d w) = ac + bd + (ad + bc + bd) w, since w^2 = w + 1.
    pub fn mul(self, o: Elt) -> Elt {
        let (a, b, c, d) = (self.a as i128, self.b as i128, o.a as i128, o.b as i128);
        Elt { a: narrow(a * c + b * d), b: narrow(a * d + b * c + b * d) }
    }
    /// The Galois conjugate: w -> 1 - w.
    pub fn conj(self) -> Elt {
        Elt { a: self.a + self.b, b: -self.b }
    }
    /// N(a + b w) = a^2 + ab - b^2. For i64 coefficients the value is exact
    /// in i128: |a^2 + ab - b^2| <= (5/4) 2^126 < 2^127 on the box
    /// |a|, |b| <= 2^63. Partial sums can overflow (a^2 + ab alone can exceed
    /// i128), so the sum is formed modulo 2^128, which gives that exact value.
    pub fn norm(self) -> i128 {
        let (a, b) = (self.a as i128, self.b as i128);
        a.wrapping_mul(a).wrapping_add(a.wrapping_mul(b)).wrapping_sub(b.wrapping_mul(b))
    }
    pub fn trace(self) -> i64 {
        2 * self.a + self.b
    }
    /// self / o, if o divides self in O_F. The product self conj(o) is formed
    /// in i128 and divided by N(o) before narrowing, so a quotient that fits
    /// is found even when the product does not fit in i64.
    pub fn div_exact(self, o: Elt) -> Option<Elt> {
        let n = o.norm();
        assert!(n != 0, "division by zero in Z[w]");
        // self conj(o) = (x + y w)(c' - d w), c' = c + d
        let (x, y, c, d) = (self.a as i128, self.b as i128, o.a as i128 + o.b as i128, -(o.b as i128));
        let m = |u: i128, v: i128| u.checked_mul(v).expect("Z[w] product overflows i128");
        let s = |u: i128, v: i128| u.checked_add(v).expect("Z[w] product overflows i128");
        let a = s(m(x, c), m(y, d));
        let b = s(s(m(x, d), m(y, c)), m(y, d));
        if a % n != 0 || b % n != 0 {
            return None;
        }
        Some(Elt { a: i64::try_from(a / n).ok()?, b: i64::try_from(b / n).ok()? })
    }
    /// x / 2, if 2 divides x.
    pub fn half(self) -> Option<Elt> {
        if self.a % 2 != 0 || self.b % 2 != 0 {
            return None;
        }
        Some(Elt { a: self.a / 2, b: self.b / 2 })
    }
    pub fn pow(self, e: u32) -> Elt {
        let mut r = ONE;
        for _ in 0..e {
            r = r.mul(self);
        }
        r
    }
    /// Signs of the two real embeddings, w -> (1 + sqrt 5)/2 and
    /// w -> (1 - sqrt 5)/2, computed exactly.
    pub fn signs(self) -> (Ordering, Ordering) {
        // a + b w = (u + b sqrt 5)/2 with u = 2a + b
        let u = 2 * self.a as i128 + self.b as i128;
        let b = self.b as i128;
        (sign_u_v_sqrt5(u, b), sign_u_v_sqrt5(u, -b))
    }
    pub fn is_totally_positive(self) -> bool {
        self.signs() == (Ordering::Greater, Ordering::Greater)
    }
    /// A totally positive generator of the ideal (self) (one exists since w
    /// has norm -1), of least trace among its multiples by powers of w^2.
    pub fn totally_positive_associate(self) -> Elt {
        assert!(!self.is_zero());
        // in i128: a large associate shrinks only after a few unit steps
        type E = (i128, i128);
        let mul = |x: E, y: E| (x.0 * y.0 + x.1 * y.1, x.0 * y.1 + x.1 * y.0 + x.1 * y.1);
        let tr = |x: E| 2 * x.0 + x.1;
        let mut g: E = (self.a as i128, self.b as i128);
        if self.norm() < 0 {
            g = mul(g, (0, 1));
        }
        // the sign of the first embedding, as in signs()
        if sign_u_v_sqrt5(2 * g.0 + g.1, g.1) == Ordering::Less {
            g = (-g.0, -g.1);
        }
        let w2: E = (1, 1); // w^2, totally positive of norm 1
        let w2inv: E = (2, -1); // w^-2 = 2 - w
        loop {
            let up = mul(g, w2);
            if tr(up) < tr(g) {
                g = up;
                continue;
            }
            let down = mul(g, w2inv);
            if tr(down) < tr(g) {
                g = down;
                continue;
            }
            let g = Elt::new(narrow(g.0), narrow(g.1));
            debug_assert!(g.is_totally_positive());
            return g;
        }
    }
}

/// The sign of u + v sqrt 5.
fn sign_u_v_sqrt5(u: i128, v: i128) -> Ordering {
    let (su, sv) = (u.cmp(&0), v.cmp(&0));
    if su == sv || sv == Ordering::Equal {
        return su;
    }
    if su == Ordering::Equal {
        return sv;
    }
    // opposite signs: compare u^2 with 5 v^2 (never equal, sqrt 5 is irrational)
    if u * u > 5 * v * v {
        su
    } else {
        sv
    }
}

impl std::fmt::Display for Elt {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let wt = |b: i64| match b {
            1 => "w".to_string(),
            -1 => "-w".to_string(),
            _ => format!("{}*w", b),
        };
        match (self.a, self.b) {
            (a, 0) => write!(f, "{}", a),
            (0, b) => write!(f, "{}", wt(b)),
            (a, b) if b < 0 => write!(f, "{} - {}", a, wt(-b)),
            (a, b) => write!(f, "{} + {}", a, wt(b)),
        }
    }
}

/// An ideal of O_F as the lattice Z a + Z (b + c w) in Hermite normal
/// form: a, c > 0, c | a, c | b, 0 <= b < a. Its norm is a c, and a is the
/// least positive integer in the ideal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hnf {
    pub a: u64,
    pub b: u64,
    pub c: u64,
}

pub fn xgcd(a: i128, b: i128) -> (i128, i128, i128) {
    let (mut r0, mut r1, mut s0, mut s1, mut t0, mut t1) = (a, b, 1i128, 0i128, 0i128, 1i128);
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

impl Hnf {
    /// The principal ideal (g), from its Z-basis g, g w.
    pub fn principal(g: Elt) -> Hnf {
        assert!(!g.is_zero());
        // g w = b + (a + b) w, formed in i128 (no narrowing)
        let (x1, y1) = (g.a as i128, g.b as i128);
        let (x2, y2) = (y1, x1 + y1);
        let (c, s, t) = xgcd(y1, y2);
        // |det| / c = |N(g)| / c, exact in i128 as in Elt::norm
        let ax = (y2 / c).wrapping_mul(x1).wrapping_sub((y1 / c).wrapping_mul(x2)).abs();
        let r = |u: i128| u.rem_euclid(ax);
        let b = (r(s) * r(x1) % ax + r(t) * r(x2) % ax) % ax;
        let h = Hnf { a: ax as u64, b: b as u64, c: c as u64 };
        debug_assert!(h.a % h.c == 0 && h.b % h.c == 0, "{:?} is not an ideal", h);
        h
    }
    pub fn norm(&self) -> u64 {
        self.a * self.c
    }
    pub fn contains(&self, x: Elt) -> bool {
        let (xa, xb) = (x.a as i128, x.b as i128);
        let c = self.c as i128;
        if xb.rem_euclid(c) != 0 {
            return false;
        }
        (xa - (xb / c) * self.b as i128).rem_euclid(self.a as i128) == 0
    }
}

pub fn pow_mod(b: u64, mut e: u64, m: u64) -> u64 {
    let m = m as u128;
    let (mut r, mut x) = (1 % m, b as u128 % m);
    while e > 0 {
        if e & 1 == 1 {
            r = r * x % m;
        }
        x = x * x % m;
        e >>= 1;
    }
    r as u64
}

pub fn inv_mod(a: u64, m: u64) -> Option<u64> {
    let (g, s, _) = xgcd(a as i128, m as i128);
    if g != 1 {
        return None;
    }
    Some(s.rem_euclid(m as i128) as u64)
}

pub fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    const BASES: [u64; 12] = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];
    for p in BASES {
        if n % p == 0 {
            return n == p;
        }
    }
    // Miller-Rabin with the first 12 prime bases is deterministic below 3.3e24.
    let (mut d, mut s) = (n - 1, 0);
    while d % 2 == 0 {
        d /= 2;
        s += 1;
    }
    'base: for a in BASES {
        let mut x = pow_mod(a, d, n);
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 1..s {
            x = (x as u128 * x as u128 % n as u128) as u64;
            if x == n - 1 {
                continue 'base;
            }
        }
        return false;
    }
    true
}

/// A square root of a modulo the odd prime p (Tonelli-Shanks), if a is a
/// square.
pub fn sqrt_mod_p(a: u64, p: u64) -> Option<u64> {
    let a = a % p;
    if a == 0 || p == 2 {
        return Some(a);
    }
    if pow_mod(a, (p - 1) / 2, p) != 1 {
        return None;
    }
    let (mut q, mut s) = (p - 1, 0u32);
    while q % 2 == 0 {
        q /= 2;
        s += 1;
    }
    let mut z = 2;
    while pow_mod(z, (p - 1) / 2, p) != p - 1 {
        z += 1;
    }
    let mulm = |x: u64, y: u64| (x as u128 * y as u128 % p as u128) as u64;
    let (mut m, mut c, mut t, mut r) = (s, pow_mod(z, q, p), pow_mod(a, q, p), pow_mod(a, (q + 1) / 2, p));
    while t != 1 {
        let (mut i, mut tt) = (0u32, t);
        while tt != 1 {
            tt = mulm(tt, tt);
            i += 1;
        }
        let b = pow_mod(c, 1u64 << (m - i - 1), p);
        m = i;
        c = mulm(b, b);
        t = mulm(t, c);
        r = mulm(r, b);
    }
    Some(r)
}

/// Factorization of a positive integer by trial division.
pub fn factor_u64(mut n: u64) -> Vec<(u64, u32)> {
    let mut f = vec![];
    let mut p = 2u64;
    while p * p <= n {
        if n % p == 0 {
            let mut e = 0;
            while n % p == 0 {
                n /= p;
                e += 1;
            }
            f.push((p, e));
        }
        p += if p == 2 { 1 } else { 2 };
    }
    if n > 1 {
        f.push((n, 1));
    }
    f
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Split,
    Inert,
    Ramified,
}

/// A nonzero prime ideal of O_F.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Prime {
    /// The rational prime below.
    pub p: u64,
    /// The absolute norm, p or p^2.
    pub norm: u64,
    pub kind: Kind,
    /// A totally positive generator of least trace (see
    /// `Elt::totally_positive_associate`).
    pub gen: Elt,
    pub hnf: Hnf,
}

impl Prime {
    fn from_gen(p: u64, kind: Kind, g: Elt) -> Prime {
        let gen = g.totally_positive_associate();
        let hnf = Hnf::principal(gen);
        Prime { p, norm: hnf.norm(), kind, gen, hnf }
    }
    pub fn contains(&self, x: Elt) -> bool {
        self.hnf.contains(x)
    }
}

impl PartialOrd for Prime {
    fn partial_cmp(&self, o: &Prime) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Prime {
    fn cmp(&self, o: &Prime) -> Ordering {
        (self.norm, self.p, self.hnf).cmp(&(o.norm, o.p, o.hnf))
    }
}

/// A shortest nonzero vector of the 2-dimensional lattice with basis u, v
/// (vectors x + y w as (x, y)) for the positive definite form
/// Q(x + y w) = 2x^2 + 2xy + 3y^2, the sum of the squares of the two real
/// embeddings, by Lagrange-Gauss reduction.
fn shortest(mut u: (i128, i128), mut v: (i128, i128)) -> (i128, i128) {
    let q = |x: (i128, i128)| 2 * x.0 * x.0 + 2 * x.0 * x.1 + 3 * x.1 * x.1;
    let bil = |x: (i128, i128), y: (i128, i128)| 2 * x.0 * y.0 + x.0 * y.1 + x.1 * y.0 + 3 * x.1 * y.1;
    if q(u) > q(v) {
        std::mem::swap(&mut u, &mut v);
    }
    loop {
        // v -= round(B(u, v) / Q(u)) u
        let (n, d) = (bil(u, v), q(u));
        let m = (2 * n + d).div_euclid(2 * d);
        v = (v.0 - m * u.0, v.1 - m * u.1);
        if q(v) >= q(u) {
            return u;
        }
        std::mem::swap(&mut u, &mut v);
    }
}

/// The primes of O_F above the rational prime p, sorted.
pub fn primes_above(p: u64) -> Vec<Prime> {
    assert!(is_prime(p), "{} is not prime", p);
    if p == 5 {
        // (sqrt 5) = (2w - 1)
        return vec![Prime::from_gen(5, Kind::Ramified, Elt::new(-1, 2))];
    }
    if p % 5 == 2 || p % 5 == 3 {
        return vec![Prime::from_gen(p, Kind::Inert, Elt::int(p as i64))];
    }
    // p = +-1 mod 5 splits: x^2 - x - 1 has the roots r = (1 +- sqrt 5)/2
    // mod p, and (p) = (p, w - r)(p, w - r'). The lattice (p, w - r) has
    // covolume p sqrt 5 in the Minkowski embedding, so a shortest vector g has
    // 2|N(g)| <= Q(g) <= (2/sqrt 3) p sqrt 5 < 4p: N(g) = +-p.
    let s = sqrt_mod_p(5, p).expect("5 is a square modulo a split prime");
    let half = (p + 1) / 2;
    let mut v = vec![];
    for t in [s, p - s] {
        let r = ((1 + t) as u128 * half as u128 % p as u128) as u64;
        let g = shortest((p as i128, 0), (-(r as i128), 1));
        let g = Elt::new(narrow(g.0), narrow(g.1));
        assert_eq!(g.norm().unsigned_abs(), p as u128, "no generator of norm p found");
        v.push(Prime::from_gen(p, Kind::Split, g));
    }
    v.sort();
    v
}

/// A nonzero ideal of O_F with its factorization and a totally positive
/// generator.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Ideal {
    pub gen: Elt,
    pub hnf: Hnf,
    /// Distinct primes, sorted, with positive exponents.
    pub factors: Vec<(Prime, u32)>,
}

impl Ideal {
    /// The ideal generated by the nonzero element g.
    pub fn principal(g: Elt) -> Result<Ideal, String> {
        if g.is_zero() {
            return Err("the level must be a nonzero ideal".into());
        }
        let n = g.norm().unsigned_abs();
        if n >= 1u128 << 62 {
            return Err(format!("the norm {} of the level is too large", n));
        }
        let mut factors = vec![];
        let mut rest = g;
        for (p, _) in factor_u64(n as u64) {
            for pr in primes_above(p) {
                let mut e = 0;
                while let Some(q) = rest.div_exact(pr.gen) {
                    rest = q;
                    e += 1;
                }
                if e > 0 {
                    factors.push((pr, e));
                }
            }
        }
        assert_eq!(rest.norm().abs(), 1, "factorization of {} incomplete", g);
        factors.sort();
        Ok(Ideal::from_factors(factors))
    }
    /// The ideal generated by the given elements (not all zero). F has class
    /// number one, and a shortest vector of the ideal's lattice for the
    /// Minkowski form 2x^2 + 2xy + 3y^2 generates it: if the ideal has norm n
    /// (covolume n sqrt 5), that vector g has 2|N(g)| <= (2/sqrt 3) n sqrt 5
    /// < 4n, and n divides N(g), so |N(g)| = n.
    pub fn from_gens(gens: &[Elt]) -> Result<Ideal, String> {
        let nonzero: Vec<Elt> = gens.iter().copied().filter(|g| !g.is_zero()).collect();
        if nonzero.len() == 1 {
            return Ideal::principal(nonzero[0]);
        }
        let mut vecs: Vec<(i128, i128)> = vec![];
        for g in &nonzero {
            if g.a.unsigned_abs() >= 1 << 40 || g.b.unsigned_abs() >= 1 << 40 {
                return Err("generators of an ideal (when there are several) must have coefficients below 2^40".into());
            }
            let (a, b) = (g.a as i128, g.b as i128);
            vecs.push((a, b));
            vecs.push((b, a + b)); // g w
        }
        if vecs.is_empty() {
            return Err("the zero ideal is not a level".into());
        }
        // the lattice spanned, reduced to a basis by integer row operations
        let (mut u, mut v) = (vecs[0], vecs[1]);
        for &x in &vecs[2..] {
            // basis of span(u, v, x): eliminate with the second coordinate, then the first
            let rows = [u, v, x];
            let (g, s, t) = xgcd(rows[0].1, rows[1].1);
            let (g2, s2, t2) = xgcd(g, rows[2].1);
            let r = (s2 * (s * rows[0].0 + t * rows[1].0) + t2 * rows[2].0, g2);
            // vectors with second coordinate 0: their first coordinates' gcd
            let z1 = if g == 0 { 0 } else { (rows[1].1 / g) * rows[0].0 - (rows[0].1 / g) * rows[1].0 };
            let z2 = if g2 == 0 { 0 } else { (rows[2].1 / g2) * (s * rows[0].0 + t * rows[1].0) - (g / g2) * rows[2].0 };
            let a = xgcd(z1, z2).0;
            u = (a, 0);
            v = r;
        }
        if u.0 * v.1 - u.1 * v.0 == 0 {
            return Err("the elements do not generate a nonzero ideal".into());
        }
        if (u.0 * v.1 - u.1 * v.0).unsigned_abs() >= 1 << 62 {
            return Err("the norm of the ideal is too large".into());
        }
        // u = (A, 0) and v = (B, C) with C | A: reduce B modulo A
        let v = (v.0.rem_euclid(u.0.abs()), v.1);
        let g = shortest(u, v);
        let g = Elt::new(i64::try_from(g.0).map_err(|_| "ideal too large")?, i64::try_from(g.1).map_err(|_| "ideal too large")?);
        let n = (u.0 * v.1 - u.1 * v.0).unsigned_abs();
        if g.norm().unsigned_abs() != n {
            return Err("internal error: no generator of the ideal's norm".into());
        }
        Ideal::principal(g)
    }
    pub fn from_factors(factors: Vec<(Prime, u32)>) -> Ideal {
        let mut g = ONE;
        for (p, e) in &factors {
            g = g.mul(p.gen.pow(*e));
        }
        let gen = g.totally_positive_associate();
        Ideal { gen, hnf: Hnf::principal(gen), factors }
    }
    pub fn norm(&self) -> u64 {
        self.hnf.norm()
    }
    pub fn is_one(&self) -> bool {
        self.factors.is_empty()
    }
}

/// The rational primes up to n.
pub fn rational_primes(n: u64) -> Vec<u64> {
    let n = n as usize;
    let mut sieve = vec![true; n + 1];
    let mut v = vec![];
    for i in 2..=n {
        if sieve[i] {
            v.push(i as u64);
            let mut j = i * i;
            while j <= n {
                sieve[j] = false;
                j += i;
            }
        }
    }
    v
}

/// The prime ideals of norm at most bound, sorted by norm.
pub fn primes_of_bounded_norm(bound: u64) -> Vec<Prime> {
    let mut v: Vec<Prime> = rational_primes(bound).into_iter().flat_map(primes_above).filter(|p| p.norm <= bound).collect();
    v.sort();
    v
}

/// All nonzero ideals of norm at most bound (the unit ideal included),
/// sorted by (norm, HNF).
pub fn ideals_of_bounded_norm(bound: u64) -> Vec<Ideal> {
    fn rec(primes: &[Prime], i: usize, norm: u64, bound: u64, cur: &mut Vec<(Prime, u32)>, out: &mut Vec<Ideal>) {
        if i == primes.len() {
            out.push(Ideal::from_factors(cur.clone()));
            return;
        }
        rec(primes, i + 1, norm, bound, cur, out);
        let (p, mut n, mut e) = (primes[i], norm, 0);
        while n <= bound / p.norm {
            n *= p.norm;
            e += 1;
            cur.push((p, e));
            rec(primes, i + 1, n, bound, cur, out);
            cur.pop();
        }
    }
    let primes = primes_of_bounded_norm(bound);
    let mut out = vec![];
    rec(&primes, 0, 1, bound, &mut vec![], &mut out);
    out.sort_by_key(|i| (i.norm(), i.hnf));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic() {
        let x = Elt::new(3, -2);
        let y = Elt::new(-1, 5);
        assert_eq!(x.mul(y).norm(), x.norm() * y.norm());
        assert_eq!(x.mul(y).div_exact(y), Some(x));
        assert_eq!(W.mul(W), Elt::new(1, 1));
        assert_eq!(W.norm(), -1);
        assert!(Elt::new(2, 1).is_totally_positive());
        assert!(!Elt::new(-1, 2).is_totally_positive());
        assert_eq!(Elt::new(-1, 2).totally_positive_associate().norm(), 5);
    }

    #[test]
    fn primes() {
        let ps = primes_of_bounded_norm(100);
        let norms: Vec<u64> = ps.iter().map(|p| p.norm).collect();
        assert_eq!(norms, vec![4, 5, 9, 11, 11, 19, 19, 29, 29, 31, 31, 41, 41, 49, 59, 59, 61, 61, 71, 71, 79, 79, 89, 89]);
        for p in &ps {
            assert!(p.gen.is_totally_positive());
            assert_eq!(p.gen.norm() as u64, p.norm);
            assert_eq!(p.hnf.norm(), p.norm);
        }
    }

    #[test]
    fn factorization() {
        let i = Ideal::principal(Elt::int(30)).unwrap();
        assert_eq!(i.norm(), 900);
        let f: Vec<(u64, u32)> = i.factors.iter().map(|(p, e)| (p.norm, *e)).collect();
        assert_eq!(f, vec![(4, 1), (5, 2), (9, 1)]);
        // ideals of norm <= 300 (PSAGE's tables.ideals_of_bounded_norm(300), plus (1))
        assert_eq!(ideals_of_bounded_norm(300).len(), 128);
        // ideals from generators
        for p in primes_of_bounded_norm(200) {
            let r = p.hnf;
            let i = Ideal::from_gens(&[Elt::int(p.p as i64), Elt::new(r.b as i64, r.c as i64)]).unwrap();
            assert_eq!(i.hnf, p.hnf);
        }
        let i = Ideal::from_gens(&[Elt::int(6), Elt::int(10)]).unwrap();
        assert_eq!(i.hnf, Ideal::principal(Elt::int(2)).unwrap().hnf);
        let i = Ideal::from_gens(&[Elt::new(-38, 2).mul(W), Elt::new(-38, 2).scale(3)]).unwrap();
        assert_eq!(i.norm(), 1364);
    }
}
