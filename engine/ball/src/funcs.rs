//! Constants and elementary functions of balls.
//!
//! Each function evaluates f at the ball's exact midpoint with ball
//! arithmetic (rounding errors tracked), adds a proven bound for the
//! truncated series, and adds rad * sup |f'| over the ball.

use crate::ball::{top, Ball};
use crate::mag::Mag;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use std::cell::RefCell;
use std::cmp::Ordering;

fn isqrt_u64(n: u64) -> u64 {
    // (squares checked: a seed of 2^32 overflowed, BALL-F7)
    let mut r = ((n as f64).sqrt() as u64).min(u32::MAX as u64);
    while r.checked_mul(r).is_none_or(|q| q > n) {
        r -= 1;
    }
    while (r + 1).checked_mul(r + 1).is_some_and(|q| q <= n) {
        r += 1;
    }
    r
}

/// Precisions are capped at PREC_MAX bits (a larger request is a lower,
/// still rigorous, precision; the review's BALL-F7: u64::MAX overflowed).
pub const PREC_MAX: u64 = 1 << 24;

fn cap(prec: u64) -> u64 {
    prec.min(PREC_MAX)
}

// ------------------------------------------------------------------ series

/// sum_k (-1)^k z^(2k+1) / (2k+1) (alternating) or sum_k z^(2k+1) / (2k+1)
/// (atanh), for |z| <= 1/2 on the whole ball.  Tail bounds: alternating
/// with decreasing terms, |tail| <= T^(2N+1)/(2N+1); otherwise
/// sum_{k>=N} T^(2k+1)/(2k+1) <= T^(2N+1)/((2N+1)(1 - T^2)) <= 2 T^(2N+1)/(2N+1).
fn odd_series(z: &Ball, wp: u64, alternating: bool) -> Ball {
    let t = z.upper_abs();
    // (callers reduce first; a wider ball here is a bug, not an input)
    assert!(t.le_pow2(-1), "odd_series: |z| > 1/2");
    if z.m.is_zero() && z.r.is_zero() {
        return Ball::zero();
    }
    let z2 = z.sqr(wp);
    let t2 = t.mul(t);
    let mut pw = z.clone(); // z^(2k+1)
    let mut tb = t; // T^(2k+1)
    let mut sum = z.clone();
    // relative to |z| (atan z and atanh z are about z)
    let goal = t.mul_2exp(-(wp as i64));
    let mut k: u64 = 0;
    loop {
        k += 1;
        tb = tb.mul(t2);
        let bound = if alternating { tb.div_u64(2 * k + 1) } else { tb.div_u64(2 * k + 1).mul_2exp(1) };
        if bound <= goal {
            return sum.add_error(bound);
        }
        pw = pw.mul(&z2, wp);
        let term = pw.div_i64((2 * k + 1) as i64, wp);
        sum = if alternating && k % 2 == 1 { sum.sub(&term, wp) } else { sum.add(&term, wp) };
    }
}

// ------------------------------------------------------------------ constants

thread_local! {
    static CACHE: RefCell<Vec<(&'static str, u64, Ball)>> = const { RefCell::new(Vec::new()) };
}

fn cached(name: &'static str, prec: u64, f: fn(u64) -> Ball) -> Ball {
    let prec = cap(prec);
    let hit = CACHE.with(|c| c.borrow().iter().find(|(n, p, _)| *n == name && *p >= prec).map(|(_, _, b)| b.clone()));
    if let Some(b) = hit {
        return b.rounded(prec);
    }
    // a little more than asked, so that nearby requests reuse it
    let p = prec + prec / 8 + 32;
    let b = f(p);
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.retain(|(n, _, _)| *n != name);
        c.push((name, p, b.clone()));
    });
    b.rounded(prec)
}

/// pi = 16 atan(1/5) - 4 atan(1/239) (Machin).
pub fn pi(prec: u64) -> Ball {
    cached("pi", prec, |p| {
        let wp = p + 16;
        let a = odd_series(&Ball::from_rational(&BigInt::from(1), &BigInt::from(5), wp), wp, true);
        let b = odd_series(&Ball::from_rational(&BigInt::from(1), &BigInt::from(239), wp), wp, true);
        a.mul_2exp(4).sub(&b.mul_2exp(2), wp)
    })
}

/// log 2 = 2 atanh(1/3).
pub fn ln2(prec: u64) -> Ball {
    cached("ln2", prec, |p| {
        let wp = p + 16;
        odd_series(&Ball::from_rational(&BigInt::from(1), &BigInt::from(3), wp), wp, false).mul_2exp(1)
    })
}

/// Euler's constant, by Brent and McMillan's algorithm B1: with
/// U = sum_k (n^k/k!)^2 (H_k - log n) and V = sum_k (n^k/k!)^2,
/// 0 < U/V - gamma < pi e^(-4n) (Brent and McMillan, Math. Comp. 34
/// (1980), 305-312).
pub fn euler_gamma(prec: u64) -> Ball {
    cached("gamma", prec, |p| {
        let wp = p + 16;
        // pi e^(-4n) <= 2^-wp needs n >= (wp + 2) ln2 / 4 = 0.17329 (wp + 2)
        let n: u64 = (wp + 2) * 178 / 1024 + 1;
        // terms to k = K >= 2 e n: beyond it t_(k+1)/t_k <= (n/K)^2 < 1/29
        let kmax: u64 = n * 544 / 100 + 2;
        // V ~ e^(2n) = 2^(2.89 n): the sums need that many more bits
        let wp2 = wp + 3 * n + 64;
        let logn = Ball::from_i64(n as i64).log(wp2).expect("log n");
        let n2 = (n * n) as i64;
        let mut t = Ball::one();
        let mut h = Ball::zero();
        let mut u = logn.neg();
        let mut v = Ball::one();
        for k in 1..=kmax {
            t = t.mul_i64(n2, wp2).div_i64((k * k) as i64, wp2);
            h = h.add(&Ball::from_rational(&BigInt::one(), &BigInt::from(k), wp2), wp2);
            u = u.add(&t.mul(&h.sub(&logn, wp2), wp2), wp2);
            v = v.add(&t, wp2);
        }
        // tails: V's <= t_K / 28; U's, with |H_k - log n| <= k for k >= n,
        // <= sum_j t_K 29^-j (K + j) <= t_K (K + 2) / 14
        let tk = t.upper_abs();
        let v = v.add_error(tk.div_u64(28));
        let u = u.add_error(tk.mul_u64(kmax + 2).div_u64(14));
        let g = u.div(&v, wp2).expect("V > 0");
        // gamma in (U/V - pi e^(-4n), U/V), and pi e^(-4n) <= 2^-wp
        g.add_error(Mag::pow2(-(wp as i64))).rounded(wp)
    })
}

/// Catalan's constant: G = (pi/8) log(2 + sqrt 3) + (3/8) sum_n a_n,
/// a_n = (n!)^2 / ((2n)! (2n+1)^2) (Ramanujan), a_(n+1)/a_n =
/// (n+1)(2n+1)/(2(2n+3)^2) <= 1/2, so the tail after a_N is <= 2 a_N.
pub fn catalan(prec: u64) -> Ball {
    cached("catalan", prec, |p| {
        let wp = p + 16;
        let mut a = Ball::one();
        let mut s = Ball::one();
        let goal = Mag::pow2(-(wp as i64) - 2);
        let mut n: i64 = 0;
        loop {
            a = a.mul_i64((n + 1) * (2 * n + 1), wp).div_i64(2 * (2 * n + 3) * (2 * n + 3), wp);
            n += 1;
            let tail = a.upper_abs().mul_2exp(1);
            if tail <= goal {
                s = s.add(&a, wp).add_error(tail);
                break;
            }
            s = s.add(&a, wp);
        }
        let l = Ball::from_i64(3).sqrt(wp).unwrap().add(&Ball::from_i64(2), wp).log(wp).unwrap();
        pi(wp).mul(&l, wp).mul_2exp(-3).add(&s.mul_i64(3, wp).mul_2exp(-3), wp)
    })
}

// ------------------------------------------------------------------ exp, log

/// exp of the exact m 2^e (None for |x| >= 2^40).
fn exp_point(m: &BigInt, e: i64, wp: u64) -> Option<Ball> {
    if m.is_zero() {
        return Some(Ball::one());
    }
    if top(m, e) > 40 {
        return None;
    }
    let x = Ball::exact(m.clone(), e);
    // n near x / log 2 (any integer is correct; this one makes |r| small)
    let q = x.div(&ln2(64), 64)?;
    let n = round_to_i64(&q);
    let nb = 64 - n.unsigned_abs().leading_zeros() as u64;
    let s = (isqrt_u64(wp) / 2 + 1) as i64;
    let wp2 = wp + s as u64 + 20 + nb;
    let r = x.sub(&ln2(wp2).mul_i64(n, wp2), wp2);
    let t = r.mul_2exp(-s);
    let tt = t.upper_abs();
    // sum_(k<=K) t^k/k!; tail <= 2 T^(K+1)/(K+1)! for T <= 1/2, checked
    // here on the reduced ball itself (not inferred from the reduction)
    if !tt.le_pow2(-1) {
        return None;
    }
    let mut sum = Ball::one();
    let mut term = Ball::one();
    let mut tb = Mag::from_u64(1);
    let goal = Mag::pow2(-(wp2 as i64));
    let mut k: u64 = 0;
    loop {
        k += 1;
        term = term.mul(&t, wp2).div_i64(k as i64, wp2);
        sum = sum.add(&term, wp2);
        tb = tb.mul(tt).div_u64(k);
        let tail = tb.mul(tt).div_u64(k + 1).mul_2exp(1);
        if tail <= goal {
            sum = sum.add_error(tail);
            break;
        }
    }
    for _ in 0..s {
        sum = sum.sqr(wp2);
    }
    Some(sum.mul_2exp(n))
}

/// The integer nearest the midpoint (|x| < 2^62).
fn round_to_i64(x: &Ball) -> i64 {
    let (m, e) = x.mid();
    if e >= 0 {
        return (&m << e as u64).to_i64().expect("integer part too large");
    }
    let s = (-e) as u64;
    let neg = m.is_negative();
    let a = m.abs();
    let mut q = &a >> s;
    if s >= 1 && a.bit(s - 1) {
        q += 1u32;
    }
    let q = q.to_i64().expect("integer part too large");
    if neg { -q } else { q }
}

/// The integer nearest the midpoint, as a BigInt.
fn round_to_bigint(x: &Ball) -> BigInt {
    let (m, e) = x.mid();
    if e >= 0 {
        return &m << e as u64;
    }
    let s = (-e) as u64;
    let neg = m.is_negative();
    let a = m.abs();
    let mut q = &a >> s;
    if a.bit(s - 1) {
        q += 1u32;
    }
    if neg { -q } else { q }
}

/// log of the exact positive m 2^e.
fn log_point(m: &BigInt, e: i64, wp: u64) -> Ball {
    // x = y 2^k, y in [3/4, 3/2)
    let b = m.bits() as i64;
    let mut k = e + b - 1;
    let mut ye = -(b - 1);
    // y >= 3/2 iff the top two bits are 11
    if b >= 2 && m.bit((b - 2) as u64) {
        k += 1;
        ye -= 1;
    }
    let y = Ball::exact(m.clone(), ye);
    let (dm, de) = crate::ball::add_dyadic(m, ye, &BigInt::from(-1), 0);
    let kb = 64 - k.unsigned_abs().leading_zeros() as u64;
    if dm.is_zero() {
        return ln2(wp + kb).mul_i64(k, wp + kb);
    }
    // log y is about y - 1: that many more bits keep it relative
    let extra = (-top(&dm, de)).max(0) as u64;
    let s = isqrt_u64(wp) / 2 + 1;
    let wp2 = wp + extra + 2 * s + 30 + kb;
    let mut yy = y;
    for _ in 0..s {
        yy = yy.sqrt(wp2).expect("sqrt of y > 0");
    }
    let one = Ball::one();
    let z = yy.sub(&one, wp2).div(&yy.add(&one, wp2), wp2).expect("y + 1 > 0");
    let ly = odd_series(&z, wp2, false).mul_2exp(s as i64 + 1);
    if k == 0 {
        return ly;
    }
    ly.add(&ln2(wp2).mul_i64(k, wp2), wp2)
}

// ------------------------------------------------------------------ sin, cos, atan

/// sin r and cos r by their series, |r| <= 1 on the ball (checked here:
/// None otherwise); both tails are at most sum_(j>J) T^j/j! <=
/// 2 T^(J+1)/(J+1)! (T/(J+2) <= 1/2).
fn sincos_series(r: &Ball, wp: u64) -> Option<(Ball, Ball)> {
    let tt = r.upper_abs();
    if !tt.le_pow2(0) {
        return None;
    }
    let mut s = r.clone();
    let mut c = Ball::one();
    let mut term = r.clone();
    let mut tb = tt;
    let goal = tt.max(Mag::pow2(-64)).mul_2exp(-(wp as i64));
    let mut j: u64 = 1;
    loop {
        j += 1;
        term = term.mul(r, wp).div_i64(j as i64, wp);
        tb = tb.mul(tt).div_u64(j);
        let neg = (j / 2) % 2 == 1;
        let target = if j % 2 == 0 { &mut c } else { &mut s };
        *target = if neg { target.sub(&term, wp) } else { target.add(&term, wp) };
        let tail = tb.mul(tt).div_u64(j + 1).mul_2exp(1);
        if tail <= goal {
            return Some((s.add_error(tail), c.add_error(tail)));
        }
    }
}

/// (sin x, cos x) of the exact m 2^e, the wanted one (0 sin, 1 cos) to
/// about wp bits relative when it is not too close to 0.
fn sincos_point(m: &BigInt, e: i64, wp: u64, want: usize) -> Option<(Ball, Ball)> {
    if m.is_zero() {
        return Some((Ball::zero(), Ball::one()));
    }
    let t = top(m, e);
    if t > 1 << 16 {
        return None; // (reduction would need pi to 65536+ bits)
    }
    let nb = t.max(0) as u64 + 2;
    let x = Ball::exact(m.clone(), e);
    let mut last = None;
    for extra in [0u64, 64, 256, 1024, 4096] {
        let wp2 = wp + nb + 30 + extra;
        let hp = pi(wp2).mul_2exp(-1);
        let q = x.div(&pi(nb + 64).mul_2exp(-1), nb + 64)?;
        let n = round_to_bigint(&q);
        let r = x.sub(&hp.mul(&Ball::from_int(&n), wp2), wp2);
        let (s, c) = sincos_series(&r, wp2)?;
        let quad = n.mod_floor_4();
        let (sx, cx) = match quad {
            0 => (s, c),
            1 => (c, s.neg()),
            2 => (s.neg(), c.neg()),
            _ => (c.neg(), s),
        };
        let ok = [&sx, &cx][want].rel_accuracy_bits() >= wp as i64 - 2;
        last = Some((sx, cx));
        if ok {
            break;
        }
    }
    last
}

trait Mod4 {
    fn mod_floor_4(&self) -> u8;
}
impl Mod4 for BigInt {
    fn mod_floor_4(&self) -> u8 {
        let r = self % BigInt::from(4);
        let r = if r.is_negative() { r + 4 } else { r };
        r.to_u8().unwrap()
    }
}

/// atan of a ball with |z| <= 1: s halvings z -> z / (1 + sqrt(1 + z^2))
/// (atan z = 2 atan(z / (1 + sqrt(1 + z^2)))), then the series.
fn atan_reduced(z: &Ball, wp: u64) -> Ball {
    let s = isqrt_u64(wp) / 2 + 1;
    let wp2 = wp + s + 16;
    let one = Ball::one();
    let mut z = z.clone();
    for _ in 0..s {
        let d = one.add(&one.add(&z.sqr(wp2), wp2).sqrt(wp2).expect("1 + z^2 > 0"), wp2);
        z = z.div(&d, wp2).expect("d >= 2");
    }
    odd_series(&z, wp2, true).mul_2exp(s as i64)
}

fn atan_point(m: &BigInt, e: i64, wp: u64) -> Ball {
    if m.is_zero() {
        return Ball::zero();
    }
    let x = Ball::exact(m.clone(), e);
    let wp2 = wp + 16;
    let gt1 = crate::ball::cmp_dyadic(&m.abs(), e, &BigInt::one(), 0) == Ordering::Greater;
    if gt1 {
        // atan x = sign(x) pi/2 - atan(1/x)
        let inv = x.recip(wp2).expect("x != 0");
        let hp = pi(wp2).mul_2exp(-1);
        let hp = if m.is_negative() { hp.neg() } else { hp };
        return hp.sub(&atan_reduced(&inv, wp2), wp2);
    }
    atan_reduced(&x, wp2)
}

// ------------------------------------------------------------------ the methods

impl Ball {
    /// e^x (None if the ball reaches |x| >= 2^40).
    pub fn exp(&self, prec: u64) -> Option<Ball> {
        let prec = cap(prec);
        let wp = prec + 24;
        let v = exp_point(&self.m, self.e, wp)?;
        if self.r.is_zero() {
            return Some(v.rounded(prec));
        }
        if !self.is_finite() {
            return None;
        }
        // |e^x - e^m| <= r e^(m + r)
        let (um, ue) = self.upper();
        let sup = exp_point(&um, ue, 40)?.upper_abs();
        Some(v.add_error(self.r.mul(sup)).rounded(prec))
    }

    /// log x (None unless the ball is certainly positive).
    pub fn log(&self, prec: u64) -> Option<Ball> {
        let prec = cap(prec);
        if !self.is_positive() {
            return None;
        }
        let wp = prec + 24;
        let v = log_point(&self.m, self.e, wp);
        if self.r.is_zero() {
            return Some(v.rounded(prec));
        }
        // |log x - log m| <= r / (m - r)
        let (lm, le) = self.lower();
        Some(v.add_error(self.r.div(Mag::from_bigint_down(&lm, le))).rounded(prec))
    }

    /// sin x (None for |x| >= 2^65536).
    pub fn sin(&self, prec: u64) -> Option<Ball> {
        let prec = cap(prec);
        let (s, _) = sincos_point(&self.m, self.e, prec + 24, 0)?;
        Some(s.add_error(self.r).rounded(prec))
    }

    /// cos x (None for |x| >= 2^65536).
    pub fn cos(&self, prec: u64) -> Option<Ball> {
        let prec = cap(prec);
        let (_, c) = sincos_point(&self.m, self.e, prec + 24, 1)?;
        Some(c.add_error(self.r).rounded(prec))
    }

    /// tan x (None near a pole, where cos x is not certainly nonzero).
    pub fn tan(&self, prec: u64) -> Option<Ball> {
        let prec = cap(prec);
        let wp = prec + 24;
        self.sin(wp)?.div(&self.cos(wp)?, prec)
    }

    /// atan x.
    pub fn atan(&self, prec: u64) -> Ball {
        let prec = cap(prec);
        let v = atan_point(&self.m, self.e, prec + 24);
        if self.r.is_zero() {
            return v.rounded(prec);
        }
        // |atan'| = 1/(1 + x^2) <= min(1, 1/L^2), L = min |x| over the ball
        let l = self.lower_abs();
        let one = Mag::from_u64(1);
        let d = if l >= one { one.div(l.mul_down(l)) } else { one };
        v.add_error(self.r.mul(d)).rounded(prec)
    }

    /// x^n for an integer n (None for n < 0 when x may be 0).
    pub fn pow_i64(&self, n: i64, prec: u64) -> Option<Ball> {
        let prec = cap(prec);
        // (|n| as u64: -i64::MIN overflowed and recursed forever, BALL-F3)
        let k0 = n.unsigned_abs();
        let wp = prec + 2 * (64 - k0.leading_zeros() as u64) + 8;
        if n < 0 {
            return self.pow_u64(k0, wp).recip(prec);
        }
        Some(self.pow_u64(k0, wp).rounded(prec))
    }

    fn pow_u64(&self, k0: u64, wp: u64) -> Ball {
        let mut r = Ball::one();
        let mut b = self.clone();
        let mut k = k0;
        while k > 0 {
            if k & 1 == 1 {
                r = r.mul(&b, wp);
            }
            k >>= 1;
            if k > 0 {
                b = b.sqr(wp);
            }
        }
        r
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn isqrt_at_the_top() {
        assert_eq!(super::isqrt_u64(u64::MAX), u32::MAX as u64);
        assert_eq!(super::isqrt_u64(1 << 62), 1 << 31);
        assert_eq!(super::isqrt_u64(0), 0);
        assert_eq!(super::isqrt_u64(99), 9);
        assert_eq!(super::cap(u64::MAX), super::PREC_MAX);
    }
}
