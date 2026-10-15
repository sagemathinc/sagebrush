//! Hilbert modular forms of weight k = (k1, k2) != (2, 2) and level N over
//! any real quadratic field F, by the definite method with coefficients:
//! weight.rs (Dembélé 2005, sections 2 and 3, over Q(sqrt 5)) on the
//! classes of definite.rs (Dembélé-Voight 2013, sections 4 and 8).
//!
//! The space. With I_1, ..., I_H the classes of definite.rs, O_j = O_L(I_j)
//! and L_k the weight representation of B^x (below),
//!
//! ```text
//! S_k^B(N) = sum over j of { f_j : P^1(O_F/N) -> L_k : f_j(g x) g = f_j(x), g in O_j^x },
//! ```
//!
//! the functions on B^x \ B^^x / O^_0(N)^x with values in L_k, without a
//! central quotient, as in weight 2 (definite.rs). By Jacquet-Langlands
//! (Dembélé 2005, Theorem 2.3) this is S_k(N) for k != (2, 2), with no
//! Eisenstein part (L_k is a nontrivial irreducible representation).
//!
//! The weight. m = k - 2, mu = max(m1, m2) and v = (mu - m)/2 as in
//! weight.rs (weights of mixed parity are refused by Weight). L_k =
//! Sym^m2 (x) Sym^m1 twisted by det^v2 (x) det^v1, where B^x acts on the
//! first factor through a splitting phi of B over an extension of F and on
//! the second through a splitting psi of B (x)_(F, conj) of the conjugate
//! (psi(c x) = conj(c) psi(x) for c in F). The characteristic polynomials
//! c in F[x] computed below (traces chi_m2(trd, nrd) conj(chi_m1(trd, nrd))
//! up to the twist) satisfy: for each real embedding sigma of F, sigma(c)
//! is the characteristic polynomial on the forms of weight k2 at sigma and
//! k1 at the other place. The convention for the real places: k1 at sqrt d
//! -> -sqrt d and k2 at sqrt d -> +sqrt d (as Sage orders the real
//! embeddings of Q(sqrt d), and as weight.rs over Q(sqrt 5), where w = (1 +
//! sqrt 5)/2). So an eigenvalue x in F, read at sqrt d -> +sqrt d (Sage's
//! embedding of QuadraticField(d)), is the eigenvalue of the forms. Magma
//! 2.18 puts k_i at InfinitePlaces(F)[i], so where its first place is sqrt
//! d -> +sqrt d (over Q(sqrt 2), for instance) its weight [k1, k2] is our
//! (k2, k1). Its eigenvalues over F in a relative extension agree with
//! ours read at its place of k1; its eigenvalues in F are fixed only up to
//! the conjugation of F (tests/defweight.rs).
//!
//! The center. A central z acts on L_k by N(z)^mu. A unit z of O_F lies in
//! every O_j^x and acts trivially on P^1, so f_j(x) = f_j(x) N(z)^mu: the
//! space is 0 when mu is odd and N(eps) = -1. Otherwise every unit of O_F
//! acts trivially on L_k (N(z)^mu = 1), and O_j^x acts through Gamma_j =
//! O_j^x / O_F^x, finite (a subgroup of B^x / F^x, inside SO(3) at a real
//! place), represented by the units of reduced norm 1 and eps up to sign
//! (classes.rs; eps is totally positive when N(eps) = 1, and a product of
//! reduced norm eps^2 is divided by the central eps).
//!
//! Brandt matrices (weight.rs). With x the orbit representatives of
//! Gamma_i, f is determined by the f_i(x) in L^Stab(x); for y = h x' (h in
//! Gamma_j, stored per point as a word), f_j(y) = f_j(x') h^-1, and h^-1 acts
//! as conj(h) (nrd h is 1 or eps, of norm 1). With the neighbour elements
//! (j, a) of definite.rs and u = conj(a),
//!
//! ```text
//! (f | T_P)_i(x) = sum over a of f_j(u x) u = sum over a of f_j(x') conj(h) u,   u x = h x',
//! ```
//!
//! the sum over the a acting nondegenerately when P divides N (U_P). As in
//! weight 2, this is N(P)^mu times a conjugate (by the scalars
//! N(nrd I_j)^mu on the classes) of the adelic operator f -> sum f(g pi)
//! with u^-1 = conj(u) / nrd(u) in place of u; over Q(sqrt 5) (H = 1) it is
//! the operator of weight.rs.
//!
//! Integrality. T_P preserves the functions with f_j(x) in the lattice
//! L_j = g_j Sym^m2(e phi(conj I_j)) (x) Sym^m1(e psi(conj I_j)) over the
//! integers of a field E splitting B and making the ideals nrd(I_j)^v2
//! conj(nrd I_j)^v1 principal, g_j their generators (e a row): a I_j lies in
//! I_i I_j^-1 I_j = I_i, so conj(I_j) conj(a) = conj(a I_j) lies in conj(I_i),
//! and the twist nrd(u)^v2 conj(nrd u)^v1 generates P^v2 conj(P)^v1 g_i /
//! g_j. So the characteristic polynomials of the Hecke operators lie in
//! O_E[x], and in F[x] (the construction is Galois equivariant over F:
//! conjugates of phi and psi are again splittings, conjugate to them by
//! Skolem-Noether), hence in O_F[x].
//!
//! Computation, modulo degree-one primes P = (p, w - s) of F with p > 2^61
//! (gpoly.rs), p prime to the discriminant and a a square modulo p, where
//! B = (a, b) with a, b in Z (quatalg.rs). Then i -> diag(r, -r), j ->
//! (0 b; 1 0), r^2 = a, maps the P-integral elements of B onto M_2(O_F/P)
//! (Lambda_P is maximal as p does not divide 2ab, |a|, |b| < 2^31 < p, and
//! this is the reduction of an isomorphism Lambda_P = M_2(O_(F,P)), r lifted
//! by Hensel), and the reduction of psi is the same map on the coordinates
//! reduced modulo P' = conj(P) (psi(x) = phi(conj x) with conj acting on the
//! coordinates, as a and b are rational). Every lattice L_j agrees with the
//! standard one at P (p is prime to N(nrd I_j) < 2^60 < p, the bound on
//! norms of rqf.rs; a denominator divisible by p would be an error at the
//! reduction, checked), two splittings of Lambda_P differ by GL_2(O_P), and
//! the invariants of Gamma_j (of order at most 60, prime to p) reduce to
//! those of the reduction (the averaging projector), whose dimensions are
//! checked against the exact ones. So the Hecke matrices computed here are reductions modulo P of
//! integral matrices whose characteristic polynomials lie in O_F[x]. The
//! exact dimension of L^Stab is (1/#Stab) sum tr(g), tr(g) =
//! chi_m2(trd g, nrd g) nrd(g)^v2 conj(chi_m1(trd g, nrd g) nrd(g)^v1), with
//! chi_m the character of Sym^m (chi_(m + 1) = t chi_m - n chi_(m - 1)).

use crate::definite::DefiniteSpace;
use crate::gpoly::GPlace;
use crate::p1::Mat as P1Mat;
use crate::quatalg::{BElt, QuatAlg};
use crate::rqf::{QElt, QPrime, QuadField};
use crate::weight::Weight;
use num_traits::{Signed, Zero};
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_bigint::BigInt;
use std::collections::HashMap;
use std::sync::Arc;

/// The largest S_k(N) whose Hecke matrices are formed (dense linear
/// algebra, as weightnew.rs).
pub const MAX_DIMENSION: usize = 4000;

/// The most work one Hecke matrix modulo one place may take, in
/// multiply-adds modulo p (estimated before the work, see `hecke_terms`;
/// measured at 1 to 4 ns each natively, so seconds to about 15 s at the
/// limit; defweightnew::MAX_TOTAL_WORK bounds the whole request).
pub const MAX_WORK: u64 = 1 << 32;

/// A degree-one place of F with the splitting of B there: r^2 = a and b
/// modulo p.
#[derive(Clone, Copy, Debug)]
pub struct WPlace {
    pub pl: GPlace,
    r: u64,
    b: u64,
}

impl WPlace {
    pub fn p(&self) -> u64 {
        self.pl.p()
    }
    pub fn md(&self) -> Modulus {
        self.pl.md
    }
    /// The conjugate place, with the same splitting data.
    pub fn conj(&self) -> WPlace {
        WPlace { pl: self.pl.conj(), r: self.r, b: self.b }
    }

    /// The reduction of the coordinate x_m of x, if x_m is P-integral.
    fn coord(&self, x: &BElt, m: usize) -> Result<u64, String> {
        let md = &self.pl.md;
        let den = md.inv(self.pl.red_int(&x.den)).ok_or("internal error: an element is not integral at the place")?;
        let num = md.add(self.pl.red_int(&x.c[2 * m]), md.mul(self.pl.red_int(&x.c[2 * m + 1]), self.pl.s));
        Ok(md.mul(num, den))
    }

    /// phi(x) = (x0 + r x1, b (x2 + r x3); x2 - r x3, x0 - r x1), as
    /// [m00, m01, m10, m11]: its determinant is nrd(x) and its trace trd(x)
    /// (reduced).
    pub fn split(&self, x: &BElt) -> Result<[u64; 4], String> {
        let md = &self.pl.md;
        let c: Vec<u64> = (0..4).map(|m| self.coord(x, m)).collect::<Result<_, _>>()?;
        let (r1, r3) = (md.mul(self.r, c[1]), md.mul(self.r, c[3]));
        Ok([md.add(c[0], r1), md.mul(self.b, md.add(c[2], r3)), md.sub(c[2], r3), md.sub(c[0], r1)])
    }
}

/// Pairs of conjugate places of F above primes below 2^62 (descending)
/// where B = (a, b) splits as above; a and b must be rational integers.
pub fn place_pairs(alg: &QuatAlg) -> Result<impl Iterator<Item = (WPlace, WPlace)>, String> {
    let (a, b) = (alg.a(), alg.b());
    if !a.b.is_zero() || !b.b.is_zero() {
        return Err("weights other than (2, 2) need an algebra (a, b) with a, b in Z".into());
    }
    let (a, b) = (a.a.clone(), b.a.clone());
    let f = *alg.field();
    Ok(Primes::new().filter_map(move |p| {
        // a check per prime (slow in wasm, as gpoly::place_pairs)
        sagebrush_interrupt::check();
        let (x, y) = GPlace::pair(&f, p)?;
        let ar = x.red_int(&a);
        if ar == 0 {
            return None;
        }
        let r = crate::field::sqrt_mod_p(ar, p)?;
        let br = x.red_int(&b);
        if br == 0 {
            return None;
        }
        Some((WPlace { pl: x, r, b: br }, WPlace { pl: y, r, b: br }))
    }))
}

fn mat2_mul(md: &Modulus, x: &[u64; 4], y: &[u64; 4]) -> [u64; 4] {
    let m = |a: u64, b: u64, c: u64, d: u64| md.add(md.mul(a, b), md.mul(c, d));
    [m(x[0], y[0], x[1], y[2]), m(x[0], y[1], x[1], y[3]), m(x[2], y[0], x[3], y[2]), m(x[2], y[1], x[3], y[3])]
}

fn det2(md: &Modulus, x: &[u64; 4]) -> u64 {
    md.sub(md.mul(x[0], x[3]), md.mul(x[1], x[2]))
}

/// Sym^m of g = (al be; ga de) as a right action on the polynomials of
/// degree m in X, Y (P -> P(al X + be Y, ga X + de Y)): row i holds the
/// coefficients of (al X + be Y)^(m - i) (ga X + de Y)^i in X^(m - j) Y^j.
/// Sym^m(g h) = Sym^m(g) Sym^m(h).
fn sym(m: usize, g: &[u64; 4], md: &Modulus) -> Vec<Vec<u64>> {
    // pow(l)[k] = the coefficients of l^k, l = (c0 X + c1 Y)
    let powers = |c0: u64, c1: u64| -> Vec<Vec<u64>> {
        let mut out = vec![vec![1u64]];
        for k in 1..=m {
            let prev = &out[k - 1];
            let mut next = vec![0u64; k + 1];
            for (j, &x) in prev.iter().enumerate() {
                next[j] = md.add(next[j], md.mul(x, c0));
                next[j + 1] = md.add(next[j + 1], md.mul(x, c1));
            }
            out.push(next);
        }
        out
    };
    let a = powers(g[0], g[1]);
    let c = powers(g[2], g[3]);
    (0..=m)
        .map(|i| {
            let (u, v) = (&a[m - i], &c[i]);
            let mut row = vec![0u64; m + 1];
            for (s, &x) in u.iter().enumerate() {
                if x == 0 {
                    continue;
                }
                for (t, &y) in v.iter().enumerate() {
                    row[s + t] = md.add(row[s + t], md.mul(x, y));
                }
            }
            row
        })
        .collect()
}

/// The matrix (row vectors, right action) of the element with images g2 =
/// phi(x) and g1 = psi(x) on L_k, flattened row by row: det(g2)^v2
/// det(g1)^v1 Sym^m2(g2) (x) Sym^m1(g1).
fn rep(w: &Weight, g2: &[u64; 4], g1: &[u64; 4], md: &Modulus) -> Vec<u64> {
    let m = w.m();
    let v = w.v();
    let s2 = sym(m[1] as usize, g2, md);
    let s1 = sym(m[0] as usize, g1, md);
    let scale = md.mul(md.pow(det2(md, g2), v[1] as u64), md.pow(det2(md, g1), v[0] as u64));
    let (n2, n1) = (s2.len(), s1.len());
    let d = n1 * n2;
    let mut out = vec![0u64; d * d];
    for i2 in 0..n2 {
        for j2 in 0..n2 {
            let x = md.mul(scale, s2[i2][j2]);
            if x == 0 {
                continue;
            }
            for i1 in 0..n1 {
                let row = (i2 * n1 + i1) * d + j2 * n1;
                for j1 in 0..n1 {
                    out[row + j1] = md.mul(x, s1[i1][j1]);
                }
            }
        }
    }
    out
}

/// chi_m(t, n): the trace of Sym^m on an element of trace t and
/// determinant n.
fn sym_character(f: &QuadField, m: u32, t: &QElt, n: &QElt) -> QElt {
    let (mut a, mut b) = (QElt::int(1), t.clone());
    if m == 0 {
        return a;
    }
    for _ in 1..m {
        let c = f.sub(&f.mul(t, &b), &f.mul(n, &a));
        a = b;
        b = c;
    }
    b
}

/// The trace of g on L_k, in O_F (module documentation).
fn character(f: &QuadField, w: &Weight, t: &QElt, n: &QElt) -> QElt {
    let m = w.m();
    let v = w.v();
    let c2 = f.mul(&sym_character(f, m[1], t, n), &f.pow(n, v[1]));
    let c1 = f.mul(&sym_character(f, m[0], t, n), &f.pow(n, v[0]));
    f.mul(&c2, &f.conj(&c1))
}

/// Gamma_j = O_j^x / O_F^x: representatives (the units of reduced norm 1
/// and eps, one of each pair +-x) and the multiplication table.
struct Group {
    elts: Vec<BElt>,
    mult: Vec<Vec<u8>>,
    one: u8,
    /// The trace of each element on L_k.
    traces: Vec<QElt>,
}

/// x or -x, whichever has its first nonzero coordinate positive.
fn canon(alg: &QuatAlg, x: &BElt) -> BElt {
    match x.c.iter().find(|c| !c.is_zero()) {
        Some(c) if c.is_negative() => alg.neg(x),
        _ => x.clone(),
    }
}

impl Group {
    /// Generators, chosen greedily: each element not in the group
    /// generated so far.
    fn generators(&self) -> Vec<u8> {
        let mut gens: Vec<u8> = vec![];
        let mut have: u64 = 1u64 << self.one;
        for s in 0..self.elts.len() as u8 {
            if have >> s & 1 == 0 {
                gens.push(s);
                have = self.closure_bits(gens.iter().fold(0u64, |b, &g| b | 1u64 << g));
            }
        }
        gens
    }

    /// The subgroup generated by a set of elements (a bitset), as a bitset.
    fn closure_bits(&self, set: u64) -> u64 {
        let gens: Vec<usize> = (0..self.elts.len()).filter(|&s| set >> s & 1 == 1).collect();
        let mut have: u64 = 1u64 << self.one;
        let mut list = vec![self.one as usize];
        let mut i = 0;
        while i < list.len() {
            for &g in &gens {
                let c = self.mult[list[i]][g] as usize;
                if have >> c & 1 == 0 {
                    have |= 1u64 << c;
                    list.push(c);
                }
            }
            i += 1;
        }
        have
    }

    /// The subgroup generated by a set of elements, sorted.
    fn closure(&self, set: u64) -> Vec<u8> {
        let b = self.closure_bits(set);
        (0..self.elts.len() as u8).filter(|&s| b >> s & 1 == 1).collect()
    }

    /// The inverse of each element.
    fn inverses(&self) -> Result<Vec<u8>, String> {
        (0..self.elts.len())
            .map(|a| (0..self.elts.len()).find(|&b| self.mult[a][b] == self.one).map(|b| b as u8).ok_or_else(|| "internal error: a unit without an inverse".to_string()))
            .collect()
    }

    fn new(sp: &DefiniteSpace, j: usize, w: &Weight) -> Result<Group, String> {
        let cs = sp.classes();
        let alg = cs.order().alg();
        let f = *alg.field();
        let cg = cs.class_group();
        let c = &cs.classes()[j];
        let mut elts: Vec<BElt> = vec![];
        let mut index: HashMap<BElt, u8> = HashMap::new();
        for x in c.units_one().iter().chain(c.units_eps()) {
            let y = canon(alg, x);
            if !index.contains_key(&y) {
                if elts.len() >= 60 {
                    return Err("internal error: a unit group has more than 60 elements modulo the center".into());
                }
                index.insert(y.clone(), elts.len() as u8);
                elts.push(y);
            }
        }
        if elts.len() != c.weight() {
            return Err("internal error: the units do not come in pairs +-x".into());
        }
        // eps^-1 = conj(eps) when N(eps) = 1
        let eps2 = f.mul(&cg.eps, &cg.eps);
        let eps_inv = crate::classes::central(&f.conj(&cg.eps));
        let mut mult = vec![vec![0u8; elts.len()]; elts.len()];
        for (s, x) in elts.iter().enumerate() {
            for (t, y) in elts.iter().enumerate() {
                sagebrush_interrupt::check();
                let mut z = alg.mul(x, y);
                let n = alg.nrd(&z).integral().ok_or("internal error: a unit of non-integral norm")?;
                if cg.eps_norm == 1 && n == eps2 {
                    z = alg.mul(&z, &eps_inv);
                }
                mult[s][t] = *index.get(&canon(alg, &z)).ok_or("internal error: the units are not closed under multiplication")?;
            }
        }
        let one = *index.get(&BElt::one()).ok_or("internal error: 1 is not among the units")?;
        let mut traces = vec![];
        for x in &elts {
            sagebrush_interrupt::check();
            let t = alg.trd(x).integral().ok_or("internal error: a unit of non-integral trace")?;
            let n = alg.nrd(x).integral().ok_or("internal error: a unit of non-integral norm")?;
            traces.push(character(&f, w, &t, &n));
        }
        Ok(Group { elts, mult, one, traces })
    }
}

/// S_k(N) for k != (2, 2) over F (module documentation), on the orbits of
/// the weight 2 space.
pub struct WeightSpace {
    space: Arc<DefiniteSpace>,
    weight: Weight,
    groups: Vec<Group>,
    /// word[j][y]: the element h of Gamma_j with y = h x', x' the
    /// representative of the orbit of y.
    word: Vec<Vec<u8>>,
    /// For each basis element of the weight 2 space (an orbit), its class
    /// and the stabilizer of its representative.
    stabilizers: Vec<(usize, Vec<u8>)>,
    /// dim L^Stab for each orbit (exact).
    dims: Vec<usize>,
    /// The index of the first coordinate of each orbit.
    offset: Vec<usize>,
    /// The work modulo one place that does not depend on P: the
    /// invariant bases, and the reductions of the group elements.
    fixed_work: u128,
}

/// The cost of reducing an element of B modulo a place (big integers), in
/// multiply-adds, for the work estimates.
const SPLIT_COST: u128 = 2000;

/// The data of T_P (U_P for P | N) that does not depend on the place: the
/// elements u = conj(a), and for each orbit of positive dimension the
/// terms (target orbit, h in its class's group, u).
pub struct HeckeTerms {
    us: Vec<BElt>,
    rows: Vec<(usize, Vec<(usize, u8, u32)>)>,
    work: u64,
    /// The neighbour elements of P (for reuse on other divisor spaces).
    pub(crate) theta: Arc<Vec<Vec<(usize, BElt)>>>,
}

impl HeckeTerms {
    /// The estimated work modulo one place, in multiply-adds.
    pub fn work(&self) -> u64 {
        self.work
    }
}

impl WeightSpace {
    /// S_k(N) on the weight 2 space `space` (k != (2, 2)).
    pub fn new(space: Arc<DefiniteSpace>, weight: Weight) -> Result<WeightSpace, String> {
        if weight.k == [2, 2] {
            return Err("weight (2, 2) is the weight 2 space (DefiniteSpace), with its Eisenstein series".into());
        }
        let cs = space.classes();
        let cg = cs.class_group();
        // the center acts by N(z)^mu: the space is 0 for odd mu and N(eps) = -1
        let zero = weight.mu() % 2 == 1 && cg.eps_norm == -1;
        let h = cs.len();
        let n = space.points() as usize;
        let mut groups = vec![];
        let mut word = vec![];
        let mut stabilizers = vec![];
        let mut dims = vec![];
        for j in 0..h {
            let g = Group::new(&space, j, &weight)?;
            let nj = BigInt::from(cs.classes()[j].ideal().nrd().norm());
            // generators of Gamma_j and their permutations of P^1 (as for
            // the orbits of definite.rs)
            let gens = g.generators();
            let mats: Vec<Vec<P1Mat>> = gens.iter().map(|&s| space.images(&g.elts[s as usize], &nj)).collect::<Result<_, _>>()?;
            let tables = space.tables(&mats)?;
            let radix = space.radix();
            // words, by a search from each representative with the
            // generators: y = s x gives w(y) = s w(x)
            let mut wj = vec![u8::MAX; n];
            let mut stack = vec![];
            let mut sizes = vec![0usize; space.reps(j).len()];
            for (k, &rep) in space.reps(j).iter().enumerate() {
                wj[rep as usize] = g.one;
                stack.push(rep);
                while let Some(x) = stack.pop() {
                    sagebrush_interrupt::check();
                    sizes[k] += 1;
                    for (t, &s) in tables.iter().zip(&gens) {
                        let y = space.apply(t, &radix, x) as usize;
                        if wj[y] == u8::MAX {
                            wj[y] = g.mult[s as usize][wj[x as usize] as usize];
                            stack.push(y as u64);
                        }
                    }
                }
            }
            if wj.iter().any(|&x| x == u8::MAX) {
                return Err("internal error: a point of P^1 was not reached from its orbit representative".into());
            }
            // the stabilizer of each representative x from Schreier's lemma:
            // for y in its orbit and a generator s, w(s y)^-1 s w(y) fixes x,
            // and these elements generate the stabilizer (closed under the
            // multiplication table; groups of at most 60 elements are
            // subsets of a u64)
            let inv = g.inverses()?;
            let mut schreier = vec![0u64; space.reps(j).len()];
            for y in 0..n as u64 {
                sagebrush_interrupt::check();
                let k = space.orbit_of(j, y);
                let wy = wj[y as usize] as usize;
                for (t, &s) in tables.iter().zip(&gens) {
                    let z = space.apply(t, &radix, y) as usize;
                    let e = g.mult[inv[wj[z] as usize] as usize][g.mult[s as usize][wy] as usize];
                    schreier[k] |= 1u64 << e;
                }
            }
            // stabilizers and exact dimensions (cached by stabilizer)
            let mut cache: HashMap<Vec<u8>, usize> = HashMap::new();
            for k in 0..space.reps(j).len() {
                let st = g.closure(schreier[k]);
                if st.len() * sizes[k] != g.elts.len() {
                    return Err(format!("internal error: an orbit of size {} has a stabilizer of order {} in a group of order {}", sizes[k], st.len(), g.elts.len()));
                }
                let dim = if zero {
                    0
                } else if let Some(&d) = cache.get(&st) {
                    d
                } else {
                    let f = *cs.order().alg().field();
                    let s = st.iter().fold(QElt::int(0), |acc, &x| f.add(&acc, &g.traces[x as usize]));
                    let order = BigInt::from(st.len());
                    if !s.b.is_zero() || s.a.is_negative() || !(&s.a % &order).is_zero() {
                        return Err(format!("internal error: the character sum {} over a group of order {} is not a dimension", s, st.len()));
                    }
                    let d = usize::try_from(&(&s.a / &order)).map_err(|_| "internal error: a dimension out of range")?;
                    cache.insert(st.clone(), d);
                    d
                };
                stabilizers.push((j, st));
                dims.push(dim);
            }
            groups.push(g);
            word.push(wj);
        }
        let mut offset = vec![0usize; dims.len() + 1];
        for b in 0..dims.len() {
            offset[b + 1] = offset[b] + dims[b];
        }
        // per distinct stabilizer of positive dimension, the projector (a
        // representation matrix per element) and its echelon form (d^3)
        let d = weight.rep_dim() as u128;
        let mut distinct: std::collections::HashSet<(usize, &Vec<u8>)> = std::collections::HashSet::new();
        let mut fixed_work: u128 = groups.iter().map(|g| g.elts.len() as u128 * 2 * SPLIT_COST).sum();
        for ((j, st), &dim) in stabilizers.iter().zip(&dims) {
            if dim > 0 && distinct.insert((*j, st)) {
                fixed_work += st.len() as u128 * Self::rep_cost(&weight) + d * d * d;
            }
        }
        Ok(WeightSpace { space, weight, groups, word, stabilizers, dims, offset, fixed_work })
    }

    pub fn weight(&self) -> Weight {
        self.weight
    }
    /// The cost of a representation matrix: the two symmetric powers
    /// (about (m + 1)^3 / 6 each) and the tensor product, added (2 d^2).
    fn rep_cost(w: &Weight) -> u128 {
        let d = w.rep_dim() as u128;
        let m = w.m();
        2 * d * d + (m[0] as u128 + 1).pow(3) / 6 + (m[1] as u128 + 1).pow(3) / 6
    }
    pub fn space(&self) -> &DefiniteSpace {
        &self.space
    }
    /// dim S_k(N).
    pub fn dimension(&self) -> usize {
        self.offset[self.dims.len()]
    }
    /// The dimension of each orbit's invariants.
    pub fn dims(&self) -> &[usize] {
        &self.dims
    }

    /// The place-independent data of T_P (U_P if P divides N).
    pub fn hecke_terms(&self, p: &QPrime) -> Result<HeckeTerms, String> {
        self.hecke_terms_with(p, None)
    }

    /// hecke_terms, with the neighbour elements of P given or found (they
    /// depend only on the classes and P: WeightNewspaces shares them across
    /// its divisor spaces), returned for reuse.
    pub(crate) fn hecke_terms_with(&self, p: &QPrime, given: Option<&Arc<Vec<Vec<(usize, BElt)>>>>) -> Result<HeckeTerms, String> {
        if self.dimension() > MAX_DIMENSION {
            return Err(format!("S_k(N) has dimension {}, above the limit of {}", self.dimension(), MAX_DIMENSION));
        }
        let sp = &self.space;
        let degenerate = sp.degenerate_factor(p);
        let want = if degenerate.is_some() { p.norm } else { p.norm + 1 };
        // the work modulo one place, refused before the neighbour search:
        // the fixed work, the reductions of the H (N(P) + 1) neighbour
        // elements, a representation matrix per term, and per row and
        // target orbit t the products B_t S (dim_t d^2), at most dim S_k(N)
        // d^2 per row
        let d = self.weight.rep_dim() as u128;
        let rows = self.dims.iter().filter(|&&x| x > 0).count() as u128;
        let h = sp.classes().len() as u128;
        let work = self.fixed_work
            + h * (p.norm as u128 + 1) * 2 * SPLIT_COST
            + rows * (want as u128 * Self::rep_cost(&self.weight) + self.dimension() as u128 * d * d);
        if work > MAX_WORK as u128 {
            return Err(format!("T_P at a prime of norm {} in weight {:?} is too large a computation (unsupported)", p.norm, self.weight.k));
        }
        let theta = match given {
            Some(t) => t.clone(),
            None => Arc::new(sp.neighbour_elements(p)?),
        };
        let alg = sp.classes().order().alg();
        let mut us = vec![];
        let mut by_class: Vec<Vec<(usize, u32, Vec<P1Mat>)>> = vec![];
        for list in theta.iter() {
            let mut v = vec![];
            for (j, a) in list {
                let u = alg.conj(a);
                let nj = BigInt::from(sp.classes().classes()[*j].ideal().nrd().norm());
                v.push((*j, us.len() as u32, sp.images(&u, &nj)?));
                us.push(u);
            }
            by_class.push(v);
        }
        let mut out = vec![];
        for (b, &(i, _)) in self.stabilizers.iter().enumerate() {
            if self.dims[b] == 0 {
                continue;
            }
            let x = sp.rep_point(b);
            let mut terms = vec![];
            let mut count: i128 = 0;
            for (j, ui, mats) in &by_class[i] {
                sagebrush_interrupt::check();
                let Some(y) = sp.act_or_degenerate(mats, x, degenerate)? else { continue };
                count += 1;
                let t = sp.offset(*j) + sp.orbit_of(*j, y);
                if self.dims[t] > 0 {
                    terms.push((t, self.word[*j][y as usize], *ui));
                }
            }
            if count != want {
                return Err(format!("internal error: {} terms in a row of the Hecke operator instead of {}", count, want));
            }
            terms.sort_unstable();
            out.push((b, terms));
        }
        Ok(HeckeTerms { us, rows: out, work: work as u64, theta })
    }

    /// For each orbit of positive dimension, a basis of the invariants
    /// (L/P)^Stab in reduced echelon form with its pivot columns; an Err if
    /// a dimension differs from the exact one.
    fn invariant_bases(&self, pl: &WPlace, conj_mats: &[Vec<([u64; 4], [u64; 4])>]) -> Result<Vec<Option<(Mat, Vec<usize>)>>, String> {
        let md = pl.md();
        let d = self.weight.rep_dim();
        let mut cache: HashMap<(usize, Vec<u8>), (Mat, Vec<usize>)> = HashMap::new();
        let mut out = vec![];
        for ((j, st), &dim) in self.stabilizers.iter().zip(&self.dims) {
            if dim == 0 {
                out.push(None);
                continue;
            }
            let key = (*j, st.clone());
            if let Some(b) = cache.get(&key) {
                out.push(Some(b.clone()));
                continue;
            }
            // the averaging projector (1/#Stab) sum M(g); M(conj g) = M(g^-1)
            // runs over the same group
            let mut p = vec![0u64; d * d];
            for &g in st {
                sagebrush_interrupt::check();
                let (g2, g1) = &conj_mats[*j][g as usize];
                let m = rep(&self.weight, g2, g1, &md);
                for (x, y) in p.iter_mut().zip(&m) {
                    *x = md.add(*x, *y);
                }
            }
            let inv = md.inv(st.len() as u64 % md.n).ok_or("p divides the order of a stabilizer")?;
            let rows: Vec<Vec<u64>> = (0..d).map(|i| (0..d).map(|k| md.mul(p[i * d + k], inv)).collect()).collect();
            let mut a = Mat::from_rows(&rows, md);
            let piv = a.rref();
            if piv.len() != dim {
                return Err(format!("internal error: invariants of dimension {} modulo {}, expected {}", piv.len(), md.n, dim));
            }
            let rows: Vec<Vec<u64>> = (0..dim).map(|i| a.row(i).to_vec()).collect();
            let b = (Mat::from_rows(&rows, md), piv);
            cache.insert(key, b.clone());
            out.push(Some(b));
        }
        Ok(out)
    }

    /// The matrix of T_P (U_P if P divides N) on S_k(N) at the place,
    /// acting on coordinate columns as weight.rs: (f | T)(x_i) in
    /// coordinates is row (i, a) times the coordinates of f.
    pub fn hecke_mod(&self, terms: &HeckeTerms, pl: &WPlace) -> Result<Mat, String> {
        let md = pl.md();
        let n = self.dimension();
        let mut t = Mat::zero(n, n, md);
        if n == 0 {
            return Ok(t);
        }
        let conj_pl = pl.conj();
        let alg = self.space.classes().order().alg();
        // the images of conj(h) for h in each group, and of each u
        let conj_mats: Vec<Vec<([u64; 4], [u64; 4])>> = self
            .groups
            .iter()
            .map(|g| g.elts.iter().map(|h| {
                let c = alg.conj(h);
                Ok((pl.split(&c)?, conj_pl.split(&c)?))
            }).collect::<Result<_, String>>())
            .collect::<Result<_, _>>()?;
        let u_mats: Vec<([u64; 4], [u64; 4])> = terms.us.iter().map(|u| Ok((pl.split(u)?, conj_pl.split(u)?))).collect::<Result<_, String>>()?;
        let bases = self.invariant_bases(pl, &conj_mats)?;
        let d = self.weight.rep_dim();
        let rows: Vec<Result<Vec<(usize, Vec<u64>)>, String>> = crate::par::map_range(terms.rows.len(), |r| {
            let (bi, list) = &terms.rows[r];
            let (basis_i, piv_i) = bases[*bi].as_ref().unwrap();
            let mut out = vec![];
            let mut k = 0;
            while k < list.len() {
                let target = list[k].0;
                // S = sum of M(conj(h) u) over the terms into this orbit
                let mut s = vec![0u64; d * d];
                while k < list.len() && list[k].0 == target {
                    sagebrush_interrupt::check();
                    let (_, h, ui) = list[k];
                    let j = self.stabilizers[target].0;
                    let (h2, h1) = &conj_mats[j][h as usize];
                    let (u2, u1) = &u_mats[ui as usize];
                    let m = rep(&self.weight, &mat2_mul(&md, h2, u2), &mat2_mul(&md, h1, u1), &md);
                    for (x, y) in s.iter_mut().zip(&m) {
                        *x = md.add(*x, *y);
                    }
                    k += 1;
                }
                let (basis_j, _) = bases[target].as_ref().unwrap();
                for b in 0..self.dims[target] {
                    // the row B_j[b] S, which must lie in the invariants of x_i
                    let mut row = vec![0u64; d];
                    for e in 0..d {
                        let c = basis_j.get(b, e);
                        if c == 0 {
                            continue;
                        }
                        for (x, y) in row.iter_mut().zip(&s[e * d..(e + 1) * d]) {
                            *x = md.add(*x, md.mul(c, *y));
                        }
                    }
                    for c in 0..d {
                        let x = (0..self.dims[*bi]).fold(0u64, |acc, a| md.add(acc, md.mul(row[piv_i[a]], basis_i.get(a, c))));
                        if x != row[c] {
                            return Err("internal error: a Hecke image is not invariant under the stabilizer".into());
                        }
                    }
                    out.push((self.offset[target] + b, piv_i.iter().map(|&q| row[q]).collect()));
                }
            }
            Ok(out)
        });
        for (r, res) in rows.into_iter().enumerate() {
            let bi = terms.rows[r].0;
            for (col, vals) in res? {
                for (a, v) in vals.into_iter().enumerate() {
                    let e = t.get(self.offset[bi] + a, col);
                    t.set(self.offset[bi] + a, col, md.add(e, v));
                }
            }
        }
        Ok(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quatalg::MaximalOrder;

    fn alg(d: i64) -> (QuadField, MaximalOrder) {
        let f = QuadField::new(d).unwrap();
        (f, MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap())
    }

    #[test]
    fn splitting_is_multiplicative() {
        for d in [2i64, 3, 5, 10, 13, 17] {
            let (_, o) = alg(d);
            let a = o.alg();
            let (pl, pl2) = place_pairs(a).unwrap().next().unwrap();
            let basis = o.basis();
            for x in basis {
                for y in basis {
                    for q in [pl, pl2] {
                        let md = q.md();
                        assert_eq!(q.split(&a.mul(x, y)).unwrap(), mat2_mul(&md, &q.split(x).unwrap(), &q.split(y).unwrap()));
                    }
                }
                let n = a.nrd(x).integral().unwrap();
                assert_eq!(det2(&pl.md(), &pl.split(x).unwrap()), pl.pl.red(&n));
            }
        }
    }

    #[test]
    fn representation_is_a_right_action() {
        let (_, o) = alg(3);
        let a = o.alg();
        let (pl, _) = place_pairs(a).unwrap().next().unwrap();
        let md = pl.md();
        let b = o.basis();
        for w in [Weight::new(2, 4).unwrap(), Weight::new(3, 5).unwrap(), Weight::new(6, 4).unwrap()] {
            let d = w.rep_dim();
            for (x, y) in [(&b[1], &b[2]), (&b[3], &b[7]), (&b[5], &b[5])] {
                let im = |z: &BElt| (pl.split(z).unwrap(), pl.conj().split(z).unwrap());
                let ((x2, x1), (y2, y1), (z2, z1)) = (im(x), im(y), im(&a.mul(x, y)));
                let mx = rep(&w, &x2, &x1, &md);
                let my = rep(&w, &y2, &y1, &md);
                let mz = rep(&w, &z2, &z1, &md);
                let to = |v: &[u64]| Mat::from_rows(&(0..d).map(|i| v[i * d..(i + 1) * d].to_vec()).collect::<Vec<_>>(), md);
                assert_eq!(to(&mx).mul(&to(&my)), to(&mz));
                // the trace is the character, reduced
                let t = a.trd(x).integral().unwrap();
                let n = a.nrd(x).integral().unwrap();
                let tr = (0..d).fold(0u64, |acc, i| md.add(acc, mx[i * d + i]));
                assert_eq!(tr, pl.pl.red(&character(a.field(), &w, &t, &n)));
            }
        }
    }
}
