//! Special functions: Bernoulli numbers, the dilogarithm Li2 on [0, 1] and
//! the inverse tangent integral Ti2(y) = Im Li2(i y) on [0, 1].

use crate::ball::Ball;
use crate::complex::CBall;
use crate::funcs::{euler_gamma, pi};
use crate::mag::Mag;
use num_traits::{One, Zero};
use sagebrush_bigint::{BigInt, BigRational};
use std::cell::RefCell;

thread_local! {
    static BERNOULLI: RefCell<Vec<BigRational>> = const { RefCell::new(Vec::new()) };
}

/// B_0 .. B_n exactly (B_1 = -1/2), from sum_(j<=m) C(m+1, j) B_j = 0.
pub fn bernoulli(n: usize) -> Vec<BigRational> {
    BERNOULLI.with(|c| {
        let mut b = c.borrow_mut();
        if b.is_empty() {
            b.push(BigRational::one());
        }
        while b.len() <= n {
            let m = b.len();
            let mut s = BigRational::zero();
            let mut binom = BigInt::one(); // C(m+1, j)
            for (j, bj) in b.iter().enumerate() {
                if !bj.is_zero() {
                    s += BigRational::from_integer(binom.clone()) * bj;
                }
                binom = binom * BigInt::from(m + 1 - j) / BigInt::from(j + 1);
            }
            b.push(-s / BigRational::from_integer(BigInt::from(m + 1)));
        }
        b[..=n].to_vec()
    })
}

fn rat_ball(q: &BigRational, wp: u64) -> Ball {
    Ball::from_rational(q.numer(), q.denom(), wp)
}

/// sum_k B_k w^(k+1) / (k+1)! = Li2(z) for w = -log(1 - z), |w| <= 3.
///
/// Tail: B_k = 0 for odd k > 1, and |B_2j| = 2 (2j)! zeta(2j) / (2 pi)^2j
/// < 4 (2j)! / (2 pi)^2j, so |B_k w^(k+1)/(k+1)!| <= 4 |w| rho^k with
/// rho = |w| / (2 pi), and the terms from k = K on (K >= 2) sum to at most
/// 4 |w| rho^K / (1 - rho) <= 8 |w| rho^K (|w| <= 3 < pi makes rho <= 1/2).
fn li2_from_w(w: &CBall, wp: u64) -> CBall {
    let wabs = w.upper_abs();
    // rho = |w| / (2 pi) <= 1/2 on the whole ball
    let rho = wabs.div(Mag::from_u64(6)); // (6 < 2 pi)
    assert!(rho.le_pow2(-1), "li2: |w| too large");
    let goal = wabs.max(Mag::pow2(-64)).mul_2exp(-(wp as i64));
    let mut sum = CBall::zero();
    let mut pw = w.clone(); // w^(k+1) / (k+1)!
    let mut k = 0usize;
    let mut tail_k = wabs.mul_2exp(3); // 8 |w| rho^k
    loop {
        if k >= 2 && tail_k <= goal {
            return sum.add_error(tail_k);
        }
        let b = bernoulli(k)[k].clone();
        if !b.is_zero() {
            sum = sum.add(&pw.scale(&rat_ball(&b, wp), wp), wp);
        }
        k += 1;
        pw = pw.mul(w, wp).div_i64((k + 1) as i64, wp);
        tail_k = tail_k.mul(rho);
    }
}

/// Li2(x) for a ball in [-1, 1] (None if it reaches outside, or is too
/// wide around 1/2: below 1/2 directly; above, by Euler's reflection
/// Li2(x) = pi^2/6 - log(x) log(1 - x) - Li2(1 - x)).
pub fn li2(x: &Ball, prec: u64) -> Option<Ball> {
    use std::cmp::Ordering::*;
    let wp = prec + 32;
    let one = Ball::one();
    // the whole ball in [-1, 1] (a ball reaching beyond is refused, not
    // clipped: Li2 is complex above 1, the review's BALL-F9)
    if !x.is_finite() {
        return None; // (before the endpoints: an infinite radius has none)
    }
    let (um, ue) = x.upper();
    let (lm0, le0) = x.lower();
    if crate::ball::cmp_dyadic(&um, ue, &BigInt::one(), 0) == Greater || crate::ball::cmp_dyadic(&lm0, le0, &-BigInt::one(), 0) == Less {
        return None;
    }
    if crate::ball::cmp_dyadic(&um, ue, &BigInt::one(), -1) != Greater {
        // |w| = |log(1 - x)| <= log 2 on [-1, 1/2]
        let w = one.sub(x, wp).log(wp)?.neg();
        return Some(li2_from_w(&CBall::real(w), wp).re.rounded(prec));
    }
    let (lm, le) = x.lower();
    if crate::ball::cmp_dyadic(&lm, le, &BigInt::one(), -2) != Greater {
        return None; // (a ball from below 1/4 to above 1/2)
    }
    let p2 = pi(wp).sqr(wp).div_i64(6, wp);
    if crate::ball::cmp_dyadic(&um, ue, &BigInt::one(), 0) == Equal {
        // the ball's upper end is 1: Li2 increases to pi^2/6 there (Li2(1)
        // itself, for a lower end at 1)
        if crate::ball::cmp_dyadic(&lm, le, &BigInt::one(), 0) != Less {
            return Some(p2.rounded(prec));
        }
        let lo = li2(&Ball::exact(lm, le), wp)?;
        return Some(Ball::hull(&lo, &p2).rounded(prec));
    }
    let y = one.sub(x, wp);
    // Li2(1 - x) directly: w = -log(x), |w| <= log 4 for x >= 1/4
    let l2y = li2_from_w(&CBall::real(x.log(wp)?.neg()), wp).re;
    let prod = x.log(wp)?.mul(&y.log(wp)?, wp);
    Some(p2.sub(&prod, wp).sub(&l2y, wp).rounded(prec))
}

/// Ti2(y) = Im Li2(i y) = sum (-1)^k y^(2k+1) / (2k+1)^2, for y in [-1, 1]:
/// w = -log(1 - i y) = -log(1 + y^2)/2 + i atan(y), |w| <= 0.87.
pub fn ti2(y: &Ball, prec: u64) -> Option<Ball> {
    let wp = prec + 32;
    let one = Ball::one();
    // the whole ball in [-1, 1] (BALL-F9; Ti2 is odd)
    if !y.is_finite() {
        return None;
    }
    let (um, ue) = y.upper();
    let (lm, le) = y.lower();
    if crate::ball::cmp_dyadic(&um, ue, &BigInt::one(), 0) == std::cmp::Ordering::Greater || crate::ball::cmp_dyadic(&lm, le, &-BigInt::one(), 0) == std::cmp::Ordering::Less {
        return None;
    }
    let re = one.add(&y.sqr(wp), wp).log(wp)?.mul_2exp(-1).neg();
    let im = y.atan(wp);
    Some(li2_from_w(&CBall { re, im }, wp).im.rounded(prec))
}

/// The exponential integral E_1(x) = int_x^oo e^-t / t dt for a ball x > 0
/// (None unless certainly positive, or for x > 2^20):
///   E_1(x) = -gamma - log x + sum_(k>=1) (-1)^(k+1) x^k / (k k!).
/// Tail: with t_k = x^k / (k k!), t_(k+1)/t_k = x k/(k+1)^2 <= X/(k+1) <= 1/2
/// for k >= 2X (X >= x), so the terms after t_K (K >= 2X) sum to at most
/// 2 t_(K+1) <= t_K.  The terms reach about e^x while E_1(x) is about
/// e^-x / x: 3X + 64 more bits keep it relative.  The input radius adds
/// r sup |E_1'| = r e^-L / L, L the ball's lower end.
pub fn e1(x: &Ball, prec: u64) -> Option<Ball> {
    let prec = prec.min(crate::funcs::PREC_MAX);
    if !x.is_positive() {
        return None;
    }
    let xu = x.upper_abs();
    if !xu.le_pow2(20) {
        return None;
    }
    // X: an integer >= x
    let (um, ue) = x.upper();
    let xint: u64 = if ue >= 0 { num_traits::ToPrimitive::to_u64(&(um << ue as u64)).unwrap() } else { num_traits::ToPrimitive::to_u64(&((um >> (-ue) as u64) + 1u32)).unwrap() };
    let wp = prec + 3 * xint + 64;
    let (m, e) = x.mid();
    let mx = Ball::exact(m, e);
    let mut p = Ball::one(); // m^k / k!
    let mut s = Ball::zero();
    let goal = Mag::pow2(-(wp as i64));
    let mut k: u64 = 0;
    loop {
        k += 1;
        p = p.mul(&mx, wp).div_i64(k as i64, wp);
        let t = p.div_i64(k as i64, wp);
        s = if k % 2 == 1 { s.add(&t, wp) } else { s.sub(&t, wp) };
        if k >= 2 * xint {
            let tb = t.upper_abs();
            if tb <= goal {
                s = s.add_error(tb);
                break;
            }
        }
    }
    let v = euler_gamma(wp).neg().sub(&mx.log(wp)?, wp).add(&s, wp);
    if x.is_exact() {
        return Some(v.rounded(prec));
    }
    let (lm, le) = x.lower();
    let l = Ball::exact(lm, le);
    let d = l.neg().exp(64)?.div(&l, 64)?.upper_abs();
    Some(v.add_error(x.rad().mul(d)).rounded(prec))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bernoulli_numbers() {
        let b = bernoulli(12);
        let q = |n: i64, d: i64| BigRational::new(BigInt::from(n), BigInt::from(d));
        assert_eq!(b[1], q(-1, 2));
        assert_eq!(b[2], q(1, 6));
        assert_eq!(b[3], q(0, 1));
        assert_eq!(b[12], q(-691, 2730));
        assert!(b[11].is_zero());
    }
}
