//! The Sagebrush engine's memory ledger (no-cliffs plan C r10, C-1).
//!
//! - A counting global allocator ([`CountingAlloc`]): every live engine heap
//!   byte, ledger-backed or not, in one atomic counter ([`live_bytes`]).
//! - The engine's total, pushed or pulled from the host (lib/_capacity.py
//!   `engine_total`, D0's consumer contract), and its reviewed share
//!   E = total / 4 ([`SHARE_DEN`]).
//! - Reservations: an admission checks, under one lock,
//!
//!   phi * (live + O + x) <= E,
//!
//!   where O is the GROSS outstanding reservations (not reduced as they
//!   materialise: their materialised bytes are counted twice while they
//!   are outstanding, which is conservative), so a pending reservation and
//!   unregistered live memory are both counted (plan C r5 section 1).
//!   phi is the allocator's overhead factor, [`FRAG_NUM`] / [`FRAG_DEN`].
//! - A reservation is released on drop, or becomes resident
//!   ([`Reservation::register_resident`]): its bytes stay in `live`, and it
//!   leaves O.
//! - Chains: each outer engine entry ([`Operation::enter`]) gets a chain id;
//!   O is kept per chain, and an outer entry's exit requires its chain's O to
//!   be zero (plan C r10 section 1): what remains is released first, then
//!   reported as an internal error, never a memory refusal.
//! - Typed errors: [`EngineError::Memory`] (a refusal, D1's error on the host)
//!   and [`EngineError::Internal`] (a guard that found a bug).
//!
//! No cap is removed by this crate: callers adopt it path by path.

use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;

// ------------------------------------------------------------------ allocator

static LIVE: AtomicU64 = AtomicU64::new(0);

/// A global allocator that counts the bytes it has live: one relaxed atomic
/// add or subtract per allocation, free or reallocation.  Installed in the
/// final artifacts (the engine's wasm cdylib and the CPython module):
///
/// ```ignore
/// #[global_allocator]
/// static ALLOC: sagebrush_ledger::CountingAlloc<std::alloc::System> =
///     sagebrush_ledger::CountingAlloc::new(std::alloc::System);
/// ```
pub struct CountingAlloc<A>(A);

impl<A> CountingAlloc<A> {
    pub const fn new(inner: A) -> Self {
        CountingAlloc(inner)
    }
}

unsafe impl<A: GlobalAlloc> GlobalAlloc for CountingAlloc<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = self.0.alloc(layout);
        if !p.is_null() {
            LIVE.fetch_add(layout.size() as u64, Relaxed);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = self.0.alloc_zeroed(layout);
        if !p.is_null() {
            LIVE.fetch_add(layout.size() as u64, Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        self.0.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size() as u64, Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let q = self.0.realloc(ptr, layout, new_size);
        if !q.is_null() {
            let (old, new) = (layout.size() as u64, new_size as u64);
            if new >= old {
                LIVE.fetch_add(new - old, Relaxed);
            } else {
                LIVE.fetch_sub(old - new, Relaxed);
            }
        }
        q
    }
}

/// The engine heap's live bytes, as the counting allocator sees them (0 in
/// an artifact that did not install it).
pub fn live_bytes() -> u64 {
    LIVE.load(Relaxed)
}

// ------------------------------------------------------------------ the total

/// The share of the engine's total the ledger may hold: E = total / 4
/// (plan C r4 section 1.1, a reviewed constant).
pub const SHARE_DEN: u64 = 4;
/// The allocator's overhead/fragmentation factor phi = FRAG_NUM / FRAG_DEN:
/// a calibrated envelope (plan C r4 section 1.2), committed pages over live
/// bytes at the calibration workloads' high-water marks, times 1.5.
pub const FRAG_NUM: u64 = 5;
pub const FRAG_DEN: u64 = 4;
/// The nominal total when the host gives none: D0's fallback (1 GiB).
pub const NOMINAL_TOTAL: u64 = 1 << 30;

/// Where the total came from (lib/_capacity.py engine_total's status).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TotalStatus {
    /// read from a row that constrains the engine's domain
    Observed,
    /// an observed limit of 0 (kept as 0: every reservation is refused)
    Zero,
    /// no row: the nominal total, tagged
    Nominal,
}

impl TotalStatus {
    /// The status as the hosts push it: 0 observed, 1 zero, 2 nominal.
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

/// The engine's total: bytes, status, and whether it also bounds the host
/// (a joint row: the host's common-domain check, C-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Total {
    pub bytes: u64,
    pub status: TotalStatus,
    pub joint: bool,
}

const NOMINAL: Total = Total { bytes: NOMINAL_TOTAL, status: TotalStatus::Nominal, joint: false };

#[cfg(not(target_arch = "wasm32"))]
type TotalHost = Box<dyn Fn() -> Option<Total> + Send + Sync>;
#[cfg(not(target_arch = "wasm32"))]
static TOTAL_HOST: std::sync::OnceLock<TotalHost> = std::sync::OnceLock::new();
/// (the native host's figure is read again when 100 ms old)
#[cfg(not(target_arch = "wasm32"))]
const TOTAL_MAX_AGE: std::time::Duration = std::time::Duration::from_millis(100);

/// Set the total (the WebAssembly host pushes it before a dispatch; tests).
pub fn set_total(total: Option<Total>) {
    let mut s = state();
    s.total = total;
    #[cfg(not(target_arch = "wasm32"))]
    {
        s.total_at = total.map(|_| std::time::Instant::now());
    }
}

/// The total pushed as WebAssembly numbers: bytes an integer from 0 to
/// 2^53, status 0, 1 or 2, joint 0 or 1; anything else is none.
pub fn total_from_wasm(bytes: f64, status: u32, joint: u32) -> Option<Total> {
    let ok = bytes.is_finite() && bytes >= 0.0 && bytes.fract() == 0.0 && bytes <= 9007199254740992.0;
    let status = TotalStatus::from_code(status)?;
    (ok && joint <= 1).then(|| Total { bytes: bytes as u64, status, joint: joint == 1 })
}

/// Register the native host's total (the first registration stands): asked
/// when the figure held is 100 ms old, outside the ledger's lock.
#[cfg(not(target_arch = "wasm32"))]
pub fn set_total_host(f: impl Fn() -> Option<Total> + Send + Sync + 'static) {
    let _ = TOTAL_HOST.set(Box::new(f));
}

/// The total in force (refreshed from the native host when stale), or the
/// nominal one.
pub fn total() -> Total {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(host) = TOTAL_HOST.get() {
        let stale = {
            let s = state();
            s.total_at.map_or(true, |t| t.elapsed() >= TOTAL_MAX_AGE)
        };
        if stale {
            // (the host is asked without the lock: it may take the GIL)
            let t = host();
            let mut s = state();
            s.total = t;
            s.total_at = Some(std::time::Instant::now());
        }
    }
    state().total.unwrap_or(NOMINAL)
}

/// E: the bytes the ledger may hold for this total.
pub fn allowance(t: Total) -> u64 {
    t.bytes / SHARE_DEN
}

// ------------------------------------------------------------------ errors

/// A memory refusal: what was asked, and the figures it was refused on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub what: String,
    /// the bytes asked for
    pub need: u64,
    /// E, the ledger's allowance
    pub allowance: u64,
    /// the live bytes and gross outstanding reservations at the check
    pub live: u64,
    pub outstanding: u64,
    /// the total E is the share of, and where it came from
    pub total: u64,
    pub status: TotalStatus,
    pub joint: bool,
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
            EngineError::Memory(r) => write!(
                f,
                "{}: {} more bytes do not fit: {} live and {} reserved, against {} (a quarter of the engine's {} total of {} bytes)",
                r.what, r.need, r.live, r.outstanding, r.allowance, r.status.name(), r.total
            ),
            EngineError::Internal(m) => write!(f, "internal error in the engine's memory ledger: {}", m),
        }
    }
}

impl std::error::Error for EngineError {}

// ------------------------------------------------------------------ the state

struct State {
    total: Option<Total>,
    #[cfg(not(target_arch = "wasm32"))]
    total_at: Option<std::time::Instant>,
    outstanding: u64,
    by_chain: BTreeMap<u64, u64>,
}

static STATE: Mutex<State> = Mutex::new(State {
    total: None,
    #[cfg(not(target_arch = "wasm32"))]
    total_at: None,
    outstanding: 0,
    by_chain: BTreeMap::new(),
});

fn state() -> std::sync::MutexGuard<'static, State> {
    // (every update is a few integer operations that cannot panic halfway,
    // so a lock poisoned by a panic elsewhere is taken over)
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The gross outstanding reservations, all chains.
pub fn outstanding_bytes() -> u64 {
    state().outstanding
}

/// The gross outstanding reservations of one chain.
pub fn chain_outstanding(chain: u64) -> u64 {
    state().by_chain.get(&chain).copied().unwrap_or(0)
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
/// reservations to be zero: [`Operation::finish`] releases what remained,
/// then reports it as an internal error; a drop (an unwind) only releases
/// it, as the reservations' own guards normally have already.
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

    /// Close the entry: for the outer one, release whatever the chain still
    /// has outstanding (cleanup first), then report it if there was any.
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
        let left = s.by_chain.remove(&self.chain).unwrap_or(0);
        s.outstanding -= left;
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
    /// reservation (a cache entry, a result): they leave the outstanding
    /// sum and stay counted as live bytes.
    pub fn register_resident(mut self) {
        release(self.chain, self.amount);
        self.amount = 0;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.amount > 0 {
            release(self.chain, self.amount);
        }
    }
}

fn release(chain: u64, amount: u64) {
    let mut s = state();
    // (a chain closed at its outer exit already took its sum away)
    if let Some(v) = s.by_chain.get_mut(&chain) {
        let take = amount.min(*v);
        *v -= take;
        if *v == 0 {
            s.by_chain.remove(&chain);
        }
        s.outstanding -= take;
    }
}

#[cfg(any(test, feature = "test-hooks"))]
pub mod hooks {
    //! Tests only: live bytes that no allocation made (a non-ledger
    //! allocation, without allocating), and a pause inside an admission
    //! after it reads the live count.
    use super::*;

    pub fn add_live(n: u64) {
        LIVE.fetch_add(n, Relaxed);
    }

    pub fn sub_live(n: u64) {
        LIVE.fetch_sub(n, Relaxed);
    }

    pub(crate) static PAUSE: Mutex<Option<std::sync::Arc<std::sync::Barrier>>> = Mutex::new(None);

    /// The next admission waits on `b` twice, after reading the live count
    /// and before deciding, with the ledger's lock released in between, so a
    /// test can act there.
    pub fn pause_next_admission(b: std::sync::Arc<std::sync::Barrier>) {
        *PAUSE.lock().unwrap() = Some(b);
    }
}

fn admit(what: &str, x: u64, chain: u64) -> Result<(), EngineError> {
    let t = total();
    let e = allowance(t);
    let mut s = state();
    #[allow(unused_mut)]
    let mut live = LIVE.load(Relaxed);
    #[cfg(any(test, feature = "test-hooks"))]
    {
        let b = hooks::PAUSE.lock().unwrap().take();
        if let Some(b) = b {
            drop(s);
            b.wait();
            b.wait();
            s = state();
            // (the test's point: the live count read before the pause is
            // the one decided on, as a race would have it)
        }
    }
    // phi (live + O + x) <= E, in u128: no overflow for any u64 inputs
    let lhs = FRAG_NUM as u128 * (live as u128 + s.outstanding as u128 + x as u128);
    if lhs > FRAG_DEN as u128 * e as u128 {
        return Err(EngineError::Memory(Refusal {
            what: what.to_string(),
            need: x,
            allowance: e,
            live,
            outstanding: s.outstanding,
            total: t.bytes,
            status: t.status,
            joint: t.joint,
        }));
    }
    s.outstanding += x;
    *s.by_chain.entry(chain).or_insert(0) += x;
    Ok(())
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
