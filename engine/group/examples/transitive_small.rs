// Our transitive groups of degree n (from the subgroup lattice of S_n) against
// Magma's database: the multiset of invariants must agree.
use sagebrush_group::lattice::Lattice;
use sagebrush_group::{named, Group, Perm};
use std::time::Instant;
fn inv(g: &Group) -> String {
    format!("{} {} {} {} {} {} {} {}", g.order(), g.is_primitive() as u8, g.is_solvable() as u8, g.is_abelian() as u8,
        g.transitivity(), g.blocks_containing(0).len(), g.derived_subgroup().order(), g.stabilizer(0).order())
}
fn main() {
    let n: usize = std::env::args().nth(1).unwrap().parse().unwrap();
    let t = Instant::now();
    let lat = Lattice::new(&named::symmetric(n), 400_000).unwrap();
    let ours: Vec<Group> = (0..lat.classes.len()).map(|i| lat.group(i)).filter(|g| g.is_transitive()).collect();
    println!("S{}: {} subgroup classes, {} transitive, in {:?}", n, lat.classes.len(), ours.len(), t.elapsed());
    let data = std::fs::read_to_string("tests/data/transitive-2-15.txt").unwrap();
    let mut theirs: Vec<String> = data.lines().filter(|l| l.starts_with(&format!("{} ", n))).map(|l| {
        let f: Vec<&str> = l.split_once(';').unwrap().0.split_whitespace().collect();
        f[2..10].join(" ")
    }).collect();
    let mut mine: Vec<String> = ours.iter().map(inv).collect();
    theirs.sort(); mine.sort();
    println!("invariant multisets agree with Magma: {}", theirs == mine);
    let _ = Perm::identity(1);
}
