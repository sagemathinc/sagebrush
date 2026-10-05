//! Modular symbols of any weight k >= 2 on Gamma0(N) with a Dirichlet
//! character eps, sign +1, -1 or 0, over a prime field F_ell with
//! ell = 1 mod ord(eps) (so eps takes its values in F_ell).
//!
//! Manin symbols are [P, (c, d)] = g (P {0, oo}) for P = X^i Y^(k-2-i) and
//! g in SL_2(Z) with bottom row (c, d).  A matrix h = [a b; c d] acts on the
//! right by
//!     [P, (u, v)] h = [P(aX + bY, cX + dY), (u, v) h],
//! and every relation and Hecke operator is written with this one action:
//!   * x + x sigma = 0,            sigma = [0 -1; 1 0]
//!   * x + x tau + x tau^2 = 0,    tau = [0 -1; 1 -1]
//!   * x = sign x eta,             eta = [-1 0; 0 1]   (if sign != 0)
//!   * [P, (l c, l d)] = eps(l)^CONV [P, (c, d)] for units l, so a symbol
//!     whose stabilizer meets the character nontrivially is zero;
//!   * T_p x = sum over Merel's matrices (ad - bc = p, a > b >= 0,
//!     d > c >= 0) of x h; for p | N, terms whose bottom row leaves
//!     P^1(Z/N) are dropped, which gives U_p.
//! The 2-term relations (sigma, eta) are solved by a union-find whose
//! edges carry weights in F_ell^*; the 3-term relations become sparse rows
//! on the remaining free generators, eliminated as in weight 2.

use crate::exact::is_prime;
use crate::linalg;
use crate::p1::{gcd, P1List};
use crate::par;

/// Direction of the character relation: -1 means [P, (l c, l d)] =
/// eps(l) [P, (c, d)], Sage's convention (+1 disagrees with Sage on 664 of
/// 1452 test spaces; see examples/general_vs_sage.rs).
const CONV: i64 = -1;

/// A Dirichlet character mod N with values in the e-th roots of unity:
/// eps(m) = zeta_e^exps[m] (exps[m] = u32::MAX when gcd(m, N) > 1).
#[derive(Clone, Debug)]
pub struct Character {
    pub n: u64,
    pub order: u64,
    exps: Vec<u32>,
}

impl Character {
    pub fn trivial(n: u64) -> Self {
        let exps = (0..n).map(|m| if gcd(m, n) == 1 || n == 1 { 0 } else { u32::MAX }).collect();
        Character { n, order: 1, exps }
    }

    /// From exponents: eps(m) = zeta_order^exps[m]; checks that it is a
    /// character (multiplicative, supported exactly on the units).
    pub fn from_exponents(n: u64, order: u64, exps: Vec<u32>) -> Result<Self, String> {
        if exps.len() as u64 != n || order == 0 {
            return Err("need one exponent per residue mod N".into());
        }
        for a in 0..n {
            let unit = gcd(a, n) == 1 || n == 1;
            if unit != (exps[a as usize] != u32::MAX) {
                return Err(format!("eps({}) must be defined exactly on units", a));
            }
        }
        for a in 0..n {
            for b in 0..n {
                let (ea, eb) = (exps[a as usize], exps[b as usize]);
                if ea != u32::MAX && eb != u32::MAX {
                    let ab = exps[((a * b) % n) as usize] as u64;
                    if (ea as u64 + eb as u64) % order != ab % order {
                        return Err(format!("not multiplicative at ({}, {})", a, b));
                    }
                }
            }
        }
        Ok(Character { n, order, exps })
    }

    pub fn exponent(&self, m: i64) -> Option<u32> {
        let e = self.exps[m.rem_euclid(self.n.max(1) as i64) as usize % self.exps.len().max(1)];
        if e == u32::MAX { None } else { Some(e) }
    }

    /// eps(-1) = +1?
    pub fn is_even(&self) -> bool {
        self.exponent(-1).map_or(true, |e| e as u64 % self.order == 0)
    }

    /// The same character with `order` its exact order m (exponents
    /// relative to zeta_m = zeta_order^(order/m)).
    pub fn minimal(&self) -> Character {
        let g = self.exps.iter().filter(|&&e| e != u32::MAX).fold(self.order, |g, &e| gcd(g, e as u64));
        let s = g.max(1);
        let exps = self.exps.iter().map(|&e| if e == u32::MAX { e } else { (e as u64 / s) as u32 }).collect();
        Character { n: self.n, order: self.order / s, exps }
    }

    /// The conductor: the least M | N with eps(x) = 1 for all units
    /// x = 1 mod M.
    pub fn conductor(&self) -> u64 {
        let n = self.n;
        (1..=n).filter(|m| n % m == 0).find(|&m| {
            (0..n / m).all(|t| {
                let x = (1 + t * m) % n;
                self.exponent(x as i64).map_or(true, |e| e as u64 % self.order == 0)
            })
        }).unwrap_or(1)
    }

    pub fn is_trivial(&self) -> bool {
        self.exps.iter().all(|&e| e == 0 || e == u32::MAX)
    }
}

pub(crate) fn powmod(mut b: u64, mut e: u64, p: u64) -> u64 {
    let mut r = 1u64;
    b %= p;
    while e > 0 {
        if e & 1 == 1 {
            r = (r as u128 * b as u128 % p as u128) as u64;
        }
        b = (b as u128 * b as u128 % p as u128) as u64;
        e >>= 1;
    }
    r
}

pub(crate) fn inv(a: u64, p: u64) -> u64 {
    powmod(a, p - 2, p)
}

/// a b mod p for p < 2^31 (enforced by `new_mod`): the product fits in u64.
#[inline]
pub(crate) fn mul(a: u64, b: u64, p: u64) -> u64 {
    a * b % p
}

/// The largest prime ell below `below` with ell = 1 mod order, and an
/// element zeta of exact multiplicative order `order` in F_ell.
pub fn prime_field(order: u64, below: u64) -> (u64, u64) {
    let ell = primes_one_mod(order, below).next().expect("a prime = 1 mod order");
    (ell, root_of_unity(order, ell))
}

/// Primes ell = 1 mod order, 2 < ell < below, in decreasing order.
pub fn primes_one_mod(order: u64, below: u64) -> impl Iterator<Item = u64> {
    let order = order.max(1);
    // Largest candidate = 1 mod order below `below`, then step down by order.
    let start = (below - 1) - ((below - 1) % order) + 1 % order;
    let start = if start >= below { start - order } else { start };
    (0..).map(move |t| start.wrapping_sub(t * order)).take_while(move |&l| l > 2 && l < below).filter(|&l| is_prime(l))
}

/// An element of exact multiplicative order `order` in F_ell (order | ell - 1).
pub fn root_of_unity(order: u64, ell: u64) -> u64 {
    assert!((ell - 1) % order == 0);
    let qs: Vec<u64> = crate::exact::factor(ell - 1).iter().map(|&(q, _)| q).collect();
    let g = (2..).find(|&g| qs.iter().all(|&q| powmod(g, (ell - 1) / q, ell) != 1)).unwrap();
    powmod(g, (ell - 1) / order, ell)
}

/// Coefficients over X^r Y^(k-2-r), r = 0..=k-2, of P(aX + bY, cX + dY)
/// for P = X^i Y^(k-2-i), mod p.
fn transform(k: usize, i: usize, h: [i64; 4], binom: &[Vec<u64>], p: u64) -> Vec<u64> {
    let w = k - 2;
    let red = |x: i64| x.rem_euclid(p as i64) as u64;
    let (a, b, c, d) = (red(h[0]), red(h[1]), red(h[2]), red(h[3]));
    // (aX + bY)^i = sum_s C(i, s) a^s b^(i-s) X^s Y^(i-s), powers built
    // incrementally (this runs once per symbol and relation).
    let pows = |x: u64, n: usize| {
        let mut v = Vec::with_capacity(n + 1);
        let mut t = 1u64;
        for _ in 0..=n {
            v.push(t);
            t = mul(t, x, p);
        }
        v
    };
    let (pa, pb) = (pows(a, i), pows(b, i));
    let first: Vec<u64> = (0..=i).map(|s| mul(binom[i][s], mul(pa[s], pb[i - s], p), p)).collect();
    let j = w - i;
    let (pc, pd) = (pows(c, j), pows(d, j));
    let second: Vec<u64> = (0..=j).map(|t| mul(binom[j][t], mul(pc[t], pd[j - t], p), p)).collect();
    let mut out = vec![0u64; w + 1];
    for (s, &x) in first.iter().enumerate() {
        if x != 0 {
            for (t, &y) in second.iter().enumerate() {
                out[s + t] = (out[s + t] + mul(x, y, p)) % p;
            }
        }
    }
    out
}

/// Merel's matrices for T_p: [a b; c d] with ad - bc = p, a > b >= 0, d > c >= 0.
/// Heilbronn matrices of determinant p for T_p on Manin symbols: Cremona's
/// (from continued fractions, O(p log p) of them and of work) when p is a
/// prime not dividing N, else Merel's (heilbronn_merel, O(p^2 log p) work).
pub fn heilbronn_for(p: u64, n: u64) -> Vec<[i64; 4]> {
    if n % p == 0 {
        return heilbronn_merel(p as i64);
    }
    crate::linalg::heilbronn(p as i64).into_iter().map(|(a, b, c, d)| [a, b, c, d]).collect()
}

pub fn heilbronn_merel(p: i64) -> Vec<[i64; 4]> {
    // As in Sage's HeilbronnMerel: for each a, either ad = p (b = 0 or
    // c = 0), or ad > p and bc = ad - p with b = bc / c < a, i.e.
    // c > bc / a, and c < d.  O(p^2 log p) in all.
    let mut out = vec![];
    for a in 1..=p {
        let q = p / a;
        if q * a == p {
            let d = q;
            for b in 0..a {
                out.push([a, b, 0, d]);
            }
            for c in 1..d {
                out.push([a, 0, c, d]);
            }
        }
        for d in q + 1..=p {
            let bc = a * d - p;
            for c in bc / a + 1..d {
                if bc % c == 0 {
                    out.push([a, bc / c, c, d]);
                }
            }
        }
    }
    out
}

pub struct GeneralSpace {
    pub n: u64,
    pub k: usize,
    pub sign: i32,
    pub p: u64,
    pub zeta: u64,
    eps: Character,
    p1: P1List,
    l: usize,
    binom: Vec<Vec<u64>>,
    /// Per symbol (i * L + j): (free generator, w) with x_sym = w x_gen, or None if zero.
    rep: Vec<Option<(u32, u64)>>,
    /// For each free generator: a symbol a and w with x_a = w x_gen.
    gen_sym: Vec<(u32, u64)>,
    pub m: usize,
    pub basis_gen: Vec<u32>,
    pivots: Vec<(u32, Vec<(u32, u64)>)>,
}

fn find(parent: &mut [u32], w: &mut [u64], a: usize, p: u64) -> (usize, u64) {
    // x_a = w[a] x_parent[a]; returns (root, W) with x_a = W x_root.
    let mut path = vec![];
    let mut r = a;
    while parent[r] as usize != r {
        path.push(r);
        r = parent[r] as usize;
    }
    // Compress: process from the node nearest the root.
    let mut acc = 1u64;
    for &node in path.iter().rev() {
        acc = mul(w[node], acc, p);
        w[node] = acc;
        parent[node] = r as u32;
    }
    (r, if path.is_empty() { 1 } else { w[a] })
}

impl GeneralSpace {
    /// The space M_k(Gamma0(N), eps) with the given sign, over F_ell for the
    /// largest suitable ell below 2^31.
    pub fn new(n: u64, k: usize, eps: &Character, sign: i32) -> Result<Self, String> {
        let (p, zeta) = prime_field(eps.order, 1 << 31);
        Self::new_mod(n, k, eps, sign, p, zeta)
    }

    pub fn new_mod(n: u64, k: usize, eps: &Character, sign: i32, p: u64, zeta: u64) -> Result<Self, String> {
        if p >= 1 << 31 || (p - 1) % eps.order != 0 || powmod(zeta, eps.order, p) != 1 {
            return Err("need a prime ell < 2^31 and zeta of order ord(eps) in F_ell".into());
        }
        if k < 2 || eps.n != n || ![-1, 0, 1].contains(&sign) {
            return Err("need k >= 2, a character mod N and sign in {-1, 0, 1}".into());
        }
        let p1 = P1List::new(n);
        let l = p1.len();
        let s = (k - 1) * l;
        let mut binom = vec![vec![0u64; k]; k];
        for a in 0..k {
            binom[a][0] = 1;
            for b in 1..=a {
                binom[a][b] = (binom[a - 1][b - 1] + if b < a { binom[a - 1][b] } else { 0 }) % p;
            }
        }
        let zpow: Vec<u64> = (0..eps.order).map(|e| powmod(zeta, e, p)).collect();
        let chi = |lam: u64| -> u64 {
            let e = eps.exponent(lam as i64).expect("scalar is a unit") as u64;
            let e = if CONV > 0 { e % eps.order } else { (eps.order - e % eps.order) % eps.order };
            zpow[e as usize]
        };
        let mut sp = GeneralSpace { n, k, sign, p, zeta, eps: eps.clone(), p1, l, binom, rep: vec![], gen_sym: vec![], m: 0, basis_gen: vec![], pivots: vec![] };
        // Symbols killed by their stabilizer: lambda = 1 mod M with eps(lambda) != 1.
        let mut killed = vec![false; l];
        for j in 0..l {
            let (u, v) = sp.p1.get(j);
            let mm = {
                let a = n / gcd(u, n).max(1);
                let b = n / gcd(v, n).max(1);
                a / gcd(a, b) * b
            };
            let mut t = 0u64;
            while t * mm < n {
                let lam = (1 + t * mm) % n.max(1);
                if n > 1 && gcd(lam, n) == 1 && eps.exponent(lam as i64).map_or(false, |e| e as u64 % eps.order != 0) {
                    killed[j] = true;
                    break;
                }
                t += 1;
            }
        }
        // Union-find on symbols.
        let mut parent: Vec<u32> = (0..s as u32).collect();
        let mut w = vec![1u64; s];
        let mut zero = vec![false; s];
        // x_a = c x_b
        let union = |parent: &mut Vec<u32>, w: &mut Vec<u64>, zero: &mut Vec<bool>, a: usize, b: usize, c: u64| {
            let (ra, wa) = find(parent, w, a, p);
            let (rb, wb) = find(parent, w, b, p);
            // wa x_ra = c wb x_rb
            if ra == rb {
                if wa != mul(c, wb, p) {
                    zero[ra] = true;
                }
                return;
            }
            // x_ra = (c wb / wa) x_rb
            parent[ra] = rb as u32;
            w[ra] = mul(mul(c, wb, p), inv(wa, p), p);
            if zero[ra] {
                zero[rb] = true;
            }
        };
        let sym = |sp: &GeneralSpace, r: usize, c: i64, d: i64| -> (usize, u64) {
            // [X^r Y^.., (c, d)] = f [X^r Y^.., canonical]
            let (j, lam) = sp.p1.index_scalar(c, d);
            (r * l + j, chi(lam))
        };
        let sigma = [0, -1, 1, 0];
        let eta = [-1, 0, 0, 1];
        for i in 0..=k - 2 {
            for j in 0..l {
                let a = i * l + j;
                let (c, d) = sp.p1.get(j);
                let (c, d) = (c as i64, d as i64);
                // x + x sigma = 0: x sigma = coef [X^{k-2-i}.., (d, -c)]
                let tr = transform(k, i, sigma, &sp.binom, p);
                for (r, &coef) in tr.iter().enumerate() {
                    if coef != 0 {
                        let (b, f) = sym(&sp, r, d, -c);
                        union(&mut parent, &mut w, &mut zero, a, b, (p - mul(coef, f, p)) % p);
                    }
                }
                if sign != 0 {
                    let tr = transform(k, i, eta, &sp.binom, p);
                    for (r, &coef) in tr.iter().enumerate() {
                        if coef != 0 {
                            let (b, f) = sym(&sp, r, -c, d);
                            let sg = if sign > 0 { 1 } else { p - 1 };
                            union(&mut parent, &mut w, &mut zero, a, b, mul(sg, mul(coef, f, p), p));
                        }
                    }
                }
            }
        }
        for j in 0..l {
            if killed[j] {
                for i in 0..=k - 2 {
                    let (r, _) = find(&mut parent, &mut w, i * l + j, p);
                    zero[r] = true;
                }
            }
        }
        let mut gen_of_root = vec![u32::MAX; s];
        let mut rep = vec![None; s];
        let mut gen_sym = vec![];
        for a in 0..s {
            let (r, wa) = find(&mut parent, &mut w, a, p);
            if zero[r] {
                continue;
            }
            if gen_of_root[r] == u32::MAX {
                gen_of_root[r] = gen_sym.len() as u32;
                // x_a = wa x_r: the generator is x_r itself.
                gen_sym.push((a as u32, wa));
            }
            rep[a] = Some((gen_of_root[r], wa));
        }
        sp.rep = rep;
        sp.gen_sym = gen_sym;
        sp.m = sp.gen_sym.len();
        // 3-term relations x + x tau + x tau^2 = 0 as rows on generators.
        let tau = [0, -1, 1, -1];
        let tau2 = [-1, 1, -1, 0];
        // tau^3 = 1, so [P', g tau] + ... = R(P' tau^-1, g): the relations at
        // the three points of a tau-orbit of P^1 span the same space (over
        // all P).  One point per orbit suffices: about a third of the rows.
        let mut seen = vec![false; l];
        let mut reps = vec![];
        for j in 0..l {
            if !seen[j] {
                reps.push(j);
                let mut jj = j;
                for _ in 0..3 {
                    seen[jj] = true;
                    let (c, d) = sp.p1.get(jj);
                    jj = sp.p1.index(d as i64, -(c as i64) - d as i64);
                }
            }
        }
        let syms: Vec<usize> = reps.iter().flat_map(|&j| (0..=k - 2).map(move |i| i * l + j)).collect();
        let rows: Vec<Vec<(u32, u64)>> = par::map_slice(&syms, |&a| {
            let (i, j) = (a / l, a % l);
            let (c, d) = sp.p1.get(j);
            let (c, d) = (c as i64, d as i64);
            let mut row: Vec<(u32, u64)> = vec![];
            let mut add = |g: u32, v: u64| match row.iter_mut().find(|e| e.0 == g) {
                Some(e) => e.1 = (e.1 + v) % p,
                None => row.push((g, v % p)),
            };
            if let Some((g, wa)) = sp.rep[a] {
                add(g, wa);
            }
            for h in [tau, tau2] {
                let (c2, d2) = (c * h[0] + d * h[2], c * h[1] + d * h[3]);
                let tr = transform(k, i, h, &sp.binom, p);
                for (r, &coef) in tr.iter().enumerate() {
                    if coef != 0 {
                        let (b, f) = sym(&sp, r, c2, d2);
                        if let Some((g, wb)) = sp.rep[b] {
                            add(g, mul(coef, mul(f, wb, p), p));
                        }
                    }
                }
            }
            row.retain(|e| e.1 != 0);
            row
        });
        let (pivots, pivot_of) = linalg::sparse_echelon(&rows, sp.m, p);
        sp.basis_gen = (0..sp.m as u32).filter(|&g| pivot_of[g as usize] == u32::MAX).collect();
        sp.pivots = pivots;
        Ok(sp)
    }

    pub fn dimension(&self) -> usize {
        self.basis_gen.len()
    }

    /// A functional on the quotient (given on the basis) on every generator.
    pub fn extend(&self, phi: &[u64]) -> Vec<u64> {
        let p = self.p;
        let mut psi = vec![0u64; self.m];
        for (t, &g) in self.basis_gen.iter().enumerate() {
            psi[g as usize] = phi[t];
        }
        for (pc, rest) in self.pivots.iter().rev() {
            let s = rest.iter().fold(0u128, |acc, &(k, v)| acc + v as u128 * psi[k as usize] as u128) % p as u128;
            psi[*pc as usize] = (p - s as u64) % p;
        }
        psi
    }

    /// T_p(x_g) for a free generator g as a sparse combination of generators.
    pub(crate) fn hecke_image(&self, hs: &[[i64; 4]], g: u32) -> Vec<(u32, u64)> {
        let p = self.p;
        let (a, wa) = self.gen_sym[g as usize];
        // x_a = wa x_g, so x_g = wa^{-1} x_a.
        let scale = inv(wa, p);
        let (i, j) = (a as usize / self.l, a as usize % self.l);
        let (c, d) = self.p1.get(j);
        let (c, d) = (c as i64, d as i64);
        let zpow = |lam: u64| -> u64 {
            let e = self.eps.exponent(lam as i64).expect("unit") as u64 % self.eps.order;
            let e = if CONV > 0 { e } else { (self.eps.order - e) % self.eps.order };
            powmod(self.zeta, e, p)
        };
        let mut acc: Vec<(u32, u64)> = vec![];
        for h in hs {
            let (c2, d2) = (c * h[0] + d * h[2], c * h[1] + d * h[3]);
            let nn = self.n as i64;
            if gcd(gcd(c2.rem_euclid(nn) as u64, d2.rem_euclid(nn) as u64), self.n) != 1 {
                continue; // only when q | N: the term is absent from U_q
            }
            let (j2, lam) = self.p1.index_scalar(c2, d2);
            let f = mul(zpow(lam), scale, p);
            let tr = transform(self.k, i, *h, &self.binom, p);
            for (r, &coef) in tr.iter().enumerate() {
                if coef != 0 {
                    if let Some((g2, w2)) = self.rep[r * self.l + j2] {
                        acc.push((g2, mul(coef, mul(f, w2, p), p)));
                    }
                }
            }
        }
        acc.sort_unstable_by_key(|e| e.0);
        let mut merged: Vec<(u32, u64)> = vec![];
        for (g2, v) in acc {
            match merged.last_mut() {
                Some(last) if last.0 == g2 => last.1 = (last.1 + v) % p,
                _ => merged.push((g2, v)),
            }
        }
        merged.retain(|e| e.1 != 0);
        merged
    }

    /// Matrix of T_q (U_q when q | N) for a prime q; row i is T_q(basis_i).
    pub fn hecke_matrix(&self, q: u64) -> Result<Vec<Vec<u64>>, String> {
        if !is_prime(q) {
            return Err(format!("q = {} must be prime", q));
        }
        let p = self.p;
        let d = self.dimension();
        let hs = heilbronn_for(q, self.n);
        let images = par::map_slice(&self.basis_gen, |&g| self.hecke_image(&hs, g));
        let mut t = vec![vec![0u64; d]; d];
        const BLOCK: usize = 64;
        for j0 in (0..d).step_by(BLOCK) {
            let js: Vec<usize> = (j0..(j0 + BLOCK).min(d)).collect();
            let psis = par::map_slice(&js, |&j| {
                let mut e = vec![0u64; d];
                e[j] = 1;
                self.extend(&e)
            });
            let cols = par::map_slice(&images, |img| {
                psis.iter().map(|psi| (img.iter().fold(0u128, |acc, &(g2, c)| acc + c as u128 * psi[g2 as usize] as u128) % p as u128) as u64).collect::<Vec<u64>>()
            });
            for (i, col) in cols.into_iter().enumerate() {
                t[i][j0..j0 + col.len()].copy_from_slice(&col);
            }
        }
        Ok(t)
    }

    /// The characteristic polynomial of sum r T_q mod ell.
    pub fn hecke_combo_charpoly(&self, ops: &[(u64, i64)]) -> Result<Vec<u64>, String> {
        Ok(linalg::charpoly(self.hecke_combo_matrix(ops)?, self.p))
    }

    /// The matrix of sum r T_q mod ell (rows are images of basis elements).
    pub fn hecke_combo_matrix(&self, ops: &[(u64, i64)]) -> Result<Vec<Vec<u64>>, String> {
        let (d, p) = (self.dimension(), self.p);
        let mut t = vec![vec![0u64; d]; d];
        for &(q, r) in ops {
            let h = self.hecke_matrix(q)?;
            let r = r.rem_euclid(p as i64) as u64;
            for (row, hrow) in t.iter_mut().zip(&h) {
                for (x, &y) in row.iter_mut().zip(hrow) {
                    *x = (*x + mul(y, r, p)) % p;
                }
            }
        }
        Ok(t)
    }

    /// The free generator underlying the i-th basis element.
    pub(crate) fn basis_generator(&self, i: usize) -> u32 {
        self.basis_gen[i]
    }

    /// The characteristic polynomial of T_q mod ell (constant term first).
    pub fn hecke_charpoly(&self, q: u64) -> Result<Vec<u64>, String> {
        Ok(linalg::charpoly(self.hecke_matrix(q)?, self.p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linalg::matmul;
    use num_traits::ToPrimitive;

    fn conductor_13_order_3() -> Character {
        // 2 generates (Z/13)^*; eps(2) = zeta_3.
        let mut exps = vec![u32::MAX; 13];
        let mut x = 1u64;
        for t in 0..12u32 {
            exps[x as usize] = t % 3;
            x = x * 2 % 13;
        }
        Character::from_exponents(13, 3, exps).unwrap()
    }

    #[test]
    fn trivial_weight2_matches_space() {
        // Weight 2, trivial character, sign +1: same dimension and T_2 as the
        // dedicated weight-2 engine.
        for n in 1..60u64 {
            let g = GeneralSpace::new(n, 2, &Character::trivial(n), 1).unwrap();
            let q = [2u64, 3, 5, 7].into_iter().find(|q| n % q != 0).unwrap();
            let w = crate::exact::exact_charpoly(n, q).unwrap();
            assert_eq!(g.dimension() + 1, w.coeffs.len(), "N = {}", n);
            let ours = g.hecke_charpoly(q).unwrap();
            let p = g.p as i128;
            let theirs: Vec<u64> = w.coeffs.iter().map(|c| c.to_i128().unwrap().rem_euclid(p) as u64).collect();
            assert_eq!(ours, theirs, "N = {}", n);
        }
    }

    #[test]
    fn level_one_weight_12() {
        // S_12(1) is spanned by Delta: T_2 has eigenvalue tau(2) = -24 on the
        // cuspidal part and 1 + 2^11 on the Eisenstein series.
        let g = GeneralSpace::new(1, 12, &Character::trivial(1), 1).unwrap();
        assert_eq!(g.dimension(), 2);
        let p = g.p;
        let f = g.hecke_charpoly(2).unwrap();
        // (x + 24)(x - 2049) = x^2 - 2025 x - 49176
        assert_eq!(f, vec![(p - 49176) % p, (p - 2025) % p, 1]);
    }

    #[test]
    fn hecke_operators_commute_with_character() {
        let eps = conductor_13_order_3();
        for (k, sign) in [(2, 0), (3, 0), (4, 1), (4, -1)] {
            if eps.is_even() != (k % 2 == 0) {
                continue;
            }
            let g = GeneralSpace::new(13, k, &eps, sign).unwrap();
            let (t2, t3) = (g.hecke_matrix(2).unwrap(), g.hecke_matrix(3).unwrap());
            assert_eq!(matmul(&t2, &t3, g.p), matmul(&t3, &t2, g.p), "k = {} sign = {}", k, sign);
        }
    }

    #[test]
    fn merel_matrices() {
        // The enumeration agrees with brute force over the defining conditions.
        for p in [2i64, 3, 5, 7, 11] {
            let hs = heilbronn_merel(p);
            let mut brute = 0;
            for a in 1..=p {
                for b in 0..a {
                    for d in 1..=p {
                        for c in 0..d {
                            if a * d - b * c == p {
                                brute += 1;
                            }
                        }
                    }
                }
            }
            assert_eq!(hs.len(), brute);
            assert!(hs.iter().all(|h| h[0] * h[3] - h[1] * h[2] == p && h[0] > h[1] && h[3] > h[2]));
        }
    }
}
