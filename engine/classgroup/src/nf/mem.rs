//! The memory of orders and of Round 2, reserved before it is allocated
//! (the systematic review's A16-F2; the ENGINE ruling of Nov 28 2026):
//! - an order holds one reservation ([`Held`]), made with it and released
//!   with it: up front the parts whose size is known exactly (the vectors'
//!   headers), then each multiplication-table entry as it is measured;
//! - each piece of work (a row of table products, an inverse, a determinant,
//!   a Round 2 step) first takes a short-lived scratch reservation sized by a
//!   rigorous bound from its operands' measured sizes, released when the
//!   work ends.
//! A BigInt of b bits is bounded by its header and, past the two words held
//! inline, its buffer's compact capacity ([`big`]).

use super::factor::FactorError;
use sagebrush_bigint::{BigInt, BigRational};
use sagebrush_ledger::Reservation;

pub const WHAT: &str = "number field order";
/// Reservations grow geometrically, not by each entry: by what is needed,
/// or by as much as is reserved, at most this much more.
const CHUNK: u64 = 1 << 20;

/// The bytes of one BigInt of at most `bits` bits.
pub fn big(bits: u64) -> u64 {
    std::mem::size_of::<BigInt>() as u64 + heap(bits)
}

/// The heap of one BigInt of at most `bits` bits: none within dashu's two
/// inline machine words; past them, a buffer dashu keeps compact, at most
/// w + w/4 + 4 words for w words of value (its Buffer::max_compact_capacity,
/// which every stored value meets, and every new buffer's default capacity
/// is below), w counted in 64-bit words, which bounds wasm32's 32-bit ones
/// too.  num-bigint, the comparison backend, keeps every nonzero value on
/// the heap, in a vector whose capacity is bounded by twice its length.
fn heap(bits: u64) -> u64 {
    let w = bits.div_ceil(64);
    if sagebrush_bigint::BACKEND == "dashu" {
        if bits <= 2 * usize::BITS as u64 { 0 } else { 8 * (w + w / 4 + 4) }
    } else if bits == 0 {
        0
    } else {
        16 * w + 64
    }
}

/// The bytes of one BigRational of numerator and denominator of at most
/// `num` and `den` bits.
pub fn rat(num: u64, den: u64) -> u64 {
    std::mem::size_of::<BigRational>() as u64 + heap(num) + heap(den)
}

/// The bytes of a Vec of `len` items of `item` bytes each (its header and
/// buffer; the items' own heaps are the caller's).
pub fn vec(len: u64, item: u64) -> u64 {
    std::mem::size_of::<Vec<u8>>() as u64 + len * item
}

pub fn bits(x: &BigInt) -> u64 {
    x.bits()
}

/// The largest bit length in `xs` (0 for none).
pub fn max_bits<'a>(xs: impl IntoIterator<Item = &'a BigInt>) -> u64 {
    xs.into_iter().map(|x| x.bits()).max().unwrap_or(0)
}

/// ceil(log2(n)), 0 for n <= 1.
pub fn lg(n: usize) -> u64 {
    if n <= 1 { 0 } else { (usize::BITS - (n - 1).leading_zeros()) as u64 }
}

/// Bits bounding any minor of an n x n integer matrix of entries of at most
/// `b` bits (Hadamard: |minor| <= (sqrt(n) 2^b)^n).
pub fn hadamard(n: usize, b: u64) -> u64 {
    n as u64 * (b + lg(n).div_ceil(2)) + 1
}

/// The measured bytes of a vector of BigInts: its buffer and each entry's heap.
pub fn bigs(xs: &[BigInt]) -> u64 {
    vec(xs.len() as u64, std::mem::size_of::<BigInt>() as u64) + xs.iter().map(|x| heap(x.bits())).sum::<u64>()
}

/// The measured bytes of a matrix of BigInts (its rows and their entries).
pub fn zmat(m: &[Vec<BigInt>]) -> u64 {
    vec(m.len() as u64, std::mem::size_of::<Vec<BigInt>>() as u64) + m.iter().map(|r| bigs(r)).sum::<u64>()
}

/// The measured bytes of a vector of BigRationals.
pub fn rats(xs: &[BigRational]) -> u64 {
    vec(xs.len() as u64, std::mem::size_of::<BigRational>() as u64) + xs.iter().map(|x| heap(x.numer().bits()) + heap(x.denom().bits())).sum::<u64>()
}

/// A scratch reservation of `bytes`, for one piece of work: Ok, or the typed
/// refusal.
pub fn scratch(bytes: u64) -> Result<Reservation, FactorError> {
    sagebrush_ledger::reserve(WHAT, bytes).map_err(FactorError::from)
}

/// An order's reservation: what it has charged, grown in chunks.
pub struct Held {
    r: Reservation,
    used: u64,
}

impl Held {
    pub fn new(bytes: u64) -> Result<Held, FactorError> {
        Ok(Held { r: sagebrush_ledger::reserve(WHAT, bytes)?, used: bytes })
    }

    /// Charge `bytes` more (before they are allocated, under [`Held::scope`]).
    pub fn take(&mut self, bytes: u64) -> Result<(), FactorError> {
        let need = self.used + bytes;
        let have = self.r.amount();
        if need > have {
            self.r.grow(WHAT, (need - have).max(have.min(CHUNK)))?;
        }
        self.used = need;
        Ok(())
    }

    pub fn scope(&self) -> sagebrush_ledger::Scope {
        self.r.scope()
    }

    pub fn charged(&self) -> u64 {
        self.used
    }
}

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Held({} bytes)", self.used)
    }
}
