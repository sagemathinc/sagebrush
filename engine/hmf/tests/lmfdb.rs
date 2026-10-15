//! Dimensions against the LMFDB (field 2.2.5.1, weight (2, 2), every level
//! of norm <= 4999; fixtures/lmfdb.py). The LMFDB lists newforms, so we
//! check dim S_2(N) = sum over M | N of d(N/M) dim S_2^new(M), where d
//! counts ideal divisors (oldforms from level M occur once for each divisor
//! of N/M; Donnelly-Voight 2016, section 2, property (3)).

use sagebrush_hmf::field::{ideals_of_bounded_norm, Hnf, Ideal, Prime};
use sagebrush_hmf::Space;
use std::collections::HashMap;

fn newdims() -> HashMap<Hnf, usize> {
    let text = include_str!("fixtures/lmfdb-2.2.5.1-newdims.txt");
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().map(|x| x.parse().unwrap()).collect();
            (Hnf { a: v[1], b: v[2], c: v[3] }, v[4] as usize)
        })
        .collect()
}

/// The divisors M of N with the number of divisors of N/M.
fn divisors(n: &Ideal) -> Vec<(Ideal, usize)> {
    let mut out = vec![(vec![], 1usize)];
    for &(p, e) in &n.factors {
        let mut next = vec![];
        for (f, d) in &out {
            for k in 0..=e {
                let mut g: Vec<(Prime, u32)> = f.clone();
                if k > 0 {
                    g.push((p, k));
                }
                next.push((g, d * (e - k + 1) as usize));
            }
        }
        out = next;
    }
    out.into_iter().map(|(f, d)| (Ideal::from_factors(f), d)).collect()
}

/// Levels where the LMFDB (queried 2026-10-14) lacks newform orbits: at
/// both primes of norm 2069 it lists only the orbit labelled "c", of
/// dimension 20, not "a" and "b"; Magma 2.18 gives dim S_2 = 34, as we do
/// (magma.rs). Recorded as (HNF, the missing new dimension).
const LMFDB_GAPS: [(Hnf, usize); 2] = [(Hnf { a: 2069, b: 45, c: 1 }, 14), (Hnf { a: 2069, b: 2023, c: 1 }, 14)];

fn check(bound: u64) {
    let mut new = newdims();
    for (h, d) in LMFDB_GAPS {
        *new.get_mut(&h).expect("gap level present") += d;
    }
    let ideals = ideals_of_bounded_norm(bound);
    if bound == 4999 {
        assert_eq!(ideals.len(), new.len(), "the LMFDB lists every level of norm <= 4999");
    }
    let mut bad = vec![];
    for n in &ideals {
        let predicted: usize = divisors(n).iter().map(|(m, d)| d * new[&m.hnf]).sum();
        let ours = Space::from_ideal(n.clone()).unwrap().cusp_dimension();
        if ours != predicted {
            bad.push((n.norm(), n.gen.to_string(), ours, predicted));
        }
    }
    assert!(bad.is_empty(), "{} disagreements, first {:?}", bad.len(), &bad[..bad.len().min(10)]);
}

#[test]
fn dimensions_norm_1000() {
    check(1000);
}

/// Every level of the LMFDB's range (run with --ignored).
#[test]
#[ignore]
fn dimensions_norm_4999() {
    check(4999);
}
