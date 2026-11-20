//! The live word ledger and its ledger-owned buffers, shared by the
//! engine's polynomial ops (`pdivrem`, `pscale`): [`Words`] counts the words
//! of every growable buffer alive now against the call's limit; [`Buf`],
//! [`Coef`] and [`Arena`] reserve before they allocate and release when
//! dropped; `fixed_words` and `fixed_vec` allocate the fixed rows fallibly.

use crate::coprime::{Fault, Meter};
#[cfg(test)]
use crate::qpoly::bits;
use crate::qpoly::{norm, parse_hex};
use std::cell::Cell;
use std::cmp::Ordering;

/// Why a division stopped: its work passed the meter's limit, its memory
/// the ledger's, or an invariant failed (internal).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DivFault {
    Work,
    Memory,
    Invariant,
}

impl From<Fault> for DivFault {
    fn from(f: Fault) -> DivFault {
        match f {
            Fault::Overrun => DivFault::Work,
            Fault::Invariant => DivFault::Invariant,
        }
    }
}

/// The live word ledger: the words reserved by the buffers alive now
/// (`live`, never above `limit`), and their high-water mark.  A reservation
/// is made before each allocation and released when that memory is freed;
/// nothing resets it.
pub struct Words {
    pub(crate) live: Cell<u64>,
    pub(crate) limit: Cell<u64>,
    pub(crate) high: Cell<u64>,
    /// the fixed rows' words credited so far, and the largest of live minus
    /// them: the least starting limit the call's reservations need
    pub(crate) credited: Cell<u64>,
    pub(crate) required: Cell<u64>,
    /// (tests) each reservation's owner tag and its requirement: the least
    /// starting limit at which it succeeds (live + the words it reserves,
    /// less the fixed rows' words credited before it)
    #[cfg(test)]
    pub(crate) log: std::cell::RefCell<Vec<(&'static str, u64)>>,
}

impl Words {
    pub fn new(limit: u64) -> Words {
        Words {
            live: Cell::new(0),
            limit: Cell::new(limit),
            high: Cell::new(0),
            credited: Cell::new(0),
            required: Cell::new(0),
            #[cfg(test)]
            log: std::cell::RefCell::new(Vec::new()),
        }
    }
    pub fn live(&self) -> u64 {
        self.live.get()
    }
    pub fn limit(&self) -> u64 {
        self.limit.get()
    }
    pub fn high(&self) -> u64 {
        self.high.get()
    }
    /// The least starting limit at which the same call succeeds: the
    /// largest of live minus the words credited before it (the high-water,
    /// when nothing is credited).
    pub fn required(&self) -> u64 {
        self.required.get()
    }
    /// (tests) record a reservation's requirement: live + need.
    pub(crate) fn note(&self, _tag: &'static str, _need: u64) {
        #[cfg(test)]
        self.log.borrow_mut().push((_tag, self.live.get().saturating_add(_need).saturating_sub(self.credited.get())));
    }
    pub(crate) fn reserve(&self, n: u64) -> Result<(), DivFault> {
        let l = self.live.get().checked_add(n).ok_or(DivFault::Memory)?;
        if l > self.limit.get() {
            return Err(DivFault::Memory);
        }
        self.live.set(l);
        self.high.set(self.high.get().max(l));
        self.required.set(self.required.get().max(l - self.credited.get().min(l)));
        Ok(())
    }
    /// A fixed row's words, freed, become the ledger's (checked): the limit
    /// grows by them, so fixed + limit, the admitted peak, is unchanged.
    pub(crate) fn credit(&self, n: u64) -> Result<(), DivFault> {
        self.limit.set(self.limit.get().checked_add(n).ok_or(DivFault::Memory)?);
        self.credited.set(self.credited.get().checked_add(n).ok_or(DivFault::Memory)?);
        Ok(())
    }
    pub(crate) fn release(&self, n: u64) {
        // (only what a buffer reserved is released: never below zero)
        debug_assert!(self.live.get() >= n, "a release of words the ledger doesn't hold");
        self.live.set(self.live.get() - n);
    }
}

/// A ledger-owned buffer of words (zeroed when made), its capacity exactly
/// the words the ledger holds for it; released when dropped (so a refusal,
/// an allocation failure or a Stop's unwind returns them).
pub(crate) struct Buf<'l> {
    pub(crate) v: Vec<u64>,
    pub(crate) led: &'l Words,
    /// its owner, for the ledger's test log ("window", "scratch", "q arena", ...)
    pub(crate) tag: &'static str,
}

/// A fresh zeroed vector of exactly `cap` words, the ledger's reservation
/// already held (released here if the allocator refuses).
pub(crate) fn alloc(led: &Words, cap: usize) -> Result<Vec<u64>, DivFault> {
    let mut v: Vec<u64> = Vec::new();
    if v.try_reserve_exact(cap).is_err() {
        led.release(cap as u64);
        return Err(DivFault::Memory);
    }
    v.resize(cap, 0);
    Ok(v)
}

impl<'l> Buf<'l> {
    /// `cap` words, reserved before they are allocated.  Charges cap + 1
    /// (the fill).
    pub(crate) fn new(led: &'l Words, cap: usize, tag: &'static str, m: &mut Meter) -> Result<Buf<'l>, DivFault> {
        m.add(cap + 1)?;
        led.note(tag, cap as u64);
        led.reserve(cap as u64)?;
        let b = Buf { v: alloc(led, cap)?, led, tag };
        b.check();
        Ok(b)
    }
    pub(crate) fn cap(&self) -> usize {
        self.v.len()
    }
    pub(crate) fn check(&self) {
        debug_assert_eq!(self.v.capacity(), self.v.len(), "a buffer's capacity is the capacity the ledger holds for it");
    }
    /// At least `need` words, the first `keep` kept: the one growth path.
    /// The new capacity is max(need, c + c/2), whatever the limit (so a
    /// call makes the same reservations at every limit, and its verdict is
    /// monotone in the limit); it is reserved while the old capacity c is
    /// still held (old and new are both live during the copy), then the old
    /// buffer is freed and c released.  Charges the new buffer's fill and the
    /// copy before either.
    pub(crate) fn grow(&mut self, need: usize, keep: usize, m: &mut Meter) -> Result<(), DivFault> {
        let c = self.v.len();
        if need <= c {
            return Ok(());
        }
        let c2 = need.max(c.checked_add(c / 2).ok_or(DivFault::Memory)?);
        #[cfg(test)]
        let c2 = if EXACT.with(|e| e.get()) { need } else { c2 };
        self.led.note(self.tag, c2 as u64);
        m.add(c2 + keep + 1)?;
        self.led.reserve(c2 as u64)?;
        let mut v = alloc(self.led, c2)?;
        v[..keep].copy_from_slice(&self.v[..keep]);
        drop(std::mem::replace(&mut self.v, v));
        self.led.release(c as u64);
        self.check();
        Ok(())
    }
}

impl Drop for Buf<'_> {
    fn drop(&mut self) {
        self.led.release(self.v.len() as u64);
    }
}

#[cfg(test)]
thread_local! {
    /// (tests) the largest bit length any coefficient reached (E7's check)
    pub(crate) static MAX_BITS: Cell<u64> = const { Cell::new(0) };
    /// (tests) grow to the exact need instead: the exact policy's live words,
    /// to measure the deterministic policy's slack against
    pub(crate) static EXACT: Cell<bool> = const { Cell::new(false) };
    /// (tests) the arena entries the iterators have visited
    pub(crate) static VISITS: Cell<u64> = const { Cell::new(0) };
}

fn visit() {
    #[cfg(test)]
    VISITS.with(|c| c.set(c.get() + 1));
}

pub(crate) fn track(_x: &[u64]) {
    #[cfg(test)]
    MAX_BITS.with(|c| c.set(c.get().max(bits(_x))));
}

/// A fixed row of `n` zeroed words, allocated fallibly: an allocation
/// failure is the memory refusal, never an abort.  Its words are counted in
/// the fixed rows, not the ledger.
pub(crate) fn fixed_words(n: usize) -> Result<Vec<u64>, DivFault> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| DivFault::Memory)?;
    v.resize(n, 0);
    Ok(v)
}

/// A fixed row's empty vector with room for `n` items, allocated fallibly
/// (pushes within it allocate nothing).
pub(crate) fn fixed_vec<T>(n: usize) -> Result<Vec<T>, DivFault> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| DivFault::Memory)?;
    Ok(v)
}

pub(crate) fn cmp_mag(x: &[u64], y: &[u64]) -> Ordering {
    if x.len() != y.len() {
        return x.len().cmp(&y.len());
    }
    for i in (0..x.len()).rev() {
        if x[i] != y[i] {
            return x[i].cmp(&y[i]);
        }
    }
    Ordering::Equal
}

/// A signed integer in a ledger-owned buffer: its magnitude's normalized
/// limbs are `buf[..len]` (0 for zero, never negative).
pub(crate) struct Coef<'l> {
    pub(crate) buf: Buf<'l>,
    pub(crate) len: usize,
    pub(crate) neg: bool,
}

impl<'l> Coef<'l> {
    pub(crate) fn new(led: &'l Words, cap: usize, m: &mut Meter) -> Result<Coef<'l>, DivFault> {
        Coef::tagged(led, cap, "window", m)
    }
    pub(crate) fn tagged(led: &'l Words, cap: usize, tag: &'static str, m: &mut Meter) -> Result<Coef<'l>, DivFault> {
        Ok(Coef { buf: Buf::new(led, cap, tag, m)?, len: 0, neg: false })
    }
    /// Set from a magnitude and a sign.  Charges the growth and the copy.
    pub(crate) fn set(&mut self, mag: &[u64], neg: bool, m: &mut Meter) -> Result<(), DivFault> {
        self.buf.grow(mag.len(), 0, m)?;
        m.add(mag.len() + 1)?;
        self.buf.v[..mag.len()].copy_from_slice(mag);
        self.len = mag.len();
        self.neg = neg && self.len > 0;
        track(self.mag());
        Ok(())
    }
    pub(crate) fn is_one(&self) -> bool {
        self.len == 1 && self.buf.v[0] == 1
    }
    pub(crate) fn mag(&self) -> &[u64] {
        &self.buf.v[..self.len]
    }
    /// Set from a canonical token's sign and hex digits.  Charges the
    /// growth (if any) and the parse.
    pub(crate) fn set_hex(&mut self, neg: bool, digits: &str, m: &mut Meter) -> Result<(), DivFault> {
        self.buf.grow(digits.len().div_ceil(16), 0, m)?;
        self.len = parse_hex(digits, &mut self.buf.v, m)?;
        self.neg = neg && self.len > 0;
        track(self.mag());
        Ok(())
    }
    /// self -= (-1)^p_neg p, p a normalized magnitude.  The destination's
    /// limb bound, max(len, len p) + 1, is reserved (by growth) before
    /// anything is written; the add or subtract is charged before it runs.
    pub(crate) fn sub_signed(&mut self, p: &[u64], p_neg: bool, m: &mut Meter) -> Result<(), DivFault> {
        let lp = p.len();
        if lp == 0 {
            return Ok(());
        }
        // (adding the term -(-1)^p_neg p, of sign !p_neg)
        let term_neg = !p_neg;
        let top = self.len.max(lp);
        self.buf.grow(top + 1, self.len, m)?;
        m.add(top + 1)?;
        let len = self.len;
        let v = &mut self.buf.v;
        if len == 0 || self.neg == term_neg {
            let mut carry = 0u64;
            for i in 0..top {
                let a = if i < len { v[i] } else { 0 };
                let b = if i < lp { p[i] } else { 0 };
                let (s, c1) = a.overflowing_add(b);
                let (s, c2) = s.overflowing_add(carry);
                v[i] = s;
                carry = u64::from(c1) + u64::from(c2);
            }
            v[top] = carry;
            self.len = norm(v, top + 1);
            self.neg = term_neg && self.len > 0;
            track(self.mag());
            return Ok(());
        }
        // (opposite signs: the larger magnitude less the smaller, its sign)
        if cmp_mag(&v[..len], p) != Ordering::Less {
            let mut borrow = 0u64;
            for i in 0..len {
                let b = if i < lp { p[i] } else { 0 };
                let (d, b1) = v[i].overflowing_sub(b);
                let (d, b2) = d.overflowing_sub(borrow);
                v[i] = d;
                borrow = u64::from(b1) + u64::from(b2);
            }
            if borrow != 0 {
                return Err(DivFault::Invariant);
            }
            self.len = norm(v, len);
        } else {
            let mut borrow = 0u64;
            for i in 0..lp {
                let a = if i < len { v[i] } else { 0 };
                let (d, b1) = p[i].overflowing_sub(a);
                let (d, b2) = d.overflowing_sub(borrow);
                v[i] = d;
                borrow = u64::from(b1) + u64::from(b2);
            }
            if borrow != 0 {
                return Err(DivFault::Invariant);
            }
            self.len = norm(v, lp);
            self.neg = term_neg;
        }
        if self.len == 0 {
            self.neg = false;
        }
        track(self.mag());
        Ok(())
    }
}

/// Coefficients appended one by one (a growable words buffer and one
/// metadata word per coefficient, `len << 1 | neg`), read back from the end.
pub(crate) struct Arena<'l> {
    pub(crate) words: Buf<'l>,
    pub(crate) meta: Buf<'l>,
    pub(crate) nw: usize,
    pub(crate) nt: usize,
}

impl<'l> Arena<'l> {
    pub(crate) fn new(led: &'l Words, tag: &'static str, m: &mut Meter) -> Result<Arena<'l>, DivFault> {
        Ok(Arena { words: Buf::new(led, 0, tag, m)?, meta: Buf::new(led, 0, tag, m)?, nw: 0, nt: 0 })
    }
    /// Append a magnitude and its sign.  Charges the growth and the copy.
    pub(crate) fn push(&mut self, mag: &[u64], neg: bool, m: &mut Meter) -> Result<(), DivFault> {
        let nw2 = self.nw.checked_add(mag.len()).ok_or(DivFault::Memory)?;
        self.words.grow(nw2, self.nw, m)?;
        self.meta.grow(self.nt + 1, self.nt, m)?;
        m.add(mag.len() + 1)?;
        self.words.v[self.nw..nw2].copy_from_slice(mag);
        self.meta.v[self.nt] = ((mag.len() as u64) << 1) | u64::from(neg && !mag.is_empty());
        self.nw = nw2;
        self.nt += 1;
        Ok(())
    }
    /// The coefficients from the last appended to the first.
    pub(crate) fn rev(&self) -> impl Iterator<Item = (&[u64], bool)> + '_ {
        let mut end = self.nw;
        (0..self.nt).rev().map(move |t| {
            visit();
            let w = self.meta.v[t];
            let len = (w >> 1) as usize;
            end -= len;
            (&self.words.v[end..end + len], w & 1 == 1)
        })
    }
    /// The coefficients in the order appended.
    pub(crate) fn fwd(&self) -> impl Iterator<Item = (&[u64], bool)> + '_ {
        let mut start = 0;
        (0..self.nt).map(move |t| {
            visit();
            let w = self.meta.v[t];
            let len = (w >> 1) as usize;
            start += len;
            (&self.words.v[start - len..start], w & 1 == 1)
        })
    }
    /// Words held (both buffers' capacities).
    pub(crate) fn words(&self) -> u64 {
        (self.words.cap() + self.meta.cap()) as u64
    }
}

/// The charge of one token of a walk over `total` tokens (the i-th): at each
/// 4096-token chunk's start, Stop polled and the chunk's units (one a token)
/// charged before its walk.
pub(crate) fn walk_charge(i: usize, total: usize, m: &mut Meter) -> Result<(), DivFault> {
    if i & 0xfff == 0 {
        sagebrush_interrupt::check_coarse();
        m.add(total.saturating_sub(i).min(0x1000))?;
    }
    Ok(())
}
