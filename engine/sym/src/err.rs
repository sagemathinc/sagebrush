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

/// Silence the default panic message for SymError payloads (they are
/// ordinary errors, not bugs).
pub fn install_quiet_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if info.payload().downcast_ref::<SymError>().is_none() {
                prev(info);
            }
        }));
    });
}
