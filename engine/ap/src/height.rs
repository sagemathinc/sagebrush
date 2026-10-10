//! Canonical heights of rational points on elliptic curves over Q, on balls
//! (sagebrush-ball): the systematic review's R2-EC-F3, whose index bound
//! used doubles with margins for the periods, Carlson's R_F, the theta
//! product and the heights.
//!
//! For P on the identity component of E(R) of the minimal model, with
//! f(x) = 4x^3 + b2 x^2 + 2 b4 x + b6 = 4 (x - e1)(x - e2)(x - e3):
//!   * periods by the AGM (Cremona's formulas, as lib/_sage_ec.py): for
//!     Delta > 0, w1 = pi / M(sqrt(e1 - e3), sqrt(e1 - e2)) and tau =
//!     i M1 / M2, M2 = M(sqrt(e1 - e3), sqrt(e2 - e3)); for Delta < 0, w1 =
//!     2 pi / M(2 sqrt B, sqrt(2B + A)) and tau = -1/2 + i pi / (w1
//!     M(2 sqrt B, sqrt(2B - A))), A = 3 e1 + b2/4, B = sqrt(3 e1^2 + b2 e1/2
//!     + b4/2).  In both cases q = e^(2 pi i tau) is real.  The AGM of
//!     positive reals lies between b_n and a_n from the first step on.
//!   * the elliptic logarithm z = R_F(x - e1, x - e2, x - e3) (Carlson): R_F
//!     is unchanged by the duplication x -> (x + l)/4 and decreasing in each
//!     argument, R_F(t, t, t) = 1/sqrt(t), so R_F lies between 1/sqrt(max)
//!     and 1/sqrt(min) of the current arguments; for the conjugate pair
//!     b +- ic of Delta < 0, s + b <= |s + y| <= s + |y| gives the same with
//!     (a, |y|) and (a, b), b > 0 after one duplication.
//!   * the archimedean Neron function at real z, u = e^(2 pi i z/w1) on the
//!     unit circle, theta = 2 pi z / w1:
//!       lambda = -log|q|/12 - log(2 - 2 cos theta)/2
//!                - sum_(n>=1) log(1 - 2 q^n cos theta + q^(2n)),
//!     the terms beyond K (|q|^(K+1) <= 1/2) at most 4 |q|^(K+1)/(1 - |q|) in
//!     all (|log(1 - 2c cos theta + c^2)| <= 2|c|/(1 - |c|) <= 4|c|).
//!   * hhat(P) = 2 (lambda + sum_p nu_p log p + log d + log|Delta|/12) / n^2
//!     with the finite local terms nu_p (exact rationals, from Python) for
//!     Q = n P on the identity component.

use num_traits::{One, Signed, Zero};
use sagebrush_ball::{pi, Ball, Mag};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

type R = Result<Ball, String>;

fn bi(x: i64) -> BigInt {
    BigInt::from(x)
}

/// sign of f at x = m / 2^k, f = c0 + c1 x + c2 x^2 + c3 x^3 (integers),
/// exactly: f(x) 2^(3k) = c0 8^k + c1 m 4^k + c2 m^2 2^k + c3 m^3.
fn sign_at(c: &[BigInt; 4], m: &BigInt, k: u64) -> i32 {
    let v = (&c[0] << (3 * k)) + ((&c[1] * m) << (2 * k)) + ((&c[2] * m * m) << k) + &c[3] * m * m * m;
    if v.is_zero() {
        0
    } else if v.is_positive() {
        1
    } else {
        -1
    }
}

/// A root of f in [lo, hi] 2^-k (a sign change at the ends), refined by
/// bisection to width 2^-bits: the ball [lo, hi].
fn refine(c: &[BigInt; 4], mut lo: BigInt, mut hi: BigInt, mut k: u64, bits: u64) -> Option<Ball> {
    let (sl, sh) = (sign_at(c, &lo, k), sign_at(c, &hi, k));
    if sl == 0 {
        return Some(Ball::exact(lo, -(k as i64)));
    }
    if sh == 0 {
        return Some(Ball::exact(hi, -(k as i64)));
    }
    if sl == sh {
        return None;
    }
    // until the width (hi - lo) 2^-k is at most 2^-bits
    while ((&hi - &lo).bits() as i64) - (k as i64) > -(bits as i64) {
        // the midpoint at one more bit
        lo <<= 1u32;
        hi <<= 1u32;
        k += 1;
        let mid: BigInt = (&lo + &hi) >> 1u32;
        let s = sign_at(c, &mid, k);
        if s == 0 {
            return Some(Ball::exact(mid, -(k as i64)));
        }
        if s == sl {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let lb = Ball::exact(lo, -(k as i64));
    let hb = Ball::exact(hi, -(k as i64));
    Some(Ball::hull(&lb, &hb))
}

/// The roots near the approximations (num 2^-k), each enclosed by a sign
/// change within 2^-(k/2) (refused if the enclosures are not disjoint).
fn real_roots(c: &[BigInt; 4], approx: &[(BigInt, u64)], bits: u64) -> Option<Vec<Ball>> {
    let mut out: Vec<Ball> = vec![];
    for (m, k) in approx {
        let mut found = None;
        for back in [(*k / 2).max(8), 8, 2] {
            let d = BigInt::one() << (*k - back.min(*k));
            if let Some(b) = refine(c, m - &d, m + &d, *k, bits) {
                found = Some(b);
                break;
            }
        }
        let b = found?;
        if out.iter().any(|o| o.overlaps(&b)) {
            return None;
        }
        out.push(b);
    }
    Some(out)
}

/// M(a, b) for balls a, b > 0: between b_n and a_n.
/// (Stops once the enclosure has goal bits; prec is the working precision.)
fn agm(a: &Ball, b: &Ball, prec: u64, goal: i64) -> Option<Ball> {
    if !a.is_positive() || !b.is_positive() {
        return None;
    }
    let (mut a, mut b) = (a.clone(), b.clone());
    for _ in 0..200 {
        let a2 = a.add(&b, prec).mul_2exp(-1);
        let b2 = a.mul(&b, prec).sqrt(prec)?;
        a = a2;
        b = b2;
        let h = Ball::hull(&a, &b);
        if h.rel_accuracy_bits() >= goal {
            return Some(h);
        }
    }
    Some(Ball::hull(&a, &b))
}

/// R_F(x, y, z) for balls x, y, z > 0, by duplication between 1/sqrt(max)
/// and 1/sqrt(min).
fn carlson_rf(x: &Ball, y: &Ball, z: &Ball, prec: u64, goal: i64) -> Option<Ball> {
    let (mut x, mut y, mut z) = (x.clone(), y.clone(), z.clone());
    let mut best = None;
    // (the spread shrinks by 4 at each step)
    for _ in 0..prec + 64 {
        if !x.is_positive() || !y.is_positive() || !z.is_positive() {
            return None;
        }
        let (sx, sy, sz) = (x.sqrt(prec)?, y.sqrt(prec)?, z.sqrt(prec)?);
        let l = sx.mul(&sy.add(&sz, prec), prec).add(&sy.mul(&sz, prec), prec);
        x = x.add(&l, prec).mul_2exp(-2);
        y = y.add(&l, prec).mul_2exp(-2);
        z = z.add(&l, prec).mul_2exp(-2);
        let lo = Ball::hull(&Ball::hull(&x, &y), &z); // contains all three
        let (um, ue) = lo.upper();
        let (lm, le) = lo.lower();
        let (umax, lmin) = (Ball::exact(um, ue), Ball::exact(lm, le));
        if !lmin.is_positive() {
            continue;
        }
        let a = umax.sqrt(prec)?.recip(prec)?;
        let b = lmin.sqrt(prec)?.recip(prec)?;
        let h = Ball::hull(&a, &b);
        if h.rel_accuracy_bits() >= goal {
            return Some(h);
        }
        if stalled(&mut best, h) {
            return best.map(|b| b.1);
        }
    }
    best.map(|b| b.1)
}

/// Keeps the most accurate enclosure (each one is valid); true once twelve
/// steps have not improved it (the arguments' own radii limit it).
fn stalled(best: &mut Option<(u32, Ball)>, h: Ball) -> bool {
    match best {
        Some((n, b)) if h.rel_accuracy_bits() <= b.rel_accuracy_bits() => {
            *n += 1;
            *n >= 12
        }
        _ => {
            *best = Some((0, h));
            false
        }
    }
}

/// R_F(a, b + ic, b - ic) (real) for a > 0, c != 0: duplication with the
/// conjugate pair kept as (b, c).
fn carlson_rf_conj(a: &Ball, b: &Ball, c: &Ball, prec: u64, goal: i64) -> Option<Ball> {
    let (mut a, mut b, mut c) = (a.clone(), b.clone(), c.clone());
    let mut best = None;
    for step in 0..prec + 64 {
        if !a.is_positive() {
            return None;
        }
        // |y|, sqrt(a), Re sqrt(y) = sqrt((|y| + b)/2)
        let ay = b.sqr(prec).add(&c.sqr(prec), prec).sqrt(prec)?;
        let sa = a.sqrt(prec)?;
        let rey = ay.add(&b, prec).mul_2exp(-1).sqrt(prec)?;
        let l = sa.mul(&rey.mul_2exp(1), prec).add(&ay, prec);
        a = a.add(&l, prec).mul_2exp(-2);
        b = b.add(&l, prec).mul_2exp(-2);
        c = c.mul_2exp(-2);
        if step == 0 || !b.is_positive() {
            continue;
        }
        // between R_F(a, |y|, |y|) and R_F(a, b, b): 1/sqrt(max(a, |y|)) and 1/sqrt(min(a, b))
        let ay = b.sqr(prec).add(&c.sqr(prec), prec).sqrt(prec)?;
        let hi_args = Ball::hull(&a, &ay);
        let lo_args = Ball::hull(&a, &b);
        let (um, ue) = hi_args.upper();
        let (lm, le) = lo_args.lower();
        let (umax, lmin) = (Ball::exact(um, ue), Ball::exact(lm, le));
        if !lmin.is_positive() {
            continue;
        }
        let h = Ball::hull(&umax.sqrt(prec)?.recip(prec)?, &lmin.sqrt(prec)?.recip(prec)?);
        // (an enclosure good enough at once is returned itself: best was
        // still None there, the review's ECBALL-F2)
        if h.rel_accuracy_bits() >= goal {
            return Some(h);
        }
        if stalled(&mut best, h) {
            return best.map(|b| b.1);
        }
    }
    best.map(|b| b.1)
}

/// The canonical height (Sage's normalization) of P, given Q = nP (n = 1
/// or 2) on the identity component as x(Q) = xn/xd, the finite local terms
/// [(p, nu_p as num/den)] and d of Q, and approximations to the real roots
/// of f (num 2^-k: three if Delta > 0, the real one if Delta < 0).
#[allow(clippy::too_many_arguments)]
pub fn canonical_height(a: &[BigInt], xn: &BigInt, xd: &BigInt, n: u32, local: &[(BigInt, BigInt, BigInt)], d: &BigInt, roots: &[(BigInt, u64)], prec: u64) -> R {
    if a.len() != 5 || xd.is_zero() || d.is_zero() {
        return Err("canonical_height: bad arguments".into());
    }
    // (Q = P or 2P; another n was cast and squared in u32, the review's
    // ECBALL-F5)
    if n != 1 && n != 2 {
        return Err("canonical_height: n must be 1 or 2".into());
    }
    let wp = prec + 64;
    let goal = prec as i64 + 32;
    let (a1, a2, a3, a4, a6) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    let b2 = a1 * a1 + a2 * bi(4);
    let b4 = a4 * bi(2) + a1 * a3;
    let b6 = a3 * a3 + a6 * bi(4);
    let b8 = a1 * a1 * a6 + a2 * a6 * bi(4) - a1 * a3 * a4 + a2 * a3 * a3 - a4 * a4;
    let disc = -(&b2 * &b2 * &b8) - &b4 * &b4 * &b4 * bi(8) - &b6 * &b6 * bi(27) + &b2 * &b4 * &b6 * bi(9);
    if disc.is_zero() {
        return Err("singular curve".into());
    }
    let c = [b6.clone(), &b4 * bi(2), b2.clone(), bi(4)];
    let x = Ball::from_rational(xn, xd, wp);
    let pib = pi(wp);
    let b = |v: &BigInt| Ball::from_int(v);
    let (w1, logq_neg, q, z) = if disc.is_positive() {
        if roots.len() != 3 {
            return Err("three real roots expected".into());
        }
        let mut r = real_roots(&c, roots, wp).ok_or("the real roots could not be enclosed")?;
        r.sort_by(|u, v| v.cmp(u).unwrap_or(Ordering::Equal));
        let (e1, e2, e3) = (&r[0], &r[1], &r[2]);
        if e1.cmp(e2) != Some(Ordering::Greater) || e2.cmp(e3) != Some(Ordering::Greater) {
            return Err("the real roots are not separated".into());
        }
        let s13 = e1.sub(e3, wp).sqrt(wp).ok_or("sqrt")?;
        let m1 = agm(&s13, &e1.sub(e2, wp).sqrt(wp).ok_or("sqrt")?, wp, goal).ok_or("agm")?;
        let m2 = agm(&s13, &e2.sub(e3, wp).sqrt(wp).ok_or("sqrt")?, wp, goal).ok_or("agm")?;
        let w1 = pib.div(&m1, wp).ok_or("w1")?;
        // tau = i M1/M2: -log|q| = 2 pi M1/M2
        let t = pib.mul_2exp(1).mul(&m1, wp).div(&m2, wp).ok_or("tau")?;
        let q = t.neg().exp(wp).ok_or("q")?;
        let (d1, d2, d3) = (x.sub(e1, wp), x.sub(e2, wp), x.sub(e3, wp));
        if !d1.is_positive() {
            return Err("the point is not on the identity component".into());
        }
        let z = carlson_rf(&d1, &d2, &d3, wp, goal).ok_or("R_F")?;
        (w1, t, q, z)
    } else {
        if roots.is_empty() {
            return Err("the real root expected".into());
        }
        let r = real_roots(&c, &roots[..1], wp).ok_or("the real root could not be enclosed")?;
        let e1 = &r[0];
        // A = 3 e1 + b2/4, B = sqrt(3 e1^2 + b2 e1/2 + b4/2)
        let aa = e1.mul_i64(3, wp).add(&b(&b2).mul_2exp(-2), wp);
        let bb = e1.sqr(wp).mul_i64(3, wp).add(&b(&b2).mul(e1, wp).mul_2exp(-1), wp).add(&b(&b4).mul_2exp(-1), wp).sqrt(wp).ok_or("B")?;
        let two_sb = bb.sqrt(wp).ok_or("sqrt B")?.mul_2exp(1);
        let m1 = agm(&two_sb, &bb.mul_2exp(1).add(&aa, wp).sqrt(wp).ok_or("sqrt(2B + A)")?, wp, goal).ok_or("agm")?;
        let m2 = agm(&two_sb, &bb.mul_2exp(1).sub(&aa, wp).sqrt(wp).ok_or("sqrt(2B - A)")?, wp, goal).ok_or("agm")?;
        let w1 = pib.mul_2exp(1).div(&m1, wp).ok_or("w1")?;
        // Im tau = pi / (w1 M2), q = -e^(-2 pi Im tau)
        let im = pib.div(&w1.mul(&m2, wp), wp).ok_or("tau")?;
        let t = pib.mul_2exp(1).mul(&im, wp);
        let q = t.neg().exp(wp).ok_or("q")?.neg();
        // the conjugate pair U +- iV: U = -(b2/4 + e1)/2, U^2 + V^2 = b4/2 - 2 U e1
        let u = b(&b2).mul_2exp(-2).add(e1, wp).mul_2exp(-1).neg();
        let v2 = b(&b4).mul_2exp(-1).sub(&u.mul(e1, wp).mul_2exp(1), wp).sub(&u.sqr(wp), wp);
        let v = v2.sqrt(wp).ok_or("V")?;
        let d1 = x.sub(e1, wp);
        if !d1.is_positive() {
            return Err("the point is not on the identity component".into());
        }
        let z = carlson_rf_conj(&d1, &x.sub(&u, wp), &v, wp, goal).ok_or("R_F")?;
        (w1, t, q, z)
    };
    // theta = 2 pi z / w1, lambda
    let theta = pib.mul_2exp(1).mul(&z, wp).div(&w1, wp).ok_or("theta")?;
    let ct = theta.cos(wp).ok_or("cos")?;
    // log(2 - 2 cos theta)/2 = log|2 sin(theta/2)|: no cancellation for the
    // small theta of points near O (x = 2^200 lost every bit to 1 - cos)
    let s2 = theta.mul_2exp(-1).sin(wp).ok_or("sin")?.mul_2exp(1).abs();
    let mut lam = logq_neg.div_i64(12, wp).sub(&s2.log(wp).ok_or("log |2 sin(theta/2)|")?, wp);
    let qa = q.upper_abs();
    if !qa.le_pow2(0) || qa == Mag::from_u64(1) {
        return Err("|q| not below 1".into());
    }
    let mut qn = Ball::one();
    let mut closed = false;
    for _ in 0..100000 {
        qn = qn.mul(&q, wp);
        let t = Ball::one().sub(&qn.mul(&ct, wp).mul_2exp(1), wp).add(&qn.sqr(wp), wp);
        lam = lam.sub(&t.log(wp).ok_or("log of a product term")?, wp);
        // the rest: 4 |q|^(K+1) / (1 - |q|), once |q|^(K+1) <= 1/2
        let next = qn.mul(&q, wp).upper_abs();
        if next.le_pow2(-1) {
            // 1 - |q| from below (|q|'s upper bound), the tail 4 |q|^(K+1)/(1 - |q|)
            let (qm, qe) = qa.to_dyadic().ok_or("q")?;
            let omq = Ball::one().sub(&Ball::exact(qm, qe), wp);
            if !omq.is_positive() {
                return Err("|q| too close to 1".into());
            }
            let tail = next.mul_u64(4).div(omq.lower_abs());
            if tail.le_pow2(-(prec as i64) - 8) {
                lam = lam.add_error(tail);
                closed = true;
                break;
            }
        }
    }
    if !closed {
        return Err("the theta product did not converge".into());
    }
    // the finite part and log|Delta|/12
    let mut fin = Ball::from_int(d).log(wp).ok_or("log d")?;
    for (p, num, den) in local {
        let lp = Ball::from_int(p).log(wp).ok_or("log p")?;
        fin = fin.add(&lp.mul(&Ball::from_rational(num, den, wp), wp), wp);
    }
    let ld = Ball::from_int(&disc.abs()).log(wp).ok_or("log Delta")?.div_i64(12, wp);
    let h = lam.add(&fin, wp).add(&ld, wp);
    Ok(h.mul_2exp(1).div_i64((n * n) as i64, wp).rounded(prec))
}

/// log(num/den) on balls (num, den > 0), for the bounds that use the heights.
pub fn log_rational(num: &BigInt, den: &BigInt, prec: u64) -> R {
    if !num.is_positive() || !den.is_positive() {
        return Err("log of a nonpositive number".into());
    }
    let wp = prec + 32;
    Ok(Ball::from_rational(num, den, wp).log(wp).ok_or("log")?.rounded(prec))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(v: i64) -> BigInt {
        BigInt::from(v)
    }

    /// the first 300 digits of Sage's value (precision=1100): the ball must
    /// hold the interval they fix and be accurate to prec bits
    fn check(a: [i64; 5], x: (i64, i64), n: u32, roots: &[(i64, u64)], digits: &str) {
        let a: Vec<BigInt> = a.iter().map(|&c| b(c)).collect();
        let roots: Vec<(BigInt, u64)> = roots.iter().map(|&(m, k)| (b(m), k)).collect();
        let d: BigInt = digits[2..302].parse().unwrap();
        let ten = BigInt::from(10u32).pow(300);
        let v = Ball::hull(&Ball::from_rational(&d, &ten, 1100), &Ball::from_rational(&(&d + 1), &ten, 1100));
        for prec in [64u64, 128, 360, 960] {
            let h = canonical_height(&a, &b(x.0), &b(x.1), n, &[], &b(1), &roots, prec).unwrap();
            assert!(h.overlaps(&v), "prec {}", prec);
            assert!(h.rel_accuracy_bits() >= prec as i64 - 2, "prec {}: {} bits", prec, h.rel_accuracy_bits());
        }
        // and a perturbed point or curve is excluded
        let h = canonical_height(&a, &(b(x.0) * 1000 + 1), &(b(x.1) * 1000), n, &[], &b(1), &roots, 128).unwrap();
        assert!(!h.overlaps(&v));
    }

    #[test]
    fn h37a1() {
        // Delta > 0: 2(0, 0) = (1, 0) on the identity component
        check([0, 0, 1, -1, 0], (1, 1), 2, &[(214, 8), (69, 8), (-283, 8)],
              "0.051111408239968840235886099756942021609538202280852964249242761521097051665601926126276280166145013158726830156913137573334269246681032033729207105827808354657697707754400846063961271799785384195067958219171703749396335964971856198526631071933948077485035042161680651850981303262357857058989986259842781270362217500446978");
    }

    #[test]
    fn h43a1() {
        // Delta < 0: (0, 0) on 43a1, the real root near -1.148
        check([0, 1, 1, 0, 0], (0, 1), 1, &[(-294, 8)],
              "0.062816507087487649265708791466968686318992037272510316529977909805136586214606513409377967749397813648320089583183955140533404202950116015455755375568264261400844892027743539093306809816348637207962096338235627897701158077256074947928946050229490526054092786828251007958855261472361928985632918022952988323840552127094117");
    }

    #[test]
    fn accurate_at_once() {
        // ECBALL-F2: P = (2^200, 2^300) on y^2 = x^3 - x + 2^200: x - e_i are
        // nearly equal, so the first R_F bound already meets the goal
        let t = BigInt::one() << 200u32;
        let a = [b(0), b(0), b(0), b(-1), t.clone()];
        // the real root near -2^(200/3) of f = 4x^3 - 4x + 4 2^200, to an
        // integer by bisection
        let c = [&t * 4, b(-4), b(0), b(4)];
        let (mut lo, mut hi) = (-(BigInt::one() << 68u32), b(0));
        while &hi - &lo > b(1) {
            let mid: BigInt = (&lo + &hi) / 2;
            if sign_at(&c, &mid, 0) < 0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let roots = [(lo, 0)];
        for prec in [32u64, 64, 128] {
            let h = canonical_height(&a, &t, &b(1), 1, &[], &b(1), &roots, prec);
            assert!(h.is_ok(), "prec {}: {:?}", prec, h);
        }
    }

    #[test]
    fn bad_input() {
        let a = [b(0), b(0), b(1), b(-1), b(0)];
        // n other than 1 and 2
        for n in [0u32, 3, 65537] {
            assert!(canonical_height(&a, &b(1), &b(1), n, &[], &b(1), &[(b(214), 8), (b(69), 8), (b(-283), 8)], 64).is_err());
        }
        // the wrong number of roots, a root approximation with no root near it
        assert!(canonical_height(&a, &b(1), &b(1), 2, &[], &b(1), &[(b(214), 8)], 64).is_err());
        assert!(canonical_height(&a, &b(1), &b(1), 2, &[], &b(1), &[(b(214), 8), (b(69), 8), (b(-200), 8)], 64).is_err());
        // (0, 0) itself is off the identity component
        assert!(canonical_height(&a, &b(0), &b(1), 1, &[], &b(1), &[(b(214), 8), (b(69), 8), (b(-283), 8)], 64).is_err());
    }
}
