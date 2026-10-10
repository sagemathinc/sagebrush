//! Dense univariate polynomials over Q (constant term first), for exact
//! rational-function integration: division, gcds, the extended Euclidean
//! algorithm, square-free and irreducible factorization, resultants.
//! Degrees in calculus are small, so plain Euclid over Q is fast enough.

use crate::expr::*;
use crate::num::Q;
use num_traits::{Signed, One, Zero};
use sagebrush_bigint::BigInt;

#[derive(Clone, Debug, PartialEq)]
pub struct QPoly(pub Vec<Q>);

impl QPoly {
    pub fn new(mut c: Vec<Q>) -> QPoly {
        while c.last().map_or(false, |v| v.is_zero()) {
            c.pop();
        }
        QPoly(c)
    }
    pub fn zero() -> QPoly {
        QPoly(vec![])
    }
    pub fn one() -> QPoly {
        QPoly(vec![Q::one()])
    }
    pub fn constant(c: Q) -> QPoly {
        QPoly::new(vec![c])
    }
    pub fn x() -> QPoly {
        QPoly(vec![Q::zero(), Q::one()])
    }
    pub fn is_zero(&self) -> bool {
        self.0.is_empty()
    }
    /// The degree; -1 for zero.
    pub fn deg(&self) -> i64 {
        self.0.len() as i64 - 1
    }
    pub fn lc(&self) -> Q {
        self.0.last().cloned().unwrap_or_else(Q::zero)
    }
    pub fn coeff(&self, k: usize) -> Q {
        self.0.get(k).cloned().unwrap_or_else(Q::zero)
    }
    pub fn add(&self, o: &QPoly) -> QPoly {
        let n = self.0.len().max(o.0.len());
        QPoly::new((0..n).map(|k| self.coeff(k) + o.coeff(k)).collect())
    }
    pub fn sub(&self, o: &QPoly) -> QPoly {
        let n = self.0.len().max(o.0.len());
        QPoly::new((0..n).map(|k| self.coeff(k) - o.coeff(k)).collect())
    }
    pub fn neg(&self) -> QPoly {
        QPoly(self.0.iter().map(|v| -v.clone()).collect())
    }
    pub fn scale(&self, c: &Q) -> QPoly {
        QPoly::new(self.0.iter().map(|v| v * c).collect())
    }
    pub fn mul(&self, o: &QPoly) -> QPoly {
        sagebrush_interrupt::check();
        if self.is_zero() || o.is_zero() {
            return QPoly::zero();
        }
        let mut c = vec![Q::zero(); self.0.len() + o.0.len() - 1];
        for (i, a) in self.0.iter().enumerate() {
            if a.is_zero() {
                continue;
            }
            for (j, b) in o.0.iter().enumerate() {
                c[i + j] += a * b;
            }
        }
        QPoly::new(c)
    }
    pub fn pow(&self, k: u32) -> QPoly {
        let mut r = QPoly::one();
        for _ in 0..k {
            r = r.mul(self);
        }
        r
    }
    pub fn derivative(&self) -> QPoly {
        QPoly::new(self.0.iter().enumerate().skip(1).map(|(k, v)| v * Q::from_integer(BigInt::from(k as i64))).collect())
    }
    /// (quotient, remainder)
    pub fn divrem(&self, d: &QPoly) -> (QPoly, QPoly) {
        sagebrush_interrupt::check();
        assert!(!d.is_zero(), "QPoly division by zero");
        let mut r = self.0.clone();
        let dd = d.deg() as usize;
        if self.deg() < d.deg() {
            return (QPoly::zero(), self.clone());
        }
        let inv = d.lc().recip();
        let mut q = vec![Q::zero(); r.len() - dd];
        for k in (0..q.len()).rev() {
            let c = &r[k + dd] * &inv;
            if !c.is_zero() {
                for (j, b) in d.0.iter().enumerate() {
                    r[k + j] -= &c * b;
                }
            }
            q[k] = c;
        }
        r.truncate(dd);
        (QPoly::new(q), QPoly::new(r))
    }
    pub fn rem(&self, d: &QPoly) -> QPoly {
        self.divrem(d).1
    }
    pub fn div_exact(&self, d: &QPoly) -> QPoly {
        self.divrem(d).0
    }
    pub fn monic(&self) -> QPoly {
        if self.is_zero() {
            return self.clone();
        }
        self.scale(&self.lc().recip())
    }
    /// The monic gcd.
    pub fn gcd(&self, o: &QPoly) -> QPoly {
        let (mut a, mut b) = (self.clone(), o.clone());
        while !b.is_zero() {
            let r = a.rem(&b);
            a = b;
            b = r.monic();
        }
        a.monic()
    }
    /// (g, s, t) with s a + t b = g = gcd(a, b), monic.
    pub fn xgcd(&self, o: &QPoly) -> (QPoly, QPoly, QPoly) {
        let (mut r0, mut r1) = (self.clone(), o.clone());
        let (mut s0, mut s1) = (QPoly::one(), QPoly::zero());
        let (mut t0, mut t1) = (QPoly::zero(), QPoly::one());
        while !r1.is_zero() {
            let (q, r) = r0.divrem(&r1);
            let s = s0.sub(&q.mul(&s1));
            let t = t0.sub(&q.mul(&t1));
            r0 = r1;
            r1 = r;
            s0 = s1;
            s1 = s;
            t0 = t1;
            t1 = t;
        }
        let c = if r0.is_zero() { Q::one() } else { r0.lc().recip() };
        (r0.scale(&c), s0.scale(&c), t0.scale(&c))
    }
    /// s, t with s a + t b = c and deg s < deg b (gcd(a, b) must divide c).
    pub fn solve_bezout(a: &QPoly, b: &QPoly, c: &QPoly) -> Option<(QPoly, QPoly)> {
        let (g, s0, _) = a.xgcd(b);
        let (q, r) = c.divrem(&g);
        if !r.is_zero() {
            return None;
        }
        let s = s0.mul(&q).rem(b);
        let t = c.sub(&s.mul(a)).div_exact(b);
        Some((s, t))
    }
    pub fn eval(&self, x: &Q) -> Q {
        let mut r = Q::zero();
        for c in self.0.iter().rev() {
            r = r * x + c;
        }
        r
    }
    /// The resultant (Euclid over Q).
    pub fn resultant(&self, o: &QPoly) -> Q {
        if self.is_zero() || o.is_zero() {
            return Q::zero();
        }
        let (m, n) = (self.deg(), o.deg());
        if n == 0 {
            return pow_q(&o.lc(), m as u32);
        }
        if m == 0 {
            return pow_q(&self.lc(), n as u32);
        }
        let r = self.rem(o);
        if r.is_zero() {
            return Q::zero();
        }
        let sign = if (m * n) % 2 == 1 { -Q::one() } else { Q::one() };
        sign * pow_q(&o.lc(), (m - r.deg()) as u32) * o.resultant(&r)
    }
    /// The square-free decomposition [(a_i, i)] of a nonzero polynomial:
    /// self = lc * prod a_i^i, the a_i monic, square-free and coprime.
    pub fn squarefree(&self) -> Vec<(QPoly, u32)> {
        let f = self.monic();
        let df = f.derivative();
        let mut out = vec![];
        let b = f.gcd(&df);
        let mut c = f.div_exact(&b);
        let mut d = df.div_exact(&b).sub(&c.derivative());
        let mut i = 1;
        while c.deg() > 0 {
            let a = c.gcd(&d);
            if a.deg() > 0 {
                out.push((a.clone(), i));
            }
            c = c.div_exact(&a);
            d = d.div_exact(&a).sub(&c.derivative());
            i += 1;
        }
        out
    }
    /// Irreducible factors over Q, monic, with multiplicities.
    pub fn factor(&self) -> Vec<(QPoly, u32)> {
        if self.deg() <= 0 {
            return vec![];
        }
        let (_, z) = crate::poly::to_zpoly(&self.0);
        let (_, fs) = sagebrush_poly::factor(&z);
        fs.into_iter()
            .map(|(g, e)| (QPoly::new(g.into_iter().map(Q::from_integer).collect()).monic(), e))
            .collect()
    }
    pub fn to_expr(&self, x: &Expr) -> Expr {
        add(self.0.iter().enumerate().map(|(k, c)| mul2(&qnum(c.clone()), &pow(x, &int(k as i64)))).collect())
    }
    /// A polynomial in x with rational coefficients, if e is one.
    pub fn from_expr(e: &Expr, x: &str) -> Option<QPoly> {
        crate::poly::rational_coeffs(e, x).map(QPoly::new)
    }
}

impl QPoly {
    /// The number of distinct real roots in the open interval (lo, hi),
    /// lo < hi, exactly (Sturm's theorem on the square-free part).
    pub fn count_real_roots(&self, lo: &Q, hi: &Q) -> usize {
        if self.deg() < 1 {
            return 0;
        }
        let p = self.div_exact(&self.gcd(&self.derivative()));
        let mut seq = vec![p.clone(), p.derivative()];
        while seq.last().map_or(false, |s| s.deg() > 0) {
            let n = seq.len();
            let r = seq[n - 2].rem(&seq[n - 1]).neg();
            if r.is_zero() {
                break;
            }
            seq.push(r);
        }
        let changes = |x: &Q| {
            let signs: Vec<i32> = seq.iter().map(|s| s.eval(x)).filter(|v| !v.is_zero()).map(|v| if v > Q::zero() { 1 } else { -1 }).collect();
            signs.windows(2).filter(|w| w[0] != w[1]).count()
        };
        // roots in (lo, hi]: V(lo) - V(hi); hi itself is not in the open interval
        let n = changes(lo).saturating_sub(changes(hi));
        n - usize::from(n > 0 && p.eval(hi).is_zero())
    }

    /// A bound B with every real root in (-B, B) (Cauchy's).
    pub fn root_bound(&self) -> Q {
        let lc = self.lc();
        let mut m = Q::zero();
        for c in &self.0[..self.0.len().saturating_sub(1)] {
            let v = (c / &lc).abs();
            if v > m {
                m = v;
            }
        }
        m + Q::one()
    }
}

pub fn pow_q(a: &Q, k: u32) -> Q {
    let mut r = Q::one();
    for _ in 0..k {
        r *= a;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::num::q;

    fn p(c: &[i64]) -> QPoly {
        QPoly::new(c.iter().map(|&v| q(v)).collect())
    }

    #[test]
    fn arithmetic() {
        let a = p(&[-1, 0, 1]); // x^2 - 1
        let b = p(&[1, 1]); // x + 1
        assert_eq!(a.divrem(&b), (p(&[-1, 1]), QPoly::zero()));
        assert_eq!(a.gcd(&p(&[-1, 1])), p(&[-1, 1]));
        let (g, s, t) = p(&[1, 0, 1]).xgcd(&p(&[0, 1]));
        assert_eq!(g, QPoly::one());
        assert_eq!(s.mul(&p(&[1, 0, 1])).add(&t.mul(&p(&[0, 1]))), QPoly::one());
        // res(x^2 + 1, x - 2) = 5; res(x^2 - 1, x + 1) = 0
        assert_eq!(p(&[1, 0, 1]).resultant(&p(&[-2, 1])), q(5));
        assert_eq!(a.resultant(&b), q(0));
        // res(x^2, x^2 + 1) = 1
        assert_eq!(p(&[0, 0, 1]).resultant(&p(&[1, 0, 1])), q(1));
        let sf = p(&[0, 0, 1, 1]).squarefree(); // x^2 (x + 1)
        assert_eq!(sf, vec![(p(&[1, 1]), 1), (p(&[0, 1]), 2)]);
        let fs = p(&[-1, 0, 0, 0, 1]).factor(); // x^4 - 1
        assert_eq!(fs.len(), 3);
    }
}
