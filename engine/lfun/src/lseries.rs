//! L(E, s) for an elliptic curve E over Q of conductor N, by the smoothed
//! approximate functional equation, for finite s with Re s in [-10, 12] and
//! |Im s| <= 1000 (RE_SPAN, MAX_IM), given enough coefficients.
//!
//! With Q = sqrt(N) / (2 pi), Lambda(s) = Q^s Gamma(s) L(E, s) satisfies
//! Lambda(s) = eps Lambda(2 - s) for the root number eps = +-1.  With
//! phi(x) = sum a_n e^(-n x / Q), Lambda(s) = int_0^oo phi(x) x^(s-1) dx and
//! phi(1/x) = eps x^2 phi(x).  Turning the path of integration to the ray
//! arg x = theta (|theta| < pi/2), splitting it at |x| = 1 and applying the
//! functional equation to the inner part gives, for every s,
//!
//!   Lambda(s) = sum_n a_n [ (Q/n)^s Gamma(s, n d / Q) + eps (Q/n)^(2-s) Gamma(2 - s, n conj(d) / Q) ],
//!
//! d = e^(i theta) (Rubinstein, "Computational methods and experiments in
//! analytic number theory", 2005, section 3.2).  At theta = 0 the terms are of
//! size about e^(-|z|) while |Gamma(1 + it)| is about e^(-pi |t| / 2), so the
//! sum would lose pi |t| / (2 ln 10) digits to cancellation; with
//! theta = sign(t) (pi/2 - C / |t|) the terms shrink like e^(-theta t) and the
//! loss is about e^C, at the price of about Q |t| / C times more terms.
//!
//! Everything is divided by Q^s Gamma(s) term by term (in logarithms), to
//! avoid underflow from the Gamma factor within the accepted height range.

use crate::complex::C64;
use crate::gamma::{gamma_inc, ln_gamma};

/// The rotation's loss allowance: theta = pi/2 - C/|t|, so the terms are
/// about e^C times the result (C = 3: about 1.3 digits).
const ROTATION_C: f64 = 3.0;

/// Terms dropped once e^-(n cos(theta) / Q) times their other factors is
/// below this, relative to 1 (L(E, s) is of order 1 where it is not near a zero).
const TAIL: f64 = 1e-18;

/// The largest |Im s| accepted: the height the tests reach (Gamma(a, z) and
/// L(E, s) against mpmath and PARI up to |Im| = 1000).
pub const MAX_IM: f64 = 1_000.0;
/// Re s must lie in [-RE_SPAN, 2 + RE_SPAN] (the functional equation's
/// symmetric range around the centre s = 1).
pub const RE_SPAN: f64 = 10.0;

/// The L-series of an elliptic curve: its coefficients [0, a_1, ..., a_M],
/// conductor N and root number.
#[derive(Clone, Debug)]
pub struct LSeries {
    an: Vec<f64>,
    conductor: u64,
    q: f64,
    eps: i32,
}

/// The rotation angle used at s.
fn theta_for(s: C64) -> f64 {
    let t = s.im.abs();
    let th = (std::f64::consts::FRAC_PI_2 - ROTATION_C / t).max(0.0);
    if s.im < 0.0 {
        -th
    } else {
        th
    }
}

fn check_s(s: C64) -> Result<(), String> {
    if !s.is_finite() {
        return Err("L(E, s): s must be finite".into());
    }
    if s.im.abs() > MAX_IM {
        return Err(format!("L(E, s): |Im s| must be at most {}", MAX_IM));
    }
    if s.re < -RE_SPAN || s.re > 2.0 + RE_SPAN {
        return Err(format!("L(E, s): Re s must lie in [{}, {}]", -RE_SPAN, 2.0 + RE_SPAN));
    }
    Ok(())
}

/// The number of coefficients L(E, s) needs at s for a curve of conductor
/// `conductor`: past it, both terms are below TAIL (bounded with
/// |a_n| <= d(n) sqrt(n) <= n and |Gamma(a, z)| <= 2 |z^(a-1) e^(-z)| where
/// |z| >= 2 |a|, which the cut-off always satisfies).  An error outside the
/// accepted range of s.
pub fn terms_needed(conductor: u64, s: C64) -> Result<usize, String> {
    check_s(s)?;
    if conductor == 0 {
        return Err("L(E, s): the conductor must be positive".into());
    }
    let q = (conductor as f64).sqrt() / (2.0 * std::f64::consts::PI);
    let th = theta_for(s);
    let lgs = ln_gamma(s).map(|g| g.re).unwrap_or(0.0);
    let s2 = C64::new(2.0, 0.0) - s;
    // ln of the bound on |term_n / (Q^s Gamma(s))| for each of the two terms
    let bound = |n: f64| -> f64 {
        let x = n / q;
        let lz = C64::new(x.ln(), th);
        let lzc = C64::new(x.ln(), -th);
        let ex = -x * th.cos();
        let t1 = -s.re * n.ln() + ((s - 1.0) * lz).re + ex;
        let t2 = (2.0 - 2.0 * s.re) * q.ln() + (s.re - 2.0) * n.ln() + ((s2 - 1.0) * lzc).re + ex;
        // (the terms past n fall at least geometrically, by e^(-cos(theta) / Q)
        // each: the tail is at most (1 + Q / cos(theta)) times the n-th)
        n.ln() + 2f64.ln() + t1.max(t2) - lgs + (1.0 + q / th.cos()).ln()
    };
    let floor = (2.0 * s.abs().max(s2.abs()) * q).max(1.0);
    let mut n = floor;
    while bound(n) > TAIL.ln() {
        n *= 1.25;
        if n > 1e12 {
            return Err("L(E, s): too many terms needed".into());
        }
    }
    Ok(n.ceil() as usize)
}

impl LSeries {
    /// From [0, a_1, ..., a_M], the conductor and the root number.
    pub fn new(an: &[i64], conductor: u64, eps: i32) -> Result<LSeries, String> {
        if conductor == 0 {
            return Err("L(E, s): the conductor must be positive".into());
        }
        if eps != 1 && eps != -1 {
            return Err("L(E, s): the root number must be 1 or -1".into());
        }
        if an.len() < 2 || an[1] != 1 {
            return Err("L(E, s): the coefficients must start [0, 1, ...]".into());
        }
        Ok(LSeries {
            an: an.iter().map(|&x| x as f64).collect(),
            conductor,
            q: (conductor as f64).sqrt() / (2.0 * std::f64::consts::PI),
            eps,
        })
    }

    pub fn conductor(&self) -> u64 {
        self.conductor
    }

    pub fn root_number(&self) -> i32 {
        self.eps
    }

    /// The two halves of Lambda(s) / (Q^s Gamma(s)) on the ray theta, over
    /// the first m terms: (sum a_n n^-s Gamma(s, z_n) / Gamma(s),
    /// sum a_n Q^(2-2s) n^(s-2) Gamma(2-s, conj z_n) / Gamma(s)).
    fn halves(&self, s: C64, theta: f64, m: usize) -> Result<(C64, C64), String> {
        let lgs = ln_gamma(s).ok_or("L(E, s): Gamma(s) has a pole")?;
        let s2 = C64::new(2.0, 0.0) - s;
        let d = C64::new(theta.cos(), theta.sin());
        let lq = self.q.ln();
        let c2 = (s2 - s) * lq - lgs; // (2 - 2s) ln Q - ln Gamma(s)
        let (mut a, mut b) = (C64::ZERO, C64::ZERO);
        sagebrush_interrupt::phase("lfun.value");
        for n in 1..=m {
            let an = self.an[n];
            if n.is_multiple_of(64) {
                sagebrush_interrupt::check();
            }
            if an == 0.0 {
                continue;
            }
            let ln_n = (n as f64).ln();
            let x = n as f64 / self.q;
            let g1 = gamma_inc(s, d * x)?;
            let g2 = gamma_inc(s2, d.conj() * x)?;
            a = a + (g1.ln - s * ln_n - lgs).exp() * g1.m * an;
            b = b + (g2.ln + (s - 2.0) * ln_n + c2).exp() * g2.m * an;
        }
        Ok((a, b))
    }

    /// L(E, s).  An error if s is outside the accepted range or the series
    /// has fewer coefficients than `terms_needed` asks for there.
    /// Interruptible.
    pub fn value(&self, s: C64) -> Result<C64, String> {
        let m = terms_needed(self.conductor, s)?;
        if m >= self.an.len() {
            return Err(format!("L(E, s): {} coefficients are needed, {} were given", m, self.an.len() - 1));
        }
        // the trivial zeros: Gamma(s) has a pole and Lambda(s) is finite
        if s.im == 0.0 && s.re <= 0.0 && s.re == s.re.round() {
            return Ok(C64::ZERO);
        }
        let (a, b) = self.halves(s, theta_for(s), m)?;
        Ok(a + b * self.eps as f64)
    }
}

/// The root number of the L-series with coefficients `an` and conductor
/// `conductor`, from the functional equation: the exact sum above does not
/// depend on theta, so comparing theta = 0 with theta = 0.6 at s = 1.1 + 0.37i
/// gives eps.  A consistency check, not a proof: an error if the inferred
/// value is not within 1e-6 of 1 or -1 (inconsistent conductor or
/// coefficients, or too few coefficients).
pub fn root_number(an: &[i64], conductor: u64) -> Result<i32, String> {
    let l = LSeries::new(an, conductor, 1)?;
    let s = C64::new(1.1, 0.37);
    let m = terms_needed(conductor, s)?;
    // theta = 0.6 needs more terms than theta = 0
    let m = ((m as f64) / 0.6f64.cos()).ceil() as usize;
    if m >= an.len() {
        return Err(format!("root number: {} coefficients are needed, {} were given", m, an.len() - 1));
    }
    let (a0, b0) = l.halves(s, 0.0, m)?;
    let (a1, b1) = l.halves(s, 0.6, m)?;
    let w = (a1 - a0) / (b0 - b1);
    for e in [1, -1] {
        if (w - e as f64).abs() < 1e-6 {
            return Ok(e);
        }
    }
    Err(format!("root number: the functional equation does not hold (got {:.3e}{:+.3e}i): wrong conductor or coefficients", w.re, w.im))
}
