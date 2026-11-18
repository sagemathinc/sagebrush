//! A rigorous proof that a basis is (eta, delta)-LLL-reduced, with eta =
//! 51/100 and delta = 99/100: the Gram-Schmidt data recomputed from the exact
//! Gram matrix (or from the rows) in interval arithmetic, every operation
//! rounded outward. `Proved` means the conditions hold for the exact values;
//! `Inconclusive` means the intervals were too wide (or a bound failed), and
//! the caller decides some other way (more precision, then `lll_cert`
//! exactly).
//!
//! Interval widths grow with the dimension (certifying LLL reducedness needs
//! a precision linear in it: Chang, Stehle and Villard, "Perturbation analysis
//! of the QR factor R in the context of LLL lattice basis reduction", Math.
//! Comp. 81 (2012); measured on the benchmark families, about 0.6 bits per
//! row), so there are rungs of increasing precision:
//! - `Iv`: doubles with a separate exponent (`Fe`), widened by one place per
//!   operation (each `Fe` operation rounds once, to nearest; exponent
//!   alignment is exact or loses less than the result's last place), a big
//!   integer entering as its top 63 bits rounded to a double: two places;
//! - `Mn<N>`: midpoint-radius intervals whose midpoint is an exact expansion
//!   of N doubles (built with error-free transformations only) and whose
//!   radius carries every error explicitly (N = 2, 3, 4: about 96, 149, 202
//!   bits);
//! - `Ip`: binary floats with a big-integer mantissa of p bits, rounded
//!   exactly toward minus or plus infinity (floor and ceiling); used by
//!   `l2_proof` only.
//!
//! The recurrences: mu_kj = r_kj / r_jj, r_kj = <b_k, b*_j> = G_kj - sum_{i<j}
//! mu_ji r_ki, and r_kk and the Lovasz quantity s_{k-1} = G_kk - sum_{i<k-1}
//! mu_ki r_ki (terms r_ki^2 / r_ii >= 0, which keeps their intervals narrow).

use crate::l2::Fe;
use num_integer::Integer;
use num_traits::{Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// The operations the proof needs from an interval type.
trait Interval: Clone {
    fn big(&self, x: &BigInt) -> Self;
    fn add(&self, o: &Self) -> Self;
    fn sub(&self, o: &Self) -> Self;
    fn mul(&self, o: &Self) -> Self;
    /// self / o when o > 0, else None
    fn div_pos(&self, o: &Self) -> Option<Self>;
    /// lower bound > 0
    fn positive(&self) -> bool;
    /// max |x| over the interval <= the lower bound of o
    fn abs_le_lo(&self, o: &Self) -> bool;
    /// upper bound <= the lower bound of o
    fn le(&self, o: &Self) -> bool;
    /// upper bound < the lower bound of o
    fn lt(&self, o: &Self) -> bool;
}

// --- doubles with exponent ---------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Iv {
    lo: Fe,
    hi: Fe,
}

fn down(x: Fe) -> Fe {
    x.with_mantissa(x.mantissa().next_down())
}

fn up(x: Fe) -> Fe {
    x.with_mantissa(x.mantissa().next_up())
}

fn fmin(a: Fe, b: Fe) -> Fe {
    if a.gt(b) { b } else { a }
}

fn fmax(a: Fe, b: Fe) -> Fe {
    if a.gt(b) { a } else { b }
}

impl Iv {
    /// An interval around the double nearest to the decimal x (0.51, 0.99
    /// are not doubles): one place each way.
    fn around(x: f64) -> Iv {
        let f = Fe::from_f64(x);
        Iv { lo: down(f), hi: up(f) }
    }

    fn hull(p: [Fe; 4]) -> Iv {
        let (mut lo, mut hi) = (p[0], p[0]);
        for &x in &p[1..] {
            lo = fmin(lo, x);
            hi = fmax(hi, x);
        }
        Iv { lo: down(lo), hi: up(hi) }
    }
}

impl Interval for Iv {
    fn big(&self, x: &BigInt) -> Iv {
        let f = Fe::from_big(x);
        if f.is_zero() {
            return Iv { lo: f, hi: f };
        }
        Iv { lo: down(down(f)), hi: up(up(f)) }
    }

    fn add(&self, o: &Iv) -> Iv {
        Iv { lo: down(self.lo.add(o.lo)), hi: up(self.hi.add(o.hi)) }
    }

    fn sub(&self, o: &Iv) -> Iv {
        Iv { lo: down(self.lo.sub(o.hi)), hi: up(self.hi.sub(o.lo)) }
    }

    fn mul(&self, o: &Iv) -> Iv {
        Iv::hull([self.lo.mul(o.lo), self.lo.mul(o.hi), self.hi.mul(o.lo), self.hi.mul(o.hi)])
    }

    fn div_pos(&self, o: &Iv) -> Option<Iv> {
        if !o.lo.gt(Fe::ZERO) {
            return None;
        }
        Some(Iv::hull([self.lo.div(o.lo), self.lo.div(o.hi), self.hi.div(o.lo), self.hi.div(o.hi)]))
    }

    fn positive(&self) -> bool {
        self.lo.gt(Fe::ZERO)
    }

    fn abs_le_lo(&self, o: &Iv) -> bool {
        !fmax(self.lo.abs(), self.hi.abs()).gt(o.lo)
    }

    fn le(&self, o: &Iv) -> bool {
        !self.hi.gt(o.lo)
    }

    fn lt(&self, o: &Iv) -> bool {
        o.lo.gt(self.hi)
    }
}

// --- error-free transformations -------------------------------------------------

#[inline]
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let z = s - a;
    (s, (a - (s - z)) + (b - z))
}

#[inline]
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    (p, a.mul_add(b, -p))
}

/// 2^k for k in the normal range.
#[inline]
fn p2(k: i64) -> f64 {
    f64::from_bits(((k + 1023) as u64) << 52)
}

fn fadd_up(a: Fe, b: Fe) -> Fe {
    up(a.add(b))
}

fn fmul_up(a: Fe, b: Fe) -> Fe {
    up(a.mul(b))
}

// --- multi-double midpoint-radius (N doubles) -----------------------------------

/// An expansion: the value is exactly (t[0] + ... + t[N-1]) 2^e. It is built
/// only with error-free transformations (`two_sum`, `two_prod`, exact
/// scalings by powers of two); whatever an operation leaves out (the terms
/// beyond N after renormalization, neglected high-order products, a
/// division's remainder) is returned as a bound and goes into the interval's
/// radius. So the radius alone carries every error, and how well the terms
/// are renormalized affects only the width, never the rigor. No published
/// error-bound constant enters: the bounds are elementary (`abs_sum_up`), and
/// a product of two small terms that underflows (two_prod is error-free only
/// above 2^-969) loses at most 2^-1074 each, covered by an absolute 2^-1000
/// (at the expansion's scale) in every product's and quotient's bound.
#[derive(Clone, Copy, Debug)]
struct Ex<const N: usize> {
    t: [f64; N],
    e: i64,
}

/// sum |v_i| as an upper bound (each f64 addition rounds to nearest: the
/// result times (1 + 2^-40) is above the exact sum for any length we use).
fn abs_sum_up(v: &[f64]) -> f64 {
    let s: f64 = v.iter().map(|x| x.abs()).sum();
    s * (1.0 + p2(-40))
}

/// Redistribute the exact sum of `v` so that the leading terms carry it
/// (bottom-up passes of two_sum; exact).
fn distill(v: &mut [f64], passes: usize) {
    let m = v.len();
    if m < 2 {
        return;
    }
    for _ in 0..passes {
        for i in (0..m - 1).rev() {
            let (s, e) = two_sum(v[i], v[i + 1]);
            v[i] = s;
            v[i + 1] = e;
        }
    }
}

/// A short list of exact terms on the stack (at most 40: a 4-double product
/// has 20, a remainder step at most 14).
#[derive(Clone, Copy)]
struct Buf {
    v: [f64; 40],
    n: usize,
}

impl Buf {
    fn new() -> Buf {
        Buf { v: [0.0; 40], n: 0 }
    }

    fn push(&mut self, x: f64) {
        self.v[self.n] = x;
        self.n += 1;
    }

    fn s(&self) -> &[f64] {
        &self.v[..self.n]
    }
}

/// The exact sum of `b` as up to `keep` leading terms plus a bound on the
/// rest: repeatedly distill and take the leading term (it carries the exact
/// sum of what remains, to about one rounding), so each further term is about
/// u times the previous one; two more terms are extracted and bounded with
/// whatever is left (exact: only error-free transformations are applied).
fn compress(b: &Buf, keep: usize) -> (Buf, f64) {
    let mut w = *b;
    let mut out = Buf::new();
    let mut extra = 0.0f64;
    let mut start = 0;
    let mut k = 0;
    while start < w.n && k < keep + 2 {
        distill(&mut w.v[start..w.n], 2);
        let lead = w.v[start];
        start += 1;
        if k < keep {
            out.push(lead);
        } else {
            extra += lead.abs();
        }
        k += 1;
    }
    let tail = (extra + abs_sum_up(&w.v[start..w.n])) * (1.0 + p2(-40));
    (out, tail)
}

impl<const N: usize> Ex<N> {
    fn is_zero(&self) -> bool {
        self.t.iter().all(|&x| x == 0.0)
    }

    /// From an exact list of terms at exponent e: compressed to N terms,
    /// normalized (|t0| in [0.5, 1)); the bound of what was cut (as Fe).
    fn from_terms(b: &Buf, e: i64) -> (Ex<N>, Fe) {
        let (kept, tail) = compress(b, N);
        let mut t = [0.0; N];
        for (i, x) in kept.s().iter().enumerate() {
            t[i] = *x;
        }
        let tail_fe = up(Fe::norm_pub(tail, e));
        if t[0] == 0.0 {
            if t.iter().all(|&x| x == 0.0) {
                return (Ex { t, e: 0 }, tail_fe);
            }
            // the leading term cancelled: restart from the others
            let mut w = Buf::new();
            for &x in t.iter().filter(|&&x| x != 0.0) {
                w.push(x);
            }
            let (x, bd) = Ex::from_terms(&w, e);
            return (x, fadd_up(bd, tail_fe));
        }
        let ex = ((t[0].to_bits() >> 52) & 0x7ff) as i64;
        let k = ex - 1022; // t0 2^-k in [0.5, 1)
        // scale every term by 2^-k; a term that would leave the normal range
        // is moved into the bound instead (it is below 2^-900 of t0)
        let mut extra = 0.0f64;
        for x in t.iter_mut() {
            if *x == 0.0 {
                continue;
            }
            let xe = ((x.to_bits() >> 52) & 0x7ff) as i64 - 1023;
            if xe - k < -1000 {
                extra += x.abs();
                *x = 0.0;
            } else {
                *x *= p2(-k);
            }
        }
        let bd = if extra > 0.0 { fadd_up(tail_fe, up(Fe::norm_pub(extra * 2.0, e))) } else { tail_fe };
        (Ex { t, e: e + k }, bd)
    }

    fn from_big(x: &BigInt) -> (Ex<N>, Fe) {
        // the top 53 N bits, in N exact 53-bit chunks; the rest bounded
        let b = x.bits();
        let keep = 53 * N as u64;
        let (top, sh) = if b > keep { (x >> ((b - keep) as usize), b - keep) } else { (x.clone(), 0) };
        let neg = top.is_negative();
        let mut t = top.abs();
        // chunk k (k = 0 the lowest 53 bits) weighs 2^(53 k); as terms at
        // exponent 53 (N - 1): chunk k becomes c_k 2^(53 (k - N + 1)), exact
        let mut v = [0.0; N];
        for k in 0..N {
            let c = &t - ((&t >> 53usize) << 53usize);
            v[N - 1 - k] = c.to_f64().unwrap() * p2(53 * (k as i64 - N as i64 + 1));
            t = t >> 53usize;
        }
        let mut w = Buf::new();
        for x in v {
            w.push(if neg { -x } else { x });
        }
        // largest first; value = sum v_i 2^(53 (N - 1) + sh)
        let (ex, bnd) = Ex::from_terms(&w, sh as i64 + 53 * (N as i64 - 1));
        let cut = if b > keep { up(Fe::norm_pub(2.0, sh as i64)) } else { Fe::ZERO };
        (ex, fadd_up(bnd, cut))
    }

    fn neg(&self) -> Ex<N> {
        let mut t = self.t;
        for x in t.iter_mut() {
            *x = -*x;
        }
        Ex { t, e: self.e }
    }

    fn add(&self, o: &Ex<N>) -> (Ex<N>, Fe) {
        if self.is_zero() {
            return (*o, Fe::ZERO);
        }
        if o.is_zero() {
            return (*self, Fe::ZERO);
        }
        let (a, b) = if self.e >= o.e { (self, o) } else { (o, self) };
        let d = b.e - a.e;
        if d < -900 {
            // b is below a's last term by far: bounded, not added
            return (*a, up(Fe::norm_pub(abs_sum_up(&b.t), b.e)));
        }
        let sc = p2(d);
        let mut w = Buf::new();
        for &x in &a.t {
            w.push(x);
        }
        let mut extra = 0.0f64;
        for &x in &b.t {
            if x == 0.0 {
                continue;
            }
            let xe = ((x.to_bits() >> 52) & 0x7ff) as i64 - 1023;
            if xe + d < -1000 {
                extra += x.abs();
            } else {
                w.push(x * sc);
            }
        }
        let (r, bnd) = Ex::from_terms(&w, a.e);
        let bnd = if extra > 0.0 { fadd_up(bnd, up(Fe::norm_pub(extra * 2.0, b.e))) } else { bnd };
        (r, bnd)
    }

    fn mul(&self, o: &Ex<N>) -> (Ex<N>, Fe) {
        let mut w = Buf::new();
        let mut neglected = 0.0f64;
        for i in 0..N {
            for j in 0..N {
                if i + j < N {
                    let (p, q) = two_prod(self.t[i], o.t[j]);
                    w.push(p);
                    w.push(q);
                } else {
                    neglected += (self.t[i] * o.t[j]).abs();
                }
            }
        }
        let e = self.e + o.e;
        let (r, bnd) = Ex::from_terms(&w, e);
        // (plus what underflowing products lost, below 2^-1074 each)
        (r, fadd_up(fadd_up(bnd, up(Fe::norm_pub(neglected * (1.0 + p2(-40)), e))), Fe::norm_pub(1.0, e - 1000)))
    }

    /// self / o (o != 0): N quotient digits by exact remainders; the bound
    /// |rem| / |o| (|o| from below).
    fn div(&self, o: &Ex<N>) -> Option<(Ex<N>, Fe)> {
        let olo = o.t[0].abs() - abs_sum_up(&o.t[1..]);
        if !(olo > 0.0) {
            return None;
        }
        let mut rem = Buf::new();
        for &x in &self.t {
            rem.push(x);
        }
        let mut q = Buf::new();
        let mut dropped = 0.0f64;
        for _ in 0..N {
            // the remainder compressed to N + 2 leading terms (what is cut is
            // about u^(N+2) of it, and bounded)
            let (r, cut) = compress(&rem, N + 2);
            rem = r;
            dropped += cut;
            if rem.n == 0 || rem.v[0] == 0.0 {
                break;
            }
            let qk = rem.v[0] / o.t[0];
            q.push(qk);
            for &y in &o.t {
                let (p, s) = two_prod(qk, y);
                rem.push(-p);
                rem.push(-s);
            }
        }
        let (r, cut) = compress(&rem, N + 2);
        rem = r;
        dropped += cut;
        // self = q o + rem exactly (up to `dropped`): |self/o - q| <= (|rem| + dropped) / |o|
        let rr = (abs_sum_up(rem.s()) + dropped) * (1.0 + p2(-40)) / olo * (1.0 + p2(-40));
        if q.n == 0 {
            q.push(0.0);
        }
        let (qx, bnd) = Ex::from_terms(&q, self.e - o.e);
        // (the remainder steps' products may underflow too: at most an
        // absolute 2^-1000 at the dividend's scale, so 2^-1000 / olo in the
        // quotient, olo ~ 0.5 as o's leading term is in [0.5, 1))
        let uf = Fe::norm_pub(p2(-1000) / olo * (1.0 + p2(-40)), self.e - o.e);
        Some((qx, fadd_up(fadd_up(bnd, up(Fe::norm_pub(rr, self.e - o.e))), up(uf))))
    }

    /// lower / upper bounds of the value as doubles with exponent
    fn lo(&self) -> Fe {
        let rest = abs_sum_up(&self.t[1..]);
        down(down(Fe::norm_pub(self.t[0] - rest, self.e)))
    }

    fn hi(&self) -> Fe {
        let rest = abs_sum_up(&self.t[1..]);
        up(up(Fe::norm_pub(self.t[0] + rest, self.e)))
    }

    fn abs_up(&self) -> Fe {
        let rest = abs_sum_up(&self.t[1..]);
        up(up(Fe::norm_pub(self.t[0].abs() + rest, self.e)))
    }
}

/// The exact value lies in [m - r, m + r], m an N-double expansion, r a
/// double with exponent rounded up after every operation.
#[derive(Clone, Copy, Debug)]
struct Mn<const N: usize> {
    m: Ex<N>,
    r: Fe,
}

impl<const N: usize> Mn<N> {
    fn ratio(n: i64, d: i64) -> Mn<N> {
        let (a, ra) = Ex::<N>::from_big(&BigInt::from(n));
        let (b, rb) = Ex::<N>::from_big(&BigInt::from(d));
        let x = Mn { m: a, r: ra };
        let y = Mn { m: b, r: rb };
        if n == 0 {
            return x;
        }
        x.div_pos(&y).expect("a positive denominator")
    }

    fn lo_down(&self) -> Fe {
        down(self.m.lo().sub(self.r))
    }

    fn hi_up(&self) -> Fe {
        up(self.m.hi().add(self.r))
    }
}

impl<const N: usize> Interval for Mn<N> {
    fn big(&self, x: &BigInt) -> Mn<N> {
        let (m, r) = Ex::from_big(x);
        Mn { m, r }
    }

    fn add(&self, o: &Mn<N>) -> Mn<N> {
        let (m, t) = self.m.add(&o.m);
        Mn { m, r: fadd_up(fadd_up(self.r, o.r), t) }
    }

    fn sub(&self, o: &Mn<N>) -> Mn<N> {
        let (m, t) = self.m.add(&o.m.neg());
        Mn { m, r: fadd_up(fadd_up(self.r, o.r), t) }
    }

    fn mul(&self, o: &Mn<N>) -> Mn<N> {
        let (m, t) = self.m.mul(&o.m);
        let (a, b) = (self.m.abs_up(), o.m.abs_up());
        let r = fadd_up(fadd_up(fmul_up(a, o.r), fmul_up(self.r, b)), fadd_up(fmul_up(self.r, o.r), t));
        Mn { m, r }
    }

    fn div_pos(&self, o: &Mn<N>) -> Option<Mn<N>> {
        // y >= y_min = m2 - r2 > 0; |x/y - m1/m2| <= (r1 + |m1/m2| r2) / y_min,
        // and |m1/m2 - m| <= t
        let ymin = o.lo_down();
        if !ymin.gt(Fe::ZERO) {
            return None;
        }
        let (m, t) = self.m.div(&o.m)?;
        let q = fadd_up(m.abs_up(), t);
        let num = fadd_up(self.r, fmul_up(q, o.r));
        let r = fadd_up(up(num.div(ymin)), t);
        Some(Mn { m, r })
    }

    fn positive(&self) -> bool {
        self.lo_down().gt(Fe::ZERO)
    }

    fn abs_le_lo(&self, o: &Mn<N>) -> bool {
        let a = fadd_up(self.m.abs_up(), self.r);
        !a.gt(o.lo_down())
    }

    fn le(&self, o: &Mn<N>) -> bool {
        !self.hi_up().gt(o.lo_down())
    }

    fn lt(&self, o: &Mn<N>) -> bool {
        o.lo_down().gt(self.hi_up())
    }
}

/// The proof with N-double intervals from an exact Gram matrix.
fn verify_mn<const N: usize>(g: &[Vec<BigInt>]) -> Verdict {
    let z = Mn::<N>::ratio(0, 1);
    verify_with(g, &z, &Mn::<N>::ratio(51, 100), &Mn::<N>::ratio(99, 100))
}

/// Whether an N-double rung can still prove a d-row basis: its interval
/// widths grow about 0.6 bits per row (measured on the benchmark families),
/// so a rung whose precision (53 N bits less ~10 lost to rounding) is below
/// 0.45 d is skipped as hopeless.
fn rung_hopeful(n_limbs: usize, d: usize) -> bool {
    (53 * n_limbs) as f64 - 10.0 >= 0.45 * d as f64
}

// --- big-integer mantissa, p bits ---------------------------------------------

/// m 2^e, |m| < 2^p.
#[derive(Clone, Debug)]
struct Bf {
    m: BigInt,
    e: i64,
}

/// m 2^e rounded to p bits, down (floor) or up (ceiling).
fn round(m: BigInt, e: i64, p: u64, up: bool) -> Bf {
    let b = m.bits();
    if b <= p {
        return Bf { m, e };
    }
    let sh = (b - p) as usize;
    let q = if up { -((-m) >> sh) } else { m >> sh };
    Bf { m: q, e: e + sh as i64 }
}

/// x + y exactly, or with y replaced by a sticky unit of the same sign far
/// below x's last place when y is that small (rounding to p bits then gives
/// the same directed result); the exponent of the result is returned too.
fn sum_exact(x: &Bf, y: &Bf, p: u64) -> (BigInt, i64) {
    if y.m.is_zero() {
        return (x.m.clone(), x.e);
    }
    if x.m.is_zero() {
        return (y.m.clone(), y.e);
    }
    let (a, b) = if x.e >= y.e { (x, y) } else { (y, x) };
    let diff = (a.e - b.e) as u64;
    if diff > b.m.bits() + p + 64 && a.m.bits() + diff > b.m.bits() + 2 * p + 64 {
        let s = (p + 64) as usize;
        let sticky = if b.m.is_negative() { BigInt::from(-1) } else { BigInt::from(1) };
        return ((&a.m << s) + sticky, a.e - s as i64);
    }
    ((&a.m << diff as usize) + &b.m, b.e)
}

impl Bf {
    fn neg(&self) -> Bf {
        Bf { m: -self.m.clone(), e: self.e }
    }

    fn sign(&self) -> i32 {
        if self.m.is_zero() {
            0
        } else if self.m.is_negative() {
            -1
        } else {
            1
        }
    }

    fn gt(&self, o: &Bf) -> bool {
        let (m, _) = sum_exact(self, &o.neg(), 1);
        m.is_positive()
    }

    fn abs(&self) -> Bf {
        Bf { m: self.m.abs(), e: self.e }
    }

    fn add(&self, o: &Bf, p: u64, up: bool) -> Bf {
        let (m, e) = sum_exact(self, o, p);
        round(m, e, p, up)
    }

    fn mul(&self, o: &Bf, p: u64, up: bool) -> Bf {
        round(&self.m * &o.m, self.e + o.e, p, up)
    }

    /// self / o (o != 0), rounded.
    fn div(&self, o: &Bf, p: u64, up: bool) -> Bf {
        if self.m.is_zero() {
            return Bf { m: BigInt::zero(), e: 0 };
        }
        let s = (p + o.m.bits() + 2).saturating_sub(self.m.bits()) as usize;
        let num = &self.m << s;
        // floor or ceiling of num / o.m (signs handled by the floor division)
        let q = if up { -((-num).div_floor(&o.m)) } else { num.div_floor(&o.m) };
        round(q, self.e - o.e - s as i64, p, up)
    }
}

#[derive(Clone, Debug)]
struct Ip {
    lo: Bf,
    hi: Bf,
    p: u64,
}

impl Ip {
    fn ratio(n: i64, d: i64, p: u64) -> Ip {
        let (a, b) = (Bf { m: BigInt::from(n), e: 0 }, Bf { m: BigInt::from(d), e: 0 });
        Ip { lo: a.div(&b, p, false), hi: a.div(&b, p, true), p }
    }

    fn hull(p: u64, lo: [Bf; 4], hi: [Bf; 4]) -> Ip {
        let mut l = lo[0].clone();
        for x in &lo[1..] {
            if l.gt(x) {
                l = x.clone();
            }
        }
        let mut h = hi[0].clone();
        for x in &hi[1..] {
            if x.gt(&h) {
                h = x.clone();
            }
        }
        Ip { lo: l, hi: h, p }
    }
}

impl Interval for Ip {
    fn big(&self, x: &BigInt) -> Ip {
        let p = self.p;
        Ip { lo: round(x.clone(), 0, p, false), hi: round(x.clone(), 0, p, true), p }
    }

    fn add(&self, o: &Ip) -> Ip {
        let p = self.p;
        Ip { lo: self.lo.add(&o.lo, p, false), hi: self.hi.add(&o.hi, p, true), p }
    }

    fn sub(&self, o: &Ip) -> Ip {
        let p = self.p;
        Ip { lo: self.lo.add(&o.hi.neg(), p, false), hi: self.hi.add(&o.lo.neg(), p, true), p }
    }

    fn mul(&self, o: &Ip) -> Ip {
        let p = self.p;
        let pairs = [(&self.lo, &o.lo), (&self.lo, &o.hi), (&self.hi, &o.lo), (&self.hi, &o.hi)];
        Ip::hull(p, pairs.map(|(a, b)| a.mul(b, p, false)), pairs.map(|(a, b)| a.mul(b, p, true)))
    }

    fn div_pos(&self, o: &Ip) -> Option<Ip> {
        if o.lo.sign() <= 0 {
            return None;
        }
        let p = self.p;
        let pairs = [(&self.lo, &o.lo), (&self.lo, &o.hi), (&self.hi, &o.lo), (&self.hi, &o.hi)];
        Some(Ip::hull(p, pairs.map(|(a, b)| a.div(b, p, false)), pairs.map(|(a, b)| a.div(b, p, true))))
    }

    fn positive(&self) -> bool {
        self.lo.sign() > 0
    }

    fn abs_le_lo(&self, o: &Ip) -> bool {
        let (a, b) = (self.lo.abs(), self.hi.abs());
        let m = if a.gt(&b) { a } else { b };
        !m.gt(&o.lo)
    }

    fn le(&self, o: &Ip) -> bool {
        !self.hi.gt(&o.lo)
    }

    fn lt(&self, o: &Ip) -> bool {
        o.lo.gt(&self.hi)
    }
}

// --- the proof -----------------------------------------------------------------

/// The verdict.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Proved,
    Inconclusive,
}

fn verify_with<I: Interval>(g: &[Vec<BigInt>], z: &I, eta: &I, delta: &I) -> Verdict {
    let gram = |i: usize, j: usize| if j <= i { z.big(&g[i][j]) } else { z.big(&g[j][i]) };
    verify_gram_iv(g.len(), gram, eta, delta)
}

/// The proof from the Gram entries as intervals (`gram(k, j)`, j <= k).
fn verify_gram_iv<I: Interval>(d: usize, gram: impl Fn(usize, usize) -> I, eta: &I, delta: &I) -> Verdict {
    // r[k][j] = <b_k, b*_j> (j <= k) and mu[k][j] = r_kj / r_jj (j < k), each
    // quotient computed once: r_kj = G_kj - sum_{i<j} mu_ji r_ki, and
    // r_kk = G_kk - sum_{i<k} mu_ki r_ki (the terms r_ki^2 / r_ii >= 0)
    let mut r: Vec<Vec<I>> = vec![vec![]; d];
    let mut mu: Vec<Vec<I>> = vec![vec![]; d];
    for k in 0..d {
        let mut s_last = gram(k, k);
        for j in 0..=k {
            let mut s = gram(k, j);
            if j < k {
                for i in 0..j {
                    s = s.sub(&mu[j][i].mul(&r[k][i]));
                }
                // |mu_kj| = |r_kj| / r_jj <= eta for the exact value
                let Some(m) = s.div_pos(&r[j][j]) else {
                    return Verdict::Inconclusive;
                };
                if !m.abs_le_lo(eta) {
                    return Verdict::Inconclusive;
                }
                mu[k].push(m);
            } else {
                for i in 0..k {
                    if i + 1 == k {
                        s_last = s.clone();
                    }
                    s = s.sub(&mu[k][i].mul(&r[k][i]));
                }
                if !s.positive() {
                    return Verdict::Inconclusive;
                }
            }
            r[k].push(s);
        }
        // Lovasz: delta r_{k-1,k-1} <= s_{k-1}
        if k > 0 && !delta.mul(&r[k - 1][k - 1]).le(&s_last) {
            return Verdict::Inconclusive;
        }
    }
    Verdict::Proved
}

// --- the lattice cut ------------------------------------------------------------
//
// A cut keeps the rows before the trailing ones whose Gram-Schmidt norm is
// above a bound: it needs |b*_k|^2 > t decided for each k, not a proof that
// the rows are reduced. The same interval Gram-Schmidt as the proof above,
// without its size and Lovasz conditions, encloses each |b*_k|^2 = r_kk.

/// For each row k of the rows with exact Gram matrix `g` (`g[k][j]`, j <= k),
/// whether |b*_k|^2 > t: Some(true) when the enclosure of r_kk lies above
/// t, Some(false) when it lies at or below t (an equality only so), None
/// when it straddles t, or when a pivot's enclosure lost positivity at or
/// before row k. With 53-bit intervals when `p` is None, else with p-bit
/// ones.
pub(crate) fn gso_vs(g: &[Vec<BigInt>], t: &BigInt, p: Option<u64>) -> Vec<Option<bool>> {
    match p {
        None => gso_vs_with(g, t, &Iv::around(0.0)),
        Some(p) => gso_vs_with(g, t, &Ip::ratio(0, 1, p)),
    }
}

fn gso_vs_with<I: Interval>(g: &[Vec<BigInt>], t: &BigInt, z: &I) -> Vec<Option<bool>> {
    let d = g.len();
    let t = z.big(t);
    let mut r: Vec<Vec<I>> = vec![vec![]; d];
    let mut mu: Vec<Vec<I>> = vec![vec![]; d];
    let mut out = vec![None; d];
    for k in 0..d {
        // r_kj = G_kj - sum_{i<j} mu_ji r_ki, mu_kj = r_kj / r_jj (j < k), and
        // r_kk = G_kk - sum_{i<k} mu_ki r_ki
        for j in 0..=k {
            let mut s = z.big(&g[k][j]);
            for i in 0..j {
                let m = if j < k { &mu[j][i] } else { &mu[k][i] };
                s = s.sub(&m.mul(&r[k][i]));
            }
            if j < k {
                let Some(m) = s.div_pos(&r[j][j]) else {
                    return out;
                };
                mu[k].push(m);
            } else if !s.positive() {
                return out;
            }
            r[k].push(s);
        }
        let rk = &r[k][k];
        out[k] = if t.lt(rk) {
            Some(true)
        } else if rk.le(&t) {
            Some(false)
        } else {
            None
        };
    }
    out
}

// --- double-word midpoint-radius on the scaled Gram matrix --------------------
//
// The fast proof for moderate dimensions: the Gram matrix scaled by row
// exponents (G_ij 2^-(e_i + e_j), so every quantity stays near 1, as in the
// fast reduction rung), midpoints as double-words (about 106 bits), radii as
// doubles rounded up. The midpoint operations are the published algorithms,
// with their proved relative error bounds (binary floating point of
// precision p, round to nearest, no underflow and no overflow; u = 2^-p,
// p = 53 here):
// - sum: AccurateDWPlusDW, Algorithm 6 of M. Joldes, J.-M. Muller and
//   V. Popescu, "Tight and rigorous error bounds for basic building blocks
//   of double-word arithmetic", ACM TOMS 44(2), art. 15, 2017
//   (doi:10.1145/3121432), Theorem 3.1: if p >= 3, the relative error is at
//   most 3u^2 / (1 - 4u) (kept by the Coq formalization below);
// - product: DWTimesDW (with an FMA), J.-M. Muller and L. Rideau,
//   "Formalization of double-word arithmetic, and comments on 'Tight and
//   rigorous error bounds ...'", ACM TOMS 48(1), 2022: if p >= 5, the
//   relative error is at most 5u^2 / (1 + u)^2 (the 2017 paper's 6u^2 rested
//   on a wrong lemma; the corrected bound is proved in Coq).
// Statements and algorithms via J.-M. Muller, CSNC 2023 slides ("Error
// bounds that are certain, sharp ... and whose proof is trustable",
// pp. 15-17, reproducing the 2017 paper's page, and 25-27); ACM text not
// read. The proof mode (`wide`, l2_proof) never uses this rung: it does not
// rest on a floating-point error analysis.
// Each operation charges more than its bound, relative to the computed
// result: 6u^2 for a sum, 8u^2 for a product (|exact| <= |z| / (1 - 5u^2)).
// Their hypotheses are kept by `Dr::guard`, applied to every operand: a
// nonzero high part lies in [2^-400, 2^400] and a nonzero low part is at
// least 2^-120 of it (smaller parts move into the radius exactly; a larger
// high part makes the radius infinite, and the proof inconclusive), so no
// product of the algorithms underflows (the smallest, x_h y_l, is at least
// 2^-920; 2Prod's error term needs x_h y_h >= 2^-970) and none overflows;
// a sum that lands below the normal range is exact, and so is the FMA in
// the product even then (its exact value is a multiple of 2^-1024, the
// product of two guarded parts' ulps). A quotient's error comes
// from its remainder, with no constant to trust. The radii are computed in
// doubles and rounded up past their few roundings (`rup`).

/// hi + lo with |lo| <= ulp(hi) / 2.
#[derive(Clone, Copy, Debug)]
struct Dw {
    h: f64,
    l: f64,
}

#[inline]
fn fast_two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    (s, b - (s - a))
}

impl Dw {
    /// AccurateDWPlusDW (JMP 2017, Algorithm 6).
    #[inline]
    fn add(self, o: Dw) -> Dw {
        let (sh, sl) = two_sum(self.h, o.h);
        let (th, tl) = two_sum(self.l, o.l);
        let (vh, vl) = fast_two_sum(sh, sl + th);
        let (h, l) = fast_two_sum(vh, tl + vl);
        Dw { h, l }
    }

    #[inline]
    fn neg(self) -> Dw {
        Dw { h: -self.h, l: -self.l }
    }

    /// DWTimesDW with an FMA (Muller and Rideau 2022; the algorithm as
    /// stated there, no x_l y_l term).
    #[inline]
    fn mul(self, o: Dw) -> Dw {
        let (ch, cl1) = two_prod(self.h, o.h);
        let tl = self.h * o.l;
        let cl2 = self.l.mul_add(o.h, tl);
        let cl3 = cl1 + cl2;
        let (h, l) = fast_two_sum(ch, cl3);
        Dw { h, l }
    }

    /// An upper bound of |self|.
    #[inline]
    fn abs_up(self) -> f64 {
        rup(self.h.abs() + self.l.abs())
    }
}

/// x rounded up past the rounding errors of a few double operations (and
/// past the absolute error of subnormal results).
#[inline]
fn rup(x: f64) -> f64 {
    x * (1.0 + p2(-50)) + f64::from_bits(64)
}

/// The value lies in [m - r, m + r].
#[derive(Clone, Copy, Debug)]
struct Dr {
    m: Dw,
    r: f64,
}

const SUM_ERR: f64 = 6.0;
const PROD_ERR: f64 = 8.0;

impl Dr {
    /// The operand inside the error bounds' hypotheses (see the section
    /// comment): tiny parts moved into the radius, a huge one poisoning it.
    #[inline]
    fn guard(self) -> Dr {
        let (h, l) = (self.m.h, self.m.l);
        if h == 0.0 {
            return self;
        }
        let a = h.abs();
        if !(a <= p2(400)) || !l.is_finite() {
            return Dr { m: self.m, r: f64::INFINITY };
        }
        if a < p2(-400) {
            return Dr { m: Dw { h: 0.0, l: 0.0 }, r: rup(self.r + a + l.abs()) };
        }
        if l != 0.0 && l.abs() < a * p2(-120) {
            return Dr { m: Dw { h, l: 0.0 }, r: rup(self.r + l.abs()) };
        }
        self
    }

    #[inline]
    fn add(self, o: Dr) -> Dr {
        let (a, o) = (self.guard(), o.guard());
        let m = a.m.add(o.m);
        Dr { m, r: rup(a.r + o.r + SUM_ERR * p2(-106) * m.abs_up()) }
    }

    #[inline]
    fn sub(self, o: Dr) -> Dr {
        self.add(Dr { m: o.m.neg(), r: o.r })
    }

    #[inline]
    fn mul(self, o: Dr) -> Dr {
        let (x, o) = (self.guard(), o.guard());
        let m = x.m.mul(o.m);
        let (a, b) = (x.m.abs_up(), o.m.abs_up());
        Dr { m, r: rup(a * o.r + b * x.r + x.r * o.r + PROD_ERR * p2(-106) * m.abs_up()) }
    }

    /// self / o for o > 0: a double-word quotient q and the bound
    /// |x/y - q| <= (|x_m - q y_m| + r_x + |q| r_y) / y_min, the remainder
    /// x_m - q y_m enclosed with the sum and product above.
    fn div_pos(self, o: Dr) -> Option<Dr> {
        let ymin = o.m.h - (o.m.l.abs() + o.r);
        let ymin = ymin - ymin.abs() * p2(-50);
        if !(ymin > 0.0) {
            return None;
        }
        let q1 = self.m.h / o.m.h;
        let r1 = self.m.add(o.m.mul(Dw { h: q1, l: 0.0 }).neg());
        let q2 = r1.h / o.m.h;
        let (h, l) = two_sum(q1, q2);
        let q = Dw { h, l };
        let rem = Dr { m: self.m, r: 0.0 }.sub(Dr { m: o.m, r: 0.0 }.mul(Dr { m: q, r: 0.0 }));
        let num = rup(rem.m.abs_up() + rem.r + self.r + q.abs_up() * o.r);
        let r = rup(num / ymin);
        r.is_finite().then_some(Dr { m: q, r })
    }

    fn lo(self) -> f64 {
        let x = self.m.h - (self.m.l.abs() + self.r);
        x - x.abs() * p2(-50)
    }

    /// Every part finite: an overflow, a NaN, or an operand `guard` refused
    /// (an infinite radius) makes the proof inconclusive.
    fn finite(self) -> bool {
        self.m.h.is_finite() && self.m.l.is_finite() && self.r.is_finite()
    }

    fn mag_up(self) -> f64 {
        rup(self.m.abs_up() + self.r)
    }
}

/// G 2^-(e_i + e_j) as a double-word with radius: the top 106 bits of the
/// integer exactly (two 53-bit halves), the rest in the radius.
fn dr_scaled(x: &BigInt, e: i64) -> Dr {
    let b = x.bits();
    let sh = b.saturating_sub(106);
    let t = x >> (sh as usize);
    let neg = t.is_negative();
    let ta = t.abs();
    let hi = &ta >> 53usize;
    let lo = &ta - (&hi << 53usize);
    let s = |v: f64, k: i64| Fe::norm_pub(v, k).to_f64();
    let (h, l) = fast_two_sum(s(hi.to_f64().unwrap(), sh as i64 + 53 - e), s(lo.to_f64().unwrap(), sh as i64 - e));
    let m = if neg { Dw { h: -h, l: -l } } else { Dw { h, l } };
    // the cut (below 2^sh, scaled), and whatever a scaling below the
    // double range flushed (at most 2^-1000)
    let r = if sh > 0 { rup(s(1.0, sh as i64 - e)) } else { 0.0 } + p2(-1000);
    Dr { m, r }
}

/// The (0.51, 0.99) proof with double-word intervals on the Gram matrix
/// scaled by row exponents; Inconclusive when the intervals are too wide,
/// or a scaled quantity leaves the double range.
pub fn verify_dw(g: &[Vec<BigInt>]) -> Verdict {
    verdict(dw_fail_row(g))
}

/// verify_dw, or the row where it became inconclusive.
fn dw_fail_row(g: &[Vec<BigInt>]) -> Result<(), usize> {
    let d = g.len();
    let at = |i: usize, j: usize| if j <= i { &g[i][j] } else { &g[j][i] };
    // e_i: G_ii 2^-2e_i in [1, 4)
    let mut e = vec![0i64; d];
    for i in 0..d {
        if !at(i, i).is_positive() {
            return Err(i);
        }
        e[i] = (at(i, i).bits() as i64 - 1) / 2;
    }
    verify_dw_at(g, &e)
}

fn verdict(r: Result<(), usize>) -> Verdict {
    if r.is_ok() { Verdict::Proved } else { Verdict::Inconclusive }
}

fn verify_dw_at(g: &[Vec<BigInt>], e: &[i64]) -> Result<(), usize> {
    let at = |i: usize, j: usize| if j <= i { &g[i][j] } else { &g[j][i] };
    verify_dw_scaled(e, |i, j| dr_scaled(at(i, j), e[i] + e[j]))
}

/// The same proof from the rows: entries scaled by 2^-e_i (e_i the bits of
/// row i's largest entry) as double-word intervals, the scaled Gram entries
/// their interval dot products (for rows whose exact Gram matrix costs more).
pub fn verify_rows_dw(rows: &[Vec<BigInt>]) -> Verdict {
    let d = rows.len();
    let e: Vec<i64> = rows.iter().map(|r| r.iter().map(|x| x.bits()).max().unwrap_or(0) as i64).collect();
    let ent: Vec<Vec<Dr>> = rows.iter().zip(&e).map(|(r, &ei)| r.iter().map(|x| dr_scaled(x, ei)).collect()).collect();
    let zero = Dr { m: Dw { h: 0.0, l: 0.0 }, r: 0.0 };
    let mut gs: Vec<Vec<Dr>> = vec![vec![]; d];
    for i in 0..d {
        for j in 0..=i {
            let mut acc = zero;
            for (a, b) in ent[i].iter().zip(&ent[j]) {
                if a.m.h == 0.0 && a.r == 0.0 || b.m.h == 0.0 && b.r == 0.0 {
                    continue;
                }
                acc = acc.add(a.mul(*b));
            }
            gs[i].push(acc);
        }
    }
    verdict(verify_dw_scaled(&e, |i, j| if j <= i { gs[i][j] } else { gs[j][i] }))
}

/// The proof from scaled Gram intervals gram(i, j) ~ G_ij 2^-(e_i + e_j);
/// Err(k): inconclusive at row k (the intervals too wide there, or a
/// quantity out of range).
fn verify_dw_scaled(e: &[i64], gram: impl Fn(usize, usize) -> Dr) -> Result<(), usize> {
    let d = e.len();
    // eta from below, delta from above: |mu| <= 0.51 tested as |mu| <= eta_lo
    let eta_lo = 0.51f64.next_down();
    let delta_hi = 0.99f64.next_up();
    let mut r: Vec<Vec<Dr>> = vec![vec![]; d];
    let mut mu: Vec<Vec<Dr>> = vec![vec![]; d];
    for k in 0..d {
        let mut s_last = gram(k, k);
        for j in 0..=k {
            let mut s = gram(k, j);
            if j < k {
                for i in 0..j {
                    s = s.sub(mu[j][i].mul(r[k][i]));
                }
                let Some(m) = s.div_pos(r[j][j]) else {
                    return Err(k);
                };
                // |mu_kj| = |m| 2^(e_k - e_j) <= eta
                let mag = Fe::norm_pub(m.mag_up(), e[k] - e[j]);
                if !m.finite() || mag.gt(Fe::from_f64(eta_lo)) {
                    return Err(k);
                }
                mu[k].push(m);
            } else {
                for i in 0..k {
                    if i + 1 == k {
                        s_last = s;
                    }
                    s = s.sub(mu[k][i].mul(r[k][i]));
                }
                if !s.finite() || !(s.lo() > 0.0) {
                    return Err(k);
                }
            }
            r[k].push(s);
        }
        // Lovasz: delta r_{k-1,k-1} 2^(2 e_{k-1}) <= s_{k-1} 2^(2 e_k)
        if k > 0 {
            let l = rup(delta_hi * r[k - 1][k - 1].mag_up());
            let lhs = Fe::norm_pub(l, 2 * e[k - 1]);
            let rhs = Fe::norm_pub(s_last.lo(), 2 * e[k]);
            if !s_last.finite() || !l.is_finite() || !(s_last.lo() > 0.0) || lhs.gt(rhs) {
                return Err(k);
            }
        }
    }
    Ok(())
}

/// Whether the rows (big integers) are provably (0.51, 0.99)-LLL-reduced,
/// with their Gram entries computed as double-double midpoint-radius
/// intervals from the rows (no exact Gram matrix: for rows with large
/// entries, whose exact dot products cost more than the proof).
pub fn verify_rows_dd(rows: &[Vec<BigInt>]) -> bool {
    let d = rows.len();
    rung_hopeful(2, d) && verify_rows_mn::<2>(rows) || rung_hopeful(3, d) && verify_rows_mn::<3>(rows)
}

fn verify_rows_mn<const N: usize>(rows: &[Vec<BigInt>]) -> bool {
    let z = Mn::<N>::ratio(0, 1);
    let ent: Vec<Vec<Mn<N>>> = rows.iter().map(|r| r.iter().map(|x| z.big(x)).collect()).collect();
    let d = rows.len();
    let mut g: Vec<Vec<Mn<N>>> = vec![vec![]; d];
    for i in 0..d {
        for j in 0..=i {
            let mut acc = z;
            for (a, b) in ent[i].iter().zip(&ent[j]) {
                if a.m.is_zero() && a.r.is_zero() || b.m.is_zero() && b.r.is_zero() {
                    continue;
                }
                acc = acc.add(&a.mul(b));
            }
            g[i].push(acc);
        }
    }
    verify_gram_iv(d, |i, j| g[i][j], &Mn::<N>::ratio(51, 100), &Mn::<N>::ratio(99, 100)) == Verdict::Proved
}

/// Whether the rows with exact Gram matrix `g` (the lower triangle g[i][j],
/// j <= i, or all of it) are provably (0.51, 0.99)-LLL-reduced, by
/// `verify_rung`'s chain: 53-bit intervals, double-word intervals (not when
/// `wide`), multi-double expansions (md3 skipped when the double-word check
/// showed it short of precision; md2 only when `wide`), then, when `wide`,
/// p-bit intervals (p from the dimension, then doubled once).
pub fn verify_gram(g: &[Vec<BigInt>], wide: bool) -> Verdict {
    if verify_rung(g, wide).is_some() { Verdict::Proved } else { Verdict::Inconclusive }
}

/// The p-bit checks alone (proof mode's last interval rung: p = 48 + d, then
/// 96 + 2d), for the memory bound's tests of that path.
pub fn verify_pbit(g: &[Vec<BigInt>]) -> Option<String> {
    let d = g.len() as u64;
    for p in [48 + d, 96 + 2 * d] {
        let z = Ip::ratio(0, 1, p);
        if verify_with(g, &z, &Ip::ratio(51, 100, p), &Ip::ratio(99, 100, p)) == Verdict::Proved {
            return Some(format!("p{p}"));
        }
    }
    None
}

/// The multi-double checks alone (2, 3 and 4 doubles), for the memory
/// bound's tests of that path.
pub fn verify_multi_double(g: &[Vec<BigInt>]) -> Option<String> {
    if verify_mn::<2>(g) == Verdict::Proved {
        return Some("md2".into());
    }
    if verify_mn::<3>(g) == Verdict::Proved {
        return Some("md3".into());
    }
    if verify_mn::<4>(g) == Verdict::Proved {
        return Some("md4".into());
    }
    None
}

/// Which interval rung proved the rows reduced on the exact Gram matrix
/// ("53", "dw", "md2" to "md4", "p<bits>"), or None when none did. With `wide`
/// (proof mode) dw is never tried (it rests on published error-bound
/// constants); md2 to md4 and p-bit are.
pub fn verify_rung(g: &[Vec<BigInt>], wide: bool) -> Option<String> {
    let d = g.len();
    let z = Iv::around(0.0);
    if verify_with(g, &z, &Iv::around(0.51), &Iv::around(0.99)) == Verdict::Proved {
        return Some("53".into());
    }
    // multi-double intervals with 2, 3, 4 doubles (~96, ~149, ~202 bits),
    // each only when the dimension leaves it a chance
    #[cfg(test)]
    MDS.with(|c| c.set(c.get() + 1));
    // the double-word rung rests on published error bounds: the default
    // check uses it; `wide` (l2_proof) keeps to the p-bit chain, always
    // where dw gave up estimates the precision needed: interval widths grow
    // about linearly with the row, so ~106 d / k bits for a failure at row
    // k; a multi-double rung short of that is skipped (it would fail too)
    let mut need = 0.0;
    if !wide && rung_hopeful(2, d) {
        match dw_fail_row(g) {
            Ok(()) => return Some("dw".into()),
            Err(k) => need = 106.0 * d as f64 / k.max(1) as f64,
        }
    }
    // md2 has no more precision than dw: tried only where dw is not (proof
    // mode)
    if wide && rung_hopeful(2, d) && verify_mn::<2>(g) == Verdict::Proved {
        return Some("md2".into());
    }
    if rung_hopeful(3, d) && (53.0 * 3.0 - 10.0) >= need && verify_mn::<3>(g) == Verdict::Proved {
        return Some("md3".into());
    }
    if rung_hopeful(4, d) && verify_mn::<4>(g) == Verdict::Proved {
        return Some("md4".into());
    }
    if !wide {
        return None;
    }
    for p in [48 + d as u64, 96 + 2 * d as u64] {
        #[cfg(test)]
        WIDE.with(|c| c.set(c.get() + 1));
        let z = Ip::ratio(0, 1, p);
        if verify_with(g, &z, &Ip::ratio(51, 100, p), &Ip::ratio(99, 100, p)) == Verdict::Proved {
            return Some(format!("p{p}"));
        }
    }
    None
}

#[cfg(test)]
thread_local! {
    /// Proofs that needed the p-bit intervals (test counter).
    static WIDE: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// Proofs that reached the multi-double intervals.
    static MDS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_traits::One;

    fn gram(m: &[Vec<i64>]) -> Vec<Vec<BigInt>> {
        (0..m.len())
            .map(|i| (0..=i).map(|j| BigInt::from(m[i].iter().zip(&m[j]).map(|(a, b)| a * b).sum::<i64>())).collect())
            .collect()
    }

    /// The cut's comparisons: every decided |b*_k|^2 > t agrees with the
    /// exact d_{k+1} > t d_k, at 53 bits and at p bits, equalities (t equal
    /// to r_kk) included; and on a reduced basis 53 bits decide the
    /// thresholds away from every r_kk.
    #[test]
    fn cut_comparisons_are_exact_or_undecided() {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move |m: i64| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((x >> 33) as i64 % (2 * m + 1)) - m
        };
        let mut cases: Vec<Vec<Vec<i64>>> = vec![
            // orthogonal rows: r_kk = 4, 9, 16, 25 exactly (the ties)
            vec![vec![2, 0, 0, 0], vec![0, 3, 0, 0], vec![0, 0, 4, 0], vec![0, 0, 0, 5]],
        ];
        for d in 2..8 {
            for m in [3, 1000, 1 << 20] {
                let rows: Vec<Vec<i64>> = (0..d).map(|_| (0..d).map(|_| next(m)).collect()).collect();
                cases.push(rows);
            }
        }
        for rows in cases {
            let big: Vec<Vec<BigInt>> = rows.iter().map(|r| r.iter().map(|&v| BigInt::from(v)).collect()).collect();
            let Some((dd, _)) = crate::lll_cert::integral_gso(&big) else { continue };
            let g = gram(&rows);
            // thresholds: 0, 1, each floor and ceiling of r_kk, and r_kk when it is an integer
            let mut ts = vec![BigInt::zero(), BigInt::one()];
            for k in 0..rows.len() {
                let (q, rem) = (&dd[k + 1] / &dd[k], &dd[k + 1] % &dd[k]);
                ts.push(q.clone());
                ts.push(&q + BigInt::one());
                if rem.is_zero() && q > BigInt::one() {
                    ts.push(&q - BigInt::one());
                }
            }
            for t in &ts {
                for p in [None, Some(64), Some(200)] {
                    for (k, v) in gso_vs(&g, t, p).into_iter().enumerate() {
                        let exact = dd[k + 1] > t * &dd[k];
                        if let Some(v) = v {
                            assert_eq!(v, exact, "row {k}, t {t}, p {p:?}");
                        }
                    }
                }
            }
        }
        // a reduced basis: 53 bits decide t = r_kk -+ 1 for every row
        let rows = vec![vec![1, 1, 0], vec![-1, 1, 1], vec![1, -1, 2]];
        let g = gram(&rows);
        let big: Vec<Vec<BigInt>> = rows.iter().map(|r| r.iter().map(|&v| BigInt::from(v)).collect()).collect();
        let (dd, _) = crate::lll_cert::integral_gso(&big).unwrap();
        for k in 0..3 {
            let q = &dd[k + 1] / &dd[k];
            assert_eq!(gso_vs(&g, &(&q + BigInt::from(1)), None)[k], Some(false));
            assert_eq!(gso_vs(&g, &(&q - BigInt::from(1)), None)[k], Some(true));
        }
    }

    /// verify_rows_dw agrees with the exact-Gram proof on the same rows.
    #[test]
    fn rows_and_gram_proofs_agree() {
        let cases: Vec<Vec<Vec<i64>>> = vec![
            vec![vec![1, 0], vec![0, 2]],
            vec![vec![1, 0], vec![1, 2]],
            vec![vec![0, 2], vec![1, 0]],
            vec![vec![1000000, 0], vec![510001, 1000000]],
            vec![vec![1000000, 0], vec![509999, 1000000]],
            vec![vec![2, 0], vec![1, 2]],
            vec![vec![10, 0], vec![0, 10]],
        ];
        for c in cases {
            let rows: Vec<Vec<BigInt>> = c.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect();
            // and scaled up by 2^300, so the entries need the cut
            for sh in [0usize, 300] {
                let rs: Vec<Vec<BigInt>> = rows.iter().map(|r| r.iter().map(|x| (x << sh) + if sh > 0 { BigInt::from(1) } else { BigInt::zero() }).collect()).collect();
                let g: Vec<Vec<BigInt>> = (0..rs.len()).map(|i| (0..=i).map(|j| rs[i].iter().zip(&rs[j]).map(|(a, b)| a * b).fold(BigInt::zero(), |s, x| s + x)).collect()).collect();
                let exact = verify_with(&g, &Ip::ratio(0, 1, 200), &Ip::ratio(51, 100, 200), &Ip::ratio(99, 100, 200));
                assert_eq!(verify_rows_dw(&rs), exact, "{c:?} << {sh}");
                assert_eq!(verify_dw(&g), exact, "{c:?} << {sh}");
            }
        }
    }

    fn both(g: &[Vec<BigInt>]) -> (Verdict, Verdict) {
        let p = 160;
        let a = verify_with(g, &Iv::around(0.0), &Iv::around(0.51), &Iv::around(0.99));
        let b = verify_with(g, &Ip::ratio(0, 1, p), &Ip::ratio(51, 100, p), &Ip::ratio(99, 100, p));
        // the multi-double rungs agree with the p-bit one on these
        assert_eq!(verify_mn::<2>(g), b, "md2 vs p-bit");
        assert_eq!(verify_mn::<3>(g), b, "md3 vs p-bit");
        assert_eq!(verify_mn::<4>(g), b, "md4 vs p-bit");
        assert_eq!(verify_dw(g), b, "dw vs p-bit");
        (a, b)
    }

    /// Both interval types prove a reduced basis and refuse one failing size
    /// reduction, one failing Lovasz, a dependent one, and mu = 0.510001 just
    /// above eta; mu = 0.5 exactly and entries near 2^200 are proved.
    /// The sizes `l2::l2_bytes` counts for the interval types (bytes an
    /// entry): 3- and 4-double intervals at most 48 and 56, a double-word
    /// interval at most 24.
    #[test]
    fn interval_type_sizes_match_the_memory_bound() {
        assert!(std::mem::size_of::<Mn<3>>() <= 48 && std::mem::size_of::<Mn<4>>() <= 56);
        assert!(std::mem::size_of::<Mn<2>>() <= 48 && std::mem::size_of::<Dr>() <= 24);
        assert!(std::mem::size_of::<Iv>() <= 56);
    }

    #[test]
    fn proves_and_refuses() {
        use Verdict::*;
        assert_eq!(both(&gram(&[vec![1, 0], vec![0, 2]])), (Proved, Proved));
        assert_eq!(both(&gram(&[vec![1, 0], vec![1, 2]])), (Inconclusive, Inconclusive));
        assert_eq!(both(&gram(&[vec![0, 2], vec![1, 0]])), (Inconclusive, Inconclusive));
        assert_eq!(both(&gram(&[vec![1, 0], vec![2, 0]])), (Inconclusive, Inconclusive));
        assert_eq!(both(&gram(&[vec![1000000, 0], vec![510001, 1000000]])), (Inconclusive, Inconclusive));
        assert_eq!(both(&gram(&[vec![2, 0], vec![1, 2]])), (Proved, Proved));
        // Lovasz exactly at delta: |b*_1|^2 = 0.99 |b_0|^2 with mu = 0 is reduced
        assert_eq!(both(&gram(&[vec![10, 0], vec![0, 0]])).1, Inconclusive);
        let big = BigInt::from(1u64) << 200usize;
        let g = vec![vec![&big * &big], vec![BigInt::from(0), &big * &big * 4u32]];
        assert_eq!(both(&g), (Proved, Proved));
    }

    /// A double exactly as m 2^s (m an integer; s low enough).
    fn f_exact(x: f64, s: i64) -> BigInt {
        if x == 0.0 {
            return BigInt::zero();
        }
        let bits = x.to_bits();
        let ex = ((bits >> 52) & 0x7ff) as i64;
        let mant = if ex == 0 { (bits & ((1u64 << 52) - 1)) as i64 } else { ((bits & ((1u64 << 52) - 1)) | (1u64 << 52)) as i64 };
        let ex = if ex == 0 { 1 } else { ex };
        let sh = ex - 1075 - s;
        assert!(sh >= 0);
        BigInt::from(if x < 0.0 { -mant } else { mant }) << (sh as usize)
    }

    /// x Dr encloses v 2^-s (v exact): |m - v| <= r, at scale 2^s.
    fn dr_holds(x: Dr, v: &BigInt, s: i64) -> bool {
        let m = f_exact(x.m.h, -s) + f_exact(x.m.l, -s);
        // r rounded up to the scale's integers
        let r = f_exact(x.r, -s - 60) >> 60usize;
        (m - v).abs() <= r + 1
    }

    /// The double-word intervals hold the exact results of +, -, x and /:
    /// on exact double-word inputs of random scales and signs, sums near
    /// cancellation and products whose low parts do not fit, every
    /// operation's charged error covers what it rounds (checked with big
    /// integers; the test counts that rounding happened).
    #[test]
    fn double_word_intervals_contain_the_exact_result() {
        let mut seed = 0x77aa_1234_5678_9abcu64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let s = 1100; // values at scale 2^-1100 are integers
        let (mut rounded_sums, mut rounded_prods) = (0, 0);
        for case in 0..3000 {
            let dw = |scale: i64, r: [u64; 4]| {
                // a normalized double-word: h, then l below half an ulp of h
                let h = ((r[0] >> 11) as f64 + 1.0) * p2(scale - 53) * if r[1] % 2 == 0 { 1.0 } else { -1.0 };
                let l = ((r[2] >> 12) as f64) * p2(scale - 53 - 54) * if r[3] % 2 == 0 { 1.0 } else { -1.0 };
                let (h, l) = fast_two_sum(h, l);
                Dr { m: Dw { h, l }, r: 0.0 }
            };
            // scales near 1, and every seventh pair at the guard's lower edge
            // (high parts around 2^-400 are flushed into the radius)
            let base = if case % 7 == 1 { -400 } else { 0 };
            let sa = base + (rnd() % 60) as i64 - 30;
            let mut a = dw(sa, [rnd(), rnd(), rnd(), rnd()]);
            let sb = if case % 3 == 0 { sa } else { base + (rnd() % 60) as i64 - 30 };
            let mut b = dw(sb, [rnd(), rnd(), rnd(), rnd()]);
            if case % 7 == 2 {
                // low parts below 2^-120 of the high part: flushed
                a.m.l = a.m.h * p2(-125);
                b.m.l = -b.m.h * p2(-130);
            }
            if case % 5 == 0 {
                // near-cancellation: b ~ -a
                let (h, l) = fast_two_sum(-a.m.h, b.m.l * p2(-20));
                b = Dr { m: Dw { h, l }, r: 0.0 };
            }
            let ex = |x: Dr| f_exact(x.m.h, -s) + f_exact(x.m.l, -s);
            let (va, vb) = (ex(a), ex(b));
            let sum = a.add(b);
            assert!(dr_holds(sum, &(&va + &vb), s), "sum {case}");
            rounded_sums += (ex(sum) != &va + &vb) as u32;
            let dif = a.sub(b);
            assert!(dr_holds(dif, &(&va - &vb), s), "difference {case}");
            let prod = a.mul(b);
            // the product at scale 2^-2s
            let vp = &va * &vb;
            let pm = f_exact(prod.m.h, -2 * s) + f_exact(prod.m.l, -2 * s);
            let pr = f_exact(prod.r, -2 * s - 60) >> 60usize;
            assert!((&pm - &vp).abs() <= pr + 1, "product {case}");
            rounded_prods += (pm != vp) as u32;
            // the quotient: |q b - a| <= r |b| (b > 0)
            let bp = if b.m.h > 0.0 { b } else { Dr { m: b.m.neg(), r: 0.0 } };
            let vbp = ex(bp);
            if let Some(q) = a.div_pos(bp) {
                let qm = f_exact(q.m.h, -s) + f_exact(q.m.l, -s);
                let qr = f_exact(q.r, -s - 60) >> 60usize;
                assert!((&qm * &vbp - (&va << s as usize)).abs() <= (qr + 1) * &vbp, "quotient {case}");
            }
        }
        assert!(rounded_sums > 500 && rounded_prods > 2000, "{rounded_sums} {rounded_prods}");
        // above 2^400 the guard refuses: the radius is infinite
        let huge = Dr { m: Dw { h: p2(401), l: 0.0 }, r: 0.0 };
        let one = Dr { m: Dw { h: 1.0, l: 0.0 }, r: 0.0 };
        assert!(!huge.mul(one).finite() && !huge.add(one).finite());
        assert!(one.mul(Dr { m: Dw { h: p2(399), l: 0.0 }, r: 0.0 }).finite());
    }

    /// A Gram entry whose scaled value exceeds the guard's 2^400 (a basis far
    /// from reduced: G_10 = 2^500 G_00 with G_11 near G_00) poisons the
    /// interval: the proof is inconclusive, and so is the exact check.
    #[test]
    fn double_word_proof_refuses_a_poisoned_entry() {
        let t = BigInt::from(1) << 500usize;
        // G00 = 1, G11 = 2^1000 + 1, G10 = 2^500: e_0 = 0, e_1 = 500, so the
        // scaled G10 is 1; make it huge instead with a non-Gram matrix whose
        // scaled entry is 2^450 (rows cannot produce it: Cauchy-Schwarz)
        let g = vec![vec![BigInt::from(1)], vec![&t * (BigInt::from(1) << 450usize), &t * &t]];
        assert_eq!(verify_dw(&g), Verdict::Inconclusive);
        let exact = verify_with(&g, &Ip::ratio(0, 1, 2000), &Ip::ratio(51, 100, 2000), &Ip::ratio(99, 100, 2000));
        assert_eq!(exact, Verdict::Inconclusive);
        // and from rows: an entry of 2^500 next to 1 scales to 1 and 2^-500,
        // fine; the poison can only come from a Gram matrix
        let rows = vec![vec![t.clone(), BigInt::from(1)], vec![BigInt::from(1), t.clone()]];
        assert_eq!(verify_rows_dw(&rows), Verdict::Proved);
    }

    /// At the guard's lower edge the proof goes on: a scaled Gram entry of
    /// 2^-500 (moved into the radius) still proves the reduced basis, as the
    /// exact check does; and a basis whose only flaw sits in such an entry
    /// is refused like the exact check refuses it.
    #[test]
    fn double_word_proof_at_the_underflow_edge() {
        let t = BigInt::from(1) << 500usize;
        // b0 = (2^500, 1), b1 = (0, 2^500): G10 = 2^500, scaled 2^-500
        let rows = vec![vec![t.clone(), BigInt::from(1)], vec![BigInt::zero(), t.clone()]];
        let g: Vec<Vec<BigInt>> = (0..2).map(|i| (0..=i).map(|j| rows[i].iter().zip(&rows[j]).map(|(a, b)| a * b).fold(BigInt::zero(), |s, x| s + x)).collect()).collect();
        let exact = verify_with(&g, &Ip::ratio(0, 1, 200), &Ip::ratio(51, 100, 200), &Ip::ratio(99, 100, 200));
        assert_eq!(exact, Verdict::Proved);
        assert_eq!(verify_dw(&g), Verdict::Proved);
        assert_eq!(verify_rows_dw(&rows), Verdict::Proved);
        // mu = 0.51 + 2^-450: not reduced; the tiny excess is in the radius
        let a = BigInt::from(100) << 450usize;
        let rows = vec![vec![a.clone(), BigInt::zero()], vec![BigInt::from(51) << 450usize, a.clone()]];
        let mut r = rows;
        r[1][0] += 1;
        let g: Vec<Vec<BigInt>> = (0..2).map(|i| (0..=i).map(|j| r[i].iter().zip(&r[j]).map(|(a, b)| a * b).fold(BigInt::zero(), |s, x| s + x)).collect()).collect();
        let exact = verify_with(&g, &Ip::ratio(0, 1, 1200), &Ip::ratio(51, 100, 1200), &Ip::ratio(99, 100, 1200));
        assert_eq!(exact, Verdict::Inconclusive);
        assert_eq!(verify_dw(&g), Verdict::Inconclusive);
        assert_eq!(verify_rows_dw(&r), Verdict::Inconclusive);
    }

    /// With radii: the product and the sum of intervals hold the products and
    /// sums of their endpoints (radii of a random fraction of the midpoints,
    /// which exercise the r_a |b| + r_b |a| + r_a r_b terms).
    #[test]
    fn double_word_radii_propagate() {
        let mut seed = 0x1f2e_3d4c_5b6a_7988u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let s = 1100;
        for case in 0..2000 {
            let mk = |r: [u64; 3]| {
                let h = ((r[0] >> 11) as f64 + 1.0) * p2(-53 + (r[1] % 20) as i64 - 10) * if r[1] % 2 == 0 { 1.0 } else { -1.0 };
                // radius 2^-k of the midpoint, k in 1..60
                Dr { m: Dw { h, l: 0.0 }, r: h.abs() * p2(-1 - (r[2] % 60) as i64) }
            };
            let (a, b) = (mk([rnd(), rnd(), rnd()]), mk([rnd(), rnd(), rnd()]));
            let ex = |x: f64| f_exact(x, -s);
            for (sa, sb) in [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
                // endpoints a_m + sa r_a, b_m + sb r_b (exact at the scale)
                let va = ex(a.m.h) + if sa > 0.0 { ex(a.r) } else { -ex(a.r) };
                let vb = ex(b.m.h) + if sb > 0.0 { ex(b.r) } else { -ex(b.r) };
                let p = a.mul(b);
                let pm = f_exact(p.m.h, -2 * s) + f_exact(p.m.l, -2 * s);
                let pr = f_exact(p.r, -2 * s - 60) >> 60usize;
                assert!((pm - &va * &vb).abs() <= pr + 1, "product {case}");
                assert!(dr_holds(a.add(b), &(&va + &vb), s), "sum {case}");
            }
        }
    }

    /// Integers above 106 bits enter with their cut in the radius: the
    /// scaled value x 2^-e lies in the interval (random sizes, signs, e).
    #[test]
    fn scaled_conversion_holds_the_integer() {
        let mut seed = 0x0123_4567_89ab_cdefu64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut cut = 0;
        for case in 0..2000 {
            let bits = 1 + rnd() % 600;
            let mut x = BigInt::zero();
            for _ in 0..bits.div_ceil(64) {
                x = (x << 64usize) + BigInt::from(rnd());
            }
            x = x >> (bits.div_ceil(64) * 64 - bits) as usize;
            if rnd() % 2 == 0 {
                x = -x;
            }
            // scaled near 1, like the Gram entries
            let e = bits as i64 - 1 - (rnd() % 8) as i64;
            let d = dr_scaled(&x, e);
            let s = 1100 - e.max(0);
            // x 2^-e at scale 2^-s: x 2^(s - e)
            let v = if s >= e { &x << (s - e) as usize } else { &x >> (e - s) as usize };
            assert!(dr_holds(d, &v, s), "case {case}: {bits} bits");
            cut += (bits > 106) as u32;
        }
        assert!(cut > 1000);
    }

    /// The value of an expansion as m 2^s exactly (m an integer).
    fn ex_exact<const N: usize>(x: &Ex<N>, s: i64) -> BigInt {
        let mut acc = BigInt::zero();
        for &t in &x.t {
            if t == 0.0 {
                continue;
            }
            let bits = t.to_bits();
            let ex = ((bits >> 52) & 0x7ff) as i64;
            let mant = ((bits & ((1u64 << 52) - 1)) | (1u64 << 52)) as i64;
            let val = BigInt::from(if t < 0.0 { -mant } else { mant });
            acc += val << ((ex - 1075 + x.e - s) as usize);
        }
        acc
    }

    /// A double with exponent as m 2^s, rounded up in magnitude (m >= 0).
    fn fe_up(f: Fe, s: i64) -> BigInt {
        let (m, e) = (f.mantissa(), f.exponent());
        let mi = (m.abs() * 2f64.powi(53)).ceil() as i64;
        let sh = e - 53 - s;
        if sh >= 0 { BigInt::from(mi) << (sh as usize) } else { (BigInt::from(mi) >> ((-sh) as usize)) + 1 }
    }

    /// Every expansion operation's result is within its returned bound of the
    /// exact answer: |a + b - r| <= t, |a b - r| <= t, |a - r b| <= t |b|
    /// (checked exactly with big integers, on random 3- and 4-double
    /// expansions of mixed signs and scales, including near-cancellation).
    #[test]
    fn expansion_operations_bound_what_they_cut() {
        fn check<const N: usize>(seed: &mut u64) {
            let mut rnd = || {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                *seed
            };
            for case in 0..300 {
                let mut big = |bits: usize| {
                    let mut x = BigInt::zero();
                    for _ in 0..bits.div_ceil(64) {
                        x = (x << 64usize) + BigInt::from(rnd());
                    }
                    x = x >> (bits.div_ceil(64) * 64 - bits);
                    if rnd() % 2 == 0 { -x } else { x }
                };
                let x = big(300);
                // near-cancellation every third case: y = -x + small
                let y = if case % 3 == 0 { -x.clone() + big(120) } else { big(250 + (case % 7) * 10) };
                let (a, _) = Ex::<N>::from_big(&x);
                let (b, _) = Ex::<N>::from_big(&y);
                let s = a.e.min(b.e) * 2 - 2400;
                let (ae, be) = (ex_exact(&a, s / 2), ex_exact(&b, s / 2));
                // add: compare at scale s/2
                let (r, t) = a.add(&b);
                let err = (&ae + &be - ex_exact(&r, s / 2)).abs();
                assert!(err <= fe_up(t, s / 2), "add {case}");
                // mul: at scale s
                let (r, t) = a.mul(&b);
                let err = (&ae * &be - ex_exact(&r, s)).abs();
                assert!(err <= fe_up(t, s), "mul {case}");
                // div: |a - r b| <= t |b| at scale s (r at scale s/2... use common scale)
                if let Some((r, t)) = a.div(&b) {
                    let s2 = s / 2 - 2400;
                    let lhs = (&ae << 2400usize) - ex_exact(&r, s2 - s / 2) * &be;
                    let rhs = fe_up(t, s2 - s / 2) * be.abs();
                    assert!(lhs.abs() <= rhs, "div {case}");
                }
            }
        }
        let mut seed = 0x1234_4321_abcd_dcbau64;
        check::<3>(&mut seed);
        check::<4>(&mut seed);
    }

    /// The intervals contain the exact results of +, -, x and / on exactly
    /// represented integers whose results need more than N doubles, so every
    /// operation's cut has to land in the radius (checked exactly).
    #[test]
    fn multi_double_intervals_contain_the_exact_result() {
        fn inside<const N: usize>(x: &Mn<N>, num: &BigInt, den: &BigInt) -> bool {
            // num/den in [m - r, m + r] with den > 0: |num - m den| <= r den
            let s = -4000;
            let lhs = (num << 4000usize) - ex_exact(&x.m, s) * den;
            lhs.abs() <= fe_up(x.r, s) * den
        }
        fn check<const N: usize>(seed: &mut u64) -> usize {
            let mut rnd = || {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                *seed
            };
            let mut cut = 0;
            for case in 0..400 {
                // sparse integers: a few random 20-bit pieces at random
                // offsets, so each fits N doubles exactly but sums and
                // products do not
                let mut sparse = || {
                    let mut x = BigInt::zero();
                    for _ in 0..N {
                        x += BigInt::from(rnd() % (1 << 20)) << ((rnd() % (40 * N as u64)) as usize);
                    }
                    if rnd() % 2 == 0 { -x } else { x }
                };
                let (mut xv, mut yv) = (sparse(), sparse());
                if case % 2 == 0 {
                    // dense, 53 N bits, same sign: the sum carries past N doubles
                    let mut dense = || {
                        let mut x = BigInt::from(1);
                        for _ in 0..53 * N - 1 {
                            x = (x << 1usize) + BigInt::from(rnd() & 1);
                        }
                        x
                    };
                    xv = dense();
                    yv = dense();
                    if case % 4 == 0 {
                        xv = -xv;
                        yv = -yv;
                    }
                }
                let one = BigInt::from(1);
                let (mut x, y) = (Mn::<N>::ratio(0, 1).big(&xv), Mn::<N>::ratio(0, 1).big(&yv));
                if case % 2 == 0 && !x.m.is_zero() {
                    // x 2^60, still exact in N doubles: x + y then spans
                    // 53 N + 60 dense bits and is cut
                    x.m.e += 60;
                    xv <<= 60usize;
                }
                // exact inputs: from_big's radius is only the 1e-323 floor
                assert!(!x.r.gt(Fe::norm_pub(1.0, -1000)) && !y.r.gt(Fe::norm_pub(1.0, -1000)));
                let (s, t, p) = (x.add(&y), x.sub(&y), x.mul(&y));
                assert!(inside(&s, &(&xv + &yv), &one), "add {case}");
                assert!(inside(&t, &(&xv - &yv), &one), "sub {case}");
                assert!(inside(&p, &(&xv * &yv), &one), "mul {case}");
                cut += s.r.gt(Fe::norm_pub(1.0, -1000)) as usize;
                let ya = yv.abs();
                if ya > BigInt::zero() {
                    let q = x.div_pos(&x.big(&ya)).expect("a positive divisor");
                    assert!(inside(&q, &xv, &ya), "div {case}");
                }
            }
            cut
        }
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        // the test means something only if some sums were cut
        assert!(check::<2>(&mut seed) > 50);
        assert!(check::<3>(&mut seed) > 50);
    }

    /// Integers of many chunks enter exactly (up to their top 53 N bits):
    /// the expansion's terms, read back as a sum of exact dyadic rationals,
    /// give the integer (or its truncation, within the returned bound).
    #[test]
    fn expansions_hold_big_integers() {
        fn back<const N: usize>(x: &Ex<N>) -> (BigInt, i64) {
            // sum t_i 2^e as m 2^s with m an integer
            let mut acc = BigInt::zero();
            let s = x.e - 1100;
            for &t in &x.t {
                if t == 0.0 {
                    continue;
                }
                let bits = t.to_bits();
                let ex = ((bits >> 52) & 0x7ff) as i64;
                let mant = ((bits & ((1u64 << 52) - 1)) | (1u64 << 52)) as i64;
                let val = BigInt::from(if t < 0.0 { -mant } else { mant });
                let pow = ex - 1075 + x.e - s; // t 2^e = mant 2^(ex - 1075 + e)
                acc += val << (pow as usize);
            }
            (acc, s)
        }
        let mut seed = 0x1357_9bdf_2468_ace0u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for bits in [10usize, 60, 100, 159, 200, 300] {
            let mut x = BigInt::zero();
            for _ in 0..bits.div_ceil(64) {
                x = (x << 64usize) + BigInt::from(rnd());
            }
            x = x >> (bits.div_ceil(64) * 64 - bits);
            for neg in [false, true] {
                let x = if neg { -x.clone() } else { x.clone() };
                let (e3, r3) = Ex::<3>::from_big(&x);
                let (m, s) = back(&e3);
                let exact = &x << ((-s) as usize);
                let diff = (&m - &exact).abs();
                if x.bits() <= 159 {
                    assert!(diff.is_zero(), "{bits} bits: not exact");
                } else {
                    // within the bound r3 (r3 = m' 2^e', compare diff 2^s <= r3)
                    let rb = Fe::from_big(&diff).mul(Fe::norm_pub(1.0, s));
                    assert!(!rb.gt(r3), "{bits} bits: beyond the bound");
                }
            }
        }
    }

    /// The p-bit floats round in the stated direction: 1/3 down < 1/3 < up,
    /// and a sum with a far smaller term keeps its direction (sticky unit).
    #[test]
    fn bf_rounds_outward() {
        let p = 64;
        let one = Bf { m: BigInt::from(1), e: 0 };
        let three = Bf { m: BigInt::from(3), e: 0 };
        let (lo, hi) = (one.div(&three, p, false), one.div(&three, p, true));
        // 3 lo < 1 < 3 hi exactly
        assert!(one.gt(&lo.mul(&three, 400, false)));
        assert!(hi.mul(&three, 400, true).gt(&one));
        let tiny = Bf { m: BigInt::from(1), e: -10_000 };
        assert!(one.add(&tiny, p, true).gt(&one));
        assert!(!one.add(&tiny, p, false).gt(&one));
        assert!(one.gt(&one.add(&tiny.neg(), p, false)));
    }
}
