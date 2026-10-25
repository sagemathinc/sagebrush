//! The Sagebrush engine's memory ledger (no-cliffs plan C r13, C-1).
//!
//! - The engine's total from the host (lib/_capacity.py `engine_total`, D0's
//!   consumer contract) with the binding rows' usage measures, and its
//!   reviewed share E = total / 4 ([`SHARE_DEN`]).
//! - An admission reads the binding rows' usage measure FRESH, holding the
//!   ledger's lock, and commits in the same critical section (C r13 §1: no
//!   cached measure), checking
//!
//!   phi * (L + O + x) <= E,
//!
//!   with O the gross outstanding obligations and L the live estimate:
//!   natively max(U, R_res), U the binding rows' own usage (cgroup
//!   memory.current, VmSize, VmData; for the physical row the process's
//!   RssAnon + VmSwap, plus the machine-availability check
//!   O + x <= MemAvailable - reserve); in WebAssembly
//!   max(committed pages, B_w + R_res) (C r12 §3).
//! - The reader does no allocation under the lock: files are opened when the
//!   total is set (outside the lock) and read with pread into a stack buffer;
//!   the chains' sums live in a fixed slot table.
//! - What the ledger promises (C r13 §2): governed admissions never take the
//!   measured domain beyond E as measured at admission, and every later check
//!   re-reads; it does NOT prevent ungoverned growth (other code, other
//!   processes) or OS out-of-memory conditions.
//! - An unreadable measure (and, for now, macOS and Windows) is fail-closed:
//!   [`certified`] is false, and no cap may be removed on the ledger's
//!   strength there.
//! - Chains, the outer exit's O_chain = 0 rule (released first, then reported
//!   as an internal error) and typed errors as in C r10.
//!
//! No cap is removed by this crate: callers adopt it path by path.

use std::cell::Cell;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;

mod measure;
pub use measure::{Measure, MeasureKind, Reading, Row, ROW_SLOTS};

#[cfg(feature = "ledger-audit")]
pub mod audit;

// ------------------------------------------------------------------ the total

/// The share of the engine's total the ledger may hold: E = total / 4
/// (plan C r4 section 1.1, a reviewed constant).
pub const SHARE_DEN: u64 = 4;
/// The allocator-overhead factor phi = FRAG_NUM / FRAG_DEN = 21/8, calibrated
/// (no-cliffs C r4 section 1.2) against the committed pages a fresh
/// WebAssembly instance grows by per byte requested at the peak: the worst
/// first call of the five workloads is 1.677431 (bnf6), times the plan's 1.5
/// margin = 2.516 <= 2.625 (VM3, Oct 25; the phi-probe build on
/// nocliffs/phi-probe).  A finite sample, not a general bound: the page
/// growth itself stays bounded by the growth envelope and its permits.
pub const FRAG_NUM: u64 = 21;
pub const FRAG_DEN: u64 = 8;
/// The nominal total when the host gives none: D0's fallback (1 GiB).
pub const NOMINAL_TOTAL: u64 = 1 << 30;

/// Where the total came from (lib/_capacity.py engine_total's status).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TotalStatus {
    Observed,
    Zero,
    Nominal,
}

impl TotalStatus {
    /// As the hosts push it: 0 observed, 1 zero, 2 nominal.
    pub fn from_code(c: u32) -> Option<TotalStatus> {
        match c {
            0 => Some(TotalStatus::Observed),
            1 => Some(TotalStatus::Zero),
            2 => Some(TotalStatus::Nominal),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TotalStatus::Observed => "observed",
            TotalStatus::Zero => "zero",
            TotalStatus::Nominal => "nominal",
        }
    }
}

/// The engine's total: bytes, status, and whether it also bounds the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Total {
    pub bytes: u64,
    pub status: TotalStatus,
    pub joint: bool,
    /// WebAssembly: the host found an applicable row that is joint or
    /// unknown (C r17 section 1.3), so the ledger is not certified there
    /// (natively each row is measured instead: always false)
    pub uncertified: bool,
}

const NOMINAL: Total = Total { bytes: NOMINAL_TOTAL, status: TotalStatus::Nominal, joint: false, uncertified: false };

/// E: the bytes the ledger may hold for this total.
pub fn allowance(t: Total) -> u64 {
    t.bytes / SHARE_DEN
}

/// The total pushed as WebAssembly numbers: bytes an integer from 0 to
/// 2^53, status 0, 1 or 2, and `uncertified` 0 or 1 (C r17 section 1.3:
/// 1 when some applicable row is joint or unknown, from lib/_capacity.py
/// engine_rows; it was the least rows' joint flag before); anything else
/// is none.
pub fn total_from_wasm(bytes: f64, status: u32, uncertified: u32) -> Option<Total> {
    let ok = bytes.is_finite() && bytes >= 0.0 && bytes.fract() == 0.0 && bytes <= 9007199254740992.0;
    let status = TotalStatus::from_code(status)?;
    (ok && uncertified <= 1).then_some(Total { bytes: bytes as u64, status, joint: uncertified == 1, uncertified: uncertified == 1 })
}

/// Set the total (the WebAssembly host pushes it before a dispatch; tests).
/// The measures stay as they are (WebAssembly measures committed pages).
pub fn set_total(total: Option<Total>) {
    let mut s = state();
    s.total = total;
    #[cfg(not(target_arch = "wasm32"))]
    {
        s.total_at = total.map(|_| std::time::Instant::now());
    }
}

/// Set the total and every applicable row with its usage measure (the
/// native host; tests).  The measures' files are opened here, outside the
/// lock.
#[cfg(not(target_arch = "wasm32"))]
pub fn set_total_and_measure(total: Option<Total>, rows: &[Row]) {
    let m = Measure::open(rows);
    let mut s = state();
    s.total = total;
    s.total_at = total.map(|_| std::time::Instant::now());
    s.measure = m;
}

#[cfg(not(target_arch = "wasm32"))]
type TotalHost = Box<dyn Fn() -> Option<(Total, Vec<Row>)> + Send + Sync>;
#[cfg(not(target_arch = "wasm32"))]
static TOTAL_HOST: std::sync::OnceLock<TotalHost> = std::sync::OnceLock::new();
/// (the native host's TOTAL, a limit, not a usage, is asked again when 100
/// ms old; the usage measure itself is never cached: C r13 section 1)
#[cfg(not(target_arch = "wasm32"))]
const TOTAL_REFRESH: std::time::Duration = std::time::Duration::from_millis(100);

/// Register the native host's total and applicable rows (the first
/// registration stands): asked outside the ledger's lock.
#[cfg(not(target_arch = "wasm32"))]
pub fn set_total_host(f: impl Fn() -> Option<(Total, Vec<Row>)> + Send + Sync + 'static) {
    let _ = TOTAL_HOST.set(Box::new(f));
}

/// The total in force (refreshed from the native host when 100 ms old,
/// outside the lock), or the nominal one.
pub fn total() -> Total {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(host) = TOTAL_HOST.get() {
        let stale = state().total_at.is_none_or(|t| t.elapsed() >= TOTAL_REFRESH);
        if stale {
            match host() {
                Some((t, rows)) => set_total_and_measure(Some(t), &rows),
                None => set_total_and_measure(None, &[]),
            }
        }
    }
    state().total.unwrap_or(NOMINAL)
}

/// Whether every applicable row is checked on this platform with this
/// total (fail-closed: a cap may be removed on the ledger's strength only
/// where this is true).  Natively: every row has a fresh measure.  In
/// WebAssembly: an observed total whose rows are all engine-only (the host's
/// classification, C r17 section 1.3; a joint row has no fresh measure in
/// the instance yet).
pub fn certified() -> bool {
    let _ = total();
    #[cfg(target_arch = "wasm32")]
    {
        state().total.is_some_and(|t| t.status == TotalStatus::Observed && !t.uncertified)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let s = state();
        s.total.is_some() && s.measure.available()
    }
}

// ------------------------------------------------------------------ errors

/// A memory refusal: what was asked, and the figures it was refused on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub what: String,
    pub need: u64,
    /// E, the ledger's allowance
    pub allowance: u64,
    /// the live estimate L and gross outstanding obligations O at the check
    pub live: u64,
    pub outstanding: u64,
    pub total: u64,
    pub status: TotalStatus,
    pub joint: bool,
    /// Some(available minus reserve) when the machine-availability check
    /// refused
    pub available: Option<u64>,
    /// whether L was measured (false: fail-closed platform or unreadable)
    pub measured: bool,
}

/// The engine's typed errors: a memory refusal (D1's error on the host), or
/// an internal guard that found a bug (never reported as memory).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineError {
    Memory(Refusal),
    Internal(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Memory(r) => match r.available {
                Some(a) => write!(f, "{}: {} more bytes do not fit in the {} bytes this machine has available (beyond its reserve)", r.what, r.need, a),
                None => write!(
                    f,
                    "{}: {} more bytes do not fit: {} in use and {} reserved, against {} (a quarter of the engine's {} total of {} bytes)",
                    r.what, r.need, r.live, r.outstanding, r.allowance, r.status.name(), r.total
                ),
            },
            EngineError::Internal(m) => write!(f, "internal error in the engine's memory ledger: {}", m),
        }
    }
}

impl std::error::Error for EngineError {}

// ------------------------------------------------------------------ the state

/// The chains' outstanding sums: a fixed slot table (no allocation under the
/// lock).  More concurrent chains than slots is an internal error.
const CHAIN_SLOTS: usize = 256;

struct State {
    total: Option<Total>,
    #[cfg(not(target_arch = "wasm32"))]
    total_at: Option<std::time::Instant>,
    #[cfg(not(target_arch = "wasm32"))]
    measure: Measure,
    /// WebAssembly: the committed bytes at the first check (B_w)
    #[cfg(target_arch = "wasm32")]
    baseline: Option<u64>,
    outstanding: u64,
    resident: u64,
    /// bytes ever converted to residents (C r12 section 2's C)
    converted: u64,
    chains: [(u64, u64); CHAIN_SLOTS],
}

static STATE: Mutex<State> = Mutex::new(State {
    total: None,
    #[cfg(not(target_arch = "wasm32"))]
    total_at: None,
    #[cfg(not(target_arch = "wasm32"))]
    measure: Measure::NONE,
    #[cfg(target_arch = "wasm32")]
    baseline: None,
    outstanding: 0,
    resident: 0,
    converted: 0,
    chains: [(0, 0); CHAIN_SLOTS],
});

/// Mirrors of O and R_res for the test-only audit allocator, which must not
/// take the lock.
pub(crate) static O_MIRROR: AtomicU64 = AtomicU64::new(0);
pub(crate) static RES_MIRROR: AtomicU64 = AtomicU64::new(0);

fn state() -> std::sync::MutexGuard<'static, State> {
    // (every update is a few integer operations that cannot panic halfway)
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

impl State {
    /// Err(()) when every slot is taken (the caller reports it after the
    /// lock is released: no allocation under the lock).
    fn chain_add(&mut self, chain: u64, x: u64) -> Result<(), ()> {
        if let Some(slot) = self.chains.iter_mut().find(|s| s.0 == chain && s.1 > 0) {
            slot.1 += x;
            return Ok(());
        }
        match self.chains.iter_mut().find(|s| s.1 == 0) {
            Some(slot) => {
                *slot = (chain, x);
                Ok(())
            }
            None => Err(()),
        }
    }

    fn chain_take(&mut self, chain: u64, x: u64) -> u64 {
        match self.chains.iter_mut().find(|s| s.0 == chain && s.1 > 0) {
            Some(slot) => {
                let t = x.min(slot.1);
                slot.1 -= t;
                t
            }
            None => 0,
        }
    }

    fn chain_sum(&self, chain: u64) -> u64 {
        self.chains.iter().filter(|s| s.0 == chain).map(|s| s.1).sum()
    }

    fn set_outstanding(&mut self, v: u64) {
        self.outstanding = v;
        O_MIRROR.store(v, Relaxed);
    }

    fn set_resident(&mut self, v: u64) {
        self.resident = v;
        RES_MIRROR.store(v, Relaxed);
    }
}

/// The gross outstanding obligations, all chains.
pub fn outstanding_bytes() -> u64 {
    state().outstanding
}

/// The registered residents.
pub fn resident_bytes() -> u64 {
    state().resident
}

/// The gross outstanding obligations of one chain.
pub fn chain_outstanding(chain: u64) -> u64 {
    state().chain_sum(chain)
}

/// The live estimate L now (a fresh read; diagnostics and the host's joint
/// check).
pub fn live_estimate() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    measure::prepare();
    let mut s = state();
    let (l, _, _) = live_locked(&mut s);
    l
}

/// L (and the availability bound, natively) under the lock, from a fresh
/// read; the third value is whether it was measured.
fn live_locked(s: &mut State) -> (u64, Option<u64>, bool) {
    #[cfg(target_arch = "wasm32")]
    {
        let committed = (core::arch::wasm32::memory_size::<0>() as u64) << 16;
        let b = *s.baseline.get_or_insert(committed);
        (committed.max(b + s.resident), None, true)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        // (diagnostics: the largest row usage; admissions check each row)
        let (mut usage, mut available) = (0u64, None);
        let measured = s.measure.read_each(|r| {
            usage = usage.max(r.usage);
            available = available.or(r.available);
        });
        if measured {
            (usage.max(s.resident), available, true)
        } else {
            (s.resident, None, false)
        }
    }
}

/// D0's reserve for an availability figure: 256 MiB + ceil(a / 10).
pub fn reserve_for(available: u64) -> u64 {
    (256 << 20) + available.div_ceil(10)
}

// ------------------------------------------------------------------ chains

static NEXT_CHAIN: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static CHAIN: Cell<u64> = const { Cell::new(0) };
}

/// The current thread's chain (0: no outer entry).
pub fn current_chain() -> u64 {
    CHAIN.with(|c| c.get())
}

/// Run f under a given chain (a parallel closure runs under its parent's).
pub fn with_chain<T>(chain: u64, f: impl FnOnce() -> T) -> T {
    struct Restore(u64);
    impl Drop for Restore {
        fn drop(&mut self) {
            CHAIN.with(|c| c.set(self.0));
        }
    }
    let _r = Restore(CHAIN.with(|c| c.replace(chain)));
    f()
}

/// An engine entry: the outer one on a thread starts a chain, nested ones
/// join it.  The outer entry's exit requires the chain's outstanding
/// obligations to be zero: [`Operation::finish`] releases what remained
/// (cleanup first, under the lock), then reports it as an internal error; a
/// drop (an unwind) only releases it.
pub struct Operation {
    chain: u64,
    outer: bool,
    done: bool,
}

impl Operation {
    pub fn enter() -> Operation {
        let cur = current_chain();
        if cur != 0 {
            return Operation { chain: cur, outer: false, done: false };
        }
        let chain = NEXT_CHAIN.fetch_add(1, Relaxed);
        CHAIN.with(|c| c.set(chain));
        Operation { chain, outer: true, done: false }
    }

    pub fn chain(&self) -> u64 {
        self.chain
    }

    pub fn finish(mut self) -> Result<(), EngineError> {
        self.done = true;
        let left = self.close();
        if left > 0 {
            Err(EngineError::Internal(format!("{} reserved bytes outlived their call (released at its end)", left)))
        } else {
            Ok(())
        }
    }

    fn close(&mut self) -> u64 {
        if !self.outer {
            return 0;
        }
        CHAIN.with(|c| c.set(0));
        let mut s = state();
        let left = s.chain_take(self.chain, !0u64);
        let o = s.outstanding - left;
        s.set_outstanding(o);
        left
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if !self.done {
            self.close();
        }
    }
}

// ------------------------------------------------------------------ reservations

/// Reserved bytes, released when dropped (or made resident).
#[must_use = "a reservation is released as soon as it is dropped"]
pub struct Reservation {
    amount: u64,
    chain: u64,
}

/// Registered resident bytes (a cache entry, a result), released when the
/// owner drops this.
#[must_use = "a resident is unregistered as soon as it is dropped"]
pub struct Resident {
    amount: u64,
}

impl Resident {
    pub fn amount(&self) -> u64 {
        self.amount
    }
}

impl Drop for Resident {
    fn drop(&mut self) {
        let mut s = state();
        let r = s.resident - self.amount.min(s.resident);
        s.set_resident(r);
    }
}

impl Reservation {
    pub fn amount(&self) -> u64 {
        self.amount
    }

    /// Reserve `extra` more bytes (a growing credit), checked as a new
    /// admission.
    pub fn grow(&mut self, what: &str, extra: u64) -> Result<(), EngineError> {
        admit(what, extra, self.chain)?;
        self.amount += extra;
        Ok(())
    }

    /// The reserved bytes now live in an object that outlives the
    /// reservation: they leave O and become a registered resident, in one
    /// critical section (C r10 section 1).
    pub fn register_resident(mut self) -> Resident {
        let amount = std::mem::take(&mut self.amount);
        let mut s = state();
        let t = s.chain_take(self.chain, amount);
        let o = s.outstanding - t;
        s.set_outstanding(o);
        let r = s.resident + amount;
        s.set_resident(r);
        s.converted += amount;
        Resident { amount }
    }

    /// The allocations made while the returned guard lives are this
    /// reservation's (the test-only audit attributes them; a no-op
    /// otherwise).
    pub fn scope(&self) -> Scope {
        Scope::enter()
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.amount > 0 {
            let mut s = state();
            let t = s.chain_take(self.chain, self.amount);
            let o = s.outstanding - t;
            s.set_outstanding(o);
        }
    }
}

thread_local! {
    pub(crate) static COVER: Cell<u32> = const { Cell::new(0) };
}

/// A coverage scope: allocations made on this thread while it lives belong
/// to a governing reservation, span, fence or resident under construction
/// (C r12 section 4).  Only the test-only audit reads it.
pub struct Scope(());

impl Scope {
    pub fn enter() -> Scope {
        COVER.with(|c| c.set(c.get() + 1));
        Scope(())
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        COVER.with(|c| c.set(c.get() - 1));
    }
}

#[cfg(any(test, feature = "test-hooks"))]
pub mod hooks {
    //! Tests only: fake rows (the measures as read under the lock) and a
    //! pause between the read and the commit.
    use super::*;

    /// (limit, None: the total's bytes; usage; machine availability)
    pub(crate) type FakeRow = (Option<u64>, u64, Option<u64>);
    pub(crate) static FAKE: Mutex<Option<Vec<FakeRow>>> = Mutex::new(None);
    pub(crate) static PAUSE: Mutex<Option<std::sync::Arc<std::sync::Barrier>>> = Mutex::new(None);

    /// One row at the total's limit with this usage (and availability),
    /// read by every check until cleared.
    pub fn set_fake_usage(usage: Option<(u64, Option<u64>)>) {
        *FAKE.lock().unwrap() = usage.map(|(u, a)| vec![(None, u, a)]);
    }

    /// Several rows, each (limit, usage, availability), read by every check
    /// until cleared (C r17 section 1.4).
    pub fn set_fake_rows(rows: Option<Vec<(u64, u64, Option<u64>)>>) {
        *FAKE.lock().unwrap() = rows.map(|v| v.into_iter().map(|(l, u, a)| (Some(l), u, a)).collect());
    }

    /// The next admission waits on `b` twice between its read and its
    /// commit, still holding the ledger's lock (a concurrent ledger
    /// transition must wait).
    pub fn pause_next_admission(b: std::sync::Arc<std::sync::Barrier>) {
        *PAUSE.lock().unwrap() = Some(b);
    }
}

/// One row's check (C r13; C r17 section 1.3): phi (L_r + O + x) <= E_r,
/// E_r = figure / 4, L_r = max(the row's usage, R_res); and for the physical
/// row, O + x <= available - reserve.  In u128: no overflow for any u64
/// inputs.  Some((allowance, room)) when it refuses (room: Some for the
/// availability check).
fn row_refuses(figure: u64, live: u64, available: Option<u64>, outstanding: u64, x: u64) -> Option<(u64, Option<u64>)> {
    let e = figure / SHARE_DEN;
    if FRAG_NUM as u128 * (live as u128 + outstanding as u128 + x as u128) > FRAG_DEN as u128 * e as u128 {
        return Some((e, None));
    }
    if let Some(a) = available {
        let room = a.saturating_sub(reserve_for(a));
        if outstanding as u128 + x as u128 > room as u128 {
            return Some((e, Some(room)));
        }
    }
    None
}

fn admit(what: &str, x: u64, chain: u64) -> Result<(), EngineError> {
    let t = total();
    #[cfg(not(target_arch = "wasm32"))]
    measure::prepare();
    let mut s = state();
    let outstanding = s.outstanding;
    let resident = s.resident;
    #[cfg(target_arch = "wasm32")]
    let wasm_live = {
        let committed = (core::arch::wasm32::memory_size::<0>() as u64) << 16;
        let b = *s.baseline.get_or_insert(committed);
        committed.max(b + resident)
    };
    // every row is checked (C r17 section 1.3); the first that refuses is
    // reported: (figure, live, allowance, room).  The decision is made under
    // the lock, the error (which allocates) built after it is released.
    let mut first: Option<(u64, u64, u64, Option<u64>)> = None;
    let mut live_seen = resident;
    let mut on_row = |figure: u64, usage: u64, available: Option<u64>| {
        let live = usage.max(resident);
        live_seen = live_seen.max(live);
        if first.is_none() {
            if let Some((e, room)) = row_refuses(figure, live, available, outstanding, x) {
                first = Some((figure, live, e, room));
            }
        }
    };
    #[allow(unused_mut)]
    let mut faked = false;
    #[cfg(any(test, feature = "test-hooks"))]
    {
        let g = hooks::FAKE.lock().unwrap();
        if let Some(rows) = g.as_ref() {
            faked = true;
            for &(figure, usage, available) in rows {
                on_row(figure.unwrap_or(t.bytes), usage, available);
            }
        }
        drop(g);
        let b = hooks::PAUSE.lock().unwrap().take();
        if let Some(b) = b {
            b.wait();
            b.wait();
        }
    }
    #[allow(unused_mut)]
    let mut measured = true;
    #[cfg(target_arch = "wasm32")]
    if !faked {
        on_row(t.bytes, wasm_live, None);
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !faked {
        measured = s.measure.read_each(|r| on_row(r.figure, r.usage, r.available));
        if !measured {
            // (unmeasured, fail-closed for certification: the residents
            // against the total, as before)
            on_row(t.bytes, 0, None);
        }
    }
    let (first, live_seen) = (first, live_seen);
    let slots_full = first.is_none() && s.chain_add(chain, x).is_err();
    if first.is_none() && !slots_full {
        s.set_outstanding(outstanding + x);
        return Ok(());
    }
    drop(s);
    if slots_full {
        return Err(EngineError::Internal(format!("more than {} chains hold reservations at once", CHAIN_SLOTS)));
    }
    let (figure, live, allowance, room) = first.unwrap_or((t.bytes, live_seen, allowance(t), None));
    Err(EngineError::Memory(Refusal {
        what: what.to_string(),
        need: x,
        allowance,
        live,
        outstanding,
        total: figure,
        status: t.status,
        joint: t.joint,
        available: room,
        measured,
    }))
}

/// Reserve `x` bytes for `what` on the current chain, before allocating
/// them: Ok(reservation) or a typed memory refusal.
pub fn reserve(what: &str, x: u64) -> Result<Reservation, EngineError> {
    let chain = current_chain();
    admit(what, x, chain)?;
    Ok(Reservation { amount: x, chain })
}

#[cfg(test)]
mod tests;
