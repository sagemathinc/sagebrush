//! Traces of Frobenius a_p = p + 1 - #E(F_p) of an elliptic curve E over Q,
//! for all primes up to a bound, in parallel.
//!
//! The method is smalljac's genus-1 strategy (Kedlaya-Sutherland), written
//! from scratch: for each prime, a point on E or on its quadratic twist,
//! baby-step giant-step over the Hasse interval |t| <= 2 sqrt(p) for the
//! t with (p + 1 - t) P = O, and more points until only one a_p is
//! consistent with all of them.  Every answer is therefore unique, not
//! probabilistic.  Small primes are counted directly.
//!
//! * `fp`: arithmetic mod p < 2^62 in Montgomery form.
//! * `ec`: the group law in Jacobian coordinates and the search.

pub mod ec;
pub mod fp;
pub mod lcert;
pub mod quartic;
pub mod search;

use ec::{Aff, Curve};
use fp::{jacobi, Fp};

thread_local! {
    static SCRATCH: std::cell::RefCell<ec::Scratch> = std::cell::RefCell::new(ec::Scratch::default());
}

/// Below this, count points directly.
const NAIVE_BELOW: u64 = 1000;

/// y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6 over Q.
#[derive(Clone, Debug)]
pub struct EllipticCurve {
    pub a: [i64; 5],
    pub c4: i128,
    pub c6: i128,
    pub disc: i128,
}

impl EllipticCurve {
    /// From [a1, a2, a3, a4, a6]; an error if singular or the invariants
    /// overflow 128 bits.
    pub fn new(a: [i64; 5]) -> Result<Self, String> {
        let [a1, a2, a3, a4, a6] = a.map(|x| x as i128);
        // every operation checked: a release build would wrap silently
        // (Astra's audit, F2: -54 c6 wrapped, and a_p came out wrong)
        let ovf = || format!("coefficients of {:?} are too large", a);
        let m = |x: i128, y: i128| x.checked_mul(y).ok_or_else(ovf);
        let s = |x: i128, y: i128| x.checked_add(y).ok_or_else(ovf);
        let d = |x: i128, y: i128| x.checked_sub(y).ok_or_else(ovf);
        let b2 = s(m(a1, a1)?, m(4, a2)?)?;
        let b4 = s(m(2, a4)?, m(a1, a3)?)?;
        let b6 = s(m(a3, a3)?, m(4, a6)?)?;
        let b8 = d(s(d(s(m(m(a1, a1)?, a6)?, m(m(4, a2)?, a6)?)?, m(m(a1, a3)?, a4)?)?, m(a2, m(a3, a3)?)?)?, m(a4, a4)?)?;
        let c4 = d(m(b2, b2)?, m(24, b4)?)?;
        let c6 = d(s(m(-1, m(m(b2, b2)?, b2)?)?, m(m(36, b2)?, b4)?)?, m(216, b6)?)?;
        let disc = s(d(d(m(-1, m(m(b2, b2)?, b8)?)?, m(m(8, m(b4, b4)?)?, b4)?)?, m(m(27, b6)?, b6)?)?, m(m(m(9, b2)?, b4)?, b6)?)?;
        if disc == 0 {
            return Err(format!("{:?} is singular", a));
        }
        Ok(EllipticCurve { a, c4, c6, disc })
    }

    /// Whether p divides the discriminant of this model.
    pub fn bad(&self, p: u64) -> bool {
        self.disc % p as i128 == 0
    }

    /// a_p, or None at a prime dividing the discriminant of the model.
    pub fn ap(&self, p: u64) -> Option<i64> {
        if self.bad(p) {
            return None;
        }
        Some(if p < NAIVE_BELOW { self.ap_naive(p) } else { self.ap_bsgs(p) })
    }

    /// p + 1 - #E(F_p) by counting, from the general model (any p).
    pub fn ap_naive(&self, p: u64) -> i64 {
        let pi = p as i128;
        let [a1, a2, a3, a4, a6] = self.a.map(|x| (x as i128).rem_euclid(pi));
        let mut count = 1i64; // O
        for x in 0..pi {
            let rhs = (((x + a2) * x + a4) * x + a6) % pi;
            let b = (a1 * x + a3) % pi; // y^2 + b y - rhs = 0
            if p == 2 {
                count += (0..2).filter(|&y| (y * y + b * y - rhs).rem_euclid(2) == 0).count() as i64;
            } else {
                let disc = ((b * b + 4 * rhs) % pi) as u64;
                count += 1 + jacobi(disc, p) as i64;
            }
        }
        p as i64 + 1 - count
    }

    /// a_p for p >= 5 of good reduction, on y^2 = x^3 - 27 c4 x - 54 c6.
    fn ap_bsgs(&self, p: u64) -> i64 {
        let f = Fp::new(p);
        // reduce first: -27 c4 and -54 c6 need not fit 128 bits
        let a = f.mul(f.from_i128(-27), f.from_i128(self.c4));
        let b = f.mul(f.from_i128(-54), f.from_i128(self.c6));
        let w = isqrt(4 * p) as i64; // |a_p| <= 2 sqrt(p)
        // If the cubic's discriminant -(4a^3 + 27b^2) is not a square, the
        // cubic has exactly one root: one point of order 2 on E and on its
        // twist, so a_p = p + 1 - #E is even.  Search only even t then.
        let disc = f.neg(f.add(f.mul(f.from_i128(4), f.mul(f.sqr(a), a)), f.mul(f.from_i128(27), f.sqr(b))));
        let (md, res) = if jacobi(f.to_u64(disc), p) == -1 { (2, 0) } else { (1, 0) };
        let mut cands: Option<Vec<i64>> = None;
        for x0 in 1..200u64 {
            // d = x0^3 + a x0 + b; (d x0, d^2) lies on y^2 = x^3 + a d^2 x + b d^3,
            // which is E if d is a square mod p and its quadratic twist if not.
            let x = f.from_i128(x0 as i128);
            let d = f.add(f.mul(f.add(f.sqr(x), a), x), b);
            if d == 0 {
                continue;
            }
            let chi = jacobi(f.to_u64(d), p) as i64;
            let d2 = f.sqr(d);
            let c = Curve { f: &f, a: f.mul(a, d2) };
            let pt = Aff { x: f.mul(d, x), y: d2 };
            let next = match cands.take() {
                Some(cs) if cs.len() <= 8 => cs.into_iter().filter(|&ap| c.mul(pt, (p as i64 + 1 - chi * ap) as u64).z == 0).collect(),
                prev => {
                    let ts: Vec<i64> = SCRATCH.with(|s| ec::traces(&c, pt, w, md, res, &mut s.borrow_mut())).into_iter().map(|t| chi * t).collect();
                    match prev {
                        None => ts,
                        Some(cs) => cs.into_iter().filter(|ap| ts.contains(ap)).collect(),
                    }
                }
            };
            if next.len() == 1 {
                return next[0];
            }
            debug_assert!(!next.is_empty(), "no candidate at p = {}", p);
            cands = Some(next);
        }
        self.ap_naive(p) // not reached in practice (Mestre)
    }
}

pub fn isqrt(n: u64) -> u64 {
    // (squares in u128: near 2^64 the double's root squared overflowed u64,
    // for 4p with p just below 2^62: the systematic review's EC-F6)
    let mut r = (n as f64).sqrt() as u128;
    let n = n as u128;
    while r * r > n {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    r as u64
}

/// The primes up to n (sieve of Eratosthenes on odd numbers).
pub fn primes_up_to(n: u64) -> Vec<u64> {
    if n < 2 {
        return vec![];
    }
    let half = (n as usize - 1) / 2; // index i is 2 i + 3
    let mut composite = vec![false; half];
    let mut i = 0;
    while ((2 * i + 3) as u64) * ((2 * i + 3) as u64) <= n {
        if !composite[i] {
            let q = 2 * i + 3;
            let mut j = (q * q - 3) / 2;
            while j < half {
                composite[j] = true;
                j += q;
            }
        }
        i += 1;
    }
    let mut out = vec![2];
    out.extend((0..half).filter(|&i| !composite[i]).map(|i| 2 * i as u64 + 3));
    out
}

/// (p, a_p) for every prime p <= n, None at primes dividing the
/// discriminant; in parallel over chunks of primes.
pub fn aplist(e: &EllipticCurve, n: u64) -> Vec<(u64, Option<i64>)> {
    let primes = primes_up_to(n);
    let chunks: Vec<&[u64]> = primes.chunks(4096).collect();
    map(&chunks, |ch| ch.iter().map(|&p| (p, e.ap(p))).collect::<Vec<_>>()).into_iter().flatten().collect()
}

/// aplist for many curves, in parallel over curves.
pub fn aplist_many(curves: &[EllipticCurve], n: u64) -> Vec<Vec<(u64, Option<i64>)>> {
    let primes = primes_up_to(n);
    map(curves, |e| primes.iter().map(|&p| (p, e.ap(p))).collect())
}

fn map<A: Sync, T: Send, F: Fn(&A) -> T + Sync + Send>(xs: &[A], f: F) -> Vec<T> {
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        xs.par_iter().map(f).collect()
    }
    #[cfg(not(feature = "parallel"))]
    xs.iter().map(f).collect()
}

/// Sato-Tate statistics without storing every a_p: the number of good
/// primes p <= n and the moments mean((a_p / sqrt p)^(2k)) for k = 1..=kmax
/// (1, 2, 5, 14 for a non-CM curve; 1, 3, 10, 35 with CM, as n grows).
pub fn moments(e: &EllipticCurve, n: u64, kmax: usize) -> (u64, Vec<f64>) {
    let primes = primes_up_to(n);
    let chunks: Vec<&[u64]> = primes.chunks(4096).collect();
    let parts = map(&chunks, |ch| {
        let mut sums = vec![0.0f64; kmax];
        let mut count = 0u64;
        for &p in ch.iter() {
            sagebrush_interrupt::check();
            if let Some(a) = e.ap(p) {
                let x2 = (a * a) as f64 / p as f64;
                let mut x = 1.0;
                for s in sums.iter_mut() {
                    x *= x2;
                    *s += x;
                }
                count += 1;
            }
        }
        (count, sums)
    });
    let count: u64 = parts.iter().map(|p| p.0).sum();
    let sums = (0..kmax).map(|k| parts.iter().map(|p| p.1[k]).sum::<f64>() / count.max(1) as f64).collect();
    (count, sums)
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    // Astra's audit, F2: on y^2 + 2000000 xy = x^3 + x, -54 c6 overflowed
    // before reduction mod p, so a_p at p >= 1000 (the BSGS path) was that of
    // another curve.  The expected values are direct point counts.
    #[test]
    fn large_coefficients_agree_with_point_counting() {
        let e = EllipticCurve::new([2_000_000, 0, 0, 1, 0]).unwrap();
        for (p, want) in [(991u64, -48i64), (997, -26), (1009, -46), (1013, -10), (1019, -12), (1031, -52), (10007, -176)] {
            assert_eq!(e.ap(p), Some(want), "p = {}", p);
            assert_eq!(e.ap_naive(p), want, "p = {}", p);
        }
    }

    // a_p does not depend on the model: x -> x + r, y -> y + s x + t with
    // large r, s, t, across the naive/BSGS threshold.
    #[test]
    fn isomorphic_models_have_the_same_traces() {
        let base = [1i64, -1, 1, -29, 53]; // a curve with small coefficients
        for &(r, s, t) in &[(1000i64, 7i64, 12345i64), (-99_999, 3, 77), (31_337, -2, -500_000)] {
            let [a1, a2, a3, a4, a6] = base.map(|x| x as i128);
            let (r, s, t) = (r as i128, s as i128, t as i128);
            // Silverman, Table 3.1 (u = 1)
            let b1 = a1 + 2 * s;
            let b2 = a2 - s * a1 + 3 * r - s * s;
            let b3 = a3 + r * a1 + 2 * t;
            let b4 = a4 - s * a3 + 2 * r * a2 - (t + r * s) * a1 + 3 * r * r - 2 * s * t;
            let b6 = a6 + r * a4 + r * r * a2 + r * r * r - t * a3 - t * t - r * t * a1;
            let m: [i64; 5] = [b1, b2, b3, b4, b6].map(|x| i64::try_from(x).unwrap());
            let (e, f) = (EllipticCurve::new(base).unwrap(), EllipticCurve::new(m).unwrap());
            for p in [997u64, 1009, 1013, 4999, 10007, 65537] {
                if e.bad(p) || f.bad(p) {
                    continue;
                }
                assert_eq!(e.ap(p), f.ap(p), "p = {} model {:?}", p, m);
                assert_eq!(f.ap(p), Some(f.ap_naive(p)), "p = {} model {:?}", p, m);
            }
        }
    }

    // Invariants beyond 128 bits are an error, not a wrapped value.
    #[test]
    fn huge_coefficients_are_an_error() {
        assert!(EllipticCurve::new([i64::MAX, i64::MAX, i64::MAX, i64::MAX, i64::MAX]).is_err());
    }
}