//! Polynomials over a number field K = Q[y]/(T), T monic in Z[y] and
//! irreducible: gcds, square-free decomposition and factorization, exact.
//!
//! An element of K is given by its coordinates on 1, y, ..., y^(n-1); a
//! polynomial over K (KPoly) by integer coordinates over one common
//! denominator.
//!
//! * gcd (multimodular): at primes p not dividing disc(T) (T square-free
//!   mod p), Euclid in R_p[x], R_p = F_p[y]/(T mod p), with the remainders
//!   made monic (a prime where a leading coefficient is a zero divisor of
//!   R_p is skipped); the monic gcds of least degree and the cofactors are
//!   combined by Chinese remaindering and rational reconstruction, and
//!   accepted once f = G A and g = G B hold exactly.  G is then the gcd: it
//!   divides both, and at such a p (p prime to the denominators, the
//!   leading coefficients units mod p) the monic gcd over K is p-integral
//!   (Gauss's lemma: Z[y] localized at p is O_K localized at p when p does
//!   not divide disc(T)), so its reduction divides the gcd mod p, whose
//!   degree is deg G.
//! * square-free decomposition: Yun's algorithm with those gcds
//!   (von zur Gathen and Gerhard, Modern Computer Algebra, Algorithm 14.21).
//! * factorization of a square-free monic h (Trager's norm method: Cohen,
//!   A Course in Computational Algebraic Number Theory, GTM 138, section
//!   3.6.2, Algorithm 3.6.4): for k = 0, 1, -1, 2, ... the norm
//!   N(x) = Res_y(T(y), h(x - k y)) until it is square-free (certified
//!   modulo a prime where it keeps its degree); its irreducible factors g
//!   over Z (factor(), Zassenhaus) give the irreducible factors
//!   gcd(h(x - k y), g)(x + k y) of h.  The norm is computed modulo primes
//!   (resultants at D + 1 points, interpolation) past twice a bound on its
//!   coefficients: N = prod over the roots a of T of h(x - k a), so each
//!   coefficient is at most (sum_i sum_j |c_ij| R^j)^n, R = 1 + max |t_k|
//!   bounding the roots of T (Cauchy).
//! * factor() checks its result by multiplying it back.

use super::{fdivrem_u as fdivrem, fgcd_u as fgcd, fmul_u as fmul, ftrim, finv, try_factor, FPoly};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// A polynomial over K: coefficient i is num[i] / den (num[i] the n integer
/// coordinates), constant term first, no trailing zero coefficient; den > 0
/// and prime to the content of num.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KPoly {
    pub num: Vec<Vec<BigInt>>,
    pub den: BigInt,
}

impl KPoly {
    /// Normalized: trailing zeros dropped, the denominator positive and
    /// coprime to the coordinates.
    pub fn new(n: usize, mut num: Vec<Vec<BigInt>>, den: BigInt) -> KPoly {
        assert!(!den.is_zero(), "zero denominator");
        for c in num.iter_mut() {
            c.resize(n, BigInt::zero());
        }
        while num.last().map_or(false, |c| c.iter().all(|x| x.is_zero())) {
            num.pop();
        }
        let mut g = den.abs();
        for c in &num {
            for x in c {
                if g.is_one() {
                    break;
                }
                g = g.gcd(x);
            }
        }
        let sign = if den.is_negative() { -BigInt::one() } else { BigInt::one() };
        let g = g * sign;
        if !g.is_one() {
            for c in num.iter_mut() {
                for x in c.iter_mut() {
                    *x = &*x / &g;
                }
            }
        }
        let den = den / g;
        if num.is_empty() {
            return KPoly { num, den: BigInt::one() };
        }
        KPoly { num, den }
    }

    /// The polynomial with integer coefficients f (constant first).
    pub fn from_z(n: usize, f: &[BigInt]) -> KPoly {
        KPoly::new(n, f.iter().map(|c| { let mut v = vec![BigInt::zero(); n]; v[0] = c.clone(); v }).collect(), BigInt::one())
    }

    pub fn is_zero(&self) -> bool {
        self.num.is_empty()
    }

    /// The degree (-1 for 0).
    pub fn degree(&self) -> isize {
        self.num.len() as isize - 1
    }
}

/// K = Q[y]/(T).
pub struct Field {
    t: Vec<BigInt>,
    n: usize,
}

/// Arithmetic modulo p in R_p = F_p[y]/(T mod p).
struct Ctx {
    p: u64,
    tp: FPoly,
    /// -T mod p (its first n coefficients), for the reduction y^n = -sum t_i y^i
    tneg: Vec<u64>,
    n: usize,
}

type RElt = Vec<u64>;
type RPoly = Vec<RElt>;

fn is_prime_u64(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    let mut d = 2u64;
    while d * d <= n {
        if n % d == 0 {
            return false;
        }
        d += 1;
    }
    true
}

/// Primes below 2^31, descending.
fn primes() -> impl Iterator<Item = u64> {
    (1u64 << 30..(1u64 << 31)).rev().filter(|&p| p % 2 == 1 && is_prime_u64(p))
}

fn modp(x: &BigInt, p: u64) -> u64 {
    x.mod_floor(&BigInt::from(p)).to_u64().unwrap()
}

impl Ctx {
    fn zero(&self) -> RElt {
        vec![0; self.n]
    }

    fn pad(&self, mut a: FPoly) -> RElt {
        a.resize(self.n, 0);
        a
    }

    fn is_zero(a: &RElt) -> bool {
        a.iter().all(|&x| x == 0)
    }

    fn mul(&self, a: &RElt, b: &RElt) -> RElt {
        let mut acc = vec![0u64; self.n];
        let mut scratch = vec![0u64; 2 * self.n];
        self.mul_add_into(&mut acc, a, b, true, &mut scratch);
        acc
    }

    /// acc += a b (or acc -= a b when sub), without allocating: scratch
    /// holds 2n words.
    fn mul_add_into(&self, acc: &mut [u64], a: &[u64], b: &[u64], add: bool, scratch: &mut [u64]) {
        let (n, p) = (self.n, self.p);
        let r = &mut scratch[..2 * n - 1];
        r.iter_mut().for_each(|x| *x = 0);
        for (i, &x) in a.iter().enumerate() {
            if x == 0 {
                continue;
            }
            for (j, &y) in b.iter().enumerate() {
                r[i + j] = (r[i + j] + x * y) % p;
            }
        }
        for k in (n..2 * n - 1).rev() {
            let c = r[k];
            if c == 0 {
                continue;
            }
            for i in 0..n {
                r[k - n + i] = (r[k - n + i] + c * self.tneg[i]) % p;
            }
        }
        for i in 0..n {
            acc[i] = if add { (acc[i] + r[i]) % p } else { (acc[i] + p - r[i]) % p };
        }
    }

    /// The inverse, or None for a zero divisor.
    fn inv(&self, a: &RElt) -> Option<RElt> {
        let p = self.p;
        let (mut r0, mut r1) = (self.tp.clone(), ftrim(a.clone()));
        let (mut s0, mut s1): (FPoly, FPoly) = (vec![], vec![1]);
        while !r1.is_empty() {
            let (q, r) = fdivrem(&r0, &r1, p);
            let qs = fmul(&q, &s1, p);
            let n = s0.len().max(qs.len());
            let s2 = ftrim((0..n).map(|i| (s0.get(i).copied().unwrap_or(0) + p - qs.get(i).copied().unwrap_or(0)) % p).collect());
            r0 = r1;
            r1 = r;
            s0 = s1;
            s1 = s2;
        }
        if r0.len() != 1 {
            return None;
        }
        let c = finv(r0[0], p);
        Some(self.pad(fdivrem(&s0.iter().map(|&x| x * c % p).collect::<Vec<_>>(), &self.tp, p).1))
    }

    fn trim(mut f: RPoly) -> RPoly {
        while f.last().map_or(false, Ctx::is_zero) {
            f.pop();
        }
        f
    }

    /// f / lc(f), or None if lc(f) is a zero divisor.
    fn monic(&self, f: &RPoly) -> Option<RPoly> {
        let inv = self.inv(f.last()?)?;
        Some(f.iter().map(|c| self.mul(c, &inv)).collect())
    }

    /// (q, r) with a = q b + r, b monic.
    fn divrem_monic(&self, a: &RPoly, b: &RPoly) -> (RPoly, RPoly) {
        let mut r = a.clone();
        let db = b.len() - 1;
        if r.len() < b.len() {
            return (vec![], r);
        }
        let mut q = vec![self.zero(); r.len() - db];
        let mut scratch = vec![0u64; 2 * self.n];
        for i in (0..q.len()).rev() {
            let c = r[i + db].clone();
            if Ctx::is_zero(&c) {
                continue;
            }
            for (j, bj) in b.iter().enumerate() {
                self.mul_add_into(&mut r[i + j], &c, bj, false, &mut scratch);
            }
            q[i] = c;
        }
        r.truncate(db);
        (Ctx::trim(q), Ctx::trim(r))
    }

    /// The monic gcd, or None if a zero divisor of R_p turns up.
    fn gcd(&self, a: &RPoly, b: &RPoly) -> Option<RPoly> {
        let (mut a, mut b) = (a.clone(), b.clone());
        if a.is_empty() {
            std::mem::swap(&mut a, &mut b);
        }
        let mut a = self.monic(&a)?;
        while !b.is_empty() {
            let bm = self.monic(&b)?;
            let (_, r) = self.divrem_monic(&a, &bm);
            a = bm;
            b = r;
        }
        Some(a)
    }
}

/// a / b with |a|, |b| <= sqrt(m / 2), b > 0, a = x b mod m (Wang).
fn ratrec(x: &BigInt, m: &BigInt) -> Option<(BigInt, BigInt)> {
    let bound = (m >> 1usize).sqrt();
    let (mut r0, mut r1) = (m.clone(), x.mod_floor(m));
    let (mut t0, mut t1) = (BigInt::zero(), BigInt::one());
    while r1 > bound {
        let q = &r0 / &r1;
        let r2 = &r0 - &q * &r1;
        let t2 = &t0 - &q * &t1;
        r0 = std::mem::replace(&mut r1, r2);
        t0 = std::mem::replace(&mut t1, t2);
    }
    if t1.is_zero() || t1.abs() > bound || !r1.gcd(&t1).is_one() {
        return None;
    }
    if t1.is_negative() {
        Some((-r1, -t1))
    } else {
        Some((r1, t1))
    }
}

/// Chinese remaindering of residue vectors: x = residues mod m.
struct Crt {
    x: Vec<BigInt>,
    m: BigInt,
}

impl Crt {
    fn new() -> Crt {
        Crt { x: vec![], m: BigInt::one() }
    }

    fn add(&mut self, r: &[u64], p: u64) {
        if self.x.is_empty() {
            self.x = r.iter().map(|&v| BigInt::from(v)).collect();
            self.m = BigInt::from(p);
            return;
        }
        let pb = BigInt::from(p);
        let minv = finv(modp(&self.m, p), p);
        for (x, &v) in self.x.iter_mut().zip(r) {
            let xm = modp(x, p);
            let t = (v + p - xm) % p * minv % p;
            *x = &*x + &self.m * BigInt::from(t);
        }
        self.m = &self.m * &pb;
    }

    /// The rationals with these residues, over one common denominator.
    fn rationals(&self) -> Option<(Vec<BigInt>, BigInt)> {
        let mut out = Vec::with_capacity(self.x.len());
        let mut den = BigInt::one();
        for x in &self.x {
            // most coordinates share the denominator found so far
            let y = (x * &den).mod_floor(&self.m);
            let (a, b) = ratrec(&y, &self.m)?;
            if !b.is_one() {
                for o in out.iter_mut() {
                    *o = &*o * &b;
                }
                den = den * &b;
            }
            out.push(a);
        }
        Some((out, den))
    }
}

impl Field {
    /// The field Q[y]/(T) for T monic irreducible over Z (constant first).
    pub fn new(t: &[BigInt]) -> Result<Field, String> {
        let mut t = t.to_vec();
        while t.last().map_or(false, |c| c.is_zero()) {
            t.pop();
        }
        if t.len() < 2 || !t.last().unwrap().is_one() {
            return Err("the defining polynomial must be monic of degree >= 1".into());
        }
        if !super::try_is_irreducible(&t).map_err(|e| e.to_string())? {
            return Err("the defining polynomial must be irreducible".into());
        }
        let n = t.len() - 1;
        Ok(Field { t, n })
    }

    pub fn degree(&self) -> usize {
        self.n
    }

    /// The product of two elements (integer coordinates), reduced mod T.
    fn emul(&self, a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
        let n = self.n;
        let mut r = vec![BigInt::zero(); 2 * n - 1];
        for (i, x) in a.iter().enumerate() {
            if x.is_zero() {
                continue;
            }
            for (j, y) in b.iter().enumerate() {
                if !y.is_zero() {
                    r[i + j] += x * y;
                }
            }
        }
        for k in (n..2 * n - 1).rev() {
            let c = std::mem::take(&mut r[k]);
            if c.is_zero() {
                continue;
            }
            for (i, ti) in self.t[..n].iter().enumerate() {
                if !ti.is_zero() {
                    r[k - n + i] -= &c * ti;
                }
            }
        }
        r.truncate(n);
        r
    }

    /// f g, exactly.
    pub fn mul(&self, f: &KPoly, g: &KPoly) -> KPoly {
        if f.is_zero() || g.is_zero() {
            return KPoly::new(self.n, vec![], BigInt::one());
        }
        let mut num = vec![vec![BigInt::zero(); self.n]; f.num.len() + g.num.len() - 1];
        for (i, a) in f.num.iter().enumerate() {
            if a.iter().all(|x| x.is_zero()) {
                continue;
            }
            for (j, b) in g.num.iter().enumerate() {
                if b.iter().all(|x| x.is_zero()) {
                    continue;
                }
                let c = self.emul(a, b);
                for (s, x) in num[i + j].iter_mut().zip(c) {
                    *s += x;
                }
            }
        }
        KPoly::new(self.n, num, &f.den * &g.den)
    }

    fn sub(&self, f: &KPoly, g: &KPoly) -> KPoly {
        let len = f.num.len().max(g.num.len());
        let zero = vec![BigInt::zero(); self.n];
        let num = (0..len)
            .map(|i| {
                let a = f.num.get(i).unwrap_or(&zero);
                let b = g.num.get(i).unwrap_or(&zero);
                a.iter().zip(b).map(|(x, y)| x * &g.den - y * &f.den).collect()
            })
            .collect();
        KPoly::new(self.n, num, &f.den * &g.den)
    }

    fn derivative(&self, f: &KPoly) -> KPoly {
        let num = f.num.iter().enumerate().skip(1).map(|(i, c)| c.iter().map(|x| x * BigInt::from(i)).collect()).collect();
        KPoly::new(self.n, num, f.den.clone())
    }

    /// f(x + k y).
    pub fn shift(&self, f: &KPoly, k: i64) -> KPoly {
        if k == 0 || f.is_zero() {
            return f.clone();
        }
        let n = self.n;
        let mut c = vec![BigInt::zero(); n];
        if n == 1 {
            c[0] = BigInt::from(k) * -&self.t[0]; // y = -t_0 when n = 1
        } else {
            c[1] = BigInt::from(k);
        }
        // Horner: r = r (x + c) + f_i
        let mut r: Vec<Vec<BigInt>> = vec![];
        for fi in f.num.iter().rev() {
            let mut nr = vec![vec![BigInt::zero(); n]; r.len() + 1];
            for (j, rj) in r.iter().enumerate() {
                for (s, x) in nr[j + 1].iter_mut().zip(rj) {
                    *s += x;
                }
                let t = self.emul(&c, rj);
                for (s, x) in nr[j].iter_mut().zip(t) {
                    *s += x;
                }
            }
            for (s, x) in nr[0].iter_mut().zip(fi) {
                *s += x;
            }
            r = nr;
        }
        KPoly::new(n, r, f.den.clone())
    }

    fn ctx(&self, p: u64) -> Option<Ctx> {
        let tp: FPoly = self.t.iter().map(|c| modp(c, p)).collect();
        // T square-free mod p (p does not divide disc(T))
        let dt: FPoly = ftrim(tp.iter().enumerate().skip(1).map(|(i, &c)| c * (i as u64 % p) % p).collect());
        if fgcd(&tp, &dt, p).len() != 1 {
            return None;
        }
        let tneg = tp[..self.n].iter().map(|&c| (p - c) % p).collect();
        Some(Ctx { p, tp, tneg, n: self.n })
    }

    /// f mod p, or None if p divides its denominator.
    fn reduce(&self, f: &KPoly, ctx: &Ctx) -> Option<RPoly> {
        let p = ctx.p;
        let d = modp(&f.den, p);
        if d == 0 {
            return None;
        }
        let di = finv(d, p);
        Some(Ctx::trim(f.num.iter().map(|c| c.iter().map(|x| modp(x, p) * di % p).collect()).collect()))
    }

    /// The monic gcd G of f and g (not both 0) with the cofactors f/G and
    /// g/G, proven (see the module documentation).
    pub fn gcd(&self, f: &KPoly, g: &KPoly) -> Result<(KPoly, KPoly, KPoly), String> {
        let n = self.n;
        if f.is_zero() && g.is_zero() {
            return Err("gcd(0, 0)".into());
        }
        let one = KPoly::new(n, vec![{ let mut v = vec![BigInt::zero(); n]; v[0] = BigInt::one(); v }], BigInt::one());
        let mut best: Option<usize> = None;
        let mut crt = Crt::new();
        let mut used = 0usize;
        let mut next_try = 1usize;
        let mut last: Option<Vec<(Vec<BigInt>, BigInt)>> = None;
        for p in primes() {
            sagebrush_interrupt::check();
            let Some(ctx) = self.ctx(p) else { continue };
            let (Some(fp), Some(gp)) = (self.reduce(f, &ctx), self.reduce(g, &ctx)) else { continue };
            // the leading coefficients must stay units
            if fp.len() != f.num.len() || gp.len() != g.num.len() {
                continue;
            }
            if fp.last().map_or(false, |c| ctx.inv(c).is_none()) || gp.last().map_or(false, |c| ctx.inv(c).is_none()) {
                continue;
            }
            let Some(hp) = ctx.gcd(&fp, &gp) else { continue };
            let d = hp.len() - 1;
            if d == 0 {
                // coprime: proven by the degree argument
                return Ok((one, f.clone(), g.clone()));
            }
            match best {
                Some(b) if d > b => continue,
                Some(b) if d == b => {}
                _ => {
                    best = Some(d);
                    crt = Crt::new();
                    used = 0;
                    next_try = 1;
                    last = None;
                }
            }
            let (a, ra) = ctx.divrem_monic(&fp, &hp);
            let (b, rb) = ctx.divrem_monic(&gp, &hp);
            if !ra.is_empty() || !rb.is_empty() {
                return Err("internal: the modular gcd does not divide".into());
            }
            let mut res: Vec<u64> = vec![];
            for poly in [&hp, &a, &b] {
                res.push(poly.len() as u64);
                for c in poly.iter() {
                    res.extend_from_slice(c);
                }
            }
            if !crt.x.is_empty() && crt.x.len() != res.len() {
                return Err("internal: the cofactor degrees changed".into());
            }
            crt.add(&res, p);
            used += 1;
            if used < next_try {
                continue;
            }
            next_try = used + used / 2 + 1;
            // reconstruct each of the three polynomials over its own denominator
            let mut parts = vec![];
            let mut pos = 0;
            let mut ok = true;
            for _ in 0..3 {
                let len = crt.x[pos].to_usize().unwrap_or(0);
                pos += 1;
                let sub = Crt { x: crt.x[pos..pos + len * n].to_vec(), m: crt.m.clone() };
                pos += len * n;
                match sub.rationals() {
                    Some(r) => parts.push(r),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            if last.as_ref() != Some(&parts) {
                last = Some(parts);
                continue;
            }
            let polys: Vec<KPoly> = parts
                .iter()
                .map(|(v, den)| KPoly::new(n, v.chunks(n).map(|c| c.to_vec()).collect(), den.clone()))
                .collect();
            let (gg, aa, bb) = (&polys[0], &polys[1], &polys[2]);
            if self.mul(gg, aa) == *f && self.mul(gg, bb) == *g {
                return Ok((gg.clone(), aa.clone(), bb.clone()));
            }
        }
        Err("out of primes".into())
    }

    /// The square-free decomposition: monic s_i with f = lc(f) prod s_i^i
    /// (Yun), as (s_i, i) for the s_i of positive degree.
    pub fn squarefree(&self, f: &KPoly) -> Result<Vec<(KPoly, u32)>, String> {
        if f.degree() < 1 {
            return Ok(vec![]);
        }
        let (_, mut c, mut d) = self.gcd(f, &self.derivative(f))?;
        let mut out = vec![];
        let mut i = 1u32;
        while c.degree() > 0 {
            let e = self.sub(&d, &self.derivative(&c));
            let (g, c2, d2) = self.gcd(&c, &e)?;
            if g.degree() > 0 {
                out.push((g, i));
            }
            c = c2;
            d = d2;
            i += 1;
        }
        Ok(out)
    }

    /// N(x) = Res_y(T(y), h(x, y)) for h with integer coordinates (num).
    pub fn norm(&self, h: &[Vec<BigInt>]) -> Vec<BigInt> {
        let n = self.n;
        let dh = h.len() - 1;
        let big_d = n * dh;
        // the bound (sum_i sum_j |c_ij| R^j)^n
        let r = BigInt::one() + self.t[..n].iter().map(|c| c.abs()).max().unwrap();
        let mut s = BigInt::zero();
        for c in h {
            let mut rj = BigInt::one();
            for x in c {
                s += x.abs() * &rj;
                rj = &rj * &r;
            }
        }
        let bound = num_traits::pow(s, n) * BigInt::from(2);
        let mut crt = Crt::new();
        for p in primes() {
            sagebrush_interrupt::check();
            if crt.m > bound {
                break;
            }
            let tp: FPoly = self.t.iter().map(|c| modp(c, p)).collect();
            let hp: Vec<Vec<u64>> = h.iter().map(|c| c.iter().map(|x| modp(x, p)).collect()).collect();
            // values at x = 0..=D
            let mut vals = Vec::with_capacity(big_d + 1);
            for x0 in 0..=big_d as u64 {
                // h(x0, y) as a polynomial in y
                let mut hy = vec![0u64; n];
                let mut pw = 1u64;
                for c in &hp {
                    for (s, &v) in hy.iter_mut().zip(c) {
                        *s = (*s + v * pw) % p;
                    }
                    pw = pw * x0 % p;
                }
                vals.push(fres(&tp, &ftrim(hy), p));
            }
            let np = interpolate(&vals, p);
            let mut full = np;
            full.resize(big_d + 1, 0);
            crt.add(&full, p);
        }
        let half = &crt.m >> 1usize;
        let mut out: Vec<BigInt> = crt.x.iter().map(|x| if *x > half { x - &crt.m } else { x.clone() }).collect();
        while out.last().map_or(false, |c| c.is_zero()) {
            out.pop();
        }
        out
    }

    /// The irreducible factors of a monic square-free h (Trager).
    fn factor_squarefree(&self, h: &KPoly) -> Result<Vec<KPoly>, String> {
        if h.degree() <= 1 {
            return Ok(vec![h.clone()]);
        }
        for step in 0..64i64 {
            let k = if step % 2 == 1 { (step + 1) / 2 } else { -(step / 2) };
            let hk = self.shift(h, -k);
            let nrm = self.norm(&hk.num);
            if !certified_squarefree(&nrm) {
                continue;
            }
            let (_, fs) = try_factor(&nrm).map_err(|e| e.to_string())?;
            if fs.len() == 1 {
                return Ok(vec![h.clone()]);
            }
            let mut out = vec![];
            for (g, _) in fs {
                let (gk, _, _) = self.gcd(&hk, &KPoly::from_z(self.n, &g))?;
                out.push(self.shift(&gk, k));
            }
            return Ok(out);
        }
        Err("no shift with a square-free norm".into())
    }

    /// f = u prod g^e with u = lc(f) (coordinates over a denominator) and
    /// the g monic irreducible; checked by multiplying back.
    #[allow(clippy::type_complexity)]
    pub fn factor(&self, f: &KPoly) -> Result<((Vec<BigInt>, BigInt), Vec<(KPoly, u32)>), String> {
        if f.is_zero() {
            return Err("factorization of 0 is not defined".into());
        }
        let n = self.n;
        let unit = (f.num.last().unwrap().clone(), f.den.clone());
        let mut out = vec![];
        for (s, e) in self.squarefree(f)? {
            for g in self.factor_squarefree(&s)? {
                out.push((g, e));
            }
        }
        // multiply back: lc(f) prod g^e == f
        let mut prod = KPoly::new(n, vec![unit.0.clone()], unit.1.clone());
        for (g, e) in &out {
            for _ in 0..*e {
                prod = self.mul(&prod, g);
            }
        }
        if prod != *f {
            return Err("internal: the factorization does not multiply back".into());
        }
        Ok((unit, out))
    }
}

/// Whether N (integer coefficients) is square-free, certified modulo a prime
/// where it keeps its degree; false when no prime tried certifies it.
fn certified_squarefree(nrm: &[BigInt]) -> bool {
    for p in primes().take(4) {
        let np: FPoly = nrm.iter().map(|c| modp(c, p)).collect();
        if np.last() == Some(&0) {
            continue;
        }
        let d = ftrim(np.iter().enumerate().skip(1).map(|(i, &c)| c * (i as u64 % p) % p).collect());
        if fgcd(&np, &d, p).len() == 1 {
            return true;
        }
    }
    false
}

/// Res(a, b) over F_p, a monic (b may be 0).
fn fres(a: &[u64], b: &[u64], p: u64) -> u64 {
    if b.is_empty() {
        return 0;
    }
    let (mut a, mut b) = (a.to_vec(), b.to_vec());
    let mut res = 1u64;
    loop {
        let (da, db) = (a.len() - 1, b.len() - 1);
        if db == 0 {
            return res * super::powmod_u(b[0], da as u64, p) % p;
        }
        let r = fdivrem(&a, &b, p).1;
        if r.is_empty() {
            return 0;
        }
        let dr = r.len() - 1;
        if (da * db) % 2 == 1 {
            res = (p - res) % p;
        }
        res = res * super::powmod_u(*b.last().unwrap(), (da - dr) as u64, p) % p;
        a = b;
        b = r;
    }
}

/// The polynomial of degree <= D with these values at 0, 1, ..., D (mod p).
fn interpolate(vals: &[u64], p: u64) -> FPoly {
    let m = vals.len();
    // Newton divided differences at the points 0..m-1
    let mut c = vals.to_vec();
    for j in 1..m {
        for i in (j..m).rev() {
            let num = (c[i] + p - c[i - 1]) % p;
            c[i] = num * finv(j as u64 % p, p) % p;
        }
    }
    // expand: P = c0 + (x - 0)(c1 + (x - 1)(c2 + ...))
    let mut poly: FPoly = vec![c[m - 1]];
    for i in (0..m - 1).rev() {
        // poly = poly (x - i) + c_i
        let mut np = vec![0u64; poly.len() + 1];
        for (j, &v) in poly.iter().enumerate() {
            np[j + 1] = (np[j + 1] + v) % p;
            np[j] = (np[j] + p - v * (i as u64 % p) % p) % p;
        }
        np[0] = (np[0] + c[i]) % p;
        poly = np;
    }
    ftrim(poly)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(v: i64) -> BigInt {
        BigInt::from(v)
    }

    /// A K-polynomial from (constant first) coefficients given as coordinate lists.
    fn kp(n: usize, c: &[&[i64]]) -> KPoly {
        KPoly::new(n, c.iter().map(|v| v.iter().map(|&x| b(x)).collect()).collect(), b(1))
    }

    fn monic_lin(n: usize, c: &[i64]) -> KPoly {
        // x + c
        let mut one = vec![0i64; n];
        one[0] = 1;
        kp(n, &[c, &one])
    }

    #[test]
    fn norms() {
        // N(x - y) over y^2 - 5 is x^2 - 5; over y^3 - 2, x^3 - 2
        let k = Field::new(&[b(-5), b(0), b(1)]).unwrap();
        assert_eq!(k.norm(&kp(2, &[&[0, -1], &[1, 0]]).num), vec![b(-5), b(0), b(1)]);
        let l = Field::new(&[b(-2), b(0), b(0), b(1)]).unwrap();
        assert_eq!(l.norm(&kp(3, &[&[0, -1, 0], &[1, 0, 0]]).num), vec![b(-2), b(0), b(0), b(1)]);
    }

    #[test]
    fn gcds() {
        let k = Field::new(&[b(-5), b(0), b(1)]).unwrap();
        let (xa, xma, x2) = (monic_lin(2, &[0, 1]), monic_lin(2, &[0, -1]), monic_lin(2, &[-2, 0]));
        let f = k.mul(&k.mul(&xa, &xa), &x2); // (x + y)^2 (x - 2)
        let g = k.mul(&xa, &xma); // x^2 - 5
        let (gg, a, bb) = k.gcd(&f, &g).unwrap();
        assert_eq!(gg, xa);
        assert_eq!(k.mul(&gg, &a), f);
        assert_eq!(k.mul(&gg, &bb), g);
        // coprime, with denominators
        let h = KPoly::new(2, vec![vec![b(1), b(3)], vec![b(2), b(0)]], b(7));
        let (one, _, _) = k.gcd(&h, &x2).unwrap();
        assert_eq!(one.degree(), 0);
    }

    #[test]
    fn factorizations_multiply_back() {
        // over Q(sqrt 5): (x - y)^3 (x + y) (x^2 + 1)^2 (x - 2)
        let k = Field::new(&[b(-5), b(0), b(1)]).unwrap();
        let x2p1 = kp(2, &[&[1, 0], &[0, 0], &[1, 0]]);
        let fs = [(monic_lin(2, &[0, -1]), 3), (monic_lin(2, &[0, 1]), 1), (x2p1.clone(), 2), (monic_lin(2, &[-2, 0]), 1)];
        let mut f = kp(2, &[&[3, 1]]); // the unit 3 + y
        for (g, e) in &fs {
            for _ in 0..*e {
                f = k.mul(&f, g);
            }
        }
        let (unit, got) = k.factor(&f).unwrap();
        assert_eq!(unit, (vec![b(3), b(1)], b(1)));
        assert_eq!(got.len(), 4);
        for (g, e) in &fs {
            assert!(got.contains(&(g.clone(), *e)), "{:?}", g);
        }
        // over Q(2^(1/3)): t^6 - 4 = (t - b)(t + b)(t^2 - b t + b^2)(t^2 + b t + b^2)
        let l = Field::new(&[b(-2), b(0), b(0), b(1)]).unwrap();
        let t6 = kp(3, &[&[-4, 0, 0], &[0, 0, 0], &[0, 0, 0], &[0, 0, 0], &[0, 0, 0], &[0, 0, 0], &[1, 0, 0]]);
        let (_, got) = l.factor(&t6).unwrap();
        let mut degs: Vec<isize> = got.iter().map(|(g, _)| g.degree()).collect();
        degs.sort();
        assert_eq!(degs, vec![1, 1, 2, 2]);
        // irreducible: x^2 - y over Q(sqrt 5)
        let (_, got) = k.factor(&kp(2, &[&[0, -1], &[0, 0], &[1, 0]])).unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn golden_ratio_charpoly() {
        // a charpoly of T_(2) on S_(2,4)(7 + 3w) over Q(w), w^2 = w + 1: an
        // irreducible cubic (from the HMF engine)
        let k = Field::new(&[b(-1), b(-1), b(1)]).unwrap();
        let f = kp(2, &[&[128, 64], &[-24, 16], &[-12, 0], &[1, 0]]);
        let (_, got) = k.factor(&f).unwrap();
        assert_eq!(got, vec![(f.clone(), 1)]);
        // and its square times a linear factor
        let g = k.mul(&k.mul(&f, &f), &monic_lin(2, &[3, -1]));
        let (_, got) = k.factor(&g).unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.contains(&(f, 2)));
    }
}
