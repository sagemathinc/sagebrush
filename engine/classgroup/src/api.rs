//! The public surface used by the bindings (WebAssembly JSON, Python):
//! plain data in and out.  Polynomials are integer coefficient vectors,
//! constant term first; elements of a number field K = Q[x]/(f) are given
//! on the power basis 1, a, ..., a^(n-1) as numerators with one denominator.

use crate::nf::embed::Embeddings;
use crate::nf::order::{maximal_order, Order};
use crate::nf::zlin::{hnf, vec_mat, ZMat};
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use sagebrush_bigint::BigRational;
use num_traits::{One, Signed, Zero};

/// The factorization of n != 0 as (prime, exponent), primes ascending
/// (probable primes beyond 3.3e24).  A composite that cannot be split
/// (beyond 1024 bits) is an error, never reported as a prime.
pub fn factor_integer(n: &BigInt) -> Result<Vec<(BigInt, u32)>, String> {
    if n.abs() <= BigInt::one() {
        return Ok(vec![]);
    }
    crate::nf::factor::factor(n)
}

/// Whether n is (probably: Miller-Rabin to 20 bases, proven below 3.3e24)
/// prime; false for n < 2 (Astra's audit, F7: -7 was "prime").
pub fn is_prime(n: &BigInt) -> bool {
    *n >= BigInt::from(2) && crate::nf::factor::is_probable_prime(n)
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
    /// w is proven (the roots of unity found, verified exactly, are all
    /// there can be by the residue fields); else w is a lower bound
    pub w_proven: bool,
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
    let (o, _) = maximal_order(f)?;
    let disc = o.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &disc).abs());
    let (r1, r2, w, w_proven) = if o.n == 1 {
        (1, 0, 2, true)
    } else {
        let ro = crate::nf::embed::reduce_order(&o)?;
        let emb = Embeddings::new(&ro)?;
        let (w, proven) = roots_of_unity(&ro, &emb);
        (emb.r1, emb.r2, w, proven)
    };
    // the HNF of the numerators: upper triangular over 1, a, a^2, ...,
    // entries above each pivot reduced (the same basis as PARI's nfbasis,
    // so as Sage's integral_basis)
    let b = hnf(&o.basis);
    Ok(NfData { degree: o.n, r1, r2, disc, index, basis: b, den: o.den.clone(), w, w_proven })
}

/// The number of roots of unity in K, and whether it is proven.  The x with
/// T2(x) = n are exactly the roots of unity (Kronecker); those the
/// enumeration finds numerically are each verified exactly (x^m = 1), so
/// their number L is a lower bound.  An upper bound U: for a prime p not
/// dividing disc(f), the roots of unity of order prime to p inject into each
/// residue field, so their number divides p^d - 1 for every residue degree d
/// (the degrees of the factors of f mod p); for each prime l, take the
/// least power of l allowed by the primes p != l (up to 40 of them: in
/// Q(zeta_20) no prime below 41 splits completely, and the 2-part needs one
/// that does).  With a real embedding (the signature is certified), U = 2.
/// L = U proves w.
pub(crate) fn roots_of_unity(o: &Order, emb: &Embeddings) -> (u32, bool) {
    let n = o.n;
    let one: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect();
    let red = crate::nf::embed::lll(&one, emb);
    let g = emb.t2_gram(&red);
    let unit = o.one();
    // phi(m) <= n implies m <= 2 n^2
    let mmax = 2 * n * n + 2;
    let is_root_of_unity = |x: &[BigInt]| {
        let mut pw = x.to_vec();
        for _ in 0..mmax {
            if pw == unit {
                return true;
            }
            pw = o.mul(&pw, x);
        }
        false
    };
    let found = crate::nf::bnf::short_vectors(&g, n as f64 * (1.0 + 1e-9), 1000);
    let lower = found.iter().filter(|c| {
        let x: Vec<BigInt> = (0..n).map(|k| c.iter().zip(&red).map(|(ci, r)| BigInt::from(*ci) * &r[k]).sum()).collect();
        is_root_of_unity(&x)
    }).count() as u64;
    // the upper bound from residue fields
    let disc = Order::equation_order(&o.f).disc();
    let small: Vec<u64> = (2..=(n as u64 + 1)).filter(|&l| crate::relations::is_prime_u64(l)).collect();
    let mut gs: Vec<(u64, BigInt)> = vec![];
    let mut p = 2u64;
    while emb.r1 == 0 && gs.len() < 40 && p < 5000 {
        p += 1;
        if !crate::relations::is_prime_u64(p) || (&disc % BigInt::from(p)).is_zero() {
            continue;
        }
        let gp = sagebrush_poly::factor_mod(&o.f, p).iter().fold(BigInt::zero(), |acc, (fac, e)| {
            let _ = e;
            num_integer::Integer::gcd(&acc, &(num_traits::pow(BigInt::from(p), fac.len() - 1) - 1u32))
        });
        gs.push((p, gp));
    }
    let mut upper = 1u64;
    if emb.r1 > 0 {
        return (lower as u32, lower == 2);
    }
    for &l in &small {
        let lb = BigInt::from(l);
        let e = gs.iter().filter(|(p, _)| *p != l).map(|(_, gp)| {
            let (mut v, mut t) = (0u32, gp.clone());
            while !t.is_zero() && (&t % &lb).is_zero() && v < 64 {
                t /= &lb;
                v += 1;
            }
            v
        }).min().unwrap_or(64);
        // phi(l^e) <= n
        let mut k = 0;
        while k < e && (l - 1) * l.pow(k) <= n as u64 {
            k += 1;
        }
        upper = upper.saturating_mul(l.pow(k));
    }
    (lower as u32, lower == upper && gs.len() >= 2)
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
    let (o, _) = maximal_order(f)?;
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
    /// the number of roots of unity, and whether that is proven
    pub w: u32,
    pub w_proven: bool,
    /// h and the regulator proven under GRH alone (the analytic
    /// certificate, nf/certify.rs)
    pub certified: bool,
}

/// A decimal string of x / 2^prec with `digits` significant digits.
pub fn fixed_to_decimal(x: &BigInt, prec: u32, digits: usize) -> String {
    // `digits` significant digits of x / 2^prec: fixed notation from 10^-4
    // up, scientific below (10^-100 printed as 0.000... to 30 decimals was
    // 0: the third review's T6)
    if x.is_zero() {
        return "0".into();
    }
    let digits = digits.max(1);
    let neg = x.is_negative();
    let x = x.abs();
    let sign = if neg { "-" } else { "" };
    let one = BigInt::one() << prec as usize;
    let half = BigInt::one() << (prec as usize).saturating_sub(1);
    let ten = BigInt::from(10);
    // round(x 10^k / 2^prec)
    let round = |k: usize| (&x * ten.pow(k as u32) + &half) >> prec as usize;
    if x >= one {
        let int_digits = (&x >> prec as usize).to_string().len();
        let mut frac_digits = digits.saturating_sub(int_digits).max(1);
        let mut scaled = round(frac_digits);
        // rounding up into a new integer digit (9.99... to 10.00...): one
        // fractional digit fewer, for the same number of significant digits
        if frac_digits > 1 && digits > int_digits && scaled.to_string().len() > frac_digits.max(digits) {
            frac_digits -= 1;
            scaled = round(frac_digits);
        }
        let s = format!("{:0>width$}", scaled.to_string(), width = frac_digits + 1);
        let (a, b) = s.split_at(s.len() - frac_digits);
        return format!("{}{}.{}", sign, a, b);
    }
    // x < 1: z zeros after the point, then the first significant digit
    let mut z = 0usize;
    let mut t = &x * &ten;
    while t < one {
        t *= &ten;
        z += 1;
    }
    let mut m = round(z + digits);
    if m.to_string().len() > digits {
        // rounded up to the next power of 10
        if z == 0 {
            return format!("{}1.{}", sign, "0".repeat(digits - 1).max("0".into()));
        }
        z -= 1;
        m = round(z + digits);
    }
    let ms = format!("{:0>width$}", m.to_string(), width = digits);
    if z < 4 {
        return format!("{}0.{}{}", sign, "0".repeat(z), ms);
    }
    let (a, b) = ms.split_at(1);
    format!("{}{}.{}e-{}", sign, a, if b.is_empty() { "0" } else { b }, z + 1)
}

pub fn bnf(f: &[BigInt]) -> Result<BnfData, String> {
    monic(f)?;
    if f.len() == 2 {
        return Ok(BnfData { degree: 1, r1: 1, r2: 0, disc: BigInt::one(), h: BigInt::one(), cyc: vec![], regulator: "1".into(), w: 2, w_proven: true, certified: true });
    }
    let (b, _) = crate::nf::bnf::bnfinit(f)?;
    let regulator = if b.prec == 0 { "1".to_string() } else { fixed_to_decimal(&b.reg_fixed, b.prec, b.reg_digits) };
    Ok(BnfData { degree: b.n, r1: b.r1, r2: b.r2, disc: b.disc, h: b.group.h, cyc: b.group.cyc, regulator, w: b.w, w_proven: b.w_proven, certified: b.certified })
}

/// The factor-base relations of a certified class group computation, with
/// all prime ideals above the rational primes `extra` in the factor base:
/// (bnf data, factor base (p, e, f), relations (column, exponent), and the
/// relation elements over the power basis (numerators, common denominator)).
pub struct RelationData {
    pub bnf: BnfData,
    pub fb: Vec<(u64, u32, u32)>,
    pub rels: Vec<Vec<(usize, i64)>>,
    pub elems: Vec<(Vec<BigInt>, BigInt)>,
}

pub fn bnf_relations(f: &[BigInt], extra: &[u64]) -> Result<RelationData, String> {
    monic(f)?;
    if f.len() < 3 {
        return Err("the degree must be at least 2".into());
    }
    let (b, _, r) = crate::nf::bnf::bnfinit_with(f, extra)?;
    let regulator = if b.prec == 0 { "1".to_string() } else { fixed_to_decimal(&b.reg_fixed, b.prec, b.reg_digits) };
    let bnf = BnfData { degree: b.n, r1: b.r1, r2: b.r2, disc: b.disc, h: b.group.h, cyc: b.group.cyc, regulator, w: b.w, w_proven: b.w_proven, certified: b.certified };
    let elems = r.elems.iter().map(|x| {
        // power-basis coordinates: x B / den
        let n = r.order.n;
        let num: Vec<BigInt> = (0..n).map(|j| (0..n).map(|i| &x[i] * &r.order.basis[i][j]).sum()).collect();
        (num, r.order.den.clone())
    }).collect();
    Ok(RelationData { bnf, fb: r.fb.iter().map(|q| (q.p, q.e, q.f)).collect(), rels: r.rels, elems })
}

/// Class group of the quadratic field of fundamental discriminant d (and
/// the regulator, d > 0), by the quadratic algorithms.
pub fn quadratic(d: &BigInt) -> Result<(BigInt, Vec<BigInt>, Option<String>, bool), String> {
    if d.is_negative() {
        let (g, _, certified) = crate::imag::class_group_certified(d)?;
        Ok((g.h, g.cyc, None, certified))
    } else {
        let (r, _) = crate::realq::class_group_real(d)?;
        Ok((r.group.h, r.group.cyc, Some(fixed_to_decimal(&r.reg_fixed, r.prec, r.reg_digits)), r.certified))
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
            sagebrush_interrupt::check();
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
        sagebrush_interrupt::check();
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
    let mut f = f.to_vec();
    while f.last().is_some_and(|c| c.is_zero()) {
        f.pop();
    }
    if f.is_empty() {
        return Err("the roots of the zero polynomial".into());
    }
    let f = &f[..];
    if f.len() < 2 {
        return Ok(vec![]);
    }
    // (a nonzero root is at least 2^-(coefficient bits) in size: enough
    // bits for its significant digits)
    let cbits = f.iter().map(|c| c.bits()).max().unwrap_or(1) as u32;
    let prec = (digits as f64 * 3.33) as u32 + 40 + cbits;
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

/// All n roots of a square-free integer polynomial, fixed point (re, im),
/// isolated in certified disks of radius below 2^-prec (nf/roots.rs); real
/// roots have im = 0 exactly.
fn roots_squarefree(g: &[BigInt], prec: u32) -> Result<Vec<(BigInt, BigInt)>, String> {
    let iso = crate::nf::roots::isolate(g, prec)?;
    let _ = vec_mat::<BigInt>;
    Ok(iso.centers(prec))
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
        assert_eq!(factor_integer(&((BigInt::one() << 128usize) + 1)).unwrap(), vec![("59649589127497217".parse().unwrap(), 1), ("5704689200685129054721".parse().unwrap(), 1)]);
    }
}
#[cfg(test)]
mod decimal_tests {
    use super::*;
    #[test]
    fn rounding_up_keeps_the_digit_count() {
        let p = 200u32;
        // 1 - 2^-110 rounds up at 30 digits
        let almost_one = (BigInt::one() << 200usize) - (BigInt::one() << 90usize);
        assert_eq!(fixed_to_decimal(&almost_one, p, 30), "1.00000000000000000000000000000");
        assert_eq!(fixed_to_decimal(&(BigInt::one() << 200usize), p, 30), "1.00000000000000000000000000000");
        assert_eq!(fixed_to_decimal(&((BigInt::one() << 200usize) - (BigInt::one() << 100usize)), p, 30), "0.999999999999999999999999999999");
        // small values: significant digits, scientific below 10^-4
        let tenth = ((BigInt::one() << 200usize) + 5u32) / 10u32;
        assert_eq!(fixed_to_decimal(&tenth, p, 5), "0.10000");
        let tiny = (BigInt::one() << 700usize) / num_traits::pow(BigInt::from(10), 100);
        assert_eq!(fixed_to_decimal(&tiny, 700, 30), "1.00000000000000000000000000000e-100");
        assert_eq!(fixed_to_decimal(&-(BigInt::from(3) << 190usize), p, 4), "-0.002930");
        assert_eq!(fixed_to_decimal(&-(BigInt::from(3) << 199usize), p, 5), "-1.5000");
    }
}
