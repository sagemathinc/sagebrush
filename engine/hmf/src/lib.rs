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
//! * `orbits`: the orbits of the units on P^1(O_F/N).
//!
//! Invalid input is an `Err`, never a panic.

pub mod field;
pub mod orbits;
pub mod p1;
pub mod quat;
pub mod residue;
pub mod split;

use field::{Elt, Ideal};
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
}
