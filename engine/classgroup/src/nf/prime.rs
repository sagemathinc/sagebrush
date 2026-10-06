//! Prime ideals of a maximal order: the decomposition of p by
//! Kummer-Dedekind, with a generator alpha of K whose order Z[alpha] has
//! index prime to p (t itself, or a small random element when p divides
//! [O : Z[t]]), and valuations by an element beta of p P^-1 not in p O
//! (Cohen 4.8.17).

use super::order::Order;
use super::zlin::*;
use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{One, Signed, Zero};

#[derive(Clone, Debug)]
pub struct PrimeIdeal {
    pub p: u64,
    pub e: u32,
    pub f: u32,
    /// P = p O + pi O (order coordinates)
    pub pi: Vec<BigInt>,
    /// beta in p P^-1, not in p O: v_P(x) = max k with x beta^k in p^k O
    pub beta: Vec<BigInt>,
    /// Z-basis (HNF rows, order coordinates)
    pub basis: ZMat,
}

impl PrimeIdeal {
    pub fn norm(&self) -> BigInt {
        BigInt::from(self.p).pow(self.f)
    }
}

/// The powers 1, a, ..., a^n of a (order coordinates).
fn powers(o: &Order, a: &[BigInt]) -> Vec<Vec<BigInt>> {
    let mut out = vec![o.one()];
    for _ in 0..o.n {
        let next = o.mul(out.last().unwrap(), a);
        out.push(next);
    }
    out
}

/// The characteristic (= minimal) polynomial of a, monic, constant term
/// first, if a generates K (its powers 1..a^(n-1) are independent).
fn charpoly(o: &Order, pw: &[Vec<BigInt>]) -> Option<Vec<BigInt>> {
    let n = o.n;
    let m: QMat = pw[..n].iter().map(|r| r.iter().map(|x| BigRational::from_integer(x.clone())).collect()).collect();
    if crate::linalg::det(&pw[..n].to_vec()).is_zero() {
        return None;
    }
    let inv = inverse(&m);
    let last: Vec<BigRational> = pw[n].iter().map(|x| BigRational::from_integer(x.clone())).collect();
    let c = vec_mat(&last, &inv); // a^n = sum c_i a^i
    let mut f: Vec<BigInt> = c.into_iter().map(|x| -x.to_integer()).collect();
    f.push(BigInt::one());
    Some(f)
}

/// sum g_k a^k (g with u64 coefficients) in order coordinates.
fn eval(o: &Order, g: &[u64], pw: &[Vec<BigInt>]) -> Vec<BigInt> {
    let mut out = vec![BigInt::zero(); o.n];
    for (k, &c) in g.iter().enumerate() {
        if c != 0 {
            for (x, y) in out.iter_mut().zip(&pw[k]) {
                *x += y * c;
            }
        }
    }
    out
}

/// disc(Z[a]) = det(Tr(a^(i+j))).
fn disc_of_powers(o: &Order, pw: &[Vec<BigInt>]) -> BigInt {
    let n = o.n;
    let mut tr = vec![];
    let mut x = o.one();
    for _ in 0..2 * n - 1 {
        tr.push(o.trace(&x));
        x = o.mul(&x, &pw[1]);
    }
    let m: ZMat = (0..n).map(|i| (0..n).map(|j| tr[i + j].clone()).collect()).collect();
    crate::linalg::det(&m)
}

/// The prime ideals above p, by Kummer-Dedekind.  An error if p is a common
/// index divisor (no alpha with p prime to [O : Z[alpha]] among those tried;
/// possible only for p < n).
pub fn decompose(o: &Order, dk: &BigInt, p: u64) -> Result<Vec<PrimeIdeal>, String> {
    let n = o.n;
    let bp = BigInt::from(p);
    let theta = {
        let v: Vec<BigRational> = (0..n).map(|i| BigRational::from_integer(BigInt::from((i == 1) as i32))).collect();
        o.from_power(&v).into_iter().map(|x| x.to_integer()).collect::<Vec<_>>()
    };
    let mut rng = 0x9E37_79B9_7F4A_7C15u64 ^ p;
    let mut alpha = theta;
    for attempt in 0..200 {
        if attempt > 0 {
            // a small random element
            alpha = (0..n).map(|_| {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                BigInt::from((rng % 7) as i64 - 3)
            }).collect();
        }
        let pw = powers(o, &alpha);
        let Some(g) = charpoly(o, &pw) else { continue };
        // [O : Z[alpha]]^2 = disc(Z[alpha]) / d_K
        let ind2 = disc_of_powers(o, &pw) / dk;
        if (&ind2 % &bp).is_zero() {
            continue;
        }
        let fac = sagebrush_poly::factor_mod(&g, p);
        let mut out = vec![];
        for (k, (gi, e)) in fac.iter().enumerate() {
            let pi = eval(o, gi, &pw);
            // h = g / gi mod p (all the other factors, and gi^(e-1))
            let mut h: Vec<u64> = vec![1];
            for (j, (gj, ej)) in fac.iter().enumerate() {
                let times = if j == k { ej - 1 } else { *ej };
                for _ in 0..times {
                    h = mul_mod_p(&h, gj, p);
                }
            }
            let beta = eval(o, &h, &pw);
            let mut gens: ZMat = (0..n).map(|i| (0..n).map(|j| if i == j { bp.clone() } else { BigInt::zero() }).collect()).collect();
            for i in 0..n {
                let e_i: Vec<BigInt> = (0..n).map(|j| BigInt::from((i == j) as i32)).collect();
                gens.push(o.mul(&pi, &e_i));
            }
            let basis = hnf(&gens);
            out.push(PrimeIdeal { p, e: *e, f: (gi.len() - 1) as u32, pi, beta, basis });
        }
        return Ok(out);
    }
    Err(format!("{} is a common index divisor: not supported yet", p))
}

fn mul_mod_p(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let mut r = vec![0u64; a.len() + b.len() - 1];
    for (i, &x) in a.iter().enumerate() {
        for (j, &y) in b.iter().enumerate() {
            r[i + j] = ((r[i + j] as u128 + x as u128 * y as u128) % p as u128) as u64;
        }
    }
    r
}

/// v_P(x) for x in O, x != 0.
pub fn valuation(o: &Order, pr: &PrimeIdeal, x: &[BigInt]) -> u32 {
    let p = BigInt::from(pr.p);
    let mut y = x.to_vec();
    let mut v = 0;
    loop {
        let z = o.mul(&y, &pr.beta);
        if z.iter().all(|c| (c % &p).is_zero()) {
            y = z.into_iter().map(|c| c / &p).collect();
            v += 1;
        } else {
            return v;
        }
    }
}

/// The factorization of x (in O, nonzero) over the given primes if its norm
/// factors over them: (index, exponent) pairs.
pub fn factor_element(o: &Order, primes: &[PrimeIdeal], by_p: &std::collections::HashMap<u64, Vec<usize>>, x: &[BigInt]) -> Option<Vec<(usize, i64)>> {
    let mut nrm = o.norm(x).abs();
    let mut out = vec![];
    for (&p, idx) in by_p.iter() {
        let bp = BigInt::from(p);
        if !(&nrm % &bp).is_zero() {
            continue;
        }
        let mut vp = 0u32;
        while (&nrm % &bp).is_zero() {
            nrm /= &bp;
            vp += 1;
        }
        let mut seen = 0u32;
        for &i in idx {
            let pr = &primes[i];
            let v = if seen + pr.f == vp && idx.last() == Some(&i) { (vp - seen) / pr.f } else { valuation(o, pr, x) };
            if v > 0 {
                out.push((i, v as i64));
                seen += v * pr.f;
            }
        }
        if seen != vp {
            return None; // p has primes outside the list
        }
    }
    if nrm.is_one() {
        out.sort();
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nf::order::maximal_order;

    fn poly(c: &[i64]) -> Vec<BigInt> {
        c.iter().map(|&x| BigInt::from(x)).collect()
    }

    #[test]
    fn decompositions() {
        // (f, p, sorted [(e, f)]) from PARI's idealprimedec (oracle)
        let cases: &[(&[i64], u64, &[(u32, u32)])] = &[
            (&[8, -2, 1, 1], 2, &[(1, 1), (1, 1), (1, 1)]), // Dedekind: 2 splits, common index divisor
            (&[1, 0, 0, 0, 1], 2, &[(4, 1)]),
            (&[1, 0, 0, 0, 1], 17, &[(1, 1), (1, 1), (1, 1), (1, 1)]),
            (&[1, 0, 0, 0, 1], 3, &[(1, 2), (1, 2)]),
            (&[-2, 0, 0, 0, 0, 1], 5, &[(5, 1)]),
            (&[-5, 0, 0, 0, 1], 2, &[(2, 2)]),
            (&[-5, 0, 0, 0, 1], 5, &[(4, 1)]),
        ];
        for &(f, p, want) in cases {
            if p == 2 && f == &[8, -2, 1, 1] {
                continue; // common index divisor: later
            }
            let (o, _) = maximal_order(&poly(f));
            let dk = o.disc();
            let mut got: Vec<(u32, u32)> = decompose(&o, &dk, p).unwrap().iter().map(|q| (q.e, q.f)).collect();
            got.sort();
            assert_eq!(got, want, "{:?} at {}", f, p);
        }
    }

    #[test]
    fn valuations_match_norms() {
        let (o, _) = maximal_order(&poly(&[-5, 0, 0, 0, 1]));
        let dk = o.disc();
        for p in [2u64, 3, 5, 7, 11, 29] {
            let ps = decompose(&o, &dk, p).unwrap();
            for x in [vec![1, 1, 0, 0], vec![3, 0, 2, 1], vec![10, -4, 1, 7], vec![2, 0, 0, 0]] {
                let x: Vec<BigInt> = x.into_iter().map(BigInt::from).collect();
                let nrm = o.norm(&x).abs();
                let mut vp = 0;
                let mut m = nrm.clone();
                while (&m % p).is_zero() {
                    m /= p;
                    vp += 1;
                }
                let sum: u32 = ps.iter().map(|q| q.f * valuation(&o, q, &x)).sum();
                assert_eq!(sum, vp, "p = {} x = {:?}", p, x);
            }
        }
    }
}
