//! The logarithmic integral and its offset form, in double precision:
//!
//! * `li(x)`: the principal value of the integral from 0 to x of dt / log t
//!   (Sage's `log_integral`, mpmath's `li`): li(x) = Ei(log x);
//! * `li_offset(x)`: Li(x) = li(x) - li(2), the integral from 2 to x
//!   (Sage's `log_integral_offset`, `Li`).
//!
//! li is computed in four ways, chosen so that no step loses digits, to
//! cancellation or to the rounding of L = log x (Ei(L) changes by about L
//! times a relative change in L, so for large x li is computed in a form
//! that depends on L only weakly):
//!
//! * x > 1 with L = log x < 2: the series
//!   Ei(L) = gamma + log L + sum_{n >= 1} L^n / (n n!)
//!   (Abramowitz and Stegun, *Handbook of Mathematical Functions*, 5.1.10),
//!   whose terms are all positive, summed with Neumaier's compensation;
//! * 2 <= L < 45: li(x) = (x / L) f(L) with f(L) = L e^{-L} Ei(L), which is
//!   close to 1 and changes slowly; f is a Chebyshev expansion on each of
//!   five intervals (src/li_cheb.rs, fitted by gen/li_cheb.py with mpmath at
//!   60 digits to within 2^-62), summed by Clenshaw's recurrence;
//! * L >= 45: the asymptotic expansion
//!   li(x) ~ (x / L) sum_{k >= 0} k! / L^k (A&S 5.1.51), stopped at its
//!   smallest term, whose relative error is then about sqrt(2 pi L) e^{-L},
//!   below 2^-60 here;
//! * 0 < x < 1: li(x) = Ei(L) = -E1(t) with t = -log x > 0.  For t <= 1 the
//!   same series (alternating, its terms below 1 in size); for t > 1,
//!   E1(t) = e^{-t} g(t) where g(t) = e^t E1(t) is the even continued fraction
//!   g(t) = 1/(t+1- 1^2/(t+3- 2^2/(t+5- ...)))
//!   (A&S 5.1.22, in the form of Press et al., *Numerical Recipes*, 3rd ed.,
//!   section 6.3), evaluated by the modified Lentz method; since e^{-t} = x,
//!   li(x) = -x g(t), which neither overflows nor underflows before x does.
//!
//! li(0) = 0, li(1) = -infinity, li(+infinity) = +infinity; li is NaN for
//! x < 0 and for NaN.
//!
//! Written from the cited formulas only; tests/li.rs checks every value of a
//! table computed by mpmath at 60 digits.

/// Euler's constant gamma.
const EULER_GAMMA: f64 = std::f64::consts::EULER_GAMMA;
/// li(2) = 1.045163780117492784844588889194613136523...
pub const LI_2: f64 = 1.045_163_780_117_493;
/// From here on (L = log x), the Chebyshev expansions of f; then the asymptotic expansion.
const CHEBYSHEV_FROM: f64 = 2.0;
const ASYMPTOTIC_FROM: f64 = 45.0;

use crate::li_cheb::LI_CHEB;

/// f(L) = L e^{-L} Ei(L) for CHEBYSHEV_FROM <= L < ASYMPTOTIC_FROM.
fn f_chebyshev(l: f64) -> f64 {
    let (a, b, c) = LI_CHEB
        .iter()
        .find(|(_, b, _)| l < *b)
        .copied()
        .unwrap_or(LI_CHEB[LI_CHEB.len() - 1]);
    let t = (2.0 * l - a - b) / (b - a);
    let (mut b1, mut b2) = (0.0, 0.0);
    for &cj in c[1..].iter().rev() {
        let b0 = 2.0 * t * b1 - b2 + cj;
        b2 = b1;
        b1 = b0;
    }
    t * b1 - b2 + c[0]
}
/// Terms below this share of the sum end a series.
const TINY: f64 = 1.0 / ((1u64 << 60) as f64);

/// Neumaier's compensated sum.
struct Sum {
    s: f64,
    c: f64,
}

impl Sum {
    fn new(s: f64) -> Sum {
        Sum { s, c: 0.0 }
    }
    fn add(&mut self, x: f64) {
        let t = self.s + x;
        if self.s.abs() >= x.abs() {
            self.c += (self.s - t) + x;
        } else {
            self.c += (x - t) + self.s;
        }
        self.s = t;
    }
    fn value(&self) -> f64 {
        self.s + self.c
    }
}

/// Ei(l) = gamma + log|l| + sum_{n >= 1} l^n / (n n!), for l > 0, or
/// -1 <= l < 0.
fn ei_series(l: f64) -> f64 {
    let mut s = Sum::new(EULER_GAMMA);
    s.add(l.abs().ln());
    let mut power = 1.0; // l^n / n!
    let mut n = 1.0;
    loop {
        power *= l / n;
        let term = power / n;
        s.add(term);
        if term.abs() <= TINY * s.value().abs() || n > 400.0 {
            break;
        }
        n += 1.0;
    }
    s.value()
}

/// li(x) for x > 1 with l = log x >= ASYMPTOTIC_FROM:
/// (x / l) sum_{k >= 0} k! / l^k, to its smallest term.
fn li_asymptotic(x: f64, l: f64) -> f64 {
    let mut s = Sum::new(1.0);
    let mut term: f64 = 1.0;
    let mut k = 1.0;
    loop {
        let next = term * k / l;
        if next >= term || next <= TINY * s.value() {
            break;
        }
        s.add(next);
        term = next;
        k += 1.0;
    }
    x / l * s.value()
}

/// g(t) = e^t E1(t) for t > 1: the even continued fraction, by Lentz.
fn e1_scaled(t: f64) -> f64 {
    const FPMIN: f64 = 1e-300;
    let mut b = t + 1.0;
    let mut c = 1.0 / FPMIN;
    let mut d = 1.0 / b;
    let mut h = d;
    let mut i = 1.0;
    while i < 10_000.0 {
        let a = -i * i;
        b += 2.0;
        d = 1.0 / (a * d + b);
        c = b + a / c;
        let del = c * d;
        h *= del;
        if (del - 1.0).abs() <= f64::EPSILON / 4.0 {
            break;
        }
        i += 1.0;
    }
    h
}

/// The logarithmic integral li(x) = PV integral from 0 to x of dt / log t.
pub fn li(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return 0.0;
    }
    if x == 1.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    let l = x.ln();
    if l > 0.0 {
        if l < CHEBYSHEV_FROM {
            ei_series(l)
        } else if l < ASYMPTOTIC_FROM {
            x / l * f_chebyshev(l)
        } else {
            li_asymptotic(x, l)
        }
    } else if l >= -1.0 {
        ei_series(l)
    } else {
        -x * e1_scaled(-l)
    }
}

/// The offset logarithmic integral Li(x) = li(x) - li(2).
pub fn li_offset(x: f64) -> f64 {
    li(x) - LI_2
}
