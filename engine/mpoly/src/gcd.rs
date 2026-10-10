//! Multivariate gcd over Z (and GF(p) for large p): Brown's modular
//! algorithm.  Over Z the gcd is computed modulo large primes and the
//! images combined by CRT; modulo a prime, the last variable is evaluated
//! at points of GF(p), the gcds of the images (one variable fewer) are
//! found recursively and interpolated back (Newton), down to univariate
//! gcds.  Leading coefficients are normalized to gcd(lc(A), lc(B)) at each
//! level, unlucky primes and points are recognized by their leading
//! monomials, and the result is checked by trial division.

use crate::order::Packing;
use crate::{Coeffs, ZPoly};
use num_integer::Integer;
use num_traits::{Signed, ToPrimitive, Zero};
use sagebrush_arith::nmod_poly as up;
use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::BigInt;
use std::collections::BTreeMap;

/// A polynomial over GF(p): (word, coefficient), decreasing words.
type SP = Vec<(u64, u64)>;

// ------------------------------------------------------------- primes

fn mulmod(a: u64, b: u64, m: u64) -> u64 {
    (a as u128 * b as u128 % m as u128) as u64
}

fn powmod(mut a: u64, mut e: u64, m: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = mulmod(r, a, m);
        }
        a = mulmod(a, a, m);
        e >>= 1;
    }
    r
}

/// Deterministic Miller-Rabin for 64-bit numbers.
pub fn is_prime_u64(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    for p in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        if n % p == 0 {
            return n == p;
        }
    }
    let (mut d, mut s) = (n - 1, 0);
    while d % 2 == 0 {
        d /= 2;
        s += 1;
    }
    'a: for a in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        let mut x = powmod(a, d, n);
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 1..s {
            x = mulmod(x, x, n);
            if x == n - 1 {
                continue 'a;
            }
        }
        return false;
    }
    true
}

/// Primes below 2^62, decreasing.
pub struct Primes {
    next: u64,
}

impl Primes {
    pub fn new() -> Primes {
        Primes { next: (1u64 << 62) - 57 }
    }

    /// The primes below n (odd n), decreasing.
    pub fn below(n: u64) -> Primes {
        Primes { next: if n % 2 == 0 { n - 1 } else { n - 2 } }
    }
}

impl Iterator for Primes {
    type Item = u64;
    fn next(&mut self) -> Option<u64> {
        loop {
            let c = self.next;
            self.next -= 2;
            if is_prime_u64(c) {
                return Some(c);
            }
        }
    }
}

// ------------------------------------------------- polynomials mod p

pub(crate) fn reduce(a: &ZPoly, p: u64) -> SP {
    let bp = BigInt::from(p);
    let mut out = Vec::with_capacity(a.len());
    for i in 0..a.len() {
        let c = match &a.coeffs {
            Coeffs::Small(v) => v[i].rem_euclid(p as i64) as u64,
            Coeffs::Big(v) => v[i].mod_floor(&bp).to_u64().unwrap(),
        };
        if c != 0 {
            out.push((a.exps[i], c));
        }
    }
    out
}

/// The field of variable z cleared.
fn clear(pk: &Packing, w: u64, z: usize) -> u64 {
    w & !(pk.mask() << pk.shift(z))
}

/// f as a polynomial in variable z: (the other exponents) -> dense in z.
fn split(pk: &Packing, f: &SP, z: usize) -> BTreeMap<u64, Vec<u64>> {
    let mut m: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
    for &(w, c) in f {
        let d = pk.exp(w, z) as usize;
        let v = m.entry(clear(pk, w, z)).or_default();
        if v.len() <= d {
            v.resize(d + 1, 0);
        }
        v[d] = c;
    }
    m
}

fn join(pk: &Packing, m: &BTreeMap<u64, Vec<u64>>, z: usize) -> SP {
    let mut out = Vec::new();
    for (&w, v) in m {
        for (d, &c) in v.iter().enumerate() {
            if c != 0 {
                out.push((w | (d as u64) << pk.shift(z), c));
            }
        }
    }
    out.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    out
}

fn eval_poly(v: &[u64], x: u64, md: &Modulus) -> u64 {
    let mut r = 0u64;
    for &c in v.iter().rev() {
        r = md.add(md.mul(r, x), c);
    }
    r
}

fn scale(f: &SP, c: u64, md: &Modulus) -> SP {
    f.iter().map(|&(w, x)| (w, md.mul(x, c))).collect()
}

/// The gcd of univariate polynomials (monic), or None for none.
fn ugcd_all<'a>(vs: impl Iterator<Item = &'a Vec<u64>>, md: &Modulus) -> Vec<u64> {
    let mut g: Vec<u64> = vec![];
    for v in vs {
        g = if g.is_empty() { up::monic(&up::trim(v.clone()), md) } else { up::gcd(&g, v, md) };
        if g.len() == 1 {
            break;
        }
    }
    up::monic(&up::trim(g), md)
}

/// Newton interpolation step: h += (c(x) - h(x)) / q(x) * q, for every
/// word; whether anything changed.
fn newton(h: &mut BTreeMap<u64, Vec<u64>>, c: &SP, x: u64, q: &[u64], md: &Modulus) -> bool {
    let qinv = md.inv(eval_poly(q, x, md)).unwrap();
    let cm: BTreeMap<u64, u64> = c.iter().copied().collect();
    let mut keys: Vec<u64> = h.keys().copied().collect();
    keys.extend(cm.keys().copied());
    keys.sort_unstable();
    keys.dedup();
    let mut changed = false;
    for w in keys {
        let hv = h.entry(w).or_default();
        let cur = eval_poly(hv, x, md);
        let want = cm.get(&w).copied().unwrap_or(0);
        if cur != want {
            changed = true;
            let r = md.mul(md.sub(want, cur), qinv);
            *hv = up::trim(up::add(hv, &up::scale(q, r, md), md));
        }
    }
    h.retain(|_, v| !v.is_empty());
    changed
}

/// Every coefficient (univariate in z) times m, or divided exactly by m
/// (None if some division is not exact).
fn map_mul(h: &BTreeMap<u64, Vec<u64>>, m: &[u64], md: &Modulus) -> BTreeMap<u64, Vec<u64>> {
    h.iter().map(|(w, v)| (*w, up::mul(v, m, md))).filter(|x| !x.1.is_empty()).collect()
}

fn map_div(h: &BTreeMap<u64, Vec<u64>>, m: &[u64], md: &Modulus) -> Option<BTreeMap<u64, Vec<u64>>> {
    h.iter().map(|(w, v)| {
        let (q, r) = up::divrem(v, m, md);
        up::trim(r).is_empty().then_some((*w, q))
    }).collect()
}

/// The gcd G of A and B over GF(p) in the variables 0..k (its leading
/// coefficient, in lex, 1) and the cofactors A / G, B / G; None on an
/// unlucky failure.  Brown: the cofactors are interpolated with G, which
/// makes trial divisions unnecessary.
fn pgcd(pk: &Packing, a: &SP, b: &SP, k: usize, md: &Modulus) -> Option<(SP, SP, SP)> {
    if a.is_empty() || b.is_empty() {
        let (f, other_zero_first) = if a.is_empty() { (b, true) } else { (a, false) };
        if f.is_empty() {
            return Some((vec![], vec![], vec![]));
        }
        let l = f[0].1;
        let g = monic(f, md);
        let unit = vec![(0u64, l)];
        return Some(if other_zero_first { (g, vec![], unit) } else { (g, unit, vec![]) });
    }
    sagebrush_interrupt::check();
    let z = k - 1;
    if k == 1 {
        let (ua, ub) = (split(pk, a, 0), split(pk, b, 0));
        let (ua, ub) = (&ua[&0], &ub[&0]);
        let g = up::monic(&up::gcd(ua, ub, md), md);
        let (ca, cb) = (up::divrem(ua, &g, md).0, up::divrem(ub, &g, md).0);
        let one = |v: Vec<u64>| join(pk, &BTreeMap::from([(0u64, v)]), 0);
        return Some((one(g), one(ca), one(cb)));
    }
    let (ma, mb) = (split(pk, a, z), split(pk, b, z));
    // contents in z and primitive parts
    let (ca, cb) = (ugcd_all(ma.values(), md), ugcd_all(mb.values(), md));
    let c = up::gcd(&ca, &cb, md);
    let pa: BTreeMap<u64, Vec<u64>> = ma.into_iter().map(|(w, v)| (w, up::divrem(&v, &ca, md).0)).collect();
    let pb: BTreeMap<u64, Vec<u64>> = mb.into_iter().map(|(w, v)| (w, up::divrem(&v, &cb, md).0)).collect();
    let (la, lb) = (pa.iter().next_back().unwrap().1.clone(), pb.iter().next_back().unwrap().1.clone());
    let gam = up::gcd(&la, &lb, md);
    let dza = pa.values().map(|v| v.len()).max().unwrap() - 1;
    let dzb = pb.values().map(|v| v.len()).max().unwrap() - 1;
    // degrees in z of gam / h * H and of the cofactors times h
    let bound = dza.max(dzb) + gam.len() - 1;
    // the coefficients in z, evaluated at each point
    let ev = |m: &BTreeMap<u64, Vec<u64>>, x: u64| -> SP {
        m.iter().rev().filter_map(|(&w, v)| {
            let c = eval_poly(v, x, md);
            (c != 0).then_some((w, c))
        }).collect()
    };
    let (mut hg, mut ha, mut hb): (BTreeMap<u64, Vec<u64>>, BTreeMap<u64, Vec<u64>>, BTreeMap<u64, Vec<u64>>) = Default::default();
    let mut q: Vec<u64> = vec![1];
    let mut lead: Option<u64> = None;
    let mut npts = 0usize;
    let mut tries = 0usize;
    // distinct pseudo-random points, different for each modulus and level:
    // 1, 2, 3, ... for every prime stopped early at the same wrong
    // interpolant when two of them were special (h = x + (y - 1)(y - 2):
    // the systematic review's MUL-F3)
    let mut used = std::collections::HashSet::new();
    let mut seed = md.n ^ (k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x2545_F491_4F6C_DD1D;
    loop {
        tries += 1;
        if tries > 4 * bound + 64 || used.len() as u64 + 1 >= md.n {
            return None;
        }
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let x = 1 + seed % (md.n - 1);
        if !used.insert(x) {
            continue;
        }
        let gx = eval_poly(&gam, x, md);
        if gx == 0 || eval_poly(&la, x, md) == 0 || eval_poly(&lb, x, md) == 0 {
            continue;
        }
        let (ax, bx) = (ev(&pa, x), ev(&pb, x));
        let Some((g1, a1, b1)) = pgcd(pk, &ax, &bx, k - 1, md) else { continue };
        let g1 = scale(&g1, gx, md);
        let lw = g1[0].0;
        match lead {
            Some(l) if lw > l => continue, // unlucky point
            Some(l) if lw == l => {}
            _ => {
                // first point, or the earlier ones were unlucky
                hg.clear();
                ha.clear();
                hb.clear();
                q = vec![1];
                npts = 0;
                lead = Some(lw);
            }
        }
        let c1 = newton(&mut hg, &g1, x, &q, md);
        let c2 = newton(&mut ha, &a1, x, &q, md);
        let c3 = newton(&mut hb, &b1, x, &q, md);
        q = up::mul(&q, &[md.sub(0, x), 1], md);
        npts += 1;
        // done when one more point changes nothing (a wrong stop has
        // probability about deg/p; the result is checked over Z at the top)
        // or when there are more points than the degree bound allows
        if (!(c1 || c2 || c3) && npts > 1) || npts > bound {
            // gam / h * H: H its primitive part, h the leading coefficient
            let ch = ugcd_all(hg.values(), md);
            let hh = map_div(&hg, &ch, md)?;
            let h = hh.iter().next_back()?.1.clone();
            let (abar, bbar) = match (map_div(&ha, &h, md), map_div(&hb, &h, md)) {
                (Some(x), Some(y)) => (x, y),
                _ if npts > bound => return None,
                _ => continue,
            };
            // with the contents
            let g = map_mul(&hh, &c, md);
            let abar = map_mul(&abar, &up::divrem(&ca, &c, md).0, md);
            let bbar = map_mul(&bbar, &up::divrem(&cb, &c, md).0, md);
            let (g, abar, bbar) = (join(pk, &g, z), join(pk, &abar, z), join(pk, &bbar, z));
            let u = g[0].1;
            let ui = md.inv(u)?;
            return Some((scale(&g, ui, md), scale(&abar, u, md), scale(&bbar, u, md)));
        }
    }
}

fn monic(f: &SP, md: &Modulus) -> SP {
    if f.is_empty() {
        return vec![];
    }
    let i = md.inv(f[0].1).unwrap();
    scale(f, i, md)
}

fn mul_p(pk: &Packing, a: &SP, b: &SP, md: &Modulus) -> SP {
    let za = ZPoly { n: pk.n, bits: pk.bits, exps: a.iter().map(|x| x.0).collect(), coeffs: Coeffs::Small(a.iter().map(|x| x.1 as i64).collect()) };
    let zb = ZPoly { n: pk.n, bits: pk.bits, exps: b.iter().map(|x| x.0).collect(), coeffs: Coeffs::Small(b.iter().map(|x| x.1 as i64).collect()) };
    let p = crate::mul(&za, &zb).unwrap().reduce_mod(md.n);
    let Coeffs::Small(c) = p.coeffs else { unreachable!() };
    let pk2 = Packing { n: pk.n, bits: p.bits };
    // back to the packing pk (the product's degrees fit: it is a gcd factor)
    p.exps.iter().zip(c).map(|(&w, c)| (pk.pack(&pk2.unpack(w)), c as u64)).collect()
}

/// gcd over GF(p) (p large enough for the evaluations), monic in lex.
pub fn gcd_p(a: &ZPoly, b: &ZPoly, p: u64) -> Result<ZPoly, String> {
    if p < 1 << 20 {
        return Err("gcd over small prime fields: not in the engine".into());
    }
    let n = a.n;
    let maxd = a.degrees().into_iter().chain(b.degrees()).max().unwrap_or(0);
    let bits = (crate::bits_for(maxd) + 1).max(a.bits).max(b.bits);
    if (n as u64) * (bits as u64) > 64 {
        return Err("exponents too large to pack".into());
    }
    let pk = Packing { n, bits };
    let md = Modulus::new(p);
    let (ap, bp) = (reduce(&a.repack(bits), p), reduce(&b.repack(bits), p));
    if ap.is_empty() && bp.is_empty() {
        return Ok(ZPoly::zero(n));
    }
    for _ in 0..4 {
        let Some((g, abar, bbar)) = pgcd(&pk, &ap, &bp, n, &md) else { continue };
        // checked: G * (A / G) = A and G * (B / G) = B
        if mul_p(&pk, &g, &abar, &md) == ap && mul_p(&pk, &g, &bbar, &md) == bp {
            return Ok(to_z(&pk, &g));
        }
    }
    Err("gcd: no lucky evaluation points".into())
}

fn to_z(pk: &Packing, g: &SP) -> ZPoly {
    ZPoly { n: pk.n, bits: pk.bits, exps: g.iter().map(|x| x.0).collect(), coeffs: Coeffs::Small(g.iter().map(|x| x.1 as i64).collect()) }
}

// ---------------------------------------------------------------- over Z

/// The monomial gcd of all terms (the word of the smallest exponents).
fn monomial_content(pk: &Packing, ws: impl Iterator<Item = u64>) -> u64 {
    let mut mins = vec![u64::MAX; pk.n];
    for w in ws {
        for (i, m) in mins.iter_mut().enumerate() {
            *m = (*m).min(pk.exp(w, i));
        }
    }
    pk.pack(&mins.iter().map(|&m| if m == u64::MAX { 0 } else { m }).collect::<Vec<_>>())
}

fn shift_down(p: &ZPoly, m: u64) -> ZPoly {
    ZPoly { n: p.n, bits: p.bits, exps: p.exps.iter().map(|w| w - m).collect(), coeffs: p.coeffs.clone() }
}

fn shift_up(p: &ZPoly, m: u64) -> ZPoly {
    ZPoly { n: p.n, bits: p.bits, exps: p.exps.iter().map(|w| w + m).collect(), coeffs: p.coeffs.clone() }
}

/// gcd(a, b) over Z: the primitive gcd times the gcd of the contents, with
/// a positive leading coefficient (lex).
pub fn gcd_z(a: &ZPoly, b: &ZPoly) -> Result<ZPoly, String> {
    Ok(gcd_cofactors(a, b)?.0)
}

/// (g, a / g, b / g) for g = gcd(a, b) over Z (as gcd_z).
pub fn gcd_cofactors(a: &ZPoly, b: &ZPoly) -> Result<(ZPoly, ZPoly, ZPoly), String> {
    let n = a.n;
    if a.is_zero() || b.is_zero() {
        let f = if a.is_zero() { b } else { a };
        if f.is_zero() {
            return Ok((f.clone(), ZPoly::zero(n), ZPoly::zero(n)));
        }
        let g = normalize_sign(f.clone());
        let u = if g.coeffs.big(0) == f.coeffs.big(0) { 1 } else { -1 };
        let unit = ZPoly { n, bits: 1, exps: vec![0], coeffs: Coeffs::Small(vec![u]) };
        return Ok(if a.is_zero() { (g, ZPoly::zero(n), unit) } else { (g, unit, ZPoly::zero(n)) });
    }
    let maxd = a.degrees().into_iter().chain(b.degrees()).max().unwrap_or(0);
    // one spare bit: the guard of the products checked
    let bits = (crate::bits_for(maxd) + 1).max(a.bits).max(b.bits);
    if (n as u64) * (bits as u64) > 64 {
        return Err("exponents too large to pack".into());
    }
    let (a, b) = (a.repack(bits), b.repack(bits));
    let pk = Packing { n, bits };
    // contents: integer and monomial
    let (ia, ib) = (a.content(), b.content());
    let ci = ia.gcd(&ib);
    let (ma, mb) = (monomial_content(&pk, a.exps.iter().copied()), monomial_content(&pk, b.exps.iter().copied()));
    let mc = pk.pack(&(0..n).map(|i| pk.exp(ma, i).min(pk.exp(mb, i))).collect::<Vec<_>>());
    let a1 = shift_down(&a.divexact_scalar(&ia), ma);
    let b1 = shift_down(&b.divexact_scalar(&ib), mb);
    let (core, ca, cb) = if a1.len() == 1 || b1.len() == 1 {
        // a monomial: gcd 1 after the contents
        (one(n, bits), a1, b1)
    } else {
        modular(&pk, &a1, &b1)?
    };
    // the contents back: a = (ia / ci) (ma / mc) * ca * (ci mc core)
    let g = shift_up(&core, mc).scale(&ci);
    let abar = shift_up(&ca, ma - mc).scale(&(&ia / &ci));
    let bbar = shift_up(&cb, mb - mc).scale(&(&ib / &ci));
    if g.coeffs.big(0).is_negative() {
        return Ok((g.neg(), abar.neg(), bbar.neg()));
    }
    Ok((g, abar, bbar))
}

fn one(n: usize, bits: u32) -> ZPoly {
    ZPoly { n, bits, exps: vec![0], coeffs: Coeffs::Small(vec![1]) }
}

fn normalize_sign(p: ZPoly) -> ZPoly {
    if !p.is_zero() && p.coeffs.big(0).is_negative() {
        p.neg()
    } else {
        p
    }
}

/// CRT of the images mod p into (coefficients, modulus); whether anything
/// changed.
fn crt(coeffs: &mut Vec<(u64, BigInt)>, m: &BigInt, g: &SP, p: u64, md: &Modulus) -> bool {
    let bp = BigInt::from(p);
    let gm: BTreeMap<u64, u64> = g.iter().copied().collect();
    let mut words: Vec<u64> = coeffs.iter().map(|x| x.0).collect();
    words.extend(gm.keys());
    words.sort_unstable_by(|x, y| y.cmp(x));
    words.dedup();
    let old: BTreeMap<u64, BigInt> = coeffs.drain(..).collect();
    let minv = BigInt::from(md.inv((m % &bp).to_u64().unwrap()).unwrap());
    let half = m / 2;
    let mut changed = false;
    for w in words {
        let c = old.get(&w).cloned().unwrap_or_default();
        // the symmetric residue mod m, compared with the image mod p
        let cs = if c > half { &c - m } else { c.clone() };
        let r = gm.get(&w).copied().unwrap_or(0);
        if cs.mod_floor(&bp).to_u64().unwrap() != r {
            changed = true;
        }
        let t = ((BigInt::from(r) - &c) * &minv).mod_floor(&bp);
        let nc = c + t * m;
        if !nc.is_zero() {
            coeffs.push((w, nc));
        }
    }
    changed
}

fn lift_sym(pk: &Packing, coeffs: &[(u64, BigInt)], m: &BigInt) -> ZPoly {
    let half = m / 2;
    let terms: Vec<(u64, BigInt)> = coeffs.iter().filter_map(|(w, c)| {
        let c = if c > &half { c - m } else { c.clone() };
        (!c.is_zero()).then_some((*w, c))
    }).collect();
    ZPoly { n: pk.n, bits: pk.bits, exps: terms.iter().map(|x| x.0).collect(), coeffs: Coeffs::Big(terms.into_iter().map(|x| x.1).collect()) }.shrunk()
}

/// The primitive gcd of primitive a, b (no monomial content) over Z, with
/// the cofactors.  Brown: images mod primes near 2^62 (gcd and cofactors),
/// combined by CRT until they stop changing, then checked by two products.
fn modular(pk: &Packing, a: &ZPoly, b: &ZPoly) -> Result<(ZPoly, ZPoly, ZPoly), String> {
    let n = pk.n;
    let gamma = a.coeffs.big(0).gcd(&b.coeffs.big(0));
    let (lca, lcb) = (a.coeffs.big(0), b.coeffs.big(0));
    // (lead word, G, A / G, B / G, modulus)
    type Crt = (u64, Vec<(u64, BigInt)>, Vec<(u64, BigInt)>, Vec<(u64, BigInt)>, BigInt);
    let mut cur: Option<Crt> = None;
    for p in Primes::new().take(2000) {
        let bp = BigInt::from(p);
        if (&lca % &bp).is_zero() || (&lcb % &bp).is_zero() {
            continue;
        }
        let md = Modulus::new(p);
        let (ap, bpp) = (reduce(a, p), reduce(b, p));
        let Some((g, ab, bb)) = pgcd(pk, &ap, &bpp, n, &md) else { continue };
        if g.len() == 1 && g[0].0 == 0 {
            return Ok((one(n, pk.bits), a.clone(), b.clone())); // coprime
        }
        let gm = gamma.mod_floor(&bp).to_u64().unwrap();
        let g = scale(&g, gm, &md);
        let lw = g[0].0;
        let changed = match &mut cur {
            Some((l, ..)) if lw > *l => continue,
            Some((l, cg, ca, cb, m)) if lw == *l => {
                let c1 = crt(cg, m, &g, p, &md);
                let c2 = crt(ca, m, &ab, p, &md);
                let c3 = crt(cb, m, &bb, p, &md);
                *m = &*m * &bp;
                c1 || c2 || c3
            }
            _ => {
                let big = |v: &SP| v.iter().map(|&(w, c)| (w, BigInt::from(c))).collect();
                cur = Some((lw, big(&g), big(&ab), big(&bb), bp.clone()));
                true
            }
        };
        if changed {
            continue;
        }
        let (_, cg, ca, cb, m) = cur.as_ref().unwrap();
        // G' = gamma / h * H, the cofactors times h = lc(H)
        let g1 = lift_sym(pk, cg, m);
        let s = g1.content();
        let h = g1.divexact_scalar(&s);
        let lh = h.coeffs.big(0);
        let (a1, b1) = (lift_sym(pk, ca, m), lift_sym(pk, cb, m));
        let divides = |f: &ZPoly| (0..f.len()).all(|i| (f.coeffs.big(i) % &lh).is_zero());
        if divides(&a1) && divides(&b1) {
            let (abar, bbar) = (a1.divexact_scalar(&lh), b1.divexact_scalar(&lh));
            let ok = h.mul(&abar).is_ok_and(|x| x.equals(a)) && h.mul(&bbar).is_ok_and(|x| x.equals(b));
            if ok {
                return Ok((h, abar, bbar));
            }
        }
        // a wrong image (an unlucky early stop): start over
        cur = None;
    }
    Err("gcd: too many primes".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(n: usize, t: &[(&[u64], i64)]) -> ZPoly {
        ZPoly::from_terms(n, t.iter().map(|(e, c)| (e.to_vec(), BigInt::from(*c))).collect()).unwrap()
    }

    #[test]
    fn pgcd_small() {
        // mod p: gcd((x+y)(x-y), (x+y)^2) = x + y
        let pk = Packing { n: 2, bits: 8 };
        let md = Modulus::new(1000003);
        let a = reduce(&poly(2, &[(&[2, 0], 1), (&[0, 2], -1)]).repack(8), md.n);
        let b = reduce(&poly(2, &[(&[2, 0], 1), (&[1, 1], 2), (&[0, 2], 1)]).repack(8), md.n);
        let g = pgcd(&pk, &a, &b, 2, &md).expect("pgcd failed").0;
        eprintln!("{:?}", g.iter().map(|&(w, c)| (pk.unpack(w), c)).collect::<Vec<_>>());
        assert_eq!(g.len(), 2);
    }

    #[test]
    fn primes() {
        let mut p = Primes::new();
        let a = p.next().unwrap();
        assert!(is_prime_u64(a) && a < 1 << 62);
        assert!(!is_prime_u64(1u64 << 61));
        assert!(is_prime_u64((1u64 << 61) - 1));
    }

    #[test]
    fn gcd_basic() {
        // (x + y + 1)^3 (x - 2y) and (x + y + 1)^2 (3x + z)
        let f = poly(3, &[(&[1, 0, 0], 1), (&[0, 1, 0], 1), (&[0, 0, 0], 1)]);
        let a = f.pow(3).unwrap().mul(&poly(3, &[(&[1, 0, 0], 1), (&[0, 1, 0], -2)])).unwrap();
        let b = f.pow(2).unwrap().mul(&poly(3, &[(&[1, 0, 0], 3), (&[0, 0, 1], 1)])).unwrap();
        let g = gcd_z(&a, &b).unwrap();
        assert!(g.equals(&f.pow(2).unwrap()));
        // with integer and monomial contents
        let a2 = a.scale(&BigInt::from(6)).mul(&poly(3, &[(&[0, 1, 2], 1)])).unwrap();
        let b2 = b.scale(&BigInt::from(-4)).mul(&poly(3, &[(&[1, 1, 1], 1)])).unwrap();
        let g2 = gcd_z(&a2, &b2).unwrap();
        assert!(g2.equals(&f.pow(2).unwrap().scale(&BigInt::from(2)).mul(&poly(3, &[(&[0, 1, 1], 1)])).unwrap()));
        // coprime
        let c = gcd_z(&poly(2, &[(&[1, 0], 1), (&[0, 1], 1)]), &poly(2, &[(&[1, 0], 1), (&[0, 1], -1)])).unwrap();
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn gcd_bigger() {
        // random-ish dense factors in 4 variables with big coefficients
        let g = poly(4, &[(&[2, 1, 0, 0], 123456789), (&[0, 0, 3, 1], -987654321), (&[1, 1, 1, 1], 5), (&[0, 0, 0, 0], 7)]);
        let u = poly(4, &[(&[3, 0, 0, 0], 2), (&[0, 2, 0, 1], -3), (&[0, 0, 0, 0], 11)]);
        let v = poly(4, &[(&[0, 3, 0, 0], 4), (&[1, 0, 2, 0], 9), (&[0, 0, 0, 2], -1)]);
        let gg = g.pow(3).unwrap();
        let a = gg.mul(&u).unwrap();
        let b = gg.mul(&v).unwrap();
        let r = gcd_z(&a, &b).unwrap();
        assert!(r.equals(&normalize_sign(gg.clone())), "{:?}", r.len());
    }
}
