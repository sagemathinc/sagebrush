//! Orders of a number field K = Q[x]/(f), f monic integral irreducible:
//! a Z-basis w_i = (b_i . (1, t, ..., t^(n-1))) / den over the power basis
//! of t = x mod f, with the multiplication table w_i w_j = sum c_ijk w_k.
//! The maximal order by Round 2 (Pohst-Zassenhaus; Cohen, A Course in
//! Computational Algebraic Number Theory, 6.1).

use super::factor::factor;
use super::zlin::*;
use crate::linalg::det;
use num_bigint::BigInt;
use num_integer::Integer;
use num_rational::BigRational;
use num_traits::{One, Zero};

#[derive(Clone, Debug)]
pub struct Order {
    pub n: usize,
    /// the defining polynomial, monic, constant term first (n + 1 terms)
    pub f: Vec<BigInt>,
    /// rows: numerators of the basis over the power basis
    pub basis: ZMat,
    pub den: BigInt,
    /// inverse of basis / den (power coordinates -> order coordinates)
    pub to_order: QMat,
    /// mult[i][j] = coordinates of w_i w_j
    pub mult: Vec<Vec<Vec<BigInt>>>,
}

/// a b mod f (f monic), coefficient vectors of length n.
pub fn polmulmod(a: &[BigInt], b: &[BigInt], f: &[BigInt]) -> Vec<BigInt> {
    let n = f.len() - 1;
    let mut c = vec![BigInt::zero(); 2 * n];
    for (i, x) in a.iter().enumerate() {
        if x.is_zero() {
            continue;
        }
        for (j, y) in b.iter().enumerate() {
            c[i + j] += x * y;
        }
    }
    for k in (n..2 * n).rev() {
        if c[k].is_zero() {
            continue;
        }
        let t = std::mem::take(&mut c[k]);
        for i in 0..n {
            c[k - n + i] -= &t * &f[i];
        }
    }
    c.truncate(n);
    c
}

impl Order {
    /// Z[t].
    pub fn equation_order(f: &[BigInt]) -> Order {
        let n = f.len() - 1;
        let id: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect();
        Order::new(f, id, BigInt::one())
    }

    pub fn new(f: &[BigInt], basis: ZMat, den: BigInt) -> Order {
        let n = f.len() - 1;
        assert!(f[n].is_one(), "f must be monic");
        let bq: QMat = basis.iter().map(|r| r.iter().map(|x| BigRational::new(x.clone(), den.clone())).collect()).collect();
        let to_order = inverse(&bq);
        let mut o = Order { n, f: f.to_vec(), basis, den, to_order, mult: vec![] };
        let mut mult = vec![vec![vec![]; n]; n];
        for i in 0..n {
            for j in i..n {
                let p = polmulmod(&o.basis[i], &o.basis[j], f);
                let d2 = &o.den * &o.den;
                let v: Vec<BigRational> = p.into_iter().map(|x| BigRational::new(x, d2.clone())).collect();
                let c = o.from_power(&v);
                let c: Vec<BigInt> = c.into_iter().map(|x| {
                    assert!(x.is_integer(), "not a ring");
                    x.to_integer()
                }).collect();
                mult[i][j] = c.clone();
                mult[j][i] = c;
            }
        }
        o.mult = mult;
        o
    }

    /// Order coordinates of an element given in the power basis.
    pub fn from_power(&self, v: &[BigRational]) -> Vec<BigRational> {
        vec_mat(v, &self.to_order)
    }

    /// Power-basis coordinates of an element given in order coordinates.
    pub fn to_power(&self, x: &[BigInt]) -> Vec<BigRational> {
        let num = vec_mat(x, &self.basis);
        num.into_iter().map(|c| BigRational::new(c, self.den.clone())).collect()
    }

    pub fn one(&self) -> Vec<BigInt> {
        let v: Vec<BigRational> = (0..self.n).map(|i| BigRational::from_integer(BigInt::from((i == 0) as i32))).collect();
        self.from_power(&v).into_iter().map(|x| x.to_integer()).collect()
    }

    pub fn mul(&self, x: &[BigInt], y: &[BigInt]) -> Vec<BigInt> {
        let n = self.n;
        let mut out = vec![BigInt::zero(); n];
        for i in 0..n {
            if x[i].is_zero() {
                continue;
            }
            for j in 0..n {
                if y[j].is_zero() {
                    continue;
                }
                let xy = &x[i] * &y[j];
                for (o, c) in out.iter_mut().zip(&self.mult[i][j]) {
                    if !c.is_zero() {
                        *o += &xy * c;
                    }
                }
            }
        }
        out
    }

    pub fn mul_mod(&self, x: &[BigInt], y: &[BigInt], m: &BigInt) -> Vec<BigInt> {
        self.mul(x, y).into_iter().map(|c| c.mod_floor(m)).collect()
    }

    /// The matrix of multiplication by x (rows: x w_i).
    pub fn mul_matrix(&self, x: &[BigInt]) -> ZMat {
        (0..self.n).map(|i| {
            let e: Vec<BigInt> = (0..self.n).map(|j| BigInt::from((i == j) as i32)).collect();
            self.mul(x, &e)
        }).collect()
    }

    pub fn trace(&self, x: &[BigInt]) -> BigInt {
        (0..self.n).map(|i| &x[i] * (0..self.n).map(|k| &self.mult[i][k][k]).sum::<BigInt>()).sum()
    }

    pub fn norm(&self, x: &[BigInt]) -> BigInt {
        det(&self.mul_matrix(x))
    }

    /// The discriminant det(Tr(w_i w_j)).
    pub fn disc(&self) -> BigInt {
        let n = self.n;
        let tr: Vec<BigInt> = (0..n).map(|i| (0..n).map(|k| self.mult[i][k][k].clone()).sum()).collect();
        let m: ZMat = (0..n).map(|i| (0..n).map(|j| self.mult[i][j].iter().zip(&tr).map(|(c, t)| c * t).sum()).collect()).collect();
        det(&m)
    }

    /// The order with basis rows `rows` (order coordinates, a full-rank
    /// lattice containing a multiple of this order) divided by `div`.
    fn sub_order(&self, rows: &ZMat, div: &BigInt) -> Order {
        let pow: ZMat = rows.iter().map(|r| vec_mat(r, &self.basis)).collect();
        let pow = hnf(&pow);
        let mut den = &self.den * div;
        let g = pow.iter().flatten().fold(den.clone(), |g, x| g.gcd(x));
        let pow: ZMat = pow.iter().map(|r| r.iter().map(|x| x / &g).collect()).collect();
        den /= &g;
        Order::new(&self.f, pow, den)
    }

    /// One Round 2 step at p: the ring of multipliers of the p-radical, if
    /// it is bigger than this order (None: the order is p-maximal).
    pub fn enlarge_at(&self, p: &BigInt) -> Option<Order> {
        let n = self.n;
        // the p-radical: kernel of x -> x^q on O/pO, q = p^j >= n
        let mut q = p.clone();
        while q < BigInt::from(n) {
            q *= p;
        }
        let frob: ZMat = (0..n).map(|i| {
            let e: Vec<BigInt> = (0..n).map(|j| BigInt::from((i == j) as i32)).collect();
            self.pow_mod(&e, &q, p)
        }).collect();
        let ker = left_kernel_mod(&frob, p);
        let mut gens = ker;
        for i in 0..n {
            gens.push((0..n).map(|j| if i == j { p.clone() } else { BigInt::zero() }).collect());
        }
        let ip = hnf(&gens); // the radical, n x n
        let ip_inv = inverse(&to_q(&ip));
        // {x in O : x I subset p I}: kernel of x -> (x b_k in I-coordinates) mod p
        let a: ZMat = (0..n).map(|i| {
            let e: Vec<BigInt> = (0..n).map(|j| BigInt::from((i == j) as i32)).collect();
            let mut row = vec![];
            for b in &ip {
                let y = self.mul(&e, b);
                let yq: Vec<BigRational> = y.into_iter().map(BigRational::from_integer).collect();
                let z = vec_mat(&yq, &ip_inv);
                row.extend(z.into_iter().map(|c| c.to_integer().mod_floor(p)));
            }
            row
        }).collect();
        let ker = left_kernel_mod(&a, p);
        if ker.is_empty() {
            return None;
        }
        let mut gens = ker;
        for i in 0..n {
            gens.push((0..n).map(|j| if i == j { p.clone() } else { BigInt::zero() }).collect());
        }
        let k = hnf(&gens);
        Some(self.sub_order(&k, p))
    }

    /// x^e mod p (order coordinates).
    pub fn pow_mod(&self, x: &[BigInt], e: &BigInt, p: &BigInt) -> Vec<BigInt> {
        let mut r = self.one();
        let mut b: Vec<BigInt> = x.iter().map(|c| c.mod_floor(p)).collect();
        let bits = e.bits();
        for k in 0..bits {
            if e.bit(k) {
                r = self.mul_mod(&r, &b, p);
            }
            if k + 1 < bits {
                b = self.mul_mod(&b, &b, p);
            }
        }
        r
    }
}

/// The maximal order of Q[x]/(f), f monic irreducible, by Round 2; also
/// returns the factorization of the field discriminant.
pub fn maximal_order(f: &[BigInt]) -> (Order, Vec<(BigInt, u32)>) {
    let mut o = Order::equation_order(f);
    let d = o.disc();
    for (p, e) in factor(&d) {
        if e < 2 {
            continue;
        }
        while let Some(o2) = o.enlarge_at(&p) {
            o = o2;
        }
    }
    let dk = o.disc();
    let fac = factor(&dk);
    (o, fac)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(c: &[i64]) -> Vec<BigInt> {
        c.iter().map(|&x| BigInt::from(x)).collect()
    }

    #[test]
    fn maximal_orders() {
        // (f, field discriminant), from PARI's nfdisc (oracle)
        let cases: &[(&[i64], i64)] = &[
            (&[3, 0, 1], -3),               // x^2 + 3
            (&[8, -2, 1, 1], -503),         // Dedekind: x^3 + x^2 - 2x + 8
            (&[-1, -1, 0, 1], -23),         // x^3 - x - 1
            (&[1, 0, 0, 0, 1], 256),        // x^4 + 1
            (&[-2, 0, 0, 0, 0, 1], 50000),  // x^5 - 2
            (&[1, 0, 0, 1, 0, 0, 1], -19683), // x^6 + x^3 + 1
            (&[-5, 0, 0, 0, 1], -2000),     // x^4 - 5
        ];
        for &(f, dk) in cases {
            let (o, _) = maximal_order(&poly(f));
            assert_eq!(o.disc(), BigInt::from(dk), "{:?}", f);
        }
    }
}
