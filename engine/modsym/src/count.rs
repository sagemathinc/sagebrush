//! Meter units for the twisted traces' kernels (the engine's metering
//! rules: each kernel counts its own work, once, where it does it).  The
//! kernels add to an explicit `Units`, not to the thread's tally, since
//! some run in parallel jobs: a job returns its units, and the caller adds
//! them to its `cost::Local` at the join, on its own thread, so nothing is
//! lost to a worker thread or counted twice.
//!
//! Families: ModArith, one unit per reduced operation mod ell (a product
//! a b mod ell, a sum reduced mod ell); MulSchool, one per multiply-add
//! whose reduction is delayed (u128 accumulation); Move, one per word
//! copied or written without arithmetic.

use sagebrush_arith::cost::{Family, Local, Units};

/// Adds `x` units of family `f`.
#[inline]
pub(crate) fn n(u: &mut Units, f: Family, x: u64) {
    let a = &mut u.0[f as usize];
    *a = a.saturating_add(x);
}

/// The units of `powmod(_, e, ell)`: a squaring and at most one product per
/// bit of e.
#[inline]
pub(crate) fn pow(u: &mut Units, e: u64) {
    n(u, Family::ModArith, 2 * u64::from(64 - e.leading_zeros()));
}

/// Where a kernel's units go at its Stop checks: a `Local` (added and
/// flushed to the thread's tally, so a Stop charges exactly the work
/// before its check), or a job's `Units` (returned to the caller, who adds
/// them at the join).
pub(crate) trait Sink {
    fn put(&mut self, u: Units);
}

impl Sink for Local {
    fn put(&mut self, u: Units) {
        self.add(u);
        self.flush();
    }
}

impl Sink for Units {
    fn put(&mut self, u: Units) {
        self.add(&u);
    }
}
