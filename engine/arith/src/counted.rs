//! Tests only: the word operations the series ops' loops perform, counted
//! where they happen, so the tests can check them against the closed-form
//! work bounds the ops are admitted with (zseries.rs).  Outside tests,
//! `add` is nothing.

#[cfg(test)]
thread_local! {
    static UNITS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[inline(always)]
pub(crate) fn add(n: u64) {
    #[cfg(test)]
    UNITS.with(|c| c.set(c.get().saturating_add(n)));
    let _ = n;
}

/// The units counted on this thread since the last call, then zero.
#[cfg(test)]
pub(crate) fn take() -> u64 {
    UNITS.with(|c| c.replace(0))
}
