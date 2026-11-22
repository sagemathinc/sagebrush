//! Units counted where the work happens and charged to a [`Meter`] at the
//! API boundary.
//!
//! - Each kernel adds its exact work to a thread-local per-family counter
//!   ([`tally`]), once, at the innermost kernel that does it: a caller of
//!   a counting kernel (nmod_poly, nmod_mat, the NTT) does not count that
//!   work again.  Each site's doc says what it counts.  bigint's
//!   transforms keep their own counter (butterflies and pointwise
//!   products, reductions, zero fills: MulNtt, ModArith, Move), read
//!   through [`tallied`].
//! - BigInt arithmetic is counted through [`bigmul_units`],
//!   [`bigdiv_units`], [`bigeuclid_units`], [`biggcd_units`] and
//!   [`bigsqrt_units`] only, never inline formulas.
//! - Code outside the kernels counts in a [`Local`], flushed at its
//!   existing Stop checks and when dropped.
//! - A site uses either an explicit [`Meter`] or the tally, never both.
//!   Code that runs an explicit meter inside a region adds its units to the
//!   tally when done (`tally_all(&inner.units().0)`), or they are lost to
//!   the region.  That merge is only for explicit `add_in` meters (whose
//!   units never went through the tally): a meter charged by [`metered`]
//!   is never merged back, or its work would count twice.
//! - The tally is cumulative, whether or not a region is open.
//!   [`metered`], the only path from the tally to a meter, charges the
//!   per-family difference across one call to the caller's accounting
//!   meter, from a Drop guard (so work done before a Stop, a panic or an
//!   early return is still charged).  Regions nest: each charges its own
//!   meter with the work in its span, and only the outermost publishes
//!   progress at the polls.
//! - The counters are thread-locals: work done on another thread inside a
//!   region is NOT counted (the documented limit; a test shows it).  The
//!   metered kernels are single-threaded; a future parallel caller sums
//!   per-thread counts at its join.
//! - Progress: at the kernels' existing Stop polls (every 2^16 units), the
//!   outermost region's running difference is published to its
//!   [`Progress`] cell, which another thread (the UI, the host) can read.

use super::{Family, Meter, Units, FAMILIES};
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

thread_local! {
    static COUNT: Cell<[u64; FAMILIES]> = const { Cell::new([0; FAMILIES]) };
    static REGION: RefCell<Option<Region>> = const { RefCell::new(None) };
}

/// The outermost region on this thread: its starting counts and its
/// progress cell, if any.
struct Region {
    start: Units,
    progress: Option<Arc<Progress>>,
}

/// A region's running units, per family, readable from any thread while
/// the region runs (updated at the kernels' Stop polls, and at the end).
#[derive(Debug, Default)]
pub struct Progress(pub [AtomicU64; FAMILIES]);

impl Progress {
    pub fn new() -> Arc<Progress> {
        Arc::new(Progress::default())
    }
    /// The units published so far.
    pub fn units(&self) -> Units {
        let mut u = [0; FAMILIES];
        for (x, a) in u.iter_mut().zip(&self.0) {
            *x = a.load(Relaxed);
        }
        Units(u)
    }
    fn publish(&self, u: &Units) {
        for (a, &x) in self.0.iter().zip(&u.0) {
            a.store(x, Relaxed);
        }
    }
}

/// Adds `n` units of family `f` to this thread's counter (cumulative,
/// wrapping).  A kernel with a loop counts in a local accumulator and adds
/// it here once per call (and at its Stop polls), not once per row.
#[inline]
pub fn tally(f: Family, n: u64) {
    COUNT.with(|c| {
        let mut v = c.get();
        v[f as usize] = v[f as usize].wrapping_add(n);
        c.set(v);
    });
}

/// Adds a whole per-family count to this thread's counter.
#[inline]
pub fn tally_all(acc: &[u64; FAMILIES]) {
    COUNT.with(|c| {
        let mut v = c.get();
        for (x, &a) in v.iter_mut().zip(acc) {
            *x = x.wrapping_add(a);
        }
        c.set(v);
    });
}

/// This thread's cumulative units, per family: the kernels' own counts plus
/// bigint's transforms (cumulative and wrapping; a region's units are the
/// per-family wrapping difference).
pub fn tallied() -> Units {
    let mut u = COUNT.with(|c| c.get());
    let [ntt, red, fill] = sagebrush_bigint::ntt::units();
    u[Family::MulNtt as usize] = u[Family::MulNtt as usize].wrapping_add(ntt);
    u[Family::ModArith as usize] = u[Family::ModArith as usize].wrapping_add(red);
    u[Family::Move as usize] = u[Family::Move as usize].wrapping_add(fill);
    Units(u)
}

fn delta(now: &Units, start: &Units) -> Units {
    let mut d = [0; FAMILIES];
    for (i, x) in d.iter_mut().enumerate() {
        *x = now.0[i].wrapping_sub(start.0[i]);
    }
    Units(d)
}

/// Publishes the outermost region's running units to its progress cell
/// (called at the kernels' Stop polls; nothing without a region or cell).
pub fn publish_progress() {
    REGION.with(|r| {
        if let Some(Region { start, progress: Some(p) }) = &*r.borrow() {
            p.publish(&delta(&tallied(), start));
        }
    });
}

struct Guard<'m> {
    meter: &'m mut Meter,
    start: Units,
    /// Whether this is the thread's outermost region (registered in
    /// REGION, its progress published at the polls).
    outer: bool,
    /// A nested region's progress cell, set at its end.
    nested_progress: Option<Arc<Progress>>,
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let d = delta(&tallied(), &self.start);
        let progress = if self.outer { REGION.with(|r| r.borrow_mut().take()).and_then(|r| r.progress) } else { self.nested_progress.take() };
        if let Some(p) = progress {
            p.publish(&d);
        }
        for (i, &n) in d.0.iter().enumerate() {
            if n > 0 {
                // (an accounting meter never refuses: a charge past its
                // bound is counted, not an error)
                let _ = self.meter.add_at(i, n);
            }
        }
    }
}

/// Runs `f`, charging the work it does on this thread to `meter` (an
/// accounting meter), family by family.  Regions nest: each charges its
/// own meter with the work in its own span (no meter is charged twice: a
/// meter is borrowed by one region at a time), and only the outermost
/// publishes progress at the polls.
pub fn metered<T>(meter: &mut Meter, f: impl FnOnce() -> T) -> T {
    metered_with(meter, None, f)
}

/// [`metered`], publishing the running units to `progress` as it goes (a
/// nested region's cell is set only at its end).
pub fn metered_with<T>(meter: &mut Meter, progress: Option<Arc<Progress>>, f: impl FnOnce() -> T) -> T {
    assert!(meter.is_accounting(), "metered charges after the work: it needs an accounting meter");
    let start = tallied();
    let (outer, nested_progress) = REGION.with(|r| {
        let mut r = r.borrow_mut();
        if r.is_some() {
            (false, progress)
        } else {
            *r = Some(Region { start, progress });
            (true, None)
        }
    });
    let _g = Guard { meter, start, outer, nested_progress };
    f()
}

/// Units of a BigInt product of `la` by `lb` 64-bit limbs: the limb
/// multiply-adds (MulSchool).
pub fn bigmul_units(la: usize, lb: usize) -> Units {
    one(Family::MulSchool, (la as u64).saturating_mul(lb as u64))
}

/// Units of a BigInt division of `la` by `lb` 64-bit limbs: a limb step per
/// quotient limb and divisor limb (Div; also exact divisions).  Like the
/// other helpers, it saturates and never panics, whatever the lengths.
pub fn bigdiv_units(la: usize, lb: usize) -> Units {
    let q = (la.saturating_sub(lb) as u64).saturating_add(1);
    one(Family::Div, q.saturating_mul(lb.max(1) as u64))
}

/// Units of one BigInt Euclid step on `la` and `lb` 64-bit limbs (la >= lb):
/// the division and the cofactor or row update by its quotient, both
/// counted as Gcd (the sum of [`bigdiv_units`] and [`bigmul_units`] of the
/// quotient by `lb`).
pub fn bigeuclid_units(la: usize, lb: usize) -> Units {
    let q = la.saturating_sub(lb).saturating_add(1);
    let n = bigdiv_units(la, lb).total().unwrap_or(u64::MAX).saturating_add(bigmul_units(q, lb).total().unwrap_or(u64::MAX));
    one(Family::Gcd, n)
}

/// Units of a full BigInt gcd of `la` and `lb` 64-bit limbs, in either
/// order, at the operands' actual sizes: about one Euclid step per limb of
/// the smaller (a word of the quotient sequence each), so
/// `bigeuclid_units(max, min)` times `min` (Gcd).  A zero-limb operand
/// costs nothing; callers pass at least one limb per value.
pub fn biggcd_units(la: usize, lb: usize) -> Units {
    let (la, lb) = if la >= lb { (la, lb) } else { (lb, la) };
    let n = bigeuclid_units(la, lb).total().unwrap_or(u64::MAX).saturating_mul(lb as u64);
    one(Family::Gcd, n)
}

/// Units of the check on a BigInt extended gcd's coefficients, x a + y b
/// = g, for operands of `la` and `lb` limbs: the two products (x has about
/// `lb` limbs and multiplies a, y about `la` and multiplies b:
/// `bigmul_units(la, lb)` each, MulSchool) and the sum's compare with g
/// (AddSub, `la + lb`).
pub fn xgcd_check_units(la: usize, lb: usize) -> Units {
    let mut u = bigmul_units(la, lb);
    u.add(&bigmul_units(la, lb));
    u.add(&one(Family::AddSub, la.saturating_add(lb) as u64));
    u
}

/// Units of a checked BigInt extended gcd (`extended_gcd_metered`): the gcd
/// ([`biggcd_units`]) and the check on its coefficients
/// ([`xgcd_check_units`]).  Plain gcds, which do no check, keep
/// `biggcd_units`.
pub fn bigxgcd_units(la: usize, lb: usize) -> Units {
    let mut u = biggcd_units(la, lb);
    u.add(&xgcd_check_units(la, lb));
    u
}

/// Units of the checked extended gcd's fallback, when it ran (dashu's
/// coefficients failed their check): each plain Euclid step at its own
/// sizes, the remainder's (`bigeuclid_units` of its dividend and divisor)
/// and the two coefficients' updates (its quotient times each, as Gcd).
/// Nothing when it did not run.
pub fn xgcd_fallback_units(f: Option<&sagebrush_bigint::XgcdFallback>) -> Units {
    let mut u = Units::default();
    for &[la, lb, ls, lt] in f.map_or(&[][..], |f| &f.steps[..]) {
        let (la, lb) = (la.max(lb), la.min(lb));
        u.add(&bigeuclid_units(la, lb));
        let q = la - lb + 1;
        u.add(&one(Family::Gcd, bigmul_units(q, ls).total().unwrap_or(u64::MAX).saturating_add(bigmul_units(q, lt).total().unwrap_or(u64::MAX))));
    }
    u
}

/// Units of the integer square root of a value of `bits` bits (Newton's
/// iteration): the bit length of `bits` steps, each a division of the
/// value (l = ceil(bits / 64) limbs, at least 1) by a root of ceil(l / 2)
/// limbs (Div, `bigdiv_units` per step).
pub fn bigsqrt_units(bits: u64) -> Units {
    let l = usize::try_from(bits.div_ceil(64)).unwrap_or(usize::MAX).max(1);
    let steps = (64 - bits.max(1).leading_zeros()) as u64;
    let n = bigdiv_units(l, l.div_ceil(2)).total().unwrap_or(u64::MAX).saturating_mul(steps);
    one(Family::Div, n)
}

/// A function's own per-family count, outside arith's two kernels (whose
/// Polls fuse the Stop counter with the units): zmat, snf, classgroup.
///
/// - [`Local::add`], [`Local::n`] and [`Local::times`] accumulate locally,
///   saturating (never a panic).  Count after the work is done, never
///   ahead of it.
/// - [`Local::flush`] adds the count to the thread's tally, then publishes
///   the outermost region's progress (nothing without a region), then
///   zeroes the count.  It does not poll Stop: call it next to the
///   function's existing Stop checks, which stay where they are.
/// - Dropping it flushes, on return and while unwinding, so the work done
///   before a Stop or a panic is charged.
/// - In a loop whose step is tiny and uniform, count the steps in a scalar
///   and add them once with [`Local::times`], not one `n` per row.
/// - Never merge a [`metered`] meter's units into a Local: they went
///   through the tally already.
pub struct Local([u64; FAMILIES]);

impl Default for Local {
    fn default() -> Local {
        Local::new()
    }
}

impl Local {
    pub fn new() -> Local {
        Local([0; FAMILIES])
    }
    /// Adds the units `u`.
    #[inline]
    pub fn add(&mut self, u: Units) {
        for (a, &x) in self.0.iter_mut().zip(&u.0) {
            *a = a.saturating_add(x);
        }
    }
    /// Adds `n` units of family `f`.
    #[inline]
    pub fn n(&mut self, f: Family, n: u64) {
        let a = &mut self.0[f as usize];
        *a = a.saturating_add(n);
    }
    /// Adds `k` steps of `u` units each: `k` times `u`, family by family.
    #[inline]
    pub fn times(&mut self, k: u64, u: Units) {
        for (a, &x) in self.0.iter_mut().zip(&u.0) {
            *a = a.saturating_add(k.saturating_mul(x));
        }
    }
    /// The units held, not yet flushed.
    pub fn held(&self) -> Units {
        Units(self.0)
    }
    /// Adds the count to the thread's tally, publishes the outermost
    /// region's running units to its progress cell, and zeroes the count.
    pub fn flush(&mut self) {
        if self.0.iter().any(|&x| x != 0) {
            tally_all(&self.0);
            publish_progress();
            self.0 = [0; FAMILIES];
        }
    }
}

impl Drop for Local {
    fn drop(&mut self) {
        self.flush();
    }
}

fn one(f: Family, n: u64) -> Units {
    let mut u = [0; FAMILIES];
    u[f as usize] = n;
    Units(u)
}

#[cfg(test)]
mod tests;
