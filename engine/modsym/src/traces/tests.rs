//! The twisted traces' rejection sites, their small-ell firings, and the
//! site-3 regression (an orbit polynomial not squarefree mod ell).  (Unit
//! tests: they call the loop's pieces.  Nothing here arms a Stop, which is
//! global: the Stop-prefix pins are in tests/hecke_stop.rs, the units'
//! independence of the threads in tests/hecke_q.rs.)

use super::*;
use crate::newspace::pgcd;

fn factor(f: &[BigInt]) -> Vec<(Vec<BigInt>, u32)> {
    sagebrush_poly::factor(f).1
}

fn space(n: u64, k: usize) -> NewspaceOrbits {
    crate::newspace::newspace_orbits(n, k, &Character::trivial(n), &factor).unwrap()
}

fn sturm_len(n: u64, k: usize) -> usize {
    crate::hecke_q::sturm_bound(n, k).unwrap() as usize + 1
}

/// The orbit polynomials mod ell.
fn polys_mod(res: &NewspaceOrbits, ell: u64) -> Vec<Vec<u64>> {
    res.orbits.iter().map(|u| u.iter().map(|c| {
        let r = c % BigInt::from(ell);
        let r = if r < BigInt::from(0) { r + BigInt::from(ell) } else { r };
        r.try_into().unwrap()
    }).collect()).collect()
}

/// One prime's twisted traces (twisted_mod), as the loop calls it.
fn at(n: u64, k: usize, res: &NewspaceOrbits, ell: u64, len: usize, sink: &mut Local) -> Result<Result<Twisted, Reject>, String> {
    let eps = Character::trivial(n).minimal();
    let qs: Vec<u64> = res.ops.iter().map(|o| o.0).collect();
    let lv = levels(n, k, &eps, &[0], &qs).unwrap();
    let e = eisenstein_exponent(n);
    twisted_mod(n, k, &eps, res, &lv, &polys_mod(res, ell), &res.dims, ell, root_of_unity(e, ell), e, len, 2, None, sink)
}

#[test]
fn the_rejection_sites_are_these() {
    // (a new site needs its reason documented, a firing below and a count)
    let names: Vec<&str> = Reject::ALL.iter().map(|r| r.name()).collect();
    assert_eq!(names, ["dimension", "degree", "separation", "minor"]);
}

#[test]
fn each_site_fires_at_a_small_prime() {
    // a small bad prime first, then the source: set aside, counted, and the
    // result still computed
    // (Separation by both of its exits: 11.4 mod 3, an orbit polynomial
    // not squarefree; 19.6 mod 13, one sharing a root with its cofactor;
    // its other two conditions are internal errors, unreachable once
    // new_poly_mod has passed)
    for (n, k, ell, want) in [(37u64, 2usize, 3u64, [1, 0, 0, 0]), (11, 2, 5, [0, 1, 0, 0]), (11, 4, 3, [0, 0, 1, 0]), (19, 6, 13, [0, 0, 1, 0])] {
        let res = space(n, k);
        let e = eisenstein_exponent(n);
        let primes = std::iter::once(ell).chain(hecke_primes(e));
        let (_, stats) = orbit_hecke_traces_from(n, k, &Character::trivial(n), &res, sturm_len(n, k), 2, primes).unwrap();
        assert_eq!(stats.rejected, want, "N={} k={} ell={}", n, k, ell);
        let (_, clean) = orbit_hecke_traces(n, k, &Character::trivial(n), &res, sturm_len(n, k), 2).unwrap();
        assert_eq!(clean.rejected_total(), 0);
        assert_eq!(stats.primes, clean.primes, "N={} k={}: the same CRT count", n, k);
    }
    // Minor, forced: at length 2 only a_1 and a_2 are available, too few for
    // the 4-dimensional orbit of S_6(19), at every prime; with a finite
    // source the loop runs out, naming the set-aside count by reason
    let res = space(19, 6);
    assert!(res.dims.contains(&4));
    let err = orbit_hecke_traces_from(19, 6, &Character::trivial(19), &res, 2, 2, hecke_primes(1).take(3)).err().unwrap();
    assert!(err.contains("ran out after 3 drawn (3 set aside: dimension 0, degree 0, separation 0, minor 3)"), "{}", err);
}

/// The site-3 regression: an orbit polynomial of S_4(11) is not squarefree
/// mod 3, so T on ker u_j(T) has no cyclic vector, and before the
/// squarefree check the setup's search ran on without end (mod 3 its
/// candidates are the seeded ones, which have no bound).  It is set aside
/// as Separation, promptly: a watchdog fails the test after 20 seconds.
// (native only: the watchdog is a thread, which wasm32 doesn't have)
#[cfg(not(target_family = "wasm"))]
#[test]
fn a_polynomial_not_squarefree_mod_ell_is_set_aside() {
    let res = space(11, 4);
    let ell = 3;
    assert!(polys_mod(&res, ell).iter().any(|u| deg(&pgcd(u, &deriv(u, ell), ell)) != 0), "an orbit polynomial is not squarefree mod 3");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = at(11, 4, &res, ell, sturm_len(11, 4), &mut Local::new());
        let _ = tx.send(matches!(r, Ok(Err(Reject::Separation))));
    });
    let set_aside = rx.recv_timeout(std::time::Duration::from_secs(20)).expect("ended promptly");
    assert!(set_aside, "set aside as Separation");
    // and through the loop, counted in the statistics
    let res = space(11, 4);
    let primes = std::iter::once(ell).chain(hecke_primes(1));
    let (_, stats) = orbit_hecke_traces_from(11, 4, &Character::trivial(11), &res, sturm_len(11, 4), 2, primes).unwrap();
    assert_eq!(stats.rejected, [0, 0, 1, 0]);
}

/// The same on the deterministic route (w (d - 1) + 1 <= ell).  Without
/// the squarefree check, 29.4 mod 41 (T on ker u_j(T) not cyclic) stops at
/// the proven bound with an internal error; 19.6 mod 59 (a Jordan block,
/// cyclic) goes on to traces mod ell from a u_j that isn't squarefree.
#[test]
fn a_polynomial_not_squarefree_on_the_deterministic_route() {
    for (n, k, ell) in [(29u64, 4usize, 41u64), (19, 6, 59)] {
        let res = space(n, k);
        let d = GeneralSpace::new_mod(n, k, &Character::trivial(n), 1, ell, 1).unwrap().dimension();
        let polys = polys_mod(&res, ell);
        let bad: Vec<usize> = (0..polys.len()).filter(|&i| deg(&pgcd(&polys[i], &deriv(&polys[i], ell), ell)) != 0).collect();
        assert!(!bad.is_empty(), "N={} k={} ell={}", n, k, ell);
        for &i in &bad {
            assert!(res.dims[i] * (d - 1) < ell as usize, "the deterministic route");
        }
        let r = at(n, k, &res, ell, sturm_len(n, k), &mut Local::new());
        assert!(matches!(r, Ok(Err(Reject::Separation))), "N={} k={} ell={}: {:?}", n, k, ell, r.map(|x| x.map(|_| ())));
    }
}

/// The seeded candidates (w (d - 1) + 1 > ell) find a setup, counted in
/// the statistics, and the traces are the same as without that prime.
#[test]
fn the_seeded_candidates_give_the_same_traces() {
    for (n, k, ell) in [(23u64, 2usize, 3u64), (13, 4, 3), (67, 2, 7)] {
        let res = space(n, k);
        let eps = Character::trivial(n);
        let primes = std::iter::once(ell).chain(hecke_primes(1));
        let (tr, st) = orbit_hecke_traces_from(n, k, &eps, &res, sturm_len(n, k), 2, primes).unwrap();
        let (tr0, st0) = orbit_hecke_traces(n, k, &eps, &res, sturm_len(n, k), 2).unwrap();
        assert!(st.seeded > 0 && st0.seeded == 0, "N={} k={} ell={}: {:?}", n, k, ell, st);
        assert_eq!(st.rejected_total(), 0);
        for (a, b) in tr.iter().zip(&tr0) {
            assert_eq!((&a.sel, &a.r, &a.s), (&b.sel, &b.r, &b.s), "N={} k={} ell={}", n, k, ell);
        }
    }
}

/// The combined functionals phi_y = sum_t y^t e_t (taken when no single
/// coordinate works, which no golden needs: forced here by skipping the
/// single coordinates) give a setup, counted, and the same traces; also
/// with the seeded candidates (23.2 mod 3).
#[test]
fn the_combined_functionals_give_the_same_traces() {
    for (n, k, small) in [(37u64, 2usize, None), (43, 2, None), (13, 4, None), (23, 2, Some(3u64))] {
        let res = space(n, k);
        let eps = Character::trivial(n);
        let (tr0, _) = orbit_hecke_traces(n, k, &eps, &res, sturm_len(n, k), 2).unwrap();
        SKIP_SINGLE.with(|c| c.set(true));
        let primes = small.into_iter().chain(hecke_primes(1));
        let r = orbit_hecke_traces_from(n, k, &eps, &res, sturm_len(n, k), 2, primes);
        SKIP_SINGLE.with(|c| c.set(false));
        let (tr, st) = r.unwrap();
        assert_eq!(st.combined, st.primes * res.orbits.len() as u64, "N={} k={}: every setup combined: {:?}", n, k, st);
        assert_eq!(small.is_some(), st.seeded > 0);
        for (a, b) in tr.iter().zip(&tr0) {
            assert_eq!((&a.sel, &a.r, &a.s), (&b.sel, &b.r, &b.s), "N={} k={}", n, k);
        }
    }
}

/// The top of the source: the primes below 2^31, the mod-ell kernels'
/// domain (GeneralSpace::new_mod refuses ell >= 2^31), go through the whole
/// setup, and give the same traces as the bottom of the source; the
/// source ends below 2^31.
#[test]
fn the_top_of_the_source_gives_the_same_traces() {
    let top: Vec<u64> = (HECKE_PRIMES_BELOW - 1_000_000..HECKE_PRIMES_BELOW).rev().filter(|&l| is_prime(l)).take(8).collect();
    assert!(top.iter().all(|&l| l < 1 << 31 && l > (1 << 31) - 1_000_000));
    for (n, k) in [(11u64, 2usize), (37, 2), (13, 4), (23, 2)] {
        let res = space(n, k);
        let eps = Character::trivial(n);
        let (tr, st) = orbit_hecke_traces_from(n, k, &eps, &res, sturm_len(n, k), 2, top.iter().copied()).unwrap();
        let (tr0, _) = orbit_hecke_traces(n, k, &eps, &res, sturm_len(n, k), 2).unwrap();
        assert_eq!(st.rejected_total(), 0, "N={} k={}", n, k);
        for (a, b) in tr.iter().zip(&tr0) {
            assert_eq!((&a.sel, &a.r, &a.s), (&b.sel, &b.r, &b.s), "N={} k={}", n, k);
        }
    }
    // a prime past the domain is what new_mod refuses: none is drawn
    assert!(crate::general::GeneralSpace::new_mod(11, 2, &Character::trivial(11), 0, 2147483659, 1).is_err());
    let last = hecke_primes(65536).last().unwrap();
    assert!(last < HECKE_PRIMES_BELOW && HECKE_PRIMES_BELOW == 1 << 31, "{}", last);
}
