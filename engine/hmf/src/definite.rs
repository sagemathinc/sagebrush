//! Hilbert modular forms of parallel weight 2 and level N over any real
//! quadratic field F, by the definite method (Dembélé-Voight, "Explicit
//! methods for Hilbert modular forms", 2013, sections 4 and 8): the
//! quaternionic space
//!
//! ```text
//! M_2^B(N) = sum over the classes I_1, ..., I_H of Cl O of C[Gamma_i \ P^1(O_F/N)],
//! ```
//!
//! with Gamma_i = O_L(I_i)^x acting on P^1(O_F/N) through a splitting of O
//! at N. Here O is the maximal order of quatalg.rs, and the classes are
//! those of classes.rs, chosen with reduced norms prime to N(N) (Kirschmer-
//! Voight, Proposition 7.3), so that each O_L(I_i) agrees with O at N.
//!
//! Hecke operators T_P for P not dividing N (DV, (4.2) and section 8). A
//! point (I_i, x) has the N(P) + 1 P-neighbours J of I_i, each with the same
//! level structure x (P is prime to N). J lies in the class of some I_j: J =
//! a I_j, with a in I_i I_j^-1 and nrd(a) O_F = P nrd(I_i) nrd(I_j)^-1, and
//! (J, x) is equivalent to (I_j, a^-1 x). The elements a are found as short
//! vectors: with nu a totally positive generator of P nrd(I_i) nrd(I_j)^-1
//! (it exists only when the narrow classes match) and z in {1, eps}, they are
//! the x in I_i I_j^-1 with nrd(x) = nu z, the vectors with Tr_{F/Q}(nrd(x)/
//! (nu z)) = 2. Two of them give the same J exactly when they differ by a
//! unit of O_L(I_j) on the right, so each neighbour accounts for 2 w_j
//! elements (w_j the unit index), and the neighbours found are checked to
//! number N(P) + 1 for every i. a^-1 acts on P^1 as conj(a) = nrd(a) a^-1
//! does; n_j conj(a), with n_j = N(nrd I_j), lies in O, and its image under
//! the splitting acts.
//!
//! The matrix of T_P has row (i, x) equal to the image of the basis element
//! (i, x), as for the Q(sqrt 5) code (rows sum to N(P) + 1). The Eisenstein
//! part of M_2^B(N) is the functions that factor through nrd: Cl O_0(N) ->
//! Cl+(F) (D = 1), of dimension h+, on which T_P acts as N(P) + 1 times the
//! translation by [P]; so S_2(N) = S_2^B(N) has dimension dim - h+, and the
//! characteristic polynomial of T_P on it is that on M_2^B(N) divided by
//! (x^m - (N(P) + 1)^m)^(h+/m), m the order of [P] in Cl+(F). The new part
//! divides out the old forms of each level M | N, M != N, with
//! multiplicity the number of divisors of N/M.

use crate::classes::{central, product, short_vectors, Budget, ClassSet, MAX_NODES};
use crate::p1::Mat;
use crate::qresidue::QLocalRing;
use crate::quatalg::{BElt, MaximalOrder, OrderSplitting};
use crate::residue::Res;
use crate::rqf::{QElt, QFrac, QIdeal, QPrime, QuadField};
use crate::HeckeMatrix;
use num_integer::Integer;
use num_traits::{One, ToPrimitive, Zero};
use sagebrush_arith::zmat::{charpoly, ZMat};
use sagebrush_bigint::BigInt;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// The largest P^1(O_F/N) handled.
pub const MAX_P1: u64 = 1 << 20;
/// The largest number of points over all classes, H #P^1(O_F/N), whose
/// orbits are computed (checked before computing them).
pub const MAX_POINTS: u64 = 1 << 22;
/// The largest dimension whose Hecke matrices are formed and whose
/// characteristic polynomials are computed (as weightnew.rs).
pub const MAX_DIMENSION: usize = 4000;

/// P^1(O_F/P^e): the points (a : 1), a in O_F/P^e, then (1 : b), b in P/P^e.
#[derive(Clone, Debug)]
struct LocalP1 {
    ring: QLocalRing,
    points: Vec<(Res, Res)>,
    index: HashMap<(Res, Res), u32>,
}

impl LocalP1 {
    fn new(ring: QLocalRing) -> LocalP1 {
        let mut points = vec![];
        for i in 0..ring.card() {
            points.push((ring.element(i), ring.one()));
        }
        for i in 0..ring.card() {
            let b = ring.element(i);
            if ring.in_p(b) {
                points.push((ring.one(), b));
            }
        }
        let index = points.iter().enumerate().map(|(i, &p)| (p, i as u32)).collect();
        LocalP1 { ring, points, index }
    }
    fn size(&self) -> u64 {
        self.points.len() as u64
    }
    /// The image of point i under m (acting on columns), None if singular.
    fn act(&self, m: &Mat, i: u32) -> Option<u32> {
        let r = &self.ring;
        let (u, v) = self.points[i as usize];
        let x = r.add(r.mul(m[0], u), r.mul(m[1], v));
        let y = r.add(r.mul(m[2], u), r.mul(m[3], v));
        let p = if let Some(yi) = r.inv(y) {
            (r.mul(x, yi), r.one())
        } else {
            let xi = r.inv(x)?;
            (r.one(), r.mul(y, xi))
        };
        self.index.get(&p).copied()
    }
}

/// M_2^B(N) over a real quadratic field, with its basis of orbits.
pub struct DefiniteSpace {
    classes: Arc<ClassSet>,
    level: QIdeal,
    locals: Vec<LocalP1>,
    splittings: Vec<OrderSplitting>,
    /// orbit[j][x] = the orbit of the global point x under Gamma_j.
    orbit: Vec<Vec<u32>>,
    /// reps[j][k] = the least global point of orbit k of Gamma_j.
    reps: Vec<Vec<u64>>,
    /// The index of the first basis element of class j.
    offset: Vec<usize>,
    dim: usize,
}

/// p(x) / q(x) for a monic q, if exact (coefficients constant term first).
fn divide_exact(p: &[BigInt], q: &[BigInt]) -> Option<Vec<BigInt>> {
    let (n, m) = (p.len(), q.len());
    if m == 0 || !q[m - 1].is_one() {
        return None;
    }
    if n < m {
        return if p.iter().all(|c| c.is_zero()) { Some(vec![]) } else { None };
    }
    let mut r = p.to_vec();
    let mut out = vec![BigInt::zero(); n - m + 1];
    for k in (0..=n - m).rev() {
        let c = r[k + m - 1].clone();
        if !c.is_zero() {
            for t in 0..m {
                r[k + t] -= &c * &q[t];
            }
        }
        out[k] = c;
    }
    if r.iter().all(|c| c.is_zero()) {
        Some(out)
    } else {
        None
    }
}

fn poly_mul(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut out = vec![BigInt::zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            out[i + j] += x * y;
        }
    }
    out
}

impl DefiniteSpace {
    /// M_2^B(N) for the maximal order O over F and the level N.
    pub fn new(order: &MaximalOrder, level: &QIdeal) -> Result<DefiniteSpace, String> {
        let f = *order.alg().field();
        f.check(level)?;
        // representatives with reduced norms prime to N(N)
        let nn = f.principal(&QElt::int(level.norm().to_i64().ok_or("level too large")?))?;
        let classes = ClassSet::coprime_to(order, &nn)?;
        DefiniteSpace::with_classes(Arc::new(classes), level)
    }

    /// The space for given classes (their reduced norms must be prime to
    /// N(N)).
    pub fn with_classes(classes: Arc<ClassSet>, level: &QIdeal) -> Result<DefiniteSpace, String> {
        let order = classes.order().clone();
        let f = *order.alg().field();
        f.check(level)?;
        let nl = BigInt::from(level.norm());
        for c in classes.classes() {
            if !BigInt::from(c.ideal().nrd().norm()).gcd(&nl).is_one() {
                return Err("a class representative has reduced norm not prime to N(N)".into());
            }
        }
        let mut locals = vec![];
        let mut splittings = vec![];
        let mut size: u64 = 1;
        for (p, e) in f.factor(level)? {
            let ring = QLocalRing::new(&f, p, e)?;
            let l = LocalP1::new(ring);
            size = size.checked_mul(l.size()).filter(|&s| s <= MAX_P1).ok_or("P^1(O_F/N) is too large (unsupported)")?;
            splittings.push(order.local_splitting(p, e)?);
            locals.push(l);
        }
        if (size as u128) * (classes.len() as u128) > MAX_POINTS as u128 {
            return Err("H #P^1(O_F/N) is too large (unsupported)".into());
        }
        let mut sp = DefiniteSpace { classes, level: *level, locals, splittings, orbit: vec![], reps: vec![], offset: vec![], dim: 0 };
        for j in 0..sp.classes.len() {
            let c = &sp.classes.classes()[j];
            let n = BigInt::from(c.ideal().nrd().norm());
            let units: Vec<BElt> = c.units_one().iter().chain(c.units_eps()).cloned().collect();
            let mats: Vec<Vec<Mat>> = units.iter().map(|u| sp.images(u, &n)).collect::<Result<_, _>>()?;
            let (orbit, reps) = sp.orbits(&mats)?;
            sp.offset.push(sp.dim);
            sp.dim += reps.len();
            sp.orbit.push(orbit);
            sp.reps.push(reps);
        }
        Ok(sp)
    }

    pub fn classes(&self) -> &ClassSet {
        &self.classes
    }
    pub fn level(&self) -> QIdeal {
        self.level
    }
    fn field(&self) -> QuadField {
        *self.classes.order().alg().field()
    }
    /// dim M_2^B(N), Eisenstein series included.
    pub fn dimension(&self) -> usize {
        self.dim
    }
    /// dim S_2(N) = dim M_2^B(N) - h+.
    pub fn cusp_dimension(&self) -> usize {
        self.dim - self.classes.class_group().narrow_h()
    }

    /// The images under the splittings at N of n x, which must lie in O
    /// (n an integer prime to N(N)); they act on P^1 as x does.
    fn images(&self, x: &BElt, n: &BigInt) -> Result<Vec<Mat>, String> {
        let o = self.classes.order();
        let alg = o.alg();
        let y = alg.mul(&central(&QElt { a: n.clone(), b: BigInt::zero() }), x);
        let c = o.coordinates(&y).ok_or("internal error: an element is not integral at N")?;
        Ok(self.splittings.iter().map(|s| s.image(&c)).collect())
    }

    fn size(&self) -> u64 {
        self.locals.iter().map(|l| l.size()).product()
    }

    fn digits(&self, mut x: u64) -> Vec<u32> {
        self.locals
            .iter()
            .map(|l| {
                let d = (x % l.size()) as u32;
                x /= l.size();
                d
            })
            .collect()
    }

    fn combine(&self, d: &[u32]) -> u64 {
        let mut x = 0u64;
        for (l, &di) in self.locals.iter().zip(d).rev() {
            x = x * l.size() + di as u64;
        }
        x
    }

    /// The image of the global point x under the matrices (one per factor).
    fn act(&self, m: &[Mat], x: u64) -> Result<u64, String> {
        let d = self.digits(x);
        let mut e = vec![0u32; d.len()];
        for k in 0..d.len() {
            e[k] = self.locals[k].act(&m[k], d[k]).ok_or("internal error: an element acted singularly on P^1")?;
        }
        Ok(self.combine(&e))
    }

    fn orbits(&self, mats: &[Vec<Mat>]) -> Result<(Vec<u32>, Vec<u64>), String> {
        let n = self.size() as usize;
        let mut orbit = vec![u32::MAX; n];
        let mut reps = vec![];
        let mut stack = vec![];
        for start in 0..n {
            if orbit[start] != u32::MAX {
                continue;
            }
            let id = reps.len() as u32;
            reps.push(start as u64);
            orbit[start] = id;
            stack.push(start as u64);
            while let Some(x) = stack.pop() {
                sagebrush_interrupt::check();
                for m in mats {
                    let y = self.act(m, x)? as usize;
                    if orbit[y] == u32::MAX {
                        orbit[y] = id;
                        stack.push(y as u64);
                    } else if orbit[y] != id {
                        return Err("internal error: orbits overlap".into());
                    }
                }
            }
        }
        Ok((orbit, reps))
    }

    /// For each class i, the pairs (j, a): one a for each P-neighbour J = a
    /// I_j of I_i.
    pub fn neighbour_elements(&self, p: &QPrime) -> Result<Vec<Vec<(usize, BElt)>>, String> {
        let f = self.field();
        f.check(&p.ideal)?;
        let cs = &self.classes;
        let alg = cs.order().alg();
        let cg = cs.class_group();
        let h = cs.len();
        // the work budget of this operator (as for a class set)
        let budget = Budget::new(MAX_NODES);
        let mut out = vec![vec![]; h];
        for i in 0..h {
            let ci = &cs.classes()[i];
            let ni = BigInt::from(ci.ideal().nrd().norm());
            let pi = f.ideal_mul(&p.ideal, &ci.ideal().nrd())?;
            let target = cg.narrow_class(&pi)?;
            for j in 0..h {
                sagebrush_interrupt::check();
                let cj = &cs.classes()[j];
                if cg.narrow_class(&cj.ideal().nrd())? != target {
                    continue;
                }
                let nj = BigInt::from(cj.ideal().nrd().norm());
                // nu = beta / n_j, beta >> 0 generating P nrd(I_i) conj(nrd I_j)
                let b_ideal = f.ideal_mul(&pi, &f.ideal_conj(&cj.ideal().nrd())?)?;
                let beta = cg.totally_positive_generator(&b_ideal)?.ok_or("internal error: not narrowly principal")?;
                // I_i I_j^-1 contains I_i conj(I_j), so N(nrd I_i) N(nrd I_j) m0^2 Lambda
                let m0 = cs.order().lambda_multiple();
                let lat = product(alg, &ci.ideal().lattice().basis(), &cj.inverse, &(&ni * &nj * m0 * m0));
                let mut zs = vec![QElt::int(1)];
                if cg.eps_norm == 1 {
                    zs.push(cg.eps.clone());
                }
                let mut found: Vec<BElt> = vec![];
                for z in zs {
                    let bz = f.mul(&beta, &z);
                    let nu = QFrac::new(bz.a.clone(), bz.b.clone(), nj.clone());
                    let mu = f.finv(&nu);
                    found.extend(short_vectors(alg, &lat.basis(), &mu, 2, false, &budget, &mut |x| alg.nrd(x) == nu)?);
                }
                // group by right multiplication by the units of O_L(I_j)
                let units: Vec<BElt> = cj.units_one().iter().chain(cj.units_eps()).cloned().collect();
                let set: HashSet<BElt> = found.iter().cloned().collect();
                let mut seen: HashSet<BElt> = HashSet::new();
                for a in &found {
                    if seen.contains(a) {
                        continue;
                    }
                    for u in &units {
                        let au = alg.mul(a, u);
                        if !set.contains(&au) {
                            return Err("internal error: a neighbour element times a unit is missing".into());
                        }
                        seen.insert(au);
                    }
                    out[i].push((j, a.clone()));
                }
                if seen.len() != found.len() || found.len() % units.len() != 0 {
                    return Err("internal error: the neighbour elements do not split into unit orbits".into());
                }
            }
            if out[i].len() as i128 != p.norm + 1 {
                return Err(format!("internal error: {} neighbours found instead of N(P) + 1 = {}", out[i].len(), p.norm + 1));
            }
        }
        Ok(out)
    }

    /// The matrix of T_P for P not dividing N: row b is the image of the
    /// basis element b; rows sum to N(P) + 1.
    pub fn hecke_matrix(&self, p: &QPrime) -> Result<HeckeMatrix, String> {
        let f = self.field();
        if f.ideal_div(&self.level, &p.ideal)?.is_some() {
            return Err("T_P for P dividing the level is not implemented".into());
        }
        if self.dim > MAX_DIMENSION {
            return Err(format!("dimension {} is above {} (unsupported)", self.dim, MAX_DIMENSION));
        }
        let theta = self.neighbour_elements(p)?;
        let alg = self.classes.order().alg();
        let mut rows = vec![vec![]; self.dim];
        for (i, list) in theta.iter().enumerate() {
            // the matrices of n_j conj(a)
            let mats: Vec<(usize, Vec<Mat>)> = list
                .iter()
                .map(|(j, a)| {
                    let nj = BigInt::from(self.classes.classes()[*j].ideal().nrd().norm());
                    Ok((*j, self.images(&alg.conj(a), &nj)?))
                })
                .collect::<Result<_, String>>()?;
            for (k, &x) in self.reps[i].iter().enumerate() {
                sagebrush_interrupt::check();
                let mut cols: Vec<u32> = vec![];
                for (j, m) in &mats {
                    let y = self.act(m, x)?;
                    cols.push((self.offset[*j] + self.orbit[*j][y as usize] as usize) as u32);
                }
                cols.sort_unstable();
                let mut row: Vec<(u32, u32)> = vec![];
                for c in cols {
                    match row.last_mut() {
                        Some((d, n)) if *d == c => *n += 1,
                        _ => row.push((c, 1)),
                    }
                }
                rows[self.offset[i] + k] = row;
            }
        }
        Ok(HeckeMatrix { dim: self.dim, rows })
    }

    /// The characteristic polynomial of T_P on M_2^B(N) (constant term first).
    pub fn charpoly(&self, p: &QPrime) -> Result<Vec<BigInt>, String> {
        let t = self.hecke_matrix(p)?;
        let rows: Vec<Vec<BigInt>> = t.dense().into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect();
        Ok(charpoly(&ZMat::from_rows(rows)))
    }

    /// The characteristic polynomial of T_P on S_2(N): the Eisenstein factor
    /// (x^m - (N(P) + 1)^m)^(h+/m) divided out (checked to divide).
    pub fn cusp_charpoly(&self, p: &QPrime) -> Result<Vec<BigInt>, String> {
        let full = self.charpoly(p)?;
        let cg = self.classes.class_group();
        let m = cg.class_order(&p.ideal, true)?;
        let hp = cg.narrow_h();
        let a = BigInt::from(p.norm + 1).pow(m as u32);
        let mut eis = vec![BigInt::zero(); m + 1];
        eis[0] = -a;
        eis[m] = BigInt::one();
        let mut q = vec![BigInt::one()];
        for _ in 0..hp / m {
            q = poly_mul(&q, &eis);
        }
        divide_exact(&full, &q).ok_or_else(|| "internal error: the Eisenstein factor does not divide".into())
    }
}

/// The divisors of the ideal N (from its factorization).
pub fn divisors(f: &QuadField, n: &QIdeal) -> Result<Vec<QIdeal>, String> {
    let mut out = vec![f.unit_ideal()];
    for (p, e) in f.factor(n)? {
        let mut next = vec![];
        for d in &out {
            let mut x = *d;
            next.push(x);
            for _ in 0..e {
                x = f.ideal_mul(&x, &p.ideal)?;
                next.push(x);
            }
        }
        out = next;
    }
    Ok(out)
}

/// The characteristic polynomial of T_P on the new subspace S_2(N)^new and
/// its dimension: the cusp characteristic polynomials of the levels M | N
/// with the old forms divided out, each new part of level M occurring
/// sigma_0(N/M) times at level N.
pub fn new_charpoly(order: &MaximalOrder, level: &QIdeal, p: &QPrime) -> Result<Vec<BigInt>, String> {
    let f = *order.alg().field();
    let divs = divisors(&f, level)?;
    // all levels use the classes prime to N(N)
    let nn = f.principal(&QElt::int(level.norm().to_i64().ok_or("level too large")?))?;
    let classes = Arc::new(ClassSet::coprime_to(order, &nn)?);
    let mut sorted = divs.clone();
    sorted.sort_by_key(|d| d.norm());
    let mut new: HashMap<QIdeal, Vec<BigInt>> = HashMap::new();
    for m in &sorted {
        let sp = DefiniteSpace::with_classes(classes.clone(), m)?;
        let mut cp = sp.cusp_charpoly(p)?;
        for d in &sorted {
            if d == m || f.ideal_div(m, d)?.is_none() {
                continue;
            }
            let q = f.ideal_div(m, d)?.unwrap();
            let mult = divisors(&f, &q)?.len();
            for _ in 0..mult {
                cp = divide_exact(&cp, &new[d]).ok_or("internal error: an old factor does not divide")?;
            }
        }
        new.insert(*m, cp);
    }
    Ok(new.remove(level).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_division() {
        let b = |v: &[i64]| v.iter().map(|&x| BigInt::from(x)).collect::<Vec<_>>();
        // (x^2 - 1)(x + 3) = x^3 + 3x^2 - x - 3
        assert_eq!(divide_exact(&b(&[-3, -1, 3, 1]), &b(&[3, 1])), Some(b(&[-1, 0, 1])));
        assert_eq!(divide_exact(&b(&[-3, -1, 3, 1]), &b(&[2, 1])), None);
    }
}
