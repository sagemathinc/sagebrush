// Our transitive groups of degree n against Magma's database (multiset of invariants).
use sagebrush_group::{transitive, Group};
use std::time::Instant;
fn inv(g: &Group) -> String {
    format!("{} {} {} {} {} {} {} {}", g.order(), g.is_primitive() as u8, g.is_solvable() as u8, g.is_abelian() as u8,
        g.transitivity(), g.blocks_containing(0).len(), g.derived_subgroup().order(), g.stabilizer(0).order())
}
fn main() {
    let data = std::fs::read_to_string("tests/data/transitive-2-15.txt").unwrap();
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let t = Instant::now();
        let ours = transitive::transitive_groups(n).unwrap();
        let el = t.elapsed();
        let mut theirs: Vec<String> = data.lines().filter(|l| l.starts_with(&format!("{} ", n))).map(|l| {
            let f: Vec<&str> = l.split_once(';').unwrap().0.split_whitespace().collect();
            f[2..10].join(" ")
        }).collect();
        let mut mine: Vec<String> = ours.iter().map(inv).collect();
        theirs.sort(); mine.sort();
        println!("degree {}: {} transitive groups (Magma: {}) in {:?}; invariants agree: {}", n, mine.len(), theirs.len(), el, theirs == mine);
        if theirs != mine {
            let (mut a, mut b) = (mine.clone(), theirs.clone());
            for x in &theirs { if let Some(i) = a.iter().position(|y| y == x) { a.remove(i); } }
            for x in &mine { if let Some(i) = b.iter().position(|y| y == x) { b.remove(i); } }
            println!("  only ours: {:?}\n  only Magma: {:?}", a, b);
        }
    }
}
