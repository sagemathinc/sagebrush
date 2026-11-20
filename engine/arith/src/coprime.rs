//! gcd = 1 checks for wire input (the canonical rationals of `QV_1` and
//! `MQR1`), in a workspace the caller sized and reserved in advance, with a
//! work charge admitted in advance.
//!
//! The gcd is Lehmer's (Knuth's Algorithm L, 63-bit leading windows), with a
//! Knuth-D remainder step when a window gives no quotient, and runs entirely
//! in place on two slots of `L + 1` limbs, `L` the largest limb count of the
//! payload.  Nothing here allocates: the routines take slices.
//!
//! **Memory.**  One workspace of [`workspace_words`]`(L) = 2 (L + 1)`
//! words, the caller's single allocation; no other allocation, no recursion,
//! the result stays in the workspace.  The inputs are read from the wire and
//! copied into the slots, so nothing decoded is touched.
//!
//! **Work**, in units: each [`Meter`] charge below is one unit per inner
//! iteration of the limb loop it precedes (plus small constants), so the
//! meter counts what the loops do.  [`gcd_work`]`(la, lb)`, for operands of
//! `la >= lb >= 1` limbs, bounds the meter of [`gcd_in_place`] in advance:
//! - **Iterations.** Every outer iteration that neither returns nor stops
//!   takes at least one step of the Euclidean remainder sequence: a Knuth-D
//!   remainder is one step, and a Lehmer window whose cosequence is not the
//!   identity applies quotients that Algorithm L's test proves are the true
//!   ones.  By Lame, a remainder sequence on b < 2^(64 lb) has at most
//!   n steps with phi^(n-1) <= b, so n < 64 lb / log2(phi) + 1 < 92.2 lb + 1:
//!   at most `T = 93 lb + 2` such iterations.
//! - **Per iteration** (with na <= la, nb <= lb: after the first, both
//!   operands are remainders below b): the comparison `na + 2`; a window's
//!   cosequence `LEHMER_STEPS` = 96; then the apply `3 na`, or the remainder's
//!   shifts `(na + nb + 2) + (2 nb + na + 1)`; at most `4 la + 3 lb + 101`
//!   in all, the quotient loop apart.
//! - **The quotient loop** of a remainder step on (r_k, r_(k+1)) runs
//!   `na - nb + 1` times at `2 nb + 4` units, and na - nb <= (bits r_k -
//!   bits r_(k+1)) / 64 + 1.  Those bit drops telescope to at most 64 la,
//!   so all the quotient loops together run at most `la + 2 T` times, at
//!   most `2 lb + 4` units each.
//! - **The last iteration**, the single-limb step (or b = 0): the comparison
//!   and `2 na + 93` (na remainders, at most 93 u64 steps by Lame, the
//!   zero fill): at most `3 la + 95`.
//!
//! So `gcd_work(la, lb) = T (4 la + 3 lb + 101) + (la + 2 T)(2 lb + 4)
//! + 3 la + 95`, a polynomial with nonnegative coefficients in the sorted
//! sizes, hence nondecreasing in each operand's size: an MQR1 row's running
//! gcd, never larger than the row denominator, is charged at the
//! denominator's size.  [`pair_work`], [`row_entry_work`] and
//! [`row_fixed_work`] add the slots' loads, copies and clears.  This is a
//! proof, not a fit: random input meters 1/70 to 1/250 of it, consecutive
//! Fibonacci numbers (the most Euclidean steps per bit) about 1/57 (the
//! price of Lame's worst case).
//! Going over the admitted total is an internal error, never a retry.  The
//! meter polls Stop every [`POLL_UNITS`] units, inside the quotient loop too.

use sagebrush_wire::BigRef;

/// The most limbs an integer may have where a gcd check runs (`QV_1`,
/// `MQR1`): 2^20 bits, about 315,000 decimal digits.
pub const LIMB_CAP: u64 = 1 << 14;

/// At most this many cosequence steps per Lehmer window (Lamé on 63 bits
/// allows 91).
const LEHMER_STEPS: u64 = 96;

/// Stop is polled at least every this many units (about a millisecond).
pub const POLL_UNITS: u64 = 1 << 20;

/// The words of the workspace for integers of at most `l` limbs.
pub const fn workspace_words(l: u64) -> Option<u64> {
    match l.checked_add(1) {
        Some(s) => s.checked_mul(2),
        None => None,
    }
}

macro_rules! ck {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => return None,
        }
    };
}

/// The work bound of [`gcd_in_place`] on operands of `la` and `lb` limbs,
/// in either order (module docs); `None` on overflow.
pub const fn gcd_work(la: u64, lb: u64) -> Option<u64> {
    let (la, lb) = if la >= lb { (la, lb) } else { (lb, la) };
    if lb == 0 {
        // one comparison, then b = 0
        return la.checked_add(2);
    }
    let t = ck!(ck!(lb.checked_mul(93)).checked_add(2));
    let iter = ck!(ck!(ck!(la.checked_mul(4)).checked_add(ck!(lb.checked_mul(3)))).checked_add(101));
    let iters = ck!(t.checked_mul(iter));
    let quot = ck!(ck!(la.checked_add(ck!(t.checked_mul(2)))).checked_mul(ck!(ck!(lb.checked_mul(2)).checked_add(4))));
    let last = ck!(ck!(la.checked_mul(3)).checked_add(95));
    ck!(iters.checked_add(quot)).checked_add(last)
}

/// The work bound of [`coprime_pair`] on a numerator of `ln` and a
/// denominator of `ld` limbs: the two loads (`k + 1` each), the gcd, the
/// two clears (`max + 2` each).
pub const fn pair_work(ln: u64, ld: u64) -> Option<u64> {
    let hi = if ln >= ld { ln } else { ld };
    let loads = ck!(ck!(ln.checked_add(ld)).checked_add(2));
    let clears = ck!(ck!(hi.checked_add(2)).checked_mul(2));
    ck!(ck!(gcd_work(ln, ld)).checked_add(loads)).checked_add(clears)
}

/// One numerator's term of [`row_work`]: for a nonzero numerator of `ln`
/// limbs in a row with a denominator of `ld` limbs, the load (`ln + 1`),
/// the gcd with the running gcd (at most `ld` limbs), the copy back
/// (`ld + 1`) and the clear (`max + 2`); zero for a zero numerator.
pub const fn row_entry_work(ln: u64, ld: u64) -> Option<u64> {
    if ln == 0 {
        return Some(0);
    }
    let hi = if ln >= ld { ln } else { ld };
    let fixed = ck!(ck!(ck!(ln.checked_add(ld)).checked_add(hi)).checked_add(4));
    ck!(gcd_work(ln, ld)).checked_add(fixed)
}

/// The rest of [`row_work`]: the denominator's load (`ld + 1`) and the
/// final clear (`l + 2`, `l` the row's largest limb count).
pub const fn row_fixed_work(ld: u64, l: u64) -> Option<u64> {
    ck!(ld.checked_add(l)).checked_add(3)
}

/// Why a check stopped without an answer: the admitted work ran out (an
/// error in the bound: internal), or an invariant failed (internal).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Overrun,
    Invariant,
}

/// The work meter: units used against the admitted total, and Stop polls.
pub struct Meter {
    used: u64,
    limit: u64,
    since_poll: u64,
    largest: u64,
}

impl Meter {
    pub fn new(limit: u64) -> Meter {
        Meter { used: 0, limit, since_poll: 0, largest: 0 }
    }
    pub fn used(&self) -> u64 {
        self.used
    }
    pub fn limit(&self) -> u64 {
        self.limit
    }
    /// The largest single charge so far: the most the count can pass the
    /// limit by when a charge is refused (the check follows every charge).
    pub fn largest_charge(&self) -> u64 {
        self.largest
    }
    #[inline]
    pub(crate) fn add(&mut self, n: usize) -> Result<(), Fault> {
        let n = u64::try_from(n).map_err(|_| Fault::Overrun)?;
        self.largest = self.largest.max(n);
        self.used = self.used.checked_add(n).ok_or(Fault::Overrun)?;
        if self.used > self.limit {
            return Err(Fault::Overrun);
        }
        self.since_poll = self.since_poll.saturating_add(n);
        if self.since_poll >= POLL_UNITS {
            self.since_poll = 0;
            sagebrush_interrupt::check_coarse();
        }
        Ok(())
    }
}

fn norm(x: &[u64], n: usize) -> usize {
    let mut n = n;
    while n > 0 && x[n - 1] == 0 {
        n -= 1;
    }
    n
}

fn less(x: &[u64], nx: usize, y: &[u64], ny: usize) -> bool {
    if nx != ny {
        return nx < ny;
    }
    for i in (0..nx).rev() {
        if x[i] != y[i] {
            return x[i] < y[i];
        }
    }
    false
}

/// The 63 bits of x from bit `shift` on.
fn window(x: &[u64], n: usize, shift: usize) -> u64 {
    let (w, b) = (shift / 64, shift % 64);
    let lo = if w < n { x[w] >> b } else { 0 };
    let hi = if b > 0 && w + 1 < n { x[w + 1] << (64 - b) } else { 0 };
    (lo | hi) & (u64::MAX >> 1)
}

/// x mod y in place (Knuth D, the quotient discarded), for ny >= 2, x >= y
/// (nx >= ny), x with room for nx + 1 limbs.  y is normalized in place and
/// restored.  The remainder's length.
fn rem_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<usize, Fault> {
    let s = y[ny - 1].leading_zeros();
    m.add(nx + ny + 2)?;
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (u128::from(y[ny - 1]), u128::from(y[ny - 2]));
    for j in (0..=nx - ny).rev() {
        m.add(2 * ny + 4)?;
        let top = (u128::from(x[j + ny]) << 64) | u128::from(x[j + ny - 1]);
        // top < y1 2^64 (the running remainder is below y): qh < 2^64 + 2
        let mut qh = top / y1;
        let mut rh = top % y1;
        // at most two corrections (Knuth D3)
        while qh >> 64 != 0 || qh * y2 > ((rh << 64) | u128::from(x[j + ny - 2])) {
            qh -= 1;
            rh += y1;
            if rh >> 64 != 0 {
                break;
            }
        }
        // x[j .. j + ny + 1] -= qh y
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let p = qh * u128::from(y[i]) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            // qh was one too large (Knuth D6): add y back once
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
    }
    m.add(2 * ny + nx + 1)?;
    if s > 0 {
        for i in 0..ny - 1 {
            x[i] = (x[i] >> s) | (x[i + 1] << (64 - s));
        }
        x[ny - 1] >>= s;
        for i in 0..ny - 1 {
            y[i] = (y[i] >> s) | (y[i + 1] << (64 - s));
        }
        y[ny - 1] >>= s;
    }
    for v in &mut x[ny..=nx] {
        *v = 0;
    }
    let r = norm(x, ny);
    if !less(x, r, y, ny) {
        return Err(Fault::Invariant);
    }
    Ok(r)
}

/// The quotient-keeping Knuth D's units for an `lx`-limb by an `ly`-limb
/// division, `1 <= ly <= lx` ([`divexact_in_place`]): `Q(lx, ly) = (lx - ly
/// + 1)(2 ly + 4) + 3 lx + 8`; `None` on overflow or outside that range.
pub const fn quot_work(lx: u64, ly: u64) -> Option<u64> {
    if ly == 0 || ly > lx {
        return None;
    }
    let loop_ = ck!(ck!((lx - ly).checked_add(1)).checked_mul(ck!(ck!(ly.checked_mul(2)).checked_add(4))));
    ck!(loop_.checked_add(ck!(lx.checked_mul(3)))).checked_add(8)
}

/// [`quot_work`]`(lx, ly)` for a divisor of unknown size: `Qhat(lx) =
/// ceil((lx + 3)^2 / 2) + 3 lx + 8 >= Q(lx, ly)` for every `1 <= ly <= lx`
/// (with u = lx - ly + 1 and v = ly + 2, u + v = lx + 3 and 2 u v <= (u +
/// v)^2 / 2).
pub const fn quot_work_any(lx: u64) -> Option<u64> {
    let t = ck!(lx.checked_add(3));
    let sq = ck!(t.checked_mul(t));
    ck!(sq.div_ceil(2).checked_add(ck!(lx.checked_mul(3)))).checked_add(8)
}

/// x / y exactly (Knuth D, the quotient kept: the sibling of
/// `rem_in_place`), for `1 <= ny <= nx`, y normalized (`y[ny - 1] != 0`), x
/// with room for `nx + 1` limbs and q for `nx - ny + 1`.  The quotient goes
/// to q and its length is returned.  x is left all zero (its remainder,
/// checked: a nonzero remainder is an invariant failure, never a wrong
/// answer); y is the caller's copy and is left normalized (shifted), not
/// restored.  Units: `nx + ny + 2` for the shifts, `2 ny + 4` per quotient
/// limb (6 for a one-limb divisor), `nx + 2` for the remainder check: at
/// most [`quot_work`]`(nx, ny)`, since `2 nx + ny + 4 <= 3 nx + 8`.
pub fn divexact_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, q: &mut [u64], m: &mut Meter) -> Result<usize, Fault> {
    if ny == 0 || nx < ny || x.len() <= nx || y.len() < ny || y[ny - 1] == 0 || q.len() < nx - ny + 1 {
        return Err(Fault::Invariant);
    }
    m.add(nx + ny + 2)?;
    if ny == 1 {
        let d = u128::from(y[0]);
        let mut r = 0u128;
        for j in (0..nx).rev() {
            m.add(6)?;
            let t = (r << 64) | u128::from(x[j]);
            q[j] = (t / d) as u64;
            r = t % d;
            x[j] = 0;
        }
        m.add(nx + 2)?;
        x[nx] = 0;
        if r != 0 {
            return Err(Fault::Invariant);
        }
        return Ok(norm(q, nx));
    }
    let s = y[ny - 1].leading_zeros();
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (u128::from(y[ny - 1]), u128::from(y[ny - 2]));
    for j in (0..=nx - ny).rev() {
        m.add(2 * ny + 4)?;
        let top = (u128::from(x[j + ny]) << 64) | u128::from(x[j + ny - 1]);
        let mut qh = top / y1;
        let mut rh = top % y1;
        while qh >> 64 != 0 || qh * y2 > ((rh << 64) | u128::from(x[j + ny - 2])) {
            qh -= 1;
            rh += y1;
            if rh >> 64 != 0 {
                break;
            }
        }
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let p = qh * u128::from(y[i]) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            qh -= 1;
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
        q[j] = qh as u64;
    }
    // (the remainder, still shifted, is x[..ny]; above it everything is zero)
    m.add(nx + 2)?;
    if x[..=nx].iter().any(|&w| w != 0) {
        return Err(Fault::Invariant);
    }
    Ok(norm(q, nx - ny + 1))
}

fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// gcd(x, y) in place, x of nx limbs and y of ny (normalized), each slice
/// with room for max(nx, ny) + 1 limbs and zero beyond its length.  The
/// gcd's slot (false: x, true: y) and length; the other slot holds 0.
pub fn gcd_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<(bool, usize), Fault> {
    let (mut a, mut b) = (x, y);
    let (mut na, mut nb) = (nx, ny);
    let mut swapped = false;
    loop {
        m.add(na + 2)?;
        if less(a, na, b, nb) {
            std::mem::swap(&mut a, &mut b);
            std::mem::swap(&mut na, &mut nb);
            swapped = !swapped;
        }
        if nb == 0 {
            return Ok((swapped, na));
        }
        if nb == 1 {
            m.add(2 * na + 93)?;
            let d = b[0];
            let mut r = 0u128;
            for i in (0..na).rev() {
                r = ((r << 64) | u128::from(a[i])) % u128::from(d);
            }
            let g = gcd_u64(d, r as u64);
            for v in &mut a[..na] {
                *v = 0;
            }
            a[0] = g;
            b[0] = 0;
            return Ok((swapped, 1));
        }
        // a >= b, nb >= 2: one Lehmer window, or a remainder
        let shift = (64 * na - a[na - 1].leading_zeros() as usize).saturating_sub(63);
        let (mut xh, mut yh) = (i128::from(window(a, na, shift)), i128::from(window(b, nb, shift)));
        let (mut ca, mut cb, mut cc, mut cd) = (1i128, 0i128, 0i128, 1i128);
        if na <= nb + 1 {
            m.add(LEHMER_STEPS as usize)?;
            for _ in 0..LEHMER_STEPS {
                // (Algorithm L's invariant keeps these positive; checked,
                // so a truncating division is a floor)
                if yh + cc <= 0 || yh + cd <= 0 || xh + ca < 0 || xh + cb < 0 {
                    break;
                }
                let q = (xh + ca) / (yh + cc);
                if q != (xh + cb) / (yh + cd) {
                    break;
                }
                (ca, cc) = (cc, ca - q * cc);
                (cb, cd) = (cd, cb - q * cd);
                (xh, yh) = (yh, xh - q * yh);
            }
        }
        if cb == 0 {
            na = rem_in_place(a, na, b, nb, m)?;
            continue;
        }
        m.add(3 * na)?;
        apply_window(a, b, na, [ca, cb, cc, cd])?;
        let n = na;
        na = norm(a, n);
        nb = norm(b, n);
    }
}

/// Algorithm L's bound on a window's cofactors [ca, cb, cc, cd], checked
/// before they are applied: each below 2^63 in size, and each row's two of
/// opposite signs (or zero), so that every i128 sum in [`apply_window`]
/// (two products below 2^127 in size and of opposite signs, plus a carry
/// below 2^64) is below 2^127 in size.
fn cofactors_fit(c: [i128; 4]) -> bool {
    const B: i128 = 1 << 63;
    c.iter().all(|&x| -B < x && x < B) && c[0].signum() * c[1].signum() <= 0 && c[2].signum() * c[3].signum() <= 0
}

/// (a, b) <- (ca a + cb b, cc a + cd b) over the first `na` limbs: the true
/// remainders, which are nonnegative (a final borrow is an invariant
/// failure).  Cofactors outside Algorithm L's bound are refused before
/// anything is written.
fn apply_window(a: &mut [u64], b: &mut [u64], na: usize, c: [i128; 4]) -> Result<(), Fault> {
    if !cofactors_fit(c) {
        return Err(Fault::Invariant);
    }
    let [ca, cb, cc, cd] = c;
    let (mut c1, mut c2) = (0i128, 0i128);
    for i in 0..na {
        let (ai, bi) = (i128::from(a[i]), i128::from(b[i]));
        let t1 = ca * ai + cb * bi + c1;
        let t2 = cc * ai + cd * bi + c2;
        a[i] = t1 as u64;
        b[i] = t2 as u64;
        c1 = t1 >> 64;
        c2 = t2 >> 64;
    }
    if c1 != 0 || c2 != 0 {
        return Err(Fault::Invariant);
    }
    Ok(())
}

/// Copy a wire integer's magnitude into a zeroed slot.
fn load(slot: &mut [u64], v: &BigRef, m: &mut Meter) -> Result<usize, Fault> {
    let k = v.limb_count();
    m.add(k + 1)?;
    for (i, w) in slot[..k].iter_mut().enumerate() {
        *w = v.limb(i);
    }
    Ok(k)
}

/// Zero the first `n` limbs of a slot.
fn clear(slot: &mut [u64], n: usize, m: &mut Meter) -> Result<(), Fault> {
    m.add(n + 1)?;
    for v in &mut slot[..n] {
        *v = 0;
    }
    Ok(())
}

fn is_one(s: &[u64], n: usize) -> bool {
    n == 1 && s[0] == 1
}

/// Whether gcd(n, d) = 1, in the workspace `ws` (zero, with slots of
/// `ws.len() / 2` limbs, at least each operand's limbs + 1); left zero.
pub fn coprime_pair(ws: &mut [u64], n: &BigRef, d: &BigRef, m: &mut Meter) -> Result<bool, Fault> {
    let half = ws.len() / 2;
    let (s0, s1) = ws.split_at_mut(half);
    let la = load(s0, n, m)?;
    let lb = load(s1, d, m)?;
    let room = la.max(lb) + 1;
    if room > half {
        return Err(Fault::Invariant);
    }
    let (slot, len) = gcd_in_place(s0, la, s1, lb, m)?;
    let one = if slot { is_one(s1, len) } else { is_one(s0, len) };
    clear(s0, room, m)?;
    clear(s1, room, m)?;
    Ok(one)
}

/// Whether gcd(d, n_1, ..., n_c) = 1 for an MQR1 row (`row`: d, then the
/// numerators): a running gcd in slot 0, each numerator loaded into slot 1,
/// stopping at 1.  The workspace is left zero.
pub fn coprime_row<'a>(ws: &mut [u64], row: impl Iterator<Item = BigRef<'a>>, m: &mut Meter) -> Result<bool, Fault> {
    let half = ws.len() / 2;
    let (s0, s1) = ws.split_at_mut(half);
    let mut row = row;
    let d = row.next().ok_or(Fault::Invariant)?;
    let mut lg = load(s0, &d, m)?;
    let mut dirty = lg + 1;
    for v in row {
        if is_one(s0, lg) {
            break;
        }
        if v.is_zero() {
            continue;
        }
        let ln = load(s1, &v, m)?;
        let room = lg.max(ln) + 1;
        if room > half {
            return Err(Fault::Invariant);
        }
        dirty = dirty.max(room);
        let (slot, len) = gcd_in_place(s0, lg, s1, ln, m)?;
        if slot {
            m.add(len + 1)?;
            s0[..len].copy_from_slice(&s1[..len]);
        }
        clear(s1, room, m)?;
        lg = len;
    }
    let one = is_one(s0, lg);
    clear(s0, dirty, m)?;
    Ok(one)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dashu_int::UBig;

    const H: u64 = 1 << 63;

    /// x mod y by rem_in_place against dashu, and the meter's count.
    fn rem(x: &[u64], y: &[u64]) {
        let (nx, ny) = (x.len(), y.len());
        let mut a = x.to_vec();
        a.push(0);
        let mut b = y.to_vec();
        let mut m = Meter::new(u64::MAX);
        let r = rem_in_place(&mut a, nx, &mut b, ny, &mut m).unwrap();
        let want = UBig::from_words(x) % UBig::from_words(y);
        assert_eq!(UBig::from_words(&a[..r]), want, "{:x?} mod {:x?}", x, y);
        assert!(a[r..].iter().all(|&w| w == 0));
        assert_eq!(b, y, "the divisor is restored");
        // the quotient loop's and the shifts' units, as gcd_work counts them
        let units = (nx + ny + 2) + (nx - ny + 1) * (2 * ny + 4) + (2 * ny + nx + 1);
        assert_eq!(m.used(), units as u64);
    }

    /// The cofactor guard: Algorithm L's bound holds at its edges, and a
    /// cofactor of size 2^63, or a row of equal signs, is refused before
    /// anything is written; a negative result is refused too.
    #[test]
    fn window_cofactors_out_of_bound_are_refused() {
        let b63 = 1i128 << 63;
        let (a0, b0) = (vec![u64::MAX, u64::MAX], vec![u64::MAX, u64::MAX - 1]);
        // at the bound: (2^63 - 1)(a - b) with a - b = 2^64 (little-endian
        // limbs), and the second row the identity on b
        let (mut a, mut b) = (a0.clone(), b0.clone());
        assert_eq!(apply_window(&mut a, &mut b, 2, [b63 - 1, -(b63 - 1), 0, 1]), Ok(()));
        assert_eq!((a, b), (vec![0, (b63 - 1) as u64], b0.clone()));
        for c in [[b63, -1, 0, 1], [1, -b63, 0, 1], [1, 0, -b63, 1], [1, 0, 0, b63], [1, 1, 0, 1], [1, 0, -1, -1], [-b63, 0, 0, 1]] {
            let (mut a, mut b) = (a0.clone(), b0.clone());
            assert_eq!(apply_window(&mut a, &mut b, 2, c), Err(Fault::Invariant), "{:?}", c);
            assert_eq!((a, b), (a0.clone(), b0.clone()), "{:?}: written before the refusal", c);
        }
        // in the bound, but a negative result (b - a with b < a): not a
        // remainder, so a final borrow is refused
        let (mut a, mut b) = (a0.clone(), b0.clone());
        assert_eq!(apply_window(&mut a, &mut b, 2, [1, 0, -1, 1]), Err(Fault::Invariant));
    }

    /// Knuth D's rare corrections: quotient digits estimated one or two
    /// too large, and the add back (D6), on the classic test patterns
    /// (Hacker's Delight's divmnu cases at 64-bit digits) and their
    /// neighbours.
    #[test]
    fn remainders_take_every_correction() {
        rem(&[0, 0, H, H - 1], &[1, 0, H]);
        rem(&[3, 0, H], &[1, 0, H >> 2]);
        rem(&[0, 0, H, H - 1], &[u64::MAX, 0, H]);
        rem(&[0, u64::MAX - 1, 0, H - 1], &[u64::MAX, 0, H]);
        rem(&[u64::MAX, u64::MAX, u64::MAX, u64::MAX], &[u64::MAX, u64::MAX]);
        rem(&[0, 0, 0, 1], &[1, 1]);
        rem(&[0, 7, 0, H], &[3, H]);
        rem(&[0x1234, 0, 0, H + 1], &[u64::MAX, H - 1, 2]);
        let mut seed = 0xdead_beef_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        // digits near 0, 2^63 and 2^64 - 1 make the estimates miss most
        let picks = [0, 1, H - 1, H, H + 1, u64::MAX - 1, u64::MAX];
        for _ in 0..20_000 {
            let nx = 2 + (next() % 5) as usize;
            let ny = 2 + (next() % (nx as u64 - 1)) as usize;
            let mut pick = || picks[(next() % 7) as usize];
            let mut x: Vec<u64> = (0..nx).map(|_| pick()).collect();
            let mut y: Vec<u64> = (0..ny).map(|_| pick()).collect();
            if x[nx - 1] == 0 {
                x[nx - 1] = 1;
            }
            if y[ny - 1] == 0 {
                y[ny - 1] = H;
            }
            if UBig::from_words(&x) >= UBig::from_words(&y) {
                rem(&x, &y);
            }
        }
    }
}
