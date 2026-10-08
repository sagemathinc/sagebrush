//! Multivariate factorization over GF(p), p < 2^32.
//!
//! Over a finite field the images of an irreducible polynomial at points
//! usually split (no Hilbert irreducibility), so Wang's method is preceded
//! by a bivariate stage: the factors of the univariate image are lifted
//! y-adically (the polynomial made monic as a power series) far enough to
//! recover any factor, and recombined by trying subsets.  The true
//! bivariate factors then lift to all the variables by multivariate Hensel
//! lifting (hensel.rs) with the leading coefficient imposed on every factor
//! (lc^(r-1) f: over a field this costs degree, not coefficient growth).
//!
//! Square-free parts in characteristic p: with a variable v in which f is
//! not constant-derivative, f / gcd(f, df/dv) is the product of the
//! irreducible factors separable in v of multiplicity prime to p; those are
//! factored and divided out (multiplicities by repeated division), and the
//! rest is treated again; when every derivative vanishes f is a p-th power
//! (exponents divided by p).  gcds and exact divisions are the recursive
//! dense ones (rdense.rs), which need no evaluation points.
//!
//! Fails ("not in the engine") when the field is too small for good
//! evaluation points.

use crate::hensel::{self, SP};
use crate::order::Packing;
use crate::rdense::{self, Ring};
use crate::{Coeffs, ZPoly};
use sagebrush_arith::nmod_poly as up;
use sagebrush_bigint::nmod::Modulus;
use sagebrush_bigint::BigInt;

struct Ctx<'a> {
    pk: Packing,
    md: &'a Modulus,
    rng: std::cell::Cell<u64>,
    // attempts left at the square-free factorization (small fields can
    // lack good evaluation points: give up rather than search forever)
    budget: std::cell::Cell<u32>,
}

impl Ctx<'_> {
    fn rand(&self) -> u64 {
        let mut x = self.rng.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng.set(x);
        x % self.md.n
    }

    fn ring(&self) -> Ring<'_> {
        Ring { md: self.md }
    }

    fn deg(&self, f: &SP, v: usize) -> u64 {
        hensel::deg(&self.pk, f, v)
    }

    fn uses(&self, f: &SP, v: usize) -> bool {
        f.iter().any(|&(w, _)| self.pk.exp(w, v) > 0)
    }

    fn is_const(&self, f: &SP) -> bool {
        f.iter().all(|&(w, _)| w == 0)
    }

    /// f with leading (lex) coefficient 1.
    fn monic(&self, f: &SP) -> SP {
        if f.is_empty() || f[0].1 == 1 {
            return f.clone();
        }
        let i = self.md.inv(f[0].1).unwrap();
        f.iter().map(|&(w, c)| (w, self.md.mul(c, i))).collect()
    }

    fn deriv(&self, f: &SP, v: usize) -> SP {
        let s = self.pk.shift(v);
        let t: SP = f.iter().filter_map(|&(w, c)| {
            let e = self.pk.exp(w, v);
            let c2 = self.md.mul(c, e % self.md.n);
            (e > 0 && c2 != 0).then_some((w - (1 << s), c2))
        }).collect();
        hensel::normalize(t, self.md)
    }

    fn gcd(&self, a: &SP, b: &SP) -> SP {
        let r = self.ring();
        let g = r.gcd(&rdense::from_words(&self.pk, a), &rdense::from_words(&self.pk, b));
        rdense::to_words(&self.pk, &g)
    }

    fn divexact(&self, a: &SP, b: &SP) -> Option<SP> {
        let r = self.ring();
        r.divexact(&rdense::from_words(&self.pk, a), &rdense::from_words(&self.pk, b)).map(|q| rdense::to_words(&self.pk, &q))
    }

    /// The gcd of the coefficients in v (a polynomial in the others).
    fn content_in(&self, f: &SP, v: usize) -> SP {
        let d = self.deg(f, v);
        let mut cs: Vec<SP> = (0..=d).map(|k| hensel::coeff(&self.pk, f, v, k)).filter(|c| !c.is_empty()).collect();
        cs.sort_by_key(|c| c.len());
        let mut g: SP = vec![];
        for c in cs {
            g = if g.is_empty() { self.monic(&c) } else { self.gcd(&g, &c) };
            if self.is_const(&g) {
                break;
            }
        }
        g
    }

    /// f at x_j = a_j for the given (j, a_j).
    fn eval(&self, f: &SP, at: &[(usize, u64)]) -> SP {
        let t: SP = f.iter().map(|&(w, c)| {
            let mut w2 = w;
            let mut c2 = c;
            for &(j, a) in at {
                let e = self.pk.exp(w, j);
                if e > 0 {
                    c2 = self.md.mul(c2, self.md.pow(a, e));
                    w2 &= !(self.pk.mask() << self.pk.shift(j));
                }
            }
            (w2, c2)
        }).collect();
        hensel::normalize(t, self.md)
    }

    fn univ(&self, f: &SP, v: usize) -> Vec<u64> {
        hensel::univ(&self.pk, f, v)
    }

    /// Terms of y-degree below k.
    fn trunc(&self, f: SP, y: usize, k: u64) -> SP {
        f.into_iter().filter(|&(w, _)| self.pk.exp(w, y) < k).collect()
    }
}

/// The factorization of f over GF(p): the unit (the leading coefficient)
/// and the monic (lex) irreducible factors with multiplicities.
pub fn factor_p(f: &ZPoly, p: u64) -> Result<(u64, Vec<(ZPoly, u32)>), String> {
    if p >= 1 << 32 {
        return Err("factorization over GF(p) for p >= 2^32 is not in the engine".into());
    }
    let n = f.n;
    if f.is_zero() {
        return Err("factor(0)".into());
    }
    let bits = (64 / n.max(1) as u32).min(32);
    let maxd = f.degrees().into_iter().max().unwrap_or(0);
    if crate::bits_for(maxd) + 2 > bits {
        return Err("exponents too large to pack".into());
    }
    let pk = Packing { n, bits };
    let md = Modulus::new(p);
    let cx = Ctx { pk, md: &md, rng: std::cell::Cell::new(0x9E3779B97F4A7C15 ^ p), budget: std::cell::Cell::new(40) };
    let fp = crate::gcd::reduce(&f.repack(bits), p);
    let unit = fp[0].1;
    let mut fp = cx.monic(&fp);
    let mut out: Vec<(SP, u32)> = vec![];
    // monomial content
    let mins: Vec<u64> = (0..n).map(|j| fp.iter().map(|&(w, _)| pk.exp(w, j)).min().unwrap_or(0)).collect();
    for (j, &k) in mins.iter().enumerate() {
        if k > 0 {
            let mut e = vec![0; n];
            e[j] = 1;
            out.push((vec![(pk.pack(&e), 1)], k as u32));
        }
    }
    let m = pk.pack(&mins);
    fp = fp.into_iter().map(|(w, c)| (w - m, c)).collect();
    rec(&cx, fp, 1, &mut out)?;
    // equal factors merged
    let mut merged: Vec<(SP, u32)> = vec![];
    for (h, e) in out {
        match merged.iter_mut().find(|x| x.0 == h) {
            Some(x) => x.1 += e,
            None => merged.push((h, e)),
        }
    }
    Ok((unit, merged.into_iter().map(|(h, e)| (ZPoly { n, bits, exps: h.iter().map(|x| x.0).collect(), coeffs: Coeffs::Small(h.iter().map(|x| x.1 as i64).collect()) }, e)).collect()))
}

fn rec(cx: &Ctx, f: SP, mult: u32, out: &mut Vec<(SP, u32)>) -> Result<(), String> {
    sagebrush_interrupt::check();
    if cx.is_const(&f) {
        return Ok(());
    }
    let n = cx.pk.n;
    let p = cx.md.n;
    // a p-th power: every exponent a multiple of p
    let Some(v) = (0..n).filter(|&j| !cx.deriv(&f, j).is_empty()).min_by_key(|&j| cx.deg(&f, j)) else {
        let g: SP = f.iter().map(|&(w, c)| {
            let e: Vec<u64> = cx.pk.unpack(w).into_iter().map(|x| x / p).collect();
            (cx.pk.pack(&e), c)
        }).collect();
        return rec(cx, g, mult * p as u32, out);
    };
    let dbg = std::env::var("SB_FP_DEBUG").is_ok();
    let t0 = dbg.then(std::time::Instant::now);
    let el = || t0.map_or(0.0, |t| t.elapsed().as_secs_f64());
    // the content in v
    let c = cx.content_in(&f, v);
    if dbg {
        eprintln!("factor_p: rec v {} terms {} content {} terms ({:.3}s)", v, f.len(), c.len(), el());
    }
    let mut f = f;
    if !cx.is_const(&c) {
        rec(cx, c.clone(), mult, out)?;
        f = cx.divexact(&f, &c).ok_or("content does not divide")?;
    }
    let fv = cx.deriv(&f, v);
    // a square-free image of the same degree in v: f is square-free and
    // separable in v (its discriminant is not 0), no gcd needed
    let dvf = cx.deg(&f, v);
    let lcv = hensel::coeff(&cx.pk, &f, v, dvf);
    let others: Vec<usize> = (0..n).filter(|&j| j != v && cx.uses(&f, j)).collect();
    let sqfree = (0..8).any(|_| {
        let at: Vec<(usize, u64)> = others.iter().map(|&j| (j, cx.rand())).collect();
        if cx.eval(&lcv, &at).is_empty() {
            return false;
        }
        let u = cx.univ(&cx.eval(&f, &at), v);
        u.len() as u64 == dvf + 1 && up::gcd(&u, &up::derivative(&u, cx.md), cx.md).len() == 1
    });
    // else a square-free bivariate image (in v and one other variable,
    // the rest at points): its gcd is cheap and proves the same
    let sqfree = sqfree || others.iter().any(|&y| {
        (0..4).any(|_| {
            let at: Vec<(usize, u64)> = others.iter().filter(|&&j| j != y).map(|&j| (j, cx.rand())).collect();
            let im = cx.eval(&f, &at);
            if cx.deg(&im, v) != dvf || cx.eval(&lcv, &at).is_empty() {
                return false;
            }
            let d = cx.deriv(&im, v);
            !d.is_empty() && cx.is_const(&cx.gcd(&im, &d))
        })
    });
    let g = if sqfree { vec![(0, 1)] } else { cx.gcd(&f, &fv) };
    if dbg {
        eprintln!("factor_p: gcd(f, f') {} terms ({:.3}s)", g.len(), el());
    }
    let b = cx.monic(&cx.divexact(&f, &g).ok_or("gcd does not divide")?);
    for h in factor_sqfree(cx, &b, v)? {
        if cx.is_const(&h) {
            return Err("factor: a constant factor".into());
        }
        let mut e = 0u32;
        while let Some(q) = cx.divexact(&f, &h) {
            f = q;
            e += 1;
        }
        if e == 0 {
            return Err("factor: a factor does not divide".into());
        }
        out.push((h, e * mult));
    }
    rec(cx, cx.monic(&f), mult, out)
}

const NO_POINT: &str = "factorization over this small field (no good evaluation point) is not in the engine";

/// The monic irreducible factors of b: square-free, primitive and
/// separable in v.  Over small fields good evaluation points may not
/// exist: then the other main variables in which b is separable are
/// tried, then automorphisms x_j -> x_j + c x_i^e (the factors mapped
/// back).
fn factor_sqfree(cx: &Ctx, b: &SP, v: usize) -> Result<Vec<SP>, String> {
    factor_sqfree_depth(cx, b, v, 0)
}

fn factor_sqfree_depth(cx: &Ctx, b: &SP, v: usize, depth: usize) -> Result<Vec<SP>, String> {
    match factor_sqfree_in(cx, b, v) {
        Err(e) if e == NO_POINT => {}
        r => return r,
    }
    let n = cx.pk.n;
    let used: Vec<usize> = (0..n).filter(|&j| cx.uses(b, j)).collect();
    for &w in &used {
        if w == v {
            continue;
        }
        // (separable in w: a good point implies it, none means try on)
        if cx.deriv(b, w).is_empty() {
            continue;
        }
        // primitive in w as well (else its content is a factor to split off)
        if !cx.is_const(&cx.content_in(b, w)) {
            continue;
        }
        match factor_sqfree_in(cx, b, w) {
            Err(e) if e == NO_POINT => {}
            r => return r,
        }
    }
    if depth >= 1 || used.len() < 2 {
        return Err(NO_POINT.into());
    }
    let p = cx.md.n;
    for attempt in 0..6u64 {
        let i = used[(cx.rand() as usize) % used.len()];
        let j = used[(cx.rand() as usize) % used.len()];
        if i == j {
            continue;
        }
        let e = 1 + attempt % 3;
        let c = 1 + cx.rand() % (p - 1);
        let maxd = (0..n).map(|k| cx.deg(b, k)).max().unwrap_or(0);
        if crate::bits_for(maxd * (e + 1) * 4) + 2 > cx.pk.bits {
            continue;
        }
        let sb = cx.monic(&substitute(cx, b, j, i, e, c));
        // the new polynomial: separable in some variable, primitive in it
        let Some(w) = (0..n).filter(|&k| cx.uses(&sb, k)).find(|&k| !cx.deriv(&sb, k).is_empty() && cx.is_const(&cx.content_in(&sb, k))) else { continue };
        match factor_sqfree_depth(cx, &sb, w, depth + 1) {
            Ok(fs) => {
                return Ok(fs.iter().map(|h| cx.monic(&substitute(cx, h, j, i, e, cx.md.neg(c)))).collect());
            }
            Err(e2) if e2 == NO_POINT => continue,
            Err(e2) => return Err(e2),
        }
    }
    Err(NO_POINT.into())
}

/// f with x_j replaced by x_j + c x_i^e.
fn substitute(cx: &Ctx, f: &SP, j: usize, i: usize, e: u64, c: u64) -> SP {
    let pk = &cx.pk;
    let md = cx.md;
    let mut ei = vec![0u64; pk.n];
    ei[i] = e;
    let mut ej = vec![0u64; pk.n];
    ej[j] = 1;
    let lin: SP = hensel::normalize(vec![(pk.pack(&ej), 1), (pk.pack(&ei), c)], md);
    let d = cx.deg(f, j);
    let mut pows: Vec<SP> = vec![vec![(0, 1)]];
    for k in 0..d as usize {
        let nx = hensel::mul(&pows[k], &lin, md);
        pows.push(nx);
    }
    let mut out: SP = vec![];
    for k in 0..=d {
        let ck = hensel::coeff(pk, f, j, k);
        if !ck.is_empty() {
            out = hensel::add(&out, &hensel::mul(&ck, &pows[k as usize], md), md);
        }
    }
    out
}

fn factor_sqfree_in(cx: &Ctx, b: &SP, v: usize) -> Result<Vec<SP>, String> {
    if cx.budget.get() == 0 {
        return Err(NO_POINT.into());
    }
    cx.budget.set(cx.budget.get() - 1);
    let n = cx.pk.n;
    let md = cx.md;
    let p = md.n;
    let ys: Vec<usize> = (0..n).filter(|&j| j != v && cx.uses(b, j)).collect();
    let dv = cx.deg(b, v);
    if ys.is_empty() {
        let u = cx.univ(b, v);
        let fs = sagebrush_poly::factor_mod(&u.iter().map(|&c| BigInt::from(c)).collect::<Vec<_>>(), p);
        let mut out = vec![];
        for (h, e) in fs {
            for _ in 0..e {
                out.push(hensel::from_univ(&cx.pk, &h, v));
            }
        }
        return Ok(out);
    }
    if dv == 1 {
        return Ok(vec![cx.monic(b)]);
    }
    let lc = hensel::coeff(&cx.pk, b, v, dv);
    // the bivariate variable: the one of largest degree
    let y = *ys.iter().max_by_key(|&&j| cx.deg(b, j)).unwrap();
    let rest: Vec<usize> = ys.iter().copied().filter(|&j| j != y).collect();
    for _attempt in 0..30 {
        // a point: rest at a, y at a0, with the image square-free of the
        // same degree
        let mut found = None;
        for _ in 0..(4 * p.min(64) as usize + 32) {
            let at: Vec<(usize, u64)> = rest.iter().map(|&j| (j, cx.rand())).collect();
            let a0 = cx.rand();
            let mut full = at.clone();
            full.push((y, a0));
            if cx.eval(&lc, &full).is_empty() {
                continue;
            }
            let u = cx.univ(&cx.eval(b, &full), v);
            if u.len() as u64 != dv + 1 {
                continue;
            }
            if up::gcd(&u, &up::derivative(&u, md), md).len() != 1 {
                continue;
            }
            found = Some((at, a0, u));
            break;
        }
        let Some((at, a0, u)) = found else {
            return Err(NO_POINT.into());
        };
        let s2 = cx.eval(b, &at);
        let bfs = bivariate(cx, &s2, v, y, a0, &u)?;
        if std::env::var("SB_FP_DEBUG").is_ok() {
            eprintln!("factor_p: v {} y {} at {:?} a0 {}: {} bivariate factors, b {} terms", v, y, at, a0, bfs.len(), b.len());
        }
        if bfs.len() == 1 {
            return Ok(vec![cx.monic(b)]);
        }
        if rest.is_empty() {
            return Ok(bfs);
        }
        if let Some(fs) = lift_all(cx, b, v, y, &rest, &at, a0, &bfs)? {
            return Ok(fs);
        }
    }
    Err("factorization over GF(p): no lucky evaluation (not in the engine)".into())
}

/// The irreducible factors of the bivariate s (in v and y), square-free
/// with s(v, a0) = u square-free of the same degree in v.
fn bivariate(cx: &Ctx, s: &SP, v: usize, y: usize, a0: u64, u: &[u64]) -> Result<Vec<SP>, String> {
    let pk = &cx.pk;
    let md = cx.md;
    let p = md.n;
    let f = hensel::taylor_shift(pk, s, y, a0, md);
    let dv = cx.deg(&f, v);
    let dy = cx.deg(&f, y);
    let l = hensel::coeff(pk, &f, v, dv);
    let lu = cx.univ(&l, y);
    let k = dy + (lu.len() as u64).saturating_sub(1) + 1;
    let us: Vec<Vec<u64>> = sagebrush_poly::factor_mod(&u.iter().map(|&c| BigInt::from(c)).collect::<Vec<_>>(), p)
        .into_iter().flat_map(|(h, e)| std::iter::repeat(h).take(e as usize)).collect();
    if us.len() == 1 {
        return Ok(vec![cx.monic(s)]);
    }
    let r = us.len();
    // f / l as a power series in y, to y^k
    let linv = up::inv_series(&lu, k as usize, md);
    let linv_sp = hensel::from_univ(pk, &linv, y);
    let mono = cx.trunc(hensel::mul(&f, &linv_sp, md), y, k);
    let ones: Vec<SP> = vec![vec![(0, 1)]; r];
    let lifted = hensel::lift(pk, md, &mono, v, &[y], &[k - 1], &us, &ones).ok_or("bivariate lifting failed")?;
    if std::env::var("SB_FP_DEBUG").is_ok() {
        eprintln!("factor_p: bivariate r {} k {} dv {} dy {}", r, k, dv, dy);
    }
    // recombination: the smallest subsets first
    let mut left: Vec<SP> = lifted;
    let mut rem = f.clone();
    let mut found: Vec<SP> = vec![];
    let mut size = 1;
    while 2 * size <= left.len() {
        let mut hit = false;
        let idx: Vec<usize> = (0..left.len()).collect();
        for sub in subsets(&idx, size) {
            let lr = hensel::coeff(pk, &rem, v, cx.deg(&rem, v));
            let mut cand = lr.clone();
            for &i in &sub {
                cand = cx.trunc(hensel::mul(&cand, &left[i], md), y, k);
            }
            let cnt = cx.content_in(&cand, v);
            let cand = cx.monic(&cx.divexact(&cand, &cnt).ok_or("content")?);
            if let Some(q) = cx.divexact(&rem, &cand) {
                rem = q;
                found.push(cand);
                let mut j = 0;
                left.retain(|_| {
                    let keep = !sub.contains(&j);
                    j += 1;
                    keep
                });
                hit = true;
                break;
            }
        }
        if !hit {
            size += 1;
        }
    }
    if !cx.is_const(&rem) {
        found.push(cx.monic(&rem));
    }
    // back to y
    Ok(found.into_iter().map(|h| cx.monic(&hensel::taylor_shift(pk, &h, y, md.neg(a0), md))).collect())
}

fn subsets(idx: &[usize], k: usize) -> Vec<Vec<usize>> {
    let mut out = vec![];
    let mut cur = vec![];
    fn go(idx: &[usize], k: usize, start: usize, cur: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if cur.len() == k {
            out.push(cur.clone());
            return;
        }
        for i in start..idx.len() {
            cur.push(idx[i]);
            go(idx, k, i + 1, cur, out);
            cur.pop();
        }
    }
    go(idx, k, 0, &mut cur, &mut out);
    out
}

/// From the factors of b(v, y, at) to those of b: Hensel lifting of the
/// images at y = a0 with every leading coefficient lc_v(b) (b times
/// lc^(r-1)), then primitive parts; None when they do not come out.
#[allow(clippy::too_many_arguments)]
fn lift_all(cx: &Ctx, b: &SP, v: usize, y: usize, rest: &[usize], at: &[(usize, u64)], a0: u64, bfs: &[SP]) -> Result<Option<Vec<SP>>, String> {
    let pk = &cx.pk;
    let md = cx.md;
    let r = bfs.len();
    let dv = cx.deg(b, v);
    let lc = hensel::coeff(pk, b, v, dv);
    let mut g = b.clone();
    for _ in 1..r {
        g = hensel::mul(&g, &lc, md);
    }
    let maxd = (0..pk.n).map(|j| cx.deg(&g, j)).max().unwrap_or(0);
    if crate::bits_for((r as u64 + 1) * maxd) + 1 > pk.bits {
        return Err("exponents too large to pack".into());
    }
    // the variables y, then the rest, all moved to 0
    let mut ys = vec![y];
    ys.extend_from_slice(rest);
    let mut pts = vec![(y, a0)];
    pts.extend_from_slice(at);
    let shift = |f: &SP| -> SP {
        let mut x = f.clone();
        for &(j, a) in &pts {
            x = hensel::taylor_shift(pk, &x, j, a, md);
        }
        x
    };
    let gs = shift(&g);
    let lcs = shift(&lc);
    let lc0 = cx.eval(&lcs, &ys.iter().map(|&j| (j, 0)).collect::<Vec<_>>());
    let l0 = lc0.first().map_or(0, |x| x.1);
    if l0 == 0 {
        return Ok(None);
    }
    let imgs: Vec<Vec<u64>> = bfs.iter().map(|h| {
        let u = cx.univ(&cx.eval(h, &[(y, a0)]), v);
        let s = md.mul(l0, md.inv(*u.last().unwrap()).unwrap());
        up::scale(&u, s, md)
    }).collect();
    let degs: Vec<u64> = ys.iter().map(|&j| cx.deg(&g, j)).collect();
    let lcv = vec![lcs; r];
    let Some(fs) = hensel::lift(pk, md, &gs, v, &ys, &degs, &imgs, &lcv) else {
        if std::env::var("SB_FP_DEBUG").is_ok() {
            eprintln!("factor_p: lift_all: lifting failed");
        }
        return Ok(None);
    };
    let mut out = vec![];
    let mut left = b.clone();
    for h in fs {
        let mut h = h;
        for &(j, a) in &pts {
            h = hensel::taylor_shift(pk, &h, j, md.neg(a), md);
        }
        let c = cx.content_in(&h, v);
        let h = cx.monic(&match cx.divexact(&h, &c) {
            Some(q) => q,
            None => return Ok(None),
        });
        if cx.is_const(&h) {
            return Ok(None);
        }
        match cx.divexact(&left, &h) {
            Some(q) => left = q,
            None => return Ok(None),
        }
        out.push(h);
    }
    if !cx.is_const(&left) {
        return Ok(None);
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(n: usize, t: &[(&[u64], i64)]) -> ZPoly {
        ZPoly::from_terms(n, t.iter().map(|(e, c)| (e.to_vec(), BigInt::from(*c))).collect()).unwrap()
    }

    fn check(f: &ZPoly, p: u64, want: u32) {
        let (u, fs) = factor_p(f, p).unwrap();
        let md = Modulus::new(p);
        let mut prod = poly(f.n, &[(&vec![0; f.n], u as i64)]);
        for (h, e) in &fs {
            prod = prod.mul(&h.pow(*e as u64).unwrap()).unwrap().reduce_mod(p);
        }
        let _ = md;
        assert!(prod.equals(&f.reduce_mod(p)), "product mismatch over GF({})", p);
        let total: u32 = fs.iter().map(|x| x.1).sum();
        assert_eq!(total, want, "factors over GF({}): {:?}", p, fs.iter().map(|x| (x.0.len(), x.1)).collect::<Vec<_>>());
    }

    #[test]
    fn small_fields() {
        // (x + y + 1)^2 (x y + z) (x^2 + y z + 1) over GF(2), GF(3), GF(7), GF(32003)
        let a = poly(3, &[(&[1, 0, 0], 1), (&[0, 1, 0], 1), (&[0, 0, 0], 1)]);
        let b = poly(3, &[(&[1, 1, 0], 1), (&[0, 0, 1], 1)]);
        let c = poly(3, &[(&[2, 0, 0], 1), (&[0, 1, 1], 1), (&[0, 0, 0], 1)]);
        let f = a.pow(2).unwrap().mul(&b).unwrap().mul(&c).unwrap();
        for p in [3u64, 7, 32003] {
            check(&f, p, 4);
        }
        // a p-th power and an inseparable factor over GF(3): (x^3 - y) (x + y)^3
        let g = poly(2, &[(&[3, 0], 1), (&[0, 1], -1)]).mul(&poly(2, &[(&[1, 0], 1), (&[0, 1], 1)]).pow(3).unwrap()).unwrap();
        check(&g, 3, 4);
        // bivariate with many univariate image factors: x^4 + y^4 + 1 times (x - y^2)
        let h = poly(2, &[(&[4, 0], 1), (&[0, 4], 1), (&[0, 0], 1)]).mul(&poly(2, &[(&[1, 0], 1), (&[0, 2], -1)])).unwrap();
        check(&h, 32003, 2);
    }
}
