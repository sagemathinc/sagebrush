//! The binary entry point's ops (`sb_bin_call` here, `call_bin` in Python):
//! SBW1 requests (engine/wire) for GF(p)[x], with coefficients as `U641`
//! words instead of decimal text.
//!
//! - `nmod_poly_mul(p, a, b)` -> [a b];
//! - `nmod_poly_divrem(p, a, b)` -> [q, r], a = q b + r, deg r < deg b;
//! - `nmod_poly_gcd(p, a, b)` -> [the monic gcd];
//! - `nmod_echelon(p, M, flags)` -> [pivots, det] or [pivots, det, rows]:
//!   the JSON op's echelon (nmod_ops.rs) on a `MAT1` of words, without its
//!   per-dimension cap (below);
//! - `nmod_mat_mul(p, A, B)` -> [A B]: the product of an r x k and a k x c
//!   `MAT1` of words, row-major (below);
//! - `conjugacy_classes_bin(n, gens)` -> [reps, lengths, orders]: a
//!   permutation group's conjugacy classes (below).
//!
//! p is a typed scalar (a `U641` of one word), prime, below 2^63.  A
//! polynomial is a `U641` of its coefficients,
//! constant term first, each in [0, p), at least one, the last nonzero
//! (one encoding per polynomial: the caller answers the zero polynomial),
//! at most the op's length cap (the JSON ops' caps, nmod_ops.rs).
//!
//! Admission follows the wire format's order (S1, S2): the frame and its
//! cap (sagebrush_wire::admit, no allocation), then every argument's
//! schema and domain by views over the request (no allocation), then ONE
//! ledger reservation of the call's closed-form bound at the actual
//! lengths: the decoded inputs, the computation (the closed forms of
//! nmod_ops.rs, evaluated at these lengths instead of at the caps) and the
//! reply (S3), held to the end of the call.  Only then does anything
//! allocate.  Every offset, count and size is computed with checked
//! arithmetic: an overflow is a typed refusal, never a wrap.
//!
//! A failure is an `er` reply (S6) with a code, the request offset and a
//! fixed text: a refused reservation is `Cap`, a failed invariant
//! `Internal`.
//!
//! `nmod_echelon` admits any rows x cols >= 1 whose request fits the frame
//! cap (its request cap is the frame cap): no per-dimension, entry or work
//! ceiling of its own.  `flags` is a U641 scalar, bit 0 `reduced`, bit 1
//! `want_rows`, any other bit refused.  Every entry must be below p (refused,
//! never reduced, as the JSON op does).  The reply is the JSON op's fields
//! as `U641` payloads: the pivot columns, the determinant factor (one word)
//! and, with `want_rows`, every row of the (reduced, if asked) echelon form,
//! row-major.  The scan, the decode and the reply poll for Stop every
//! [`ECH_CHUNK`] words and count their words (Move) after each run.

use sagebrush_arith::cost::{tally, Family};
use sagebrush_arith::nmod::{is_prime, Modulus};
use sagebrush_arith::nmod_mat::{product_peak, with_fast_product, Mat};
use sagebrush_arith::{nmod_poly, ntt};
use sagebrush_wire::{self as wire, Code, OpSpec, U64s, WireError};

use crate::nmod_ops::{DIV_MAX_LEN, GCD_MAX_LEN, MUL_MAX_LEN};

/// The largest request of an op of `polys` polynomials of at most `len`
/// coefficients: the header, a 32-byte name, the counts and lengths, the
/// scalar p and the polynomials.
/// None on an overflow (then the op admits nothing: see spec).
const fn request_cap(polys: usize, len: usize) -> Option<usize> {
    // the header, name length, name, argument count; a length per
    // argument; the scalar p (tag, count, word)
    let Some(args) = polys.checked_add(1) else { return None };
    let Some(lengths) = args.checked_mul(4) else { return None };
    let Some(frame) = (4 + 4 + wire::OP_NAME_MAX + 4 + 12 + 8).checked_add(lengths) else { return None };
    let Some(words) = len.checked_mul(8) else { return None };
    let Some(poly) = words.checked_add(12) else { return None };
    let Some(all) = poly.checked_mul(polys) else { return None };
    frame.checked_add(all)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Mul,
    Divrem,
    Gcd,
}

struct BinOp {
    name: &'static str,
    kind: Kind,
    polys: usize,
    max_len: usize,
}

/// p is below 2^63 for every op.
const MAX_P: u64 = 1 << 63;

static BIN_OPS: [BinOp; 3] = [
    BinOp { name: "nmod_poly_mul", kind: Kind::Mul, polys: 2, max_len: MUL_MAX_LEN },
    BinOp { name: "nmod_poly_divrem", kind: Kind::Divrem, polys: 2, max_len: DIV_MAX_LEN },
    BinOp { name: "nmod_poly_gcd", kind: Kind::Gcd, polys: 2, max_len: GCD_MAX_LEN },
];

// every op's request cap is below the frame cap (S1)
const _: () = {
    let mut i = 0;
    while i < BIN_OPS.len() {
        assert!(matches!(request_cap(BIN_OPS[i].polys, BIN_OPS[i].max_len), Some(c) if c <= wire::FRAME_CAP));
        i += 1;
    }
};

fn find(name: &str) -> Option<&'static BinOp> {
    BIN_OPS.iter().find(|o| o.name == name)
}

fn spec(name: &str) -> Option<OpSpec> {
    if name == ECHELON || name == MAT_MUL {
        return Some(OpSpec { min_args: 3, max_args: 3, request_cap: wire::FRAME_CAP });
    }
    if name == CLASSES {
        return Some(OpSpec { min_args: 2, max_args: 2, request_cap: wire::FRAME_CAP });
    }
    // (an overflow, excluded at compile time above, would leave the op
    // without a spec: refused, never admitted with a wrong cap)
    let o = find(name)?;
    let args = o.polys.checked_add(1)?;
    Some(OpSpec { min_args: args, max_args: args, request_cap: request_cap(o.polys, o.max_len)? })
}

fn fail(code: Code, offset: u64, what: &'static str) -> WireError {
    WireError { code, offset, what }
}

/// base + 8 i, the offset of word i of a payload: checked (an overflow is
/// a failed invariant, as the words are in the request).
fn word_at(base: u64, i: usize) -> Result<u64, WireError> {
    u64::try_from(i)
        .ok()
        .and_then(|i| i.checked_mul(8))
        .and_then(|x| base.checked_add(x))
        .ok_or(fail(Code::Internal, 0, "a word offset past u64"))
}

/// One polynomial argument, validated in place (no allocation): 1 to
/// `max` coefficients, each below p, the last nonzero.
fn poly_view(a: wire::Arg<'_>, max: usize, p: u64) -> Result<U64s<'_>, WireError> {
    let v = wire::u641(a)?;
    if v.count == 0 || v.count > max {
        let at = a.offset.checked_add(4).ok_or(fail(Code::Internal, 0, "an offset past u64"))?;
        return Err(fail(Code::Count, at, "a polynomial length out of the op's range"));
    }
    for (i, c) in v.iter().enumerate() {
        if c >= p {
            return Err(fail(Code::Domain, word_at(v.offset, i)?, "a coefficient outside [0, p)"));
        }
    }
    let last = v.count.checked_sub(1).ok_or(fail(Code::Internal, 0, "an empty polynomial past its check"))?;
    if v.get(last) == 0 {
        return Err(fail(Code::Domain, word_at(v.offset, last)?, "a leading coefficient of zero"));
    }
    Ok(v)
}

/// Bytes of the transform tables and buffers for products up to `len`
/// (0: none): 96 N for at most three tables and 32 N for one product's
/// buffers, N the padded length (nmod_ops.rs).
fn tables(len: usize) -> Option<u64> {
    if len == 0 {
        return Some(0);
    }
    u64::try_from(len.checked_next_power_of_two()?).ok()?.checked_mul(128)
}

fn words(n: usize) -> Option<u64> {
    u64::try_from(n).ok()?.checked_mul(8)
}

/// The call's closed-form memory bound at these lengths (S2, S3): the
/// decoded inputs, the computation and the reply.
fn bound(kind: Kind, la: usize, lb: usize) -> Option<u64> {
    let inputs = words(la.checked_add(lb)?)?;
    let (compute, reply) = match kind {
        // the product (at most la + lb - 1 words) and the tables
        Kind::Mul => {
            let lc = la.checked_add(lb)?.checked_sub(1)?;
            (words(lc)?.checked_add(tables(nmod_poly::mul_table_len(la, lb))?)?, wire::ok_u641_len(&[lc])?)
        }
        // the copies and Newton's polynomials, 8 (la + lb + 4 ql), and
        // the tables; q has ql words and r fewer than lb
        Kind::Divrem => {
            // (la >= lb >= 1, admitted)
            let ql = la.checked_add(1)?.checked_sub(lb)?;
            let newton = words(la.checked_add(lb)?.checked_add(ql.checked_mul(4)?)?)?;
            (newton.checked_add(tables(nmod_poly::divrem_table_len(la, lb))?)?, wire::ok_u641_len(&[ql, lb])?)
        }
        // the half-gcd's polynomials (or Euclid's monic result) and the
        // tables, plus 4 KiB (nmod_ops.rs GCD_PEAK); the gcd is at most
        // min(la, lb) words
        Kind::Gcd => {
            let frames = nmod_poly::gcd_frame_bytes(la, lb)?;
            (frames.checked_add(tables(nmod_poly::gcd_table_len(la, lb))?)?.checked_add(4096)?, wire::ok_u641_len(&[la.min(lb)])?)
        }
    };
    inputs.checked_add(compute)?.checked_add(u64::try_from(reply).ok()?)
}

/// The reservation of a call of `op` on polynomials of la and lb
/// coefficients, as admitted (the peak tests' bound): None for an unknown
/// op or an overflow.
pub fn reservation(op: &str, la: usize, lb: usize) -> Option<u64> {
    bound(find(op)?.kind, la, lb)
}

/// The decoded words of a validated view, into a vector of exactly that
/// capacity (inside the call's reservation).
fn decode(v: &U64s) -> Vec<u64> {
    let mut out = Vec::with_capacity(v.count);
    out.extend(v.iter());
    out
}

/// One binary call: the reply bytes (ok or er), never a panic on any
/// input (an interrupt unwinds, as for every entry point).
pub fn call_bin(req: &[u8]) -> Vec<u8> {
    match run(req) {
        Ok(r) => r,
        Err(e) => wire::error_reply(&e),
    }
}

fn run(req: &[u8]) -> Result<Vec<u8>, WireError> {
    run_with(req, wire::FRAME_CAP)
}

/// [`run`] with an explicit frame cap (the tests' boundary at a small cap).
fn run_with(req: &[u8], frame_cap: usize) -> Result<Vec<u8>, WireError> {
    // S1: the frame, allocation-free
    let f = wire::admit_with(req, spec, u64::try_from(usize::MAX).unwrap_or(u64::MAX), frame_cap)?;
    if f.op == ECHELON {
        return echelon(&f);
    }
    if f.op == MAT_MUL {
        return mat_mul(&f);
    }
    if f.op == CLASSES {
        return classes(&f);
    }
    let op = find(f.op).ok_or(fail(Code::Internal, 0, "an admitted op without a row"))?;
    let arg = |i: usize| f.arg(i).ok_or(fail(Code::Internal, 0, "an admitted argument missing"));
    // S2 pass 2: every schema and domain, allocation-free
    let pa = arg(0)?;
    let p = wire::scalar(pa)?;
    if p >= MAX_P || !is_prime(p) {
        // (at p's word: the tag and count come first)
        let at = pa.offset.checked_add(12).ok_or(fail(Code::Internal, 0, "an offset past u64"))?;
        return Err(fail(Code::Domain, at, "p must be a prime below 2^63"));
    }
    let a = poly_view(arg(1)?, op.max_len, p)?;
    let b = poly_view(arg(2)?, op.max_len, p)?;
    let (la, lb) = (a.count, b.count);
    if op.kind == Kind::Divrem && la < lb {
        // (the quotient is 0 and the remainder a: the caller's answer)
        return Err(fail(Code::Domain, arg(1)?.offset, "a dividend shorter than the divisor"));
    }
    // S2/S3: one reservation of the whole call's bound, before any
    // allocation
    let need = bound(op.kind, la, lb).ok_or(fail(Code::Cap, 0, "a memory bound too large"))?;
    let _r = sagebrush_ledger::reserve(op.name, need).map_err(|e| match e {
        sagebrush_ledger::EngineError::Memory(_) => fail(Code::Cap, 0, "the call's memory reservation was refused"),
        sagebrush_ledger::EngineError::Internal(_) => fail(Code::Internal, 0, "the ledger failed an invariant"),
    })?;
    let m = Modulus::new(p);
    let a = decode(&a);
    let b = decode(&b);
    let results: (Vec<u64>, Option<Vec<u64>>) = match op.kind {
        Kind::Mul => {
            let len = nmod_poly::mul_table_len(a.len(), b.len());
            let c = if len == 0 {
                nmod_poly::mul(&a, &b, &m)
            } else {
                let lt = ntt::LocalTables::new(&m, len);
                nmod_poly::mul_in(&a, &b, &m, &lt)
            };
            drop((a, b));
            (c, None)
        }
        Kind::Divrem => {
            let len = nmod_poly::divrem_table_len(a.len(), b.len());
            let (q, r) = if len == 0 {
                nmod_poly::divrem(&a, &b, &m)
            } else {
                let lt = ntt::LocalTables::new(&m, len);
                nmod_poly::divrem_in(&a, &b, &m, &lt)
            };
            drop((a, b));
            (nmod_poly::trim(q), Some(nmod_poly::trim(r)))
        }
        Kind::Gcd => {
            let len = nmod_poly::gcd_table_len(a.len(), b.len());
            let g = if len == 0 {
                nmod_poly::gcd_classical(a, b, &m)
            } else {
                let lt = ntt::LocalTables::new(&m, len);
                nmod_poly::gcd_in(a, b, &m, &lt)
            };
            (g, None)
        }
    };
    // S3: the reply at its exact length, within the reservation's bound
    let (x, y) = (&results.0[..], results.1.as_deref());
    let refs: [&[u64]; 2] = [x, y.unwrap_or(&[])];
    let n = if y.is_some() { 2 } else { 1 };
    let counts = [refs[0].len(), refs[1].len()];
    let len = wire::ok_u641_len(&counts[..n]).ok_or(fail(Code::Internal, 0, "a result too large to frame"))?;
    let mut out = Vec::with_capacity(len);
    wire::write_ok_u641(&mut out, &refs[..n])?;
    Ok(out)
}

// ---------------------------------------------------------------- echelon

/// The frame cap, for the hosts' checks before they assemble a request.
pub const FRAME_CAP: usize = wire::FRAME_CAP;

const ECHELON: &str = "nmod_echelon";

/// The words the echelon's scan, decode and reply handle between two Stop
/// polls (and two Move tallies).
pub const ECH_CHUNK: usize = 4096;

/// The fixed slack of the echelon's reservation: the allocator's rounding
/// and the call's small allocations (the progress phases, the Poll).
const ECH_SLACK: u64 = 4096;

/// `nmod_echelon`'s request length for an r x c matrix: the header (4), the
/// name's length and name (4 + 12), the argument count (4), p (4 + 12 + 8),
/// the matrix (4 + `MAT1` 4 + r 4 + c 4 + `U641` 12 + 8 E) and the flags
/// (4 + 12 + 8): 100 + 8 E.  None on an overflow.
pub fn echelon_request_len(rows: usize, cols: usize) -> Option<usize> {
    rows.checked_mul(cols)?.checked_mul(8)?.checked_add(100)
}

/// `nmod_echelon`'s reply length for k pivots of an r x c matrix: the ok
/// header (10), the pivots (16 + 8 k), the det (24) and, with `want_rows`,
/// the rows (16 + 8 E).  None on an overflow or a length past a u32 field.
pub fn echelon_reply_len(rows: usize, cols: usize, k: usize, want_rows: bool) -> Option<usize> {
    let e = rows.checked_mul(cols)?;
    if want_rows {
        wire::ok_u641_len(&[k, 1, e])
    } else {
        wire::ok_u641_len(&[k, 1])
    }
}

/// The echelon's reservation for an r x c matrix, a conservative sum of
/// what the call allocates, by phase:
/// - the decoded matrix, which is the working matrix (eliminated in place):
///   8 E;
/// - the elimination's accumulators (nmod_mat's `Acc`, 16 c + 8 c) and its
///   row update's partial sums on the u128 route (at most 8 c, one row at a
///   time): 32 c;
/// - the pivots, allocated once at exactly min(r, c) (w min(r, c), w the
///   usize's bytes), and their copy as words for the reply (8 min(r, c):
///   in place where usize is 64 bits, a new vector on wasm32);
/// - the last block's copy of its pivots: at most 32 w;
/// - the reply at min(r, c) pivots;
/// - [`ECH_SLACK`].
///
/// None on an overflow.
pub fn echelon_reservation(rows: usize, cols: usize, want_rows: bool) -> Option<u64> {
    let kappa = rows.min(cols);
    let w = u64::try_from(core::mem::size_of::<usize>()).ok()?;
    let matrix = words(rows.checked_mul(cols)?)?;
    let acc = u64::try_from(cols).ok()?.checked_mul(32)?;
    let pivots = u64::try_from(kappa).ok()?.checked_mul(w.checked_add(8)?)?;
    let block = w.checked_mul(32)?;
    let reply = u64::try_from(echelon_reply_len(rows, cols, kappa, want_rows)?).ok()?;
    matrix.checked_add(acc)?.checked_add(pivots)?.checked_add(block)?.checked_add(reply)?.checked_add(ECH_SLACK)
}

/// Every word of a validated view below p (S4, allocation-free), polled
/// and counted (Move) after each run of [`ECH_CHUNK`] words.
fn echelon_scan(v: &U64s, p: u64) -> Result<(), WireError> {
    let _phase = sagebrush_interrupt::enter("scan");
    let mut i = 0;
    while i < v.count {
        let end = v.count.min(i.saturating_add(ECH_CHUNK));
        for j in i..end {
            if v.get(j) >= p {
                return Err(fail(Code::Domain, word_at(v.offset, j)?, "an entry outside [0, p)"));
            }
        }
        tally(Family::Move, (end - i) as u64);
        sagebrush_interrupt::check_coarse();
        i = end;
    }
    Ok(())
}

/// The decoded words, into a vector of exactly that capacity (inside the
/// reservation), polled and counted after each run.
fn echelon_decode(v: &U64s) -> Vec<u64> {
    let _phase = sagebrush_interrupt::enter("decode");
    let mut out = Vec::with_capacity(v.count);
    let mut i = 0;
    while i < v.count {
        let end = v.count.min(i.saturating_add(ECH_CHUNK));
        out.extend((i..end).map(|j| v.get(j)));
        tally(Family::Move, (end - i) as u64);
        sagebrush_interrupt::check_coarse();
        i = end;
    }
    out
}

fn echelon(f: &wire::Frame) -> Result<Vec<u8>, WireError> {
    let arg = |i: usize| f.arg(i).ok_or(fail(Code::Internal, 0, "an admitted argument missing"));
    // S2: every schema and domain, allocation-free
    let pa = arg(0)?;
    let p = wire::scalar(pa)?;
    if p >= MAX_P || !is_prime(p) {
        let at = pa.offset.checked_add(12).ok_or(fail(Code::Internal, 0, "an offset past u64"))?;
        return Err(fail(Code::Domain, at, "p must be a prime below 2^63"));
    }
    let fa = arg(2)?;
    let flags = wire::scalar(fa)?;
    if flags & !3 != 0 {
        let at = fa.offset.checked_add(12).ok_or(fail(Code::Internal, 0, "an offset past u64"))?;
        return Err(fail(Code::Domain, at, "an unknown flag bit"));
    }
    let (reduced, want_rows) = (flags & 1 != 0, flags & 2 != 0);
    let mat = wire::mat1(arg(1)?, wire::ElemKind::Words, false)?;
    let wire::Elems::Words(v) = mat.elems else {
        return Err(fail(Code::Internal, 0, "a words matrix of another kind"));
    };
    let (rows, cols) = (mat.rows, mat.cols);
    echelon_scan(&v, p)?;
    // S2/S3: one reservation of the whole call's bound, before any
    // allocation, held to the end (released on every exit, unwinding too)
    let need = echelon_reservation(rows, cols, want_rows).ok_or(fail(Code::Cap, 0, "a memory bound too large"))?;
    let _r = sagebrush_ledger::reserve(ECHELON, need).map_err(|e| match e {
        sagebrush_ledger::EngineError::Memory(_) => fail(Code::Cap, 0, "the call's memory reservation was refused"),
        sagebrush_ledger::EngineError::Internal(_) => fail(Code::Internal, 0, "the ledger failed an invariant"),
    })?;
    let d = echelon_decode(&v);
    let mut a = Mat { rows, cols, m: Modulus::new(p), d };
    let (piv, det) = a.echelon(reduced, true);
    let piv: Vec<u64> = piv.into_iter().map(|c| c as u64).collect();
    // S3: the reply at its exact length, within the reservation's bound
    let len = echelon_reply_len(rows, cols, piv.len(), want_rows).ok_or(fail(Code::Internal, 0, "a result too large to frame"))?;
    let _phase = sagebrush_interrupt::enter("reply");
    let mut out = Vec::with_capacity(len);
    let det = [det];
    let results: [&[u64]; 3] = [&piv, &det, &a.d];
    let n = if want_rows { 3 } else { 2 };
    wire::write_ok_u641_with(&mut out, &results[..n], ECH_CHUNK, |k| {
        tally(Family::Move, k as u64);
        sagebrush_interrupt::check_coarse();
    })?;
    Ok(out)
}

// ---------------------------------------------------------------- product

const MAT_MUL: &str = "nmod_mat_mul";

/// The allowance, in words, that `nmod_mat_mul` gives the product's fast
/// route for its workspace beyond the classical product's
/// (sagebrush_arith::nmod_mat::with_fast_product): a fixed constant, so that
/// whether a product takes the fast route depends on its shape and its
/// prime alone, never on the memory free when it runs.  2^24 words (128
/// MiB) admits the fast route's extra words up to about 2600 x 2600 x 2600;
/// a larger product whose plan is fast runs classical.
pub const MAT_MUL_FAST_ALLOWANCE: u64 = 1 << 24;

/// `nmod_mat_mul`'s request length for an r x k by k x c product: the header
/// (4), the name's length and name (4 + 12), the argument count (4), p (4 +
/// 12 + 8) and the two matrices (each 4 + `MAT1` 4 + rows 4 + cols 4 + `U641`
/// 12 + 8 per entry): 104 + 8 (r k + k c).  None on an overflow.
pub fn mat_mul_request_len(r: usize, k: usize, c: usize) -> Option<usize> {
    r.checked_mul(k)?.checked_add(k.checked_mul(c)?)?.checked_mul(8)?.checked_add(104)
}

/// `nmod_mat_mul`'s reply length for an r x c product: the ok header (10) and
/// the entries (16 + 8 r c).  None on an overflow or a length past a u32
/// field.
pub fn mat_mul_reply_len(r: usize, c: usize) -> Option<usize> {
    wire::ok_u641_len(&[r.checked_mul(c)?])
}

/// `nmod_mat_mul`'s reservation for an r x k by k x c product over p: the
/// decoded factors (8 (r k + k c)), the product's peak under
/// [`MAT_MUL_FAST_ALLOWANCE`] (its result included:
/// sagebrush_arith::nmod_mat::product_peak, the decision `Mat::mul` makes),
/// the reply and [`ECH_SLACK`].  None on an overflow.
pub fn mat_mul_reservation(r: usize, k: usize, c: usize, p: u64) -> Option<u64> {
    let inputs = words(r.checked_mul(k)?.checked_add(k.checked_mul(c)?)?)?;
    let (peak, _) = product_peak(r, k, c, &Modulus::new(p), MAT_MUL_FAST_ALLOWANCE)?;
    let reply = u64::try_from(mat_mul_reply_len(r, c)?).ok()?;
    inputs.checked_add(peak.checked_mul(8)?)?.checked_add(reply)?.checked_add(ECH_SLACK)
}

fn mat_mul(f: &wire::Frame) -> Result<Vec<u8>, WireError> {
    let arg = |i: usize| f.arg(i).ok_or(fail(Code::Internal, 0, "an admitted argument missing"));
    // S2: every schema and domain, allocation-free
    let pa = arg(0)?;
    let p = wire::scalar(pa)?;
    if p >= MAX_P || !is_prime(p) {
        let at = pa.offset.checked_add(12).ok_or(fail(Code::Internal, 0, "an offset past u64"))?;
        return Err(fail(Code::Domain, at, "p must be a prime below 2^63"));
    }
    let ma = wire::mat1(arg(1)?, wire::ElemKind::Words, false)?;
    let wire::Elems::Words(va) = ma.elems else {
        return Err(fail(Code::Internal, 0, "a words matrix of another kind"));
    };
    let bb = arg(2)?;
    let mb = wire::mat1(bb, wire::ElemKind::Words, false)?;
    let wire::Elems::Words(vb) = mb.elems else {
        return Err(fail(Code::Internal, 0, "a words matrix of another kind"));
    };
    if ma.cols != mb.rows {
        return Err(fail(Code::Domain, bb.offset, "the factors' inner dimensions differ"));
    }
    let (r, k, c) = (ma.rows, ma.cols, mb.cols);
    echelon_scan(&va, p)?;
    echelon_scan(&vb, p)?;
    // S2/S3: one reservation of the whole call's bound, before any
    // allocation, held to the end (released on every exit, unwinding too)
    let need = mat_mul_reservation(r, k, c, p).ok_or(fail(Code::Cap, 0, "a memory bound too large"))?;
    let _r = sagebrush_ledger::reserve(MAT_MUL, need).map_err(|e| match e {
        sagebrush_ledger::EngineError::Memory(_) => fail(Code::Cap, 0, "the call's memory reservation was refused"),
        sagebrush_ledger::EngineError::Internal(_) => fail(Code::Internal, 0, "the ledger failed an invariant"),
    })?;
    let m = Modulus::new(p);
    let a = Mat { rows: r, cols: k, m, d: echelon_decode(&va) };
    let b = Mat { rows: k, cols: c, m, d: echelon_decode(&vb) };
    let prod = with_fast_product(MAT_MUL_FAST_ALLOWANCE, || {
        let _phase = sagebrush_interrupt::enter("product");
        a.mul(&b)
    });
    drop((a, b));
    // S3: the reply at its exact length, within the reservation's bound
    let len = mat_mul_reply_len(r, c).ok_or(fail(Code::Internal, 0, "a result too large to frame"))?;
    let _phase = sagebrush_interrupt::enter("reply");
    let mut out = Vec::with_capacity(len);
    let results: [&[u64]; 1] = [&prod.d];
    wire::write_ok_u641_with(&mut out, &results, ECH_CHUNK, |n| {
        tally(Family::Move, n as u64);
        sagebrush_interrupt::check_coarse();
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------- classes

const CLASSES: &str = "conjugacy_classes_bin";

/// `conjugacy_classes_bin`'s reply length for c classes of degree n: the
/// representatives (n words each), the lengths and the orders.
pub fn classes_reply_len(n: usize, c: usize) -> Option<usize> {
    wire::ok_u641_len(&[c.checked_mul(n)?, c, c])
}

/// `conjugacy_classes_bin(n, gens)`: n a U641 scalar, 1 <= n < 2^32; gens a
/// U641 of the generators' images on 0 .. n-1, n words each (none for the
/// trivial group).  The classes are the ones conjugacy_class_count (JSON)
/// computed and kept for this group, else computed now (the caller has
/// admitted the enumeration and, by their number, this reply); the cache is
/// emptied.  The reply's three U641 results: each class's least element's
/// images (n words a class), its length and its elements' order, by (order,
/// length, representative).  One ledger reservation of the representatives'
/// words and the reply, before either is made.
fn classes(f: &wire::Frame) -> Result<Vec<u8>, WireError> {
    use sagebrush_group::{Group, Perm};
    let arg = |i: usize| f.arg(i).ok_or(fail(Code::Internal, 0, "an admitted argument missing"));
    let na = arg(0)?;
    let n = wire::scalar(na)?;
    // (points are u32 words in the group engine; the frame cap bounds the request)
    if n == 0 || n > u64::from(u32::MAX) {
        let at = na.offset.checked_add(12).ok_or(fail(Code::Internal, 0, "an offset past u64"))?;
        return Err(fail(Code::Domain, at, "the degree must be at least 1 and a u32"));
    }
    let n = n as usize;
    let ga = arg(1)?;
    let gv = wire::u641(ga)?;
    if gv.count % n != 0 {
        return Err(fail(Code::Domain, ga.offset, "the generators must be n images each"));
    }
    if gv.iter().any(|x| x >= n as u64) {
        return Err(fail(Code::Domain, ga.offset, "an image past the degree"));
    }
    let words: Vec<u32> = gv.iter().map(|x| x as u32).collect();
    let gens = words
        .chunks(n)
        .map(|c| Perm::from_images(c.to_vec()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| fail(Code::Domain, ga.offset, "a generator is not a permutation"))?;
    drop(words);
    let g = Group::new(n, gens.clone()).map_err(|_| fail(Code::Domain, ga.offset, "not a permutation group"))?;
    let cs = crate::group_classes(n, &gens, &g);
    crate::clear_classes();
    drop(g);
    let c = cs.len();
    let len = classes_reply_len(n, c).ok_or(fail(Code::Cap, 0, "a reply too large to frame"))?;
    // the representatives' words and the reply, reserved before either is made
    let need = (c as u64).checked_mul(n as u64).and_then(|w| w.checked_mul(8)).and_then(|b| b.checked_add(len as u64)).ok_or(fail(Code::Cap, 0, "a memory bound too large"))?;
    let _r = sagebrush_ledger::reserve(CLASSES, need).map_err(|e| match e {
        sagebrush_ledger::EngineError::Memory(_) => fail(Code::Cap, 0, "the call's memory reservation was refused"),
        sagebrush_ledger::EngineError::Internal(_) => fail(Code::Internal, 0, "the ledger failed an invariant"),
    })?;
    let mut reps: Vec<u64> = Vec::with_capacity(c * n);
    for k in cs.iter() {
        sagebrush_interrupt::check();
        reps.extend(k.rep.0.iter().map(|&x| x as u64));
    }
    let lengths: Vec<u64> = cs.iter().map(|k| k.length).collect();
    let orders: Vec<u64> = cs.iter().map(|k| k.order).collect();
    drop(cs);
    let mut out = Vec::with_capacity(len);
    wire::write_ok_u641(&mut out, &[&reps, &lengths, &orders])?;
    Ok(out)
}
