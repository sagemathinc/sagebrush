//! New subspaces, Galois orbits of newforms and their Hecke eigenvalues for
//! Hilbert modular forms of parallel weight 2 over any real quadratic field
//! (definite.rs): the methods of newspace.rs and eigen.rs (over Q(sqrt 5)),
//! with the Eisenstein part of a field of narrow class number h+.
//!
//! - The new part (Donnelly-Voight 2016, section 2, with Shemanske-Walling
//!   for multiplicity one): S_2(N) is the sum over M | N of d(N/M) copies of
//!   S_2^new(M) as a module for the T_P, P not dividing N (d counts ideal
//!   divisors), and newforms of level N have distinct systems of
//!   eigenvalues, different from those of the oldforms. So the
//!   characteristic polynomial of an operator T = sum c_i T_(P_i) on
//!   S_2^new(N) is that on M_2^B(N) divided by the Eisenstein factor and by
//!   those on S_2^new(M)^d(N/M), M | N, M != N.
//! - The Eisenstein part of M_2^B(M) is the functions that factor through
//!   nrd to Cl+(F) (D = 1), spanned by the indicators e_c of the narrow
//!   classes c. T maps e_c to a combination of the e_c' (T_P moves the
//!   narrow class of nrd by [P] and has N(P) + 1 terms). Its matrix there
//!   (an h+ x h+ block, read off the matrix of T and checked to be constant
//!   on each class) gives the Eisenstein factor exactly.
//! - These polynomials are monic, so they are computed modulo word-size
//!   primes (divisions checked exact) and lifted by Chinese remaindering with
//!   the coefficient bound of newspace.rs (eigenvalue_bound). A T whose new
//!   characteristic polynomial is squarefree and prime to the old part and
//!   the Eisenstein factor separates the newforms (decided modulo 2^61 - 1):
//!   its irreducible factors over Q are the Galois orbits of newforms.
//! - The eigenvalue of T_P (U_P for P dividing N) on an orbit is c(theta) in
//!   K = Q[x]/(g), by the Krylov method of eigen.rs (shared code), each one
//!   proven by an identity checked in integers. (U_P eigenvalues where P
//!   exactly divides N need not be +-1 when P is not narrowly principal.)
//!
//! All results are proven, given the facts cited; nothing is heuristic.

use crate::definite::{divisor_census, divisors, DefiniteSpace, MAX_HECKE_TERMS, MAX_TOTAL_POINTS};
use crate::quatalg::BElt;
use crate::eigen::{orbit_eigenspace_core, Eigenvalue, ModData, OrbitEigenspace};
use crate::classes::ClassSet;
use crate::newspace::{ELL, MAX_OP_BOUND};
use crate::quatalg::MaximalOrder;
use crate::rqf::{QElt, QIdeal, QPrime, QuadField};
use crate::HeckeMatrix;
use sagebrush_arith::crt::MultiCrt;
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::nmod_poly;
use sagebrush_arith::zmat::{charpoly, ZMat};
use sagebrush_bigint::BigInt;
use num_traits::ToPrimitive;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A Hecke operator sum c_i T_(P_i).
pub type Op = Vec<(QPrime, i64)>;

/// The most modular work of the characteristic polynomials of one request,
/// in multiply-adds: a dense characteristic polynomial modulo a prime costs
/// about dim^3 per divisor space (measured at 1.6 ns per dim^3 natively,
/// dimensions 200 to 1252), so about 15 s at the limit. Checked before
/// new_charpoly's primes are used, and cumulatively over the attempts of
/// the separating-operator search (daybreak HARD-3AE-4).
pub const MAX_MODULAR_WORK: u128 = 1 << 33;

type OpKey = Vec<((i128, i128, i128), i64)>;

fn key(op: &Op) -> OpKey {
    op.iter().map(|(p, c)| (p.ideal.hnf(), *c)).collect()
}

/// A bound L for the eigenvalues and the matrix entries of op (as
/// newspace::eigenvalue_bound): sum |c_i| (N(P_i) + 1), at most 2^61.
pub fn eigenvalue_bound(op: &Op) -> Result<i64, String> {
    let mut l: u128 = 0;
    for (p, c) in op {
        l += c.unsigned_abs() as u128 * (p.norm as u128 + 1);
        if l > MAX_OP_BOUND {
            return Err("the Hecke operator's coefficients are too large: sum |c_P| (N(P) + 1) must be at most 2^61".into());
        }
    }
    Ok(l as i64)
}

/// c modulo md.
fn reduce(c: &BigInt, md: Modulus) -> u64 {
    use num_integer::Integer;
    c.mod_floor(&BigInt::from(md.n)).to_u64().unwrap()
}

/// (x - a)^d, constant term first.
fn power_of_linear(a: i64, d: usize) -> Vec<BigInt> {
    let mut p = vec![BigInt::from(1)];
    for _ in 0..d {
        let mut q = vec![BigInt::from(0); p.len() + 1];
        for (k, c) in p.iter().enumerate() {
            q[k + 1] += c;
            q[k] -= c * BigInt::from(a);
        }
        p = q;
    }
    p
}

/// The Galois orbits of newforms of a level.
#[derive(Clone, Debug)]
pub struct Orbits {
    /// The separating operator.
    pub op: Op,
    /// The irreducible factors over Q of its new characteristic polynomial
    /// (monic, constant term first), sorted by degree: one per orbit.
    pub orbits: Vec<Vec<BigInt>>,
}

impl Orbits {
    pub fn dimensions(&self) -> Vec<usize> {
        self.orbits.iter().map(|g| g.len() - 1).collect()
    }
}

/// The spaces of all the divisors of a level, and their newspaces.
pub struct Newspaces {
    pub level: QIdeal,
    field: QuadField,
    spaces: HashMap<QIdeal, DefiniteSpace>,
    /// The divisors M of N, each with d(N/M).
    divisors: Vec<(QIdeal, usize)>,
    /// The sum over the divisor spaces of dim^3: the modular work of one
    /// characteristic polynomial of each.
    cube_work: u128,
    /// For each divisor M, its proper divisors M' with d(M/M').
    old: HashMap<QIdeal, Vec<(QIdeal, usize)>>,
    /// The sum of the dimensions of the divisor spaces.
    total_dim: u128,
    /// The neighbour elements of each prime, shared by the divisor spaces.
    theta: Mutex<HashMap<QIdeal, Arc<Vec<Vec<(usize, BElt)>>>>>,
    hecke: Mutex<HashMap<(QIdeal, QIdeal), Arc<HeckeMatrix>>>,
    orbits: Mutex<Option<Orbits>>,
    charpoly_mod: Mutex<HashMap<(OpKey, u64), Arc<ModData>>>,
}

impl Newspaces {
    /// The newspaces of level N for the maximal order O (one class set,
    /// with reduced norms prime to N(N), serves every divisor).
    ///
    /// All the divisor spaces are built, so their number and size are
    /// checked first, from the factorization of N alone (at most
    /// definite::MAX_DIVISORS divisors and MAX_TOTAL_P1 points of P^1 in
    /// all), and H times the points (MAX_TOTAL_POINTS) right after the class
    /// set (daybreak HARD-3AE-4).
    pub fn new(order: &MaximalOrder, level: &QIdeal) -> Result<Newspaces, String> {
        let f = *order.alg().field();
        f.check(level)?;
        let (_, total) = divisor_census(&f.factor(level)?)?;
        let nn = f.principal(&QElt::int(level.norm().to_i64().ok_or("level too large")?))?;
        let classes = Arc::new(ClassSet::coprime_to(order, &nn)?);
        if total * classes.len() as u128 > MAX_TOTAL_POINTS {
            return Err("H #P^1(O_F/M) over the divisors M of the level is too large (unsupported)".into());
        }
        // d(Q) from the exponents of Q
        let sigma0 = |q: &QIdeal| -> Result<usize, String> { Ok(f.factor(q)?.iter().map(|(_, e)| *e as usize + 1).product()) };
        let all = divisors(&f, level)?;
        let mut spaces = HashMap::new();
        let mut divs = vec![];
        let mut old = HashMap::new();
        let mut total_dim: u128 = 0;
        let mut cube_work: u128 = 0;
        for m in &all {
            sagebrush_interrupt::check();
            let q = f.ideal_div(level, m)?.ok_or("internal error: not a divisor")?;
            divs.push((*m, sigma0(&q)?));
            let mut below = vec![];
            for m2 in &all {
                if m2 != m {
                    if let Some(q2) = f.ideal_div(m, m2)? {
                        below.push((*m2, sigma0(&q2)?));
                    }
                }
            }
            old.insert(*m, below);
            let sp = DefiniteSpace::with_classes(classes.clone(), m)?;
            total_dim += sp.dimension() as u128;
            cube_work += (sp.dimension() as u128).pow(3);
            spaces.insert(*m, sp);
        }
        divs.sort_by_key(|(m, _)| (m.norm(), m.hnf()));
        Ok(Newspaces {
            level: *level,
            field: f,
            spaces,
            divisors: divs,
            cube_work,
            old,
            total_dim,
            theta: Mutex::new(HashMap::new()),
            hecke: Mutex::new(HashMap::new()),
            orbits: Mutex::new(None),
            charpoly_mod: Mutex::new(HashMap::new()),
        })
    }

    pub fn space(&self, m: &QIdeal) -> Result<&DefiniteSpace, String> {
        self.spaces.get(m).ok_or_else(|| "not a divisor of the level".into())
    }
    pub fn top(&self) -> &DefiniteSpace {
        &self.spaces[&self.level]
    }
    pub fn field(&self) -> &QuadField {
        &self.field
    }

    /// The matrix of T_P (U_P if P divides M) on M_2^B(M), computed once.
    /// T_P is applied on every divisor space, so its terms are counted over
    /// all of them (MAX_HECKE_TERMS) before the neighbour search, which is
    /// done once for P and shared (HARD-3AE-4).
    pub fn hecke(&self, m: &QIdeal, p: &QPrime) -> Result<Arc<HeckeMatrix>, String> {
        if let Some(t) = self.hecke.lock().unwrap().get(&(*m, p.ideal)) {
            return Ok(t.clone());
        }
        let sp = self.space(m)?;
        sp.check_hecke(p, 1)?;
        if self.total_dim * (p.norm as u128 + 1) > MAX_HECKE_TERMS {
            return Err(format!("T_P at a prime of norm {} on the spaces of the divisors of the level is too large a computation (unsupported)", p.norm));
        }
        let theta = match self.theta.lock().unwrap().get(&p.ideal) {
            Some(t) => Some(t.clone()),
            None => None,
        };
        let theta = match theta {
            Some(t) => t,
            None => {
                let t = Arc::new(sp.neighbour_elements(p)?);
                self.theta.lock().unwrap().insert(p.ideal, t.clone());
                t
            }
        };
        let t = Arc::new(sp.hecke_matrix_with(p, &theta)?);
        self.hecke.lock().unwrap().insert((*m, p.ideal), t.clone());
        Ok(t)
    }

    /// The dense matrix of op on M_2^B(M) (entries at most L: checked).
    pub fn op_matrix(&self, m: &QIdeal, op: &Op) -> Result<Vec<Vec<i64>>, String> {
        eigenvalue_bound(op)?;
        let d = self.space(m)?.dimension();
        // row by row, with checks: up to 4000^2 entries
        let mut out = Vec::with_capacity(d);
        for _ in 0..d {
            sagebrush_interrupt::check();
            out.push(vec![0i64; d]);
        }
        for (p, c) in op {
            let t = self.hecke(m, p)?;
            for (i, row) in t.rows.iter().enumerate() {
                sagebrush_interrupt::check();
                for &(j, n) in row {
                    let e = &mut out[i][j as usize];
                    *e = c.checked_mul(n as i64).and_then(|x| e.checked_add(x)).ok_or("a Hecke operator matrix entry overflows i64")?;
                }
            }
        }
        Ok(out)
    }

    /// The characteristic polynomial over Z of op on the Eisenstein part of
    /// M_2^B(M): the h+ x h+ block of its action on the indicators of the
    /// narrow classes of nrd (checked to be constant on each class).
    fn eisenstein_charpoly(&self, m: &QIdeal, a: &[Vec<i64>]) -> Result<Vec<BigInt>, String> {
        let sp = self.space(m)?;
        let fiber = sp.narrow_fibers()?;
        let hp = fiber.iter().copied().max().map_or(0, |x| x + 1);
        let n = a.len();
        let mut block = vec![vec![BigInt::from(0); hp]; hp];
        let mut seen = vec![vec![false; hp]; hp];
        for b in 0..n {
            sagebrush_interrupt::check();
            let mut sums = vec![0i128; hp];
            for j in 0..n {
                sums[fiber[j]] += a[b][j] as i128;
            }
            let r = fiber[b];
            for c in 0..hp {
                let v = BigInt::from(sums[c]);
                if seen[r][c] {
                    if block[r][c] != v {
                        return Err("internal error: the Eisenstein part is not invariant".into());
                    }
                } else {
                    block[r][c] = v;
                    seen[r][c] = true;
                }
            }
        }
        Ok(charpoly(&ZMat::from_rows(block)))
    }

    /// The characteristic polynomials modulo md of op on S_2^new(M) for every
    /// divisor M, and the old part at N (with the Eisenstein factor).
    fn new_charpolys_mod(&self, op: &Op, eis: &HashMap<QIdeal, Vec<BigInt>>, md: Modulus) -> Result<(HashMap<QIdeal, Vec<u64>>, Vec<u64>), String> {
        let red = |p: &[BigInt]| -> Vec<u64> { p.iter().map(|c| reduce(c, md)).collect() };
        let mut new: HashMap<QIdeal, Vec<u64>> = HashMap::new();
        let mut top_old = vec![];
        for (m, _) in &self.divisors {
            sagebrush_interrupt::check();
            let a = self.op_matrix(m, op)?;
            let rows: Vec<Vec<u64>> = a
                .iter()
                .map(|r| {
                    sagebrush_interrupt::check();
                    r.iter().map(|&x| md.from_i64(x)).collect()
                })
                .collect();
            let full = Mat::from_rows(&rows, md).charpoly();
            let mut old = red(&eis[m]);
            for (m2, mult) in &self.old[m] {
                for _ in 0..*mult {
                    old = nmod_poly::mul(&old, &new[m2], &md);
                }
            }
            let (q, r) = nmod_poly::divrem(&full, &old, &md);
            if !nmod_poly::trim(r).is_empty() {
                return Err("internal error: the old part does not divide the characteristic polynomial".into());
            }
            if *m == self.level {
                top_old = old;
            }
            new.insert(*m, nmod_poly::trim(q));
        }
        Ok((new, top_old))
    }

    fn eisenstein_charpolys(&self, op: &Op) -> Result<HashMap<QIdeal, Vec<BigInt>>, String> {
        let mut out = HashMap::new();
        for (m, _) in &self.divisors {
            let a = self.op_matrix(m, op)?;
            out.insert(*m, self.eisenstein_charpoly(m, &a)?);
        }
        Ok(out)
    }

    fn check_op(&self, op: &Op) -> Result<(), String> {
        for (p, _) in op {
            self.field.check(&p.ideal)?;
            if self.field.ideal_div(&self.level, &p.ideal)?.is_some() {
                return Err("the Hecke operator must involve only primes not dividing the level".into());
            }
        }
        Ok(())
    }

    /// dim S_2^new(M) for every divisor M of N.
    pub fn new_dimensions(&self) -> Result<HashMap<QIdeal, usize>, String> {
        let mut nd: HashMap<QIdeal, usize> = HashMap::new();
        for (m, _) in &self.divisors {
            let mut old = 0;
            for (m2, mult) in &self.old[m] {
                old += mult * nd[m2];
            }
            let cusp = self.space(m)?.cusp_dimension();
            nd.insert(*m, cusp.checked_sub(old).ok_or("internal error: negative new dimension")?);
        }
        Ok(nd)
    }

    pub fn new_dimension(&self) -> Result<usize, String> {
        Ok(self.new_dimensions()?[&self.level])
    }

    /// The characteristic polynomial over Z of op (primes not dividing N) on
    /// S_2^new(N): modulo enough word-size primes, then Chinese remaindering
    /// (a coefficient of a polynomial of degree d is at most 2^d L^d).
    pub fn new_charpoly(&self, op: &Op) -> Result<Vec<BigInt>, String> {
        self.check_op(op)?;
        let d = self.new_dimension()?;
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
        self.check_modular(primes.len() as u128)?;
        let eis = self.eisenstein_charpolys(op)?;
        let res: Vec<Vec<u64>> = primes.iter().map(|&p| Ok(self.new_charpolys_mod(op, &eis, Modulus::new(p))?.0.remove(&self.level).unwrap())).collect::<Result<_, String>>()?;
        let crt = MultiCrt::new(&primes);
        let deg = res[0].len();
        Ok((0..deg).map(|t| crt.reconstruct(&res.iter().map(|r| r.get(t).copied().unwrap_or(0)).collect::<Vec<u64>>())).collect())
    }

    /// Refuses `count` characteristic polynomials of every divisor space
    /// above MAX_MODULAR_WORK.
    fn check_modular(&self, count: u128) -> Result<(), String> {
        if self.cube_work.saturating_mul(count) > MAX_MODULAR_WORK {
            return Err(format!("the characteristic polynomials of the newspaces of this level need about {} operations, above the limit of {} (unsupported)", self.cube_work.saturating_mul(count), MAX_MODULAR_WORK));
        }
        Ok(())
    }

    /// Whether op separates the newforms (modulo 2^61 - 1; monic, so this
    /// implies it over Q).
    fn separates_mod_ell(&self, op: &Op, eis: &HashMap<QIdeal, Vec<BigInt>>) -> Result<bool, String> {
        let md = Modulus::new(ELL);
        let (new, old) = self.new_charpolys_mod(op, eis, md)?;
        let g = &new[&self.level];
        if nmod_poly::degree(g) <= 0 {
            return Ok(true);
        }
        let rest = nmod_poly::mul(&old, &nmod_poly::derivative(g, &md), &md);
        Ok(nmod_poly::degree(&nmod_poly::gcd(g, &rest, &md)) == 0)
    }

    /// A Hecke operator separating the newforms of level N (as
    /// newspace::Newspaces::separating_operator): T_P1, then pseudo-random
    /// combinations of more and more primes not dividing N.
    pub fn separating_operator(&self) -> Result<(Op, Vec<BigInt>), String> {
        let primes: Vec<QPrime> = self.field.primes_of_bounded_norm(2000)?.into_iter().filter(|p| self.field.ideal_div(&self.level, &p.ideal).map_or(false, |q| q.is_none())).take(16).collect();
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for attempt in 0..48usize {
            // the attempts so far, and this one, within the modular budget
            self.check_modular(attempt as u128 + 1)?;
            let k = (1 + attempt).min(primes.len());
            let range = [9u64, 101, 1001, 20001][(attempt / 4).min(3)];
            let op: Op = (0..k)
                .map(|t| {
                    let c = if t == 0 { 1 } else { (next() % range) as i64 - (range / 2) as i64 };
                    (primes[t], c)
                })
                .filter(|&(_, c)| c != 0)
                .collect();
            let eis = self.eisenstein_charpolys(&op)?;
            if self.separates_mod_ell(&op, &eis)? {
                let cp = self.new_charpoly(&op)?;
                return Ok((op, cp));
            }
        }
        Err("no separating Hecke operator found".into())
    }

    /// The Galois orbits of newforms of level N, sorted by dimension.
    pub fn newform_orbits(&self) -> Result<Orbits, String> {
        if let Some(o) = self.orbits.lock().unwrap().as_ref() {
            return Ok(o.clone());
        }
        let (op, cp) = self.separating_operator()?;
        let mut orbits: Vec<Vec<BigInt>> = if cp.len() <= 1 { vec![] } else { sagebrush_poly::try_factor(&cp).map_err(|e| e.to_string())?.1.into_iter().map(|(g, e)| {
            debug_assert_eq!(e, 1);
            g
        }).collect() };
        orbits.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
        let o = Orbits { op, orbits };
        *self.orbits.lock().unwrap() = Some(o.clone());
        Ok(o)
    }

    /// The eigenspace of the k-th orbit (eigen.rs).
    pub fn orbit_eigenspace(&self, orbits: &Orbits, k: usize) -> Result<OrbitEigenspace, String> {
        let g = orbits.orbits.get(k).ok_or("no such orbit")?.clone();
        let t = self.op_matrix(&self.level, &orbits.op)?;
        orbit_eigenspace_core(&t, g, &key(&orbits.op), &self.charpoly_mod, 1 << 23)
    }

    /// a_P on an orbit, in its coefficient field (U_P for P dividing N),
    /// proven by eigen.rs's identity in integers. One consistency check: if
    /// P^2 divides N, a_P = 0. That holds for newforms whose central
    /// character is unramified (here a character of Cl+(F)): a local
    /// representation with a nonzero U_P eigenvalue and conductor exponent at
    /// least 2 would be a principal series pi(mu1, mu2) with mu1 unramified
    /// and mu2 ramified, and then the central character mu1 mu2 would be
    /// ramified. Where P exactly divides N, a_P depends on the normalization
    /// of U_P when P is not narrowly principal: it need not be +-1 (Q(sqrt
    /// 10), N = (5, sqrt 10): a_P^2 = -1, as in Magma; @sagebrush-astra's
    /// CORR-6F0-1), and it is not checked.
    pub fn eigenvalue(&self, es: &OrbitEigenspace, p: &QPrime) -> Result<Eigenvalue, String> {
        let a = es.eigenvalue_from(&*self.hecke(&self.level, p)?)?;
        if let Some((_, e)) = self.field.factor(&self.level)?.into_iter().find(|(q, _)| q.ideal == p.ideal) {
            let cp = es.charpoly_of(&a)?;
            let d = es.degree();
            if e >= 2 && cp != power_of_linear(0, d) {
                return Err("U_P has a nonzero eigenvalue on a newform with P^2 dividing the level".into());
            }
        }
        Ok(a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quatalg::QuatAlg;

    /// For tests/wasm-stop.mjs (the Stop button in wasm): the newspaces of
    /// level (210) over Q(sqrt 5) (16 divisor spaces) and their newform
    /// orbits, which must notice Stop and trap.
    #[test]
    #[ignore]
    fn stop_newspaces() {
        let f = QuadField::new(5).unwrap();
        let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
        let ns = Newspaces::new(&o, &f.principal(&QElt::int(210)).unwrap()).unwrap();
        println!("not interrupted: {:?}", ns.newform_orbits().map(|o| o.dimensions()));
    }
}
