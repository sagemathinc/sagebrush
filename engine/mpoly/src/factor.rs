//! Multivariate factorization over Z (so over Q): contents, Yun's
//! square-free decomposition, and Wang's EEZ algorithm for the square-free
//! parts: an evaluation of all variables but one, the univariate
//! factorization of the image (sagebrush-poly), leading coefficients
//! imposed (the polynomial multiplied by lc^(r-1)), and multivariate Hensel
//! lifting modulo p^k, one variable at a time, by multivariate diophantine
//! equations.  Every factor found is checked by exact division; a failure
//! (an image with extraneous factors, too little p-adic precision) tries
//! another evaluation point.

use crate::divide::divexact;
use crate::gcd::{gcd_cofactors, gcd_z};
use crate::{Coeffs, ZPoly};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

// ------------------------------------------------------------- helpers

fn terms(f: &ZPoly) -> Vec<(Vec<u64>, BigInt)> {
    (0..f.len()).map(|i| (f.unpack(f.exps[i]), f.coeffs.big(i))).collect()
}

fn build(n: usize, t: Vec<(Vec<u64>, BigInt)>) -> ZPoly {
    ZPoly::from_terms(n, t).expect("factor: exponents too large")
}

fn constant(n: usize, c: BigInt) -> ZPoly {
    build(n, vec![(vec![0; n], c)])
}

fn var(n: usize, j: usize) -> ZPoly {
    let mut e = vec![0; n];
    e[j] = 1;
    build(n, vec![(e, BigInt::one())])
}

fn deg_in(f: &ZPoly, j: usize) -> u64 {
    f.exps.iter().map(|&w| f.exp(w, j)).max().unwrap_or(0)
}

fn uses(f: &ZPoly, j: usize) -> bool {
    f.exps.iter().any(|&w| f.exp(w, j) > 0)
}

/// The coefficient of x_j^m (x_j removed).
fn coeff_in(f: &ZPoly, j: usize, m: u64) -> ZPoly {
    let t = terms(f).into_iter().filter(|(e, _)| e[j] == m).map(|(mut e, c)| {
        e[j] = 0;
        (e, c)
    }).collect();
    build(f.n, t)
}

/// f * x_j^m.
fn mul_var(f: &ZPoly, j: usize, m: u64) -> ZPoly {
    build(f.n, terms(f).into_iter().map(|(mut e, c)| {
        e[j] += m;
        (e, c)
    }).collect())
}

/// f with x_j = a.
fn eval_var(f: &ZPoly, j: usize, a: &BigInt) -> ZPoly {
    let mut pw: Vec<BigInt> = vec![BigInt::one()];
    let t = terms(f).into_iter().map(|(mut e, c)| {
        let k = e[j] as usize;
        while pw.len() <= k {
            let l = pw.last().unwrap() * a;
            pw.push(l);
        }
        e[j] = 0;
        (e, c * &pw[k])
    }).collect();
    build(f.n, t)
}

/// f(x_j + a): Horner in x_j.
fn shift_var(f: &ZPoly, j: usize, a: &BigInt) -> ZPoly {
    if a.is_zero() {
        return f.clone();
    }
    let d = deg_in(f, j);
    let lin = var(f.n, j).add_signed(&constant(f.n, a.clone()), false);
    let mut r = ZPoly::zero(f.n);
    for m in (0..=d).rev() {
        r = r.mul(&lin).unwrap().add_signed(&coeff_in(f, j, m), false);
    }
    r
}

/// Terms with deg in x_j at most d.
fn truncate(f: &ZPoly, j: usize, d: u64) -> ZPoly {
    build(f.n, terms(f).into_iter().filter(|(e, _)| e[j] <= d).collect())
}

/// The coefficients reduced to the symmetric range mod m.
fn smod(f: &ZPoly, m: &BigInt) -> ZPoly {
    let h = m / 2;
    build(f.n, terms(f).into_iter().map(|(e, c)| {
        let r = c.mod_floor(m);
        (e, if r > h { r - m } else { r })
    }).collect())
}

fn derivative(f: &ZPoly, j: usize) -> ZPoly {
    build(f.n, terms(f).into_iter().filter(|(e, _)| e[j] > 0).map(|(mut e, c)| {
        let k = e[j];
        e[j] -= 1;
        (e, c * BigInt::from(k))
    }).collect())
}

fn univ(f: &ZPoly, v: usize) -> Vec<BigInt> {
    let d = deg_in(f, v) as usize;
    let mut out = vec![BigInt::zero(); d + 1];
    for (e, c) in terms(f) {
        out[e[v] as usize] += c;
    }
    out
}

fn from_univ(u: &[BigInt], n: usize, v: usize) -> ZPoly {
    build(n, u.iter().enumerate().filter(|(_, c)| !c.is_zero()).map(|(k, c)| {
        let mut e = vec![0; n];
        e[v] = k as u64;
        (e, c.clone())
    }).collect())
}

fn sub(a: &ZPoly, b: &ZPoly) -> ZPoly {
    a.add_signed(b, true)
}

fn add(a: &ZPoly, b: &ZPoly) -> ZPoly {
    a.add_signed(b, false)
}

fn mul(a: &ZPoly, b: &ZPoly) -> ZPoly {
    a.mul(b).unwrap()
}

/// The leading coefficient in x_v (a polynomial in the other variables).
fn lc_in(f: &ZPoly, v: usize) -> ZPoly {
    coeff_in(f, v, deg_in(f, v))
}

fn content_in(f: &ZPoly, v: usize) -> Result<ZPoly, String> {
    let d = deg_in(f, v);
    let mut g = ZPoly::zero(f.n);
    let mut cs: Vec<ZPoly> = (0..=d).map(|m| coeff_in(f, v, m)).filter(|c| !c.is_zero()).collect();
    cs.sort_by_key(|c| c.len());
    for c in cs {
        g = gcd_z(&g, &c)?;
        if is_constant(&g) {
            break;
        }
    }
    Ok(g)
}

fn is_constant(f: &ZPoly) -> bool {
    f.len() <= 1 && f.exps.iter().all(|&w| w == 0)
}

// --------------------------------------------- univariate mod p^k

/// Polynomials mod m (coefficients in [0, m)), constant first.
type U = Vec<BigInt>;

fn utrim(mut a: U) -> U {
    while a.last().is_some_and(|c| c.is_zero()) {
        a.pop();
    }
    a
}

fn umod(a: &[BigInt], m: &BigInt) -> U {
    utrim(a.iter().map(|c| c.mod_floor(m)).collect())
}

fn umul(a: &[BigInt], b: &[BigInt], m: &BigInt) -> U {
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
    umod(&r, m)
}

fn uadd(a: &[BigInt], b: &[BigInt], m: &BigInt) -> U {
    let mut r = vec![BigInt::zero(); a.len().max(b.len())];
    for (i, x) in a.iter().enumerate() {
        r[i] += x;
    }
    for (i, x) in b.iter().enumerate() {
        r[i] += x;
    }
    umod(&r, m)
}

fn uscale(a: &[BigInt], c: &BigInt, m: &BigInt) -> U {
    umod(&a.iter().map(|x| x * c).collect::<Vec<_>>(), m)
}

/// a mod b for b with an invertible leading coefficient (mod m).
fn urem(a: &[BigInt], b: &[BigInt], m: &BigInt) -> U {
    let mut r = umod(a, m);
    let db = b.len() - 1;
    let li = b[db].modinv(m).expect("leading coefficient not invertible");
    while r.len() > db {
        let k = r.len() - 1;
        let q = (&r[k] * &li).mod_floor(m);
        for (i, x) in b.iter().enumerate() {
            r[k - db + i] -= &q * x;
        }
        r = umod(&r, m);
    }
    r
}

/// (g, s, t) with s a + t b = g mod the prime p (g monic).
fn uxgcd_p(a: &[BigInt], b: &[BigInt], p: &BigInt) -> (U, U, U) {
    let (mut r0, mut r1) = (umod(a, p), umod(b, p));
    let (mut s0, mut s1): (U, U) = (vec![BigInt::one()], vec![]);
    let (mut t0, mut t1): (U, U) = (vec![], vec![BigInt::one()]);
    while !r1.is_empty() {
        // q = r0 div r1
        let mut r = r0.clone();
        let mut q = vec![BigInt::zero(); r0.len().saturating_sub(r1.len()) + 1];
        let li = r1.last().unwrap().modinv(p).unwrap();
        while r.len() >= r1.len() && !r.is_empty() {
            let k = r.len() - r1.len();
            let c = (r.last().unwrap() * &li).mod_floor(p);
            q[k] = c.clone();
            for (i, x) in r1.iter().enumerate() {
                r[k + i] -= &c * x;
            }
            r = umod(&r, p);
        }
        let neg = |v: U| -> U { v.into_iter().map(|c| -c).collect() };
        let ns = uadd(&s0, &neg(umul(&q, &s1, p)), p);
        let nt = uadd(&t0, &neg(umul(&q, &t1, p)), p);
        (r0, r1) = (r1, r);
        (s0, s1) = (s1, ns);
        (t0, t1) = (t1, nt);
    }
    let li = r0.last().unwrap().modinv(p).unwrap();
    (uscale(&r0, &li, p), uscale(&s0, &li, p), uscale(&t0, &li, p))
}

/// For monic pairwise coprime (mod p) u_1..u_r mod m: s_i with
/// sum s_i prod_{j != i} u_j = 1 mod p^k, deg s_i < deg u_i.
fn bezout_lifted(us: &[U], p: &BigInt, m: &BigInt) -> Vec<U> {
    let r = us.len();
    // mod p: the partial fractions of 1 / prod u_i, pairwise
    let mut s: Vec<U> = vec![vec![]; r];
    // s_i = (1 / prod_{j != i} u_j) mod u_i  computed via xgcd
    let usp: Vec<U> = us.iter().map(|u| umod(u, p)).collect();
    for i in 0..r {
        let mut b: U = vec![BigInt::one()];
        for (j, u) in usp.iter().enumerate() {
            if j != i {
                b = umul(&b, u, p);
            }
        }
        let (_, si, _) = uxgcd_p(&b, &usp[i], p);
        s[i] = urem(&si, &usp[i], p);
    }
    // quadratic lifting: s_i <- s_i (1 + e) rem u_i, e = 1 - sum s_i b_i
    let mut q = p.clone();
    while &q < m {
        q = (&q * &q).min(m.clone());
        let mut bs: Vec<U> = vec![];
        for i in 0..r {
            let mut b: U = vec![BigInt::one()];
            for (j, u) in us.iter().enumerate() {
                if j != i {
                    b = umul(&b, u, &q);
                }
            }
            bs.push(b);
        }
        let mut acc: U = vec![];
        for i in 0..r {
            acc = uadd(&acc, &umul(&s[i], &bs[i], &q), &q);
        }
        let mut e: U = acc.iter().map(|c| -c).collect();
        if e.is_empty() {
            e.push(BigInt::zero());
        }
        e[0] += BigInt::one();
        let e = umod(&e, &q);
        let onepe = uadd(&[BigInt::one()], &e, &q);
        for i in 0..r {
            s[i] = urem(&umul(&s[i], &onepe, &q), &us[i], &q);
        }
    }
    s
}

// ------------------------------------------------------ Hensel lifting

struct Lift {
    n: usize,
    v: usize,
    /// p^k
    m: BigInt,
    /// the univariate (in v) images, monic-normalized data for diophantine
    s: Vec<U>,
    umon: Vec<U>,
}

impl Lift {
    /// sigma_i with sum sigma_i b_i = c mod (m, y_j^(d_j + 1) for j in ys),
    /// b_i = prod_{l != i} f_l, deg_v sigma_i < deg_v f_i.  Univariate base
    /// case: from the lifted partial fractions.
    fn diophant(&self, fs: &[ZPoly], c: &ZPoly, ys: &[(usize, u64)]) -> Vec<ZPoly> {
        let r = fs.len();
        if ys.is_empty() {
            // c univariate in v: sigma_i = (c s_i / lambda_i) rem u_i, with
            // b_i = lambda_i prod_{l != i} umon_l
            let cu = umod(&univ(c, self.v), &self.m);
            let mut out = vec![];
            for i in 0..r {
                let mut lam = BigInt::one();
                for (l, f) in fs.iter().enumerate() {
                    if l != i {
                        lam = (lam * f.coeffs.big(0)).mod_floor(&self.m);
                    }
                }
                let li = lam.modinv(&self.m).expect("lc not invertible mod p^k");
                let t = urem(&umul(&cu, &self.s[i], &self.m), &self.umon[i], &self.m);
                out.push(smod(&from_univ(&uscale(&t, &li, &self.m), self.n, self.v), &self.m));
            }
            return out;
        }
        let (y, d) = *ys.last().unwrap();
        let rest = &ys[..ys.len() - 1];
        let zero = BigInt::zero();
        let fs0: Vec<ZPoly> = fs.iter().map(|f| eval_var(f, y, &zero)).collect();
        let c0 = eval_var(c, y, &zero);
        let mut sig = self.diophant(&fs0, &c0, rest);
        // b_i = prod_{l != i} f_l
        let bs: Vec<ZPoly> = (0..r).map(|i| {
            let mut b = constant(self.n, BigInt::one());
            for (l, f) in fs.iter().enumerate() {
                if l != i {
                    b = truncate(&mul(&b, f), y, d);
                }
            }
            smod(&b, &self.m)
        }).collect();
        let resid = |sig: &[ZPoly]| -> ZPoly {
            let mut e = c.clone();
            for i in 0..r {
                e = sub(&e, &truncate(&mul(&sig[i], &bs[i]), y, d));
            }
            smod(&e, &self.m)
        };
        let mut e = resid(&sig);
        for k in 1..=d {
            if e.is_zero() {
                break;
            }
            let ck = coeff_in(&e, y, k);
            if ck.is_zero() {
                continue;
            }
            let ds = self.diophant(&fs0, &ck, rest);
            for i in 0..r {
                sig[i] = smod(&add(&sig[i], &mul_var(&ds[i], y, k)), &self.m);
            }
            e = resid(&sig);
        }
        sig
    }
}

/// p-adic and multivariate Hensel lifting: G (shifted: evaluation point 0)
/// with G(v, 0) = prod U_i (mod p) and the true leading coefficients lcs
/// (polynomials in the other variables): the factors mod p^k, or None.
fn hensel(g: &ZPoly, v: usize, ys: &[usize], us: &[Vec<BigInt>], lcs: &[ZPoly], p: &BigInt, m: &BigInt) -> Option<Vec<ZPoly>> {
    let n = g.n;
    let r = us.len();
    // the images mod p^k with the right leading coefficients: U_i scaled
    let zero = BigInt::zero();
    let mut img: Vec<U> = vec![];
    for i in 0..r {
        let mut l = lcs[i].clone();
        for &y in ys {
            l = eval_var(&l, y, &zero);
        }
        let lv = l.coeffs.big(0).mod_floor(m);
        let ui = umod(&us[i], m);
        let li = ui.last().unwrap().modinv(m)?;
        img.push(uscale(&ui, &(lv * li).mod_floor(m), m));
    }
    // p-adic lifting of the univariate factorization of G(v, 0)
    let mut g0 = g.clone();
    for &y in ys {
        g0 = eval_var(&g0, y, &zero);
    }
    let g0u = univ(&g0, v);
    let img = lift_univariate(&g0u, img, p, m)?;
    let umon: Vec<U> = img.iter().map(|u| {
        let li = u.last().unwrap().modinv(m).unwrap();
        uscale(u, &li, m)
    }).collect();
    let s = bezout_lifted(&umon, p, m);
    let lift = Lift { n, v, m: m.clone(), s, umon };
    let mut fs: Vec<ZPoly> = img.iter().map(|u| smod(&from_univ(u, n, v), m)).collect();
    // one variable at a time
    for (jj, &y) in ys.iter().enumerate() {
        // G with the later variables still at 0
        let mut gj = g.clone();
        for &z in &ys[jj + 1..] {
            gj = eval_var(&gj, z, &zero);
        }
        let d = deg_in(&gj, y);
        // impose the leading coefficients (in v) as polynomials in y_1..y_j
        for i in 0..r {
            let mut l = lcs[i].clone();
            for &z in &ys[jj + 1..] {
                l = eval_var(&l, z, &zero);
            }
            let dv = deg_in(&fs[i], v);
            let without = sub(&fs[i], &mul_var(&lc_in(&fs[i], v), v, dv));
            fs[i] = smod(&add(&without, &mul_var(&l, v, dv)), m);
        }
        let prod = |fs: &[ZPoly]| -> ZPoly {
            let mut t = constant(n, BigInt::one());
            for f in fs {
                t = truncate(&mul(&t, f), y, d);
            }
            smod(&t, m)
        };
        let mut e = smod(&sub(&gj, &prod(&fs)), m);
        let ysofar: Vec<(usize, u64)> = ys[..jj].iter().map(|&z| (z, deg_in(g, z))).collect();
        let fs0: Vec<ZPoly> = fs.iter().map(|f| eval_var(f, y, &zero)).collect();
        for k in 1..=d {
            sagebrush_interrupt::check();
            if e.is_zero() {
                break;
            }
            let ck = coeff_in(&e, y, k);
            if ck.is_zero() {
                continue;
            }
            let ds = lift.diophant(&fs0, &ck, &ysofar);
            for i in 0..r {
                fs[i] = smod(&add(&fs[i], &mul_var(&ds[i], y, k)), m);
            }
            e = smod(&sub(&gj, &prod(&fs)), m);
        }
        if !e.is_zero() {
            return None;
        }
    }
    Some(fs)
}

/// The p-adic lifting (linear) of g = prod u_i mod p to mod m (the u_i with
/// the leading coefficients wanted; g's leading coefficient their product).
fn lift_univariate(g: &[BigInt], us: Vec<U>, p: &BigInt, m: &BigInt) -> Option<Vec<U>> {
    let r = us.len();
    let mut us = us;
    let umon_p: Vec<U> = us.iter().map(|u| {
        let up = umod(u, p);
        let li = up.last()?.modinv(p)?;
        Some(uscale(&up, &li, p))
    }).collect::<Option<_>>()?;
    let s = bezout_lifted(&umon_p, p, p);
    let mut q = p.clone();
    while &q < m {
        let q2 = (&q * p).min(m.clone());
        // e = (g - prod u) / q  mod p
        let mut prod: U = vec![BigInt::one()];
        for u in &us {
            prod = umul(&prod, u, &q2);
        }
        let diff = umod(&uadd(&umod(g, &q2), &prod.iter().map(|c| -c).collect::<Vec<_>>(), &q2), &q2);
        if diff.is_empty() {
            q = q2;
            continue;
        }
        let e: U = utrim(diff.iter().map(|c| (c / &q).mod_floor(p)).collect());
        // u_i += q * ((e * s_i / lambda_i) rem umon_i), lambda_i = prod_{l != i} lc(u_l)
        for i in 0..r {
            let mut lam = BigInt::one();
            for (l, u) in us.iter().enumerate() {
                if l != i {
                    lam = (lam * u.last().unwrap()).mod_floor(p);
                }
            }
            let li = lam.modinv(p)?;
            let t = urem(&umul(&e, &s[i], p), &umon_p[i], p);
            let t = uscale(&t, &li, p);
            us[i] = uadd(&us[i], &t.iter().map(|c| c * &q).collect::<Vec<_>>(), &q2);
        }
        q = q2;
    }
    Some(us)
}

// --------------------------------------------------------- the driver

/// The factorization of f over Z: (unit content, [(irreducible, e)]) with
/// primitive factors of positive leading coefficient (lex).
pub fn factor_z(f: &ZPoly) -> Result<(BigInt, Vec<(ZPoly, u32)>), String> {
    let n = f.n;
    if f.is_zero() {
        return Err("factor(0)".into());
    }
    let mut c = f.content();
    if f.coeffs.big(0).is_negative() {
        c = -c;
    }
    let g = f.divexact_scalar(&c);
    let mut out: Vec<(ZPoly, u32)> = vec![];
    // monomial content
    let degs_min: Vec<u64> = (0..n).map(|j| g.exps.iter().map(|&w| g.exp(w, j)).min().unwrap_or(0)).collect();
    for (j, &k) in degs_min.iter().enumerate() {
        if k > 0 {
            out.push((var(n, j), k as u32));
        }
    }
    let g = build(n, terms(&g).into_iter().map(|(mut e, c)| {
        for j in 0..n {
            e[j] -= degs_min[j];
        }
        (e, c)
    }).collect());
    factor_rec(&g, &mut out)?;
    // equal factors merged
    let mut merged: Vec<(ZPoly, u32)> = vec![];
    for (h, e) in out {
        match merged.iter_mut().find(|(k, _)| k.equals(&h)) {
            Some(x) => x.1 += e,
            None => merged.push((h, e)),
        }
    }
    Ok((c, merged))
}

fn normalize(h: ZPoly) -> ZPoly {
    let c = h.content();
    let h = h.divexact_scalar(&c);
    if h.coeffs.big(0).is_negative() {
        h.neg()
    } else {
        h
    }
}

/// Factors of a primitive g (no monomial content) appended to out.
fn factor_rec(g: &ZPoly, out: &mut Vec<(ZPoly, u32)>) -> Result<(), String> {
    if is_constant(g) {
        return Ok(());
    }
    let n = g.n;
    let v = (0..n).find(|&j| uses(g, j)).unwrap();
    // the content in v (a polynomial in the other variables)
    let cont = content_in(g, v)?;
    if !is_constant(&cont) {
        factor_rec(&normalize(cont.clone()), out)?;
    }
    let pp = normalize(if is_constant(&cont) { g.clone() } else { divexact(g, &cont).ok_or("content does not divide")? });
    if !uses(&pp, v) {
        return Ok(());
    }
    // Yun in v
    for (part, e) in squarefree(&pp, v)? {
        for h in factor_squarefree(&part, v)? {
            out.push((h, e));
        }
    }
    Ok(())
}

/// Yun's square-free decomposition of pp (primitive in v) with respect to v.
fn squarefree(f: &ZPoly, v: usize) -> Result<Vec<(ZPoly, u32)>, String> {
    if surely_squarefree(f, v) {
        return Ok(vec![(f.clone(), 1)]);
    }
    let df = derivative(f, v);
    let (b, c, db) = gcd_cofactors(f, &df)?;
    if is_constant(&b) {
        return Ok(vec![(f.clone(), 1)]);
    }
    let mut out = vec![];
    let mut c = c;
    let mut d = sub(&db, &derivative(&c, v));
    let mut i = 1u32;
    while uses(&c, v) {
        let (a, c1, d1) = gcd_cofactors(&c, &d)?;
        if uses(&a, v) {
            out.push((normalize(a.clone()), i));
        }
        c = c1;
        d = sub(&d1, &derivative(&c, v));
        i += 1;
    }
    Ok(out)
}

/// Whether an image of f (all variables but v at random points modulo a
/// large prime) is square-free of the same degree: then so is f.
fn surely_squarefree(f: &ZPoly, v: usize) -> bool {
    use sagebrush_arith::nmod_poly as up;
    use sagebrush_bigint::nmod::Modulus;
    let p = (1u64 << 62) - 57;
    let md = Modulus::new(p);
    let mut x = 0x2545F4914F6CDD1Du64;
    let pts: Vec<u64> = (0..f.n).map(|_| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % p
    }).collect();
    let dv = deg_in(f, v) as usize;
    let mut u = vec![0u64; dv + 1];
    let bp = BigInt::from(p);
    for i in 0..f.len() {
        let w = f.exps[i];
        let mut c = f.coeffs.big(i).mod_floor(&bp).to_u64().unwrap();
        for j in 0..f.n {
            if j != v {
                c = md.mul(c, md.pow(pts[j], f.exp(w, j)));
            }
        }
        let k = f.exp(w, v) as usize;
        u[k] = md.add(u[k], c);
    }
    if u[dv] == 0 {
        return false;
    }
    up::gcd(&u, &up::derivative(&u, &md), &md).len() == 1
}

/// The irreducible factors of s, square-free and primitive in v: in the
/// main variable with the simplest leading coefficient (a constant if
/// possible), then the largest degree (the fewest lifting steps).
fn factor_squarefree(s: &ZPoly, v: usize) -> Result<Vec<ZPoly>, String> {
    let n = s.n;
    let w = (0..n).filter(|&j| uses(s, j)).min_by_key(|&j| {
        let l = lc_in(s, j);
        (!is_constant(&l), l.len(), u64::MAX - deg_in(s, j))
    }).unwrap();
    if w == v {
        return factor_sqfree_in(s, v);
    }
    let cont = content_in(s, w)?;
    if is_constant(&cont) {
        return factor_sqfree_in(s, w);
    }
    let mut out: Vec<ZPoly> = factor_z(&cont)?.1.into_iter().map(|(h, _)| h).collect();
    let rest = divexact(s, &cont).ok_or("content does not divide")?;
    out.extend(factor_sqfree_in(&normalize(rest), w)?);
    Ok(out)
}

fn factor_sqfree_in(s: &ZPoly, v: usize) -> Result<Vec<ZPoly>, String> {
    let n = s.n;
    let ys: Vec<usize> = (0..n).filter(|&j| j != v && uses(s, j)).collect();
    if ys.is_empty() {
        let (_, fs) = sagebrush_poly::factor(&univ(s, v));
        let mut out = vec![];
        for (h, e) in fs {
            for _ in 0..e {
                out.push(normalize(from_univ(&h, n, v)));
            }
        }
        return Ok(out);
    }
    let dv = deg_in(s, v);
    if dv == 1 {
        return Ok(vec![normalize(s.clone())]);
    }
    let lc = lc_in(s, v);
    // Wang: lc = omega * prod F_j^e_j, the F_j distributed over the factors
    let (omega, lfacs) = if is_constant(&lc) { (lc.coeffs.big(0), vec![]) } else { factor_z(&lc)? };
    let lf: Vec<ZPoly> = lfacs.iter().map(|(h, _)| h.clone()).collect();
    let le: Vec<u32> = lfacs.iter().map(|(_, e)| *e).collect();
    let mut rng = 0x9E3779B97F4A7C15u64;
    let mut next = |range: i64| -> i64 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        (rng % (2 * range as u64 + 1)) as i64 - range
    };
    for attempt in 0..40 {
        let range = 3 + 4 * attempt as i64;
        // a few good evaluation points: the one with the fewest univariate factors
        let mut best: Option<(Vec<BigInt>, Vec<Vec<BigInt>>, Vec<BigInt>, Vec<BigInt>)> = None;
        let mut found = 0;
        let mut tried = attempt;
        for _ in 0..100 {
            if found >= 3 {
                break;
            }
            // mostly zeros first: shifting by a nonzero coordinate makes
            // the lifting dense in that variable
            let a: Vec<BigInt> = if tried == 0 {
                vec![BigInt::zero(); ys.len()]
            } else {
                let zp = if attempt < 2 { 2 } else { 1 + attempt as u64 % 3 };
                ys.iter().map(|_| if next(1000) as u64 % (zp + 1) != 0 { BigInt::zero() } else { BigInt::from(next(range)) }).collect()
            };
            tried += 1;
            let at = |f: &ZPoly| -> ZPoly {
                let mut f = f.clone();
                for (k, &y) in ys.iter().enumerate() {
                    f = eval_var(&f, y, &a[k]);
                }
                f
            };
            if at(&lc).is_zero() {
                continue;
            }
            let uu = eval_univ(s, v, &ys, &a);
            if uu.len() as u64 != dv + 1 {
                continue;
            }
            // square-free image
            let sq = sagebrush_poly::squarefree(&normalize_univ(&uu));
            if sq.len() != 1 || sq[0].1 != 1 {
                continue;
            }
            // Wang's condition: every F_j(a) with a prime of its own
            let ft: Vec<BigInt> = lf.iter().map(|h| at(h).coeffs.big(0)).collect();
            let delta = {
                let mut g = BigInt::zero();
                for c in &uu {
                    g = g.gcd(c);
                }
                g
            };
            let Some(ds) = distinct_parts(&(&omega * &delta), &ft) else { continue };
            let (_, fs) = sagebrush_poly::factor(&uu);
            let facs: Vec<Vec<BigInt>> = fs.into_iter().flat_map(|(h, e)| std::iter::repeat(h).take(e as usize)).collect();
            found += 1;
            if facs.len() == 1 {
                return Ok(vec![normalize(s.clone())]);
            }
            if best.as_ref().is_none_or(|b| facs.len() < b.1.len()) {
                best = Some((a, facs, ft, ds));
            }
        }
        let Some((a, facs, ft, ds)) = best else { continue };
        // the leading coefficient of each factor: omega * D_i
        let Some(dis) = distribute(s.n, &lf, &le, &ft, &ds, &facs) else { continue };
        let lcs: Vec<ZPoly> = dis.iter().map(|d| d.scale(&omega)).collect();
        if let Some(fs) = eez(s, v, &ys, &a, &facs, &lcs, &omega)? {
            return Ok(fs);
        }
    }
    Err("factor: no good evaluation point".into())
}

/// Wang's distinct parts: d_0 = c, d_j the part of F_j(a) prime to
/// d_0, ..., d_(j-1); None when some d_j is a unit.
fn distinct_parts(c: &BigInt, ft: &[BigInt]) -> Option<Vec<BigInt>> {
    let mut ds = vec![c.abs()];
    for f in ft {
        let mut q = f.abs();
        if q.is_zero() {
            return None;
        }
        for d in ds.iter().rev() {
            let mut r = d.clone();
            loop {
                r = r.gcd(&q);
                if r.is_one() {
                    break;
                }
                q = &q / &r;
            }
        }
        if q.is_one() {
            return None;
        }
        ds.push(q);
    }
    Some(ds[1..].to_vec())
}

/// D_i, the product of the F_j dividing the leading coefficient of the
/// i-th factor, from the image's leading coefficients (Wang).
fn distribute(n: usize, lf: &[ZPoly], le: &[u32], ft: &[BigInt], ds: &[BigInt], facs: &[Vec<BigInt>]) -> Option<Vec<ZPoly>> {
    let r = facs.len();
    // the remaining leading coefficients, as fractions num / den
    let mut rem: Vec<(BigInt, BigInt)> = facs.iter().map(|h| (h.last().unwrap().clone(), BigInt::one())).collect();
    let mut dis: Vec<ZPoly> = vec![constant(n, BigInt::one()); r];
    for j in (0..lf.len()).rev() {
        let mut placed = 0;
        for i in 0..r {
            while placed < le[j] && (&rem[i].0 % &ds[j]).is_zero() {
                dis[i] = mul(&dis[i], &lf[j]);
                let (nm, dn) = (rem[i].0.clone(), &rem[i].1 * &ft[j]);
                let g = nm.gcd(&dn);
                rem[i] = (nm / &g, dn / &g);
                placed += 1;
            }
        }
        if placed != le[j] {
            return None;
        }
    }
    Some(dis)
}

/// s at the point a (for the variables ys), dense in v.
fn eval_univ(s: &ZPoly, v: usize, ys: &[usize], a: &[BigInt]) -> Vec<BigInt> {
    let mut pw: Vec<Vec<BigInt>> = ys.iter().map(|&y| {
        let d = deg_in(s, y) as usize;
        let mut p = vec![BigInt::one()];
        for k in 0..d {
            let x = &p[k] * &a[ys.iter().position(|&z| z == y).unwrap()];
            p.push(x);
        }
        p
    }).collect();
    let mut out = vec![BigInt::zero(); deg_in(s, v) as usize + 1];
    for i in 0..s.len() {
        let w = s.exps[i];
        let mut c = s.coeffs.big(i);
        for (k, &y) in ys.iter().enumerate() {
            let e = s.exp(w, y) as usize;
            if e > 0 {
                c *= &pw[k][e];
            }
        }
        out[s.exp(w, v) as usize] += c;
    }
    pw.clear();
    while out.last().is_some_and(|c| c.is_zero()) {
        out.pop();
    }
    out
}

fn normalize_univ(u: &[BigInt]) -> Vec<BigInt> {
    let mut g = BigInt::zero();
    for c in u {
        g = g.gcd(c);
    }
    let mut v: Vec<BigInt> = u.iter().map(|c| c / &g).collect();
    if v.last().is_some_and(|c| c.is_negative()) {
        v = v.into_iter().map(|c| -c).collect();
    }
    v
}

/// One EEZ attempt at the point a with the leading coefficients lcs (of the
/// factors of omega^(r-1) s): the factors, or None (try another).
fn eez(s: &ZPoly, v: usize, ys: &[usize], a: &[BigInt], facs: &[Vec<BigInt>], lcs: &[ZPoly], omega: &BigInt) -> Result<Option<Vec<ZPoly>>, String> {
    let r = facs.len();
    let mut g = s.clone();
    for _ in 1..r {
        g = g.scale(omega);
    }
    // first modulo one word-size prime (the usual case: small factors)
    if let Some(out) = eez_p(s, &g, v, ys, a, facs, lcs)? {
        return Ok(Some(out));
    }
    let n = s.n;
    // shift the evaluation point to 0
    let mut gs = g.clone();
    let mut lcs: Vec<ZPoly> = lcs.to_vec();
    for (k, &y) in ys.iter().enumerate() {
        gs = shift_var(&gs, y, &a[k]);
        for l in lcs.iter_mut() {
            *l = shift_var(l, y, &a[k]);
        }
    }
    let lc0: Vec<BigInt> = lcs.iter().map(|l| {
        let mut l = l.clone();
        for &y in ys {
            l = eval_var(&l, y, &BigInt::zero());
        }
        l.coeffs.big(0)
    }).collect();
    // coefficient bound for the factors of G: Gelfond-style
    let norm1: BigInt = (0..gs.len()).map(|i| gs.coeffs.big(i).abs()).sum();
    let totdeg: u64 = (0..n).map(|j| deg_in(&gs, j)).sum();
    let bound = norm1 * (BigInt::one() << (totdeg as usize + n + 1));
    let mut chosen: Option<BigInt> = None;
    for p in small_primes() {
        let bp = BigInt::from(p);
        if lc0.iter().any(|l| (l % &bp).is_zero()) {
            continue;
        }
        if facs.iter().any(|h| (h.last().unwrap() % &bp).is_zero()) {
            continue;
        }
        // pairwise coprime images mod p
        let ok = (0..r).all(|i| (i + 1..r).all(|j| {
            let (gg, _, _) = uxgcd_p(&facs[i], &facs[j], &bp);
            gg.len() == 1
        }));
        if ok {
            chosen = Some(bp);
            break;
        }
    }
    let Some(p) = chosen else { return Ok(None) };
    let mut m = p.clone();
    while m < &bound * BigInt::from(2) {
        m = &m * &p;
    }
    let Some(fs) = hensel(&gs, v, ys, facs, &lcs, &p, &m) else { return Ok(None) };
    // back to the original variables, primitive parts, check
    let mut out = vec![];
    let mut rest = s.clone();
    for f in fs {
        let mut h = f;
        for (k, &y) in ys.iter().enumerate() {
            h = shift_var(&h, y, &(-a[k].clone()));
        }
        let cont = content_in(&h, v)?;
        let h = normalize(if is_constant(&cont) { h } else { match divexact(&h, &cont) { Some(q) => q, None => return Ok(None) } });
        match divexact(&rest, &h) {
            Some(q) => rest = q,
            None => return Ok(None),
        }
        out.push(h);
    }
    if !is_constant(&rest) {
        return Ok(None);
    }
    Ok(Some(out))
}

/// The factors of s from a lifting modulo a prime near 2^62, checked over
/// Z; None when they do not come out (too large, or an extraneous image).
fn eez_p(s: &ZPoly, g: &ZPoly, v: usize, ys: &[usize], a: &[BigInt], facs: &[Vec<BigInt>], lcs: &[ZPoly]) -> Result<Option<Vec<ZPoly>>, String> {
    use crate::hensel;
    use crate::order::Packing;
    use sagebrush_arith::nmod_poly as up;
    use sagebrush_bigint::nmod::Modulus;
    let n = s.n;
    let r = facs.len();
    let maxd = g.degrees().into_iter().max().unwrap_or(0);
    let bits = crate::bits_for((r as u64 + 1) * maxd) + 1;
    if n as u32 * bits > 64 {
        return Ok(None);
    }
    let pk = Packing { n, bits };
    // the leading coefficients at the point a
    let lca: Vec<BigInt> = lcs.iter().map(|l| {
        let mut l = l.clone();
        for (k, &y) in ys.iter().enumerate() {
            l = eval_var(&l, y, &a[k]);
        }
        l.coeffs.big(0)
    }).collect();
    let red = |x: &BigInt, p: u64| -> u64 { x.mod_floor(&BigInt::from(p)).to_u64().unwrap() };
    let mut chosen = None;
    for p in crate::gcd::Primes::new().take(20) {
        if lca.iter().any(|l| red(l, p) == 0) || facs.iter().any(|h| red(h.last().unwrap(), p) == 0) {
            continue;
        }
        let md = Modulus::new(p);
        let fp: Vec<Vec<u64>> = facs.iter().map(|h| h.iter().map(|c| red(c, p)).collect()).collect();
        let coprime = (0..r).all(|i| (i + 1..r).all(|j| up::gcd(&fp[i], &fp[j], &md).len() == 1));
        if coprime {
            chosen = Some((p, md, fp));
            break;
        }
    }
    let Some((p, md, fp)) = chosen else { return Ok(None) };
    let ap: Vec<u64> = a.iter().map(|x| red(x, p)).collect();
    let to_p = |f: &ZPoly| -> hensel::SP {
        let mut x = crate::gcd::reduce(&f.repack(bits), p);
        for (k, &y) in ys.iter().enumerate() {
            x = hensel::taylor_shift(&pk, &x, y, ap[k], &md);
        }
        x
    };
    let gp = to_p(g);
    let lcp: Vec<hensel::SP> = lcs.iter().map(to_p).collect();
    // the images scaled to the leading coefficients
    let imgs: Vec<Vec<u64>> = (0..r).map(|i| {
        let c = md.mul(red(&lca[i], p), md.inv(*fp[i].last().unwrap()).unwrap());
        up::scale(&fp[i], c, &md)
    }).collect();
    let degs: Vec<u64> = ys.iter().map(|&y| deg_in(g, y)).collect();
    let Some(fs) = hensel::lift(&pk, &md, &gp, v, ys, &degs, &imgs, &lcp) else { return Ok(None) };
    let mut out = vec![];
    let mut rest = s.clone();
    let half = p / 2;
    for f in fs {
        let mut h = f;
        for (k, &y) in ys.iter().enumerate() {
            h = hensel::taylor_shift(&pk, &h, y, md.neg(ap[k]), &md);
        }
        let z = ZPoly {
            n,
            bits,
            exps: h.iter().map(|x| x.0).collect(),
            coeffs: Coeffs::Small(h.iter().map(|&(_, c)| if c > half { c as i64 - p as i64 } else { c as i64 }).collect()),
        };
        let h = normalize(z);
        match divexact(&rest, &h) {
            Some(q) => rest = q,
            None => return Ok(None),
        }
        out.push(h);
    }
    if !is_constant(&rest) {
        return Ok(None);
    }
    Ok(Some(out))
}

fn small_primes() -> impl Iterator<Item = u64> {
    (32003u64..).step_by(2).filter(|&p| crate::gcd::is_prime_u64(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(n: usize, t: &[(&[u64], i64)]) -> ZPoly {
        ZPoly::from_terms(n, t.iter().map(|(e, c)| (e.to_vec(), BigInt::from(*c))).collect()).unwrap()
    }

    fn check(f: &ZPoly, want: usize) {
        let (c, fs) = factor_z(f).unwrap();
        let mut prod = constant(f.n, c);
        for (h, e) in &fs {
            prod = mul(&prod, &h.pow(*e as u64).unwrap());
        }
        assert!(prod.equals(f), "product mismatch");
        let total: u32 = fs.iter().map(|x| x.1).sum();
        assert_eq!(total as usize, want, "{} factors", fs.len());
    }

    #[test]
    fn simple() {
        // x^2 - y^2 = (x - y)(x + y)
        check(&poly(2, &[(&[2, 0], 1), (&[0, 2], -1)]), 2);
        // irreducible x^2 + y^2 + 1
        check(&poly(2, &[(&[2, 0], 1), (&[0, 2], 1), (&[0, 0], 1)]), 1);
        // 6 x^3 y^2 (x + y)^2 (x y - 3)
        let a = poly(2, &[(&[1, 0], 1), (&[0, 1], 1)]);
        let b = poly(2, &[(&[1, 1], 1), (&[0, 0], -3)]);
        let f = mul(&mul(&a.pow(2).unwrap(), &b), &poly(2, &[(&[3, 2], 6)]));
        check(&f, 2 + 1 + 5);
    }

    #[test]
    fn three_vars() {
        // (x y + z^2 + 1)(x^2 - y z + 3)(x + y + z)^2 with a non-monic lead
        let f1 = poly(3, &[(&[1, 1, 0], 2), (&[0, 0, 2], 1), (&[0, 0, 0], 1)]);
        let f2 = poly(3, &[(&[2, 0, 0], 3), (&[0, 1, 1], -1), (&[0, 0, 0], 3)]);
        let f3 = poly(3, &[(&[1, 0, 0], 1), (&[0, 1, 0], 1), (&[0, 0, 1], 1)]);
        let f = mul(&mul(&f1, &f2), &f3.pow(2).unwrap());
        check(&f, 4);
    }

    #[test]
    fn swinnerton_like() {
        // (x^4 - 10 x^2 y^2 + y^4 ... ) products with leading coefficients in y
        let f1 = poly(2, &[(&[2, 1], 1), (&[0, 0], 1), (&[1, 0], 3)]);
        let f2 = poly(2, &[(&[2, 2], 2), (&[1, 1], -1), (&[0, 3], 1), (&[0, 0], 5)]);
        let f3 = poly(2, &[(&[3, 0], 1), (&[0, 2], -7), (&[1, 1], 1)]);
        check(&mul(&mul(&f1, &f2), &f3), 3);
    }
}
