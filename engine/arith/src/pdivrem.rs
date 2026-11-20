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
use crate::qpoly::{self, bits, mul_into, parse_hex, parts, Factor};
use crate::zmul::hex;
use crate::zseries::INTERNAL_PREFIX;
#[cfg(test)]
use std::cell::Cell;
use std::cmp::Ordering;

pub use crate::ledger::{DivFault, Words};
pub(crate) use crate::ledger::{cmp_mag, fixed_vec, fixed_words, skip_polled, token_end_polled, track, walk_charge, Arena, Buf, Coef};
#[cfg(test)]
pub(crate) use crate::ledger::{EXACT, MAX_BITS};

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

/// qpoly_divrem's work cap (word operations): 2^29.  zmul's 2^28 was sized
/// for products; at it, a dense Q[x] division the real-scale algorithm
/// finishes in 0.4 s natively (degree 1000 by a non-monic degree 500, 3.59e8
/// units) was refused.  Calibrated in time: the worst measured rate (4.01
/// ns/unit on the production wasm engine, 2.29 natively) gives at most
/// about 2.15 s (wasm) and 1.2 s (native) for the longest admitted call.
/// zpoly_divrem keeps zmul's cap; the peak cap is zmul's for both.
pub const DIVREM_Q_WORK_MAX: u64 = 1 << 29;

/// qpoly_divrem's caps: zmul's, but the work cap [`DIVREM_Q_WORK_MAX`].
pub const DIVREM_Q_CAPS: qpoly::Caps = qpoly::Caps { int: crate::zmul::Caps { work: DIVREM_Q_WORK_MAX, ..crate::zmul::CAPS }, reply: qpoly::REPLY_MAX };

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
        let end = token_end_polled(a.text, na as usize);
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
    let mut limbs = fixed_words(b.n_sum as usize)?;
    let mut rows = fixed_vec(w)?;
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
    /// (Q) the reduced denominators, one per coefficient of q and of r
    qd: Option<Arena<'l>>,
    rd: Option<Arena<'l>>,
}

impl Divided<'_> {
    /// The words the arenas hold.
    pub fn words(&self) -> u64 {
        self.q.words() + self.r.words() + self.qd.as_ref().map_or(0, |a| a.words()) + self.rd.as_ref().map_or(0, |a| a.words())
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
    let mut toks = skip_polled(a.text.rsplit(','), skip);
    // the window: slot(l) = ring[(h + l) % w] holds degree (top - m + l)
    let mut ring: Vec<Coef<'l>> = fixed_vec(w)?;
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
        // (the comparison reads at most min(lt, lc) limbs, charged before)
        m.add(lt.min(lc) + 1)?;
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
    Ok(Divided { q, r, qd: None, rd: None })
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

/// A token's bytes in the reply: `0`, or a sign, its numerator's hex
/// digits and, unless its denominator is 1 (or absent), `/` and the
/// denominator's.
pub(crate) fn token_bytes(mag: &[u64], neg: bool, den: Option<&[u64]>) -> u64 {
    if mag.is_empty() {
        return 1;
    }
    let d = match den {
        Some(d) if !(d.len() == 1 && d[0] == 1) => 1 + bits(d).div_ceil(4),
        _ => 0,
    };
    u64::from(neg) + bits(mag).div_ceil(4) + d
}

/// An arena's top-degree zeros (stored first): their count.  One unit a
/// token visited, charged and Stop polled in 4096-token chunks.
fn lead_zeros(a: &Arena, m: &mut Meter) -> Result<usize, DivFault> {
    let mut lead = 0;
    for (i, (x, _)) in a.fwd().enumerate() {
        walk_charge(i, a.nt, m)?;
        if !x.is_empty() {
            break;
        }
        lead += 1;
    }
    Ok(lead)
}

/// The reply's exact bytes, `{"ok":{"q":"...","r":"..."}}` (22 fixed
/// bytes), each list trimmed of its trailing (top-degree) zeros.  Its own
/// phase, `divrem bytes`: each walk charged one unit a token and Stop polled
/// in 4096-token chunks; an overflow is the memory refusal.
pub fn reply_bytes(dv: &Divided, m: &mut Meter) -> Result<u64, DivFault> {
    let _p = sagebrush_interrupt::enter("divrem bytes");
    // (the kept tokens summed from the end, as emit writes them: the only
    // walk over the top zeros is lead_zeros', charged and polled)
    let list = |a: &Arena, d: Option<&Arena>, m: &mut Meter| -> Result<u64, DivFault> {
        let lead = lead_zeros(a, m)?;
        let kept = a.nt - lead;
        let mut dens = d.map(|d| d.rev().take(kept));
        let mut total = 0u64;
        for (i, (x, neg)) in a.rev().take(kept).enumerate() {
            walk_charge(i, kept, m)?;
            let den = dens.as_mut().and_then(|it| it.next()).map(|(y, _)| y);
            total = total.checked_add(token_bytes(x, neg, den)).ok_or(DivFault::Memory)?;
        }
        total.checked_add((kept as u64).saturating_sub(1)).ok_or(DivFault::Memory)
    };
    let q = list(&dv.q, dv.qd.as_ref(), m)?;
    let r = list(&dv.r, dv.rd.as_ref(), m)?;
    22u64.checked_add(q).and_then(|t| t.checked_add(r)).ok_or(DivFault::Memory)
}

/// Write the reply into `out`, which already holds capacity for exactly
/// [`reply_bytes`]: nothing is allocated here (the debug assertion and the
/// allocator pins check it).  Charges each token before writing it.
pub fn emit(dv: &Divided, out: &mut String, m: &mut Meter) -> Result<(), DivFault> {
    let _p = sagebrush_interrupt::enter("divrem emit");
    sagebrush_interrupt::check_coarse();
    let cap = out.capacity();
    let list = |a: &Arena, d: Option<&Arena>, out: &mut String, m: &mut Meter| -> Result<(), DivFault> {
        let lead = lead_zeros(a, m)?;
        let mut dens = d.map(|d| d.rev().take(d.nt - lead));
        for (i, (x, neg)) in a.rev().take(a.nt - lead).enumerate() {
            let den = dens.as_mut().and_then(|it| it.next()).map(|(y, _)| y);
            m.add(x.len() + den.map_or(0, |y| y.len()) + 1)?;
            if i > 0 {
                out.push(',');
            }
            if neg {
                out.push('-');
            }
            hex(out, x);
            if let Some(y) = den {
                if !x.is_empty() && !(y.len() == 1 && y[0] == 1) {
                    out.push('/');
                    hex(out, y);
                }
            }
        }
        Ok(())
    };
    out.push_str("{\"ok\":{\"q\":\"");
    list(&dv.q, dv.qd.as_ref(), out, m)?;
    out.push_str("\",\"r\":\"");
    list(&dv.r, dv.rd.as_ref(), out, m)?;
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
    let bytes = reply_bytes(&dv, m)?;
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

// ---- qpoly_divrem: exact division in Q[x] (r3.3's Q section) ----
//
// Phase A clears the denominators (qpoly_mul's lcms, on the call's meter):
// a = A / d_a and b = B / d_b with A, B integral.  Q1 divides B by its
// content in place, in its fixed row: B = cont(B) P, c = lc(P) > 0, and b =
// beta P with beta = (+-cont / d_b) reduced.  Q2 divides at the remainder's
// real scale: below the window rho_p = A_p / d_a; in it rho_p = W_p / (d_a
// T).  A step at the top degree i (quotient degree j = i - m):
//   q_j = W_i beta_d / (d_a T beta_n c),  W <- c W - W_i x^j P,  T <- T c,
// the top then 0 (checked); then g = gcd(T, the window's content) cancels
// (stopping at 1), and the entering coefficient is A_p T.  Each q_j, and at
// the end each r_p = W_p / (d_a T), is stored reduced.  With c = 1 (Q5), T
// stays 1: no multiplication by c and no gcd.

#[cfg(test)]
thread_local! {
    /// (tests) Q2's counts: multiplications by c, content gcds, the steps
    /// whose content was more than 1 (cancelled), and T's largest length
    pub(crate) static Q_COUNTS: Cell<(u64, u64, u64, usize)> = const { Cell::new((0, 0, 0, 0)) };
}

fn qcount(_cmul: u64, _cgcd: u64, _cancel: u64, _t: usize) {
    #[cfg(test)]
    Q_COUNTS.with(|c| {
        let (a, b, x, t) = c.get();
        c.set((a + _cmul, b + _cgcd, x + _cancel, t.max(_t)));
    });
}

#[cfg(test)]
thread_local! {
    /// (tests) the units the content gcds, the window's update and the
    /// cancelling divisions charged
    pub(crate) static GCD_UNITS: Cell<u64> = const { Cell::new(0) };
    pub(crate) static UPD_UNITS: Cell<u64> = const { Cell::new(0) };
    pub(crate) static DIV_UNITS: Cell<u64> = const { Cell::new(0) };
}

#[cfg(test)]
thread_local! {
    /// (tests) each phase's end: its name and the meter's count then
    pub(crate) static PHASES: std::cell::RefCell<Vec<(&'static str, u64)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn phase_end(_name: &'static str, _m: &Meter) {
    #[cfg(test)]
    PHASES.with(|p| p.borrow_mut().push((_name, _m.used())));
}

#[cfg(test)]
thread_local! {
    /// (tests) Q's leaving-coefficient probe: the top's update uses P_m + 1,
    /// so the leaving coefficient isn't 0 and the invariant must refuse.
    pub(crate) static PROBE_LEAVING: Cell<bool> = const { Cell::new(false) };
}

fn probe_leaving() -> bool {
    #[cfg(test)]
    return PROBE_LEAVING.with(|p| p.get());
    #[cfg(not(test))]
    false
}

/// Q's integer scratch, ledger-owned and grown on demand.
struct QScratch<'l> {
    x: Buf<'l>,
    y: Buf<'l>,
    q: Buf<'l>,
    p: Buf<'l>,
    ws: Buf<'l>,
}

impl<'l> QScratch<'l> {
    fn new(led: &'l Words, tag: &'static str, m: &mut Meter) -> Result<QScratch<'l>, DivFault> {
        Ok(QScratch { x: Buf::new(led, 0, tag, m)?, y: Buf::new(led, 0, tag, m)?, q: Buf::new(led, 0, tag, m)?, p: Buf::new(led, 0, tag, m)?, ws: Buf::new(led, 0, tag, m)? })
    }
    /// The product x y into p: its normalized length.
    fn mul(&mut self, x: &[u64], y: &[u64], m: &mut Meter) -> Result<usize, DivFault> {
        if x.is_empty() || y.is_empty() {
            return Ok(0);
        }
        self.p.grow(x.len() + y.len(), 0, m)?;
        Ok(mul_into(x, y, &mut self.p.v, m)?)
    }
    /// x / y exactly (y normalized, nonzero; x a multiple of y) into q: its
    /// normalized length.
    fn divexact(&mut self, x: &[u64], y: &[u64], m: &mut Meter) -> Result<usize, DivFault> {
        if x.is_empty() {
            return Ok(0);
        }
        if x.len() < y.len() {
            return Err(DivFault::Invariant);
        }
        let (nx, ny) = (x.len(), y.len());
        self.x.grow(nx + 1, 0, m)?;
        self.y.grow(ny, 0, m)?;
        self.q.grow(nx - ny + 1, 0, m)?;
        m.add(nx + ny + 2)?;
        self.x.v[..nx].copy_from_slice(x);
        self.y.v[..ny].copy_from_slice(y);
        Ok(crate::coprime::divexact_in_place(&mut self.x.v, nx, &mut self.y.v, ny, &mut self.q.v, m)?)
    }
    /// gcd(x, y) of two magnitudes (not both zero) into g.
    fn gcd(&mut self, x: &[u64], y: &[u64], g: &mut Coef, m: &mut Meter) -> Result<(), DivFault> {
        let room = x.len().max(y.len()) + 1;
        self.ws.grow(2 * room, 0, m)?;
        m.add(2 * room + 1)?;
        let (s0, s1) = self.ws.v.split_at_mut(room);
        let s1 = &mut s1[..room];
        s0.iter_mut().for_each(|w| *w = 0);
        s1.iter_mut().for_each(|w| *w = 0);
        s0[..x.len()].copy_from_slice(x);
        s1[..y.len()].copy_from_slice(y);
        let (slot, lg) = crate::coprime::gcd_in_place(s0, x.len(), s1, y.len(), m)?;
        let r: &[u64] = if slot { &s1[..lg] } else { &s0[..lg] };
        g.set(r, false, m)
    }
}

/// num / den (den > 0) in lowest terms, appended to the two arenas; num = 0
/// appends 0 over 1.  g and the scratch are ledger-owned; nothing else is
/// allocated.
#[allow(clippy::too_many_arguments)]
fn push_reduced(num: &[u64], neg: bool, den: &[u64], an: &mut Arena, ad: &mut Arena, g: &mut Coef, s: &mut QScratch, m: &mut Meter) -> Result<(), DivFault> {
    if num.is_empty() {
        an.push(&[], false, m)?;
        return ad.push(&[1], false, m);
    }
    s.gcd(num, den, g, m)?;
    if g.is_one() {
        an.push(num, neg, m)?;
        return ad.push(den, false, m);
    }
    m.add(2 * g.len + 2)?;
    let n1 = s.divexact(num, g.mag(), m)?;
    an.push(&s.q.v[..n1], neg, m)?;
    let n2 = s.divexact(den, g.mag(), m)?;
    ad.push(&s.q.v[..n2], false, m)
}

/// The fixed rows for Q, in words, once phase A's lcms are known: the
/// request; d_a and d_b at phase A's capacities; the cleared divisor (each
/// of its m + 1 coefficients at most its numerator's limbs plus d_b's) and
/// its metadata; the window's metadata; and the call's other owners.
pub fn fixed_rows_q(b: &Factor, m: u64, r: u64, pa: &qpoly::PlanA, nb_words: u64) -> Option<u64> {
    let meta = m.checked_add(1)?.checked_mul(META_WORDS)?;
    let divisor = b.n_sum.checked_add(m.checked_add(1)?.checked_mul(nb_words)?)?;
    r.div_ceil(8)
        .checked_add(pa.lam_a.checked_add(1)?)?
        .checked_add(pa.lam_b.checked_add(1)?)?
        .checked_add(divisor)?
        .checked_add(meta)?
        .checked_add(meta)?
        .checked_add(OVERHEAD_WORDS)
}

/// Phase A for Q, the `divrem clear` phase: the two lcms (qpoly_mul's, on
/// the call's meter), polled at its start.
pub fn clear_q(a: &Factor, b: &Factor, pa: &qpoly::PlanA, m: &mut Meter) -> Result<qpoly::Lcms, Fault> {
    let _p = sagebrush_interrupt::enter("divrem clear");
    sagebrush_interrupt::check_coarse();
    let l = qpoly::lcms_metered(a, b, pa, m)?;
    phase_end("divrem clear", m);
    Ok(l)
}

/// The whole qpoly_divrem call on scanned operands (`num` and `num/den`
/// tokens): `{"ok":{"q":...,"r":...}}` in lowest terms, or the refusal.
pub fn reply_q(a: &Factor, b: &Factor, r: u64, caps: &qpoly::Caps) -> Result<String, String> {
    if r > caps.int.request {
        return Err(format!("the request's bytes = {} is more than {} ({})", r, caps.int.request, HOW));
    }
    let nb = norm_len(b);
    if nb == 0 {
        return Err("division by zero polynomial".to_string());
    }
    let na = norm_len(a);
    if na == 0 {
        return Ok("{\"ok\":{\"q\":\"\",\"r\":\"\"}}".to_string());
    }
    let pa = qpoly::admit_a(a, b, r, caps)?.ok_or_else(|| format!("{}: a nonzero operand admitted as zero", INTERNAL_PREFIX))?;
    let mut m = Meter::new(pa.limit);
    let lcm_refusal = |f: Fault| match f {
        Fault::Overrun => format!("the denominators' lcm needs more than {} word operations (fewer or simpler denominators per call)", pa.limit),
        Fault::Invariant => format!("{}: the lcm (Invariant)", INTERNAL_PREFIX),
    };
    let l = clear_q(a, b, &pa, &mut m).map_err(lcm_refusal)?;
    let (n, mm) = (na - 1, nb - 1);
    let fixed = fixed_rows_q(b, mm, r, &pa, l.nb as u64).ok_or_else(|| "the division's size overflows".to_string())?;
    let cap = caps.int.peak / 8;
    if fixed > cap {
        return Err(format!("the memory (bytes) = {} is more than {} ({})", fixed.saturating_mul(8), caps.int.peak, HOW));
    }
    let plan = Plan { n, m: mm, k: if n >= mm { n - mm + 1 } else { 0 }, fixed, limit: cap - fixed, work: pa.limit };
    let led = Words::new(plan.limit);
    reply_q_on(a, b, &plan, &pa, l, &led, &mut m).map_err(|f| fault_text(f, &plan))
}

/// Q's division, the reply's exact reservation and its writing, on the
/// caller's ledger and meter (the tests drive both), phase A done.
pub fn reply_q_on(a: &Factor, b: &Factor, plan: &Plan, pa: &qpoly::PlanA, l: qpoly::Lcms, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let dv = divide_q(a, b, plan, pa, l, led, m)?;
    let bytes = reply_bytes(&dv, m)?;
    let words = bytes.div_ceil(8);
    led.note("reply", words);
    led.reserve(words)?;
    let _held = Reserved(words, led);
    let mut out = String::new();
    out.try_reserve_exact(bytes as usize).map_err(|_| DivFault::Memory)?;
    emit(&dv, &mut out, m)?;
    phase_end("divrem emit", m);
    if out.len() as u64 != bytes {
        return Err(DivFault::Invariant);
    }
    Ok(out)
}

/// Q's per-token scratch: a denominator and a numerator, ledger-owned.
struct TokScratch<'l> {
    d: Coef<'l>,
    n: Coef<'l>,
}

/// A token's cleared integer n_i (L / d_i) into c: the parses into the
/// token scratch, L / d_i into the scratch's quotient, and the product
/// straight into c's buffer (grown first).  Nothing outside the ledger.
fn cleared(tok: &str, l: &[u64], c: &mut Coef, t: &mut TokScratch, s: &mut QScratch, m: &mut Meter) -> Result<(), DivFault> {
    let (neg, num, den) = parts(tok);
    if num == "0" {
        c.len = 0;
        c.neg = false;
        return Ok(());
    }
    t.d.set_hex(false, den, m)?;
    let nq = s.divexact(l, t.d.mag(), m)?;
    t.n.set_hex(false, num, m)?;
    c.buf.grow(t.n.len + nq, 0, m)?;
    let np = mul_into(t.n.mag(), &s.q.v[..nq], &mut c.buf.v, m)?;
    c.len = np;
    c.neg = neg && np > 0;
    track(c.mag());
    Ok(())
}

/// x y into c's buffer (grown first), c's sign `neg`.
fn mul_to(c: &mut Coef, x: &[u64], y: &[u64], neg: bool, m: &mut Meter) -> Result<(), DivFault> {
    if x.is_empty() || y.is_empty() {
        c.len = 0;
        c.neg = false;
        return Ok(());
    }
    c.buf.grow(x.len() + y.len(), 0, m)?;
    c.len = mul_into(x, y, &mut c.buf.v, m)?;
    c.neg = neg && c.len > 0;
    track(c.mag());
    Ok(())
}

/// Q's division on the caller's ledger and meter, phase A's lcms given.
/// Every buffer it makes is a ledger reservation ([`Buf`], [`Coef`],
/// [`QScratch`], [`Arena`]) or a fixed row allocated fallibly
/// ([`fixed_words`], [`fixed_vec`]); no other allocation happens here.
pub fn divide_q<'l>(a: &Factor, b: &Factor, plan: &Plan, pa: &qpoly::PlanA, l: qpoly::Lcms, led: &'l Words, m: &mut Meter) -> Result<Divided<'l>, DivFault> {
    let qpoly::Lcms { la, lb, na, nb, .. } = l;
    let da = &la[..na];
    let w = plan.m as usize + 1;
    let mut s = QScratch::new(led, "scratch", m)?;
    let mut g = Coef::tagged(led, 1, "scratch", m)?;
    let mut g2 = Coef::tagged(led, 1, "scratch", m)?;
    let mut t = TokScratch { d: Coef::tagged(led, 0, "scratch", m)?, n: Coef::tagged(led, 0, "scratch", m)? };
    let mut q = Arena::new(led, "q arena", m)?;
    let mut qd = Arena::new(led, "q arena", m)?;
    let mut r = Arena::new(led, "r arena", m)?;
    let mut rd = Arena::new(led, "r arena", m)?;
    // a lower degree: r = a, each token reduced
    if plan.n < plan.m {
        let _p = sagebrush_interrupt::enter("divrem divide");
        sagebrush_interrupt::check_coarse();
        let skip = (a.tokens - plan.n - 1) as usize;
        for tok in skip_polled(a.text.rsplit(','), skip) {
            let (neg, num, den) = parts(tok);
            t.n.set_hex(neg, num, m)?;
            t.d.set_hex(false, den, m)?;
            push_reduced(t.n.mag(), t.n.neg, t.d.mag(), &mut r, &mut rd, &mut g, &mut s, m)?;
        }
        drop((la, lb, s, g, g2, t));
        return Ok(Divided { q, r, qd: Some(qd), rd: Some(rd) });
    }
    // Q1: the divisor cleared into its fixed row, divided by its content in
    // place there (P reuses B's capacity: nothing is allocated for P)
    let (d, beta_n, beta_d) = {
        let _p = sagebrush_interrupt::enter("divrem load");
        sagebrush_interrupt::check_coarse();
        let mut limbs = fixed_words(b.n_sum as usize + w * nb)?;
        let mut rows: Vec<(usize, usize, bool)> = fixed_vec(w)?;
        let mut at = 0usize;
        let mut c = Coef::tagged(led, 0, "q1 scratch", m)?;
        let mut q1 = QScratch::new(led, "q1 scratch", m)?;
        for tok in b.text.split(',').take(w) {
            cleared(tok, &lb[..nb], &mut c, &mut t, &mut q1, m)?;
            let n = c.len;
            if at + n > limbs.len() {
                return Err(DivFault::Invariant);
            }
            m.add(n + 1)?;
            limbs[at..at + n].copy_from_slice(c.mag());
            rows.push((at, n, c.neg));
            at += n;
        }
        // the content, stopping at 1 (each gcd into the other coefficient,
        // which then swaps in)
        let mut cont = Coef::tagged(led, 1, "q1 scratch", m)?;
        let mut cont2 = Coef::tagged(led, 1, "q1 scratch", m)?;
        for &(st, n, _) in &rows {
            if n == 0 {
                continue;
            }
            if cont.len == 0 {
                cont.set(&limbs[st..st + n], false, m)?;
            } else {
                q1.gcd(cont.mag(), &limbs[st..st + n], &mut cont2, m)?;
                std::mem::swap(&mut cont, &mut cont2);
            }
            if cont.is_one() {
                break;
            }
        }
        if !cont.is_one() {
            for row in rows.iter_mut() {
                let (st, n, _) = *row;
                if n == 0 {
                    continue;
                }
                let nq = q1.divexact(&limbs[st..st + n], cont.mag(), m)?;
                m.add(n + 1)?;
                limbs[st..st + nq].copy_from_slice(&q1.q.v[..nq]);
                limbs[st + nq..st + n].iter_mut().for_each(|x| *x = 0);
                row.1 = nq;
            }
        }
        // lc(P) > 0: a negative leading coefficient flips every sign, in place
        let flip = rows[w - 1].2;
        if flip {
            for row in rows.iter_mut() {
                row.2 = !row.2 && row.1 > 0;
            }
        }
        // beta = (+-cont) / d_b, reduced: ledger reservations that never grow
        let mut gg = Coef::tagged(led, 1, "q1 scratch", m)?;
        q1.gcd(cont.mag(), &lb[..nb], &mut gg, m)?;
        let n1 = q1.divexact(cont.mag(), gg.mag(), m)?;
        let mut beta_n = Coef::tagged(led, n1, "beta", m)?;
        beta_n.set(&q1.q.v[..n1], flip, m)?;
        let n2 = q1.divexact(&lb[..nb], gg.mag(), m)?;
        let mut beta_d = Coef::tagged(led, n2, "beta", m)?;
        beta_d.set(&q1.q.v[..n2], false, m)?;
        drop((c, q1, cont, cont2, gg));
        phase_end("divrem load", m);
        (Divisor { limbs, rows }, beta_n, beta_d)
    };
    // d_b is no longer needed: freed, and what the fixed rows charged for it
    // (phase A's capacity, Lambda_b + 1 words) credited to the ledger
    let charged = pa.lam_b.checked_add(1).ok_or(DivFault::Memory)?;
    if lb.capacity() as u64 > charged {
        return Err(DivFault::Invariant);
    }
    drop(lb);
    led.credit(charged)?;
    let (c, _) = d.get(w - 1);
    let monic = c.len() == 1 && c[0] == 1;
    let _p = sagebrush_interrupt::enter("divrem divide");
    sagebrush_interrupt::check_coarse();
    // DT = d_a |beta_n| c: q_j's denominator is DT T
    let mut dt = Coef::tagged(led, 0, "scratch", m)?;
    let mut dt0 = Coef::tagged(led, 0, "scratch", m)?;
    mul_to(&mut dt0, da, beta_n.mag(), false, m)?;
    mul_to(&mut dt, dt0.mag(), c, false, m)?;
    drop(dt0);
    let mut tsc = Coef::tagged(led, 1, "T", m)?;
    tsc.set(&[1], false, m)?;
    // the step's scratch: W_i, q_j's numerator and denominator
    let mut wi = Coef::tagged(led, 0, "scratch", m)?;
    let mut num = Coef::tagged(led, 0, "scratch", m)?;
    let mut den = Coef::tagged(led, 0, "scratch", m)?;
    // the window, slot(l) = ring[(h + l) % w], from the dividend's top
    let skip = (a.tokens - plan.n - 1) as usize;
    let mut toks = skip_polled(a.text.rsplit(','), skip);
    let mut ring: Vec<Coef<'l>> = fixed_vec(w)?;
    for _ in 0..w {
        ring.push(Coef::new(led, 0, m)?);
    }
    for li in (0..w).rev() {
        cleared(toks.next().ok_or(DivFault::Invariant)?, da, &mut ring[li], &mut t, &mut s, m)?;
    }
    let mut h = 0usize;
    let mut ent = Coef::tagged(led, 0, "scratch", m)?;
    let k = plan.k as usize;
    for st in 0..k {
        let topi = (h + w - 1) % w;
        wi.set(ring[topi].mag(), ring[topi].neg, m)?;
        // q_j = W_i beta_d / (DT T), reduced
        mul_to(&mut num, wi.mag(), beta_d.mag(), wi.neg != beta_n.neg, m)?;
        mul_to(&mut den, dt.mag(), tsc.mag(), false, m)?;
        push_reduced(num.mag(), num.neg, den.mag(), &mut q, &mut qd, &mut g, &mut s, m)?;
        // W <- c W - W_i x^j P (the top: c W_i - W_i c = 0, checked)
        #[cfg(test)]
        let u0 = m.used();
        for li in 0..w {
            let i = (h + li) % w;
            if !monic {
                qcount(1, 0, 0, 0);
                // (the product into the scratch, whose buffer then becomes
                // the coefficient's: both are the ledger's, so swapping them
                // moves no reservation)
                let len = ring[i].len;
                let np = s.mul(&ring[i].buf.v[..len], c, m)?;
                std::mem::swap(&mut ring[i].buf.v, &mut s.p.v);
                ring[i].len = np;
            }
            let (pl, pneg) = d.get(li);
            let np = s.mul(wi.mag(), pl, m)?;
            ring[i].sub_signed(&s.p.v[..np], wi.neg != pneg, m)?;
            if li == w - 1 && probe_leaving() {
                // (the probe: the top's update with P_m + 1, so W_i more)
                ring[i].sub_signed(wi.mag(), wi.neg, m)?;
            }
        }
        #[cfg(test)]
        UPD_UNITS.with(|u| u.set(u.get() + m.used() - u0));
        if ring[topi].len != 0 {
            return Err(DivFault::Invariant);
        }
        if !monic {
            let np = s.mul(tsc.mag(), c, m)?;
            std::mem::swap(&mut tsc.buf.v, &mut s.p.v);
            tsc.len = np;
            // g = gcd(T, the window's content), stopping at 1 (each gcd into
            // g2, which then swaps in)
            g.set(tsc.mag(), false, m)?;
            for li in 0..w - 1 {
                if g.is_one() {
                    break;
                }
                let i = (h + li) % w;
                if ring[i].len == 0 {
                    continue;
                }
                qcount(0, 1, 0, 0);
                #[cfg(test)]
                let u0 = m.used();
                s.gcd(g.mag(), ring[i].mag(), &mut g2, m)?;
                std::mem::swap(&mut g, &mut g2);
                #[cfg(test)]
                GCD_UNITS.with(|u| u.set(u.get() + m.used() - u0));
            }
            #[cfg(test)]
            let u1 = m.used();
            if !g.is_one() {
                qcount(0, 0, 1, 0);
                for li in 0..w - 1 {
                    let i = (h + li) % w;
                    if ring[i].len == 0 {
                        continue;
                    }
                    let len = ring[i].len;
                    let nq = s.divexact(&ring[i].buf.v[..len], g.mag(), m)?;
                    std::mem::swap(&mut ring[i].buf.v, &mut s.q.v);
                    ring[i].len = nq;
                }
                let nq = s.divexact(tsc.mag(), g.mag(), m)?;
                std::mem::swap(&mut tsc.buf.v, &mut s.q.v);
                tsc.len = nq;
            }
            #[cfg(test)]
            DIV_UNITS.with(|u| u.set(u.get() + m.used() - u1));
            qcount(0, 0, 0, tsc.len);
        }
        // the entering coefficient A_p T at the bottom (the top's slot)
        if st + 1 < k {
            if tsc.is_one() {
                cleared(toks.next().ok_or(DivFault::Invariant)?, da, &mut ring[topi], &mut t, &mut s, m)?;
            } else {
                cleared(toks.next().ok_or(DivFault::Invariant)?, da, &mut ent, &mut t, &mut s, m)?;
                mul_to(&mut ring[topi], ent.mag(), tsc.mag(), ent.neg, m)?;
            }
            h = topi;
        }
    }
    // r_p = W_p / (d_a T), reduced, degrees m - 1 down to 0
    mul_to(&mut den, da, tsc.mag(), false, m)?;
    for li in (0..w - 1).rev() {
        let i = (h + li) % w;
        push_reduced(ring[i].mag(), ring[i].neg, den.mag(), &mut r, &mut rd, &mut g, &mut s, m)?;
    }
    drop((ring, s, g, g2, t, ent, wi, num, den, dt, tsc, beta_n, beta_d, la));
    phase_end("divrem divide", m);
    Ok(Divided { q, r, qd: Some(qd), rd: Some(rd) })
}

#[cfg(test)]
mod tests;
