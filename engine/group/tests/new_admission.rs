//! Group::new (and every chain the group engine builds: stabilizers,
//! normal closures, the named groups, subgroups) admits its stabilizer
//! chain's certain part with the engine's memory ledger before building
//! it: the known levels (n slots and the base point's element and inverse
//! for each prefix point) and the first base point's orbit's transversal
//! (8 n^2 bytes for a transitive group).  A 200000-cycle's (about 320 GB)
//! is refused at once; a refusal deeper in, as a stabilizer's chain, is
//! the Err the caller gets, never a panic.  The ledger here has no host
//! total: its nominal 1 GiB.

use sagebrush_group::group::{chain_certain_bytes, chain_levels_bytes};
use sagebrush_group::{named, Group, Perm};

fn cycle(n: usize) -> Perm {
    Perm((1..n as u32).chain([0]).collect())
}

#[test]
fn group_new_admits_its_chain() {
    let slot = std::mem::size_of::<Option<(Perm, Perm)>>() as u64;
    let level = |n: u64| (slot + 8) * n;
    // the certain bytes: a transitive group's level and its n - 1 further pairs
    let n = 200_000u64;
    assert_eq!(chain_certain_bytes(n as usize, &[cycle(n as usize)], &[]), level(n) + (n - 1) * 8 * n);
    // a leading identity generator is passed over in choosing the base (mutant A5)
    assert_eq!(chain_certain_bytes(n as usize, &[Perm::identity(n as usize), cycle(n as usize)], &[]), level(n) + (n - 1) * 8 * n);
    // an intransitive one's: the orbit of its first moved point (here 3 of 10)
    let g = Perm::from_cycles(10, &[vec![2, 3, 4], vec![6, 7]]).unwrap();
    assert_eq!(chain_certain_bytes(10, &[g.clone()], &[]), level(10) + 2 * 8 * 10);
    // a prefix: a level for each of its points, the first's orbit (here 6's, 2 points)
    assert_eq!(chain_levels_bytes(10, &[g.clone()], &[6, 0, 9]), 3 * level(10));
    assert_eq!(chain_certain_bytes(10, &[g], &[6, 0, 9]), 3 * level(10) + 8 * 10);
    // the trivial group with no prefix: nothing
    assert_eq!(chain_certain_bytes(10, &[Perm::identity(10)], &[]), 0);
    // refused, promptly, naming what didn't fit (with an identity first too)
    let t = std::time::Instant::now();
    for gens in [vec![cycle(n as usize)], vec![Perm::identity(n as usize), cycle(n as usize)]] {
        let e = Group::new(n as usize, gens).unwrap_err();
        assert!(e.contains("a permutation group's stabilizer chain"), "{}", e);
    }
    assert!(t.elapsed().as_secs() < 10, "refused after {:?}", t.elapsed());
    // groups whose chain fits: built, with their orders (first: the ledger
    // counts what is live, and the group below holds a large later level)
    assert_eq!(Group::new(2000, vec![cycle(2000)]).unwrap().order().to_string(), "2000");
    assert_eq!(named::symmetric(8).unwrap().order().to_string(), "40320");
    // the named groups admit theirs: of degree 12000, 1.15 GB certain, refused
    assert!(named::symmetric(12_000).is_err() && named::cyclic(12_000).is_err());
    // a stabilizer whose chain can't fit is an Err, not a panic (the review's
    // case): <(0 1), (2 3 ... 11999)> is admitted (its first level is
    // (0 1)'s orbit); the stabilizer of 2 needs the 11998-cycle's orbit at
    // its first level, 1.15 GB, past the whole allowance whatever is live
    let m = 12_000usize;
    let big = Group::new(m, vec![Perm::from_cycles(m, &[vec![0, 1]]).unwrap(), Perm::from_cycles(m, &[(2..m as u32).collect()]).unwrap()]).unwrap();
    for e in [big.stabilizer(2).unwrap_err(), big.pointwise_stabilizer(&[2]).unwrap_err(), big.blocks_containing(2).unwrap_err()] {
        assert!(e.contains("a permutation group's stabilizer chain"), "{}", e);
    }
    // and its few generators (random elements' subgroups, each admitted):
    // the refusal is the Err, not a panic (the review's second case)
    assert!(sagebrush_group::embed::few_generators(&big).is_err());
    // the stabilizer of 0 keeps the group's own chain (base 0): no new one
    assert_eq!(big.stabilizer(0).unwrap().order().to_string(), "11998");
    assert_eq!(big.transitivity().unwrap(), 0);
    assert_eq!(Group::trivial(1 << 20).order().to_string(), "1");
}
