//! tables/maximal-<n>.txt (computed by examples/write_lattice.rs) against GAP
//! (tests/data/gap-maximal*.txt, from tests/gap-maximal.g): for each nTk the
//! same maximal transitive subgroups, by type, with multiplicity (for Alt(n)
//! our list may repeat a class, so only the types are compared); and each
//! listed conjugate really is a subgroup of nTk.

use sagebrush_group::{Group, Perm};
use std::collections::HashMap;

fn perm(s: &str) -> Perm {
    Perm::from_images(s.split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap()
}

fn groups(n: usize) -> Vec<Group> {
    std::fs::read_to_string(format!("{}/tables/transitive-{}.txt", env!("CARGO_MANIFEST_DIR"), n))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| Group::new(n, l.split(';').nth(1).unwrap().split_whitespace().map(perm).collect()).unwrap())
        .collect()
}

#[test]
fn maximal_subgroups_match_gap() {
    let mut gap: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for f in ["gap-maximal.txt", "gap-maximal-sa.txt"] {
        for l in std::fs::read_to_string(format!("{}/tests/data/{}", env!("CARGO_MANIFEST_DIR"), f)).unwrap().lines() {
            let (a, b) = l.split_once(';').unwrap();
            let nk: Vec<usize> = a.split_whitespace().map(|x| x.parse().unwrap()).collect();
            let mut v: Vec<usize> = b.split_whitespace().map(|x| x.parse().unwrap()).collect();
            v.sort();
            gap.insert((nk[0], nk[1]), v);
        }
    }
    let mut checked = 0;
    for n in 2..=13usize {
        let gs = groups(n);
        let m = gs.len();
        let text = std::fs::read_to_string(format!("{}/tables/maximal-{}.txt", env!("CARGO_MANIFEST_DIR"), n)).unwrap();
        for l in text.lines().filter(|l| !l.starts_with('#')) {
            let (a, b) = l.split_once(';').unwrap();
            let k: usize = a.trim().parse().unwrap();
            let mut ours: Vec<usize> = vec![];
            for item in b.split_whitespace() {
                let (j, y) = item.split_once(':').unwrap();
                let j: usize = j.parse().unwrap();
                let y = perm(y);
                assert!(gs[j - 1].gens.iter().all(|h| gs[k - 1].contains(&h.conj(&y))), "{}T{} in {}T{}", n, j, n, k);
                ours.push(j);
            }
            ours.sort();
            if let Some(g) = gap.get(&(n, k)) {
                if n > 2 && k == m - 1 {
                    ours.dedup();
                    let mut g = g.clone();
                    g.dedup();
                    assert_eq!(ours, g, "{}T{}", n, k);
                } else {
                    assert_eq!(&ours, g, "{}T{}", n, k);
                }
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 482);
}
