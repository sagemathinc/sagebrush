//! Interval arithmetic for certificates (definite integrals' zero sets,
//! the limit engine's signs of constants): enclosures of real expressions
//! over an interval of x, rounded outward, with an explicit allowance for
//! the platform's elementary functions (LIBM).

use crate::expr::*;


/// A closed interval [lo, hi] of reals.
#[derive(Clone, Copy, Debug)]
pub struct Iv(pub f64, pub f64);

/// The error allowed the platform's exp, ln, sin, cos, ... (relative, and
/// absolute near zeros of sin and cos): Rust does not specify their accuracy;
/// glibc's, musl's and the libm crate's (WebAssembly) are within an ulp or
/// two, and this is several hundred.  The certificates below assume it.
pub const LIBM: f64 = 1e-14;

/// Outward rounding: a few ulps beyond the computed ends.
pub fn out(lo: f64, hi: f64) -> Option<Iv> {
    if lo.is_nan() || hi.is_nan() || lo > hi {
        return None;
    }
    // an end that overflowed: the value is beyond the largest double, so
    // that double is still an end ([+inf, +inf] enclosed nothing: the
    // systematic review's ROOT-F5)
    let lo = if lo == f64::INFINITY { f64::MAX } else { lo };
    let hi = if hi == f64::NEG_INFINITY { f64::MIN } else { hi };
    let down = |v: f64| if v.is_finite() { (v - 4.0 * f64::EPSILON * v.abs()).next_down() } else { v };
    let up = |v: f64| if v.is_finite() { (v + 4.0 * f64::EPSILON * v.abs()).next_up() } else { v };
    Some(Iv(down(lo), up(hi)))
}

impl Iv {
    pub fn contains_zero(self) -> bool {
        self.0 <= 0.0 && self.1 >= 0.0
    }
    fn add(self, o: Iv) -> Option<Iv> {
        out(self.0 + o.0, self.1 + o.1)
    }
    fn mul(self, o: Iv) -> Option<Iv> {
        let p = [self.0 * o.0, self.0 * o.1, self.1 * o.0, self.1 * o.1];
        if p.iter().any(|v| v.is_nan()) {
            return None;
        }
        out(p.iter().cloned().fold(f64::INFINITY, f64::min), p.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    }
    fn recip(self) -> Option<Iv> {
        if self.contains_zero() {
            return None;
        }
        out(1.0 / self.1, 1.0 / self.0)
    }
    fn powi(self, n: i64) -> Option<Iv> {
        // (the size limit before negating: -i64::MIN recursed forever, the
        // systematic review's ROOT-F6)
        if n.unsigned_abs() > 1 << 20 {
            return None;
        }
        if n < 0 {
            return self.powi(-n)?.recip();
        }
        if n == 0 {
            return Some(Iv(1.0, 1.0));
        }
        if n > 1 << 20 {
            return None;
        }
        let (a, b) = (self.0.abs(), self.1.abs());
        let (lo, hi) = if n % 2 == 1 {
            (self.0.signum() * a.powi(n as i32), self.1.signum() * b.powi(n as i32))
        } else {
            (if self.contains_zero() { 0.0 } else { a.min(b).powi(n as i32) }, a.max(b).powi(n as i32))
        };
        // (powi's own error: a few ulps per multiplication)
        let s = (n as f64) * 4.0 * f64::EPSILON;
        out(lo - lo.abs() * s, hi + hi.abs() * s)
    }
    /// A monotone library function (exp, ln, atan, ...), increasing or
    /// decreasing, with LIBM's allowance for its error.
    fn mono(self, f: impl Fn(f64) -> f64, increasing: bool) -> Option<Iv> {
        let (a, b) = (f(self.0), f(self.1));
        let (a, b) = if increasing { (a, b) } else { (b, a) };
        out(a - LIBM * a.abs(), b + LIBM * b.abs())
    }
}

/// An enclosure of e over x in [lo, hi], or None.
pub fn ival(e: &Expr, x: &str, r: Iv) -> Option<Iv> {
    match &e.kind {
        Kind::Sym(s) if &**s == x => Some(r),
        // an integer a double holds exactly is a point (so that acos(1) or a
        // bound at 1 is not widened past 1)
        Kind::Num(_) if e.as_rat().is_some_and(|q| q.is_integer() && num_traits::ToPrimitive::to_i64(q.numer()).is_some_and(|n| n.unsigned_abs() <= 1 << 53)) => {
            let n = num_traits::ToPrimitive::to_i64(e.as_rat().unwrap().numer()).unwrap() as f64;
            Some(Iv(n, n))
        }
        Kind::Num(_) | Kind::Const(Const::Pi | Const::E | Const::EulerGamma) => {
            let v = crate::eval::to_c64(e)?;
            if v.1 != 0.0 || !v.0.is_finite() {
                return None;
            }
            out(v.0, v.0)
        }
        Kind::Add(v) => v.iter().try_fold(Iv(0.0, 0.0), |acc, t| acc.add(ival(t, x, r)?)),
        Kind::Mul(v) => v.iter().try_fold(Iv(1.0, 1.0), |acc, t| acc.mul(ival(t, x, r)?)),
        Kind::Pow(b, n) if b.is_const(Const::E) => ival(n, x, r)?.mono(f64::exp, true),
        Kind::Pow(b, n) => {
            if let Some(k) = n.as_rat().filter(|q| q.is_integer()).and_then(|q| num_traits::ToPrimitive::to_i64(q.numer())) {
                return ival(b, x, r)?.powi(k);
            }
            // b^n = exp(n log b) for b > 0
            let bi = ival(b, x, r)?;
            if bi.0 <= 0.0 {
                return None;
            }
            let li = bi.mono(f64::ln, true)?;
            li.mul(ival(n, x, r)?)?.mono(f64::exp, true)
        }
        Kind::Fun(f, a) if a.len() == 1 => {
            let u = ival(&a[0], x, r)?;
            match f {
                Fun::Log if u.0 > 0.0 => u.mono(f64::ln, true),
                Fun::Atan => u.mono(f64::atan, true),
                Fun::Sinh => u.mono(f64::sinh, true),
                Fun::Tanh => u.mono(f64::tanh, true),
                Fun::Asinh => u.mono(f64::asinh, true),
                // real only on [-1, 1]
                Fun::Asin if u.0 >= -1.0 && u.1 <= 1.0 => u.mono(f64::asin, true),
                Fun::Acos if u.0 >= -1.0 && u.1 <= 1.0 => u.mono(f64::acos, false),
                Fun::Cosh => {
                    let m = u.0.abs().max(u.1.abs()).cosh();
                    let l = if u.contains_zero() { 1.0 } else { u.0.abs().min(u.1.abs()).cosh() };
                    out(l - LIBM * l, m + LIBM * m)
                }
                Fun::Abs => {
                    let m = u.0.abs().max(u.1.abs());
                    out(if u.contains_zero() { 0.0 } else { u.0.abs().min(u.1.abs()) }, m)
                }
                Fun::Sin => trig(u, false),
                Fun::Cos => trig(u, true),
                // (each by its definition in sin and cos)
                Fun::Sec => trig(u, true)?.recip(),
                Fun::Csc => trig(u, false)?.recip(),
                Fun::Tan => trig(u, false)?.mul(trig(u, true)?.recip()?),
                Fun::Cot => trig(u, true)?.mul(trig(u, false)?.recip()?),
                _ => None,
            }
        }
        _ => None,
    }
}

/// An enclosure of a real constant expression (no free symbols), or None.
pub fn encl(e: &Expr) -> Option<Iv> {
    ival(e, "\u{0}", Iv(0.0, 0.0))
}

/// A real constant as a double whose certified enclosure is narrow
/// (relative width 1e-9): the value to place it by, and None when it cannot
/// be placed (sin(10^20 + 1): the double of 10^20 + 1 is 10^20, and the
/// sine of that has the other sign; the fifth review's V3).
pub fn tight(e: &Expr) -> Option<f64> {
    let i = encl(e)?;
    let m = i.0 + (i.1 - i.0) / 2.0;
    (i.0.is_finite() && i.1.is_finite() && i.1 - i.0 <= 1e-9 * (1.0 + m.abs())).then_some(m)
}

/// sin(u) (or cos(u)) over u: the values at the ends, computed directly
/// (cos(u) is not sin(u + pi/2): rounding that sum loses a zero of cos, the
/// third review's T1), widened by LIBM absolutely and relatively, and +-1
/// where a maximum or minimum may lie inside (decided with a margin wider
/// than the error in the extrema's positions).  Large arguments get [-1, 1].
pub fn trig(u: Iv, cosine: bool) -> Option<Iv> {
    let (a, b) = (u.0, u.1);
    if !a.is_finite() || !b.is_finite() || a.abs().max(b.abs()) > 1e6 || b - a >= 2.0 * std::f64::consts::PI {
        return Some(Iv(-1.0, 1.0));
    }
    let f = |t: f64| if cosine { t.cos() } else { t.sin() };
    let (fa, fb) = (f(a), f(b));
    let w = |v: f64| LIBM * (1.0 + v.abs());
    let (mut lo, mut hi) = (fa.min(fb), fa.max(fb));
    lo -= w(lo);
    hi += w(hi);
    let tau = 2.0 * std::f64::consts::PI;
    let has = |c: f64| {
        // c + 2 k pi in [a - margin, b + margin] for some k
        let m = 1e-9 * (1.0 + a.abs().max(b.abs()));
        ((a - m - c) / tau).ceil() <= ((b + m - c) / tau).floor()
    };
    let (max_at, min_at) = if cosine { (0.0, std::f64::consts::PI) } else { (std::f64::consts::FRAC_PI_2, -std::f64::consts::FRAC_PI_2) };
    if has(max_at) {
        hi = 1.0;
    }
    if has(min_at) {
        lo = -1.0;
    }
    out(lo.max(-1.0), hi.min(1.0)).map(|i| Iv(i.0.max(-1.0), i.1.min(1.0)))
}

/// Whether b is certainly nonzero on [lo, hi] (bisection on interval
/// enclosures, a bounded number of steps).
pub fn certified_nonzero(b: &Expr, x: &str, lo: f64, hi: f64) -> bool {
    let (lo, hi) = (lo.next_down(), hi.next_up());
    if lo.is_infinite() || hi.is_infinite() {
        return ival(b, x, Iv(lo, hi)).map_or(false, |i| !i.contains_zero());
    }
    let mut todo = vec![(lo, hi)];
    let mut steps = 0;
    while let Some((l, h)) = todo.pop() {
        steps += 1;
        if steps > 20_000 {
            return false;
        }
        match ival(b, x, Iv(l, h)) {
            Some(i) if !i.contains_zero() => continue,
            _ => {}
        }
        if h - l < 1e-10 * (1.0 + l.abs()) {
            return false;
        }
        let m = l + (h - l) / 2.0;
        todo.push((l, m));
        todo.push((m, h));
    }
    true
}

