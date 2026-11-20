//! gcd = 1 checks for wire input (the canonical rationals of `QV_1` and
//! `MQR1`), in a workspace the caller sized and reserved in advance, with a
//! work charge admitted in advance.
//!
//! The gcd is Lehmer's (Knuth's Algorithm L, 63-bit leading windows), with a
//! Knuth-D remainder step when a window gives no quotient, and runs entirely
//! in place on two slots of `L + 1` limbs, `L` the largest limb count of the
//! payload.  Nothing here allocates: the routines take slices.
//!
//! **Memory.**  One workspace of [`workspace_words`]`(L) = 2 (L + 1)`
//! words, the caller's single allocation; no other allocation, no recursion,
//! the result stays in the workspace.  The inputs are read from the wire and
//! copied into the slots, so nothing decoded is touched.
//!
//! **Work**, in units: each [`Meter`] charge below is one unit per inner
//! iteration of the limb loop it precedes (plus small constants), so the
//! meter counts what the loops do.  [`gcd_work`]`(la, lb)`, for operands of
//! `la >= lb >= 1` limbs, bounds the meter of [`gcd_in_place`] in advance:
//! - **Iterations.** Every outer iteration that neither returns nor stops
//!   takes at least one step of the Euclidean remainder sequence: a Knuth-D
//!   remainder is one step, and a Lehmer window whose cosequence is not the
//!   identity applies quotients that Algorithm L's test proves are the true
//!   ones.  By Lame, a remainder sequence on b < 2^(64 lb) has at most
//!   n steps with phi^(n-1) <= b, so n < 64 lb / log2(phi) + 1 < 92.2 lb + 1:
//!   at most `T = 93 lb + 2` such iterations.
//! - **Per iteration** (with na <= la, nb <= lb: after the first, both
//!   operands are remainders below b): the comparison `na + 2`; a window's
//!   cosequence `LEHMER_STEPS` = 96; then the apply `3 na`, or the remainder's
//!   shifts `(na + nb + 2) + (2 nb + na + 1)`; at most `4 la + 3 lb + 101`
//!   in all, the quotient loop apart.
//! - **The quotient loop** of a remainder step on (r_k, r_(k+1)) runs
//!   `na - nb + 1` times at `2 nb + 4` units, and na - nb <= (bits r_k -
//!   bits r_(k+1)) / 64 + 1.  Those bit drops telescope to at most 64 la,
//!   so all the quotient loops together run at most `la + 2 T` times, at
//!   most `2 lb + 4` units each.
//! - **The last iteration**, the single-limb step (or b = 0): the comparison
//!   and `2 na + 93` (na remainders, at most 93 u64 steps by Lame, the
//!   zero fill): at most `3 la + 95`.
//!
//! So `gcd_work(la, lb) = T (4 la + 3 lb + 101) + (la + 2 T)(2 lb + 4)
//! + 3 la + 95`, a polynomial with nonnegative coefficients in the sorted
//! sizes, hence nondecreasing in each operand's size: an MQR1 row's running
//! gcd, never larger than the row denominator, is charged at the
//! denominator's size.  [`pair_work`], [`row_entry_work`] and
//! [`row_fixed_work`] add the slots' loads, copies and clears.  This is a
//! proof, not a fit: random input meters 1/70 to 1/250 of it, consecutive
//! Fibonacci numbers (the most Euclidean steps per bit) about 1/57 (the
//! price of Lame's worst case).
//! Going over the admitted total is an internal error, never a retry.  The
//! meter polls Stop every [`POLL_UNITS`] units, inside the quotient loop too.

use sagebrush_wire::BigRef;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

use crate::cost::{Family, Units, FAMILIES};

use crate::invdiv;

/// At most this many cosequence steps per Lehmer window (Lamé on 63 bits
/// allows 91).
const LEHMER_STEPS: u64 = 96;

/// Stop is polled at least every this many units (about a millisecond).
pub const POLL_UNITS: u64 = 1 << 20;

/// The words of the workspace for integers of at most `l` limbs.
pub const fn workspace_words(l: u64) -> Option<u64> {
    match l.checked_add(1) {
        Some(s) => s.checked_mul(2),
        None => None,
    }
}

macro_rules! ck {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => return None,
        }
    };
}

/// The work bound of [`gcd_in_place`] on operands of `la` and `lb` limbs,
/// in either order (module docs); `None` on overflow.
pub const fn gcd_work(la: u64, lb: u64) -> Option<u64> {
    let (la, lb) = if la >= lb { (la, lb) } else { (lb, la) };
    if lb == 0 {
        // one comparison, then b = 0
        return la.checked_add(2);
    }
    let t = ck!(ck!(lb.checked_mul(93)).checked_add(2));
    let iter = ck!(ck!(ck!(la.checked_mul(4)).checked_add(ck!(lb.checked_mul(3)))).checked_add(101));
    let iters = ck!(t.checked_mul(iter));
    let quot = ck!(ck!(la.checked_add(ck!(t.checked_mul(2)))).checked_mul(ck!(ck!(lb.checked_mul(2)).checked_add(4))));
    let last = ck!(ck!(la.checked_mul(3)).checked_add(95));
    ck!(iters.checked_add(quot)).checked_add(last)
}

/// The units of `rem_in_place` (x mod y, the quotient discarded) for an
/// `lx`-limb by an `ly`-limb operand, `2 <= ly <= lx`: the loads and
/// shifts `lx + ly + 2`, the quotient loop `(lx - ly + 1)(2 ly + 4)`, the
/// unshift `2 ly + lx + 1`, exactly; `None` on overflow or outside that range.
pub const fn rem_work(lx: u64, ly: u64) -> Option<u64> {
    if ly < 2 || ly > lx {
        return None;
    }
    let loop_ = ck!(ck!((lx - ly).checked_add(1)).checked_mul(ck!(ck!(ly.checked_mul(2)).checked_add(4))));
    let ends = ck!(ck!(ck!(lx.checked_mul(2)).checked_add(ck!(ly.checked_mul(3)))).checked_add(3));
    loop_.checked_add(ends)
}

/// Whether [`gcd_unbalanced`] takes one remainder step before Lehmer on
/// sorted sizes `la >= lb`: when `lb >= 2`, `la > lb` and the step plus a
/// gcd of two `lb`-limb operands is bounded below [`gcd_work`]`(la, lb)`.
/// Decided from the sizes alone, before any work.
pub const fn rem_first(la: u64, lb: u64) -> bool {
    if lb < 2 || la <= lb {
        return false;
    }
    match (rem_work(la, lb), gcd_work(lb, lb), gcd_work(la, lb)) {
        (Some(r), Some(g), Some(w)) => match r.checked_add(g) {
            Some(t) => t < w,
            None => false,
        },
        _ => false,
    }
}

/// The work bound of [`gcd_unbalanced`] on operands of `la` and `lb` limbs,
/// in either order; `None` on overflow.  Never above [`gcd_work`]:
/// - `lb = 0`: [`gcd_work`]`(la, 0)`;
/// - `lb = 1`: `3 la + 95`, [`gcd_in_place`]'s single-limb step (one
///   comparison `la + 2`, the remainder and the u64 gcd `2 la + 93`; when
///   `la = 1` and a < b, the swap's comparison is the one counted);
/// - [`rem_first`]: [`rem_work`]`(la, lb) + `[`gcd_work`]`(lb, lb)` (after
///   the step both operands have at most `lb` limbs, and gcd_work is
///   nondecreasing in each size);
/// - otherwise [`gcd_work`]`(la, lb)`.
pub const fn gcd_unbalanced_work(la: u64, lb: u64) -> Option<u64> {
    let (la, lb) = if la >= lb { (la, lb) } else { (lb, la) };
    if lb == 0 {
        return gcd_work(la, 0);
    }
    if lb == 1 {
        return ck!(la.checked_mul(3)).checked_add(95);
    }
    if rem_first(la, lb) {
        return ck!(rem_work(la, lb)).checked_add(ck!(gcd_work(lb, lb)));
    }
    gcd_work(la, lb)
}

/// The work bound of [`coprime_pair`] on a numerator of `ln` and a
/// denominator of `ld` limbs: the two loads (`k + 1` each), the gcd, the
/// two clears (`max + 2` each).
pub const fn pair_work(ln: u64, ld: u64) -> Option<u64> {
    let hi = if ln >= ld { ln } else { ld };
    let loads = ck!(ck!(ln.checked_add(ld)).checked_add(2));
    let clears = ck!(ck!(hi.checked_add(2)).checked_mul(2));
    ck!(ck!(gcd_work(ln, ld)).checked_add(loads)).checked_add(clears)
}

/// One numerator's term of [`row_work`]: for a nonzero numerator of `ln`
/// limbs in a row with a denominator of `ld` limbs, the load (`ln + 1`),
/// the gcd with the running gcd (at most `ld` limbs), the copy back
/// (`ld + 1`) and the clear (`max + 2`); zero for a zero numerator.
pub const fn row_entry_work(ln: u64, ld: u64) -> Option<u64> {
    if ln == 0 {
        return Some(0);
    }
    let hi = if ln >= ld { ln } else { ld };
    let fixed = ck!(ck!(ck!(ln.checked_add(ld)).checked_add(hi)).checked_add(4));
    ck!(gcd_work(ln, ld)).checked_add(fixed)
}

/// The rest of [`row_work`]: the denominator's load (`ld + 1`) and the
/// final clear (`l + 2`, `l` the row's largest limb count).
pub const fn row_fixed_work(ld: u64, l: u64) -> Option<u64> {
    ck!(ld.checked_add(l)).checked_add(3)
}

/// Why a check stopped without an answer: the admitted work ran out (an
/// error in the bound: internal), or an invariant failed (internal).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Overrun,
    Invariant,
}

/// The work meter: units used against a limit, and Stop polls.
pub struct Meter {
    used: u64,
    limit: u64,
    since_poll: u64,
    largest: u64,
    /// The limit is a proven upper bound (U), not a budget: passing it is an
    /// accounting bug, recorded, never a refusal.
    accounting: bool,
    overran: bool,
    /// The units charged per family (their sum is `used`).
    units: [u64; FAMILIES],
}

/// Meters that passed their proven upper bound since the start (the engine
/// cost policy: an accounting bug, never a refusal).  A release-build signal
/// for the harness; debug builds fail at the overrun instead.
static ACCOUNTING_OVERRUNS: AtomicU64 = AtomicU64::new(0);

/// How many [`Meter::accounting`] meters have passed their proven upper
/// bound since the start.
pub fn accounting_overruns() -> u64 {
    ACCOUNTING_OVERRUNS.load(Relaxed)
}

impl Meter {
    /// A meter that refuses past `limit` (Fault::Overrun).  The pre-r2 form,
    /// kept for the ops still to migrate: new code uses
    /// [`Meter::accounting`] (the engine cost policy: an upper bound never
    /// refuses).
    pub fn new(limit: u64) -> Meter {
        Meter { used: 0, limit, since_poll: 0, largest: 0, accounting: false, overran: false, units: [0; FAMILIES] }
    }
    /// A meter whose limit is a proven upper bound on the work (a cost's
    /// `work_upper`, or u64::MAX where there is none).  Passing it is an
    /// accounting bug, never a refusal: a debug build fails (so tests catch
    /// a wrong bound); a release build counts it once per meter
    /// ([`accounting_overruns`]) and the work goes on, metered and polling
    /// Stop.
    pub fn accounting(upper: u64) -> Meter {
        Meter { accounting: true, ..Meter::new(upper) }
    }
    pub fn used(&self) -> u64 {
        self.used
    }
    pub fn limit(&self) -> u64 {
        self.limit
    }
    /// The largest single charge so far: the most the count can pass the
    /// limit by when a charge is refused (the check follows every charge).
    pub fn largest_charge(&self) -> u64 {
        self.largest
    }
    /// The units charged so far, per family (their total is [`Meter::used`]).
    pub fn units(&self) -> Units {
        let u = Units(self.units);
        debug_assert_eq!(u.total(), Some(self.used), "the per-family units drifted from the total");
        u
    }
    /// Charge `n` units, untagged: [`Family::Other`].  The pre-family form,
    /// for the charge sites still to migrate to [`Meter::add_in`].
    #[inline]
    pub(crate) fn add(&mut self, n: usize) -> Result<(), Fault> {
        self.add_in(Family::Other, n)
    }
    /// Charge `n` units of family `f` (a constant at each charge site).
    #[inline]
    pub(crate) fn add_in(&mut self, f: Family, n: usize) -> Result<(), Fault> {
        let n = u64::try_from(n).map_err(|_| Fault::Overrun)?;
        self.largest = self.largest.max(n);
        match self.used.checked_add(n) {
            Some(u) => self.used = u,
            None if self.accounting => self.used = u64::MAX,
            None => return Err(Fault::Overrun),
        }
        // (a family's count is at most the total, so it fits where the
        // total did; it saturates with the total in accounting mode)
        let fu = &mut self.units[f as usize];
        *fu = fu.saturating_add(n);
        if self.used > self.limit {
            if !self.accounting {
                return Err(Fault::Overrun);
            }
            if !self.overran {
                self.overran = true;
                ACCOUNTING_OVERRUNS.fetch_add(1, Relaxed);
                debug_assert!(false, "a meter passed its proven upper bound: {} units of at most {}", self.used, self.limit);
            }
        }
        self.since_poll = self.since_poll.saturating_add(n);
        if self.since_poll >= POLL_UNITS {
            self.since_poll = 0;
            sagebrush_interrupt::check_coarse();
        }
        Ok(())
    }
}

fn norm(x: &[u64], n: usize) -> usize {
    let mut n = n;
    while n > 0 && x[n - 1] == 0 {
        n -= 1;
    }
    n
}

fn less(x: &[u64], nx: usize, y: &[u64], ny: usize) -> bool {
    if nx != ny {
        return nx < ny;
    }
    for i in (0..nx).rev() {
        if x[i] != y[i] {
            return x[i] < y[i];
        }
    }
    false
}

/// The 63 bits of x from bit `shift` on.
fn window(x: &[u64], n: usize, shift: usize) -> u64 {
    let (w, b) = (shift / 64, shift % 64);
    let lo = if w < n { x[w] >> b } else { 0 };
    let hi = if b > 0 && w + 1 < n { x[w + 1] << (64 - b) } else { 0 };
    (lo | hi) & (u64::MAX >> 1)
}

/// Test-only coverage counters for the differential test's hard-case rows
/// (indices in `diff_tests`): which branches the inputs actually reached.
#[cfg(test)]
pub(crate) mod hits {
    use std::cell::Cell;
    thread_local! {
        static N: [Cell<u64>; 6] = const { [const { Cell::new(0) }; 6] };
    }
    pub(crate) const BOUNDARY: usize = 0;
    pub(crate) const ADD_BACK: usize = 1;
    // (today's D3 loop: a correction because qhat >= b, one and two because
    // of the second-limb test, and the rh overflow break)
    pub(crate) const D3_QBIG: usize = 2;
    pub(crate) const D3_Y2_ONCE: usize = 3;
    pub(crate) const D3_Y2_TWICE: usize = 4;
    pub(crate) const D3_RH_BREAK: usize = 5;
    pub(crate) fn hit(i: usize) {
        N.with(|n| n[i].set(n[i].get() + 1));
    }
    pub(crate) fn get(i: usize) -> u64 {
        N.with(|n| n[i].get())
    }
}

/// Knuth D's quotient digit at one step, with U = u2 b^2 + u1 b + u0 and
/// D = y1 b + y2: floor(U / D) by the 3-by-2 ([`invdiv::div3by2`], v3 its
/// reciprocal), or b - 1 when (u2, u1) = (y1, y2), where the true digit is
/// b - 1 (the running remainder R is at least D b^(ny-1) and below Y b, so
/// R / Y > b - 1).  This is the value the D3 correction loop reached, the
/// smaller of floor(U / D) and b - 1, so every digit, multiply-subtract and
/// add-back is the same as with it.  (u2, u1) above (y1, y2) can't happen
/// (the running remainder is below y b): an invariant failure.
#[inline]
fn qdigit(u2: u64, u1: u64, u0: u64, y1: u64, y2: u64, v3: u64) -> Result<u128, Fault> {
    if (u2, u1) < (y1, y2) {
        Ok(u128::from(invdiv::div3by2(u2, u1, u0, y1, y2, v3).0))
    } else if (u2, u1) == (y1, y2) {
        #[cfg(test)]
        hits::hit(hits::BOUNDARY);
        Ok(u128::from(u64::MAX))
    } else {
        Err(Fault::Invariant)
    }
}

/// x / d for a one-limb d != 0, x of nx >= 1 limbs (one limb: a u64
/// division): the quotient to q[..nx]
/// and x[..nx] zeroed, limb by limb from the top (each limb charged 6
/// units before it is divided); the remainder.  The 2-by-1 divides x 2^s by
/// the normalized d 2^s, the shifted limbs read on the fly (nothing
/// written but q and the zeros): the same quotient limbs, the remainder
/// shifted back at the end.  The reciprocal is made right after the first
/// limb's charge.
fn div_limb(x: &mut [u64], nx: usize, d: u64, q: &mut [u64], m: &mut Meter) -> Result<u64, Fault> {
    if nx == 1 {
        // (one limb by one limb: the machine's own u64 division, no
        // reciprocal; the same charge)
        m.add_in(Family::Div, 6)?;
        let (qj, r) = (x[0] / d, x[0] % d);
        q[0] = qj;
        x[0] = 0;
        return Ok(r);
    }
    let s = d.leading_zeros();
    let dn = d << s;
    // (the top limb's spill: below 2^s <= dn)
    let mut r = if s > 0 { x[nx - 1] >> (64 - s) } else { 0 };
    let mut inv = None;
    for j in (0..nx).rev() {
        m.add_in(Family::Div, 6)?;
        let v = *inv.get_or_insert_with(|| invdiv::recip(dn));
        let low = if s > 0 && j > 0 { x[j - 1] >> (64 - s) } else { 0 };
        let u0 = if s > 0 { (x[j] << s) | low } else { x[j] };
        let (qj, rj) = invdiv::div2by1(r, u0, dn, v);
        q[j] = qj;
        r = rj;
        x[j] = 0;
    }
    Ok(r >> s)
}

/// a mod d for a one-limb d != 0, a of na >= 1 limbs, a unchanged: the
/// 2-by-1 on a 2^s by d 2^s as in [`div_limb`], the quotient discarded.
/// Its caller has charged the units already.
fn rem_limb(a: &[u64], na: usize, d: u64) -> u64 {
    if na == 1 {
        return a[0] % d;
    }
    let s = d.leading_zeros();
    let dn = d << s;
    let v = invdiv::recip(dn);
    let mut r = if s > 0 { a[na - 1] >> (64 - s) } else { 0 };
    for i in (0..na).rev() {
        let low = if s > 0 && i > 0 { a[i - 1] >> (64 - s) } else { 0 };
        let u0 = if s > 0 { (a[i] << s) | low } else { a[i] };
        r = invdiv::div2by1(r, u0, dn, v).1;
    }
    r >> s
}

/// x mod y in place (Knuth D, the quotient discarded), for ny >= 2, x >= y
/// (nx >= ny), x with room for nx + 1 limbs.  y is normalized in place and
/// restored.  The remainder's length.
fn rem_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<usize, Fault> {
    let s = y[ny - 1].leading_zeros();
    m.add_in(Family::Move, nx + ny + 2)?;
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (y[ny - 1], y[ny - 2]);
    // (the 3-by-2 reciprocal: made once, right after the first digit's
    // charge, which pays for more than it costs)
    let mut inv = None;
    for j in (0..=nx - ny).rev() {
        m.add_in(Family::Div, 2 * ny + 4)?;
        let v3 = *inv.get_or_insert_with(|| invdiv::recip3(y1, y2, invdiv::recip(y1)));
        let qh = qdigit(x[j + ny], x[j + ny - 1], x[j + ny - 2], y1, y2, v3)?;
        // x[j .. j + ny + 1] -= qh y
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let (ph, pl) = invdiv::mul_wide(qh as u64, y[i]);
            let p = ((u128::from(ph) << 64) | u128::from(pl)) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            #[cfg(test)]
            hits::hit(hits::ADD_BACK);
            // qh was one too large (Knuth D6): add y back once
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
    }
    m.add_in(Family::Move, 2 * ny + nx + 1)?;
    if s > 0 {
        for i in 0..ny - 1 {
            x[i] = (x[i] >> s) | (x[i + 1] << (64 - s));
        }
        x[ny - 1] >>= s;
        for i in 0..ny - 1 {
            y[i] = (y[i] >> s) | (y[i + 1] << (64 - s));
        }
        y[ny - 1] >>= s;
    }
    for v in &mut x[ny..=nx] {
        *v = 0;
    }
    let r = norm(x, ny);
    if !less(x, r, y, ny) {
        return Err(Fault::Invariant);
    }
    Ok(r)
}

/// The quotient-keeping Knuth D's units for an `lx`-limb by an `ly`-limb
/// division, `1 <= ly <= lx` ([`divexact_in_place`]): `Q(lx, ly) = (lx - ly
/// + 1)(2 ly + 4) + 3 lx + 8`; `None` on overflow or outside that range.
pub const fn quot_work(lx: u64, ly: u64) -> Option<u64> {
    if ly == 0 || ly > lx {
        return None;
    }
    let loop_ = ck!(ck!((lx - ly).checked_add(1)).checked_mul(ck!(ck!(ly.checked_mul(2)).checked_add(4))));
    ck!(loop_.checked_add(ck!(lx.checked_mul(3)))).checked_add(8)
}

/// [`quot_work`]`(lx, ly)` for a divisor of unknown size: `Qhat(lx) =
/// ceil((lx + 3)^2 / 2) + 3 lx + 8 >= Q(lx, ly)` for every `1 <= ly <= lx`
/// (with u = lx - ly + 1 and v = ly + 2, u + v = lx + 3 and 2 u v <= (u +
/// v)^2 / 2).
pub const fn quot_work_any(lx: u64) -> Option<u64> {
    let t = ck!(lx.checked_add(3));
    let sq = ck!(t.checked_mul(t));
    ck!(sq.div_ceil(2).checked_add(ck!(lx.checked_mul(3)))).checked_add(8)
}

/// x / y exactly (Knuth D, the quotient kept: the sibling of
/// `rem_in_place`), for `1 <= ny <= nx`, y normalized (`y[ny - 1] != 0`), x
/// with room for `nx + 1` limbs and q for `nx - ny + 1`.  The quotient goes
/// to q and its length is returned.  x is left all zero (its remainder,
/// checked: a nonzero remainder is an invariant failure, never a wrong
/// answer); y is the caller's copy and is left normalized (shifted), not
/// restored.  Units: `nx + ny + 2` for the shifts, `2 ny + 4` per quotient
/// limb (6 for a one-limb divisor), `nx + 2` for the remainder check: at
/// most [`quot_work`]`(nx, ny)`, since `2 nx + ny + 4 <= 3 nx + 8`.
pub fn divexact_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, q: &mut [u64], m: &mut Meter) -> Result<usize, Fault> {
    if ny == 0 || nx < ny || x.len() <= nx || y.len() < ny || y[ny - 1] == 0 || q.len() < nx - ny + 1 {
        return Err(Fault::Invariant);
    }
    m.add_in(Family::Move, nx + ny + 2)?;
    if ny == 1 {
        let r = div_limb(x, nx, y[0], q, m)?;
        m.add_in(Family::Move, nx + 2)?;
        x[nx] = 0;
        if r != 0 {
            return Err(Fault::Invariant);
        }
        return Ok(norm(q, nx));
    }
    let s = y[ny - 1].leading_zeros();
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (y[ny - 1], y[ny - 2]);
    // (the 3-by-2 reciprocal: made once, right after the first digit's
    // charge, which pays for more than it costs)
    let mut inv = None;
    for j in (0..=nx - ny).rev() {
        m.add_in(Family::Div, 2 * ny + 4)?;
        let v3 = *inv.get_or_insert_with(|| invdiv::recip3(y1, y2, invdiv::recip(y1)));
        let mut qh = qdigit(x[j + ny], x[j + ny - 1], x[j + ny - 2], y1, y2, v3)?;
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let (ph, pl) = invdiv::mul_wide(qh as u64, y[i]);
            let p = ((u128::from(ph) << 64) | u128::from(pl)) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            #[cfg(test)]
            hits::hit(hits::ADD_BACK);
            qh -= 1;
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
        q[j] = qh as u64;
    }
    // (the remainder, still shifted, is x[..ny]; above it everything is zero)
    m.add_in(Family::Move, nx + 2)?;
    if x[..=nx].iter().any(|&w| w != 0) {
        return Err(Fault::Invariant);
    }
    Ok(norm(q, nx - ny + 1))
}

/// The units of [`divrem_in_place`] for an `lx`-limb by an `ly`-limb
/// division, `1 <= ly <= lx`: [`quot_work`]`(lx, ly)` plus the remainder's
/// unshift and restore, `2 ly + lx + 1` (the sibling of `rem_in_place`'s);
/// `None` on overflow or outside that range.
pub const fn divrem_work(lx: u64, ly: u64) -> Option<u64> {
    let q = ck!(quot_work(lx, ly));
    ck!(q.checked_add(ck!(ly.checked_mul(2)))).checked_add(ck!(lx.checked_add(1)))
}

/// x = q y + r with 0 <= r < y (Knuth D keeping both, magnitudes), for `1
/// <= ny <= nx`, y normalized, x with room for `nx + 1` limbs and q for `nx
/// - ny + 1`.  The quotient goes to q; the remainder is left in x's first
/// limbs (everything above it zero); y is restored.  Returns (the
/// quotient's length, the remainder's).  Every unit is charged before the
/// work it counts: at most [`divrem_work`]`(nx, ny)`.
pub fn divrem_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, q: &mut [u64], m: &mut Meter) -> Result<(usize, usize), Fault> {
    if ny == 0 || nx < ny || x.len() <= nx || y.len() < ny || y[ny - 1] == 0 || q.len() < nx - ny + 1 {
        return Err(Fault::Invariant);
    }
    m.add_in(Family::Move, nx + ny + 2)?;
    if ny == 1 {
        let r = div_limb(x, nx, y[0], q, m)?;
        m.add_in(Family::Move, nx + 2)?;
        x[nx] = 0;
        x[0] = r;
        return Ok((norm(q, nx), usize::from(r != 0)));
    }
    let s = y[ny - 1].leading_zeros();
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (y[ny - 1], y[ny - 2]);
    // (the 3-by-2 reciprocal: made once, right after the first digit's
    // charge, which pays for more than it costs)
    let mut inv = None;
    for j in (0..=nx - ny).rev() {
        m.add_in(Family::Div, 2 * ny + 4)?;
        let v3 = *inv.get_or_insert_with(|| invdiv::recip3(y1, y2, invdiv::recip(y1)));
        let mut qh = qdigit(x[j + ny], x[j + ny - 1], x[j + ny - 2], y1, y2, v3)?;
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let (ph, pl) = invdiv::mul_wide(qh as u64, y[i]);
            let p = ((u128::from(ph) << 64) | u128::from(pl)) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            #[cfg(test)]
            hits::hit(hits::ADD_BACK);
            qh -= 1;
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
        q[j] = qh as u64;
    }
    // (the remainder, shifted, is x[..ny]; unshift it and y, zero the rest)
    m.add_in(Family::Move, 2 * ny + nx + 1)?;
    if s > 0 {
        for i in 0..ny - 1 {
            x[i] = (x[i] >> s) | (x[i + 1] << (64 - s));
        }
        x[ny - 1] >>= s;
        for i in 0..ny - 1 {
            y[i] = (y[i] >> s) | (y[i + 1] << (64 - s));
        }
        y[ny - 1] >>= s;
    }
    for v in &mut x[ny..=nx] {
        *v = 0;
    }
    let r = norm(x, ny);
    if !less(x, r, y, ny) {
        return Err(Fault::Invariant);
    }
    Ok((norm(q, nx - ny + 1), r))
}

fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// gcd(x, y) in place, x of nx limbs and y of ny (normalized), each slice
/// with room for max(nx, ny) + 1 limbs and zero beyond its length.  The
/// gcd's slot (false: x, true: y) and length; the other slot holds 0.
pub fn gcd_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<(bool, usize), Fault> {
    let (mut a, mut b) = (x, y);
    let (mut na, mut nb) = (nx, ny);
    let mut swapped = false;
    loop {
        m.add_in(Family::Gcd, na + 2)?;
        if less(a, na, b, nb) {
            std::mem::swap(&mut a, &mut b);
            std::mem::swap(&mut na, &mut nb);
            swapped = !swapped;
        }
        if nb == 0 {
            return Ok((swapped, na));
        }
        if nb == 1 {
            m.add_in(Family::Div, 2 * na + 93)?;
            let d = b[0];
            let g = gcd_u64(d, rem_limb(a, na, d));
            for v in &mut a[..na] {
                *v = 0;
            }
            a[0] = g;
            b[0] = 0;
            return Ok((swapped, 1));
        }
        // a >= b, nb >= 2: one Lehmer window, or a remainder
        let shift = (64 * na - a[na - 1].leading_zeros() as usize).saturating_sub(63);
        let (mut xh, mut yh) = (i128::from(window(a, na, shift)), i128::from(window(b, nb, shift)));
        let (mut ca, mut cb, mut cc, mut cd) = (1i128, 0i128, 0i128, 1i128);
        if na <= nb + 1 {
            m.add_in(Family::Gcd, LEHMER_STEPS as usize)?;
            for _ in 0..LEHMER_STEPS {
                // (Algorithm L's invariant keeps these positive; checked,
                // so a truncating division is a floor)
                if yh + cc <= 0 || yh + cd <= 0 || xh + ca < 0 || xh + cb < 0 {
                    break;
                }
                let q = (xh + ca) / (yh + cc);
                if q != (xh + cb) / (yh + cd) {
                    break;
                }
                (ca, cc) = (cc, ca - q * cc);
                (cb, cd) = (cd, cb - q * cd);
                (xh, yh) = (yh, xh - q * yh);
            }
        }
        if cb == 0 {
            na = rem_in_place(a, na, b, nb, m)?;
            continue;
        }
        m.add_in(Family::Gcd, 3 * na)?;
        apply_window(a, b, na, [ca, cb, cc, cd])?;
        let n = na;
        na = norm(a, n);
        nb = norm(b, n);
    }
}

/// gcd(x, y) as [`gcd_in_place`] (the same slices, the same result: the
/// gcd's slot, false: x, true: y, and length; the other slot 0), its work
/// at most [`gcd_unbalanced_work`]`(nx, ny)`.  On operands of very
/// different sizes ([`rem_first`]), one remainder step first: x mod y in
/// place (y, the smaller, normalized there and restored; a zero remainder
/// makes y the gcd), then [`gcd_in_place`] on two operands of at most `ny`
/// limbs.  Otherwise [`gcd_in_place`] itself.
pub fn gcd_unbalanced(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<(bool, usize), Fault> {
    if nx < ny {
        let (slot, len) = gcd_unbalanced(y, ny, x, nx, m)?;
        return Ok((!slot, len));
    }
    if rem_first(nx as u64, ny as u64) {
        if x[nx - 1] == 0 || y[ny - 1] == 0 || x.len() <= nx {
            return Err(Fault::Invariant);
        }
        let nr = rem_in_place(x, nx, y, ny, m)?;
        if nr == 0 {
            return Ok((true, ny));
        }
        let (slot, len) = gcd_in_place(y, ny, x, nr, m)?;
        return Ok((!slot, len));
    }
    gcd_in_place(x, nx, y, ny, m)
}

/// Algorithm L's bound on a window's cofactors [ca, cb, cc, cd], checked
/// before they are applied: each below 2^63 in size, and each row's two of
/// opposite signs (or zero), so that every i128 sum in [`apply_window`]
/// (two products below 2^127 in size and of opposite signs, plus a carry
/// below 2^64) is below 2^127 in size.
fn cofactors_fit(c: [i128; 4]) -> bool {
    const B: i128 = 1 << 63;
    c.iter().all(|&x| -B < x && x < B) && c[0].signum() * c[1].signum() <= 0 && c[2].signum() * c[3].signum() <= 0
}

/// (a, b) <- (ca a + cb b, cc a + cd b) over the first `na` limbs: the true
/// remainders, which are nonnegative (a final borrow is an invariant
/// failure).  Cofactors outside Algorithm L's bound are refused before
/// anything is written.
fn apply_window(a: &mut [u64], b: &mut [u64], na: usize, c: [i128; 4]) -> Result<(), Fault> {
    if !cofactors_fit(c) {
        return Err(Fault::Invariant);
    }
    let [ca, cb, cc, cd] = c;
    let (mut c1, mut c2) = (0i128, 0i128);
    for i in 0..na {
        let (ai, bi) = (i128::from(a[i]), i128::from(b[i]));
        let t1 = ca * ai + cb * bi + c1;
        let t2 = cc * ai + cd * bi + c2;
        a[i] = t1 as u64;
        b[i] = t2 as u64;
        c1 = t1 >> 64;
        c2 = t2 >> 64;
    }
    if c1 != 0 || c2 != 0 {
        return Err(Fault::Invariant);
    }
    Ok(())
}

/// Copy a wire integer's magnitude into a zeroed slot.
fn load(slot: &mut [u64], v: &BigRef, m: &mut Meter) -> Result<usize, Fault> {
    let k = v.limb_count();
    m.add_in(Family::Move, k + 1)?;
    for (i, w) in slot[..k].iter_mut().enumerate() {
        *w = v.limb(i);
    }
    Ok(k)
}

/// Zero the first `n` limbs of a slot.
fn clear(slot: &mut [u64], n: usize, m: &mut Meter) -> Result<(), Fault> {
    m.add_in(Family::Move, n + 1)?;
    for v in &mut slot[..n] {
        *v = 0;
    }
    Ok(())
}

fn is_one(s: &[u64], n: usize) -> bool {
    n == 1 && s[0] == 1
}

/// Whether gcd(n, d) = 1, in the workspace `ws` (zero, with slots of
/// `ws.len() / 2` limbs, at least each operand's limbs + 1); left zero.
pub fn coprime_pair(ws: &mut [u64], n: &BigRef, d: &BigRef, m: &mut Meter) -> Result<bool, Fault> {
    let half = ws.len() / 2;
    let (s0, s1) = ws.split_at_mut(half);
    let la = load(s0, n, m)?;
    let lb = load(s1, d, m)?;
    let room = la.max(lb) + 1;
    if room > half {
        return Err(Fault::Invariant);
    }
    let (slot, len) = gcd_in_place(s0, la, s1, lb, m)?;
    let one = if slot { is_one(s1, len) } else { is_one(s0, len) };
    clear(s0, room, m)?;
    clear(s1, room, m)?;
    Ok(one)
}

/// Whether gcd(d, n_1, ..., n_c) = 1 for an MQR1 row (`row`: d, then the
/// numerators): a running gcd in slot 0, each numerator loaded into slot 1,
/// stopping at 1.  The workspace is left zero.
pub fn coprime_row<'a>(ws: &mut [u64], row: impl Iterator<Item = BigRef<'a>>, m: &mut Meter) -> Result<bool, Fault> {
    let half = ws.len() / 2;
    let (s0, s1) = ws.split_at_mut(half);
    let mut row = row;
    let d = row.next().ok_or(Fault::Invariant)?;
    let mut lg = load(s0, &d, m)?;
    let mut dirty = lg + 1;
    for v in row {
        if is_one(s0, lg) {
            break;
        }
        if v.is_zero() {
            continue;
        }
        let ln = load(s1, &v, m)?;
        let room = lg.max(ln) + 1;
        if room > half {
            return Err(Fault::Invariant);
        }
        dirty = dirty.max(room);
        let (slot, len) = gcd_in_place(s0, lg, s1, ln, m)?;
        if slot {
            m.add_in(Family::Move, len + 1)?;
            s0[..len].copy_from_slice(&s1[..len]);
        }
        clear(s1, room, m)?;
        lg = len;
    }
    let one = is_one(s0, lg);
    clear(s0, dirty, m)?;
    Ok(one)
}

#[cfg(test)]
mod old;

#[cfg(test)]
mod diff_tests;

// (its helpers use dashu's u64-word API: native targets only)
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use dashu_int::UBig;

    const H: u64 = 1 << 63;

    /// x mod y by rem_in_place against dashu, and the meter's count.
    fn rem(x: &[u64], y: &[u64]) {
        let (nx, ny) = (x.len(), y.len());
        let mut a = x.to_vec();
        a.push(0);
        let mut b = y.to_vec();
        let mut m = Meter::new(u64::MAX);
        let r = rem_in_place(&mut a, nx, &mut b, ny, &mut m).unwrap();
        let want = UBig::from_words(x) % UBig::from_words(y);
        assert_eq!(UBig::from_words(&a[..r]), want, "{:x?} mod {:x?}", x, y);
        assert!(a[r..].iter().all(|&w| w == 0));
        assert_eq!(b, y, "the divisor is restored");
        // the quotient loop's and the shifts' units, as gcd_work counts them
        let units = (nx + ny + 2) + (nx - ny + 1) * (2 * ny + 4) + (2 * ny + nx + 1);
        assert_eq!(m.used(), units as u64);
        assert_eq!(m.units().total(), Some(m.used()));
        assert_eq!(m.units().get(Family::Other), 0, "a remainder's work is tagged");
    }

    /// The cofactor guard: Algorithm L's bound holds at its edges, and a
    /// cofactor of size 2^63, or a row of equal signs, is refused before
    /// anything is written; a negative result is refused too.
    #[test]
    fn window_cofactors_out_of_bound_are_refused() {
        let b63 = 1i128 << 63;
        let (a0, b0) = (vec![u64::MAX, u64::MAX], vec![u64::MAX, u64::MAX - 1]);
        // at the bound: (2^63 - 1)(a - b) with a - b = 2^64 (little-endian
        // limbs), and the second row the identity on b
        let (mut a, mut b) = (a0.clone(), b0.clone());
        assert_eq!(apply_window(&mut a, &mut b, 2, [b63 - 1, -(b63 - 1), 0, 1]), Ok(()));
        assert_eq!((a, b), (vec![0, (b63 - 1) as u64], b0.clone()));
        for c in [[b63, -1, 0, 1], [1, -b63, 0, 1], [1, 0, -b63, 1], [1, 0, 0, b63], [1, 1, 0, 1], [1, 0, -1, -1], [-b63, 0, 0, 1]] {
            let (mut a, mut b) = (a0.clone(), b0.clone());
            assert_eq!(apply_window(&mut a, &mut b, 2, c), Err(Fault::Invariant), "{:?}", c);
            assert_eq!((a, b), (a0.clone(), b0.clone()), "{:?}: written before the refusal", c);
        }
        // in the bound, but a negative result (b - a with b < a): not a
        // remainder, so a final borrow is refused
        let (mut a, mut b) = (a0.clone(), b0.clone());
        assert_eq!(apply_window(&mut a, &mut b, 2, [1, 0, -1, 1]), Err(Fault::Invariant));
    }

    /// Knuth D's rare corrections: quotient digits estimated one or two
    /// too large, and the add back (D6), on the classic test patterns
    /// (Hacker's Delight's divmnu cases at 64-bit digits) and their
    /// neighbours.
    #[test]
    fn remainders_take_every_correction() {
        rem(&[0, 0, H, H - 1], &[1, 0, H]);
        rem(&[3, 0, H], &[1, 0, H >> 2]);
        rem(&[0, 0, H, H - 1], &[u64::MAX, 0, H]);
        rem(&[0, u64::MAX - 1, 0, H - 1], &[u64::MAX, 0, H]);
        rem(&[u64::MAX, u64::MAX, u64::MAX, u64::MAX], &[u64::MAX, u64::MAX]);
        rem(&[0, 0, 0, 1], &[1, 1]);
        rem(&[0, 7, 0, H], &[3, H]);
        rem(&[0x1234, 0, 0, H + 1], &[u64::MAX, H - 1, 2]);
        let mut seed = 0xdead_beef_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        // digits near 0, 2^63 and 2^64 - 1 make the estimates miss most
        let picks = [0, 1, H - 1, H, H + 1, u64::MAX - 1, u64::MAX];
        for _ in 0..20_000 {
            let nx = 2 + (next() % 5) as usize;
            let ny = 2 + (next() % (nx as u64 - 1)) as usize;
            let mut pick = || picks[(next() % 7) as usize];
            let mut x: Vec<u64> = (0..nx).map(|_| pick()).collect();
            let mut y: Vec<u64> = (0..ny).map(|_| pick()).collect();
            if x[nx - 1] == 0 {
                x[nx - 1] = 1;
            }
            if y[ny - 1] == 0 {
                y[ny - 1] = H;
            }
            if UBig::from_words(&x) >= UBig::from_words(&y) {
                rem(&x, &y);
            }
        }
    }

    /// gcd_unbalanced on (x, y) against gcd_in_place and dashu: the same
    /// slot, length and value, the other slot zero; its meter within
    /// gcd_unbalanced_work, which is never above gcd_work; and the count
    /// exact (a limit at the count admits, one below refuses).
    fn unbalanced(x: &[u64], y: &[u64]) -> u64 {
        let (nx, ny) = (x.len(), y.len());
        let room = nx.max(ny) + 1;
        let slots = |v: &[u64]| {
            let mut s = v.to_vec();
            s.resize(room, 0);
            s
        };
        let (mut a, mut b) = (slots(x), slots(y));
        let mut m = Meter::new(u64::MAX);
        let (slot, len) = gcd_unbalanced(&mut a, nx, &mut b, ny, &mut m).unwrap();
        let (g, other) = if slot { (&b, &a) } else { (&a, &b) };
        let (mut p, mut q) = (UBig::from_words(x), UBig::from_words(y));
        while q != UBig::ZERO {
            let r = &p % &q;
            (p, q) = (q, r);
        }
        let want = p;
        assert_eq!(UBig::from_words(&g[..len]), want, "gcd({:x?}, {:x?})", x, y);
        assert!(g[len..].iter().all(|&w| w == 0) && other.iter().all(|&w| w == 0), "the slots are clean");
        let (mut c, mut d) = (slots(x), slots(y));
        let mut m2 = Meter::new(u64::MAX);
        let (slot2, len2) = gcd_in_place(&mut c, nx, &mut d, ny, &mut m2).unwrap();
        assert_eq!((slot, len), (slot2, len2), "the same slot as gcd_in_place");
        let bound = gcd_unbalanced_work(nx as u64, ny as u64).unwrap();
        assert!(m.used() <= bound, "{} > {} ({}, {})", m.used(), bound, nx, ny);
        assert!(bound <= gcd_work(nx as u64, ny as u64).unwrap());
        for (limit, ok) in [(m.used(), true), (m.used() - 1, false)] {
            let (mut c, mut d) = (slots(x), slots(y));
            let r = gcd_unbalanced(&mut c, nx, &mut d, ny, &mut Meter::new(limit));
            assert_eq!(r.is_ok(), ok, "limit {} of {}", limit, m.used());
        }
        m.used()
    }

    /// gcd_unbalanced: random unbalanced pairs (la up to 64, lb 1 to 4, both
    /// orders), and the edges: b = 0, la < lb, a mod b = 0, lb = 1 (its
    /// bound 3 la + 95 reached), balanced pairs (gcd_in_place's own path).
    #[test]
    fn unbalanced_gcd_matches_gcd_in_place_within_its_bound() {
        let mut seed = 0x5eed_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut took_rem = false;
        for _ in 0..3000 {
            let la = 1 + (next() % 64) as usize;
            let lb = 1 + (next() % 4) as usize;
            // (the top limb nonzero: normalized lengths)
            let mut x: Vec<u64> = (0..la).map(|_| next()).collect();
            let mut y: Vec<u64> = (0..lb).map(|_| next()).collect();
            x[la - 1] |= 1;
            y[lb - 1] |= 1;
            took_rem |= rem_first(la.max(lb) as u64, la.min(lb) as u64);
            unbalanced(&x, &y);
            unbalanced(&y, &x);
            // a common factor, and a multiple (a mod b = 0)
            let g = UBig::from_words(&y);
            let xm = (UBig::from_words(&x) * &g).to_le_bytes();
            let xm: Vec<u64> = xm.chunks(8).map(|c| c.iter().rev().fold(0u64, |a, &b| (a << 8) | u64::from(b))).collect();
            let mut xm = xm;
            while xm.last() == Some(&0) {
                xm.pop();
            }
            unbalanced(&xm, &y);
            unbalanced(&y, &xm);
        }
        assert!(took_rem, "the remainder-first path ran");
        // b = 0, either side; zero and zero
        unbalanced(&[5, 7], &[]);
        unbalanced(&[], &[5, 7]);
        unbalanced(&[], &[]);
        // lb = 1: the bound 3 la + 95 is reached when la = 1 and a < b
        assert_eq!(unbalanced(&[3], &[7]), gcd_unbalanced_work(1, 1).unwrap());
        assert_eq!(gcd_unbalanced_work(1, 1), Some(98));
        unbalanced(&[u64::MAX; 40], &[3]);
        // balanced pairs: gcd_in_place's path, its bound
        for (la, lb) in [(2u64, 2u64), (4, 4), (9, 9)] {
            assert!(!rem_first(la, lb));
            assert_eq!(gcd_unbalanced_work(la, lb), gcd_work(la, lb));
        }
    }

    /// The bounds' arithmetic: gcd_unbalanced_work never above gcd_work on
    /// a grid; rem_work as the remainder's pinned count (`rem` above); and
    /// None, never a wrap, at the u64 limits.
    #[test]
    fn unbalanced_gcd_bounds() {
        for la in 0..300u64 {
            for lb in 0..=la.min(40) {
                let u = gcd_unbalanced_work(la, lb).unwrap();
                assert!(u <= gcd_work(la, lb).unwrap(), "({}, {})", la, lb);
                assert_eq!(gcd_unbalanced_work(lb, la), Some(u), "either order");
            }
        }
        assert_eq!(rem_work(5, 2), Some((5 + 2 + 2) + 4 * 8 + (4 + 5 + 1)));
        assert_eq!(rem_work(5, 1), None);
        assert_eq!(rem_work(2, 3), None);
        assert_eq!(rem_work(u64::MAX, 2), None);
        assert_eq!(gcd_unbalanced_work(u64::MAX, 1), None);
        assert_eq!(gcd_unbalanced_work(u64::MAX, 0), None);
        assert_eq!(gcd_unbalanced_work(u64::MAX, u64::MAX), None);
        assert!(!rem_first(u64::MAX, 2));
        // a 1000-limb operand by a 2-limb one: linear, not quadratic
        assert!(gcd_unbalanced_work(1000, 2).unwrap() < 20 * 1000 + gcd_work(2, 2).unwrap());
    }
}
