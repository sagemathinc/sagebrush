//! Products in Q[x] for the `qpoly_mul` op: each factor's coefficients are
//! hex tokens `num` or `num/den` (den positive; lowest terms not required),
//! and the reply holds the product's coefficients in lowest terms, in the
//! same form, trailing zeros dropped.  One path for every input: the common
//! denominators, the integer product of zmul, then one reduction per
//! coefficient (design: the QQ poly_mul note, r3 with its r3.1 delta).
//!
//! - **Phase A**, admitted on memory from the scans alone (`admit_a`): each
//!   factor's lcm L = lcm(d_i), built as L <- L (d_i / gcd(L, d_i)) for
//!   every token (1 and repeats included).  bits(L) <= S_d = sum bits(d_i),
//!   so L fits in Lambda = ceil(S_d / 64) + 1 words.  Its work is metered
//!   ([`lcms`]): one [`Meter`] for both factors, limit WORK_MAX - R, never
//!   reset, checked after every charge, so passing the limit is a named
//!   refusal at most [`max_charge`]`(Lambda)` units past it.
//! - **Phase B**, admitted from the actual lcms (`admit_b`) before any of
//!   its allocations, against WORK_MAX minus phase A's count: each numerator
//!   scaled to n_i (L / d_i) and packed as zmul packs (slot s = (B_n,a +
//!   bits L_a) + (B_n,b + bits L_b) + bl(min(l_a, l_b)) + 2); the word
//!   product by zmul's backend choice; D = L_a L_b; then each centered digit
//!   c_k reduced: g = gcd(c_k, D), and c_k / g, D / g by the
//!   quotient-keeping Knuth D (`coprime::divexact_in_place`).
//!
//! Every buffer is allocated once at its admitted capacity and reused per
//! token or coefficient; the peak's rows are the design's ledger (phase A;
//! phase B's scaling, product and reduction), each a checked closed form.

use crate::coprime::{self, divexact_in_place, gcd_in_place, Fault, Meter};
use crate::counted;
use crate::zmul::{self, hex, mul_words_schoolbook, schoolbook_work, unpack_digits, SCHOOLBOOK_WORDS};
use crate::zseries::{bl, preview, INTERNAL_PREFIX};
use sagebrush_bigint::ntt::{mul_words_local, mul_words_local_peak, mul_words_local_work};

/// The reply's bytes (the reply is also within the peak; its own cap makes
/// the exact reply bound testable on its own).
pub const REPLY_MAX: u64 = zmul::PEAK_MAX;

/// The caps of one admission: zmul's, and the reply's.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub int: zmul::Caps,
    pub reply: u64,
}

pub const CAPS: Caps = Caps { int: zmul::CAPS, reply: REPLY_MAX };

const HOW: &str = "a smaller product per call";
const MIB: u64 = 1 << 20;

fn over(what: &str, value: u64, max: u64) -> Result<(), String> {
    if value > max {
        return Err(format!("{} = {} is more than {} ({})", what, value, max, HOW));
    }
    Ok(())
}

fn ovf() -> String {
    "the product's size overflows".to_string()
}

fn internal(what: &str, f: Fault) -> String {
    format!("{}: {} ({:?})", INTERNAL_PREFIX, what, f)
}

/// The largest single charge phase A's meter takes, for factors whose lcms
/// fit in `lam` words: `7 lam + 101`.  Its charge sites (every operand has
/// at most lam limbs, since bits(L) and bits(d_i) are at most S_d):
/// - the word product ([`mul_into`]): the output's fill, `x + y <= lam + 1`
///   words, then per row one charge per column block and one for its
///   carry: at most `lam + 2`;
/// - the quotient-keeping Knuth D: the shifts `nx + ny + 2 <= 2 lam + 2`,
///   per quotient limb `2 ly + 4 <= 2 lam + 4`, the remainder check `nx +
///   2`: at most `2 lam + 8`;
/// - the gcd (`gcd_in_place`): per outer iteration at most `4 lam + 3 lam +
///   101` in all (coprime's module docs), each single charge less;
/// - loads, copies and clears: `n + 1 <= lam + 2`.
///
/// The gcd's term is the largest: `7 lam + 101`.
///
/// Phase B's meter (the scaling, D and the reduction) takes at most
/// `max_charge(max(l_c, l_D))`, with l_c = ceil(s / 64) + 2 and l_D =
/// lambda_a + lambda_b: every operand there has at most that many limbs (a
/// numerator's limbs are at most ceil(s / 64) + 1, since s counts its bits;
/// d_i, L and D at most l_D), and its sites are the same kinds, with the
/// fills, packings and hex output at most `2 max + 2`.
pub const fn max_charge(lam: u64) -> Option<u64> {
    match lam.checked_mul(7) {
        Some(x) => x.checked_add(101),
        None => None,
    }
}

/// A factor's tokens, scanned once without allocating.
#[derive(Clone, Copy, Debug)]
pub struct Factor<'a> {
    pub text: &'a str,
    pub tokens: u64,
    /// every numerator is 0
    pub all_zero: bool,
    /// every |numerator| < 2^num_bits (4 x the most numerator digits)
    pub num_bits: u64,
    /// the most limbs of a numerator, and of a denominator (1 for none)
    pub n_max: u64,
    pub d_max: u64,
    /// sum of bits(d_i)
    pub sd: u64,
    /// sum of the numerators' limbs, and of the denominators'
    pub n_sum: u64,
    pub d_sum: u64,
    /// sum (2 l_d + 7) and sum (l_d - 1)(2 l_d + 4) over the tokens: the
    /// scaling divisions' closed form is lambda a1 - a2 + 8 l
    pub a1: u64,
    pub a2: u64,
    /// the same over the tokens with a nonzero numerator only (qpoly_clear
    /// takes no zero numerator's denominator into its lcm): their count,
    /// denominators' limbs, a1 and a2
    pub nz_tokens: u64,
    pub nz_d_sum: u64,
    pub nz_a1: u64,
    pub nz_a2: u64,
}

impl Factor<'_> {
    /// Lambda: the lcm's words are at most this minus one.
    pub fn lam(&self) -> Option<u64> {
        self.sd.div_ceil(64).checked_add(1)
    }
}

fn canonical(d: &str, zero_ok: bool) -> bool {
    !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && (!d.starts_with('0') || (zero_ok && d == "0"))
}

/// A token's parts: (negative, numerator digits, denominator digits).
pub(crate) fn parts(tok: &str) -> (bool, &str, &str) {
    let (n, d) = match tok.split_once('/') {
        Some((n, d)) => (n, d),
        None => (tok, "1"),
    };
    match n.strip_prefix('-') {
        Some(m) => (true, m, d),
        None => (false, n, d),
    }
}

fn limbs(digits: &str) -> u64 {
    if digits == "0" {
        0
    } else {
        (digits.len() as u64).div_ceil(16)
    }
}

fn nibble(c: u8) -> u64 {
    match c {
        b'0'..=b'9' => (c - b'0') as u64,
        _ => (c - b'a' + 10) as u64,
    }
}

/// Scan a factor: tokens `-?(0|[1-9a-f][0-9a-f]*)(/[1-9a-f][0-9a-f]*)?`
/// ("-0" refused), at most 2^24 of them (the request bounds them), each part
/// at most zmul's TOKEN_DIGITS_MAX digits.  One pass; nothing allocated.
pub fn scan(text: &str) -> Result<Factor<'_>, String> {
    scan_with(text, false)
}

/// [`scan`] for integer tokens only, `-?(0|[1-9a-f][0-9a-f]*)` (zpoly_divrem's
/// grammar, poly_mul's).
pub fn scan_ints(text: &str) -> Result<Factor<'_>, String> {
    scan_with(text, true)
}

fn scan_with(text: &str, ints: bool) -> Result<Factor<'_>, String> {
    let mut f = Factor { text, tokens: 0, all_zero: true, num_bits: 0, n_max: 0, d_max: 0, sd: 0, n_sum: 0, d_sum: 0, a1: 0, a2: 0, nz_tokens: 0, nz_d_sum: 0, nz_a1: 0, nz_a2: 0 };
    if text.is_empty() {
        return Ok(f);
    }
    let bad = |tok: &str| {
        if ints {
            format!("{:?} is not a hex integer (-?(0|[1-9a-f][0-9a-f]*))", preview(tok, 40))
        } else {
            format!("{:?} is not a hex rational (-?(0|[1-9a-f][0-9a-f]*)(/[1-9a-f][0-9a-f]*)?)", preview(tok, 40))
        }
    };
    for (i, tok) in text.split(',').enumerate() {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        if i as u64 >= zmul::REQUEST_MAX {
            return Err(format!("more than {} coefficients", zmul::REQUEST_MAX));
        }
        let (neg, n, d) = parts(tok);
        if (ints && tok.contains('/')) || !canonical(n, true) || (neg && n == "0") || !canonical(d, false) {
            return Err(bad(tok));
        }
        if n.len() > zmul::TOKEN_DIGITS_MAX || d.len() > zmul::TOKEN_DIGITS_MAX {
            return Err(format!("a coefficient of more than {} hex digits", zmul::TOKEN_DIGITS_MAX));
        }
        let (ln, ld) = (limbs(n), limbs(d));
        let bits_d = 4 * (d.len() as u64 - 1) + (8 - (nibble(d.as_bytes()[0]) as u8).leading_zeros() as u64);
        f.tokens += 1;
        f.all_zero &= n == "0";
        f.num_bits = f.num_bits.max(4 * n.len() as u64);
        f.n_max = f.n_max.max(ln);
        f.d_max = f.d_max.max(ld);
        let add = |x: u64, y: Option<u64>| y.and_then(|y| x.checked_add(y)).ok_or_else(ovf);
        f.sd = add(f.sd, Some(bits_d))?;
        f.n_sum = add(f.n_sum, Some(ln))?;
        f.d_sum = add(f.d_sum, Some(ld))?;
        f.a1 = add(f.a1, ld.checked_mul(2).and_then(|x| x.checked_add(7)))?;
        f.a2 = add(f.a2, (ld - 1).checked_mul(2 * ld + 4))?;
        if n != "0" {
            f.nz_tokens += 1;
            f.nz_d_sum = add(f.nz_d_sum, Some(ld))?;
            f.nz_a1 = add(f.nz_a1, ld.checked_mul(2).and_then(|x| x.checked_add(7)))?;
            f.nz_a2 = add(f.nz_a2, (ld - 1).checked_mul(2 * ld + 4))?;
        }
    }
    Ok(f)
}

/// Phase A's admission: the lcms' buffers and scratch, and the work limit.
#[derive(Clone, Copy, Debug)]
pub struct PlanA {
    pub lam_a: u64,
    pub lam_b: u64,
    /// max(lam_a, lam_b)
    pub lam: u64,
    /// the most limbs of a denominator, both factors
    pub d_max: u64,
    /// the row's bytes, and the admitted peak (request and allowance included)
    pub row: u64,
    pub peak: u64,
    /// the meter's limit, WORK_MAX - R
    pub limit: u64,
}

fn allowance(sized: u64) -> u64 {
    MIB.max(sized / 16)
}

fn sum(xs: &[Option<u64>]) -> Option<u64> {
    xs.iter().try_fold(0u64, |s, &x| x.and_then(|x| s.checked_add(x)))
}

/// Phase A's closed forms, from the scans alone, before anything is
/// allocated: None for the zero polynomial (an empty or all-zero factor,
/// answered before any length arithmetic).  The row: L_a and L_b (Lambda_a
/// + 1 and Lambda_b + 1 words), the gcd's two operand slots
/// (`workspace_words(Lambda)`), the quotient d_i / g (d* + 1), Knuth D's
/// dividend and divisor copies (2 d* + 1) and the product's output (Lambda
/// + 1).
pub fn admit_a(a: &Factor, b: &Factor, r: u64, caps: &Caps) -> Result<Option<PlanA>, String> {
    over("the request's bytes", r, caps.int.request)?;
    if a.tokens == 0 || b.tokens == 0 || a.all_zero || b.all_zero {
        return Ok(None);
    }
    let (lam_a, lam_b) = (a.lam().ok_or_else(ovf)?, b.lam().ok_or_else(ovf)?);
    let lam = lam_a.max(lam_b);
    let d = a.d_max.max(b.d_max);
    let words = sum(&[
        lam_a.checked_add(1),
        lam_b.checked_add(1),
        coprime::workspace_words(lam),
        d.checked_add(1),
        d.checked_mul(2).and_then(|x| x.checked_add(1)),
        lam.checked_add(1),
    ])
    .ok_or_else(ovf)?;
    let row = words.checked_mul(8).ok_or_else(ovf)?;
    let peak = r.checked_add(row).and_then(|x| x.checked_add(allowance(row))).ok_or_else(ovf)?;
    over("the memory (bytes)", peak, caps.int.peak)?;
    let limit = caps.int.work.checked_sub(r).ok_or_else(|| format!("the request's bytes = {} leave no work within {} ({})", r, caps.int.work, HOW))?;
    Ok(Some(PlanA { lam_a, lam_b, lam, d_max: d, row, peak, limit }))
}

/// Normalized length of x[..n].
pub(crate) fn norm(x: &[u64], n: usize) -> usize {
    let mut n = n;
    while n > 0 && x[n - 1] == 0 {
        n -= 1;
    }
    n
}

/// A canonical hex magnitude into dst's first limbs (little-endian): its
/// normalized length.  Charges limbs + 1.
pub(crate) fn parse_hex(digits: &str, dst: &mut [u64], m: &mut Meter) -> Result<usize, Fault> {
    let b = digits.as_bytes();
    let n = b.len().div_ceil(16);
    if n > dst.len() {
        return Err(Fault::Invariant);
    }
    m.add(n + 1)?;
    for (k, w) in dst[..n].iter_mut().enumerate() {
        let hi = b.len() - 16 * k;
        let lo = hi.saturating_sub(16);
        *w = b[lo..hi].iter().fold(0u64, |acc, &c| (acc << 4) | nibble(c));
    }
    Ok(norm(dst, n))
}

/// dst[..src.len()] = src.  Charges len + 1.
pub(crate) fn copy(dst: &mut [u64], src: &[u64], m: &mut Meter) -> Result<(), Fault> {
    if src.len() > dst.len() {
        return Err(Fault::Invariant);
    }
    m.add(src.len() + 1)?;
    dst[..src.len()].copy_from_slice(src);
    Ok(())
}

/// Zero the first n words.  Charges n + 1.
fn clear(x: &mut [u64], n: usize, m: &mut Meter) -> Result<(), Fault> {
    m.add(n + 1)?;
    x[..n].iter_mut().for_each(|w| *w = 0);
    Ok(())
}

/// x y into out's first x.len() + y.len() words (the word schoolbook by rows
/// of the shorter factor, each row's columns in blocks of 2^12): the
/// product's normalized length.  Charges the fill, then each block's
/// columns and one per row: exactly `schoolbook_work(x.len(), y.len())`.
pub(crate) fn mul_into(x: &[u64], y: &[u64], out: &mut [u64], m: &mut Meter) -> Result<usize, Fault> {
    const BLOCK: usize = 1 << 12;
    let n = x.len() + y.len();
    if n > out.len() {
        return Err(Fault::Invariant);
    }
    m.add(n)?;
    out[..n].iter_mut().for_each(|w| *w = 0);
    let (long, short) = if x.len() >= y.len() { (x, y) } else { (y, x) };
    for (j, &w) in short.iter().enumerate() {
        let mut carry: u128 = 0;
        for (c, chunk) in long.chunks(BLOCK).enumerate() {
            m.add(chunk.len())?;
            let base = j + c * BLOCK;
            for (i, &v) in chunk.iter().enumerate() {
                let t = out[base + i] as u128 + v as u128 * w as u128 + carry;
                out[base + i] = t as u64;
                carry = t >> 64;
            }
        }
        m.add(1)?;
        out[j + long.len()] = carry as u64;
    }
    Ok(norm(out, n))
}

/// Phase A's buffers, allocated once at the admitted sizes.
struct LcmScratch {
    ws: Vec<u64>,
    q: Vec<u64>,
    kx: Vec<u64>,
    ky: Vec<u64>,
    prod: Vec<u64>,
}

/// The factor's lcm into l (zero, capacity Lambda_f + 1): its length.
/// With `skip_zero`, a token whose numerator is 0 takes no part (qpoly_clear).
fn lcm(f: &Factor, l: &mut [u64], s: &mut LcmScratch, m: &mut Meter, skip_zero: bool) -> Result<usize, Fault> {
    let half = s.ws.len() / 2;
    l[0] = 1;
    let mut nl = 1;
    for tok in f.text.split(',') {
        let (_, num, den) = parts(tok);
        if skip_zero && num == "0" {
            continue;
        }
        let nd = parse_hex(den, &mut s.kx, m)?;
        let room = nl.max(nd) + 1;
        if room > half {
            return Err(Fault::Invariant);
        }
        let (s0, s1) = s.ws.split_at_mut(half);
        copy(s0, &l[..nl], m)?;
        copy(s1, &s.kx[..nd], m)?;
        let (slot, lg) = gcd_in_place(s0, nl, s1, nd, m)?;
        copy(&mut s.ky, if slot { &s1[..lg] } else { &s0[..lg] }, m)?;
        clear(s0, room, m)?;
        clear(s1, room, m)?;
        // q = d / g, then L q (at most Lambda + 1 words: bits(L) + bits(q)
        // <= bits(L q) + 1 <= S_d + 1), copied back into L
        let nq = divexact_in_place(&mut s.kx, nd, &mut s.ky, lg, &mut s.q, m)?;
        let np = mul_into(&l[..nl], &s.q[..nq], &mut s.prod, m)?;
        if np >= l.len() {
            return Err(Fault::Invariant);
        }
        copy(l, &s.prod[..np], m)?;
        nl = np;
    }
    Ok(nl)
}

/// The two lcms, their lengths, and phase A's count.
pub struct Lcms {
    pub la: Vec<u64>,
    pub lb: Vec<u64>,
    pub na: usize,
    pub nb: usize,
    pub used: u64,
}

/// Phase A on the caller's meter (tests read it after a refusal): the
/// buffers of the admitted row, freed on return but for L_a and L_b.
pub fn lcms_metered(a: &Factor, b: &Factor, plan: &PlanA, m: &mut Meter) -> Result<Lcms, Fault> {
    let (lam, d) = (plan.lam as usize, plan.d_max as usize);
    let mut la = vec![0u64; plan.lam_a as usize + 1];
    let mut lb = vec![0u64; plan.lam_b as usize + 1];
    let ws = coprime::workspace_words(plan.lam).ok_or(Fault::Invariant)? as usize;
    let mut s = LcmScratch { ws: vec![0u64; ws], q: vec![0u64; d + 1], kx: vec![0u64; d + 1], ky: vec![0u64; d], prod: vec![0u64; lam + 1] };
    let na = lcm(a, &mut la, &mut s, m, false)?;
    let nb = lcm(b, &mut lb, &mut s, m, false)?;
    Ok(Lcms { la, lb, na, nb, used: m.used() })
}

/// Phase A: one meter for both factors, limit WORK_MAX - R, never reset.
/// Passing the limit is the named refusal; an invariant is internal.
pub fn lcms(a: &Factor, b: &Factor, plan: &PlanA) -> Result<Lcms, String> {
    let mut m = Meter::new(plan.limit);
    lcms_metered(a, b, plan, &mut m).map_err(|f| match f {
        Fault::Overrun => format!("the denominators' lcm needs more than {} word operations (fewer or simpler denominators per call)", plan.limit),
        Fault::Invariant => internal("the lcm", f),
    })
}

pub(crate) fn bits(x: &[u64]) -> u64 {
    match x.last() {
        None => 0,
        Some(&t) => 64 * x.len() as u64 - t.leading_zeros() as u64,
    }
}

/// Phase B's admission.
#[derive(Clone, Copy, Debug)]
pub struct PlanB {
    pub slot: u64,
    pub wa: usize,
    pub wb: usize,
    pub schoolbook: bool,
    pub terms: usize,
    /// a coefficient's words for the reduction (ceil(s / 64) + 2), and
    /// D's (lambda_a + lambda_b; its limbs are at most ceil(beta_D / 64))
    pub lc: u64,
    pub ld: u64,
    pub beta_d: u64,
    /// phase B's closed-form work (the scaling, D, the packing, the
    /// product's backend and the unpacking), and the call's admitted part: R
    /// + phase A's count + that
    pub fixed: u64,
    pub work: u64,
    /// phase B's meter's limit: WORK_MAX - R - phase A's count - the
    /// closed-form parts it doesn't count (the packing, the backend, the
    /// unpacking); it counts the scaling, D and the reduction
    pub limit_b: u64,
    /// the peak over all rows, phase A's included
    pub peak: u64,
    /// the reply's exact bound, `{"ok":"` and `"}` included
    pub reply: u64,
    /// each row's bytes (scaling, product, reduction), for the tests
    pub rows: [u64; 3],
}

/// A factor's scaling units, its lcm of `lam` limbs: per token the two
/// parses, L's copy, the division L / d_i (sum Q(lam, l_d) = lam a1 - a2 +
/// 8 l), the product n_i (L / d_i) (at most lam (l_n + 2) + l_n) and its
/// packing (at most lam + l_n + 1).
fn scale_work(f: &Factor, lam: u64) -> Option<u64> {
    let l = f.tokens;
    let div = lam.checked_mul(f.a1)?.checked_sub(f.a2)?.checked_add(l.checked_mul(8)?)?;
    let per = lam.checked_add(1)?.checked_mul(l)?;
    sum(&[
        f.n_sum.checked_add(l),
        f.d_sum.checked_add(l),
        Some(per),
        Some(div),
        lam.checked_mul(f.n_sum.checked_add(l.checked_mul(2)?)?)?.checked_add(f.n_sum),
        per.checked_add(f.n_sum),
    ])
}

/// Phase B's closed forms, from the actual lcms, before any of its
/// allocations; against WORK_MAX minus R and phase A's count (checked).
/// The reduction's work is not among them: it is metered (as phase A's lcm
/// work is), because the gcd's closed form (coprime's Lame bound) overstates
/// it 124 to 278 times on the measured shapes (the design's r3.1 table):
/// as an admission term it refused ordinary products, such as 201 x 201
/// with 32-bit denominators.
pub fn admit_b(a: &Factor, b: &Factor, l: &Lcms, plan: &PlanA, r: u64, caps: &Caps) -> Result<PlanB, String> {
    let (la, lb) = (a.tokens, b.tokens);
    let (lam_a, lam_b) = (l.na as u64, l.nb as u64);
    let (ba, bb) = (bits(&l.la[..l.na]), bits(&l.lb[..l.nb]));
    let slot = sum(&[a.num_bits.checked_add(ba), b.num_bits.checked_add(bb), Some(bl(la.min(lb)) + 2)]).ok_or_else(ovf)?;
    let terms = la + lb - 1;
    over("the product's bits (l_a + l_b - 1) s", terms.checked_mul(slot).ok_or_else(ovf)?, caps.int.o)?;
    let words = |n: u64| n.checked_mul(slot).map(|x| x.div_ceil(64) + 1);
    let (wa, wb) = (words(la).ok_or_else(ovf)?, words(lb).ok_or_else(ovf)?);
    let m = wa + wb;
    let n = (m - 1).checked_next_power_of_two().ok_or_else(ovf)?;
    over("the transform's points", n, caps.int.n)?;
    let ws = slot.div_ceil(64);
    let beta_d = ba + bb;
    // (the reply: per coefficient a sign, at most ceil((s - 2) / 4) numerator
    // digits, a '/' and at most ceil(beta_D / 4) denominator digits; T - 1
    // commas; `{"ok":"` and `"}`)
    let per = sum(&[Some(2), Some((slot - 2).div_ceil(4)), Some(beta_d.div_ceil(4))]).ok_or_else(ovf)?;
    let reply = terms.checked_mul(per).and_then(|x| x.checked_add(terms - 1 + 9)).ok_or_else(ovf)?;
    over("the reply's bytes", reply, caps.reply)?;
    let schoolbook = wa.min(wb) <= SCHOOLBOOK_WORDS;
    let backend = if schoolbook { schoolbook_work(wa as usize, wb as usize) } else { mul_words_local_work(wa as usize, wb as usize) }.ok_or_else(ovf)?;
    let lc = ws + 2;
    // (the parts the meter doesn't count, then those it does)
    let unmetered = sum(&[Some(4 * m), Some(backend), terms.checked_mul(8 * (ws + 1) + 8)]).ok_or_else(ovf)?;
    let metered = sum(&[scale_work(a, lam_a), scale_work(b, lam_b), schoolbook_work(l.na, l.nb)]).ok_or_else(|| format!("{}: a scaling bound underflows", INTERNAL_PREFIX))?;
    let fixed = unmetered.checked_add(metered).ok_or_else(ovf)?;
    let used = r.checked_add(l.used).ok_or_else(ovf)?;
    let budget = caps.int.work.checked_sub(used).ok_or_else(|| format!("{}: phase A's count passed its limit", INTERNAL_PREFIX))?;
    if fixed > budget {
        over("the work (word operations)", used.saturating_add(fixed), caps.int.work)?;
    }
    let limit_b = budget - unmetered;
    // (the rows, each with L_a and L_b at capacity and D at lambda_a +
    // lambda_b words)
    let ld = lam_a + lam_b;
    let base = sum(&[Some(plan.lam_a + 1), Some(plan.lam_b + 1), Some(ld)]).and_then(|x| x.checked_mul(8)).ok_or_else(ovf)?;
    let (lam, ns, ds) = (lam_a.max(lam_b), a.n_max.max(b.n_max), a.d_max.max(b.d_max));
    let scale = sum(&[lam.checked_mul(3), ns.checked_mul(2), ds.checked_mul(2), Some(3)]).and_then(|x| x.checked_mul(8)).ok_or_else(ovf)?;
    let row_scale = sum(&[Some(base), Some(scale), Some(16 * m)]).ok_or_else(ovf)?;
    let backend_peak = if schoolbook { Some(8 * m) } else { mul_words_local_peak(wa as usize, wb as usize) }.ok_or_else(ovf)?;
    let row_product = sum(&[Some(base), Some(8 * m), Some(backend_peak)]).ok_or_else(ovf)?;
    let hi = lc.max(ld);
    let red = sum(&[
        sum(&[lc.checked_mul(2), Some(ld), hi.checked_mul(2), Some(4)]).and_then(|x| x.checked_mul(8)),
        coprime::workspace_words(hi).and_then(|x| x.checked_mul(8)),
    ])
    .ok_or_else(ovf)?;
    let row_reduce = sum(&[Some(base), Some(8 * m), Some(red), Some(reply)]).ok_or_else(ovf)?;
    let sized = row_scale.max(row_product).max(row_reduce);
    let peak_b = r.checked_add(sized).and_then(|x| x.checked_add(allowance(sized))).ok_or_else(ovf)?;
    over("the memory (bytes)", peak_b, caps.int.peak)?;
    Ok(PlanB {
        slot,
        wa: wa as usize,
        wb: wb as usize,
        schoolbook,
        terms: terms as usize,
        lc,
        ld,
        beta_d,
        fixed,
        work: used + fixed,
        limit_b,
        peak: peak_b.max(plan.peak),
        reply,
        rows: [row_scale, row_product, row_reduce],
    })
}

/// Phase B's scaling buffers, allocated once.
struct ScaleScratch {
    num: Vec<u64>,
    den: Vec<u64>,
    kx: Vec<u64>,
    q: Vec<u64>,
    prod: Vec<u64>,
}

/// dst |= x 2^bit.  Charges len + 1.
fn or_at(dst: &mut [u64], x: &[u64], bit: u64, m: &mut Meter) -> Result<(), Fault> {
    m.add(x.len() + 1)?;
    let (q, r) = ((bit / 64) as usize, (bit % 64) as u32);
    for (k, &w) in x.iter().enumerate() {
        *dst.get_mut(q + k).ok_or(Fault::Invariant)? |= w << r;
        if r > 0 {
            let hi = w >> (64 - r);
            if hi != 0 {
                *dst.get_mut(q + k + 1).ok_or(Fault::Invariant)? |= hi;
            }
        }
    }
    Ok(())
}

/// sum n_i (L / d_i) 2^(i s) for a factor, as (|X| in `words` words, X < 0).
fn pack(f: &Factor, l: &[u64], slot: u64, words: usize, s: &mut ScaleScratch, m: &mut Meter) -> Result<(Vec<u64>, bool), Fault> {
    let mut pos = vec![0u64; words];
    let mut neg = vec![0u64; words];
    counted::add(2 * words as u64);
    for (i, tok) in f.text.split(',').enumerate() {
        let (negative, n, d) = parts(tok);
        if n == "0" {
            continue;
        }
        let nn = parse_hex(n, &mut s.num, m)?;
        let nd = parse_hex(d, &mut s.den, m)?;
        copy(&mut s.kx, l, m)?;
        let nq = divexact_in_place(&mut s.kx, l.len(), &mut s.den, nd, &mut s.q, m)?;
        let np = mul_into(&s.num[..nn], &s.q[..nq], &mut s.prod, m)?;
        or_at(if negative { &mut neg } else { &mut pos }, &s.prod[..np], i as u64 * slot, m)?;
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
    Ok((pos, negative))
}

/// The packed product of the scaled numerators, its sign, D = L_a L_b, and
/// phase B's meter.
pub struct Scaled {
    z: Vec<u64>,
    negative: bool,
    d: Vec<u64>,
    nd: usize,
    pub meter: Meter,
}

/// D, the scaled and packed numerators, and their word product (the
/// scaling buffers and the packed factors are freed before the reduction).
pub fn product(a: &Factor, b: &Factor, l: Lcms, plan: &PlanB) -> Result<Scaled, String> {
    let mut m = Meter::new(plan.limit_b);
    let fault = |f| internal("the scaled product", f);
    let mut d = vec![0u64; plan.ld as usize];
    let nd = mul_into(&l.la[..l.na], &l.lb[..l.nb], &mut d, &mut m).map_err(fault)?;
    let (x, nx, y, ny) = {
        let (lam, ns, ds) = (l.na.max(l.nb), a.n_max.max(b.n_max) as usize, a.d_max.max(b.d_max) as usize);
        let mut s = ScaleScratch { num: vec![0u64; ns], den: vec![0u64; ds], kx: vec![0u64; lam + 1], q: vec![0u64; lam + 1], prod: vec![0u64; lam + ns + 1] };
        let (x, nx) = pack(a, &l.la[..l.na], plan.slot, plan.wa, &mut s, &mut m).map_err(fault)?;
        let (y, ny) = pack(b, &l.lb[..l.nb], plan.slot, plan.wb, &mut s, &mut m).map_err(fault)?;
        (x, nx, y, ny)
    };
    let z = if plan.schoolbook { mul_words_schoolbook(&x, &y) } else { mul_words_local(&x, &y) };
    Ok(Scaled { z, negative: nx != ny, d, nd, meter: m })
}

/// The reduction's buffers, allocated once.
struct ReduceScratch {
    ws: Vec<u64>,
    kx: Vec<u64>,
    ky: Vec<u64>,
    q1: Vec<u64>,
    q2: Vec<u64>,
}

/// c / D in lowest terms, as `[-]num[/den]` hex (c's magnitude nonzero).
fn reduce(c: &[u64], negative: bool, d: &[u64], s: &mut ReduceScratch, out: &mut String, m: &mut Meter) -> Result<(), Fault> {
    let half = s.ws.len() / 2;
    let (nc, nd) = (c.len(), d.len());
    let room = nc.max(nd) + 1;
    if room > half {
        return Err(Fault::Invariant);
    }
    let (s0, s1) = s.ws.split_at_mut(half);
    copy(s0, c, m)?;
    copy(s1, d, m)?;
    let (slot, lg) = gcd_in_place(s0, nc, s1, nd, m)?;
    let g: &[u64] = if slot { &s1[..lg] } else { &s0[..lg] };
    copy(&mut s.kx, c, m)?;
    copy(&mut s.ky, g, m)?;
    let n1 = divexact_in_place(&mut s.kx, nc, &mut s.ky, lg, &mut s.q1, m)?;
    copy(&mut s.kx, d, m)?;
    copy(&mut s.ky, g, m)?;
    let n2 = divexact_in_place(&mut s.kx, nd, &mut s.ky, lg, &mut s.q2, m)?;
    clear(s0, room, m)?;
    clear(s1, room, m)?;
    m.add(n1 + n2 + 2)?;
    if negative {
        out.push('-');
    }
    hex(out, &s.q1[..n1]);
    if !(n2 == 1 && s.q2[0] == 1) {
        out.push('/');
        hex(out, &s.q2[..n2]);
    }
    Ok(())
}

/// The product's coefficients, each reduced, written into `out` as tokens
/// (the zero polynomial is ""); phase B's meter's count is returned.  The
/// reduction is metered: passing the meter's limit is the named refusal
/// (the caller then publishes nothing of `out`).
pub fn emit(p: &mut Scaled, plan: &PlanB, out: &mut String) -> Result<u64, String> {
    let Scaled { z, negative, d, nd, meter } = p;
    let (z, negative, d, nd): (&[u64], bool, &[u64], usize) = (z, *negative, d, *nd);
    let (lc, ld) = (plan.lc as usize, plan.ld as usize);
    let hi = lc.max(ld);
    let ws = coprime::workspace_words(hi as u64).ok_or_else(ovf)? as usize;
    let mut s = ReduceScratch { ws: vec![0u64; ws], kx: vec![0u64; hi + 1], ky: vec![0u64; hi + 1], q1: vec![0u64; lc + 1], q2: vec![0u64; ld + 1] };
    let start = out.len();
    let mut kept = out.len();
    // (what the meter leaves the reduction: passing it is the named refusal)
    let left = plan.limit_b.checked_sub(meter.used()).ok_or_else(|| format!("{}: the scaling passed its bound", INTERNAL_PREFIX))?;
    unpack_digits(z, negative, plan.terms, plan.slot, |t, neg| {
        if out.len() > start {
            out.push(',');
        }
        let nc = norm(t, t.len());
        if nc == 0 {
            out.push('0');
            return Ok(());
        }
        reduce(&t[..nc], neg, &d[..nd], &mut s, out, meter).map_err(|f| match f {
            Fault::Overrun => format!("the coefficients' reduction needs more than {} word operations (fewer or smaller coefficients per call)", left),
            Fault::Invariant => internal("a coefficient's reduction", f),
        })?;
        kept = out.len();
        Ok(())
    })?;
    out.truncate(kept);
    Ok(meter.used())
}

/// The whole call on scanned factors: `{"ok":"..."}`, reserved at its exact
/// bound only after the product (the transforms and the reply are never
/// live together), or the refusal.  `r` is the request's bytes.
pub fn reply(a: &Factor, b: &Factor, r: u64, caps: &Caps) -> Result<String, String> {
    // (an empty or all-zero factor: the zero polynomial, before any length
    // arithmetic)
    let Some(plan_a) = admit_a(a, b, r, caps)? else {
        return Ok("{\"ok\":\"\"}".to_string());
    };
    let l = lcms(a, b, &plan_a)?;
    let plan = admit_b(a, b, &l, &plan_a, r, caps)?;
    let mut p = product(a, b, l, &plan)?;
    sagebrush_interrupt::check_coarse();
    let mut out = String::with_capacity(plan.reply as usize);
    out.push_str("{\"ok\":\"");
    // (a refusal or an error returns without the partial reply; the reply,
    // Z and the scratch are freed on the way out)
    emit(&mut p, &plan, &mut out)?;
    out.push_str("\"}");
    if out.len() as u64 > plan.reply {
        return Err(format!("{}: the reply passed its bound", INTERNAL_PREFIX));
    }
    Ok(out)
}

// ---- qpoly_clear: one factor's denominators cleared ----
//
// d = lcm of the denominators of the tokens with a nonzero numerator, AS
// GIVEN (no reduction: `2/4` contributes 4, `0/5` nothing), and each token's
// integer n_i (d / d_i), one per token, in order, untrimmed.  The scan,
// phase A (the metered lcm) and the scaling are qpoly_mul's; one meter spans
// both phases, never reset; the reply is streamed into one String reserved at
// its exact bound.

/// qpoly_clear's phase A admission: one factor's row (its L, the gcd's two
/// slots, the quotient, Knuth D's dividend and divisor, the product's
/// output), admitted from the scan before anything is allocated.
#[derive(Clone, Copy, Debug)]
pub struct PlanClear {
    pub lam: u64,
    pub d_max: u64,
    pub row: u64,
    pub peak: u64,
    /// the meter's limit, WORK_MAX - R
    pub limit: u64,
}

/// None for the empty factor (the reply `{"ok":{"d":"1","c":""}}`).
pub fn admit_clear(f: &Factor, r: u64, caps: &Caps) -> Result<Option<PlanClear>, String> {
    over("the request's bytes", r, caps.int.request)?;
    if f.tokens == 0 {
        return Ok(None);
    }
    let lam = f.lam().ok_or_else(ovf)?;
    let d = f.d_max;
    let words = sum(&[
        lam.checked_add(1),
        coprime::workspace_words(lam),
        d.checked_add(1),
        d.checked_mul(2).and_then(|x| x.checked_add(1)),
        lam.checked_add(1),
    ])
    .ok_or_else(ovf)?;
    let row = words.checked_mul(8).ok_or_else(ovf)?;
    let peak = r.checked_add(row).and_then(|x| x.checked_add(allowance(row))).ok_or_else(ovf)?;
    over("the memory (bytes)", peak, caps.int.peak)?;
    let limit = caps.int.work.checked_sub(r).ok_or_else(|| format!("the request's bytes = {} leave no work within {} ({})", r, caps.int.work, HOW))?;
    Ok(Some(PlanClear { lam, d_max: d, row, peak, limit }))
}

/// qpoly_clear's scaling units, its lcm of `lam` limbs: per token with a
/// nonzero numerator, the two parses, L's copy, the division L / d_i (sum
/// Q(lam, l_d) = lam a1 - a2 + 8 l over those tokens), the product n_i (L /
/// d_i) (at most lam (l_n + 2) + l_n) and its hex out (at most lam + l_n + 1
/// words, one unit each: scale_work's packing term); per zero token its `0`,
/// one; and L's hex out, lam + 1.
pub fn clear_work(f: &Factor, lam: u64) -> Option<u64> {
    let l = f.nz_tokens;
    let div = lam.checked_mul(f.nz_a1)?.checked_sub(f.nz_a2)?.checked_add(l.checked_mul(8)?)?;
    let per = lam.checked_add(1)?.checked_mul(l)?;
    sum(&[
        f.n_sum.checked_add(l),
        f.nz_d_sum.checked_add(l),
        Some(per),
        Some(div),
        lam.checked_mul(f.n_sum.checked_add(l.checked_mul(2)?)?)?.checked_add(f.n_sum),
        per.checked_add(f.n_sum),
        Some(f.tokens - l),
        lam.checked_add(1),
    ])
}

/// qpoly_clear's reply, exactly: `{"ok":{"d":"` (12 bytes), L's
/// ceil(bits(L) / 4) digits, `","c":"` (7), then per token a sign and at most
/// ceil((B_n + bits(L)) / 4) digits (|n_i (L / d_i)| <= |n_i| L < 2^(B_n +
/// bits(L))), l - 1 commas, and `"}}` (3).  For l >= 1; None on overflow.
pub fn clear_reply_bound(f: &Factor, bits_l: u64) -> Option<u64> {
    let per = f.num_bits.checked_add(bits_l)?.div_ceil(4).checked_add(1)?;
    sum(&[Some(22), Some(bits_l.div_ceil(4)), f.tokens.checked_mul(per), Some(f.tokens - 1)])
}

/// The scaling's buffers for qpoly_clear (qpoly_mul's ScaleScratch).
fn clear_scratch(f: &Factor, nl: usize) -> ScaleScratch {
    let (ns, ds) = (f.n_max as usize, f.d_max as usize);
    ScaleScratch { num: vec![0u64; ns], den: vec![0u64; ds], kx: vec![0u64; nl + 1], q: vec![0u64; nl + 1], prod: vec![0u64; nl + ns + 1] }
}

/// Phase B's admission for qpoly_clear, from the actual lcm: the work
/// against WORK_MAX - R - phase A's count (checked), the reply against its
/// cap, and the peak: R, L at its capacity (Lambda + 1), the scaling's
/// scratch 8 (3 lambda + 2 n* + d* + 3), the reply, and the allowance.
/// Returns (the reply's bound, the peak).
pub fn admit_clear_b(f: &Factor, l: &[u64], plan: &PlanClear, used: u64, r: u64, caps: &Caps) -> Result<(u64, u64), String> {
    let nl = l.len() as u64;
    let work = clear_work(f, nl).ok_or_else(|| format!("{}: a scaling bound underflows", INTERNAL_PREFIX))?;
    let spent = r.checked_add(used).ok_or_else(ovf)?;
    let budget = caps.int.work.checked_sub(spent).ok_or_else(|| format!("{}: phase A's count passed its limit", INTERNAL_PREFIX))?;
    if work > budget {
        over("the work (word operations)", spent.saturating_add(work), caps.int.work)?;
    }
    let reply = clear_reply_bound(f, bits(l)).ok_or_else(ovf)?;
    over("the reply's bytes", reply, caps.reply)?;
    let scratch = sum(&[nl.checked_mul(3), f.n_max.checked_mul(2), Some(f.d_max), Some(3)]).and_then(|x| x.checked_mul(8)).ok_or_else(ovf)?;
    let sized = sum(&[plan.lam.checked_add(1).and_then(|x| x.checked_mul(8)), Some(scratch), Some(reply)]).ok_or_else(ovf)?;
    let peak = r.checked_add(sized).and_then(|x| x.checked_add(allowance(sized))).ok_or_else(ovf)?;
    over("the memory (bytes)", peak, caps.int.peak)?;
    Ok((reply, peak.max(plan.peak)))
}

/// The whole qpoly_clear call on a scanned factor: `{"ok":{"d":...,"c":...}}`
/// or the refusal (no partial reply).  `r` is the request's bytes.
pub fn clear_reply(f: &Factor, r: u64, caps: &Caps) -> Result<String, String> {
    let Some(plan) = admit_clear(f, r, caps)? else {
        return Ok("{\"ok\":{\"d\":\"1\",\"c\":\"\"}}".to_string());
    };
    let mut m = Meter::new(plan.limit);
    clear_metered(f, r, caps, &plan, &mut m).map_err(|e| match e {
        ClearError::Refused(s) => s,
        ClearError::Fault(Fault::Overrun, true) => format!("the denominators' lcm needs more than {} word operations (fewer or simpler denominators per call)", plan.limit),
        ClearError::Fault(f, _) => internal("the cleared denominators", f),
    })
}

/// How a qpoly_clear call stopped: a refusal at phase B's admission, or a
/// fault (in phase A when the flag is set).
pub enum ClearError {
    Refused(String),
    Fault(Fault, bool),
}

/// Phase A of qpoly_clear alone: the lcm, normalized (tests: phase B's
/// admission needs it).
pub fn clear_lcm(f: &Factor, plan: &PlanClear, m: &mut Meter) -> Result<Vec<u64>, Fault> {
    let (lam, d) = (plan.lam as usize, plan.d_max as usize);
    let mut l = vec![0u64; lam + 1];
    let ws = coprime::workspace_words(plan.lam).ok_or(Fault::Invariant)? as usize;
    let mut s = LcmScratch { ws: vec![0u64; ws], q: vec![0u64; d + 1], kx: vec![0u64; d + 1], ky: vec![0u64; d], prod: vec![0u64; lam + 1] };
    let nl = lcm(f, &mut l, &mut s, m, true)?;
    l.truncate(nl);
    Ok(l)
}

/// [`clear_reply`] on the caller's meter (tests read it after a refusal).
pub fn clear_metered(f: &Factor, r: u64, caps: &Caps, plan: &PlanClear, m: &mut Meter) -> Result<String, ClearError> {
    let (lam, d) = (plan.lam as usize, plan.d_max as usize);
    let mut l = vec![0u64; lam + 1];
    let nl = {
        let ws = coprime::workspace_words(plan.lam).ok_or(ClearError::Fault(Fault::Invariant, false))? as usize;
        let mut s = LcmScratch { ws: vec![0u64; ws], q: vec![0u64; d + 1], kx: vec![0u64; d + 1], ky: vec![0u64; d], prod: vec![0u64; lam + 1] };
        lcm(f, &mut l, &mut s, m, true).map_err(|e| ClearError::Fault(e, true))?
    };
    let (bound, _) = admit_clear_b(f, &l[..nl], plan, m.used(), r, caps).map_err(ClearError::Refused)?;
    let fault = |e| ClearError::Fault(e, false);
    let mut out = String::with_capacity(bound as usize);
    out.push_str("{\"ok\":{\"d\":\"");
    m.add(nl + 1).map_err(fault)?;
    hex(&mut out, &l[..nl]);
    out.push_str("\",\"c\":\"");
    let mut s = clear_scratch(f, nl);
    for (i, tok) in f.text.split(',').enumerate() {
        if i > 0 {
            out.push(',');
        }
        let (negative, n, den) = parts(tok);
        if n == "0" {
            m.add(1).map_err(fault)?;
            out.push('0');
            continue;
        }
        let nn = parse_hex(n, &mut s.num, m).map_err(fault)?;
        let nd = parse_hex(den, &mut s.den, m).map_err(fault)?;
        copy(&mut s.kx, &l[..nl], m).map_err(fault)?;
        let nq = divexact_in_place(&mut s.kx, nl, &mut s.den, nd, &mut s.q, m).map_err(fault)?;
        let np = mul_into(&s.num[..nn], &s.q[..nq], &mut s.prod, m).map_err(fault)?;
        m.add(np + 1).map_err(fault)?;
        if negative {
            out.push('-');
        }
        hex(&mut out, &s.prod[..np]);
    }
    out.push_str("\"}}");
    if out.len() as u64 > bound {
        return Err(ClearError::Fault(Fault::Invariant, false));
    }
    Ok(out)
}

// (its helpers use dashu's u64-word API: native targets only)
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
