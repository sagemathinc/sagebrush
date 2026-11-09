//! A call's failure, sticky (design/mpmath-core.md §4.5): the first refusal
//! (a number over the limb limit, an allocation the heap refused) or
//! exception the reference raises (ZeroDivisionError, ComplexResult, ...)
//! is recorded here, and the arithmetic goes on infallibly, every number
//! made after it zero.  `checked` runs a call and returns that first
//! failure instead of its value: nothing computed after a failure leaves the
//! core.  Every loop whose length doesn't shrink with its numbers checks
//! `failed()`, so a failed call ends promptly.

use crate::Fail;
use std::cell::Cell;

thread_local! {
    static FAILED: Cell<Option<Fail>> = const { Cell::new(None) };
}

/// Record a failure (the call's first one stands).
#[cold]
#[inline(never)]
pub fn raise(f: Fail) {
    FAILED.with(|c| {
        if c.get().is_none() {
            c.set(Some(f))
        }
    })
}

/// Has the call failed?
pub fn failed() -> bool {
    FAILED.with(|c| c.get().is_some())
}

/// Run a call: its value, or its first failure.
pub fn checked<T>(f: impl FnOnce() -> T) -> Result<T, Fail> {
    FAILED.with(|c| c.set(None));
    let v = f();
    match FAILED.with(|c| c.take()) {
        Some(e) => Err(e),
        None => Ok(v),
    }
}

/// The over-limit failure for a size that can't even be counted.
#[cold]
#[inline(never)]
pub fn too_big() {
    raise(Fail::Limit { limbs: u64::MAX })
}
