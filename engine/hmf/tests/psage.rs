//! Values from PSAGE's own docstrings (psage/modform/hilbert/sqrt5).

use sagebrush_hmf::field::{ideals_of_bounded_norm, Elt};
use sagebrush_hmf::Space;

/// sqrt5_fast.pyx, IcosiansModP1ModN: the number of orbits for every ideal
/// of norm 2..300, listed by norm (tables.ideals_of_bounded_norm). Ideals
/// of equal norm are compared as multisets, since Sage's order within a
/// norm is not reproduced.
const PSAGE_ORBITS_300: [usize; 127] = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 1, 1, 3, 3, 2, 2, 2, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 3, 4, 4, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 6, 5, 5,
    4, 4, 6, 4, 4, 6, 6, 4, 4, 4, 4, 5, 5, 6, 6, 6, 5, 5, 5, 5, 4, 4, 6, 6, 7, 7, 6, 5, 5, 6, 6, 6, 5, 5, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6,
];

#[test]
fn orbit_counts_norm_300() {
    let ideals: Vec<_> = ideals_of_bounded_norm(300).into_iter().filter(|i| !i.is_one()).collect();
    assert_eq!(ideals.len(), PSAGE_ORBITS_300.len());
    let mut k = 0;
    while k < ideals.len() {
        let n = ideals[k].norm();
        let mut end = k;
        while end < ideals.len() && ideals[end].norm() == n {
            end += 1;
        }
        let mut ours: Vec<usize> = ideals[k..end].iter().map(|i| Space::from_ideal(i.clone()).unwrap().dimension()).collect();
        let mut theirs = PSAGE_ORBITS_300[k..end].to_vec();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs, "norm {}", n);
        k = end;
    }
}

/// sqrt5_fast.pyx and hmf.py docstrings.
#[test]
fn docstring_dimensions() {
    // F.prime_above(31) = (5a - 2), 2 orbits; F.prime_above(389) = (18a - 5), 7;
    // F.prime_above(2011) = (41a - 11), 35; F.primes_above(809)[0] = (-26a + 7), 14.
    for (a, b, d) in [(-2, 5, 2), (-5, 18, 7), (-11, 41, 35), (7, -26, 14), (3, 0, 1)] {
        assert_eq!(Space::new(Elt::new(a, b)).unwrap().dimension(), d, "level {} + {}w", a, b);
    }
    // P*Q*R with P | 31, Q | 11, R = (2): "dimension 32, level 2*a-38 (norm 1364)"
    let s = Space::new(Elt::new(-38, 2)).unwrap();
    assert_eq!(s.level.norm(), 1364);
    assert_eq!(s.dimension(), 32);
}
