//! The embeddings of K = Q[x]/(f): the complex roots of f (Aberth's method
//! in f64, refined by Newton's method in fixed point to any precision), the
//! real r1 first, then one of each complex pair (positive imaginary part).
//! T2(x) = sum |sigma(x)|^2 over all n embeddings, and the logarithmic
//! embedding used for units.

use super::order::Order;
use crate::real::ln_fixed;
use num_bigint::BigInt;
use num_traits::{Signed, ToPrimitive, Zero};

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
}

/// The roots of f (monic, integer) in f64 by Aberth's iteration.
fn roots_f64(f: &[BigInt]) -> Vec<(f64, f64)> {
    let fc: Vec<f64> = f.iter().map(|c| c.to_f64().unwrap()).collect();
    aberth(&fc)
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

impl Embeddings {
    pub fn new(o: &Order) -> Embeddings {
        let roots = roots_f64(&o.f);
        // real roots: |im| tiny relative to the size
        let scale = roots.iter().map(|r| r.0.hypot(r.1)).fold(1.0, f64::max);
        let mut real: Vec<(f64, f64)> = roots.iter().filter(|r| r.1.abs() <= 1e-9 * scale).map(|r| (r.0, 0.0)).collect();
        let mut cplx: Vec<(f64, f64)> = roots.iter().filter(|r| r.1 > 1e-9 * scale).cloned().collect();
        real.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        cplx.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.partial_cmp(&b.1).unwrap()));
        let (r1, r2) = (real.len(), cplx.len());
        assert_eq!(r1 + 2 * r2, o.n, "root separation failed");
        let roots: Vec<(f64, f64)> = real.into_iter().chain(cplx).collect();
        let den = o.den.to_f64().unwrap();
        let conj = (0..o.n).map(|i| {
            roots.iter().map(|&(re, im)| {
                // sum b_ik t^k / den
                let mut v = C(0.0, 0.0);
                let mut pw = C(1.0, 0.0);
                for c in &o.basis[i] {
                    v = v.add(pw.mul(C(c.to_f64().unwrap() / den, 0.0)));
                    pw = pw.mul(C(re, im));
                }
                (v.0, v.1)
            }).collect()
        }).collect();
        Embeddings { r1, r2, roots, conj }
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

    /// The roots to `prec` bits (fixed point re, im), by Newton's method
    /// from the f64 values.
    pub fn roots_hp(&self, f: &[BigInt], prec: u32) -> Vec<(BigInt, BigInt)> {
        let p = prec as usize + 32;
        self.roots.iter().map(|&(re, im)| {
            // exact for any magnitude (an i64 cast would saturate)
            let to = |x: f64| -> BigInt { num_traits::FromPrimitive::from_f64((x * 2f64.powi(52)).round()).map_or(BigInt::zero(), |b: BigInt| b << (p - 52)) };
            let (mut zr, mut zi) = (to(re), if im == 0.0 { BigInt::zero() } else { to(im) });
            let mut bits = 45;
            loop {
                // f(z) and f'(z) by Horner in fixed point
                let (mut vr, mut vi) = (BigInt::zero(), BigInt::zero());
                let (mut dr, mut di) = (BigInt::zero(), BigInt::zero());
                for c in f.iter().rev() {
                    let (ndr, ndi) = (((&dr * &zr - &di * &zi) >> p) + &vr, ((&dr * &zi + &di * &zr) >> p) + &vi);
                    dr = ndr;
                    di = ndi;
                    let (nvr, nvi) = (((&vr * &zr - &vi * &zi) >> p) + (c << p), (&vr * &zi + &vi * &zr) >> p);
                    vr = nvr;
                    vi = nvi;
                }
                // z -= v / d
                let dd = (&dr * &dr + &di * &di) >> p;
                if dd.is_zero() {
                    break;
                }
                let qr = ((&vr * &dr + &vi * &di) >> p << p) / &dd;
                let qi = ((&vi * &dr - &vr * &di) >> p << p) / &dd;
                zr -= qr;
                if im != 0.0 {
                    zi -= qi;
                }
                if bits > p + 10 {
                    break;
                }
                bits *= 2;
            }
            (zr >> 32usize, zi >> 32usize)
        }).collect()
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
    fn roots_and_logs() {
        // x^3 - 2: one real root 2^(1/3), one complex pair
        let f: Vec<BigInt> = [-2, 0, 0, 1].iter().map(|&c| BigInt::from(c)).collect();
        let (o, _) = maximal_order(&f);
        let e = Embeddings::new(&o);
        assert_eq!((e.r1, e.r2), (1, 1));
        assert!((e.roots[0].0 - 2f64.powf(1.0 / 3.0)).abs() < 1e-14);
        let prec = 200;
        let hp = e.roots_hp(&o.f, prec);
        // the real root cubed is 2 to the precision
        let r = &hp[0].0;
        let cube = ((r * r) >> prec as usize) * r >> prec as usize;
        assert!((cube - (BigInt::from(2) << prec as usize)).abs() < BigInt::from(1u64 << 20));
        // log embedding of the unit t - 1 (norm 1): sums to 0
        let x: Vec<BigInt> = o.from_power(&[(-1).into(), 1.into(), 0.into()].map(|c: i64| num_rational::BigRational::from_integer(c.into()))).into_iter().map(|c| c.to_integer()).collect();
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
