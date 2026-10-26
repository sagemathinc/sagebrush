//! WebAssembly page growth (no-cliffs C r15 sections 1 and 2; r14 section
//! 1.1 and 1.4–1.5): the growth envelope W(b), a growth reservation sized by
//! the ledger, and a two-phase permit around each `memory.grow`.
//!
//! - Natively, `reserve_growth(what, b)` is `reserve(what, b)`: a native
//!   block is a fresh allocation, reserved in full; no permits.
//! - In WebAssembly, under the ledger's lock, room = max(0, floor(E / phi) -
//!   L - R_ret - O) and g = min(W(b), room) is charged into O as the handle's
//!   `held`.  g = 0 is success (the block must come from free memory).
//! - Before each `memory.grow` of k bytes the budgeted allocator asks
//!   `permit(k)`; after the grow succeeded it calls `commit()`, which
//!   releases the full k from O (the watermark L >= M now covers it); a
//!   permit dropped without commit (the grow failed, or any early exit)
//!   changes nothing.  At most one permit is in flight per instance; no lock
//!   is held across the grow.
//! - r15's full-k permit/commit supersedes r14's `consume` and its Delta-L
//!   release: Delta-L (the change in L across the grow) is only observed.

use super::*;

/// A WebAssembly page.
pub const PAGE: u64 = 65536;

/// W(b) = ceil((b + 64) / 65536) * 65536 + 65536 (C r15 section 1): the
/// block, its chunk header and alignment (at most 64 B), the rounding to
/// whole pages, and one page of top-chunk and segment slack.  Checked: None
/// when it doesn't fit in u64 (such a block is never admitted).
pub fn growth_envelope(block: u64) -> Option<u64> {
    block.checked_add(64)?.div_ceil(PAGE).checked_mul(PAGE)?.checked_add(PAGE)
}

/// The instance's committed bytes when the ledger runs on pages: in
/// WebAssembly the memory's size; natively None (tests: a fake page count,
/// hooks::set_fake_committed).
pub(crate) fn paged_committed() -> Option<u64> {
    #[cfg(target_arch = "wasm32")]
    {
        Some((core::arch::wasm32::memory_size::<0>() as u64) << 16)
    }
    #[cfg(all(not(target_arch = "wasm32"), any(test, feature = "test-hooks")))]
    {
        hooks::fake_committed()
    }
    #[cfg(all(not(target_arch = "wasm32"), not(any(test, feature = "test-hooks"))))]
    {
        None
    }
}

/// L on pages: max(committed, B_w + R_res) (C r12 section 3).
pub(crate) fn paged_live(s: &mut State, committed: u64) -> u64 {
    let b = *s.baseline.get_or_insert(committed);
    committed.max(b.saturating_add(s.resident))
}

/// The row that binds a growth room (C r16b): its scope and its own total;
/// R_ret is its term only on the shared row.
#[derive(Clone, Copy)]
struct Bind {
    row: &'static str,
    total: Total,
}

impl Bind {
    fn retired(self, s: &State) -> u64 {
        if self.row == "shared" { s.retired } else { 0 }
    }
}

/// The room under every row in force (C r16b section 3.2), at least 0, and
/// the row that binds it: the shared total's floor(E / phi) - L - R_ret - O
/// and the instance total's floor(E / phi) - L - O, the least of them.
/// There is always a row: an absent shared total with no instance total is
/// the nominal one (shared_row; never the whole envelope).
fn room_locked(s: &mut State, t: Total, committed: u64) -> (u64, Bind) {
    let l = paged_live(s, committed);
    let (outstanding, retired) = (s.outstanding, s.retired);
    let room = |e: u64, ret: u64| {
        let e_over_phi = (e as u128 * FRAG_DEN as u128 / FRAG_NUM as u128) as u64;
        e_over_phi.saturating_sub(l).saturating_sub(ret).saturating_sub(outstanding)
    };
    let shared = shared_row(t, s.instance.is_some()).map(|sh| (room(allowance(sh), retired), Bind { row: "shared", total: sh }));
    let inst = s.instance.map(|i| (room(allowance(i), 0), Bind { row: "instance", total: i }));
    match (shared, inst) {
        (Some(a), Some(b)) => if b.0 < a.0 { b } else { a },
        (Some(a), None) => a,
        (None, Some(b)) => b,
        // (unreachable: shared_row is none only beside an instance total)
        (None, None) => (0, Bind { row: "shared", total: NOMINAL }),
    }
}

/// A growth refusal on the row `b`, with that row's own figures.
fn refusal(what: &str, b: Bind, need: u64, live: u64, outstanding: u64, retired: u64) -> EngineError {
    EngineError::Memory(Refusal {
        what: what.to_string(),
        row: b.row,
        need,
        allowance: allowance(b.total),
        live,
        outstanding,
        total: b.total.bytes,
        status: b.total.status,
        joint: b.total.joint,
        available: None,
        measured: true,
        retired,
    })
}

/// A growth reservation: natively a reservation of the whole block; in
/// WebAssembly the bytes the block may add to the instance's pages, drawn on
/// by permits.  Dropping it releases what it still holds.
#[must_use = "a growth reservation is released as soon as it is dropped"]
pub struct Growth {
    kind: Kind,
}

enum Kind {
    Native(Reservation),
    Paged { chain: u64, granted: u64, held: u64, bind: Bind },
}

/// Reserve the page growth of a block of `block` bytes (C r15 section 1).
/// Natively `reserve(what, block)`.  In WebAssembly, g = min(W(block),
/// room) is granted (g = 0 is success); it refuses only a block whose
/// envelope overflows, and, on a certification-dependent chain, an
/// uncertified ledger (a refresh can't downgrade it, C-2a).
pub fn reserve_growth(what: &str, block: u64) -> Result<Growth, EngineError> {
    if paged_committed().is_none() {
        return reserve(what, block).map(|r| Growth { kind: Kind::Native(r) });
    }
    let chain = current_chain();
    let t = total();
    let w = growth_envelope(block);
    let mut s = state();
    let committed = paged_committed().unwrap_or(0);
    let protected = s.is_certified_chain(chain);
    let uncertified = !wasm_totals_certified(s.fault, t, s.instance);
    let live = paged_live(&mut s, committed);
    let outstanding = s.outstanding;
    let (room, bind) = room_locked(&mut s, t, committed);
    if let (Some(w), false) = (w, protected && uncertified) {
        let g = w.min(room);
        if g > 0 {
            if s.chain_add(chain, g).is_err() {
                drop(s);
                return Err(EngineError::Internal(format!("more than {} chains hold reservations at once", CHAIN_SLOTS)));
            }
            s.set_outstanding(outstanding + g);
        }
        return Ok(Growth { kind: Kind::Paged { chain, granted: g, held: g, bind } });
    }
    let retired = bind.retired(&s);
    drop(s);
    Err(refusal(what, bind, w.unwrap_or(u64::MAX), live, outstanding, retired))
}

impl Growth {
    /// The bytes granted (WebAssembly: g; natively the block).
    pub fn granted(&self) -> u64 {
        match &self.kind {
            Kind::Native(r) => r.amount(),
            Kind::Paged { granted, .. } => *granted,
        }
    }

    /// The bytes still held in O.
    pub fn held(&self) -> u64 {
        match &self.kind {
            Kind::Native(r) => r.amount(),
            Kind::Paged { held, .. } => *held,
        }
    }

    /// The allocations made while the returned guard lives are this
    /// growth's (the test-only audit; a no-op otherwise).
    pub fn scope(&self) -> Scope {
        Scope::enter()
    }

    /// Phase one, before `memory.grow(k / 65536)` (C r15 section 2.1): k a
    /// whole number of pages within what the handle holds.  At most one
    /// permit is in flight on the instance.  WebAssembly only (a native
    /// block is reserved in full and never grows pages).
    pub fn permit(&mut self, k: u64) -> Result<GrowPermit<'_>, EngineError> {
        let (held, bind) = match &self.kind {
            Kind::Native(_) => return Err(EngineError::Internal("a growth permit is for WebAssembly pages; a native block is reserved in full".into())),
            Kind::Paged { held, bind, .. } => (*held, *bind),
        };
        if !k.is_multiple_of(PAGE) {
            return Err(EngineError::Internal(format!("a growth permit of {} bytes is not a whole number of pages", k)));
        }
        let mut s = state();
        if s.permit_in_flight != 0 {
            drop(s);
            return Err(EngineError::Internal("a growth permit is already in flight on this instance".into()));
        }
        let committed = paged_committed().unwrap_or(0);
        let live = paged_live(&mut s, committed);
        if k > held {
            // (the row that bound the grant, with its own figures)
            let (outstanding, retired) = (s.outstanding, bind.retired(&s));
            drop(s);
            return Err(refusal("memory growth", bind, k, live, outstanding, retired));
        }
        // (a zero-byte permit still occupies the one slot)
        s.permit_in_flight = k.max(1);
        drop(s);
        Ok(GrowPermit { growth: self, k, live_before: live, done: false })
    }
}

impl Drop for Growth {
    fn drop(&mut self) {
        if let Kind::Paged { chain, held, .. } = self.kind {
            if held > 0 {
                let mut s = state();
                let t = s.chain_take(chain, held);
                let o = s.outstanding - t;
                s.set_outstanding(o);
            }
        }
    }
}

/// A growth permit in flight: `commit()` after an exact successful
/// `memory.grow(k / 65536)`; dropped without commit (the grow returned -1,
/// or any early exit), it changes nothing.
#[must_use = "a permit dropped without commit aborts"]
pub struct GrowPermit<'a> {
    growth: &'a mut Growth,
    k: u64,
    live_before: u64,
    done: bool,
}

impl GrowPermit<'_> {
    /// Phase two (C r15 section 2.1): the full k leaves O and the handle
    /// (the old watermark covers k - Delta-L, the new one Delta-L, since
    /// L >= M after the grow); Delta-L is recorded for audit only.
    pub fn commit(mut self) {
        self.done = true;
        let k = self.k;
        let mut s = state();
        let committed = paged_committed().unwrap_or(0);
        let live_after = paged_live(&mut s, committed);
        if let Kind::Paged { chain, held, .. } = &mut self.growth.kind {
            let t = s.chain_take(*chain, k);
            let o = s.outstanding - t;
            s.set_outstanding(o);
            *held -= k;
        }
        s.permit_in_flight = 0;
        s.last_growth_delta = live_after.saturating_sub(self.live_before);
    }
}

impl Drop for GrowPermit<'_> {
    fn drop(&mut self) {
        if !self.done {
            state().permit_in_flight = 0;
        }
    }
}

/// The last committed growth's Delta-L (an audit observation, C r15
/// section 2.1).
pub fn last_growth_delta() -> u64 {
    state().last_growth_delta
}
