//! Floating-point LLL (Nguyen and Stehle's L^2, "An LLL algorithm with
//! quadratic complexity", SIAM J. Comput. 39 (2009)): the basis and its Gram
//! matrix stay exact integers; the Gram-Schmidt data r_ij = <b_i, b*_j> and
//! mu_ij = r_ij / r_jj are floating-point, recomputed from the exact Gram
//! matrix during a lazy size reduction. Parameters eta = 0.51, delta = 0.99,
//! with a little slack in the floating-point tests (eta', delta') for their
//! rounding error.
//!
//! Five rungs of increasing precision, each continuing from the basis the
//! previous one reached when its precision runs out (the size reduction stops
//! shrinking): f64 scaled by row exponents and a double with exponent, both
//! with approximate Gram entries from row copies; a double-double scaled by
//! row exponents and a double-double with exponent, with 106-bit row copies;
//! and a double-double on the exact Gram matrix. A rung's result is returned
//! only once it is proved (0.51, 0.99)-reduced (`proved_by`, the checks of
//! `l2_verify`): `l2` uses every check, `l2_proof` none that rests on a
//! published floating-point error bound.
//!
//! The state lives in `L2` and nothing is global, so its kernels (one row's
//! Gram-Schmidt recomputation, one row's size reduction) can be reused by a
//! parallel schedule.

use num_traits::{ToPrimitive, Zero};
use sagebrush_bigint::BigInt;
use crate::limbs::{Src, WRow};

/// m * 2^e with m = 0 or 0.5 <= |m| < 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fe {
    m: f64,
    e: i64,
}

/// 2^k for -1022 <= k <= 1023, straight from the exponent bits.
#[inline]
fn pow2(k: i64) -> f64 {
    f64::from_bits(((k + 1023) as u64) << 52)
}

impl Fe {
    pub const ZERO: Fe = Fe { m: 0.0, e: 0 };

    fn norm(m: f64, e: i64) -> Fe {
        if m == 0.0 || !m.is_finite() {
            return Fe { m: if m.is_finite() { 0.0 } else { m }, e: 0 };
        }
        let bits = m.to_bits();
        let ex = ((bits >> 52) & 0x7ff) as i64;
        if ex == 0 {
            // subnormal: scale up first
            return Fe::norm(m * pow2(64), e - 64);
        }
        // m = 1.f * 2^(ex - 1023) = 0.1f * 2^(ex - 1022)
        let mm = f64::from_bits((bits & !(0x7ffu64 << 52)) | (1022u64 << 52));
        Fe { m: mm, e: e + ex - 1022 }
    }

    /// The mantissa (|m| in [0.5, 1) or 0) and the same exponent with another
    /// mantissa (for outward rounding).
    pub fn mantissa(self) -> f64 {
        self.m
    }

    pub fn exponent(self) -> i64 {
        self.e
    }

    pub fn with_mantissa(self, m: f64) -> Fe {
        Fe { m, e: self.e }
    }

    /// m 2^e normalized (any finite m).
    pub fn norm_pub(m: f64, e: i64) -> Fe {
        Fe::norm(m, e)
    }

    pub fn from_f64(x: f64) -> Fe {
        Fe::norm(x, 0)
    }

    /// The nearest double-with-exponent to x (truncated to its top 64 bits).
    pub fn from_big(x: &BigInt) -> Fe {
        let b = x.bits();
        if b <= 63 {
            return Fe::norm(x.to_i64().unwrap() as f64, 0);
        }
        let sh = b - 63;
        let top = (x >> (sh as usize)).to_i64().unwrap();
        Fe::norm(top as f64, sh as i64)
    }

    #[inline]
    fn scale(m: f64, d: i64) -> f64 {
        // m * 2^d for d <= 0 (|m| < 1), flushing below the double range to 0
        if d < -1074 {
            0.0
        } else if d < -1022 {
            m * pow2(-1022) * pow2(d + 1022)
        } else {
            m * pow2(d)
        }
    }

    pub fn add(self, o: Fe) -> Fe {
        if self.m == 0.0 {
            return o;
        }
        if o.m == 0.0 {
            return self;
        }
        if self.e >= o.e {
            Fe::norm(self.m + Fe::scale(o.m, o.e - self.e), self.e)
        } else {
            Fe::norm(o.m + Fe::scale(self.m, self.e - o.e), o.e)
        }
    }

    pub fn neg(self) -> Fe {
        Fe { m: -self.m, e: self.e }
    }

    pub fn sub(self, o: Fe) -> Fe {
        self.add(o.neg())
    }

    pub fn mul(self, o: Fe) -> Fe {
        Fe::norm(self.m * o.m, self.e + o.e)
    }

    pub fn div(self, o: Fe) -> Fe {
        Fe::norm(self.m / o.m, self.e - o.e)
    }

    pub fn abs(self) -> Fe {
        Fe { m: self.m.abs(), e: self.e }
    }

    pub fn is_zero(self) -> bool {
        self.m == 0.0
    }

    /// self > o (both finite)
    pub fn gt(self, o: Fe) -> bool {
        self.sub(o).m > 0.0
    }

    /// The value as a double, saturating to +-inf or 0 outside the range.
    pub fn to_f64(self) -> f64 {
        if self.m == 0.0 {
            0.0
        } else if self.e > 1024 {
            self.m * f64::INFINITY
        } else if self.e < -1074 {
            0.0
        } else if self.e > 1000 {
            self.m * pow2(1000) * pow2(self.e - 1000)
        } else if self.e <= 0 {
            Fe::scale(self.m, self.e)
        } else {
            self.m * pow2(self.e)
        }
    }

    /// The nearest integer.
    pub fn round(self) -> BigInt {
        if self.m == 0.0 || self.e < 0 {
            return BigInt::zero();
        }
        if self.e <= 62 {
            return BigInt::from(self.to_f64().round() as i64);
        }
        // m has 53 significant bits: m * 2^53 is an integer
        let mi = (self.m * pow2(53)) as i64;
        BigInt::from(mi) << ((self.e - 53) as usize)
    }
}

/// The floating-point numbers of a rung's Gram-Schmidt data: `Fe` (53
/// bits) or `Dd` (106 bits), both with a separate exponent.
pub trait Flt: Copy + std::fmt::Debug {
    /// Whether approximate Gram entries need double-double row copies.
    const WIDE: bool;
    /// The same precision without an exponent, for the fast rungs (values
    /// scaled by the row exponents stay in the double range).
    type P: Plain;
    fn zero() -> Self;
    /// (hi + lo) 2^e.
    fn from_parts(hi: f64, lo: f64, e: i64) -> Self;
    fn from_fe(x: Fe) -> Self;
    fn from_f64(x: f64) -> Self;
    fn from_big(x: &BigInt) -> Self;
    fn add(self, o: Self) -> Self;
    fn sub(self, o: Self) -> Self;
    fn mul(self, o: Self) -> Self;
    fn div(self, o: Self) -> Self;
    fn abs(self) -> Self;
    fn is_zero(self) -> bool;
    fn is_neg(self) -> bool;
    fn gt(self, o: Self) -> bool;
    fn to_f64(self) -> f64;
    fn round(self) -> BigInt;
}

impl Flt for Fe {
    const WIDE: bool = false;
    type P = f64;
    fn zero() -> Fe {
        Fe::ZERO
    }
    fn from_parts(hi: f64, lo: f64, e: i64) -> Fe {
        Fe::norm(hi + lo, e)
    }
    fn from_fe(x: Fe) -> Fe {
        x
    }
    fn from_f64(x: f64) -> Fe {
        Fe::from_f64(x)
    }
    fn from_big(x: &BigInt) -> Fe {
        Fe::from_big(x)
    }
    fn add(self, o: Fe) -> Fe {
        Fe::add(self, o)
    }
    fn sub(self, o: Fe) -> Fe {
        Fe::sub(self, o)
    }
    fn mul(self, o: Fe) -> Fe {
        Fe::mul(self, o)
    }
    fn div(self, o: Fe) -> Fe {
        Fe::div(self, o)
    }
    fn abs(self) -> Fe {
        Fe::abs(self)
    }
    fn is_zero(self) -> bool {
        Fe::is_zero(self)
    }
    fn is_neg(self) -> bool {
        self.m < 0.0
    }
    fn gt(self, o: Fe) -> bool {
        Fe::gt(self, o)
    }
    fn to_f64(self) -> f64 {
        Fe::to_f64(self)
    }
    fn round(self) -> BigInt {
        Fe::round(self)
    }
}

/// (hi + lo) 2^e, a double-double with a separate exponent: |hi| in
/// [0.5, 1) (or both 0), |lo| <= ulp(hi) / 2. About 106 bits.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dd {
    hi: f64,
    lo: f64,
    e: i64,
}

#[inline]
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    (s, (a - (s - bb)) + (b - bb))
}

#[inline]
fn quick_two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    (s, b - (s - a))
}

impl Dd {
    /// (hi + lo) 2^e renormalized (any finite hi, lo with |lo| <~ |hi|).
    fn norm(hi: f64, lo: f64, e: i64) -> Dd {
        let (h, l) = quick_two_sum(hi, lo);
        if h == 0.0 || !h.is_finite() {
            return Dd { hi: if h.is_finite() { 0.0 } else { h }, lo: 0.0, e: 0 };
        }
        let f = Fe::norm(h, 0);
        // h = f.m 2^f.e: scale both by 2^-f.e (|f.e| < 1100)
        let k = f.e;
        let sc = |x: f64| Fe::norm(x, -k).to_f64();
        Dd { hi: f.m, lo: if l == 0.0 { 0.0 } else { sc(l) }, e: e + k }
    }

    fn neg(self) -> Dd {
        Dd { hi: -self.hi, lo: -self.lo, e: self.e }
    }
}

impl Flt for Dd {
    const WIDE: bool = true;
    type P = DD;
    fn zero() -> Dd {
        Dd { hi: 0.0, lo: 0.0, e: 0 }
    }
    fn from_parts(hi: f64, lo: f64, e: i64) -> Dd {
        Dd::norm(hi, lo, e)
    }
    fn from_fe(x: Fe) -> Dd {
        Dd { hi: x.m, lo: 0.0, e: x.e }
    }
    fn from_f64(x: f64) -> Dd {
        Dd::from_fe(Fe::from_f64(x))
    }
    /// The top 106 bits of x, exactly (two 53-bit halves).
    fn from_big(x: &BigInt) -> Dd {
        let b = x.bits();
        if b <= 63 {
            let v = x.to_i64().unwrap();
            let h = (v >> 32) as f64 * pow2(32);
            return Dd::norm(h, (v - ((v >> 32) << 32)) as f64, 0);
        }
        let sh = b.saturating_sub(106);
        let t = x >> (sh as usize);
        let hi = &t >> 53usize;
        let lo = &t - (&hi << 53usize);
        Dd::norm(hi.to_i64().unwrap() as f64 * pow2(53), lo.to_i64().unwrap() as f64, sh as i64)
    }
    fn add(self, o: Dd) -> Dd {
        if self.hi == 0.0 {
            return o;
        }
        if o.hi == 0.0 {
            return self;
        }
        let (a, b) = if self.e >= o.e { (self, o) } else { (o, self) };
        let d = b.e - a.e;
        let (bh, bl) = (Fe::scale(b.hi, d), if b.lo == 0.0 { 0.0 } else { Fe::norm(b.lo, d).to_f64() });
        let (s1, s2) = two_sum(a.hi, bh);
        let (t1, t2) = two_sum(a.lo, bl);
        let (s1, s2) = quick_two_sum(s1, s2 + t1);
        Dd::norm(s1, s2 + t2, a.e)
    }
    fn sub(self, o: Dd) -> Dd {
        self.add(o.neg())
    }
    fn mul(self, o: Dd) -> Dd {
        let p = self.hi * o.hi;
        let err = self.hi.mul_add(o.hi, -p) + (self.hi * o.lo + self.lo * o.hi);
        Dd::norm(p, err, self.e + o.e)
    }
    fn div(self, o: Dd) -> Dd {
        // three quotient digits, each from the double-double remainder
        let digit = |r: Dd| Dd::from_fe(Fe::norm(r.hi / o.hi, r.e - o.e));
        let q1 = digit(self);
        let r = self.sub(o.mul(q1));
        let q2 = digit(r);
        let r = r.sub(o.mul(q2));
        q1.add(q2).add(digit(r))
    }
    fn abs(self) -> Dd {
        if self.hi < 0.0 {
            self.neg()
        } else {
            self
        }
    }
    fn is_zero(self) -> bool {
        self.hi == 0.0
    }
    fn is_neg(self) -> bool {
        self.hi < 0.0
    }
    fn gt(self, o: Dd) -> bool {
        self.sub(o).hi > 0.0
    }
    fn to_f64(self) -> f64 {
        Fe { m: self.hi, e: self.e }.to_f64()
    }
    /// The nearest integer (ties either way).
    fn round(self) -> BigInt {
        if self.hi == 0.0 || self.e < 0 {
            return BigInt::zero();
        }
        // (hi 2^53 + lo 2^106) 2^(e - 106), hi 2^53 an integer, lo 2^106
        // rounded (an error below 2^(e - 106), irrelevant to the rounding)
        let n = ((self.hi * pow2(53)) as i128) * (1i128 << 53) + (self.lo * pow2(106)).round() as i128;
        if self.e >= 106 {
            BigInt::from(n) << ((self.e - 106) as usize)
        } else {
            let sh = 106 - self.e;
            BigInt::from((n + (1i128 << (sh - 1))) >> sh)
        }
    }
}

/// The fast rungs' numbers: f64, or a plain double-double.
pub trait Plain: Copy + std::fmt::Debug {
    fn nan() -> Self;
    fn is_nan(self) -> bool;
    fn zero() -> Self;
    fn add(self, o: Self) -> Self;
    fn sub(self, o: Self) -> Self;
    fn mul(self, o: Self) -> Self;
    fn div(self, o: Self) -> Self;
    fn is_finite(self) -> bool;
    /// x 2^-e, from an exact integer.
    fn from_big_scaled(x: &BigInt, e: i64) -> Self;
    /// (hi + lo), from the parts of an exact double-double sum.
    fn from_sum(hi: f64, lo: f64) -> Self;
    /// self 2^e in the rung's exponent type.
    fn to_flt<F: Flt>(self, e: i64) -> F;
    /// |self| 2^e as a double (saturating).
    fn mag_scaled(self, e: i64) -> f64;
    /// self 2^e rounded to an integer.
    fn round_scaled(self, e: i64) -> BigInt;
}

impl Plain for f64 {
    fn nan() -> f64 {
        f64::NAN
    }
    fn is_nan(self) -> bool {
        f64::is_nan(self)
    }
    fn zero() -> f64 {
        0.0
    }
    fn add(self, o: f64) -> f64 {
        self + o
    }
    fn sub(self, o: f64) -> f64 {
        self - o
    }
    fn mul(self, o: f64) -> f64 {
        self * o
    }
    fn div(self, o: f64) -> f64 {
        self / o
    }
    fn is_finite(self) -> bool {
        f64::is_finite(self)
    }
    fn from_big_scaled(x: &BigInt, e: i64) -> f64 {
        let f = Fe::from_big(x);
        Fe::norm(f.m, f.e - e).to_f64()
    }
    fn from_sum(hi: f64, lo: f64) -> f64 {
        hi + lo
    }
    fn to_flt<F: Flt>(self, e: i64) -> F {
        F::from_fe(Fe::norm(self, e))
    }
    fn mag_scaled(self, e: i64) -> f64 {
        Fe::norm(self.abs(), e).to_f64()
    }
    fn round_scaled(self, e: i64) -> BigInt {
        Fe::norm(self, e).round()
    }
}

/// hi + lo, |lo| <= ulp(hi) / 2: a double-double without an exponent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DD {
    hi: f64,
    lo: f64,
}

impl DD {
    fn from_f64(x: f64) -> DD {
        DD { hi: x, lo: 0.0 }
    }
}

impl Plain for DD {
    fn nan() -> DD {
        DD { hi: f64::NAN, lo: 0.0 }
    }
    fn is_nan(self) -> bool {
        self.hi.is_nan()
    }
    fn zero() -> DD {
        DD { hi: 0.0, lo: 0.0 }
    }
    fn add(self, o: DD) -> DD {
        let (s1, s2) = two_sum(self.hi, o.hi);
        let (t1, t2) = two_sum(self.lo, o.lo);
        let (s1, s2) = quick_two_sum(s1, s2 + t1);
        let (hi, lo) = quick_two_sum(s1, s2 + t2);
        DD { hi, lo }
    }
    fn sub(self, o: DD) -> DD {
        self.add(DD { hi: -o.hi, lo: -o.lo })
    }
    fn mul(self, o: DD) -> DD {
        let p = self.hi * o.hi;
        let err = self.hi.mul_add(o.hi, -p) + (self.hi * o.lo + self.lo * o.hi);
        let (hi, lo) = quick_two_sum(p, err);
        DD { hi, lo }
    }
    fn div(self, o: DD) -> DD {
        let q1 = self.hi / o.hi;
        let r = self.sub(o.mul(DD::from_f64(q1)));
        let q2 = r.hi / o.hi;
        let r = r.sub(o.mul(DD::from_f64(q2)));
        let q3 = r.hi / o.hi;
        let (hi, lo) = quick_two_sum(q1, q2);
        DD { hi, lo }.add(DD::from_f64(q3))
    }
    fn is_finite(self) -> bool {
        self.hi.is_finite() && self.lo.is_finite()
    }
    fn from_big_scaled(x: &BigInt, e: i64) -> DD {
        let d = Dd::from_big(x);
        let sc = |v: f64| if v == 0.0 { 0.0 } else { Fe::norm(v, d.e - e).to_f64() };
        let (hi, lo) = quick_two_sum(sc(d.hi), sc(d.lo));
        DD { hi, lo }
    }
    fn from_sum(hi: f64, lo: f64) -> DD {
        let (hi, lo) = two_sum(hi, lo);
        DD { hi, lo }
    }
    fn to_flt<F: Flt>(self, e: i64) -> F {
        F::from_parts(self.hi, self.lo, e)
    }
    fn mag_scaled(self, e: i64) -> f64 {
        Fe::norm(self.hi.abs(), e).to_f64()
    }
    fn round_scaled(self, e: i64) -> BigInt {
        Dd::norm(self.hi, self.lo, e).round()
    }
}

/// Why the floating-point reduction stopped.
#[derive(Debug, PartialEq)]
pub enum Stop {
    /// The size reduction of row `k` stopped shrinking: more precision needed.
    Precision { k: usize },
    /// A zero (dependent) row showed up.
    Dependent,
    /// The work counted reached `work_limit` (limb operations).
    Work,
    /// An entry grew past `bits_cap` bits.
    Bits { bits: u64 },
}

/// The largest entry a small row holds: 2^62, so that x b with |x| < 2^62
/// fits in an i128 with room, and a sum of such products is checked.
const SMALL: i64 = 1 << 62;

/// One basis row: machine integers while every entry is below 2^62 in
/// absolute value, otherwise fixed-width limbs (the approximate rungs, whose
/// row operations then allocate nothing) or big integers (the exact rung,
/// whose Gram updates are big-integer anyway); rows move both ways.
#[derive(Clone, Debug)]
pub enum Row {
    S(Vec<i64>),
    W(WRow),
    B(Vec<BigInt>),
}

impl Row {
    fn from_big(v: Vec<BigInt>) -> Row {
        let mb = v.iter().map(|x| x.bits()).max().unwrap_or(0);
        if mb <= 62 {
            Row::S(v.iter().map(|x| x.to_i64().unwrap()).collect())
        } else if limbs_pay(v.len(), WRow::width_for(mb), nnz(&v), 1) {
            Row::W(WRow::from_big(&v))
        } else {
            Row::B(v)
        }
    }

    pub fn to_big(&self) -> Vec<BigInt> {
        match self {
            Row::S(a) => a.iter().map(|&x| BigInt::from(x)).collect(),
            Row::W(w) => w.to_big(),
            Row::B(b) => b.clone(),
        }
    }

    fn into_big(self) -> Vec<BigInt> {
        match self {
            Row::S(a) => a.into_iter().map(BigInt::from).collect(),
            Row::W(w) => w.to_big(),
            Row::B(b) => b,
        }
    }

    /// The exact dot product.
    fn dot(&self, o: &Row) -> BigInt {
        match (self, o) {
            (Row::S(a), Row::S(b)) => {
                let mut acc: i128 = 0;
                for (x, y) in a.iter().zip(b) {
                    match acc.checked_add(*x as i128 * *y as i128) {
                        Some(v) => acc = v,
                        None => return dot(&self.to_big(), &o.to_big()),
                    }
                }
                BigInt::from(acc)
            }
            _ => dot(&self.to_big(), &o.to_big()),
        }
    }
}

/// Whether a row of n entries is cheaper to operate on in w limbs each than
/// as big integers with `nnz` nonzero entries: a big-integer entry's
/// operation costs about 14 limb operations, whatever its size up to ~1000
/// bits (measured, limbs::calib). `slack` > 1 keeps a row where it is unless
/// the other form is clearly cheaper.
fn limbs_pay(n: usize, w: usize, nnz: usize, slack: usize) -> bool {
    n * w <= 14 * nnz * slack
}

fn nnz(b: &[BigInt]) -> usize {
    b.iter().filter(|x| !x.is_zero()).count()
}

/// Limbs of a `bits`-bit integer (at least 1).
fn limbs(bits: u64) -> u64 {
    bits.div_ceil(64).max(1)
}

/// Declares an item `pub` in tests or with the `bench` feature (the
/// benchmarks drive the reducer's rungs themselves), `pub(crate)` otherwise:
/// a build that ships has no way into the reducer but `l2_budgeted`.
macro_rules! bench_pub {
    ($(#[$m:meta])* struct $($rest:tt)*) => {
        $(#[$m])*
        #[cfg(any(test, feature = "bench"))]
        pub struct $($rest)*
        $(#[$m])*
        #[cfg(not(any(test, feature = "bench")))]
        pub(crate) struct $($rest)*
    };
}

bench_pub! {
    /// The L^2 state for one basis (independent rows).
    struct L2<F: Flt = Fe> {
        pub basis: Vec<Row>,
        /// Gram entries exact (maintained under row operations) or approximate
        /// (dot products of the rows' floating-point copies, recomputed exactly
        /// when they cancel)
        exact: bool,
        /// exact mode: the Gram matrix, lower triangle g[i][j] (j <= i)
        g: Vec<Vec<BigInt>>,
        /// approximate mode: row i ~ ap[i] * 2^ex[i] (doubles of at most 63-bit
        /// integers), with nrm[i] = sum ap[i][t]^2
        ap: Vec<Vec<f64>>,
        /// with double-double rungs (F::WIDE), the copies have 106 bits:
        /// row i ~ (ap[i] + al[i]) 2^ex[i], both parts exact doubles
        al: Vec<Vec<f64>>,
        ex: Vec<i64>,
        nrm: Vec<f64>,
        /// the fast rung (approximate mode): the Gram-Schmidt data as plain doubles
        /// scaled by the row exponents, r64[k][j] = r_kj 2^-(e_k + e_j) and
        /// mu64[k][j] = mu_kj 2^-(e_k - e_j), s64 likewise 2^-2e_k; the recurrences
        /// are then the plain ones (every term of row k's carries the same scale)
        fast: bool,
        /// the fast rung's scaled Gram entries G_ij 2^-(e_i + e_j), lower
        /// triangle, cached (NaN = to compute): a swap moves them with the rows,
        /// a change of row i's integers invalidates row and column i
        gh: Vec<Vec<F::P>>,
        r64: Vec<Vec<F::P>>,
        mu64: Vec<Vec<F::P>>,
        s64: F::P,
        r: Vec<Vec<F>>,
        mu: Vec<Vec<F>>,
        /// s = G_kk - sum_{i < k-1} mu_ki r_ki for the row last recomputed: the
        /// squared norm of b_k's projection orthogonal to b_0..b_{k-2}, which the
        /// Lovasz test needs (one subtraction short of r_kk, whose cancellation
        /// can be complete before the test passes)
        s_last: F,
        /// eta', delta' in the floating-point tests
        eta: f64,
        delta: f64,
        /// work done so far in limb operations (an upper estimate: the
        /// Gram-Schmidt row and Gram entries of each size-reduction pass, and
        /// every row operation's limbs), and the limit and entry cap a caller's
        /// budget sets (no limit by default)
        pub work: u64,
        pub work_limit: u64,
        pub bits_cap: u64,
        /// exact dot products the approximate Gram entries fell back to (in
        /// `&self` methods), folded into `work` after each pass
        side: std::cell::Cell<u64>,
        /// statistics, for tests and tuning
        pub swaps: u64,
        pub reductions: u64,
    }
}

fn dot(x: &[BigInt], y: &[BigInt]) -> BigInt {
    let mut s = BigInt::zero();
    for (a, b) in x.iter().zip(y) {
        if !a.is_zero() && !b.is_zero() {
            s += a * b;
        }
    }
    s
}

impl<F: Flt> L2<F> {
    /// The fast rung: approximate Gram entries and doubles scaled by the row
    /// exponents.
    pub fn new_fast(basis: Vec<Vec<BigInt>>) -> L2<F> {
        let mut s = L2::<F>::new(basis, false);
        s.fast = true;
        s
    }

    /// The state for `basis`, with exact or approximate Gram entries.
    pub fn new(basis: Vec<Vec<BigInt>>, exact: bool) -> L2<F> {
        let d = basis.len();
        let g = if exact { (0..d).map(|i| (0..=i).map(|j| dot(&basis[i], &basis[j])).collect()).collect() } else { vec![] };
        // exact mode keeps big rows (its Gram updates are big-integer anyway)
        let basis: Vec<Row> = basis.into_iter().map(|v| if exact { Row::B(v) } else { Row::from_big(v) }).collect();
        let mut s = L2 {
            basis,
            exact,
            g,
            ap: vec![vec![]; d],
            al: vec![vec![]; d],
            ex: vec![0; d],
            nrm: vec![0.0; d],
            fast: false,
            gh: (0..d).map(|i| vec![F::P::nan(); i + 1]).collect(),
            r64: (0..d).map(|i| vec![F::P::zero(); i + 1]).collect(),
            mu64: (0..d).map(|i| vec![F::P::zero(); i + 1]).collect(),
            s64: F::P::zero(),
            r: (0..d).map(|i| vec![F::zero(); i + 1]).collect(),
            mu: (0..d).map(|i| vec![F::zero(); i + 1]).collect(),
            s_last: F::zero(),
            // a margin over the target (0.51, 0.99) that the final proof
            // needs: the output is certified against the target, not these
            eta: 0.505,
            delta: 0.995,
            work: 0,
            side: std::cell::Cell::new(0),
            work_limit: u64::MAX,
            bits_cap: u64::MAX,
            swaps: 0,
            reductions: 0,
        };
        if !exact {
            for i in 0..d {
                s.approx_row(i);
            }
        }
        s
    }

    /// Refresh row i's floating-point copy: its entries shifted right so the
    /// largest has at most 63 bits, as doubles.
    fn approx_row(&mut self, i: usize) {
        self.approx_row_(i)
    }

    fn approx_row_(&mut self, i: usize) {
        let row = &mut self.ap[i];
        row.clear();
        let mut sh = 0;
        match &self.basis[i] {
            Row::S(a) => row.extend(a.iter().map(|&x| x as f64)),
            Row::W(w) => {
                let mb = w.max_bits();
                if mb <= 62 {
                    let a: Vec<i64> = (0..w.len()).map(|e| w.low(e)).collect();
                    row.extend(a.iter().map(|&x| x as f64));
                    self.basis[i] = Row::S(a);
                } else if !limbs_pay(w.len(), WRow::width_for(mb), w.nnz(), 2) {
                    // turned sparse: big integers (refreshed below)
                    self.basis[i] = Row::B(w.to_big());
                    return self.approx_row_(i);
                } else {
                    // narrowed when two limbs too wide (not every time
                    // it shrinks: the next operation would widen it again)
                    if WRow::width_for(mb) + 2 <= w.w {
                        let Row::W(w) = &mut self.basis[i] else { unreachable!() };
                        w.narrow(WRow::width_for(mb));
                    }
                    let Row::W(w) = &self.basis[i] else { unreachable!() };
                    sh = mb - 63;
                    w.shifted(sh, row);
                }
            }
            Row::B(b) => {
                let mb = b.iter().map(|x| x.bits()).max().unwrap_or(0);
                if mb <= 62 && !self.exact {
                    // back to machine integers
                    let a: Vec<i64> = b.iter().map(|x| x.to_i64().unwrap()).collect();
                    row.extend(a.iter().map(|&x| x as f64));
                    self.basis[i] = Row::S(a);
                } else if !self.exact && limbs_pay(b.len(), WRow::width_for(mb), nnz(b), 1) {
                    // turned dense: limbs (refreshed below)
                    self.basis[i] = Row::W(WRow::from_big(b));
                    return self.approx_row_(i);
                } else {
                    sh = mb.saturating_sub(63);
                    if sh == 0 {
                        row.extend(b.iter().map(|x| x.to_i64().unwrap() as f64));
                    } else {
                        row.extend(b.iter().map(|x| if x.bits() > sh { (x >> (sh as usize)).to_i64().unwrap() as f64 } else { 0.0 }));
                    }
                }
            }
        }
        self.ex[i] = sh as i64;
        if F::WIDE && !self.exact {
            self.wide_copy(i);
        }
        self.nrm[i] = if self.al[i].is_empty() {
            self.ap[i].iter().map(|v| v * v).sum()
        } else {
            self.ap[i].iter().zip(&self.al[i]).map(|(h, l)| (h + l) * (h + l)).sum()
        };
        if self.fast {
            for j in 0..=i {
                self.gh[i][j] = F::P::nan();
            }
            for k in i + 1..self.gh.len() {
                self.gh[k][i] = F::P::nan();
            }
        }
    }

    /// Row i's 106-bit copy: entries shifted right so the largest has at most
    /// 106 bits, split exactly into a high double (the nearest multiple of
    /// 2^53) and a low one.
    fn wide_copy(&mut self, i: usize) {
        let mut v: Vec<i128> = vec![];
        let sh = match &self.basis[i] {
            Row::S(a) => {
                v.extend(a.iter().map(|&x| x as i128));
                0
            }
            Row::W(w) => {
                let sh = w.max_bits().saturating_sub(106);
                w.shifted128(sh, &mut v);
                sh
            }
            Row::B(b) => {
                let mb = b.iter().map(|x| x.bits()).max().unwrap_or(0);
                let sh = mb.saturating_sub(106);
                v.extend(b.iter().map(|x| if x.bits() > sh { (x >> (sh as usize)).to_i128().unwrap() } else { 0 }));
                sh
            }
        };
        let (hi, lo) = (&mut self.ap[i], &mut self.al[i]);
        hi.clear();
        lo.clear();
        for x in v {
            // the nearest multiple of 2^53: |low| <= 2^52, and a small
            // entry (of either sign) is all low part
            let h = ((x + (1i128 << 52)) >> 53) << 53;
            hi.push(h as f64);
            lo.push((x - h) as f64);
        }
        self.ex[i] = sh as i64;
    }

    /// G_ij from the 106-bit copies, as a double-double (error-free products
    /// of the high parts, the other terms in doubles: all of a small row
    /// sits in its low parts), or the exact dot
    /// product when it cancelled (below 2^-60 of the norms' geometric mean).
    fn gram_wide(&self, i: usize, j: usize) -> F {
        match self.gram_wide_raw(i, j) {
            Some((s, c)) => F::from_parts(s, c, self.ex[i] + self.ex[j]),
            None => {
                self.charge_dot(i, j);
                F::from_big(&self.basis[i].dot(&self.basis[j]))
            }
        }
    }

    /// The copies' dot product (hi, lo), G_ij 2^-(e_i + e_j); None when it
    /// cancelled (the caller takes the exact dot product).
    fn gram_wide_raw(&self, i: usize, j: usize) -> Option<(f64, f64)> {
        let (ah, al, bh, bl) = (&self.ap[i], &self.al[i], &self.ap[j], &self.al[j]);
        let (mut s, mut c) = (0.0f64, 0.0f64);
        for t in 0..ah.len() {
            let p = ah[t] * bh[t];
            let e = ah[t].mul_add(bh[t], -p);
            let (s2, err) = two_sum(s, p);
            s = s2;
            c += err + e + (ah[t] * bl[t] + al[t] * bh[t] + al[t] * bl[t]);
        }
        // the high parts' sum can cancel against the low terms: test the
        // total
        let (s, c) = two_sum(s, c);
        let bound = (self.nrm[i] * self.nrm[j]).sqrt() * 2f64.powi(-60);
        if s.abs() <= bound || !s.is_finite() {
            #[cfg(test)]
            WIDE_EXACT_DOTS.with(|c| c.set(c.get() + 1));
            return None;
        }
        Some((s, c))
    }

    /// G_ij as a double with exponent: exact in exact mode; in approximate
    /// mode the copies' dot product, or the exact one when that cancelled
    /// (below 2^-30 of the norms' geometric mean).
    fn gram_fe(&self, i: usize, j: usize) -> Fe {
        if self.exact {
            return Fe::from_big(self.gram(i, j));
        }
        let (a, b) = (&self.ap[i], &self.ap[j]);
        let mut s = 0.0;
        for t in 0..a.len() {
            s += a[t] * b[t];
        }
        let bound = (self.nrm[i] * self.nrm[j]).sqrt() * 2f64.powi(-30);
        if s.abs() <= bound || !s.is_finite() {
            self.charge_dot(i, j);
            return Fe::from_big(&self.basis[i].dot(&self.basis[j]));
        }
        Fe::norm(s, self.ex[i] + self.ex[j])
    }

    /// G_ij in the rung's precision (all of it when exact).
    fn gram_f(&self, i: usize, j: usize) -> F {
        if self.exact {
            F::from_big(self.gram(i, j))
        } else if F::WIDE {
            self.gram_wide(i, j)
        } else {
            F::from_fe(self.gram_fe(i, j))
        }
    }

    fn gram(&self, i: usize, j: usize) -> &BigInt {
        if j <= i {
            &self.g[i][j]
        } else {
            &self.g[j][i]
        }
    }

    /// G_kj 2^-(e_k + e_j) as a double (the fast rung), from the cache.
    fn gram_hat_c(&mut self, i: usize, j: usize) -> F::P {
        let (a, b) = if j <= i { (i, j) } else { (j, i) };
        let v = self.gh[a][b];
        if !v.is_nan() {
            return v;
        }
        let v = self.gram_hat(a, b);
        self.gh[a][b] = v;
        v
    }

    /// G_kj 2^-(e_k + e_j) (the fast rungs).
    fn gram_hat(&self, i: usize, j: usize) -> F::P {
        if F::WIDE {
            return match self.gram_wide_raw(i, j) {
                Some((s, c)) => F::P::from_sum(s, c),
                None => {
                    self.charge_dot(i, j);
                    F::P::from_big_scaled(&self.basis[i].dot(&self.basis[j]), self.ex[i] + self.ex[j])
                }
            };
        }
        let (a, b) = (&self.ap[i], &self.ap[j]);
        let mut s = 0.0;
        for t in 0..a.len() {
            s += a[t] * b[t];
        }
        let bound = (self.nrm[i] * self.nrm[j]).sqrt() * 2f64.powi(-30);
        if s.abs() <= bound || !s.is_finite() {
            self.charge_dot(i, j);
            return F::P::from_big_scaled(&self.basis[i].dot(&self.basis[j]), self.ex[i] + self.ex[j]);
        }
        F::P::from_sum(s, 0.0)
    }

    /// The fast rung's row k; false when a value left the double range.
    fn gso_row64(&mut self, k: usize) -> bool {
        for j in 0..=k {
            let mut s = self.gram_hat_c(k, j);
            let (rk, mj) = (&self.r64[k], &self.mu64[j]);
            for i in 0..j {
                if j == k && i + 1 == k {
                    self.s64 = s;
                }
                s = s.sub(mj[i].mul(rk[i]));
            }
            if k == 0 {
                self.s64 = s;
            }
            self.r64[k][j] = s;
            if j < k {
                let m = s.div(self.r64[j][j]);
                if !m.is_finite() {
                    return false;
                }
                self.mu64[k][j] = m;
            }
        }
        true
    }

    /// |mu_kj| (saturating), mu_kj rounded, and the update of row k's mu
    /// after b_k -= x b_j: in whichever rung is running.
    fn mu_mag(&self, k: usize, j: usize) -> f64 {
        if self.fast {
            self.mu64[k][j].mag_scaled(self.ex[k] - self.ex[j])
        } else {
            self.mu[k][j].abs().to_f64()
        }
    }

    fn mu_round(&self, k: usize, j: usize) -> BigInt {
        if self.fast {
            self.mu64[k][j].round_scaled(self.ex[k] - self.ex[j])
        } else {
            self.mu[k][j].round()
        }
    }

    fn mu_sub(&mut self, k: usize, j: usize, x: &BigInt) {
        if self.fast {
            // mu_ki -= x mu_ji in the scaled units: mu64_ki -= x 2^(e_j - e_k) mu64_ji
            let xh = F::P::from_big_scaled(x, self.ex[k] - self.ex[j]);
            let (lo, hi) = self.mu64.split_at_mut(k);
            let (mk, mj) = (&mut hi[0], &lo[j]);
            for i in 0..j {
                mk[i] = mk[i].sub(xh.mul(mj[i]));
            }
            mk[j] = mk[j].sub(xh);
        } else {
            let xf = F::from_big(x);
            for i in 0..j {
                self.mu[k][i] = self.mu[k][i].sub(xf.mul(self.mu[j][i]));
            }
            self.mu[k][j] = self.mu[k][j].sub(xf);
        }
    }

    /// r_jj, s (of the last row recomputed) and r_kk as doubles with exponent.
    fn rjj(&self, j: usize) -> F {
        if self.fast {
            self.r64[j][j].to_flt(2 * self.ex[j])
        } else {
            self.r[j][j]
        }
    }

    fn s_of(&self, k: usize) -> F {
        if self.fast {
            self.s64.to_flt(2 * self.ex[k])
        } else {
            self.s_last
        }
    }

    /// Recompute r[k][0..=k] and mu[k][0..k] from the exact Gram row k and
    /// the data of rows < k (the Cholesky recurrence).
    fn gso_row(&mut self, k: usize) {
        for j in 0..=k {
            let mut s = self.gram_f(k, j);
            for i in 0..j {
                if j == k && i + 1 == k {
                    self.s_last = s;
                }
                s = s.sub(self.mu[j][i].mul(self.r[k][i]));
            }
            self.r[k][j] = s;
            if j < k {
                self.mu[k][j] = s.div(self.r[j][j]);
            }
        }
    }

    /// b_k -= x b_j, exactly, with the Gram matrix updated exactly:
    /// G_kk -= 2 x G_kj - x^2 G_jj, G_ki -= x G_ji (i != k).
    fn sub_row(&mut self, k: usize, j: usize, x: &BigInt) {
        let (bk, bj) = if j < k {
            let (lo, hi) = self.basis.split_at_mut(k);
            (&mut hi[0], &lo[j])
        } else {
            let (lo, hi) = self.basis.split_at_mut(j);
            (&mut lo[k], &hi[0])
        };
        // both small and x small: in i128, written only if every entry stays small
        if let (Row::S(a), Row::S(b), Some(xi)) = (&mut *bk, bj, x.to_i64()) {
            if xi.unsigned_abs() < SMALL as u64 {
                let xi = xi as i128;
                let fits = a.iter().zip(b.iter()).all(|(&u, &v)| (u as i128 - xi * v as i128).unsigned_abs() < SMALL as u128);
                if fits {
                    for (u, &v) in a.iter_mut().zip(b.iter()) {
                        *u = (*u as i128 - xi * v as i128) as i64;
                    }
                    #[cfg(test)]
                    ACTUAL_LIMB_OPS.with(|c| c.set(c.get() + a.len() as u64));
                    return;
                }
            }
        }
        // the approximate rungs, x a machine integer: in limbs, the row
        // widened first so the results fit (approx_row may turn it back)
        let no_big = !matches!(bk, Row::B(_)) && !matches!(bj, Row::B(_));
        if let (false, true, Some(xi)) = (self.exact, no_big, x.to_i64()) {
            if let Row::S(a) = bk {
                *bk = Row::W(WRow::from_i64(a, 2));
            }
            let Row::W(a) = bk else { unreachable!() };
            let src = match bj {
                Row::S(b) => Src::S(b),
                Row::W(b) => Src::W(b),
                Row::B(_) => unreachable!(),
            };
            let need = a.max_bits().max(src.max_bits() + 64 - xi.unsigned_abs().leading_zeros() as u64) + 2;
            a.widen(WRow::width_for(need));
            a.sub_mul(src, xi);
            #[cfg(test)]
            ACTUAL_LIMB_OPS.with(|c| c.set(c.get() + (a.len() * a.w) as u64));
            return;
        }
        if let Row::W(w) = bk {
            // a big multiplier, or a big-integer row j
            *bk = Row::B(w.to_big());
        }
        // big integers (row k a big row; approx_row may turn it back), with
        // the Gram matrix in the exact rung
        if let Row::S(a) = bk {
            *bk = Row::B(a.iter().map(|&u| BigInt::from(u)).collect());
        }
        let Row::B(a) = bk else { unreachable!() };
        #[cfg(test)]
        {
            // the schoolbook limb products and sums of this row operation
            let lx = limbs(x.bits());
            let bj_big = bj.to_big();
            let c: u64 = a.iter().zip(&bj_big).map(|(u, v)| if v.is_zero() { 0 } else { limbs(v.bits()) * lx + limbs(u.bits()) }).sum();
            ACTUAL_LIMB_OPS.with(|cell| cell.set(cell.get() + c));
        }
        match bj {
            Row::S(b) => {
                for (u, &v) in a.iter_mut().zip(b.iter()) {
                    if v != 0 {
                        sagebrush_bigint::sub_mul_assign(u, x, &BigInt::from(v));
                    }
                }
            }
            Row::B(b) => {
                for (u, v) in a.iter_mut().zip(b.iter()) {
                    if !v.is_zero() {
                        sagebrush_bigint::sub_mul_assign(u, x, v);
                    }
                }
            }
            Row::W(w) => {
                for (u, v) in a.iter_mut().zip(w.to_big()) {
                    if !v.is_zero() {
                        sagebrush_bigint::sub_mul_assign(u, x, &v);
                    }
                }
            }
        }
        if !self.exact {
            return;
        }
        let d = self.basis.len();
        #[cfg(test)]
        {
            let lx = limbs(x.bits());
            let mut c = 0;
            for i in 0..d {
                if i != k {
                    c += limbs(self.gram(j, i).bits()) * lx + limbs(self.gram(k, i).bits());
                }
            }
            c += limbs(self.gram(k, j).bits()) * lx * 2 + limbs(self.g[j][j].bits()) * lx * (lx + 1) + limbs(self.g[k][k].bits());
            ACTUAL_LIMB_OPS.with(|cell| cell.set(cell.get() + c));
        }
        let gkj = self.gram(k, j).clone();
        let gjj = self.g[j][j].clone();
        let gkk = &self.g[k][k] - (&gkj * x) * 2u32 + &gjj * x * x;
        for i in 0..d {
            if i == k {
                continue;
            }
            let v = self.gram(k, i) - x * self.gram(j, i);
            if i < k {
                self.g[k][i] = v;
            } else {
                self.g[i][k] = v;
            }
        }
        self.g[k][k] = gkk;
    }

    /// Lazy size reduction of row k (rows < k reduced): until every
    /// |mu_kj| <= eta'. Err when it stops shrinking.
    fn size_reduce(&mut self, k: usize) -> Result<(), Stop> {
        let mut last = f64::INFINITY;
        let mut stalls = 0;
        loop {
            sagebrush_interrupt::check();
            // this pass: row k's Gram entries (k + 1 dot products of n) and its
            // Gram-Schmidt row (k^2), in the rung's arithmetic (a double-
            // double or exponent operation counted as 8)
            let n = self.row_len();
            let per = if self.exact { 16 } else if F::WIDE || !self.fast { 8 } else { 1 };
            self.work = self.work.saturating_add(per * ((k as u64 + 1) * n + (k as u64) * (k as u64)));
            if self.work > self.work_limit {
                return Err(Stop::Work);
            }
            if self.fast {
                if !self.gso_row64(k) {
                    return Err(Stop::Precision { k });
                }
            } else {
                self.gso_row(k);
            }
            self.work = self.work.saturating_add(self.side.take());
            if self.work > self.work_limit {
                return Err(Stop::Work);
            }
            let mx = (0..k).map(|j| self.mu_mag(k, j)).fold(0.0, f64::max);
            if mx <= self.eta {
                return Ok(());
            }
            // the largest |mu| must keep shrinking (by a few bits) or precision is short
            if mx > last / 32.0 {
                stalls += 1;
                if stalls > 2 {
                    return Err(Stop::Precision { k });
                }
            } else {
                stalls = 0;
            }
            last = mx;
            self.reductions += 1;
            for j in (0..k).rev() {
                let x = self.mu_round(k, j);
                if x.is_zero() {
                    continue;
                }
                // debited before it is done: the row operation, row k's mu
                // update, and in the exact rung the Gram update
                self.work = self.work.saturating_add(self.row_op_cost(k, j, &x)).saturating_add(per * k as u64);
                if self.work > self.work_limit {
                    return Err(Stop::Work);
                }
                // the cap holds for every row at every step: x b_j beyond it
                // makes b_k - x b_j exceed it too (b_k is within it), so that
                // is refused before it is computed; the result is checked
                let pre = x.bits().saturating_add(self.row_bits(j));
                if pre > self.bits_cap.saturating_add(2) {
                    return Err(Stop::Bits { bits: pre });
                }
                self.mu_sub(k, j, &x);
                self.sub_row(k, j, &x);
                let bits = self.row_bits(k);
                if bits > self.bits_cap {
                    return Err(Stop::Bits { bits });
                }
            }
            if !self.exact {
                self.approx_row(k);
            }
            let bits = self.row_bits(k);
            if bits > self.bits_cap {
                return Err(Stop::Bits { bits });
            }
        }
    }

    fn swap(&mut self, k: usize) {
        // rows k-1 and k: basis, Gram rows and columns
        self.basis.swap(k - 1, k);
        self.swaps += 1;
        if !self.exact {
            self.ap.swap(k - 1, k);
            self.al.swap(k - 1, k);
            self.ex.swap(k - 1, k);
            self.nrm.swap(k - 1, k);
            if self.fast {
                let (a, b) = (k - 1, k);
                for i in 0..self.gh.len() {
                    if i == a || i == b {
                        continue;
                    }
                    if i < a {
                        let t = self.gh[a][i];
                        self.gh[a][i] = self.gh[b][i];
                        self.gh[b][i] = t;
                    } else {
                        let t = self.gh[i][a];
                        self.gh[i][a] = self.gh[i][b];
                        self.gh[i][b] = t;
                    }
                }
                let t = self.gh[a][a];
                self.gh[a][a] = self.gh[b][b];
                self.gh[b][b] = t;
            }
            return;
        }
        let d = self.basis.len();
        // swap entries of the lower-triangular Gram matrix
        let a = k - 1;
        let b = k;
        for i in 0..d {
            if i == a || i == b {
                continue;
            }
            let ga = self.gram(a, i).clone();
            let gb = self.gram(b, i).clone();
            if i < a {
                self.g[a][i] = gb;
                self.g[b][i] = ga;
            } else {
                // i > b
                self.g[i][a] = gb;
                self.g[i][b] = ga;
            }
        }
        let gaa = self.g[a][a].clone();
        self.g[a][a] = self.g[b][b].clone();
        self.g[b][b] = gaa;
    }

    #[cfg(any(test, feature = "bench"))]
    /// Whether the current basis is (0.51, 0.99)-reduced, by `proved_by`'s
    /// chain: for rows with large entries, intervals from the rows (double-word,
    /// then multi-double); then on the exact Gram matrix 53-bit, double-word
    /// (not when `wide`), multi-double and, when `wide`, p-bit intervals; else
    /// decided exactly (`lll_cert::reduced`, which costs O(d^3) big-integer
    /// operations: much more than the reduction in large dimensions).
    pub fn proved(&self, wide: bool) -> bool {
        self.proved_by(wide).is_some()
    }

    #[cfg(any(test, feature = "bench"))]
    /// The check that proved the basis reduced ("dw-rows", "dd-rows", "53",
    /// "dw", "md2".."md4",
    /// "p<bits>", "exact"), or None when it is not reduced.
    pub fn proved_by(&self, wide: bool) -> Option<String> {
        self.proved_by_with(wide, ProofPath::Default)
    }

    /// `proved_by`, or (the memory bound's tests) one path of it: the same
    /// Gram matrix built, then only the multi-double checks, or only the
    /// exact one.
    fn proved_by_with(&self, wide: bool, path: ProofPath) -> Option<String> {
        let d = self.basis.len();
        // rows with large entries: the exact Gram matrix in machine words up
        // to 8 limbs an entry (a product costs ~w^2 word multiplications);
        // wider, the double-double proof from the rows (~300 ns an entry)
        let g: Vec<Vec<BigInt>> = if self.basis.iter().any(|r| matches!(r, Row::B(_) | Row::W(_))) {
            let rows: Vec<Vec<BigInt>> = self.basis.iter().map(|r| r.to_big()).collect();
            let m = crate::limbs::MagRows::new(&rows);
            if m.width() > 8 && path == ProofPath::Default {
                if !wide && crate::l2_verify::verify_rows_dw(&rows) == crate::l2_verify::Verdict::Proved {
                    return Some("dw-rows".into());
                }
                if crate::l2_verify::verify_rows_dd(&rows) {
                    return Some("dd-rows".into());
                }
            }
            (0..d).map(|i| (0..=i).map(|j| m.dot(i, j)).collect()).collect()
        } else {
            (0..d).map(|i| (0..=i).map(|j| self.basis[i].dot(&self.basis[j])).collect()).collect()
        };
        match path {
            ProofPath::Default => {
                if let Some(r) = crate::l2_verify::verify_rung(&g, wide) {
                    return Some(r);
                }
            }
            ProofPath::MultiDouble => {
                if let Some(r) = crate::l2_verify::verify_multi_double(&g) {
                    return Some(r);
                }
            }
            ProofPath::PBit => {
                if let Some(r) = crate::l2_verify::verify_pbit(&g) {
                    return Some(r);
                }
            }
            ProofPath::Exact => {}
        }
        #[cfg(test)]
        EXACT_CHECKS.with(|c| c.set(c.get() + 1));
        let rows: Vec<Vec<BigInt>> = self.basis.iter().map(|r| r.to_big()).collect();
        crate::lll_cert::reduced(&rows, (51, 100), (99, 100)).is_ok().then(|| "exact".into())
    }

    /// b_k -= x b_j in limb operations (schoolbook products and sums of the
    /// actual operands); in the exact rung, with the Gram update: G_ki -=
    /// x G_ji for every i != k, and G_kk -= 2 x G_kj - x^2 G_jj.
    fn row_op_cost(&self, k: usize, j: usize, x: &BigInt) -> u64 {
        let lx = limbs(x.bits());
        let mut c = self.row_limbs(j).saturating_mul(lx).saturating_add(self.row_limbs(k));
        if self.exact {
            let lg = |a: usize, b: usize| limbs(self.gram(a, b).bits());
            for i in 0..self.basis.len() {
                if i != k {
                    c = c.saturating_add(lg(j, i).saturating_mul(lx)).saturating_add(lg(k, i));
                }
            }
            c = c.saturating_add(lg(k, j).saturating_mul(lx).saturating_mul(2)).saturating_add(lg(j, j).saturating_mul(lx).saturating_mul(lx + 1)).saturating_add(lg(k, k));
        }
        c
    }

    /// An exact dot product of rows i and j (a fallback of the approximate
    /// Gram entries), charged where it happens.
    fn charge_dot(&self, i: usize, j: usize) {
        let n = self.row_len();
        let c = n.saturating_mul(limbs(self.row_bits(i)).saturating_mul(limbs(self.row_bits(j))) + 1);
        self.side.set(self.side.get().saturating_add(c));
    }

    /// The proof check's stages, in proved_by's order, with their costs in
    /// limb operations (from the dimension, the row length and the largest
    /// entry): (the check's name prefix, cost).
    fn check_stages(&self, wide: bool) -> Vec<(&'static str, u64)> {
        let (d, n) = (self.basis.len() as u64, self.row_len());
        let lb = limbs((0..self.basis.len()).map(|i| self.row_bits(i)).max().unwrap_or(0));
        let g2 = (d.saturating_mul(d.saturating_add(1)) / 2).saturating_mul(n);
        let d3 = d.saturating_mul(d).saturating_mul(d) / 3 + 1;
        let mut v = vec![];
        if lb > 8 {
            // (plus the entries' conversions: to_big and the intervals' own,
            // 2 d n lb)
            let conv = d.saturating_mul(n).saturating_mul(2 * lb);
            if !wide {
                v.push(("dw-rows", g2.saturating_add(d3).saturating_mul(16).saturating_add(conv)));
            }
            v.push(("dd-rows", g2.saturating_add(d3).saturating_mul(64 * (4 + 9)).saturating_add(conv)));
        }
        // the exact Gram matrix, then the interval rungs
        v.push(("gram", g2.saturating_mul(lb * lb + 1)));
        v.push(("53", d3.saturating_mul(4)));
        if wide {
            v.push(("md2", d3.saturating_mul(64 * 4)));
        } else {
            v.push(("dw", d3.saturating_mul(16)));
        }
        v.push(("md3", d3.saturating_mul(64 * 9)));
        v.push(("md4", d3.saturating_mul(64 * 16)));
        if wide {
            let (p1, p2) = (limbs(48 + d), limbs(96 + 2 * d));
            v.push(("p", d3.saturating_mul(8 * (p1 * p1 + p2 * p2))));
        }
        // the exact check: its own Gram matrix, then the integral
        // Gram-Schmidt: ~d^3 / 6 updates of two products and an exact
        // division of values up to ~2 d lb limbs
        v.push(("exact", d3.saturating_mul(12 * d * d).saturating_mul(lb * lb).saturating_add(g2.saturating_mul(lb * lb + 1))));
        v
    }

    /// The rows' length (at least 1).
    fn row_len(&self) -> u64 {
        let n = match self.basis.first() {
            Some(Row::S(a)) => a.len(),
            Some(Row::W(w)) => w.len(),
            Some(Row::B(b)) => b.len(),
            None => 0,
        };
        n.max(1) as u64
    }

    /// Row k's limbs (a row operation's cost) and largest entry's bits.
    fn row_limbs(&self, k: usize) -> u64 {
        match &self.basis[k] {
            Row::S(a) => a.len() as u64,
            Row::W(w) => (w.len() * w.w) as u64,
            Row::B(b) => b.iter().map(|x| x.bits().div_ceil(64).max(1)).sum(),
        }
    }

    fn row_bits(&self, k: usize) -> u64 {
        match &self.basis[k] {
            Row::S(a) => a.iter().map(|&x| 64 - x.unsigned_abs().leading_zeros() as u64).max().unwrap_or(0),
            Row::W(w) => w.max_bits(),
            Row::B(b) => b.iter().map(|x| x.bits()).max().unwrap_or(0),
        }
    }

    #[cfg(any(test, feature = "bench"))]
    /// The exact dot product of rows i and j.
    pub fn dot_rows(&self, i: usize, j: usize) -> BigInt {
        self.basis[i].dot(&self.basis[j])
    }

    #[cfg(any(test, feature = "bench"))]
    /// Row i as big integers.
    pub fn row_big(&self, i: usize) -> Vec<BigInt> {
        self.basis[i].to_big()
    }

    /// The basis as big-integer rows.
    pub fn into_basis(self) -> Vec<Vec<BigInt>> {
        self.basis.into_iter().map(Row::into_big).collect()
    }

    fn first_row(&mut self) {
        if self.fast {
            self.r64[0][0] = self.gram_hat_c(0, 0);
        } else {
            self.r[0][0] = self.gram_f(0, 0);
        }
    }

    /// Run L^2 to the end (rows independent).
    pub fn run(&mut self) -> Result<(), Stop> {
        let d = self.basis.len();
        if d == 0 {
            return Ok(());
        }
        self.first_row();
        if self.rjj(0).is_zero() {
            return Err(Stop::Dependent);
        }
        let mut k = 1;
        while k < d {
            self.size_reduce(k)?;
            let s = self.s_of(k);
            let lhs = F::from_f64(self.delta).mul(self.rjj(k - 1));
            if lhs.gt(s) {
                self.swap(k);
                k = if k > 1 { k - 1 } else { 1 };
                if k == 1 {
                    self.first_row();
                }
            } else {
                // Lovasz holds, so r_kk >= (delta' - eta'^2) r_{k-1,k-1} up to rounding:
                // a non-positive r_kk here is a dependent row (or lost precision)
                let rkk = self.rjj(k);
                if rkk.is_zero() || rkk.is_neg() {
                    return Err(Stop::Dependent);
                }
                k += 1;
            }
        }
        Ok(())
    }
}

/// L^2-reduce the independent rows; the result is (0.51, 0.99)-LLL-reduced
/// and spans the same lattice (only unimodular integer row operations).
/// Reducedness is proved by the first of: double-word intervals from the rows
/// (large entries) or multi-double ones; then, on the exact Gram matrix, 53-bit
/// intervals, double-word intervals, 3- and 4-double expansions; else decided
/// exactly, which costs time (O(d^3) big-integer operations on values of ~2 d
/// times the entries' size).
#[cfg(any(test, feature = "bench"))]
pub fn l2(basis: Vec<Vec<BigInt>>) -> Result<Vec<Vec<BigInt>>, (Stop, Vec<Vec<BigInt>>)> {
    l2_with(basis, false)
}

/// `l2` without the double-word checks (they rest on published error-bound
/// constants): 53-bit directed intervals and error-free multi-double
/// expansions (2 to 4 doubles), then p-bit intervals, then the exact check.
#[cfg(any(test, feature = "bench"))]
pub fn l2_proof(basis: Vec<Vec<BigInt>>) -> Result<Vec<Vec<BigInt>>, (Stop, Vec<Vec<BigInt>>)> {
    l2_with(basis, true)
}

/// What a reduction did: the reduction rungs run, with their times, and the
/// check that proved the result, with its time (for benchmarks and tuning).
#[derive(Debug, Default, Clone)]
pub struct Report {
    pub rungs: Vec<(u8, f64)>,
    pub check: String,
    pub check_secs: f64,
}

/// `l2` (or `l2_proof` when `wide`) with its report.
#[cfg(any(test, feature = "bench"))]
pub fn l2_report(basis: Vec<Vec<BigInt>>, wide: bool) -> (Result<Vec<Vec<BigInt>>, (Stop, Vec<Vec<BigInt>>)>, Report) {
    let mut rep = Report::default();
    let r = l2_run(basis, wide, &mut rep);
    (r, rep)
}

#[cfg(any(test, feature = "bench"))]
fn l2_with(basis: Vec<Vec<BigInt>>, wide: bool) -> Result<Vec<Vec<BigInt>>, (Stop, Vec<Vec<BigInt>>)> {
    l2_run(basis, wide, &mut Report::default())
}

/// The work a reduction may still do (limb operations) and the entry cap.
struct Meter {
    left: u64,
    bits_cap: u64,
    /// which proof checks run (all, except in the memory bound's tests)
    path: ProofPath,
}

/// `l2` within a budget: the reduction's work (counted by each rung, and the
/// proof checks' estimated cost) is debited, refusing past what is left;
/// entries are capped at `cap` bits. The work done is debited on every return,
/// a refusal included, so the budget is a true aggregate quota.
///
/// The caller's responsibilities: the rows are linearly independent (a
/// dependent basis is reported as an internal error) and all of one length;
/// and the memory of the basis and of this state (`l2_bytes(d, n, cap +
/// growth)`, growth being a row operation's multiplier, a few bits beyond the
/// entries) is reserved first. Every input entry is checked against `cap`
/// before any work; entries are checked again after each size-reduction pass.
pub fn l2_budgeted(b: &crate::budget::Budget, basis: Vec<Vec<BigInt>>, cap: u64) -> crate::budget::FResult<Vec<Vec<BigInt>>> {
    l2_budgeted_with(b, basis, cap, ProofPath::Default, &mut Report::default()).map_err(|e| e.refusal(b, cap))
}

/// Why `l2_budgeted_typed` returned no basis.
#[derive(Debug)]
pub enum L2Err {
    /// An entry past the cap (`Stop::Bits`), or no rung proved the result
    /// (`Stop::Precision`): the exact LLL can take over from the caller's
    /// original rows. Every row and state of the attempt is dropped by then,
    /// and its work debited.
    Fallback(Stop),
    /// Everything else ends the call: the work limit, an interrupt, a
    /// dependent row, an internal error.
    Refused(crate::budget::FactorLimit),
}

impl L2Err {
    /// `l2_budgeted`'s refusal for this outcome.
    fn refusal(self, b: &crate::budget::Budget, cap: u64) -> crate::budget::FactorLimit {
        match self {
            L2Err::Fallback(Stop::Bits { bits }) => b.refuse("l2 bits", bits, cap),
            L2Err::Fallback(_) => b.internal("l2: no rung proved the result"),
            L2Err::Refused(e) => e,
        }
    }
}

/// `l2_budgeted`, telling the stops the exact LLL can take over from (an
/// entry past the cap, no rung proving the result) apart from the refusals
/// that end the call. The caller keeps its own copy of the rows, charged,
/// for that fallback: this consumes `basis`.
pub fn l2_budgeted_typed(b: &crate::budget::Budget, basis: Vec<Vec<BigInt>>, cap: u64) -> Result<Vec<Vec<BigInt>>, L2Err> {
    l2_budgeted_with(b, basis, cap, ProofPath::Default, &mut Report::default())
}

/// Which proof checks run: all of them (`Default`), or, for the memory
/// bound's tests, which must reach each path, only the multi-double ones
/// from the exact Gram matrix, only the p-bit ones (proof mode's), or only
/// the exact check (each after building the same Gram matrix).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum ProofPath {
    Default,
    MultiDouble,
    PBit,
    Exact,
}

/// `l2_budgeted` with the proof forced onto one path, and the report (which
/// check proved it): for the memory bound's tests.
#[cfg(test)]
pub(crate) fn l2_budgeted_path(b: &crate::budget::Budget, basis: Vec<Vec<BigInt>>, cap: u64, path: ProofPath) -> (crate::budget::FResult<Vec<Vec<BigInt>>>, Report) {
    let mut rep = Report::default();
    let r = l2_budgeted_with(b, basis, cap, path, &mut rep).map_err(|e| e.refusal(b, cap));
    (r, rep)
}

fn l2_budgeted_with(b: &crate::budget::Budget, basis: Vec<Vec<BigInt>>, cap: u64, path: ProofPath, rep: &mut Report) -> Result<Vec<Vec<BigInt>>, L2Err> {
    // every input entry within the cap, before any work (a reduced basis
    // would otherwise be returned without a row operation checking it)
    if let Some(bits) = basis.iter().flatten().map(|x| x.bits()).max() {
        if bits > cap {
            return Err(L2Err::Fallback(Stop::Bits { bits }));
        }
    }
    let left = b.work_left();
    let mut m = Meter { left, bits_cap: cap, path };
    // (the p-bit path is proof mode's: its stages are charged as such)
    let wide = path == ProofPath::PBit;
    let r = l2_run_metered(basis, wide, rep, &mut m);
    // (tests: a proved result reported unproved, or past the cap, for the
    // caller's fallback after a full run)
    #[cfg(test)]
    let r = match (r, crate::lll::FORCE.with(|f| f.get())) {
        (Ok(v), crate::lll::Force::Precision) => Err((Stop::Precision { k: 0 }, v)),
        (Ok(v), crate::lll::Force::BitsInRun) => Err((Stop::Bits { bits: cap.saturating_add(1) }, v)),
        (r, _) => r,
    };
    let used = left - m.left;
    // the work done is debited whatever the outcome (used <= left, so this
    // succeeds; an interrupt unwinds from inside it, past any fallback)
    let debited = b.debit(Some(used));
    // the stopped attempt's rows go before the caller hears of a fallback
    let r = r.map_err(|(stop, rows)| {
        drop(rows);
        stop
    });
    match r {
        Ok(v) => {
            debited.map_err(L2Err::Refused)?;
            Ok(v)
        }
        Err(Stop::Work) => Err(L2Err::Refused(b.refuse("l2 work", used.saturating_add(1), left))),
        Err(Stop::Dependent) => Err(L2Err::Refused(b.internal("l2: dependent rows"))),
        Err(stop @ (Stop::Bits { .. } | Stop::Precision { .. })) => {
            debited.map_err(L2Err::Refused)?;
            Err(L2Err::Fallback(stop))
        }
    }
}

/// Bytes live at the peak of `l2_budgeted` on a d-row basis of length-n rows
/// with the entry cap `bits`: the reducer's state plus the largest proof
/// stage, the exact fallback included (a conservative bound: each term is the
/// most its objects hold, a big integer counted at `big_bytes`).
/// Every sum and product here is checked: a shape whose bound doesn't fit in
/// u64 gives None (fails closed), never a wrapped, smaller figure.
pub fn l2_bytes(d: usize, n: usize, bits: u64) -> Option<u64> {
    use crate::budget::{big_bytes, limbs};
    // a Vec's header
    const V: u64 = 24;
    let (d, n) = (d as u64, n as u64);
    let tri = d.checked_mul(d.checked_add(1)?)? / 2;
    let lg = crate::clog2(n.max(1)).checked_add(1)?;
    let rowvec = |each: u64| -> Option<u64> { d.checked_mul(V.checked_add(n.checked_mul(each)?)?) };
    let max = |a: u64, b: u64| a.max(b);
    // The state, at its largest rung:
    // - the rows: every entry within the cap at every step (a row operation
    //   that would pass it is refused first), a result before its check a
    //   few bits more; limb rows (8 bytes a limb, two of headroom) fit too
    let entry = big_bytes(bits.checked_add(64)?)?;
    let rows = rowvec(entry)?;
    // - the basis the rows were built from, alive while they are, and one
    //   row converted to big integers inside a row operation
    let input = l2_input_bytes(d, n, bits)?;
    let conv = n.checked_mul(entry)?;
    // - the rows' double-double copies (hi, lo), exponents and norms
    let copies = rowvec(16)?.checked_add(d.checked_mul(16)?)?;
    // - the exact rung's Gram matrix, an entry during its update (x^2 G_jj)
    let ge = big_bytes(bits.checked_mul(4)?.checked_add(lg.checked_mul(2)?.checked_add(256)?)?)?;
    let gram = tri.checked_mul(ge)?.checked_add(d.checked_mul(V)?)?;
    // - the Gram-Schmidt data: three plain double-double triangles (16
    //   bytes an entry) and two with exponents (24)
    let gso = tri.checked_mul(3 * 16 + 2 * 24)?.checked_add(d.checked_mul(5 * V)?)?;
    let state = rows.checked_add(input)?.checked_add(conv)?.checked_add(copies)?.checked_add(gram)?.checked_add(gso)?;
    // The proof, with the state alive:
    // - a clone of the rows and their machine-word copy (MagRows)
    let clone = rowvec(big_bytes(bits)?)?;
    let mag = d.checked_mul((2 * V).checked_add(n.checked_mul(limbs(bits).checked_mul(8)?.checked_add(1)?)?)?)?;
    // - row-based intervals (dd-rows: 3-double expansions, 48 bytes, more
    //   than dw-rows' 24): the entries, the Gram triangle, r and mu
    let rowiv = d.checked_mul(n)?.checked_add(tri.checked_mul(3)?)?.checked_mul(48)?.checked_add(d.checked_mul(3 * V)?)?;
    let stage_rows = clone.checked_add(mag)?.checked_add(rowiv)?;
    // - the exact Gram matrix, then the interval Gram-Schmidt on it (r and
    //   mu as 4-double expansions, 56 bytes an entry, the widest)
    let g2 = tri.checked_mul(big_bytes(bits.checked_mul(2)?.checked_add(lg.checked_add(1)?)?)?)?.checked_add(d.checked_mul(V)?)?;
    let iv_md = tri.checked_mul(2 * 56)?.checked_add(d.checked_mul(2 * V + 8)?)?;
    //   or, in proof mode, p-bit intervals (two big-integer endpoints with
    //   exponents and the precision, p at most 96 + 2d), with a few
    //   double-width temporaries
    let pb = d.checked_mul(2)?.checked_add(96 + 64)?;
    let ip = 2u64.checked_mul(big_bytes(pb)?.checked_add(8)?)?.checked_add(8)?;
    let iv_p = tri.checked_mul(2u64.checked_mul(ip)?)?.checked_add(d.checked_mul(2 * V)?)?.checked_add(8u64.checked_mul(big_bytes(pb.checked_mul(2)?)?)?)?;
    let iv = max(iv_md, iv_p);
    let stage_gram = max(clone.checked_add(mag)?.checked_add(g2)?, g2.checked_add(iv)?);
    // - the exact check: with the Gram matrix still held, a clone of the rows,
    //   its own full Gram matrix, and the integral Gram-Schmidt data (d + 1
    //   determinants and the lambda triangle, each at most d (2 bits + lg +
    //   1) + 64 bits), with a few temporaries twice that
    let vb = d.checked_mul(bits.checked_mul(2)?.checked_add(lg.checked_add(1)?)?)?.checked_add(64)?;
    let full = d.checked_mul(d)?.checked_mul(big_bytes(bits.checked_mul(2)?.checked_add(lg.checked_add(1)?)?)?)?.checked_add(d.checked_mul(V)?)?;
    let integral = d.checked_add(1)?.checked_add(tri)?.checked_mul(big_bytes(vb)?)?.checked_add(d.checked_mul(V)?)?.checked_add(4u64.checked_mul(big_bytes(vb.checked_mul(2)?)?)?)?;
    let stage_exact = g2.checked_add(clone)?.checked_add(full)?.checked_add(integral)?;
    state.checked_add(max(stage_rows, max(stage_gram, stage_exact)))
}

/// `l2_bytes`'s term for the basis given to `l2_budgeted`: d rows of n big
/// integers of at most `bits` bits (a caller's copy of its rows fits in it).
pub(crate) fn l2_input_bytes(d: u64, n: u64, bits: u64) -> Option<u64> {
    d.checked_mul(24u64.checked_add(n.checked_mul(crate::budget::big_bytes(bits)?)?)?)
}

#[cfg(any(test, feature = "bench"))]
fn l2_run(basis: Vec<Vec<BigInt>>, wide: bool, rep: &mut Report) -> Result<Vec<Vec<BigInt>>, (Stop, Vec<Vec<BigInt>>)> {
    l2_run_metered(basis, wide, rep, &mut Meter { left: u64::MAX, bits_cap: u64::MAX, path: ProofPath::Default })
}

fn l2_run_metered(basis: Vec<Vec<BigInt>>, wide: bool, rep: &mut Report, m: &mut Meter) -> Result<Vec<Vec<BigInt>>, (Stop, Vec<Vec<BigInt>>)> {
    // the rungs: doubles scaled by row exponents, then doubles with an
    // exponent (approximate Gram entries), then exact Gram entries; each
    // starts from the basis the previous one reached. A rung's result is
    // returned only once it is proved reduced: by intervals, else exactly;
    // otherwise the next rung continues from it.
    let mut basis = basis;
    for rung in 0..5u8 {
        let step = match rung {
            0 => rung_step(L2::<Fe>::new_fast(basis), rung, wide, rep, m),
            1 => rung_step(L2::<Fe>::new(basis, false), rung, wide, rep, m),
            2 => rung_step(L2::<Dd>::new_fast(basis), rung, wide, rep, m),
            3 => rung_step(L2::<Dd>::new(basis, false), rung, wide, rep, m),
            _ => rung_step(L2::<Dd>::new(basis, true), rung, wide, rep, m),
        };
        match step {
            Step::Proved(b) => return Ok(b),
            Step::Next(b) => basis = b,
            Step::Stopped(e, b) => return Err((e, b)),
        }
    }
    // the last rung stopped short, or its result was not proved reduced
    Err((Stop::Precision { k: 0 }, basis))
}

enum Step {
    Proved(Vec<Vec<BigInt>>),
    Next(Vec<Vec<BigInt>>),
    Stopped(Stop, Vec<Vec<BigInt>>),
}

/// The report's clock: seconds since `start()` in tests and with the bench
/// feature (the benchmarks' rung and check timings), and 0 in every other
/// build, which reads no clock: std has none on wasm32-unknown-unknown,
/// where `Instant::now` panics.
#[cfg(any(test, feature = "bench"))]
mod clock {
    pub struct Start(std::time::Instant);
    pub fn start() -> Start {
        Start(std::time::Instant::now())
    }
    pub fn secs(s: &Start) -> f64 {
        s.0.elapsed().as_secs_f64()
    }
}
#[cfg(not(any(test, feature = "bench")))]
mod clock {
    pub struct Start;
    pub fn start() -> Start {
        Start
    }
    pub fn secs(_: &Start) -> f64 {
        0.0
    }
}

/// One rung: run it; its result proved reduced, or the basis it reached for
/// the next rung (precision ran out, or the proof failed), or a stop.
fn rung_step<F: Flt>(mut s: L2<F>, rung: u8, wide: bool, rep: &mut Report, m: &mut Meter) -> Step {
    let t0 = clock::start();
    s.work_limit = m.left;
    s.bits_cap = m.bits_cap;
    let ran = s.run();
    s.work = s.work.saturating_add(s.side.take());
    m.left = m.left.saturating_sub(s.work);
    rep.rungs.push((rung, clock::secs(&t0)));
    match ran {
        Ok(()) => {
            // the proof check: admitted when its whole chain fits; debited up
            // to the check that proved the rows (or the whole chain)
            let stages = s.check_stages(wide);
            let all = stages.iter().fold(0u64, |a, (_, c)| a.saturating_add(*c));
            if all > m.left {
                return Step::Stopped(Stop::Work, s.into_basis());
            }
            let t1 = clock::start();
            let by = s.proved_by_with(wide, m.path);
            rep.check_secs += clock::secs(&t1);
            let used = match &by {
                Some(name) => {
                    // the stages up to the prover
                    let mut u = 0u64;
                    for (st, c) in &stages {
                        u = u.saturating_add(*c);
                        if name.starts_with(st) {
                            break;
                        }
                    }
                    u
                }
                None => all,
            };
            m.left = m.left.saturating_sub(used);
            if let Some(b) = by {
                rep.check = b;
                return Step::Proved(s.into_basis());
            }
            rep.check.push_str("unproved;");
            #[cfg(test)]
            UNPROVED.with(|c| c.set(c.get() + 1));
            Step::Next(s.into_basis())
        }
        Err(Stop::Precision { .. }) => Step::Next(s.into_basis()),
        Err(e) => Step::Stopped(e, s.into_basis()),
    }
}

#[cfg(test)]
thread_local! {
    /// limb operations the row operations and Gram updates actually did
    static ACTUAL_LIMB_OPS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// exact dot products the double-double rung fell back to
    pub static WIDE_EXACT_DOTS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// Results the interval check could not prove (test counters).
    static EXACT_CHECKS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// Rung results refused by both checks.
    static UNPROVED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lll_cert::certify;

    /// No clock on the production path: in the lattice code's sources (this
    /// module, the proof checks, the exact LLL and its certificate, van
    /// Hoeij), outside test modules, `std::time` appears only in the clock
    /// compiled for tests and the bench feature. std has no clock on
    /// wasm32-unknown-unknown (`Instant::now` panics, a trap in the engine),
    /// and native tests can't see that.
    #[test]
    fn no_clock_on_the_production_path() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for f in ["l2.rs", "l2_verify.rs", "lll.rs", "lll_cert.rs", "limbs.rs", "vanhoeij.rs", "budget.rs"] {
            let text = std::fs::read_to_string(dir.join(f)).unwrap();
            // the production part: up to the test module (`mod tests` or
            // `pub(crate) mod tests`)
            let cut = ["\n#[cfg(test)]\nmod tests", "\n#[cfg(test)]\npub(crate) mod tests"].iter().filter_map(|m| text.find(m)).min().unwrap_or(text.len());
            let prod = &text[..cut];
            // the gated clock module, then the rest
            let gate = "#[cfg(any(test, feature = \"bench\"))]\nmod clock {";
            let rest = match prod.find(gate) {
                Some(i) => {
                    let end = i + prod[i..].find("\n}\n").unwrap();
                    format!("{}{}", &prod[..i], &prod[end..])
                }
                None => prod.to_string(),
            };
            for line in rest.lines().filter(|l| !l.trim_start().starts_with("//")) {
                assert!(!line.contains("std::time") && !line.contains("Instant::"), "{f}: a clock on the production path: {line}");
            }
        }
    }

    /// The production ways into the reducer (LLL design r2, section 1). In
    /// the engine's sources, outside test modules, tests, examples and this
    /// module, `l2` is reached only for `l2_budgeted_typed` (and its
    /// `L2Err`), `l2_bytes` and the `Fe` number type; here, the unbudgeted
    /// entries (`l2`, `l2_proof`, `l2_report`, `l2_with`, `l2_run`) and the
    /// state's own entry points beyond the metered run are compiled only in
    /// tests or with the `bench` feature, and the state is crate-private
    /// without it.
    #[test]
    fn the_reducer_has_one_production_entry() {
        use std::path::{Path, PathBuf};
        fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                let name = p.file_name().unwrap().to_string_lossy().to_string();
                if p.is_dir() {
                    if !["target", "tests", "examples", "benches"].contains(&name.as_str()) {
                        rs_files(&p, out);
                    }
                } else if name.ends_with(".rs") {
                    out.push(p);
                }
            }
        }
        let engine = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut files = vec![];
        for e in std::fs::read_dir(engine).unwrap() {
            let src = e.unwrap().path().join("src");
            if src.is_dir() {
                rs_files(&src, &mut files);
            }
        }
        let allowed = ["l2_budgeted_typed", "L2Err", "l2_bytes", "Fe"];
        let mut seen = std::collections::BTreeSet::new();
        for f in &files {
            let rel = f.strip_prefix(engine).unwrap().to_string_lossy().replace('\\', "/");
            if rel == "poly/src/l2.rs" {
                continue;
            }
            let text = std::fs::read_to_string(f).unwrap();
            // the production part: up to the file's test module
            let prod = text.split("\n#[cfg(test)]\nmod tests").next().unwrap();
            for line in prod.lines().filter(|l| !l.trim_start().starts_with("//")) {
                let mut rest = line;
                while let Some(i) = rest.find("l2::") {
                    let after = &rest[i + 4..];
                    let names: Vec<&str> = if let Some(inner) = after.strip_prefix('{') {
                        inner.split('}').next().unwrap().split(',').map(|x| x.trim()).collect()
                    } else {
                        vec![after.split(|c: char| !(c.is_alphanumeric() || c == '_')).next().unwrap()]
                    };
                    for n in names.into_iter().filter(|n| !n.is_empty()) {
                        assert!(allowed.contains(&n), "{rel}: a production use of l2::{n}: {line}");
                        seen.insert((rel.clone(), n.to_string()));
                    }
                    rest = after;
                }
            }
        }
        // (the census found the callers it should)
        assert!(seen.contains(&("poly/src/vanhoeij.rs".to_string(), "l2_budgeted_typed".to_string())), "{seen:?}");
        // the unbudgeted entries and the state's extra entry points, gated
        let me = include_str!("l2.rs");
        let gate = "#[cfg(any(test, feature = \"bench\"))]";
        for decl in ["pub fn l2(", "pub fn l2_proof(", "pub fn l2_report(", "fn l2_with(", "fn l2_run(", "pub fn proved(", "pub fn proved_by(", "pub fn dot_rows(", "pub fn row_big("] {
            let at = me.find(&format!("\n{decl}")).or_else(|| me.find(&format!("\n    {decl}"))).unwrap_or_else(|| panic!("{decl} not found"));
            let before: Vec<&str> = me[..at].lines().rev().take_while(|l| l.trim_start().starts_with("///") || l.trim_start().starts_with("#[")).collect();
            assert!(before.iter().any(|l| l.trim() == gate), "{decl} is not gated");
        }
        assert!(me.contains("        #[cfg(not(any(test, feature = \"bench\")))]\n        pub(crate) struct $($rest)*"));
    }

    /// Rows (X, Y, 1) and (Y, -X, 1) with X, Y of 200 bits: their 106-bit
    /// copies' dot product cancels to 0, the exact one is 1. The
    /// double-double rung must fall back to the exact dot product (limb rows
    /// and big-integer rows), and the reduction of such rows is certified.
    #[test]
    fn dd_rung_falls_back_to_the_exact_dot_on_cancellation() {
        let mut seed = 0x0bad_cafe_1234_5678u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for case in 0..20 {
            let mut big = || {
                let mut x = BigInt::from(1);
                for _ in 0..3 {
                    x = (x << 64usize) + BigInt::from(rnd());
                }
                x >> 0usize
            };
            let (x, y) = (big(), big());
            let mut rows = vec![vec![x.clone(), y.clone(), BigInt::from(1)], vec![y.clone(), -x.clone(), BigInt::from(1)]];
            // half the cases: a sparse fourth column of zeros keeps them
            // big-integer rows
            if case % 2 == 1 {
                for r in rows.iter_mut() {
                    r.extend((0..40).map(|_| BigInt::zero()));
                }
            }
            let s = L2::<Dd>::new(rows.clone(), false);
            assert!(matches!(s.basis[0], Row::W(_)) == (case % 2 == 0));
            let before = WIDE_EXACT_DOTS.with(|c| c.get());
            let g = s.gram_f(1, 0);
            assert!(WIDE_EXACT_DOTS.with(|c| c.get()) > before, "case {case}: no fallback");
            assert_eq!(g.round(), BigInt::from(1), "case {case}");
            // and the rung's reduction of rows with this structure
            rows.push(vec![x.clone() + 1, y.clone() - 1, BigInt::from(3)].into_iter().chain((0..rows[0].len() - 3).map(|_| BigInt::zero())).collect());
            let out = l2(rows.clone()).expect("reduced");
            assert_eq!(certify(&rows, &out, (51, 100), (99, 100)), Ok(()), "case {case}");
        }
    }

    #[test]
    fn dd_arithmetic() {
        use num_traits::Signed;
        // exact: (hi + lo) 2^e as m 2^s, m an integer
        fn exact(x: Dd, s: i64) -> BigInt {
            let part = |f: f64| {
                if f == 0.0 {
                    return BigInt::zero();
                }
                let fe = Fe::norm(f, x.e);
                let mi = (fe.m * pow2(53)) as i64;
                let sh = fe.e - 53 - s;
                assert!(sh >= 0);
                BigInt::from(mi) << (sh as usize)
            };
            part(x.hi) + part(x.lo)
        }
        let mut seed = 0x1357_9bdf_2468_ace0u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for case in 0..2000 {
            let mut big = |bits: u64| {
                let mut x = BigInt::zero();
                for _ in 0..bits.div_ceil(64) {
                    x = (x << 64usize) + BigInt::from(rnd());
                }
                x = x >> (bits.div_ceil(64) * 64 - bits) as usize;
                if rnd() % 2 == 0 { -x } else { x }
            };
            let (xa, xb) = (big(1 + case % 400), big(1 + (case * 13) % 300));
            let (a, b) = (Dd::from_big(&xa), Dd::from_big(&xb));
            let s = -1200;
            // from_big keeps the top 106 bits
            let tol = |v: &BigInt| (v.abs() >> 100usize) + 1;
            assert!((exact(a, s) - (&xa << 1200usize)).abs() <= tol(&(&xa << 1200usize)) , "from_big {case}");
            let (ea, eb) = (exact(a, s), exact(b, s));
            let sum = &ea + &eb;
            assert!((exact(a.add(b), s) - &sum).abs() <= (ea.abs().max(eb.abs()) >> 100usize) + 1, "add {case}");
            let prod = &ea * &eb;
            assert!((exact(a.mul(b), 2 * s) - &prod).abs() <= (prod.abs() >> 100usize) + 1, "mul {case}");
            if !b.is_zero() {
                // |q b - a| <= 2^-100 |a|
                let q = a.div(b);
                let qb = exact(q, s) * &eb;
                assert!((qb - (&ea << 1200usize)).abs() <= ((&ea << 1200usize).abs() >> 100usize) + (eb.abs() << 2usize), "div {case}");
            }
            // round: within 1/2 (+ the cut below 2^-100)
            let r = a.round();
            let twice = (&r << 1201usize) - (&ea << 1usize);
            assert!(twice.abs() <= (BigInt::from(1) << 1200usize) + (ea.abs() >> 99usize), "round {case}");
        }
    }

    #[test]
    fn fe_arithmetic() {
        let a = Fe::from_f64(3.0);
        let b = Fe::from_f64(0.25);
        assert_eq!(a.mul(b).to_f64(), 0.75);
        assert_eq!(a.div(b).to_f64(), 12.0);
        assert_eq!(a.sub(b).to_f64(), 2.75);
        assert_eq!(Fe::from_f64(2.5).round(), BigInt::from(3));
        let big = BigInt::from(1u64) << 3000usize;
        let f = Fe::from_big(&big);
        assert_eq!(f.e, 3001);
        assert_eq!(f.div(f).to_f64(), 1.0);
        assert_eq!(f.round(), big);
        assert_eq!(Fe::from_big(&(-(BigInt::from(5) << 100usize))).round(), -(BigInt::from(5) << 100usize));
    }

    fn knapsack(d: usize, bits: usize, seed: &mut u64) -> Vec<Vec<BigInt>> {
        let mut rnd = || {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        };
        (0..d)
            .map(|i| {
                let mut x = BigInt::zero();
                for _ in 0..bits.div_ceil(64) {
                    x = (x << 64usize) + BigInt::from(rnd());
                }
                x = x >> (bits.div_ceil(64) * 64 - bits);
                let mut r = vec![x];
                r.extend((0..d).map(|j| BigInt::from((i == j) as u32)));
                r
            })
            .collect()
    }

    /// The proof check refuses what is not (0.51, 0.99)-reduced, on both of
    /// its paths (rows with small entries: the exact Gram matrix; with large
    /// ones: the Gram matrix from the rows), and proves the reduced output:
    /// the unreduced input, the output with two adjacent rows swapped
    /// (Lovasz fails) and with a row replaced by itself plus the one before
    /// (size reduction fails).
    #[test]
    fn proof_check_refuses_unreduced() {
        let mut seed = 0x0bad_cafe_1234_5678u64;
        for &(d, bits, shift) in &[(12usize, 100usize, 0usize), (12, 100, 200)] {
            let m = knapsack(d, bits, &mut seed);
            let r = l2(m.clone()).map_err(|e| e.0).unwrap();
            // shift > 0: every entry times 2^shift (same reducedness, big rows)
            let sc = |v: &Vec<Vec<BigInt>>| -> Vec<Vec<BigInt>> { v.iter().map(|row| row.iter().map(|x| x << shift).collect()).collect() };
            let check = |v: Vec<Vec<BigInt>>| L2::<Fe>::new_fast(sc(&v)).proved_by(false);
            assert!(check(r.clone()).is_some(), "d {d} shift {shift}: the reduced output");
            assert!(check(m.clone()).is_none(), "d {d} shift {shift}: the input");
            let mut sw = r.clone();
            // a swap that breaks Lovasz: put the longest row first
            let longest = (0..d).max_by_key(|&i| sw[i].iter().map(|x| x * x).sum::<BigInt>()).unwrap();
            sw.swap(0, longest);
            assert!(check(sw).is_none(), "d {d} shift {shift}: swapped");
            let mut sr = r.clone();
            let prev = sr[0].clone();
            for (a, b) in sr[1].iter_mut().zip(&prev) {
                *a += b;
            }
            assert!(check(sr).is_none(), "d {d} shift {shift}: not size reduced");
        }
    }

    /// A dimension where the 53-bit intervals cannot prove the result is
    /// proved by a multi-double rung (the rung reported), and certified.
    #[test]
    fn multi_double_rung_proves_where_53_bits_cannot() {
        let mut seed = 0x5eed_0f_1a77_1ce5u64;
        let m = knapsack(90, 100, &mut seed);
        let (r, rep) = l2_report(m.clone(), false);
        let r = r.map_err(|e| e.0).unwrap();
        assert!(rep.check == "dw" || rep.check.starts_with("md"), "proved by {:?}", rep.check);
        assert_eq!(certify(&m, &r, (51, 100), (99, 100)), Ok(()));
    }

    /// Within a budget: enough work reduces exactly as `l2` does and debits
    /// it; too little refuses (work); a cap below the entries refuses (bits).
    #[test]
    fn budgeted_l2_debits_and_refuses() {
        use crate::budget::{Budget, Limits};
        let mut seed = 0x0b0d_9e7au64;
        let m = knapsack(30, 100, &mut seed);
        let b = Budget::default();
        let before = b.work_left();
        let out = l2_budgeted(&b, m.clone(), 10_000).expect("enough budget");
        assert_eq!(out, l2(m.clone()).map_err(|e| e.0).unwrap());
        assert!(b.work_left() < before);
        assert_eq!(certify(&m, &out, (51, 100), (99, 100)), Ok(()));
        let small = Budget::new(Limits { work: 1000, ..Limits::DEFAULT });
        let e = l2_budgeted(&small, m.clone(), 10_000).unwrap_err();
        assert_eq!(e.what, "l2 work");
        // a refusal keeps what it did on the budget: a retry has less
        assert!(small.work_left() < 1000, "refused call debited nothing: {}", small.work_left());
        // and a bits refusal mid-reduction debits too: entries grow past a
        // cap set just above the input (a knapsack's first row operations)
        let mid = Budget::default();
        let before = mid.work_left();
        let in_bits = m.iter().flatten().map(|x| x.bits()).max().unwrap();
        if let Err(e) = l2_budgeted(&mid, m.clone(), in_bits) {
            if e.what == "l2 bits" {
                assert!(mid.work_left() < before);
            }
        }
        // the knapsack's entries have 100 bits: a 50-bit cap refuses at the
        // first size-reduction pass
        let e = l2_budgeted(&Budget::default(), m.clone(), 50).unwrap_err();
        assert_eq!(e.what, "l2 bits");
        assert!(l2_bytes(30, 31, 100).unwrap() > 30 * 31 * 8);
        // the cap holds for inputs no row operation touches: one row, an
        // orthogonal (already reduced) basis; entries at the cap pass
        let t = BigInt::from(1) << 200usize;
        let e = l2_budgeted(&Budget::unlimited(), vec![vec![t.clone()]], 50).unwrap_err();
        assert_eq!(e.what, "l2 bits");
        let diag = |d: usize, v: &BigInt| -> Vec<Vec<BigInt>> { (0..d).map(|i| (0..d).map(|j| if i == j { v.clone() } else { BigInt::zero() }).collect()).collect() };
        let e = l2_budgeted(&Budget::unlimited(), diag(4, &t), 50).unwrap_err();
        assert_eq!(e.what, "l2 bits");
        let at = (BigInt::from(1) << 50usize) - 1;
        assert_eq!(l2_budgeted(&Budget::unlimited(), diag(4, &at), 50).unwrap(), diag(4, &at));
        assert_eq!(l2_budgeted(&Budget::unlimited(), vec![vec![at.clone()]], 50).unwrap(), vec![vec![at]]);
        // the cap in the middle of a row operation: [[7, 1], [7, -7]] with
        // cap 3 (the entries fit; b_1 - b_0 = (0, -8) would need 4 bits) is
        // refused there, after work was done, and the work is debited
        let w = vec![vec![BigInt::from(7), BigInt::from(1)], vec![BigInt::from(7), BigInt::from(-7)]];
        let mid = Budget::default();
        let before = mid.work_left();
        let e = l2_budgeted(&mid, w, 3).unwrap_err();
        assert_eq!((e.what, e.need, e.remaining), ("l2 bits", 4, 3));
        assert!(mid.work_left() < before, "the refused row operation's work was not debited");
    }

    /// l2_bytes fails closed: a shape whose bound doesn't fit in u64 is None
    /// (usize::MAX rows, and huge but smaller shapes), never a panic or a
    /// wrapped figure; and the bound grows with each argument.
    #[test]
    fn l2_bytes_fails_closed() {
        assert_eq!(l2_bytes(usize::MAX, 1, 1), None);
        assert_eq!(l2_bytes(1, usize::MAX, 1), None);
        assert_eq!(l2_bytes(1, 1, u64::MAX), None);
        assert_eq!(l2_bytes(usize::MAX, usize::MAX, u64::MAX), None);
        for (d, n, bits) in [(1usize << 32, 2, 64), (1 << 22, 1 << 22, 64), (1 << 16, 1 << 16, 1 << 20), (1 << 20, 3, 1 << 30), (3, 1 << 40, 1 << 24)] {
            if let Some(b) = l2_bytes(d, n, bits) {
                // a figure, when there is one, is at least the rows' own size
                assert!(b >= (d as u64) * (n as u64) * (bits / 8), "{d} {n} {bits}: {b}");
            }
        }
        let base = l2_bytes(40, 41, 200).unwrap();
        assert!(l2_bytes(41, 41, 200).unwrap() > base && l2_bytes(40, 42, 200).unwrap() > base && l2_bytes(40, 41, 201).unwrap() >= base);
    }

    /// The meter covers the work: on inputs whose multipliers x span many
    /// limbs (large knapsack entries; Ajtai-style triangular bases), the work
    /// debited is at least the limb operations the row operations and exact
    /// Gram updates actually did (counted inside sub_row).
    #[test]
    fn budget_meter_covers_the_actual_limb_operations() {
        use crate::budget::Budget;
        let mut seed = 0x6d65_7465_7231_2345u64;
        for (d, bits) in [(12usize, 3000usize), (20, 1200), (30, 400)] {
            let m = knapsack(d, bits, &mut seed);
            ACTUAL_LIMB_OPS.with(|c| c.set(0));
            let b = Budget::default();
            let before = b.work_left();
            let out = l2_budgeted(&b, m.clone(), 1 << 20).expect("enough budget");
            let debited = before - b.work_left();
            let actual = ACTUAL_LIMB_OPS.with(|c| c.get());
            assert!(actual > 0 && debited >= actual, "d {d} bits {bits}: debited {debited} < actual {actual}");
            assert_eq!(certify(&m, &out, (51, 100), (99, 100)), Ok(()));
        }
        // a big row times a big multiplier: b_1 = M b_0 + small, A and M of
        // 2000 bits, so the first reduction is 32-limb entries times a
        // 32-limb x; through the whole chain and the exact rung alone
        let big = |bits: usize, seed: &mut u64| {
            let mut x = BigInt::from(1);
            for _ in 0..bits / 64 {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                x = (x << 64usize) + BigInt::from(*seed);
            }
            x
        };
        let (a, mm, m2) = (big(2000, &mut seed), big(2000, &mut seed), big(1900, &mut seed));
        let m = vec![
            vec![a.clone(), BigInt::zero(), BigInt::zero()],
            vec![&a * &mm + 5, BigInt::from(1), BigInt::zero()],
            vec![&a * &m2 + 7, BigInt::from(3), BigInt::from(1)],
        ];
        ACTUAL_LIMB_OPS.with(|c| c.set(0));
        let b = Budget::default();
        let before = b.work_left();
        let out = l2_budgeted(&b, m.clone(), 1 << 20).expect("enough budget");
        let debited = before - b.work_left();
        let actual = ACTUAL_LIMB_OPS.with(|c| c.get());
        assert!(actual > 0 && debited >= actual, "big x: debited {debited} < actual {actual}");
        assert_eq!(certify(&m, &out, (51, 100), (99, 100)), Ok(()));
        ACTUAL_LIMB_OPS.with(|c| c.set(0));
        let mut s = L2::<Dd>::new(m, true);
        s.run().unwrap();
        let actual = ACTUAL_LIMB_OPS.with(|c| c.get());
        assert!(actual > 1000 && s.work >= actual, "exact rung, big x: work {} < actual {actual}", s.work);
        // the exact rung directly, multi-limb multipliers included
        let m = knapsack(10, 2000, &mut seed);
        ACTUAL_LIMB_OPS.with(|c| c.set(0));
        let mut s = L2::<Dd>::new(m, true);
        s.run().unwrap();
        let actual = ACTUAL_LIMB_OPS.with(|c| c.get());
        assert!(actual > 0 && s.work >= actual, "exact rung: work {} < actual {actual}", s.work);
    }

    /// The memory bound: the peak of live heap bytes during `l2_budgeted`
    /// (measured by the tests' counting allocator, per thread, so other tests
    /// don't count) never exceeds `l2_bytes(d, n, cap)`, over shapes whose
    /// proofs take each path: 53-bit and double-word intervals, double-word
    /// intervals from the rows (entries over 8 limbs), multi-double
    /// expansions, proof mode's p-bit intervals, and the exact check (the
    /// last three forced).
    #[test]
    fn l2_memory_stays_within_l2_bytes() {
        use crate::budget::Budget;
        let mut seed = 0x6d65_6d6f_7279_6232u64;
        let mut big = |bits: u64| {
            let mut x = BigInt::from(1);
            for _ in 0..bits / 64 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                x = (x << 64usize) + BigInt::from(seed);
            }
            x << (bits % 64) as usize
        };
        let mut knap = |d: usize, bits: u64| -> Vec<Vec<BigInt>> { (0..d).map(|i| std::iter::once(big(bits)).chain((0..d).map(|j| BigInt::from((i == j) as i64))).collect()).collect() };
        let k20 = knap(20, 100);
        let k60 = knap(60, 200);
        let k30 = knap(30, 150);
        let k25 = knap(25, 120);
        let k22 = knap(22, 130);
        let mut tri = |d: usize, bits: u64| -> Vec<Vec<BigInt>> {
            (0..d).map(|i| (0..d).map(|j| if j < i { big(bits) } else if j == i { big(bits + 8) } else { BigInt::zero() }).collect()).collect()
        };
        let t12 = tri(12, 1000);
        let t10 = tri(10, 600);
        let t10b = tri(10, 800);
        let t9 = tri(9, 700);
        // (the check expected to prove each: the path's own, so a fallback
        // to another stage fails the test)
        let cases = [
            ("knapsack d20 (53-bit)", k20, ProofPath::Default, "53"),
            ("knapsack d60 (double-word)", k60, ProofPath::Default, "dw"),
            ("triangular d12, 1000 bits (from the rows)", t12, ProofPath::Default, "dw-rows"),
            ("knapsack d30 (multi-double)", k30, ProofPath::MultiDouble, "md"),
            ("triangular d10, 600 bits (multi-double)", t10, ProofPath::MultiDouble, "md"),
            ("knapsack d25 (exact)", k25, ProofPath::Exact, "exact"),
            ("knapsack d22 (proof mode, p-bit)", k22, ProofPath::PBit, "p"),
            ("triangular d9, 700 bits (proof mode, p-bit)", t9, ProofPath::PBit, "p"),
            ("triangular d10, 800 bits (exact)", t10b, ProofPath::Exact, "exact"),
        ];
        for (name, m, path, stage) in cases {
            let (d, n) = (m.len(), m[0].len());
            let cap = m.iter().flatten().map(|x| x.bits()).max().unwrap() + 64;
            let bound = l2_bytes(d, n, cap).unwrap() as i64;
            let b = Budget::unlimited();
            let ((r, rep), peak) = crate::alloc_spy::peak_during(|| {
                let (r, rep) = l2_budgeted_path(&b, m, cap, path);
                (r.map(|v| v.len()), rep)
            });
            assert_eq!(r.map_err(|e| e.what), Ok(d), "{name}");
            let by = rep.check.rsplit(';').next().unwrap_or("");
            let ok = if stage == "dw" { by == "dw" } else if stage == "p" { by.starts_with('p') } else { by.starts_with(stage) };
            assert!(ok, "{name}: proved by {:?}, expected {stage}", rep.check);
            assert!(peak <= bound, "{name}: peak {peak} bytes > l2_bytes {bound}");
            eprintln!("{name}: peak {peak} of {bound} bytes ({:.1}%)", 100.0 * peak as f64 / bound as f64);
        }
    }

    #[test]
    fn l2_output_is_certified() {
        let mut seed = 0x1234_5678_9abc_def1u64;
        for &(d, bits) in &[(2usize, 20usize), (5, 100), (10, 300), (20, 200), (30, 1000)] {
            let m = knapsack(d, bits, &mut seed);
            let r = l2(m.clone()).map_err(|e| e.0).unwrap();
            assert_eq!(certify(&m, &r, (51, 100), (99, 100)), Ok(()), "d {d} bits {bits}");
        }
    }
}
