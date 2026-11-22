//! The Smith form's live progress: one progress call ("smith form") for a
//! run above a size threshold, its count the units charged so far (total
//! unknown: the count is labelled "counted"), and an estimated time
//! fraction done / (done + R) from the work estimate's own terms, R the
//! remaining forecast.  Observation only: it never changes a result, the
//! units or the Stop checks, and it never feeds `cost()` or a decision.
//!
//! - R = R_active + the future phases' terms, R_active = max(B - spent,
//!   spent / 4) for the active phase's budget B and the units spent in it:
//!   the budget's remainder until spent = 4B/5, then a quarter as much
//!   again as spent (an overrun keeps the fraction below 1, and the ETA
//!   grows with it; a long overrun of the last phase takes the fraction
//!   towards 4/5 of it, so a run at 0.95 that overruns its last phase falls
//!   back visibly).  Re-forecasts may lower the fraction.
//! - `beyond_forecast` once done passes the first total forecast, sticky.
//! - Fraction 1 only on success, after the route's charges are in; before
//!   it the fraction is capped one step below the frames' all-ones word.
//! - The forecast reads sizes only (bit and limb counts of values the run
//!   already holds), inside [`crate::cost::unmetered`]: no units, no polls.
//! - Per thread: the state is this thread's (the Smith form uses no `par`
//!   workers).  A Stop natively unwinds through the guard, which releases
//!   the call without claiming completion; a wasm trap runs no destructors,
//!   so the state is also cleared at the next top-level call
//!   ([`sagebrush_interrupt::progress::reset_frames`], which moves the run
//!   generation) and a state of an older generation is dropped on entry.
//! - A Smith form run inside this one (route 3's core) reports no phases of
//!   its own: its units count towards this run's done, its forecast is in
//!   this run's terms.

use crate::cost::Units;
use crate::zmat::{limbs, ZMat};
use sagebrush_interrupt::progress::{self, Call};
use std::cell::RefCell;

/// Runs of at least this many limb-entries (m n times the mean limbs) get
/// a progress call; smaller ones pay nothing.
pub const THRESHOLD: u64 = 1 << 16;
/// The clock is read (and a publish attempted) once done has grown by this
/// many units since the last read.
const CLOCK_EVERY: u64 = 1 << 16;
/// The largest pre-success fraction: one step of the frames' u32 below 1.
pub const BEFORE_DONE: f64 = (u32::MAX as f64 - 1.0) / u32::MAX as f64;

struct State {
    call: Call,
    generation: u64,
    start: u64,
    phase_start: u64,
    budget: u64,
    future: u64,
    first: Option<u64>,
    beyond: bool,
    clock_mark: u64,
    /// Route 3: the remaining named terms (units), the run's phase order,
    /// and how many of the order's phases are behind (a mark retires its
    /// phase and every one before it, ran or skipped).
    named: Vec<(String, u64)>,
    order: Vec<String>,
    retired: usize,
    /// Route 3: the side ("col: ", "left: ") the marks belong to.
    side: &'static str,
    /// Route 3: A's shape and mean limbs, k^, and whether the forecast was
    /// redone after the first side's G.
    shape: (usize, usize, usize),
    kh: usize,
    reforecast: bool,
    /// Smith runs nested in this one running now (route 3's core, or a
    /// Smith form a route calls): their phases are theirs, not this run's,
    /// and are not reported.
    inner: u32,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    /// The tests' switches: progress off; the forecast made invalid.
    static ENABLED: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
    static FORCE_NAN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static THRESHOLD_TEST: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    static CLOCK_TEST: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    static FORECAST_SCALE: std::cell::Cell<f64> = const { std::cell::Cell::new(1.0) };
    /// The tests' record of the first total forecast of the last call.
    static FIRST_SEEN: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    /// The tests' log of route 3's re-forecasts: (which, done at it).
    static REFORECASTS: RefCell<Vec<(&'static str, u64)>> = const { RefCell::new(Vec::new()) };
}

fn log_reforecast(what: &'static str, done: u64) {
    REFORECASTS.with(|r| {
        if let Ok(mut r) = r.try_borrow_mut() {
            r.push((what, done));
        }
    });
}

/// Whether A is large enough for a progress call: m n entries of at least
/// [`THRESHOLD`] limbs in all (saturating).
fn qualifies(a: &ZMat) -> bool {
    let limbs_sum: u64 = a.d.iter().fold(0u64, |s, x| s.saturating_add(limbs(x) as u64));
    limbs_sum >= THRESHOLD_TEST.with(|t| t.get()).unwrap_or(THRESHOLD)
}

/// A forecast's units, as the tests may scale them.
fn scaled(u: u64) -> u64 {
    let f = FORECAST_SCALE.with(|f| f.get());
    if f == 1.0 {
        u
    } else {
        (u as f64 * f) as u64
    }
}

/// Clears this thread's Smith state without its drop: a new top-level
/// call's start (engine/web calls it beside
/// [`progress::reset_frames`]), after a trap may have left one.  The
/// stale call is abandoned (its frame is already forgotten).
pub fn reset() {
    STATE.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut() {
            if let Some(st) = s.take() {
                st.call.abandon();
            }
        }
    });
}

/// The tests' hooks (doc-hidden, inert unless called).
#[doc(hidden)]
pub mod testing {
    use super::*;

    /// Progress on or off on this thread (the ETA-off control).
    pub fn set_enabled(on: bool) {
        ENABLED.with(|e| e.set(on));
    }

    /// Makes every fraction this thread computes NaN (an invalid forecast).
    pub fn force_nan(on: bool) {
        FORCE_NAN.with(|e| e.set(on));
    }

    /// Opens a run's progress on A and drops its guard without running
    /// its drop: the state a wasm trap leaves behind.
    pub fn open_and_leak(a: &ZMat) -> bool {
        let g = open(a);
        let owned = g.owns;
        std::mem::forget(g);
        owned
    }

    /// Whether a Smith state is set on this thread.
    pub fn state_set() -> bool {
        STATE.with(|s| s.try_borrow().map(|s| s.is_some()).unwrap_or(false))
    }

    /// The size gate on A (the production threshold unless overridden).
    pub fn qualifies(a: &ZMat) -> bool {
        super::qualifies(a)
    }

    /// Overrides the threshold on this thread (the traces' smaller inputs);
    /// None restores [`THRESHOLD`].
    pub fn set_threshold(t: Option<u64>) {
        THRESHOLD_TEST.with(|x| x.set(t));
    }

    /// Overrides the refresh interval (units) on this thread; None
    /// restores the production one.
    pub fn set_clock_every(t: Option<u64>) {
        CLOCK_TEST.with(|x| x.set(t));
    }

    /// The last call's first total forecast (done at its first phase plus
    /// that phase's forecast), taken: the reference of `beyond_forecast`.
    pub fn first_forecast() -> Option<u64> {
        FIRST_SEEN.with(|f| f.take())
    }

    /// Route 3's re-forecasts since the last call, in order: ("G", done)
    /// after the first side's G, ("core", done) at the core's, from T's own
    /// stage 2.
    pub fn reforecasts() -> Vec<(&'static str, u64)> {
        REFORECASTS.with(|r| std::mem::take(&mut *r.borrow_mut()))
    }

    /// Scales every forecast on this thread (a forced crossing, or a
    /// never-crossed control).
    pub fn scale_forecast(f: f64) {
        FORECAST_SCALE.with(|x| x.set(f));
    }
}

fn units_total() -> u64 {
    crate::cost::tallied().0.iter().fold(0u64, |a, x| a.wrapping_add(*x))
}

fn total(u: &Units) -> u64 {
    u.0.iter().fold(0u64, |a, x| a.saturating_add(*x))
}

/// The fraction done / (done + R), R = max(budget - spent, spent / 4) +
/// future, spent = done - phase_start; capped at [`BEFORE_DONE`]; None
/// when it isn't finite.
pub fn fraction(done: u64, phase_start: u64, budget: u64, future: u64) -> Option<f64> {
    let spent = done.saturating_sub(phase_start);
    let active = budget.saturating_sub(spent).max(spent / 4);
    let r = active.saturating_add(future);
    let (d, r) = (done as f64, r as f64);
    if d + r == 0.0 {
        return Some(0.0);
    }
    valid(d / (d + r))
}

/// A fraction to publish: None unless finite, else capped below 1.
fn valid(f: f64) -> Option<f64> {
    f.is_finite().then(|| f.clamp(0.0, BEFORE_DONE))
}

/// The run's progress, for its lifetime (see the module doc).
pub(crate) struct Guard {
    owns: bool,
    /// A run nested in a reported one (it counts itself in the state).
    inner: bool,
}

/// Opens the run's progress call if A is large enough and none is running
/// on this thread (a stale one, left by a trap, is dropped first).
pub(crate) fn open(a: &ZMat) -> Guard {
    if !ENABLED.with(|e| e.get()) {
        return Guard { owns: false, inner: false };
    }
    let g = progress::generation();
    let nested = STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return None };
        match s.as_mut() {
            Some(st) if st.generation == g => {
                st.inner = st.inner.saturating_add(1);
                Some(true)
            }
            Some(_) => {
                // (stale: a trapped run's; its frame is already forgotten)
                if let Some(st) = s.take() {
                    st.call.abandon();
                }
                Some(false)
            }
            None => Some(false),
        }
    });
    match nested {
        None => return Guard { owns: false, inner: false },
        Some(true) => return Guard { owns: false, inner: true },
        Some(false) => {}
    }
    let (m, n) = (a.rows as u64, a.cols as u64);
    if m.saturating_mul(n) == 0 || !qualifies(a) {
        return Guard { owns: false, inner: false };
    }
    let mut call = progress::begin(progress::table_index(progress::OPS, "smith form"));
    call.report().unit = progress::table_index(progress::UNITS, "work units");
    let start = units_total();
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            call,
            generation: g,
            start,
            phase_start: 0,
            budget: 0,
            future: 0,
            first: None,
            beyond: false,
            clock_mark: 0,
            named: vec![],
            order: vec![],
            retired: 0,
            side: "",
            shape: (0, 0, 0),
            kh: 0,
            reforecast: false,
            inner: 0,
        })
    });
    Guard { owns: true, inner: false }
}

impl Guard {
    /// The run succeeded: its charges are in (the route's Locals have
    /// dropped), so the final done is the run's units; fraction 1, flushed.
    pub(crate) fn success(mut self) {
        if self.owns {
            STATE.with(|s| {
                if let Some(mut st) = s.borrow_mut().take() {
                    let done = units_total().wrapping_sub(st.start);
                    // (a crossing since the last refresh counts too)
                    if let Some(first) = st.first {
                        st.beyond |= done > first;
                    }
                    let beyond = st.beyond;
                    let r = st.call.report();
                    r.done = done;
                    r.work = done;
                    r.fraction = Some(1.0);
                    r.beyond_forecast = beyond;
                    st.call.flush();
                }
            });
            self.owns = false;
        }
    }
}

impl Drop for Guard {
    /// An error or a Stop's unwinding: the call is released, completion is
    /// not claimed.  Stores, a lock and the clock only: no poll, no panic.
    fn drop(&mut self) {
        if self.inner {
            leave_inner();
        }
        if self.owns {
            STATE.with(|s| {
                if let Ok(mut s) = s.try_borrow_mut() {
                    drop(s.take());
                }
            });
        }
    }
}

/// A nested run's scope, for a Smith form a route runs on a matrix of its
/// own (route 3's core, through the nonsingular routes directly): its
/// phases are not the outer run's, so none are reported while it lives.
/// The outer run's count goes on (its units are the outer run's).
pub(crate) struct Inner(bool);

pub(crate) fn inner() -> Inner {
    Inner(STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return false };
        let Some(st) = s.as_mut() else { return false };
        st.inner = st.inner.saturating_add(1);
        true
    }))
}

impl Drop for Inner {
    fn drop(&mut self) {
        if self.0 {
            leave_inner();
        }
    }
}

fn leave_inner() {
    STATE.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut() {
            if let Some(st) = s.as_mut() {
                st.inner = st.inner.saturating_sub(1);
            }
        }
    });
}

/// Recomputes the report from the state and writes it (`now`: at once,
/// else at most as the call's throttle allows).
fn refresh(st: &mut State, now: bool) {
    let done = units_total().wrapping_sub(st.start);
    if let Some(first) = st.first {
        st.beyond |= done > first;
    }
    let f = if FORCE_NAN.with(|e| e.get()) { valid(f64::NAN) } else { fraction(done, st.phase_start, st.budget, st.future) };
    let beyond = st.beyond;
    let r = st.call.report();
    r.done = done;
    r.work = done;
    r.fraction = f;
    r.beyond_forecast = beyond;
    if now {
        st.call.flush();
    } else {
        st.call.publish();
    }
}

/// At every kernel poll: refreshes done and the fraction once done has
/// grown by [`CLOCK_EVERY`] since the last refresh.
pub(crate) fn tick() {
    STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return };
        let Some(st) = s.as_mut() else { return };
        let done = units_total().wrapping_sub(st.start);
        if done.saturating_sub(st.clock_mark) < CLOCK_TEST.with(|t| t.get()).unwrap_or(CLOCK_EVERY) {
            return;
        }
        st.clock_mark = done;
        refresh(st, false);
    });
}

/// Whether a progress call is running on this thread (the routes skip
/// their forecasts otherwise).
pub(crate) fn active() -> bool {
    STATE.with(|s| s.try_borrow().map(|s| s.as_ref().is_some_and(|st| st.inner == 0)).unwrap_or(false))
}

/// A new phase: its stage name, index and count, its budget B and the
/// future phases' units; the first total forecast is taken at the first
/// phase (done + B + future).
pub(crate) fn phase(stage: &str, index: u64, count: Option<u64>, budget: u64, future: u64) {
    STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return };
        let Some(st) = s.as_mut().filter(|st| st.inner == 0) else { return };
        let done = units_total().wrapping_sub(st.start);
        st.phase_start = done;
        st.budget = scaled(budget);
        st.future = scaled(future);
        if st.first.is_none() {
            st.first = Some(done.saturating_add(st.budget).saturating_add(st.future));
            FIRST_SEEN.with(|f| f.set(st.first));
        }
        let r = st.call.report();
        r.stage = progress::table_index(progress::STAGES, stage);
        r.stage_index = index;
        r.stage_count = count;
        refresh(st, true);
    });
}

/// Route 3: the forecast's named terms (units), in the run's order; the
/// active phase is the first of `order` not yet retired.  (A re-forecast's
/// terms for phases already behind are dropped: their units are in done.)
pub(crate) fn named(terms: &[(String, Units)], order: &[&str]) {
    STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return };
        let Some(st) = s.as_mut().filter(|st| st.inner == 0) else { return };
        st.order = order.iter().map(|x| x.to_string()).collect();
        let retired = st.retired;
        let ahead = |st: &State, n: &str| st.order.iter().position(|o| o == n).is_none_or(|k| k >= retired);
        st.named = terms.iter().filter(|(n, _)| ahead(st, n)).map(|(n, u)| (n.clone(), scaled(total(u)))).collect();
        route3_active(st);
    });
}

/// Route 3: the side the next marks belong to.
pub(crate) fn side(s_: &'static str) {
    STATE.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut() {
            if let Some(st) = s.as_mut().filter(|st| st.inner == 0) {
                st.side = s_;
            }
        }
    });
}

/// Route 3: phase `name` (on the current side) ended.
pub(crate) fn mark(name: &str) {
    STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return };
        let Some(st) = s.as_mut().filter(|st| st.inner == 0) else { return };
        if st.order.is_empty() {
            return;
        }
        // (the phases run in the order's order: this one and any before it
        // are behind, ran or skipped, such as "T inverse", which runs inside
        // the core; a phase marked again, behind already, retires nothing)
        let full = format!("{}{name}", st.side);
        if let Some(k) = st.order.iter().position(|o| *o == full) {
            st.retired = st.retired.max(k + 1);
            let behind: Vec<String> = st.order[..st.retired].to_vec();
            st.named.retain(|(n, _)| !behind.contains(n));
        }
        route3_active(st);
    });
}

/// The public stage of route 3's phase `name`.
fn route3_stage(name: &str) -> (&'static str, u64) {
    if name.starts_with("col: ") || name == "certificate" || name == "A X" {
        ("Compress", 1)
    } else if name.starts_with("left: ") {
        ("Compress", 2)
    } else if name == "core" || name == "T inverse" {
        ("core", 3)
    } else if name == "combine" {
        ("combine", 4)
    } else {
        ("profile", 0)
    }
}

fn route3_active(st: &mut State) {
    let active = st.order.iter().find(|o| st.named.iter().any(|(n, _)| n == *o)).cloned();
    let budget = active.as_ref().and_then(|a| st.named.iter().find(|(n, _)| n == a)).map_or(0, |x| x.1);
    let all: u64 = st.named.iter().fold(0u64, |a, x| a.saturating_add(x.1));
    let done = units_total().wrapping_sub(st.start);
    st.phase_start = done;
    st.budget = budget;
    st.future = all.saturating_sub(budget);
    if st.first.is_none() {
        st.first = Some(done.saturating_add(all));
        FIRST_SEEN.with(|f| f.set(st.first));
    }
    let (stage, index) = route3_stage(active.as_deref().unwrap_or("combine"));
    let r = st.call.report();
    r.stage = progress::table_index(progress::STAGES, stage);
    r.stage_index = index;
    r.stage_count = Some(5);
    refresh(st, true);
}

/// Route 3's phases in the run's order (the model's term names; "T
/// inverse" runs inside the core).
#[doc(hidden)]
pub const ROUTE3_ORDER: &[&str] = &[
    "entry",
    "profile",
    "col: blocks",
    "col: B_J inverse",
    "col: Q",
    "col: G",
    "col: C echelon",
    "col: C solve",
    "col: lift",
    "col: N C",
    "col: H echelon",
    "col: K and X",
    "certificate",
    "A X",
    "left: blocks",
    "left: B_J inverse",
    "left: Q",
    "left: G",
    "left: C echelon",
    "left: C solve",
    "left: lift",
    "left: N C",
    "left: H echelon",
    "left: K and X",
    "T inverse",
    "core",
    "combine",
];

/// Route 3's entry: the forecast from sizes (k^ 0 until the run has A's
/// contents); the failed pass, if any, is already behind.
pub(crate) fn route3_begin(a: &ZMat) {
    route3_stage1(a);
}

/// Route 3: a failed certificate sends the run back to the profile (a
/// larger rank): the column side's phases are ahead again, forecast anew
/// from sizes, and the forecast after G is redone at the new rank.
pub(crate) fn route3_retry(a: &ZMat) {
    let Some(()) = STATE.with(|s| {
        let mut s = s.try_borrow_mut().ok()?;
        let st = s.as_mut().filter(|st| st.inner == 0 && !st.order.is_empty())?;
        st.retired = st.order.iter().position(|o| o == "profile").unwrap_or(0);
        st.reforecast = false;
        Some(())
    }) else {
        return;
    };
    route3_stage1(a);
}

fn route3_stage1(a: &ZMat) {
    if !active() {
        return;
    }
    let (m, n) = (a.rows, a.cols);
    let kh = STATE.with(|s| s.try_borrow().ok().and_then(|s| s.as_ref().map(|st| st.kh)).unwrap_or(0));
    let terms = {
        let _u = crate::cost::unmetered();
        let la = super::estimate::forecast_mean_limbs(a);
        let (rows, cols) = super::estimate::norm_bits_from_sizes(a);
        let t = super::estimate::stage1_route3_terms_sized(m, n, la, &rows, &cols, kh, &super::estimate::FITTED);
        (t, la)
    };
    STATE.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut() {
            if let Some(st) = s.as_mut().filter(|st| st.inner == 0) {
                st.shape = (m, n, terms.1);
            }
        }
    });
    let t: Vec<(String, Units)> = terms.0.into_iter().filter(|(n, _)| n != "failed pass").collect();
    named(&t, ROUTE3_ORDER);
}

/// Route 3: A's k^, once the run has it.
pub(crate) fn route3_khat(kh: usize) {
    STATE.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut() {
            if let Some(st) = s.as_mut().filter(|st| st.inner == 0) {
                st.kh = kh;
            }
        }
    });
}

/// Route 3, the first side's G known: the forecast redone at stage 2's
/// sizes, from values the run holds (delta, det, G, N; their bit and limb
/// counts only).
pub(crate) fn route3_after_g(r: usize, nm: &ZMat, delta: &sagebrush_bigint::BigInt, det: &sagebrush_bigint::BigInt, g: &sagebrush_bigint::BigInt) {
    let Some((m, n, la, kh)) = STATE.with(|s| {
        let mut s = s.try_borrow_mut().ok()?;
        let st = s.as_mut().filter(|st| st.inner == 0)?;
        if st.reforecast || st.order.is_empty() {
            return None;
        }
        st.reforecast = true;
        Some((st.shape.0, st.shape.1, st.shape.2, st.kh))
    }) else {
        return;
    };
    let terms = {
        let _u = crate::cost::unmetered();
        // (e = |det| / delta, G = e gcd(delta, Q): their sizes from the bit
        // lengths)
        let eb = det.bits().saturating_sub(delta.bits()) + 1;
        let le = (eb as usize).div_ceil(64).max(1);
        let k = super::estimate::Stage2Known {
            m,
            n,
            r,
            la,
            ld: limbs(delta),
            delta_bits: delta.bits(),
            ln: super::estimate::forecast_mean_limbs(nm),
            lg: limbs(g),
            g_bits: g.bits(),
            e_is_g: g.bits() <= eb,
            lgq: limbs(g).saturating_sub(le).max(1),
            piv: if det.bits() == delta.bits() { 1 } else { 3 },
            kh,
            ..Default::default()
        };
        super::estimate::stage2_route3_terms_known(&k, &super::estimate::FITTED)
    };
    let t: Vec<(String, Units)> = terms.into_iter().filter(|(n, _)| n != "failed pass").collect();
    named(&t, ROUTE3_ORDER);
    STATE.with(|s| {
        if let Ok(s) = s.try_borrow() {
            if let Some(st) = s.as_ref() {
                log_reforecast("G", units_total().wrapping_sub(st.start));
            }
        }
    });
}

/// Whether the running call is route 3's and its core (a nested route 1 or
/// 2 on T) is running now: the core's term is re-estimated from T's own
/// stage 2 ([`core_budget`]).
pub(crate) fn in_core() -> bool {
    STATE.with(|s| s.try_borrow().map(|s| s.as_ref().is_some_and(|st| st.inner == 1 && !st.order.is_empty())).unwrap_or(false))
}

/// Route 3's core: its remaining units, from T's own stage 2 (route 1's
/// attempts; or route 2's part A and attempts, then its attempts alone).
/// The phases before the core are behind; the stage stays "core".
pub(crate) fn core_budget(units: u64) {
    STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return };
        let Some(st) = s.as_mut().filter(|st| st.inner == 1 && !st.order.is_empty()) else { return };
        let Some(k) = st.order.iter().position(|o| o == "core") else { return };
        st.retired = st.retired.max(k);
        let behind: Vec<String> = st.order[..st.retired].to_vec();
        st.named.retain(|(n, _)| !behind.contains(n));
        let u = scaled(units);
        match st.named.iter_mut().find(|(n, _)| n == "core") {
            Some(t) => t.1 = u,
            None => st.named.push(("core".into(), u)),
        }
        route3_active(st);
        let done = units_total().wrapping_sub(st.start);
        log_reforecast("core", done);
    });
}
