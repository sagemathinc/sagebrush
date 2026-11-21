//! What a Stop partway through the twisted traces charges: the work done
//! before it, never the work to come.  Pinned against prefixes rebuilt
//! here: all_pn stopped at its i-th check against all_pn run whole to
//! bound i; prime_polys's batch, charged at its join, against its primes
//! one by one; the CRT, charged after the loop's last check, against
//! crt_units.  A charge moved ahead of its work fails here.  Then a Stop at
//! every check of a whole cusp_hecke_matrix charges part of the whole.  (A
//! file of its own: the Stop hooks are global.  One test, for the same
//! reason.  Native only: a Stop unwinds, and wasm32 aborts on a panic.)

#![cfg(not(target_arch = "wasm32"))]
// (traces::pins: the test-pins feature, on through the dev-dependency)

use sagebrush_arith::cost::{tallied, Family, Units, FAMILIES};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_modsym::general::Character;
use sagebrush_modsym::hecke_q::{cusp_hecke_matrix, sturm_bound, Admit};
use sagebrush_modsym::newspace::newspace_orbits;
use sagebrush_modsym::traces::{hecke_primes, orbit_hecke_traces, pins};

fn factor(f: &[BigInt]) -> Vec<(Vec<BigInt>, u32)> {
    sagebrush_poly::factor(f).1
}

fn delta(after: Units, before: Units) -> [u64; FAMILIES] {
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = after.0[i].wrapping_sub(before.0[i]);
    }
    d
}

/// (the units tallied by f stopped at check `at` since a reset, whether it
/// was stopped)
fn stopped_at<T>(at: u64, f: impl FnOnce() -> T) -> ([u64; FAMILIES], bool) {
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::arm_at(at);
    let before = tallied();
    let r = sagebrush_interrupt::catch(f);
    let d = delta(tallied(), before);
    hooks::reset();
    sagebrush_interrupt::clear();
    (d, r.is_err())
}

/// (the units tallied by f run whole, its checks)
fn whole<T>(f: impl FnOnce() -> T) -> ([u64; FAMILIES], u64) {
    sagebrush_interrupt::clear();
    hooks::reset();
    let before = tallied();
    let _ = f();
    let d = delta(tallied(), before);
    let checks = hooks::total();
    hooks::reset();
    (d, checks)
}

struct Free;
impl Admit for Free {
    fn admit(&mut self, _work: u64, _bytes: u64) -> Result<(), String> {
        Ok(())
    }
}

#[test]
fn a_stop_charges_only_the_work_before_it() {
    // all_pn: its check i comes before P_(i+1), after the work of n <= i
    let fx = pins::fixture(23, 2, 40, &factor);
    for i in [1u64, 2, 7, 20, 38] {
        let want = fx.all_pn(i as usize, false);
        let (got, stopped) = stopped_at(i, || fx.all_pn(40, true));
        assert!(stopped, "all_pn stopped at check {}", i);
        assert_eq!(got, want.0, "all_pn stopped at check {}: the work of n <= {}", i, i);
    }

    // prime_polys: the batch's units at its join, the sum of its primes';
    // a Stop inside it charges none of the batch
    let fx = pins::fixture(37, 2, 2, &factor);
    let primes: Vec<u64> = (2..=60u64).filter(|&p| sagebrush_modsym::exact::is_prime(p)).collect();
    let mut each = Units::default();
    for &p in &primes {
        each.add(&fx.prime_polys(&[p], false));
    }
    let (all, _) = whole(|| fx.prime_polys(&primes, true));
    assert_eq!(all, each.0, "the batch is the sum of its primes");
    assert!(each.get(Family::MulSchool) > 0 && each.get(Family::Gcd) > 0 && each.get(Family::Move) > 0);
    for at in [1, primes.len() as u64 / 2, primes.len() as u64] {
        let (got, stopped) = stopped_at(at, || fx.prime_polys(&primes, true));
        assert!(stopped);
        assert_eq!(got, [0; FAMILIES], "stopped at the batch's check {}: none of it", at);
    }

    // the CRT: stopped at the loop's last check, everything but crt_units
    let (n, k) = (37u64, 2usize);
    let res = newspace_orbits(n, k, &Character::trivial(n), &factor).unwrap();
    let len = sturm_bound(n, k).unwrap() as usize + 1;
    let eps = Character::trivial(n);
    let run = || orbit_hecke_traces(n, k, &eps, &res, len, 2).unwrap();
    let (all, checks) = whole(run);
    let (_, stats) = run();
    let (got, stopped) = stopped_at(checks, run);
    assert!(stopped);
    let ls: Vec<u64> = hecke_primes(1).take(stats.primes as usize).collect();
    let entries: usize = res.dims.iter().map(|&w| 2 * w * len).sum();
    let crt = pins::crt_units(&ls, entries);
    for f in 0..FAMILIES {
        assert_eq!(all[f] - got[f], crt.0[f], "family {}: the CRT's units alone", f);
    }
    // crt_units by hand, two primes and ten values: the inverses (0 + 1
    // products and a powmod each), per value 4 + 2 * 2 ModArith, two
    // one-limb Horner steps and a one-limb copy
    let ls = [1_073_741_827u64, 1_073_741_831];
    let u = pins::crt_units(&ls, 10);
    let pw = |e: u64| 2 * u64::from(64 - e.leading_zeros());
    assert_eq!(u.get(Family::ModArith), 1 + pw(ls[0] - 2) + pw(ls[1] - 2) + 10 * 8);
    assert_eq!(u.get(Family::Move), 10);
    let mut horner = sagebrush_arith::cost::bigmul_units(1, 1);
    horner.add(&sagebrush_arith::cost::bigmul_units(1, 1));
    assert_eq!(u.get(Family::MulSchool), 10 * horner.get(Family::MulSchool));

    // a Stop at every check of a whole op (every phase: the newspaces, the
    // setups, the Heilbronn batches, the CRTs, W, the solve) ends it, and
    // charges part of the whole
    let (n, k, p) = (37u64, 2usize, 3u64);
    let prec = sturm_bound(n, k).unwrap() as usize + 2;
    let op = || cusp_hecke_matrix(n, k, p, prec, false, &factor, &mut Free).unwrap();
    let (all, checks) = whole(op);
    assert!(checks > 10);
    for at in 1..=checks {
        let (got, stopped) = stopped_at(at, op);
        assert!(stopped, "stopped at check {} of {}", at, checks);
        for f in 0..FAMILIES {
            assert!(got[f] <= all[f], "check {}: family {}: {} of {}", at, f, got[f], all[f]);
        }
    }
}
