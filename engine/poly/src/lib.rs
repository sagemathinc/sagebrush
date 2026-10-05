//! Factoring polynomials over Z, in pure Rust (no FLINT), so that the
//! engines can find Galois orbits of newforms anywhere, WebAssembly included.
//!
//! factor(f) = content * prod g_i^e_i, the g_i irreducible, primitive, with
//! positive leading coefficients: the same contract as sagebrush-flint's
//! factor(), against which the tests check it.  The algorithm is the
//! classical one (von zur Gathen and Gerhard, Modern Computer Algebra, ch.
//! 14-15):
//!   * the square-free decomposition (Yun), skipped when f is square-free
//!     modulo a prime;
//!   * for each square-free part, its factorization modulo a few small
//!     primes (distinct-degree, then Cantor-Zassenhaus), keeping the prime
//!     with the fewest factors; the factor degrees possible modulo every
//!     one of them often prove irreducibility outright;
//!   * Hensel lifting of those factors (a factor tree, quadratic steps) past
//!     twice the Mignotte bound times the leading coefficient;
//!   * Zassenhaus' recombination of subsets of the lifted factors, with a
//!     constant-term test before each trial division.
//! Polynomials are coefficient vectors, constant term first.

use num_bigint::{BigInt, BigUint};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};

pub type ZPoly = Vec<BigInt>;

// ------------------------------------------------------------------ Z[x]

fn trim(mut v: ZPoly) -> ZPoly {
    while v.last().map_or(false, |c| c.is_zero()) {
        v.pop();
    }
    v
}

fn deg(v: &[BigInt]) -> usize {
    v.len().saturating_sub(1)
}

fn content(v: &[BigInt]) -> BigInt {
    let mut g = BigInt::zero();
    for c in v {
        g = g.gcd(c);
        if g.is_one() {
            break;
        }
    }
    g
}

/// The primitive part, with a positive leading coefficient.
fn prim(v: &[BigInt]) -> ZPoly {
    let v = trim(v.to_vec());
    if v.is_empty() {
        return v;
    }
    let mut c = content(&v);
    if v.last().unwrap().is_negative() {
        c = -c;
    }
    v.iter().map(|x| x / &c).collect()
}

fn derivative(v: &[BigInt]) -> ZPoly {
    trim(v.iter().enumerate().skip(1).map(|(i, c)| c * BigInt::from(i)).collect())
}

fn zsub(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let n = a.len().max(b.len());
    trim((0..n).map(|i| a.get(i).cloned().unwrap_or_default() - b.get(i).cloned().unwrap_or_default()).collect())
}

fn zmul(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let mut r = vec![BigInt::zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        if x.is_zero() {
            continue;
        }
        for (j, y) in b.iter().enumerate() {
            r[i + j] += x * y;
        }
    }
    trim(r)
}

/// a / b when b divides a in Z[x], else None.
fn divexact(a: &[BigInt], b: &[BigInt]) -> Option<ZPoly> {
    let (a, b) = (trim(a.to_vec()), trim(b.to_vec()));
    if b.is_empty() {
        return None;
    }
    if a.is_empty() {
        return Some(vec![]);
    }
    if a.len() < b.len() {
        return None;
    }
    let lb = b.last().unwrap().clone();
    let mut r = a;
    let mut q = vec![BigInt::zero(); r.len() - b.len() + 1];
    for i in (0..q.len()).rev() {
        let top = &r[i + b.len() - 1];
        if top.is_zero() {
            continue;
        }
        let (c, rem) = top.div_rem(&lb);
        if !rem.is_zero() {
            return None;
        }
        for (j, y) in b.iter().enumerate() {
            r[i + j] -= &c * y;
        }
        q[i] = c;
    }
    if r.iter().all(|c| c.is_zero()) {
        Some(trim(q))
    } else {
        None
    }
}

/// The pseudo-remainder of a by b.
fn prem(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let mut r = trim(a.to_vec());
    let lb = b.last().unwrap().clone();
    while r.len() >= b.len() && !r.is_empty() {
        let lr = r.last().unwrap().clone();
        let shift = r.len() - b.len();
        for c in r.iter_mut() {
            *c *= &lb;
        }
        for (j, y) in b.iter().enumerate() {
            r[shift + j] -= &lr * y;
        }
        r = trim(r);
    }
    r
}

/// gcd in Z[x] (primitive, positive leading coefficient), by primitive
/// remainder sequences.
fn zgcd(a: &[BigInt], b: &[BigInt]) -> ZPoly {
    let (mut a, mut b) = (prim(a), prim(b));
    if a.len() < b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    while !b.is_empty() {
        let r = prim(&prem(&a, &b));
        a = b;
        b = r;
    }
    a
}

// ------------------------------------------------------------------ F_p[x], p < 2^31

type FPoly = Vec<u64>;

fn ftrim(mut v: FPoly) -> FPoly {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

fn powmod_u(mut b: u64, mut e: u64, p: u64) -> u64 {
    let mut r = 1;
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

fn finv(a: u64, p: u64) -> u64 {
    powmod_u(a, p - 2, p)
}

fn reduce_p(f: &[BigInt], p: u64) -> FPoly {
    let pb = BigInt::from(p);
    ftrim(f.iter().map(|c| c.mod_floor(&pb).to_u64().unwrap()).collect())
}

fn fsub(a: &[u64], b: &[u64], p: u64) -> FPoly {
    let n = a.len().max(b.len());
    ftrim((0..n).map(|i| (a.get(i).copied().unwrap_or(0) + p - b.get(i).copied().unwrap_or(0)) % p).collect())
}

fn fmul(a: &[u64], b: &[u64], p: u64) -> FPoly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let mut r = vec![0u64; a.len() + b.len() - 1];
    for (i, &x) in a.iter().enumerate() {
        if x == 0 {
            continue;
        }
        for (j, &y) in b.iter().enumerate() {
            r[i + j] = (r[i + j] + x * y) % p;
        }
    }
    ftrim(r)
}

fn fdivrem(a: &[u64], b: &[u64], p: u64) -> (FPoly, FPoly) {
    let b = ftrim(b.to_vec());
    let mut r = ftrim(a.to_vec());
    if r.len() < b.len() {
        return (vec![], r);
    }
    let inv = finv(*b.last().unwrap(), p);
    let mut q = vec![0u64; r.len() - b.len() + 1];
    for i in (0..q.len()).rev() {
        let c = r[i + b.len() - 1] * inv % p;
        q[i] = c;
        if c != 0 {
            for (j, &y) in b.iter().enumerate() {
                r[i + j] = (r[i + j] + p - c * y % p) % p;
            }
        }
    }
    (ftrim(q), ftrim(r))
}

fn frem(a: &[u64], b: &[u64], p: u64) -> FPoly {
    fdivrem(a, b, p).1
}

fn fmonic(a: &[u64], p: u64) -> FPoly {
    let a = ftrim(a.to_vec());
    if a.is_empty() {
        return a;
    }
    let inv = finv(*a.last().unwrap(), p);
    a.iter().map(|&x| x * inv % p).collect()
}

fn fgcd(a: &[u64], b: &[u64], p: u64) -> FPoly {
    let (mut a, mut b) = (ftrim(a.to_vec()), ftrim(b.to_vec()));
    while !b.is_empty() {
        let r = frem(&a, &b, p);
        a = b;
        b = r;
    }
    fmonic(&a, p)
}

/// s, t with s a + t b = 1 (a, b coprime), deg s < deg b, deg t < deg a.
fn fxgcd(a: &[u64], b: &[u64], p: u64) -> (FPoly, FPoly) {
    let (mut r0, mut r1) = (ftrim(a.to_vec()), ftrim(b.to_vec()));
    let (mut s0, mut s1): (FPoly, FPoly) = (vec![1], vec![]);
    let (mut t0, mut t1): (FPoly, FPoly) = (vec![], vec![1]);
    while !r1.is_empty() {
        let (q, r) = fdivrem(&r0, &r1, p);
        let s2 = fsub(&s0, &fmul(&q, &s1, p), p);
        let t2 = fsub(&t0, &fmul(&q, &t1, p), p);
        r0 = r1;
        r1 = r;
        s0 = s1;
        s1 = s2;
        t0 = t1;
        t1 = t2;
    }
    // r0 is a nonzero constant: normalize to 1
    let inv = finv(r0[0], p);
    let s: FPoly = ftrim(s0.iter().map(|&x| x * inv % p).collect());
    let t: FPoly = ftrim(t0.iter().map(|&x| x * inv % p).collect());
    // reduce degrees: s = s mod b, t = t + (s div b) a
    let (q, s) = fdivrem(&s, b, p);
    let t = fsub(&t, &fmul(&fsub(&[], &q, p), a, p), p);
    (s, t)
}

fn fpowmod(base: &[u64], e: &BigUint, m: &[u64], p: u64) -> FPoly {
    let mut r: FPoly = vec![1];
    let mut b = frem(base, m, p);
    for i in 0..e.bits() {
        if e.bit(i) {
            r = frem(&fmul(&r, &b, p), m, p);
        }
        b = frem(&fmul(&b, &b, p), m, p);
    }
    r
}

fn fderivative(a: &[u64], p: u64) -> FPoly {
    ftrim(a.iter().enumerate().skip(1).map(|(i, &c)| c * (i as u64 % p) % p).collect())
}

/// Distinct-degree factorization of a monic square-free f: (product of the
/// irreducible factors of degree d, d).
fn ddf(f: &[u64], p: u64) -> Vec<(FPoly, usize)> {
    let mut out = vec![];
    let mut f = f.to_vec();
    let x: FPoly = vec![0, 1];
    let mut h = x.clone();
    let pb = BigUint::from(p);
    let mut d = 1;
    while 2 * d <= f.len() - 1 {
        h = fpowmod(&h, &pb, &f, p);
        let g = fgcd(&f, &fsub(&h, &x, p), p);
        if g.len() > 1 {
            f = fdivrem(&f, &g, p).0;
            h = frem(&h, &f, p);
            out.push((g, d));
        }
        d += 1;
    }
    if f.len() > 1 {
        let n = f.len() - 1;
        out.push((f, n));
    }
    out
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

/// Cantor-Zassenhaus: the irreducible factors (of degree d each) of g.
fn edf(g: &[u64], d: usize, p: u64, rng: &mut Rng, out: &mut Vec<FPoly>) {
    let n = g.len() - 1;
    if n == d {
        out.push(g.to_vec());
        return;
    }
    let e = (BigUint::from(p).pow(d as u32) - 1u32) / 2u32;
    loop {
        let a: FPoly = ftrim((0..n).map(|_| rng.next() % p).collect());
        if a.len() < 2 {
            continue;
        }
        let b = fsub(&fpowmod(&a, &e, g, p), &[1], p);
        let h = fgcd(g, &b, p);
        if h.len() > 1 && h.len() < g.len() {
            let q = fdivrem(g, &h, p).0;
            edf(&h, d, p, rng, out);
            edf(&fmonic(&q, p), d, p, rng, out);
            return;
        }
    }
}

// ------------------------------------------------------------------ (Z/m)[x], Hensel lifting

fn mreduce(a: &[BigInt], m: &BigInt) -> ZPoly {
    trim(a.iter().map(|c| c.mod_floor(m)).collect())
}

fn mmul(a: &[BigInt], b: &[BigInt], m: &BigInt) -> ZPoly {
    mreduce(&zmul(a, b), m)
}

fn madd(a: &[BigInt], b: &[BigInt], m: &BigInt) -> ZPoly {
    let n = a.len().max(b.len());
    mreduce(&(0..n).map(|i| a.get(i).cloned().unwrap_or_default() + b.get(i).cloned().unwrap_or_default()).collect::<Vec<_>>(), m)
}

fn msub(a: &[BigInt], b: &[BigInt], m: &BigInt) -> ZPoly {
    mreduce(&zsub(a, b), m)
}

/// Division by a monic b modulo m.
fn mdivrem(a: &[BigInt], b: &[BigInt], m: &BigInt) -> (ZPoly, ZPoly) {
    let mut r = mreduce(a, m);
    if r.len() < b.len() {
        return (vec![], r);
    }
    let mut q = vec![BigInt::zero(); r.len() - b.len() + 1];
    for i in (0..q.len()).rev() {
        let c = r[i + b.len() - 1].mod_floor(m);
        if !c.is_zero() {
            for (j, y) in b.iter().enumerate() {
                r[i + j] = (&r[i + j] - &c * y).mod_floor(m);
            }
        }
        q[i] = c;
    }
    (trim(q), mreduce(&r, m))
}

fn to_z(a: &[u64]) -> ZPoly {
    a.iter().map(|&x| BigInt::from(x)).collect()
}

/// Lift f = u g h (mod p), u a unit mod p, g and h monic and coprime mod p,
/// to monic G, H with f = u G H (mod p^k): quadratic Hensel steps
/// (von zur Gathen-Gerhard, Algorithm 15.10).  f is given modulo p^k.
fn hensel_pair(f: &[BigInt], g: &[u64], h: &[u64], p: u64, k: u32) -> (ZPoly, ZPoly) {
    let pk = BigInt::from(p).pow(k);
    let u = f.last().unwrap().mod_floor(&pk);
    // work with G = u g so that f = G H
    let up = u.mod_floor(&BigInt::from(p)).to_u64().unwrap();
    let gu: FPoly = g.iter().map(|&x| x * up % p).collect();
    let (s0, t0) = fxgcd(&gu, h, p);
    let (mut gg, mut hh, mut s, mut t) = (to_z(&gu), to_z(h), to_z(&s0), to_z(&t0));
    let mut m = BigInt::from(p);
    let mut e_now = 1u32;
    while e_now < k {
        let e_next = (2 * e_now).min(k);
        let m2 = BigInt::from(p).pow(e_next);
        let e = msub(f, &mmul(&gg, &hh, &m2), &m2);
        let (q, r) = mdivrem(&mmul(&s, &e, &m2), &hh, &m2);
        let g2 = madd(&madd(&gg, &mmul(&t, &e, &m2), &m2), &mmul(&q, &gg, &m2), &m2);
        let h2 = madd(&hh, &r, &m2);
        let b = msub(&madd(&mmul(&s, &g2, &m2), &mmul(&t, &h2, &m2), &m2), &[BigInt::one()], &m2);
        let (c, d) = mdivrem(&mmul(&s, &b, &m2), &h2, &m2);
        s = msub(&s, &d, &m2);
        t = msub(&msub(&t, &mmul(&t, &b, &m2), &m2), &mmul(&c, &g2, &m2), &m2);
        gg = g2;
        hh = h2;
        m = m2;
        e_now = e_next;
    }
    // G is u times the monic factor
    let uinv = u.modinv(&m).expect("leading coefficient invertible mod p");
    let gmon = mreduce(&gg.iter().map(|c| c * &uinv).collect::<Vec<_>>(), &m);
    (gmon, hh)
}

/// Lift the monic factors fs of f (mod p) to monic factors mod p^k, by a
/// factor tree.  f is given modulo p^k; its leading coefficient is a unit.
fn hensel(f: &[BigInt], fs: &[FPoly], p: u64, k: u32) -> Vec<ZPoly> {
    let pk = BigInt::from(p).pow(k);
    if fs.len() == 1 {
        let u = f.last().unwrap().mod_floor(&pk);
        let uinv = u.modinv(&pk).unwrap();
        return vec![mreduce(&f.iter().map(|c| c * &uinv).collect::<Vec<_>>(), &pk)];
    }
    let (a, b) = fs.split_at(fs.len() / 2);
    let prod = |v: &[FPoly]| v.iter().fold(vec![1u64], |acc, x| fmul(&acc, x, p));
    let (g, h) = hensel_pair(f, &prod(a), &prod(b), p, k);
    let mut out = hensel(&g, a, p, k);
    out.extend(hensel(&h, b, p, k));
    out
}

// ------------------------------------------------------------------ the square-free case

fn small_primes() -> impl Iterator<Item = u64> {
    (3u64..).filter(|&n| (2..).take_while(|d| d * d <= n).all(|d| n % d != 0))
}

/// The irreducible factors of a primitive square-free f of degree >= 1
/// with positive leading coefficient.
fn factor_squarefree(f: &[BigInt]) -> Vec<ZPoly> {
    let n = deg(f);
    if n <= 1 {
        return vec![f.to_vec()];
    }
    let lc = f.last().unwrap().clone();
    // factor modulo a few good primes; keep the one with the fewest factors,
    // and the degrees possible for a factor over Q modulo every one of them
    let mut best: Option<(u64, Vec<(FPoly, usize)>, usize)> = None;
    let mut possible = vec![true; n + 1];
    let mut tried = 0;
    for p in small_primes() {
        if (&lc % BigInt::from(p)).is_zero() {
            continue;
        }
        let fp = reduce_p(f, p);
        if fp.len() != f.len() || fgcd(&fp, &fderivative(&fp, p), p).len() > 1 {
            continue;
        }
        let parts = ddf(&fmonic(&fp, p), p);
        let count: usize = parts.iter().map(|(g, d)| (g.len() - 1) / d).sum();
        // subset sums of the factor degrees
        let mut sums = vec![false; n + 1];
        sums[0] = true;
        for (g, d) in &parts {
            for _ in 0..(g.len() - 1) / d {
                for s in (0..=n - d).rev() {
                    if sums[s] {
                        sums[s + d] = true;
                    }
                }
            }
        }
        for s in 0..=n {
            possible[s] &= sums[s];
        }
        if best.as_ref().map_or(true, |b| count < b.2) {
            best = Some((p, parts, count));
        }
        tried += 1;
        if count == 1 || (1..n).all(|s| !possible[s]) {
            return vec![f.to_vec()]; // irreducible
        }
        if tried >= 7 || (tried >= 3 && p > 3 * n as u64) {
            break;
        }
    }
    let (p, parts, _) = best.expect("a good prime");
    let mut rng = Rng(0x9E3779B97F4A7C15 ^ p);
    let mut modfs: Vec<FPoly> = vec![];
    for (g, d) in &parts {
        edf(g, *d, p, &mut rng, &mut modfs);
    }
    // a bound on the coefficients of lc * (a factor of f): Mignotte
    let norm = f.iter().map(|c| c.abs()).max().unwrap();
    let bound = BigInt::from(2u32).pow(n as u32) * BigInt::from(n + 1) * norm * lc.abs();
    let mut k = 1u32;
    let pb = BigInt::from(p);
    while pb.pow(k) <= &bound * 2 {
        k += 1;
    }
    let pk = pb.pow(k);
    let lifted = hensel(&mreduce(f, &pk), &modfs, p, k);
    recombine(f, lifted, &pk, &possible)
}

/// Zassenhaus' recombination of the lifted monic factors.
fn recombine(f: &[BigInt], lifted: Vec<ZPoly>, pk: &BigInt, possible: &[bool]) -> Vec<ZPoly> {
    let half = pk / 2;
    let symc = |c: &BigInt| -> BigInt {
        let c = c.mod_floor(pk);
        if c > half {
            c - pk
        } else {
            c
        }
    };
    let mut f = f.to_vec();
    let mut rest: Vec<ZPoly> = lifted;
    let mut out = vec![];
    let mut size = 1;
    while 2 * size <= rest.len() {
        let mut found = false;
        let lc = f.last().unwrap().clone();
        let f0 = f[0].clone();
        let r = rest.len();
        // subsets of `size` indices, in lexicographic order
        let mut idx: Vec<usize> = (0..size).collect();
        loop {
            let d: usize = idx.iter().map(|&i| rest[i].len() - 1).sum();
            if d < possible.len() && possible[d] {
                // constant term test: lc prod u_i(0) must divide lc f(0)
                let c0 = symc(&idx.iter().fold(lc.clone(), |acc, &i| (acc * &rest[i][0]).mod_floor(pk)));
                let ok = f0.is_zero() || (!c0.is_zero() && ((&lc * &f0) % &c0).is_zero());
                if ok {
                    let g = idx.iter().fold(vec![lc.clone()], |acc, &i| mreduce(&zmul(&acc, &rest[i]), pk));
                    let g = prim(&trim(g.iter().map(&symc).collect()));
                    if let Some(q) = divexact(&f, &g) {
                        out.push(g);
                        f = prim(&q);
                        rest = rest.iter().enumerate().filter(|(i, _)| !idx.contains(i)).map(|(_, v)| v.clone()).collect();
                        found = true;
                        break;
                    }
                }
            }
            // the next subset
            let mut i = size;
            while i > 0 && idx[i - 1] == r - size + i - 1 {
                i -= 1;
            }
            if i == 0 {
                break;
            }
            idx[i - 1] += 1;
            for j in i..size {
                idx[j] = idx[j - 1] + 1;
            }
        }
        if !found {
            size += 1;
        }
    }
    if deg(&f) > 0 {
        out.push(f);
    }
    out
}

// ------------------------------------------------------------------ the API

/// Factors f (constant term first, f != 0) as content * prod g_i^e_i, the
/// g_i irreducible over Q, primitive, with positive leading coefficients;
/// the content carries the sign of f's leading coefficient.  Returns
/// (content, [(g_i, e_i)]) with the g_i sorted by degree, then coefficients
/// from the top.
pub fn factor(f: &[BigInt]) -> (BigInt, Vec<(ZPoly, u32)>) {
    let f = trim(f.to_vec());
    assert!(!f.is_empty(), "factor(0)");
    let mut c = content(&f);
    if f.last().unwrap().is_negative() {
        c = -c;
    }
    let g = prim(&f);
    let mut out: Vec<(ZPoly, u32)> = vec![];
    if deg(&g) == 0 {
        return (c, out);
    }
    for (part, e) in squarefree(&g) {
        for h in factor_squarefree(&part) {
            out.push((h, e));
        }
    }
    out.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then_with(|| a.0.iter().rev().cmp(b.0.iter().rev())));
    (c, out)
}

/// Yun's square-free decomposition of a primitive f with positive leading
/// coefficient: [(a_i, i)], f = prod a_i^i, the a_i square-free, coprime.
pub fn squarefree(f: &[BigInt]) -> Vec<(ZPoly, u32)> {
    // square-free modulo a prime not dividing lc(f) deg(f): square-free
    let lc = f.last().unwrap();
    for p in small_primes().take(20) {
        if (lc % BigInt::from(p)).is_zero() || (deg(f) as u64) % p == 0 {
            continue;
        }
        let fp = reduce_p(f, p);
        if fp.len() == f.len() && fgcd(&fp, &fderivative(&fp, p), p).len() == 1 {
            return vec![(f.to_vec(), 1)];
        }
    }
    let df = derivative(f);
    let b = zgcd(f, &df);
    if deg(&b) == 0 {
        return vec![(f.to_vec(), 1)];
    }
    let mut out = vec![];
    let mut c = divexact(f, &b).expect("gcd divides f");
    let mut d = zsub(&divexact(&df, &b).expect("gcd divides f'"), &derivative(&c));
    let mut i = 1u32;
    while deg(&c) > 0 {
        let a = zgcd(&c, &d);
        if deg(&a) > 0 {
            out.push((a.clone(), i));
        }
        c = divexact(&c, &a).expect("a divides c");
        d = zsub(&divexact(&d, &a).expect("a divides d"), &derivative(&c));
        i += 1;
    }
    out
}

/// Whether f is irreducible over Q (constants are not).
pub fn is_irreducible(f: &[BigInt]) -> bool {
    let (c, fs) = factor(f);
    fs.len() == 1 && fs[0].1 == 1 && c.abs().is_one()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(v: &[i64]) -> ZPoly {
        v.iter().map(|&x| BigInt::from(x)).collect()
    }

    #[test]
    fn small() {
        assert_eq!(factor(&z(&[2, -4, 4, -4, 2])), (BigInt::from(2), vec![(z(&[-1, 1]), 2), (z(&[1, 0, 1]), 1)]));
        assert_eq!(factor(&z(&[0, -6, -1, 1])), (BigInt::one(), vec![(z(&[-3, 1]), 1), (z(&[0, 1]), 1), (z(&[2, 1]), 1)]));
        assert_eq!(factor(&z(&[-1, 0, 0, 0, 1])), (BigInt::one(), vec![(z(&[-1, 1]), 1), (z(&[1, 1]), 1), (z(&[1, 0, 1]), 1)]));
        assert_eq!(factor(&z(&[1, 0, 0, 0, 1])), (BigInt::one(), vec![(z(&[1, 0, 0, 0, 1]), 1)]));
        assert_eq!(factor(&z(&[-12, -12])), (BigInt::from(-12), vec![(z(&[1, 1]), 1)]));
        assert_eq!(factor(&z(&[5])), (BigInt::from(5), vec![]));
    }

    #[test]
    fn swinnerton_dyer() {
        // the minimal polynomial of sqrt2 + sqrt3 + sqrt5: irreducible, but
        // a product of linear and quadratic factors modulo every prime
        let f = z(&[576, 0, -960, 0, 352, 0, -40, 0, 1]);
        assert_eq!(factor(&f).1, vec![(f.clone(), 1)]);
    }
}
