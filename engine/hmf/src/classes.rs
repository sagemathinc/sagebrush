//! The right ideal classes of a maximal order O in the totally definite
//! quaternion algebra B over a real quadratic field F (quatalg.rs): the
//! set Cl O of the definite method (Dembélé-Voight 2013, section 4), with
//! the left order O_i = O_L(I_i) of each representative I_i and its unit
//! group O_i^x / O_F^x.
//!
//! The method is that of Kirschmer and Voight, "Algorithmic enumeration of
//! ideal classes for quaternion orders", SIAM J. Comput. 39 (2010):
//!
//! - Neighbours (section 7, Lemma 7.2 and Algorithm 7.4). For a prime P of
//!   F and a right O-ideal I, the right O-ideals J inside I with nrd(J) =
//!   P nrd(I) are in bijection with P^1(O_F/P). Here they come from a
//!   splitting of O at P: with e an idempotent of O lifting the matrix unit
//!   e11 of O/PO = M_2(k), V = I/PI is a free right M_2(k)-module of rank
//!   one, V e is a plane over k, and the N(P) + 1 neighbours are
//!   J = PI + v O for v in I e spanning the lines of V e (the submodules of
//!   V of dimension 2 over k are the v M_2(k) with v e = v).
//! - Isomorphism (section 6, Algorithm 6.3, with Lemma 2.5): J = xI for
//!   some x in B if and only if the lattice J I^-1 = J conj(I) nrd(I)^-1
//!   contains x with nrd(x) = nu z, where nu is a totally positive generator
//!   of nrd(J) nrd(I)^-1 (which must be narrowly principal) and z runs over
//!   the totally positive units modulo squares: 1, and the fundamental unit
//!   eps when N(eps) = 1. Such an x is a vector with Tr_{F/Q}(nrd(x)/(nu z))
//!   = 2, the least value of that positive definite form (the
//!   arithmetic-geometric mean inequality), found by LLL and Fincke-Pohst
//!   (theta.rs). Each isomorphism found is checked: x I is inside J and
//!   nrd(x I) = nrd(J), so x I = J.
//! - Termination by the mass (Remark 5.2 and Proposition 5.1, from
//!   Vignéras, "Arithmétique des algèbres de quaternions", 1980, V.2):
//!   the sum over Cl O of 1/[O_L(I)^x : O_F^x] is 2^(1-n) zeta_F(-1) h_F
//!   (D = N = 1), with zeta_F(-1) from Siegel's formula (`zeta_minus_one`).
//!   Neighbours of the classes found so far are added, a prime at a time,
//!   until the classes reach the mass exactly; a sum above the mass is an
//!   error, never an answer.
//! - Unit groups: [O_i^x : O_F^x] = (#{x : nrd x = 1} + #{x : nrd x = eps})/2,
//!   the second set only when N(eps) = 1 (the units' reduced norms are the
//!   totally positive units, and x ~ x u for u in O_F^x changes nrd by u^2).
//!   Both sets are the vectors with Tr_{F/Q}(nrd(x)/z) = 2 in O_i.
//!
//! Left orders are O_L(I) = I I^-1 with I^-1 = conj(I) nrd(I)^-1, certified
//! as maximal orders (closed, containing O_F, of discriminant d_F^4).
//!
//! The short vectors: the forms Tr_{F/Q}(nrd(x) mu) are rational and, when
//! the fundamental unit is large, very skewed, so they are scaled to
//! integers and reduced exactly first (the integral LLL of Cohen, Algorithm
//! 2.6.7, on big integers); Fincke-Pohst then runs on the reduced basis, and
//! every vector found is checked exactly. Before an isomorphism test, two
//! invariants of the classes are compared: the weight, and the numbers of
//! x in the left order with Tr nrd(x) = 3, 4, 5, 6 (isomorphic ideals have
//! conjugate left orders). A failed search could only add a class twice,
//! and then the classes would exceed the mass, which is an error.

use crate::qresidue::QLocalRing;
use crate::quatalg::{BElt, Lattice, MaximalOrder, QuatAlg};
use crate::rqf::{ClassGroup, QElt, QFrac, QIdeal, QPrime, QuadField};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// A rational number num/den in lowest terms, den > 0 (made by `new`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rat {
    pub(crate) num: BigInt,
    pub(crate) den: BigInt,
}

impl Rat {
    pub fn num(&self) -> &BigInt {
        &self.num
    }
    pub fn den(&self) -> &BigInt {
        &self.den
    }
    pub fn new(num: BigInt, den: BigInt) -> Rat {
        assert!(!den.is_zero(), "zero denominator");
        let g = num.gcd(&den);
        let s = if den.is_negative() { -g } else { g };
        Rat { num: num / &s, den: den / &s }
    }
    pub fn zero() -> Rat {
        Rat { num: BigInt::zero(), den: BigInt::one() }
    }
    pub fn add(&self, o: &Rat) -> Rat {
        Rat::new(&self.num * &o.den + &o.num * &self.den, &self.den * &o.den)
    }
    pub fn mul(&self, o: &Rat) -> Rat {
        Rat::new(&self.num * &o.num, &self.den * &o.den)
    }
    fn gt(&self, o: &Rat) -> bool {
        &self.num * &o.den > &o.num * &self.den
    }
}

impl std::fmt::Display for Rat {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.den.is_one() {
            write!(f, "{}", self.num)
        } else {
            write!(f, "{}/{}", self.num, self.den)
        }
    }
}

/// sigma_1(n), the sum of the divisors of n > 0.
fn sigma1(n: i128) -> i128 {
    let mut s = 0;
    let mut d = 1;
    while d * d <= n {
        if n % d == 0 {
            s += d;
            if d * d != n {
                s += n / d;
            }
        }
        d += 1;
    }
    s
}

/// zeta_F(-1) for a real quadratic field of discriminant D, by Siegel's
/// formula zeta_F(-1) = (1/60) sum sigma_1((D - b^2)/4) over the integers b
/// with b^2 < D and b = D mod 2 (C. L. Siegel, "Berechnung von
/// Zetafunktionen an ganzzahligen Stellen", Nachr. Akad. Wiss. Göttingen
/// 1969; see D. Zagier, "On the values at negative integers of the
/// zeta-function of a real quadratic field", Enseign. Math. 22 (1976)). The
/// tests compare it with zeta(-1) L(-1, chi_D) = B_{2,chi_D}/24.
pub fn zeta_minus_one(f: &QuadField) -> Result<Rat, String> {
    let d = f.disc as i128;
    if d > 1 << 32 {
        return Err("zeta_F(-1) is implemented for discriminants below 2^32".into());
    }
    let mut s: i128 = 0;
    let mut b: i128 = d % 2;
    while b * b < d {
        let t = sigma1((d - b * b) / 4);
        s += if b == 0 { t } else { 2 * t };
        b += 2;
    }
    Ok(Rat::new(BigInt::from(s), BigInt::from(60)))
}

/// The number of coefficients of the left orders' theta series compared
/// before an isomorphism test.
const THETA: usize = 4;

/// A right O-ideal: its lattice and its reduced norm.
#[derive(Clone, Debug)]
pub struct RightIdeal {
    pub(crate) lattice: Lattice,
    pub(crate) nrd: QIdeal,
}

impl RightIdeal {
    pub fn lattice(&self) -> &Lattice {
        &self.lattice
    }
    pub fn nrd(&self) -> QIdeal {
        self.nrd
    }
}

/// An ideal class: a representative I, its left order, and the units of the
/// left order of reduced norm 1 and (when N(eps) = 1) of reduced norm eps.
#[derive(Clone, Debug)]
pub struct IdealClass {
    pub(crate) ideal: RightIdeal,
    pub(crate) left_order: MaximalOrder,
    pub(crate) units_one: Vec<BElt>,
    pub(crate) units_eps: Vec<BElt>,
    /// The basis of I^-1.
    pub(crate) inverse: Vec<BElt>,
    /// The numbers of x in the left order with Tr nrd(x) = 3, ..., THETA + 2:
    /// an invariant of the class (isomorphic ideals have conjugate left
    /// orders).
    pub(crate) theta: [usize; THETA],
}

impl IdealClass {
    pub fn ideal(&self) -> &RightIdeal {
        &self.ideal
    }
    pub fn left_order(&self) -> &MaximalOrder {
        &self.left_order
    }
    /// The units of the left order of reduced norm 1 (the group O_1^x).
    pub fn units_one(&self) -> &[BElt] {
        &self.units_one
    }
    /// The units of the left order of reduced norm eps (empty unless
    /// N(eps) = 1).
    pub fn units_eps(&self) -> &[BElt] {
        &self.units_eps
    }
    /// [O_L(I)^x : O_F^x].
    pub fn weight(&self) -> usize {
        (self.units_one.len() + self.units_eps.len()) / 2
    }
}

/// Cl O, with the data to place any right O-ideal in its class.
pub struct ClassSet {
    order: MaximalOrder,
    class_group: ClassGroup,
    classes: Vec<IdealClass>,
    mass: Rat,
    primes: Vec<QPrime>,
}

fn central(x: &QElt) -> BElt {
    BElt::from_coords([x.clone(), QElt::int(0), QElt::int(0), QElt::int(0)])
}

/// The Z-basis a, b + c w of an ideal.
fn ideal_basis(i: &QIdeal) -> [QElt; 2] {
    let (a, b, c) = i.hnf();
    [QElt { a: BigInt::from(a), b: BigInt::zero() }, QElt { a: BigInt::from(b), b: BigInt::from(c) }]
}

/// The Z-span of the products x y (x in xs, y in ys), given that it
/// contains m Lambda.
fn product(alg: &QuatAlg, xs: &[BElt], ys: &[BElt], m: &BigInt) -> Lattice {
    let mut gens = vec![];
    for x in xs {
        for y in ys {
            gens.push(alg.mul(x, y));
        }
    }
    Lattice::from_gens_containing(&gens, m)
}

/// I^-1 = conj(I) nrd(I)^-1 = conj(I) conj(nrd I) / N(nrd I), which
/// contains conj(I), so N(nrd I) Lambda.
fn inverse(alg: &QuatAlg, ideal: &RightIdeal) -> Result<Lattice, String> {
    let f = alg.field();
    let nn = BigInt::from(ideal.nrd.norm());
    let nconj = f.ideal_conj(&ideal.nrd)?;
    let mut gens = vec![];
    for x in ideal.lattice.basis() {
        let cx = alg.conj(&x);
        for s in ideal_basis(&nconj) {
            gens.push(alg.mul(&cx, &central(&s)).div_int(&nn));
        }
    }
    Ok(Lattice::from_gens_containing(&gens, &nn))
}

/// Tr_{F/Q} of an element of F, as a rational.
fn trace_q(f: &QuadField, x: &QFrac) -> Rat {
    Rat::new(&x.a * BigInt::from(2) + &x.b * BigInt::from(f.t), x.den.clone())
}

/// The vectors x != 0 of the lattice with basis `basis` with
/// Tr_{F/Q}(nrd(x) mu) <= bound (mu totally positive), passed to `keep`;
/// the search stops at the first x that `keep` accepts if `first`.
fn short_vectors(alg: &QuatAlg, basis: &[BElt], mu: &QFrac, bound: i64, first: bool, keep: &mut dyn FnMut(&BElt) -> bool) -> Result<Vec<BElt>, String> {
    let f = alg.field();
    // the Gram matrix of B(x, y) = Tr(trd(x conj y) mu), with Q(x) = B(x, x)/2
    let mut gram = vec![vec![Rat::zero(); 8]; 8];
    for s in 0..8 {
        for t in s..8 {
            let tr = alg.trd(&alg.mul(&basis[s], &alg.conj(&basis[t])));
            let v = trace_q(f, &f.fmul(&tr, mu));
            gram[s][t] = v.clone();
            gram[t][s] = v;
        }
    }
    let l = gram.iter().flatten().fold(BigInt::one(), |l, r| l.lcm(&r.den));
    let ints: Vec<Vec<BigInt>> = gram.iter().map(|row| row.iter().map(|r| &r.num * (&l / &r.den)).collect()).collect();
    let bound_l = BigInt::from(bound) * &l;
    let c = ints.iter().flatten().fold(bound_l.clone(), |g, x| g.gcd(x));
    let ints: Vec<Vec<BigInt>> = ints.iter().map(|row| row.iter().map(|x| x / &c).collect()).collect();
    // reduce exactly first: the form can be very skewed (a large fundamental
    // unit), beyond the floating-point LLL of theta.rs
    let red = lll_exact(&ints)?;
    let lim = BigInt::from(1i64 << 60);
    let mut g = [[0i128; 8]; 8];
    for s in 0..8 {
        for t in 0..8 {
            let v = dot(&ints, &red[s], &red[t]);
            if v.abs() >= lim {
                return Err("the reduced quadratic form is too large (unsupported)".into());
            }
            g[s][t] = v.to_i128().unwrap();
        }
    }
    let bound_c = (&bound_l / &c).to_i128().filter(|b| *b < 1 << 60).ok_or("the bound is too large (unsupported)")?;
    // the reduced basis, as elements
    let rb: Vec<BElt> = red
        .iter()
        .map(|v| {
            let mut x = BElt::integral(std::array::from_fn(|_| BigInt::zero()));
            for (s, vs) in v.iter().enumerate() {
                if !vs.is_zero() {
                    x = alg.add(&x, &BElt::new(basis[s].c.clone().map(|c| c * vs), basis[s].den.clone()));
                }
            }
            x
        })
        .collect();
    let mut b: Vec<[i128; 8]> = (0..8)
        .map(|s| {
            let mut v = [0i128; 8];
            v[s] = 1;
            v
        })
        .collect();
    crate::theta::lll(&mut b, &g);
    let mut out = vec![];
    crate::theta::enumerate(&b, &g, bound_c, &mut |v| {
        let mut x = BElt::integral(std::array::from_fn(|_| BigInt::zero()));
        for (s, &vs) in v.iter().enumerate() {
            if vs != 0 {
                let term = BElt::new(rb[s].c.clone().map(|c| c * BigInt::from(vs)), rb[s].den.clone());
                x = alg.add(&x, &term);
            }
        }
        if keep(&x) {
            out.push(x);
            return first;
        }
        false
    });
    Ok(out)
}

/// u^T G v.
fn dot(g: &[Vec<BigInt>], u: &[BigInt], v: &[BigInt]) -> BigInt {
    let mut s = BigInt::zero();
    for i in 0..u.len() {
        if u[i].is_zero() {
            continue;
        }
        for j in 0..v.len() {
            if !v[j].is_zero() {
                s += &u[i] * &g[i][j] * &v[j];
            }
        }
    }
    s
}

/// The integral LLL algorithm (Cohen, "A Course in Computational Algebraic
/// Number Theory", Algorithm 2.6.7, with delta = 99/100) for the positive
/// definite integral Gram matrix g: the coefficient vectors (in the original
/// basis) of a reduced basis. Exact: it uses only the integers d_i and
/// lambda_ij, and only unimodular steps (swaps and integral translations).
fn lll_exact(g: &[Vec<BigInt>]) -> Result<Vec<Vec<BigInt>>, String> {
    let n = g.len();
    let mut b: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| if i == j { BigInt::one() } else { BigInt::zero() }).collect()).collect();
    // d[0] = 1, d[i + 1] = d_i of Cohen (1-based); lam[k][j] = lambda_kj
    let mut d = vec![BigInt::one(); n + 1];
    let mut lam = vec![vec![BigInt::zero(); n]; n];
    let mut kmax = 0usize;
    d[1] = dot(g, &b[0], &b[0]);
    if !d[1].is_positive() {
        return Err("internal error: the form is not positive definite".into());
    }
    let mut k = 1usize; // 0-based index of Cohen's k
    let two = BigInt::from(2);
    let red = |k: usize, l: usize, b: &mut Vec<Vec<BigInt>>, lam: &mut Vec<Vec<BigInt>>, d: &Vec<BigInt>| {
        // if 2 |lambda_kl| > d_l: q = round(lambda_kl / d_l)
        if &lam[k][l].abs() * &two > d[l + 1] {
            let q = (&lam[k][l] * &two + &d[l + 1]).div_floor(&(&d[l + 1] * &two));
            for t in 0..n {
                let v = &q * &b[l][t];
                b[k][t] -= v;
            }
            lam[k][l] -= &q * &d[l + 1];
            for i in 0..l {
                let v = &q * &lam[l][i];
                lam[k][i] -= v;
            }
        }
    };
    let mut steps = 0u64;
    while k < n {
        steps += 1;
        if steps > 1_000_000 {
            return Err("internal error: LLL did not terminate".into());
        }
        if k > kmax {
            kmax = k;
            for j in 0..=k {
                let mut u = dot(g, &b[k], &b[j]);
                for i in 0..j {
                    u = (&d[i + 1] * &u - &lam[k][i] * &lam[j][i]) / &d[i];
                }
                if j < k {
                    lam[k][j] = u;
                } else {
                    if !u.is_positive() {
                        return Err("internal error: the form is not positive definite".into());
                    }
                    d[k + 1] = u;
                }
            }
        }
        red(k, k - 1, &mut b, &mut lam, &d);
        // Lovasz: 100 d_k d_(k-2) < 99 d_(k-1)^2 - 100 lambda^2 means swap
        let lhs = BigInt::from(100) * &d[k + 1] * &d[k - 1];
        let rhs = BigInt::from(99) * &d[k] * &d[k] - BigInt::from(100) * &lam[k][k - 1] * &lam[k][k - 1];
        if lhs < rhs {
            b.swap(k, k - 1);
            for j in 0..k - 1 {
                let t = lam[k][j].clone();
                lam[k][j] = lam[k - 1][j].clone();
                lam[k - 1][j] = t;
            }
            let l = lam[k][k - 1].clone();
            let bb = (&d[k - 1] * &d[k + 1] + &l * &l) / &d[k];
            for i in k + 1..=kmax {
                let t = lam[i][k].clone();
                lam[i][k] = (&d[k + 1] * &lam[i][k - 1] - &l * &t) / &d[k];
                lam[i][k - 1] = (&bb * &t + &l * &lam[i][k]) / &d[k + 1];
            }
            d[k] = bb;
            if k > 1 {
                k -= 1;
            }
        } else {
            for l in (0..k - 1).rev() {
                red(k, l, &mut b, &mut lam, &d);
            }
            k += 1;
        }
    }
    Ok(b)
}

impl ClassSet {
    /// Cl O for the maximal order O.
    pub fn new(order: &MaximalOrder) -> Result<ClassSet, String> {
        ClassSet::coprime_to(order, &order.alg().field().unit_ideal())
    }

    /// Cl O, with representatives whose reduced norms are prime to n (the
    /// neighbours are taken at primes not dividing n).
    pub fn coprime_to(order: &MaximalOrder, n: &QIdeal) -> Result<ClassSet, String> {
        let alg = order.alg().clone();
        let f = *alg.field();
        f.check(n)?;
        let class_group = f.class_group();
        let mass = zeta_minus_one(&f)?.mul(&Rat::new(BigInt::from(class_group.h()), BigInt::from(2)));
        let mut set = ClassSet { order: order.clone(), class_group, classes: vec![], mass, primes: vec![] };
        let o = RightIdeal { lattice: order.lattice().clone(), nrd: f.unit_ideal() };
        let first = set.make_class(o)?;
        let mut sum = Rat::new(BigInt::one(), BigInt::from(first.weight()));
        set.classes.push(first);
        const MAX_CLASSES: usize = 5000;
        // the primes S grow one at a time, in order of norm, when the classes
        // closed under the neighbours at all of S fall short of the mass (as
        // in Kirschmer-Voight, Algorithm 7.4, every class gets the neighbours
        // at every prime of S: once S generates the narrow class group, the
        // closure is all of Cl O by strong approximation, their Proposition
        // 7.3)
        let mut candidates = f.primes_of_bounded_norm(2000)?.into_iter();
        let mut idempotents: Vec<BElt> = vec![];
        let mut done: Vec<usize> = vec![0]; // primes of S applied to each class
        while sum != set.mass {
            let p = loop {
                let p = candidates.next().ok_or_else(|| format!("the neighbours at primes of norm <= 2000 did not reach the mass {} (found {})", set.mass, sum))?;
                if f.ideal_div(n, &p.ideal)?.is_none() {
                    break p;
                }
            };
            idempotents.push(order.local_splitting(p, 1)?.matrix_units()[0].clone());
            set.primes.push(p);
            let mut i = 0;
            while i < set.classes.len() && sum != set.mass {
                while done[i] < set.primes.len() && sum != set.mass {
                    let (q, e) = (set.primes[done[i]], idempotents[done[i]].clone());
                    done[i] += 1;
                    let ideal = set.classes[i].ideal.clone();
                    for j in set.neighbours(&ideal, &q, &e)? {
                        let c = set.make_class(j)?;
                        if set.find(&c)?.is_none() {
                            sum = sum.add(&Rat::new(BigInt::one(), BigInt::from(c.weight())));
                            if sum.gt(&set.mass) {
                                return Err(format!("internal error: the classes found exceed the mass {}", set.mass));
                            }
                            set.classes.push(c);
                            done.push(0);
                            if set.classes.len() > MAX_CLASSES {
                                return Err(format!("more than {} ideal classes (unsupported)", MAX_CLASSES));
                            }
                            if sum == set.mass {
                                break;
                            }
                        }
                    }
                }
                i += 1;
            }
        }
        if sum != set.mass {
            return Err(format!("the neighbours at primes of norm <= 2000 did not reach the mass {} (found {})", set.mass, sum));
        }
        Ok(set)
    }

    pub fn order(&self) -> &MaximalOrder {
        &self.order
    }
    pub fn classes(&self) -> &[IdealClass] {
        &self.classes
    }
    /// The class number H = #Cl O.
    pub fn len(&self) -> usize {
        self.classes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.classes.is_empty()
    }
    /// The mass 2^(1-n) zeta_F(-1) h_F, the sum of the 1/weights.
    pub fn mass(&self) -> &Rat {
        &self.mass
    }
    /// The primes whose neighbours were used.
    pub fn primes(&self) -> &[QPrime] {
        &self.primes
    }
    pub fn class_group(&self) -> &ClassGroup {
        &self.class_group
    }

    /// The class of a right O-ideal J: the index k and x with J = x I_k.
    pub fn locate(&self, j: &RightIdeal) -> Result<(usize, BElt), String> {
        for k in 0..self.classes.len() {
            if let Some(x) = self.isomorphism(j, k)? {
                return Ok((k, x));
            }
        }
        Err("internal error: the ideal is in no class".into())
    }

    fn alg(&self) -> &QuatAlg {
        self.order.alg()
    }

    /// The class of the ideal j, with its left order and units.
    fn make_class(&self, ideal: RightIdeal) -> Result<IdealClass, String> {
        let alg = self.alg();
        let f = alg.field();
        let nn = BigInt::from(ideal.nrd.norm());
        // O_L(I) = I I^-1, containing I conj(I), which contains
        // N(nrd I)^2 Lambda
        let inv = inverse(alg, &ideal)?.basis();
        let lat = product(alg, &ideal.lattice.basis(), &inv, &(&nn * &nn));
        let left_order = MaximalOrder::from_lattice(alg, lat)?;
        let one = QFrac::one();
        let units_one = short_vectors(alg, left_order.basis(), &one, 2, false, &mut |x| alg.nrd(x) == one)?;
        let cg = &self.class_group;
        let units_eps = if cg.eps_norm == 1 {
            let eps = cg.eps.frac();
            // 1/eps = conj(eps) when N(eps) = 1
            let inv = f.conj(&cg.eps).frac();
            short_vectors(alg, left_order.basis(), &inv, 2, false, &mut |x| alg.nrd(x) == eps)?
        } else {
            vec![]
        };
        if units_one.is_empty() || (units_one.len() + units_eps.len()) % 2 != 0 {
            return Err("internal error: the unit group is inconsistent".into());
        }
        let mut theta = [0usize; THETA];
        short_vectors(alg, left_order.basis(), &one, THETA as i64 + 2, false, &mut |x| {
            let t = trace_q(f, &alg.nrd(x));
            if let Some(v) = t.num.to_usize().filter(|_| t.den.is_one()) {
                if (3..THETA + 3).contains(&v) {
                    theta[v - 3] += 1;
                }
            }
            false
        })?;
        Ok(IdealClass { ideal, left_order, units_one, units_eps, inverse: inv, theta })
    }

    /// The index of a known class isomorphic to c, if any (only classes with
    /// the same weight and the same narrow class of nrd can be).
    fn find(&self, c: &IdealClass) -> Result<Option<usize>, String> {
        let cg = &self.class_group;
        let nc = cg.narrow_class(&c.ideal.nrd)?;
        for (k, d) in self.classes.iter().enumerate() {
            if d.weight() != c.weight() || d.theta != c.theta || cg.narrow_class(&d.ideal.nrd)? != nc {
                continue;
            }
            if self.isomorphism(&c.ideal, k)?.is_some() {
                return Ok(Some(k));
            }
        }
        Ok(None)
    }

    /// x with J = x I_k, if J and I_k are isomorphic.
    fn isomorphism(&self, j: &RightIdeal, k: usize) -> Result<Option<BElt>, String> {
        let alg = self.alg();
        let f = alg.field();
        let cg = &self.class_group;
        let ik = &self.classes[k].ideal;
        if cg.narrow_class(&j.nrd)? != cg.narrow_class(&ik.nrd)? {
            return Ok(None);
        }
        // nu = beta / N(nrd I_k), beta a totally positive generator of
        // nrd(J) conj(nrd I_k), generates nrd(J) nrd(I_k)^-1
        let nk = BigInt::from(ik.nrd.norm());
        let nj = BigInt::from(j.nrd.norm());
        let b_ideal = f.ideal_mul(&j.nrd, &f.ideal_conj(&ik.nrd)?)?;
        let beta = cg.totally_positive_generator(&b_ideal)?.ok_or("internal error: nrd(J) nrd(I)^-1 is not narrowly principal")?;
        // J I_k^-1, containing J conj(I_k), which contains
        // N(nrd J) N(nrd I_k) Lambda
        let ikb = ik.lattice.basis();
        let lat = product(alg, &j.lattice.basis(), &self.classes[k].inverse, &(&nj * &nk));
        let mut zs = vec![QElt::int(1)];
        if cg.eps_norm == 1 {
            zs.push(cg.eps.clone());
        }
        for z in zs {
            let bz = f.mul(&beta, &z);
            let nu = QFrac::new(bz.a.clone(), bz.b.clone(), nk.clone());
            let mu = f.finv(&nu);
            let found = short_vectors(alg, &lat.basis(), &mu, 2, true, &mut |x| alg.nrd(x) == nu)?;
            if let Some(x) = found.into_iter().next() {
                // check: x I_k is inside J, and nrd(x I_k) = nrd(J)
                if ikb.iter().all(|y| j.lattice.contains(&alg.mul(&x, y))) {
                    return Ok(Some(x));
                }
                return Err("internal error: an isomorphism failed its check".into());
            }
        }
        Ok(None)
    }

    /// The N(P) + 1 right O-ideals J inside I with nrd(J) = P nrd(I), for
    /// e an idempotent of O lifting e11 of O/PO = M_2(k).
    fn neighbours(&self, i: &RightIdeal, p: &QPrime, e: &BElt) -> Result<Vec<RightIdeal>, String> {
        let alg = self.alg();
        let f = alg.field();
        let q = p.norm as u64;
        let ni = BigInt::from(i.nrd.norm());
        let m = &ni * BigInt::from(q);
        let ib = i.lattice.basis();
        let pb: Vec<BElt> = ideal_basis(&p.ideal).iter().map(central).collect();
        // P I, containing N(P) N(nrd I) Lambda
        let mut pi_gens = vec![];
        for s in &pb {
            for x in &ib {
                pi_gens.push(alg.mul(s, x));
            }
        }
        let pi = Lattice::from_gens_containing(&pi_gens, &m);
        let w = central(&QElt::new(0, 1));
        // a basis w1, w2 of V e = (I e + P I)/P I over k
        let ie: Vec<BElt> = ib.iter().map(|x| alg.mul(x, e)).collect();
        let w1 = ie.iter().find(|v| !pi.contains(v)).ok_or("internal error: I e lies in P I")?.clone();
        let mut m1_gens = pi.basis();
        m1_gens.push(w1.clone());
        m1_gens.push(alg.mul(&w, &w1));
        let m1 = Lattice::from_gens_containing(&m1_gens, &m);
        let w2 = ie.iter().find(|v| !m1.contains(v)).ok_or("internal error: V e has dimension 1")?.clone();
        // the lines: k w1, and k (w2 + t w1) for t in k
        let k = QLocalRing::new(f, *p, 1)?;
        let mut vs = vec![w1.clone()];
        for t in 0..k.card() {
            let tt = central(&k.lift(k.element(t)));
            vs.push(alg.add(&w2, &alg.mul(&tt, &w1)));
        }
        let ob = self.order.basis();
        let nrd = f.ideal_mul(&i.nrd, &p.ideal)?;
        let (ci, di) = i.lattice.covolume();
        let mut out = vec![];
        for v in vs {
            let mut gens = pi.basis();
            for o in ob {
                gens.push(alg.mul(&v, o));
            }
            let lattice = Lattice::from_gens_containing(&gens, &m);
            // check [I : J] = N(P)^2
            let (cj, dj) = lattice.covolume();
            if &cj * &di != &ci * &dj * BigInt::from(q * q) {
                return Err("internal error: a neighbour has the wrong index".into());
            }
            out.push(RightIdeal { lattice, nrd });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// zeta(-1) L(-1, chi_D) = B_{2,chi}/24 with B_{2,chi} = D sum_{a=1}^{D}
    /// chi(a) B_2(a/D), B_2(x) = x^2 - x + 1/6, and chi the Kronecker symbol
    /// (D/.).
    fn zeta_bernoulli(d: i64) -> Rat {
        let kron = |a: i64| -> i64 {
            // (D/a) for a > 0 by multiplicativity over the factors of a
            let mut r = 1i64;
            let mut m = a;
            let mut p = 2;
            while m > 1 {
                if p * p > m {
                    p = m;
                }
                while m % p == 0 {
                    m /= p;
                    let s = if p == 2 {
                        if d % 2 == 0 {
                            0
                        } else if d.rem_euclid(8) == 1 || d.rem_euclid(8) == 7 {
                            1
                        } else {
                            -1
                        }
                    } else {
                        let t = crate::field::pow_mod(d.rem_euclid(p) as u64, (p as u64 - 1) / 2, p as u64);
                        if t == 0 {
                            0
                        } else if t == 1 {
                            1
                        } else {
                            -1
                        }
                    };
                    r *= s;
                }
                p += 1;
            }
            r
        };
        // B_{2,chi} = D sum chi(a) (a^2/D^2 - a/D + 1/6) = sum chi(a) (6 a^2 - 6 a D + D^2) / (6 D)
        let mut s = BigInt::zero();
        for a in 1..=d {
            let c = kron(a);
            if c != 0 {
                s += BigInt::from(c) * BigInt::from(6 * a * a - 6 * a * d + d * d);
            }
        }
        Rat::new(s, BigInt::from(6 * d * 24))
    }

    #[test]
    fn zeta_values() {
        // zeta(-1) = 1/30 for Q(sqrt 5), 1/12 for Q(sqrt 2), 1/6 for Q(sqrt 3)
        for (d, n, m) in [(5i64, 1, 30), (2, 1, 12), (3, 1, 6)] {
            assert_eq!(zeta_minus_one(&QuadField::new(d).unwrap()).unwrap(), Rat::new(BigInt::from(n), BigInt::from(m)));
        }
        // Siegel's formula against the generalized Bernoulli number
        for d in 2..400i64 {
            let Ok(f) = QuadField::new(d) else { continue };
            assert_eq!(zeta_minus_one(&f).unwrap(), zeta_bernoulli(f.disc), "D = {}", f.disc);
        }
    }

    #[test]
    fn exact_lll() {
        // a skewed form: the result is a unimodular change of basis, and
        // the reduced Gram matrix has the same determinant
        let mut g = vec![vec![BigInt::zero(); 8]; 8];
        for i in 0..8 {
            for j in 0..8 {
                let v: i128 = if i == j { 10i128.pow(30) + (i as i128) * 7 } else { ((i * 31 + j * 17) % 11) as i128 * 10i128.pow(15) };
                g[i][j] = BigInt::from(v);
            }
        }
        for i in 0..8 {
            for j in 0..i {
                g[i][j] = g[j][i].clone();
            }
        }
        let b = lll_exact(&g).unwrap();
        let m = sagebrush_arith::zmat::ZMat::from_rows(b.clone());
        assert_eq!(sagebrush_arith::zmat::det_bareiss(&m).abs(), BigInt::one());
        let red: Vec<Vec<BigInt>> = (0..8).map(|i| (0..8).map(|j| dot(&g, &b[i], &b[j])).collect()).collect();
        let det = |x: &Vec<Vec<BigInt>>| sagebrush_arith::zmat::det_bareiss(&sagebrush_arith::zmat::ZMat::from_rows(x.clone()));
        assert_eq!(det(&red), det(&g));
    }

    #[test]
    fn class_number_one() {
        // the icosians (Q(sqrt 5)) and the binary octahedral order
        // (Q(sqrt 2)): one class, of weight 60 and 24
        for (d, w) in [(5, 60), (2, 24)] {
            let f = QuadField::new(d).unwrap();
            let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
            let cs = ClassSet::new(&o).unwrap();
            assert_eq!(cs.len(), 1);
            assert_eq!(cs.classes()[0].weight(), w);
        }
    }

    #[test]
    fn neighbours_are_located() {
        // every neighbour of every class is in some class, with a checked x
        let f = QuadField::new(13).unwrap();
        let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
        let cs = ClassSet::new(&o).unwrap();
        let mut sum = Rat::zero();
        for c in cs.classes() {
            sum = sum.add(&Rat::new(BigInt::one(), BigInt::from(c.weight())));
        }
        assert_eq!(&sum, cs.mass());
        for p in f.primes_of_bounded_norm(9).unwrap() {
            let e = o.local_splitting(p, 1).unwrap().matrix_units()[0].clone();
            for c in cs.classes() {
                let ns = cs.neighbours(c.ideal(), &p, &e).unwrap();
                assert_eq!(ns.len() as i128, p.norm + 1);
                for j in ns {
                    cs.locate(&j).unwrap();
                }
            }
        }
    }
}
