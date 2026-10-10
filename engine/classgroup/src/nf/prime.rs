//! Prime ideals of a maximal order: the decomposition of p by
//! Kummer-Dedekind, with a generator alpha of K whose order Z[alpha] has
//! index prime to p (t itself, or a small random element when p divides
//! [O : Z[t]]), and valuations by an element beta of p P^-1 not in p O
//! (Cohen 4.8.17).

use super::order::Order;
use super::zlin::*;
use sagebrush_bigint::BigInt;
use sagebrush_bigint::BigRational;
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

/// The prime ideals above p, by Kummer-Dedekind; for a common index divisor
/// (no alpha with p prime to [O : Z[alpha]]: possible only for p < n), by
/// splitting the algebra O / rad(p) (decompose_general).
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
    decompose_general(o, p)
}

/// Echelon form over F_p of the rows (pivot columns, rows normalized).
fn echelon(rows: &[Vec<u64>], p: u64) -> Vec<(usize, Vec<u64>)> {
    let mut out: Vec<(usize, Vec<u64>)> = vec![];
    for r in rows {
        let mut v = r.clone();
        reduce_by(&mut v, &out, p);
        if let Some(c) = v.iter().position(|&x| x != 0) {
            let inv = crate::arith::invmod(v[c], p);
            for x in v.iter_mut() {
                *x = *x * inv % p;
            }
            // keep the basis reduced
            for (_, b) in out.iter_mut() {
                let f = b[c];
                if f != 0 {
                    for (y, &z) in b.iter_mut().zip(&v) {
                        *y = (*y + p - f * z % p) % p;
                    }
                }
            }
            out.push((c, v));
        }
    }
    out
}

fn reduce_by(v: &mut [u64], ech: &[(usize, Vec<u64>)], p: u64) {
    for (c, b) in ech {
        let f = v[*c];
        if f != 0 {
            for (y, &z) in v.iter_mut().zip(b) {
                *y = (*y + p - f * z % p) % p;
            }
        }
    }
}

fn to_fp(x: &[BigInt], p: u64) -> Vec<u64> {
    let bp = BigInt::from(p);
    x.iter().map(|c| num_integer::Integer::mod_floor(c, &bp).to_u64_digits().1.first().copied().unwrap_or(0)).collect()
}

/// The prime ideals above a small prime p (p < 2^31) without Kummer-Dedekind
/// (Cohen 6.2): the algebra O / rad(p) is a product of finite fields; split
/// an ideal J containing rad(p) by the factors g of the minimal polynomial
/// of a random element a of O/J (J + g(a) O), until O/J is a field.
pub fn decompose_general(o: &Order, p: u64) -> Result<Vec<PrimeIdeal>, String> {
    let n = o.n;
    let bp = BigInt::from(p);
    let mut todo = vec![o.radical(&bp)];
    let mut found: Vec<(ZMat, u32)> = vec![];
    let mut rng = 0x2545_F491_4F6C_DD1Du64 ^ p;
    while let Some(j) = todo.pop() {
        // O/J over F_p: J's rows mod p span W; dim O/J = n - dim W
        let w = echelon(&j.iter().map(|r| to_fp(r, p)).collect::<Vec<_>>(), p);
        let dim = n - w.len();
        if dim == 1 {
            found.push((j, 1));
            continue;
        }
        let mut done = false;
        for _ in 0..400 {
            let a: Vec<BigInt> = (0..n).map(|_| {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                BigInt::from(rng % p)
            }).collect();
            // minimal polynomial of a in O/J: powers until dependent mod W
            let mut ech_p: Vec<(usize, Vec<u64>, Vec<u64>)> = vec![]; // pivot, vector, combination of powers
            let mut pw = o.one();
            let mut minpoly = None;
            for d in 0..=dim {
                let mut v = to_fp(&pw, p);
                reduce_by(&mut v, &w, p);
                let mut comb = vec![0u64; d + 1];
                comb[d] = 1;
                for (c, b, cb) in &ech_p {
                    let f = v[*c];
                    if f != 0 {
                        for (y, &z) in v.iter_mut().zip(b) {
                            *y = (*y + p - f * z % p) % p;
                        }
                        for (y, &z) in comb.iter_mut().zip(cb) {
                            *y = (*y + p - f * z % p) % p;
                        }
                    }
                }
                match v.iter().position(|&x| x != 0) {
                    None => {
                        minpoly = Some(comb);
                        break;
                    }
                    Some(c) => {
                        let inv = crate::arith::invmod(v[c], p);
                        for x in v.iter_mut() {
                            *x = *x * inv % p;
                        }
                        for x in comb.iter_mut() {
                            *x = *x * inv % p;
                        }
                        ech_p.push((c, v, comb));
                    }
                }
                pw = o.mul_mod(&pw, &a, &bp);
            }
            let Some(m) = minpoly else { continue };
            let mz: Vec<BigInt> = m.iter().map(|&c| BigInt::from(c)).collect();
            let fac = sagebrush_poly::factor_mod(&mz, p);
            if fac.len() == 1 && fac[0].1 == 1 && fac[0].0.len() - 1 == dim {
                found.push((j.clone(), dim as u32));
                done = true;
                break;
            }
            if fac.len() >= 2 {
                let pws = powers(o, &a);
                for (g, _) in &fac {
                    let ga = eval(o, g, &pws);
                    let mut gens = j.clone();
                    for i in 0..n {
                        let e_i: Vec<BigInt> = (0..n).map(|k| BigInt::from((i == k) as i32)).collect();
                        gens.push(o.mul_mod(&ga, &e_i, &bp));
                    }
                    todo.push(hnf(&gens));
                }
                done = true;
                break;
            }
        }
        if !done {
            return Err(format!("could not split the algebra at {}", p));
        }
    }
    let mut out = vec![];
    for (basis, f) in found {
        // beta: a nonzero x mod p with x P in p O (left kernel over F_p)
        let rows: ZMat = (0..n).map(|i| {
            let e_i: Vec<BigInt> = (0..n).map(|k| BigInt::from((i == k) as i32)).collect();
            basis.iter().flat_map(|b| o.mul_mod(&e_i, b, &bp)).collect()
        }).collect();
        let ker = left_kernel_mod(&rows, &bp);
        let beta = ker.into_iter().next().unwrap_or_else(|| o.one());
        let mut pr = PrimeIdeal { p, e: 0, f, pi: basis[0].clone(), beta, basis };
        let pv: Vec<BigInt> = o.one().into_iter().map(|c| c * p).collect();
        pr.e = valuation(o, &pr, &pv);
        out.push(pr);
    }
    Ok(out)
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
    let mut ps: Vec<u64> = by_p.keys().cloned().collect();
    ps.sort();
    let primorial: BigInt = ps.iter().map(|&p| BigInt::from(p)).product();
    factor_element_fast(o, primes, by_p, &primorial, x)
}

/// factor_element with the product of the factor base's rational primes
/// precomputed: smoothness of the norm N by gcds with (primorial mod N)
/// first (most candidates are not smooth), valuations only for the primes
/// dividing N.
pub fn factor_element_fast(o: &Order, primes: &[PrimeIdeal], by_p: &std::collections::HashMap<u64, Vec<usize>>, primorial: &BigInt, x: &[BigInt]) -> Option<Vec<(usize, i64)>> {
    use num_integer::Integer;
    let mut nrm = o.norm(x).abs();
    if nrm.is_zero() {
        return None;
    }
    let g0 = (primorial % &nrm).gcd(&nrm);
    let mut m = nrm.clone();
    loop {
        let d = m.gcd(&g0);
        if d.is_one() {
            break;
        }
        m /= d;
    }
    if !m.is_one() {
        return None;
    }
    // the rational primes dividing the norm: those of g0 (squarefree)
    let mut divs = vec![];
    let mut g = g0;
    if let Some(gu) = num_traits::ToPrimitive::to_u128(&g) {
        let mut gu = gu;
        let mut ps: Vec<&u64> = by_p.keys().collect();
        ps.sort();
        for &&p in &ps {
            if gu == 1 {
                break;
            }
            if gu % p as u128 == 0 {
                gu /= p as u128;
                divs.push(p);
            }
        }
    } else {
        let mut ps: Vec<&u64> = by_p.keys().collect();
        ps.sort();
        for &&p in &ps {
            if g.is_one() {
                break;
            }
            if (&g % p).is_zero() {
                g /= p;
                divs.push(p);
            }
        }
    }
    let mut out = vec![];
    for p in divs {
        let idx = &by_p[&p];
        let bp = BigInt::from(p);
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
            let (o, _) = maximal_order(&poly(f)).unwrap();
            let dk = o.disc();
            let mut got: Vec<(u32, u32)> = decompose(&o, &dk, p).unwrap().iter().map(|q| (q.e, q.f)).collect();
            got.sort();
            assert_eq!(got, want, "{:?} at {}", f, p);
        }
    }

    #[test]
    fn valuations_match_norms() {
        let (o, _) = maximal_order(&poly(&[-5, 0, 0, 0, 1])).unwrap();
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

    #[test]
    fn general_matches_dedekind() {
        let polys: &[&[i64]] = &[&[-5, 0, 0, 0, 1], &[1, 1, 2, -1, 1], &[-2, 0, 0, 0, 0, 1], &[3, 1, 0, 2, 0, 1], &[8, -2, 1, 1], &[-1, 3, 0, 0, 0, 0, 1]];
        for f in polys {
            let (o, _) = maximal_order(&poly(f)).unwrap();
            let dk = o.disc();
            for p in [2u64, 3, 5, 7, 11, 13] {
                let a = decompose(&o, &dk, p).unwrap();
                let b = decompose_general(&o, p).unwrap();
                let key = |v: &[PrimeIdeal]| { let mut k: Vec<(u32, u32)> = v.iter().map(|q| (q.e, q.f)).collect(); k.sort(); k };
                assert_eq!(key(&a), key(&b), "{:?} at {}", f, p);
                for x in [vec![1i64, 1, 0], vec![3, 0, 2], vec![10, -4, 1], vec![6, 1, 1]] {
                    let mut xv: Vec<BigInt> = x.into_iter().map(BigInt::from).collect();
                    xv.resize(o.n, BigInt::zero());
                    let nrm = o.norm(&xv).abs();
                    let (mut m, mut vp) = (nrm, 0u32);
                    while (&m % p).is_zero() {
                        m /= p;
                        vp += 1;
                    }
                    let sum: u32 = b.iter().map(|q| q.f * valuation(&o, q, &xv)).sum();
                    assert_eq!(sum, vp, "{:?} at {}: {:?}", f, p, xv);
                }
            }
        }
    }
}
