//! The transitive-group tables this crate computed (tables/, by
//! examples/write_tables.rs from src/transitive.rs) against Magma's database
//! (tests/data): for each degree 2..12 the same number of groups, and
//! group nTk has the same eight invariants as Magma's TransitiveGroup(n, k).

use sagebrush_group::{Group, Perm};

fn inv(g: &Group) -> String {
    format!("{} {} {} {} {} {} {} {}", g.order(), g.is_primitive() as u8, g.is_solvable() as u8, g.is_abelian() as u8,
        g.transitivity(), g.blocks_containing(0).len(), g.derived_subgroup().order(), g.stabilizer(0).order())
}

#[test]
fn our_tables_match_magma() {
    let oracle = include_str!("data/transitive-2-15.txt");
    for n in 2..=12usize {
        let table = std::fs::read_to_string(format!("{}/tables/transitive-{}.txt", env!("CARGO_MANIFEST_DIR"), n)).unwrap();
        let ours: Vec<String> = table
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| {
                let f: Vec<&str> = l.split(';').collect();
                let (ord, gens) = (f[0], f[1]);
                let gens: Vec<Perm> = gens.split_whitespace().map(|g| Perm::from_images(g.split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap()).collect();
                let g = Group::new(n, gens).unwrap();
                assert!(g.is_transitive());
                assert_eq!(g.order().to_string(), ord.trim());
                inv(&g)
            })
            .collect();
        let theirs: Vec<String> = oracle.lines().filter(|l| l.starts_with(&format!("{} ", n))).map(|l| {
            let f: Vec<&str> = l.split_once(';').unwrap().0.split_whitespace().collect();
            f[2..10].join(" ")
        }).collect();
        assert_eq!(ours.len(), theirs.len(), "degree {}", n);
        assert_eq!(ours, theirs, "degree {}", n);
    }
}
