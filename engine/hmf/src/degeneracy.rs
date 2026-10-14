//! PSAGE's degeneracy map from level N to N/p (sqrt5_fast.pyx,
//! IcosiansModP1ModN.degeneracy_matrix): reduction P^1(O_F/N) ->
//! P^1(O_F/(N/p)) is equivariant for the units of R, so it maps orbits to
//! orbits. The splitting at level N/p must be the reduction of the one at
//! level N (PSAGE's comment: incompatible choices give wrong answers), so
//! the lower space is built from the reduced splittings.
//!
//! On functions, this is the pullback along x -> x mod N/p (or its
//! transpose, the trace). Its kernel is NOT the p-new subspace in general:
//! when p does not divide N/p, the forms of level N/p occur twice at level
//! N (through two degeneracy maps), and this kernel is the complement of one
//! copy only. PSAGE's new_subspace used it; the newspace is computed in
//! newspace.rs instead.

use crate::field::{Ideal, Prime};
use crate::residue::LocalRing;
use crate::split::LocalSplitting;
use crate::Space;

/// The degeneracy map: the space at level N/p and, for each orbit at level
/// N, the orbit at level N/p that contains its reduction.
pub struct Degeneracy {
    pub lower: Space,
    pub map: Vec<u32>,
}

impl Degeneracy {
    /// PSAGE's degeneracy_matrix: entry (i, map[i]) is 1, all others 0.
    pub fn matrix(&self) -> Vec<Vec<i64>> {
        let mut d = vec![vec![0i64; self.lower.dimension()]; self.map.len()];
        for (i, &j) in self.map.iter().enumerate() {
            d[i][j as usize] = 1;
        }
        d
    }
}

impl Space {
    /// The degeneracy map from this level N to N/p, for a prime p | N.
    pub fn degeneracy(&self, p: &Prime) -> Result<Degeneracy, String> {
        let k = self.level.factors.iter().position(|(q, _)| q == p).ok_or("p must divide the level")?;
        let e = self.level.factors[k].1;
        let mut factors = self.level.factors.clone();
        let mut rings: Vec<LocalRing> = self.p1.locals.iter().map(|l| l.ring.clone()).collect();
        let mut splittings = self.splittings.clone();
        if e == 1 {
            factors.remove(k);
            rings.remove(k);
            splittings.remove(k);
        } else {
            factors[k].1 = e - 1;
            let (upper, lower) = (&rings[k], LocalRing::new(*p, e - 1)?);
            splittings[k] = LocalSplitting { images: splittings[k].images.map(|m| m.map(|x| lower.from_elt(upper.lift(x)))) };
            rings[k] = lower;
        }
        let lower = Space::from_parts(Ideal::from_factors(factors), rings, splittings)?;
        let r = self.p1.locals.len();
        let mut digits = vec![0u64; r];
        let mut low = vec![];
        let map = self
            .orbits
            .reps
            .iter()
            .map(|&x| {
                self.p1.digits(x, &mut digits);
                low.clear();
                for t in 0..r {
                    let l = &self.p1.locals[t];
                    let (u, v) = l.point(digits[t]);
                    if t == k {
                        if e == 1 {
                            continue;
                        }
                        let ll = &lower.p1.locals[k];
                        let (u, v) = (ll.ring.from_elt(l.ring.lift(u)), ll.ring.from_elt(l.ring.lift(v)));
                        low.push(ll.index_of(u, v).expect("reduction keeps points primitive"));
                    } else {
                        low.push(digits[t]);
                    }
                }
                lower.orbits.orbit[lower.p1.combine(&low) as usize]
            })
            .collect();
        Ok(Degeneracy { lower, map })
    }
}
