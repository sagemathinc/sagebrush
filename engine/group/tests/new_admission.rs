//! Group::new admits its stabilizer chain's first level (n slots and an
//! element and its inverse for each point of the first base point's orbit)
//! with the engine's memory ledger before building it: a 200000-cycle's
//! (about 320 GB) is refused at once, not allocated until the system kills
//! the process; groups whose first level fits are built as before.  The
//! ledger here has no host total: its nominal 1 GiB.

use sagebrush_group::group::first_level_bytes;
use sagebrush_group::{named, Group, Perm};

fn cycle(n: usize) -> Perm {
    Perm((1..n as u32).chain([0]).collect())
}

#[test]
fn group_new_admits_its_first_level() {
    let slot = std::mem::size_of::<Option<(Perm, Perm)>>() as u64;
    // the certain bytes: a transitive group's n slots and n pairs of 4n bytes
    let n = 200_000u64;
    assert_eq!(first_level_bytes(n as usize, &[cycle(n as usize)], &[]), slot * n + n * 8 * n);
    // an intransitive one's: the orbit of its first moved point (here 3 of 10)
    let g = Perm::from_cycles(10, &[vec![2, 3, 4], vec![6, 7]]).unwrap();
    assert_eq!(first_level_bytes(10, &[g.clone()], &[]), slot * 10 + 3 * 8 * 10);
    // with a prefix, its first point's orbit; the trivial group's nothing
    assert_eq!(first_level_bytes(10, &[g], &[6]), slot * 10 + 2 * 8 * 10);
    assert_eq!(first_level_bytes(10, &[Perm::identity(10)], &[]), 0);
    // refused, promptly, naming what didn't fit
    let t = std::time::Instant::now();
    let e = Group::new(n as usize, vec![cycle(n as usize)]).unwrap_err();
    assert!(e.contains("a permutation group's stabilizer chain"), "{}", e);
    assert!(t.elapsed().as_secs() < 10, "refused after {:?}", t.elapsed());
    // groups whose first level fits: built, with their orders
    assert_eq!(Group::new(2000, vec![cycle(2000)]).unwrap().order().to_string(), "2000");
    assert_eq!(named::symmetric(8).order().to_string(), "40320");
    assert_eq!(Group::trivial(1 << 20).order().to_string(), "1");
}
