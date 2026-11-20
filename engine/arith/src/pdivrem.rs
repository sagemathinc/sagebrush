//! Division with remainder of polynomials, for the `zpoly_divrem` and
//! `qpoly_divrem` ops (design: the division note r3.3).
//!
//! - **Z** (`zpoly_divrem`): Sage's rule in Z[x], from the top degree down:
//!   when |r_i| >= |c| (c the divisor's leading coefficient) the quotient
//!   coefficient is floor(r_i / c) and r -= t x^(i-m) b; a smaller r_i
//!   stays in the remainder (so the remainder may keep degree >= m).
//! - **Q** (`qpoly_divrem`): exact division in Q[x] (in a later change).
//!
//! The (M) pattern: one work [`Meter`] for the whole call (limit WORK_MAX -
//! R, never reset), every unit charged before the work it counts; and one
//! word ledger ([`Words`]) for the memory that grows with the actual sizes:
//! every growable buffer is a ledger reservation from its first capacity on
//! ([`Buf`]), each growth reserving its new capacity while the old one is
//! still held (both are live during the copy), and released when freed.
//! The fixed rows (the request, the divisor's storage, the window's and the
//! arenas' metadata) are closed forms, admitted before anything else; the
//! ledger's limit is the cap minus them.  The reply is reserved exactly from
//! the actual output after the division, and written without allocating.

use crate::coprime::{divrem_in_place, Fault, Meter};
use crate::qpoly::{self, bits, mul_into, norm, parse_hex, parts, Factor};
use crate::zmul::hex;
use crate::zseries::INTERNAL_PREFIX;
use std::cell::Cell;
use std::cmp::Ordering;

/// The words a coefficient's metadata is charged at, in the fixed rows and
/// the arenas: the larger of the two targets' layouts (a [`Coef`] is at most
/// 64 bytes on a 64-bit target, less on wasm32; const-asserted below).
pub const META_WORDS: u64 = 8;
/// The call's fixed owners beyond the request, the divisor and the window's
/// metadata (the meter, the ledger, the arenas' headers), at most this many
/// words.
pub const OVERHEAD_WORDS: u64 = 64;
const _: () = assert!(std::mem::size_of::<Coef<'static>>() as u64 <= 8 * META_WORDS);

const HOW: &str = "a smaller division per call";

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
    live: Cell<u64>,
    limit: Cell<u64>,
    high: Cell<u64>,
    /// (tests) each reservation's owner tag and its requirement: the least
    /// limit at which it succeeds (live + the words it reserves)
    #[cfg(test)]
    log: std::cell::RefCell<Vec<(&'static str, u64)>>,
}

impl Words {
    pub fn new(limit: u64) -> Words {
        Words {
            live: Cell::new(0),
            limit: Cell::new(limit),
            high: Cell::new(0),
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
    /// (tests) record a reservation's requirement: live + need.
    fn note(&self, _tag: &'static str, _need: u64) {
        #[cfg(test)]
        self.log.borrow_mut().push((_tag, self.live.get().saturating_add(_need)));
    }
    fn reserve(&self, n: u64) -> Result<(), DivFault> {
        let l = self.live.get().checked_add(n).ok_or(DivFault::Memory)?;
        if l > self.limit.get() {
            return Err(DivFault::Memory);
        }
        self.live.set(l);
        self.high.set(self.high.get().max(l));
        Ok(())
    }
    fn release(&self, n: u64) {
        // (only what a buffer reserved is released: never below zero)
        debug_assert!(self.live.get() >= n, "a release of words the ledger doesn't hold");
        self.live.set(self.live.get() - n);
    }
}

/// A ledger-owned buffer of words (zeroed when made), its capacity exactly
/// the words the ledger holds for it; released when dropped (so a refusal,
/// an allocation failure or a Stop's unwind returns them).
pub(crate) struct Buf<'l> {
    v: Vec<u64>,
    led: &'l Words,
    /// its owner, for the ledger's test log ("window", "scratch", "q arena", ...)
    tag: &'static str,
}

/// A fresh zeroed vector of exactly `cap` words, the ledger's reservation
/// already held (released here if the allocator refuses).
fn alloc(led: &Words, cap: usize) -> Result<Vec<u64>, DivFault> {
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
    fn cap(&self) -> usize {
        self.v.len()
    }
    fn check(&self) {
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
}

fn track(_x: &[u64]) {
    #[cfg(test)]
    MAX_BITS.with(|c| c.set(c.get().max(bits(_x))));
}

fn cmp_mag(x: &[u64], y: &[u64]) -> Ordering {
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
    buf: Buf<'l>,
    len: usize,
    neg: bool,
}

impl<'l> Coef<'l> {
    fn new(led: &'l Words, cap: usize, m: &mut Meter) -> Result<Coef<'l>, DivFault> {
        Ok(Coef { buf: Buf::new(led, cap, "window", m)?, len: 0, neg: false })
    }
    fn mag(&self) -> &[u64] {
        &self.buf.v[..self.len]
    }
    /// Set from a canonical token's sign and hex digits.  Charges the
    /// growth (if any) and the parse.
    fn set_hex(&mut self, neg: bool, digits: &str, m: &mut Meter) -> Result<(), DivFault> {
        self.buf.grow(digits.len().div_ceil(16), 0, m)?;
        self.len = parse_hex(digits, &mut self.buf.v, m)?;
        self.neg = neg && self.len > 0;
        track(self.mag());
        Ok(())
    }
    /// self -= (-1)^p_neg p, p a normalized magnitude.  The destination's
    /// limb bound, max(len, len p) + 1, is reserved (by growth) before
    /// anything is written; the add or subtract is charged before it runs.
    fn sub_signed(&mut self, p: &[u64], p_neg: bool, m: &mut Meter) -> Result<(), DivFault> {
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
    words: Buf<'l>,
    meta: Buf<'l>,
    nw: usize,
    nt: usize,
}

impl<'l> Arena<'l> {
    fn new(led: &'l Words, tag: &'static str, m: &mut Meter) -> Result<Arena<'l>, DivFault> {
        Ok(Arena { words: Buf::new(led, 0, tag, m)?, meta: Buf::new(led, 0, tag, m)?, nw: 0, nt: 0 })
    }
    /// Append a magnitude and its sign.  Charges the growth and the copy.
    fn push(&mut self, mag: &[u64], neg: bool, m: &mut Meter) -> Result<(), DivFault> {
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
    fn rev(&self) -> impl Iterator<Item = (&[u64], bool)> + '_ {
        let mut end = self.nw;
        (0..self.nt).rev().map(move |t| {
            let w = self.meta.v[t];
            let len = (w >> 1) as usize;
            end -= len;
            (&self.words.v[end..end + len], w & 1 == 1)
        })
    }
    /// The coefficients in the order appended.
    fn fwd(&self) -> impl Iterator<Item = (&[u64], bool)> + '_ {
        let mut start = 0;
        (0..self.nt).map(move |t| {
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

/// The normalized length of a polynomial's tokens: the count up to its last
/// token with a nonzero numerator (0 for the zero polynomial).  One pass from
/// the end over the zero tokens.
pub fn norm_len(f: &Factor) -> u64 {
    if f.tokens == 0 || f.all_zero {
        return 0;
    }
    let mut zeros = 0u64;
    for (i, tok) in f.text.rsplit(',').enumerate() {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        if parts(tok).1 != "0" {
            break;
        }
        zeros += 1;
    }
    f.tokens - zeros
}

/// One division's shape, admitted before anything is allocated.
#[derive(Clone, Copy, Debug)]
pub struct Plan {
    /// deg a, deg b (normalized), and the steps k = n - m + 1 (0 when n < m)
    pub n: u64,
    pub m: u64,
    pub k: u64,
    /// the fixed rows (words) and the ledger's limit: cap - fixed
    pub fixed: u64,
    pub limit: u64,
    /// the work meter's limit: WORK_MAX - R
    pub work: u64,
}

/// What a call answers before any division: the zero polynomial as
/// dividend, or a dividend of lower degree (its tokens, as given).
pub enum Short<'a> {
    Zero,
    Lower(&'a str),
}

/// The fixed rows for Z, in words: the request (ceil(R / 8)), the divisor's
/// limbs (at most its scan's limb sum) and its m + 1 coefficients'
/// metadata, the window's m + 1 metadata words, and the call's other owners.
pub fn fixed_rows_z(b: &Factor, m: u64, r: u64) -> Option<u64> {
    let meta = m.checked_add(1)?.checked_mul(META_WORDS)?;
    r.div_ceil(8).checked_add(b.n_sum)?.checked_add(meta)?.checked_add(meta)?.checked_add(OVERHEAD_WORDS)
}

/// Normalization and admission for zpoly_divrem, before any size arithmetic
/// on the shapes and before anything is allocated: a zero divisor in any
/// spelling is refused; a zero or lower-degree dividend is answered.
pub fn admit_z<'a>(a: &Factor<'a>, b: &Factor, r: u64, caps: &qpoly::Caps) -> Result<Result<Plan, Short<'a>>, String> {
    if r > caps.int.request {
        return Err(format!("the request's bytes = {} is more than {} ({})", r, caps.int.request, HOW));
    }
    let nb = norm_len(b);
    if nb == 0 {
        return Err("division by zero polynomial".to_string());
    }
    let na = norm_len(a);
    if na == 0 {
        return Ok(Err(Short::Zero));
    }
    let (n, m) = (na - 1, nb - 1);
    if n < m {
        let end = a.text.match_indices(',').nth(na as usize - 1).map_or(a.text.len(), |(i, _)| i);
        return Ok(Err(Short::Lower(&a.text[..end])));
    }
    let k = n - m + 1;
    let fixed = fixed_rows_z(b, m, r).ok_or_else(|| "the division's size overflows".to_string())?;
    let cap = caps.int.peak / 8;
    if fixed > cap {
        return Err(format!("the memory (bytes) = {} is more than {} ({})", fixed.saturating_mul(8), caps.int.peak, HOW));
    }
    let work = caps.int.work.checked_sub(r).ok_or_else(|| format!("the request's bytes = {} leave no work within {} ({})", r, caps.int.work, HOW))?;
    Ok(Ok(Plan { n, m, k, fixed, limit: cap - fixed, work }))
}

/// The divisor's coefficients, in the fixed storage (one limbs vector and
/// one (start, len, neg) row per coefficient), constant first.
pub(crate) struct Divisor {
    limbs: Vec<u64>,
    rows: Vec<(usize, usize, bool)>,
}

impl Divisor {
    fn get(&self, l: usize) -> (&[u64], bool) {
        let (s, n, neg) = self.rows[l];
        (&self.limbs[s..s + n], neg)
    }
}

/// Parse the divisor's first m + 1 tokens into its fixed storage (at most
/// its scan's limb sum).  Charges each parse.
fn load_divisor(b: &Factor, plan: &Plan, m: &mut Meter) -> Result<Divisor, DivFault> {
    let _p = sagebrush_interrupt::enter("divrem load");
    sagebrush_interrupt::check_coarse();
    let w = plan.m as usize + 1;
    let mut limbs = vec![0u64; b.n_sum as usize];
    let mut rows = Vec::with_capacity(w);
    let mut at = 0usize;
    for tok in b.text.split(',').take(w) {
        let (neg, num, _) = parts(tok);
        let n = parse_hex(num, &mut limbs[at..], m)?;
        rows.push((at, n, neg && n > 0));
        at += n;
    }
    Ok(Divisor { limbs, rows })
}

/// The division's result: the quotient's coefficients (appended from the
/// top degree down) and the remainder's (Z: degrees n down to 0).
pub struct Divided<'l> {
    q: Arena<'l>,
    r: Arena<'l>,
}

impl Divided<'_> {
    /// The words the two arenas hold.
    pub fn words(&self) -> u64 {
        self.q.words() + self.r.words()
    }
}

/// Z's division on the caller's ledger and meter (tests read both after a
/// refusal).  Every buffer it makes is ledger-owned and freed on return,
/// but for the two arenas.
pub fn divide_z<'l>(a: &Factor, b: &Factor, plan: &Plan, led: &'l Words, m: &mut Meter) -> Result<Divided<'l>, DivFault> {
    let d = load_divisor(b, plan, m)?;
    let _p = sagebrush_interrupt::enter("divrem divide");
    sagebrush_interrupt::check_coarse();
    let (w, k) = (plan.m as usize + 1, plan.k as usize);
    let (c, c_neg) = d.get(w - 1);
    let lc = c.len();
    // (the dividend's tokens from its top degree down, trailing zeros skipped)
    let skip = (a.tokens - plan.n - 1) as usize;
    let mut toks = a.text.rsplit(',').skip(skip);
    // the window: slot(l) = ring[(h + l) % w] holds degree (top - m + l)
    let mut ring: Vec<Coef<'l>> = Vec::with_capacity(w);
    for _ in 0..w {
        ring.push(Coef::new(led, 0, m)?);
    }
    for l in (0..w).rev() {
        let (neg, num, _) = parts(toks.next().ok_or(DivFault::Invariant)?);
        ring[l].set_hex(neg, num, m)?;
    }
    let mut h = 0usize;
    let mut cbuf = Buf::new(led, lc, "scratch", m)?;
    cbuf.v[..lc].copy_from_slice(c);
    let mut tmag = Buf::new(led, lc + 1, "scratch", m)?;
    let mut tq = Buf::new(led, 1, "scratch", m)?;
    let mut prod = Buf::new(led, lc + 1, "scratch", m)?;
    let mut q = Arena::new(led, "q arena", m)?;
    let mut r = Arena::new(led, "r arena", m)?;
    for s in 0..k {
        let topi = (h + w - 1) % w;
        let (lt, t_neg) = (ring[topi].len, ring[topi].neg != c_neg);
        if cmp_mag(ring[topi].mag(), c) != Ordering::Less {
            // t = floor(top / c): Knuth D on the magnitudes, then the floor's
            // sign fix-up when the signs differ and the remainder isn't 0
            tmag.grow(lt + 1, 0, m)?;
            m.add(lt + 1)?;
            tmag.v[..lt].copy_from_slice(ring[topi].mag());
            tq.grow(lt - lc + 2, 0, m)?;
            let (mut nq, nr) = divrem_in_place(&mut tmag.v, lt, &mut cbuf.v, lc, &mut tq.v, m)?;
            if t_neg && nr > 0 {
                floor_fix(&mut tq, &mut nq, m)?;
            }
            for l in 0..w {
                let (bl, b_neg) = d.get(l);
                if bl.is_empty() {
                    continue;
                }
                prod.grow(nq + bl.len(), 0, m)?;
                let np = mul_into(&tq.v[..nq], bl, &mut prod.v, m)?;
                ring[(h + l) % w].sub_signed(&prod.v[..np], t_neg != b_neg, m)?;
            }
            track(&tq.v[..nq]);
            q.push(&tq.v[..nq], t_neg, m)?;
        } else {
            q.push(&[], false, m)?;
        }
        // the top coefficient leaves (Z keeps it in the remainder); its slot
        // takes the next coefficient at the bottom
        r.push(ring[topi].mag(), ring[topi].neg, m)?;
        if s + 1 < k {
            let (neg, num, _) = parts(toks.next().ok_or(DivFault::Invariant)?);
            ring[topi].set_hex(neg, num, m)?;
            h = topi;
        }
    }
    // the remainder's low degrees (m - 1 down to 0) from the window, which
    // is then freed, with the step scratch, before the reply is reserved
    for l in (0..w - 1).rev() {
        let i = (h + l) % w;
        r.push(ring[i].mag(), ring[i].neg, m)?;
    }
    drop((ring, cbuf, tmag, tq, prod));
    Ok(Divided { q, r })
}

/// |t| += 1 (the floor of a negative inexact quotient): `floor_fix(l_t) =
/// l_t + 1` units, charged before.
fn floor_fix(tq: &mut Buf, nq: &mut usize, m: &mut Meter) -> Result<(), DivFault> {
    tq.grow(*nq + 1, *nq, m)?;
    m.add(*nq + 1)?;
    // (the limb above the quotient may hold an earlier step's value)
    tq.v[*nq] = 0;
    let mut i = 0;
    loop {
        let (s, c) = tq.v[i].overflowing_add(1);
        tq.v[i] = s;
        if !c {
            break;
        }
        i += 1;
    }
    *nq = (*nq).max(i + 1);
    Ok(())
}

/// A token's bytes in the reply: `0`, or a sign and its hex digits.
fn token_bytes(mag: &[u64], neg: bool) -> u64 {
    if mag.is_empty() {
        1
    } else {
        u64::from(neg) + bits(mag).div_ceil(4)
    }
}

/// The reply's exact bytes, `{"ok":{"q":"...","r":"..."}}` (22 fixed
/// bytes), each list trimmed of its trailing (top-degree) zeros.
pub fn reply_bytes(dv: &Divided) -> Option<u64> {
    let list = |a: &Arena| -> Option<u64> {
        let lead = a.fwd().take_while(|(x, _)| x.is_empty()).count();
        let mut total = 0u64;
        let mut count = 0u64;
        for (x, neg) in a.fwd().skip(lead) {
            total = total.checked_add(token_bytes(x, neg))?;
            count += 1;
        }
        total.checked_add(count.saturating_sub(1))
    };
    22u64.checked_add(list(&dv.q)?)?.checked_add(list(&dv.r)?)
}

/// Write the reply into `out`, which already holds capacity for exactly
/// [`reply_bytes`]: nothing is allocated here (the debug assertion and the
/// allocator pins check it).  Charges each token before writing it.
pub fn emit(dv: &Divided, out: &mut String, m: &mut Meter) -> Result<(), DivFault> {
    let _p = sagebrush_interrupt::enter("divrem emit");
    sagebrush_interrupt::check_coarse();
    let cap = out.capacity();
    let list = |a: &Arena, out: &mut String, m: &mut Meter| -> Result<(), DivFault> {
        let lead = a.fwd().take_while(|(x, _)| x.is_empty()).count();
        for (i, (x, neg)) in a.rev().take(a.nt - lead).enumerate() {
            m.add(x.len() + 1)?;
            if i > 0 {
                out.push(',');
            }
            if neg {
                out.push('-');
            }
            hex(out, x);
        }
        Ok(())
    };
    out.push_str("{\"ok\":{\"q\":\"");
    list(&dv.q, out, m)?;
    out.push_str("\",\"r\":\"");
    list(&dv.r, out, m)?;
    out.push_str("\"}}");
    debug_assert_eq!(out.capacity(), cap, "the reply was written without allocating");
    Ok(())
}

/// The reply for a call answered before any division.
fn short_reply(s: &Short, led: &Words) -> Result<String, DivFault> {
    let body = match s {
        Short::Zero => "",
        Short::Lower(t) => t,
    };
    let bytes = 22 + body.len();
    led.note("reply", bytes.div_ceil(8) as u64);
    led.reserve(bytes.div_ceil(8) as u64)?;
    let mut out = String::new();
    out.try_reserve_exact(bytes).map_err(|_| DivFault::Memory)?;
    out.push_str("{\"ok\":{\"q\":\"\",\"r\":\"");
    out.push_str(body);
    out.push_str("\"}}");
    Ok(out)
}

/// The refusal or internal error for a fault.
fn fault_text(f: DivFault, plan: &Plan) -> String {
    match f {
        DivFault::Work => format!("the division needs more than {} word operations (a shorter dividend or a smaller divisor per call)", plan.work),
        DivFault::Memory => format!("the division's memory needs more than {} bytes ({})", (plan.fixed + plan.limit).saturating_mul(8), HOW),
        DivFault::Invariant => format!("{}: the division (Invariant)", INTERNAL_PREFIX),
    }
}

/// The reserved reply's guard: its words held by the ledger until dropped.
struct Reserved<'l>(u64, &'l Words);

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.1.release(self.0);
    }
}

/// The division, the reply's exact reservation and its writing, on the
/// caller's ledger and meter (the integration tests drive both): after the
/// division the window and its scratch are freed; the reply is reserved
/// exactly (ceil(bytes / 8) words) while the two arenas are held; then
/// [`emit`] writes it into that capacity without allocating.
pub fn reply_z_on(a: &Factor, b: &Factor, plan: &Plan, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let dv = divide_z(a, b, plan, led, m)?;
    let bytes = reply_bytes(&dv).ok_or(DivFault::Memory)?;
    let words = bytes.div_ceil(8);
    led.note("reply", words);
    led.reserve(words)?;
    let _held = Reserved(words, led);
    let mut out = String::new();
    out.try_reserve_exact(bytes as usize).map_err(|_| DivFault::Memory)?;
    emit(&dv, &mut out, m)?;
    if out.len() as u64 != bytes {
        return Err(DivFault::Invariant);
    }
    Ok(out)
}

/// The whole zpoly_divrem call on scanned operands (integer tokens):
/// `{"ok":{"q":...,"r":...}}` or the refusal, with no partial reply.
pub fn reply_z(a: &Factor, b: &Factor, r: u64, caps: &qpoly::Caps) -> Result<String, String> {
    let plan = match admit_z(a, b, r, caps)? {
        Ok(p) => p,
        Err(short) => {
            let led = Words::new(caps.int.peak / 8);
            return short_reply(&short, &led).map_err(|_| format!("the memory (bytes) is more than {} ({})", caps.int.peak, HOW));
        }
    };
    let led = Words::new(plan.limit);
    let mut m = Meter::new(plan.work);
    reply_z_on(a, b, &plan, &led, &mut m).map_err(|f| fault_text(f, &plan))
}

#[cfg(test)]
mod tests;
