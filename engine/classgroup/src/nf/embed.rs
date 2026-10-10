//! The embeddings of K = Q[x]/(f): the complex roots of f, isolated in
//! certified disks and refined to any precision (nf/roots.rs), the real r1
//! first, then one of each complex pair (positive imaginary part).
//! T2(x) = sum |sigma(x)|^2 over all n embeddings, and the logarithmic
//! embedding used for units.

use super::order::Order;
use super::zlin::ZMat;
use crate::real::ln_fixed;
use sagebrush_bigint::{BigInt, BigRational};
use num_traits::{One, Signed, ToPrimitive, Zero};

#[derive(Clone, Copy, Debug)]
struct C(f64, f64);

impl C {
    fn add(self, o: C) -> C {
        C(self.0 + o.0, self.1 + o.1)
    }
    fn sub(self, o: C) -> C {
        C(self.0 - o.0, self.1 - o.1)
    }
    fn mul(self, o: C) -> C {
        C(self.0 * o.0 - self.1 * o.1, self.0 * o.1 + self.1 * o.0)
    }
    fn div(self, o: C) -> C {
        let d = o.0 * o.0 + o.1 * o.1;
        C((self.0 * o.0 + self.1 * o.1) / d, (self.1 * o.0 - self.0 * o.1) / d)
    }
    fn abs(self) -> f64 {
        self.0.hypot(self.1)
    }
}

fn horner(f: &[f64], z: C) -> (C, C) {
    // f(z), f'(z)
    let mut v = C(0.0, 0.0);
    let mut d = C(0.0, 0.0);
    for &c in f.iter().rev() {
        d = d.mul(z).add(v);
        v = v.mul(z).add(C(c, 0.0));
    }
    (v, d)
}

#[derive(Clone, Debug)]
pub struct Embeddings {
    pub r1: usize,
    pub r2: usize,
    /// roots (re, im): r1 real, then r2 with im > 0
    pub roots: Vec<(f64, f64)>,
    /// sigma_j(w_i) for the r1 + r2 embeddings: conj[i][j]
    pub conj: Vec<Vec<(f64, f64)>>,
    /// the roots of f, certified (nf/roots.rs), and which of them `roots` are
    iso: super::roots::Isolated,
    order: Vec<usize>,
}

/// The roots of a monic polynomial with f64 coefficients (constant term
/// first) by Aberth's iteration.
pub fn aberth(fc: &[f64]) -> Vec<(f64, f64)> {
    let n = fc.len() - 1;
    // Cauchy bound for the initial circle
    let bound = 1.0 + fc[..n].iter().map(|c| c.abs()).fold(0.0, f64::max);
    let mut z: Vec<C> = (0..n).map(|k| {
        let t = 2.0 * std::f64::consts::PI * (k as f64 + 0.25) / n as f64;
        C(bound * 0.5 * t.cos(), bound * 0.5 * t.sin())
    }).collect();
    for _ in 0..500 {
        sagebrush_interrupt::check();
        let mut moved = 0.0f64;
        for k in 0..n {
            let (v, d) = horner(&fc, z[k]);
            if v.abs() == 0.0 {
                continue;
            }
            let ratio = v.div(d);
            let mut s = C(0.0, 0.0);
            for j in 0..n {
                if j != k {
                    s = s.add(C(1.0, 0.0).div(z[k].sub(z[j])));
                }
            }
            let w = ratio.div(C(1.0, 0.0).sub(ratio.mul(s)));
            z[k] = z[k].sub(w);
            moved = moved.max(w.abs() / (1.0 + z[k].abs()));
        }
        if moved < 1e-15 {
            break;
        }
    }
    z.into_iter().map(|c| (c.0, c.1)).collect()
}

/// p mod q over Q (q nonzero), coefficients constant first.
fn rem_q(p: &[BigRational], q: &[BigRational]) -> Vec<BigRational> {
    let mut r = p.to_vec();
    let dq = q.len() - 1;
    while r.len() > dq && !r.is_empty() {
        let c = r.last().unwrap() / q.last().unwrap();
        let shift = r.len() - 1 - dq;
        for (i, qc) in q.iter().enumerate() {
            r[shift + i] = &r[shift + i] - &c * qc;
        }
        r.pop();
        while r.last().is_some_and(|x| x.is_zero()) {
            r.pop();
        }
    }
    r
}

/// The Sturm sequence of a squarefree integer polynomial.
pub(crate) fn sturm(f: &[BigInt]) -> Vec<Vec<BigRational>> {
    let p0: Vec<BigRational> = f.iter().map(|c| BigRational::from_integer(c.clone())).collect();
    let p1: Vec<BigRational> = (1..f.len()).map(|i| BigRational::from_integer(&f[i] * BigInt::from(i as u64))).collect();
    let mut seq = vec![p0, p1];
    loop {
        let n = seq.len();
        if seq[n - 1].len() <= 1 {
            break;
        }
        let r: Vec<BigRational> = rem_q(&seq[n - 2], &seq[n - 1]).into_iter().map(|x| -x).collect();
        if r.is_empty() {
            break;
        }
        seq.push(r);
    }
    seq
}

pub(crate) fn sign_changes(seq: &[Vec<BigRational>], x: &BigRational) -> usize {
    let mut last = 0i32;
    let mut n = 0;
    for p in seq {
        let mut v = BigRational::zero();
        for c in p.iter().rev() {
            v = v * x + c;
        }
        let s = if v.is_positive() { 1 } else if v.is_negative() { -1 } else { 0 };
        if s != 0 {
            if last != 0 && s != last {
                n += 1;
            }
            last = s;
        }
    }
    n
}

impl Embeddings {
    /// The embeddings, from the roots of f isolated with certified disks
    /// (nf/roots.rs): the signature is proven (and checked against Sturm).
    pub fn new(o: &Order) -> Result<Embeddings, String> {
        let iso = super::roots::isolate(&o.f, 64)?;
        let iprec = iso.prec;
        let to_f = |x: &BigInt| -> f64 { crate::real::to_f64(x, iprec) };
        let mut real: Vec<usize> = (0..o.n).filter(|&i| iso.roots[i].real).collect();
        let mut cplx: Vec<usize> = (0..o.n).filter(|&i| !iso.roots[i].real && iso.roots[i].im.is_positive()).collect();
        real.sort_by(|&a, &b| iso.roots[a].re.cmp(&iso.roots[b].re));
        cplx.sort_by(|&a, &b| iso.roots[a].re.cmp(&iso.roots[b].re).then(iso.roots[a].im.cmp(&iso.roots[b].im)));
        let (r1, r2) = (real.len(), cplx.len());
        if r1 + 2 * r2 != o.n {
            return Err(format!("the roots of the defining polynomial: {} real and {} complex pairs, degree {}", r1, r2, o.n));
        }
        let order: Vec<usize> = real.into_iter().chain(cplx).collect();
        let roots: Vec<(f64, f64)> = order.iter().map(|&i| (to_f(&iso.roots[i].re), to_f(&iso.roots[i].im))).collect();
        // sigma_j(w_i) = sum_k b_ik t_j^k / den, in fixed point from roots
        // refined to enough bits: the b_ik can be huge and cancel (f64
        // alone gave a singular T2 form for x^3 - 1386489987 x - ...)
        let mut emb = Embeddings { r1, r2, roots, conj: vec![], iso, order };
        let cbits = o.basis.iter().flatten().map(|c| c.bits()).max().unwrap_or(1) as u32;
        let rbits = emb.roots.iter().map(|r| r.0.abs().max(r.1.abs()).max(1.0).log2().ceil() as u32).max().unwrap_or(1);
        let prec = 96 + cbits + (o.n as u32) * rbits;
        let hp = emb.roots_hp(&o.f, prec)?;
        let p = prec as usize;
        let to_f = |x: &BigInt| -> f64 { crate::real::to_f64(x, prec) };
        let den = o.den.to_f64().unwrap();
        emb.conj = (0..o.n).map(|i| {
            hp.iter().map(|(zr, zi)| {
                let (mut vr, mut vi) = (BigInt::zero(), BigInt::zero());
                for c in o.basis[i].iter().rev() {
                    let (nr, ni) = (((&vr * zr - &vi * zi) >> p) + (c << p), (&vr * zi + &vi * zr) >> p);
                    vr = nr;
                    vi = ni;
                }
                (to_f(&vr) / den, to_f(&vi) / den)
            }).collect()
        }).collect();
        Ok(emb)
    }

    /// sigma_j(x) for x in order coordinates (f64).
    pub fn sigma(&self, x: &[BigInt]) -> Vec<(f64, f64)> {
        let m = self.r1 + self.r2;
        let mut out = vec![(0.0, 0.0); m];
        for (xi, row) in x.iter().zip(&self.conj) {
            let c = xi.to_f64().unwrap();
            if c == 0.0 {
                continue;
            }
            for (o, s) in out.iter_mut().zip(row) {
                o.0 += c * s.0;
                o.1 += c * s.1;
            }
        }
        out
    }

    /// The T2 Gram matrix of vectors given in order coordinates.
    pub fn t2_gram(&self, vs: &[Vec<BigInt>]) -> Vec<Vec<f64>> {
        self.gram(vs, &[])
    }

    /// The Gram matrix of sum_j w_j |sigma_j(x)|^2 (complex j counted
    /// twice), w_j = exp(2 s_j) for the log-weights s (empty: T2).
    pub fn gram(&self, vs: &[Vec<BigInt>], s_log: &[f64]) -> Vec<Vec<f64>> {
        let s: Vec<Vec<(f64, f64)>> = vs.iter().map(|v| self.sigma(v)).collect();
        let k = vs.len();
        (0..k).map(|a| (0..k).map(|b| {
            let mut t = 0.0;
            for (j, (x, y)) in s[a].iter().zip(&s[b]).enumerate() {
                let w = if j < self.r1 { 1.0 } else { 2.0 } * s_log.get(j).map_or(1.0, |l| (2.0 * l).exp());
                t += w * (x.0 * y.0 + x.1 * y.1);
            }
            t
        }).collect()).collect()
    }

    /// The roots to `prec` bits (fixed point re, im), in the order of
    /// `roots`: refined within their certified disks (nf/roots.rs).
    pub fn roots_hp(&self, f: &[BigInt], prec: u32) -> Result<Vec<(BigInt, BigInt)>, String> {
        let iso = super::roots::refine(f, &self.iso, prec)?;
        let c = iso.centers(prec);
        Ok(self.order.iter().map(|&i| c[i].clone()).collect())
    }

    /// roots_hp, with for each root a bound (units of 2^-prec) on its
    /// distance from the center: the certified radius plus the truncation.
    pub fn roots_hp_rad(&self, f: &[BigInt], prec: u32) -> Result<(Vec<(BigInt, BigInt)>, Vec<sagebrush_ball::Mag>), String> {
        let iso = super::roots::refine(f, &self.iso, prec)?;
        let c = iso.centers(prec);
        let sh = (iso.prec - prec.min(iso.prec)) as usize;
        // the radius shifted down (+1), each coordinate of the center
        // truncated (< 1 each, so < 2 together)
        let rad = |i: usize| sagebrush_ball::Mag::from_bigint_up(&(&iso.roots[i].rad >> sh), 0).add(sagebrush_ball::Mag::from_u64(3));
        Ok((self.order.iter().map(|&i| c[i].clone()).collect(), self.order.iter().map(|&i| rad(i)).collect()))
    }

    /// log_embedding with a certified bound on the error of every
    /// coordinate (units of 2^-prec): v = sum c_k t^k / den is evaluated on
    /// a complex ball for each root t (its center and certified radius rho,
    /// units of 2^-prec, as roots_hp_rad gives them), log |v|^2 on balls
    /// (sagebrush-ball), then rounded to fixed point: the error is the
    /// ball's radius plus the rounding.  None if |v| is not certainly
    /// nonzero (more precision may help).  (Before: an error analysis in
    /// doubles with margins, trusting ln_fixed's accuracy: R2-CLG-F2.)
    pub fn log_embedding_err(&self, o: &Order, x: &[BigInt], roots: &[(BigInt, BigInt)], rho: &[sagebrush_ball::Mag], prec: u32) -> Option<(Vec<BigInt>, sagebrush_ball::Mag)> {
        use sagebrush_ball::{Ball, CBall, Mag};
        let num = super::zlin::vec_mat(x, &o.basis);
        let cbits = num.iter().map(|c| c.bits()).max().unwrap_or(1);
        let wp = prec as u64 + 2 * cbits + 64 * (num.len() as u64 + 2);
        let lden2 = Ball::from_int(&o.den).log(wp)?.mul_2exp(1);
        let mut out = Vec::with_capacity(roots.len());
        let mut worst = Mag::ZERO;
        let p = prec as i64;
        for (j, ((zr, zi), &rho)) in roots.iter().zip(rho).enumerate() {
            let r = rho.mul_2exp(-p);
            let t = CBall::new(Ball::with_radius(zr.clone(), -p, r), Ball::with_radius(zi.clone(), -p, r));
            let mut acc = CBall::zero();
            for c in num.iter().rev() {
                acc = acc.mul(&t, wp).add(&CBall::real(Ball::from_int(c)), wp);
            }
            let a2 = acc.re.sqr(wp).add(&acc.im.sqr(wp), wp);
            let mut l = a2.log(wp)?.sub(&lden2, wp);
            if j < self.r1 {
                l = l.mul_2exp(-1);
            }
            let (m, err) = l.to_fixed(p)?;
            out.push(m);
            worst = worst.max(err);
        }
        Some((out, worst))
    }

    /// The logarithmic embedding of x (order coordinates) to `prec` bits:
    /// log |sigma_j(x)| for real j, 2 log |sigma_j(x)| for complex j
    /// (fixed point), from the roots at that precision.
    pub fn log_embedding(&self, o: &Order, x: &[BigInt], roots: &[(BigInt, BigInt)], prec: u32) -> Vec<BigInt> {
        let p = prec as usize;
        // x in the power basis: sum_k c_k t^k / den
        let num = super::zlin::vec_mat(x, &o.basis);
        roots.iter().enumerate().map(|(j, (zr, zi))| {
            let (mut vr, mut vi) = (BigInt::zero(), BigInt::zero());
            for c in num.iter().rev() {
                let (nvr, nvi) = (((&vr * zr - &vi * zi) >> p) + (c << p), (&vr * zi + &vi * zr) >> p);
                vr = nvr;
                vi = nvi;
            }
            // |v|^2 / den^2
            let abs2 = (&vr * &vr + &vi * &vi) >> p;
            let den2 = &o.den * &o.den;
            let abs2 = abs2 / den2;
            // log |v| = log(|v|^2)/2; complex embeddings count twice
            let l = ln_fixed(&abs2.abs().max(BigInt::from(1)), prec);
            if j < self.r1 { l >> 1usize } else { l }
        }).collect()
    }
}

/// The same order with a basis LLL-reduced for T2: the embeddings of the
/// basis in fixed point (roots refined far enough for the size of the
/// numerators), exact integer LLL with the identity appended to record the
/// transformation.  Round 2 on a polynomial with large coefficients gives a
/// basis of huge numerators over a huge denominator, in which even 1 has
/// coordinates near 10^10: every f64 computation with order coordinates
/// (T2 forms, embeddings of elements) then cancels catastrophically.
pub fn reduce_order(o: &Order) -> Result<Order, String> {
    let n = o.n;
    if n == 1 {
        return Ok(o.clone());
    }
    let emb = Embeddings::new(o)?;
    let cbits = o.basis.iter().flatten().map(|c| c.bits()).max().unwrap_or(1) as u32;
    let rbits = emb.roots.iter().map(|r| r.0.abs().max(r.1.abs()).max(1.0).log2().ceil() as u32).max().unwrap_or(1);
    // The embeddings of the basis are up to about 2^(cbits + n rbits); the
    // short vectors are combinations cancelling all but O(1) of that, so
    // the lattice keeps 80 bits below 1 beyond that size (with 80 bits only,
    // a power basis of a generator near 5 10^7 needed two passes, and the
    // roots of unity were then counted in a badly scaled basis).
    let size = cbits + (n as u32) * rbits;
    let prec = 160 + 2 * size;
    let p = prec as usize;
    let hp = emb.roots_hp(&o.f, prec)?;
    // sigma_j(w_i) den 2^p; complex embeddings as sqrt(2) (re, im)
    let s2 = BigInt::from(1518500249u64); // round(sqrt(2) 2^30)
    // keep 80 + size bits below 1 (sigma(1) den 2^p)
    let shift = (p + o.den.bits() as usize).saturating_sub(80 + size as usize);
    let rows: ZMat = (0..n).map(|i| {
        let mut row = vec![];
        for (j, (zr, zi)) in hp.iter().enumerate() {
            let (mut vr, mut vi) = (BigInt::zero(), BigInt::zero());
            for c in o.basis[i].iter().rev() {
                let (nr, ni) = (((&vr * zr - &vi * zi) >> p) + (c << p), (&vr * zi + &vi * zr) >> p);
                vr = nr;
                vi = ni;
            }
            if j < emb.r1 {
                row.push(vr >> shift);
            } else {
                row.push((vr * &s2) >> (shift + 30));
                row.push((vi * &s2) >> (shift + 30));
            }
        }
        row.extend((0..n).map(|k| BigInt::from((k == i) as i32)));
        row
    }).collect();
    let red = crate::api::lll(&rows);
    let u: ZMat = red.iter().map(|r| r[n..].to_vec()).collect();
    if u.len() != n || !crate::linalg::det(&u).abs().is_one() {
        return Ok(o.clone());
    }
    let basis: ZMat = u.iter().map(|ur| (0..n).map(|k| (0..n).map(|i| &ur[i] * &o.basis[i][k]).sum()).collect()).collect();
    Ok(Order::new(&o.f, basis, o.den.clone()))
}

/// LLL reduction (delta = 0.99) of a basis (order coordinates) for the
/// Gram form computed by `gram` (floating point Gram-Schmidt, exact integer
/// transformations).
pub fn lll(basis: &[Vec<BigInt>], emb: &Embeddings) -> Vec<Vec<BigInt>> {
    lll_weighted(basis, emb, &[])
}

/// lll for the weighted form of Embeddings::gram: LLL (delta 0.99, size
/// reduction only for |mu| > 0.51, so that mu near 1/2 cannot oscillate) on
/// the real vectors (sqrt(w_j) Re, Im sigma_j(x)), exact integer
/// transformations of the basis.
pub fn lll_weighted(basis: &[Vec<BigInt>], emb: &Embeddings, s_log: &[f64]) -> Vec<Vec<BigInt>> {
    let mut b: Vec<Vec<BigInt>> = basis.to_vec();
    let k = b.len();
    if k < 2 {
        return b;
    }
    let vec_of = |x: &[BigInt]| -> Vec<f64> {
        let sg = emb.sigma(x);
        let mut out = vec![];
        for (j, (re, im)) in sg.iter().enumerate() {
            let w = if j < emb.r1 { 1.0 } else { 2.0 } * s_log.get(j).map_or(1.0, |l| (2.0 * l).exp());
            let sw = w.sqrt();
            out.push(sw * re);
            if j >= emb.r1 {
                out.push(sw * im);
            }
        }
        out
    };
    let dot = |a: &[f64], c: &[f64]| -> f64 { a.iter().zip(c).map(|(x, y)| x * y).sum() };
    let mut v: Vec<Vec<f64>> = b.iter().map(|x| vec_of(x)).collect();
    // Gram-Schmidt data: mu[i][j] (j < i), bb[i] = |b_i*|^2
    let mut mu = vec![vec![0.0f64; k]; k];
    let mut bb = vec![0.0f64; k];
    let gs = |i: usize, v: &Vec<Vec<f64>>, mu: &mut Vec<Vec<f64>>, bb: &mut Vec<f64>| {
        for j in 0..i {
            let mut t = dot(&v[i], &v[j]);
            for l in 0..j {
                t -= mu[j][l] * mu[i][l] * bb[l];
            }
            mu[i][j] = if bb[j] > 0.0 { t / bb[j] } else { 0.0 };
        }
        let mut t = dot(&v[i], &v[i]);
        for l in 0..i {
            t -= mu[i][l] * mu[i][l] * bb[l];
        }
        bb[i] = t.max(0.0);
    };
    gs(0, &v, &mut mu, &mut bb);
    let mut i = 1;
    let mut iters = 0;
    while i < k && iters < 20_000 {
        sagebrush_interrupt::check();
        iters += 1;
        gs(i, &v, &mut mu, &mut bb);
        // size reduction of b_i
        let mut changed = false;
        for j in (0..i).rev() {
            if mu[i][j].abs() > 0.51 {
                let q = mu[i][j].round();
                let qb = BigInt::from(q as i64);
                let bj = b[j].clone();
                for (x, y) in b[i].iter_mut().zip(&bj) {
                    *x -= &qb * y;
                }
                for l in 0..j {
                    mu[i][l] -= q * mu[j][l];
                }
                mu[i][j] -= q;
                changed = true;
            }
        }
        if changed {
            v[i] = vec_of(&b[i]);
            gs(i, &v, &mut mu, &mut bb);
        }
        if bb[i] < (0.99 - mu[i][i - 1] * mu[i][i - 1]) * bb[i - 1] {
            b.swap(i, i - 1);
            v.swap(i, i - 1);
            gs(i - 1, &v, &mut mu, &mut bb);
            i = (i - 1).max(1);
        } else {
            i += 1;
        }
    }
    if std::env::var("QCL_LLLITER").is_ok() && iters > 1000 {
        eprintln!("      lll: {} iterations (k = {})", iters, k);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nf::order::maximal_order;

    #[test]
    fn t2_of_one_is_n() {
        for f in [vec![-2i64, 0, 0, 1], vec![-47400624380034, -1386489987, 0, 1], vec![5, 1, -3, 1]] {
            let f: Vec<BigInt> = f.iter().map(|&c| BigInt::from(c)).collect();
            let (o, _) = maximal_order(&f).unwrap();
            let o = reduce_order(&o).unwrap();
            let e = Embeddings::new(&o).unwrap();
            let one = o.from_power(&[1i64, 0, 0].map(|c| sagebrush_bigint::BigRational::from_integer(c.into()))).into_iter().map(|c| c.to_integer()).collect::<Vec<_>>();
            let g = e.t2_gram(&[one.clone()]);
            assert!((g[0][0] - 3.0).abs() < 1e-9, "{:?}: T2(1) = {}", f, g[0][0]);
        }
    }

    #[test]
    fn nearly_coincident_real_roots() {
        // x^3 - 27 c4 x - 54 c6 for the elliptic curve 9709b3: roots near
        // +-6e4, two of them 0.004 apart (f64's Aberth saw a complex pair)
        let f: Vec<BigInt> = ["-100192487473584", "-4076849664", "0", "1"].iter().map(|c| c.parse().unwrap()).collect();
        let (o, _) = maximal_order(&f).unwrap();
        let e = Embeddings::new(&o).unwrap();
        assert_eq!((e.r1, e.r2), (3, 0));
        let r: Vec<f64> = e.roots.iter().map(|z| z.0).collect();
        assert!(r[1] - r[0] > 1e-3 || r[2] - r[1] > 1e-3);
    }

    #[test]
    fn roots_and_logs() {
        // x^3 - 2: one real root 2^(1/3), one complex pair
        let f: Vec<BigInt> = [-2, 0, 0, 1].iter().map(|&c| BigInt::from(c)).collect();
        let (o, _) = maximal_order(&f).unwrap();
        let e = Embeddings::new(&o).unwrap();
        assert_eq!((e.r1, e.r2), (1, 1));
        assert!((e.roots[0].0 - 2f64.powf(1.0 / 3.0)).abs() < 1e-14);
        let prec = 200;
        let hp = e.roots_hp(&o.f, prec).unwrap();
        // the real root cubed is 2 to the precision
        let r = &hp[0].0;
        let cube = ((r * r) >> prec as usize) * r >> prec as usize;
        assert!((cube - (BigInt::from(2) << prec as usize)).abs() < BigInt::from(1u64 << 20));
        // log embedding of the unit t - 1 (norm 1): sums to 0
        let x: Vec<BigInt> = o.from_power(&[(-1).into(), 1.into(), 0.into()].map(|c: i64| sagebrush_bigint::BigRational::from_integer(c.into()))).into_iter().map(|c| c.to_integer()).collect();
        let l = e.log_embedding(&o, &x, &hp, prec);
        let s: BigInt = l.iter().sum();
        assert!(s.abs() < BigInt::from(1u64 << 20), "{}", s);
        // LLL of a skewed basis of O
        let skew: Vec<Vec<BigInt>> = vec![vec![1.into(), 0.into(), 0.into()], vec![37.into(), 1.into(), 0.into()], vec![1000.into(), 5.into(), 1.into()]];
        let red = lll(&skew, &e);
        let g = e.t2_gram(&red);
        assert!(g[0][0] <= 3.0 + 1e-9 && g[1][1] < 10.0, "{:?}", g);
    }
}
