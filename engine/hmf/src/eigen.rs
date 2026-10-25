//! Hecke eigenvalues of every newform, in its coefficient field.
//!
//! Let T be the separating operator of the level (newspace.rs) and g one of
//! the irreducible factors of its new characteristic polynomial: a Galois
//! orbit of newforms, with coefficient field K = Q(theta), g(theta) = 0. By
//! the separation, g divides the characteristic polynomial of T on M_2(N)
//! exactly once, so V_g = ker g(T) has dimension d = deg g and is a cyclic
//! Q[T]-module (isomorphic to K, with T acting as theta): for any nonzero
//! v in V_g, the vectors v, T v, ..., T^(d-1) v are a basis. Every Hecke
//! operator T_P (U_P for P dividing N) commutes with T, so it preserves V_g
//! and acts there as c(T) for a polynomial c of degree < d over Q; then the
//! eigenvalue of T_P on the newform with T-eigenvalue theta is
//! a_P = c(theta).
//!
//! The computation is modular, its results are checked exactly:
//!
//! * v: modulo word-size primes l, v_0 = h(T) u lies in V_g (h = the
//!   characteristic polynomial of T divided by g, u an integer vector),
//!   its Krylov vectors span V_g, and the first row of their reduced
//!   echelon form is a canonical v (the sequence T^j u, j < n, is computed
//!   once per prime and shared by the orbits, so that T^i h(T) u =
//!   sum_j h_j T^(i+j) u costs O(n^2) per orbit and vector, not the O(n^3)
//!   of evaluating h(T) u); Chinese remaindering and rational
//!   reconstruction recover it over Q once it is stable, and g(T) v = 0 is
//!   then verified in integers (so v lies in V_g whatever the primes did);
//! * c: with the exact Krylov basis W_j = T^j v, c solves T_P v = sum c_j W_j
//!   on d coordinates where the W_j are independent (an exact inverse), and
//!   the identity is then verified on every coordinate. Since V_g is cyclic,
//!   T_P v = c(T) v implies T_P = c(T) on V_g.
//!
//! So every eigenvalue returned is proven, given the separation (proven in
//! newspace.rs).

use crate::field::Prime;
use crate::newspace::{NewformOrbits, Newspaces};
use sagebrush_arith::crt::MultiCrt;
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::nmod_poly;
use sagebrush_arith::zmat::{charpoly, inverse, ratrecon, ZMat};
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, Zero};

/// a = (num_0 + num_1 theta + ... + num_(d-1) theta^(d-1)) / den, in lowest
/// terms (den > 0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Eigenvalue {
    pub num: Vec<BigInt>,
    pub den: BigInt,
}

/// The eigenspace data of one Galois orbit of newforms.
pub struct OrbitEigenspace {
    /// The orbit's factor g (monic, irreducible) of the new characteristic
    /// polynomial of the separating operator; theta is a root of g.
    pub g: Vec<BigInt>,
    /// The Krylov basis W_j = T^j v (integral, v primitive), j < d.
    pub krylov: Vec<Vec<BigInt>>,
    /// d coordinates on which the W_j are independent.
    pub pivots: Vec<usize>,
    /// The inverse of the d x d matrix A[r][j] = W_j[pivots[r]], as N / den.
    ainv: ZMat,
    aden: BigInt,
    /// The Krylov basis in i128, when every entry is below 2^62 (the usual
    /// case): the products below are then done in checked i128 arithmetic,
    /// falling back to big integers on overflow.
    small: Option<Vec<Vec<i128>>>,
}

/// Data of an operator T on M_2(N) modulo a prime p, shared by the orbits:
/// its characteristic polynomial, and the Krylov sequence T^j u (j < n) of
/// a fixed pseudo-random vector u depending only on p (kept when it fits
/// the memory budget below).
pub(crate) struct ModData {
    charpoly: Vec<u64>,
    krylov: Option<Vec<Vec<u64>>>,
}

/// At most this many residues are kept in Krylov sequences per level.
const KRYLOV_BUDGET: usize = 1 << 23;

fn big(x: i64) -> BigInt {
    BigInt::from(x)
}

/// The integer matrix-vector product m v (m with i64 entries).
fn matvec(m: &[Vec<i64>], v: &[BigInt]) -> Vec<BigInt> {
    m.iter()
        .map(|row| {
            let mut s = BigInt::zero();
            for (j, &x) in row.iter().enumerate() {
                if x != 0 && !v[j].is_zero() {
                    s += &v[j] * &big(x);
                }
            }
            s
        })
        .collect()
}

fn content(v: &[BigInt]) -> BigInt {
    v.iter().fold(BigInt::zero(), |g, x| g.gcd(x))
}

impl Newspaces {
    /// The eigenspace data of the k-th orbit of `orbits` (from
    /// newform_orbits() of this level).
    pub fn orbit_eigenspace(&self, orbits: &NewformOrbits, k: usize) -> Result<OrbitEigenspace, String> {
        self.orbit_eigenspace_with(orbits, k, KRYLOV_BUDGET)
    }

    /// orbit_eigenspace, keeping at most `budget` residues in shared Krylov
    /// sequences (0: none, Horner evaluation instead).
    fn orbit_eigenspace_with(&self, orbits: &NewformOrbits, k: usize, budget: usize) -> Result<OrbitEigenspace, String> {
        let g = orbits.orbits.get(k).ok_or("no such orbit")?.clone();
        let t = self.op_matrix(&self.level, &orbits.op)?;
        let key: Vec<(crate::field::Hnf, i64)> = orbits.op.iter().map(|(q, c)| (q.hnf, *c)).collect();
        orbit_eigenspace_core(&t, g, &key, &self.charpoly_mod, budget)
    }
}

/// The eigenspace data of the orbit with factor g of the separating operator
/// whose matrix on M_2(N) is t (the algorithm of the module documentation).
/// Data modulo primes is cached in `cache` under (key, prime), shared by the
/// orbits of one operator, keeping at most `budget` residues of Krylov
/// sequences. Used by Newspaces (Q(sqrt 5)) and by the general newspaces
/// (defnew.rs).
pub(crate) fn orbit_eigenspace_core<K: std::hash::Hash + Eq + Clone>(t: &[Vec<i64>], g: Vec<BigInt>, key: &K, cache: &std::sync::Mutex<std::collections::HashMap<(K, u64), std::sync::Arc<ModData>>>, budget: usize) -> Result<OrbitEigenspace, String> {
    {
        let d = g.len() - 1;
        if g[d] != BigInt::one() {
            return Err("the orbit's polynomial must be monic".into());
        }
        let n = t.len();
        let mut primes: Vec<u64> = vec![];
        let mut attempts = 0usize;
        let mut residues: Vec<Vec<u64>> = vec![];
        let mut pivots: Option<Vec<usize>> = None;
        let mut last: Option<Vec<BigInt>> = None;
        for p in Primes::new() {
            attempts += 1;
            if attempts > 400 {
                return Err("rational reconstruction of the eigenvector did not stabilize".into());
            }
            // u varies with the prime: the canonical v (the first row of the
            // reduced echelon basis of V_g) does not depend on it, and a u with
            // no component in V_g (h(T) u = 0) cannot recur forever
            let s = p % 1009;
            let u: Vec<u64> = (0..n as u64).map(|i| (i * i + 7 * i + 3 + s * (2 * i + 1)) % 1009 + 1).collect();
            let md = Modulus::new(p);
            let rows: Vec<Vec<u64>> = t.iter().map(|r| r.iter().map(|&x| md.from_i64(x)).collect()).collect();
            let tm = Mat::from_rows(&rows, md);
            sagebrush_interrupt::check();
            let key = (key.clone(), p);
            // (the cache's lock is never held while computing: the
            // characteristic polynomial polls Stop, and an interrupt
            // unwinding through a held lock poisoned it, so every later use
            // of this cache panicked; astra2's report.  An entry is inserted
            // only once complete, so a lock poisoned elsewhere still guards
            // whole entries, and is taken over)
            let lock = || cache.lock().unwrap_or_else(|e| e.into_inner());
            let krylov_used = |c: &std::collections::HashMap<(K, u64), std::sync::Arc<ModData>>| -> usize {
                c.values().map(|e| e.krylov.as_ref().map_or(0, |k| k.len() * n)).sum()
            };
            let cached = lock().get(&key).cloned();
            let data = match cached {
                Some(f) => f,
                None => {
                    let used = krylov_used(&lock());
                    let krylov = if used + n * n <= budget {
                        let mut k = vec![u.clone()];
                        for _ in 1..n {
                            let next = tm.mul_vec(k.last().unwrap());
                            k.push(next);
                        }
                        Some(k)
                    } else {
                        None
                    };
                    let mut f = std::sync::Arc::new(ModData { charpoly: tm.charpoly(), krylov });
                    if budget > 0 {
                        let mut c = lock();
                        if let Some(g) = c.get(&key) {
                            // (computed meanwhile by another orbit's thread)
                            f = g.clone();
                        } else {
                            // (the budget again, as the cache is now: an
                            // optional Krylov table is dropped, never kept
                            // beyond the budget)
                            if f.krylov.is_some() && krylov_used(&c) + n * n > budget {
                                f = std::sync::Arc::new(ModData { charpoly: f.charpoly.clone(), krylov: None });
                            }
                            c.insert(key, f.clone());
                        }
                    }
                    f
                }
            };
            let full = &data.charpoly;
            let gm: Vec<u64> = g.iter().map(|c| md.from_i64(i64::try_from(&c.mod_floor(&BigInt::from(p))).unwrap())).collect();
            let (h, r) = nmod_poly::divrem(full.as_slice(), &gm, &md);
            if !nmod_poly::trim(r).is_empty() {
                return Err("the orbit's polynomial does not divide the characteristic polynomial".into());
            }
            // g must stay squarefree and prime to h modulo p
            let gd = nmod_poly::derivative(&gm, &md);
            if nmod_poly::degree(&nmod_poly::gcd(&gm, &nmod_poly::mul(&h, &gd, &md), &md)) > 0 {
                continue;
            }
            // the Krylov vectors T^i h(T) u (i < d): from the shared sequence
            // K_j = T^j u as sum_j h_j K_{i+j} (deg h + i < n), else by Horner
            let kry: Vec<Vec<u64>> = match &data.krylov {
                Some(ks) => (0..d)
                    .map(|i| {
                        let mut acc = vec![0u128; n];
                        let mut out = vec![0u64; n];
                        // this many products of residues below p fit in a u128
                        let batch = (u128::MAX / ((p as u128 - 1) * (p as u128 - 1))) as usize;
                        for (j, &c) in h.iter().enumerate() {
                            if c != 0 {
                                for (a, &x) in acc.iter_mut().zip(&ks[i + j]) {
                                    *a += c as u128 * x as u128;
                                }
                            }
                            if (j + 1) % batch == 0 {
                                for (o, a) in out.iter_mut().zip(acc.iter_mut()) {
                                    *o = md.add(*o, md.reduce_u128(*a));
                                    *a = 0;
                                }
                            }
                        }
                        for (o, a) in out.iter_mut().zip(acc.iter()) {
                            *o = md.add(*o, md.reduce_u128(*a));
                        }
                        out
                    })
                    .collect(),
                None => {
                    let mut v0 = vec![0u64; n];
                    for &c in h.iter().rev() {
                        let tv = tm.mul_vec(&v0);
                        for i in 0..n {
                            v0[i] = md.add(tv[i], md.mul(c, u[i] % p));
                        }
                    }
                    let mut kry: Vec<Vec<u64>> = vec![v0];
                    for _ in 1..d {
                        let next = tm.mul_vec(kry.last().unwrap());
                        kry.push(next);
                    }
                    kry
                }
            };
            let mut km = Mat::from_rows(&kry, md);
            let piv = km.rref();
            if piv.len() != d {
                continue; // an unlucky u or p
            }
            match &pivots {
                None => pivots = Some(piv.clone()),
                Some(q) if *q != piv => {
                    // a prime with a different echelon shape: start over
                    // with this one only if it is "earlier" (smaller pivots)
                    if piv < *q {
                        pivots = Some(piv.clone());
                        primes.clear();
                        residues.clear();
                        last = None;
                    } else {
                        continue;
                    }
                }
                _ => {}
            }
            primes.push(p);
            residues.push(km.row(0).to_vec());
            // reconstruct over Q
            let crt = MultiCrt::new(&primes);
            let m: BigInt = primes.iter().fold(BigInt::one(), |a, &q| a * BigInt::from(q));
            let bound = {
                // sqrt(m / 2)
                let mut b = BigInt::one();
                let half_bits = (m.bits() / 2).saturating_sub(1);
                b <<= half_bits as usize;
                b
            };
            let mut den = BigInt::one();
            let mut num: Vec<BigInt> = Vec::with_capacity(n);
            let mut ok = true;
            for i in 0..n {
                let x = crt.reconstruct(&residues.iter().map(|r| r[i]).collect::<Vec<u64>>());
                let y = (&x * &den).mod_floor(&m);
                match ratrecon(&y, &m, &bound, &(&bound / &den).max(BigInt::one())) {
                    Some((a, b)) => {
                        // x = a / (b den)
                        if !b.is_one() {
                            for z in num.iter_mut() {
                                *z *= &b;
                            }
                            den *= &b;
                        }
                        num.push(a);
                    }
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            // primitive integral representative
            let c = content(&num);
            if c.is_zero() {
                continue;
            }
            let w: Vec<BigInt> = num.iter().map(|z| z / &c).collect();
            if last.as_ref() != Some(&w) {
                last = Some(w);
                continue;
            }
            // stable for two rounds: verify g(T) w = 0 exactly
            let w = last.clone().unwrap();
            if std::env::var("HMF_EIGEN_DEBUG").is_ok() {
                eprintln!("orbit of degree {}: {} primes, max entry {} bits", d, primes.len(), w.iter().map(|x| x.bits()).max().unwrap_or(0));
            }
            let mut acc = vec![BigInt::zero(); n];
            for cg in g.iter().rev() {
                acc = matvec(t, &acc);
                for i in 0..n {
                    acc[i] += cg * &w[i];
                }
            }
            if acc.iter().any(|x| !x.is_zero()) {
                return Err("the reconstructed vector is not in ker g(T)".into());
            }
            // the exact Krylov basis and the inverse on the pivot coordinates
            let mut krylov = vec![w];
            for _ in 1..d {
                let next = matvec(t, krylov.last().unwrap());
                krylov.push(next);
            }
            let pv = pivots.unwrap();
            let a = ZMat::from_rows(pv.iter().map(|&r| (0..d).map(|j| krylov[j][r].clone()).collect()).collect());
            let (ainv, aden) = inverse(&a).ok_or("the Krylov vectors are dependent on the pivot coordinates")?;
            let lim = BigInt::one() << 62usize;
            let small = if krylov.iter().all(|w| w.iter().all(|x| x.abs() < lim)) {
                Some(krylov.iter().map(|w| w.iter().map(|x| i64::try_from(x).unwrap() as i128).collect()).collect())
            } else {
                None
            };
            return Ok(OrbitEigenspace { g, krylov, pivots: pv, ainv, aden, small });
        }
        Err("no usable primes".into())
    }
}

impl OrbitEigenspace {
    pub fn degree(&self) -> usize {
        self.g.len() - 1
    }

    /// a_P = c(theta) for the operator T_P (U_P if P divides the level),
    /// proven by the identity T_P v = sum_j c_j T^j v checked in integers.
    pub fn eigenvalue(&self, ns: &Newspaces, p: &Prime) -> Result<Eigenvalue, String> {
        self.eigenvalue_from(&*ns.hecke(&ns.level, p)?)
    }

    /// a_P = c(theta) for a Hecke operator with matrix t on M_2(N) (one that
    /// commutes with the separating operator), proven the same way.
    pub fn eigenvalue_from(&self, t: &crate::HeckeMatrix) -> Result<Eigenvalue, String> {
        if t.dim != self.krylov[0].len() {
            return Err("the Hecke matrix is of another space".into());
        }
        let n = self.krylov[0].len();
        let d = self.degree();
        // y = T_P v: in i128 when the Krylov basis is small (|v| < 2^62 and
        // the entries of T_P are at most N(P) + 1 < 2^31, so each y_i is far
        // below 2^127), else in big integers
        let y: Vec<BigInt> = match &self.small {
            Some(sm) => {
                let w = &sm[0];
                t.rows
                    .iter()
                    .map(|row| {
                        let mut acc: i128 = 0;
                        for &(j, c) in row {
                            acc += w[j as usize] * c as i128;
                        }
                        BigInt::from(acc)
                    })
                    .collect()
            }
            None => {
                let w = &self.krylov[0];
                t.rows
                    .iter()
                    .map(|row| {
                        let mut acc = BigInt::zero();
                        for &(j, c) in row {
                            acc += &w[j as usize] * &big(c as i64);
                        }
                        acc
                    })
                    .collect()
            }
        };
        // c = Ainv y[pivots] / aden
        let mut num: Vec<BigInt> = (0..d)
            .map(|j| {
                let mut s = BigInt::zero();
                for (r, &pr) in self.pivots.iter().enumerate() {
                    s += self.ainv.get(j, r) * &y[pr];
                }
                s
            })
            .collect();
        let mut den = self.aden.clone();
        let gcd = num.iter().fold(den.clone(), |a, x| a.gcd(x));
        if !gcd.is_one() && !gcd.is_zero() {
            for z in num.iter_mut() {
                *z = &*z / &gcd;
            }
            den = &den / &gcd;
        }
        if den.is_negative() {
            for z in num.iter_mut() {
                *z = -&*z;
            }
            den = -den;
        }
        // verify den y = sum_j num_j W_j on every coordinate: in checked i128
        // where everything fits, else in big integers
        let small_c: Option<(Vec<i128>, i128)> = match (&self.small, i64::try_from(&den)) {
            (Some(_), Ok(dd)) => num.iter().map(|z| i64::try_from(z).ok().map(|v| v as i128)).collect::<Option<Vec<i128>>>().map(|c| (c, dd as i128)),
            _ => None,
        };
        for i in 0..n {
            let fast = match (&self.small, &small_c, i64::try_from(&y[i])) {
                (Some(sm), Some((c, dd)), Ok(yi)) => {
                    let mut acc: Option<i128> = Some(0);
                    for j in 0..d {
                        acc = acc.and_then(|a| c[j].checked_mul(sm[j][i]).and_then(|x| a.checked_add(x)));
                    }
                    acc.and_then(|a| (yi as i128).checked_mul(*dd).map(|r| a == r))
                }
                _ => None,
            };
            let ok = match fast {
                Some(ok) => ok,
                None => {
                    let mut s = BigInt::zero();
                    for j in 0..d {
                        s += &num[j] * &self.krylov[j][i];
                    }
                    s == &y[i] * &den
                }
            };
            if !ok {
                return Err(format!("T_P v is not c(T) v at coordinate {}: not an eigenspace", i));
            }
        }
        Ok(Eigenvalue { num, den })
    }

    /// The characteristic polynomial over Q of c(theta) in K = Q[x]/(g),
    /// constant term first; it has integer coefficients (a_P is an algebraic
    /// integer), which is checked.
    pub fn charpoly_of(&self, a: &Eigenvalue) -> Result<Vec<BigInt>, String> {
        let d = self.degree();
        // multiplication by num(theta) on the basis theta^j, as integer columns
        let mulx = |v: &[BigInt]| -> Vec<BigInt> {
            // v * x mod g (g monic)
            let mut r = vec![BigInt::zero(); d];
            for k in 0..d - 1 {
                r[k + 1] = v[k].clone();
            }
            let top = &v[d - 1];
            for k in 0..d {
                r[k] -= top * &self.g[k];
            }
            r
        };
        let mut cols: Vec<Vec<BigInt>> = vec![];
        let mut cur: Vec<BigInt> = a.num.clone();
        for _ in 0..d {
            cols.push(cur.clone());
            cur = mulx(&cur);
        }
        let m = ZMat::from_rows((0..d).map(|i| (0..d).map(|j| cols[j][i].clone()).collect()).collect());
        let p = charpoly(&m);
        // charpoly of M / den: coefficient k is p_k / den^(d - k)
        let mut out = vec![];
        for (k, c) in p.iter().enumerate() {
            let q = a.den.pow((d - k) as u32);
            if !(c % &q).is_zero() {
                return Err("a_P is not an algebraic integer".into());
            }
            out.push(c / &q);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{Elt, Ideal};

    /// The shared Krylov sequences and the Horner evaluation give the same
    /// eigenspaces.
    #[test]
    fn krylov_and_horner_agree() {
        let ns = Newspaces::new(Ideal::principal(Elt::new(-5, 18)).unwrap()).unwrap();
        let o = ns.newform_orbits().unwrap();
        for k in 0..o.orbits.len() {
            let a = ns.orbit_eigenspace_with(&o, k, 0).unwrap();
            let b = ns.orbit_eigenspace(&o, k).unwrap();
            assert_eq!((a.krylov, a.pivots), (b.krylov, b.pivots));
        }
    }
}
