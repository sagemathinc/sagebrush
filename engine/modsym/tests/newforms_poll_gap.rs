//! How long a Stop can go unnoticed while newforms computes trace forms
//! to a large bound (Sage's hecke_matrix(p) on a weight-4 space asks for
//! about p times the Sturm bound): the longest wall time between two Stop
//! checks, and between two polls of the WebAssembly host as the interrupt
//! crate's test hooks simulate them (every check_coarse, every 1024th
//! check), on one thread as in WebAssembly.  One test: the hooks are
//! global.

use sagebrush_interrupt::hooks;
use sagebrush_modsym::general::Character;
use sagebrush_modsym::newspace::newspace_orbits;
use sagebrush_modsym::traces::{labelled_orbits, trace_coefficient_bound};

#[test]
fn newforms_trace_bound_poll_gap() {
    // WebAssembly runs on one thread
    std::env::set_var("SAGEBRUSH_THREADS", "1");
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_poly::factor(f).1;
    let eps = Character::trivial(389);
    let res = newspace_orbits(389, 4, &eps, &factor).unwrap();
    let bound = 6000;
    hooks::reset();
    hooks::trace();
    // (a check on each side: the call's whole time is between traced
    // checks, so a stretch with no check at all still counts)
    sagebrush_interrupt::check_coarse();
    let t = std::time::Instant::now();
    let orbits = labelled_orbits(389, 4, &eps, &res, bound).unwrap();
    let secs = t.elapsed().as_secs_f64();
    sagebrush_interrupt::check_coarse();
    let (gap, poll, total) = (hooks::max_gap_ns(), hooks::max_poll_gap_ns(), hooks::total());
    hooks::reset();
    eprintln!("389.4, {} orbits, traces to {}: {:.2} s; {} checks; longest gap between checks {:.2} ms, between host polls {:.2} ms", orbits.len(), bound, secs, total, gap as f64 / 1e6, poll as f64 / 1e6);
    assert_eq!(orbits.len(), 2);
    assert!(orbits.iter().all(|o| o.1.len() == bound));
    assert!(poll > 0, "no host poll traced");
    // the 250 ms Stop bound
    assert!(gap <= 250_000_000, "{:.2} ms between two Stop checks, past the 250 ms Stop bound", gap as f64 / 1e6);
    assert!(poll <= 250_000_000, "{:.2} ms between two host polls, past the 250 ms Stop bound", poll as f64 / 1e6);
}

#[test]
fn trace_coefficient_bound_poll_gap() {
    // the CRT modulus's bound alone, at a bound hecke_matrix(p) reaches
    // (before its sieve this was O(bound^2) without a Stop check); and
    // its value against the definition at a small bound
    let brute = |k: usize, dim: usize, bound: usize| {
        (1..=bound as u64)
            .map(|n| {
                let s0 = (1..=n).filter(|d| n % d == 0).count() as u64;
                (root(n, k) + 1u32) * s0 * dim as u64 * 2u32
            })
            .max()
            .unwrap()
    };
    for (k, dim, bound) in [(2, 1, 1), (4, 33, 500), (12, 2, 300)] {
        assert_eq!(trace_coefficient_bound(k, dim, bound), brute(k, dim, bound), "{k} {dim} {bound}");
    }
    hooks::reset();
    hooks::trace();
    sagebrush_interrupt::check_coarse();
    let t = std::time::Instant::now();
    let _ = trace_coefficient_bound(4, 33, 100_000);
    let secs = t.elapsed().as_secs_f64();
    sagebrush_interrupt::check_coarse();
    let (gap, poll) = (hooks::max_gap_ns(), hooks::max_poll_gap_ns());
    hooks::reset();
    eprintln!("trace_coefficient_bound(4, 33, 100000): {:.2} s; longest gap between checks {:.2} ms, between host polls {:.2} ms", secs, gap as f64 / 1e6, poll as f64 / 1e6);
    assert!(poll <= 250_000_000, "{:.2} ms between two host polls, past the 250 ms Stop bound", poll as f64 / 1e6);
}

/// floor(sqrt(n^(k-1))).
fn root(n: u64, k: usize) -> sagebrush_bigint::BigUint {
    sagebrush_bigint::BigUint::from(n).pow(k as u32 - 1).sqrt()
}
