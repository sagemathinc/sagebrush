//! Newspaces, newform orbits and Hecke eigenvalues in weight k != (2, 2)
//! over any real quadratic field F (defweight.rs): weightnew.rs (over
//! Q(sqrt 5)) over every F, with the polynomials over O_F of gpoly.rs.
//!
//! * S_k(N) is the sum over M | N of d(N/M) copies of S_k^new(M) as a module
//!   for the T_P, P not dividing N (Donnelly-Voight 2016, section 2, with
//!   Shemanske-Walling, as in defnew.rs), M = (1) included. There is no
//!   Eisenstein part.
//! * The characteristic polynomials of the Hecke operators lie in O_F[x]
//!   (defweight.rs) and are computed modulo pairs of conjugate degree-one
//!   primes and recovered with a proven bound: the eigenvalues of T_P (U_P
//!   for P dividing N) are at most (N(P) + 1) N(P)^(mu/2) (N(P) N(P)^(mu/2)
//!   for U_P) under both embeddings. With the norm max over i and x of
//!   N(nrd I_i)^(-mu/2) |f_i(x)| (|.| a hermitian norm on L_k invariant
//!   under the norm-one quaternions at the real place), each term
//!   f_j(u x) u has norm at most N(nrd u)^(mu/2) N(nrd I_i)^(-mu/2) times
//!   that of f_j, and N(nrd u) = N(P) N(nrd I_i) / N(nrd I_j): u is, under
//!   each real embedding sigma, sqrt(sigma(nrd u)) times a unitary
//!   quaternion, which acts on L_k by sigma(nrd u)^(m_sigma/2 + v_sigma) =
//!   sigma(nrd u)^(mu/2) times an isometry, and the units h of the words
//!   act isometrically (nrd h is 1 or eps, of norm 1). Bounds and the number
//!   of moduli they need are exact integer computations (fpoly.rs), and a
//!   request needing more than fpoly::MAX_BITS bits per coefficient is
//!   refused before any modular work, as is a total modular work above
//!   MAX_TOTAL_WORK.
//! * The newform orbits, the characteristic polynomials of a_P on them and
//!   the eigenvalues a_P = h(theta)/g'(theta) as in weightnew.rs (where the
//!   bounds and the faithfulness conditions of the reductions are
//!   explained).

use crate::classes::ClassSet;
use crate::definite::{divisor_census, divisors, DefiniteSpace, MAX_TOTAL_POINTS};
use crate::defnew::Op;
use crate::defweight::{place_pairs, HeckeTerms, WPlace, WeightSpace, MAX_DIMENSION};
use crate::fpoly::{bitlen, coefficient_bits, pairs_needed};
use crate::gpoly::{self, GPlace, PairCrt, QPoly};
use crate::quatalg::{MaximalOrder, QuatAlg};
use crate::rqf::{QElt, QIdeal, QPrime, QuadField};
use crate::weight::Weight;
use num_traits::{One, ToPrimitive};
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::nmod_poly;
use sagebrush_bigint::BigInt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The most modular work one request may take, in multiply-adds: the
/// per-place estimates of defweight.rs, with the operator sums and the
/// characteristic polynomials (dim^2 and dim^3), times the number of places.
/// Measured at 2 to 8 ns per estimated multiply-add natively (one thread;
/// 2.5 ns where the characteristic polynomials dominate, as near the limit:
/// 3.0e10 in 74 s for S_(8, 8)((9)) over Q(sqrt 13), of dimension 588,
/// which is refused) and about 1.4 times that in wasm, so up to a minute
/// or two at the limit, with interrupt checks throughout.
pub const MAX_TOTAL_WORK: u64 = 1 << 34;

/// The modular work of one request, accumulated over its steps (the
/// attempts of the separating-operator search): a step is admitted only if
/// the work spent so far, the step, and the work it would go on to start
/// fit the cap, and then its own work counts as spent.
pub(crate) struct WorkBudget {
    spent: u128,
    cap: u128,
}

impl WorkBudget {
    pub(crate) fn new(cap: u128) -> WorkBudget {
        WorkBudget { spent: 0, cap }
    }

    /// Admits a step of work `now` that may be followed by `then` more.
    pub(crate) fn admit(&mut self, now: u128, then: u128, weight: Weight) -> Result<(), String> {
        let total = self.spent.saturating_add(now).saturating_add(then);
        if total > self.cap {
            return Err(format!("this computation in weight {:?} needs about {} operations modulo primes, above the limit of {} (unsupported)", weight.k, total, self.cap));
        }
        self.spent += now;
        Ok(())
    }

    pub(crate) fn spent(&self) -> u128 {
        self.spent
    }
}

/// The newform orbits of a level: the separating operator and the
/// characteristic polynomial over F of it on each orbit (irreducible over F,
/// its degree is the orbit's dimension over F).
#[derive(Clone, Debug)]
pub struct WeightOrbits {
    pub op: Op,
    pub orbits: Vec<QPoly>,
}

pub struct WeightNewspaces {
    pub level: QIdeal,
    pub weight: Weight,
    field: QuadField,
    order: MaximalOrder,
    spaces: HashMap<QIdeal, WeightSpace>,
    /// The divisors M of N, each with d(N/M).
    divisors: Vec<(QIdeal, usize)>,
    terms: Mutex<HashMap<(QIdeal, QIdeal), Arc<HeckeTerms>>>,
    orbits: Mutex<Option<WeightOrbits>>,
}

/// A bound for the absolute values of the eigenvalues of T_P (U_P if P
/// divides the level) in weight k, under every embedding, as an exact
/// integer: (N(P) + 1) N(P)^ceil(mu/2), N(P) terms for U_P.
pub fn hecke_bound(w: &Weight, p: &QPrime, divides: bool) -> BigInt {
    let n = BigInt::from(p.norm);
    let terms = if divides { n.clone() } else { &n + BigInt::one() };
    terms * num_traits::pow(n, ((w.mu() + 1) / 2) as usize)
}

impl WeightNewspaces {
    /// The newspaces of level N and weight k for the maximal order O (one
    /// class set, with reduced norms prime to N(N), serves every divisor).
    pub fn new(order: &MaximalOrder, level: &QIdeal, weight: Weight) -> Result<WeightNewspaces, String> {
        let f = *order.alg().field();
        f.check(level)?;
        // the places need B = (a, b) with a, b in Z: refuse early
        place_pairs(order.alg())?.next().ok_or("internal error: no place splits the algebra")?;
        // all the divisor spaces are built: their number and size are
        // checked first, as for weight 2 (defnew.rs)
        let (_, total) = divisor_census(&f.factor(level)?)?;
        let nn = f.principal(&QElt::int(level.norm().to_i64().ok_or("level too large")?))?;
        let classes = Arc::new(ClassSet::coprime_to(order, &nn)?);
        if total * classes.len() as u128 > MAX_TOTAL_POINTS {
            return Err("H #P^1(O_F/M) over the divisors M of the level is too large (unsupported)".into());
        }
        let mut spaces = HashMap::new();
        let mut divs = vec![];
        for m in divisors(&f, level)? {
            sagebrush_interrupt::check();
            let q = f.ideal_div(level, &m)?.ok_or("internal error: not a divisor")?;
            divs.push((m, divisors(&f, &q)?.len()));
            let s = WeightSpace::new(Arc::new(DefiniteSpace::with_classes(classes.clone(), &m)?), weight)?;
            if s.dimension() > MAX_DIMENSION {
                return Err(format!("S_k at a level of norm {} has dimension {}, above the limit of {}", m.norm(), s.dimension(), MAX_DIMENSION));
            }
            spaces.insert(m, s);
        }
        divs.sort_by_key(|(m, _)| (m.norm(), m.hnf()));
        Ok(WeightNewspaces { level: *level, weight, field: f, order: order.clone(), spaces, divisors: divs, terms: Mutex::new(HashMap::new()), orbits: Mutex::new(None) })
    }

    pub fn field(&self) -> &QuadField {
        &self.field
    }
    pub fn space(&self, m: &QIdeal) -> Result<&WeightSpace, String> {
        self.spaces.get(m).ok_or_else(|| "not a divisor of the level".into())
    }
    pub fn top(&self) -> &WeightSpace {
        &self.spaces[&self.level]
    }

    fn divides(&self, p: &QPrime) -> Result<bool, String> {
        Ok(self.field.ideal_div(&self.level, &p.ideal)?.is_some())
    }

    /// The place-independent data of T_P on S_k(M), computed once.
    fn terms(&self, m: &QIdeal, p: &QPrime) -> Result<Arc<HeckeTerms>, String> {
        if let Some(t) = self.terms.lock().unwrap().get(&(*m, p.ideal)) {
            return Ok(t.clone());
        }
        // the neighbour elements of P, if already found for another divisor
        let theta = self.terms.lock().unwrap().iter().find(|((_, q), _)| *q == p.ideal).map(|(_, t)| t.theta.clone());
        let t = Arc::new(self.space(m)?.hecke_terms_with(p, theta.as_ref())?);
        self.terms.lock().unwrap().insert((*m, p.ideal), t.clone());
        Ok(t)
    }

    /// dim S_k^new(M) for every divisor M of N.
    pub fn new_dimensions(&self) -> Result<HashMap<QIdeal, usize>, String> {
        let mut nd: HashMap<QIdeal, usize> = HashMap::new();
        for (m, _) in &self.divisors {
            let mut old = 0;
            for d in divisors(&self.field, m)? {
                if d != *m {
                    let q = self.field.ideal_div(m, &d)?.ok_or("internal error: not a divisor")?;
                    old += divisors(&self.field, &q)?.len() * nd[&d];
                }
            }
            let full = self.space(m)?.dimension();
            nd.insert(*m, full.checked_sub(old).ok_or("internal error: the old part is larger than the space")?);
        }
        Ok(nd)
    }

    pub fn new_dimension(&self) -> Result<usize, String> {
        Ok(self.new_dimensions()?[&self.level])
    }

    /// A bound for the eigenvalues of op on S_k(M), M | N, under every
    /// embedding.
    pub fn op_bound(&self, op: &Op) -> Result<BigInt, String> {
        let mut b = BigInt::from(0);
        for (p, c) in op {
            b += BigInt::from(c.unsigned_abs()) * hecke_bound(&self.weight, p, self.divides(p)?);
        }
        Ok(b)
    }

    /// The modular work of op on the spaces `ms` at `places` places, checked
    /// against MAX_TOTAL_WORK (computing the place-independent data first).
    fn check_work(&self, ms: &[QIdeal], ops: &[&Op], places: usize) -> Result<u128, String> {
        self.within_cap(self.work(ms, ops, places)?)
    }

    fn within_cap(&self, w: u128) -> Result<u128, String> {
        if w > MAX_TOTAL_WORK as u128 {
            return Err(format!("this computation in weight {:?} needs about {} operations modulo primes, above the limit of {} (unsupported)", self.weight.k, w, MAX_TOTAL_WORK));
        }
        Ok(w)
    }

    /// The estimated modular work of ops on the spaces ms at `places`
    /// places (computing the place-independent data first).
    fn work(&self, ms: &[QIdeal], ops: &[&Op], places: usize) -> Result<u128, String> {
        let mut w: u128 = 0;
        for m in ms {
            let n = self.space(m)?.dimension() as u128;
            for op in ops {
                w += n * n * n;
                for (p, _) in op.iter() {
                    w += self.terms(m, p)?.work() as u128 + n * n;
                }
            }
        }
        Ok(w.saturating_mul(places as u128))
    }

    /// The estimated modular work of hecke_charpoly(p), in multiply-adds
    /// (an Err above MAX_TOTAL_WORK).
    pub fn hecke_charpoly_work(&self, p: &QPrime) -> Result<u128, String> {
        self.field.check(&p.ideal)?;
        let n = self.top().dimension();
        let k = pairs_needed(coefficient_bits(n, &hecke_bound(&self.weight, p, self.divides(p)?)))?;
        self.check_work(&[self.level], &[&vec![(*p, 1)]], 2 * k)
    }

    /// The matrix of op on S_k(M) at the place.
    pub fn op_mod(&self, m: &QIdeal, op: &Op, pl: &WPlace) -> Result<Mat, String> {
        let md = pl.md();
        let s = self.space(m)?;
        let n = s.dimension();
        let mut out = Mat::zero(n, n, md);
        for (p, c) in op {
            let t = s.hecke_mod(&*self.terms(m, p)?, pl)?;
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
    /// every divisor M of N, and the old part at N.
    fn new_charpolys_mod(&self, op: &Op, pl: &WPlace) -> Result<(HashMap<QIdeal, Vec<u64>>, Vec<u64>), String> {
        let md = pl.md();
        let mut new: HashMap<QIdeal, Vec<u64>> = HashMap::new();
        let mut top_old = vec![1];
        for (m, _) in &self.divisors {
            let full = self.op_mod(m, op, pl)?.charpoly();
            let mut old = vec![1u64];
            for d in divisors(&self.field, m)? {
                if d != *m {
                    let q = self.field.ideal_div(m, &d)?.ok_or("internal error: not a divisor")?;
                    for _ in 0..divisors(&self.field, &q)?.len() {
                        old = nmod_poly::mul(&old, &new[&d], &md);
                    }
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

    fn check_op(&self, op: &Op) -> Result<(), String> {
        for (p, _) in op {
            self.field.check(&p.ideal)?;
            if self.divides(p)? {
                return Err("the Hecke operator must involve only primes not dividing the level".into());
            }
        }
        Ok(())
    }

    /// k pairs of places above primes above 2^61.
    fn pairs(&self, k: usize) -> Result<Vec<(WPlace, WPlace)>, String> {
        let out: Vec<(WPlace, WPlace)> = place_pairs(self.order.alg())?.take(k).collect();
        if out.len() != k || out.iter().any(|pp| pp.0.p() >> 61 == 0) {
            return Err("internal error: not enough places above 2^61".into());
        }
        Ok(out)
    }

    fn crt(pairs: &[(WPlace, WPlace)]) -> PairCrt {
        PairCrt::new(&pairs.iter().map(|(a, b)| (a.pl, b.pl)).collect::<Vec<(GPlace, GPlace)>>())
    }

    /// The characteristic polynomial over O_F of op on S_k^new(M), for every
    /// divisor M of N.
    pub fn new_charpolys(&self, op: &Op) -> Result<HashMap<QIdeal, QPoly>, String> {
        self.check_op(op)?;
        let nd = self.new_dimensions()?;
        let (k, work) = self.recovery(op)?;
        self.within_cap(work)?;
        let pairs = self.pairs(k)?;
        let res: Vec<Result<(HashMap<QIdeal, Vec<u64>>, HashMap<QIdeal, Vec<u64>>), String>> =
            crate::par::map_range(pairs.len(), |t| Ok((self.new_charpolys_mod(op, &pairs[t].0)?.0, self.new_charpolys_mod(op, &pairs[t].1)?.0)));
        let res: Vec<(HashMap<QIdeal, Vec<u64>>, HashMap<QIdeal, Vec<u64>>)> = res.into_iter().collect::<Result<_, _>>()?;
        let crt = Self::crt(&pairs);
        let mut out = HashMap::new();
        for (m, _) in &self.divisors {
            let deg = nd[m];
            let get = |v: &Vec<u64>, t: usize| v.get(t).copied().unwrap_or(0);
            let f: QPoly = (0..=deg).map(|t| crt.reconstruct(&res.iter().map(|(a, b)| (get(&a[m], t), get(&b[m], t))).collect::<Vec<_>>())).collect();
            out.insert(*m, f);
        }
        Ok(out)
    }

    /// The pairs of places new_charpolys(op) uses and its modular work:
    /// the coefficient bound of the largest new dimension over the divisors
    /// of N (a divisor's can exceed N's), on every divisor space. The
    /// separating search reserves exactly this (daybreak HARD-F86-1).
    fn recovery(&self, op: &Op) -> Result<(usize, u128), String> {
        let d = self.new_dimensions()?.values().copied().max().unwrap_or(0);
        let k = pairs_needed(coefficient_bits(d, &self.op_bound(op)?))?;
        let ms: Vec<QIdeal> = self.divisors.iter().map(|(m, _)| *m).collect();
        Ok((k, self.work(&ms, &[op], 2 * k)?))
    }

    pub fn new_charpoly(&self, op: &Op) -> Result<QPoly, String> {
        Ok(self.new_charpolys(op)?.remove(&self.level).unwrap())
    }

    /// The characteristic polynomial over O_F of T_P (U_P if P divides N) on
    /// all of S_k(N).
    pub fn hecke_charpoly(&self, p: &QPrime) -> Result<QPoly, String> {
        self.field.check(&p.ideal)?;
        let n = self.top().dimension();
        if n == 0 {
            return Ok(vec![QElt::int(1)]);
        }
        let k = pairs_needed(coefficient_bits(n, &hecke_bound(&self.weight, p, self.divides(p)?)))?;
        self.hecke_charpoly_work(p)?;
        let pairs = self.pairs(k)?;
        let terms = self.terms(&self.level, p)?;
        let res: Vec<Result<(Vec<u64>, Vec<u64>), String>> = crate::par::map_range(pairs.len(), |t| {
            let s = self.top();
            Ok((s.hecke_mod(&terms, &pairs[t].0)?.charpoly(), s.hecke_mod(&terms, &pairs[t].1)?.charpoly()))
        });
        let res: Vec<(Vec<u64>, Vec<u64>)> = res.into_iter().collect::<Result<_, _>>()?;
        let crt = Self::crt(&pairs);
        Ok((0..=n).map(|t| crt.reconstruct(&res.iter().map(|(a, b)| (a[t], b[t])).collect::<Vec<_>>())).collect())
    }

    /// Whether op separates the newforms of level N, decided at one place:
    /// the new characteristic polynomial is squarefree and prime to the old
    /// part there, hence over F (they are monic).
    fn separates(&self, op: &Op, pl: &WPlace) -> Result<bool, String> {
        let md = pl.md();
        let (new, old) = self.new_charpolys_mod(op, pl)?;
        let g = &new[&self.level];
        if nmod_poly::degree(g) <= 0 {
            return Ok(true);
        }
        let rest = nmod_poly::mul(&old, &nmod_poly::derivative(g, &md), &md);
        Ok(nmod_poly::degree(&nmod_poly::gcd(g, &rest, &md)) == 0)
    }

    /// A separating operator, by the search of weightnew.rs.
    pub fn separating_operator(&self) -> Result<(Op, QPoly), String> {
        let pl = self.pairs(1)?[0].0;
        let op = self.search_separating(MAX_TOTAL_WORK as u128, |op| self.separates(op, &pl))?;
        let cp = self.new_charpoly(&op)?;
        Ok((op, cp))
    }

    /// The search for a separating operator, with `test` deciding each
    /// candidate. One budget of `cap` covers the whole search (daybreak
    /// HARD-A95-1): a candidate is tested only if the work of the failed
    /// tests so far, its own test (one place) and the recovery of its
    /// characteristic polynomial it would start (recovery(), the same
    /// estimate new_charpolys checks) all fit.
    fn search_separating(&self, cap: u128, mut test: impl FnMut(&Op) -> Result<bool, String>) -> Result<Op, String> {
        let primes: Vec<QPrime> = self.field.primes_of_bounded_norm(2000)?.into_iter().filter(|p| !self.divides(p).unwrap_or(true)).take(16).collect();
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let ms: Vec<QIdeal> = self.divisors.iter().map(|(m, _)| *m).collect();
        let mut budget = WorkBudget::new(cap);
        for attempt in 0..48usize {
            let k = (1 + attempt).min(primes.len());
            let range = [9u64, 101, 1001, 20001][(attempt / 4).min(3)];
            let op: Op = (0..k)
                .map(|t| {
                    let c = if t == 0 { 1 } else { (next() % range) as i64 - (range / 2) as i64 };
                    (primes[t], c)
                })
                .filter(|&(_, c)| c != 0)
                .collect();
            budget.admit(self.work(&ms, &[&op], 1)?, self.recovery(&op)?.1, self.weight)?;
            if test(&op)? {
                return Ok(op);
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
        let orbits = gpoly::factor_squarefree(&self.field, &cp, &self.op_bound(&op)?)?;
        let o = WeightOrbits { op, orbits };
        *self.orbits.lock().unwrap() = Some(o.clone());
        Ok(o)
    }

    /// For each orbit and each prime P in `primes`, the characteristic
    /// polynomial over O_F of a_P on the orbit, and h in O_F[x] of degree <
    /// deg g with a_P = h(theta)/g'(theta) (as weightnew::orbit_data; T_P, or
    /// U_P for P dividing N).
    #[allow(clippy::type_complexity)]
    pub fn orbit_data(&self, orbits: &WeightOrbits, primes: &[QPrime]) -> Result<(Vec<Vec<QPoly>>, Vec<Vec<QPoly>>), String> {
        for p in primes {
            self.field.check(&p.ideal)?;
        }
        let r = self.op_bound(&orbits.op)?;
        let mut bits: u64 = 0;
        for g in &orbits.orbits {
            let d = g.len() - 1;
            for p in primes {
                let b = hecke_bound(&self.weight, p, self.divides(p)?);
                bits = bits.max(coefficient_bits(d, &b));
                // the Lagrange bound d B (1 + R)^(d - 1), in integers
                bits = bits.max(bitlen(&BigInt::from(d)) + bitlen(&b) + (d as u64).saturating_sub(1) * bitlen(&(&r + BigInt::one())));
            }
        }
        let need = pairs_needed(bits)?;
        let tops = [self.level];
        let mut ops: Vec<Op> = primes.iter().map(|p| vec![(*p, 1)]).collect();
        ops.push(orbits.op.clone());
        self.check_work(&tops, &ops.iter().collect::<Vec<_>>(), 2 * (need + SPARE_PAIRS))?;
        let kept = usable_pairs(self.order.alg(), need, |pp| {
            let Some(a) = self.orbit_charpolys_mod(orbits, primes, &pp.0)? else { return Ok(None) };
            Ok(self.orbit_charpolys_mod(orbits, primes, &pp.1)?.map(|b| (a, b)))
        })?;
        let pairs: Vec<(WPlace, WPlace)> = kept.iter().map(|(pp, _)| *pp).collect();
        let crt = Self::crt(&pairs);
        let mut cps = vec![];
        let mut hs = vec![];
        for (k, g) in orbits.orbits.iter().enumerate() {
            let d = g.len() - 1;
            let mut row = vec![];
            let mut hrow = vec![];
            for t in 0..primes.len() {
                row.push((0..=d).map(|i| crt.reconstruct(&kept.iter().map(|(_, (a, b))| (a[k][t].0[i], b[k][t].0[i])).collect::<Vec<_>>())).collect());
                let at = |v: &Vec<u64>, i: usize| v.get(i).copied().unwrap_or(0);
                hrow.push(gpoly::trim((0..d).map(|i| crt.reconstruct(&kept.iter().map(|(_, (a, b))| (at(&a[k][t].1, i), at(&b[k][t].1, i))).collect::<Vec<_>>())).collect()));
            }
            cps.push(row);
            hs.push(hrow);
        }
        Ok((cps, hs))
    }

    /// orbit_data at one place, or None if the place is unusable (g not
    /// squarefree or not prime to its cofactor there, or Krylov vectors
    /// dependent).
    #[allow(clippy::type_complexity)]
    fn orbit_charpolys_mod(&self, orbits: &WeightOrbits, primes: &[QPrime], pl: &WPlace) -> Result<Option<Vec<Vec<(Vec<u64>, Vec<u64>)>>>, String> {
        let md = pl.md();
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
        let tps: Vec<Mat> = primes.iter().map(|q| self.top().hecke_mod(&*self.terms(&self.level, q)?, pl)).collect::<Result<_, _>>()?;
        let mut out = vec![];
        for g in &orbits.orbits {
            let gm = gpoly::reduce(g, &pl.pl);
            let d = g.len() - 1;
            let (h, r) = nmod_poly::divrem(&full, &gm, &md);
            if !nmod_poly::trim(r).is_empty() {
                return Err("internal error: an orbit's polynomial does not divide the characteristic polynomial".into());
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
            let ainv = a.inverse().ok_or("internal error: singular Krylov block")?;
            let mut per_p = vec![];
            for tp in &tps {
                let y = tp.mul_vec(&w[0]);
                let yp: Vec<u64> = piv.iter().map(|&r| y[r]).collect();
                let c = ainv.mul_vec(&yp);
                // T_P W_0 = sum c_j W_j on every coordinate
                for i in 0..n {
                    let s = (0..d).fold(0u64, |acc, j| md.add(acc, md.mul(c[j], w[j][i])));
                    if s != y[i] {
                        return Err("internal error: T_P does not preserve the orbit's eigenspace".into());
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

/// The pairs of places orbit_data may try beyond the `need` it uses, all
/// budgeted.
const SPARE_PAIRS: usize = 400;

/// The first `need` pairs of conjugate places at which `at` succeeds, with
/// its results, trying at most need + SPARE_PAIRS pairs (the number
/// budgeted; daybreak LIM-A95-4), else an error.
fn usable_pairs<T>(alg: &QuatAlg, need: usize, mut at: impl FnMut(&(WPlace, WPlace)) -> Result<Option<T>, String>) -> Result<Vec<((WPlace, WPlace), T)>, String> {
    let mut kept = vec![];
    for (tries, pp) in place_pairs(alg)?.enumerate() {
        if kept.len() >= need {
            break;
        }
        if tries >= need + SPARE_PAIRS {
            return Err("too many unusable places".into());
        }
        if pp.0.p() >> 61 == 0 {
            return Err("internal error: a modulus below 2^61".into());
        }
        if let Some(r) = at(&pp)? {
            kept.push((pp, r));
        }
    }
    if kept.len() < need {
        return Err("internal error: not enough places above 2^61".into());
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HARD-A95-1: the budget accumulates over failed attempts and counts
    /// the recovery an attempt would start.
    #[test]
    fn work_budget_accumulates() {
        let w = Weight::new(2, 4).unwrap();
        let mut b = WorkBudget::new(100);
        // three failed attempts of 30 with a recovery of 10 each fit
        for _ in 0..3 {
            b.admit(30, 10, w).unwrap();
        }
        assert_eq!(b.spent(), 90);
        // a fourth would exceed the cap with its recovery
        assert!(b.admit(5, 10, w).unwrap_err().contains("above the limit of 100"));
        assert_eq!(b.spent(), 90);
        // without it, it fits
        b.admit(5, 5, w).unwrap();
        // and saturation cannot wrap around
        assert!(WorkBudget::new(100).admit(u128::MAX, 1, w).is_err());
    }

    fn weight_newspaces(d: i64, n: i64, k: (u32, u32)) -> WeightNewspaces {
        let f = QuadField::new(d).unwrap();
        let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
        WeightNewspaces::new(&o, &f.principal(&QElt::int(n)).unwrap(), Weight::new(k.0, k.1).unwrap()).unwrap()
    }

    /// The 48 candidates of the search with every test failing, and per
    /// candidate the work of its test (one place) and of the recovery
    /// new_charpolys would run for it, computed here from the definition:
    /// the coefficient bound for the largest new dimension over the
    /// divisors, on every divisor space.
    fn candidates(ns: &WeightNewspaces) -> Vec<(Op, u128, u128, usize)> {
        let mut all: Vec<Op> = vec![];
        let e = ns.search_separating(u128::MAX, |op| {
            all.push(op.clone());
            Ok(false)
        });
        assert_eq!(e.unwrap_err(), "no separating Hecke operator found");
        assert_eq!(all.len(), 48);
        let ms: Vec<QIdeal> = ns.divisors.iter().map(|(m, _)| *m).collect();
        let d = *ns.new_dimensions().unwrap().values().max().unwrap();
        all.into_iter()
            .map(|op| {
                let k = pairs_needed(coefficient_bits(d, &ns.op_bound(&op).unwrap())).unwrap();
                assert_eq!(ns.recovery(&op).unwrap().0, k);
                let (now, then) = (ns.work(&ms, &[&op], 1).unwrap(), ns.work(&ms, &[&op], 2 * k).unwrap());
                assert!(now > 0);
                (op, now, then, k)
            })
            .collect()
    }

    /// The search under `cap` with every test failing: it must test exactly
    /// the candidates whose spent work, test and recovery fit (in order),
    /// and refuse the next one; returns how many it tested.
    fn tested_under(ns: &WeightNewspaces, all: &[(Op, u128, u128, usize)], cap: u128) -> usize {
        let mut seen: Vec<Op> = vec![];
        let e = ns.search_separating(cap, |op| {
            seen.push(op.clone());
            Ok(false)
        });
        assert!(e.unwrap_err().contains("above the limit"));
        let mut spent = 0;
        let mut want = 0;
        while want < all.len() && spent + all[want].1 + all[want].2 <= cap {
            spent += all[want].1;
            want += 1;
        }
        assert_eq!(seen.len(), want);
        assert!(seen.iter().zip(all).all(|(a, b)| *a == b.0));
        want
    }

    /// HARD-A95-1 in the search: with every candidate failing, the tests
    /// run and the last one's recovery fit the cap together, and the search
    /// is refused at the first candidate that would not, although that
    /// candidate alone (the check before the fix) fits.
    #[test]
    fn separating_search_one_budget() {
        let ns = weight_newspaces(5, 6, (2, 4));
        let all = candidates(&ns);
        // a cap that the first five tests and any one recovery fit
        let cap = all[..5].iter().map(|c| c.1).sum::<u128>() + all[..5].iter().map(|c| c.2).max().unwrap();
        let c = tested_under(&ns, &all, cap);
        assert!((5..48).contains(&c), "{} tests", c);
        assert!(all[c].1 + all[c].2 <= cap, "the refused candidate alone fits");
    }

    /// HARD-F86-1: the recovery reserved is that of new_charpolys, for the
    /// largest new dimension over the divisors, not the top one. Over
    /// Q(sqrt 6) at level (6) in weight (2, 4) the top new dimension is 3
    /// and a divisor's is 4; the fifth candidate needs 2 pairs, 1 for the
    /// top dimension. Under a cap one short of the first five tests and
    /// that recovery, the search stops after four tests (reserving 1 pair
    /// it would have run the fifth).
    #[test]
    fn separating_search_reserves_divisor_recovery() {
        let ns = weight_newspaces(6, 6, (2, 4));
        let nd = ns.new_dimensions().unwrap();
        assert_eq!(ns.new_dimension().unwrap(), 3);
        assert_eq!(*nd.values().max().unwrap(), 4);
        let all = candidates(&ns);
        let top = |op: &Op| pairs_needed(coefficient_bits(3, &ns.op_bound(op).unwrap())).unwrap();
        assert_eq!((all[4].3, top(&all[4].0)), (2, 1));
        let ms: Vec<QIdeal> = ns.divisors.iter().map(|(m, _)| *m).collect();
        let cap = all[..5].iter().map(|c| c.1).sum::<u128>() + all[4].2 - 1;
        assert!(all[..5].iter().map(|c| c.1).sum::<u128>() + ns.work(&ms, &[&all[4].0], 2).unwrap() <= cap);
        assert_eq!(tested_under(&ns, &all, cap), 4);
    }

    /// LIM-A95-4: with every place unusable, exactly need + SPARE_PAIRS
    /// pairs are tried; otherwise the first `need` usable ones are kept.
    #[test]
    fn usable_pairs_tries_the_budgeted_number() {
        let alg = QuatAlg::unramified(QuadField::new(13).unwrap()).unwrap();
        let mut tries = 0;
        let e = usable_pairs::<()>(&alg, 3, |_| {
            tries += 1;
            Ok(None)
        });
        assert_eq!(e.unwrap_err(), "too many unusable places");
        assert_eq!(tries, 3 + SPARE_PAIRS);
        // the last budgeted pair may still be the need-th usable one
        let mut tries = 0;
        let kept = usable_pairs(&alg, 3, |pp| {
            tries += 1;
            Ok((tries == 1 || tries == 2 || tries == 3 + SPARE_PAIRS).then_some(pp.0.p()))
        })
        .unwrap();
        assert_eq!(tries, 3 + SPARE_PAIRS);
        assert_eq!(kept.len(), 3);
        assert!(kept.iter().all(|(pp, p)| pp.0.p() == *p));
        // and nothing is tried once enough are kept
        let mut tries = 0;
        assert_eq!(usable_pairs(&alg, 2, |_| {
            tries += 1;
            Ok(Some(()))
        })
        .unwrap()
        .len(), 2);
        assert_eq!(tries, 2);
        assert!(usable_pairs::<()>(&alg, 0, |_| unreachable!()).unwrap().is_empty());
    }

    /// For tests/wasm-stop.mjs (the Stop button in wasm): a computation of
    /// several seconds, T at the prime of norm 3 on S_(6, 6)((9)) over
    /// Q(sqrt 13), of dimension 300, which must notice Stop and trap.
    #[test]
    #[ignore]
    fn stop_weight_charpoly() {
        let f = QuadField::new(13).unwrap();
        let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
        let ns = WeightNewspaces::new(&o, &f.principal(&QElt::int(9)).unwrap(), Weight::new(6, 6).unwrap()).unwrap();
        let p = f.primes_above(3).unwrap()[0];
        println!("not interrupted: {:?}", ns.hecke_charpoly(&p).map(|c| c.len()));
    }
}
