//! Multivariate Hensel lifting modulo a word-size prime, for Wang's EEZ
//! factorization (factor.rs).  The factors of G = prod f_i, with their
//! leading coefficients known, are lifted from univariate images one
//! variable y at a time: the coefficients of y^k of the factors come from
//! a multivariate diophantine equation, the error coefficient from prefix
//! products kept split by the degree in y (so each variable costs a few
//! products, not one per degree).  With a prime near 2^62 the factors are
//! recovered by symmetric residues when their coefficients are smaller;
//! the caller checks them over Z and falls back to p-adic lifting.

use crate::order::Packing;
use sagebrush_arith::nmod_poly as up;
use sagebrush_bigint::nmod::Modulus;

/// A polynomial over GF(p): (word, coefficient), decreasing words.
pub(crate) type SP = Vec<(u64, u64)>;

pub(crate) fn add(a: &SP, b: &SP, md: &Modulus) -> SP {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].0 > b[j].0 {
            out.push(a[i]);
            i += 1;
        } else if a[i].0 < b[j].0 {
            out.push(b[j]);
            j += 1;
        } else {
            let c = md.add(a[i].1, b[j].1);
            if c != 0 {
                out.push((a[i].0, c));
            }
            i += 1;
            j += 1;
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

pub(crate) fn neg(a: &SP, md: &Modulus) -> SP {
    a.iter().map(|&(w, c)| (w, md.neg(c))).collect()
}

pub(crate) fn sub(a: &SP, b: &SP, md: &Modulus) -> SP {
    add(a, &neg(b, md), md)
}

/// Sorts (decreasing) and merges equal words.
fn normalize(mut v: SP, md: &Modulus) -> SP {
    v.sort_unstable_by(|x, y| y.0.cmp(&x.0));
    let mut out: SP = Vec::with_capacity(v.len());
    for (w, c) in v {
        match out.last_mut() {
            Some(l) if l.0 == w => l.1 = md.add(l.1, c),
            _ => {
                if out.last().is_some_and(|l| l.1 == 0) {
                    out.pop();
                }
                out.push((w, c));
            }
        }
    }
    if out.last().is_some_and(|l| l.1 == 0) {
        out.pop();
    }
    out
}

/// a * b (exponents must fit the packing).
pub(crate) fn mul(a: &SP, b: &SP, md: &Modulus) -> SP {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let (a, b) = if a.len() < b.len() { (a, b) } else { (b, a) };
    // in pieces of bounded size
    const CHUNK: usize = 1 << 20;
    if a.len() * b.len() > CHUNK && a.len() > 1 {
        let h = a.len() / 2;
        return add(&mul(&a[..h].to_vec(), b, md), &mul(&a[h..].to_vec(), b, md), md);
    }
    if a.len() * b.len() <= 64 {
        let mut v: SP = Vec::with_capacity(a.len() * b.len());
        for &(wa, ca) in a {
            for &(wb, cb) in b {
                v.push((wa + wb, md.mul(ca, cb)));
            }
        }
        return normalize(v, md);
    }
    // accumulate in an open-addressing table (sums of products as u128,
    // reduced every 15 additions... simpler: reduced on each add)
    let cap = (a.len() * b.len()).min(a.len() + b.len() << 6).next_power_of_two() * 2;
    let mut keys: Vec<u64> = vec![u64::MAX; cap];
    let mut vals: Vec<u64> = vec![0; cap];
    let mut used = 0usize;
    let mut mask = cap - 1;
    for &(wa, ca) in a {
        for &(wb, cb) in b {
            let w = wa + wb;
            let c = md.mul(ca, cb);
            let mut h = (w.wrapping_mul(0x9E3779B97F4A7C15) >> 20) as usize & mask;
            loop {
                if keys[h] == w {
                    vals[h] = md.add(vals[h], c);
                    break;
                }
                if keys[h] == u64::MAX {
                    keys[h] = w;
                    vals[h] = c;
                    used += 1;
                    break;
                }
                h = (h + 1) & mask;
            }
            if used * 2 > keys.len() {
                // grow
                let old: Vec<(u64, u64)> = keys.iter().zip(&vals).filter(|x| *x.0 != u64::MAX).map(|(&k, &v)| (k, v)).collect();
                let cap = keys.len() * 2;
                keys = vec![u64::MAX; cap];
                vals = vec![0; cap];
                mask = cap - 1;
                for (k, v) in old {
                    let mut h = (k.wrapping_mul(0x9E3779B97F4A7C15) >> 20) as usize & mask;
                    while keys[h] != u64::MAX {
                        h = (h + 1) & mask;
                    }
                    keys[h] = k;
                    vals[h] = v;
                }
            }
        }
    }
    let mut out: SP = keys.into_iter().zip(vals).filter(|&(k, v)| k != u64::MAX && v != 0).collect();
    out.sort_unstable_by(|x, y| y.0.cmp(&x.0));
    out
}

/// The coefficient of y^k (the field of y cleared).
pub(crate) fn coeff(pk: &Packing, f: &SP, y: usize, k: u64) -> SP {
    let s = pk.shift(y);
    let m = pk.mask() << s;
    f.iter().filter(|&&(w, _)| (w >> s) & pk.mask() == k).map(|&(w, c)| (w & !m, c)).collect()
}

/// The coefficients of y^0..y^d.
fn split_y(pk: &Packing, f: &SP, y: usize, d: u64) -> Vec<SP> {
    let s = pk.shift(y);
    let m = pk.mask() << s;
    let mut out: Vec<SP> = vec![vec![]; d as usize + 1];
    for &(w, c) in f {
        let k = (w >> s) & pk.mask();
        if k <= d {
            out[k as usize].push((w & !m, c));
        }
    }
    out
}

fn join_y(pk: &Packing, parts: &[SP], y: usize, md: &Modulus) -> SP {
    let s = pk.shift(y);
    let mut v: SP = vec![];
    for (k, p) in parts.iter().enumerate() {
        v.extend(p.iter().map(|&(w, c)| (w | (k as u64) << s, c)));
    }
    normalize(v, md)
}

fn deg(pk: &Packing, f: &SP, y: usize) -> u64 {
    f.iter().map(|&(w, _)| pk.exp(w, y)).max().unwrap_or(0)
}

/// f, univariate in v, as a dense vector.
fn univ(pk: &Packing, f: &SP, v: usize) -> Vec<u64> {
    let mut out = vec![0u64; deg(pk, f, v) as usize + 1];
    for &(w, c) in f {
        out[pk.exp(w, v) as usize] = c;
    }
    up::trim(out)
}

pub(crate) fn from_univ(pk: &Packing, u: &[u64], v: usize) -> SP {
    let s = pk.shift(v);
    u.iter().enumerate().rev().filter(|(_, &c)| c != 0).map(|(k, &c)| ((k as u64) << s, c)).collect()
}

/// f(y + a).
pub(crate) fn taylor_shift(pk: &Packing, f: &SP, y: usize, a: u64, md: &Modulus) -> SP {
    if a == 0 {
        return f.clone();
    }
    let s = pk.shift(y);
    let m = pk.mask() << s;
    let mut groups: std::collections::BTreeMap<u64, Vec<u64>> = Default::default();
    for &(w, c) in f {
        let k = ((w >> s) & pk.mask()) as usize;
        let v = groups.entry(w & !m).or_default();
        if v.len() <= k {
            v.resize(k + 1, 0);
        }
        v[k] = c;
    }
    let mut out: SP = vec![];
    for (w, mut c) in groups {
        let d = c.len();
        for i in 0..d {
            for j in (i..d - 1).rev() {
                c[j] = md.add(c[j], md.mul(a, c[j + 1]));
            }
        }
        out.extend(c.iter().enumerate().filter(|(_, &x)| x != 0).map(|(k, &x)| (w | (k as u64) << s, x)));
    }
    normalize(out, md)
}

/// Replaces the leading coefficient in v (degree dv) by l.
fn set_lc(pk: &Packing, f: &SP, v: usize, l: &SP, md: &Modulus) -> SP {
    let dv = deg(pk, f, v);
    let s = pk.shift(v);
    let rest: SP = f.iter().filter(|&&(w, _)| pk.exp(w, v) != dv).copied().collect();
    let top: SP = l.iter().map(|&(w, c)| (w | dv << s, c)).collect();
    add(&rest, &normalize(top, md), md)
}

/// One level of the multivariate diophantine solver: the variable y, its
/// degree bound, and b_i = prod_{l != i} f_l split by the degree in y.
struct Level {
    y: usize,
    d: u64,
    b: Vec<Vec<SP>>,
}

struct Solver<'a> {
    pk: Packing,
    md: &'a Modulus,
    v: usize,
    levels: Vec<Level>,
    // the univariate base: s_i with sum s_i prod_{l != i} umon_l = 1
    s: Vec<Vec<u64>>,
    umon: Vec<Vec<u64>>,
    laminv: Vec<u64>,
}

impl Solver<'_> {
    /// sigma_i, deg_v sigma_i < deg_v f_i, with sum sigma_i b_i = c
    /// (modulo y_u^(d_u + 1) at each level u).
    fn solve(&self, u: usize, c: &SP) -> Vec<SP> {
        let r = self.s.len();
        if u == 0 {
            let cu = univ(&self.pk, c, self.v);
            return (0..r).map(|i| {
                let t = up::rem(&up::mul(&cu, &self.s[i], self.md), &self.umon[i], self.md);
                from_univ(&self.pk, &up::scale(&t, self.laminv[i], self.md), self.v)
            }).collect();
        }
        let lv = &self.levels[u - 1];
        let cs = split_y(&self.pk, c, lv.y, lv.d);
        let mut sig: Vec<Vec<SP>> = vec![vec![vec![]; lv.d as usize + 1]; r];
        for k in 0..=lv.d as usize {
            let mut e = cs[k].clone();
            for i in 0..r {
                for j in 0..k {
                    if !sig[i][j].is_empty() && !lv.b[i][k - j].is_empty() {
                        e = sub(&e, &mul(&sig[i][j], &lv.b[i][k - j], self.md), self.md);
                    }
                }
            }
            if e.is_empty() {
                continue;
            }
            let ds = self.solve(u - 1, &e);
            for i in 0..r {
                sig[i][k] = ds[i].clone();
            }
        }
        sig.iter().map(|parts| join_y(&self.pk, parts, lv.y, self.md)).collect()
    }
}

/// prod_{l != i} f_l for every i (prefix and suffix products), each
/// truncated to degree d in y.
fn products_except(pk: &Packing, fs: &[SP], y: usize, d: u64, md: &Modulus) -> Vec<SP> {
    let r = fs.len();
    let trunc = |f: SP| -> SP { f.into_iter().filter(|&(w, _)| pk.exp(w, y) <= d).collect() };
    let one: SP = vec![(0, 1)];
    let mut pre = vec![one.clone()];
    for f in &fs[..r - 1] {
        let p = trunc(mul(pre.last().unwrap(), f, md));
        pre.push(p);
    }
    let mut out = vec![vec![]; r];
    let mut suf = one;
    for i in (0..r).rev() {
        out[i] = trunc(mul(&pre[i], &suf, md));
        suf = trunc(mul(&suf, &fs[i], md));
    }
    out
}

/// Lifts the univariate images (dense in v, with the right leading
/// coefficients) to the factors of g (the evaluation point moved to 0),
/// the variables ys in turn; lcs are the factors' leading coefficients in
/// v, degs the degrees of g in the ys.  None when the images do not lift.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lift(pk: &Packing, md: &Modulus, g: &SP, v: usize, ys: &[usize], degs: &[u64], imgs: &[Vec<u64>], lcs: &[SP]) -> Option<Vec<SP>> {
    let r = imgs.len();
    let umon: Vec<Vec<u64>> = imgs.iter().map(|u| up::monic(u, md)).collect();
    let mut s = vec![];
    let mut laminv = vec![];
    for i in 0..r {
        let mut b = vec![1u64];
        let mut lam = 1u64;
        for l in 0..r {
            if l != i {
                b = up::mul(&b, &umon[l], md);
                lam = md.mul(lam, *imgs[l].last()?);
            }
        }
        let (gg, si, _) = up::xgcd(&b, &umon[i], md);
        if gg.len() != 1 {
            return None;
        }
        let gi = md.inv(gg[0])?;
        s.push(up::rem(&up::scale(&si, gi, md), &umon[i], md));
        laminv.push(md.inv(lam)?);
    }
    let mut fs: Vec<SP> = imgs.iter().map(|u| from_univ(pk, u, v)).collect();
    for (t, &y) in ys.iter().enumerate() {
        sagebrush_interrupt::check();
        let mut gt = g.clone();
        for &z in &ys[t + 1..] {
            gt = coeff(pk, &gt, z, 0);
        }
        let d = degs[t];
        for i in 0..r {
            let mut l = lcs[i].clone();
            for &z in &ys[t + 1..] {
                l = coeff(pk, &l, z, 0);
            }
            fs[i] = set_lc(pk, &fs[i], v, &l, md);
        }
        // the diophantine levels from the factors at y = 0
        let mut cur: Vec<SP> = fs.iter().map(|f| coeff(pk, f, y, 0)).collect();
        let mut levels = vec![];
        for u in (0..t).rev() {
            let z = ys[u];
            let bs = products_except(pk, &cur, z, degs[u], md);
            levels.push(Level { y: z, d: degs[u], b: bs.iter().map(|b| split_y(pk, b, z, degs[u])).collect() });
            cur = cur.iter().map(|f| coeff(pk, f, z, 0)).collect();
        }
        levels.reverse();
        let solver = Solver { pk: *pk, md, v, levels, s: s.clone(), umon: umon.clone(), laminv: laminv.clone() };
        // lift in y, degree by degree
        let gk = split_y(pk, &gt, y, d);
        let mut f: Vec<Vec<SP>> = fs.iter().map(|x| split_y(pk, x, y, d)).collect();
        let du = d as usize;
        // pre[l][k]: the coefficient of y^k of f_0 ... f_l
        let mut pre: Vec<Vec<SP>> = vec![vec![vec![]; du + 1]; r];
        let pre_at = |pre: &mut Vec<Vec<SP>>, f: &Vec<Vec<SP>>, k: usize| {
            pre[0][k] = f[0][k].clone();
            for l in 1..r {
                let mut acc: SP = vec![];
                for j in 0..=k {
                    if !pre[l - 1][j].is_empty() && !f[l][k - j].is_empty() {
                        acc = add(&acc, &mul(&pre[l - 1][j], &f[l][k - j], md), md);
                    }
                }
                pre[l][k] = acc;
            }
        };
        pre_at(&mut pre, &f, 0);
        if pre[r - 1][0] != gk[0] {
            return None;
        }
        for k in 1..=du {
            pre_at(&mut pre, &f, k);
            let e = sub(&gk[k], &pre[r - 1][k], md);
            if e.is_empty() {
                continue;
            }
            let ds = solver.solve(t, &e);
            // the change of the prefix products: d_l = d_(l-1) f_l(0) + pre_(l-1)(0) ds_l
            let mut dl: SP = ds[0].clone();
            pre[0][k] = add(&pre[0][k], &dl, md);
            for l in 1..r {
                dl = add(&mul(&dl, &f[l][0], md), &mul(&pre[l - 1][0], &ds[l], md), md);
                pre[l][k] = add(&pre[l][k], &dl, md);
            }
            for i in 0..r {
                f[i][k] = add(&f[i][k], &ds[i], md);
            }
            if pre[r - 1][k] != gk[k] {
                return None;
            }
        }
        fs = f.iter().map(|parts| join_y(pk, parts, y, md)).collect();
    }
    Some(fs)
}
