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

    // the setups: a Stop at the first candidate's check has charged the
    // first orbit's gcds and divisions, and (the single coordinates
    // skipped) one at the first functional's check, those and the
    // candidates' powers, Krylov vectors and ranks up to the first cyclic
    // one's Gram vectors, rebuilt here (pins::Setup)
    for (n, k) in [(23u64, 2usize), (37, 2), (13, 4)] {
        let st = pins::setup(n, k, &factor);
        let (a, b, tried) = st.prefix();
        pins::skip_single_coordinates(true);
        sagebrush_interrupt::clear();
        hooks::reset();
        hooks::trace();
        st.run();
        let x1 = hooks::traced("twisted setup: candidates")[0];
        let y1 = hooks::traced("twisted setup: functionals")[0];
        hooks::reset();
        assert_eq!(y1, x1 + tried, "{}.{}: a check per candidate before the functionals", n, k);
        let (got, stopped) = stopped_at(x1, || st.run());
        assert!(stopped);
        assert_eq!(got, a.0, "{}.{}: stopped at the first candidate", n, k);
        let (got, stopped) = stopped_at(y1, || st.run());
        assert!(stopped);
        assert_eq!(got, b.0, "{}.{}: stopped at the first functional", n, k);
        pins::skip_single_coordinates(false);
    }

    // solve: a Stop at the first scaling check has charged everything but
    // the products (to_rows's copies included), on multi-limb entries
    {
        use sagebrush_arith::cost::bigmul_units;
        use sagebrush_arith::zmat::limbs;
        use sagebrush_modsym::hecke_q::solve_pin;
        let dd = BigInt::from(1) << 130u32;
        let w = vec![vec![dd.clone(), BigInt::from(1)], vec![BigInt::from(3), dd.clone() + 5]];
        let tw = vec![vec![BigInt::from(1), BigInt::from(1)], vec![dd.clone(), BigInt::from(7)]];
        sagebrush_interrupt::clear();
        hooks::reset();
        hooks::trace();
        let before = tallied();
        let h = solve_pin(&w, &tw).unwrap();
        let all = delta(tallied(), before);
        let first = hooks::traced("hecke solve: scaling")[0];
        hooks::reset();
        // the products: one per entry of E (scaled by den / den_e) and C,
        // whose scaled values are h's rows
        let mut products = [0u64; FAMILIES];
        let (got, stopped) = stopped_at(first, || solve_pin(&w, &tw));
        assert!(stopped);
        for f in 0..FAMILIES {
            products[f] = all[f] - got[f];
        }
        // what the Stop saved, rebuilt: E's products (to_rows copied E
        // before the check), then C's copy and products, each product at
        // its entry's and factor's sizes (E and C from zmat directly)
        use sagebrush_arith::zmat::{self, copy_units, ZMat};
        let wm = ZMat::from_rows(w.clone());
        let (e, den_e, piv) = zmat::rref(&wm);
        let rows: Vec<usize> = (0..w.len()).collect();
        let (c, den_c) = zmat::solve(&wm.select(&rows, &piv), &ZMat::from_rows(tw.clone()).select(&rows, &piv)).unwrap();
        let (fe, fc) = (&h.den / &den_e, &h.den / &den_c);
        let mut want = Units::default();
        for r in e.to_rows().into_iter().take(w.len()) {
            for x in &r {
                want.add(&bigmul_units(limbs(x), limbs(&fe)));
            }
        }
        let crows = c.to_rows();
        want.0[Family::Move as usize] += crows.iter().map(|r| copy_units(r)).sum::<u64>();
        for r in &crows {
            for x in r {
                want.add(&bigmul_units(limbs(x), limbs(&fc)));
            }
        }
        assert_eq!(products, want.0, "solve stopped at its first scaling check: all but E's products and C");
        assert!(want.get(Family::MulSchool) > 0 && limbs(&dd) == 3);
    }

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
