//! Totally definite quaternion algebras B over a real quadratic field F,
//! unramified at every finite place, and maximal orders in them: the
//! algebra of the definite method over F (Dembélé-Voight 2013, section 4;
//! such a B exists because [F : Q] = 2 is even, so the two real places
//! alone form a set of even size).
//!
//! The algebra. B = (a, b)_F = F<i, j> with i^2 = a, j^2 = b and k = ij =
//! -ji, for a, b in O_F totally negative, so that B is ramified at both
//! real places. [`QuatAlg::unramified`] takes a, b in Z from Pizer, "An
//! algorithm for computing modular forms on Gamma_0(N)", J. Algebra 64
//! (1980), Proposition 5.1: the algebra B_0 = (a, b)_Q ramified exactly at
//! p and infinity is (-1, -1) for p = 2, (-1, -p) for p = 3 mod 4, (-2, -p)
//! for p = 5 mod 8 and (-p, -q) for p = 1 mod 8, where q = 3 mod 4 is a
//! prime with (p/q) = -1. With p = 2 if 2 does not split in F and p the
//! least odd inert prime otherwise, every prime P of F above p has
//! [F_P : Q_p] = 2 and B = B_0 (x) F is split at P, so B is ramified at the
//! real places only. This choice is not trusted: the maximal order below
//! comes with a certificate that B is unramified at every finite place.
//!
//! Elements and lattices. An element x0 + x1 i + x2 j + x3 k is stored by
//! its eight Z-coordinates over a common denominator in the Q-basis e_m,
//! w e_m (e = 1, i, j, k), so that Lambda = O_F + O_F i + O_F j + O_F k
//! (Voight, "Identifying the matrix ring", equation (7.8)) is Z^8. Orders
//! are Z-lattices containing Lambda, in Hermite normal form.
//!
//! Maximal orders ([`MaximalOrder::new`]), following Voight, section 7.
//! The reduced discriminant of Lambda is 4ab.
//! - Odd primes r | ab (r prime to disc F, and to exactly one of a, b):
//!   Lambda is r-saturated, and Algorithm 7.10, step 2, adjoins
//!   r^-1 (x - i) j O_F with x^2 = a mod r O_F if r | b (or r^-1 (y - j) i
//!   O_F with y^2 = b if r | a). Since r is unramified in F, r^-1 is an
//!   inverse uniformizer at every prime above r at once.
//! - The primes above 2: an exhaustive search. If O is an order and O' a
//!   strictly larger order with [O' : O] a power of 2, then O'/O is a
//!   finite O_F-module supported at the dyadic primes, so it contains some
//!   z + O killed by a dyadic prime P, and z lies in P^-1 O, inside
//!   (1/2) O. So O is maximal at 2 if and only if no z in (1/2) O \ O
//!   generates, with O, a ring inside the dual O^# (every order containing
//!   O lies in O^#, and a ring inside O^# is finitely generated, so it is
//!   an order). There are 2^8 - 1 classes z + O to try.
//! - The certificate: the Z-discriminant |det(Tr_{F/Q} trd(f_s f_t))| over
//!   a Z-basis f of O equals d_F^4 N(disc O) (O is locally free over O_F,
//!   and the trace form of a restriction of scalars has determinant
//!   N(det) times the discriminant of O_F to the power 4). It is checked to
//!   be d_F^4, so the reduced discriminant d(O) is O_F; as d(O) is
//!   contained in D(B), B is unramified at every finite place, and O is
//!   maximal by Voight, Lemma 7.5. The closure of O under multiplication
//!   is checked on its basis, and O contains Lambda, so O is an order.

use crate::field::{factor_u64, inv_mod, is_prime, pow_mod, sqrt_mod_p};
use crate::p1::Mat;
use crate::qresidue::QLocalRing;
use crate::residue::Res;
use crate::rqf::{QElt, QFrac, QPrime, QuadField};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_arith::zmat::{det_bareiss, ZMat};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

fn big(x: i64) -> BigInt {
    BigInt::from(x)
}

fn zero8() -> [BigInt; 8] {
    std::array::from_fn(|_| BigInt::zero())
}

/// An element sum_m x_m e_m of B (e = 1, i, j, k), with
/// x_m = (c[2m] + c[2m+1] w) / den in lowest terms, den > 0.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct BElt {
    pub c: [BigInt; 8],
    pub den: BigInt,
}

impl BElt {
    pub fn new(c: [BigInt; 8], den: BigInt) -> BElt {
        assert!(!den.is_zero(), "zero denominator");
        let g = c.iter().fold(den.clone(), |g, x| g.gcd(x));
        let s = if den.is_negative() { -g } else { g };
        BElt { c: std::array::from_fn(|k| &c[k] / &s), den: den / &s }
    }
    pub fn integral(c: [BigInt; 8]) -> BElt {
        BElt { c, den: BigInt::one() }
    }
    /// x0 + x1 i + x2 j + x3 k for x_m in O_F.
    pub fn from_coords(x: [QElt; 4]) -> BElt {
        BElt::integral(std::array::from_fn(|s| if s % 2 == 0 { x[s / 2].a.clone() } else { x[s / 2].b.clone() }))
    }
    pub fn one() -> BElt {
        BElt::from_coords([QElt::int(1), QElt::int(0), QElt::int(0), QElt::int(0)])
    }
    pub fn is_zero(&self) -> bool {
        self.c.iter().all(|x| x.is_zero())
    }
    /// The numerator of x_m.
    fn num(&self, m: usize) -> QElt {
        QElt { a: self.c[2 * m].clone(), b: self.c[2 * m + 1].clone() }
    }
    /// k x for an integer k.
    pub fn scale_int(&self, k: &BigInt) -> BElt {
        BElt::new(std::array::from_fn(|i| &self.c[i] * k), self.den.clone())
    }
    /// x / k for a nonzero integer k.
    pub fn div_int(&self, k: &BigInt) -> BElt {
        BElt::new(self.c.clone(), &self.den * k)
    }
    /// The coordinates scaled to the denominator den (a multiple of
    /// self.den).
    fn at_den(&self, den: &BigInt) -> [BigInt; 8] {
        let s = den / &self.den;
        debug_assert!((den % &self.den).is_zero());
        std::array::from_fn(|k| &self.c[k] * &s)
    }
}

/// The quaternion algebra (a, b)_F, made by `new` or `unramified` (the
/// fields are private to the crate, so a and b are totally negative).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuatAlg {
    pub(crate) f: QuadField,
    pub(crate) a: QElt,
    pub(crate) b: QElt,
}

impl QuatAlg {
    /// (a, b)_F for a, b in O_F totally negative (a totally definite
    /// algebra; indefinite algebras are not supported).
    pub fn new(f: QuadField, a: QElt, b: QElt) -> Result<QuatAlg, String> {
        let neg = |x: &QElt| f.signs(x) == (Ordering::Less, Ordering::Less);
        if !neg(&a) || !neg(&b) {
            return Err("a and b must be totally negative (only totally definite algebras are supported)".into());
        }
        Ok(QuatAlg { f, a, b })
    }
    pub fn field(&self) -> &QuadField {
        &self.f
    }
    pub fn a(&self) -> &QElt {
        &self.a
    }
    pub fn b(&self) -> &QElt {
        &self.b
    }

    /// A totally definite quaternion algebra over F unramified at every
    /// finite place, with a, b in Z (Pizer's algebra of discriminant p,
    /// p the least prime not split in F that is 2 or inert; see the module
    /// documentation).
    pub fn unramified(f: QuadField) -> Result<QuatAlg, String> {
        let disc = f.disc;
        let p = if disc.rem_euclid(8) != 1 {
            2
        } else {
            (3u64..).find(|&p| is_prime(p) && legendre(disc, p) == -1).expect("an inert prime exists")
        };
        let (a, b) = match p {
            2 => (-1, -1),
            _ if p % 4 == 3 => (-1, -(p as i64)),
            _ if p % 8 == 5 => (-2, -(p as i64)),
            _ => {
                let q = (3u64..).find(|&q| q % 4 == 3 && is_prime(q) && disc % q as i64 != 0 && legendre(p as i64, q) == -1).expect("such a q exists");
                (-(p as i64), -(q as i64))
            }
        };
        QuatAlg::new(f, QElt::int(a), QElt::int(b))
    }

    pub fn add(&self, x: &BElt, y: &BElt) -> BElt {
        let den = x.den.lcm(&y.den);
        let (u, v) = (x.at_den(&den), y.at_den(&den));
        BElt::new(std::array::from_fn(|k| &u[k] + &v[k]), den)
    }
    pub fn neg(&self, x: &BElt) -> BElt {
        BElt { c: std::array::from_fn(|k| -&x.c[k]), den: x.den.clone() }
    }
    pub fn sub(&self, x: &BElt, y: &BElt) -> BElt {
        self.add(x, &self.neg(y))
    }

    /// x y, from i^2 = a, j^2 = b, ij = -ji = k, so jk = -b i, kj = b i,
    /// ki = -a j, ik = a j and k^2 = -ab.
    pub fn mul(&self, x: &BElt, y: &BElt) -> BElt {
        let f = &self.f;
        let m = |u: &QElt, v: &QElt| f.mul(u, v);
        let (x0, x1, x2, x3) = (x.num(0), x.num(1), x.num(2), x.num(3));
        let (y0, y1, y2, y3) = (y.num(0), y.num(1), y.num(2), y.num(3));
        let ab = m(&self.a, &self.b);
        let s = |xs: &[QElt]| xs.iter().fold(QElt::int(0), |acc, t| f.add(&acc, t));
        let z0 = s(&[m(&x0, &y0), m(&self.a, &m(&x1, &y1)), m(&self.b, &m(&x2, &y2))]);
        let z0 = f.sub(&z0, &m(&ab, &m(&x3, &y3)));
        let z1 = s(&[m(&x0, &y1), m(&x1, &y0), m(&self.b, &f.sub(&m(&x3, &y2), &m(&x2, &y3)))]);
        let z2 = s(&[m(&x0, &y2), m(&x2, &y0), m(&self.a, &f.sub(&m(&x1, &y3), &m(&x3, &y1)))]);
        let z3 = s(&[m(&x0, &y3), m(&x3, &y0), f.sub(&m(&x1, &y2), &m(&x2, &y1))]);
        let z = BElt::from_coords([z0, z1, z2, z3]);
        BElt::new(z.c, &x.den * &y.den)
    }

    /// The standard involution x0 - x1 i - x2 j - x3 k.
    pub fn conj(&self, x: &BElt) -> BElt {
        BElt { c: std::array::from_fn(|k| if k < 2 { x.c[k].clone() } else { -&x.c[k] }), den: x.den.clone() }
    }

    /// trd(x) = 2 x0.
    pub fn trd(&self, x: &BElt) -> QFrac {
        QFrac::new(&x.c[0] * big(2), &x.c[1] * big(2), x.den.clone())
    }

    /// nrd(x) = x0^2 - a x1^2 - b x2^2 + ab x3^2.
    pub fn nrd(&self, x: &BElt) -> QFrac {
        let f = &self.f;
        let sq = |m: usize| f.mul(&x.num(m), &x.num(m));
        let ab = f.mul(&self.a, &self.b);
        let n = f.sub(&f.sub(&sq(0), &f.mul(&self.a, &sq(1))), &f.mul(&self.b, &sq(2)));
        let n = f.add(&n, &f.mul(&ab, &sq(3)));
        QFrac::new(n.a, n.b, &x.den * &x.den)
    }

    /// Tr_{F/Q}(trd(x)) = 2 (2 c0 + t c1) / den, if it is an integer.
    fn tr_trd(&self, x: &BElt) -> Option<BigInt> {
        let n = (&x.c[0] * big(2) + &x.c[1] * big(self.f.t)) * big(2);
        let (q, r) = n.div_rem(&x.den);
        if r.is_zero() {
            Some(q)
        } else {
            None
        }
    }

    /// Whether x is integral over O_F: trd(x) and nrd(x) lie in O_F.
    pub fn is_integral(&self, x: &BElt) -> bool {
        self.trd(x).integral().is_some() && self.nrd(x).integral().is_some()
    }
}

/// The Legendre symbol (n/p) for an odd prime p.
fn legendre(n: i64, p: u64) -> i32 {
    let r = pow_mod(n.rem_euclid(p as i64) as u64, (p - 1) / 2, p);
    if r == 0 {
        0
    } else if r == 1 {
        1
    } else {
        -1
    }
}

/// A square root of the integer c (prime to r) in O_F / r O_F, for an odd
/// prime r not dividing disc F: in Z if c is a square mod r; otherwise, if
/// r is inert, s (2w - t) with s^2 = c / D mod r, as (2w - t)^2 = D.
fn sqrt_mod_r(f: &QuadField, c: i64, r: u64) -> Option<QElt> {
    let cm = c.rem_euclid(r as i64) as u64;
    if let Some(s) = sqrt_mod_p(cm, r) {
        return Some(QElt::int(s as i64));
    }
    if legendre(f.disc, r) != -1 {
        return None;
    }
    let dinv = inv_mod(f.disc.rem_euclid(r as i64) as u64, r)?;
    let s = sqrt_mod_p((cm as u128 * dinv as u128 % r as u128) as u64, r)? as i64;
    Some(QElt::new(-s * f.t, 2 * s))
}

/// (g, x, y) with x u + y v = g = gcd(u, v), for u > 0.
fn ext_gcd(u: &BigInt, v: &BigInt) -> (BigInt, BigInt, BigInt) {
    let (mut r0, mut r1) = (u.clone(), v.clone());
    let (mut s0, mut s1) = (BigInt::one(), BigInt::zero());
    let (mut t0, mut t1) = (BigInt::zero(), BigInt::one());
    while !r1.is_zero() {
        let q = r0.div_floor(&r1);
        let r2 = &r0 - &q * &r1;
        let s2 = &s0 - &q * &s1;
        let t2 = &t0 - &q * &t1;
        (r0, r1, s0, s1, t0, t1) = (r1, r2, s1, s2, t1, t2);
    }
    if r0.is_negative() {
        (-r0, -s0, -t0)
    } else {
        (r0, s0, t0)
    }
}

/// A Z-lattice (1/den) (row span of h) in B of full rank, in the
/// coordinates of [`BElt`], containing m Lambda for some integer m > 0
/// (Lambda = Z^8; m = 1 for orders containing Lambda); h is in Hermite
/// normal form (upper triangular, positive diagonal, entries above the
/// diagonal reduced modulo it) and den is least. Made only by `from_gens`
/// and `from_gens_containing` (the fields are private to the crate).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Lattice {
    pub(crate) den: BigInt,
    pub(crate) h: [[BigInt; 8]; 8],
}

impl Lattice {
    pub fn den(&self) -> &BigInt {
        &self.den
    }
    /// The rows of the Hermite normal form.
    pub fn hnf(&self) -> &[[BigInt; 8]; 8] {
        &self.h
    }
    /// Lambda + Z gens.
    pub fn from_gens(gens: &[BElt]) -> Lattice {
        Lattice::from_gens_containing(gens, &BigInt::one())
    }
    /// m Lambda + Z gens, for an integer m > 0: the Z-span of gens when it
    /// contains m Lambda (the Hermite normal form is computed from the rows
    /// m den e_i, which keeps it exact without a determinant). Private to the
    /// crate: every caller passes a positive multiple justified in a comment
    /// (API-06F-2).
    pub(crate) fn from_gens_containing(gens: &[BElt], m: &BigInt) -> Lattice {
        assert!(m.is_positive(), "m must be positive");
        let den = gens.iter().fold(BigInt::one(), |d, g| d.lcm(&g.den));
        let md = m * &den;
        let mut h: [[BigInt; 8]; 8] = std::array::from_fn(|i| {
            let mut r = zero8();
            r[i] = md.clone();
            r
        });
        for g in gens {
            // cancellable: the HNF of a long list of generators is the main
            // work outside the lattice searches
            sagebrush_interrupt::check();
            let mut v = g.at_den(&den);
            for i in 0..8 {
                if v[i].is_zero() {
                    continue;
                }
                let (g, x, y) = ext_gcd(&h[i][i], &v[i]);
                let (p, q) = (&h[i][i] / &g, &v[i] / &g);
                let row: [BigInt; 8] = std::array::from_fn(|k| &x * &h[i][k] + &y * &v[k]);
                v = std::array::from_fn(|k| &p * &v[k] - &q * &h[i][k]);
                h[i] = row;
            }
            reduce(&mut h);
        }
        let g = h.iter().flatten().fold(den.clone(), |g, x| g.gcd(x));
        Lattice { den: &den / &g, h: std::array::from_fn(|i| std::array::from_fn(|k| &h[i][k] / &g)) }
    }

    pub fn basis(&self) -> Vec<BElt> {
        self.h.iter().map(|r| BElt::new(r.clone(), self.den.clone())).collect()
    }

    pub fn contains(&self, x: &BElt) -> bool {
        let n = &x.c;
        let mut v: [BigInt; 8] = zero8();
        for k in 0..8 {
            let t = &n[k] * &self.den;
            if !(&t % &x.den).is_zero() {
                return false;
            }
            v[k] = t / &x.den;
        }
        for i in 0..8 {
            let (q, r) = v[i].div_rem(&self.h[i][i]);
            if !r.is_zero() {
                return false;
            }
            if !q.is_zero() {
                for k in i..8 {
                    v[k] = &v[k] - &q * &self.h[i][k];
                }
            }
        }
        true
    }

    /// The covolume of L relative to Lambda, prod h_ii / den^8 (as numerator
    /// and denominator, not reduced): [Lambda : L] when L is inside Lambda,
    /// and 1/[L : Lambda] when L contains it.
    pub fn covolume(&self) -> (BigInt, BigInt) {
        let d = (0..8).fold(BigInt::one(), |d, i| d * &self.h[i][i]);
        (d, self.den.pow(8))
    }
    /// The least integer m > 0 with m Lambda inside L: the least common
    /// denominator of the coordinates of e_1, ..., e_8 in the basis of L
    /// (solved exactly on the triangular Hermite normal form).
    pub fn lambda_multiple(&self) -> BigInt {
        let mut m = BigInt::one();
        for s in 0..8 {
            // x H = den e_s, solved column by column: x_i = (t_i - sum_{r < i}
            // x_r H[r][i]) / H[i][i], with x_r = num_r / dd (common denominator)
            let mut nums: Vec<BigInt> = vec![];
            let mut dd = BigInt::one();
            for i in 0..8 {
                // t_i dd - sum num_r H[r][i], over dd H[i][i]
                let t = if i == s { &self.den * &dd } else { BigInt::zero() };
                let acc = (0..i).fold(t, |a, r| a - &nums[r] * &self.h[r][i]);
                let den_i = &dd * &self.h[i][i];
                let g = acc.gcd(&den_i);
                let (num_i, den_i) = (&acc / &g, &den_i / &g);
                // bring everything to the common denominator lcm(dd, den_i)
                let l = dd.lcm(&den_i);
                let scale = &l / &dd;
                for x in nums.iter_mut() {
                    *x = &*x * &scale;
                }
                nums.push(num_i * (&l / &den_i));
                dd = l;
            }
            let g = nums.iter().fold(dd.clone(), |g, x| g.gcd(x));
            m = m.lcm(&(&dd / &g));
        }
        m
    }
    /// The index [L : Lambda] = den^8 / prod h_ii, for L containing Lambda.
    pub fn index(&self) -> BigInt {
        let mut n = BigInt::one();
        for _ in 0..8 {
            n = n * &self.den;
        }
        let d = (0..8).fold(BigInt::one(), |d, i| d * &self.h[i][i]);
        n / d
    }
}

fn reduce(h: &mut [[BigInt; 8]; 8]) {
    for i in 0..8 {
        for r in 0..i {
            let q = h[r][i].div_floor(&h[i][i]);
            if !q.is_zero() {
                for k in i..8 {
                    let t = &q * &h[i][k];
                    h[r][k] = &h[r][k] - &t;
                }
            }
        }
    }
}

/// The Gram matrix Tr_{F/Q} trd(f_s f_t) on the basis f of the order o
/// (integral, as o is an order).
fn trace_gram(alg: &QuatAlg, f: &[BElt]) -> ZMat {
    let rows = f.iter().map(|x| f.iter().map(|y| alg.tr_trd(&alg.mul(x, y)).expect("an order is integral")).collect()).collect();
    ZMat::from_rows(rows)
}

/// The ring generated by the order o and extra, if it lies in the dual
/// o^# = {x : Tr_{F/Q} trd(x o) in Z} (and so is an order); None if not.
fn ring_closure(alg: &QuatAlg, o: &Lattice, extra: &[BElt]) -> Option<Lattice> {
    let ob = o.basis();
    let in_dual = |x: &BElt| ob.iter().all(|y| alg.tr_trd(&alg.mul(x, y)).is_some());
    if !extra.iter().all(in_dual) {
        return None;
    }
    let mut gens = ob.clone();
    gens.extend(extra.iter().cloned());
    let mut l = Lattice::from_gens(&gens);
    loop {
        let b = l.basis();
        let mut new = vec![];
        for x in &b {
            for y in &b {
                let p = alg.mul(x, y);
                if !l.contains(&p) {
                    if !in_dual(&p) {
                        return None;
                    }
                    new.push(p);
                }
            }
        }
        if new.is_empty() {
            return Some(l);
        }
        let mut g = b;
        g.extend(new);
        l = Lattice::from_gens(&g);
    }
}

/// A maximal order of a totally definite quaternion algebra over F that is
/// unramified at every finite place, with its certificate. Made only by
/// `new`, which certifies it (the fields are private to the crate).
#[derive(Clone, Debug)]
pub struct MaximalOrder {
    pub(crate) alg: QuatAlg,
    pub(crate) lattice: Lattice,
    /// A Z-basis (the rows of the lattice); basis[0] need not be 1.
    pub(crate) basis: Vec<BElt>,
    /// The least m > 0 with m Lambda inside the order (1 for the orders of
    /// `new`, which contain Lambda; a left order of an ideal need not).
    pub(crate) lambda_m: BigInt,
}

impl MaximalOrder {
    pub fn alg(&self) -> &QuatAlg {
        &self.alg
    }
    pub fn lattice(&self) -> &Lattice {
        &self.lattice
    }
    /// A Z-basis (the rows of the lattice); basis()[0] need not be 1.
    pub fn basis(&self) -> &[BElt] {
        &self.basis
    }
    /// The least m > 0 with m Lambda inside the order, Lambda = O_F<1, i, j,
    /// k>.
    pub fn lambda_multiple(&self) -> &BigInt {
        &self.lambda_m
    }
    /// A maximal order of alg, which must be unramified at every finite
    /// place (an error otherwise). Implemented for a, b in Z, squarefree,
    /// with no odd prime factor in common or dividing disc F (as for
    /// [`QuatAlg::unramified`]).
    pub fn new(alg: &QuatAlg) -> Result<MaximalOrder, String> {
        let f = &alg.f;
        let (a, b) = match (alg.a.b.is_zero(), alg.b.b.is_zero(), alg.a.a.to_i64(), alg.b.a.to_i64()) {
            // unsigned_abs: abs() of i64::MIN overflows (HARD-022-1)
            (true, true, Some(a), Some(b)) if a.unsigned_abs() < 1 << 31 && b.unsigned_abs() < 1 << 31 => (a, b),
            _ => return Err("maximal orders are implemented only for a, b in Z (|a|, |b| < 2^31)".into()),
        };
        let fa = factor_u64(a.unsigned_abs())?;
        let fb = factor_u64(b.unsigned_abs())?;
        let mut odd: Vec<(u64, bool)> = vec![]; // (r, r | b)
        for (fs, in_b) in [(&fa, false), (&fb, true)] {
            for &(r, e) in fs.iter() {
                if r == 2 {
                    continue;
                }
                if e > 1 || f.disc % r as i64 == 0 || (a % r as i64 == 0 && b % r as i64 == 0) {
                    return Err(format!("not implemented: the odd prime {} divides a b to a power > 1, both a and b, or disc F", r));
                }
                odd.push((r, in_b));
            }
        }
        let i = BElt::from_coords([QElt::int(0), QElt::int(1), QElt::int(0), QElt::int(0)]);
        let j = BElt::from_coords([QElt::int(0), QElt::int(0), QElt::int(1), QElt::int(0)]);
        let w = BElt::from_coords([QElt::new(0, 1), QElt::int(0), QElt::int(0), QElt::int(0)]);
        let elt = |x: QElt| BElt::from_coords([x, QElt::int(0), QElt::int(0), QElt::int(0)]);
        let mut o = Lattice::from_gens(&[]);
        // odd primes: Voight, Algorithm 7.10, step 2
        for (r, in_b) in odd {
            let (c, u, v) = if in_b { (a, &i, &j) } else { (b, &j, &i) };
            let x = sqrt_mod_r(f, c, r).ok_or_else(|| format!("B is ramified at a prime above {}", r))?;
            // alpha = (x - u) v
            let alpha = alg.mul(&alg.sub(&elt(x), u), v);
            let rr = big(r as i64);
            let gens = [alpha.div_int(&rr), alg.mul(&w, &alpha).div_int(&rr)];
            o = ring_closure(alg, &o, &gens).ok_or_else(|| format!("B is ramified at a prime above {}", r))?;
        }
        // the dyadic primes: exhaustive search over (1/2) O / O
        'search: loop {
            let ob = o.basis();
            for mask in 1u32..256 {
                let z = ob.iter().enumerate().filter(|(s, _)| mask >> s & 1 == 1).fold(BElt::integral(zero8()), |acc, (_, x)| alg.add(&acc, x));
                let z = z.div_int(&big(2));
                if !alg.is_integral(&z) {
                    continue;
                }
                if let Some(l) = ring_closure(alg, &o, &[z]) {
                    o = l;
                    continue 'search;
                }
            }
            break;
        }
        let order = MaximalOrder { alg: alg.clone(), basis: o.basis(), lambda_m: o.lambda_multiple(), lattice: o };
        order.certify()?;
        Ok(order)
    }

    /// The Z-discriminant |det(Tr_{F/Q} trd(f_s f_t))|.
    pub fn z_discriminant(&self) -> BigInt {
        det_bareiss(&trace_gram(&self.alg, &self.basis)).abs()
    }

    /// The maximal order with the given lattice, certified (an error if the
    /// lattice is not an O_F-order of reduced discriminant O_F), e.g. the left
    /// order of an ideal.
    pub fn from_lattice(alg: &QuatAlg, lattice: Lattice) -> Result<MaximalOrder, String> {
        let o = MaximalOrder { alg: alg.clone(), basis: lattice.basis(), lambda_m: lattice.lambda_multiple(), lattice };
        o.certify()?;
        Ok(o)
    }

    /// Checks that the lattice is a ring containing 1 and w (so an O_F-order)
    /// and that its Z-discriminant is d_F^4 (so it is maximal and B is
    /// unramified at every finite place).
    pub fn certify(&self) -> Result<(), String> {
        let w = BElt::from_coords([QElt::new(0, 1), QElt::int(0), QElt::int(0), QElt::int(0)]);
        if !self.lattice.contains(&BElt::one()) || !self.lattice.contains(&w) {
            return Err("the lattice does not contain O_F".into());
        }
        for x in &self.basis {
            for y in &self.basis {
                if !self.lattice.contains(&self.alg.mul(x, y)) {
                    return Err("the lattice is not closed under multiplication".into());
                }
            }
        }
        let d4 = big(self.alg.f.disc).pow(4);
        if self.z_discriminant() != d4 {
            return Err("B is ramified at a finite place (no order of discriminant 1 found)".into());
        }
        Ok(())
    }

    /// The coordinates of x in the basis, if x lies in the order.
    pub fn coordinates(&self, x: &BElt) -> Option<[BigInt; 8]> {
        let l = &self.lattice;
        let mut v: [BigInt; 8] = zero8();
        for k in 0..8 {
            let t = &x.c[k] * &l.den;
            if !(&t % &x.den).is_zero() {
                return None;
            }
            v[k] = t / &x.den;
        }
        let mut out = zero8();
        for i in 0..8 {
            let (q, r) = v[i].div_rem(&l.h[i][i]);
            if !r.is_zero() {
                return None;
            }
            if !q.is_zero() {
                for k in i..8 {
                    v[k] = &v[k] - &q * &l.h[i][k];
                }
            }
            out[i] = q;
        }
        Some(out)
    }

    /// The element with the given coordinates in the basis.
    pub fn element(&self, v: &[i128; 8]) -> BElt {
        let mut c = zero8();
        for (s, &vs) in v.iter().enumerate() {
            if vs != 0 {
                for k in 0..8 {
                    c[k] = &c[k] + &self.lattice.h[s][k] * BigInt::from(vs);
                }
            }
        }
        BElt::new(c, self.lattice.den.clone())
    }

    /// The Gram matrix of the bilinear form B(x, y) = Tr_{F/Q} trd(x conj(y))
    /// of the positive definite form Q(x) = Tr_{F/Q} nrd(x) = B(x, x)/2 on
    /// the basis (integral, as the order is).
    pub fn norm_gram(&self) -> Result<[[i128; 8]; 8], String> {
        let mut g = [[0i128; 8]; 8];
        for (s, x) in self.basis.iter().enumerate() {
            for (t, y) in self.basis.iter().enumerate() {
                let v = self.alg.tr_trd(&self.alg.mul(x, &self.alg.conj(y))).expect("an order is integral");
                g[s][t] = v.to_i128().filter(|v| v.unsigned_abs() < 1 << 60).ok_or("the norm form is too large")?;
            }
        }
        Ok(g)
    }

    /// The units of reduced norm 1 (a finite group, as B is totally
    /// definite): the x in O with Tr_{F/Q} nrd(x) = 2, since nrd(x) is a
    /// totally positive element of O_F, whose trace is at least 2 with
    /// equality only for 1 (the arithmetic-geometric mean inequality).
    pub fn norm_one_units(&self) -> Result<Vec<BElt>, String> {
        let g = self.norm_gram()?;
        let mut basis: Vec<[i128; 8]> = (0..8)
            .map(|s| {
                let mut v = [0i128; 8];
                v[s] = 1;
                v
            })
            .collect();
        crate::theta::lll(&mut basis, &g);
        let mut out = vec![];
        crate::theta::enumerate(&basis, &g, 2, &mut |v| {
            let x = self.element(v);
            if self.alg.nrd(&x) == QFrac::one() {
                out.push(x);
            }
            false
        });
        Ok(out)
    }
}

/// The product of 2 x 2 matrices [a11, a12, a21, a22] over O_F / P^e.
pub fn mat_mul(r: &QLocalRing, x: &Mat, y: &Mat) -> Mat {
    [
        r.add(r.mul(x[0], y[0]), r.mul(x[1], y[2])),
        r.add(r.mul(x[0], y[1]), r.mul(x[1], y[3])),
        r.add(r.mul(x[2], y[0]), r.mul(x[3], y[2])),
        r.add(r.mul(x[2], y[1]), r.mul(x[3], y[3])),
    ]
}

/// A local splitting O / P^e O = M_2(O_F / P^e) of a maximal order.
///
/// It is built from matrix units, as split.rs does for the icosians: an
/// element x of O whose reduced characteristic polynomial T^2 - trd(x) T +
/// nrd(x) has distinct roots l1, l2 modulo P gives the rank-one idempotent
/// eps = (x - l2)/(l1 - l2) modulo P, lifted to an idempotent modulo P^e by
/// eps <- 3 eps^2 - 2 eps^3. Then e11 = eps, e22 = 1 - eps, e21 = (1 - eps)
/// y eps for a basis element y with e21 not in P O, and e12 = r^-1 eps y'
/// (1 - eps) with r = trd(eps y' (1 - eps) e21) a unit. The entries of the
/// image of z are z_ij = trd(e_1i z e_j1), as e_1i z e_j1 = z_ij e11 and
/// trd(e11) = 1. Membership in P^e O is tested by trd: O is its own dual
/// for trd (its reduced discriminant is O_F), so P^e O = {x : trd(x O) in
/// P^e}. The map is checked to be unital and multiplicative on the basis;
/// then it is an isomorphism, as O / P O is simple of the same order.
#[derive(Clone, Debug)]
pub struct OrderSplitting {
    pub(crate) ring: QLocalRing,
    /// The images of the basis elements of the order.
    pub(crate) images: Vec<Mat>,
    /// Lifts to the order of the matrix units e11, e12, e21, e22.
    pub(crate) units: [BElt; 4],
}

impl OrderSplitting {
    pub fn ring(&self) -> &QLocalRing {
        &self.ring
    }
    /// The images of the basis elements of the order.
    pub fn images(&self) -> &[Mat] {
        &self.images
    }
    /// Lifts to the order of the matrix units e11, e12, e21, e22 (e22 = 1 -
    /// e11); e11 is an idempotent modulo P^e of rank one.
    pub fn matrix_units(&self) -> &[BElt; 4] {
        &self.units
    }
    /// The image of the element with the given coordinates in the basis.
    pub fn image(&self, coords: &[BigInt; 8]) -> Mat {
        let r = &self.ring;
        let m = BigInt::from(r.card);
        let mut out = [r.zero(); 4];
        for (s, c) in coords.iter().enumerate() {
            let c = c.mod_floor(&m).to_i128().unwrap();
            if c == 0 {
                continue;
            }
            let c = r.reduce(c, 0);
            for u in 0..4 {
                out[u] = r.add(out[u], r.mul(c, self.images[s][u]));
            }
        }
        out
    }
}

impl MaximalOrder {
    fn trd_mod(&self, r: &QLocalRing, x: &BElt) -> Res {
        r.from_qelt(&self.alg.trd(x).integral().expect("an element of the order"))
    }
    /// Whether x (in O) lies in P^e O, for r = O_F / P^e.
    fn in_pe(&self, r: &QLocalRing, x: &BElt) -> bool {
        self.basis.iter().all(|y| self.trd_mod(r, &self.alg.mul(x, y)) == r.zero())
    }
    /// x (in O) with its coordinates reduced modulo m.
    fn reduce_mod(&self, x: &BElt, m: u64) -> BElt {
        let c = self.coordinates(x).expect("an element of the order");
        let m = BigInt::from(m);
        self.element(&std::array::from_fn(|s| c[s].mod_floor(&m).to_i128().unwrap()))
    }
    fn scalar(s: &QElt) -> BElt {
        BElt::from_coords([s.clone(), QElt::int(0), QElt::int(0), QElt::int(0)])
    }

    /// The splitting O / P^e O = M_2(O_F / P^e) at the prime P.
    pub fn local_splitting(&self, prime: QPrime, e: u32) -> Result<OrderSplitting, String> {
        let f = &self.alg.f;
        // QLocalRing::new refuses anything but a prime of f
        let ring = QLocalRing::new(f, prime, e)?;
        let k = QLocalRing::new(f, ring.prime(), 1)?;
        let alg = &self.alg;
        let m = ring.card;
        let red = |x: &BElt| self.reduce_mod(x, m);
        // Step 1: an element with split separable characteristic polynomial
        let mut found = None;
        for n in 1..6561u32 {
            let mut v = [0i128; 8];
            let mut t = n;
            for s in 0..8 {
                v[s] = (t % 3) as i128 - 1;
                t /= 3;
            }
            let x = self.element(&v);
            let s = k.from_qelt(&alg.trd(&x).integral().unwrap());
            let nm = k.from_qelt(&alg.nrd(&x).integral().unwrap());
            if let Some((l1, l2)) = k.distinct_roots(s, nm) {
                found = Some((x, k.lift(l1), k.lift(l2)));
                break;
            }
        }
        let (x, l1, l2) = found.ok_or("no element with split characteristic polynomial found")?;
        let d = ring.inv(ring.from_qelt(&f.sub(&l1, &l2))).ok_or("roots not distinct")?;
        let mut eps = red(&alg.mul(&Self::scalar(&ring.lift(d)), &alg.sub(&x, &Self::scalar(&l2))));
        // Step 2: Newton's iteration for eps^2 = eps
        let mut steps = 0;
        loop {
            let e2 = alg.mul(&eps, &eps);
            if self.in_pe(&ring, &alg.sub(&e2, &eps)) {
                break;
            }
            let e3 = alg.mul(&e2, &eps);
            eps = red(&alg.sub(&alg.mul(&Self::scalar(&QElt::int(3)), &e2), &alg.mul(&Self::scalar(&QElt::int(2)), &e3)));
            steps += 1;
            if steps > 64 {
                return Err("idempotent lifting did not converge".into());
            }
        }
        // Step 3: matrix units
        let one_minus = alg.sub(&BElt::one(), &eps);
        let e21 = self.basis.iter().map(|y| red(&alg.mul(&alg.mul(&one_minus, y), &eps))).find(|v| !self.in_pe(&k, v)).ok_or("(1 - eps) O eps lies in P O")?;
        let e12 = self
            .basis
            .iter()
            .find_map(|y| {
                let u = red(&alg.mul(&alg.mul(&eps, y), &one_minus));
                let r = ring.inv(self.trd_mod(&ring, &alg.mul(&u, &e21)))?;
                Some(red(&alg.mul(&Self::scalar(&ring.lift(r)), &u)))
            })
            .ok_or("no unit pairing eps O (1 - eps) with e21")?;
        let rows = [&eps, &e12];
        let cols = [&eps, &e21];
        let images: Vec<Mat> = self
            .basis
            .iter()
            .map(|z| {
                let zij = |i: usize, j: usize| self.trd_mod(&ring, &alg.mul(&alg.mul(rows[i], z), cols[j]));
                [zij(0, 0), zij(0, 1), zij(1, 0), zij(1, 1)]
            })
            .collect();
        let e22 = alg.sub(&BElt::one(), &eps);
        let sp = OrderSplitting { ring, images, units: [eps.clone(), e12.clone(), e21.clone(), e22] };
        // the check: unital and multiplicative on the basis
        let r = &sp.ring;
        if sp.image(&self.coordinates(&BElt::one()).unwrap()) != [r.one(), r.zero(), r.zero(), r.one()] {
            return Err("internal error: the splitting is not unital".into());
        }
        for (s, x) in self.basis.iter().enumerate() {
            for (t, y) in self.basis.iter().enumerate() {
                let xy = self.coordinates(&alg.mul(x, y)).unwrap();
                if sp.image(&xy) != mat_mul(r, &sp.images[s], &sp.images[t]) {
                    return Err("internal error: the splitting is not multiplicative".into());
                }
            }
        }
        Ok(sp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_splittings() {
        for d in [2i64, 5, 13, 17, 106, 229] {
            let f = QuadField::new(d).unwrap();
            let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
            for p in [2i64, 3, 5, 7, 11, 13, 53] {
                for pr in f.primes_above(p).unwrap() {
                    for e in 1..=3u32 {
                        if (pr.norm as u128).pow(e) > 1 << 16 {
                            continue;
                        }
                        let sp = o.local_splitting(pr, e).unwrap_or_else(|err| panic!("d = {}, P = {:?}, e = {}: {}", d, pr.ideal, e, err));
                        let r = &sp.ring;
                        // det = nrd and trace = trd on a few elements
                        for v in [[1i128, 0, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 2, 0, 0], [3, -1, 0, 2, 1, 0, -5, 1], [0, 0, 0, 0, 0, 0, 1, 1]] {
                            let x = o.element(&v);
                            let m = sp.image(&o.coordinates(&x).unwrap());
                            let det = r.sub(r.mul(m[0], m[3]), r.mul(m[1], m[2]));
                            assert_eq!(det, r.from_qelt(&o.alg.nrd(&x).integral().unwrap()));
                            assert_eq!(r.add(m[0], m[3]), r.from_qelt(&o.alg.trd(&x).integral().unwrap()));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn lambda_discriminant() {
        // d_Z(Lambda) = d_F^4 N(disc Lambda) = d_F^4 N(4ab)^2, N(12) = 144
        let f = QuadField::new(5).unwrap();
        let alg = QuatAlg::new(f, QElt::int(-1), QElt::int(-3)).unwrap();
        let lam = Lattice::from_gens(&[]);
        let d = det_bareiss(&trace_gram(&alg, &lam.basis())).abs();
        assert_eq!(d, big(5).pow(4) * big(144).pow(2));
    }

    #[test]
    fn hurwitz_and_icosians() {
        // Q(sqrt 5): (-1, -1) is unramified; the maximal order has the 120
        // icosians as its norm-one units (the binary icosahedral group)
        let f = QuadField::new(5).unwrap();
        let alg = QuatAlg::unramified(f).unwrap();
        assert_eq!((alg.a.clone(), alg.b.clone()), (QElt::int(-1), QElt::int(-1)));
        let o = MaximalOrder::new(&alg).unwrap();
        assert_eq!(o.norm_one_units().unwrap().len(), 120);
        // Q(sqrt 2): the binary octahedral group, of order 48
        let o = MaximalOrder::new(&QuatAlg::unramified(QuadField::new(2).unwrap()).unwrap()).unwrap();
        assert_eq!(o.norm_one_units().unwrap().len(), 48);
    }

    #[test]
    fn ramified_is_refused() {
        // (-1, -1) over Q(sqrt 17) is ramified at the two primes above 2
        let alg = QuatAlg::new(QuadField::new(17).unwrap(), QElt::int(-1), QElt::int(-1)).unwrap();
        assert!(MaximalOrder::new(&alg).is_err());
        // (-1, -3) over Q(sqrt 13): 3 splits and -1 is not a square mod 3
        let alg = QuatAlg::new(QuadField::new(13).unwrap(), QElt::int(-1), QElt::int(-3)).unwrap();
        assert!(MaximalOrder::new(&alg).is_err());
        assert!(QuatAlg::new(QuadField::new(13).unwrap(), QElt::int(1), QElt::int(-3)).is_err());
        // HARD-022-1 (daybreak): i64::MIN is outside |a|, |b| < 2^31, in a and
        // in b (abs() wrapped to i64::MIN < 2^31 in release builds)
        let f = QuadField::new(5).unwrap();
        for (a, b) in [(i64::MIN, -1), (-1, i64::MIN), (i64::MIN, i64::MIN), (-(1 << 31), -1), (-1, -(1 << 31))] {
            let alg = QuatAlg::new(f, QElt::int(a), QElt::int(b)).unwrap();
            assert_eq!(MaximalOrder::new(&alg).unwrap_err(), "maximal orders are implemented only for a, b in Z (|a|, |b| < 2^31)");
        }
        // a prime of another field
        let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
        let q = QuadField::new(13).unwrap().primes_above(3).unwrap()[0];
        assert!(o.local_splitting(q, 1).is_err());
    }

    #[test]
    fn small_fields() {
        for d in 2..200i64 {
            let Ok(f) = QuadField::new(d) else { continue };
            let alg = QuatAlg::unramified(f).unwrap();
            let o = MaximalOrder::new(&alg).unwrap_or_else(|e| panic!("d = {}: {}", d, e));
            assert!(o.lattice.contains(&BElt::one()));
            for x in &o.basis {
                assert!(alg.is_integral(x));
            }
        }
    }
}
