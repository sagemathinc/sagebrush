//! The analytic rank of an elliptic curve over Q when it is 0 or 1, decided
//! on balls (sagebrush-ball): every sum, exponential and E_1 enclosed, the
//! tails bounded, no floating-point margin (the systematic review's
//! R2-EC-F2: the f64 version allowed 1e-13 for exp and 1e-12 for E_1
//! without a proof).
//!
//! With q = 2 pi t / sqrt(N) and a_n the coefficients of L(E, s) (N the
//! conductor), f(t) = sum a_n/n e^(-q n) satisfies
//! f(1) - f(t) = w (f(1/t) - f(1)) for the root number w, L(E,1) =
//! (1 + w) f(1), and for w = -1, L'(E,1) = 2 sum a_n/n E_1(2 pi n/sqrt N).
//! Tails: |a_n| <= d(n) sqrt(n) <= 2n, so |a_n/n| <= 2 and
//!   sum_(n>M) |a_n/n| e^(-q n) <= 2 e^(-q(M+1)) / (1 - e^(-q)),
//!   sum_(n>M) |a_n/n| E_1(q n) <= 2 e^(-q(M+1)) / ((1 - e^(-q)) q (M+1))
//! (E_1(x) < e^(-x)/x).  L(E,1) != 0 gives rank 0 (Kolyvagin); w = -1 and
//! L'(E,1) != 0 give rank 1 (Gross-Zagier, Kolyvagin).

use sagebrush_ball::{e1, pi, Ball};

/// A decided analytic rank: (w, rank, L(E,1) or L'(E,1)).
#[derive(Clone, Debug)]
pub struct LowRank {
    pub w: i32,
    pub rank: u32,
    pub value: Ball,
}

/// The number of terms making the tails about 2^-bits (a heuristic: the
/// bound itself is computed on balls).
fn terms_for(q: f64, bits: f64) -> usize {
    let extra = (2.0 / (1.0 - (-q).exp())).ln();
    ((bits * std::f64::consts::LN_2 + extra) / q).ceil() as usize + 1
}

/// f(t) for q = q(t), with its tail.
fn f_ball(an: &[i64], q: &Ball, m: usize, prec: u64) -> Option<Ball> {
    let z = q.neg().exp(prec)?;
    let mut zn = Ball::one();
    let mut sum = Ball::zero();
    for (n, &a) in an.iter().enumerate().take(m + 1).skip(1) {
        zn = zn.mul(&z, prec);
        if a != 0 {
            sum = sum.add(&zn.mul_i64(a, prec).div_i64(n as i64, prec), prec);
        }
    }
    // 2 z^(M+1) / (1 - z)
    let tail = zn.mul(&z, prec).mul_2exp(1).div(&Ball::one().sub(&z, prec), prec)?;
    Some(sum.add_error(tail.upper_abs()))
}

/// The certified analytic rank, if it is 0 or 1 and the balls decide it.
/// `an` = [0, a_1, ..., a_M] (exact), `n` the conductor.
pub fn low_rank(an: &[i64], n: u64, prec: u64) -> Option<LowRank> {
    if an.len() < 2 || n == 0 {
        return None;
    }
    let sqn = Ball::from_i64(n as i64).sqrt(prec)?;
    let q1 = pi(prec).mul_2exp(1).div(&sqn, prec)?;
    let (qt, qi) = (q1.mul_i64(6, prec).div_i64(5, prec), q1.mul_i64(5, prec).div_i64(6, prec));
    let qf = q1.to_f64_approx();
    let m = terms_for(qf * 5.0 / 6.0, 60.0).min(an.len() - 1);
    let f1 = f_ball(an, &q1, m, prec)?;
    let ft = f_ball(an, &qt, m, prec)?;
    let fi = f_ball(an, &qi, m, prec)?;
    // A = w B with A = f(1) - f(t), B = f(1/t) - f(1): A + B = 0 for
    // w = -1, A - B = 0 for w = 1; exactly one must be certainly nonzero
    let a = f1.sub(&ft, prec);
    let b = fi.sub(&f1, prec);
    let (plus, minus) = (a.add(&b, prec).is_nonzero(), a.sub(&b, prec).is_nonzero());
    if plus == minus {
        return None;
    }
    if plus {
        let l = f1.mul_2exp(1);
        return l.is_nonzero().then_some(LowRank { w: 1, rank: 0, value: l });
    }
    // w = -1: L'(E,1) = 2 sum a_n/n E_1(q n)
    let m1 = terms_for(qf, 60.0).min(an.len() - 1);
    let mut s = Ball::zero();
    for (k, &a) in an.iter().enumerate().take(m1 + 1).skip(1) {
        sagebrush_interrupt::check();
        if a != 0 {
            let x = q1.mul_i64(k as i64, prec);
            s = s.add(&e1(&x, prec)?.mul_i64(a, prec).div_i64(k as i64, prec), prec);
        }
    }
    // tail: 2 e^(-q(M+1)) / ((1 - e^(-q)) q (M+1))
    let z = q1.neg().exp(prec)?;
    let zm = q1.mul_i64(m1 as i64 + 1, prec).neg().exp(prec)?;
    let tail = zm.mul_2exp(1).div(&Ball::one().sub(&z, prec).mul(&q1, prec).mul_i64(m1 as i64 + 1, prec), prec)?;
    let l1 = s.add_error(tail.upper_abs()).mul_2exp(1);
    l1.is_nonzero().then_some(LowRank { w: -1, rank: 1, value: l1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{aplist, EllipticCurve};

    /// [0, a_1, ..., a_n] from the a_p (as Sage's anlist).
    fn anlist(a: [i64; 5], n: usize, bad: (usize, i64)) -> Vec<i64> {
        let e = EllipticCurve::new(a).unwrap();
        let mut an = vec![0i64; n + 1];
        an[1] = 1;
        let mut ap = std::collections::HashMap::new();
        for (p, v) in aplist(&e, n as u64) {
            ap.insert(p as usize, v);
        }
        // prime powers
        for (&p, v) in &ap {
            let (good, a_p) = match v { Some(x) => (true, *x), None => { assert_eq!(p, bad.0); (false, bad.1) } };
            let (mut pk, mut prev, mut cur) = (p, 1i64, a_p);
            while pk <= n {
                an[pk] = cur;
                let next = if good { a_p * cur - p as i64 * prev } else { a_p * cur };
                prev = cur;
                cur = next;
                pk *= p;
            }
        }
        // multiplicativity
        for k in 2..=n {
            let mut m = k;
            let mut p = 2;
            while p * p <= m && m % p != 0 { p += 1; }
            if p * p > m { continue; } // prime
            let mut pk = 1;
            while m % p == 0 { m /= p; pk *= p; }
            if m > 1 { an[k] = an[pk] * an[m]; }
        }
        an
    }

    #[test]
    fn ranks_0_and_1_certified_on_balls() {
        // (prime conductors: a_N = w, given here)
        let cases: [([i64; 5], u64, i64, Option<(u32, f64)>); 4] = [
            ([0, -1, 1, -10, -20], 11, 1, Some((0, 0.253_841_860_855_910_684_3))),
            ([0, 0, 1, -1, 0], 37, -1, Some((1, 0.305_999_773_834_052_301_8))),
            ([0, 1, 1, -2, 0], 389, 1, None),
            ([0, 0, 1, -7, 6], 5077, -1, None),
        ];
        for (a, n, an_n, want) in cases {
            let an = anlist(a, 4000, (n as usize, an_n));
            let t = std::time::Instant::now();
            let r = low_rank(&an, n, 96);
            eprintln!("N {}: {:?} in {:.1} ms", n, r.as_ref().map(|x| (x.w, x.rank, x.value.to_string())), t.elapsed().as_secs_f64() * 1e3);
            match (r, want) {
                (Some(r), Some((rank, v))) => {
                    assert_eq!(r.rank, rank);
                    assert!((r.value.to_f64_approx() - v).abs() < 1e-15, "{}", r.value);
                    assert!(r.value.rad_f64_approx() < 1e-20);
                }
                (None, None) => {}
                (r, w) => panic!("N {}: {:?} vs {:?}", n, r, w),
            }
        }
    }
}
