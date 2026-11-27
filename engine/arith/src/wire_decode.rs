//! Decoding the wire's big-integer payloads (`ZV_1`, integer vectors,
//! `QV_1`, `MAT1`, `MQR1`) into engine integers, under one reservation
//! (S2).  Each `decode_*` takes the caller's [`Admit`], so admission cannot
//! be skipped:
//! 1. it computes the payload's [`Need`] (`need_*`, allocation-free): the
//!    bytes of everything decoded plus the workspace, and the work of every
//!    gcd check, in checked u64 arithmetic.  There is no size cap: a large
//!    integer only costs its owner time (the engine cost policy), and the
//!    check is metered and polls Stop;
//! 2. it asks the caller to admit them ([`Admit::admit`]: the bytes
//!    reserved in the ledger, with the payload's [`Cost`]), before anything
//!    here allocates; a refusal ends the decode;
//! 3. it decodes: the gcd = 1 checks first, in the workspace, on an
//!    accounting meter whose limit is the proven work bound (passing it is
//!    an accounting bug, never a refusal); then the values, with exactly
//!    the allocations the reserved bytes count.
//!
//! **Cost** (the engine cost policy): $L_{\mathrm{mem}}$ is the larger of the
//! two phases' exact allocations (the workspace during the checks; the
//! vectors' elements and the values' heap after, dashu's allocation for a
//! value of more than [`sagebrush_wire::INLINE_LIMBS`] limbs being
//! $n + \lfloor n/8 \rfloor + 2$ words of $n$ words' magnitude);
//! $L_{\mathrm{work}}$ is the slots' loads and clears of every check (one
//! pass over the limbs); $U$ is the proven bound of [`coprime`]; there is
//! no estimate yet (the candidate is about $4.4\, l_a l_b$ units per pair
//! plus the loads, to be fitted on the harness).
//!
//! **Bytes.**  Each `Vec<BigInt>`: its capacity times the BigInt's size,
//! plus its header.  Each value: [`sagebrush_wire::bigint_heap_words`] (E1; the
//! integers are built from their wire bytes, so no staging copy).  The gcd
//! workspace: [`workspace_words`]`(L)` words, `L` the payload's largest
//! limb count, when any check runs (E2, freed before the values are built;
//! counted on top of them all the same).  A `QV_1` (or a `MAT1` of
//! rationals, E3) is two flat vectors; an `MQR1` is one vector of the
//! rows x cols numerators and one of the rows' denominators.
//!
//! **Work.**  A pair n/d is checked unless gcd = 1 is evident (n = 0, which
//! the schema makes 0/1; d = 1; |n| = 1), at [`coprime::pair_work`].  An
//! MQR1 row is checked unless its denominator is 1, at
//! [`coprime::row_fixed_work`] plus [`coprime::row_entry_work`] per
//! numerator: the worst running-gcd sequence the headers allow (stopping at
//! gcd 1 only spends less).

use crate::coprime::{self, Fault, workspace_words};
use crate::cost::{Cost, Meter};
use sagebrush_bigint::{BigInt, Sign};
use sagebrush_wire::{BigRef, Code, Elems, Ints, Mat, Mqr, Qv, WireError, Zv};

// E1's inline rule is dashu's: two machine words inline, so the wire's
// INLINE_LIMBS u64 limbs are exactly two words on every target (one limb
// in WebAssembly, where a word is 32 bits); a mismatch fails the build.
const _: () = assert!(sagebrush_wire::INLINE_LIMBS * 64 == 2 * dashu_int::Word::BITS as u64);

/// What a payload needs, admitted before it is decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Need {
    /// The bytes of every allocation of the decode: the reservation (its
    /// observed peak is at most this, and at least `cost.mem_lower`).
    pub bytes: u64,
    /// The payload's cost: $L$ and $U$ of the gcd checks' work, and
    /// $L_{\mathrm{mem}} \le$ `bytes`.
    pub cost: Cost,
}

/// The caller's admission of a payload, before it is decoded: reserve
/// `bytes` (held until the decoded values are dropped), or refuse.  The
/// consumer implements it on its ledger reservation; it may refuse only on
/// memory (`bytes`, or `cost.mem_lower`, against what is available) or on
/// an estimate against the user's time budget, never on `cost.work_upper`
/// (the engine cost policy).
pub trait Admit {
    fn admit(&mut self, bytes: u64, cost: Cost) -> Result<(), WireError>;
}

fn admitted(need: Result<Need, WireError>, a: &mut impl Admit) -> Result<Need, WireError> {
    let need = need?;
    debug_assert!(need.cost.mem_lower <= need.bytes, "a memory lower bound above the reservation");
    a.admit(need.bytes, need.cost)?;
    Ok(need)
}

/// A payload's figures as they are summed: the reservation (checked: an
/// overflow means it cannot fit), the two phases' exact allocations and
/// the work bounds (a lower bound that overflows falls back to 0, an upper
/// bound to none).
struct Sum {
    bytes: Result<u64, WireError>,
    values: Option<u64>,
    workspace: u64,
    work_lower: Option<u64>,
    work_upper: Option<u64>,
}

impl Sum {
    fn new() -> Sum {
        Sum { bytes: Ok(0), values: Some(0), workspace: 0, work_lower: Some(0), work_upper: Some(0) }
    }
    fn bytes(&mut self, b: Result<u64, WireError>) {
        self.bytes = match (self.bytes, b) {
            (Ok(t), Ok(b)) => ck(t.checked_add(b)),
            (Err(e), _) | (_, Err(e)) => Err(e),
        };
    }
    /// A vector of n BigInts: its reservation (elements and header) and its
    /// exact allocation (the elements).
    fn vector(&mut self, n: usize) {
        self.bytes(vec_bytes(n));
        self.values = self.values.and_then(|v| v.checked_add(as_u64(n).checked_mul(as_u64(size_of::<BigInt>()))?));
    }
    /// The values of a ZV_1: their reservation (E1's bound) and their exact
    /// heap.
    fn values(&mut self, z: &Zv) {
        self.bytes(words_bytes(z.heap_words));
        for b in z.iter() {
            self.values = self.values.and_then(|v| v.checked_add(value_heap(limbs(&b))?));
        }
    }
    fn workspace(&mut self, l: u64) {
        let b = ck(workspace_words(l)).and_then(words_bytes);
        if let Ok(w) = b {
            self.workspace = w;
        }
        self.bytes(b);
    }
    fn work(&mut self, lower: Option<u64>, upper: Option<u64>) {
        self.work_lower = self.work_lower.and_then(|w| w.checked_add(lower?));
        self.work_upper = self.work_upper.and_then(|w| w.checked_add(upper?));
    }
    fn need(self) -> Result<Need, WireError> {
        let mem_lower = self.values.unwrap_or(0).max(self.workspace);
        Ok(Need { bytes: self.bytes?, cost: Cost { mem_lower, work_lower: self.work_lower.unwrap_or(0), work_estimate: None, work_upper: self.work_upper } })
    }
}

/// The exact heap bytes dashu allocates for a value of k u64 limbs built
/// from its bytes: none inline, else one buffer of n + floor(n/8) + 2 words
/// for its n words (a rigorous lower bound: the tests observe it).
fn value_heap(k: u64) -> Option<u64> {
    if k <= sagebrush_wire::INLINE_LIMBS {
        return Some(0);
    }
    let word = u64::from(dashu_int::Word::BITS / 8);
    let n = k.checked_mul(8 / word)?;
    n.checked_add(n / 8)?.checked_add(2)?.checked_mul(word)
}

/// The slots' loads and clears of a checked pair: the work every check
/// does whatever its gcd ([`coprime::coprime_pair`]).
fn pair_floor(ln: u64, ld: u64) -> Option<u64> {
    ln.checked_add(ld)?.checked_add(2)?.checked_add(ln.max(ld).checked_add(2)?.checked_mul(2)?)
}

/// The denominator's load and the final clear of a checked row
/// ([`coprime::coprime_row`]).
fn row_floor(ld: u64) -> Option<u64> {
    ld.checked_mul(2)?.checked_add(3)
}

fn fail(code: Code, offset: u64, what: &'static str) -> WireError {
    WireError { code, offset, what }
}

fn internal(what: &'static str) -> WireError {
    fail(Code::Internal, 0, what)
}

fn ck(v: Option<u64>) -> Result<u64, WireError> {
    v.ok_or(fail(Code::Cap, 0, "the decode cannot fit in memory (its size overflows u64)"))
}

const fn as_u64(n: usize) -> u64 {
    // (usize is at most 64 bits on every engine target: asserted by wire)
    n as u64
}

/// A `Vec<BigInt>` of capacity n: its elements and its header.
fn vec_bytes(n: usize) -> Result<u64, WireError> {
    let each = as_u64(size_of::<BigInt>());
    ck(as_u64(n).checked_mul(each).and_then(|b| b.checked_add(as_u64(size_of::<Vec<BigInt>>()))))
}

fn words_bytes(w: u64) -> Result<u64, WireError> {
    ck(w.checked_mul(8))
}

/// The entries of a `ZV_1` with their request offsets.
fn entries<'a>(z: &Zv<'a>) -> impl Iterator<Item = (Option<u64>, BigRef<'a>)> + 'a {
    let mut at = z.offset.checked_add(8);
    z.iter().map(move |b| {
        let here = at;
        at = at.and_then(|a| a.checked_add(4)).and_then(|a| a.checked_add(8 * as_u64(b.limb_count())));
        (here, b)
    })
}

fn is_unit(b: &BigRef) -> bool {
    b.limb_count() == 1 && b.limb(0) == 1
}

/// Whether gcd(n, d) = 1 needs a check (it is evident for n = 0, |n| = 1
/// and d = 1).
fn pair_checked(n: &BigRef, d: &BigRef) -> bool {
    !n.is_zero() && !is_unit(n) && !is_unit(d)
}

fn limbs(b: &BigRef) -> u64 {
    as_u64(b.limb_count())
}

fn value(b: &BigRef) -> BigInt {
    let sign = if b.is_zero() {
        Sign::NoSign
    } else if b.neg {
        Sign::Minus
    } else {
        Sign::Plus
    };
    BigInt::from_bytes_le(sign, b.le_bytes())
}

fn values(z: &Zv) -> Vec<BigInt> {
    let mut out = Vec::with_capacity(z.count);
    out.extend(z.iter().map(|b| value(&b)));
    out
}

fn fault(f: Fault) -> WireError {
    match f {
        Fault::Overrun => internal("a gcd check exceeded its admitted work"),
        Fault::Invariant => internal("a gcd check failed an invariant"),
    }
}

fn workspace(l: u64) -> Result<Vec<u64>, WireError> {
    let w = workspace_words(l).ok_or(internal("a workspace past u64"))?;
    let n = usize::try_from(w).map_err(|_| internal("a workspace past usize"))?;
    Ok(vec![0u64; n])
}

// ---------------------------------------------------------------- ZV_1

/// A `ZV_1` (no gcd checks, no cap: linear).
pub fn need_zv(z: &Zv) -> Result<Need, WireError> {
    let mut s = Sum::new();
    s.vector(z.count);
    s.values(z);
    s.need()
}

/// Decode a `ZV_1` after admitting its [`need_zv`].
pub fn decode_zv(z: &Zv, a: &mut impl Admit) -> Result<Vec<BigInt>, WireError> {
    admitted(need_zv(z), a)?;
    Ok(values(z))
}

/// An integer vector (`I641` or `ZV_1`).
pub fn need_ints(v: &Ints) -> Result<Need, WireError> {
    match v {
        Ints::Small(v) => {
            let mut s = Sum::new();
            s.vector(v.count);
            s.need()
        }
        Ints::Big(z) => need_zv(z),
    }
}

/// Decode an integer vector after admitting its [`need_ints`].
pub fn decode_ints(v: &Ints, a: &mut impl Admit) -> Result<Vec<BigInt>, WireError> {
    admitted(need_ints(v), a)?;
    Ok(ints_values(v))
}

fn ints_values(v: &Ints) -> Vec<BigInt> {
    match v {
        Ints::Small(s) => {
            let mut out = Vec::with_capacity(s.count);
            out.extend((0..s.count).map(|i| BigInt::from(s.get(i))));
            out
        }
        Ints::Big(z) => values(z),
    }
}

// ---------------------------------------------------------------- QV_1

/// A `QV_1`: both vectors, the values, and the workspace and work of the
/// pairs that need a gcd check.
pub fn need_qv(q: &Qv) -> Result<Need, WireError> {
    let mut s = Sum::new();
    let mut any = false;
    for (n, d) in q.num.iter().zip(q.den.iter()) {
        if pair_checked(&n, &d) {
            any = true;
            s.work(pair_floor(limbs(&n), limbs(&d)), coprime::pair_work(limbs(&n), limbs(&d)));
        }
    }
    s.vector(q.num.count);
    s.vector(q.den.count);
    s.values(&q.num);
    s.values(&q.den);
    if any {
        s.workspace(q.num.max_limbs.max(q.den.max_limbs));
    }
    s.need()
}

/// Check every pair of a `QV_1` against the admitted work.
fn check_qv(q: &Qv, upper: Option<u64>) -> Result<(), WireError> {
    let mut ws: Option<Vec<u64>> = None;
    let mut m = Meter::accounting(upper.unwrap_or(u64::MAX));
    for ((at, n), d) in entries(&q.num).zip(q.den.iter()) {
        if !pair_checked(&n, &d) {
            continue;
        }
        let w = match &mut ws {
            Some(w) => w,
            None => ws.insert(workspace(q.num.max_limbs.max(q.den.max_limbs))?),
        };
        if !coprime::coprime_pair(w, &n, &d, &mut m).map_err(fault)? {
            return Err(fail(Code::Schema, at.ok_or(internal("an offset past u64"))?, "a rational not in lowest terms"));
        }
    }
    Ok(())
}

/// Decode a `QV_1` after admitting its [`need_qv`]: the gcd checks, then
/// the numerators and denominators.
pub fn decode_qv(q: &Qv, a: &mut impl Admit) -> Result<(Vec<BigInt>, Vec<BigInt>), WireError> {
    let need = admitted(need_qv(q), a)?;
    qv_admitted(q, &need)
}

fn qv_admitted(q: &Qv, need: &Need) -> Result<(Vec<BigInt>, Vec<BigInt>), WireError> {
    check_qv(q, need.cost.work_upper)?;
    Ok((values(&q.num), values(&q.den)))
}

// ---------------------------------------------------------------- MAT1

/// A matrix's decoded entries, row-major.
#[derive(Debug, PartialEq)]
pub enum MatValues {
    Ints(Vec<BigInt>),
    Rationals(Vec<BigInt>, Vec<BigInt>),
}

/// A `MAT1` of integers or rationals (E3: rationals are two flat
/// vectors); a matrix of words is not this decoder's.
pub fn need_mat(m: &Mat) -> Result<Need, WireError> {
    match &m.elems {
        Elems::Ints(v) => need_ints(v),
        Elems::Rationals(q) => need_qv(q),
        Elems::Words(_) => Err(internal("a word matrix given to the big-integer decoder")),
    }
}

/// Decode a `MAT1` after admitting its [`need_mat`].
pub fn decode_mat(m: &Mat, a: &mut impl Admit) -> Result<MatValues, WireError> {
    let need = admitted(need_mat(m), a)?;
    match &m.elems {
        Elems::Ints(v) => Ok(MatValues::Ints(ints_values(v))),
        Elems::Rationals(q) => {
            let (n, d) = qv_admitted(q, &need)?;
            Ok(MatValues::Rationals(n, d))
        }
        Elems::Words(_) => Err(internal("a word matrix given to the big-integer decoder")),
    }
}

// ---------------------------------------------------------------- MQR1

/// An `MQR1`: the numerator and denominator vectors, the values, and the
/// workspace and work of the rows that need a check (the worst running-gcd
/// sequence their headers allow).
pub fn need_mqr(q: &Mqr) -> Result<Need, WireError> {
    let mut s = Sum::new();
    let mut any = false;
    for row in q.rows_iter() {
        s.values(&row);
        let mut it = row.iter();
        let d = it.next().ok_or(internal("an empty row"))?;
        if is_unit(&d) {
            continue;
        }
        any = true;
        let ld = limbs(&d);
        s.work(row_floor(ld), coprime::row_fixed_work(ld, row.max_limbs));
        for n in it {
            s.work(Some(0), coprime::row_entry_work(limbs(&n), ld));
        }
    }
    let n = q.rows.checked_mul(q.cols).ok_or(internal("rows x cols past usize"))?;
    s.vector(q.rows);
    s.vector(n);
    if any {
        s.workspace(q.max_limbs);
    }
    s.need()
}

fn check_mqr(q: &Mqr, upper: Option<u64>) -> Result<(), WireError> {
    let mut ws: Option<Vec<u64>> = None;
    let mut m = Meter::accounting(upper.unwrap_or(u64::MAX));
    for row in q.rows_iter() {
        let Some((at, d)) = entries(&row).next() else {
            return Err(internal("an empty row"));
        };
        if is_unit(&d) {
            continue;
        }
        let w = match &mut ws {
            Some(w) => w,
            None => ws.insert(workspace(q.max_limbs)?),
        };
        if !coprime::coprime_row(w, row.iter(), &mut m).map_err(fault)? {
            return Err(fail(Code::Schema, at.ok_or(internal("an offset past u64"))?, "a row whose denominator and numerators share a factor"));
        }
    }
    Ok(())
}

/// Decode an `MQR1` after admitting its [`need_mqr`]: the row checks,
/// then the denominators (one per row) and the numerators (row-major).
pub fn decode_mqr(q: &Mqr, a: &mut impl Admit) -> Result<(Vec<BigInt>, Vec<BigInt>), WireError> {
    let need = admitted(need_mqr(q), a)?;
    mqr_admitted(q, &need)
}

fn mqr_admitted(q: &Mqr, need: &Need) -> Result<(Vec<BigInt>, Vec<BigInt>), WireError> {
    check_mqr(q, need.cost.work_upper)?;
    let n = q.rows.checked_mul(q.cols).ok_or(internal("rows x cols past usize"))?;
    let mut dens = Vec::with_capacity(q.rows);
    let mut nums = Vec::with_capacity(n);
    for row in q.rows_iter() {
        let mut it = row.iter();
        dens.push(value(&it.next().ok_or(internal("an empty row"))?));
        nums.extend(it.map(|b| value(&b)));
    }
    if dens.len() != q.rows || nums.len() != n {
        return Err(internal("a row count that changed after validation"));
    }
    Ok((dens, nums))
}

// (its helpers use dashu's u64-word API: native targets only)
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
