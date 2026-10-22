//! The resource budget of one factorization call (plan r3, sections 5.1
//! and 5.3): one work remainder, in limb operations (a limb is 64 bits),
//! and one live-memory reservation, in bytes, shared by every phase,
//! square-free part, precision level and nested call.  Long-running
//! helpers debit the work before they run; data that grows with the input
//! is reserved before it is allocated, by a guard that releases it when
//! dropped (also when an interrupt or a refusal unwinds the call).
//! Exhausting either gives [`FactorLimit`], an error: never a partial or
//! unfactored "success".
//!
//! All size and work arithmetic is checked; an overflow is a refusal.

use std::cell::Cell;
use std::fmt;

/// The phases of a factorization, for refusals and the tests' debit log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Admission,
    Squarefree,
    Modular,
    Hensel,
    Prepass,
    Zassenhaus,
    Cld,
    Lattice,
    Lll,
    Echelon,
    Reconstruct,
    Fallback,
}

pub const PHASES: usize = 12;

impl Phase {
    fn index(self) -> usize {
        self as usize
    }
    pub fn name(self) -> &'static str {
        match self {
            Phase::Admission => "admission",
            Phase::Squarefree => "square-free decomposition",
            Phase::Modular => "modular factorization",
            Phase::Hensel => "Hensel lifting",
            Phase::Prepass => "small-subset pre-pass",
            Phase::Zassenhaus => "subset recombination",
            Phase::Cld => "CLD columns",
            Phase::Lattice => "lattice",
            Phase::Lll => "LLL",
            Phase::Echelon => "echelon",
            Phase::Reconstruct => "reconstruction",
            Phase::Fallback => "fallback recombination",
        }
    }
}

/// A refusal: a resource limit was reached; nothing was factored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactorLimit {
    pub phase: Phase,
    pub what: &'static str,
    pub need: u64,
    pub remaining: u64,
}

impl fmt::Display for FactorLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "factor: resource limit exceeded ({} in {}: {} > {}); not factored",
            self.what,
            self.phase.name(),
            self.need,
            self.remaining
        )
    }
}

impl std::error::Error for FactorLimit {}

pub type FResult<T> = Result<T, FactorLimit>;

/// The default limits of one public call (plan r3, section 5.1).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// The aggregate work, in limb operations.
    pub work: u64,
    /// The aggregate live memory, in bytes.
    pub memory: u64,
    /// Short-circuits, also charged to `work`.
    pub subsets: u64,
    pub divisions: u64,
    /// Input admission.
    pub max_degree: usize,
    pub max_coeff_bits: u64,
    pub max_total_bits: u64,
}

impl Limits {
    /// Provisional: the work constant awaits the VM 1 calibration (native
    /// and wasm, from the slowest measured throughput per charged unit),
    /// which will pin it with a test; no wall-clock bound is claimed yet.
    pub const DEFAULT: Limits = Limits {
        work: 1 << 36,
        memory: 512 << 20,
        subsets: 1 << 20,
        divisions: 4096,
        max_degree: 10_000,
        max_coeff_bits: 1 << 20,
        max_total_bits: 1 << 24,
    };
    /// No limits (factor_mod and squarefree for other crates, as before).
    pub const UNLIMITED: Limits = Limits {
        work: u64::MAX,
        memory: u64::MAX,
        subsets: u64::MAX,
        divisions: u64::MAX,
        max_degree: usize::MAX,
        max_coeff_bits: u64::MAX,
        max_total_bits: u64::MAX,
    };
}

/// The budget of one call.  Shared by reference (interior mutability), so
/// reservation guards can live alongside other borrows.
pub struct Budget {
    limits: Limits,
    work: Cell<u64>,
    live: Cell<u64>,
    subsets: Cell<u64>,
    divisions: Cell<u64>,
    phase: Cell<Phase>,
    /// Debits per phase (for the tests' coverage log; also cheap).
    debits: [Cell<u64>; PHASES],
    peak: Cell<u64>,
}

thread_local! {
    static DEFAULT_OVERRIDE: Cell<Option<Limits>> = const { Cell::new(None) };
}

impl Default for Budget {
    /// Limits::DEFAULT, or the limits of an enclosing with_default_limits
    /// on this thread.
    fn default() -> Budget {
        Budget::new(DEFAULT_OVERRIDE.with(|o| o.get()).unwrap_or(Limits::DEFAULT))
    }
}

/// Run f with `limits` as the default of every call on this thread that
/// makes its own budget (try_factor and the callers built on it): for
/// tests of how callers propagate refusals, and for callers that want
/// tighter limits.  The previous default is restored afterwards, also when
/// f unwinds.
pub fn with_default_limits<T>(limits: Limits, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<Limits>);
    impl Drop for Restore {
        fn drop(&mut self) {
            DEFAULT_OVERRIDE.with(|o| o.set(self.0));
        }
    }
    let _r = Restore(DEFAULT_OVERRIDE.with(|o| o.replace(Some(limits))));
    f()
}

impl Budget {
    pub fn new(limits: Limits) -> Budget {
        Budget {
            limits,
            work: Cell::new(limits.work),
            live: Cell::new(0),
            subsets: Cell::new(limits.subsets),
            divisions: Cell::new(limits.divisions),
            phase: Cell::new(Phase::Admission),
            debits: Default::default(),
            peak: Cell::new(0),
        }
    }

    pub fn unlimited() -> Budget {
        Budget::new(Limits::UNLIMITED)
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn phase(&self) -> Phase {
        self.phase.get()
    }

    /// The work left, in limb operations.
    pub fn work_left(&self) -> u64 {
        self.work.get()
    }

    /// The live reservation now and its peak, in bytes.
    pub fn live(&self) -> u64 {
        self.live.get()
    }
    pub fn peak(&self) -> u64 {
        self.peak.get()
    }

    /// How many debits each phase made (the tests' coverage log).
    pub fn debit_counts(&self) -> [u64; PHASES] {
        let mut out = [0; PHASES];
        for (o, c) in out.iter_mut().zip(&self.debits) {
            *o = c.get();
        }
        out
    }
    pub fn debited(&self, p: Phase) -> bool {
        self.debits[p.index()].get() > 0
    }

    /// Enter a phase until the guard drops.
    pub fn enter(&self, p: Phase) -> PhaseGuard<'_> {
        let prev = self.phase.replace(p);
        PhaseGuard { b: self, prev }
    }

    pub fn refuse(&self, what: &'static str, need: u64, remaining: u64) -> FactorLimit {
        FactorLimit { phase: self.phase.get(), what, need, remaining }
    }

    /// Debit `units` limb operations (computed by the caller with checked
    /// arithmetic: pass the Option from a checked chain).
    pub fn debit(&self, units: Option<u64>) -> FResult<()> {
        sagebrush_interrupt::check();
        let left = self.work.get();
        let units = units.ok_or_else(|| self.refuse("work (overflow)", u64::MAX, left))?;
        let c = &self.debits[self.phase.get().index()];
        c.set(c.get().saturating_add(1));
        if units > left {
            return Err(self.refuse("work", units, left));
        }
        self.work.set(left - units);
        Ok(())
    }

    /// One subset candidate (a short-circuit; the caller also debits work).
    pub fn take_subset(&self) -> FResult<()> {
        let n = self.subsets.get();
        if n == 0 {
            return Err(self.refuse("subset candidates", 1, 0));
        }
        self.subsets.set(n - 1);
        Ok(())
    }

    /// One exact trial division (a short-circuit; the caller also debits).
    pub fn take_division(&self) -> FResult<()> {
        let n = self.divisions.get();
        if n == 0 {
            return Err(self.refuse("trial divisions", 1, 0));
        }
        self.divisions.set(n - 1);
        Ok(())
    }

    /// Reserve `bytes` of live memory before allocating them; released when
    /// the guard drops.
    pub fn reserve(&self, bytes: Option<u64>) -> FResult<Reservation<'_>> {
        let live = self.live.get();
        let room = self.limits.memory.saturating_sub(live);
        let bytes = bytes.ok_or_else(|| self.refuse("memory (overflow)", u64::MAX, room))?;
        if bytes > room {
            return Err(self.refuse("memory", bytes, room));
        }
        self.live.set(live + bytes);
        if live + bytes > self.peak.get() {
            self.peak.set(live + bytes);
        }
        Ok(Reservation { b: self, bytes })
    }
}

/// Restores the previous phase when dropped.
pub struct PhaseGuard<'a> {
    b: &'a Budget,
    prev: Phase,
}

impl Drop for PhaseGuard<'_> {
    fn drop(&mut self) {
        self.b.phase.set(self.prev);
    }
}

/// Reserved live memory; released when dropped.
pub struct Reservation<'a> {
    b: &'a Budget,
    bytes: u64,
}

impl Reservation<'_> {
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.b.live.set(self.b.live.get() - self.bytes);
    }
}

// ------------------------------------------------------------------ the byte and work models

/// Limbs of a b-bit integer (at least 1).
pub fn limbs(bits: u64) -> u64 {
    bits.div_ceil(64).max(1)
}

/// Bytes charged for one big integer of `bits` bits: twice its limbs (an
/// integer grown in place, an accumulator, can hold up to about twice the
/// capacity it needs) plus its header.
pub fn big_bytes(bits: u64) -> Option<u64> {
    limbs(bits).checked_mul(16)?.checked_add(32)
}

/// Bytes charged for a vector of `len` big integers of `bits` bits each
/// (twice the length: capacity doubling while pushing), plus its header
/// and the slot of a reservation-carrying holder in an outer vector.
pub fn poly_bytes(len: u64, bits: u64) -> Option<u64> {
    len.checked_mul(2)?.checked_mul(big_bytes(bits)?)?.checked_add(64)
}

/// Bytes charged for a vector of `len` words.
pub fn words_bytes(len: u64) -> Option<u64> {
    len.checked_mul(16)?.checked_add(24)
}

/// Work of a schoolbook product of polynomials with `la`, `lb` coefficients
/// of `ba`, `bb` bits.
pub fn mul_work(la: u64, ba: u64, lb: u64, bb: u64) -> Option<u64> {
    la.max(1).checked_mul(lb.max(1))?.checked_mul(limbs(ba))?.checked_mul(limbs(bb))
}

/// Work of a schoolbook division of a (`la` coefficients, `ba` bits) by b
/// (`lb`, `bb`).
pub fn div_work(la: u64, ba: u64, lb: u64, bb: u64) -> Option<u64> {
    let q = la.saturating_sub(lb) + 1;
    let l = limbs(ba).checked_add(limbs(bb))?;
    q.checked_mul(lb.max(1))?.checked_mul(l.checked_mul(l)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_and_memory_are_aggregate() {
        let b = Budget::new(Limits { work: 100, memory: 1000, ..Limits::DEFAULT });
        {
            let _p = b.enter(Phase::Hensel);
            b.debit(Some(60)).unwrap();
        }
        let _p = b.enter(Phase::Lll);
        // fits alone, not after the first debit
        let e = b.debit(Some(60)).unwrap_err();
        assert_eq!((e.phase, e.what, e.need, e.remaining), (Phase::Lll, "work", 60, 40));
        assert!(b.debited(Phase::Hensel) && b.debited(Phase::Lll) && !b.debited(Phase::Cld));
        // two reservations that fit alone but not together
        let r1 = b.reserve(Some(600)).unwrap();
        assert!(b.reserve(Some(600)).is_err());
        drop(r1);
        let _r2 = b.reserve(Some(600)).unwrap();
        assert_eq!(b.live(), 600);
        // overflow is a refusal
        assert!(b.debit(None).is_err());
        assert!(b.reserve(None).is_err());
        assert!(e.to_string().starts_with("factor: resource limit exceeded (work in LLL: 60 > 40)"));
    }

    #[test]
    fn reservations_release_on_unwind() {
        let b = Budget::new(Limits { memory: 1000, ..Limits::DEFAULT });
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = b.reserve(Some(900)).unwrap();
            panic!("unwind");
        }));
        assert!(r.is_err());
        assert_eq!(b.live(), 0);
        assert_eq!(b.phase(), Phase::Admission);
    }
}
