//! Hilbert modular forms of parallel weight 2 over F = Q(sqrt 5), by the
//! definite method: by Jacquet-Langlands and class number one,
//! M_2(N) is the space of functions on R^x \ P^1(O_F/N), where R is the
//! icosian ring (Dembélé 2005, section 3; Dembélé-Voight 2013, section 4).
//!
//! The structure follows William Stein's PSAGE implementation
//! (psage/modform/hilbert/sqrt5), ported with his permission
//! (PROVENANCE.md); departures from it are noted in each module:
//!
//! * `field`: O_F = Z[w], ideals, primes, factorization;
//! * `residue`: O_F/P^e in one Hermite-normal-form representation;
//! * `p1`: P^1(O_F/N) as a product of local projective lines;
//! * `quat`: the icosian ring and its 120 units;
//! * `split`: local splittings R/P^e R = M_2(O_F/P^e), from idempotents;
//! * `orbits`: the orbits of the units on P^1(O_F/N);
//! * `theta`: the Hecke elements Theta(p), by lattice enumeration;
//! * Hecke operators T_p for p not dividing N (`Space::hecke_matrix`).
//!
//! Invalid input is an `Err`, never a panic.

pub mod field;
mod par;
pub mod orbits;
pub mod p1;
pub mod quat;
pub mod residue;
pub mod split;
pub mod theta;

use field::{Elt, Ideal, Prime};
use orbits::Orbits;
use p1::P1;
use residue::LocalRing;
use split::LocalSplitting;

/// The generators of the icosian group used for the orbit search (PSAGE
/// sqrt5.py, icosian_gens).
fn icosian_generators() -> Vec<quat::Quat> {
    use field::{ONE, W, ZERO};
    use quat::Quat;
    vec![
        Quat([ZERO, Elt::int(2), ZERO, ZERO]),
        Quat([ZERO, ZERO, Elt::int(2), ZERO]),
        Quat([ZERO, ZERO, ZERO, Elt::int(2)]),
        Quat([Elt::int(-1), ONE, ONE, ONE]),
        Quat([ZERO, ONE, W, Elt::new(1, -1)]),
    ]
}

/// The space M_2(N) of Hilbert modular forms of weight (2, 2) and level N
/// over Q(sqrt 5), Eisenstein series included, with the basis of orbits.
pub struct Space {
    pub level: Ideal,
    pub p1: P1,
    pub splittings: Vec<LocalSplitting>,
    pub orbits: Orbits,
}

impl Space {
    /// The space of level (g).
    pub fn new(g: Elt) -> Result<Space, String> {
        Space::from_ideal(Ideal::principal(g)?)
    }
    pub fn from_ideal(level: Ideal) -> Result<Space, String> {
        let rings: Vec<LocalRing> = level.factors.iter().map(|&(p, e)| LocalRing::new(p, e)).collect::<Result<_, _>>()?;
        let splittings: Vec<LocalSplitting> = rings.iter().map(LocalSplitting::new).collect::<Result<_, _>>()?;
        let p1 = P1::new(rings)?;
        let orbits = Orbits::new(&p1, &splittings, &icosian_generators())?;
        Ok(Space { level, p1, splittings, orbits })
    }
    /// dim M_2(N) = the number of orbits (PSAGE's HilbertModularForms
    /// dimension, which includes the Eisenstein series).
    pub fn dimension(&self) -> usize {
        self.orbits.len()
    }
    /// dim S_2(N): F has narrow class number one, so the Eisenstein part of
    /// M_2^B(N) is the constant functions.
    pub fn cusp_dimension(&self) -> usize {
        self.orbits.len() - 1
    }

    /// The matrices, one per factor of the level, by which the elements
    /// conj(alpha), alpha in Theta(p), act; conj(alpha) = pi alpha^-1 acts on
    /// P^1 as alpha^-1 does (PSAGE: hecke_elements(P) = [~a for a in alphas]).
    fn hecke_action(&self, p: &Prime) -> Result<Vec<Vec<p1::Mat>>, String> {
        if self.level.factors.iter().any(|(q, _)| q == p) {
            return Err(format!("T_p for p = ({}) dividing the level is not implemented", p.gen));
        }
        let th = theta::theta(p)?;
        Ok(th
            .iter()
            .map(|a| {
                let b = quat::Quat::from_e(a).conj().to_e().expect("conj(alpha) lies in R");
                self.p1.locals.iter().zip(&self.splittings).map(|(l, s)| s.image(&l.ring, &b)).collect()
            })
            .collect())
    }

    fn hecke_row_with(&self, mats: &[Vec<p1::Mat>], i: usize) -> Vec<(u32, u32)> {
        let r = self.p1.locals.len();
        let mut digits = vec![0u64; r];
        let mut image = vec![0u64; r];
        self.p1.digits(self.orbits.reps[i], &mut digits);
        let mut js: Vec<u32> = Vec::with_capacity(mats.len());
        for m in mats {
            for k in 0..r {
                image[k] = self.p1.locals[k].act(&m[k], digits[k]).expect("conj(alpha) is invertible modulo N");
            }
            js.push(self.orbits.orbit[self.p1.combine(&image) as usize]);
        }
        js.sort_unstable();
        let mut row: Vec<(u32, u32)> = vec![];
        for j in js {
            match row.last_mut() {
                Some((c, n)) if *c == j => *n += 1,
                _ => row.push((j, 1)),
            }
        }
        row
    }

    /// The matrix of T_p on the basis of orbits, acting on the right: row i
    /// is the image of the i-th basis element (PSAGE's hecke_matrix), for a
    /// prime p not dividing N. Its rows sum to N(p) + 1. Rows are computed in
    /// parallel with the `parallel` feature.
    pub fn hecke_matrix(&self, p: &Prime) -> Result<HeckeMatrix, String> {
        let mats = self.hecke_action(p)?;
        let rows = par::map_range(self.dimension(), |i| self.hecke_row_with(&mats, i));
        Ok(HeckeMatrix { dim: self.dimension(), rows })
    }

    /// Row i of the matrix of T_p alone (PSAGE's
    /// hecke_operator_on_basis_element), as (column, entry) pairs.
    pub fn hecke_row(&self, p: &Prime, i: usize) -> Result<Vec<(u32, u32)>, String> {
        if i >= self.dimension() {
            return Err(format!("basis index {} out of range", i));
        }
        let mats = self.hecke_action(p)?;
        Ok(self.hecke_row_with(&mats, i))
    }
}

/// A Hecke matrix with sparse rows: rows[i] lists (column, entry), sorted.
/// Row i has at most N(p) + 1 nonzero entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeckeMatrix {
    pub dim: usize,
    pub rows: Vec<Vec<(u32, u32)>>,
}

impl HeckeMatrix {
    pub fn dense(&self) -> Vec<Vec<i64>> {
        let mut t = vec![vec![0i64; self.dim]; self.dim];
        for (i, row) in self.rows.iter().enumerate() {
            for &(j, n) in row {
                t[i][j as usize] = n as i64;
            }
        }
        t
    }
    pub fn trace(&self) -> i64 {
        self.rows.iter().enumerate().map(|(i, row)| row.iter().find(|&&(j, _)| j as usize == i).map_or(0, |&(_, n)| n as i64)).sum()
    }
}
