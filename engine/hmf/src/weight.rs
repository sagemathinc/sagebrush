//! Hilbert modular forms of weight k = (k1, k2) over F = Q(sqrt 5), by the
//! definite method with coefficients (Dembélé 2005, sections 2 and 3).
//!
//! Let m = k - 2, mu = max(m1, m2) and v = (mu - m)/2 (Dembélé 2005, section
//! 2: v >= 0, some v_i = 0, m + 2v = mu (1, 1)). The weight is the
//! representation L_k = S_{m1, v1} (x) S_{m2, v2} of B^x, where S_{a, b} is
//! Sym^a of the standard representation twisted by det^b, through the two
//! real embeddings of F; then (Definition 2.1 and Proposition 3.1)
//!
//!   S_k^B(N) = { f : P^1(O_F/N) -> L_k : f(g x) g = f(x) for g in R^x },
//!
//! and by Jacquet-Langlands (Theorem 2.3) this is S_k(N) for k != (2, 2)
//! (L_k is then nontrivial, so it has no Eisenstein part). A central unit e
//! acts on L_k by N(e)^mu, and trivially on P^1, so the space is 0 when mu
//! is odd (w has norm -1); otherwise R^x acts through R^x_1 / {+-1}. Weights
//! of mixed parity have no v, and are rejected.
//!
//! The model of L_k, over F. For m = 2r even, Sym^{2r} of the standard
//! representation is det^r times the harmonic polynomials of degree r on the
//! trace-zero quaternions B^0 (the adjoint representation): with u acting on
//! a polynomial P by (P.u)(X) = P(u X conj(u)), the eigenvalues of u on
//! polynomials of degree r modulo the multiples of the norm form
//! Q = nrd = x^2 + y^2 + z^2 (Q(u X conj(u)) = nrd(u)^2 Q(X), so this is a
//! quotient representation) are lambda1^(2r - i) lambda2^i, those of Sym^2r,
//! where lambda1, lambda2 are those of u. The quotient has the basis of the
//! monomials x^a y^b z^c with c <= 1 (z^2 = -x^2 - y^2 modulo Q). So
//!
//!   L_k = H_{r2} (x) H_{r1},  u acting by nrd(u)^v2 conj(nrd(u))^v1 times
//!         P (x) P' -> P(u X conj(u)) (x) P'(u' X conj(u'))
//!
//! with u' the Galois conjugate of u (coordinates in 1, i, j, k conjugated),
//! and m = 2r (the order of the factors is that of Weight).
//! This is a right action defined over F, so the Hecke operators are
//! matrices over F (their eigenvalues generate fields containing F when
//! k1 != k2: Dembélé's Examples 3.5 and 3.6 have a_2 = 4w - 12).
//!
//! Brandt matrices (Definition 3.2). With x_1, ..., x_s the orbit
//! representatives, f is determined by the f(x_j) in L^{Gamma_j}, Gamma_j
//! the stabilizer of x_j. For a point y = h x_j (h in R^x_1, stored per point
//! as in Dembélé's step 4, "an icosian which sends it to the unique element
//! of the fundamental domain"), f(y) = f(x_j) h^-1; so
//!
//!   (f | T_p)(x_i) = sum over u in Theta(p) of f(u x_i) u
//!                  = sum over u of f(x_j) conj(h) u,   u x_i = h x_j,
//!
//! the sum over the u acting nondegenerately when p divides N (U_p, as in
//! weight 2). Here u = conj(alpha), alpha in Theta(p) (lib.rs), runs over
//! R^x \ {nrd = pi} with pi totally positive, so the sum does not depend on
//! the representatives.
//!
//! Computation. All of this is done modulo degree-one primes P = (p, w - s)
//! of F (p = +-1 mod 5, p > 5), where L_k and its invariants reduce well:
//! the polynomial lattice is stable under R at odd p, and for p not dividing
//! #Gamma_j (which divides 120) the invariants of the reduction are the
//! reduction of the invariants. dim L^Gamma is exact, from the character
//! formula (1/#Gamma) sum chi(g), chi = chi_{m1}(trd g) conj(chi_{m2}(trd g))
//! with chi_n the characters of Sym^n (det 1), and is checked against each
//! reduction.

use crate::field::{sqrt_mod_p, Elt, Ideal, Prime};
use crate::orbits::local_permutations;
use crate::quat::{icosians, Quat};
use crate::{theta, Space};
use sagebrush_arith::nmod::{Modulus, Primes};
use sagebrush_arith::nmod_mat::Mat;
use std::collections::HashMap;

/// A weight (k1, k2) with k1, k2 >= 2 of the same parity: k1 at the real
/// place w -> (1 - sqrt 5)/2 and k2 at w -> (1 + sqrt 5)/2, the order of
/// Magma's InfinitePlaces(F) (checked against Magma's HilbertCuspForms as a
/// black box and Dembélé's Table 1: weight (2, 4) at level (3 + w) has
/// a_2 = 4w - 12). In the model above, u acts as itself on the factor of
/// weight k2 and through its conjugate on that of weight k1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Weight {
    pub k: [u32; 2],
}

impl Weight {
    pub fn new(k1: u32, k2: u32) -> Result<Weight, String> {
        if k1 < 2 || k2 < 2 {
            return Err("the weights must be at least 2".into());
        }
        if k1 % 2 != k2 % 2 {
            return Err("the weights must have the same parity".into());
        }
        if k1 > 200 || k2 > 200 {
            return Err("weights above 200 are not supported".into());
        }
        Ok(Weight { k: [k1, k2] })
    }
    /// m = k - 2.
    pub fn m(&self) -> [u32; 2] {
        [self.k[0] - 2, self.k[1] - 2]
    }
    /// mu = max(m1, m2).
    pub fn mu(&self) -> u32 {
        self.m()[0].max(self.m()[1])
    }
    /// v = (mu - m)/2.
    pub fn v(&self) -> [u32; 2] {
        let m = self.m();
        [(self.mu() - m[0]) / 2, (self.mu() - m[1]) / 2]
    }
    /// Whether the space is 0 for every level: mu is odd.
    pub fn is_odd(&self) -> bool {
        self.mu() % 2 == 1
    }
    /// The dimension of L_k.
    pub fn rep_dim(&self) -> usize {
        let m = self.m();
        (m[0] as usize + 1) * (m[1] as usize + 1)
    }
}

/// A prime of F of degree one, (p, w - s): the reduction O_F -> Z/p with
/// w -> s.
#[derive(Clone, Copy, Debug)]
pub struct Place {
    pub md: Modulus,
    pub s: u64,
}

impl Place {
    pub fn p(&self) -> u64 {
        self.md.n
    }
    /// The image of x.
    pub fn red(&self, x: Elt) -> u64 {
        self.md.add(self.md.from_i64(x.a), self.md.mul(self.md.from_i64(x.b), self.s))
    }
    /// The conjugate place (p, w - s'), s + s' = 1: reducing conj(x) here
    /// is reducing x there.
    pub fn conj(&self) -> Place {
        Place { md: self.md, s: self.md.sub(1, self.s) }
    }
    /// The two places above p, if p > 5 is prime and splits in F.
    pub fn pair(p: u64) -> Option<(Place, Place)> {
        if p <= 5 || (p % 5 != 1 && p % 5 != 4) {
            return None;
        }
        let md = Modulus::new(p);
        let r = sqrt_mod_p(5, p)?;
        // s = (1 + sqrt 5)/2
        let s = md.mul(md.add(1, r), md.inv(2)?);
        let a = Place { md, s };
        Some((a, a.conj()))
    }
}

/// Pairs of conjugate places above word-size primes p = +-1 mod 5, from
/// below 2^62 descending.
pub fn place_pairs() -> impl Iterator<Item = (Place, Place)> {
    Primes::new().filter_map(Place::pair)
}

/// chi_n(t): the character of Sym^n on an element of determinant 1 and
/// trace t.
fn sym_character(n: u32, t: Elt) -> Elt {
    let (mut a, mut b) = (Elt::int(1), t); // chi_0, chi_1
    if n == 0 {
        return a;
    }
    for _ in 1..n {
        let c = t.mul(b).sub(a);
        a = b;
        b = c;
    }
    b
}

/// The dimension of the invariants of the elements gs (of reduced norm 1, a
/// group) on L_k, by the character formula.
pub fn invariant_dimension(w: &Weight, gs: &[Quat]) -> Result<usize, String> {
    let m = w.m();
    let mut s = Elt::int(0);
    for g in gs {
        let t = g.trd();
        s = s.add(sym_character(m[1], t).mul(sym_character(m[0], t).conj()));
    }
    let n = gs.len() as i64;
    if s.b != 0 || s.a % n != 0 || s.a < 0 {
        return Err(format!("character sum {:?} over a group of order {} is not a dimension", s, n));
    }
    Ok((s.a / n) as usize)
}

/// Polynomials of degree r in x, y, z: the monomial x^a y^b z^c (a + b + c
/// = r) has index t (t + 1)/2 + c with t = b + c.
fn mono_index(b: usize, c: usize) -> usize {
    let t = b + c;
    t * (t + 1) / 2 + c
}

/// The basis of H_r: the monomials (a, b, c) of degree r with c <= 1.
fn harmonic_basis(r: usize) -> Vec<(usize, usize, usize)> {
    let mut v = vec![];
    for c in 0..=1.min(r) {
        for b in 0..=(r - c) {
            v.push((r - c - b, b, c));
        }
    }
    v
}

/// The matrix (row vectors, right action) of P -> P(A X) on H_r =
/// polynomials of degree r modulo x^2 + y^2 + z^2, for the 3 x 3 matrix A
/// (X -> A X), modulo md.
fn harmonic_matrix(r: usize, a: &[[u64; 3]; 3], md: &Modulus) -> Vec<Vec<u64>> {
    let basis = harmonic_basis(r);
    let pos: HashMap<(usize, usize, usize), usize> = basis.iter().enumerate().map(|(i, &x)| (x, i)).collect();
    let mut out = vec![];
    for &(ea, eb, ec) in &basis {
        // the product row0^ea row1^eb row2^ec, degree by degree
        let mut poly = vec![1u64]; // degree 0
        let mut deg = 0usize;
        let factors = std::iter::repeat(0).take(ea).chain(std::iter::repeat(1).take(eb)).chain(std::iter::repeat(2).take(ec));
        for f in factors {
            let l = &a[f];
            let mut next = vec![0u64; (deg + 2) * (deg + 3) / 2];
            for b in 0..=deg {
                for c in 0..=(deg - b) {
                    let x = poly[mono_index(b, c)];
                    if x == 0 {
                        continue;
                    }
                    // times l0 x + l1 y + l2 z
                    let i0 = mono_index(b, c);
                    let i1 = mono_index(b + 1, c);
                    let i2 = mono_index(b, c + 1);
                    next[i0] = md.add(next[i0], md.mul(x, l[0]));
                    next[i1] = md.add(next[i1], md.mul(x, l[1]));
                    next[i2] = md.add(next[i2], md.mul(x, l[2]));
                }
            }
            poly = next;
            deg += 1;
        }
        // reduce z^2 -> -x^2 - y^2
        for c in (2..=r).rev() {
            for b in 0..=(r - c) {
                let x = poly[mono_index(b, c)];
                if x == 0 {
                    continue;
                }
                poly[mono_index(b, c)] = 0;
                let ia = mono_index(b, c - 2); // x^(a+2) y^b z^(c-2)
                let ib = mono_index(b + 2, c - 2); // x^a y^(b+2) z^(c-2)
                poly[ia] = md.sub(poly[ia], x);
                poly[ib] = md.sub(poly[ib], x);
            }
        }
        let mut row = vec![0u64; basis.len()];
        for b in 0..=r {
            for c in 0..=(r - b).min(1) {
                row[pos[&(r - b - c, b, c)]] = poly[mono_index(b, c)];
            }
        }
        out.push(row);
    }
    out
}

/// The Hamilton product of quaternions modulo md (coordinates 1, i, j, k).
fn qmul(x: &[u64; 4], y: &[u64; 4], md: &Modulus) -> [u64; 4] {
    let m = |a: u64, b: u64| md.mul(a, b);
    let (ad, sb) = (|a: u64, b: u64| md.add(a, b), |a: u64, b: u64| md.sub(a, b));
    [
        sb(sb(sb(m(x[0], y[0]), m(x[1], y[1])), m(x[2], y[2])), m(x[3], y[3])),
        sb(ad(ad(m(x[0], y[1]), m(x[1], y[0])), m(x[2], y[3])), m(x[3], y[2])),
        ad(ad(sb(m(x[0], y[2]), m(x[1], y[3])), m(x[2], y[0])), m(x[3], y[1])),
        ad(sb(ad(m(x[0], y[3]), m(x[1], y[2])), m(x[2], y[1])), m(x[3], y[0])),
    ]
}

/// The matrix of X -> u X conj(u) on the trace-zero quaternions (basis i,
/// j, k), u given by its doubled coordinates d (2u = d0 + d1 i + ...) at the
/// place pl.
fn adjoint(d: &Quat, pl: &Place) -> [[u64; 3]; 3] {
    let md = &pl.md;
    let q: [u64; 4] = [0, 1, 2, 3].map(|t| pl.red(d.0[t]));
    let qc = [q[0], md.neg(q[1]), md.neg(q[2]), md.neg(q[3])];
    let quarter = md.inv(4).expect("odd p");
    let mut a = [[0u64; 3]; 3];
    for col in 0..3 {
        let mut e = [0u64; 4];
        e[col + 1] = 1;
        let y = qmul(&qmul(&q, &e, md), &qc, md);
        for row in 0..3 {
            a[row][col] = md.mul(y[row + 1], quarter);
        }
    }
    a
}

/// The matrix (row vectors, right action) of u on L_k at the place pl.
pub fn rep_matrix(w: &Weight, d: &Quat, pl: &Place) -> Vec<Vec<u64>> {
    let md = &pl.md;
    let m = w.m();
    let v = w.v();
    // k2 at the factor where u acts as itself, k1 at its conjugate (see
    // Weight)
    let h1 = harmonic_matrix(m[1] as usize / 2, &adjoint(d, pl), md);
    let h2 = harmonic_matrix(m[0] as usize / 2, &adjoint(d, &pl.conj()), md);
    let n = d.nrd();
    let scale = md.mul(md.pow(pl.red(n), v[1] as u64), md.pow(pl.conj().red(n), v[0] as u64));
    let (n1, n2) = (h1.len(), h2.len());
    let mut out = vec![vec![0u64; n1 * n2]; n1 * n2];
    for i1 in 0..n1 {
        for j1 in 0..n1 {
            let x = md.mul(scale, h1[i1][j1]);
            if x == 0 {
                continue;
            }
            for i2 in 0..n2 {
                for j2 in 0..n2 {
                    out[i1 * n2 + i2][j1 * n2 + j2] = md.mul(x, h2[i2][j2]);
                }
            }
        }
    }
    out
}

/// The space S_k(N) for k != (2, 2) (see the module documentation), on the
/// orbit structure of the weight 2 space.
pub struct WeightSpace {
    pub space: Space,
    pub weight: Weight,
    /// The 120 icosians, sorted, and their multiplication table.
    units: Vec<Quat>,
    mult: Vec<Vec<u8>>,
    /// word[y]: the icosian h with y = h x_j, x_j the representative of the
    /// orbit of y.
    word: Vec<u8>,
    /// The stabilizer of each orbit representative, as icosian indices.
    pub stabilizers: Vec<Vec<u8>>,
    /// dim L^(Gamma_j) for each orbit j (exact).
    pub dims: Vec<usize>,
}

impl WeightSpace {
    pub fn new(level: Ideal, weight: Weight) -> Result<WeightSpace, String> {
        if weight.k == [2, 2] {
            return Err("weight (2, 2) is the weight 2 space (Space), with its Eisenstein series".into());
        }
        let space = Space::from_ideal(level)?;
        let units = icosians();
        let index: HashMap<Quat, u8> = units.iter().enumerate().map(|(i, u)| (*u, i as u8)).collect();
        let mult: Vec<Vec<u8>> = units.iter().map(|a| units.iter().map(|b| index[&a.mul(b).expect("icosians are a group")]).collect()).collect();
        let one = index[&Quat::one()];
        // words, by a search from each representative over the generators
        let gens = crate::icosian_generators();
        let perms: Vec<Vec<Vec<u32>>> = gens.iter().map(|g| local_permutations(&space.p1, &space.splittings, g)).collect::<Result<_, _>>()?;
        let gidx: Vec<u8> = gens.iter().map(|g| index[g]).collect();
        let p1 = &space.p1;
        let n = p1.size as usize;
        let r = p1.locals.len();
        let mut word = vec![u8::MAX; n];
        let mut digits = vec![0u64; r];
        let mut stack = vec![];
        for &rep in &space.orbits.reps {
            word[rep as usize] = one;
            stack.push(rep);
            while let Some(x) = stack.pop() {
                p1.digits(x, &mut digits);
                for (perm, &g) in perms.iter().zip(&gidx) {
                    let y: u64 = (0..r).map(|k| perm[k][digits[k] as usize] as u64 * p1.radix[k]).sum();
                    if word[y as usize] == u8::MAX {
                        word[y as usize] = mult[g as usize][word[x as usize] as usize];
                        stack.push(y);
                    }
                }
            }
        }
        if word.iter().any(|&x| x == u8::MAX) {
            return Err("a point of P^1 was not reached from its orbit representative".into());
        }
        // stabilizers of the representatives
        let unit_perms: Vec<Vec<Vec<u32>>> = units.iter().map(|g| local_permutations(p1, &space.splittings, g)).collect::<Result<_, _>>()?;
        let mut stabilizers = vec![];
        let mut dims = vec![];
        for (j, &rep) in space.orbits.reps.iter().enumerate() {
            p1.digits(rep, &mut digits);
            let st: Vec<u8> = (0..units.len())
                .filter(|&g| (0..r).all(|k| unit_perms[g][k][digits[k] as usize] as u64 == digits[k]))
                .map(|g| g as u8)
                .collect();
            if st.len() * space.orbits.sizes[j] as usize != 120 {
                return Err(format!("orbit {} has size {} but stabilizer of order {}", j, space.orbits.sizes[j], st.len()));
            }
            let dim = if weight.is_odd() { 0 } else { invariant_dimension(&weight, &st.iter().map(|&g| units[g as usize]).collect::<Vec<_>>())? };
            stabilizers.push(st);
            dims.push(dim);
        }
        Ok(WeightSpace { space, weight, units, mult, word, stabilizers, dims })
    }

    /// dim S_k(N).
    pub fn dimension(&self) -> usize {
        self.dims.iter().sum()
    }

    /// The icosian with index i.
    pub fn unit(&self, i: u8) -> Quat {
        self.units[i as usize]
    }

    /// For each orbit j, a basis of the invariants (L/P)^Gamma_j in reduced
    /// echelon form, with its pivot columns; an Err if a dimension differs
    /// from the exact one.
    fn invariant_bases(&self, pl: &Place) -> Result<Vec<(Mat, Vec<usize>)>, String> {
        let md = &pl.md;
        let d = self.weight.rep_dim();
        let mut cache: HashMap<Vec<u8>, (Mat, Vec<usize>)> = HashMap::new();
        let mut out = vec![];
        for (st, &dim) in self.stabilizers.iter().zip(&self.dims) {
            if let Some(b) = cache.get(st) {
                out.push(b.clone());
                continue;
            }
            // the averaging projector (1/#Gamma) sum M(g)
            let mut p = vec![vec![0u64; d]; d];
            for &g in st {
                let m = rep_matrix(&self.weight, &self.units[g as usize], pl);
                for i in 0..d {
                    for k in 0..d {
                        p[i][k] = md.add(p[i][k], m[i][k]);
                    }
                }
            }
            let inv = md.inv(st.len() as u64 % md.n).ok_or("p divides the order of a stabilizer")?;
            for row in p.iter_mut() {
                for x in row.iter_mut() {
                    *x = md.mul(*x, inv);
                }
            }
            let mut a = Mat::from_rows(&p, *md);
            let piv = a.rref();
            if piv.len() != dim {
                return Err(format!("invariants of dimension {} modulo {}, expected {}", piv.len(), md.n, dim));
            }
            let rows: Vec<Vec<u64>> = (0..dim).map(|i| a.row(i).to_vec()).collect();
            let b = (Mat::from_rows(&rows, *md), piv);
            cache.insert(st.clone(), b.clone());
            out.push(b);
        }
        Ok(out)
    }

    /// The matrix of T_p (U_p if p divides N) on S_k(N) at the place pl,
    /// acting on coordinate columns: (f | T)(x_i) in coordinates is row
    /// (i, a) times the coordinates of f. The basis is that of the
    /// invariant_bases, orbit by orbit.
    pub fn hecke_mod(&self, p: &Prime, pl: &Place) -> Result<Mat, String> {
        let md = &pl.md;
        let n = self.dimension();
        let mut t = Mat::zero(n, n, *md);
        if n == 0 {
            return Ok(t);
        }
        let bases = self.invariant_bases(pl)?;
        let mut off = vec![0usize; self.dims.len() + 1];
        for j in 0..self.dims.len() {
            off[j + 1] = off[j] + self.dims[j];
        }
        let d = self.weight.rep_dim();
        let th = theta::theta(p)?;
        let us: Vec<(Quat, Vec<crate::p1::Mat>)> = th
            .iter()
            .map(|a| {
                let u = Quat::from_e(a).conj();
                let e = u.to_e().expect("conj(alpha) lies in R");
                (u, self.space.p1.locals.iter().zip(&self.space.splittings).map(|(l, s)| s.image(&l.ring, &e)).collect())
            })
            .collect();
        let p1 = &self.space.p1;
        let r = p1.locals.len();
        let mut digits = vec![0u64; r];
        let mut image = vec![0u64; r];
        for (i, &rep) in self.space.orbits.reps.iter().enumerate() {
            if self.dims[i] == 0 {
                continue;
            }
            p1.digits(rep, &mut digits);
            // S_ij = sum of M(conj(h) u) over the u with u x_i in orbit j
            let mut sums: HashMap<usize, Vec<Vec<u64>>> = HashMap::new();
            'u: for (u, mats) in &us {
                for k in 0..r {
                    match p1.locals[k].act(&mats[k], digits[k]) {
                        Some(y) => image[k] = y,
                        None => continue 'u,
                    }
                }
                let y = p1.combine(&image) as usize;
                let j = self.space.orbits.orbit[y] as usize;
                if self.dims[j] == 0 {
                    continue;
                }
                let h = self.units[self.word[y] as usize];
                let q = h.conj().mul(u).ok_or("conj(h) u is not in R")?;
                let m = rep_matrix(&self.weight, &q, pl);
                let s = sums.entry(j).or_insert_with(|| vec![vec![0u64; d]; d]);
                for a in 0..d {
                    for b in 0..d {
                        s[a][b] = md.add(s[a][b], m[a][b]);
                    }
                }
            }
            let (bi, pi) = &bases[i];
            for (j, s) in sums {
                let (bj, _) = &bases[j];
                for b in 0..self.dims[j] {
                    // the row B_j[b] S_ij, which must lie in the invariants of x_i
                    let row: Vec<u64> = (0..d).map(|c| (0..d).fold(0u64, |acc, e| md.add(acc, md.mul(bj.get(b, e), s[e][c])))).collect();
                    for c in 0..d {
                        let x = (0..self.dims[i]).fold(0u64, |acc, a| md.add(acc, md.mul(row[pi[a]], bi.get(a, c))));
                        if x != row[c] {
                            return Err("a Hecke image is not invariant under the stabilizer: inconsistent actions".into());
                        }
                    }
                    for a in 0..self.dims[i] {
                        let e = t.get(off[i] + a, off[j] + b);
                        t.set(off[i] + a, off[j] + b, md.add(e, row[pi[a]]));
                    }
                }
            }
        }
        Ok(t)
    }

    /// The product table of the icosians (for tests).
    pub fn mult(&self, a: u8, b: u8) -> u8 {
        self.mult[a as usize][b as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::primes_of_bounded_norm;

    fn place() -> Place {
        place_pairs().next().unwrap().0
    }

    #[test]
    fn representation_is_a_right_action() {
        let pl = place();
        let md = pl.md;
        let us = icosians();
        for w in [Weight::new(2, 4).unwrap(), Weight::new(6, 4).unwrap(), Weight::new(8, 2).unwrap()] {
            for (a, b) in [(3, 17), (40, 99), (5, 5), (119, 64)] {
                let (x, y) = (us[a], us[b]);
                let mx = rep_matrix(&w, &x, &pl);
                let my = rep_matrix(&w, &y, &pl);
                let mxy = rep_matrix(&w, &x.mul(&y).unwrap(), &pl);
                let prod = Mat::from_rows(&mx, md).mul(&Mat::from_rows(&my, md));
                assert_eq!(prod, Mat::from_rows(&mxy, md));
            }
            // dimension of L_k
            assert_eq!(rep_matrix(&w, &us[0], &pl).len(), w.rep_dim());
        }
    }

    #[test]
    fn character_formula_matches_traces() {
        // the trace of M(g) is chi(g), reduced
        let pl = place();
        let w = Weight::new(4, 8).unwrap();
        for g in icosians() {
            let m = rep_matrix(&w, &g, &pl);
            let tr = (0..m.len()).fold(0u64, |a, i| pl.md.add(a, m[i][i]));
            let t = g.trd();
            let chi = sym_character(6, t).mul(sym_character(2, t).conj());
            assert_eq!(tr, pl.red(chi));
        }
    }

    #[test]
    fn dembele_dimensions() {
        // Dembélé 2005, Examples 3.5-3.7: weight (2, 4) at levels (3 + w),
        // (7 + 2w), (30): dimensions 1, 3, 74
        for (g, d) in [(Elt::new(3, 1), 1), (Elt::new(7, 2), 3), (Elt::int(30), 74)] {
            let s = WeightSpace::new(Ideal::principal(g).unwrap(), Weight::new(2, 4).unwrap()).unwrap();
            assert_eq!(s.dimension(), d);
        }
    }

    #[test]
    fn hecke_operators_commute() {
        let pl = place();
        let s = WeightSpace::new(Ideal::principal(Elt::int(6)).unwrap(), Weight::new(2, 4).unwrap()).unwrap();
        let ps = primes_of_bounded_norm(20);
        let ts: Vec<Mat> = ps.iter().map(|p| s.hecke_mod(p, &pl).unwrap()).collect();
        for a in &ts {
            for b in &ts {
                assert_eq!(a.mul(b), b.mul(a));
            }
        }
    }
}
