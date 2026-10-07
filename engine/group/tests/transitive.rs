//! Every transitive group of degree 2..16, against Magma (tests/data,
//! made by tests/transitive-oracle.m): order, primitivity, solvability,
//! commutativity, multiple transitivity, the number of block systems, and
//! the orders of the derived subgroup and of a point stabilizer.  The data is
//! the oracle's answers for these tests only; nothing in the engine uses it.

use sagebrush_bigint::BigInt;
use sagebrush_group::{Group, Perm};

#[test]
fn transitive_groups_degree_2_to_15() {
    check(include_str!("data/transitive-2-15.txt"), 650);
}

/// the 1954 transitive groups of degree 16 (mostly 2-groups, with many block systems)
#[test]
fn transitive_groups_degree_16() {
    check(include_str!("data/transitive-16.txt"), 1954);
}

fn check(data: &str, count: usize) {
    let mut checked = 0;
    let mut failures = vec![];
    for line in data.lines().filter(|l| !l.trim().is_empty()) {
        let (head, gens) = line.split_once(';').unwrap();
        let f: Vec<&str> = head.split_whitespace().collect();
        let n: usize = f[0].parse().unwrap();
        let gens: Vec<Perm> = gens
            .split_whitespace()
            .map(|g| Perm::from_images(g.trim_end_matches(',').split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap())
            .collect();
        let g = Group::new(n, gens).unwrap();
        let want = |i: usize| f[i].to_string();
        let got = [
            g.order().to_string(),
            (g.is_primitive() as u8).to_string(),
            (g.is_solvable() as u8).to_string(),
            (g.is_abelian() as u8).to_string(),
            g.transitivity().to_string(),
            g.blocks_containing(0).len().to_string(),
            g.derived_subgroup().order().to_string(),
            g.stabilizer(0).order().to_string(),
        ];
        let names = ["order", "primitive", "solvable", "abelian", "transitivity", "block systems", "|G'|", "|G_1|"];
        for (i, name) in names.iter().enumerate() {
            if got[i] != want(i + 2) {
                failures.push(format!("{}T{}: {} is {}, Magma says {}", n, f[1], name, got[i], want(i + 2)));
            }
        }
        assert!(g.is_transitive(), "{}T{} not transitive", n, f[1]);
        assert_eq!(g.order(), f[2].parse::<BigInt>().unwrap());
        checked += 1;
    }
    assert_eq!(checked, count);
    assert!(failures.is_empty(), "{} disagreements:\n{}", failures.len(), failures.join("\n"));
}
