// Time each operation over the degree-16 transitive groups.
use sagebrush_group::{Group, Perm};
use std::time::Instant;
fn main() {
    let data = std::fs::read_to_string("tests/data/transitive-16.txt").unwrap();
    let groups: Vec<Group> = data.lines().filter(|l| !l.trim().is_empty()).map(|line| {
        let (_, gens) = line.split_once(';').unwrap();
        let gens: Vec<Perm> = gens.split_whitespace().map(|g| Perm::from_images(g.trim_end_matches(',').split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap()).collect();
        (16, gens)
    }).map(|(n, gens)| { Group::new(n, gens).unwrap() }).collect();
    let t = Instant::now();
    for (n, line) in data.lines().enumerate().take(0) { let _ = (n, line); }
    let gs: Vec<_> = groups.iter().map(|g| g.gens.clone()).collect();
    let t0 = Instant::now(); for g in &gs { let _ = Group::new(16, g.clone()).unwrap(); } println!("chain {:?}", t0.elapsed());
    let t0 = Instant::now(); for g in &groups { let _ = g.is_primitive(); } println!("primitive {:?}", t0.elapsed());
    let t0 = Instant::now(); for g in &groups { let _ = g.is_solvable(); } println!("solvable {:?}", t0.elapsed());
    let t0 = Instant::now(); for g in &groups { let _ = g.transitivity(); } println!("transitivity {:?}", t0.elapsed());
    let t0 = Instant::now(); let mut mx = 0; for g in &groups { mx = mx.max(g.blocks_containing(0).len()); } println!("blocks {:?} (max {})", t0.elapsed(), mx);
    let t0 = Instant::now(); for g in &groups { let _ = g.derived_subgroup(); } println!("derived {:?}", t0.elapsed());
    let t0 = Instant::now(); for g in &groups { let _ = g.stabilizer(0); } println!("stabilizer {:?}", t0.elapsed());
    println!("total {:?}", t.elapsed());
}
