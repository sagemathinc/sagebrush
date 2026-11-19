//! The engine's binary call framing, `SBW1`: one framing for every binary
//! engine entry point (`sb_bin_call` in WebAssembly, `call_bin` in Python).
//! It is a parser of untrusted bytes.  Its design obligations are labelled
//! S1 (admission) to S6 (replies and tests) in its comments and tests.
//!
//! Request: `SBW1`, the op name (u32 length, then 1 to 32 bytes of
//! `[a-z0-9_]`), the argument count (u32), then each argument (u32 length,
//! then a typed payload).  Little-endian everywhere; every number is read
//! with `from_le_bytes` from a copied slice, never by casting the buffer.
//!
//! - [`admit`] (S1, stage 1) borrows the request and validates the frame in
//!   place, allocating NOTHING: the global cap, the header, the op name
//!   (looked up), the argument table against the bytes present, then the
//!   op's own cap.
//! - The payload views ([`u641`], [`i641`], [`zv1`], [`ints`], [`qv1`],
//!   [`mat1`], [`mqr1`], [`txt1`]) validate one argument completely (S4,
//!   the structural and canonical checks that need no workspace) and give
//!   the counts the caller needs for its in-memory bound (S2).  They
//!   allocate nothing either: the caller computes its bound, reserves it,
//!   and only then decodes (S2).  Checks that need big-integer workspace
//!   (coprimality) belong to the consuming crate, after decoding, under the
//!   same reservation.
//! - [`ok_len`] / [`write_ok`] and [`error_reply`] write the replies (S3,
//!   S6): an ok reply into a buffer the caller allocated at its exact
//!   length; an error reply of bounded size whose text is composed from
//!   fixed strings and numbers, never from request bytes.
//!
//! No `unsafe`, no dependencies, `no_std` + `alloc`.

#![no_std]
extern crate alloc;

use alloc::vec::Vec;

/// The frame header: magic and format version.
pub const MAGIC: [u8; 4] = *b"SBW1";
/// The global frame cap: no request may be longer, whatever its op (every
/// op's own cap is at most this).
pub const FRAME_CAP: usize = 1 << 28;
/// The most arguments any op takes.
pub const MAX_ARGS: usize = 8;
/// The longest op name.
pub const OP_NAME_MAX: usize = 32;
/// The longest error text.
pub const ERROR_TEXT_MAX: usize = 256;
/// An error reply's largest size: header, "er", code, offset, text length,
/// text.
pub const ERROR_REPLY_MAX: usize = 4 + 2 + 2 + 8 + 2 + ERROR_TEXT_MAX;

/// What went wrong, by class (the u16 code of an error reply).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Code {
    /// The framing: truncated, trailing bytes, lengths that don't add up.
    Frame = 1,
    /// The header: not `SBW`, or another version.
    Header = 2,
    /// The op name: malformed or unknown.
    Op = 3,
    /// An argument count, element count or limb count out of bounds.
    Count = 4,
    /// A payload that breaks its schema (tag, layout, canonical form).
    Schema = 5,
    /// A value outside the op's domain (for example a coefficient >= p).
    Domain = 6,
    /// A size cap: the frame, the op's request, a reservation.
    Cap = 7,
    /// A failed proved invariant: a bug, never an expected outcome.
    Internal = 8,
}

/// A typed failure with the byte offset (into the request) where it was
/// found.  `what` is a fixed string: no request bytes are ever echoed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WireError {
    pub code: Code,
    pub offset: u64,
    pub what: &'static str,
}

fn err(code: Code, offset: u64, what: &'static str) -> WireError {
    WireError { code, offset, what }
}

/// A u64 as usize, refused when it doesn't fit (WebAssembly's usize is 32
/// bits); `max` is usize::MAX in production (the tests pass u32::MAX to
/// check the 32-bit behavior on a 64-bit host).
pub fn to_usize(v: u64, max: u64, offset: u64) -> Result<usize, WireError> {
    if v > max {
        return Err(err(Code::Count, offset, "a count too large for this platform"));
    }
    usize::try_from(v).map_err(|_| err(Code::Count, offset, "a count too large for this platform"))
}

fn usize_bound() -> u64 {
    // (usize is at most 64 bits on every target the engine supports)
    u64::try_from(usize::MAX).unwrap_or(u64::MAX)
}

/// A reader over a borrowed slice that knows its absolute offset in the
/// request, for error offsets.  Every read is bounds-checked; nothing is
/// allocated.
#[derive(Clone, Copy)]
struct Cursor<'a> {
    b: &'a [u8],
    pos: usize,
    base: u64,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8], base: u64) -> Self {
        Cursor { b, pos: 0, base }
    }
    fn at(&self) -> u64 {
        self.base.saturating_add(u64::try_from(self.pos).unwrap_or(u64::MAX))
    }
    fn left(&self) -> usize {
        self.b.len() - self.pos
    }
    fn take(&mut self, n: usize, code: Code, what: &'static str) -> Result<&'a [u8], WireError> {
        let end = self.pos.checked_add(n).ok_or(err(code, self.at(), what))?;
        if end > self.b.len() {
            return Err(err(code, self.at(), what));
        }
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u16(&mut self, what: &'static str) -> Result<u16, WireError> {
        let s = self.take(2, Code::Frame, what)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self, code: Code, what: &'static str) -> Result<u32, WireError> {
        let s = self.take(4, code, what)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self, code: Code, what: &'static str) -> Result<u64, WireError> {
        let s = self.take(8, code, what)?;
        let mut w = [0u8; 8];
        w.copy_from_slice(s);
        Ok(u64::from_le_bytes(w))
    }
    fn done(&self, what: &'static str) -> Result<(), WireError> {
        if self.pos != self.b.len() {
            return Err(err(Code::Schema, self.at(), what));
        }
        Ok(())
    }
}

// ------------------------------------------------------------- stage 1 (S1)

/// An op's admission parameters, from the dispatcher's table.
#[derive(Clone, Copy, Debug)]
pub struct OpSpec {
    pub min_args: usize,
    pub max_args: usize,
    /// The op's request cap in bytes (at most [`FRAME_CAP`]).
    pub request_cap: usize,
}

/// One argument: its payload bytes and their offset in the request.
#[derive(Clone, Copy, Debug)]
pub struct Arg<'a> {
    pub bytes: &'a [u8],
    pub offset: u64,
}

/// An admitted request: the op name and the argument table, all borrowed
/// (a fixed array: no allocation).
#[derive(Clone, Copy, Debug)]
pub struct Frame<'a> {
    pub op: &'a str,
    pub spec: OpSpec,
    args: [Arg<'a>; MAX_ARGS],
    nargs: usize,
}

impl<'a> Frame<'a> {
    pub fn nargs(&self) -> usize {
        self.nargs
    }
    pub fn arg(&self, i: usize) -> Option<Arg<'a>> {
        if i < self.nargs {
            Some(self.args[i])
        } else {
            None
        }
    }
}

/// Stage 1 of S1: validate the frame in place and look the op up, without
/// allocating.  Order: the global cap and minimum length; the header (no
/// other version, no headerless fallback); the op name (ASCII
/// `[a-z0-9_]{1,32}`, then `lookup`); the argument count (against the op's
/// minimum and maximum); each argument's length (against the bytes
/// present, checked); no trailing bytes; then the op's request cap.
pub fn admit<'a>(req: &'a [u8], lookup: impl Fn(&str) -> Option<OpSpec>) -> Result<Frame<'a>, WireError> {
    admit_with(req, lookup, usize_bound(), FRAME_CAP)
}

/// [`admit`] with an explicit usize maximum (the tests' 32-bit check) and
/// frame cap (so the tests exercise the cap gate without a 256 MiB frame).
pub fn admit_with<'a>(req: &'a [u8], lookup: impl Fn(&str) -> Option<OpSpec>, usize_bound: u64, frame_cap: usize) -> Result<Frame<'a>, WireError> {
    if req.len() > frame_cap {
        return Err(err(Code::Cap, 0, "the request exceeds the frame cap"));
    }
    let mut c = Cursor::new(req, 0);
    let h = c.take(4, Code::Header, "no frame header")?;
    if h[..3] != MAGIC[..3] {
        return Err(err(Code::Header, 0, "not an SBW frame"));
    }
    if h[3] != MAGIC[3] {
        return Err(err(Code::Header, 3, "an unsupported frame version"));
    }
    let at = c.at();
    let n = to_usize(u64::from(c.u32(Code::Frame, "no op name length")?), usize_bound, at)?;
    if n == 0 || n > OP_NAME_MAX {
        return Err(err(Code::Op, at, "an op name length out of range"));
    }
    let at = c.at();
    let name = c.take(n, Code::Frame, "a truncated op name")?;
    if !name.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
        return Err(err(Code::Op, at, "an op name with a character outside [a-z0-9_]"));
    }
    // (ASCII checked just above)
    let op = core::str::from_utf8(name).map_err(|_| err(Code::Op, at, "an op name that is not ASCII"))?;
    let spec = lookup(op).ok_or(err(Code::Op, at, "an unknown op"))?;
    let at = c.at();
    let argc = to_usize(u64::from(c.u32(Code::Frame, "no argument count")?), usize_bound, at)?;
    if argc < spec.min_args || argc > spec.max_args || argc > MAX_ARGS {
        return Err(err(Code::Count, at, "an argument count out of range for the op"));
    }
    let mut args = [Arg { bytes: &[], offset: 0 }; MAX_ARGS];
    for slot in args.iter_mut().take(argc) {
        let at = c.at();
        let len = to_usize(u64::from(c.u32(Code::Frame, "no argument length")?), usize_bound, at)?;
        let off = c.at();
        let bytes = c.take(len, Code::Frame, "an argument longer than the bytes present")?;
        *slot = Arg { bytes, offset: off };
    }
    if c.left() != 0 {
        return Err(err(Code::Frame, c.at(), "trailing bytes after the last argument"));
    }
    if req.len() > spec.request_cap {
        return Err(err(Code::Cap, 0, "the request exceeds the op's cap"));
    }
    Ok(Frame { op, spec, args, nargs: argc })
}

// ------------------------------------------------- payload views (S2, S4)

fn tag(c: &mut Cursor, want: &[u8; 4], what: &'static str) -> Result<(), WireError> {
    let at = c.at();
    let t = c.take(4, Code::Schema, what)?;
    if t != want {
        return Err(err(Code::Schema, at, what));
    }
    Ok(())
}

/// A validated vector of 64-bit words (`U641`), borrowed.
#[derive(Clone, Copy, Debug)]
pub struct U64s<'a> {
    words: &'a [u8],
    pub count: usize,
    pub offset: u64,
}

impl<'a> U64s<'a> {
    /// The i-th word (i < count).
    pub fn get(&self, i: usize) -> u64 {
        let mut w = [0u8; 8];
        w.copy_from_slice(&self.words[8 * i..8 * i + 8]);
        u64::from_le_bytes(w)
    }
    pub fn iter(&self) -> impl Iterator<Item = u64> + 'a {
        self.words.as_chunks::<8>().0.iter().map(|s| u64::from_le_bytes(*s))
    }
}

fn words_body<'a>(c: &mut Cursor<'a>, usize_bound: u64) -> Result<(usize, &'a [u8], u64), WireError> {
    let at = c.at();
    let n = to_usize(c.u64(Code::Schema, "no element count")?, usize_bound, at)?;
    let bytes = n.checked_mul(8).ok_or(err(Code::Count, at, "an element count too large"))?;
    if bytes > c.left() {
        return Err(err(Code::Count, at, "an element count larger than the bytes present"));
    }
    let off = c.at();
    let w = c.take(bytes, Code::Schema, "truncated words")?;
    Ok((n, w, off))
}

fn u641_in<'a>(c: &mut Cursor<'a>, usize_bound: u64) -> Result<U64s<'a>, WireError> {
    tag(c, b"U641", "expected a U641 payload")?;
    let (count, words, offset) = words_body(c, usize_bound)?;
    Ok(U64s { words, count, offset })
}

/// A `U641` argument (S4: count, then exactly count words; the op checks
/// the words' domain).
pub fn u641(a: Arg) -> Result<U64s, WireError> {
    u641_with(a, usize_bound())
}

pub fn u641_with(a: Arg, usize_bound: u64) -> Result<U64s, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    let v = u641_in(&mut c, usize_bound)?;
    c.done("trailing bytes after a U641 payload")?;
    Ok(v)
}

/// A `U641` of exactly one word: a typed scalar (S5).
pub fn scalar(a: Arg) -> Result<u64, WireError> {
    let v = u641(a)?;
    if v.count != 1 {
        return Err(err(Code::Count, a.offset, "a scalar must be a U641 of one word"));
    }
    Ok(v.get(0))
}

/// A validated vector of i64 (`I641`), borrowed.
#[derive(Clone, Copy, Debug)]
pub struct I64s<'a> {
    words: &'a [u8],
    pub count: usize,
    pub offset: u64,
}

impl<'a> I64s<'a> {
    pub fn get(&self, i: usize) -> i64 {
        let mut w = [0u8; 8];
        w.copy_from_slice(&self.words[8 * i..8 * i + 8]);
        i64::from_le_bytes(w)
    }
}

fn i641_in<'a>(c: &mut Cursor<'a>, usize_bound: u64) -> Result<I64s<'a>, WireError> {
    tag(c, b"I641", "expected an I641 payload")?;
    let (count, words, offset) = words_body(c, usize_bound)?;
    Ok(I64s { words, count, offset })
}

pub fn i641(a: Arg) -> Result<I64s, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    let v = i641_in(&mut c, usize_bound())?;
    c.done("trailing bytes after an I641 payload")?;
    Ok(v)
}

/// The words of heap storage the engine's BigInt may take for an integer
/// of `k` limbs (E1: the dashu bound, at most 2 words inline, else at most
/// k + floor(k/4) + 4 words; pinned by the consumer's peak tests).
pub fn bigint_heap_words(k: u64) -> Option<u64> {
    if k <= 2 {
        Some(0)
    } else {
        k.checked_add(k / 4)?.checked_add(4)
    }
}

/// A validated sequence of canonical big integers (`ZV_1`), borrowed, with
/// the figures an in-memory bound needs (S2).
#[derive(Clone, Copy, Debug)]
pub struct Zv<'a> {
    body: &'a [u8],
    pub count: usize,
    pub offset: u64,
    /// The heap words of all entries ([`bigint_heap_words`] summed).
    pub heap_words: u64,
    /// The largest limb count of an entry.
    pub max_limbs: u64,
    /// Whether every entry fits in i64 (the narrowest-tag rule, S4).
    pub all_fit_i64: bool,
}

/// One canonical big integer of a [`Zv`]: its sign and little-endian limbs.
#[derive(Clone, Copy, Debug)]
pub struct BigRef<'a> {
    pub neg: bool,
    limbs: &'a [u8],
}

impl<'a> BigRef<'a> {
    pub fn limb_count(&self) -> usize {
        self.limbs.len() / 8
    }
    pub fn limb(&self, i: usize) -> u64 {
        let mut w = [0u8; 8];
        w.copy_from_slice(&self.limbs[8 * i..8 * i + 8]);
        u64::from_le_bytes(w)
    }
    pub fn is_zero(&self) -> bool {
        self.limbs.is_empty()
    }
    /// The value as i64 when it fits.
    pub fn to_i64(&self) -> Option<i64> {
        match self.limb_count() {
            0 => Some(0),
            1 => {
                let m = self.limb(0);
                if self.neg {
                    if m <= 1u64 << 63 {
                        Some((m as i128).wrapping_neg() as i64)
                    } else {
                        None
                    }
                } else {
                    i64::try_from(m).ok()
                }
            }
            _ => None,
        }
    }
    fn is_one(&self) -> bool {
        !self.neg && self.limb_count() == 1 && self.limb(0) == 1
    }
}

impl<'a> Zv<'a> {
    /// The entries in order (already validated: this cannot fail).
    pub fn iter(&self) -> impl Iterator<Item = BigRef<'a>> + 'a {
        let mut c = Cursor::new(self.body, 0);
        let n = self.count;
        (0..n).map(move |_| {
            let h = c.u32(Code::Schema, "").unwrap_or(0);
            let k = usize::try_from(h >> 1).unwrap_or(0);
            let limbs = c.take(8 * k, Code::Schema, "").unwrap_or(&[]);
            BigRef { neg: h & 1 == 1, limbs }
        })
    }
}

fn zv1_in<'a>(c: &mut Cursor<'a>, usize_bound: u64) -> Result<Zv<'a>, WireError> {
    tag(c, b"ZV_1", "expected a ZV_1 payload")?;
    let at = c.at();
    let n = to_usize(c.u64(Code::Schema, "no element count")?, usize_bound, at)?;
    // each entry takes at least its 4-byte header: a count the bytes can't
    // hold is refused before any per-entry work
    if n.checked_mul(4).is_none_or(|b| b > c.left()) {
        return Err(err(Code::Count, at, "an element count larger than the bytes present"));
    }
    let start = c.pos;
    let mut heap_words: u64 = 0;
    let mut max_limbs: u64 = 0;
    let mut all_fit = true;
    for _ in 0..n {
        let at = c.at();
        let h = c.u32(Code::Schema, "a truncated integer header")?;
        let k = u64::from(h >> 1);
        let neg = h & 1 == 1;
        let kk = to_usize(k, usize_bound, at)?;
        let bytes = kk.checked_mul(8).ok_or(err(Code::Count, at, "a limb count too large"))?;
        if bytes > c.left() {
            return Err(err(Code::Count, at, "a limb count larger than the bytes present"));
        }
        let limbs = c.take(bytes, Code::Schema, "truncated limbs")?;
        if k == 0 {
            if neg {
                return Err(err(Code::Schema, at, "a negative zero (zero must have neg = 0)"));
            }
        } else if limbs[bytes - 8..] == [0u8; 8] {
            return Err(err(Code::Schema, at, "a leading zero limb (non-canonical integer)"));
        }
        let b = BigRef { neg, limbs };
        if b.to_i64().is_none() {
            all_fit = false;
        }
        heap_words = heap_words
            .checked_add(bigint_heap_words(k).ok_or(err(Code::Count, at, "a limb count too large"))?)
            .ok_or(err(Code::Count, at, "too many limbs in total"))?;
        max_limbs = max_limbs.max(k);
    }
    let body = &c.b[start..c.pos];
    Ok(Zv { body, count: n, offset: at, heap_words, max_limbs, all_fit_i64: all_fit })
}

/// A `ZV_1` argument where the schema offers no `I641` alternative.
pub fn zv1(a: Arg) -> Result<Zv, WireError> {
    zv1_with(a, usize_bound())
}

pub fn zv1_with(a: Arg, usize_bound: u64) -> Result<Zv, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    let v = zv1_in(&mut c, usize_bound)?;
    c.done("trailing bytes after a ZV_1 payload")?;
    Ok(v)
}

/// An integer vector where the schema offers the choice of `I641` or
/// `ZV_1` (top-level integer vectors, `MAT1` elements): the narrowest-tag
/// rule applies (S4), so a `ZV_1` whose entries all fit in i64 is
/// refused.
#[derive(Clone, Copy, Debug)]
pub enum Ints<'a> {
    Small(I64s<'a>),
    Big(Zv<'a>),
}

fn ints_in<'a>(c: &mut Cursor<'a>, usize_bound: u64) -> Result<Ints<'a>, WireError> {
    let at = c.at();
    let t = c.b.get(c.pos..c.pos.saturating_add(4)).ok_or(err(Code::Schema, at, "no payload tag"))?;
    if t == b"I641" {
        Ok(Ints::Small(i641_in(c, usize_bound)?))
    } else if t == b"ZV_1" {
        let z = zv1_in(c, usize_bound)?;
        if z.all_fit_i64 {
            return Err(err(Code::Schema, at, "a ZV_1 whose entries all fit in i64 (must be I641)"));
        }
        Ok(Ints::Big(z))
    } else {
        Err(err(Code::Schema, at, "expected an I641 or ZV_1 payload"))
    }
}

pub fn ints(a: Arg) -> Result<Ints, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    let v = ints_in(&mut c, usize_bound())?;
    c.done("trailing bytes after an integer vector")?;
    Ok(v)
}

/// A validated vector of rationals (`QV_1`): numerators and denominators,
/// equal counts, denominators positive, zero as 0/1.  Coprimality needs
/// big-integer workspace: the consumer checks it after decoding (S2).
#[derive(Clone, Copy, Debug)]
pub struct Qv<'a> {
    pub num: Zv<'a>,
    pub den: Zv<'a>,
}

fn qv1_in<'a>(c: &mut Cursor<'a>, usize_bound: u64) -> Result<Qv<'a>, WireError> {
    tag(c, b"QV_1", "expected a QV_1 payload")?;
    let num = zv1_in(c, usize_bound)?;
    let at = c.at();
    let den = zv1_in(c, usize_bound)?;
    if num.count != den.count {
        return Err(err(Code::Schema, at, "numerator and denominator counts differ"));
    }
    for (n, d) in num.iter().zip(den.iter()) {
        if d.neg || d.is_zero() {
            return Err(err(Code::Schema, at, "a denominator that is not positive"));
        }
        if n.is_zero() && !d.is_one() {
            return Err(err(Code::Schema, at, "zero must be 0/1"));
        }
    }
    Ok(Qv { num, den })
}

pub fn qv1(a: Arg) -> Result<Qv, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    let v = qv1_in(&mut c, usize_bound())?;
    c.done("trailing bytes after a QV_1 payload")?;
    Ok(v)
}

/// The element payload of a matrix.
#[derive(Clone, Copy, Debug)]
pub enum Elems<'a> {
    Words(U64s<'a>),
    Ints(Ints<'a>),
    Rationals(Qv<'a>),
}

/// The element tags an op accepts in a `MAT1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElemKind {
    Words,
    Ints,
    Rationals,
}

/// A validated matrix (`MAT1`): rows, cols and exactly rows x cols entries.
#[derive(Clone, Copy, Debug)]
pub struct Mat<'a> {
    pub rows: usize,
    pub cols: usize,
    pub elems: Elems<'a>,
}

/// A `MAT1` argument with the element kind the op allows; `empty_ok`
/// allows rows = 0 or cols = 0.
pub fn mat1(a: Arg, kind: ElemKind, empty_ok: bool) -> Result<Mat, WireError> {
    mat1_with(a, kind, empty_ok, usize_bound())
}

pub fn mat1_with(a: Arg, kind: ElemKind, empty_ok: bool, usize_bound: u64) -> Result<Mat, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    tag(&mut c, b"MAT1", "expected a MAT1 payload")?;
    let at = c.at();
    let rows = to_usize(u64::from(c.u32(Code::Schema, "no row count")?), usize_bound, at)?;
    let cols = to_usize(u64::from(c.u32(Code::Schema, "no column count")?), usize_bound, at)?;
    if !empty_ok && (rows == 0 || cols == 0) {
        return Err(err(Code::Count, at, "an empty matrix where the op needs entries"));
    }
    let n = rows.checked_mul(cols).ok_or(err(Code::Count, at, "rows x cols too large"))?;
    let eat = c.at();
    let elems = match kind {
        ElemKind::Words => {
            let v = u641_in(&mut c, usize_bound)?;
            if v.count != n {
                return Err(err(Code::Count, eat, "the entry count is not rows x cols"));
            }
            Elems::Words(v)
        }
        ElemKind::Ints => {
            let v = ints_in(&mut c, usize_bound)?;
            let cnt = match v {
                Ints::Small(s) => s.count,
                Ints::Big(z) => z.count,
            };
            if cnt != n {
                return Err(err(Code::Count, eat, "the entry count is not rows x cols"));
            }
            Elems::Ints(v)
        }
        ElemKind::Rationals => {
            let v = qv1_in(&mut c, usize_bound)?;
            if v.num.count != n {
                return Err(err(Code::Count, eat, "the entry count is not rows x cols"));
            }
            Elems::Rationals(v)
        }
    };
    c.done("trailing bytes after a MAT1 payload")?;
    Ok(Mat { rows, cols, elems })
}

/// A validated QQ matrix with cleared row denominators (`MQR1`): each row a
/// ZV_1 of exactly cols + 1 integers (the row's denominator, then its
/// numerators), d > 0, an all-zero row with d = 1.  The gcd condition is
/// the consumer's, after decoding (S2).
#[derive(Clone, Copy, Debug)]
pub struct Mqr<'a> {
    pub rows: usize,
    pub cols: usize,
    body: &'a [u8],
    base: u64,
    /// The heap words of every integer, denominators included.
    pub heap_words: u64,
    pub max_limbs: u64,
}

impl<'a> Mqr<'a> {
    /// The rows in order, each a validated ZV_1 of cols + 1 integers.
    pub fn rows_iter(&self) -> impl Iterator<Item = Zv<'a>> + 'a {
        let mut c = Cursor::new(self.body, self.base);
        let r = self.rows;
        (0..r).filter_map(move |_| zv1_in(&mut c, usize_bound()).ok())
    }
}

pub fn mqr1(a: Arg) -> Result<Mqr, WireError> {
    mqr1_with(a, usize_bound())
}

pub fn mqr1_with(a: Arg, usize_bound: u64) -> Result<Mqr, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    tag(&mut c, b"MQR1", "expected an MQR1 payload")?;
    let at = c.at();
    let rows = to_usize(u64::from(c.u32(Code::Schema, "no row count")?), usize_bound, at)?;
    let cols = to_usize(u64::from(c.u32(Code::Schema, "no column count")?), usize_bound, at)?;
    let per = cols.checked_add(1).ok_or(err(Code::Count, at, "cols + 1 too large"))?;
    let _total = rows.checked_mul(per).ok_or(err(Code::Count, at, "rows x (cols + 1) too large"))?;
    // each row takes at least a tag, a count and (cols + 1) headers
    let min_row = per.checked_mul(4).and_then(|x| x.checked_add(12)).ok_or(err(Code::Count, at, "a row too large"))?;
    if rows.checked_mul(min_row).is_none_or(|b| b > c.left()) {
        return Err(err(Code::Count, at, "a row count larger than the bytes present"));
    }
    let start = c.pos;
    let base = c.at();
    let mut heap_words: u64 = 0;
    let mut max_limbs: u64 = 0;
    for _ in 0..rows {
        let rat = c.at();
        let z = zv1_in(&mut c, usize_bound)?;
        if z.count != per {
            return Err(err(Code::Count, rat, "a row that does not have cols + 1 integers"));
        }
        let mut it = z.iter();
        let d = it.next().ok_or(err(Code::Internal, rat, "an empty row"))?;
        if d.neg || d.is_zero() {
            return Err(err(Code::Schema, rat, "a row denominator that is not positive"));
        }
        let all_zero = it.all(|x| x.is_zero());
        if all_zero && !d.is_one() {
            return Err(err(Code::Schema, rat, "an all-zero row must have denominator 1"));
        }
        heap_words = heap_words.checked_add(z.heap_words).ok_or(err(Code::Count, rat, "too many limbs in total"))?;
        max_limbs = max_limbs.max(z.max_limbs);
    }
    let body = &c.b[start..c.pos];
    c.done("trailing bytes after an MQR1 payload")?;
    Ok(Mqr { rows, cols, body, base, heap_words, max_limbs })
}

// ---------------------------------------------------------------- TXT1 (S5)

/// The most lines, bytes, key bytes and value bytes of a `TXT1`.
pub const TXT_MAX_LINES: usize = 16;
pub const TXT_MAX_BYTES: usize = 1024;
pub const TXT_MAX_KEY: usize = 32;
pub const TXT_MAX_VALUE: usize = 64;

/// Validated textual options (S5): ASCII, LF line ends, `key=value` lines
/// with keys `[a-z][a-z0-9_]{0,31}` in strictly increasing order, values
/// 1 to 64 printable bytes 0x21-0x7E other than `=`, every key in the op's
/// allowlist.
#[derive(Clone, Copy, Debug)]
pub struct Txt<'a> {
    text: &'a [u8],
}

impl<'a> Txt<'a> {
    /// The value of `key`, if present.
    pub fn get(&self, key: &str) -> Option<&'a str> {
        for line in self.text.split(|&b| b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let eq = line.iter().position(|&b| b == b'=')?;
            if &line[..eq] == key.as_bytes() {
                return core::str::from_utf8(&line[eq + 1..]).ok();
            }
        }
        None
    }
}

pub fn txt1<'a>(a: Arg<'a>, allow: &[&str]) -> Result<Txt<'a>, WireError> {
    let mut c = Cursor::new(a.bytes, a.offset);
    tag(&mut c, b"TXT1", "expected a TXT1 payload")?;
    // the text is the rest of the argument (its length is the frame's)
    let tat = c.at();
    if c.left() > TXT_MAX_BYTES {
        return Err(err(Code::Cap, tat, "options text longer than 1 KiB"));
    }
    let text = c.take(c.left(), Code::Schema, "truncated options text")?;
    if !text.is_empty() && *text.last().unwrap_or(&0) != b'\n' {
        return Err(err(Code::Schema, tat, "options text must end with LF"));
    }
    let mut lines = 0usize;
    let mut prev: &[u8] = &[];
    let mut pos = 0usize;
    for line in text.split(|&b| b == b'\n') {
        let lat = tat.saturating_add(u64::try_from(pos).unwrap_or(u64::MAX));
        pos += line.len() + 1;
        if line.is_empty() {
            // (only the empty tail after the final LF)
            if pos <= text.len() {
                return Err(err(Code::Schema, lat, "an empty options line"));
            }
            continue;
        }
        lines += 1;
        if lines > TXT_MAX_LINES {
            return Err(err(Code::Count, lat, "more than 16 option lines"));
        }
        let eq = line.iter().position(|&b| b == b'=').ok_or(err(Code::Schema, lat, "an option line without '='"))?;
        let (key, value) = (&line[..eq], &line[eq + 1..]);
        let key_ok = !key.is_empty()
            && key.len() <= TXT_MAX_KEY
            && key[0].is_ascii_lowercase()
            && key.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !key_ok {
            return Err(err(Code::Schema, lat, "a malformed option key"));
        }
        let value_ok = !value.is_empty() && value.len() <= TXT_MAX_VALUE && value.iter().all(|&b| (0x21..=0x7e).contains(&b) && b != b'=');
        if !value_ok {
            return Err(err(Code::Schema, lat, "a malformed option value"));
        }
        if key <= prev {
            return Err(err(Code::Schema, lat, "option keys out of order or repeated"));
        }
        if !allow.iter().any(|k| k.as_bytes() == key) {
            return Err(err(Code::Schema, lat, "an option key the op does not take"));
        }
        prev = key;
    }
    Ok(Txt { text })
}

// ------------------------------------------------------- replies (S3, S6)

/// The byte length of a `U641` payload of n words.
pub fn u641_len(n: usize) -> Option<usize> {
    n.checked_mul(8)?.checked_add(12)
}

/// Append a `U641` payload (the caller reserved and sized the buffer).
pub fn put_u641(out: &mut Vec<u8>, words: &[u64]) {
    out.extend_from_slice(b"U641");
    out.extend_from_slice(&u64::try_from(words.len()).unwrap_or(u64::MAX).to_le_bytes());
    for w in words {
        out.extend_from_slice(&w.to_le_bytes());
    }
}

/// The byte length of an ok reply with payloads of these lengths: header,
/// "ok", u32 count, then (u32 length + payload) each.  None when a length
/// or the count doesn't fit its u32 field, or the sum overflows.
pub fn ok_len(payload_lens: &[usize]) -> Option<usize> {
    u32::try_from(payload_lens.len()).ok()?;
    let mut n: usize = 4 + 2 + 4;
    for &l in payload_lens {
        u32::try_from(l).ok()?;
        n = n.checked_add(4)?.checked_add(l)?;
    }
    Some(n)
}

/// Write an ok reply into `out`, which the caller allocated with capacity
/// [`ok_len`] (after reserving it): the write never reallocates.
pub fn write_ok(out: &mut Vec<u8>, payloads: &[&[u8]]) -> Result<(), WireError> {
    let lens: [usize; MAX_ARGS] = {
        let mut a = [0usize; MAX_ARGS];
        if payloads.len() > MAX_ARGS {
            return Err(err(Code::Internal, 0, "too many results"));
        }
        for (i, p) in payloads.iter().enumerate() {
            a[i] = p.len();
        }
        a
    };
    let need = ok_len(&lens[..payloads.len()]).ok_or(err(Code::Internal, 0, "a result too large to frame"))?;
    if out.capacity().saturating_sub(out.len()) < need {
        return Err(err(Code::Internal, 0, "the reply buffer was not sized to its bound"));
    }
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(b"ok");
    // (ok_len checked that the count and each length fit u32)
    let internal = err(Code::Internal, 0, "a result too large to frame");
    out.extend_from_slice(&u32::try_from(payloads.len()).map_err(|_| internal)?.to_le_bytes());
    for p in payloads {
        out.extend_from_slice(&u32::try_from(p.len()).map_err(|_| internal)?.to_le_bytes());
        out.extend_from_slice(p);
    }
    Ok(())
}

/// The byte length of an ok reply whose results are `U641` payloads of
/// these word counts (S3: an op's closed-form reply bound).
pub fn ok_u641_len(counts: &[usize]) -> Option<usize> {
    let mut lens = [0usize; MAX_ARGS];
    if counts.len() > MAX_ARGS {
        return None;
    }
    for (l, &n) in lens.iter_mut().zip(counts) {
        *l = u641_len(n)?;
    }
    ok_len(&lens[..counts.len()])
}

/// Write an ok reply of `U641` results straight from the words (no
/// intermediate payload buffers) into `out`, which the caller allocated
/// with capacity [`ok_u641_len`] after reserving it: never a reallocation.
pub fn write_ok_u641(out: &mut Vec<u8>, results: &[&[u64]]) -> Result<(), WireError> {
    let mut counts = [0usize; MAX_ARGS];
    if results.len() > MAX_ARGS {
        return Err(err(Code::Internal, 0, "too many results"));
    }
    for (c, r) in counts.iter_mut().zip(results) {
        *c = r.len();
    }
    let need = ok_u641_len(&counts[..results.len()]).ok_or(err(Code::Internal, 0, "a result too large to frame"))?;
    if out.capacity().saturating_sub(out.len()) < need {
        return Err(err(Code::Internal, 0, "the reply buffer was not sized to its bound"));
    }
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(b"ok");
    let internal = err(Code::Internal, 0, "a result too large to frame");
    out.extend_from_slice(&u32::try_from(results.len()).map_err(|_| internal)?.to_le_bytes());
    for r in results {
        // (ok_u641_len checked that each length fits u32)
        let len = u641_len(r.len()).and_then(|l| u32::try_from(l).ok()).ok_or(internal)?;
        out.extend_from_slice(&len.to_le_bytes());
        put_u641(out, r);
    }
    Ok(())
}

/// The error reply for `e`: header, "er", the code (u16), the offset
/// (u64), the text length (u16) and the text, composed from `e.what` (a
/// fixed string), at most [`ERROR_TEXT_MAX`] bytes: never request bytes.
pub fn error_reply(e: &WireError) -> Vec<u8> {
    let text = e.what.as_bytes();
    let t = &text[..text.len().min(ERROR_TEXT_MAX)];
    let mut v = Vec::with_capacity(ERROR_REPLY_MAX);
    v.extend_from_slice(&MAGIC);
    v.extend_from_slice(b"er");
    v.extend_from_slice(&(e.code as u16).to_le_bytes());
    v.extend_from_slice(&e.offset.to_le_bytes());
    v.extend_from_slice(&u16::try_from(t.len()).unwrap_or(0).to_le_bytes());
    v.extend_from_slice(t);
    v
}

/// Parse a reply (the hosts' side, also used by the tests): Ok(payloads)
/// or Err((code, offset)).  Every byte is checked; a truncated or
/// malformed reply is an error, never a panic.
/// A parsed reply: the result payloads, or an error's (code, offset).
pub type Reply<'a> = Result<Vec<&'a [u8]>, (u16, u64)>;

pub fn parse_reply(r: &[u8]) -> Result<Reply<'_>, WireError> {
    let mut c = Cursor::new(r, 0);
    let h = c.take(4, Code::Header, "no reply header")?;
    if h != MAGIC {
        return Err(err(Code::Header, 0, "not an SBW1 reply"));
    }
    let k = c.take(2, Code::Frame, "no reply kind")?;
    if k == b"ok" {
        let at = c.at();
        let n = to_usize(u64::from(c.u32(Code::Frame, "no result count")?), usize_bound(), at)?;
        if n > MAX_ARGS {
            return Err(err(Code::Count, at, "too many results"));
        }
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let at = c.at();
            let l = to_usize(u64::from(c.u32(Code::Frame, "no result length")?), usize_bound(), at)?;
            out.push(c.take(l, Code::Frame, "a truncated result")?);
        }
        if c.left() != 0 {
            return Err(err(Code::Frame, c.at(), "trailing bytes after the results"));
        }
        Ok(Ok(out))
    } else if k == b"er" {
        let code = c.u16("no error code")?;
        let off = c.u64(Code::Frame, "no error offset")?;
        let at = c.at();
        let tl = usize::from(c.u16("no error text length")?);
        if tl > ERROR_TEXT_MAX {
            return Err(err(Code::Count, at, "an error text too long"));
        }
        c.take(tl, Code::Frame, "a truncated error text")?;
        if c.left() != 0 {
            return Err(err(Code::Frame, c.at(), "trailing bytes after the error"));
        }
        Ok(Err((code, off)))
    } else {
        Err(err(Code::Frame, 4, "an unknown reply kind"))
    }
}

#[cfg(test)]
mod tests;
