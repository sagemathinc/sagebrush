//! Per-coefficient maps of polynomials over Q, for the `qpoly_scale`,
//! `qpoly_derivative` and `qpoly_integral` ops (design: the scale note r1):
//! one path, three op rows.  `a` is the polynomial's tokens (`[-]num[/den]`
//! in hex, constant first), `b` one token:
//! - **scale** (`b` = s = p/q): each coefficient a_n/a_d becomes
//!   (a_n/g1)(p/g2) / ((a_d/g2)(q/g1)), g1 = gcd(a_n, q), g2 = gcd(p, a_d):
//!   in lowest terms when a's tokens and s are (no third gcd).  A gcd is
//!   skipped when one of its operands is 1; s = 0 gives the zero polynomial,
//!   s = 1 and s = -1 copy the tokens (the sign flipped for -1).
//! - **derivative** (`b` = k, a hex integer): the coefficient of x^j is
//!   a_(j+k) F_j with F_j = (j+k)!/j!, carried as F_0 = k! and F_(j+1) =
//!   F_j (j+k+1)/(j+1) (exact), reduced by g = gcd(F_j, a_d).  k > deg gives
//!   the zero polynomial before any arithmetic; k = 0 copies the tokens.
//! - **integral** (`b` = the constant term): the coefficient of x^(i+1) is
//!   a_i/(i+1), reduced by g = gcd(a_n, i+1), a word.
//! - **sum and difference** (`qpoly_add`, `qpoly_sub`; `b` a polynomial, the
//!   add note r1): for x = a_n/a_d and y = +-b_n/b_d, with g = gcd(a_d, b_d),
//!   t = a_n (b_d/g) +- b_n (a_d/g) and h = gcd(t, g), x +- y = (t/h) /
//!   ((a_d/g)(b_d/h)), in lowest terms when x and y are (Knuth 4.5.1).  g is
//!   a_d itself when the denominators are equal (a charged compare) and 1
//!   when either is 1; h is 1 when g is.  Past the shorter operand each
//!   coefficient is copied (b's with its sign flipped for the difference).
//!   Cancellation can zero the top coefficients: the arenas keep them, and
//!   the reply ([`trim`], run once) stops at the last nonzero one.
//!
//! Tokens not in lowest terms give the right values, possibly not in lowest
//! terms (the Python side sends Fractions and ints, which are).
//!
//! The (M) pattern, as pdivrem's: admission on closed forms only (the
//! request, the fixed rows, the reply's bound, in checked u64); one work
//! [`Meter`] for the whole call (limit WORK_MAX - R, never reset, every unit
//! charged before the work it counts); every growable buffer on the word
//! ledger ([`Words`]); the reply reserved exactly after the compute, while
//! the arenas are held, and written without allocating.

use crate::coprime::{gcd_unbalanced, Meter};
use crate::ledger::{walk_charge, Arena, Buf, Coef, DivFault, Words};
use crate::pdivrem::{norm_len, token_bytes, OVERHEAD_WORDS};
use crate::qpoly::{self, mul_into, parts, Factor};
use crate::zmul::hex;
use crate::zseries::INTERNAL_PREFIX;

const HOW: &str = "a smaller polynomial per call";

/// The reply's fixed bytes: `{"ok":"` and `"}`.
pub const FIXED_BYTES: u64 = 9;

/// Which map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Scale,
    Derivative,
    Integral,
    Add,
    Sub,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Scale => "scaling",
            Kind::Derivative => "derivative",
            Kind::Integral => "integral",
            Kind::Add => "sum",
            Kind::Sub => "difference",
        }
    }
}

/// The number of hex digits of a value below 2^bits: ceil(bits / 4).
const fn hex_digits_of_bits(bits: u64) -> u64 {
    bits.div_ceil(4)
}

/// The bit length of v (0 for 0).
const fn bit_length(v: u64) -> u64 {
    64 - v.leading_zeros() as u64
}

/// The hex digits of F_j = (j+1)...(j+k) for j + k <= n: at most
/// ceil(k bitlen(n) / 4), since F_j <= n^k < 2^(k bitlen(n)).  Checked.
pub const fn falling_digits(k: u64, n: u64) -> Option<u64> {
    match k.checked_mul(bit_length(n)) {
        Some(b) => Some(hex_digits_of_bits(b)),
        None => None,
    }
}

/// The byte end of the first `n` tokens of `text` (their text with the
/// commas between them).
fn prefix_end(text: &str, n: u64) -> usize {
    if n == 0 {
        return 0;
    }
    text.match_indices(',').nth(n as usize - 1).map_or(text.len(), |(i, _)| i)
}

/// The reply's closed-form bound in bytes, from the tokens' text alone,
/// before anything is allocated (checked; None on overflow):
/// - scale: each output token is at most its input token's bytes plus s's
///   digits (num and den) plus 2 (a sign and a slash it may gain): FIXED +
///   prefix + na (digits(p) + digits(q) + 2);
/// - derivative: na - k output tokens, each at most its input's bytes plus
///   F_j's digits ([`falling_digits`]`(k, na - 1)`): FIXED + prefix +
///   (na - k) F;
/// - integral: the constant's token and a comma, then na tokens, each at
///   most its input's bytes plus the digits of i + 1 <= na and a slash:
///   FIXED + len(b) + 1 + prefix + na (hexdigits(na) + 1).
pub fn reply_bound(kind: Kind, prefix: u64, na: u64, b: &str, k: u64) -> Option<u64> {
    let (_, bn, bd) = parts(b);
    let body = match kind {
        Kind::Scale => {
            let per = (bn.len() as u64).checked_add(bd.len() as u64)?.checked_add(2)?;
            prefix.checked_add(na.checked_mul(per)?)?
        }
        Kind::Derivative => {
            let f = falling_digits(k, na.checked_sub(1)?)?;
            prefix.checked_add(na.checked_sub(k)?.checked_mul(f)?)?
        }
        Kind::Integral => {
            let per = hex_digits_of_bits(bit_length(na)).checked_add(1)?;
            (b.len() as u64).checked_add(1)?.checked_add(prefix)?.checked_add(na.checked_mul(per)?)?
        }
        // (their bound is [`pair_bound`]'s, from both operands' tokens)
        Kind::Add | Kind::Sub => return None,
    };
    FIXED_BYTES.checked_add(body)
}

/// The sum's and difference's reply bound in bytes, from the two operands'
/// first `na` and `nb` tokens (checked; None on overflow).  For a pair of
/// tokens with numerator and denominator digits (n_a, d_a) and (n_b, d_b) (a
/// missing denominator counted as its digit "1"): the numerator has at most
/// max(n_a + d_b, n_b + d_a) + 1 digits, the denominator d_a + d_b, plus a
/// sign and a slash.  Past the shorter operand a token keeps its bytes, plus
/// a sign.  Then the commas and the fixed bytes.  One pass, nothing
/// allocated.
pub fn pair_bound(a: &str, na: u64, b: &str, nb: u64) -> Option<u64> {
    let (mut ia, mut ib) = (a.split(',').take(na as usize), b.split(',').take(nb as usize));
    let mut total = FIXED_BYTES;
    let mut i = 0u64;
    loop {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        let per = match (ia.next(), ib.next()) {
            (None, None) => break,
            (Some(t), None) | (None, Some(t)) => (t.len() as u64).checked_add(1)?,
            (Some(x), Some(y)) => {
                let ((_, xn, xd), (_, yn, yd)) = (parts(x), parts(y));
                let (xn, xd, yn, yd) = (xn.len() as u64, xd.len() as u64, yn.len() as u64, yd.len() as u64);
                let num = xn.checked_add(yd)?.max(yn.checked_add(xd)?).checked_add(1)?;
                num.checked_add(xd)?.checked_add(yd)?.checked_add(2)?
            }
        };
        total = total.checked_add(per)?;
        i += 1;
    }
    total.checked_add(i.saturating_sub(1))
}

/// The fixed rows, in words: the request (ceil(R / 8)) and the call's owners
/// (the meter, the ledger, the arenas' and the scratch's headers).
pub fn fixed_rows(r: u64) -> Option<u64> {
    r.div_ceil(8).checked_add(OVERHEAD_WORDS)
}

/// The integer scratch, ledger-owned and grown on demand.
struct Ints<'l> {
    x: Buf<'l>,
    y: Buf<'l>,
    q: Buf<'l>,
    p: Buf<'l>,
    ws: Buf<'l>,
}

impl<'l> Ints<'l> {
    fn new(led: &'l Words, m: &mut Meter) -> Result<Ints<'l>, DivFault> {
        let tag = "scratch";
        Ok(Ints { x: Buf::new(led, 0, tag, m)?, y: Buf::new(led, 0, tag, m)?, q: Buf::new(led, 0, tag, m)?, p: Buf::new(led, 0, tag, m)?, ws: Buf::new(led, 0, tag, m)? })
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
        self.x.v[nx] = 0;
        self.y.v[..ny].copy_from_slice(y);
        Ok(crate::coprime::divexact_in_place(&mut self.x.v, nx, &mut self.y.v, ny, &mut self.q.v, m)?)
    }
    /// gcd(x, y) of two magnitudes (not both zero) into g, by
    /// [`gcd_unbalanced`] on copies (the remainder step normalizes its
    /// divisor in place).
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
        let (slot, lg) = gcd_unbalanced(s0, x.len(), s1, y.len(), m)?;
        let r: &[u64] = if slot { &s1[..lg] } else { &s0[..lg] };
        g.set(r, false, m)
    }
}

/// c *= w (a word), in place.  Charges the growth and len + 1.
fn mul_word(c: &mut Coef, w: u64, m: &mut Meter) -> Result<(), DivFault> {
    let n = c.len;
    c.buf.grow(n + 1, n, m)?;
    m.add(n + 1)?;
    let mut carry = 0u128;
    for x in &mut c.buf.v[..n] {
        let t = u128::from(*x) * u128::from(w) + carry;
        *x = t as u64;
        carry = t >> 64;
    }
    c.buf.v[n] = carry as u64;
    c.len = crate::qpoly::norm(&c.buf.v, n + 1);
    if c.len == 0 {
        c.neg = false;
    }
    Ok(())
}

/// The small divisors here (j + 1, i + 1 and their gcds, at most the token
/// count, below 2^24): each limb is divided as two 32-bit halves, so every
/// step is a native u64 division (r < w < 2^32 keeps (r << 32) | half below
/// 2^64), never a u128 one (a library call on wasm32).
const SMALL: u64 = 1 << 32;

/// c mod w (0 < w < 2^32).  Charges 2 len + 1.
fn rem_word(c: &Coef, w: u64, m: &mut Meter) -> Result<u64, DivFault> {
    if w == 0 || w >= SMALL {
        return Err(DivFault::Invariant);
    }
    m.add(2 * c.len + 1)?;
    let mut r = 0u64;
    for &x in c.buf.v[..c.len].iter().rev() {
        r = ((r << 32) | (x >> 32)) % w;
        r = ((r << 32) | (x & 0xffff_ffff)) % w;
    }
    Ok(r)
}

/// c /= w (0 < w < 2^32, dividing c), in place; a remainder is an
/// invariant failure.  Charges 2 len + 1.
fn div_word_exact(c: &mut Coef, w: u64, m: &mut Meter) -> Result<(), DivFault> {
    if w == 0 || w >= SMALL {
        return Err(DivFault::Invariant);
    }
    m.add(2 * c.len + 1)?;
    let mut r = 0u64;
    for x in c.buf.v[..c.len].iter_mut().rev() {
        let hi = (r << 32) | (*x >> 32);
        let (qh, rh) = (hi / w, hi % w);
        let lo = (rh << 32) | (*x & 0xffff_ffff);
        *x = (qh << 32) | (lo / w);
        r = lo % w;
    }
    if r != 0 {
        return Err(DivFault::Invariant);
    }
    c.len = crate::qpoly::norm(&c.buf.v, c.len);
    Ok(())
}

/// gcd of two words, Euclid's (at most 93 steps, Lame on 64 bits): charged
/// 94 before.
fn gcd_word(mut a: u64, mut b: u64, m: &mut Meter) -> Result<u64, DivFault> {
    m.add(94)?;
    while b != 0 {
        (a, b) = (b, a % b);
    }
    Ok(a)
}

/// A token's numerator and denominator into two Coefs.
fn load(tok: &str, n: &mut Coef, d: &mut Coef, m: &mut Meter) -> Result<(), DivFault> {
    let (neg, nd, dd) = parts(tok);
    n.set_hex(neg, nd, m)?;
    d.set_hex(false, dd, m)?;
    if d.len == 0 {
        return Err(DivFault::Invariant);
    }
    Ok(())
}

/// The scratch Coefs of one call.
struct Tmp<'l> {
    an: Coef<'l>,
    ad: Coef<'l>,
    g1: Coef<'l>,
    g2: Coef<'l>,
    u: Coef<'l>,
    v: Coef<'l>,
}

impl<'l> Tmp<'l> {
    fn new(led: &'l Words, m: &mut Meter) -> Result<Tmp<'l>, DivFault> {
        let t = |m: &mut Meter| Coef::tagged(led, 0, "scratch", m);
        Ok(Tmp { an: t(m)?, ad: t(m)?, g1: t(m)?, g2: t(m)?, u: t(m)?, v: t(m)? })
    }
}

/// The computed coefficients: numerators and denominators, constant first,
/// and how many of them the reply keeps ([`trim`], once, at the end of the
/// compute).
pub struct Mapped<'l> {
    pub(crate) num: Arena<'l>,
    pub(crate) den: Arena<'l>,
    pub(crate) kept: usize,
}

/// Push num/den (den > 0) to the arenas.
fn push(out: &mut Mapped, num: &[u64], neg: bool, den: &[u64], m: &mut Meter) -> Result<(), DivFault> {
    if num.is_empty() {
        out.num.push(&[], false, m)?;
        return out.den.push(&[1], false, m);
    }
    out.num.push(num, neg, m)?;
    out.den.push(den, false, m)
}

/// x / g into dst (g = 1: a copy).
fn quotient(x: &[u64], g: &Coef, dst: &mut Coef, s: &mut Ints, m: &mut Meter) -> Result<(), DivFault> {
    if g.is_one() {
        return dst.set(x, false, m);
    }
    let n = s.divexact(x, g.mag(), m)?;
    dst.set(&s.q.v[..n], false, m)
}

/// The scale's coefficients (s = p/q, not 0, 1 or -1).
fn scale<'l>(a: &Factor, na: u64, b: &str, led: &'l Words, m: &mut Meter) -> Result<Mapped<'l>, DivFault> {
    let mut s = Ints::new(led, m)?;
    let mut t = Tmp::new(led, m)?;
    let (mut p, mut q) = (Coef::tagged(led, 0, "scalar", m)?, Coef::tagged(led, 0, "scalar", m)?);
    load(b, &mut p, &mut q, m)?;
    let mut out = Mapped { num: Arena::new(led, "num arena", m)?, den: Arena::new(led, "den arena", m)?, kept: 0 };
    let (mut w, mut z) = (Coef::tagged(led, 0, "scratch", m)?, Coef::tagged(led, 0, "scratch", m)?);
    for tok in a.text.split(',').take(na as usize) {
        load(tok, &mut t.an, &mut t.ad, m)?;
        if t.an.len == 0 {
            push(&mut out, &[], false, &[], m)?;
            continue;
        }
        // g1 = gcd(a_n, q), g2 = gcd(p, a_d); 1 when an operand is 1
        if q.is_one() || t.an.is_one() {
            t.g1.set(&[1], false, m)?;
        } else {
            s.gcd(t.an.mag(), q.mag(), &mut t.g1, m)?;
        }
        if p.is_one() || t.ad.is_one() {
            t.g2.set(&[1], false, m)?;
        } else {
            s.gcd(p.mag(), t.ad.mag(), &mut t.g2, m)?;
        }
        quotient(t.an.mag(), &t.g1, &mut t.u, &mut s, m)?;
        quotient(p.mag(), &t.g2, &mut t.v, &mut s, m)?;
        quotient(t.ad.mag(), &t.g2, &mut w, &mut s, m)?;
        quotient(q.mag(), &t.g1, &mut z, &mut s, m)?;
        let nn = s.mul(t.u.mag(), t.v.mag(), m)?;
        out.num.push(&s.p.v[..nn], t.an.neg != p.neg, m)?;
        let nd = s.mul(w.mag(), z.mag(), m)?;
        out.den.push(&s.p.v[..nd], false, m)?;
    }
    Ok(out)
}

/// The derivative's coefficients (1 <= k < na, so every factor j + k + 1
/// <= na and j + 1 is at most na <= 2^24: a word on every target).
fn derivative<'l>(a: &Factor, na: u64, k: u64, led: &'l Words, m: &mut Meter) -> Result<Mapped<'l>, DivFault> {
    if k == 0 || k >= na || na > zmulmax() {
        return Err(DivFault::Invariant);
    }
    let mut s = Ints::new(led, m)?;
    let mut t = Tmp::new(led, m)?;
    let mut f = Coef::tagged(led, 1, "falling", m)?;
    f.set(&[1], false, m)?;
    for i in 2..=k {
        mul_word(&mut f, i, m)?;
    }
    let mut out = Mapped { num: Arena::new(led, "num arena", m)?, den: Arena::new(led, "den arena", m)?, kept: 0 };
    let outs = na - k;
    for (j, tok) in a.text.split(',').take(na as usize).skip(k as usize).enumerate() {
        let j = j as u64;
        load(tok, &mut t.an, &mut t.ad, m)?;
        if t.an.len == 0 {
            push(&mut out, &[], false, &[], m)?;
        } else {
            // g = gcd(F_j, a_d), 1 when a_d is
            if t.ad.is_one() {
                t.g1.set(&[1], false, m)?;
            } else {
                s.gcd(f.mag(), t.ad.mag(), &mut t.g1, m)?;
            }
            quotient(f.mag(), &t.g1, &mut t.u, &mut s, m)?;
            quotient(t.ad.mag(), &t.g1, &mut t.v, &mut s, m)?;
            let nn = s.mul(t.an.mag(), t.u.mag(), m)?;
            out.num.push(&s.p.v[..nn], t.an.neg, m)?;
            out.den.push(t.v.mag(), false, m)?;
        }
        if j + 1 < outs {
            // F_(j+1) = F_j (j + k + 1) / (j + 1)
            mul_word(&mut f, j + k + 1, m)?;
            div_word_exact(&mut f, j + 1, m)?;
        }
    }
    Ok(out)
}

/// The most tokens a request may carry (zmul's request cap bounds them).
const fn zmulmax() -> u64 {
    crate::zmul::REQUEST_MAX
}

/// The integral's coefficients: b's token, then a_i / (i + 1) for i < na.
fn integral<'l>(a: &Factor, na: u64, b: &str, led: &'l Words, m: &mut Meter) -> Result<Mapped<'l>, DivFault> {
    if na > zmulmax() {
        return Err(DivFault::Invariant);
    }
    let mut t = Tmp::new(led, m)?;
    let mut out = Mapped { num: Arena::new(led, "num arena", m)?, den: Arena::new(led, "den arena", m)?, kept: 0 };
    load(b, &mut t.an, &mut t.ad, m)?;
    push(&mut out, t.an.mag(), t.an.neg, t.ad.mag(), m)?;
    for (i, tok) in a.text.split(',').take(na as usize).enumerate() {
        let w = i as u64 + 1;
        load(tok, &mut t.an, &mut t.ad, m)?;
        if t.an.len == 0 {
            push(&mut out, &[], false, &[], m)?;
            continue;
        }
        // g = gcd(a_n, w) = gcd(w, a_n mod w)
        let r = rem_word(&t.an, w, m)?;
        let g = gcd_word(w, r, m)?;
        if g != 1 {
            div_word_exact(&mut t.an, g, m)?;
        }
        if w / g != 1 {
            mul_word(&mut t.ad, w / g, m)?;
        }
        out.num.push(t.an.mag(), t.an.neg, m)?;
        out.den.push(t.ad.mag(), false, m)?;
    }
    Ok(out)
}

/// The sum's and difference's scratch coefficients.
struct Pair<'l> {
    an: Coef<'l>,
    ad: Coef<'l>,
    bn: Coef<'l>,
    bd: Coef<'l>,
    g: Coef<'l>,
    h: Coef<'l>,
    u: Coef<'l>,
    v: Coef<'l>,
    w: Coef<'l>,
    z: Coef<'l>,
}

/// x + y for x = a_n/a_d and y = (-1)^y_neg b_n/b_d (the operands in `p`),
/// pushed to the arenas reduced (the module docs' formula).
fn add_one(p: &mut Pair, y_neg: bool, out: &mut Mapped, s: &mut Ints, m: &mut Meter) -> Result<(), DivFault> {
    if p.bn.len == 0 {
        return push(out, p.an.mag(), p.an.neg, p.ad.mag(), m);
    }
    if p.an.len == 0 {
        return push(out, p.bn.mag(), y_neg, p.bd.mag(), m);
    }
    // g: a_d itself when the denominators are equal (the compare charged), 1
    // when either is 1, else their gcd
    m.add(p.ad.len.min(p.bd.len) + 1)?;
    if p.ad.mag() == p.bd.mag() {
        let ad = p.ad.mag();
        p.g.set(ad, false, m)?;
    } else if p.ad.is_one() || p.bd.is_one() {
        p.g.set(&[1], false, m)?;
    } else {
        s.gcd(p.ad.mag(), p.bd.mag(), &mut p.g, m)?;
    }
    // w = a_d/g, z = b_d/g; t = a_n z + y_n w, in u
    quotient(p.ad.mag(), &p.g, &mut p.w, s, m)?;
    quotient(p.bd.mag(), &p.g, &mut p.z, s, m)?;
    let n = s.mul(p.an.mag(), p.z.mag(), m)?;
    p.u.set(&s.p.v[..n], p.an.neg, m)?;
    let n = s.mul(p.bn.mag(), p.w.mag(), m)?;
    p.v.set(&s.p.v[..n], y_neg, m)?;
    let (vm, vn) = (p.v.mag(), p.v.neg);
    p.u.sub_signed(vm, !vn, m)?;
    if p.u.len == 0 {
        return push(out, &[], false, &[], m);
    }
    // h = gcd(t, g), 1 when g is; the numerator t/h, the denominator w (b_d/h)
    if p.g.is_one() {
        p.h.set(&[1], false, m)?;
    } else {
        s.gcd(p.u.mag(), p.g.mag(), &mut p.h, m)?;
    }
    quotient(p.u.mag(), &p.h, &mut p.v, s, m)?;
    out.num.push(p.v.mag(), p.u.neg, m)?;
    quotient(p.bd.mag(), &p.h, &mut p.z, s, m)?;
    let n = s.mul(p.w.mag(), p.z.mag(), m)?;
    out.den.push(&s.p.v[..n], false, m)
}

/// The sum's or difference's coefficients: pairs, then the longer
/// operand's tail copied (b's signs flipped for the difference).
fn add_sub<'l>(a: &Factor, na: u64, b: &Factor, nb: u64, sub: bool, led: &'l Words, m: &mut Meter) -> Result<Mapped<'l>, DivFault> {
    let mut s = Ints::new(led, m)?;
    let t = |m: &mut Meter| Coef::tagged(led, 0, "scratch", m);
    let mut p = Pair { an: t(m)?, ad: t(m)?, bn: t(m)?, bd: t(m)?, g: t(m)?, h: t(m)?, u: t(m)?, v: t(m)?, w: t(m)?, z: t(m)? };
    let mut out = Mapped { num: Arena::new(led, "num arena", m)?, den: Arena::new(led, "den arena", m)?, kept: 0 };
    let (mut ia, mut ib) = (a.text.split(',').take(na as usize), b.text.split(',').take(nb as usize));
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => break,
            (Some(x), None) => {
                load(x, &mut p.an, &mut p.ad, m)?;
                push(&mut out, p.an.mag(), p.an.neg, p.ad.mag(), m)?;
            }
            (None, Some(y)) => {
                load(y, &mut p.bn, &mut p.bd, m)?;
                push(&mut out, p.bn.mag(), p.bn.neg != sub, p.bd.mag(), m)?;
            }
            (Some(x), Some(y)) => {
                load(x, &mut p.an, &mut p.ad, m)?;
                load(y, &mut p.bn, &mut p.bd, m)?;
                let y_neg = p.bn.neg != sub;
                add_one(&mut p, y_neg, &mut out, &mut s, m)?;
            }
        }
    }
    Ok(out)
}

/// How many tokens the reply holds: through the last nonzero numerator (the
/// arenas keep the zeros a cancellation leaves on top).  Run once, at the end
/// of the compute (the `scale trim` phase): one unit a token, charged and
/// Stop polled every 4096 tokens; its count is stored in the [`Mapped`],
/// the one value both [`reply_bytes`] and [`emit`] use.
pub fn trim(mp: &Mapped, m: &mut Meter) -> Result<usize, DivFault> {
    let _p = sagebrush_interrupt::enter("scale trim");
    let total = mp.num.nt;
    let mut n = 0;
    for (i, (x, _)) in mp.num.fwd().enumerate() {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
            m.add((total - i).min(0x1000))?;
        }
        if !x.is_empty() {
            n = i + 1;
        }
    }
    Ok(n)
}

/// The reply's exact bytes, `{"ok":"..."}` with the [`Mapped`]'s kept
/// tokens.  Its own phase, `scale bytes`: one unit a token, charged and Stop
/// polled in 4096-token chunks; an overflow is the memory refusal.
pub fn reply_bytes(out: &Mapped, m: &mut Meter) -> Result<u64, DivFault> {
    let _p = sagebrush_interrupt::enter("scale bytes");
    let mut total = FIXED_BYTES;
    let mut count = 0u64;
    for (i, ((x, neg), (y, _))) in out.num.fwd().zip(out.den.fwd()).take(out.kept).enumerate() {
        walk_charge(i, out.kept, m)?;
        total = total.checked_add(token_bytes(x, neg, Some(y))).ok_or(DivFault::Memory)?;
        count += 1;
    }
    total.checked_add(count.saturating_sub(1)).ok_or(DivFault::Memory)
}

/// Write the reply into `out`, which already holds capacity for exactly
/// [`reply_bytes`]: nothing is allocated here.  Charges each token before
/// writing it, 4 units a limb (a limb is 16 hex digits to format).
pub fn emit(mp: &Mapped, out: &mut String, m: &mut Meter) -> Result<(), DivFault> {
    let _p = sagebrush_interrupt::enter("scale emit");
    sagebrush_interrupt::check_coarse();
    let cap = out.capacity();
    out.push_str("{\"ok\":\"");
    for (i, ((x, neg), (y, _))) in mp.num.fwd().zip(mp.den.fwd()).take(mp.kept).enumerate() {
        m.add(4 * (x.len() + y.len()) + 1)?;
        if i > 0 {
            out.push(',');
        }
        if neg {
            out.push('-');
        }
        hex(out, x);
        if !x.is_empty() && !(y.len() == 1 && y[0] == 1) {
            out.push('/');
            hex(out, y);
        }
    }
    out.push_str("\"}");
    debug_assert_eq!(out.capacity(), cap, "the reply was written without allocating");
    Ok(())
}

/// The reserved reply's guard: its words held by the ledger until dropped.
struct Reserved<'l>(u64, &'l Words);

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.1.release(self.0);
    }
}

/// An empty String with room for exactly `bytes`, its words reserved on the
/// ledger first (and held by the returned guard).
fn reserve_reply(bytes: u64, led: &Words) -> Result<(String, Reserved<'_>), DivFault> {
    let words = bytes.div_ceil(8);
    led.note("reply", words);
    led.reserve(words)?;
    let held = Reserved(words, led);
    let mut out = String::new();
    out.try_reserve_exact(usize::try_from(bytes).map_err(|_| DivFault::Memory)?).map_err(|_| DivFault::Memory)?;
    Ok((out, held))
}

/// A reply of the first `na` tokens of `a` copied (`flip`: each nonzero
/// token's sign flipped), reserved exactly from one metered pass.
fn copy_reply(a: &Factor, na: u64, flip: bool, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let _p = sagebrush_interrupt::enter("scale emit");
    let end = prefix_end(a.text, na);
    let prefix = &a.text[..end];
    let mut bytes = FIXED_BYTES + end as u64;
    if flip {
        for tok in prefix.split(',') {
            m.add(1)?;
            if tok.starts_with('-') {
                bytes -= 1;
            } else if tok != "0" {
                bytes += 1;
            }
        }
    }
    let (mut out, _held) = reserve_reply(bytes, led)?;
    let cap = out.capacity();
    out.push_str("{\"ok\":\"");
    if flip {
        for (i, tok) in prefix.split(',').enumerate() {
            m.add(tok.len() / 16 + 1)?;
            if i > 0 {
                out.push(',');
            }
            match tok.strip_prefix('-') {
                Some(t) => out.push_str(t),
                None if tok == "0" => out.push('0'),
                None => {
                    out.push('-');
                    out.push_str(tok);
                }
            }
        }
    } else {
        m.add(end / 16 + 1)?;
        out.push_str(prefix);
    }
    out.push_str("\"}");
    debug_assert_eq!(out.capacity(), cap, "the reply was written without allocating");
    if out.len() as u64 != bytes {
        return Err(DivFault::Invariant);
    }
    Ok(out)
}

/// A reply of one given token (or of none: the zero polynomial).
fn token_reply(tok: &str, led: &Words) -> Result<String, DivFault> {
    let (mut out, _held) = reserve_reply(FIXED_BYTES + tok.len() as u64, led)?;
    out.push_str("{\"ok\":\"");
    out.push_str(tok);
    out.push_str("\"}");
    Ok(out)
}

/// One call's admitted shape.
#[derive(Clone, Copy, Debug)]
pub struct Plan {
    pub kind: Kind,
    /// the normalized token counts of a and (for the sum and difference) b,
    /// and k (the derivative's order; 0 otherwise)
    pub na: u64,
    pub nb: u64,
    pub k: u64,
    /// the reply's closed-form bound (bytes)
    pub bound: u64,
    /// the fixed rows (words) and the ledger's limit: cap - fixed
    pub fixed: u64,
    pub limit: u64,
    /// the work meter's limit: WORK_MAX - R
    pub work: u64,
}

/// What a call answers without computing: the zero polynomial, a copy of
/// a's tokens or of b's (sign flipped or not), or b's token alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Short<'a> {
    Zero,
    Copy { na: u64, flip: bool },
    CopyB { nb: u64, flip: bool },
    Token(&'a str),
}

/// The derivative's order from b's token (a hex integer, nonnegative): None
/// when it is at least 2^28 (above any degree a request can carry, so the
/// derivative is zero).
fn order(b: &str) -> Result<Option<u64>, String> {
    if b.starts_with('-') {
        return Err("the derivative's order is negative".to_string());
    }
    if b.len() > 7 {
        return Ok(None);
    }
    Ok(Some(b.bytes().fold(0u64, |v, c| (v << 4) | u64::from(if c.is_ascii_digit() { c - b'0' } else { c - b'a' + 10 }))))
}

/// Admission, before anything is allocated: the request's bytes; b one
/// token (a polynomial for the sum and difference); the short answers; then
/// the fixed rows and the reply's bound against the caps.
pub fn admit<'a>(kind: Kind, a: &Factor, b: &Factor<'a>, r: u64, caps: &qpoly::Caps) -> Result<Result<Plan, Short<'a>>, String> {
    if r > caps.int.request {
        return Err(format!("the request's bytes = {} is more than {} ({})", r, caps.int.request, HOW));
    }
    let pair = matches!(kind, Kind::Add | Kind::Sub);
    if !pair && b.tokens != 1 {
        return Err("b is exactly one token".to_string());
    }
    let na = norm_len(a);
    let nb = if pair { norm_len(b) } else { 0 };
    let mut k = 0;
    match kind {
        Kind::Add | Kind::Sub => {
            if na == 0 && nb == 0 {
                return Ok(Err(Short::Zero));
            }
            if na == 0 {
                return Ok(Err(Short::CopyB { nb, flip: kind == Kind::Sub }));
            }
            if nb == 0 {
                return Ok(Err(Short::Copy { na, flip: false }));
            }
        }
        Kind::Scale => {
            if na == 0 || b.all_zero {
                return Ok(Err(Short::Zero));
            }
            if b.text == "1" || b.text == "-1" {
                return Ok(Err(Short::Copy { na, flip: b.text == "-1" }));
            }
        }
        Kind::Derivative => match order(b.text)? {
            None => return Ok(Err(Short::Zero)),
            Some(o) if o >= na => return Ok(Err(Short::Zero)),
            Some(0) => return Ok(Err(Short::Copy { na, flip: false })),
            Some(o) => k = o,
        },
        Kind::Integral => {
            if na == 0 {
                return Ok(Err(if b.all_zero { Short::Zero } else { Short::Token(b.text) }));
            }
        }
    }
    let bound = if pair { pair_bound(a.text, na, b.text, nb) } else { reply_bound(kind, prefix_end(a.text, na) as u64, na, b.text, k) };
    let bound = bound.ok_or_else(|| format!("the {}'s size overflows", kind.name()))?;
    if bound > caps.reply {
        return Err(format!("the reply's bytes (at most {}) is more than {} ({})", bound, caps.reply, HOW));
    }
    let fixed = fixed_rows(r).ok_or_else(|| format!("the {}'s size overflows", kind.name()))?;
    let cap = caps.int.peak / 8;
    if fixed > cap {
        return Err(format!("the memory (bytes) = {} is more than {} ({})", fixed.saturating_mul(8), caps.int.peak, HOW));
    }
    let work = caps.int.work.checked_sub(r).ok_or_else(|| format!("the request's bytes = {} leave no work within {} ({})", r, caps.int.work, HOW))?;
    Ok(Ok(Plan { kind, na, nb, k, bound, fixed, limit: cap - fixed, work }))
}

/// The refusal or internal error for a fault.
fn fault_text(f: DivFault, plan: &Plan) -> String {
    match f {
        DivFault::Work => format!("the {} needs more than {} word operations ({})", plan.kind.name(), plan.work, HOW),
        DivFault::Memory => format!("the {}'s memory needs more than {} bytes ({})", plan.kind.name(), (plan.fixed + plan.limit).saturating_mul(8), HOW),
        DivFault::Invariant => format!("{}: the {} (Invariant)", INTERNAL_PREFIX, plan.kind.name()),
    }
}

/// The map's coefficients into the arenas, on the caller's ledger and meter
/// (the `scale compute` phase).
pub fn compute<'l>(a: &Factor, b: &Factor, plan: &Plan, led: &'l Words, m: &mut Meter) -> Result<Mapped<'l>, DivFault> {
    let mut mp = {
        let _p = sagebrush_interrupt::enter("scale compute");
        sagebrush_interrupt::check_coarse();
        match plan.kind {
            Kind::Scale => scale(a, plan.na, b.text, led, m)?,
            Kind::Derivative => derivative(a, plan.na, plan.k, led, m)?,
            Kind::Integral => integral(a, plan.na, b.text, led, m)?,
            Kind::Add | Kind::Sub => add_sub(a, plan.na, b, plan.nb, plan.kind == Kind::Sub, led, m)?,
        }
    };
    mp.kept = trim(&mp, m)?;
    Ok(mp)
}

/// The compute, the reply's exact reservation (checked against the
/// admitted bound) and its writing, on the caller's ledger and meter (the
/// tests drive both).
pub fn reply_on(a: &Factor, b: &Factor, plan: &Plan, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let mp = compute(a, b, plan, led, m)?;
    let bytes = reply_bytes(&mp, m)?;
    if bytes > plan.bound {
        return Err(DivFault::Invariant);
    }
    let (mut out, _held) = reserve_reply(bytes, led)?;
    emit(&mp, &mut out, m)?;
    if out.len() as u64 != bytes {
        return Err(DivFault::Invariant);
    }
    Ok(out)
}

/// A short answer's reply, on the caller's ledger and meter.
pub fn short_on(s: Short, a: &Factor, b: &Factor, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    match s {
        Short::Zero => token_reply("", led),
        Short::Token(t) => token_reply(t, led),
        Short::Copy { na, flip } => copy_reply(a, na, flip, led, m),
        Short::CopyB { nb, flip } => copy_reply(b, nb, flip, led, m),
    }
}

/// The whole call on scanned operands: `{"ok":"..."}` or the refusal, with
/// no partial reply.
pub fn reply(kind: Kind, a: &Factor, b: &Factor, r: u64, caps: &qpoly::Caps) -> Result<String, String> {
    match admit(kind, a, b, r, caps)? {
        Ok(plan) => {
            let led = Words::new(plan.limit);
            let mut m = Meter::new(plan.work);
            reply_on(a, b, &plan, &led, &mut m).map_err(|f| fault_text(f, &plan))
        }
        Err(short) => {
            let fixed = fixed_rows(r).ok_or_else(|| format!("the {}'s size overflows", kind.name()))?;
            let cap = caps.int.peak / 8;
            let limit = cap.checked_sub(fixed).ok_or_else(|| format!("the memory (bytes) = {} is more than {} ({})", fixed.saturating_mul(8), caps.int.peak, HOW))?;
            let work = caps.int.work.checked_sub(r).ok_or_else(|| format!("the request's bytes = {} leave no work within {} ({})", r, caps.int.work, HOW))?;
            let led = Words::new(limit);
            let mut m = Meter::new(work);
            let plan = Plan { kind, na: 0, nb: 0, k: 0, bound: 0, fixed, limit, work };
            short_on(short, a, b, &led, &mut m).map_err(|f| fault_text(f, &plan))
        }
    }
}

#[cfg(test)]
mod tests;
