//! Factoring polynomials over Z, in pure Rust (no FLINT), so that the
//! engines can find Galois orbits of newforms anywhere, WebAssembly included.
//!
//! factor(f) = content * prod g_i^e_i, the g_i irreducible, primitive, with
//! positive leading coefficients: the same contract as sagebrush-flint's
//! factor(), against which the tests check it.  The algorithm (von zur
//! Gathen and Gerhard, Modern Computer Algebra, ch. 14-15, and van Hoeij's
//! knapsack recombination):
//!   * the square-free decomposition (Yun), skipped when f is square-free
//!     modulo a prime;
//!   * for each square-free part, its factorization modulo a few small
//!     primes (distinct-degree, then Cantor-Zassenhaus), keeping the prime
//!     with the fewest factors; the factor degrees possible modulo every
//!     one of them often prove irreducibility outright;
//!   * Hensel lifting of those factors (a factor tree, quadratic steps) past
//!     twice the Mignotte bound times the leading coefficient;
//!   * recombination: Zassenhaus' subsets for few modular factors (r <= 8),
//!     else a pre-pass over subsets of sizes 1 and 2, then van Hoeij's
//!     lattice of CLD (logarithmic derivative) columns (vanhoeij.rs), with
//!     Zassenhaus as a budgeted fallback;
//!   * binomials x^k (a x^m + b) skip all of this: their factors come from
//!     cyclotomic polynomials, proved (binomial.rs).
//! Every call runs within one [`Budget`] (work and live memory, budget.rs):
//! exhausting it is the error [`FactorLimit`], never a partial answer.
//! Polynomials are coefficient vectors, constant term first.

use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::{BigInt, BigUint};
use std::ops::Deref;

mod binomial;
pub mod budget;
mod lll;
pub mod nf;
/// The recombination faults, for other crates' tests of how an internal
/// error reaches their surfaces (feature `test-faults`, dev-dependencies
/// only; rank-3 plan r3 section 4.3).
#[cfg(feature = "test-faults")]
pub mod test_faults {
    pub use crate::vanhoeij::fault::{reach, with, with_hooks, Reach, CORRUPT_CLD, FORCE_S0, INTERRUPT_AFTER_PASS2, S2_LAST_PASS, SKIP_PREPASS, STAGE1_EXIT, STAGE1_LOW_PREC, STAGE1_NO_CERT};
}
mod vanhoeij;

pub use budget::{with_default_limits, Budget, FactorLimit, Kind, Limits, MemorySource, Phase, INTERNAL_PREFIX};
use budget::{big_bytes, div_work, limbs, mul_work, poly_bytes, words_bytes, FResult, Reservation};

pub type ZPoly = Vec<BigInt>;

// ------------------------------------------------------------------ held polynomials

/// A polynomial whose memory is reserved in the call's budget for as long
/// as it lives (the reservation is made before the coefficients are
/// allocated, from a bound on their size).
pub(crate) struct Held<'b> {
    pub v: ZPoly,
    _r: Reservation<'b>,
}

impl Deref for Held<'_> {
    type Target = ZPoly;
    fn deref(&self) -> &ZPoly {
        &self.v
    }
}

impl<'b> Held<'b> {
    /// Reserve room for `len` coefficients of at most `bits` bits, then
    /// build them.
    pub fn build(b: &'b Budget, len: usize, bits: u64, f: impl FnOnce() -> ZPoly) -> FResult<Held<'b>> {
        let r = b.reserve(poly_bytes(len as u64, bits))?;
        let v = f();
        Ok(Held { v, _r: r })
    }
    /// A copy (reserved first).
    pub fn copy(b: &'b Budget, a: &[BigInt]) -> FResult<Held<'b>> {
        Held::build(b, a.len(), maxbits(a), || a.to_vec())
    }
    pub fn into_vec(self) -> ZPoly {
        self.v
    }
    /// The bytes reserved for it (the tests' ledger).
    #[cfg(test)]
    pub fn reserved(&self) -> u64 {
        self._r.bytes()
    }
}

/// A big integer whose memory is reserved in the call's budget for as long
/// as it lives (a p-adic modulus p^k: its size grows with the precision,
/// not the degree).
pub(crate) struct HeldInt<'b> {
    pub v: BigInt,
    _r: Reservation<'b>,
}

impl Deref for HeldInt<'_> {
    type Target = BigInt;
    fn deref(&self) -> &BigInt {
        &self.v
    }
}

/// p^k, reserved first: the power (at most k bitlen(p) bits) and, of the
/// same size, the two transients of its computation and two working
/// integers its users keep beside it (a leading coefficient mod p^k and its
/// inverse).  The exponent is a u64 (rank-3 plan r3, section 3.6): no
/// precision is cut off by its width, and one whose power can't be counted
/// in bytes is refused by the reservation, before anything is built.
pub(crate) fn power<'b>(b: &'b Budget, p: u64, k: u64) -> FResult<HeldInt<'b>> {
    let bits = k.checked_mul(64 - p.leading_zeros() as u64);
    let r = b.reserve(power_bytes(p, k))?;
    let l = limbs(bits.unwrap_or(u64::MAX));
    b.debit(l.checked_mul(l).and_then(|x| x.checked_mul(clog2(k) + 1)))?;
    Ok(HeldInt { v: pow_u64(&BigInt::from(p), k, 32), _r: r })
}

/// Bytes reserved by `power(p, k)`.
pub(crate) fn power_bytes(p: u64, k: u64) -> Option<u64> {
    k.checked_mul(64 - p.leading_zeros() as u64).and_then(big_bytes).and_then(|x| x.checked_mul(5))
}

/// x^k for a u64 exponent: BigInt::pow takes a u32, so with k = hi 2^s + lo
/// (lo < 2^s, s <= 32), x^k = (x^(2^s))^hi x^lo (s is 32 except in the test).
fn pow_u64(x: &BigInt, k: u64, s: u32) -> BigInt {
    if k >> s == 0 {
        return x.pow(k as u32);
    }
    // x^(2^s), by s squarings
    let mut y = x.clone();
    for _ in 0..s {
        y = &y * &y;
    }
    pow_u64(&y, k >> s, s) * x.pow((k & ((1u64 << s) - 1)) as u32)
}

/// Room for `count` transient integers of `bits` bits (an operation's
/// intermediate products, sums and quotients, freed when it returns).
pub(crate) fn transients(b: &Budget, count: u64, bits: u64) -> FResult<Reservation<'_>> {
    b.reserve(big_bytes(bits).and_then(|x| x.checked_mul(count)))
}

/// The largest bit length of the coefficients.
pub(crate) fn maxbits(a: &[BigInt]) -> u64 {
    a.iter().map(|c| c.bits()).max().unwrap_or(0)
}

/// ceil(log2(n)) for n >= 1 (0 for n <= 1).
pub(crate) fn clog2(n: u64) -> u64 {
    if n <= 1 {
        0
    } else {
        64 - (n - 1).leading_zeros() as u64
    }
}

// ------------------------------------------------------------------ Z[x]

fn trim(mut v: ZPoly) -> ZPoly {
    while v.last().map_or(false, |c| c.is_zero()) {
        v.pop();
    }
    v
}

/// v without its trailing zeros (no copy).
fn trimmed(v: &[BigInt]) -> &[BigInt] {
    let n = v.iter().rposition(|c| !c.is_zero()).map_or(0, |i| i + 1);
    &v[..n]
}

fn deg(v: &[BigInt]) -> usize {
    v.len().saturating_sub(1)
}

/// The content (gcd of the coefficients).
fn content(b: &Budget, v: &[BigInt]) -> FResult<BigInt> {
    let w: Option<u64> = v.iter().try_fold(0u64, |acc, c| acc.checked_add(limbs(c.bits()).checked_mul(limbs(c.bits()))?));
    b.debit(w)?;
    // the gcd's transients: a few integers of the largest coefficient's size
    let _t = b.reserve(big_bytes(maxbits(v)).and_then(|x| x.checked_mul(4)))?;
    let mut g = BigInt::zero();
    for c in v {
        g = g.gcd(c);
        if g.is_one() {
            break;
        }
    }
    Ok(g)
}

/// The primitive part, with a positive leading coefficient.
fn prim<'b>(b: &'b Budget, v: &[BigInt]) -> FResult<Held<'b>> {
    let v = trimmed(v);
    if v.is_empty() {
        return Held::copy(b, v);
    }
    // the result's room first, then the content
    let r = b.reserve(poly_bytes(v.len() as u64, maxbits(v)))?;
    let mut c = content(b, v)?;
    if v.last().unwrap().is_negative() {
        c = -c;
    }
    b.debit(div_work(v.len() as u64, maxbits(v), 1, c.bits()))?;
    Ok(Held { v: v.iter().map(|x| x / &c).collect(), _r: r })
}

fn derivative<'b>(b: &'b Budget, v: &[BigInt]) -> FResult<Held<'b>> {
    b.debit(mul_work(v.len() as u64, maxbits(v), 1, 64))?;
    let _t = transients(b, 2, maxbits(v) + 64)?;
    Held::build(b, v.len(), maxbits(v) + clog2(v.len() as u64 + 1), || {
        trim(v.iter().enumerate().skip(1).map(|(i, c)| c * BigInt::from(i)).collect())
    })
}

fn zsub<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt]) -> FResult<Held<'b>> {
    let n = x.len().max(y.len());
    b.debit(mul_work(n as u64, maxbits(x).max(maxbits(y)), 1, 64))?;
    let _t = transients(b, 3, maxbits(x).max(maxbits(y)) + 1)?;
    Held::build(b, n, maxbits(x).max(maxbits(y)) + 1, || {
        trim((0..n).map(|i| x.get(i).cloned().unwrap_or_default() - y.get(i).cloned().unwrap_or_default()).collect())
    })
}

/// Product in Z[x] (schoolbook): work and the result's room charged first.
fn zmul<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt]) -> FResult<Held<'b>> {
    if x.is_empty() || y.is_empty() {
        return Held::copy(b, &[]);
    }
    let (bx, by) = (maxbits(x), maxbits(y));
    b.debit(mul_work(x.len() as u64, bx, y.len() as u64, by))?;
    let bits = bx + by + clog2(x.len().min(y.len()) as u64) + 1;
    let _t = transients(b, 2, bits)?;
    Held::build(b, x.len() + y.len() - 1, bits, || {
        let mut r = vec![BigInt::zero(); x.len() + y.len() - 1];
        for (i, u) in x.iter().enumerate() {
            sagebrush_interrupt::check();
            if u.is_zero() {
                continue;
            }
            for (j, w) in y.iter().enumerate() {
                r[i + j] += u * w;
            }
        }
        trim(r)
    })
}

/// x / y when y divides x in Z[x], else None.  A quotient coefficient
/// larger than a factor of x can have (Mignotte) proves y does not divide
/// x, which bounds the working storage reserved first.
fn divexact<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt]) -> FResult<Option<Held<'b>>> {
    let (x, y) = (trimmed(x), trimmed(y));
    if y.is_empty() {
        return Ok(None);
    }
    if x.is_empty() {
        return Held::copy(b, &[]).map(Some);
    }
    if x.len() < y.len() {
        return Ok(None);
    }
    let lq = x.len() - y.len() + 1;
    // a factor q of x: |q|_inf <= 2^deg(q) |x|_2 <= 2^deg(q) sqrt(len x) |x|_inf
    let qbits = (lq as u64 - 1) + maxbits(x) + clog2(x.len() as u64) + 1;
    let wbits = maxbits(x).max(qbits + maxbits(y) + clog2(y.len() as u64) + 1) + 1;
    b.debit(div_work(x.len() as u64, wbits, y.len() as u64, maxbits(y)))?;
    // the working copy and the quotient, reserved before either exists
    let _work = b.reserve(poly_bytes(x.len() as u64, wbits).and_then(|w| w.checked_add(poly_bytes(lq as u64, qbits)?)))?;
    let _t = transients(b, 3, wbits + maxbits(y))?;
    let ly = y.last().unwrap().clone();
    let mut r = x.to_vec();
    let mut q = vec![BigInt::zero(); lq];
    for i in (0..lq).rev() {
        sagebrush_interrupt::check();
        let top = &r[i + y.len() - 1];
        if top.is_zero() {
            continue;
        }
        let (c, rem) = top.div_rem(&ly);
        if !rem.is_zero() || c.bits() > qbits {
            return Ok(None);
        }
        for (j, w) in y.iter().enumerate() {
            r[i + j] -= &c * w;
        }
        q[i] = c;
    }
    if r.iter().all(|c| c.is_zero()) {
        Held::build(b, lq, qbits, || trim(q)).map(Some)
    } else {
        Ok(None)
    }
}

/// The pseudo-remainder of x by y: each step multiplies by lc(y) and
/// subtracts, adding at most bits(y) + 1 bits, so the working storage is
/// bounded (and reserved) first.
fn prem<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt]) -> FResult<Held<'b>> {
    let x = trimmed(x);
    let steps = (x.len() + 1).saturating_sub(y.len()) as u64;
    let bits = maxbits(x) + steps * (maxbits(y) + 1) + 1;
    b.debit(mul_work(steps, bits, x.len() as u64, maxbits(y)))?;
    let held = b.reserve(poly_bytes(x.len() as u64, bits))?;
    let _t = transients(b, 3, bits + maxbits(y))?;
    let mut r = x.to_vec();
    let ly = y.last().unwrap().clone();
    while r.len() >= y.len() && !r.is_empty() {
        sagebrush_interrupt::check();
        let lr = r.last().unwrap().clone();
        let shift = r.len() - y.len();
        for c in r.iter_mut() {
            *c *= &ly;
        }
        for (j, w) in y.iter().enumerate() {
            r[shift + j] -= &lr * w;
        }
        r = trim(r);
    }
    Ok(Held { v: r, _r: held })
}

/// gcd in Z[x] (primitive, positive leading coefficient), by primitive
/// remainder sequences.
fn zgcd<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt]) -> FResult<Held<'b>> {
    let (mut x, mut y) = (prim(b, x)?, prim(b, y)?);
    if x.len() < y.len() {
        std::mem::swap(&mut x, &mut y);
    }
    while !y.is_empty() {
        let r = prim(b, &prem(b, &x, &y)?)?;
        x = y;
        y = r;
    }
    Ok(x)
}

// ------------------------------------------------------------------ F_p[x], p < 2^32

type FPoly = Vec<u64>;

fn ftrim(mut v: FPoly) -> FPoly {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

fn powmod_u(mut x: u64, mut e: u64, p: u64) -> u64 {
    let mut r = 1;
    x %= p;
    while e > 0 {
        if e & 1 == 1 {
            r = r * x % p;
        }
        x = x * x % p;
        e >>= 1;
    }
    r
}

fn finv(a: u64, p: u64) -> u64 {
    powmod_u(a, p - 2, p)
}

fn reduce_p(f: &[BigInt], p: u64) -> FPoly {
    let pb = BigInt::from(p);
    ftrim(f.iter().map(|c| c.mod_floor(&pb).to_u64().unwrap()).collect())
}

fn fsub(x: &[u64], y: &[u64], p: u64) -> FPoly {
    let n = x.len().max(y.len());
    ftrim((0..n).map(|i| (x.get(i).copied().unwrap_or(0) + p - y.get(i).copied().unwrap_or(0)) % p).collect())
}

fn fmul(b: &Budget, x: &[u64], y: &[u64], p: u64) -> FResult<FPoly> {
    if x.is_empty() || y.is_empty() {
        return Ok(vec![]);
    }
    b.debit(mul_work(x.len() as u64, 64, y.len() as u64, 64))?;
    let mut r = vec![0u64; x.len() + y.len() - 1];
    for (i, &u) in x.iter().enumerate() {
        if i % 256 == 0 {
            sagebrush_interrupt::check();
        }
        if u == 0 {
            continue;
        }
        for (j, &w) in y.iter().enumerate() {
            r[i + j] = (r[i + j] + u * w) % p;
        }
    }
    Ok(ftrim(r))
}

fn fdivrem(b: &Budget, x: &[u64], y: &[u64], p: u64) -> FResult<(FPoly, FPoly)> {
    let y = ftrim(y.to_vec());
    let mut r = ftrim(x.to_vec());
    if r.len() < y.len() {
        return Ok((vec![], r));
    }
    b.debit(div_work(r.len() as u64, 64, y.len() as u64, 64))?;
    let inv = finv(*y.last().unwrap(), p);
    let mut q = vec![0u64; r.len() - y.len() + 1];
    for i in (0..q.len()).rev() {
        if i % 256 == 0 {
            sagebrush_interrupt::check();
        }
        let c = r[i + y.len() - 1] * inv % p;
        q[i] = c;
        if c != 0 {
            for (j, &w) in y.iter().enumerate() {
                r[i + j] = (r[i + j] + p - c * w % p) % p;
            }
        }
    }
    Ok((ftrim(q), ftrim(r)))
}

fn frem(b: &Budget, x: &[u64], y: &[u64], p: u64) -> FResult<FPoly> {
    Ok(fdivrem(b, x, y, p)?.1)
}

fn fmonic(x: &[u64], p: u64) -> FPoly {
    let x = ftrim(x.to_vec());
    if x.is_empty() {
        return x;
    }
    let inv = finv(*x.last().unwrap(), p);
    x.iter().map(|&c| c * inv % p).collect()
}

fn fgcd(b: &Budget, x: &[u64], y: &[u64], p: u64) -> FResult<FPoly> {
    let (mut x, mut y) = (ftrim(x.to_vec()), ftrim(y.to_vec()));
    while !y.is_empty() {
        let r = frem(b, &x, &y, p)?;
        x = y;
        y = r;
    }
    Ok(fmonic(&x, p))
}

/// s, t with s x + t y = 1 (x, y coprime), deg s < deg y, deg t < deg x.
fn fxgcd(b: &Budget, x: &[u64], y: &[u64], p: u64) -> FResult<(FPoly, FPoly)> {
    let (mut r0, mut r1) = (ftrim(x.to_vec()), ftrim(y.to_vec()));
    let (mut s0, mut s1): (FPoly, FPoly) = (vec![1], vec![]);
    let (mut t0, mut t1): (FPoly, FPoly) = (vec![], vec![1]);
    while !r1.is_empty() {
        let (q, r) = fdivrem(b, &r0, &r1, p)?;
        let s2 = fsub(&s0, &fmul(b, &q, &s1, p)?, p);
        let t2 = fsub(&t0, &fmul(b, &q, &t1, p)?, p);
        r0 = r1;
        r1 = r;
        s0 = s1;
        s1 = s2;
        t0 = t1;
        t1 = t2;
    }
    // r0 is a nonzero constant: normalize to 1
    let inv = finv(r0[0], p);
    let s: FPoly = ftrim(s0.iter().map(|&c| c * inv % p).collect());
    let t: FPoly = ftrim(t0.iter().map(|&c| c * inv % p).collect());
    // reduce degrees: s = s mod y, t = t + (s div y) x
    let (q, s) = fdivrem(b, &s, y, p)?;
    let t = fsub(&t, &fmul(b, &fsub(&[], &q, p), x, p)?, p);
    Ok((s, t))
}

fn fpowmod(b: &Budget, base: &[u64], e: &BigUint, m: &[u64], p: u64) -> FResult<FPoly> {
    let mut r: FPoly = vec![1];
    let mut x = frem(b, base, m, p)?;
    for i in 0..e.bits() {
        if e.bit(i) {
            r = frem(b, &fmul(b, &r, &x, p)?, m, p)?;
        }
        x = frem(b, &fmul(b, &x, &x, p)?, m, p)?;
    }
    Ok(r)
}

// unbudgeted forms, for nf.rs (number field arithmetic, outside factor's budget)
fn fdivrem_u(x: &[u64], y: &[u64], p: u64) -> (FPoly, FPoly) {
    fdivrem(&Budget::unlimited(), x, y, p).expect("no limits")
}
fn fgcd_u(x: &[u64], y: &[u64], p: u64) -> FPoly {
    fgcd(&Budget::unlimited(), x, y, p).expect("no limits")
}
fn fmul_u(x: &[u64], y: &[u64], p: u64) -> FPoly {
    fmul(&Budget::unlimited(), x, y, p).expect("no limits")
}

fn fderivative(x: &[u64], p: u64) -> FPoly {
    ftrim(x.iter().enumerate().skip(1).map(|(i, &c)| c * (i as u64 % p) % p).collect())
}

/// Distinct-degree factorization of a monic square-free f: (product of the
/// irreducible factors of degree d, d).
fn ddf(b: &Budget, f: &[u64], p: u64) -> FResult<Vec<(FPoly, usize)>> {
    let mut out = vec![];
    let mut f = f.to_vec();
    let x: FPoly = vec![0, 1];
    let mut h = x.clone();
    let pb = BigUint::from(p);
    let mut d = 1;
    while 2 * d <= f.len() - 1 {
        h = fpowmod(b, &h, &pb, &f, p)?;
        let g = fgcd(b, &f, &fsub(&h, &x, p), p)?;
        if g.len() > 1 {
            f = fdivrem(b, &f, &g, p)?.0;
            h = frem(b, &h, &f, p)?;
            out.push((g, d));
        }
        d += 1;
    }
    if f.len() > 1 {
        let n = f.len() - 1;
        out.push((f, n));
    }
    Ok(out)
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// Cantor-Zassenhaus: the irreducible factors (of degree d each) of g, with
/// the trace map a + a^2 + ... + a^(2^(d-1)) in characteristic 2.  The
/// pending pieces are kept on a stack: they partition g, so they hold at
/// most deg(g) + (their number) words.
fn edf(b: &Budget, g: &[u64], d: usize, p: u64, rng: &mut Rng, out: &mut Vec<FPoly>) -> FResult<()> {
    let mut stack: Vec<FPoly> = vec![g.to_vec()];
    while let Some(g) = stack.pop() {
        let n = g.len() - 1;
        if n == d {
            out.push(g);
            continue;
        }
        loop {
            let a: FPoly = ftrim((0..n).map(|_| rng.next() % p).collect());
            if a.len() < 2 {
                b.debit(Some(n as u64))?;
                continue;
            }
            let s = if p == 2 {
                let mut t = a.clone();
                let mut s = a.clone();
                for _ in 1..d {
                    t = frem(b, &fmul(b, &t, &t, 2)?, &g, 2)?;
                    s = fsub(&s, &fsub(&[], &t, 2), 2); // s + t
                }
                s
            } else {
                // (p^d - 1) / 2: d bitlen(p) bits, reserved with its transients
                let _e = b.reserve(big_bytes((d as u64).saturating_mul(64 - p.leading_zeros() as u64)).and_then(|x| x.checked_mul(3)))?;
                let e = (BigUint::from(p).pow(d as u32) - 1u32) / 2u32;
                fsub(&fpowmod(b, &a, &e, &g, p)?, &[1], p)
            };
            let h = fgcd(b, &g, &s, p)?;
            if h.len() > 1 && h.len() < g.len() {
                let q = fdivrem(b, &g, &h, p)?.0;
                stack.push(fmonic(&q, p));
                stack.push(h);
                break;
            }
        }
    }
    Ok(())
}

/// Square-free decomposition of a monic f over F_p (Musser, with p-th
/// roots in characteristic p): (g, e) with f = prod g^e, g square-free.
fn sqf_mod(b: &Budget, f: &[u64], p: u64) -> FResult<Vec<(FPoly, u32)>> {
    let mut out = vec![];
    let c = fgcd(b, f, &fderivative(f, p), p)?;
    let mut w = fdivrem(b, f, &c, p)?.0;
    let mut c = c;
    let mut i = 1;
    while w.len() > 1 {
        let y = fgcd(b, &w, &c, p)?;
        let z = fdivrem(b, &w, &y, p)?.0;
        if z.len() > 1 {
            out.push((fmonic(&z, p), i));
        }
        i += 1;
        w = y;
        c = fdivrem(b, &c, &w, p)?.0;
    }
    if c.len() > 1 {
        // c is a p-th power: c(x) = r(x^p)
        let r: FPoly = c.iter().step_by(p as usize).copied().collect();
        for (g, e) in sqf_mod(b, &fmonic(&r, p), p)? {
            out.push((g, e * p as u32));
        }
    }
    Ok(out)
}

/// The memory of the modular phase for a polynomial of degree n: the
/// pieces (a partition: n + 1 words plus one per piece), the factors found
/// (the same), and at most 16 working polynomials of n + 1 words.
fn modular_bytes(n: usize) -> Option<u64> {
    words_bytes((n as u64 + 1).checked_mul(20)?)
}

/// The factorization of f modulo a prime p < 2^32: monic irreducible
/// factors (coefficients constant term first) with multiplicities, sorted
/// by degree then coefficients.  The leading coefficient must be a unit.
pub fn factor_mod(f: &[BigInt], p: u64) -> Vec<(Vec<u64>, u32)> {
    let b = Budget::unlimited();
    factor_mod_with(&b, f, p).expect("no limits")
}

fn factor_mod_with(b: &Budget, f: &[BigInt], p: u64) -> FResult<Vec<(Vec<u64>, u32)>> {
    assert!(p >= 2 && p < 1 << 32);
    let _p = b.enter(Phase::Modular);
    let _m = b.reserve(modular_bytes(f.len()))?;
    // (reducing a coefficient mod p makes a quotient of its size)
    let _t = transients(b, 2, maxbits(f))?;
    let fp = fmonic(&reduce_p(f, p), p);
    let mut rng = Rng(0x2545_F491_4F6C_DD1D ^ p);
    let mut out = vec![];
    for (g, e) in sqf_mod(b, &fp, p)? {
        for (h, d) in ddf(b, &g, p)? {
            let mut fs = vec![];
            edf(b, &h, d, p, &mut rng, &mut fs)?;
            out.extend(fs.into_iter().map(|q| (fmonic(&q, p), e)));
        }
    }
    out.sort_by(|x, y| x.0.len().cmp(&y.0.len()).then(x.0.cmp(&y.0)));
    Ok(out)
}

// ------------------------------------------------------------------ (Z/m)[x], Hensel lifting

pub(crate) fn mreduce<'b>(b: &'b Budget, x: &[BigInt], m: &BigInt) -> FResult<Held<'b>> {
    b.debit(div_work(x.len() as u64, maxbits(x), 1, m.bits()))?;
    let _t = transients(b, 3, maxbits(x).max(m.bits()) + 1)?;
    Held::build(b, x.len(), m.bits(), || trim(x.iter().map(|c| c.mod_floor(m)).collect()))
}

pub(crate) fn mmul<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt], m: &BigInt) -> FResult<Held<'b>> {
    mreduce(b, &zmul(b, x, y)?, m)
}

fn madd<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt], m: &BigInt) -> FResult<Held<'b>> {
    let n = x.len().max(y.len());
    b.debit(mul_work(n as u64, m.bits() + 1, 1, 64))?;
    let _t = transients(b, 3, maxbits(x).max(maxbits(y)) + 1)?;
    let s = Held::build(b, n, maxbits(x).max(maxbits(y)) + 1, || {
        (0..n).map(|i| x.get(i).cloned().unwrap_or_default() + y.get(i).cloned().unwrap_or_default()).collect()
    })?;
    mreduce(b, &s, m)
}

fn msub<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt], m: &BigInt) -> FResult<Held<'b>> {
    mreduce(b, &zsub(b, x, y)?, m)
}

/// Division by a monic y modulo m.
fn mdivrem<'b>(b: &'b Budget, x: &[BigInt], y: &[BigInt], m: &BigInt) -> FResult<(Held<'b>, Held<'b>)> {
    let mut r = mreduce(b, x, m)?;
    if r.len() < y.len() {
        return Ok((Held::copy(b, &[])?, r));
    }
    let mb = m.bits();
    b.debit(div_work(r.len() as u64, mb, y.len() as u64, mb))?;
    let _t = transients(b, 4, 2 * mb + maxbits(y) + 1)?;
    let lq = r.len() - y.len() + 1;
    let mut q = Held::build(b, lq, mb, || vec![BigInt::zero(); lq])?;
    for i in (0..lq).rev() {
        sagebrush_interrupt::check();
        let c = r.v[i + y.len() - 1].mod_floor(m);
        if !c.is_zero() {
            for (j, w) in y.iter().enumerate() {
                r.v[i + j] = (&r.v[i + j] - &c * w).mod_floor(m);
            }
        }
        q.v[i] = c;
    }
    q.v = trim(std::mem::take(&mut q.v));
    let r = mreduce(b, &r, m)?;
    Ok((q, r))
}

fn to_z<'b>(b: &'b Budget, x: &[u64]) -> FResult<Held<'b>> {
    Held::build(b, x.len(), 64, || x.iter().map(|&c| BigInt::from(c)).collect())
}

/// Lift f = u g h (mod p), u a unit mod p, g and h monic and coprime mod p,
/// to monic G, H with f = u G H (mod p^k): quadratic Hensel steps
/// (von zur Gathen-Gerhard, Algorithm 15.10).  f is given modulo p^k.
fn hensel_pair<'b>(b: &'b Budget, f: &[BigInt], g: &[u64], h: &[u64], p: u64, k: u64) -> FResult<(Held<'b>, Held<'b>)> {
    let pk = power(b, p, k)?;
    let u = f.last().unwrap().mod_floor(&pk);
    // work with G = u g so that f = G H
    let up = u.mod_floor(&BigInt::from(p)).to_u64().unwrap();
    let gu: FPoly = g.iter().map(|&x| x * up % p).collect();
    let (s0, t0) = fxgcd(b, &gu, h, p)?;
    let (mut gg, mut hh, mut s, mut t) = (to_z(b, &gu)?, to_z(b, h)?, to_z(b, &s0)?, to_z(b, &t0)?);
    let mut m = power(b, p, 1)?;
    let mut e_now = 1u64;
    while e_now < k {
        // the doubled precision, clipped to k (checked: a doubling past
        // u64::MAX is past k)
        let e_next = e_now.checked_mul(2).map_or(k, |e| e.min(k));
        let m2 = power(b, p, e_next)?;
        let e = msub(b, f, &mmul(b, &gg, &hh, &m2)?, &m2)?;
        let (q, r) = mdivrem(b, &mmul(b, &s, &e, &m2)?, &hh, &m2)?;
        let g2 = madd(b, &madd(b, &gg, &mmul(b, &t, &e, &m2)?, &m2)?, &mmul(b, &q, &gg, &m2)?, &m2)?;
        let h2 = madd(b, &hh, &r, &m2)?;
        let bb = msub(b, &madd(b, &mmul(b, &s, &g2, &m2)?, &mmul(b, &t, &h2, &m2)?, &m2)?, &[BigInt::one()], &m2)?;
        let (c, d) = mdivrem(b, &mmul(b, &s, &bb, &m2)?, &h2, &m2)?;
        s = msub(b, &s, &d, &m2)?;
        t = msub(b, &msub(b, &t, &mmul(b, &t, &bb, &m2)?, &m2)?, &mmul(b, &c, &g2, &m2)?, &m2)?;
        gg = g2;
        hh = h2;
        m = m2;
        e_now = e_next;
    }
    // G is u times the monic factor
    let uinv = u.modinv(&m).expect("leading coefficient invertible mod p");
    let gu = Held::build(b, gg.len(), 2 * m.bits(), || gg.iter().map(|c| c * &uinv).collect())?;
    let gmon = mreduce(b, &gu, &m)?;
    Ok((gmon, hh))
}

/// Lift the monic factors fs of f (mod p) to monic factors mod p^k, by a
/// factor tree.  f is given modulo p^k; its leading coefficient is a unit.
pub(crate) fn hensel<'b>(b: &'b Budget, f: &[BigInt], fs: &[FPoly], p: u64, k: u64) -> FResult<Vec<Held<'b>>> {
    let pk = power(b, p, k)?;
    if fs.len() == 1 {
        let u = f.last().unwrap().mod_floor(&pk);
        let uinv = u.modinv(&pk).unwrap();
        let fu = Held::build(b, f.len(), 2 * pk.bits(), || f.iter().map(|c| c * &uinv).collect())?;
        return Ok(vec![mreduce(b, &fu, &pk)?]);
    }
    let (x, y) = fs.split_at(fs.len() / 2);
    let prod = |v: &[FPoly]| -> FResult<FPoly> {
        let mut acc = vec![1u64];
        for w in v {
            acc = fmul(b, &acc, w, p)?;
        }
        Ok(acc)
    };
    let (g, h) = hensel_pair(b, f, &prod(x)?, &prod(y)?, p, k)?;
    let mut out = hensel(b, &g, x, p, k)?;
    drop(g);
    out.extend(hensel(b, &h, y, p, k)?);
    Ok(out)
}

// ------------------------------------------------------------------ the square-free case

fn small_primes() -> impl Iterator<Item = u64> {
    (3u64..).filter(|&n| (2..).take_while(|d| d * d <= n).all(|d| n % d != 0))
}

/// The symmetric representative of c modulo m.
pub(crate) fn symmetric(c: &BigInt, m: &BigInt) -> BigInt {
    let c = c.mod_floor(m);
    if c > m / 2 {
        c - m
    } else {
        c
    }
}

/// The modular data of a square-free part: the prime, its factors mod p,
/// the degrees possible for a factor over Q, and the lifting exponent.
pub(crate) struct Modular<'b> {
    /// The reservation of the data below, made before it was built.
    pub _r: Reservation<'b>,
    pub p: u64,
    pub modfs: Vec<FPoly>,
    pub possible: Vec<bool>,
    pub k: u64,
}

/// The exponent k with p^k > 2 |lc| 2^n (n + 1) |f|_inf (twice the
/// Mignotte bound for lc times a factor).
/// Computed from bit lengths, allocating nothing: 2 |lc| 2^n (n + 1)
/// |f|_inf < 2^B with B = bits(lc) + n + bits(n + 1) + bits(|f|_inf) + 1, and
/// p^k >= 2^(k floor(log2 p)) >= 2^B for k = ceil(B / floor(log2 p)).
pub(crate) fn mignotte_exponent(f: &[BigInt], p: u64) -> u64 {
    let n = deg(f) as u64;
    let lc = f.last().unwrap();
    let bb = lc.bits() + n + (64 - (n + 1).leading_zeros() as u64) + maxbits(f) + 1;
    let lp = 63 - p.leading_zeros() as u64; // floor(log2 p) >= 1 for p >= 3
    bb.div_ceil(lp).max(1)
}

/// Factor f modulo a few good primes; None when that proves f irreducible.
fn modular<'b>(b: &'b Budget, f: &[BigInt]) -> FResult<Option<Modular<'b>>> {
    let _p = b.enter(Phase::Modular);
    let n = deg(f);
    let lc = f.last().unwrap().clone();
    // what is returned: the factors mod p (n words in all, plus one vector
    // header each, at most n + 1) and the n + 1 degree flags
    let keep = b.reserve(words_bytes(3 * (n as u64 + 1)))?;
    let _m = b.reserve(modular_bytes(n).and_then(|x| x.checked_mul(2)))?;
    // (reducing a coefficient mod p makes a quotient of its size)
    let _t = transients(b, 2, maxbits(f))?;
    // keep the prime with the fewest factors, and the degrees possible for
    // a factor over Q modulo every one of them
    let mut best: Option<(u64, Vec<(FPoly, usize)>, usize)> = None;
    let mut possible = vec![true; n + 1];
    let mut tried = 0;
    for p in small_primes() {
        b.debit(Some(n as u64 + 1))?;
        if (&lc % BigInt::from(p)).is_zero() {
            continue;
        }
        let fp = reduce_p(f, p);
        if fp.len() != f.len() || fgcd(b, &fp, &fderivative(&fp, p), p)?.len() > 1 {
            continue;
        }
        let parts = ddf(b, &fmonic(&fp, p), p)?;
        let count: usize = parts.iter().map(|(g, d)| (g.len() - 1) / d).sum();
        // subset sums of the factor degrees
        b.debit((count as u64).checked_mul(n as u64 + 1))?;
        let mut sums = vec![false; n + 1];
        sums[0] = true;
        for (g, d) in &parts {
            for _ in 0..(g.len() - 1) / d {
                for s in (0..=n - d).rev() {
                    if sums[s] {
                        sums[s + d] = true;
                    }
                }
            }
        }
        for s in 0..=n {
            possible[s] &= sums[s];
        }
        if best.as_ref().map_or(true, |x| count < x.2) {
            best = Some((p, parts, count));
        }
        tried += 1;
        if count == 1 || (1..n).all(|s| !possible[s]) {
            return Ok(None); // irreducible
        }
        if tried >= 7 || (tried >= 3 && p > 3 * n as u64) {
            break;
        }
    }
    let (p, parts, _) = best.expect("a good prime");
    let mut rng = Rng(0x9E3779B97F4A7C15 ^ p);
    let mut modfs: Vec<FPoly> = vec![];
    for (g, d) in &parts {
        edf(b, g, *d, p, &mut rng, &mut modfs)?;
    }
    let k = mignotte_exponent(f, p);
    Ok(Some(Modular { _r: keep, p, modfs, possible, k }))
}

/// Lift the modular factors of f to p^k (within the call's budget).
pub(crate) fn lift<'b>(b: &'b Budget, f: &[BigInt], m: &Modular, k: u64) -> FResult<Vec<Held<'b>>> {
    let _p = b.enter(Phase::Hensel);
    // the F_p[x] temporaries of the factor tree (the products of each node's
    // halves and the Bezout pair: four of at most n + 1 words a level) and
    // a Hensel step's few
    let n = deg(f) as u64;
    let _w = b.reserve(words_bytes((4 * (clog2(m.modfs.len() as u64) + 1) + 8) * (n + 1)))?;
    let pk = power(b, m.p, k)?;
    let fk = mreduce(b, f, &pk)?;
    hensel(b, &fk, &m.modfs, m.p, k)
}

/// The irreducible factors of a primitive square-free f of degree >= 1
/// with positive leading coefficient.
fn factor_squarefree<'b>(b: &'b Budget, f: &[BigInt]) -> FResult<Vec<Held<'b>>> {
    if deg(f) <= 1 {
        return Ok(vec![Held::copy(b, f)?]);
    }
    let Some(m) = modular(b, f)? else {
        return Ok(vec![Held::copy(b, f)?]);
    };
    let lifted = lift(b, f, &m, m.k)?;
    let pk = power(b, m.p, m.k)?;
    if lifted.len() <= vanhoeij::ZASSENHAUS_MAX {
        let _p = b.enter(Phase::Zassenhaus);
        return Ok(zassenhaus(b, f, lifted, &pk, &m.possible, usize::MAX)?.found);
    }
    vanhoeij::recombine(b, f, &m, lifted)
}

/// The result of Zassenhaus' recombination: the factors proved irreducible,
/// and, when the subset sizes were limited before the search finished, the
/// unproved residual with its modular factors.
pub(crate) struct Zassenhaus<'b> {
    pub found: Vec<Held<'b>>,
    pub residual: Option<(Held<'b>, Vec<Held<'b>>)>,
}

/// Zassenhaus' recombination of the lifted monic factors, over subsets of
/// at most `max_size` factors (usize::MAX: all).  Sizes are tried in
/// increasing order, each exhausted before the next, so a factor found is
/// irreducible: a proper factor of it would have a smaller support.  When
/// 2 size exceeds the number of factors left, the residual is irreducible
/// too (its complement argument); when `max_size` stops the search first,
/// the residual is returned unproved, for the caller to finish.  Every
/// candidate is charged to the budget.
pub(crate) fn zassenhaus<'b>(
    b: &'b Budget,
    f: &[BigInt],
    lifted: Vec<Held<'b>>,
    pk: &BigInt,
    possible: &[bool],
    max_size: usize,
) -> FResult<Zassenhaus<'b>> {
    // the no-subset audit (rank-3 plan r3, section 4.2): a full search on a
    // residual with more than ZASSENHAUS_MAX factors must never run
    if max_size == usize::MAX && lifted.len() > vanhoeij::ZASSENHAUS_MAX {
        vanhoeij::fault::count(|c| c.full_subsets_large += 1);
    }
    let mut f = Held::copy(b, f)?;
    let mut rest: Vec<Held<'b>> = lifted;
    let mut found = vec![];
    let mut size = 1;
    let lpk = limbs(pk.bits());
    while 2 * size <= rest.len() {
        if size > max_size {
            return Ok(Zassenhaus { found, residual: Some((f, rest)) });
        }
        let mut hit = false;
        let lc = f.last().unwrap().clone();
        let f0 = f[0].clone();
        let r = rest.len();
        // subsets of `size` indices, in lexicographic order
        let mut idx: Vec<usize> = (0..size).collect();
        loop {
            b.take_subset()?;
            b.debit((size as u64).checked_mul(lpk).and_then(|x| x.checked_mul(lpk)).and_then(|x| x.checked_add(1)))?;
            let d: usize = idx.iter().map(|&i| rest[i].len() - 1).sum();
            if d < possible.len() && possible[d] {
                // constant term test: lc prod u_i(0) must divide lc f(0)
                let c0 = symmetric(&idx.iter().fold(lc.clone(), |acc, &i| (acc * &rest[i][0]).mod_floor(pk)), pk);
                let ok = f0.is_zero() || (!c0.is_zero() && ((&lc * &f0) % &c0).is_zero());
                if ok {
                    let g = reconstruct(b, &lc, idx.iter().map(|&i| &rest[i].v[..]), pk)?;
                    b.take_division()?;
                    if let Some(q) = divexact(b, &f, &g)? {
                        found.push(g);
                        f = prim(b, &q)?;
                        let mut keep = vec![];
                        for (i, v) in rest.into_iter().enumerate() {
                            if !idx.contains(&i) {
                                keep.push(v);
                            }
                        }
                        rest = keep;
                        hit = true;
                        break;
                    }
                }
            }
            // the next subset
            let mut i = size;
            while i > 0 && idx[i - 1] == r - size + i - 1 {
                i -= 1;
            }
            if i == 0 {
                break;
            }
            idx[i - 1] += 1;
            for j in i..size {
                idx[j] = idx[j - 1] + 1;
            }
        }
        if !hit {
            size += 1;
        }
    }
    if deg(&f) > 0 {
        found.push(f);
    }
    Ok(Zassenhaus { found, residual: None })
}

/// The candidate factor lc prod u_i, reduced symmetrically modulo pk, made
/// primitive with a positive leading coefficient.
pub(crate) fn reconstruct<'b, 'u>(b: &'b Budget, lc: &BigInt, us: impl Iterator<Item = &'u [BigInt]>, pk: &BigInt) -> FResult<Held<'b>> {
    let mut g = Held::build(b, 1, lc.bits(), || vec![lc.clone()])?;
    for u in us {
        g = mreduce(b, &zmul(b, &g, u)?, pk)?;
    }
    let gs = Held::build(b, g.len(), pk.bits(), || trim(g.iter().map(|c| symmetric(c, pk)).collect()))?;
    drop(g);
    prim(b, &gs)
}

// ------------------------------------------------------------------ the API

/// The admission of an input (plan r3, section 5.1), before anything is
/// copied.
fn admit(b: &Budget, f: &[BigInt]) -> FResult<()> {
    let _p = b.enter(Phase::Admission);
    let l = b.limits();
    let n = f.len().saturating_sub(1);
    if n > l.max_degree {
        return Err(b.refuse("degree", n as u64, l.max_degree as u64));
    }
    let mut total = 0u64;
    for c in f {
        let bits = c.bits();
        if bits > l.max_coeff_bits {
            return Err(b.refuse("coefficient bits", bits, l.max_coeff_bits));
        }
        total = total.saturating_add(bits);
    }
    if total > l.max_total_bits {
        return Err(b.refuse("total coefficient bits", total, l.max_total_bits));
    }
    Ok(())
}

/// Factors f (constant term first, f != 0) as content * prod g_i^e_i, the
/// g_i irreducible over Q, primitive, with positive leading coefficients;
/// the content carries the sign of f's leading coefficient.  Returns
/// (content, [(g_i, e_i)]) with the g_i sorted by degree, then coefficients
/// from the top.  Within the default limits (Limits::DEFAULT: only the
/// memory guard); a refusal is an error.
pub fn try_factor(f: &[BigInt]) -> Result<(BigInt, Vec<(ZPoly, u32)>), FactorLimit> {
    try_factor_with(f, &Budget::default())
}

/// As [`try_factor`], within the caller's budget (shared by every call
/// made with it: nested users pass one budget through all their calls).
pub fn try_factor_with(f: &[BigInt], b: &Budget) -> Result<(BigInt, Vec<(ZPoly, u32)>), FactorLimit> {
    admit(b, f)?;
    let f = Held::copy(b, trimmed(f))?;
    assert!(!f.is_empty(), "factor(0)");
    let _p = b.enter(Phase::Squarefree);
    let mut c = content(b, &f)?;
    if f.last().unwrap().is_negative() {
        c = -c;
    }
    let g = prim(b, &f)?;
    if deg(&g) == 0 {
        return Ok((c, vec![]));
    }
    // (the factors stay reserved until the call returns them)
    let mut held: Vec<(Held, u32)> = vec![];
    // binomials x^k (a x^m + b): from their cyclotomic structure
    if let Some(fs) = binomial::factor(b, &g)? {
        held = fs;
    } else {
        for (part, e) in squarefree_with(b, &g)? {
            for h in factor_squarefree(b, &part)? {
                held.push((h, e));
            }
        }
    }
    let _o = b.reserve(words_bytes(4 * held.len() as u64))?;
    let mut out: Vec<(ZPoly, u32)> = held.into_iter().map(|(h, e)| (h.into_vec(), e)).collect();
    out.sort_by(|x, y| x.0.len().cmp(&y.0.len()).then_with(|| x.0.iter().rev().cmp(y.0.iter().rev())));
    Ok((c, out))
}

/// [`try_factor`], panicking on a refusal (for tests and examples).
pub fn factor(f: &[BigInt]) -> (BigInt, Vec<(ZPoly, u32)>) {
    try_factor(f).unwrap_or_else(|e| panic!("{e}"))
}

/// Yun's square-free decomposition of a primitive f with positive leading
/// coefficient: [(a_i, i)], f = prod a_i^i, the a_i square-free, coprime.
pub fn squarefree(f: &[BigInt]) -> Vec<(ZPoly, u32)> {
    let b = Budget::unlimited();
    squarefree_with(&b, f).expect("no limits").into_iter().map(|(h, e)| (h.into_vec(), e)).collect()
}

fn squarefree_with<'b>(b: &'b Budget, f: &[BigInt]) -> FResult<Vec<(Held<'b>, u32)>> {
    let _p = b.enter(Phase::Squarefree);
    // square-free modulo a prime not dividing lc(f) deg(f): square-free.
    // Each try is O(n^2), the exact gcd below can take minutes, and a
    // polynomial with many factors (its discriminant divisible by every
    // small prime) can need primes past its degree: try 200.
    let lc = f.last().unwrap();
    {
        let _m = b.reserve(modular_bytes(f.len()))?;
        // (reducing a coefficient mod p makes a quotient of its size)
        let _t = transients(b, 2, maxbits(f))?;
        for p in small_primes().take(200) {
            b.debit(Some(f.len() as u64))?;
            if (lc % BigInt::from(p)).is_zero() || (deg(f) as u64) % p == 0 {
                continue;
            }
            let fp = reduce_p(f, p);
            if fp.len() == f.len() && fgcd(b, &fp, &fderivative(&fp, p), p)?.len() == 1 {
                return Ok(vec![(Held::copy(b, f)?, 1)]);
            }
        }
    }
    let df = derivative(b, f)?;
    let g = zgcd(b, f, &df)?;
    if deg(&g) == 0 {
        return Ok(vec![(Held::copy(b, f)?, 1)]);
    }
    let mut out = vec![];
    let mut c = divexact(b, f, &g)?.expect("gcd divides f");
    let mut d = zsub(b, &divexact(b, &df, &g)?.expect("gcd divides f'"), &derivative(b, &c)?)?;
    drop((df, g));
    let mut i = 1u32;
    while deg(&c) > 0 {
        let a = zgcd(b, &c, &d)?;
        c = divexact(b, &c, &a)?.expect("a divides c");
        d = zsub(b, &divexact(b, &d, &a)?.expect("a divides d"), &derivative(b, &c)?)?;
        if deg(&a) > 0 {
            out.push((a, i));
        }
        i += 1;
    }
    Ok(out)
}

/// Whether f is irreducible over Q (constants are not; the content is a
/// unit over Q: 2x + 2 is irreducible, the second review's R2-POL-F5).
/// Within the default limits.
pub fn try_is_irreducible(f: &[BigInt]) -> Result<bool, FactorLimit> {
    // (a constant or zero is not irreducible; factor(0) panicked: Astra's review)
    if f.len() < 2 || f.iter().all(|c| c.is_zero()) {
        return Ok(false);
    }
    let (_, fs) = try_factor(f)?;
    Ok(fs.len() == 1 && fs[0].1 == 1)
}

/// [`try_is_irreducible`], panicking on a refusal (for tests).
pub fn is_irreducible(f: &[BigInt]) -> bool {
    try_is_irreducible(f).unwrap_or_else(|e| panic!("{e}"))
}

#[cfg(test)]
mod tests;

/// The tests' allocation spy: bytes allocated by the current thread (so
/// parallel tests do not disturb each other), to check that refusals come
/// before the allocations they refuse.
#[cfg(test)]
pub(crate) mod alloc_spy {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    thread_local! {
        static BYTES: Cell<u64> = const { Cell::new(0) };
        static LIVE: Cell<i64> = const { Cell::new(0) };
        static PEAK: Cell<i64> = const { Cell::new(0) };
        // the ledger audit (rank-3 plan r3, section 4.5, delta 1 r2): this
        // thread's live bytes at its start (None: no audit running)
        static AUDIT: Cell<Option<i64>> = const { Cell::new(None) };
        static REPORT: Cell<Report> = const { Cell::new(Report::new()) };
        // the attribution: the current tag, every live tagged block, and
        // the live and reserved bytes of each tag
        static TAG: Cell<Option<&'static str>> = const { Cell::new(None) };
        static BLOCKS: RefCell<HashMap<usize, (&'static str, i64)>> = RefCell::new(HashMap::new());
        static TAGS: RefCell<HashMap<&'static str, (i64, i64)>> = RefCell::new(HashMap::new());
        // set while the spy's own bookkeeping runs (its maps allocate)
        static BUSY: Cell<bool> = const { Cell::new(false) };
    }

    /// What an audit found.
    #[derive(Clone, Copy, Debug)]
    pub struct Report {
        /// The largest excess of live bytes over the whole reservation at a
        /// debit or a reservation, and the phase it was in.
        pub excess: i64,
        pub excess_phase: &'static str,
        /// Checks where a tag's live bytes exceeded its reservation, and the
        /// first one: (tag, live, reserved, phase).
        pub tag_breaches: u64,
        pub first_breach: Option<(&'static str, i64, i64, &'static str)>,
    }

    impl Report {
        const fn new() -> Report {
            Report { excess: i64::MIN, excess_phase: "", tag_breaches: 0, first_breach: None }
        }
    }

    fn grow(n: i64) {
        let _ = LIVE.try_with(|l| {
            let v = l.get() + n;
            l.set(v);
            let _ = PEAK.try_with(|p| {
                if v > p.get() {
                    p.set(v)
                }
            });
        });
    }

    /// The spy's bookkeeping, while an audit runs, and not re-entered.
    fn book(f: impl FnOnce()) {
        if AUDIT.try_with(|a| a.get().is_none()).unwrap_or(true) {
            return;
        }
        let Ok(false) = BUSY.try_with(|b| b.replace(true)) else { return };
        f();
        let _ = BUSY.try_with(|b| b.set(false));
    }

    // (the allocator's paths use try_with: they also run while the
    // thread's locals are being destroyed)
    fn tag_live(t: &'static str, n: i64) {
        let _ = TAGS.try_with(|m| m.borrow_mut().entry(t).or_insert((0, 0)).0 += n);
    }

    fn current_tag() -> Option<&'static str> {
        TAG.try_with(|t| t.get()).ok().flatten()
    }

    fn on_alloc(p: *mut u8, size: usize) {
        book(|| {
            if let Some(t) = current_tag() {
                let _ = BLOCKS.try_with(|m| m.borrow_mut().insert(p as usize, (t, size as i64)));
                tag_live(t, size as i64);
            }
        });
    }

    fn on_free(p: *mut u8) -> Option<&'static str> {
        let mut out = None;
        book(|| {
            if let Some((t, n)) = BLOCKS.try_with(|m| m.borrow_mut().remove(&(p as usize))).ok().flatten() {
                tag_live(t, -n);
                out = Some(t);
            }
        });
        out
    }

    pub struct Spy;

    // SAFETY: every method forwards to `System` with the caller's own arguments,
    // so System's GlobalAlloc contract carries over; the tagging around it only
    // updates counters and the spy's own tables.  Tests only.
    #[allow(unsafe_code)]
    unsafe impl GlobalAlloc for Spy {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let _ = BYTES.try_with(|b| b.set(b.get() + l.size() as u64));
            grow(l.size() as i64);
            let p = System.alloc(l);
            on_alloc(p, l.size());
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            grow(-(l.size() as i64));
            on_free(p);
            System.dealloc(p, l)
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
            let _ = BYTES.try_with(|b| b.set(b.get() + n as u64));
            grow(n as i64 - l.size() as i64);
            // a tagged block keeps its tag; an untagged one takes the current
            let was = on_free(p);
            let q = System.realloc(p, l, n);
            book(|| {
                if let Some(t) = was.or(current_tag()) {
                    let _ = BLOCKS.try_with(|m| m.borrow_mut().insert(q as usize, (t, n as i64)));
                    tag_live(t, n as i64);
                }
            });
            q
        }
    }

    /// The current tag (Budget's `tag` guard); returns the previous one.
    pub fn set_tag(t: Option<&'static str>) -> Option<&'static str> {
        TAG.with(|c| c.replace(t))
    }

    /// A reservation of a tagged object made (n > 0) or released.
    pub fn tag_reserved(t: &'static str, n: i64) {
        book(|| TAGS.with(|m| m.borrow_mut().entry(t).or_insert((0, 0)).1 += n));
    }

    /// A debit or a reservation (`reserved`: the budget's live reservation),
    /// checked while an audit runs.
    pub fn audit_point(reserved: u64, phase: &'static str) {
        book(|| {
            let Some(base) = AUDIT.with(|a| a.get()) else { return };
            let mut r = REPORT.with(|r| r.get());
            let excess = LIVE.with(|l| l.get()) - base - reserved as i64;
            if excess > r.excess {
                r.excess = excess;
                r.excess_phase = phase;
            }
            TAGS.with(|m| {
                for (&t, &(live, res)) in m.borrow().iter() {
                    if live > res {
                        r.tag_breaches += 1;
                        r.first_breach.get_or_insert((t, live, res, phase));
                    }
                }
            });
            REPORT.with(|c| c.set(r));
        });
    }

    /// Run f under the audit (only this thread's allocations count).  The
    /// audit ends when f returns or unwinds (a failed assertion inside it).
    pub fn audit<T>(f: impl FnOnce() -> T) -> (T, Report) {
        struct End;
        impl Drop for End {
            fn drop(&mut self) {
                let _ = AUDIT.try_with(|a| a.set(None));
                let _ = TAG.try_with(|t| t.set(None));
            }
        }
        BLOCKS.with(|m| m.borrow_mut().clear());
        TAGS.with(|m| m.borrow_mut().clear());
        REPORT.with(|r| r.set(Report::new()));
        AUDIT.with(|a| a.set(Some(LIVE.with(|l| l.get()))));
        let end = End;
        let r = f();
        drop(end);
        (r, REPORT.with(|r| r.get()))
    }

    thread_local! {
        static REFUSED_AT: Cell<u64> = const { Cell::new(0) };
    }

    /// A memory refusal: this thread's allocated bytes at that moment.
    pub fn note_refusal() {
        let _ = REFUSED_AT.try_with(|r| r.set(allocated()));
    }

    /// The allocated bytes at the last memory refusal.
    pub fn refused_at() -> u64 {
        REFUSED_AT.with(|r| r.get())
    }

    /// Bytes allocated by this thread so far.
    pub fn allocated() -> u64 {
        BYTES.with(|b| b.get())
    }

    /// Run f; the peak of this thread's live bytes during it, above the
    /// live bytes at its start.
    pub fn peak_during<T>(f: impl FnOnce() -> T) -> (T, i64) {
        let start = LIVE.with(|l| l.get());
        PEAK.with(|p| p.set(start));
        let r = f();
        (r, PEAK.with(|p| p.get()) - start)
    }
}

#[cfg(test)]
#[global_allocator]
static SPY: alloc_spy::Spy = alloc_spy::Spy;
