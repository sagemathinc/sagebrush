//! The Gamma function and the upper incomplete Gamma function for complex
//! arguments, in double precision, as logarithms or scaled values so that
//! nothing over- or underflows for large imaginary parts (|Gamma(1 + it)|
//! is about e^(-pi |t| / 2)).
//!
//! * `ln_gamma(z)`: Stirling's series (A&S 6.1.40) after shifting Re z up
//!   with Gamma(z + 1) = z Gamma(z).
//! * `gamma_inc(a, z)`: Gamma(a, z) = int_z^oo w^(a-1) e^(-w) dw for
//!   Re z >= 0, z != 0:
//!   - small |z|: Gamma(a) - gamma(a, z) with the series
//!     gamma(a, z) = z^a e^(-z) sum_k z^k / (a (a+1) ... (a+k)) (A&S 6.5.29);
//!   - small |z| and a within 1/4 of a pole -m of Gamma(a): the pole of
//!     Gamma(a) and the k = m term of gamma(a, z) cancel in closed form
//!     (below), so a = 0, -1, ... and their neighbourhoods lose nothing;
//!   - otherwise Legendre's continued fraction (A&S 6.5.31), evaluated by
//!     the modified Lentz method.
//!
//! The error is measured against max(|Gamma(a)|, |Gamma(a, z)|) (against
//! |z^a e^(-z)| at the poles of Gamma(a)): the L-series divides each term
//! by Gamma(s), so that is what an error in one term costs, and Gamma(a, z)
//! itself can be near a zero.

use crate::complex::C64;

/// (1/2) ln(2 pi)
const HALF_LN_2PI: f64 = 0.918_938_533_204_672_8;
/// B_2k / (2k (2k - 1)) for k = 1..=10 (A&S 6.1.40)
const STIRLING: [f64; 10] = [
    1.0 / 12.0,
    -1.0 / 360.0,
    1.0 / 1260.0,
    -1.0 / 1680.0,
    1.0 / 1188.0,
    -691.0 / 360_360.0,
    1.0 / 156.0,
    -3617.0 / 122_400.0,
    43867.0 / 244_188.0,
    -174_611.0 / 125_400.0,
];
/// zeta(k) for k = 2..=12; larger k use 1 + 2^-k + ... + 5^-k (the rest is
/// below 6^-13 and is multiplied by |eps|^13 / 13 < 1e-9 where it is used)
const ZETA: [f64; 11] = [
    1.644_934_066_848_226_4,
    1.202_056_903_159_594_3,
    1.082_323_233_711_138_2,
    1.036_927_755_143_37,
    1.017_343_061_984_449,
    1.008_349_277_381_922_8,
    1.004_077_356_197_944_3,
    1.002_008_392_826_082_2,
    1.000_994_575_127_818_1,
    1.000_494_188_604_119_5,
    1.000_246_086_553_308,
];

/// Re z below which ln_gamma refuses (the shift would take too many steps).
pub const RE_MIN: f64 = -1000.0;

/// |z| from which Stirling's series is used: its first omitted term is below
/// |B_22| / (22 * 21 * 15^21) < 1e-23.
const STIRLING_FROM: f64 = 15.0;

/// A value m e^ln: ln carries the size and the phase, m is moderate.
#[derive(Clone, Copy, Debug)]
pub struct Scaled {
    pub ln: C64,
    pub m: C64,
}

impl Scaled {
    pub fn value(self) -> C64 {
        self.m * self.ln.exp()
    }
}

/// A logarithm of Gamma(z) (a branch; exp of it is Gamma(z)); None at the
/// poles z = 0, -1, -2, ... and for Re z < RE_MIN or non-finite z.
pub fn ln_gamma(z: C64) -> Option<C64> {
    if !z.is_finite() || z.re < RE_MIN {
        return None;
    }
    if z.im == 0.0 && z.re <= 0.0 && z.re == z.re.round() {
        return None;
    }
    // shift: ln Gamma(z) = ln Gamma(z + n) - sum_{k<n} ln(z + k)
    let mut w = z;
    let mut shift = C64::ZERO;
    while w.re < 0.5 || w.abs() < STIRLING_FROM {
        shift = shift + w.ln();
        w = w + 1.0;
    }
    let r = w.recip();
    let r2 = r * r;
    let mut series = C64::ZERO;
    for &c in STIRLING.iter().rev() {
        series = series * r2 + c;
    }
    series = series * r;
    Some((w - 0.5) * w.ln() - w + HALF_LN_2PI + series - shift)
}

/// expm1(x) / x, with its limit 1 at 0.
fn expm1_over(x: C64) -> C64 {
    if x.abs() < 0.5 {
        // sum x^n / (n + 1)!
        let mut term = C64::ONE;
        let mut sum = C64::ONE;
        for n in 2..30 {
            term = term * x * (1.0 / n as f64);
            sum = sum + term;
            if term.abs() < 1e-18 * sum.abs() {
                break;
            }
        }
        sum
    } else {
        (x.exp() - 1.0) / x
    }
}

/// ln(1 + x) / x for |x| <= 1/4 (the series sum (-x)^n / (n + 1)).
fn ln1p_over(x: C64) -> C64 {
    let mut term = C64::ONE;
    let mut sum = C64::ONE;
    for n in 1..40 {
        term = -(term * x);
        let t = term * (1.0 / (n + 1) as f64);
        sum = sum + t;
        if t.abs() < 1e-18 * sum.abs() {
            break;
        }
    }
    sum
}

fn zeta(k: usize) -> f64 {
    if k <= 12 {
        ZETA[k - 2]
    } else {
        (1..=5).map(|n| (n as f64).powi(-(k as i32))).sum()
    }
}

/// Where to switch from the series to the continued fraction.  Measured
/// against mpmath on the rays the L-series uses (|arg z| = pi/2 - 3/|Im a|),
/// relative to max(|Gamma(a)|, |Gamma(a, z)|): at |z| = |a| both keep about
/// 5e-13 up to |Im a| = 1000; the continued fraction loses everything below
/// |z| = 0.85 |a| at Im a = 1000 (0.9 |a| is still 1e-7 there), and the
/// series loses from |z| = 1.1 |a|.  So the switch is at |z| = |a|, and at 2
/// for small |a| (the series' alternating terms lose at most e^2 there).
fn use_series(a: C64, z: C64) -> bool {
    let r = z.abs();
    r <= 2.0 || r <= a.abs()
}

/// Continued-fraction iterations allowed before giving up.
pub const CF_MAX_ITER: usize = 20_000;

/// Gamma(a, z) for Re z >= 0, z != 0, as a scaled value; an error for z
/// outside that half-plane, non-finite input, Re a < RE_MIN, or a
/// continued fraction that does not converge.
pub fn gamma_inc(a: C64, z: C64) -> Result<Scaled, String> {
    if !a.is_finite() || !z.is_finite() {
        return Err("gamma_inc: arguments must be finite".into());
    }
    if z.re < 0.0 || (z.re == 0.0 && z.im == 0.0) {
        return Err("gamma_inc: z must satisfy Re z >= 0 and z != 0".into());
    }
    if a.re < RE_MIN {
        return Err(format!("gamma_inc: Re a must be at least {}", RE_MIN));
    }
    if use_series(a, z) {
        let m = (-a.re).round();
        if m >= 0.0 && (a + m).abs() <= 0.25 {
            return Ok(near_pole(a, m as usize, z));
        }
        return series(a, z);
    }
    continued_fraction(a, z)
}

/// Gamma(a) - gamma(a, z), gamma by A&S 6.5.29.
fn series(a: C64, z: C64) -> Result<Scaled, String> {
    let lg = ln_gamma(a).ok_or("gamma_inc: Gamma(a) has a pole")?;
    let lz = z.ln();
    // sum_k z^k / (a)_(k+1)
    let mut term = a.recip();
    let mut sum = term;
    let mut k = 1.0;
    loop {
        term = term * z / (a + k);
        sum = sum + term;
        if term.abs() <= 1e-17 * sum.abs() {
            break;
        }
        k += 1.0;
        if k > 10_000.0 {
            return Err("gamma_inc: the series did not converge".into());
        }
        if (k as u64).is_multiple_of(256) {
            sagebrush_interrupt::check();
        }
    }
    let lgam = a * lz - z; // gamma(a, z) = e^lgam * sum
    let base = if lg.re >= lgam.re { lg } else { lgam };
    let m = (lg - base).exp() - (lgam - base).exp() * sum;
    Ok(Scaled { ln: base, m })
}

/// Gamma(a, z) for a = -m + eps, |eps| <= 1/4, small |z|.  With
/// gamma(a, z) = z^a sum_k (-z)^k / (k! (a + k)) (A&S 6.5.4 and 6.5.29),
///   Gamma(a, z) = [Gamma(a) - (-1)^m z^eps / (m! eps)] - z^a sum_(k != m) ...
/// and, with P(eps) = prod_(j=1..m) (eps - j), Gamma(a) = Gamma(1+eps) / (eps P(eps)):
///   [..] = (g - p) / P(eps) - ln z * E(eps ln z) / P(0),
/// g = (Gamma(1 + eps) - 1) / eps, p = (P(eps)/P(0) - 1) / eps, E(x) = expm1(x)/x,
/// each computed without cancellation (ln Gamma(1 + eps) by A&S 6.1.33).
fn near_pole(a: C64, m: usize, z: C64) -> Scaled {
    let eps = a + m as f64;
    // ln Gamma(1 + eps) / eps = -gamma + sum_(k>=2) (-1)^k zeta(k) eps^(k-1) / k
    let mut lg_over = C64::real(-std::f64::consts::EULER_GAMMA);
    let mut pw = C64::ONE; // eps^(k-1)
    for k in 2..60 {
        pw = pw * eps;
        let t = pw * (zeta(k) / k as f64);
        lg_over = if k % 2 == 0 { lg_over + t } else { lg_over - t };
        if t.abs() < 1e-18 {
            break;
        }
    }
    let g = lg_over * expm1_over(lg_over * eps);
    // ln(P(eps)/P(0)) / eps = sum_j ln(1 - eps/j) / eps = -sum_j (1/j) L(-eps/j)
    let mut lp_over = C64::ZERO;
    for j in 1..=m {
        let x = eps * (-1.0 / j as f64);
        lp_over = lp_over - ln1p_over(x) * (1.0 / j as f64);
    }
    let p = lp_over * expm1_over(lp_over * eps);
    let mut p0 = 1.0; // P(0) = (-1)^m m!
    for j in 1..=m {
        p0 *= -(j as f64);
    }
    let pe = (C64::ONE + eps * p) * p0; // P(eps)
    let lz = z.ln();
    let bracket = (g - p) / pe - lz * expm1_over(eps * lz) * (1.0 / p0);
    // z^a sum_(k != m) (-z)^k / (k! (a + k))
    let mut rest = C64::ZERO;
    let mut pk = C64::ONE; // (-z)^k / k!
    let mut k = 0usize;
    loop {
        if k != m {
            let t = pk / (a + k as f64);
            rest = rest + t;
            if k > m && t.abs() <= 1e-17 * rest.abs().max(1e-300) {
                break;
            }
        }
        k += 1;
        pk = pk * (-z) * (1.0 / k as f64);
        if k > 400 {
            break;
        }
    }
    let m_val = bracket - (a * lz).exp() * rest;
    Scaled { ln: C64::ZERO, m: m_val }
}

/// Legendre's continued fraction (A&S 6.5.31):
///   Gamma(a, z) = e^(-z) z^a / (z + 1 - a - 1 (1 - a) / (z + 3 - a - 2 (2 - a) / (z + 5 - a - ...)))
/// by the modified Lentz method.
fn continued_fraction(a: C64, z: C64) -> Result<Scaled, String> {
    const TINY: f64 = 1e-300;
    let tiny = C64::real(TINY);
    let mut f = z + 1.0 - a;
    if f.abs() < TINY {
        f = tiny;
    }
    let mut c = f;
    let mut d = C64::ZERO;
    for k in 1..=CF_MAX_ITER {
        let kf = k as f64;
        let an = (a - kf) * kf; // -k (k - a)
        let bn = z + (2.0 * kf + 1.0) - a;
        d = bn + an * d;
        if d.abs() < TINY {
            d = tiny;
        }
        c = bn + an / c;
        if c.abs() < TINY {
            c = tiny;
        }
        d = d.recip();
        let delta = c * d;
        f = f * delta;
        if (delta - 1.0).abs() < 1e-16 {
            return Ok(Scaled { ln: a * z.ln() - z, m: f.recip() });
        }
        if k.is_multiple_of(256) {
            sagebrush_interrupt::check();
        }
    }
    Err("gamma_inc: the continued fraction did not converge".into())
}
