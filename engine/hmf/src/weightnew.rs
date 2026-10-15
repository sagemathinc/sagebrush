//! Newspaces, newform orbits and Hecke eigenvalues in weight k != (2, 2)
//! (weight.rs), as newspace.rs and eigen.rs do in weight 2, over F.
//!
//! * S_k(N) = sum over M | N of d(N/M) copies of S_k^new(M) as modules for
//!   the T_p, p not dividing N (Atkin-Lehner theory for Hilbert modular
//!   forms: Shemanske-Walling; as cited in newspace.rs), M = (1) included
//!   (there are forms of level one in higher weight). There is no
//!   Eisenstein part.
//! * The Hecke operators are matrices over F with characteristic
//!   polynomials in O_F[x] (they preserve the integral lattice of
//!   polynomials, weight.rs). These are computed modulo pairs of conjugate
//!   degree-one primes and recovered (fpoly.rs) with a proven bound: every
//!   u in Theta(p) acts on L_k with operator norm N(p)^(mu/2) for an
//!   invariant hermitian norm (u = sqrt(pi) times a unitary under each real
//!   embedding, and v + m/2 = mu/2), so for the sup norm over P^1 the
//!   operator T_p (N(p) + 1 terms) has norm at most (N(p) + 1) N(p)^(mu/2),
//!   and U_p (N(p) terms) at most N(p)^(1 + mu/2). This holds under both
//!   embeddings of F, which exchange (k1, k2).
//! * A separating operator T (its new characteristic polynomial squarefree
//!   and prime to the old part, decided modulo a prime of F: monic
//!   polynomials) gives the Galois orbits of newforms over F: the
//!   irreducible factors g over F of its new characteristic polynomial.
//! * For an orbit g, V_g = ker g(T) is a cyclic F[T]-module, every T_p (U_p
//!   for p dividing N) acts on it as c(T), and the newforms of the orbit
//!   have a_p = c(theta), theta running over the roots of g. The
//!   characteristic polynomial of a_p over the orbit, prod (x - c(theta)),
//!   is computed modulo each place from the Krylov basis of V_g (as in
//!   eigen.rs, where the conditions for the reduction to be faithful are
//!   explained) and recovered over O_F with the bound above. For an orbit
//!   of degree one this is x - a_p, a_p in O_F.
//! * The eigenvalues themselves, exactly: a_p = h(theta)/g'(theta) with h in
//!   O_F[x] of degree < d. Since a_p is an algebraic integer, g'(theta) a_p
//!   lies in O_F[theta]: by Euler's lemma the trace dual of O_F[theta] is
//!   g'(theta)^-1 O_F[theta] (Serre, "Local Fields", III.6, Lemma 2), and
//!   it contains the integers of K = F(theta), whose traces are integral;
//!   and by Lagrange interpolation h = sum_i a_p(f_i) prod_(j != i)
//!   (x - theta_j), so under every embedding the coefficients of h are at
//!   most d B (1 + R)^(d - 1), with B the bound for a_p and R that for the
//!   roots of g (the separating operator's bound). Modulo each faithful
//!   place, h = g' c modulo g.

use crate::field::{primes_of_bounded_norm, Hnf, Ideal, Prime};
use crate::fpoly::{self, coefficient_bits, pairs_for_bits, FPoly, PairCrt};
use crate::newspace::{divisors, HeckeOp};
use crate::weight::{place_pairs, Place, Weight, WeightSpace};
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::nmod_poly;
use std::collections::HashMap;
use std::sync::Mutex;

/// The newform orbits of a level: the separating operator and the
/// characteristic polynomial over F of it on each orbit (irreducible over F,
/// its degree is the orbit's dimension over F).
#[derive(Clone, Debug)]
pub struct WeightOrbits {
    pub op: HeckeOp,
    pub orbits: Vec<FPoly>,
}

pub struct WeightNewspaces {
    pub level: Ideal,
    pub weight: Weight,
    spaces: HashMap<Hnf, WeightSpace>,
    divisors: Vec<(Ideal, usize)>,
    orbits: Mutex<Option<WeightOrbits>>,
}

/// A bound for the absolute values of the eigenvalues of T_p (U_p if p
/// divides the level) in weight k, under every embedding.
pub fn hecke_bound(w: &Weight, p: &Prime, level: &Ideal) -> f64 {
    let n = p.norm as f64;
    let terms = if level.factors.iter().any(|(q, _)| q == p) { n } else { n + 1.0 };
    terms * n.powf(w.mu() as f64 / 2.0)
}

impl WeightNewspaces {
    pub fn new(level: Ideal, weight: Weight) -> Result<WeightNewspaces, String> {
        let divisors = divisors(&level);
        let mut spaces = HashMap::new();
        for (m, _) in &divisors {
            spaces.insert(m.hnf, WeightSpace::new(m.clone(), weight)?);
        }
        Ok(WeightNewspaces { level, weight, spaces, divisors, orbits: Mutex::new(None) })
    }
    pub fn space(&self, m: &Ideal) -> &WeightSpace {
        &self.spaces[&m.hnf]
    }
    pub fn top(&self) -> &WeightSpace {
        self.space(&self.level)
    }

    fn sorted_divisors(&self) -> Vec<(Ideal, usize)> {
        let mut divs = self.divisors.clone();
        divs.sort_by_key(|(m, _)| m.norm());
        divs
    }

    /// dim S_k^new(M) for every divisor M of N.
    pub fn new_dimensions(&self) -> Result<HashMap<Hnf, usize>, String> {
        let mut nd: HashMap<Hnf, usize> = HashMap::new();
        for (m, _) in &self.sorted_divisors() {
            let mut old = 0;
            for (m2, d) in divisors(m) {
                if m2.hnf != m.hnf {
                    old += d * nd[&m2.hnf];
                }
            }
            let full = self.space(m).dimension();
            nd.insert(m.hnf, full.checked_sub(old).ok_or("the old part is larger than the space")?);
        }
        Ok(nd)
    }

    pub fn new_dimension(&self) -> Result<usize, String> {
        Ok(self.new_dimensions()?[&self.level.hnf])
    }

    /// A bound for the eigenvalues of op on S_k(M), M | N, under every
    /// embedding (op involves only primes not dividing N, or the level's
    /// U_p at level N).
    pub fn op_bound(&self, op: &HeckeOp) -> f64 {
        op.iter().map(|(p, c)| c.unsigned_abs() as f64 * hecke_bound(&self.weight, p, &self.level)).sum()
    }

    /// The matrix of op on S_k(M) at the place pl.
    pub fn op_mod(&self, m: &Ideal, op: &HeckeOp, pl: &Place) -> Result<Mat, String> {
        let md = pl.md;
        let s = self.space(m);
        let n = s.dimension();
        let mut out = Mat::zero(n, n, md);
        for (p, c) in op {
            let t = s.hecke_mod(p, pl)?;
            let c = md.from_i64(*c);
            for i in 0..n {
                for j in 0..n {
                    out.set(i, j, md.add(out.get(i, j), md.mul(c, t.get(i, j))));
                }
            }
        }
        Ok(out)
    }

    /// The characteristic polynomials of op on S_k^new(M) at the place, for
    /// every divisor M of N, and the old part at N (as in newspace.rs).
    fn new_charpolys_mod(&self, op: &HeckeOp, pl: &Place) -> Result<(HashMap<Hnf, Vec<u64>>, Vec<u64>), String> {
        let md = pl.md;
        let mut new: HashMap<Hnf, Vec<u64>> = HashMap::new();
        let mut top_old = vec![1];
        for (m, _) in &self.sorted_divisors() {
            let full = self.op_mod(m, op, pl)?.charpoly();
            let mut old = vec![1u64];
            for (m2, d) in divisors(m) {
                if m2.hnf != m.hnf {
                    for _ in 0..d {
                        old = nmod_poly::mul(&old, &new[&m2.hnf], &md);
                    }
                }
            }
            let (q, r) = nmod_poly::divrem(&full, &old, &md);
            if !nmod_poly::trim(r).is_empty() {
                return Err("old part does not divide the characteristic polynomial".into());
            }
            if m.hnf == self.level.hnf {
                top_old = old;
            }
            new.insert(m.hnf, nmod_poly::trim(q));
        }
        Ok((new, top_old))
    }

    fn check_op(&self, op: &HeckeOp) -> Result<(), String> {
        if op.iter().any(|(p, _)| self.level.factors.iter().any(|(q, _)| q == p)) {
            return Err("the Hecke operator must involve only primes not dividing the level".into());
        }
        Ok(())
    }

    /// The characteristic polynomial over O_F of op on S_k^new(M), for every
    /// divisor M of N.
    pub fn new_charpolys(&self, op: &HeckeOp) -> Result<HashMap<Hnf, FPoly>, String> {
        self.check_op(op)?;
        let nd = self.new_dimensions()?;
        let d = nd.values().copied().max().unwrap_or(0);
        let pairs = pairs_for_bits(coefficient_bits(d, self.op_bound(op)));
        let res: Vec<Result<(HashMap<Hnf, Vec<u64>>, HashMap<Hnf, Vec<u64>>), String>> = crate::par::map_range(pairs.len(), |k| {
            Ok((self.new_charpolys_mod(op, &pairs[k].0)?.0, self.new_charpolys_mod(op, &pairs[k].1)?.0))
        });
        let res: Vec<(HashMap<Hnf, Vec<u64>>, HashMap<Hnf, Vec<u64>>)> = res.into_iter().collect::<Result<_, _>>()?;
        let crt = PairCrt::new(&pairs);
        let mut out = HashMap::new();
        for (m, _) in &self.divisors {
            let deg = nd[&m.hnf];
            let get = |v: &Vec<u64>, t: usize| v.get(t).copied().unwrap_or(0);
            let f: FPoly = (0..=deg).map(|t| crt.reconstruct(&res.iter().map(|(a, b)| (get(&a[&m.hnf], t), get(&b[&m.hnf], t))).collect::<Vec<_>>())).collect();
            out.insert(m.hnf, f);
        }
        Ok(out)
    }

    pub fn new_charpoly(&self, op: &HeckeOp) -> Result<FPoly, String> {
        Ok(self.new_charpolys(op)?.remove(&self.level.hnf).unwrap())
    }

    /// The characteristic polynomial over O_F of T_p (U_p if p divides N)
    /// on all of S_k(N).
    pub fn hecke_charpoly(&self, p: &Prime) -> Result<FPoly, String> {
        let n = self.top().dimension();
        let pairs = pairs_for_bits(coefficient_bits(n, hecke_bound(&self.weight, p, &self.level)));
        let res: Vec<Result<(Vec<u64>, Vec<u64>), String>> = crate::par::map_range(pairs.len(), |k| {
            let s = self.top();
            Ok((s.hecke_mod(p, &pairs[k].0)?.charpoly(), s.hecke_mod(p, &pairs[k].1)?.charpoly()))
        });
        let res: Vec<(Vec<u64>, Vec<u64>)> = res.into_iter().collect::<Result<_, _>>()?;
        let crt = PairCrt::new(&pairs);
        Ok((0..=n).map(|t| crt.reconstruct(&res.iter().map(|(a, b)| (a[t], b[t])).collect::<Vec<_>>())).collect())
    }

    /// Whether op separates the newforms of level N, decided at one place:
    /// the new characteristic polynomial is squarefree and prime to the old
    /// part there, hence over F (they are monic).
    fn separates(&self, op: &HeckeOp, pl: &Place) -> Result<bool, String> {
        let md = pl.md;
        let (new, old) = self.new_charpolys_mod(op, pl)?;
        let g = &new[&self.level.hnf];
        if nmod_poly::degree(g) <= 0 {
            return Ok(true);
        }
        let rest = nmod_poly::mul(&old, &nmod_poly::derivative(g, &md), &md);
        Ok(nmod_poly::degree(&nmod_poly::gcd(g, &rest, &md)) == 0)
    }

    /// A separating operator, by the search of newspace.rs.
    pub fn separating_operator(&self) -> Result<(HeckeOp, FPoly), String> {
        let primes: Vec<Prime> = primes_of_bounded_norm(2000).into_iter().filter(|p| self.level.factors.iter().all(|(q, _)| q != p)).take(16).collect();
        let pl = place_pairs().next().unwrap().0;
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for attempt in 0..48usize {
            let k = (1 + attempt).min(primes.len());
            let range = [9u64, 101, 1001, 20001][(attempt / 4).min(3)];
            let op: HeckeOp = (0..k)
                .map(|t| {
                    let c = if t == 0 { 1 } else { (next() % range) as i64 - (range / 2) as i64 };
                    (primes[t], c)
                })
                .filter(|&(_, c)| c != 0)
                .collect();
            if self.separates(&op, &pl)? {
                let cp = self.new_charpoly(&op)?;
                return Ok((op, cp));
            }
        }
        Err("no separating Hecke operator found".into())
    }

    /// The Galois orbits over F of the newforms of level N, sorted by
    /// degree.
    pub fn newform_orbits(&self) -> Result<WeightOrbits, String> {
        if let Some(o) = self.orbits.lock().unwrap().as_ref() {
            return Ok(o.clone());
        }
        let (op, cp) = self.separating_operator()?;
        let orbits = fpoly::factor_squarefree(&cp, self.op_bound(&op))?;
        let o = WeightOrbits { op, orbits };
        *self.orbits.lock().unwrap() = Some(o.clone());
        Ok(o)
    }

    /// For each orbit and each prime p in `primes`, the characteristic
    /// polynomial over O_F of a_p on the orbit, prod (x - a_p(f)) over its
    /// newforms f (T_p, or U_p for p dividing N).
    pub fn orbit_charpolys(&self, orbits: &WeightOrbits, primes: &[Prime]) -> Result<Vec<Vec<FPoly>>, String> {
        Ok(self.orbit_data(orbits, primes)?.0)
    }

    /// For each orbit g and each prime p in `primes`, h in O_F[x] of degree
    /// < deg g with a_p = h(theta)/g'(theta) on the newform with eigenvalue
    /// theta for the separating operator (module documentation).
    pub fn orbit_eigenvalues(&self, orbits: &WeightOrbits, primes: &[Prime]) -> Result<Vec<Vec<FPoly>>, String> {
        Ok(self.orbit_data(orbits, primes)?.1)
    }

    /// orbit_charpolys and orbit_eigenvalues together.
    #[allow(clippy::type_complexity)]
    pub fn orbit_data(&self, orbits: &WeightOrbits, primes: &[Prime]) -> Result<(Vec<Vec<FPoly>>, Vec<Vec<FPoly>>), String> {
        let r = self.op_bound(&orbits.op);
        let mut bits: f64 = 0.0;
        for g in &orbits.orbits {
            let d = g.len() - 1;
            for p in primes {
                let b = hecke_bound(&self.weight, p, &self.level);
                bits = bits.max(coefficient_bits(d, b));
                bits = bits.max((d as f64 * b).log2() + (d as f64 - 1.0) * (1.0 + r).log2() + 1.0);
            }
        }
        // places where the reductions are faithful, enough of them
        type Res = Vec<Vec<(Vec<u64>, Vec<u64>)>>;
        let mut kept: Vec<((Place, Place), Res, Res)> = vec![];
        let mut have = 0.0;
        for (tries, pp) in place_pairs().enumerate() {
            if tries > 400 {
                return Err("too many unusable places".into());
            }
            let (Some(a), Some(b)) = (self.orbit_charpolys_mod(orbits, primes, &pp.0)?, self.orbit_charpolys_mod(orbits, primes, &pp.1)?) else {
                continue;
            };
            have += (pp.0.p() as f64).log2();
            kept.push((pp, a, b));
            if have > bits + 2.0 {
                break;
            }
        }
        let pairs: Vec<(Place, Place)> = kept.iter().map(|(pp, _, _)| *pp).collect();
        let crt = PairCrt::new(&pairs);
        let mut cps = vec![];
        let mut hs = vec![];
        for (k, g) in orbits.orbits.iter().enumerate() {
            let d = g.len() - 1;
            let mut row = vec![];
            let mut hrow = vec![];
            for t in 0..primes.len() {
                row.push((0..=d).map(|i| crt.reconstruct(&kept.iter().map(|(_, a, b)| (a[k][t].0[i], b[k][t].0[i])).collect::<Vec<_>>())).collect());
                let at = |v: &Vec<u64>, i: usize| v.get(i).copied().unwrap_or(0);
                hrow.push(fpoly::trim((0..d).map(|i| crt.reconstruct(&kept.iter().map(|(_, a, b)| (at(&a[k][t].1, i), at(&b[k][t].1, i))).collect::<Vec<_>>())).collect()));
            }
            cps.push(row);
            hs.push(hrow);
        }
        Ok((cps, hs))
    }

    /// orbit_charpolys at one place, or None if the place is unusable (g
    /// not squarefree or not prime to its cofactor there, or Krylov vectors
    /// dependent).
    #[allow(clippy::type_complexity)]
    fn orbit_charpolys_mod(&self, orbits: &WeightOrbits, primes: &[Prime], pl: &Place) -> Result<Option<Vec<Vec<(Vec<u64>, Vec<u64>)>>>, String> {
        let md = pl.md;
        let t = self.op_mod(&self.level, &orbits.op, pl)?;
        let n = t.rows;
        let full = t.charpoly();
        // the Krylov sequence K_j = T^j u, j < n
        let p = pl.p();
        let u: Vec<u64> = (0..n as u64).map(|i| (i * i + 7 * i + 3 + (p % 1009) * (2 * i + 1)) % 1009 + 1).collect();
        let mut ks = vec![u];
        for _ in 1..n {
            let next = t.mul_vec(ks.last().unwrap());
            ks.push(next);
        }
        let tps: Vec<Mat> = primes.iter().map(|q| self.top().hecke_mod(q, pl)).collect::<Result<_, _>>()?;
        let mut out = vec![];
        for g in &orbits.orbits {
            let gm = fpoly::reduce(g, pl);
            let d = g.len() - 1;
            let (h, r) = nmod_poly::divrem(&full, &gm, &md);
            if !nmod_poly::trim(r).is_empty() {
                return Err("an orbit's polynomial does not divide the characteristic polynomial".into());
            }
            let gd = nmod_poly::derivative(&gm, &md);
            if nmod_poly::degree(&nmod_poly::gcd(&gm, &nmod_poly::mul(&h, &gd, &md), &md)) > 0 {
                return Ok(None);
            }
            // W_i = T^i h(T) u = sum_j h_j K_(i+j)
            let w: Vec<Vec<u64>> = (0..d)
                .map(|i| {
                    let mut v = vec![0u64; n];
                    for (j, &c) in h.iter().enumerate() {
                        if c != 0 {
                            for (x, &k) in v.iter_mut().zip(&ks[i + j]) {
                                *x = md.add(*x, md.mul(c, k));
                            }
                        }
                    }
                    v
                })
                .collect();
            let mut e = Mat::from_rows(&w, md);
            let piv = e.rref();
            if piv.len() != d {
                return Ok(None);
            }
            let a = Mat::from_rows(&piv.iter().map(|&r| (0..d).map(|j| w[j][r]).collect()).collect::<Vec<_>>(), md);
            let ainv = a.inverse().ok_or("singular Krylov block")?;
            let mut per_p = vec![];
            for tp in &tps {
                let y = tp.mul_vec(&w[0]);
                let yp: Vec<u64> = piv.iter().map(|&r| y[r]).collect();
                let c = ainv.mul_vec(&yp);
                // T_p W_0 = sum c_j W_j on every coordinate
                for i in 0..n {
                    let s = (0..d).fold(0u64, |acc, j| md.add(acc, md.mul(c[j], w[j][i])));
                    if s != y[i] {
                        return Err("T_p does not preserve the orbit's eigenspace".into());
                    }
                }
                // the matrix of multiplication by c(theta) on F_p[x]/(g)
                let cols: Vec<Vec<u64>> = (0..d)
                    .map(|j| {
                        let mut xj = vec![0u64; j + 1];
                        xj[j] = 1;
                        let prod = nmod_poly::rem(&nmod_poly::mul(&c, &xj, &md), &gm, &md);
                        (0..d).map(|i| prod.get(i).copied().unwrap_or(0)).collect()
                    })
                    .collect();
                let m = Mat::from_rows(&cols, md).transpose();
                // h = g' c modulo g
                let h = nmod_poly::rem(&nmod_poly::mul(&gd, &c, &md), &gm, &md);
                per_p.push((m.charpoly(), h));
            }
            out.push(per_p);
        }
        Ok(Some(out))
    }
}
