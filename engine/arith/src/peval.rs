//! A polynomial over Q at a rational point, for the `qpoly_eval` op (design:
//! the eval note r1).  `a` is the polynomial's tokens (`[-]num[/den]` in hex,
//! constant first), `b` one token, the point v = p/q (q > 0, lowest terms).
//!
//! - **eval clear:** D = the lcm of the nonzero coefficients' denominators,
//!   qpoly_clear's metered lcm (its plan, its closed-form row, its refusal),
//!   on the call's one meter; A_i = a_i D, an integer, made as each token is
//!   read (a_n (D / a_d), one exact division).
//! - **eval horner:** homogeneous Horner on integers, top down: S_n = A_n,
//!   Q_n = 1; Q_k = Q_(k+1) q, S_k = S_(k+1) p + A_k Q_k.  Then a(v) = S_0 /
//!   (D q^n), Q_0 = q^n.  With q = 1 there is no Q.
//! - **one reduction at the end:** since gcd(p, q) = 1, S_0 = A_n p^n (mod q),
//!   so a prime of q divides S_0 only if it divides A_n.  With c = gcd(A_n,
//!   q) = 1 (the common case), gcd(S_0, D q^n) = gcd(S_0, D): an unbalanced
//!   gcd against D; only c > 1 takes the general gcd(S_0, D q^n).
//!
//! p = 0 answers a_0's token; the zero polynomial answers 0.  The (M)
//! pattern, as pscale's: closed forms admitted before anything is allocated
//! (the request, the lcm's row, then the reply's bound from the actual lcm),
//! one never-reset meter (WORK_MAX - R), every growable buffer on the word
//! ledger, the reply reserved exactly and written without allocating.

use crate::coprime::{Fault, Meter};
use crate::ledger::{skip_polled, token_end_polled, Coef, DivFault, Words};
use crate::pdivrem::{norm_len, token_bytes, OVERHEAD_WORDS};
use crate::pscale::{load, mul_word, quotient, reserve_reply, token_reply, Ints, FIXED_BYTES};
use crate::qpoly::{self, bits, parts, Factor};
use crate::zmul::hex;
use crate::zseries::INTERNAL_PREFIX;

const HOW: &str = "a smaller polynomial or point per call";

/// The bit length of v (0 for 0).
const fn bit_length(v: u64) -> u64 {
    64 - v.leading_zeros() as u64
}

/// The reply's closed-form bound in bytes, from the actual lcm's bits and the
/// tokens' digits (checked; None on overflow).  |S_0| <= (n + 1) max|A_i|
/// max(|p|, q)^n with |A_i| < 2^(bits(D) + num_bits), so S_0 has at most
/// bits(D) + num_bits + n max(bits p, bits q) + bitlen(n + 1) bits, and the
/// denominator D q^n at most bits(D) + n bits(q); in hex, a sign and a slash.
pub fn reply_bound(bits_d: u64, num_bits: u64, n: u64, bits_p: u64, bits_q: u64) -> Option<u64> {
    let top = bits_p.max(bits_q);
    let nb = bits_d.checked_add(num_bits)?.checked_add(n.checked_mul(top)?)?.checked_add(bit_length(n.checked_add(1)?))?;
    let db = bits_d.checked_add(n.checked_mul(bits_q)?)?;
    FIXED_BYTES.checked_add(2)?.checked_add(nb.div_ceil(4))?.checked_add(db.div_ceil(4))
}

/// One call's admitted shape.
#[derive(Clone, Copy, Debug)]
pub struct Plan {
    /// the normalized token count of a (the degree + 1)
    pub na: u64,
    /// the lcm phase's plan
    pub clear: qpoly::PlanClear,
    /// the meter's limit, WORK_MAX - R
    pub work: u64,
}

/// What a call answers without the Horner phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Short<'a> {
    /// the zero polynomial: 0
    Zero,
    /// v = 0: a_0's token
    Token(&'a str),
}

/// Admission before anything is allocated: the request's bytes, b one token,
/// the short answers, then the lcm phase's closed forms.
pub fn admit<'a>(a: &Factor<'a>, b: &Factor, r: u64, caps: &qpoly::Caps) -> Result<Result<Plan, Short<'a>>, String> {
    if r > caps.int.request {
        return Err(format!("the request's bytes = {} is more than {} ({})", r, caps.int.request, HOW));
    }
    if b.tokens != 1 {
        return Err("b is exactly one token".to_string());
    }
    let na = norm_len(a);
    if na == 0 {
        return Ok(Err(Short::Zero));
    }
    if b.all_zero {
        let end = token_end_polled(a.text, 1);
        return Ok(Err(Short::Token(&a.text[..end])));
    }
    let clear = qpoly::admit_clear(a, r, caps)?.ok_or_else(|| format!("{}: a nonzero polynomial admitted as empty", INTERNAL_PREFIX))?;
    Ok(Ok(Plan { na, clear, work: clear.limit }))
}

/// The `eval clear` phase: D, on the call's meter.
pub fn clear(a: &Factor, plan: &Plan, m: &mut Meter) -> Result<Vec<u64>, Fault> {
    let _p = sagebrush_interrupt::enter("eval clear");
    sagebrush_interrupt::check_coarse();
    qpoly::clear_lcm(a, &plan.clear, m)
}

/// The rest's admission from the actual lcm: the reply's bound against its
/// cap, and the fixed rows (the request, D, the call's owners) against the
/// peak, leaving the ledger's limit.  (bound, fixed, limit), in bytes and
/// words.
pub fn admit_b(a: &Factor, b: &Factor, d: &[u64], plan: &Plan, r: u64, caps: &qpoly::Caps) -> Result<(u64, u64, u64), String> {
    let (_, bn, bd) = parts(b.text);
    let ovf = || "the evaluation's size overflows".to_string();
    let bound = reply_bound(bits(d), a.num_bits, plan.na - 1, 4 * bn.len() as u64, 4 * bd.len() as u64).ok_or_else(ovf)?;
    if bound > caps.reply {
        return Err(format!("the reply's bytes (at most {}) is more than {} ({})", bound, caps.reply, HOW));
    }
    let fixed = r.div_ceil(8).checked_add(d.len() as u64).and_then(|x| x.checked_add(OVERHEAD_WORDS)).ok_or_else(ovf)?;
    let cap = caps.int.peak / 8;
    if fixed > cap {
        return Err(format!("the memory (bytes) = {} is more than {} ({})", fixed.saturating_mul(8), caps.int.peak, HOW));
    }
    Ok((bound, fixed, cap - fixed))
}

/// The `eval point` phase, the call's first, on its meter: whether b is in
/// lowest terms (gcd(p, q) = 1; zero only as `0`).  The reduction's c = 1
/// branch rests on it, so a point not in lowest terms is refused.
pub fn point_reduced(b: &Factor, led: &Words, m: &mut Meter) -> Result<bool, DivFault> {
    let _p = sagebrush_interrupt::enter("eval point");
    sagebrush_interrupt::check_coarse();
    let mut s = Ints::new(led, m)?;
    let t = |m: &mut Meter| Coef::tagged(led, 0, "scratch", m);
    let (mut p, mut q, mut g) = (t(m)?, t(m)?, t(m)?);
    load(b.text, &mut p, &mut q, m)?;
    if q.is_one() {
        return Ok(true);
    }
    if p.len == 0 {
        return Ok(false);
    }
    s.gcd(p.mag(), q.mag(), &mut g, m)?;
    Ok(g.is_one())
}

#[cfg(test)]
thread_local! {
    /// (tests) the last call's final reduction: true for gcd(S, D) (c = 1),
    /// false for the general gcd(S, D q^n)
    pub(crate) static BY_D: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

fn branch(_by_d: bool) {
    #[cfg(test)]
    BY_D.with(|b| b.set(Some(_by_d)));
}

/// The scratch of the Horner phase, ledger-owned.
struct Horner<'l> {
    s: Coef<'l>,
    q_pow: Coef<'l>,
    a_n: Coef<'l>,
    an: Coef<'l>,
    ad: Coef<'l>,
    term: Coef<'l>,
    p: Coef<'l>,
    q: Coef<'l>,
    g: Coef<'l>,
    den: Coef<'l>,
}

/// A_i = a_n (D / a_d) into `dst` (its sign a_n's); zero for a zero a_n.
fn cleared(h_an: &Coef, h_ad: &Coef, d: &[u64], dst: &mut Coef, s: &mut Ints, m: &mut Meter) -> Result<(), DivFault> {
    if h_an.len == 0 {
        return dst.set(&[], false, m);
    }
    if h_ad.is_one() {
        // (an integer coefficient: A = a_n D, no division; a_n itself for
        // D = 1)
        if d == [1] {
            return dst.set(h_an.mag(), h_an.neg, m);
        }
        let np = s.mul(h_an.mag(), d, m)?;
        return dst.set(&s.p.v[..np], h_an.neg, m);
    }
    let nq = s.divexact(d, h_ad.mag(), m)?;
    dst.set(&s.q.v[..nq], false, m)?;
    let np = s.mul(h_an.mag(), dst.mag(), m)?;
    dst.set(&s.p.v[..np], h_an.neg, m)
}

/// The reduced value S_0 / (D q^n), as (numerator, its sign, denominator)
/// in `h.s` and `h.den` (the `eval horner` phase, the reduction included).
fn horner<'l>(a: &Factor, b: &Factor, d: &[u64], plan: &Plan, led: &'l Words, m: &mut Meter) -> Result<(Coef<'l>, Coef<'l>), DivFault> {
    let _p = sagebrush_interrupt::enter("eval horner");
    sagebrush_interrupt::check_coarse();
    let mut s = Ints::new(led, m)?;
    let t = |m: &mut Meter| Coef::tagged(led, 0, "scratch", m);
    let mut h = Horner { s: t(m)?, q_pow: t(m)?, a_n: t(m)?, an: t(m)?, ad: t(m)?, term: t(m)?, p: t(m)?, q: t(m)?, g: t(m)?, den: t(m)? };
    load(b.text, &mut h.p, &mut h.q, m)?;
    let unit_q = h.q.is_one();
    h.q_pow.set(&[1], false, m)?;
    // (the tokens from the top degree down, a's trailing zeros stepped over)
    let mut toks = skip_polled(a.text.rsplit(','), (a.tokens - plan.na) as usize);
    let top = toks.next().ok_or(DivFault::Invariant)?;
    load(top, &mut h.an, &mut h.ad, m)?;
    cleared(&h.an, &h.ad, d, &mut h.a_n, &mut s, m)?;
    let (mag, neg) = (h.a_n.mag(), h.a_n.neg);
    h.s.set(mag, neg, m)?;
    for tok in toks {
        // Q = Q q; S = S p + A_k Q (a one-word p or q in place)
        if h.q.len == 1 && !unit_q {
            mul_word(&mut h.q_pow, h.q.mag()[0], m)?;
        } else if !unit_q {
            let n = s.mul(h.q_pow.mag(), h.q.mag(), m)?;
            h.q_pow.set(&s.p.v[..n], false, m)?;
        }
        if h.s.len > 0 && h.p.len == 1 {
            h.s.neg = h.s.neg != h.p.neg;
            mul_word(&mut h.s, h.p.mag()[0], m)?;
        } else if h.s.len > 0 {
            let n = s.mul(h.s.mag(), h.p.mag(), m)?;
            let neg = h.s.neg != h.p.neg;
            h.s.set(&s.p.v[..n], neg, m)?;
        }
        load(tok, &mut h.an, &mut h.ad, m)?;
        if h.an.len == 0 {
            continue;
        }
        cleared(&h.an, &h.ad, d, &mut h.term, &mut s, m)?;
        if !unit_q {
            let n = s.mul(h.term.mag(), h.q_pow.mag(), m)?;
            let neg = h.term.neg;
            h.term.set(&s.p.v[..n], neg, m)?;
        }
        let (tm, tn) = (h.term.mag(), h.term.neg);
        h.s.sub_signed(tm, !tn, m)?;
    }
    if h.s.len == 0 {
        h.den.set(&[1], false, m)?;
        return Ok((h.s, h.den));
    }
    // the denominator D q^n; g = gcd(S, D) when gcd(A_n, q) = 1, else
    // gcd(S, D q^n)
    let n = s.mul(d, h.q_pow.mag(), m)?;
    h.den.set(&s.p.v[..n], false, m)?;
    let c_is_one = if unit_q {
        true
    } else {
        s.gcd(h.a_n.mag(), h.q.mag(), &mut h.g, m)?;
        h.g.is_one()
    };
    branch(c_is_one);
    if c_is_one {
        s.gcd(h.s.mag(), d, &mut h.g, m)?;
    } else {
        s.gcd(h.s.mag(), h.den.mag(), &mut h.g, m)?;
    }
    if !h.g.is_one() {
        let neg = h.s.neg;
        quotient(h.s.mag(), &h.g, &mut h.term, &mut s, m)?;
        let tm = h.term.mag();
        h.an.set(tm, neg, m)?;
        quotient(h.den.mag(), &h.g, &mut h.term, &mut s, m)?;
        let tm = h.term.mag();
        h.ad.set(tm, false, m)?;
        return Ok((h.an, h.ad));
    }
    Ok((h.s, h.den))
}

/// The refusal or internal error for a fault after the lcm.
fn fault_text(f: DivFault, work: u64, fixed: u64, limit: u64) -> String {
    match f {
        DivFault::Work => format!("the evaluation needs more than {} word operations ({})", work, HOW),
        DivFault::Memory => format!("the evaluation's memory needs more than {} bytes ({})", (fixed + limit).saturating_mul(8), HOW),
        DivFault::Invariant => format!("{}: the evaluation (Invariant)", INTERNAL_PREFIX),
    }
}

/// The Horner phase, the reply's exact reservation (checked against the
/// admitted bound) and its writing (`eval emit`), on the caller's ledger
/// and meter.
pub fn reply_on(a: &Factor, b: &Factor, d: &[u64], plan: &Plan, bound: u64, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let (num, den) = horner(a, b, d, plan, led, m)?;
    let _p = sagebrush_interrupt::enter("eval emit");
    sagebrush_interrupt::check_coarse();
    write_token(&num, &den, bound, led, m)
}

/// `{"ok":"num/den"}` (num alone for den = 1 or num = 0) in its exact
/// reservation, without allocating past it; more than `bound` bytes is an
/// Invariant.
fn write_token(num: &Coef, den: &Coef, bound: u64, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let bytes = FIXED_BYTES.checked_add(token_bytes(num.mag(), num.neg, Some(den.mag()))).ok_or(DivFault::Memory)?;
    if bytes > bound {
        return Err(DivFault::Invariant);
    }
    let (mut out, _held) = reserve_reply(bytes, led)?;
    let cap = out.capacity();
    m.add(4 * (num.len + den.len) + 1)?;
    out.push_str("{\"ok\":\"");
    if num.neg {
        out.push('-');
    }
    hex(&mut out, num.mag());
    if num.len > 0 && !den.is_one() {
        out.push('/');
        hex(&mut out, den.mag());
    }
    out.push_str("\"}");
    debug_assert_eq!(out.capacity(), cap, "the reply was written without allocating");
    if out.len() as u64 != bytes {
        return Err(DivFault::Invariant);
    }
    Ok(out)
}

/// v = 0: a_0 in lowest terms (the `eval emit` phase, on the call's meter
/// and ledger): its token's gcd and exact divisions, then the reply.
pub fn a0_reply(tok: &str, led: &Words, m: &mut Meter) -> Result<String, DivFault> {
    let _p = sagebrush_interrupt::enter("eval emit");
    sagebrush_interrupt::check_coarse();
    let mut s = Ints::new(led, m)?;
    let t = |m: &mut Meter| Coef::tagged(led, 0, "scratch", m);
    let (mut n, mut d, mut g, mut q) = (t(m)?, t(m)?, t(m)?, t(m)?);
    load(tok, &mut n, &mut d, m)?;
    if n.len == 0 {
        d.set(&[1], false, m)?;
    } else if !d.is_one() {
        s.gcd(n.mag(), d.mag(), &mut g, m)?;
        if !g.is_one() {
            let neg = n.neg;
            quotient(n.mag(), &g, &mut q, &mut s, m)?;
            n.set(q.mag(), neg, m)?;
            quotient(d.mag(), &g, &mut q, &mut s, m)?;
            d.set(q.mag(), false, m)?;
        }
    }
    // (a reduced token is no longer than the one given)
    let bound = FIXED_BYTES.checked_add(tok.len() as u64).ok_or(DivFault::Memory)?;
    write_token(&n, &d, bound, led, m)
}

/// The whole call on scanned operands: `{"ok":"tok"}`, a(v) in lowest terms,
/// or the refusal (no partial reply).
pub fn reply(a: &Factor, b: &Factor, r: u64, caps: &qpoly::Caps) -> Result<String, String> {
    let admitted = admit(a, b, r, caps)?;
    // (the point's check first, on the call's one meter and a ledger of the
    // peak less the request, released before the lcm)
    let work = caps.int.work.saturating_sub(r);
    let mut m = Meter::new(work);
    {
        let fixed = r.div_ceil(8).saturating_add(OVERHEAD_WORDS);
        let led = Words::new((caps.int.peak / 8).saturating_sub(fixed));
        match point_reduced(b, &led, &mut m) {
            Ok(true) => {}
            Ok(false) => return Err("b is not in lowest terms".to_string()),
            Err(f) => return Err(fault_text(f, work, fixed, led.limit())),
        }
        match admitted {
            Ok(_) => {}
            Err(Short::Zero) => return token_reply("0", &led).map_err(|_| format!("the memory (bytes) is more than {} ({})", caps.int.peak, HOW)),
            Err(Short::Token(t)) => return a0_reply(t, &led, &mut m).map_err(|f| fault_text(f, work, fixed, led.limit())),
        }
    }
    let Ok(plan) = admitted else { return Err(format!("{}: a short answer past its branch", INTERNAL_PREFIX)) };
    let d = clear(a, &plan, &mut m).map_err(|f| match f {
        Fault::Overrun => format!("the denominators' lcm needs more than {} word operations (fewer or simpler denominators per call)", plan.work),
        Fault::Invariant => format!("{}: the lcm (Invariant)", INTERNAL_PREFIX),
    })?;
    let (bound, fixed, limit) = admit_b(a, b, &d, &plan, r, caps)?;
    let led = Words::new(limit);
    reply_on(a, b, &d, &plan, bound, &led, &mut m).map_err(|f| fault_text(f, plan.work, fixed, limit))
}

#[cfg(test)]
mod tests;
