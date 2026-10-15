//! Exact comparison of the Hecke eigenvalues of one newform orbit given in
//! two number fields (ours, and the LMFDB's or Magma's), shared by
//! lmfdb_eigen.rs and eigen_magma.rs.
//!
//! Equal characteristic polynomials of each a_P separately would not show
//! that the a_P are conjugated together (daybreak TEST-796-1). So the
//! comparison finds an isomorphism between the two fields and maps every
//! a_P through it:
//!
//! * z_t = sum_k (k + 1)^t a_(P_k) over all the primes in the fixture's
//!   order, for the least t = 1, 2, ... for which z generates our field
//!   (1, z, ..., z^(d-1) are independent);
//! * z and z' (the same combination on the other side) must have the same
//!   characteristic polynomial, which is then irreducible: so z -> z'
//!   defines an isomorphism phi of fields;
//! * every a_P = c_P(z) with c_P in Q[x] of degree < d (exact linear
//!   algebra), and phi(a_P) = c_P(z') must be a'_P: the coordinates of a_P
//!   in the basis 1, z, ..., z^(d-1) and those of a'_P in 1, z', ...
//!   must be equal.

#![allow(dead_code)]

use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;

/// A rational number in lowest terms, positive denominator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Q {
    n: BigInt,
    d: BigInt,
}

impl Q {
    pub fn new(n: BigInt, d: BigInt) -> Q {
        assert!(!d.is_zero());
        let g = n.gcd(&d);
        let (mut n, mut d) = (&n / &g, &d / &g);
        if d.is_negative() {
            n = -n;
            d = -d;
        }
        Q { n, d }
    }
    pub fn int(n: i64) -> Q {
        Q { n: BigInt::from(n), d: BigInt::one() }
    }
    pub fn zero() -> Q {
        Q::int(0)
    }
    /// "a" or "a/b".
    pub fn parse(s: &str) -> Q {
        match s.trim().split_once('/') {
            Some((a, b)) => Q::new(a.parse().unwrap(), b.parse().unwrap()),
            None => Q::new(s.trim().parse().unwrap(), BigInt::one()),
        }
    }
    pub fn is_zero(&self) -> bool {
        self.n.is_zero()
    }
    pub fn add(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.d + &o.n * &self.d, &self.d * &o.d)
    }
    pub fn sub(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.d - &o.n * &self.d, &self.d * &o.d)
    }
    pub fn mul(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.n, &self.d * &o.d)
    }
    pub fn div(&self, o: &Q) -> Q {
        Q::new(&self.n * &o.d, &self.d * &o.n)
    }
}

/// Q[x]/(f), f monic of degree d (constant term first); elements are
/// coordinate vectors of length d in the basis 1, x, ..., x^(d-1).
pub struct Field {
    f: Vec<Q>,
}

impl Field {
    /// From a defining polynomial with rational coefficients (made monic).
    pub fn new(f: Vec<Q>) -> Field {
        let lead = f.last().unwrap().clone();
        Field { f: f.iter().map(|c| c.div(&lead)).collect() }
    }
    pub fn degree(&self) -> usize {
        self.f.len() - 1
    }
    pub fn mul(&self, a: &[Q], b: &[Q]) -> Vec<Q> {
        let d = self.degree();
        let mut w = vec![Q::zero(); 2 * d];
        for (i, x) in a.iter().enumerate() {
            if x.is_zero() {
                continue;
            }
            for (j, y) in b.iter().enumerate() {
                w[i + j] = w[i + j].add(&x.mul(y));
            }
        }
        for k in (d..w.len()).rev() {
            let c = w[k].clone();
            if c.is_zero() {
                continue;
            }
            for i in 0..=d {
                w[k - d + i] = w[k - d + i].sub(&c.mul(&self.f[i]));
            }
        }
        w.truncate(d);
        w
    }
    pub fn one(&self) -> Vec<Q> {
        let mut v = vec![Q::zero(); self.degree()];
        v[0] = Q::int(1);
        v
    }
}

/// The solution x of sum_j x_j cols[j] = b, if the cols are independent
/// (exact Gaussian elimination), else None.
fn solve(cols: &[Vec<Q>], b: &[Q]) -> Option<Vec<Q>> {
    let d = cols.len();
    // rows of the augmented matrix [cols | b]
    let mut m: Vec<Vec<Q>> = (0..b.len()).map(|i| cols.iter().map(|c| c[i].clone()).chain(std::iter::once(b[i].clone())).collect()).collect();
    for c in 0..d {
        let k = (c..m.len()).find(|&k| !m[k][c].is_zero())?;
        m.swap(c, k);
        let inv = Q::int(1).div(&m[c][c]);
        for x in m[c].iter_mut() {
            *x = x.mul(&inv);
        }
        for k in 0..m.len() {
            if k != c && !m[k][c].is_zero() {
                let f = m[k][c].clone();
                for j in 0..=d {
                    let t = m[c][j].mul(&f);
                    m[k][j] = m[k][j].sub(&t);
                }
            }
        }
    }
    // the remaining rows must be consistent
    if m[d..].iter().any(|row| !row[d].is_zero()) {
        return None;
    }
    Some((0..d).map(|c| m[c][d].clone()).collect())
}

/// The characteristic polynomial of multiplication by a (Faddeev-LeVerrier),
/// constant term first.
pub fn charpoly(k: &Field, a: &[Q]) -> Vec<Q> {
    let d = k.degree();
    // the matrix of multiplication by a: column j = a x^j
    let mut cols = vec![];
    let mut xj = k.one();
    let mut x = vec![Q::zero(); d];
    if d > 1 {
        x[1] = Q::int(1);
    }
    for j in 0..d {
        cols.push(k.mul(a, &xj));
        if j + 1 < d {
            xj = k.mul(&xj, &x);
        }
    }
    let am = |i: usize, j: usize| &cols[j][i];
    let mut c = vec![Q::zero(); d + 1];
    c[d] = Q::int(1);
    let mut mk = vec![vec![Q::zero(); d]; d];
    for t in 1..=d {
        // M_t = A M_(t-1) + c_(d-t+1) I
        let mut next = vec![vec![Q::zero(); d]; d];
        for i in 0..d {
            for j in 0..d {
                let mut s = Q::zero();
                for l in 0..d {
                    if !mk[l][j].is_zero() {
                        s = s.add(&am(i, l).mul(&mk[l][j]));
                    }
                }
                next[i][j] = s;
            }
            next[i][i] = next[i][i].add(&c[d - t + 1]);
        }
        mk = next;
        // c_(d-t) = -tr(A M_t)/t
        let mut tr = Q::zero();
        for i in 0..d {
            for l in 0..d {
                tr = tr.add(&am(i, l).mul(&mk[l][i]));
            }
        }
        c[d - t] = Q::zero().sub(&tr.div(&Q::int(t as i64)));
    }
    c
}

/// The coordinates of every a in the basis 1, z, ..., z^(d-1), or None if
/// z does not generate the field.
fn coordinates(k: &Field, z: &[Q], aps: &[Vec<Q>]) -> Option<Vec<Vec<Q>>> {
    let d = k.degree();
    let mut pows = vec![k.one()];
    for _ in 1..d {
        pows.push(k.mul(pows.last().unwrap(), z));
    }
    aps.iter().map(|a| solve(&pows, a)).collect()
}

fn combination(k: &Field, aps: &[Vec<Q>], t: u32) -> Vec<Q> {
    let mut z = vec![Q::zero(); k.degree()];
    for (i, a) in aps.iter().enumerate() {
        let c = Q::new(BigInt::from(i as i64 + 1).pow(t), BigInt::one());
        for (x, y) in z.iter_mut().zip(a) {
            *x = x.add(&y.mul(&c));
        }
    }
    z
}

/// Whether the eigenvalue systems (a_P in k, a'_P in k2, primes in the same
/// order) agree under one isomorphism k -> k2; Ok(t) gives the t used.
pub fn joint(k: &Field, aps: &[Vec<Q>], k2: &Field, aps2: &[Vec<Q>]) -> Result<u32, String> {
    if k.degree() != k2.degree() || aps.len() != aps2.len() {
        return Err("different degrees or numbers of primes".into());
    }
    for t in 1..=12u32 {
        let z = combination(k, aps, t);
        let Some(c) = coordinates(k, &z, aps) else {
            continue; // z does not generate our field
        };
        let z2 = combination(k2, aps2, t);
        if charpoly(k, &z) != charpoly(k2, &z2) {
            return Err(format!("z_{} has different characteristic polynomials", t));
        }
        let c2 = coordinates(k2, &z2, aps2).ok_or("z' does not generate the other field")?;
        return match c.iter().zip(&c2).position(|(x, y)| x != y) {
            None => Ok(t),
            Some(i) => Err(format!("a_P at the prime with index {} differs under z_{} -> z_{}'", i, t, t)),
        };
    }
    Err("no z_t (t <= 12) generates the field: the a_P compared do not generate it".into())
}

/// Matches every orbit of `theirs` with a distinct orbit of `ours` whose
/// eigenvalues agree under an isomorphism of fields; the number matched.
pub fn match_orbits(ours: &[(Field, Vec<Vec<Q>>)], theirs: &[(Field, Vec<Vec<Q>>)], what: &str) -> usize {
    assert_eq!(ours.len(), theirs.len(), "{}: numbers of orbits", what);
    let mut used = vec![false; ours.len()];
    for (k2, a2) in theirs {
        let mut errs = vec![];
        let hit = ours.iter().enumerate().find(|(j, (k, a))| {
            if used[*j] || k.degree() != k2.degree() {
                return false;
            }
            match joint(k, a, k2, a2) {
                Ok(_) => true,
                Err(e) => {
                    errs.push(e);
                    false
                }
            }
        });
        match hit {
            Some((j, _)) => used[j] = true,
            None => panic!("{}: an orbit of degree {} has no match: {:?}", what, k2.degree(), errs),
        }
    }
    theirs.len()
}

/// Our orbit as a field and its eigenvalues: Q[x]/(g), a_P = num/den in the
/// basis 1, theta, ....
pub fn ours(g: &[BigInt], aps: &[sagebrush_hmf::eigen::Eigenvalue]) -> (Field, Vec<Vec<Q>>) {
    let k = Field::new(g.iter().map(|c| Q::new(c.clone(), BigInt::one())).collect());
    let v = aps.iter().map(|a| a.num.iter().map(|x| Q::new(x.clone(), a.den.clone())).collect()).collect();
    (k, v)
}

/// A field and eigenvalues from fixture strings: "f0,f1,...,fd" and, per
/// prime, "q0,q1,...".
pub fn theirs(field: &str, aps: &[&str]) -> (Field, Vec<Vec<Q>>) {
    let k = Field::new(field.split(',').map(Q::parse).collect());
    let d = k.degree();
    let v = aps
        .iter()
        .map(|s| {
            let mut a: Vec<Q> = s.split(',').map(Q::parse).collect();
            assert!(a.len() <= d);
            a.resize(d, Q::zero());
            a
        })
        .collect();
    (k, v)
}

#[test]
fn counterexample_is_rejected() {
    // daybreak (TEST-656-1), in Q(sqrt 2): a = (2 sqrt 2, -sqrt 2, 1 + sqrt 2)
    // and b = (-2 sqrt 2, sqrt 2, 1 + sqrt 2) have the same characteristic
    // polynomial at every prime and the same z_1 = a1 + 2 a2 + 3 a3
    // = 3 + 3 sqrt 2, which generates the field; but no one automorphism
    // carries a to b, so the comparison must reject it at the coordinates
    let k = Field::new(vec![Q::int(-2), Q::int(0), Q::int(1)]);
    let a = vec![vec![Q::int(0), Q::int(2)], vec![Q::int(0), Q::int(-1)], vec![Q::int(1), Q::int(1)]];
    let b = vec![vec![Q::int(0), Q::int(-2)], vec![Q::int(0), Q::int(1)], vec![Q::int(1), Q::int(1)]];
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(charpoly(&k, x), charpoly(&k, y));
    }
    let (z, z2) = (combination(&k, &a, 1), combination(&k, &b, 1));
    assert_eq!(z, vec![Q::int(3), Q::int(3)]);
    assert_eq!(charpoly(&k, &z), charpoly(&k, &z2));
    let e = joint(&k, &a, &k, &b).unwrap_err();
    assert!(e.starts_with("a_P at the prime"), "rejected before the coordinate comparison: {}", e);
    // a genuine conjugation of all three, and the identity, are accepted
    let c = vec![vec![Q::int(0), Q::int(-2)], vec![Q::int(0), Q::int(1)], vec![Q::int(1), Q::int(-1)]];
    assert_eq!(joint(&k, &a, &k, &c), Ok(1));
    assert_eq!(joint(&k, &a, &k, &a), Ok(1));
}
