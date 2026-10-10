//! The certificate for bnfinit's class group and regulator under GRH alone.
//!
//! Buchmann's algorithm finds h* and R*, integer multiples of h and R, and
//! stops when h* R* < 2 h R: then both are exact.  That needs a proven lower
//! bound for h R, and R* with a proven upper bound, h* a proven multiple of
//! h.  Before the fifth review's closing item, bnfinit compared h* R* with
//! Bach's estimate of h R (no error bound) and R* from a numerically
//! identified unit lattice.  Here:
//!   * log h R from Belabas and Friedman, "Computing the residue of the
//!     Dedekind zeta function" (Math. Comp. 84, 2015; arXiv:1305.0035),
//!     Theorem 1: under GRH, |log kappa_K - f_K(X)| is at most an explicit
//!     E(X), with f_K(X) from the prime ideals of norm < X;
//!   * the units: integer combinations of the relation elements (genuine
//!     units, checked exactly), their logarithms with certified error bounds
//!     (embed.rs log_embedding_err, carried through the elimination); a
//!     basis b = T lambda with T integral, so b spans a sublattice of the
//!     unit lattice whatever the numerical identification did, and |det b|
//!     bounded by the exact determinant of the fixed-point b plus Hadamard's
//!     bound on the perturbation;
//!   * h* from determinants computed exactly (imag.rs lattice_group_exact).

use super::zlin::{hnf, inverse, vec_mat, QMat, ZMat};
use sagebrush_bigint::BigRational;
use crate::real::to_f64;
use sagebrush_bigint::BigInt;
use num_traits::{One, Signed, Zero};

/// log x for a positive integer of any size.
pub fn ln_big(x: &BigInt) -> f64 {
    let b = x.bits() as i64;
    let s = (b - 60).max(0) as usize;
    to_f64(&(x >> s), 0).ln() + s as f64 * std::f64::consts::LN_2
}

/// Belabas and Friedman's bound E(X) on |log kappa_K - f_K(X)| (Theorem 1:
/// GRH, n > 1, X >= 69), for log Delta_K = ld.
pub fn bf_error(x: f64, n: usize, ld: f64) -> f64 {
    let a = (1.0 + 3.88 / (x / 9.0).ln()) * (1.0 + 2.0 / ld.sqrt()).powi(2);
    let b = 4.26 * (n as f64 - 1.0) / (x.sqrt() * ld);
    2.324 * ld / (x.sqrt() * (3.0 * x).ln()) * (a + b)
}

/// The X to use: E(X) <= 0.1 if X <= 9 2^17 gives it, else at most 0.25
/// (anything below log(2)/2 can certify), None if out of reach.
pub fn choose_x(n: usize, ld: f64) -> Option<u64> {
    let mut x = 9u64 << 7;
    loop {
        let e = bf_error(x as f64, n, ld);
        if e <= 0.1 {
            return Some(x);
        }
        if x >= 9 << 17 {
            return (e <= 0.25).then_some(x);
        }
        x *= 2;
    }
}

/// B_K(Y) (a sum over prime ideal powers of norm < Y, minus the same over
/// the rational primes) and the sum of the absolute values of its terms.
/// y is an integer; `split` lists every rational prime below it.
fn b_k(split: &[(u64, Vec<(u32, u32)>)], y: u64) -> (f64, f64, usize) {
    let yf = y as f64;
    let sy = yf.sqrt() * yf.ln();
    let (mut sum, mut abs, mut count) = (0.0f64, 0.0f64, 0usize);
    let mut add = |q: u128, ln_n: f64, m: u32, sign: f64| {
        let qf = q as f64;
        let t = ln_n / qf.sqrt() * (sy / (qf.sqrt() * m as f64 * ln_n) - 1.0);
        sum += sign * t;
        abs += t.abs();
        count += 1;
    };
    for (p, degs) in split {
        if *p >= y {
            break;
        }
        let lp = (*p as f64).ln();
        let powers = |f: u32| -> Vec<(u128, u32)> {
            let mut out = vec![];
            let mut m = 1u32;
            while let Some(q) = (*p as u128).checked_pow(f * m) {
                if q >= y as u128 {
                    break;
                }
                out.push((q, m));
                m += 1;
            }
            out
        };
        for &(f, _) in degs {
            for (q, m) in powers(f) {
                add(q, f as f64 * lp, m, 1.0);
            }
        }
        for (q, m) in powers(1) {
            add(q, lp, m, -1.0);
        }
    }
    (sum, abs, count)
}

/// A lower bound for log(h R) under GRH: Theorem 1 at X (a multiple of 9,
/// `split` covering every prime below X), w a lower bound for the number of
/// roots of unity (those found, verified exactly), ld = log Delta_K.
/// Floating-point error is bounded generously: each term to a few units in
/// the last place relatively, the sums by their length times that.
pub fn log_hr_lower(split: &[(u64, Vec<(u32, u32)>)], x: u64, n: usize, r1: usize, r2: usize, w: u32, ld: f64) -> f64 {
    assert!(n > 1 && x >= 69 && x % 9 == 0);
    let (b1, a1, c1) = b_k(split, x);
    let (b2, a2, c2) = b_k(split, x / 9);
    let xf = x as f64;
    let scale = 3.0 / (2.0 * xf.sqrt() * (3.0 * xf).ln());
    let f = scale * (b1 - b2);
    let float_err = scale * ((c1 + 20) as f64 * a1 + (c2 + 20) as f64 * a2) * 4.5e-16 + 1e-12 * f.abs();
    let e = bf_error(xf, n, ld) * (1.0 + 1e-9);
    // h R = kappa w sqrt(Delta) / (2^r1 (2 pi)^r2)
    let rest = (w as f64).ln() + ld / 2.0 - r1 as f64 * std::f64::consts::LN_2 - r2 as f64 * (2.0 * std::f64::consts::PI).ln();
    f - e - float_err + rest - 1e-9 * (1.0 + rest.abs())
}

/// Bounds for the covolume of a full sublattice of the unit lattice: the
/// vectors `lams` (first r coordinates of unit logarithms, fixed point to
/// `prec` bits, each coordinate within errs[k] units of the truth) and a
/// basis `basis` (same scale) of the lattice they appear to span.  Each
/// lambda's coordinates in that basis are rounded to integers C; the HNF
/// of [C | I] gives integer T with T C of full rank, and b = T lambda (true
/// units, whatever C was).  Then |det b| is within Hadamard's bound of the
/// exact determinant of the fixed-point b.  Returns (lower, upper, |det|
/// of the fixed-point b scaled by 2^(prec r), a bound on its relative
/// error) or None (rank deficient, or too imprecise: Err(true), which more
/// precision may cure).
pub fn regulator_bounds(lams: &[Vec<BigInt>], errs: &[f64], basis: &ZMat, prec: u32) -> Result<(f64, f64, BigInt, f64), bool> {
    let r = basis.len();
    let m = lams.len();
    if r == 0 || m < r {
        return Err(false);
    }
    // coordinates in the basis: f64 when they come out near integers, else
    // exactly (an ill-conditioned basis gives f64 coordinates off by whole
    // units); a wrong C only makes b span less, never a wrong bound
    let inv = super::bnf::inverse_f64(basis, prec);
    let mut exact_inv: Option<QMat> = None;
    // (f64 coordinates off by an integer vector leave a residual that is a
    // nonzero lattice vector, far above 2^(-prec/2))
    let tol = BigInt::one() << (prec / 2) as usize;
    let close = |v: &[BigInt], c: &[BigInt]| (0..r).all(|j| (&v[j] - c.iter().zip(basis).map(|(ci, row)| ci * &row[j]).sum::<BigInt>()).abs() <= tol);
    let coords: Vec<Vec<BigInt>> = lams.iter().map(|v| {
        if let Some(inv) = &inv {
            let vf: Vec<f64> = v.iter().map(|x| to_f64(x, prec)).collect();
            let cf: Vec<f64> = (0..r).map(|j| (0..r).map(|i| vf[i] * inv[i][j]).sum()).collect();
            if cf.iter().all(|c| c.is_finite() && c.abs() < 1e15) {
                let c: Vec<BigInt> = cf.iter().map(|c| BigInt::from(c.round() as i64)).collect();
                if close(v, &c) {
                    return c;
                }
            }
        }
        let qi = exact_inv.get_or_insert_with(|| inverse(&basis.iter().map(|row| row.iter().map(|x| BigRational::from_integer(x.clone())).collect()).collect::<QMat>()));
        let vq: Vec<BigRational> = v.iter().map(|x| BigRational::from_integer(x.clone())).collect();
        vec_mat(&vq, qi).iter().map(|q| q.round().to_integer()).collect()
    }).collect();
    let rows: ZMat = coords.iter().enumerate().map(|(k, c)| c.iter().cloned().chain((0..m).map(|j| BigInt::from((j == k) as i32))).collect()).collect();
    let t: Vec<Vec<BigInt>> = hnf(&rows).into_iter().filter(|row| row[..r].iter().any(|x| !x.is_zero())).map(|row| row[r..].to_vec()).collect();
    if t.len() != r {
        return Err(false);
    }
    // b = T lambda and the error bounds of its rows
    let b: ZMat = t.iter().map(|ti| (0..r).map(|j| ti.iter().zip(lams).filter(|(c, _)| !c.is_zero()).map(|(c, l)| c * &l[j]).sum()).collect()).collect();
    let e: Vec<f64> = t.iter().map(|ti| ti.iter().zip(errs).filter(|(c, _)| !c.is_zero()).map(|(c, &er)| to_f64(&c.abs(), 0) * (1.0 + 1e-15) * er).sum::<f64>() * (1.0 + 1e-12)).collect();
    let d = crate::linalg::det(&b).abs();
    // |det(b + E) - det b| <= prod (|b_i| + |E_i|) - prod |b_i|
    //                     <= prod |b_i| (exp(S) - 1) <= prod |b_i| S exp(S),
    // S = sum |E_i| / |b_i|, |E_i| <= sqrt(r) e_i 2^-prec
    let norms: Vec<f64> = b.iter().map(|row| row.iter().map(|x| to_f64(x, prec).powi(2)).sum::<f64>().sqrt() * (1.0 + 1e-14)).collect();
    if !norms.iter().all(|x| x.is_finite() && *x > 0.0) {
        return Err(false);
    }
    if !e.iter().all(|x| x.is_finite()) {
        return Err(true);
    }
    let s: f64 = e.iter().zip(&norms).map(|(&ei, &ni)| {
        let l = ((r as f64).sqrt() * ei.max(1.0)).log2() - prec as f64 - ni.log2();
        2f64.powf(l.max(-1000.0)) * (1.0 + 1e-12)
    }).sum();
    if s > 1e-3 {
        return Err(true);
    }
    let log_prod: f64 = norms.iter().map(|x| x.ln()).sum::<f64>();
    let log_prod = log_prod + 1e-14 * (1.0 + log_prod.abs());
    let pert = s * s.exp() * log_prod.exp() * (1.0 + 1e-12);
    let df = to_f64(&d, prec * r as u32);
    let (lo, hi) = (df * (1.0 - 1e-14) - pert, df * (1.0 + 1e-14) + pert);
    if !hi.is_finite() {
        return Err(false);
    }
    if lo <= 0.0 {
        // rank deficient, or the perturbation swamps the determinant
        return Err(pert >= df * 1e-3);
    }
    // the relative error: the perturbation over |det|, and the last unit
    let rel = (pert / df.max(f64::MIN_POSITIVE)) * (1.0 + 1e-9) + 2f64.powf(-(prec as f64) * 0.9);
    Ok((lo, hi, d, rel))
}

/// The splitting of the primes below x in the quadratic field of
/// discriminant d, from the Kronecker symbol: split, inert or ramified.
pub fn quadratic_split(d: &BigInt, x: u64) -> Vec<(u64, Vec<(u32, u32)>)> {
    let d8 = crate::arith::bigmod(d, 8);
    crate::arith::primes_up_to(x).into_iter().map(|p| {
        let degs = match crate::arith::kronecker_res(d8, crate::arith::bigmod(d, p), p) {
            1 => vec![(1, 1), (1, 1)],
            -1 => vec![(2, 1)],
            _ => vec![(1, 2)],
        };
        (p, degs)
    }).collect()
}

// ------------------------------------------------------------------ on balls
//
// The same bound with sagebrush-ball: every logarithm, square root and the
// sums enclosed, Theorem 1's E(X) evaluated as a ball (no floating-point
// margins: the systematic review's R2-CLG-F2).

use sagebrush_ball::{pi, Ball};

/// B_K(Y) on balls.
fn b_k_ball(split: &[(u64, Vec<(u32, u32)>)], y: u64, prec: u64) -> Option<Ball> {
    let yb = Ball::from_i64(y as i64);
    let sy = yb.sqrt(prec)?.mul(&yb.log(prec)?, prec);
    let mut sum = Ball::zero();
    let mut sq_cache: std::collections::HashMap<u128, Ball> = std::collections::HashMap::new();
    for (p, degs) in split {
        if *p >= y {
            break;
        }
        let lp = Ball::from_i64(*p as i64).log(prec)?;
        let powers = |f: u32| -> Vec<(u128, u32)> {
            let mut out = vec![];
            let mut m = 1u32;
            while let Some(q) = (*p as u128).checked_pow(f * m) {
                if q >= y as u128 {
                    break;
                }
                out.push((q, m));
                m += 1;
            }
            out
        };
        let mut add = |q: u128, ln_n: &Ball, m: u32, sign: i64| -> Option<()> {
            let sq = match sq_cache.get(&q) {
                Some(b) => b.clone(),
                None => {
                    let b = Ball::from_int(&BigInt::from(q)).sqrt(prec)?;
                    sq_cache.insert(q, b.clone());
                    b
                }
            };
            // ln_n / sqrt(q) (sy / (sqrt(q) m ln_n) - 1)
            let inner = sy.div(&sq.mul(ln_n, prec).mul_i64(m as i64, prec), prec)?.sub(&Ball::one(), prec);
            let t = ln_n.div(&sq, prec)?.mul(&inner, prec);
            sum = sum.add(&t.mul_i64(sign, prec), prec);
            Some(())
        };
        for &(f, _) in degs {
            let ln_n = lp.mul_i64(f as i64, prec);
            for (q, m) in powers(f) {
                add(q, &ln_n, m, 1)?;
            }
        }
        for (q, m) in powers(1) {
            add(q, &lp, m, -1)?;
        }
    }
    Some(sum)
}

/// E(X) of Theorem 1 as a ball (its constants are the paper's, exact
/// decimals here).
fn bf_error_ball(x: u64, n: usize, ld: &Ball, prec: u64) -> Option<Ball> {
    let q = |a: i64, b: i64| Ball::from_rational(&BigInt::from(a), &BigInt::from(b), prec);
    let xb = Ball::from_i64(x as i64);
    let sx = xb.sqrt(prec)?;
    let one = Ball::one();
    let a = one.add(&q(388, 100).div(&q(x as i64, 9).log(prec)?, prec)?, prec)
        .mul(&one.add(&Ball::from_i64(2).div(&ld.sqrt(prec)?, prec)?, prec).sqr(prec), prec);
    let b = q(426, 100).mul_i64(n as i64 - 1, prec).div(&sx.mul(ld, prec), prec)?;
    let lead = q(2324, 1000).mul(ld, prec).div(&sx.mul(&xb.mul_i64(3, prec).log(prec)?, prec), prec)?;
    Some(lead.mul(&a.add(&b, prec), prec))
}

/// A ball whose lower end is a proven lower bound for log h R under GRH
/// (Theorem 1 at X, as log_hr_lower), for the field of discriminant disc.
pub fn log_hr_lower_ball(split: &[(u64, Vec<(u32, u32)>)], x: u64, n: usize, r1: usize, r2: usize, w: u32, disc: &BigInt, prec: u64) -> Option<Ball> {
    assert!(n > 1 && x >= 69 && x % 9 == 0);
    let ld = Ball::from_int(&disc.abs()).log(prec)?;
    let b1 = b_k_ball(split, x, prec)?;
    let b2 = b_k_ball(split, x / 9, prec)?;
    let xb = Ball::from_i64(x as i64);
    let scale = Ball::from_i64(3).div(&xb.sqrt(prec)?.mul(&xb.mul_i64(3, prec).log(prec)?, prec).mul_2exp(1), prec)?;
    let f = scale.mul(&b1.sub(&b2, prec), prec);
    let e = bf_error_ball(x, n, &ld, prec)?;
    // h R = kappa w sqrt(Delta) / (2^r1 (2 pi)^r2)
    let two_pi_log = pi(prec).mul_2exp(1).log(prec)?;
    let rest = Ball::from_i64(w as i64).log(prec)?
        .add(&ld.mul_2exp(-1), prec)
        .sub(&sagebrush_ball::ln2(prec).mul_i64(r1 as i64, prec), prec)
        .sub(&two_pi_log.mul_i64(r2 as i64, prec), prec);
    // log kappa >= f - E: the ball f - E + rest has a lower end below it
    Some(f.sub(&e, prec).add(&rest, prec))
}

/// Whether h R_hi < 2 h R_lo is certain: log h + log R_hi < log 2 + log hR_lo,
/// h an integer, r_hi a ball whose upper end bounds the regulator, lo a ball
/// whose lower end bounds log h R.
pub fn below_twice_ball(h: &BigInt, r_hi: &Ball, lo: &Ball, prec: u64) -> bool {
    let (Some(lh), Some(lr)) = (Ball::from_int(h).log(prec), r_hi.log(prec)) else { return false };
    // the worst case of each: lo at its lower end, R and h at their upper
    let (lom, loe) = lo.lower();
    let (lru, lrue) = lr.upper();
    let d = sagebrush_ball::ln2(prec).add(&Ball::exact(lom, loe), prec).sub(&lh, prec).sub(&Ball::exact(lru, lrue), prec);
    d.is_positive()
}

/// quadratic_log_hr_lower on balls.
pub fn quadratic_log_hr_lower_ball(d: &BigInt, prec: u64) -> Option<Ball> {
    let ld = to_f64(&d.abs(), 0).ln();
    let x = choose_x(2, ld)?;
    let (r1, r2) = if d.is_positive() { (2, 0) } else { (0, 1) };
    log_hr_lower_ball(&quadratic_split(d, x), x, 2, r1, r2, 2, d, prec)
}

/// The lower bound for log h R of the quadratic field of discriminant d
/// (w = 2 is a lower bound for the number of roots of unity), or None if
/// Theorem 1 cannot make the error small enough.
pub fn quadratic_log_hr_lower(d: &BigInt) -> Option<f64> {
    let ld = to_f64(&d.abs(), 0).ln();
    let x = choose_x(2, ld)?;
    let (r1, r2) = if d.is_positive() { (2, 0) } else { (0, 1) };
    Some(log_hr_lower(&quadratic_split(d, x), x, 2, r1, r2, 2, ld))
}

/// Rank one: unit logarithms `lams` (fixed point, prec bits, within errs[k]
/// units) and an approximate generator g of the lattice they span.  The
/// rounded quotients q_k = lam_k / g give integers t with sum t_k q_k =
/// gcd, and b = sum t_k lam_k is the logarithm of a genuine unit (not a
/// root of unity: |b| exceeds its error).  Returns (|b| - e, |b| + e, b)
/// in units of 2^-prec, as for regulator_bounds (Err(true): imprecise).
pub fn rank_one_bounds(lams: &[BigInt], errs: &[f64], g: &BigInt) -> Result<(BigInt, BigInt, BigInt), bool> {
    use num_integer::Integer;
    if g.is_zero() {
        return Err(false);
    }
    let half = g.abs() >> 1usize;
    let mut acc_g = BigInt::zero();
    let mut t: Vec<BigInt> = vec![BigInt::zero(); lams.len()];
    for (k, l) in lams.iter().enumerate() {
        let q = (l + &half).div_floor(g);
        if q.is_zero() {
            continue;
        }
        if acc_g.is_zero() {
            acc_g = q;
            t[k] = BigInt::one();
            continue;
        }
        let e = acc_g.extended_gcd(&q);
        for tj in t.iter_mut() {
            *tj *= &e.x;
        }
        t[k] = e.y;
        acc_g = e.gcd;
    }
    if acc_g.is_zero() {
        return Err(false);
    }
    let b: BigInt = t.iter().zip(lams).filter(|(c, _)| !c.is_zero()).map(|(c, l)| c * l).sum();
    let e: f64 = t.iter().zip(errs).filter(|(c, _)| !c.is_zero()).map(|(c, &er)| to_f64(&c.abs(), 0) * (1.0 + 1e-15) * er).sum::<f64>() * (1.0 + 1e-12);
    if !e.is_finite() {
        return Err(true);
    }
    // ceil(e) + 1 as an integer, for any size: e < (m + 1) 2^k
    let k = (e.max(1.0).log2().ceil() as i32 - 52).max(0);
    let eb = (BigInt::from((e / 2f64.powi(k)).ceil() as u64 + 1) << k as usize) + 1u32;
    let ab = b.abs();
    if ab <= &eb * 2 {
        return Err(true);
    }
    Ok((&ab - &eb, &ab + &eb, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bf_error_decreases() {
        // log Delta = 23 (Delta near 10^10), degree 4
        let e1 = bf_error(1152.0, 4, 23.0);
        let e2 = bf_error(9.0 * 4096.0, 4, 23.0);
        assert!(e1 > e2 && e2 < 0.2, "{} {}", e1, e2);
        assert!(choose_x(4, 23.0).is_some());
    }
}

#[cfg(test)]
mod ball_tests {
    use super::*;

    /// The ball bound agrees with the f64 one (which carried margins) to
    /// about 1e-9, and costs little; timing printed.
    #[test]
    fn log_hr_lower_ball_matches() {
        for d in [-23i64, -4027, 5, 1009, -1000003, 10007 * 4] {
            let db = BigInt::from(d);
            let t = std::time::Instant::now();
            let b = quadratic_log_hr_lower_ball(&db, 96).unwrap();
            let el = t.elapsed().as_secs_f64() * 1e3;
            let f = quadratic_log_hr_lower(&db).unwrap();
            let (lm, le) = b.lower();
            let lo = Ball::exact(lm, le).to_f64_approx();
            eprintln!("d {}: ball lower {:.12} f64 {:.12} (radius {:.2e}) in {:.1} ms", d, lo, f, b.rad_f64_approx(), el);
            assert!((lo - f).abs() < 1e-6 * (1.0 + f.abs()), "{} vs {}", lo, f);
        }
    }
}
