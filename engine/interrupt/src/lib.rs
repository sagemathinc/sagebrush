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
    if REQUESTED.load(Relaxed) {
        interrupt()
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
    }
}
