//! Products in Z[x] for the `poly_mul` op: Kronecker substitution, then one
//! word product by either of two backends, chosen at admission from the
//! packed sizes alone: the word schoolbook (`mul_words_schoolbook`) when the
//! shorter packed factor has at most SCHOOLBOOK_WORDS words, else the 3-prime
//! NTT with the call's own tables (`ntt::mul_words_local`).  Everything is
//! admitted by closed forms before anything the request sizes is allocated.
//!
//! - **Slot.** For factors of l_a and l_b coefficients below 2^B_a and 2^B_b,
//!   each product coefficient has |c| <= min(l_a, l_b) 2^(B_a + B_b) <
//!   2^(s - 2) with s = B_a + B_b + bl(min(l_a, l_b)) + 2.
//! - **Pack.** Each factor's hex nibbles go straight into two word arrays (its
//!   positive and its negative coefficients) at bit i s: the slots never
//!   overlap.  X = pos - neg by one borrow pass; a negative X is negated and
//!   its sign kept.
//! - **Multiply.** |X| |Y| by the admitted backend: the schoolbook (exactly
//!   w_a w_b multiply-adds, no tables) or `mul_words_local`.
//! - **Unpack** (centered digits).  With Z = sum c_k 2^(k s), |c_k| <
//!   2^(s - 1), sigma Z's sign: from k = 0 with carry 0, t = bits [k s, (k + 1)
//!   s) of |Z| plus the carry; t >= 2^(s - 1) (2^s included) gives the digit
//!   t - 2^s and carry 1, else t and carry 0.  Every integer has exactly one
//!   expansion with digits in [-2^(s - 1), 2^(s - 1)), the procedure computes
//!   it, and sigma c_k is it: so c_k = sigma d_k, the carry past the last
//!   digit is 0 and the bits above L s are zero (asserted: an internal error,
//!   never a wrong answer).  The slot leaves a factor of 2 to spare.
//!
//! The work and the peak are the closed forms of [`admit`], per backend
//! (design: the poly_mul caps note, r2.1 and its r2.2 delta); the tests
//! count the loops against them.

use crate::counted;
use crate::zseries::{bl, scan_with, Admitted, Csv, INTERNAL_PREFIX};
use sagebrush_bigint::ntt::{mul_words_local, mul_words_local_peak, mul_words_local_work};
use std::fmt::Write;

/// The request's bytes.
pub const REQUEST_MAX: u64 = 1 << 24;
/// The transform's points (u64 words), N = next_pow2(w_a + w_b - 1).
pub const N_MAX: u64 = 1 << 19;
/// The product's packed bits, (l_a + l_b - 1) s.
pub const O_MAX: u64 = 1 << 25;
/// Bytes live at the call's peak (the op's row).
pub const PEAK_MAX: u64 = 64 << 20;
/// Word operations: every shape within the caps above needs at most
/// 205,069,830 (the design note's table; checked below).
pub const WORK_MAX: u64 = 1 << 28;

/// The caps one admission checks (the op passes [`CAPS`]; tests pass
/// others to reach each one exactly).
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub request: u64,
    pub n: u64,
    pub o: u64,
    pub peak: u64,
    pub work: u64,
}

pub const CAPS: Caps = Caps { request: REQUEST_MAX, n: N_MAX, o: O_MAX, peak: PEAK_MAX, work: WORK_MAX };

/// A token's hex digits: no product coefficient's bits exceed O_MAX.
pub const TOKEN_DIGITS_MAX: usize = (O_MAX / 4) as usize;

// The closed-form maximum of the work over every shape within the caps (the
// smallest slot is 11: a nonzero factor has a token of at least one hex
// digit, so B >= 4 on each side) is at most WORK_MAX.
const _: () = {
    let n = N_MAX;
    let m = N_MAX + 1;
    let r = REQUEST_MAX;
    let tab = 16 * n + 512;
    let conv = 3 * (n / 2) * 19 + 8 * n + 64;
    let pack = 6 * m + r;
    let emit = O_MAX / 8 + 24 * (O_MAX / 11);
    let w = r + pack + 3 * (tab + conv) + 16 * m + emit;
    assert!(w == 205_069_830 && w <= WORK_MAX);
    // (the schoolbook's work, at most SCHOOLBOOK_WORDS rows of at most M
    // words, is below the NTT term the table counts)
    let sb = SCHOOLBOOK_WORDS * m + m + SCHOOLBOOK_WORDS;
    assert!(sb <= 3 * (tab + conv) + 16 * m);
};

const HOW: &str = "a smaller product per call";

/// The shorter packed factor's words at most which the word product is the
/// schoolbook (`mul_words_schoolbook`), else the NTT.  Measured (examples/
/// zmul_threshold, short factors of 4 to 128 words): at 128 words the
/// schoolbook takes at most 0.45 of the NTT's time natively and 0.38 in
/// wasm32, a margin on both.
pub const SCHOOLBOOK_WORDS: u64 = 128;

/// [`mul_words_schoolbook`]'s word operations: the output's zero fill and
/// exactly w_a w_b multiply-adds (each row's carry pass included in its
/// multiply-adds, one per word), plus one per row for its final carry.
pub const fn schoolbook_work(wa: usize, wb: usize) -> Option<u64> {
    let (a, b) = (wa as u64, wb as u64);
    let rows = if a < b { a } else { b };
    let product = match a.checked_mul(b) {
        Some(x) => x,
        None => return None,
    };
    let fill = match a.checked_add(b) {
        Some(x) => x,
        None => return None,
    };
    match product.checked_add(fill) {
        Some(y) => y.checked_add(rows),
        None => None,
    }
}

/// |x| |y| by rows of the shorter factor, each row's multiply-adds with a
/// running carry in u128, polled every BLOCK columns.  The result has
/// x.len() + y.len() words.
pub fn mul_words_schoolbook(x: &[u64], y: &[u64]) -> Vec<u64> {
    const BLOCK: usize = 1 << 12;
    let (long, short) = if x.len() >= y.len() { (x, y) } else { (y, x) };
    let mut out = vec![0u64; x.len() + y.len()];
    counted::add((x.len() + y.len()) as u64);
    for (j, &w) in short.iter().enumerate() {
        let mut carry: u128 = 0;
        for (c, chunk) in long.chunks(BLOCK).enumerate() {
            sagebrush_interrupt::check_coarse();
            let base = j + c * BLOCK;
            for (i, &v) in chunk.iter().enumerate() {
                let t = out[base + i] as u128 + v as u128 * w as u128 + carry;
                out[base + i] = t as u64;
                carry = t >> 64;
            }
            counted::add(chunk.len() as u64);
        }
        out[j + long.len()] = carry as u64;
        counted::add(1);
    }
    out
}

/// The admitted bounds of a product, or None for the zero polynomial (an
/// empty or all-zero factor), decided by the scans alone.
pub struct Plan {
    pub slot: u64,
    pub wa: usize,
    pub wb: usize,
    /// The word product's backend: schoolbook (the shorter packed factor at
    /// most SCHOOLBOOK_WORDS words) or the NTT.
    pub schoolbook: bool,
    pub terms: usize,
    pub admitted: Admitted,
}

fn over(what: &str, value: u64, max: u64) -> Result<(), String> {
    if value > max {
        return Err(format!("{} = {} is more than {} ({})", what, value, max, HOW));
    }
    Ok(())
}

/// Scan a factor: at most 2^24 tokens (the request bounds them) of at most
/// TOKEN_DIGITS_MAX hex digits.
pub fn scan(text: &str) -> Result<Csv<'_>, String> {
    scan_with(text, REQUEST_MAX as usize, true, TOKEN_DIGITS_MAX)
}

/// The closed forms for a × b, checked against `caps` in checked u64
/// arithmetic, before anything is allocated.  `r` is the request's bytes.
pub fn admit(a: &Csv, b: &Csv, r: u64, caps: &Caps) -> Result<Option<Plan>, String> {
    over("the request's bytes", r, caps.request)?;
    if a.tokens == 0 || b.tokens == 0 || a.all_zero || b.all_zero {
        return Ok(None);
    }
    let ovf = || "the product's size overflows".to_string();
    let (la, lb) = (a.tokens as u64, b.tokens as u64);
    let slot = a.bits().checked_add(b.bits()).and_then(|x| x.checked_add(bl(la.min(lb)) + 2)).ok_or_else(ovf)?;
    let terms = la + lb - 1;
    let o = terms.checked_mul(slot).ok_or_else(ovf)?;
    over("the product's bits (l_a + l_b - 1) s", o, caps.o)?;
    let words = |l: u64| l.checked_mul(slot).map(|x| x.div_ceil(64) + 1);
    let (wa, wb) = (words(la).ok_or_else(ovf)?, words(lb).ok_or_else(ovf)?);
    let m = wa + wb;
    let n = (m - 1).checked_next_power_of_two().ok_or_else(ovf)?;
    over("the transform's points", n, caps.n)?;
    let ws = slot.div_ceil(64);
    // (the reply: per coefficient at most ceil((s - 2) / 4) hex digits, a sign
    // and a comma, and the JSON around them)
    let reply = terms.checked_mul((slot - 2).div_ceil(4) + 2).and_then(|x| x.checked_add(32)).ok_or_else(ovf)?;
    // (the backend, from the packed sizes alone: a short factor's product by
    // rows of word multiply-adds, exactly w_a w_b of them, no tables; else
    // the NTT)
    let schoolbook = wa.min(wb) <= SCHOOLBOOK_WORDS;
    let ntt_work = if schoolbook {
        schoolbook_work(wa as usize, wb as usize).ok_or_else(ovf)?
    } else {
        mul_words_local_work(wa as usize, wb as usize).ok_or_else(ovf)?
    };
    let pack = 6 * m + r;
    let emit = terms.checked_mul(8 * (ws + 1) + 8).ok_or_else(ovf)?;
    let work = [r, pack, ntt_work, emit].iter().try_fold(0u64, |s, &x| s.checked_add(x)).ok_or_else(ovf)?;
    over("the work (word operations)", work, caps.work)?;
    // (live bytes: the request and the packed factors, then the larger of the
    // product's transforms and the reply with one field and its complement;
    // the packing's pos and neg arrays, 16 (w_a + w_b), are below both)
    let ntt_peak = if schoolbook { 8 * m } else { mul_words_local_peak(wa as usize, wb as usize).ok_or_else(ovf)? };
    let emit_peak = reply.checked_add(32 * ws + 64).ok_or_else(ovf)?;
    let sized = (8 * m).checked_add(ntt_peak.max(emit_peak)).ok_or_else(ovf)?;
    let peak = r.checked_add(sized).and_then(|x| x.checked_add((1u64 << 20).max(sized / 16))).ok_or_else(ovf)?;
    over("the memory (bytes)", peak, caps.peak)?;
    Ok(Some(Plan {
        slot,
        wa: wa as usize,
        wb: wb as usize,
        schoolbook,
        terms: terms as usize,
        admitted: Admitted { beta: slot, primes: 0, work, peak, reply },
    }))
}

fn nibble(c: u8) -> u64 {
    match c {
        b'0'..=b'9' => (c - b'0') as u64,
        _ => (c - b'a' + 10) as u64,
    }
}

/// sum c_i 2^(i s) for a scanned factor, as (|X| in `words` words, X < 0).
fn pack(c: &Csv, slot: u64, words: usize) -> (Vec<u64>, bool) {
    let mut pos = vec![0u64; words];
    let mut neg = vec![0u64; words];
    counted::add(2 * words as u64);
    for (i, tok) in c.text.split(',').enumerate() {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        let (dst, digits) = match tok.strip_prefix('-') {
            Some(d) => (&mut neg, d),
            None => (&mut pos, tok),
        };
        counted::add(digits.len() as u64);
        let base = i as u64 * slot;
        for (j, ch) in digits.bytes().rev().enumerate() {
            let v = nibble(ch);
            if v == 0 {
                continue;
            }
            let bit = base + 4 * j as u64;
            let (w, off) = ((bit / 64) as usize, (bit % 64) as u32);
            dst[w] |= v << off;
            if off > 60 {
                dst[w + 1] |= v >> (64 - off);
            }
        }
    }
    // X = pos - neg; a borrow out of the top means X < 0: negate in place
    let mut borrow = 0u64;
    for (k, (x, &y)) in pos.iter_mut().zip(neg.iter()).enumerate() {
        if k & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        let (d, b1) = x.overflowing_sub(y);
        let (d, b2) = d.overflowing_sub(borrow);
        *x = d;
        borrow = (b1 || b2) as u64;
    }
    drop(neg);
    counted::add(words as u64);
    let negative = borrow != 0;
    if negative {
        let mut carry = 1u64;
        for (k, x) in pos.iter_mut().enumerate() {
            if k & 0xfff == 0 {
                sagebrush_interrupt::check_coarse();
            }
            let (s, c) = (!*x).overflowing_add(carry);
            *x = s;
            carry = c as u64;
        }
        counted::add(words as u64);
    }
    (pos, negative)
}

/// Bits [start, start + len) of `z` into `t` (len <= 64 t.len()), zeros past
/// z's end.
fn field(z: &[u64], start: u64, len: u64, t: &mut [u64]) {
    let (q, r) = ((start / 64) as usize, (start % 64) as u32);
    let n = len.div_ceil(64) as usize;
    for (k, o) in t.iter_mut().enumerate() {
        if k >= n {
            *o = 0;
            continue;
        }
        let lo = z.get(q + k).copied().unwrap_or(0);
        let hi = z.get(q + k + 1).copied().unwrap_or(0);
        *o = if r == 0 { lo } else { (lo >> r) | (hi << (64 - r)) };
    }
    let extra = n as u64 * 64 - len;
    if extra > 0 {
        t[n - 1] &= u64::MAX >> extra;
    }
}

/// Append a magnitude's hex (no leading zeros; "0" for zero).
fn hex(out: &mut String, t: &[u64]) {
    match t.iter().rposition(|&w| w != 0) {
        None => out.push('0'),
        Some(top) => {
            let _ = write!(out, "{:x}", t[top]);
            for w in t[..top].iter().rev() {
                let _ = write!(out, "{:016x}", w);
            }
        }
    }
}

/// The `terms` centered digits of |Z| (slot `slot`), times `sign`, written
/// as hex tokens, trailing zero coefficients dropped.  Checks that the carry
/// past the last digit is 0 and nothing is above them.
pub(crate) fn unpack(z: &[u64], negative: bool, terms: usize, slot: u64, out: &mut String) -> Result<(), String> {
    let ws = slot.div_ceil(64) as usize;
    let mut t = vec![0u64; ws + 1];
    let top = slot as u32 % 64;
    let (hw, hb) = (((slot - 1) / 64) as usize, ((slot - 1) % 64) as u32);
    let start = out.len();
    let mut kept = out.len();
    let mut carry = 0u64;
    for k in 0..terms {
        if k & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        field(z, k as u64 * slot, slot, &mut t[..ws]);
        t[ws] = 0;
        // t + carry, into ws + 1 words
        let mut c = carry;
        for w in t.iter_mut() {
            if c == 0 {
                break;
            }
            let (s, o) = w.overflowing_add(c);
            *w = s;
            c = o as u64;
        }
        // t == 2^s (the field all ones plus the carry): digit 0, carry 1
        let full = if top == 0 { t[ws] == 1 } else { t[ws - 1] >> top == 1 };
        let digit_negative;
        if full {
            t.iter_mut().for_each(|w| *w = 0);
            digit_negative = false;
            carry = 1;
        } else if t[hw] >> hb & 1 == 1 {
            // t - 2^s: magnitude 2^s - t, the s-bit two's complement
            let mut c = 1u64;
            for w in t[..ws].iter_mut() {
                let (s, o) = (!*w).overflowing_add(c);
                *w = s;
                c = o as u64;
            }
            if top != 0 {
                t[ws - 1] &= (1u64 << top) - 1;
            }
            digit_negative = true;
            carry = 1;
        } else {
            digit_negative = false;
            carry = 0;
        }
        counted::add(8 * (ws as u64 + 1) + 8);
        if out.len() > start {
            out.push(',');
        }
        let zero = t[..ws].iter().all(|&w| w == 0);
        if !zero && (digit_negative != negative) {
            out.push('-');
        }
        hex(out, &t[..ws]);
        if !zero {
            kept = out.len();
        }
    }
    // (the bits above the last digit, with the carry, must be zero)
    let used = terms as u64 * slot;
    let high_zero = (0..z.len()).all(|i| {
        let lo = i as u64 * 64;
        if lo + 64 <= used {
            true
        } else if lo >= used {
            z[i] == 0
        } else {
            z[i] >> (used - lo) == 0
        }
    });
    if carry != 0 || !high_zero {
        return Err(format!("{}: a Kronecker product left bits above its last coefficient", INTERNAL_PREFIX));
    }
    out.truncate(kept);
    Ok(())
}

/// |a b| packed (Kronecker), and its sign.
pub struct Product {
    z: Vec<u64>,
    negative: bool,
}

/// a × b, admitted by `plan`, as the packed product: the factors packed and
/// multiplied, then dropped.  The caller reserves the reply only after this
/// (the reply and the transforms are never live together: the peak's two
/// phases).
pub fn product(a: &Csv, b: &Csv, plan: &Plan) -> Product {
    let (x, nx) = pack(a, plan.slot, plan.wa);
    let (y, ny) = pack(b, plan.slot, plan.wb);
    let z = if plan.schoolbook { mul_words_schoolbook(&x, &y) } else { mul_words_local(&x, &y) };
    Product { z, negative: nx != ny }
}

/// The product's coefficients written into `out` as hex tokens (the zero
/// polynomial is "").
pub fn emit(p: &Product, plan: &Plan, out: &mut String) -> Result<(), String> {
    unpack(&p.z, p.negative, plan.terms, plan.slot, out)
}

/// [`product`] then [`emit`].
pub fn mul(a: &Csv, b: &Csv, plan: &Plan, out: &mut String) -> Result<(), String> {
    let p = product(a, b, plan);
    emit(&p, plan, out)
}

#[cfg(test)]
mod tests;
