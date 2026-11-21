//! The trace forms of a few newspaces (labelled_orbits to bound 300:
//! dimensions, traces, charpolys), against a fixture written by the code
//! before traces.rs was split into helpers for the twisted traces: the
//! split must not change a byte.  SAGEBRUSH_WRITE_GOLDEN=1 rewrites it.

use sagebrush_modsym::dirichlet::DirichletGroup;
use sagebrush_modsym::general::Character;
use sagebrush_modsym::newspace::newspace_orbits;
use sagebrush_modsym::traces::labelled_orbits;
use std::fmt::Write;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/trace_forms_golden.txt");

#[test]
fn trace_forms_are_unchanged() {
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_poly::factor(f).1;
    // trivial character at levels with old and new parts, a weight 4 and a
    // weight 6 space, and two nontrivial characters (orders 6 and 2)
    let spaces: Vec<(u64, usize, Character)> = vec![
        (11, 2, Character::trivial(11)),
        (37, 2, Character::trivial(37)),
        (60, 4, Character::trivial(60)),
        (97, 4, Character::trivial(97)),
        (48, 6, Character::trivial(48)),
        (13, 2, DirichletGroup::new(13).character(&[2])),
        (7, 3, DirichletGroup::new(7).character(&[3])),
        (389, 2, Character::trivial(389)),
    ];
    let mut out = String::new();
    for (n, k, eps) in &spaces {
        let res = newspace_orbits(*n, *k, eps, &factor).unwrap();
        let orbits = labelled_orbits(*n, *k, eps, &res, 300).unwrap();
        writeln!(out, "N={} k={} order={} orbits={}", n, k, eps.order, orbits.len()).unwrap();
        for (dim, traces, charpoly) in &orbits {
            writeln!(out, "dim {}", dim).unwrap();
            writeln!(out, "traces {}", traces.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(" ")).unwrap();
            writeln!(out, "charpoly {}", charpoly.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(" ")).unwrap();
        }
    }
    if std::env::var("SAGEBRUSH_WRITE_GOLDEN").is_ok() {
        std::fs::write(FIXTURE, &out).unwrap();
        return;
    }
    let want = std::fs::read_to_string(FIXTURE).unwrap();
    assert!(out == want, "the trace forms changed (rerun with SAGEBRUSH_WRITE_GOLDEN=1 at the commit before to compare)");
}
