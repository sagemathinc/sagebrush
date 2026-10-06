//! The public surface used by the bindings (WebAssembly JSON, Python):
//! plain data in and out.  Polynomials are integer coefficient vectors,
//! constant term first; elements of a number field K = Q[x]/(f) are given
//! on the power basis 1, a, ..., a^(n-1) as numerators with one denominator.

use crate::nf::embed::Embeddings;
use crate::nf::order::{maximal_order, Order};
use crate::nf::zlin::{hnf, vec_mat, ZMat};
use num_bigint::BigInt;
use num_integer::Integer;
use num_rational::BigRational;
use num_traits::{One, Signed, ToPrimitive, Zero};

/// The factorization of n != 0 as (prime, exponent), primes ascending (a
/// cofactor that Pollard rho cannot split is reported as if prime).
pub fn factor_integer(n: &BigInt) -> Vec<(BigInt, u32)> {
    if n.abs() <= BigInt::one() {
        return vec![];
    }
    crate::nf::factor::factor(n)
}

pub fn is_prime(n: &BigInt) -> bool {
    crate::nf::factor::is_probable_prime(n)
}

/// A number field and its maximal order.
pub struct NfData {
    pub degree: usize,
    pub r1: usize,
    pub r2: usize,
    pub disc: BigInt,
    /// [O_K : Z[a]]
    pub index: BigInt,
    /// integral basis: rows of numerators over the power basis, / den
    pub basis: ZMat,
    pub den: BigInt,
    /// the number of roots of unity
    pub w: u32,
}

fn monic(f: &[BigInt]) -> Result<(), String> {
    if f.len() < 2 || !f.last().unwrap().is_one() {
        return Err("the defining polynomial must be monic with integer coefficients, of degree >= 1".into());
    }
    if !sagebrush_poly::is_irreducible(f) {
        return Err("the defining polynomial must be irreducible".into());
    }
    Ok(())
}

pub fn nf_data(f: &[BigInt]) -> Result<NfData, String> {
    monic(f)?;
    let (o, _) = maximal_order(f);
    let disc = o.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &disc).abs());
    let (r1, r2, w) = if o.n == 1 {
        (1, 0, 2)
    } else {
        let emb = Embeddings::new(&o);
        let w = roots_of_unity(&o, &emb);
        (emb.r1, emb.r2, w)
    };
    // the HNF of the numerators: upper triangular over 1, a, a^2, ...,
    // entries above each pivot reduced (the same basis as PARI's nfbasis,
    // so as Sage's integral_basis)
    let b = hnf(&o.basis);
    Ok(NfData { degree: o.n, r1, r2, disc, index, basis: b, den: o.den.clone(), w })
}

fn roots_of_unity(o: &Order, emb: &Embeddings) -> u32 {
    let n = o.n;
    let one: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect();
    let red = crate::nf::embed::lll(&one, emb);
    let g = emb.t2_gram(&red);
    crate::nf::bnf::short_vectors(&g, n as f64 * (1.0 + 1e-9), 1000).len() as u32
}

/// A prime ideal above p: P = p O + pi O, pi on the power basis.
pub struct PrimeData {
    pub p: u64,
    pub e: u32,
    pub f: u32,
    pub pi: Vec<BigInt>,
    pub pi_den: BigInt,
}

/// x (order coordinates) on the power basis as (numerators, denominator),
/// reduced so that the coefficients are small: x is adjusted by multiples of
/// p (any element of p O works as well in (p, x)), toward a symmetric range.
fn small_generator(o: &Order, x: &[BigInt], p: u64) -> (Vec<BigInt>, BigInt) {
    let bp = BigInt::from(p);
    // reduce the order coordinates symmetrically mod p first
    let half = &bp >> 1usize;
    let xr: Vec<BigInt> = x.iter().map(|c| {
        let m = c.mod_floor(&bp);
        if m > half { m - &bp } else { m }
    }).collect();
    let v = o.to_power(&xr);
    let den = v.iter().fold(BigInt::one(), |l, q: &BigRational| l.lcm(q.denom()));
    let mut num: Vec<BigInt> = v.iter().map(|q| (q * BigRational::from_integer(den.clone())).to_integer()).collect();
    // on the power basis too, when the order is Z[a] there (den = 1)
    if den.is_one() {
        for c in num.iter_mut() {
            let m = c.mod_floor(&bp);
            *c = if m > half { m - &bp } else { m };
        }
    }
    (num, den)
}

/// The prime ideals above p with their ramification and residue degrees.
pub fn primes_above(f: &[BigInt], p: u64) -> Result<Vec<PrimeData>, String> {
    monic(f)?;
    if !crate::relations::is_prime_u64(p) {
        return Err(format!("{} is not prime", p));
    }
    let (o, _) = maximal_order(f);
    let dk = o.disc();
    let ps = crate::nf::prime::decompose(&o, &dk, p)?;
    Ok(ps.into_iter().map(|q| {
        let (pi, pi_den) = if q.f as usize == o.n { (vec![BigInt::from(p)], BigInt::one()) } else { small_generator(&o, &q.pi, p) };
        PrimeData { p, e: q.e, f: q.f, pi, pi_den }
    }).collect())
}

/// Class group, regulator and roots of unity (GRH).
pub struct BnfData {
    pub degree: usize,
    pub r1: usize,
    pub r2: usize,
    pub disc: BigInt,
    pub h: BigInt,
    pub cyc: Vec<BigInt>,
    /// the regulator to `digits` significant decimal digits (1 for unit rank 0)
    pub regulator: String,
    pub w: u32,
}

/// A decimal string of x / 2^prec with `digits` significant digits.
pub fn fixed_to_decimal(x: &BigInt, prec: u32, digits: usize) -> String {
    if x.is_zero() {
        return "0".into();
    }
    let neg = x.is_negative();
    let x = x.abs();
    // integer part digits
    let ip = &x >> prec as usize;
    let int_digits = if ip.is_zero() { 0 } else { ip.to_string().len() };
    let frac_digits = digits.saturating_sub(int_digits).max(1);
    let scaled = (&x * BigInt::from(10).pow(frac_digits as u32) + (BigInt::one() << (prec as usize - 1).max(0))) >> prec as usize;
    let s = format!("{:0>width$}", scaled.to_string(), width = frac_digits + 1);
    let (a, b) = s.split_at(s.len() - frac_digits);
    format!("{}{}.{}", if neg { "-" } else { "" }, a, b)
}

pub fn bnf(f: &[BigInt]) -> Result<BnfData, String> {
    monic(f)?;
    if f.len() == 2 {
        return Ok(BnfData { degree: 1, r1: 1, r2: 0, disc: BigInt::one(), h: BigInt::one(), cyc: vec![], regulator: "1".into(), w: 2 });
    }
    let (b, _) = crate::nf::bnf::bnfinit(f)?;
    let regulator = if b.prec == 0 { "1".to_string() } else { fixed_to_decimal(&b.reg_fixed, b.prec, 20) };
    Ok(BnfData { degree: b.n, r1: b.r1, r2: b.r2, disc: b.disc, h: b.group.h, cyc: b.group.cyc, regulator, w: b.w })
}

/// Class group of the quadratic field of fundamental discriminant d (and
/// the regulator, d > 0), by the quadratic algorithms.
pub fn quadratic(d: &BigInt) -> Result<(BigInt, Vec<BigInt>, Option<String>), String> {
    if d.is_negative() {
        let (g, _) = crate::imag::class_group(d)?;
        Ok((g.h, g.cyc, None))
    } else {
        let (r, _) = crate::realq::class_group_real(d)?;
        Ok((r.group.h, r.group.cyc, Some(fixed_to_decimal(&r.reg_fixed, r.prec, 20))))
    }
}

/// The Hermite normal form (rows, upper triangular, positive pivots; zero
/// rows dropped).
pub fn hermite(m: &ZMat) -> ZMat {
    hnf(m)
}

/// The elementary divisors (Smith form diagonal) of an m x n integer matrix:
/// min(m, n) entries d_1 | d_2 | ..., zeros last.
pub fn elementary_divisors(m: &ZMat) -> Vec<BigInt> {
    let rows = m.len();
    let cols = m.first().map_or(0, |r| r.len());
    let k = rows.min(cols);
    let mut a = m.clone();
    let mut diag = vec![];
    for t in 0..k {
        loop {
            // the smallest nonzero entry of the remaining block
            let mut best: Option<(usize, usize)> = None;
            for i in t..rows {
                for j in t..cols {
                    if !a[i][j].is_zero() && best.map_or(true, |(bi, bj)| a[i][j].abs() < a[bi][bj].abs()) {
                        best = Some((i, j));
                    }
                }
            }
            let Some((bi, bj)) = best else {
                diag.push(BigInt::zero());
                break;
            };
            a.swap(t, bi);
            for row in a.iter_mut() {
                row.swap(t, bj);
            }
            let p = a[t][t].clone();
            let mut clean = true;
            for i in t + 1..rows {
                let q = a[i][t].div_floor(&p);
                if !q.is_zero() {
                    let pr = a[t].clone();
                    for (x, y) in a[i].iter_mut().zip(&pr) {
                        *x -= &q * y;
                    }
                }
                clean &= a[i][t].is_zero();
            }
            for j in t + 1..cols {
                let q = a[t][j].div_floor(&p);
                if !q.is_zero() {
                    for row in a.iter_mut() {
                        let v = &row[t] * &q;
                        row[j] -= v;
                    }
                }
                clean &= a[t][j].is_zero();
            }
            if !clean {
                continue;
            }
            // p must divide the rest of the block
            let bad = (t + 1..rows).find(|&i| (t + 1..cols).any(|j| !(&a[i][j] % &p).is_zero()));
            if let Some(i) = bad {
                let ri = a[i].clone();
                for (x, y) in a[t].iter_mut().zip(&ri) {
                    *x += y;
                }
                continue;
            }
            diag.push(p.abs());
            break;
        }
    }
    // nonzero ones ascending (they divide each other), zeros last
    let mut nz: Vec<BigInt> = diag.iter().filter(|d| !d.is_zero()).cloned().collect();
    nz.sort();
    let zeros = diag.len() - nz.len();
    nz.extend(std::iter::repeat(BigInt::zero()).take(zeros));
    nz
}

/// LLL-reduced basis (delta 0.99, exact integral version of de Weger /
/// Cohen 2.6.7) of the lattice spanned by the rows; dependent rows give zero
/// rows, which come first (as in Sage).
pub fn lll(m: &ZMat) -> ZMat {
    let rows = m.len();
    // the rows themselves when independent (the result then matches Sage's
    // reduction of the same rows), else a basis of their lattice
    let h = hnf(m);
    let mut b = if h.len() == rows { m.clone() } else { h };
    let k = b.len();
    if k > 1 {
        integral_lll(&mut b);
    }
    let cols = m.first().map_or(0, |r| r.len());
    let mut out: ZMat = (0..rows - k).map(|_| vec![BigInt::zero(); cols]).collect();
    out.extend(b);
    out
}

fn dot(a: &[BigInt], b: &[BigInt]) -> BigInt {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Integral LLL with delta = 0.99 on independent rows (Cohen, Algorithm
/// 2.6.7): d_i and lambda_ij stay integers.
fn integral_lll(b: &mut ZMat) {
    let n = b.len();
    let mut d = vec![BigInt::zero(); n + 1];
    let mut lam = vec![vec![BigInt::zero(); n]; n];
    d[0] = BigInt::one();
    let gs = |b: &ZMat, k: usize, d: &mut Vec<BigInt>, lam: &mut Vec<Vec<BigInt>>| {
        for j in 0..=k {
            let mut u = dot(&b[k], &b[j]);
            for i in 0..j {
                u = (&d[i + 1] * &u - &lam[k][i] * &lam[j][i]) / &d[i];
            }
            if j < k {
                lam[k][j] = u;
            } else {
                d[k + 1] = u;
            }
        }
    };
    gs(b, 0, &mut d, &mut lam);
    let mut k = 1;
    let mut kmax = 0;
    let red = |b: &mut ZMat, lam: &mut Vec<Vec<BigInt>>, d: &Vec<BigInt>, k: usize, l: usize| {
        if (&lam[k][l] * BigInt::from(2)).abs() > d[l + 1] {
            let q = (&lam[k][l] * BigInt::from(2) + &d[l + 1]).div_floor(&(&d[l + 1] * BigInt::from(2))); // nearest integer
            let bl = b[l].clone();
            for (x, y) in b[k].iter_mut().zip(&bl) {
                *x -= &q * y;
            }
            lam[k][l] -= &q * &d[l + 1];
            for i in 0..l {
                let v = &q * &lam[l][i];
                lam[k][i] -= v;
            }
        }
    };
    while k < n {
        if k > kmax {
            kmax = k;
            gs(b, k, &mut d, &mut lam);
        }
        red(b, &mut lam, &d, k, k - 1);
        // Lovasz with delta 99/100 (as fplll, so as Sage):
        // 100 d_{k+1} d_{k-1} < 99 d_k^2 - 100 lam^2
        if BigInt::from(100) * &d[k + 1] * &d[k - 1] < BigInt::from(99) * &d[k] * &d[k] - BigInt::from(100) * &lam[k][k - 1] * &lam[k][k - 1] {
            // swap b_k, b_{k-1}
            b.swap(k, k - 1);
            for j in 0..k - 1 {
                let t = lam[k][j].clone();
                lam[k][j] = lam[k - 1][j].clone();
                lam[k - 1][j] = t;
            }
            let l = lam[k][k - 1].clone();
            let bb = (&d[k - 1] * &d[k + 1] + &l * &l) / &d[k];
            for i in k + 1..=kmax {
                let t = lam[i][k].clone();
                lam[i][k] = (&d[k + 1] * &lam[i][k - 1] - &l * &t) / &d[k];
                lam[i][k - 1] = (&bb * &t + &l * &lam[i][k]) / &d[k + 1];
            }
            d[k] = bb;
            if k > 1 {
                k -= 1;
            }
        } else {
            for l in (0..k - 1).rev() {
                red(b, &mut lam, &d, k, l);
            }
            k += 1;
        }
    }
}

/// The complex roots of f (integer coefficients) with multiplicities, to
/// `digits` significant digits, as decimal (re, im) strings: real roots
/// first (ascending), then complex ones by real then imaginary part.
pub fn complex_roots(f: &[BigInt], digits: usize) -> Result<Vec<(String, String, u32)>, String> {
    if f.len() < 2 {
        return Ok(vec![]);
    }
    let prec = (digits as f64 * 3.33) as u32 + 40;
    let mut out = vec![];
    for (g, e) in sagebrush_poly::squarefree(f) {
        if g.len() < 2 {
            continue;
        }
        for (re, im) in roots_squarefree(&g, prec)? {
            out.push((re, im, e));
        }
    }
    let key = |r: &(BigInt, BigInt, u32)| (r.1.is_zero() as u8, r.0.clone(), r.1.clone());
    out.sort_by(|a, b| key(b).0.cmp(&key(a).0).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    let fmt = |x: &BigInt| fixed_to_decimal(x, prec, digits);
    Ok(out.iter().map(|(re, im, e)| (fmt(re), fmt(im), *e)).collect())
}

/// All n roots of a square-free integer polynomial, fixed point (re, im).
fn roots_squarefree(g: &[BigInt], prec: u32) -> Result<Vec<(BigInt, BigInt)>, String> {
    let n = g.len() - 1;
    let lead = g[n].to_f64().unwrap();
    let fc: Vec<f64> = g.iter().map(|c| c.to_f64().unwrap() / lead).collect();
    let z0 = crate::nf::embed::aberth(&fc);
    let p = prec as usize + 32;
    let mut out = vec![];
    for (re, im) in z0 {
        let to = |x: f64| -> BigInt { num_traits::FromPrimitive::from_f64((x * 2f64.powi(52)).round()).map_or(BigInt::zero(), |b: BigInt| b << (p - 52)) };
        let (mut zr, mut zi) = (to(re), to(im));
        let mut bits = 40;
        loop {
            let (mut vr, mut vi, mut dr, mut di) = (BigInt::zero(), BigInt::zero(), BigInt::zero(), BigInt::zero());
            for c in g.iter().rev() {
                let ndr = ((&dr * &zr - &di * &zi) >> p) + &vr;
                let ndi = ((&dr * &zi + &di * &zr) >> p) + &vi;
                dr = ndr;
                di = ndi;
                let nvr = ((&vr * &zr - &vi * &zi) >> p) + (c << p);
                let nvi = (&vr * &zi + &vi * &zr) >> p;
                vr = nvr;
                vi = nvi;
            }
            let dd = (&dr * &dr + &di * &di) >> p;
            if dd.is_zero() {
                break;
            }
            zr -= ((&vr * &dr + &vi * &di) >> p << p) / &dd;
            zi -= ((&vi * &dr - &vr * &di) >> p << p) / &dd;
            if bits > p + 20 {
                break;
            }
            bits *= 2;
        }
        // a real root: imaginary part within the error
        if im.abs() < 1e-9 * (1.0 + re.abs()) && (&zi.abs() >> (p / 2)).is_zero() {
            zi = BigInt::zero();
        }
        out.push((zr >> 32usize, zi >> 32usize));
    }
    let _ = vec_mat::<BigInt>;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(v: &[&[i64]]) -> ZMat {
        v.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    #[test]
    fn against_sage() {
        // M = matrix(ZZ, [[4,6,2],[3,9,12],[1,1,1]]): Sage's outputs
        let m = z(&[&[4, 6, 2], &[3, 9, 12], &[1, 1, 1]]);
        assert_eq!(hermite(&m), z(&[&[1, 1, 1], &[0, 2, 13], &[0, 0, 15]]));
        assert_eq!(elementary_divisors(&m), vec![BigInt::from(1), BigInt::from(1), BigInt::from(30)]);
        assert_eq!(lll(&z(&[&[1, 2, 3], &[4, 5, 6], &[7, 8, 10]])), z(&[&[0, 0, 1], &[-1, 1, 0], &[2, 1, 0]]));
        let r = complex_roots(&[BigInt::from(-2), BigInt::zero(), BigInt::zero(), BigInt::one()], 15).unwrap();
        assert_eq!(r[0].0, "1.25992104989487");
        assert_eq!(r[0].1, "0");
        let d = nf_data(&[BigInt::from(-11), BigInt::zero(), BigInt::zero(), BigInt::one()]).unwrap();
        assert_eq!((d.disc.clone(), d.r1, d.r2, d.w), (BigInt::from(-3267), 1, 1, 2));
        assert_eq!(factor_integer(&((BigInt::one() << 128usize) + 1)), vec![("59649589127497217".parse().unwrap(), 1), ("5704689200685129054721".parse().unwrap(), 1)]);
    }
}
