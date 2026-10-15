//! Local splittings R / P^e R = M_2(O_F/P^e) of the icosian ring.
//!
//! The icosian ring is maximal and B is unramified at every finite place,
//! so R / P^e R is isomorphic to M_2(O_F/P^e). PSAGE found the images of
//! i and j by a search with brute-force square roots, and treated P = (2)
//! separately (there i, j do not generate R) by lifting a mod-2 solution
//! (sqrt5_fast.pyx, sqrt5_fast_python.py). Here the splitting is computed
//! directly on the basis e1..e4 of R, the same way at every prime:
//!
//! 1. Find x in R whose reduced characteristic polynomial has two distinct
//!    roots l1, l2 in the residue field k = O_F/P. In R/PR = M_2(k), x is
//!    then diagonalizable and eps = (x - l2)/(l1 - l2) is an idempotent of
//!    rank one.
//! 2. Lift eps to an idempotent modulo P^e by eps <- 3 eps^2 - 2 eps^3:
//!    with d = eps^2 - eps, the new eps satisfies eps^2 - eps = d^2 (4d - 3),
//!    so an idempotent modulo P^m becomes one modulo P^2m.
//! 3. The left ideal I = A eps of A = R/P^e R is free of rank two with
//!    basis v1 = eps, v2 = (1 - eps) y eps (for some basis element y making
//!    v2 nonzero modulo P), since eps A eps and (1 - eps) A eps are free of
//!    rank one. Left multiplication A -> End(I) = M_2(O_F/P^e) is the
//!    splitting: it is an isomorphism because it is unital and A/PA is
//!    simple (Voight, "Identifying the matrix ring", 2013, Lemma 4.1 and its
//!    proof, which uses the same left-regular action on a left ideal).
//!
//! A splitting modulo N reduces to a splitting modulo every divisor of N;
//! PSAGE's degeneracy maps rely on using such compatible reductions.

use crate::field::Elt;
use crate::p1::Mat;
use crate::quat::{one_e, structure_constants, Quat};
use crate::residue::{LocalRing, Res};

/// An element of R / P^e R in the basis e1..e4.
pub type AElt = [Res; 4];

/// R / P^e R with its multiplication table.
pub struct LocalAlgebra<'a> {
    pub ring: &'a LocalRing,
    c: [[[Res; 4]; 4]; 4],
    one: AElt,
}

impl<'a> LocalAlgebra<'a> {
    pub fn new(ring: &'a LocalRing) -> LocalAlgebra<'a> {
        let sc = structure_constants();
        let c = sc.map(|row| row.map(|v| v.map(|x| ring.from_elt(x))));
        let one = one_e().map(|x| ring.from_elt(x));
        LocalAlgebra { ring, c, one }
    }
    pub fn from_e(&self, c: &[Elt; 4]) -> AElt {
        c.map(|x| self.ring.from_elt(x))
    }
    pub fn mul(&self, x: &AElt, y: &AElt) -> AElt {
        let r = self.ring;
        let mut z = [r.zero(); 4];
        for i in 0..4 {
            for j in 0..4 {
                let xy = r.mul(x[i], y[j]);
                if xy == r.zero() {
                    continue;
                }
                for k in 0..4 {
                    z[k] = r.add(z[k], r.mul(xy, self.c[i][j][k]));
                }
            }
        }
        z
    }
    pub fn add(&self, x: &AElt, y: &AElt) -> AElt {
        [0, 1, 2, 3].map(|m| self.ring.add(x[m], y[m]))
    }
    pub fn sub(&self, x: &AElt, y: &AElt) -> AElt {
        [0, 1, 2, 3].map(|m| self.ring.sub(x[m], y[m]))
    }
    pub fn scale(&self, s: Res, x: &AElt) -> AElt {
        x.map(|t| self.ring.mul(s, t))
    }
    pub fn one(&self) -> AElt {
        self.one
    }
    fn is_zero_mod_p(&self, x: &AElt) -> bool {
        x.iter().all(|&t| self.ring.in_p(t))
    }
    /// The coefficient a with a v = w, for v with some unit coordinate and w
    /// a multiple of v.
    fn coefficient(&self, v: &AElt, w: &AElt) -> Res {
        let r = self.ring;
        let t = (0..4).find(|&t| r.is_unit(v[t])).expect("vector is zero modulo P");
        let a = r.mul(w[t], r.inv(v[t]).unwrap());
        debug_assert!(self.scale(a, v) == *w, "not a multiple");
        a
    }
}

/// The images E_m in M_2(O_F/P^e) of the basis e1..e4 of R.
#[derive(Clone, Debug)]
pub struct LocalSplitting {
    pub images: [Mat; 4],
}

impl LocalSplitting {
    pub fn new(ring: &LocalRing) -> Result<LocalSplitting, String> {
        let alg = LocalAlgebra::new(ring);
        let k = LocalRing::new(ring.prime, 1)?;
        // Step 1: an element with split separable reduced characteristic
        // polynomial t^2 - trd(x) t + nrd(x). Small combinations of the basis
        // suffice; about half of all elements qualify.
        let mut found = None;
        'search: for n in 0..4096u64 {
            let mut c = [Elt::int(0); 4];
            let mut m = n;
            for t in 0..4 {
                c[t] = Elt::int((m % 8) as i64 - 3);
                m /= 8;
            }
            let q = Quat::from_e(&c);
            if let Some((l1, l2)) = k.distinct_roots(k.from_elt(q.trd()), k.from_elt(q.nrd())) {
                found = Some((c, l1, l2));
                break 'search;
            }
        }
        let (c, l1, l2) = found.ok_or("no element with split characteristic polynomial found")?;
        let x = alg.from_e(&c);
        let (l1, l2) = (ring.from_elt(k.lift(l1)), ring.from_elt(k.lift(l2)));
        let d = ring.inv(ring.sub(l1, l2)).ok_or("roots not distinct")?;
        let mut eps = alg.scale(d, &alg.sub(&x, &alg.scale(l2, &alg.one())));
        // Step 2: Newton iteration for eps^2 = eps.
        let three = ring.reduce(3, 0);
        let two = ring.reduce(2, 0);
        let mut steps = 0;
        loop {
            let e2 = alg.mul(&eps, &eps);
            if e2 == eps {
                break;
            }
            let e3 = alg.mul(&e2, &eps);
            eps = alg.sub(&alg.scale(three, &e2), &alg.scale(two, &e3));
            steps += 1;
            if steps > 64 {
                return Err("idempotent lifting did not converge".into());
            }
        }
        // Step 3: the basis v1, v2 of A eps and the left-regular action.
        let one_minus = alg.sub(&alg.one(), &eps);
        let v1 = eps;
        let v2 = (0..4)
            .map(|m| {
                let mut y = [ring.zero(); 4];
                y[m] = ring.one();
                alg.mul(&alg.mul(&one_minus, &y), &eps)
            })
            .find(|v| !alg.is_zero_mod_p(v))
            .ok_or("(1 - eps) A eps is zero modulo P")?;
        let mut images = [[ring.zero(); 4]; 4];
        for m in 0..4 {
            let mut em = [ring.zero(); 4];
            em[m] = ring.one();
            for (col, v) in [v1, v2].iter().enumerate() {
                let w = alg.mul(&em, v);
                let a = alg.coefficient(&v1, &alg.mul(&eps, &w));
                let b = alg.coefficient(&v2, &alg.mul(&one_minus, &w));
                // column col of [a11 a12; a21 a22] is (a, b)
                images[m][col] = a;
                images[m][2 + col] = b;
            }
        }
        Ok(LocalSplitting { images })
    }

    /// The image of the element of R with e-coordinates c.
    pub fn image(&self, ring: &LocalRing, c: &[Elt; 4]) -> Mat {
        let mut m = [ring.zero(); 4];
        for t in 0..4 {
            let s = ring.from_elt(c[t]);
            if s == ring.zero() {
                continue;
            }
            for u in 0..4 {
                m[u] = ring.add(m[u], ring.mul(s, self.images[t][u]));
            }
        }
        m
    }
}

pub fn mat_mul(r: &LocalRing, x: &Mat, y: &Mat) -> Mat {
    [
        r.add(r.mul(x[0], y[0]), r.mul(x[1], y[2])),
        r.add(r.mul(x[0], y[1]), r.mul(x[1], y[3])),
        r.add(r.mul(x[2], y[0]), r.mul(x[3], y[2])),
        r.add(r.mul(x[2], y[1]), r.mul(x[3], y[3])),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{primes_above, rational_primes};
    use crate::quat::icosians;

    /// The images satisfy the multiplication table of R, 1 maps to the
    /// identity, and they are linearly independent modulo P.
    #[test]
    fn splittings_are_isomorphisms() {
        let sc = structure_constants();
        for p in rational_primes(60) {
            for pr in primes_above(p) {
                for e in 1..=3u32 {
                    if (pr.norm as u128).pow(e) > 1 << 20 {
                        continue;
                    }
                    let r = LocalRing::new(pr, e).unwrap();
                    let s = LocalSplitting::new(&r).unwrap();
                    for i in 0..4 {
                        for j in 0..4 {
                            let lhs = mat_mul(&r, &s.images[i], &s.images[j]);
                            assert_eq!(lhs, s.image(&r, &sc[i][j]), "P = {:?}, e = {}", pr.gen, e);
                        }
                    }
                    let id = s.image(&r, &one_e());
                    assert_eq!(id, [r.one(), r.zero(), r.zero(), r.one()]);
                    // independence modulo P: the 4x4 determinant over k is nonzero
                    let k = LocalRing::new(pr, 1).unwrap();
                    let rows: Vec<Vec<Res>> = (0..4).map(|m| s.images[m].iter().map(|&x| k.from_elt(r.lift(x))).collect()).collect();
                    assert!(det_nonzero(&k, rows), "images dependent modulo P");
                    // icosians map to matrices of determinant 1 (nrd = det)
                    for g in icosians().iter().take(10) {
                        let m = s.image(&r, &g.to_e().unwrap());
                        let det = r.sub(r.mul(m[0], m[3]), r.mul(m[1], m[2]));
                        assert_eq!(det, r.one());
                    }
                }
            }
        }
    }

    fn det_nonzero(k: &LocalRing, mut m: Vec<Vec<Res>>) -> bool {
        let n = m.len();
        for col in 0..n {
            let Some(piv) = (col..n).find(|&r| m[r][col] != k.zero()) else { return false };
            m.swap(col, piv);
            let inv = k.inv(m[col][col]).unwrap();
            for r in col + 1..n {
                let f = k.mul(m[r][col], inv);
                for c in col..n {
                    let t = k.mul(f, m[col][c]);
                    m[r][c] = k.sub(m[r][c], t);
                }
            }
        }
        true
    }
}
