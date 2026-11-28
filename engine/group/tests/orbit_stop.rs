//! Stop during orbits (the interrupt crate's test hooks): Group::orbits and
//! Group::orbit check Stop once per point reached, so a Stop armed at a
//! check in the middle stops them (the trivial group of degree 200000, its
//! 200000 orbits; a 5000-cycle's one orbit, whose stabilizer chain stays
//! small), and the next call works and gives the orbits.  One test: the hooks and the request flag are process-wide.

use sagebrush_group::{Group, Perm};
use sagebrush_interrupt::{catch, hooks};

/// Run f with a Stop armed at its k-th check: whether it stopped, and the
/// checks it made.
fn stopped_at<T>(k: u64, f: impl FnOnce() -> T) -> (bool, u64) {
    hooks::reset();
    hooks::arm_after(k);
    let r = catch(f);
    let made = hooks::total();
    hooks::reset();
    sagebrush_interrupt::clear();
    (r.is_err(), made)
}

#[test]
fn orbits_stop_midway_and_recover() {
    let (n, m) = (200_000usize, 5_000usize);
    let trivial = Group::trivial(n);
    let cycle = Group::new(m, vec![Perm((1..m as u32).chain([0]).collect())]).unwrap();
    // a Stop midway: the trivial group's orbits (one check a point) at the
    // 100000th check, the m-cycle's orbit and orbits at the 2500th
    assert_eq!(stopped_at(100_000, || trivial.orbits()), (true, 100_000));
    assert_eq!(stopped_at(2_500, || cycle.orbit(0)), (true, 2_500));
    assert_eq!(stopped_at(2_500, || cycle.orbits()), (true, 2_500));
    // then the calls work: n fixed points, and one orbit of all m points
    let o = trivial.orbits();
    assert_eq!((o.len(), o[0].clone(), o[n - 1].clone()), (n, vec![0], vec![n as u32 - 1]));
    assert_eq!(cycle.orbit(7), (0..m as u32).collect::<Vec<_>>());
    assert_eq!(cycle.orbits().len(), 1);
    assert!(cycle.is_transitive() && !trivial.is_transitive());
}
