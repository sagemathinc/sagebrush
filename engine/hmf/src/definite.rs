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
//! Hecke operators T_P for P not dividing N (DV, (4.2) and section 8), and
//! U_P for P dividing N (see `hecke_matrix`). A
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
use num_traits::{One, Signed, ToPrimitive, Zero};
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
/// The most divisors of a level whose spaces are built together (newspaces).
pub const MAX_DIVISORS: u128 = 256;
/// The most points of P^1(O_F/M) over all the divisors M of a level, and
/// times the number of classes (newspaces build a space for every divisor;
/// daybreak HARD-3AE-4).
pub const MAX_TOTAL_P1: u128 = 1 << 21;
pub const MAX_TOTAL_POINTS: u128 = 1 << 23;
/// The most terms (an action on P^1 each) of one Hecke matrix: a row per
/// basis element with N(P) + 1 terms (or N(P)), checked before the
/// neighbour search; for newspaces, over all the divisor spaces together.
/// Measured at about 2 microseconds a term natively (S_2((210)) over
/// Q(sqrt 5), dimension 1252, and S_2((120)) over Q(sqrt 2), dimension
/// 1040), so a few seconds at the limit; the neighbour search has its own
/// node budget (classes.rs).
pub const MAX_HECKE_TERMS: u128 = 1 << 21;

/// #P^1(O_F/P^e) = q^e + q^(e - 1), q = N(P), e >= 1 (None on overflow).
pub fn p1_size(q: i128, e: u32) -> Option<u128> {
    let q = u128::try_from(q).ok()?;
    let a = q.checked_pow(e - 1)?;
    a.checked_mul(q)?.checked_add(a)
}

/// For the factorization of a level: its number of divisors, and the sum
/// over its divisors M of #P^1(O_F/M), the product over P^e of 1 + sum
/// over k = 1..e of #P^1(O_F/P^k) (#P^1 is multiplicative); an Err above
/// MAX_DIVISORS or MAX_TOTAL_P1, computed from the exponents alone, before
/// anything is built (daybreak HARD-3AE-4).
pub fn divisor_census(fac: &[(QPrime, u32)]) -> Result<(u128, u128), String> {
    let (mut count, mut total) = (1u128, 1u128);
    for (p, e) in fac {
        count = count.checked_mul(*e as u128 + 1).filter(|&c| c <= MAX_DIVISORS).ok_or_else(|| format!("the level has more than {} divisors (unsupported)", MAX_DIVISORS))?;
        let mut s = 1u128;
        for k in 1..=*e {
            s = p1_size(p.norm, k).and_then(|x| s.checked_add(x)).filter(|&x| x <= MAX_TOTAL_P1).ok_or("P^1(O_F/M) over the divisors M of the level is too large (unsupported)")?;
        }
        total = total.checked_mul(s).filter(|&x| x <= MAX_TOTAL_P1).ok_or("P^1(O_F/M) over the divisors M of the level is too large (unsupported)")?;
    }
    Ok((count, total))
}

/// P^1(O_F/P^e): the points (a : 1), a in O_F/P^e, then (1 : b), b in P/P^e.
#[derive(Clone, Debug)]
struct LocalP1 {
    ring: QLocalRing,
    points: Vec<(Res, Res)>,
    index: HashMap<(Res, Res), u32>,
}

impl LocalP1 {
    /// Built only after its size is checked against MAX_P1 (with_classes).
    fn new(ring: QLocalRing) -> LocalP1 {
        let mut points = vec![];
        for i in 0..ring.card() {
            sagebrush_interrupt::check();
            points.push((ring.element(i), ring.one()));
        }
        for i in 0..ring.card() {
            sagebrush_interrupt::check();
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
        // the sizes from the factorization, checked before any ring or
        // point is built (daybreak HARD-3AE-3)
        let fac = f.factor(level)?;
        let mut size: u128 = 1;
        for (p, e) in &fac {
            size = p1_size(p.norm, *e).and_then(|s| size.checked_mul(s)).filter(|&s| s <= MAX_P1 as u128).ok_or("P^1(O_F/N) is too large (unsupported)")?;
        }
        if size * (classes.len() as u128) > MAX_POINTS as u128 {
            return Err("H #P^1(O_F/N) is too large (unsupported)".into());
        }
        let mut locals = vec![];
        let mut splittings = vec![];
        for (p, e) in fac {
            let ring = QLocalRing::new(&f, p, e)?;
            let l = LocalP1::new(ring);
            if Some(l.size() as u128) != p1_size(p.norm, e) {
                return Err("internal error: P^1(O_F/P^e) has the wrong size".into());
            }
            splittings.push(order.local_splitting(p, e)?);
            locals.push(l);
        }
        let mut sp = DefiniteSpace { classes, level: *level, locals, splittings, orbit: vec![], reps: vec![], offset: vec![], dim: 0 };
        for j in 0..sp.classes.len() {
            let c = &sp.classes.classes()[j];
            let n = BigInt::from(c.ideal().nrd().norm());
            let units: Vec<BElt> = c.units_one().iter().chain(c.units_eps()).cloned().collect();
            let gens = unit_generators(&sp.classes, &units)?;
            let mats: Vec<Vec<Mat>> = gens.iter().map(|u| sp.images(u, &n)).collect::<Result<_, _>>()?;
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

    /// For each basis element, the index (0..h+) of the narrow class of the
    /// reduced norm of its ideal class: the fibers of the map to Cl+(F)
    /// through which the Eisenstein series factor. Every narrow class occurs
    /// (nrd maps Cl O onto Cl+(F)); checked.
    pub fn narrow_fibers(&self) -> Result<Vec<usize>, String> {
        let cg = self.classes.class_group();
        let mut keys = vec![];
        for c in self.classes.classes() {
            keys.push(cg.narrow_class(&c.ideal().nrd())?);
        }
        let mut distinct = keys.clone();
        distinct.sort();
        distinct.dedup();
        if distinct.len() != cg.narrow_h() {
            return Err("internal error: the classes do not cover the narrow class group".into());
        }
        let mut out = vec![0usize; self.dim];
        for (i, k) in keys.iter().enumerate() {
            let idx = distinct.iter().position(|x| x == k).unwrap();
            for b in self.offset[i]..self.offset[i] + self.reps[i].len() {
                out[b] = idx;
            }
        }
        Ok(out)
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

    /// The image of x, or None if the matrix is singular on x at the factor
    /// `degenerate` (an Err at any other factor).
    fn act_or_degenerate(&self, m: &[Mat], x: u64, degenerate: Option<usize>) -> Result<Option<u64>, String> {
        let d = self.digits(x);
        let mut e = vec![0u32; d.len()];
        for k in 0..d.len() {
            match self.locals[k].act(&m[k], d[k]) {
                Some(y) => e[k] = y,
                None if Some(k) == degenerate => return Ok(None),
                None => return Err("internal error: an element acted singularly on P^1".into()),
            }
        }
        Ok(Some(self.combine(&e)))
    }

    /// The orbits on P^1(O_F/N) of the group generated by the given
    /// elements (their images at N, one matrix per local factor): each
    /// generator's permutation of each local P^1 is computed once, and the
    /// search applies the generators through these tables (orbits under a
    /// group are orbits under its generators; unit_generators).
    fn orbits(&self, mats: &[Vec<Mat>]) -> Result<(Vec<u32>, Vec<u64>), String> {
        let n = self.size() as usize;
        let k = self.locals.len();
        let mut gens: Vec<Vec<Vec<u32>>> = vec![];
        for m in mats {
            let mut pm = Vec::with_capacity(k);
            for (l, mk) in self.locals.iter().zip(m) {
                let mut v = Vec::with_capacity(l.size() as usize);
                for i in 0..l.size() as u32 {
                    sagebrush_interrupt::check();
                    v.push(l.act(mk, i).ok_or("internal error: an element acted singularly on P^1")?);
                }
                pm.push(v);
            }
            gens.push(pm);
        }
        let mut radix = vec![1u64; k];
        for i in 1..k {
            radix[i] = radix[i - 1] * self.locals[i - 1].size();
        }
        let mut orbit = vec![u32::MAX; n];
        let mut reps = vec![];
        let mut stack = vec![];
        let mut digits = vec![0usize; k];
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
                for (i, l) in self.locals.iter().enumerate() {
                    digits[i] = ((x / radix[i]) % l.size()) as usize;
                }
                for g in &gens {
                    let y = (0..k).map(|i| g[i][digits[i]] as u64 * radix[i]).sum::<u64>() as usize;
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
    ///
    /// For P dividing N this is U_P, with rows summing to N(P) (as for the
    /// Q(sqrt 5) code). Of the N(P) + 1 elements a, those for which conj(a)
    /// is singular modulo P on the point x are left out. conj(a) a = nrd(a)
    /// lies in P, so conj(a) is singular modulo P with a rank-one kernel, the
    /// line of a, and the N(P) + 1 lines are distinct (the neighbours are), so
    /// exactly one a is left out for each x (checked): the sum runs over the
    /// N(P) single cosets of the double coset of diag(pi, 1) for the Eichler
    /// order of level P^e (Dembélé 2005, section 3: "one must restrict the
    /// summation to the u whose action is nondegenerate").
    pub fn hecke_matrix(&self, p: &QPrime) -> Result<HeckeMatrix, String> {
        self.check_hecke(p, 1)?;
        let theta = self.neighbour_elements(p)?;
        self.hecke_matrix_with(p, &theta)
    }

    /// Refuses T_P where the matrix (dimension at most MAX_DIMENSION), with
    /// `spaces` such matrices of this size, would exceed MAX_HECKE_TERMS
    /// terms: before the neighbour search.
    pub(crate) fn check_hecke(&self, p: &QPrime, spaces: u128) -> Result<(), String> {
        self.field().check(&p.ideal)?;
        if self.dim > MAX_DIMENSION {
            return Err(format!("dimension {} is above {} (unsupported)", self.dim, MAX_DIMENSION));
        }
        let terms = (self.dim as u128) * (p.norm as u128 + 1) * spaces;
        if terms > MAX_HECKE_TERMS {
            return Err(format!("T_P at a prime of norm {} on a space of dimension {} is too large a computation (unsupported)", p.norm, self.dim));
        }
        Ok(())
    }

    /// hecke_matrix with the neighbour elements of P given (they depend only
    /// on the classes and P, so newspaces share them across divisors).
    pub(crate) fn hecke_matrix_with(&self, p: &QPrime, theta: &[Vec<(usize, BElt)>]) -> Result<HeckeMatrix, String> {
        let f = self.field();
        f.check(&p.ideal)?;
        if theta.len() != self.classes.len() {
            return Err("internal error: neighbour elements of another class set".into());
        }
        // the factor of P^e in N, if P divides N
        let degenerate = self.locals.iter().position(|l| l.ring.prime().ideal == p.ideal);
        let want = if degenerate.is_some() { p.norm } else { p.norm + 1 };
        if self.dim > MAX_DIMENSION {
            return Err(format!("dimension {} is above {} (unsupported)", self.dim, MAX_DIMENSION));
        }
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
                let mut cols: Vec<u32> = vec![];
                for (j, m) in &mats {
                    // a check per term: rows have N(P) + 1 terms
                    sagebrush_interrupt::check();
                    if let Some(y) = self.act_or_degenerate(m, x, degenerate)? {
                        cols.push((self.offset[*j] + self.orbit[*j][y as usize] as usize) as u32);
                    }
                }
                if cols.len() as i128 != want {
                    return Err(format!("internal error: {} terms in a row of the Hecke operator instead of {}", cols.len(), want));
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
        self.check_hecke(p, 1)?;
        self.charpoly_with(p, &self.neighbour_elements(p)?)
    }

    fn charpoly_with(&self, p: &QPrime, theta: &[Vec<(usize, BElt)>]) -> Result<Vec<BigInt>, String> {
        let t = self.hecke_matrix_with(p, theta)?;
        let rows: Vec<Vec<BigInt>> = t.dense().into_iter().map(|r| r.into_iter().map(BigInt::from).collect()).collect();
        Ok(charpoly(&ZMat::from_rows(rows)))
    }

    /// The characteristic polynomial of T_P on S_2(N): the Eisenstein factor
    /// (x^m - (N(P) + 1)^m)^(h+/m) divided out (checked to divide). For P
    /// dividing N (U_P) the factor is (x^m - N(P)^m)^(h+/m): the N(P) terms
    /// of a row all move the narrow class of nrd by [P].
    pub fn cusp_charpoly(&self, p: &QPrime) -> Result<Vec<BigInt>, String> {
        self.check_hecke(p, 1)?;
        self.cusp_charpoly_with(p, &self.neighbour_elements(p)?)
    }

    fn cusp_charpoly_with(&self, p: &QPrime, theta: &[Vec<(usize, BElt)>]) -> Result<Vec<BigInt>, String> {
        let full = self.charpoly_with(p, theta)?;
        let cg = self.classes.class_group();
        let m = cg.class_order(&p.ideal, true)?;
        let hp = cg.narrow_h();
        let divides = self.field().ideal_div(&self.level, &p.ideal)?.is_some();
        let a = BigInt::from(if divides { p.norm } else { p.norm + 1 }).pow(m as u32);
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

/// Generators of O_j^x / O_F^x among its units (of reduced norm 1 and
/// eps), chosen greedily: each unit not in the group generated so far is
/// added. Elements are compared up to sign, and a product of reduced norm
/// eps^2 is divided by the central eps (classes.rs: eps is totally positive
/// when N(eps) = 1). The group is finite, a subgroup of B^x / F^x inside
/// SO(3) at a real place, of order at most 60 (checked), so there are at
/// most 6 generators.
fn unit_generators(classes: &ClassSet, units: &[BElt]) -> Result<Vec<BElt>, String> {
    let alg = classes.order().alg();
    let f = *alg.field();
    let cg = classes.class_group();
    let eps2 = f.mul(&cg.eps, &cg.eps).frac();
    let eps_inv = central(&f.conj(&cg.eps));
    let canon = |x: BElt| -> BElt {
        let x = if cg.eps_norm == 1 && alg.nrd(&x) == eps2 { alg.mul(&x, &eps_inv) } else { x };
        match x.c.iter().find(|c| !c.is_zero()) {
            Some(c) if c.is_negative() => alg.neg(&x),
            _ => x,
        }
    };
    let mut gens: Vec<BElt> = vec![];
    let mut group: HashSet<BElt> = HashSet::new();
    group.insert(canon(BElt::one()));
    for u in units {
        if group.contains(&canon(u.clone())) {
            continue;
        }
        gens.push(u.clone());
        let mut elements = vec![canon(BElt::one())];
        group.clear();
        group.insert(elements[0].clone());
        let mut i = 0;
        while i < elements.len() {
            for g in &gens {
                sagebrush_interrupt::check();
                let c = canon(alg.mul(g, &elements[i]));
                if group.insert(c.clone()) {
                    elements.push(c);
                    if elements.len() > 60 {
                        return Err("internal error: a unit group has more than 60 elements modulo the center".into());
                    }
                }
            }
            i += 1;
        }
    }
    Ok(gens)
}

/// The divisors of the ideal N (from its factorization); an Err above
/// MAX_DIVISORS, before they are built.
pub fn divisors(f: &QuadField, n: &QIdeal) -> Result<Vec<QIdeal>, String> {
    let fac = f.factor(n)?;
    let mut count = 1u128;
    for (_, e) in &fac {
        count = count.checked_mul(*e as u128 + 1).filter(|&c| c <= MAX_DIVISORS).ok_or_else(|| format!("the level has more than {} divisors (unsupported)", MAX_DIVISORS))?;
    }
    let mut out = vec![f.unit_ideal()];
    for (p, e) in fac {
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
    f.check(&p.ideal)?;
    // the size of all the divisor spaces, before the class set (HARD-3AE-4)
    let (_, total) = divisor_census(&f.factor(level)?)?;
    let divs = divisors(&f, level)?;
    // all levels use the classes prime to N(N)
    let nn = f.principal(&QElt::int(level.norm().to_i64().ok_or("level too large")?))?;
    let classes = Arc::new(ClassSet::coprime_to(order, &nn)?);
    if total * classes.len() as u128 > MAX_TOTAL_POINTS {
        return Err("H #P^1(O_F/M) over the divisors M of the level is too large (unsupported)".into());
    }
    let mut sorted = divs.clone();
    sorted.sort_by_key(|d| d.norm());
    let mut new: HashMap<QIdeal, Vec<BigInt>> = HashMap::new();
    // the neighbour elements once (they depend only on the classes and P),
    // and the Hecke terms counted over all the divisor spaces
    let mut theta = None;
    let mut terms: u128 = 0;
    for m in &sorted {
        let sp = DefiniteSpace::with_classes(classes.clone(), m)?;
        sp.check_hecke(p, 1)?;
        terms += sp.dimension() as u128 * (p.norm as u128 + 1);
        if terms > MAX_HECKE_TERMS {
            return Err(format!("T_P at a prime of norm {} on the spaces of the divisors of the level is too large a computation (unsupported)", p.norm));
        }
        if theta.is_none() {
            theta = Some(sp.neighbour_elements(p)?);
        }
        let mut cp = sp.cusp_charpoly_with(p, theta.as_ref().unwrap())?;
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
