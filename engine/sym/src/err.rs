//! Errors in symbolic computation.  Arithmetic deep inside a simplifier
//! (a division by zero, say) unwinds with a typed payload, which the API
//! entry points ([`catch`]) turn into an `Err`, the way Ctrl-C is handled
//! (engine/interrupt).

use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum SymError {
    DivisionByZero,
    /// An operation that does not apply (with a message for the user).
    Value(String),
    /// Not implemented (yet).
    NotImplemented(String),
}

impl fmt::Display for SymError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            SymError::DivisionByZero => write!(f, "Symbolic division by zero"),
            SymError::Value(s) => write!(f, "{}", s),
            SymError::NotImplemented(s) => write!(f, "{}", s),
        }
    }
}

pub fn throw(e: SymError) -> ! {
    std::panic::panic_any(e)
}

pub fn value_error(msg: impl Into<String>) -> ! {
    throw(SymError::Value(msg.into()))
}

pub fn not_implemented(msg: impl Into<String>) -> ! {
    throw(SymError::NotImplemented(msg.into()))
}

pub type R<T> = Result<T, SymError>;

thread_local! {
    static SOFT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Run f with division by zero giving unsigned infinity instead of an
/// error: for algorithms that inspect what a substitution gives (limits,
/// checking solutions).  Errors must not need unwinding to be recovered,
/// since in WebAssembly a panic aborts.
pub fn soft<T>(f: impl FnOnce() -> T) -> T {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            SOFT.with(|s| s.set(s.get() - 1));
        }
    }
    SOFT.with(|s| s.set(s.get() + 1));
    let _g = Guard;
    f()
}

pub fn soft_division() -> bool {
    SOFT.with(|s| s.get() > 0)
}

/// Run f, turning a thrown SymError into Err (other panics, including
/// Ctrl-C's, continue to unwind).
pub fn catch<T>(f: impl FnOnce() -> T) -> Result<T, SymError> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(v) => Ok(v),
        Err(p) => match p.downcast::<SymError>() {
            Ok(e) => Err(*e),
            Err(p) => std::panic::resume_unwind(p),
        },
    }
}

static LAST: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

/// The last SymError raised (kind, message): where panics abort (in
/// WebAssembly), the host reads it after the trap.
pub fn take_last_error() -> Option<(String, String)> {
    LAST.lock().ok().and_then(|mut l| l.take())
}

/// Silence the default panic message for SymError payloads (they are
/// ordinary errors, not bugs), and remember the error.
pub fn install_quiet_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            match info.payload().downcast_ref::<SymError>() {
                Some(e) => {
                    let kind = match e {
                        SymError::DivisionByZero => "ZeroDivisionError",
                        SymError::Value(_) => "ValueError",
                        SymError::NotImplemented(_) => "NotImplementedError",
                    };
                    if let Ok(mut l) = LAST.try_lock() {
                        *l = Some((kind.to_string(), e.to_string()));
                    }
                }
                None => prev(info),
            }
        }));
    });
}
