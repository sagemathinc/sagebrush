//! Decoding the wire's big-integer payloads (`ZV_1`, integer vectors,
//! `QV_1`, `MAT1`, `MQR1`) into engine integers, under one reservation
//! (S2).  For each payload the caller:
//! 1. takes its [`Need`] (`need_*`, allocation-free): over-size integers
//!    where a gcd check runs are refused (Cap, [`LIMB_CAP`]), and the bytes
//!    of everything decoded plus the workspace, and the work of every gcd
//!    check, are bounded in checked u64 arithmetic;
//! 2. admits `need.work` from the call's work budget and reserves
//!    `need.bytes` in the ledger, before anything here allocates;
//! 3. decodes (`decode_*`): the gcd = 1 checks first, in the workspace,
//!    metered against `need.work`; then the values, with exactly the
//!    allocations `need.bytes` counts.
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

use crate::coprime::{self, Fault, Meter, LIMB_CAP, workspace_words};
use sagebrush_bigint::{BigInt, Sign};
use sagebrush_wire::{BigRef, Code, Elems, Ints, Mat, Mqr, Qv, WireError, Zv};

// E1's inline rule is dashu's: two machine words inline, so the wire's
// INLINE_LIMBS u64 limbs are exactly two words on every target (one limb
// in WebAssembly, where a word is 32 bits); a mismatch fails the build.
const _: () = assert!(sagebrush_wire::INLINE_LIMBS * 64 == 2 * dashu_int::Word::BITS as u64);

/// What a payload needs, admitted before it is decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Need {
    /// The bytes of every allocation of the decode.
    pub bytes: u64,
    /// The gcd checks' work bound (units of [`coprime::Meter`]).
    pub work: u64,
}

fn fail(code: Code, offset: u64, what: &'static str) -> WireError {
    WireError { code, offset, what }
}

fn internal(what: &'static str) -> WireError {
    fail(Code::Internal, 0, what)
}

fn ck(v: Option<u64>) -> Result<u64, WireError> {
    v.ok_or(fail(Code::Cap, 0, "a decode bound too large"))
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

fn sum(parts: &[u64]) -> Result<u64, WireError> {
    let mut t: u64 = 0;
    for &p in parts {
        t = ck(t.checked_add(p))?;
    }
    Ok(t)
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

/// Refuse an integer over [`LIMB_CAP`] (only where gcd checks run).
fn capped(z: &Zv) -> Result<(), WireError> {
    if z.max_limbs <= LIMB_CAP {
        return Ok(());
    }
    for (at, b) in entries(z) {
        if as_u64(b.limb_count()) > LIMB_CAP {
            return Err(fail(Code::Cap, at.ok_or(internal("an offset past u64"))?, "an integer of a rational above 2^20 bits (about 315,000 decimal digits)"));
        }
    }
    Err(internal("a limb maximum without its integer"))
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
    Ok(Need { bytes: sum(&[vec_bytes(z.count)?, words_bytes(z.heap_words)?])?, work: 0 })
}

pub fn decode_zv(z: &Zv) -> Vec<BigInt> {
    values(z)
}

/// An integer vector (`I641` or `ZV_1`).
pub fn need_ints(v: &Ints) -> Result<Need, WireError> {
    match v {
        Ints::Small(s) => Ok(Need { bytes: vec_bytes(s.count)?, work: 0 }),
        Ints::Big(z) => need_zv(z),
    }
}

pub fn decode_ints(v: &Ints) -> Vec<BigInt> {
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

/// A `QV_1`: the cap, both vectors, the values, and the workspace and
/// work of the pairs that need a gcd check.
pub fn need_qv(q: &Qv) -> Result<Need, WireError> {
    capped(&q.num)?;
    capped(&q.den)?;
    let mut work: u64 = 0;
    let mut any = false;
    for (n, d) in q.num.iter().zip(q.den.iter()) {
        if pair_checked(&n, &d) {
            any = true;
            work = ck(work.checked_add(ck(coprime::pair_work(limbs(&n), limbs(&d)))?))?;
        }
    }
    let ws = if any { words_bytes(ck(workspace_words(q.num.max_limbs.max(q.den.max_limbs)))?)? } else { 0 };
    let bytes = sum(&[vec_bytes(q.num.count)?, vec_bytes(q.den.count)?, words_bytes(q.num.heap_words)?, words_bytes(q.den.heap_words)?, ws])?;
    Ok(Need { bytes, work })
}

/// Check every pair of a `QV_1` against the admitted work.
fn check_qv(q: &Qv, work: u64) -> Result<(), WireError> {
    let mut ws: Option<Vec<u64>> = None;
    let mut m = Meter::new(work);
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

/// Decode a `QV_1` admitted at `need` (its [`need_qv`]): the gcd checks,
/// then the numerators and denominators.
pub fn decode_qv(q: &Qv, need: &Need) -> Result<(Vec<BigInt>, Vec<BigInt>), WireError> {
    check_qv(q, need.work)?;
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

pub fn decode_mat(m: &Mat, need: &Need) -> Result<MatValues, WireError> {
    match &m.elems {
        Elems::Ints(v) => Ok(MatValues::Ints(decode_ints(v))),
        Elems::Rationals(q) => {
            let (n, d) = decode_qv(q, need)?;
            Ok(MatValues::Rationals(n, d))
        }
        Elems::Words(_) => Err(internal("a word matrix given to the big-integer decoder")),
    }
}

// ---------------------------------------------------------------- MQR1

/// An `MQR1`: the cap, the numerator and denominator vectors, the values,
/// and the workspace and work of the rows that need a check (the worst
/// running-gcd sequence their headers allow).
pub fn need_mqr(q: &Mqr) -> Result<Need, WireError> {
    let mut work: u64 = 0;
    let mut any = false;
    for row in q.rows_iter() {
        capped(&row)?;
        let mut it = row.iter();
        let d = it.next().ok_or(internal("an empty row"))?;
        if is_unit(&d) {
            continue;
        }
        any = true;
        let ld = limbs(&d);
        work = ck(work.checked_add(ck(coprime::row_fixed_work(ld, row.max_limbs))?))?;
        for n in it {
            work = ck(work.checked_add(ck(coprime::row_entry_work(limbs(&n), ld))?))?;
        }
    }
    let n = q.rows.checked_mul(q.cols).ok_or(internal("rows x cols past usize"))?;
    let ws = if any { words_bytes(ck(workspace_words(q.max_limbs))?)? } else { 0 };
    let bytes = sum(&[vec_bytes(q.rows)?, vec_bytes(n)?, words_bytes(q.heap_words)?, ws])?;
    Ok(Need { bytes, work })
}

fn check_mqr(q: &Mqr, work: u64) -> Result<(), WireError> {
    let mut ws: Option<Vec<u64>> = None;
    let mut m = Meter::new(work);
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

/// Decode an `MQR1` admitted at `need` (its [`need_mqr`]): the row
/// checks, then the denominators (one per row) and the numerators
/// (row-major).
pub fn decode_mqr(q: &Mqr, need: &Need) -> Result<(Vec<BigInt>, Vec<BigInt>), WireError> {
    check_mqr(q, need.work)?;
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

#[cfg(test)]
mod tests;
