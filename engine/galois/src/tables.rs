//! The transitive groups of degree n <= 13 and n = 17, 19, 23 (engine/group/tables): for each
//! nTk its generators, order and name, the number of elements of each cycle
//! type, and its maximal transitive subgroups up to conjugacy.  All of it
//! was computed by sagebrush-group; only the numbering and the names were
//! matched against GAP's library (see the table headers).

use sagebrush_group::Perm;
use std::sync::OnceLock;

pub const MAX_DEGREE: usize = 23;

/// The degrees with tables: 1..13 and the primes 17, 19, 23.
pub fn supported(n: usize) -> bool {
    (1..=13).contains(&n) || [17, 19, 23].contains(&n)
}

pub struct TGroup {
    pub n: usize,
    /// the number k in nTk
    pub k: usize,
    pub order: u128,
    pub name: String,
    pub gens: Vec<Perm>,
    /// (cycle type, number of elements), types as cycle lengths largest first
    pub types: Vec<(Vec<usize>, u128)>,
    /// (j, y): (nTj)^y = y^-1 (nTj) y <= nTk is maximal (Perm::conj), one per class
    pub maximal: Vec<(usize, Perm)>,
}

impl TGroup {
    pub fn label(&self) -> String {
        format!("{}T{}", self.n, self.k)
    }
    pub fn has_type(&self, t: &[usize]) -> bool {
        self.types.iter().any(|(u, _)| u == t)
    }
    /// All elements even?
    pub fn is_even(&self) -> bool {
        self.types.iter().all(|(t, _)| t.iter().filter(|&&l| l % 2 == 0).count() % 2 == 0)
    }
}

fn raw(n: usize) -> (&'static str, &'static str, &'static str) {
    match n {
        2 => (include_str!("../../group/tables/transitive-2.txt"), include_str!("../../group/tables/cycletypes-2.txt"), include_str!("../../group/tables/maximal-2.txt")),
        3 => (include_str!("../../group/tables/transitive-3.txt"), include_str!("../../group/tables/cycletypes-3.txt"), include_str!("../../group/tables/maximal-3.txt")),
        4 => (include_str!("../../group/tables/transitive-4.txt"), include_str!("../../group/tables/cycletypes-4.txt"), include_str!("../../group/tables/maximal-4.txt")),
        5 => (include_str!("../../group/tables/transitive-5.txt"), include_str!("../../group/tables/cycletypes-5.txt"), include_str!("../../group/tables/maximal-5.txt")),
        6 => (include_str!("../../group/tables/transitive-6.txt"), include_str!("../../group/tables/cycletypes-6.txt"), include_str!("../../group/tables/maximal-6.txt")),
        7 => (include_str!("../../group/tables/transitive-7.txt"), include_str!("../../group/tables/cycletypes-7.txt"), include_str!("../../group/tables/maximal-7.txt")),
        8 => (include_str!("../../group/tables/transitive-8.txt"), include_str!("../../group/tables/cycletypes-8.txt"), include_str!("../../group/tables/maximal-8.txt")),
        9 => (include_str!("../../group/tables/transitive-9.txt"), include_str!("../../group/tables/cycletypes-9.txt"), include_str!("../../group/tables/maximal-9.txt")),
        10 => (include_str!("../../group/tables/transitive-10.txt"), include_str!("../../group/tables/cycletypes-10.txt"), include_str!("../../group/tables/maximal-10.txt")),
        11 => (include_str!("../../group/tables/transitive-11.txt"), include_str!("../../group/tables/cycletypes-11.txt"), include_str!("../../group/tables/maximal-11.txt")),
        12 => (include_str!("../../group/tables/transitive-12.txt"), include_str!("../../group/tables/cycletypes-12.txt"), include_str!("../../group/tables/maximal-12.txt")),
        13 => (include_str!("../../group/tables/transitive-13.txt"), include_str!("../../group/tables/cycletypes-13.txt"), include_str!("../../group/tables/maximal-13.txt")),
        17 => (include_str!("../../group/tables/transitive-17.txt"), include_str!("../../group/tables/cycletypes-17.txt"), include_str!("../../group/tables/maximal-17.txt")),
        19 => (include_str!("../../group/tables/transitive-19.txt"), include_str!("../../group/tables/cycletypes-19.txt"), include_str!("../../group/tables/maximal-19.txt")),
        23 => (include_str!("../../group/tables/transitive-23.txt"), include_str!("../../group/tables/cycletypes-23.txt"), include_str!("../../group/tables/maximal-23.txt")),
        _ => ("", "", ""),
    }
}

fn perm(s: &str) -> Perm {
    Perm::from_images(s.split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap()
}

fn body(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty())
}

/// The lines "k ; rest" of a table, by k.
fn keyed(text: &str) -> Vec<&str> {
    body(text).map(|l| l.split_once(';').unwrap().1.trim()).collect()
}

fn parse(n: usize) -> Vec<TGroup> {
    if n == 1 {
        return vec![TGroup { n: 1, k: 1, order: 1, name: "1".into(), gens: vec![], types: vec![(vec![1], 1)], maximal: vec![] }];
    }
    let (tr, ct, mx) = raw(n);
    let cts = keyed(ct);
    let mxs = keyed(mx);
    body(tr)
        .enumerate()
        .map(|(i, l)| {
            let f: Vec<&str> = l.splitn(3, ';').collect();
            let types = cts[i]
                .split_whitespace()
                .map(|w| {
                    let (t, c) = w.split_once(':').unwrap();
                    (t.split('.').map(|x| x.parse().unwrap()).collect(), c.parse().unwrap())
                })
                .collect();
            let maximal = mxs[i]
                .split_whitespace()
                .map(|w| {
                    let (j, y) = w.split_once(':').unwrap();
                    (j.parse().unwrap(), perm(y))
                })
                .collect();
            TGroup {
                n,
                k: i + 1,
                order: f[0].trim().parse().unwrap(),
                name: f.get(2).map_or(String::new(), |s| s.trim().to_string()),
                gens: f[1].split_whitespace().map(perm).collect(),
                types,
                maximal,
            }
        })
        .collect()
}

/// The transitive groups of degree n (1 <= n <= 12), nTk at index k - 1.
pub fn transitive_groups(n: usize) -> &'static [TGroup] {
    static TABLES: [OnceLock<Vec<TGroup>>; MAX_DEGREE + 1] = [const { OnceLock::new() }; MAX_DEGREE + 1];
    assert!(supported(n), "transitive groups are tabulated for degrees 1..13, 17, 19, 23, not {}", n);
    TABLES[n].get_or_init(|| parse(n))
}

/// The seed of the invariant (see the crate) for the maximal subgroup
/// number mi (from 0) of nTk, from tables/invariants-<n>.txt if present.
pub fn invariant_seed(n: usize, k: usize, mi: usize) -> Option<&'static str> {
    static SEEDS: [OnceLock<std::collections::HashMap<(usize, usize), &'static str>>; MAX_DEGREE + 1] = [const { OnceLock::new() }; MAX_DEGREE + 1];
    let text = seeds_raw(n);
    SEEDS[n]
        .get_or_init(|| {
            body(text)
                .filter_map(|l| {
                    let (key, seed) = l.split_once(';')?;
                    let (k, mi) = key.trim().split_once(':')?;
                    Some(((k.parse().ok()?, mi.parse().ok()?), seed.trim()))
                })
                .collect()
        })
        .get(&(k, mi))
        .copied()
}

fn seeds_raw(n: usize) -> &'static str {
    match n {
        2 => include_str!("../tables/invariants-2.txt"),
        3 => include_str!("../tables/invariants-3.txt"),
        4 => include_str!("../tables/invariants-4.txt"),
        5 => include_str!("../tables/invariants-5.txt"),
        6 => include_str!("../tables/invariants-6.txt"),
        7 => include_str!("../tables/invariants-7.txt"),
        8 => include_str!("../tables/invariants-8.txt"),
        9 => include_str!("../tables/invariants-9.txt"),
        10 => include_str!("../tables/invariants-10.txt"),
        11 => include_str!("../tables/invariants-11.txt"),
        12 => include_str!("../tables/invariants-12.txt"),
        13 => include_str!("../tables/invariants-13.txt"),
        17 => include_str!("../tables/invariants-17.txt"),
        19 => include_str!("../tables/invariants-19.txt"),
        23 => include_str!("../tables/invariants-23.txt"),
        _ => "",
    }
}
