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
    let n = f.len() - 1;
    let fc: Vec<f64> = f.iter().map(|c| c.to_f64().unwrap()).collect();
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
        let s: Vec<Vec<(f64, f64)>> = vs.iter().map(|v| self.sigma(v)).collect();
        let k = vs.len();
        (0..k).map(|a| (0..k).map(|b| {
            let mut t = 0.0;
            for (j, (x, y)) in s[a].iter().zip(&s[b]).enumerate() {
                let w = if j < self.r1 { 1.0 } else { 2.0 };
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
            let to = |x: f64| -> BigInt { BigInt::from((x * 2f64.powi(52)) as i64) << (p - 52) };
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
    let mut b: Vec<Vec<BigInt>> = basis.to_vec();
    let k = b.len();
    let delta = 0.99;
    let mut i = 1;
    let mut iters = 0;
    while i < k && iters < 100_000 {
        iters += 1;
        let g = emb.t2_gram(&b);
        // Gram-Schmidt coefficients from the Gram matrix
        let mut mu = vec![vec![0.0f64; k]; k];
        let mut bstar = vec![0.0f64; k];
        for a in 0..k {
            for c in 0..a {
                let mut s = g[a][c];
                for t in 0..c {
                    s -= mu[c][t] * mu[a][t] * bstar[t];
                }
                mu[a][c] = s / bstar[c];
            }
            let mut s = g[a][a];
            for t in 0..a {
                s -= mu[a][t] * mu[a][t] * bstar[t];
            }
            bstar[a] = s;
        }
        // size-reduce b_i
        let mut changed = false;
        for c in (0..i).rev() {
            let q = mu[i][c].round();
            if q != 0.0 {
                let qb = BigInt::from(q as i64);
                let bc = b[c].clone();
                for (x, y) in b[i].iter_mut().zip(&bc) {
                    *x -= &qb * y;
                }
                for t in 0..=c {
                    mu[i][t] -= q * if t == c { 1.0 } else { mu[c][t] };
                }
                changed = true;
            }
        }
        if changed {
            continue; // recompute (cheap for small dimensions)
        }
        if bstar[i] < (delta - mu[i][i - 1] * mu[i][i - 1]) * bstar[i - 1] {
            b.swap(i, i - 1);
            i = (i - 1).max(1);
        } else {
            i += 1;
        }
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
