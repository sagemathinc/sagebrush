//! Permutation groups (clean-room, MIT OR Apache-2.0): permutations, stabilizer
//! chains by the Schreier-Sims algorithm (randomized, then proven by the
//! deterministic test), orbits, stabilizers, blocks of imprimitivity and
//! block systems, primitivity, multiple transitivity, normal closures,
//! derived series and solvability, and the standard groups.  The foundation
//! for Galois groups of polynomials.
//!
//! References: D. F. Holt, B. Eick and E. A. O'Brien, Handbook of
//! Computational Group Theory (2005); A. Seress, Permutation Group
//! Algorithms (2003); M. D. Atkinson, An algorithm for finding the blocks of
//! a permutation group (1975).

pub mod chain;
pub mod embed;
pub mod group;
pub mod lattice;
pub mod named;
pub mod perm;
pub mod primitive;
pub mod transitive;

pub use group::Group;
pub use perm::{Perm, Rng};

#[cfg(test)]
mod tests {
    use super::*;
    use named::*;
    use sagebrush_bigint::BigInt;

    fn fact(n: u64) -> BigInt {
        (1..=n).fold(BigInt::from(1u32), |a, k| a * BigInt::from(k))
    }

    #[test]
    fn orders() {
        for n in 1..=12u64 {
            assert_eq!(symmetric(n as usize).order(), fact(n), "S{}", n);
            if n >= 2 {
                assert_eq!(alternating(n as usize).order() * BigInt::from(if n >= 2 { 2 } else { 1 }), fact(n).max(BigInt::from(2)), "A{}", n);
            }
        }
        assert_eq!(symmetric(30).order(), fact(30));
        assert_eq!(alternating(23).order() * BigInt::from(2), fact(23));
        assert_eq!(dihedral(7).order(), BigInt::from(14));
        assert_eq!(cyclic(12).order(), BigInt::from(12));
        assert_eq!(agl1(23).unwrap().order(), BigInt::from(23 * 22));
        assert_eq!(pl2(23, false).unwrap().order(), BigInt::from(23 * (23 * 23 - 1) / 2));
        assert_eq!(pl2(13, true).unwrap().order(), BigInt::from(13 * (13 * 13 - 1)));
    }

    #[test]
    fn mathieu_groups() {
        let want = [(11, 7920u64, 4), (12, 95040, 5), (22, 443520, 3), (23, 10200960, 4), (24, 244823040, 5)];
        for (n, order, k) in want {
            let g = mathieu(n).unwrap();
            assert_eq!(g.order(), BigInt::from(order), "M{}", n);
            assert_eq!(g.transitivity(), k, "M{} is {}-transitive", n, k);
            assert!(g.is_primitive());
            // simple: its own derived subgroup
            assert_eq!(g.derived_subgroup().order(), g.order());
        }
    }

    #[test]
    fn membership_and_random() {
        let g = mathieu(12).unwrap();
        let mut rng = Rng::new(7);
        for _ in 0..50 {
            assert!(g.contains(&g.random(&mut rng)));
        }
        // a transposition is not in M12 (it is in S12)
        assert!(!g.contains(&Perm::from_cycles(12, &[vec![0, 1]]).unwrap()));
        let a = alternating(12);
        assert!(a.contains_group(&g));
    }

    #[test]
    fn blocks() {
        // D_6 on a hexagon: blocks {0,3} (opposite), {0,2,4} (triangles)
        let d = dihedral(6);
        assert!(!d.is_primitive());
        let bs = d.blocks_containing(0);
        assert_eq!(bs, vec![vec![0, 3], vec![0, 2, 4]]);
        assert_eq!(d.block_system(&[0, 3]).len(), 3);
        // GRP-F6: an unsorted block is the same set as its sorted images
        assert_eq!(cyclic(4).block_system(&[2, 0]), vec![vec![0, 2], vec![1, 3]]);
        assert!(symmetric(7).is_primitive());
        assert!(dihedral(7).is_primitive());
        assert!(!cyclic(8).is_primitive());
        // C_8 regular: blocks are the subgroups {0,4}, {0,2,4,6}
        assert_eq!(cyclic(8).blocks_containing(0).len(), 2);
    }

    #[test]
    fn solvable() {
        assert!(symmetric(4).is_solvable());
        assert!(!symmetric(5).is_solvable());
        assert!(agl1(23).unwrap().is_solvable());
        assert_eq!(symmetric(4).derived_series().len(), 4); // S4 > A4 > V4 > 1
        assert_eq!(symmetric(6).derived_subgroup().order(), alternating(6).order());
        assert!(cyclic(9).is_abelian());
        assert!(!dihedral(5).is_abelian());
        assert!(symmetric(5).is_normal(&alternating(5)));
    }

    #[test]
    fn stabilizers() {
        let s = symmetric(6);
        assert_eq!(s.stabilizer(3).order(), fact(5));
        assert_eq!(s.pointwise_stabilizer(&[0, 1]).order(), fact(4));
        assert_eq!(s.orbits().len(), 1);
        assert_eq!(s.stabilizer(3).orbits().len(), 2);
    }
}
