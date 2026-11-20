//! What is known about an engine operation's cost before it runs, and the
//! meter that checks it as it runs (the engine cost policy).
//!
//! - $L$ (`mem_lower`, `work_lower`): rigorous lower bounds, the only
//!   grounds for refusing before starting: memory against what is
//!   available, work (through the calibration) against the user's time
//!   budget.
//! - $E$ (`work_estimate`): an estimate in meter units; the per-op error
//!   factor $k$ and the units-to-seconds tables live with the calibration,
//!   keyed by op.  `None` until the harness has measured $k$.
//! - $U$ (`work_upper`): a proven upper bound where one is cheap.  It never
//!   refuses: an operation runs on a [`Meter::accounting`] meter with $U$ as
//!   its limit, and passing it is an accounting bug, not a budget.
//!
//! Every figure is computed in checked arithmetic.  A lower bound that would
//! overflow is replaced by 0 (still a lower bound); an upper bound that
//! would overflow becomes `None` (no promise); a byte count the operation
//! must reserve that overflows means it cannot fit (a memory refusal).

pub use crate::coprime::{accounting_overruns, Meter};

/// What is known about an operation's cost before it runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cost {
    /// $L$: a rigorous lower bound on the peak bytes.
    pub mem_lower: u64,
    /// $L$: a rigorous lower bound on the work, in meter units.
    pub work_lower: u64,
    /// $E$: the estimated work in meter units (`None` until calibrated).
    pub work_estimate: Option<u64>,
    /// $U$: a proven upper bound on the work in meter units, where cheap.
    pub work_upper: Option<u64>,
}
