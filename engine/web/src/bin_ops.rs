//! The binary entry point's ops (`sb_bin_call` here, `call_bin` in Python):
//! SBW1 requests (engine/wire) for GF(p)[x], with coefficients as `U641`
//! words instead of decimal text.
//!
//! - `nmod_poly_mul(p, a, b)` -> [a b];
//! - `nmod_poly_divrem(p, a, b)` -> [q, r], a = q b + r, deg r < deg b;
//! - `nmod_poly_gcd(p, a, b)` -> [the monic gcd];
//! - `factor_mod(p, f)` -> [coefficients, shape]: the monic irreducible
//!   factors' coefficients one after the other, and per factor its length
//!   and multiplicity (sorted by degree, then coefficients).
//!
//! p is a typed scalar (a `U641` of one word), prime, below 2^63
//! (factor_mod: below 2^32).  A polynomial is a `U641` of its coefficients,
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
//! allocate.  factor_mod's computation runs within its own budget
//! (sagebrush_poly's default, as the JSON op's callers get): the
//! reservation covers its input and its reply.
//!
//! A failure is an `er` reply (S6) with a code, the request offset and a
//! fixed text: a refused reservation is `Cap`, a factorization limit `Cap`,
//! a failed invariant `Internal`.

use sagebrush_arith::nmod::{is_prime, Modulus};
use sagebrush_arith::{nmod_poly, ntt};
use sagebrush_wire::{self as wire, Code, OpSpec, U64s, WireError};

use crate::nmod_ops::{DIV_MAX_LEN, GCD_MAX_LEN, MUL_MAX_LEN};

/// factor_mod's longest polynomial (its time and memory are its budget's).
pub const FACTOR_MAX_LEN: usize = 1 << 16;

/// The largest request of an op of `polys` polynomials of at most `len`
/// coefficients: the header, a 32-byte name, the counts and lengths, the
/// scalar p and the polynomials.
const fn request_cap(polys: usize, len: usize) -> usize {
    let frame = 4 + 4 + wire::OP_NAME_MAX + 4 + 4 * (polys + 1);
    let p = 12 + 8;
    let poly = match len.checked_mul(8) {
        Some(x) => x + 12,
        None => panic!("overflow"),
    };
    match poly.checked_mul(polys) {
        Some(x) => frame + p + x,
        None => panic!("overflow"),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Mul,
    Divrem,
    Gcd,
    Factor,
}

struct BinOp {
    name: &'static str,
    kind: Kind,
    polys: usize,
    max_len: usize,
    /// The largest p (exclusive).
    max_p: u64,
}

static BIN_OPS: [BinOp; 4] = [
    BinOp { name: "nmod_poly_mul", kind: Kind::Mul, polys: 2, max_len: MUL_MAX_LEN, max_p: 1 << 63 },
    BinOp { name: "nmod_poly_divrem", kind: Kind::Divrem, polys: 2, max_len: DIV_MAX_LEN, max_p: 1 << 63 },
    BinOp { name: "nmod_poly_gcd", kind: Kind::Gcd, polys: 2, max_len: GCD_MAX_LEN, max_p: 1 << 63 },
    BinOp { name: "factor_mod", kind: Kind::Factor, polys: 1, max_len: FACTOR_MAX_LEN, max_p: 1 << 32 },
];

// every op's request cap is below the frame cap (S1)
const _: () = {
    let mut i = 0;
    while i < BIN_OPS.len() {
        assert!(request_cap(BIN_OPS[i].polys, BIN_OPS[i].max_len) <= wire::FRAME_CAP);
        i += 1;
    }
};

fn find(name: &str) -> Option<&'static BinOp> {
    BIN_OPS.iter().find(|o| o.name == name)
}

fn spec(name: &str) -> Option<OpSpec> {
    find(name).map(|o| OpSpec { min_args: 1 + o.polys, max_args: 1 + o.polys, request_cap: request_cap(o.polys, o.max_len) })
}

fn fail(code: Code, offset: u64, what: &'static str) -> WireError {
    WireError { code, offset, what }
}

/// One polynomial argument, validated in place (no allocation): 1 to
/// `max` coefficients, each below p, the last nonzero.
fn poly_view(a: wire::Arg<'_>, max: usize, p: u64) -> Result<U64s<'_>, WireError> {
    let v = wire::u641(a)?;
    if v.count == 0 || v.count > max {
        return Err(fail(Code::Count, a.offset + 4, "a polynomial length out of the op's range"));
    }
    for (i, c) in v.iter().enumerate() {
        if c >= p {
            return Err(fail(Code::Domain, v.offset + 8 * i as u64, "a coefficient outside [0, p)"));
        }
    }
    if v.get(v.count - 1) == 0 {
        return Err(fail(Code::Domain, v.offset + 8 * (v.count as u64 - 1), "a leading coefficient of zero"));
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
            let lc = la + lb - 1;
            (words(lc)?.checked_add(tables(nmod_poly::mul_table_len(la, lb))?)?, wire::ok_u641_len(&[lc])?)
        }
        // the copies and Newton's polynomials, 8 (la + lb + 4 ql), and
        // the tables; q has ql words and r fewer than lb
        Kind::Divrem => {
            let ql = (la + 1).saturating_sub(lb);
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
        // the computation is the budget's; its answer, at most la - 1
        // factors of total length at most 2 (la - 1), 32 bytes of header
        // each (a vector and a multiplicity), lives on with the results,
        // two words of shape per factor
        Kind::Factor => (words(la.checked_mul(10)?)?, wire::ok_u641_len(&[2 * la, 2 * la])?),
    };
    inputs.checked_add(compute)?.checked_add(u64::try_from(reply).ok()?)
}

/// The reservation of a call of `op` on polynomials of la and lb
/// coefficients (lb = 0 for factor_mod), as admitted (the peak tests'
/// bound): None for an unknown op or an overflow.
pub fn reservation(op: &str, la: usize, lb: usize) -> Option<u64> {
    bound(find(op)?.kind, la, lb)
}

thread_local! {
    static FACTOR_PEAK: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The peak of the last factor_mod call's own budget on this thread, in
/// bytes (its reservations: the tests' bound beside [`reservation`]).
pub fn last_factor_budget_peak() -> u64 {
    FACTOR_PEAK.with(|c| c.get())
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
    // S1: the frame, allocation-free
    let f = wire::admit(req, spec)?;
    let op = find(f.op).ok_or(fail(Code::Internal, 0, "an admitted op without a row"))?;
    let arg = |i: usize| f.arg(i).ok_or(fail(Code::Internal, 0, "an admitted argument missing"));
    // S2 pass 2: every schema and domain, allocation-free
    let pa = arg(0)?;
    let p = wire::scalar(pa)?;
    if p >= op.max_p || !is_prime(p) {
        return Err(fail(
            Code::Domain,
            pa.offset + 12,
            if op.max_p == 1 << 32 { "p must be a prime below 2^32" } else { "p must be a prime below 2^63" },
        ));
    }
    let a = poly_view(arg(1)?, op.max_len, p)?;
    let b = if op.polys == 2 { Some(poly_view(arg(2)?, op.max_len, p)?) } else { None };
    let (la, lb) = (a.count, b.map_or(0, |b| b.count));
    if op.kind == Kind::Divrem && la < lb {
        // (the quotient is 0 and the remainder a: the caller's answer)
        return Err(fail(Code::Domain, a.offset - 12, "a dividend shorter than the divisor"));
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
    let b = b.map(|b| decode(&b));
    let results: (Vec<u64>, Option<Vec<u64>>) = match (op.kind, b) {
        (Kind::Mul, Some(b)) => {
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
        (Kind::Divrem, Some(b)) => {
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
        (Kind::Gcd, Some(b)) => {
            let len = nmod_poly::gcd_table_len(a.len(), b.len());
            let g = if len == 0 {
                nmod_poly::gcd_classical(a, b, &m)
            } else {
                let lt = ntt::LocalTables::new(&m, len);
                nmod_poly::gcd_in(a, b, &m, &lt)
            };
            (g, None)
        }
        (Kind::Factor, None) => {
            let budget = sagebrush_poly::Budget::default();
            let fs = sagebrush_poly::try_factor_mod_words(&a, p, &budget);
            FACTOR_PEAK.with(|c| c.set(budget.peak()));
            let fs = fs.map_err(|e| {
                if e.kind == sagebrush_poly::Kind::Internal {
                    fail(Code::Internal, 0, "factor_mod failed an invariant")
                } else {
                    fail(Code::Cap, 0, "factor_mod reached a resource limit")
                }
            })?;
            drop(a);
            let total = fs.iter().map(|(g, _)| g.len()).sum::<usize>();
            if total > 2 * la || 2 * fs.len() > 2 * la {
                return Err(fail(Code::Internal, 0, "factor_mod's factors exceed their bound"));
            }
            let mut coeffs = Vec::with_capacity(total);
            let mut shape = Vec::with_capacity(2 * fs.len());
            for (g, e) in &fs {
                coeffs.extend_from_slice(g);
                shape.push(u64::try_from(g.len()).unwrap_or(u64::MAX));
                shape.push(u64::from(*e));
            }
            drop(fs);
            (coeffs, Some(shape))
        }
        _ => return Err(fail(Code::Internal, 0, "an op without its arguments")),
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

#[cfg(test)]
mod tests;
