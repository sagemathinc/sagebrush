//! New subspaces, newform orbits and rational newforms.
//!
//! PSAGE took the new subspace to be the kernel of one degeneracy map per
//! prime p | N, which is too large when forms of level N/p occur twice
//! (degeneracy.rs). Here the newspace is described through the Hecke
//! algebra away from N, using two standard facts (Donnelly-Voight 2016,
//! section 2, properties (1)-(3), with Shemanske-Walling for multiplicity
//! one):
//!
//!   S_2(N) = sum over M | N of d(N/M) copies of S_2^new(M)
//!
//! as Hecke modules for the T_p, p not dividing N (d counts ideal
//! divisors), and the newforms of level N have distinct systems of
//! eigenvalues, differing from those of the oldforms. So:
//!
//! * dim S_2^new(N) follows from the dimensions at the divisors of N;
//! * the characteristic polynomial of a Hecke operator T on S_2^new(N) is its
//!   characteristic polynomial on M_2(N) divided by the Eisenstein factor
//!   and by those on S_2^new(M)^d(N/M), M | N, M != N. All are monic, so
//!   this is computed modulo word-size primes (division checked exact) and
//!   lifted by Chinese remaindering with a proven coefficient bound
//!   (eigenvalue_bound);
//! * for T = sum c_i T_(p_i) whose new characteristic polynomial g is
//!   squarefree and prime to the old part, the irreducible factors of g over
//!   Q are the Galois orbits of newforms (as Donnelly-Voight, section 2,
//!   choose a primitive element of the Hecke algebra), and a factor x - a
//!   is a rational newform whose eigenvector is ker(T - a) on M_2(N), a line
//!   over Q. Whether T separates is decided modulo the prime 2^61 - 1
//!   (coprimality of monic polynomials modulo a prime implies it over Q).
//!
//! For a rational newform with eigenvector w (T_p w = a_p w for all p not
//! dividing N), a_p = (T_p w)_i / w_i needs only row i of T_p (PSAGE's
//! "dual" aplist algorithm); w is computed modulo 2^61 - 1, where it is the
//! reduction of the rational eigenvector when the kernel modulo the prime
//! is a line (checked), and |a_p| <= N(p) + 1 < (2^61 - 1)/2 (T_p has
//! nonnegative entries and row sums N(p) + 1) makes the lift exact. The
//! Ramanujan bound |a_p| <= 2 sqrt(N(p)) (Blasius) is checked as a
//! consistency test. Every result here is proven, given the facts above; no
//! step is heuristic.

use crate::field::{primes_of_bounded_norm, Hnf, Ideal, Prime};
use crate::{HeckeMatrix, Space};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::nmod_poly;
use sagebrush_arith::crt::MultiCrt;
use sagebrush_arith::nmod::Primes;
use sagebrush_arith::zpoly;
use sagebrush_bigint::BigInt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The prime 2^61 - 1, for computations modulo a word-size prime.
pub const ELL: u64 = (1 << 61) - 1;

/// A Hecke operator sum c_i T_(p_i).
pub type HeckeOp = Vec<(Prime, i64)>;

/// The divisors M of N, each with d(N/M), the number of divisors of N/M.
pub fn divisors(n: &Ideal) -> Vec<(Ideal, usize)> {
    let mut out = vec![(vec![], 1usize)];
    for &(p, e) in &n.factors {
        let mut next = vec![];
        for (f, d) in &out {
            for k in 0..=e {
                let mut g: Vec<(Prime, u32)> = f.clone();
                if k > 0 {
                    g.push((p, k));
                }
                next.push((g, d * (e - k + 1) as usize));
            }
        }
        out = next;
    }
    out.into_iter().map(|(f, d)| (Ideal::from_factors(f), d)).collect()
}

fn big(x: i64) -> BigInt {
    BigInt::from(x)
}

/// The dense matrix of sum c_i T_(p_i) on M_2(N).
pub fn op_matrix(space: &Space, op: &HeckeOp) -> Result<Vec<Vec<i64>>, String> {
    op_matrix_with(space, op, &|p| space.hecke_matrix(p).map(Arc::new))
}

fn op_matrix_with(space: &Space, op: &HeckeOp, hecke: &dyn Fn(&Prime) -> Result<Arc<HeckeMatrix>, String>) -> Result<Vec<Vec<i64>>, String> {
    // every entry is at most L in absolute value (eigenvalue_bound); the
    // checked arithmetic below is a second guard
    eigenvalue_bound(op)?;
    let d = space.dimension();
    let mut m = vec![vec![0i64; d]; d];
    let overflow = || "a Hecke operator matrix entry overflows i64".to_string();
    for (p, c) in op {
        let t = hecke(p)?;
        for (i, row) in t.rows.iter().enumerate() {
            for &(j, n) in row {
                let e = &mut m[i][j as usize];
                *e = c.checked_mul(n as i64).and_then(|x| e.checked_add(x)).ok_or_else(overflow)?;
            }
        }
    }
    Ok(m)
}

/// The largest allowed eigenvalue bound L of a Hecke operator: matrix
/// entries, the Eisenstein eigenvalue and the differences x - a formed for
/// eigenvectors (|x|, |a| <= L) then all fit in i64.
pub const MAX_OP_BOUND: u128 = 1 << 61;

/// A bound L for the eigenvalues of sum c_i T_(p_i) on M_2, and for the
/// absolute values of its matrix entries: T_p has nonnegative entries and
/// row sums N(p) + 1, so L = sum |c_i| (N(p_i) + 1) bounds the row-sum norm,
/// hence every entry and every eigenvalue. Computed exactly; an Err if L
/// exceeds MAX_OP_BOUND (daybreak CORR-C4F-1), before any matrix,
/// modular or CRT work.
pub fn eigenvalue_bound(op: &HeckeOp) -> Result<i64, String> {
    let mut l: u128 = 0;
    for (p, c) in op {
        l += c.unsigned_abs() as u128 * (p.norm as u128 + 1);
        if l > MAX_OP_BOUND {
            return Err(format!("the Hecke operator's coefficients are too large: sum |c_P| (N(P) + 1) must be at most 2^61"));
        }
    }
    Ok(l as i64)
}

/// The Eisenstein eigenvalue sum c_i (N(p_i) + 1) of op, whose absolute value
/// is at most eigenvalue_bound(op).
fn eisenstein_eigenvalue(op: &HeckeOp) -> Result<i64, String> {
    eigenvalue_bound(op)?;
    Ok(op.iter().map(|(p, c)| c * (p.norm as i64 + 1)).sum())
}

/// Spaces and newspace data for all the divisors of a level, computed once.
pub struct Newspaces {
    pub level: Ideal,
    spaces: HashMap<Hnf, Space>,
    divisors: Vec<(Ideal, usize)>,
    /// Hecke matrices by (level, prime), computed once.
    hecke: Mutex<HashMap<(Hnf, Hnf), Arc<HeckeMatrix>>>,
    /// The newform orbits, computed once.
    orbits: Mutex<Option<NewformOrbits>>,
    /// Characteristic polynomials and Krylov sequences of operators on
    /// M_2(N) modulo word-size primes, by (operator, prime): shared by the
    /// orbits (eigen.rs).
    pub(crate) charpoly_mod: Mutex<HashMap<(Vec<(Hnf, i64)>, u64), Arc<crate::eigen::ModData>>>,
}

/// The characteristic polynomial of an operator on S_2^new(N), and its
/// eigenvalue on the Eisenstein series.
pub struct NewCharpoly {
    pub new: Vec<BigInt>,
    pub eisenstein: i64,
}

impl Newspaces {
    pub fn new(level: Ideal) -> Result<Newspaces, String> {
        let divisors = divisors(&level);
        let mut spaces = HashMap::new();
        for (m, _) in &divisors {
            spaces.insert(m.hnf, Space::from_ideal(m.clone())?);
        }
        Ok(Newspaces { level, spaces, divisors, hecke: Mutex::new(HashMap::new()), orbits: Mutex::new(None), charpoly_mod: Mutex::new(HashMap::new()) })
    }
    pub fn space(&self, m: &Ideal) -> &Space {
        &self.spaces[&m.hnf]
    }
    pub fn top(&self) -> &Space {
        self.space(&self.level)
    }

    /// The matrix of T_p (U_p if p divides M) on M_2(M), M | N, computed once.
    pub fn hecke(&self, m: &Ideal, p: &Prime) -> Result<Arc<HeckeMatrix>, String> {
        if let Some(t) = self.hecke.lock().unwrap().get(&(m.hnf, p.hnf)) {
            return Ok(t.clone());
        }
        let t = Arc::new(self.space(m).hecke_matrix(p)?);
        self.hecke.lock().unwrap().insert((m.hnf, p.hnf), t.clone());
        Ok(t)
    }

    /// The matrix of op on M_2(M), M | N, from cached Hecke matrices.
    pub fn op_matrix(&self, m: &Ideal, op: &HeckeOp) -> Result<Vec<Vec<i64>>, String> {
        op_matrix_with(self.space(m), op, &|p| self.hecke(m, p))
    }

    /// The characteristic polynomials modulo md of op on S_2^new(M), for
    /// every divisor M of N, and the old part at N (with the Eisenstein
    /// factor): divide the characteristic polynomial on M_2(M) by
    /// (x - e) prod over M' | M, M' != M of new(M')^d(M/M'). All are monic,
    /// so the division modulo md is exact and gives the reductions of the
    /// polynomials over Z.
    fn new_charpolys_mod(&self, op: &HeckeOp, md: Modulus) -> Result<(HashMap<Hnf, Vec<u64>>, Vec<u64>), String> {
        let eis = eisenstein_eigenvalue(op)?;
        let mut divs = self.divisors.clone();
        divs.sort_by_key(|(m, _)| m.norm());
        let mut new: HashMap<Hnf, Vec<u64>> = HashMap::new();
        let mut top_old = vec![];
        for (m, _) in &divs {
            let a = self.op_matrix(m, op)?;
            let rows: Vec<Vec<u64>> = a.iter().map(|r| r.iter().map(|&x| md.from_i64(x)).collect()).collect();
            let full = Mat::from_rows(&rows, md).charpoly();
            let mut old = vec![md.from_i64(-eis), 1];
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

    /// Whether op separates the newforms of level N, decided modulo ELL:
    /// the new characteristic polynomial modulo ELL is squarefree and prime
    /// to the old part and the Eisenstein factor. These polynomials are monic,
    /// so this implies the same over Q.
    fn separates_mod_ell(&self, op: &HeckeOp) -> Result<bool, String> {
        let md = Modulus::new(ELL);
        let (new, old) = self.new_charpolys_mod(op, md)?;
        let g = &new[&self.level.hnf];
        if nmod_poly::degree(g) <= 0 {
            return Ok(true);
        }
        let rest = nmod_poly::mul(&old, &nmod_poly::derivative(g, &md), &md);
        Ok(nmod_poly::degree(&nmod_poly::gcd(g, &rest, &md)) == 0)
    }

    /// dim S_2^new(M) for every divisor M of N.
    pub fn new_dimensions(&self) -> HashMap<Hnf, usize> {
        let mut nd: HashMap<Hnf, usize> = HashMap::new();
        let mut divs = self.divisors.clone();
        divs.sort_by_key(|(m, _)| m.norm());
        for (m, _) in &divs {
            // dim S(M) = sum over M' | M of d(M/M') new(M')
            let mut old = 0;
            for (m2, d) in divisors(m) {
                if m2.hnf != m.hnf {
                    old += d * nd[&m2.hnf];
                }
            }
            nd.insert(m.hnf, self.space(m).cusp_dimension() - old);
        }
        nd
    }

    pub fn new_dimension(&self) -> usize {
        self.new_dimensions()[&self.level.hnf]
    }

    /// The characteristic polynomial over Z of op (primes not dividing N)
    /// on S_2^new(M), for every divisor M of N: modulo enough word-size
    /// primes (new_charpolys_mod, in parallel), then Chinese remaindering.
    /// The number of primes is fixed in advance: every eigenvalue has
    /// absolute value at most L (eigenvalue_bound), so a coefficient of a
    /// polynomial of degree d is at most 2^d L^d.
    pub fn new_charpolys(&self, op: &HeckeOp) -> Result<HashMap<Hnf, NewCharpoly>, String> {
        if op.iter().any(|(p, _)| self.level.factors.iter().any(|(q, _)| q == p)) {
            return Err("the Hecke operator must involve only primes not dividing the level".into());
        }
        let eis = eisenstein_eigenvalue(op)?;
        let d = self.new_dimensions().values().copied().max().unwrap_or(0);
        let bits = d as f64 * (1.0 + (eigenvalue_bound(op)? as f64).max(1.0).log2()) + 2.0;
        let mut primes = vec![];
        let mut have = 0.0;
        for p in Primes::new() {
            primes.push(p);
            have += (p as f64).log2();
            if have > bits {
                break;
            }
        }
        let res: Vec<Result<HashMap<Hnf, Vec<u64>>, String>> = crate::par::map_range(primes.len(), |j| Ok(self.new_charpolys_mod(op, Modulus::new(primes[j]))?.0));
        let res: Vec<HashMap<Hnf, Vec<u64>>> = res.into_iter().collect::<Result<_, _>>()?;
        let crt = MultiCrt::new(&primes);
        let mut out = HashMap::new();
        for (m, _) in &self.divisors {
            let deg = res[0][&m.hnf].len();
            let new = (0..deg).map(|t| crt.reconstruct(&res.iter().map(|r| r[&m.hnf].get(t).copied().unwrap_or(0)).collect::<Vec<u64>>())).collect();
            out.insert(m.hnf, NewCharpoly { new, eisenstein: eis });
        }
        Ok(out)
    }

    /// The new characteristic polynomial of op at level N.
    pub fn new_charpoly(&self, op: &HeckeOp) -> Result<NewCharpoly, String> {
        Ok(self.new_charpolys(op)?.remove(&self.level.hnf).unwrap())
    }

    /// A Hecke operator separating the newforms of level N: its new
    /// characteristic polynomial is squarefree and prime to the old part and
    /// to the Eisenstein factor. Such operators exist (multiplicity one, and
    /// newforms differ from oldforms at infinitely many primes) and are
    /// generic; but quadratic twists agree at many small primes, so the
    /// candidates are T_p1, then pseudo-random combinations, with growing
    /// coefficients, of more and more primes not dividing N.
    pub fn separating_operator(&self) -> Result<(HeckeOp, NewCharpoly), String> {
        let primes: Vec<Prime> = primes_of_bounded_norm(2000).into_iter().filter(|p| self.level.factors.iter().all(|(q, _)| q != p)).take(16).collect();
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        // With many eigen-systems (levels divisible by high powers of 2 have
        // dozens of twists), a combination with small coefficients nearly
        // always has a collision between some pair; the range grows to 10^4
        // (small coefficients first: they keep the exact charpoly small).
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
            if self.separates_mod_ell(&op)? {
                let cp = self.new_charpoly(&op)?;
                debug_assert!(cp.new.len() <= 1 || zpoly::gcd(&cp.new, &derivative(&cp.new)).len() == 1);
                return Ok((op, cp));
            }
        }
        Err("no separating Hecke operator found".into())
    }

    /// The Galois orbits of newforms of level N: the irreducible factors over
    /// Q (degree = dimension of the orbit) of the new characteristic
    /// polynomial of a separating operator, sorted by degree.
    pub fn newform_orbits(&self) -> Result<NewformOrbits, String> {
        if let Some(o) = self.orbits.lock().unwrap().as_ref() {
            return Ok(o.clone());
        }
        let o = self.compute_newform_orbits()?;
        *self.orbits.lock().unwrap() = Some(o.clone());
        Ok(o)
    }

    fn compute_newform_orbits(&self) -> Result<NewformOrbits, String> {
        let (op, cp) = self.separating_operator()?;
        let factors = if cp.new.len() <= 1 { vec![] } else { sagebrush_poly::try_factor(&cp.new).map_err(|e| e.to_string())?.1 };
        let orbits: Vec<Vec<BigInt>> = factors.into_iter().map(|(g, e)| {
            debug_assert_eq!(e, 1);
            g
        }).collect();
        Ok(NewformOrbits { op, orbits })
    }

    /// The rational newforms of level N, each with its eigenvector in M_2(N).
    pub fn rational_newforms(&self) -> Result<Vec<RationalNewform>, String> {
        let orbits = self.newform_orbits()?;
        self.rational_newforms_of(&orbits)
    }

    /// The rational newforms among the given orbits. For a factor x - a of
    /// the new characteristic polynomial of the separating operator T, the
    /// eigenvector is ker(T - a) on M_2(N), a line over Q; it is computed
    /// modulo ELL, which is its reduction whenever the kernel modulo ELL is
    /// also a line (checked). Then a_p = (T_p w)_i / w_i modulo ELL, and
    /// |a_p| <= N(p) + 1 < ELL/2 makes the lift exact.
    pub fn rational_newforms_of(&self, orbits: &NewformOrbits) -> Result<Vec<RationalNewform>, String> {
        let md = Modulus::new(ELL);
        let t = self.op_matrix(&self.level, &orbits.op)?;
        let mut out = vec![];
        for g in orbits.orbits.iter().filter(|g| g.len() == 2) {
            // g = g0 + x (primitive with positive leading coefficient)
            // a is an eigenvalue of the operator, so |a| <= L <= 2^61
            let l = eigenvalue_bound(&orbits.op)?;
            let a = i64::try_from(&(-&g[0])).ok().filter(|a| a.unsigned_abs() <= l as u64).ok_or("eigenvalue out of range")?;
            let rows: Vec<Vec<u64>> = t
                .iter()
                .enumerate()
                .map(|(i, r)| r.iter().enumerate().map(|(j, &x)| md.from_i64(if i == j { x.checked_sub(a).expect("|x|, |a| <= 2^61") } else { x })).collect())
                .collect();
            let k = Mat::from_rows(&rows, md).nullspace();
            if k.rows != 1 {
                return Err(format!("eigenspace of dimension {} modulo ELL for a rational newform", k.rows));
            }
            let w: Vec<u64> = k.row(0).to_vec();
            let i = w.iter().position(|&x| x != 0).unwrap();
            out.push(RationalNewform { level: self.level.clone(), op_eigenvalue: a, w, i });
        }
        Ok(out)
    }
}

fn derivative(f: &[BigInt]) -> Vec<BigInt> {
    if f.len() <= 1 {
        return vec![big(0)];
    }
    zpoly::trim(f.iter().enumerate().skip(1).map(|(k, c)| c * &big(k as i64)).collect())
}

/// The a_p of several rational newforms of the same level, for all primes
/// of norm at most bound (as RationalNewform::aplist), computing the action
/// of each T_p (U_p for p dividing the level) once for all of them, primes
/// in parallel.
pub fn aplists(space: &Space, forms: &[RationalNewform], bound: u64) -> Result<Vec<Vec<(Prime, i64)>>, String> {
    let primes = primes_of_bounded_norm(bound);
    let rows: Vec<usize> = forms.iter().map(|f| f.i).collect();
    let per_prime: Vec<Result<Vec<i64>, String>> = crate::par::map_range(primes.len(), |k| {
        let p = &primes[k];
        let rs = space.hecke_rows(p, &rows)?;
        forms.iter().zip(&rs).map(|(f, r)| f.ap_from_row(p, r)).collect()
    });
    let per_prime: Vec<Vec<i64>> = per_prime.into_iter().collect::<Result<_, _>>()?;
    Ok((0..forms.len()).map(|t| primes.iter().zip(&per_prime).map(|(p, v)| (*p, v[t])).collect()).collect())
}

#[derive(Clone, Debug)]
pub struct NewformOrbits {
    /// The separating operator used.
    pub op: HeckeOp,
    /// The characteristic polynomial over Q of op on each orbit (constant
    /// term first), irreducible; its degree is the orbit's dimension.
    pub orbits: Vec<Vec<BigInt>>,
}

impl NewformOrbits {
    pub fn dimensions(&self) -> Vec<usize> {
        self.orbits.iter().map(|g| g.len() - 1).collect()
    }
}

/// A newform with rational Hecke eigenvalues (conjecturally an isogeny
/// class of elliptic curves over F with conductor the level).
pub struct RationalNewform {
    pub level: Ideal,
    /// Its eigenvalue for the separating operator.
    pub op_eigenvalue: i64,
    /// Its eigenvector in M_2(N) (T_p w = a_p w), modulo ELL.
    pub w: Vec<u64>,
    /// A coordinate with w_i != 0.
    pub i: usize,
}

impl RationalNewform {
    /// a_p for a prime p: (T_p w)_i / w_i from row i of T_p alone, where
    /// T_p is U_p if p divides the level. The eigenvector w of the separating
    /// operator spans a joint eigenspace of the T_q (q not dividing N) of
    /// dimension one (multiplicity one), which U_p preserves since it
    /// commutes with them; so w is an eigenvector of U_p too.
    pub fn ap(&self, space: &Space, p: &Prime) -> Result<i64, String> {
        self.ap_from_row(p, &space.hecke_row(p, self.i)?)
    }

    /// a_p from row i of T_p (U_p if p divides the level). Checked: the
    /// Ramanujan bound |a_p| <= 2 sqrt(N(p)) for p not dividing N; for p
    /// dividing N, a_p = +-1 if p exactly divides N and a_p = 0 if p^2 does,
    /// as for every newform of weight 2 with trivial character.
    pub fn ap_from_row(&self, p: &Prime, row: &[(u32, u32)]) -> Result<i64, String> {
        let md = Modulus::new(ELL);
        let mut s = 0u64;
        for &(j, n) in row {
            s = md.add(s, md.mul(self.w[j as usize], n as u64));
        }
        let x = md.mul(s, md.inv(self.w[self.i]).unwrap());
        let a = if x > ELL / 2 { x as i64 - ELL as i64 } else { x as i64 };
        let e = self.level.factors.iter().find(|(q, _)| q == p).map_or(0, |(_, e)| *e);
        let ok = match e {
            0 => (a as i128 * a as i128) <= 4 * p.norm as i128,
            1 => a == 1 || a == -1,
            _ => a == 0,
        };
        if !ok {
            return Err(format!("a_p = {} modulo ELL at N(p) = {} (p^{} || N) is impossible for a newform: not an eigenvector", a, p.norm, e));
        }
        Ok(a)
    }

    /// a_p for all primes of norm at most bound, in the order of
    /// primes_of_bounded_norm (the eigenvalues of U_p at primes dividing the
    /// level: -1 times the Atkin-Lehner eigenvalue where p exactly divides
    /// it, 0 where p^2 does).
    pub fn aplist(&self, space: &Space, bound: u64) -> Result<Vec<(Prime, i64)>, String> {
        primes_of_bounded_norm(bound).into_iter().map(|p| Ok((p, self.ap(space, &p)?))).collect()
    }
}
