//! The Smith form's live progress: the remaining-forecast rule, the
//! recorded traces of the routes (stages, done, interior updates, the
//! success-only completion), cleanup after a Stop, the wasm trap's two
//! defenses each alone, observation charging nothing (the ETA on against
//! off: units per family and Stop checks), the size gate's boundaries,
//! re-entry, a full slot table, an invalid forecast, and the policy (cost()
//! publishes no estimate).  (A file of its own: the progress slots and the
//! Stop hooks are global.  Native only: a Stop unwinds, and wasm32 aborts.)

#![cfg(not(target_arch = "wasm32"))]

use num_traits::One;
use sagebrush_arith::cost::{tallied, FAMILIES};
use sagebrush_arith::smith::estimate;
use sagebrush_arith::smith::progress::{self, testing, BEFORE_DONE, THRESHOLD};
use sagebrush_arith::smith::smith_form;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_interrupt::progress as p;
use sagebrush_interrupt::progress::record::{self, Event};

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
}
/// A random entry of `b` bits (any b >= 1), signed.
fn e(r: &mut Rng, b: u32) -> BigInt {
    let mut x = BigInt::from(0);
    let mut left = b;
    while left > 0 {
        let t = left.min(63);
        x = (x << t as usize) + BigInt::from(r.next() >> (64 - t));
        left -= t;
    }
    if r.next() & 1 == 1 {
        -x
    } else {
        x
    }
}
fn plain(rg: &mut Rng, m: usize, n: usize, bits: u32) -> ZMat {
    ZMat::from_rows((0..m).map(|_| (0..n).map(|_| e(rg, bits)).collect()).collect())
}

/// The named inputs, one per route: (name, A, stages in order).
fn inputs() -> Vec<(&'static str, ZMat, Vec<&'static str>)> {
    let mut rg = Rng(11);
    let route1 = plain(&mut rg, 10, 10, 300);
    // route 2: two rows scaled by 6 (nontrivial invariants 2 and 3 at
    // least twice)
    let mut route2 = plain(&mut rg, 10, 10, 300);
    for r in 0..2 {
        for c in 0..10 {
            let v = route2.get(r, c) * BigInt::from(6);
            route2.d[r * 10 + c] = v;
        }
    }
    let mut sing = plain(&mut rg, 10, 10, 300);
    for c in 0..10 {
        let v = sing.get(0, c) + sing.get(1, c);
        sing.d[9 * 10 + c] = v;
    }
    let wide = plain(&mut rg, 8, 11, 300);
    let tall = plain(&mut rg, 11, 8, 300);
    // rank 7 < m, n: both sides (the forecast from sizes takes r = min(m,
    // n); the one after G has the real rank)
    let wide7 = plain(&mut rg, 8, 7, 300).mul(&plain(&mut rg, 7, 11, 4));
    let tall7 = plain(&mut rg, 11, 7, 300).mul(&plain(&mut rg, 7, 8, 4));
    vec![
        ("route 1", route1, vec!["inverse", "attempts"]),
        ("route 2", route2, vec!["inverse", "invariants", "attempts"]),
        ("route 3 singular", sing, vec!["inverse", "profile", "Compress", "core", "combine"]),
        ("route 3 wide", wide, vec!["profile", "Compress", "core", "combine"]),
        ("route 3 tall", tall, vec!["profile", "Compress", "core", "combine"]),
        ("route 3 wide, rank 7", wide7, vec!["profile", "Compress", "core", "combine"]),
        ("route 3 tall, rank 7", tall7, vec!["profile", "Compress", "core", "combine"]),
    ]
}

fn units_now() -> [u64; FAMILIES] {
    tallied().0
}
fn diff(a: &[u64; FAMILIES], b: &[u64; FAMILIES]) -> [u64; FAMILIES] {
    let mut d = [0; FAMILIES];
    for i in 0..FAMILIES {
        d[i] = a[i].wrapping_sub(b[i]);
    }
    d
}

/// Runs smith_form on A with the recorder on and a small threshold: the
/// events of its call, the run's units per family and its Stop checks.
fn traced(a: &ZMat) -> (Vec<Event>, [u64; FAMILIES], u64, sagebrush_arith::smith::SmithForm) {
    sagebrush_interrupt::clear();
    hooks::reset();
    testing::set_threshold(Some(64));
    testing::set_clock_every(Some(1 << 12));
    record::start();
    let t0 = units_now();
    let f = smith_form(a).unwrap();
    let t1 = units_now();
    let ev = record::take();
    let checks = hooks::total();
    testing::set_threshold(None);
    testing::set_clock_every(None);
    hooks::reset();
    (ev, diff(&t1, &t0), checks, f)
}

fn stage_name(i: u32) -> &'static str {
    p::STAGES.get(i as usize).copied().unwrap_or("?")
}

/// The remaining forecast an event shows: R = done (1 - f) / f.
fn r_of(e: &Event) -> f64 {
    let (d, f) = (e.report.done as f64, e.report.fraction.unwrap());
    d * (1.0 - f) / f
}

/// The rule checked on the recorded trace alone (not with the helper): in
/// each phase (from a forecast's flush to the next), with s the units spent
/// since its entry, the events show R + s constant (R = B + F - s, within
/// the budget B), then R - s / 4 constant (R = F + s / 4, the overrun), the
/// switch where s reaches 4B/5.  (An entry at done 0 shows fraction 0 and
/// no R: its phase is checked from its first counted event.)  Returns the
/// number of events checked past each phase's first, within the budget
/// and in an overrun.
fn check_rule(name: &str, ev: &[Event]) -> (usize, usize) {
    let (mut budget, mut overruns) = (0, 0);
    let shown = |e: &Event| e.report.done > 0 && e.report.fraction.is_some_and(|f| f < 1.0);
    let entries: Vec<usize> = (0..ev.len()).filter(|&i| ev[i].written && ev[i].report.fraction.is_some_and(|f| f < 1.0)).collect();
    for (k, &i) in entries.iter().enumerate() {
        let end = entries.get(k + 1).copied().unwrap_or(ev.len());
        let d0 = ev[i].report.done as f64;
        let pts: Vec<(f64, f64)> = ev[i..end].iter().filter(|e| shown(e)).map(|e| (e.report.done as f64 - d0, r_of(e))).collect();
        let Some(&(s1, r1)) = pts.first() else { continue };
        let tol = |s: f64, r: f64| 1e-9 * (d0 + s + r) + 4.0;
        // the budget's events: R + s the same as at the first
        let within = pts.iter().take_while(|&&(s, r)| (r + s - (r1 + s1)).abs() <= tol(s, r)).count();
        let over = &pts[within..];
        if let Some(&(sf, rf)) = over.first() {
            let f = rf - sf / 4.0;
            for &(s, r) in over {
                assert!((r - s / 4.0 - f).abs() <= tol(s, r), "{name}: R - s/4 moved in an overrun ({} vs {f}) at s {s}", r - s / 4.0);
            }
            if within > 0 {
                // the switch at 4B/5, B = (R + s) - F
                let b = r1 + s1 - f;
                assert!(pts[within - 1].0 <= 0.8 * b + tol(b, 0.0), "{name}: the budget's rule past 4B/5");
                assert!(sf + tol(b, 0.0) >= 0.8 * b, "{name}: the overrun before 4B/5 (s {sf}, B {b})");
            }
            overruns += over.len();
        }
        budget += within.saturating_sub(1);
    }
    (budget, overruns)
}

/// The remaining-forecast rule: R = max(B - spent, spent / 4) + future;
/// the crossover at spent = 4B/5, the boundary at B, B = 0, an interior
/// overrun point (D + s) / (D + 5s/4), and the cap below the frames'
/// all-ones word.
#[test]
fn the_remaining_forecast_rule() {
    let f = |done: u64, start: u64, b: u64, fut: u64| progress::fraction(done, start, b, fut).unwrap();
    let (d, b) = (10_000u64, 1000u64);
    // within budget: R = B - spent
    assert!((f(d + 400, d, b, 0) - (d + 400) as f64 / (d + 400 + 600) as f64).abs() < 1e-15);
    // the crossover: at 4B/5 both branches give B/5
    assert!((f(d + 800, d, b, 0) - (d + 800) as f64 / (d + 800 + 200) as f64).abs() < 1e-15);
    // at B, the overrun branch: spent / 4
    assert!((f(d + 1000, d, b, 0) - (d + 1000) as f64 / (d + 1250) as f64).abs() < 1e-15);
    // an interior overrun point: (D + s) / (D + 5s/4)
    let s = 2000u64;
    assert!((f(d + s, d, b, 0) - (d + s) as f64 / (d as f64 + 1.25 * s as f64)).abs() < 1e-15);
    // B = 0: always the overrun branch
    assert!((f(d + 400, d, 0, 0) - (d + 400) as f64 / (d + 500) as f64).abs() < 1e-15);
    // a long overrun of the last phase tends to 4/5 of it
    let big = 1u64 << 50;
    assert!((f(big, 0, b, 0) - 0.8).abs() < 1e-9);
    // nothing done, nothing forecast: 0
    assert_eq!(progress::fraction(0, 0, 0, 0), Some(0.0));
    // the cap: a fraction that would round to the all-ones word is held one
    // step below it, which stays below it after encoding
    assert_eq!(f(u64::MAX, u64::MAX, 1, 0), BEFORE_DONE);
    assert_eq!(f(1 << 60, 1 << 60, 1, 0), BEFORE_DONE);
    let w = p::encode(&p::Slot { in_use: true, fraction: Some(BEFORE_DONE), ..p::Slot::default() });
    assert_eq!(w[p::word::FRACTION], u32::MAX - 1);
    let one = p::encode(&p::Slot { in_use: true, fraction: Some(1.0), ..p::Slot::default() });
    assert_eq!(one[p::word::FRACTION], u32::MAX);
}

/// The traces: on each route, the op's unit, the stages in order,
/// non-decreasing done, an interior update in the inverse and part A, no
/// fraction 1 before the end, and the success flush: fraction 1, done the
/// run's units.  Route 1's and route 2's attempts entries checked against
/// stage 2's own terms (stage 2 less the inverse's model).
#[test]
fn the_traces_of_the_routes() {
    let _l = lock();
    for (name, a, stages) in inputs() {
        let (ev, units, _, _) = traced(&a);
        assert!(!ev.is_empty(), "{name}: a call opened");
        let id = ev[0].call_id;
        assert!(ev.iter().all(|e| e.call_id == id), "{name}: one call");
        // (the first event is begin's own, empty: the unit set after it)
        assert!(ev[1..].iter().all(|e| e.report.unit == p::table_index(p::UNITS, "work units")), "{name}: the unit");
        // stages in order (from the written events)
        let mut seen: Vec<&str> = vec![];
        for e in ev.iter().filter(|e| e.written && e.report.stage != 0) {
            let s = stage_name(e.report.stage);
            if seen.last() != Some(&s) {
                seen.push(s);
            }
        }
        let mut want = stages.clone();
        want.dedup();
        assert_eq!(seen, want, "{name}: the stages");
        // done non-decreasing; no completion before the end
        for w in ev.windows(2) {
            assert!(w[1].report.done >= w[0].report.done, "{name}: done decreased");
        }
        let (last, before) = ev.split_last().unwrap();
        assert!(before.iter().all(|e| e.report.fraction.is_none_or(|f| f <= BEFORE_DONE)), "{name}: fraction 1 before success");
        // the success flush: written, fraction 1, done the run's units
        let total: u64 = units.iter().fold(0u64, |s, x| s.wrapping_add(*x));
        assert!(last.written && last.report.fraction == Some(1.0), "{name}: the success flush");
        assert_eq!(last.report.done, total, "{name}: done at fraction 1 is the run's units");
        let (b, _) = check_rule(name, &ev);
        assert!(b > 0, "{name}: the budget's rule exercised");
        // an interior update in the inverse (and part A on route 2)
        for st in ["inverse", "invariants"].iter().filter(|s| stages.contains(s)) {
            let entry = ev.iter().position(|e| e.written && stage_name(e.report.stage) == *st).unwrap();
            let d0 = ev[entry].report.done;
            assert!(ev[entry + 1..].iter().take_while(|e| stage_name(e.report.stage) == *st).any(|e| e.report.done > d0), "{name}: an interior update in {st}: {:?}", ev.iter().map(|e| (stage_name(e.report.stage), e.report.done, e.written)).collect::<Vec<_>>());
        }
    }
    // route 1's attempts entry: R = stage 2's term past the inverse
    let (_, a, _) = inputs().remove(0);
    let (ev, _, _, _) = traced(&a);
    let (nm, den, det) = zmat::inverse_det(&a).unwrap();
    let s2 = estimate::stage2(&a, &nm, &den, &det, None).unwrap();
    let inv = zmat::inverse_model(&a, sagebrush_arith::zmat::limbs(&den), 2, None);
    let rest: u64 = (0..FAMILIES).map(|i| s2.0[i] - inv.0[i]).sum();
    let at = ev.iter().find(|e| e.written && stage_name(e.report.stage) == "attempts").unwrap();
    let d = at.report.done as f64;
    assert!((at.report.fraction.unwrap() - d / (d + rest as f64)).abs() < 1e-12, "route 1: the attempts' forecast is stage 2's");
}

/// beyond_forecast: set once done passes the first total forecast, and
/// sticky across a re-forecast; a never-crossed control.
#[test]
fn beyond_the_forecast_is_sticky() {
    let _l = lock();
    let (_, a, _) = inputs().remove(1);
    // forecasts at a hundredth: the first is passed early, and the later
    // phases' (larger) forecasts don't clear the flag
    testing::scale_forecast(0.01);
    let (ev, _, _, _) = traced(&a);
    testing::scale_forecast(1.0);
    assert!(check_rule("forecasts at a hundredth", &ev).1 > 0, "the overrun rule exercised");
    let first = ev.iter().position(|e| e.report.beyond_forecast).expect("crossed");
    assert!(ev[first..].iter().all(|e| e.report.beyond_forecast), "sticky");
    assert!(ev[first..].iter().any(|e| e.written && e.report.stage != ev[first].report.stage), "across a re-forecast");
    // never crossed at a hundred times
    testing::scale_forecast(100.0);
    let (ev, _, _, _) = traced(&a);
    testing::scale_forecast(1.0);
    assert!(ev.iter().all(|e| !e.report.beyond_forecast), "never crossed");
}

/// A Stop at check `at` on A, with an outer call running: the slot is
/// free, the state clear, no stale parent, no completion claimed, no check
/// counted in the drop, the outer call survives.  The stage the Stop came
/// in (its position in `stages`).
fn stop_at(name: &str, a: &ZMat, at: u64, stages: &[&str]) -> usize {
    let outer = p::begin(p::name_index("python"));
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::arm_at(at);
    testing::set_threshold(Some(64));
    record::start();
    let r = sagebrush_interrupt::catch(|| smith_form(a));
    let ev = record::take();
    testing::set_threshold(None);
    assert!(r.is_err(), "{name}: stopped at check {at}");
    assert_eq!(hooks::total(), at, "{name}: no check after the Stop's (the drop polls nothing)");
    sagebrush_interrupt::clear();
    hooks::reset();
    assert!(!testing::state_set(), "{name}: the state cleared");
    assert!(ev.iter().all(|e| e.report.fraction != Some(1.0)), "{name}: no completion claimed at check {at}");
    let slots = p::snapshot();
    assert!(slots.iter().all(|s| s.op != p::table_index(p::OPS, "smith form")), "{name}: the slot released");
    assert!(slots.iter().any(|s| s.call_id == outer.id()), "{name}: the outer call survives");
    let next = p::begin(p::name_index("python"));
    let parent = p::snapshot().iter().find(|s| s.call_id == next.id()).map(|s| s.parent_id);
    assert_eq!(parent, Some(outer.id()), "{name}: no stale parent");
    drop(next);
    drop(outer);
    let last = ev.iter().rev().find(|e| e.written && e.report.stage != 0).map_or("", |e| stage_name(e.report.stage));
    stages.iter().position(|s| *s == last).unwrap_or(0)
}

/// A Stop in each phase of each route (the inverse, part A, the attempts,
/// route 3's profile, Compress, core and combine), each found by bisecting
/// the run's checks for the first Stop that lands in it: cleanup as in
/// [`stop_at`] at every probe.
#[test]
fn a_stop_in_each_phase_releases_without_claiming_completion() {
    let _l = lock();
    for (name, a, stages) in inputs() {
        let (_, _, checks, _) = traced(&a);
        for (want, st) in stages.iter().enumerate() {
            // the first check whose Stop lands at or past `st`
            let (mut lo, mut hi) = (1u64, checks);
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                if stop_at(name, &a, mid, &stages) >= want {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            assert_eq!(stop_at(name, &a, lo, &stages), want, "{name}: a Stop in {st} (check {lo} of {checks})");
        }
    }
}

/// The wasm trap's defenses, each alone: a state left behind (a trap runs
/// no destructors) is dropped by a new run generation, and by the explicit
/// reset; with neither, the next run sees a nested call and reports
/// nothing (the hazard both defenses prevent).
#[test]
fn a_trapped_runs_state_is_dropped() {
    let _l = lock();
    let (_, a, _) = inputs().remove(0);
    testing::set_threshold(Some(64));
    // (A) the generation alone
    assert!(testing::open_and_leak(&a));
    p::reset_frames();
    let (ev, ..) = traced(&a);
    assert!(!ev.is_empty() && ev.last().unwrap().report.fraction == Some(1.0), "a new generation: the next run reports");
    assert!(!testing::state_set());
    // (B) the reset alone (same generation)
    testing::set_threshold(Some(64));
    assert!(testing::open_and_leak(&a));
    progress::reset();
    let (ev, ..) = traced(&a);
    assert!(!ev.is_empty() && ev.last().unwrap().report.fraction == Some(1.0), "the reset: the next run reports");
    // neither: the hazard
    testing::set_threshold(Some(64));
    assert!(testing::open_and_leak(&a));
    let (ev, ..) = traced(&a);
    assert!(ev.iter().all(|e| e.report.fraction != Some(1.0)), "a stale state of this generation takes the next run's completion");
    progress::reset();
    assert!(!testing::state_set());
}

/// Observing charges nothing: the ETA on against off, per family and in
/// Stop checks, on every route (word-size and multi-limb entries); same
/// results.
#[test]
fn the_eta_on_and_off_charge_the_same() {
    let _l = lock();
    let mut rg = Rng(5);
    let mut all = inputs();
    // a multi-limb input (63 limbs an entry; its products stay below the
    // transforms, which need 4096-word operands: a Smith form reaching them
    // runs for minutes, measured once instead, in the change's notes)
    all.push(("route 1, 4000-bit", plain(&mut rg, 6, 6, 4000), vec![]));
    for (name, a, _) in all {
        // (a first run fills the caches a run may build, such as the
        // transforms' tables, whose building polls: both compared runs find
        // them filled)
        let _ = smith_form(&a).unwrap();
        let (ev, on, c_on, f_on) = traced(&a);
        assert!(!ev.is_empty(), "{name}: on");
        testing::set_enabled(false);
        let (ev_off, off, c_off, f_off) = traced(&a);
        testing::set_enabled(true);
        assert!(ev_off.is_empty(), "{name}: off");
        assert_eq!(on, off, "{name}: units per family, ETA on vs off");
        assert_eq!(c_on, c_off, "{name}: Stop checks, ETA on vs off");
        assert_eq!((f_on.d.d, f_on.u.d, f_on.v.d), (f_off.d.d, f_off.u.d, f_off.v.d), "{name}: the result");
    }
}

/// The unmetered scope restores the counters (arith's and bigint's) on a
/// normal exit and on an unwinding; in debug builds a poll inside it is
/// refused, a transform product's included (every one polls: so nothing
/// the scope may run moves bigint's counters, and they are moved here
/// through its restore hook, as an unpolled tally would).
#[test]
fn the_unmetered_scope_restores_and_polls_nothing() {
    let _l = lock();
    let t0 = units_now();
    let n0 = sagebrush_bigint::ntt::units();
    {
        let _u = sagebrush_arith::cost::unmetered();
        sagebrush_arith::cost::tally(sagebrush_arith::cost::Family::Move, 1234);
        sagebrush_bigint::ntt::restore_units([n0[0] + 5, n0[1] + 7, n0[2] + 11]);
        assert_ne!(units_now(), t0);
    }
    assert_eq!(units_now(), t0, "restored on exit");
    assert_eq!(sagebrush_bigint::ntt::units(), n0, "bigint's counters restored on exit");
    let r = std::panic::catch_unwind(|| {
        let _u = sagebrush_arith::cost::unmetered();
        sagebrush_arith::cost::tally(sagebrush_arith::cost::Family::Move, 99);
        sagebrush_bigint::ntt::restore_units([n0[0] + 1, n0[1], n0[2]]);
        panic!("unwind");
    });
    assert!(r.is_err());
    assert_eq!(units_now(), t0, "restored on unwind");
    if cfg!(debug_assertions) {
        let r = std::panic::catch_unwind(|| {
            let _u = sagebrush_arith::cost::unmetered();
            sagebrush_interrupt::check();
        });
        assert!(r.is_err(), "a poll inside the scope is refused in debug builds");
        let mut rg = Rng(3);
        let (x, y) = (e(&mut rg, 400_000), e(&mut rg, 400_000));
        let r = std::panic::catch_unwind(|| {
            let _u = sagebrush_arith::cost::unmetered();
            let _ = &x * &y;
        });
        assert!(r.is_err(), "a transform product inside the scope is refused in debug builds");
        sagebrush_interrupt::clear();
    }
}

/// The size gate at THRESHOLD - 1, THRESHOLD and THRESHOLD + 1 limb-entries
/// (the production threshold), and re-entry: a running call's thread opens
/// no second one.
#[test]
fn the_gate_and_re_entry() {
    let _l = lock();
    let row = |n: usize| ZMat::from_rows(vec![(0..n).map(|_| BigInt::one()).collect()]);
    let t = THRESHOLD as usize;
    assert!(!testing::qualifies(&row(t - 1)));
    assert!(testing::qualifies(&row(t)));
    assert!(testing::qualifies(&row(t + 1)));
    // re-entry: with a call running (of this generation), a nested run
    // opens none
    let (_, a, _) = inputs().remove(0);
    testing::set_threshold(Some(64));
    assert!(testing::open_and_leak(&a));
    assert!(!testing::open_and_leak(&a), "no second call");
    progress::reset();
    testing::set_threshold(None);
}

/// A full slot table: the run goes on untracked (same result and units)
/// and its events are still produced; an invalid forecast (NaN) gives no
/// fraction and changes nothing.
#[test]
fn full_slots_and_an_invalid_forecast() {
    let _l = lock();
    let (_, a, _) = inputs().remove(1);
    let (_, units, checks, f) = traced(&a);
    let held: Vec<p::Call> = (0..p::SLOTS).map(|_| p::begin(p::name_index("python"))).collect();
    let (ev, u2, c2, f2) = traced(&a);
    drop(held);
    assert!(!ev.is_empty(), "events while untracked");
    assert_eq!((&units, checks, &f.d.d), (&u2, c2, &f2.d.d), "untracked: the same run");
    testing::force_nan(true);
    let (ev, u3, c3, f3) = traced(&a);
    testing::force_nan(false);
    let (_, before) = ev.split_last().unwrap();
    assert!(before.iter().all(|e| e.report.fraction.is_none()), "no fraction from an invalid forecast");
    assert_eq!((&units, checks, &f.d.d), (&u3, c3, &f3.d.d), "an invalid forecast: the same run");
}

/// The policy: the estimate drives the ETA only; cost() still publishes
/// no work estimate.
#[test]
fn cost_publishes_no_estimate() {
    // (cost() polls: the Stop-check counter is global)
    let _l = lock();
    let (_, a, _) = inputs().remove(0);
    assert_eq!(estimate::cost(&a).work_estimate, None);
}

/// The host test's input (test/progress.test.ts builds the same):
/// diag(1, 2, 3, 1, 2, 3, ...) of order 256, at the production threshold
/// (2^16 one-limb entries) and refresh interval.
fn host_input() -> ZMat {
    let n = 256;
    ZMat::from_rows((0..n).map(|i| (0..n).map(|j| BigInt::from(if i == j { 1 + (i % 3) as i64 } else { 0 })).collect()).collect())
}

/// The producer's trace of the host test's run, as the frames carry it
/// (stage, done, the fraction's u32 word, beyond_forecast), every publish
/// and flush in order: pinned in tests/smith_progress_trace.txt, which the
/// wasm test reads (its copies must be an ordered subsequence; done is the
/// same on every target).  SMITH_PROGRESS_BLESS=1 rewrites the file.
#[test]
fn the_host_tests_trace() {
    let _l = lock();
    let a = host_input();
    assert!(testing::qualifies(&a));
    sagebrush_interrupt::clear();
    record::start();
    smith_form(&a).unwrap();
    let ev = record::take();
    let mut out = String::from("# stage done fraction-word beyond (engine/arith/tests/smith_progress.rs, the_host_tests_trace)\n");
    for e in &ev[1..] {
        let w = p::encode(&p::Slot { in_use: true, fraction: e.report.fraction, ..p::Slot::default() });
        let f = if e.report.fraction.is_some() { w[p::word::FRACTION].to_string() } else { "-".into() };
        let st = match stage_name(e.report.stage) {
            "" => "-",
            x => x,
        };
        out += &format!("{st} {} {f} {}\n", e.report.done, e.report.beyond_forecast as u8);
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/smith_progress_trace.txt");
    if std::env::var("SMITH_PROGRESS_BLESS").is_ok() {
        std::fs::write(path, &out).unwrap();
    }
    let pinned = std::fs::read_to_string(path).unwrap();
    assert!(pinned == out, "the host test's trace moved (SMITH_PROGRESS_BLESS=1 rewrites it)");
}

/// The bar's inputs (smith_route3_tail's the_speed_rows: Rng(7), X Y with
/// 16-bit X and 4-bit Y): the bar (48 x 48 rank 47, route 3) and the
/// reference draw (48 x 48 rank 48, route 2).
fn bar_inputs() -> (ZMat, ZMat) {
    fn small(r: &mut Rng, b: u32) -> BigInt {
        let x = BigInt::from(r.next() >> (64 - b));
        if r.next() & 1 == 1 {
            -x
        } else {
            x
        }
    }
    fn product(rg: &mut Rng, m: usize, n: usize, rank: usize, bits: u32) -> ZMat {
        let x = ZMat::from_rows((0..m).map(|_| (0..rank).map(|_| small(rg, bits)).collect()).collect());
        let y = ZMat::from_rows((0..rank).map(|_| (0..n).map(|_| small(rg, 4)).collect()).collect());
        x.mul(&y)
    }
    let mut rg = Rng(7);
    let bar = product(&mut rg, 48, 48, 47, 16);
    let mut rg = Rng(7);
    for &(m, n, rank) in &[(48, 48, 47), (32, 32, 31), (24, 24, 12), (8, 1000, 8), (16, 18, 16)] {
        let _ = product(&mut rg, m, n, rank, 16);
    }
    (bar, product(&mut rg, 48, 48, 48, 16))
}

/// The overhead row: route 3's bar and a route 2 input (below the
/// production threshold: the gate alone; then with the threshold lowered,
/// the whole machinery), and the host test's input (above it): units
/// identical with the ETA on and off, wall times printed (the fastest of
/// three runs each).
#[test]
fn the_overhead_row() {
    let _l = lock();
    let (bar, reference) = bar_inputs();
    let host = host_input();
    let time = |a: &ZMat, on: bool, threshold: Option<u64>| {
        testing::set_enabled(on);
        testing::set_threshold(threshold);
        let mut best = f64::INFINITY;
        let mut units = [0; FAMILIES];
        for _ in 0..3 {
            sagebrush_interrupt::clear();
            let t0 = units_now();
            let t = std::time::Instant::now();
            smith_form(a).unwrap();
            best = best.min(t.elapsed().as_secs_f64());
            units = diff(&units_now(), &t0);
        }
        testing::set_enabled(true);
        testing::set_threshold(None);
        (best, units)
    };
    for (name, a, forced) in [("route 3, the bar", &bar, true), ("route 2, the reference draw", &reference, true), ("route 2, the host input", &host, false)] {
        let threshold = forced.then_some(64);
        let (t_off, u_off) = time(a, false, threshold);
        let (t_on, u_on) = time(a, true, threshold);
        assert_eq!(u_on, u_off, "{name}: units, ETA on vs off");
        let total: u64 = u_on.iter().sum();
        let gate = if forced {
            let (t_gate, u_gate) = time(a, true, None);
            assert_eq!(u_gate, u_off, "{name}: units, the gate alone");
            format!(", the gate alone (production threshold) {:.4} s", t_gate)
        } else {
            String::new()
        };
        println!("overhead: {name}: {total} units; ETA off {t_off:.4} s, on {t_on:.4} s ({:+.1}%){gate}", 100.0 * (t_on / t_off - 1.0));
    }
}

/// Route 3's stages with their indices: both sides' Compress (1, then 2)
/// on rank-deficient wide and tall input, every term name in the phase
/// order; and a failed certificate's retry, back to the profile.
#[test]
fn route3_shows_each_side_and_a_retry() {
    let _l = lock();
    let staged = |ev: &[Event]| {
        let mut v: Vec<(&str, u64)> = vec![];
        for e in ev.iter().filter(|e| e.written && e.report.stage != 0) {
            let x = (stage_name(e.report.stage), e.report.stage_index);
            if v.last() != Some(&x) {
                v.push(x);
            }
        }
        v
    };
    for (name, a, _) in inputs().into_iter().filter(|x| x.0.ends_with("rank 7")) {
        let (ev, ..) = traced(&a);
        assert_eq!(staged(&ev), [("profile", 0), ("Compress", 1), ("Compress", 2), ("core", 3), ("combine", 4)], "{name}");
        // (the model's term names, before and after G, all in the order)
        let (rows, cols) = estimate::norm_bits_from_sizes(&a);
        for (t, _) in estimate::stage1_route3_terms_sized(a.rows, a.cols, 1, &rows, &cols, 0, &estimate::FITTED) {
            assert!(t == "failed pass" || progress::ROUTE3_ORDER.contains(&t.as_str()), "{name}: {t} not in the order");
        }
    }
    // [[1, 0, 0], [0, p, 0]], p the profile's first prime: rank 1 modulo p,
    // so the certificate fails, and the next prime's profile has rank 2
    let p = sagebrush_bigint::nmod::Primes::new().next().unwrap();
    let a = ZMat::from_rows(vec![
        vec![BigInt::from(1), BigInt::from(0), BigInt::from(0)],
        vec![BigInt::from(0), BigInt::from(p), BigInt::from(0)],
    ]);
    sagebrush_interrupt::clear();
    testing::set_threshold(Some(1));
    testing::set_clock_every(Some(1));
    record::start();
    let f = smith_form(&a).unwrap();
    let ev = record::take();
    testing::set_threshold(None);
    testing::set_clock_every(None);
    assert_eq!(f.d.get(1, 1), &BigInt::from(p));
    let st: Vec<&str> = staged(&ev).iter().map(|x| x.0).collect();
    assert_eq!(st, ["profile", "Compress", "profile", "Compress", "core", "combine"], "the retry");
    assert_eq!(ev.last().unwrap().report.fraction, Some(1.0));
    for w in ev.windows(2) {
        assert!(w[1].report.done >= w[0].report.done);
    }
}

/// Stage 2's named route 3 terms for A, from the existing model and the
/// inputs the run computes (as smith_route3_model rebuilds them): the
/// first side's profile, B_J's inverse, Q and G.  Also the first side's
/// prefix ("col: " or "left: ").
fn stage2_terms(a: &ZMat) -> (Vec<(String, u64)>, &'static str) {
    use sagebrush_arith::nmod::{Modulus, Primes};
    let n = a.cols;
    let p = Primes::new().next().unwrap();
    let (js, is, _) = a.reduce(&Modulus::new(p)).rref_rows();
    let r = is.len();
    let first = if r < n { ZMat::from_rows(is.iter().map(|&i| (0..n).map(|j| a.get(i, j).clone()).collect()).collect()) } else { a.transpose() };
    let fj = if r < n { js.clone() } else { is.clone() };
    let bj = ZMat::from_rows((0..r).map(|i| fj.iter().map(|&j| first.get(i, j).clone()).collect()).collect());
    let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
    let jp: Vec<usize> = (0..first.cols).filter(|x| !fj.contains(x)).collect();
    let q = nm.mul(&ZMat::from_rows((0..r).map(|i| jp.iter().map(|&j| first.get(i, j).clone()).collect()).collect()));
    let g = sagebrush_arith::smith::route3::hnf_modulus(&q, &delta, &det, &mut sagebrush_arith::cost::Local::new());
    let terms = estimate::stage2_route3_terms(a, &is, &js, &nm, &delta, &det, &g, &estimate::FITTED);
    (terms.into_iter().map(|(k, u)| (k, u.0.iter().sum())).collect(), if r < n { "col: " } else { "left: " })
}

/// R checked against the existing named model at route 3's re-forecasts:
/// after the first side's G, R is stage 2's terms for the phases after G;
/// at the core's (from T's own stage 2), R's future part is stage 2's
/// combine, and R itself within a factor of the model's core and combine
/// (the model prices T's attempts from sizes before T exists).
#[test]
fn route3_reforecasts_against_the_named_model() {
    let _l = lock();
    for (name, a, _) in inputs().into_iter().filter(|x| x.0.starts_with("route 3")) {
        let _ = testing::reforecasts();
        let (ev, ..) = traced(&a);
        let log = testing::reforecasts();
        let (terms, side) = stage2_terms(&a);
        let order = progress::ROUTE3_ORDER;
        let pos = |n: &str| order.iter().position(|o| *o == n);
        let r_at = |what: &str| {
            let d = log.iter().find(|x| x.0 == what).unwrap_or_else(|| panic!("{name}: no {what} re-forecast")).1;
            r_of(ev.iter().rev().find(|e| e.written && e.report.done == d).unwrap())
        };
        // after G: the terms after the first side's G
        let g = pos(&format!("{side}G")).unwrap();
        let after: u64 = terms.iter().filter(|(k, _)| pos(k).is_some_and(|p| p > g)).map(|x| x.1).sum();
        let rg = r_at("G");
        // the core's: R = the core's budget (at its start) + combine
        let comb: u64 = terms.iter().filter(|(k, _)| k == "combine").map(|x| x.1).sum();
        let core: u64 = terms.iter().filter(|(k, _)| k == "core").map(|x| x.1).sum();
        let rc = r_at("core");
        assert!((rg - after as f64).abs() <= 1e-9 * after as f64 + 2.0, "{name}: R after G {rg} against the model's {after}");
        let m = (core + comb) as f64;
        assert!((rc / m - 1.0).abs() <= 0.05, "{name}: R at the core {rc} against the model's core and combine {m}");
        // (the core's stage stays "core", and its re-forecast is the core's)
        let e = ev.iter().rev().find(|e| e.written && e.report.done == log.iter().find(|x| x.0 == "core").unwrap().1).unwrap();
        assert_eq!(stage_name(e.report.stage), "core", "{name}");
    }
}

/// The success flush counts a crossing of the first forecast since the
/// last refresh: on route 2 at the production refresh interval (the last
/// refresh at done 6,214,060, the final done 6,230,461), the first
/// forecast placed between the last refresh's done and the final done (by
/// the forecast scale), the success frame says beyond_forecast.
#[test]
fn a_crossing_at_the_success_flush_is_reported() {
    let _l = lock();
    let (_, a, _) = inputs().remove(1);
    let run = |f: f64| {
        testing::scale_forecast(f);
        sagebrush_interrupt::clear();
        testing::set_threshold(Some(64));
        record::start();
        smith_form(&a).unwrap();
        let ev = record::take();
        testing::set_threshold(None);
        testing::scale_forecast(1.0);
        (ev, testing::first_forecast().unwrap())
    };
    // at scale 1: the first forecast's units, and where the last refresh
    // before the success flush sits
    let (ev, first1) = run(1.0);
    let (last, before) = ev.split_last().unwrap();
    let prev = before.last().unwrap().report.done;
    let fin = last.report.done;
    // (the reported case: the last refresh at 6,214,060, the final done
    // 6,230,461)
    assert_eq!((prev, fin), (6_214_060, 6_230_461));
    // the first forecast is taken at done 0 (the inverse's entry): scaled,
    // aim it at the middle of (prev, fin)
    let target = prev + (fin - prev) / 2;
    let (ev, first) = run(target as f64 / first1 as f64);
    assert!(prev < first && first < fin, "the first forecast {first} not between {prev} and {fin}");
    let (last, before) = ev.split_last().unwrap();
    assert!(before.iter().all(|e| !e.report.beyond_forecast), "crossed before the success flush");
    assert_eq!((last.report.fraction, last.report.done), (Some(1.0), fin));
    assert!(last.report.beyond_forecast, "the success frame missed the crossing");
}

