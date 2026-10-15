//! Unconditional bounds for the class group certificate (nf/proof.rs),
//! evaluated on balls (sagebrush-ball).
//!
//!   * Every ideal class of K contains an integral ideal a with
//!     N a <= min(Minkowski, Zimmert) sqrt|d|:
//!       - Minkowski: N a <= (4/pi)^r2 n!/n^n sqrt|d|;
//!       - Zimmert, "Ideale kleiner Norm in Idealklassen und eine
//!         Regulatorabschätzung", Invent. Math. 62 (1981) 367-380, Satz 2:
//!         for all gamma > alpha > 0,
//!           log(sqrt|d| / N a) >= r1 (-psi((1+gamma)/2) - log Gamma(1/2+gamma)
//!                                     + log Gamma(1+gamma) + log(pi)/2)
//!                                + r2 (-2 psi(1+gamma) + 2 log 2
//!                                      + log(1/2+gamma) + log pi)
//!                                - 2/(gamma-alpha)
//!                                - log[(1+1/alpha) (1+1/gamma)^-2
//!                                      (1+1/(2gamma-alpha))^-1].
//!     Zimmert's bound is the smaller for n >= 3 (except signature (1, 1));
//!     for quadratic fields Minkowski's is.
//!   * The regulator: Zimmert, op. cit., Satz 3: for all gamma > 0,
//!       R/w >= (1+gamma)(1+2gamma)/2 Gamma(1+gamma)^(r1+r2)
//!              Gamma(3/2+gamma)^r2 2^-(r1+r2) pi^(-r2/2)
//!              exp(-(1+gamma) [(r1+r2) psi((1+gamma)/2) + r2 psi(1+gamma/2)
//!                              + 2/gamma + 1/(1+gamma)]).
//!
//! gamma (and alpha, by Zimmert's Bemerkung 1: alpha = gamma -
//! gamma(gamma+1)/sqrt(1+3gamma+3gamma^2)) are chosen by a search at low
//! precision; any choice gives a valid bound, so they only need to be exact
//! dyadics in range.  Both formulas reproduce Zimmert's Tables 1 and 2
//! (tests below).

use num_traits::{One, Signed, Zero};
use sagebrush_ball::{digamma, lgamma, ln2, pi, Ball};
use sagebrush_bigint::BigInt;

/// Which bound gave the class-group norm bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormBound {
    Minkowski,
    Zimmert,
}

impl NormBound {
    pub fn name(self) -> &'static str {
        match self {
            NormBound::Minkowski => "Minkowski",
            NormBound::Zimmert => "Zimmert",
        }
    }
}

fn dy(x: f64) -> Ball {
    Ball::from_f64_exact(x).expect("finite")
}

/// The right-hand side of Satz 2 at (gamma, alpha), exact dyadics with
/// gamma > alpha > 0: a lower bound for log(sqrt|d| / N a) where a is an
/// integral ideal of least norm in its class.
fn satz2(r1: usize, r2: usize, gamma: &Ball, alpha: &Ball, prec: u64) -> Option<Ball> {
    let one = Ball::one();
    let half = Ball::exact(BigInt::one(), -1);
    let lpi = pi(prec).log(prec)?;
    let g1 = one.add(gamma, prec); // 1 + gamma
    let real = digamma(&g1.mul_2exp(-1), prec)?.neg()
        .sub(&lgamma(&half.add(gamma, prec), prec)?, prec)
        .add(&lgamma(&g1, prec)?, prec)
        .add(&lpi.mul_2exp(-1), prec);
    let complex = digamma(&g1, prec)?.mul_2exp(1).neg()
        .add(&ln2(prec).mul_2exp(1), prec)
        .add(&half.add(gamma, prec).log(prec)?, prec)
        .add(&lpi, prec);
    let ga = gamma.sub(alpha, prec);
    if !ga.is_positive() || !alpha.is_positive() {
        return None;
    }
    let inv = |x: &Ball| x.recip(prec);
    let l1 = one.add(&inv(alpha)?, prec).log(prec)?;
    let l2 = one.add(&inv(gamma)?, prec).log(prec)?;
    let l3 = one.add(&inv(&gamma.mul_2exp(1).sub(alpha, prec))?, prec).log(prec)?;
    Some(real.mul_i64(r1 as i64, prec)
        .add(&complex.mul_i64(r2 as i64, prec), prec)
        .sub(&inv(&ga)?.mul_2exp(1), prec)
        .sub(&l1, prec)
        .add(&l2.mul_2exp(1), prec)
        .add(&l3, prec))
}

/// Zimmert's best alpha for gamma (Bemerkung 1), as a dyadic in (0, gamma).
fn alpha_for(gamma: f64) -> f64 {
    let a = gamma - gamma * (gamma + 1.0) / (1.0 + 3.0 * gamma + 3.0 * gamma * gamma).sqrt();
    a.clamp(gamma * 1e-3, gamma * (1.0 - 1e-3))
}

/// log of the right-hand side of Satz 3 at gamma > 0 (exact dyadic): a
/// lower bound for log(R/w).
fn satz3_log(r1: usize, r2: usize, gamma: &Ball, prec: u64) -> Option<Ball> {
    let one = Ball::one();
    let g1 = one.add(gamma, prec);
    let s = (r1 + r2) as i64;
    let lead = g1.mul(&one.add(&gamma.mul_2exp(1), prec), prec).mul_2exp(-1).log(prec)?;
    let gammas = lgamma(&g1, prec)?.mul_i64(s, prec)
        .add(&lgamma(&Ball::exact(BigInt::from(3), -1).add(gamma, prec), prec)?.mul_i64(r2 as i64, prec), prec);
    let consts = ln2(prec).mul_i64(s, prec).add(&pi(prec).log(prec)?.mul_i64(r2 as i64, prec).mul_2exp(-1), prec);
    let bracket = digamma(&g1.mul_2exp(-1), prec)?.mul_i64(s, prec)
        .add(&digamma(&one.add(&gamma.mul_2exp(-1), prec), prec)?.mul_i64(r2 as i64, prec), prec)
        .add(&gamma.recip(prec)?.mul_2exp(1), prec)
        .add(&g1.recip(prec)?, prec);
    Some(lead.add(&gammas, prec).sub(&consts, prec).sub(&g1.mul(&bracket, prec), prec))
}

thread_local! {
    /// best_gamma's results by (formula, r1, r2): the search costs about
    /// 200 evaluations.
    static BEST: std::cell::RefCell<std::collections::HashMap<(u8, usize, usize), f64>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// best_gamma, cached by (which formula, r1, r2).
fn best_gamma_cached(key: (u8, usize, usize), f: &dyn Fn(f64) -> Option<f64>) -> f64 {
    if let Some(g) = BEST.with(|c| c.borrow().get(&key).copied()) {
        return g;
    }
    let g = best_gamma(f);
    BEST.with(|c| c.borrow_mut().insert(key, g));
    g
}

/// A dyadic gamma in (0, 12] (a multiple of 2^-10) near the maximum of f,
/// by golden-section search on a coarse bracket (f evaluated at low
/// precision; None counts as -infinity).  Any gamma gives a valid bound:
/// this only makes it tight (both functions have a single flat maximum).
fn best_gamma(f: &dyn Fn(f64) -> Option<f64>) -> f64 {
    let v = |g: f64| f(g).unwrap_or(f64::NEG_INFINITY);
    // the bracket: the best of a coarse grid and its neighbours
    let grid: Vec<f64> = (1..=24).map(|k| k as f64 / 2.0).collect();
    let k = (0..grid.len()).max_by(|&a, &b| v(grid[a]).total_cmp(&v(grid[b]))).unwrap();
    let (mut a, mut b) = (if k == 0 { 1.0 / 64.0 } else { grid[k - 1] }, grid[(k + 1).min(grid.len() - 1)]);
    let phi = (5f64.sqrt() - 1.0) / 2.0;
    let (mut x1, mut x2) = (b - phi * (b - a), a + phi * (b - a));
    let (mut f1, mut f2) = (v(x1), v(x2));
    while b - a > 1.0 / 1024.0 {
        if f1 < f2 {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = a + phi * (b - a);
            f2 = v(x2);
        } else {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = b - phi * (b - a);
            f1 = v(x1);
        }
    }
    (((a + b) / 2.0) * 1024.0).round().max(1.0) / 1024.0
}

/// Zimmert's lower bound for log(sqrt|d| / N a) for the signature, as a
/// ball, at the best gamma found.
pub fn zimmert_log_ratio(r1: usize, r2: usize, prec: u64) -> Option<Ball> {
    let f = |g: f64| satz2(r1, r2, &dy(g), &dy(alpha_for(g)), 64).map(|b| super::bnf::lower_f64(&b));
    let g = best_gamma_cached((2, r1, r2), &f);
    satz2(r1, r2, &dy(g), &dy(alpha_for(g)), prec)
}

/// log of Minkowski's constant (4/pi)^r2 n!/n^n.
fn minkowski_log_const(n: usize, r2: usize, prec: u64) -> Option<Ball> {
    let mut fact = BigInt::one();
    for k in 2..=n {
        fact *= BigInt::from(k);
    }
    let nn = BigInt::from(n).pow(n as u32);
    let c = Ball::from_int(&fact).log(prec)?.sub(&Ball::from_int(&nn).log(prec)?, prec);
    let four_over_pi = Ball::from_i64(4).log(prec)?.sub(&pi(prec).log(prec)?, prec);
    Some(c.add(&four_over_pi.mul_i64(r2 as i64, prec), prec))
}

/// floor of the upper end of exp(x): an integer at least exp(x) (x below
/// 2^20, so the result fits comfortably).
fn floor_exp_upper(x: &Ball, prec: u64) -> Option<BigInt> {
    let e = x.exp(prec)?;
    let (m, ex) = e.upper();
    if !m.is_positive() {
        return Some(BigInt::zero());
    }
    Some(if ex >= 0 { m << ex as u64 } else { m >> (-ex) as u64 })
}

/// An integer M such that every ideal class of a field of signature
/// (r1, r2) and discriminant disc contains an integral ideal of norm at most
/// M: the smaller of Minkowski's and Zimmert's bounds, rounded down after
/// rounding the ball up (norms are integers).
pub fn class_norm_bound(r1: usize, r2: usize, disc: &BigInt) -> Option<(BigInt, NormBound)> {
    let prec = 128;
    let n = r1 + 2 * r2;
    let half_log_d = Ball::from_int(&disc.abs()).log(prec)?.mul_2exp(-1);
    let mink = floor_exp_upper(&half_log_d.add(&minkowski_log_const(n, r2, prec)?, prec), prec)?;
    let zim = floor_exp_upper(&half_log_d.sub(&zimmert_log_ratio(r1, r2, prec)?, prec), prec)?;
    Some(if zim < mink { (zim, NormBound::Zimmert) } else { (mink, NormBound::Minkowski) })
}

/// A lower bound for the regulator of any field of signature (r1, r2)
/// with w roots of unity (Satz 3 at the best gamma found): a ball whose
/// lower end is the bound.
pub fn regulator_lower(r1: usize, r2: usize, w: u32, prec: u64) -> Option<Ball> {
    let f = |g: f64| satz3_log(r1, r2, &dy(g), 64).map(|b| super::bnf::lower_f64(&b));
    let g = best_gamma_cached((3, r1, r2), &f);
    let l = satz3_log(r1, r2, &dy(g), prec)?;
    Some(l.exp(prec)?.mul_i64(w as i64, prec))
}

/// The lower end of a ball as a double, rounded down a little more (for
/// messages and limits only).
pub fn lower_approx(b: &Ball) -> f64 {
    super::bnf::lower_f64(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Satz 2 and Satz 3 at Zimmert's own gamma reproduce his Tables 1
    /// and 2 (rounded down there, to 4 digits): our values are at least the
    /// table's and within 0.1% of it.
    #[test]
    fn zimmert_tables() {
        // (r1, r2, gamma, sqrt(d)/N a >= table 1)
        let t1: &[(usize, usize, f64, f64)] = &[(2, 0, 2.41, 1.760), (0, 1, 2.98, 1.400), (3, 0, 1.56, 4.636), (1, 1, 1.84, 3.355), (4, 0, 1.18, 14.45),
            (2, 1, 1.34, 9.749), (0, 2, 1.54, 6.792), (5, 0, 0.96, 50.21), (3, 1, 1.07, 32.12), (1, 2, 1.20, 21.11), (6, 0, 0.83, 188.1), (0, 3, 1.09, 46.74)];
        for &(r1, r2, g, t) in t1 {
            let v = satz2(r1, r2, &dy(g), &dy(alpha_for(g)), 128).unwrap().exp(128).unwrap();
            let lo = lower_approx(&v);
            assert!(lo >= t && lo <= t * 1.001, "Satz 2 at {:?}: {} vs table {}", (r1, r2), lo, t);
            // the search does as well as Zimmert's gamma, to the flat
            // maximum's precision
            let best = zimmert_log_ratio(r1, r2, 128).unwrap().exp(128).unwrap();
            assert!(lower_approx(&best) >= lo * (1.0 - 1e-4), "{:?}", (r1, r2));
        }
        // (r1, r2, gamma, 2 R / w >= table 2)
        let t2: &[(usize, usize, f64, f64)] = &[(2, 0, 2.43, 0.2296), (0, 1, 3.03, 0.1559), (3, 0, 1.58, 0.2129), (1, 1, 1.87, 0.1170), (4, 0, 1.20, 0.2697),
            (0, 2, 1.58, 0.06702), (6, 0, 0.85, 0.6825), (0, 3, 1.12, 0.05602)];
        for &(r1, r2, g, t) in t2 {
            let v = satz3_log(r1, r2, &dy(g), 128).unwrap().exp(128).unwrap().mul_i64(2, 128);
            let lo = lower_approx(&v);
            assert!(lo >= t && lo <= t * 1.001, "Satz 3 at {:?}: {} vs table {}", (r1, r2), lo, t);
            let best = regulator_lower(r1, r2, 1, 128).unwrap().mul_i64(2, 128);
            assert!(lower_approx(&best) >= lo * (1.0 - 1e-4), "{:?}", (r1, r2));
        }
    }

    /// The norm bound against Minkowski's constant computed directly, and
    /// which one wins: Minkowski for quadratic fields, Zimmert for
    /// totally real quartic and sextic fields.
    #[test]
    fn class_norm_bounds() {
        // Q(sqrt 5): Minkowski sqrt(5)/2 = 1.118
        assert_eq!(class_norm_bound(2, 0, &BigInt::from(5)).unwrap(), (BigInt::one(), NormBound::Minkowski));
        // d = -10^6 - 3 (imaginary quadratic): (2/pi) sqrt(1000003) = 636.6...
        assert_eq!(class_norm_bound(0, 1, &BigInt::from(-1_000_003)).unwrap(), (BigInt::from(636), NormBound::Minkowski));
        // a totally real sextic field with d = 10^12: sqrt(d)/188.1... < 5317
        let (m, which) = class_norm_bound(6, 0, &BigInt::from(10i64.pow(12))).unwrap();
        assert_eq!(which, NormBound::Zimmert);
        assert!(m <= BigInt::from(5317) && m >= BigInt::from(5000), "{}", m);
        let (m, which) = class_norm_bound(4, 0, &BigInt::from(725)).unwrap();
        assert_eq!((m, which), (BigInt::one(), NormBound::Zimmert));
    }
}
