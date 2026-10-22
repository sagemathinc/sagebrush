//! Cooperative interruption (Ctrl-C) for the Sagebrush engines.
//!
//! Long-running loops call [`check`].  Once an interrupt has been
//! [`request`]ed, `check` panics with the private payload [`Interrupted`]:
//! the computation unwinds through every frame, running destructors (no
//! leaks, no locks left held), up to the binding, which catches exactly
//! that payload with [`catch`] and reports it as Python's
//! `KeyboardInterrupt`.  Other panics are left alone.  Caches and the
//! caller's state stay valid, so the next call works normally.
//!
//! Who requests it:
//! - native: [`SigintGuard`], held around an engine call made from the main
//!   thread, routes Ctrl-C to [`request`] for the duration of the call
//!   (SIGINT on Unix, the console Ctrl handler on Windows), then restores
//!   the previous handler.  Pressing Ctrl-C three times during one call
//!   falls back to the default action (Unix), for loops that never check;
//! - WebAssembly (with the feature `wasm-host`): `check` asks the host,
//!   every 1024 calls, through the import `sagebrush.interrupted` (the page sets a flag in a
//!   SharedArrayBuffer).  WebAssembly cannot unwind: the panic traps, and the
//!   host discards the engine instance (the interpreter's state, outside the
//!   engine, survives).
//!
//! A check is one relaxed atomic load: put them in loops whose iterations
//! take microseconds to milliseconds, not in the innermost arithmetic.
//! Between coarser units of work (a millisecond or more each, such as a
//! block of rows of a dense elimination) use [`check_coarse`], which in wasm
//! asks the host at every call: 1024 such units between two questions
//! would leave Stop unanswered for seconds.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};

static REQUESTED: AtomicBool = AtomicBool::new(false);

/// The panic payload of an interruption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interrupted;

impl std::fmt::Display for Interrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("interrupted")
    }
}

/// Ask running computations to stop at their next check.
pub fn request() {
    REQUESTED.store(true, Relaxed);
}

/// Forget a request (at the start and end of an interactive call).
pub fn clear() {
    REQUESTED.store(false, Relaxed);
    PRESSES.store(0, Relaxed);
}

/// Whether an interrupt has been requested (polling the host in wasm).
pub fn requested() -> bool {
    poll_host();
    REQUESTED.load(Relaxed)
}

/// Stop here (by unwinding) if an interrupt has been requested.
#[inline]
pub fn check() {
    poll_host();
    #[cfg(feature = "test-hooks")]
    hooks::count();
    if REQUESTED.load(Relaxed) {
        interrupt()
    }
}

/// As [`check`], at a checkpoint between coarse units of work: in wasm the
/// host is asked at every call (one import call), not every 1024th.
#[inline]
pub fn check_coarse() {
    poll_host_now();
    #[cfg(feature = "test-hooks")]
    hooks::count();
    if REQUESTED.load(Relaxed) {
        interrupt()
    }
}

/// Names the phase of a computation that the following checks belong to
/// (for the tests' phase-targeted Stop, feature `test-hooks`; otherwise
/// nothing).
#[inline]
pub fn phase(_name: &'static str) {
    #[cfg(feature = "test-hooks")]
    hooks::set_phase(_name);
}

/// The phase `name` until the returned guard drops, then the previous one
/// again (nested computations: a product inside a division).
#[inline]
pub fn enter(_name: &'static str) -> PhaseGuard {
    #[cfg(feature = "test-hooks")]
    {
        let prev = hooks::current();
        hooks::set_phase(_name);
        PhaseGuard { prev }
    }
    #[cfg(not(feature = "test-hooks"))]
    PhaseGuard {}
}

/// See [`enter`].
pub struct PhaseGuard {
    #[cfg(feature = "test-hooks")]
    prev: &'static str,
}

#[cfg(feature = "test-hooks")]
impl Drop for PhaseGuard {
    fn drop(&mut self) {
        hooks::set_phase(self.prev);
    }
}

/// Test hooks (feature `test-hooks`, for tests only): every check is
/// counted, per phase; [`hooks::arm_after`] requests Stop at the k-th check
/// from now, so a test can interrupt a chosen phase of a computation.
#[cfg(feature = "test-hooks")]
pub mod hooks {
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed};
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    const MAX_PHASES: usize = 32;
    static NAMES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    static CURRENT: AtomicUsize = AtomicUsize::new(0);
    static COUNTS: [AtomicU64; MAX_PHASES] = [const { AtomicU64::new(0) }; MAX_PHASES];
    static TOTAL: AtomicU64 = AtomicU64::new(0);
    static ARMED: AtomicU64 = AtomicU64::new(0);
    static STOPPED: AtomicUsize = AtomicUsize::new(0);
    static TRACING: AtomicBool = AtomicBool::new(false);
    static TRACE: Mutex<Vec<u8>> = Mutex::new(Vec::new());
    static LAST_NS: AtomicU64 = AtomicU64::new(0);
    static MAX_GAP_NS: AtomicU64 = AtomicU64::new(0);

    fn now_ns() -> u64 {
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_nanos() as u64
    }

    pub(crate) fn count() {
        let cur = CURRENT.load(Relaxed);
        COUNTS[cur].fetch_add(1, Relaxed);
        let t = TOTAL.fetch_add(1, Relaxed) + 1;
        if TRACING.load(Relaxed) {
            TRACE.lock().unwrap_or_else(|e| e.into_inner()).push(cur as u8);
            let n = now_ns();
            let last = LAST_NS.swap(n, Relaxed);
            if last != 0 {
                MAX_GAP_NS.fetch_max(n - last, Relaxed);
            }
        }
        let a = ARMED.load(Relaxed);
        if a != 0 && t >= a && !super::REQUESTED.load(Relaxed) {
            STOPPED.store(cur, Relaxed);
            super::request();
        }
    }

    /// Record the phase of every check (and the longest time between two
    /// checks) until [`reset`].
    pub fn trace() {
        TRACE.lock().unwrap_or_else(|e| e.into_inner()).clear();
        LAST_NS.store(0, Relaxed);
        MAX_GAP_NS.store(0, Relaxed);
        TRACING.store(true, Relaxed);
    }

    /// The (1-based) indices of the traced checks made in phase `name`.
    pub fn traced(name: &str) -> Vec<u64> {
        let names = NAMES.lock().unwrap_or_else(|e| e.into_inner());
        let Some(i) = names.iter().position(|&n| n == name) else { return vec![] };
        let tr = TRACE.lock().unwrap_or_else(|e| e.into_inner());
        tr.iter().enumerate().filter(|x| *x.1 as usize == i + 1).map(|x| x.0 as u64 + 1).collect()
    }

    /// The longest wall time between two traced checks, in nanoseconds.
    pub fn max_gap_ns() -> u64 {
        MAX_GAP_NS.load(Relaxed)
    }

    /// The phase that was current when an armed Stop was requested.
    pub fn stopped_in() -> &'static str {
        let i = STOPPED.load(Relaxed);
        if i == 0 {
            return "";
        }
        NAMES.lock().unwrap_or_else(|e| e.into_inner()).get(i - 1).copied().unwrap_or("")
    }

    pub(crate) fn set_phase(name: &'static str) {
        let mut names = NAMES.lock().unwrap_or_else(|e| e.into_inner());
        let i = match names.iter().position(|&n| n == name) {
            Some(i) => i,
            None if names.len() + 1 < MAX_PHASES => {
                names.push(name);
                names.len() - 1
            }
            None => MAX_PHASES - 2,
        };
        // (index 0 of COUNTS is shared by "no phase" and the first name:
        // names start at 1)
        CURRENT.store(i + 1, Relaxed);
    }

    /// Forget the counts, the phase and any arming.
    pub fn reset() {
        CURRENT.store(0, Relaxed);
        TOTAL.store(0, Relaxed);
        ARMED.store(0, Relaxed);
        STOPPED.store(0, Relaxed);
        TRACING.store(false, Relaxed);
        for c in COUNTS.iter() {
            c.store(0, Relaxed);
        }
    }

    /// Request Stop at the k-th check from now (k >= 1).
    pub fn arm_after(k: u64) {
        ARMED.store(TOTAL.load(Relaxed) + k.max(1), Relaxed);
    }

    /// Request Stop at the check with this (1-based) index since the last
    /// reset.
    pub fn arm_at(index: u64) {
        ARMED.store(index.max(1), Relaxed);
    }

    /// The checks counted since the last reset.
    pub fn total() -> u64 {
        TOTAL.load(Relaxed)
    }

    /// The current phase's name ("" before any).
    pub fn current() -> &'static str {
        let i = CURRENT.load(Relaxed);
        if i == 0 {
            return "";
        }
        NAMES.lock().unwrap_or_else(|e| e.into_inner()).get(i - 1).copied().unwrap_or("")
    }

    /// The checks counted in each named phase since the last reset.
    pub fn counts() -> Vec<(&'static str, u64)> {
        let names = NAMES.lock().unwrap_or_else(|e| e.into_inner());
        names.iter().enumerate().map(|(i, &n)| (n, COUNTS[i + 1].load(Relaxed))).filter(|x| x.1 > 0).collect()
    }
}

#[cold]
#[inline(never)]
fn interrupt() -> ! {
    std::panic::panic_any(Interrupted)
}

/// Run `f`; an interruption inside it becomes `Err(Interrupted)`.
pub fn catch<T>(f: impl FnOnce() -> T) -> Result<T, Interrupted> {
    quiet_hook();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(v) => Ok(v),
        Err(p) if p.is::<Interrupted>() => Err(Interrupted),
        Err(p) => std::panic::resume_unwind(p),
    }
}

/// The default panic hook prints "thread panicked at ..." for every panic;
/// an interruption is not an error, so it prints nothing.
fn quiet_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !info.payload().is::<Interrupted>() {
                prev(info)
            }
        }));
    });
}

// ---- the WebAssembly host's flag

#[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
#[link(wasm_import_module = "sagebrush")]
extern "C" {
    fn interrupted() -> i32;
}

#[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
static POLLS: AtomicU32 = AtomicU32::new(0);

#[inline]
fn poll_host() {
    #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
    {
        if POLLS.fetch_add(1, Relaxed) % 1024 == 0 && unsafe { interrupted() } != 0 {
            REQUESTED.store(true, Relaxed);
        }
    }
}

#[inline]
fn poll_host_now() {
    #[cfg(all(target_arch = "wasm32", feature = "wasm-host"))]
    {
        if unsafe { interrupted() } != 0 {
            REQUESTED.store(true, Relaxed);
        }
    }
}

// ---- Ctrl-C during a native call

static PRESSES: AtomicU32 = AtomicU32::new(0);

/// Routes Ctrl-C to [`request`] while it lives; the previous handler is
/// restored on drop.  Hold it only on the main thread, around a call.
pub struct SigintGuard {
    #[cfg(unix)]
    old: libc::sigaction,
}

#[cfg(unix)]
extern "C" fn on_sigint(_: libc::c_int) {
    // async-signal-safe: atomics, and on the third press the default action
    REQUESTED.store(true, Relaxed);
    if PRESSES.fetch_add(1, Relaxed) + 1 >= 3 {
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::raise(libc::SIGINT);
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
}

#[cfg(windows)]
unsafe extern "system" fn on_ctrl(kind: u32) -> i32 {
    // CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1; anything else goes on
    if kind <= 1 {
        REQUESTED.store(true, Relaxed);
        PRESSES.fetch_add(1, Relaxed);
        1
    } else {
        0
    }
}

impl SigintGuard {
    pub fn new() -> SigintGuard {
        clear();
        #[cfg(unix)]
        unsafe {
            let mut new: libc::sigaction = std::mem::zeroed();
            new.sa_sigaction = on_sigint as extern "C" fn(libc::c_int) as usize;
            libc::sigemptyset(&mut new.sa_mask);
            let mut old: libc::sigaction = std::mem::zeroed();
            libc::sigaction(libc::SIGINT, &new, &mut old);
            SigintGuard { old }
        }
        #[cfg(windows)]
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), 1);
            SigintGuard {}
        }
        #[cfg(not(any(unix, windows)))]
        SigintGuard {}
    }
}

impl Default for SigintGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SigintGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::sigaction(libc::SIGINT, &self.old, std::ptr::null_mut());
        }
        #[cfg(windows)]
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), 0);
        }
        clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_unwinds_and_catch_reports() {
        clear();
        assert_eq!(catch(|| 7), Ok(7));
        let mut dropped = false;
        struct D<'a>(&'a mut bool);
        impl Drop for D<'_> {
            fn drop(&mut self) {
                *self.0 = true;
            }
        }
        let r = catch(|| {
            let _d = D(&mut dropped);
            for i in 0.. {
                if i == 1000 {
                    request();
                }
                check();
            }
        });
        assert_eq!(r, Err(Interrupted));
        assert!(dropped, "destructors run on the way out");
        clear();
        assert!(!requested());
        // other panics pass through
        let other = std::panic::catch_unwind(|| catch(|| panic!("a bug")));
        assert!(other.is_err());
        // check_coarse unwinds in the same way (in this one test: the flag
        // is global to the process)
        let r = catch(|| {
            for i in 0.. {
                if i == 3 {
                    request();
                }
                check_coarse();
            }
        });
        assert_eq!(r, Err(Interrupted));
        clear();
        assert_eq!(catch(check_coarse), Ok(()));
    }
}
