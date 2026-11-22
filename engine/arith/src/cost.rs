//! What is known about an engine operation's cost before it runs, and the
//! meter that checks it as it runs (the engine cost policy).
//!
//! - $L$ (`mem_lower`, `work_lower`): rigorous lower bounds, the only
//!   grounds for refusing before starting: memory against what is
//!   available, work (through the calibration) against the user's time
//!   budget.
//! - $E$ (`work_estimate`): an estimate in meter units, per [`Family`] of
//!   primitive (the units-to-seconds rates are per family and per target;
//!   the per-op error factor $k$ lives with the calibration, keyed by op).
//!   `None` until the harness has measured $k$.
//! - $U$ (`work_upper`): a proven upper bound where one is cheap.  It never
//!   refuses: an operation runs on a [`Meter::accounting`] meter with $U$ as
//!   its limit, and passing it is an accounting bug, not a budget.
//!
//! Every figure is computed in checked arithmetic.  A lower bound that would
//! overflow is replaced by 0 (still a lower bound); an upper bound that
//! would overflow becomes `None` (no promise); a byte count the operation
//! must reserve that overflows means it cannot fit (a memory refusal).

pub use crate::coprime::{accounting_overruns, Meter};
pub use tally::{bigdiv_units, bigeuclid_units, biggcd_units, bigmul_units, bigsqrt_units, metered, metered_with, publish_progress, tally, tally_all, tallied, Local, Progress};

mod tally;

/// The families of primitive work a meter counts separately: their
/// units convert to seconds at different rates.  A charge site names its
/// family as a constant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum Family {
    /// Schoolbook products (limbs, and multiply-adds mod p).
    MulSchool,
    /// NTT transforms and pointwise products.
    MulNtt,
    /// Knuth D and Möller–Granlund steps, one-limb divisions.
    Div,
    /// Newton inversion and division.
    DivNewton,
    /// Lehmer windows and cosequences.
    Gcd,
    /// Loads, copies, clears, normalisation.
    Move,
    /// Reductions mod p (nmod, CRT).
    ModArith,
    /// Linear limb addition and subtraction with carry (one carry chain;
    /// not a copy's speed).
    AddSub,
    /// A reply walk: one unit per output token, formatting included.
    Walk,
    /// The rest (kept small: untagged charge sites count here).
    Other,
}

/// The number of [`Family`] values.
pub const FAMILIES: usize = 10;

const _: () = assert!(Family::Other as usize + 1 == FAMILIES);

/// Meter units per [`Family`] (deterministic from the inputs).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Units(pub [u64; FAMILIES]);

impl Units {
    /// The units of one family.
    pub fn get(&self, f: Family) -> u64 {
        self.0[f as usize]
    }
    /// Adds `o`, family by family (wrapping, like the tally).
    pub fn add(&mut self, o: &Units) {
        for (x, &y) in self.0.iter_mut().zip(&o.0) {
            *x = x.wrapping_add(y);
        }
    }
    /// Adds `o`, family by family, saturating (for the work estimates: a
    /// wrapped estimate would read as small).
    pub fn add_saturating(&mut self, o: &Units) {
        for (x, &y) in self.0.iter_mut().zip(&o.0) {
            *x = x.saturating_add(y);
        }
    }
    /// The total, or `None` if it overflows u64.
    pub fn total(&self) -> Option<u64> {
        self.0.iter().try_fold(0u64, |t, &u| t.checked_add(u))
    }
}

/// The product of sizes in u64, saturating: for the work estimates'
/// models, where a usize product could wrap (on 32-bit targets first)
/// and a wrapped estimate would read as small.
pub fn size_product(xs: &[usize]) -> u64 {
    xs.iter().fold(1u64, |p, &x| p.saturating_mul(x as u64))
}

/// What is known about an operation's cost before it runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cost {
    /// $L$: a rigorous lower bound on the peak bytes.
    pub mem_lower: u64,
    /// $L$: a rigorous lower bound on the work, in meter units.
    pub work_lower: u64,
    /// $E$: the estimated work in meter units, per family (`None` until
    /// calibrated).
    pub work_estimate: Option<Units>,
    /// $U$: a proven upper bound on the work in meter units, where cheap.
    pub work_upper: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_estimates_sums_and_products_saturate() {
        // past usize on 32-bit targets, exact in u64
        assert_eq!(size_product(&[1 << 20, 1 << 20, 3]), 3 << 40);
        assert_eq!(size_product(&[]), 1);
        assert_eq!(size_product(&[usize::MAX, usize::MAX, 2]), u64::MAX);
        let mut u = Units([u64::MAX - 1; FAMILIES]);
        u.add_saturating(&Units([2; FAMILIES]));
        assert_eq!(u, Units([u64::MAX; FAMILIES]));
    }
}
