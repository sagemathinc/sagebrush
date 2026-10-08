//! Class groups and units of number fields, assuming GRH, by Buchmann's
//! subexponential method (Cohen, A Course in Computational Algebraic Number
//! Theory, 6.5):
//!   * the prime ideals of norm below a bound T generate the class group:
//!     T from Belabas, Diaz y Diaz and Friedman's criterion with Grenie and
//!     Molteni's search (nf/grh.rs), typically well below the uniform
//!     4 log^2 |d_K| (Grenie and Molteni; Bach's was 12);
//!   * relations are small elements x of LLL-reduced ideals (O itself and
//!     the factor-base primes) whose norms factor over the factor base:
//!     (x) = prod P^v_P(x);
//!   * the relation lattice gives a multiple h* of h (as for quadratic
//!     fields), its kernel gives units, as integer combinations of the
//!     relation elements (a compact representation: no unit is ever
//!     expanded), whose logarithmic embeddings span a multiple of the unit
//!     lattice: covolume R*;
//!   * h* R* below sqrt 2 times the analytic estimate of h R proves both.

use super::embed::{lll, lll_weighted, Embeddings};
use super::order::{maximal_order, Order};
use super::prime::{decompose, factor_element_fast, PrimeIdeal};
use super::zlin::*;
use crate::imag::{lattice_group, ClassGroup, Timing};
use crate::linalg::{eliminate_with, independent_rows, kernel_crt, Reduced};
use crate::real::to_f64;
use crate::relations::Relation;
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use sagebrush_bigint::BigRational;
use num_traits::{One, Signed, ToPrimitive, Zero};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// Profiling counters (nanoseconds): ideal products, LLL, norms+factoring.
static T_MUL: AtomicU64 = AtomicU64::new(0);
static T_LLL: AtomicU64 = AtomicU64::new(0);
static T_FAC: AtomicU64 = AtomicU64::new(0);
static N_CAND: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct Bnf {
    pub n: usize,
    pub r1: usize,
    pub r2: usize,
    pub disc: BigInt,
    pub group: ClassGroup,
    /// the regulator (1 when the unit rank is 0), and to `prec` bits
    pub regulator: f64,
    pub reg_fixed: BigInt,
    pub prec: u32,
    /// the number of roots of unity
    pub w: u32,
}

fn euler_phi(mut k: u64) -> u64 {
    let mut r = k;
    let mut p = 2;
    while p * p <= k {
        if k % p == 0 {
            while k % p == 0 {
                k /= p;
            }
            r -= r / p;
        }
        p += 1;
    }
    if k > 1 {
        r -= r / k;
    }
    r
}

/// Enumerate the integer vectors x != 0 with x^T G x <= bound (Fincke-Pohst
/// on the Cholesky decomposition of the Gram matrix G), up to `limit`.
pub fn short_vectors(g: &[Vec<f64>], bound: f64, limit: usize) -> Vec<Vec<i64>> {
    let k = g.len();
    // q: G = sum_i q_ii (x_i + sum_{j>i} q_ij x_j)^2
    let mut q = vec![vec![0.0f64; k]; k];
    for i in 0..k {
        for j in i..k {
            q[i][j] = g[i][j];
        }
    }
    for i in 0..k {
        for j in i + 1..k {
            q[j][i] = q[i][j];
            q[i][j] /= q[i][i];
        }
        for l in i + 1..k {
            for j in l..k {
                q[l][j] -= q[l][i] * q[i][j];
            }
        }
    }
    let mut out = vec![];
    let mut x = vec![0i64; k];
    fn rec(i: usize, q: &[Vec<f64>], x: &mut Vec<i64>, left: f64, out: &mut Vec<Vec<i64>>, limit: usize) {
        if out.len() >= limit {
            return;
        }
        let k = q.len();
        let c: f64 = -(i + 1..k).map(|j| q[i][j] * x[j] as f64).sum::<f64>();
        let r = (left / q[i][i]).max(0.0).sqrt();
        let (lo, hi) = ((c - r).ceil() as i64, (c + r).floor() as i64);
        for v in lo..=hi {
            sagebrush_interrupt::check();
            x[i] = v;
            let t = q[i][i] * (v as f64 - c).powi(2);
            if t > left + 1e-9 {
                continue;
            }
            if i == 0 {
                if x.iter().any(|&y| y != 0) {
                    out.push(x.clone());
                }
            } else {
                rec(i - 1, q, x, left - t, out, limit);
            }
            if out.len() >= limit {
                break;
            }
        }
        x[i] = 0;
    }
    if k > 0 {
        rec(k - 1, &q, &mut x, bound, &mut out, limit);
    }
    out
}

/// The residue of zeta_K at 1 by Bach's weighted average of truncated
/// Euler products prod_p (1 - 1/p) / prod_{P | p} (1 - 1/N P), x <= i < 2x.
/// The splitting of every prime p <= bound: (p, [(f, e)]), from the
/// factorization of the defining polynomial mod p unless p divides the index.
fn splitting(o: &Order, dk: &BigInt, index: &BigInt, bound: u64) -> Vec<(u64, Vec<(u32, u32)>)> {
    crate::arith::primes_up_to(bound)
        .into_iter()
        .map(|p| {
            let degs: Vec<(u32, u32)> = if (index % p).is_zero() {
                decompose(o, dk, p).map(|v| v.iter().map(|q| (q.f, q.e)).collect()).unwrap_or_default()
            } else {
                sagebrush_poly::factor_mod(&o.f, p).iter().map(|(g, e)| ((g.len() - 1) as u32, *e)).collect()
            };
            (p, degs)
        })
        .collect()
}

fn residue_estimate(split: &[(u64, Vec<(u32, u32)>)], x: u64) -> f64 {
    let primes: Vec<u64> = split.iter().map(|s| s.0).take_while(|&p| p <= 2 * x).collect();
    let mut local = vec![0.0f64; primes.len()];
    for (k, (p, degs)) in split.iter().take(primes.len()).enumerate() {
        let pf = *p as f64;
        let mut l = (1.0 - 1.0 / pf).ln();
        for &(f, _) in degs {
            l -= (1.0 - pf.powi(-(f as i32))).ln();
        }
        local[k] = l;
    }
    let (mut num, mut den) = (0.0f64, 0.0f64);
    let mut acc = 0.0;
    let mut k = 0;
    for i in 1..2 * x {
        while k < primes.len() && primes[k] <= i {
            acc += local[k];
            k += 1;
        }
        if i >= x {
            let w = i as f64 * (i as f64).ln();
            num += w * acc;
            den += w;
        }
    }
    (num / den).exp()
}

/// The lattice spanned by vectors in R^r (fixed point, 2^prec, each within
/// `err` units of the truth) that lie in a lattice of rank r: a basis and
/// its covolume (fixed point, 2^(prec r)).  Each further vector is written
/// in the current basis, its coordinates identified as exact rationals
/// (continued fractions, with a tolerance from the error), and the basis
/// replaced by that of the lattice they generate (HNF).  None if an
/// identification fails (precision too low) or the rank stays below r.
/// Is v (approximately) an integer combination of the rows of `basis`, by
/// coordinates from the f64 inverse?  The rounded combination is checked
/// exactly: the residual must be within the error, as the f64 coordinates
/// are unreliable for an ill-conditioned basis.
fn in_lattice_f64(basis: &ZMat, inv: &[Vec<f64>], v: &[BigInt], err: &BigInt, prec: u32) -> bool {
    let r = basis.len();
    let vf: Vec<f64> = v.iter().map(|x| to_f64(x, prec)).collect();
    let cf: Vec<f64> = (0..r).map(|j| (0..r).map(|i| vf[i] * inv[i][j]).sum()).collect();
    if !cf.iter().all(|c| c.abs() < 1e15 && (c - c.round()).abs() < 1e-3) {
        return false;
    }
    let ci: Vec<i64> = cf.iter().map(|c| c.round() as i64).collect();
    let tol = err * 64 * (1 + ci.iter().map(|c| c.unsigned_abs()).sum::<u64>());
    (0..v.len()).all(|j| {
        let comb: BigInt = ci.iter().zip(basis).map(|(&c, row)| &row[j] * c).sum();
        (&v[j] - comb).abs() <= tol
    })
}

fn unit_lattice(vs: &[Vec<BigInt>], r: usize, err: &BigInt, prec: u32) -> Option<(ZMat, BigInt)> {
    let p = prec as usize;
    let small = err * 64;
    let uld = std::env::var("QCL_UL").is_ok();
    let mut basis: ZMat = vec![];
    let mut fast_inv: Option<Vec<Vec<f64>>> = None;
    for v in vs {
        sagebrush_interrupt::check();
        if v.iter().all(|x| x.abs() <= small) {
            continue; // a torsion unit
        }
        // coordinates c with c B = v, exactly for the approximate data, over
        // the r coordinates (B square once full)
        let k = basis.len();
        if k < r {
            let mut trial = basis.clone();
            trial.push(v.clone());
            if independent_exact(&trial, err) {
                basis = trial;
                if basis.len() == r {
                    fast_inv = inverse_f64(&basis, prec);
                }
                continue;
            }
        }
        if k == 0 {
            continue;
        }
        if k == r {
            // already in the lattice? (f64 coordinates near integers)
            if fast_inv.as_ref().is_some_and(|inv| in_lattice_f64(&basis, inv, v, err, prec)) {
                continue;
            }
        }
        let Some(c) = solve_rows(&basis, v) else {
            if uld { eprintln!("      UL: solve_rows failed (k = {})", k); }
            return None;
        };
        // identify each c_j: first convergent within the tolerance
        let bf: Vec<Vec<f64>> = basis.iter().map(|row| row.iter().map(|x| to_f64(x, prec)).collect()).collect();
        let scale = bf.iter().flatten().map(|x| x.abs()).fold(0.0, f64::max).max(1e-300);
        let min_len = bf.iter().map(|row| row.iter().map(|x| x * x).sum::<f64>().sqrt()).fold(f64::INFINITY, f64::min);
        let err_real = to_f64(err, prec).max(2f64.powi(-(prec as i32)));
        let csum: f64 = c.iter().map(|x| x.to_f64().unwrap_or(f64::INFINITY).abs()).sum::<f64>() + 1.0;
        let tol = 64.0 * err_real * csum * scale / (min_len * min_len).max(1e-300) * (r as f64);
        let mut rats = vec![];
        for cj in &c {
            match identify(cj, tol) {
                Some(q) => rats.push(q),
                None => {
                    if uld { eprintln!("      UL: identify failed: c ~ {:.3e}, tol {:.3e}", cj.to_f64().unwrap_or(f64::NAN), tol); }
                    return None;
                }
            }
        }
        // lattice generated by B and v: rows D e_j and D c, HNF, / D
        let d = rats.iter().fold(BigInt::one(), |l, q: &BigRational| l.lcm(q.denom()));
        if d.is_one() {
            continue; // already in the lattice
        }
        let mut gens: ZMat = (0..k).map(|i| (0..k).map(|j| if i == j { d.clone() } else { BigInt::zero() }).collect()).collect();
        gens.push(rats.iter().map(|q| (q * BigRational::from_integer(d.clone())).to_integer()).collect());
        let h = hnf(&gens);
        if h.len() != k {
            if uld { eprintln!("      UL: hnf rank {} != {}", h.len(), k); }
            return None;
        }
        // new basis = (H B) / D
        basis = h.iter().map(|hrow| {
            let comb = vec_mat(hrow, &basis);
            comb.into_iter().map(|x| {
                let (q, rem) = x.div_mod_floor(&d);
                if rem * 2 >= d { q + 1 } else { q }
            }).collect()
        }).collect();
        fast_inv = if basis.len() == r { inverse_f64(&basis, prec) } else { None };
    }
    if basis.len() < r {
        if uld { eprintln!("      UL: rank {} < {} after {} vectors", basis.len(), r, vs.len()); }
        return None;
    }
    let det = crate::linalg::det(&basis).abs();
    let _ = p;
    Some((basis, det))
}

/// The inverse of a square fixed-point matrix in f64 (None if not finite:
/// it is only a shortcut).
fn inverse_f64(m: &ZMat, prec: u32) -> Option<Vec<Vec<f64>>> {
    let r = m.len();
    let mut a: Vec<Vec<f64>> = m.iter().enumerate().map(|(i, row)| row.iter().map(|x| to_f64(x, prec)).chain((0..r).map(|j| (i == j) as i32 as f64)).collect()).collect();
    for c in 0..r {
        let piv = (c..r).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs())).unwrap();
        a.swap(c, piv);
        let d = a[c][c];
        for x in a[c].iter_mut() {
            *x /= d;
        }
        let pr = a[c].clone();
        for (i, row) in a.iter_mut().enumerate() {
            if i != c {
                let f = row[c];
                for (x, y) in row.iter_mut().zip(&pr) {
                    *x -= f * y;
                }
            }
        }
    }
    let inv: Vec<Vec<f64>> = a.into_iter().map(|row| row[r..].to_vec()).collect();
    inv.iter().flatten().all(|x| x.is_finite()).then_some(inv)
}

/// Whether k fixed-point rows (k <= their length), each entry within err of
/// the truth, are linearly independent: some k x k minor exceeds what the
/// errors alone could produce (k! max|entry|^(k-1) err, with a margin).
/// Exact, so nearly parallel vectors (common: units that are huge powers)
/// are told apart whenever the precision allows.
fn independent_exact(rows: &ZMat, err: &BigInt) -> bool {
    let k = rows.len();
    let m = rows[0].len();
    let maxabs = rows.iter().flatten().map(|x| x.abs()).max().unwrap_or_default();
    let fact: BigInt = (1..=k as u64).map(BigInt::from).product();
    let noise = fact * maxabs.pow(k as u32 - 1) * err << 20usize;
    // the k-subsets of the m columns
    let mut cols: Vec<usize> = (0..k).collect();
    loop {
        let minor: ZMat = rows.iter().map(|row| cols.iter().map(|&c| row[c].clone()).collect()).collect();
        if crate::linalg::det(&minor).abs() > noise {
            return true;
        }
        // next combination
        let mut i = k;
        while i > 0 && cols[i - 1] == m - k + i - 1 {
            i -= 1;
        }
        if i == 0 {
            return false;
        }
        cols[i - 1] += 1;
        for j in i..k {
            cols[j] = cols[j - 1] + 1;
        }
    }
}


/// c with c B = v over Q (B: k rows of length r, rank k; uses k independent
/// columns).
fn solve_rows(b: &ZMat, v: &[BigInt]) -> Option<Vec<BigRational>> {
    let k = b.len();
    let r = v.len();
    // choose k independent columns greedily
    let mut cols = vec![];
    for j in 0..r {
        let mut trial = cols.clone();
        trial.push(j);
        let m: ZMat = b.iter().map(|row| trial.iter().map(|&c| row[c].clone()).collect()).collect();
        // rank of the k x |trial| matrix = |trial|?
        let t: ZMat = (0..trial.len()).map(|a| (0..k).map(|i| m[i][a].clone()).collect()).collect();
        if hnf(&t).len() == trial.len() {
            cols = trial;
        }
        if cols.len() == k {
            break;
        }
    }
    if cols.len() < k {
        return None;
    }
    let m: QMat = (0..k).map(|i| cols.iter().map(|&c| BigRational::from_integer(b[i][c].clone())).collect()).collect();
    let inv = inverse(&m);
    let vv: Vec<BigRational> = cols.iter().map(|&c| BigRational::from_integer(v[c].clone())).collect();
    Some(vec_mat(&vv, &inv))
}

/// The first continued-fraction convergent of x within tol.
fn identify(x: &BigRational, tol: f64) -> Option<BigRational> {
    let (mut h1, mut h2) = (BigInt::one(), BigInt::zero());
    let (mut k1, mut k2) = (BigInt::zero(), BigInt::one());
    let mut y = x.clone();
    for _ in 0..2000 {
        let a = y.floor().to_integer();
        let h = &a * &h1 + &h2;
        let k = &a * &k1 + &k2;
        let conv = BigRational::new(h.clone(), k.clone());
        let diff = (&conv - x).abs().to_f64().unwrap_or(f64::INFINITY);
        if diff <= tol {
            return Some(conv);
        }
        let frac = &y - BigRational::from_integer(a);
        if frac.is_zero() {
            return Some(conv);
        }
        y = frac.recip();
        (h2, h1) = (h1, h);
        (k2, k1) = (k1, k);
    }
    None
}

/// Log-weights uniform in [-t, t] (none when t = 0).
fn random_weights(k: usize, t: f64, rng: &mut u64) -> Vec<f64> {
    if t == 0.0 {
        return vec![];
    }
    (0..k).map(|_| {
        *rng ^= *rng << 13;
        *rng ^= *rng >> 7;
        *rng ^= *rng << 17;
        ((*rng % 20001) as f64 / 10000.0 - 1.0) * t
    }).collect()
}

/// The HNF of the product of two ideals given by Z-bases.
fn ideal_mul(o: &Order, a: &ZMat, b: &ZMat) -> ZMat {
    let t = crate::clock::Instant::now();
    let r = ideal_mul_impl(o, a, b);
    T_MUL.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
    r
}

fn ideal_mul_impl(o: &Order, a: &ZMat, b: &ZMat) -> ZMat {
    // the product contains N(A) N(B) O: an HNF modulo that keeps entries small
    let n = o.n;
    let na: BigInt = (0..n).map(|i| a[i][i].clone()).product();
    let nb: BigInt = (0..n).map(|i| b[i][i].clone()).product();
    let m = (na * nb).abs();
    let mut gens: ZMat = (0..n).map(|i| (0..n).map(|j| if i == j { m.clone() } else { BigInt::zero() }).collect()).collect();
    for x in a {
        for y in b {
            gens.push(o.mul(x, y).into_iter().map(|c| c.mod_floor(&m)).collect());
        }
    }
    hnf_mod_d(&gens, &m)
}

/// The HNF of a full-rank lattice containing d Z^n (rows include d e_i),
/// reducing entries modulo d along the way.
fn hnf_mod_d(rows: &ZMat, d: &BigInt) -> ZMat {
    let n = rows[0].len();
    let mut w: ZMat = (0..n).map(|i| (0..n).map(|j| if i == j { d.clone() } else { BigInt::zero() }).collect()).collect();
    for r in rows {
        let mut v: Vec<BigInt> = r.iter().map(|x| x.mod_floor(d)).collect();
        for i in 0..n {
            if v[i].is_zero() {
                continue;
            }
            let e = w[i][i].extended_gcd(&v[i]);
            let (g, x, y) = (e.gcd, e.x, e.y);
            let (wi, vi) = (&w[i][i] / &g, &v[i] / &g);
            let wrow = w[i].clone();
            for j in i..n {
                let nw = (&x * &wrow[j] + &y * &v[j]).mod_floor(d);
                let nv = (&wi * &v[j] - &vi * &wrow[j]).mod_floor(d);
                w[i][j] = nw;
                v[j] = nv;
            }
            w[i][i] = g;
        }
    }
    // a true HNF basis of L + d Z^n: rows with diagonal d/(product) fixed
    // up by adding d e_i rows (diagonals divide d here), then reduce
    let mut all = w;
    for i in 0..n {
        all.push((0..n).map(|j| if i == j { d.clone() } else { BigInt::zero() }).collect());
    }
    hnf(&all)
}

struct Field {
    o: Order,
    /// the product of the factor base's rational primes
    primorial: BigInt,
    /// log of the factor-base bound
    log_bound: f64,
    emb: Embeddings,
    fb: Vec<PrimeIdeal>,
    by_p: HashMap<u64, Vec<usize>>,
    /// fb[..ngen], the primes of norm below the bound, are the columns;
    /// relations with the others are dropped (they are not needed to
    /// generate, and rarely occur)
    ngen: usize,
}

/// Relations from small elements of the LLL-reduced ideal with basis `ib`.
fn relations_from(fld: &Field, ib: &ZMat, budget: usize, seen: &mut HashSet<Vec<(usize, i64)>>, rels: &mut Vec<Relation>, elems: &mut Vec<Vec<BigInt>>, rng: &mut u64) -> usize {
    relations_weighted(fld, ib, budget, &[], seen, rels, elems, rng)
}

/// relations_from, reducing for the weighted form with log-weights s:
/// small elements are then skewed (log |sigma_j(x)| near c - s_j), so that
/// the units they combine to are not all small.
#[allow(clippy::too_many_arguments)]
fn relations_weighted(fld: &Field, ib: &ZMat, budget: usize, s_log: &[f64], seen: &mut HashSet<Vec<(usize, i64)>>, rels: &mut Vec<Relation>, elems: &mut Vec<Vec<BigInt>>, rng: &mut u64) -> usize {
    // log N(I) from the HNF diagonal
    let log_ni: f64 = (0..ib.len()).map(|i| ib[i][i].to_f64().unwrap_or(1.0).abs().max(1.0).ln()).sum();
    let t = crate::clock::Instant::now();
    let red = if s_log.is_empty() { lll(ib, &fld.emb) } else { lll_weighted(ib, &fld.emb, s_log) };
    T_LLL.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
    let n = red.len();
    let mut found = 0;
    let mut tried = 0;
    let mut next = || {
        *rng ^= *rng << 13;
        *rng ^= *rng >> 7;
        *rng ^= *rng << 17;
        *rng
    };
    while tried < budget {
        sagebrush_interrupt::check();
        tried += 1;
        // the basis vectors, then random small combinations
        let coef: Vec<i64> = if tried <= n { (0..n).map(|j| (j + 1 == tried) as i64).collect() } else { (0..n).map(|_| (next() % 5) as i64 - 2).collect() };
        if coef.iter().all(|&c| c == 0) {
            continue;
        }
        let mut x = vec![BigInt::zero(); fld.o.n];
        for (c, b) in coef.iter().zip(&red) {
            if *c != 0 {
                for (xi, bi) in x.iter_mut().zip(b) {
                    *xi += bi * *c;
                }
            }
        }
        // skip norms too big to be smooth with useful probability: the
        // cofactor N(x)/N(I) as u = log / log B, at most 5
        let sg = fld.emb.sigma(&x);
        let log_n: f64 = sg.iter().enumerate().map(|(j, (re, im))| if j < fld.emb.r1 { re.abs().max(1e-300).ln() } else { (re * re + im * im).max(1e-300).ln() }).sum();
        if log_n - log_ni > 5.0 * fld.log_bound {
            continue;
        }
        let t = crate::clock::Instant::now();
        let fe = factor_element_fast(&fld.o, &fld.fb, &fld.by_p, &fld.primorial, &x);
        T_FAC.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
        N_CAND.fetch_add(1, Relaxed);
        if let Some(rel) = fe {
            if rel.is_empty() || rel.iter().any(|&(i, _)| i >= fld.ngen) || !seen.insert(rel.clone()) {
                continue;
            }
            rels.push(rel);
            elems.push(x);
            found += 1;
        }
    }
    found
}

/// The norms of the prime ideals below a bound, from the splitting data.
fn prime_norms(split: &[(u64, Vec<(u32, u32)>)], bound: f64) -> Vec<u64> {
    split.iter().take_while(|s| (s.0 as f64) < bound).flat_map(|(p, degs)| degs.iter().filter_map(move |&(f, _)| p.checked_pow(f))).collect()
}

/// (T, the uniform 4 log^2 |d_K|): under GRH the prime ideals of norm < T
/// generate the class group of Q[x]/(f).
pub fn class_group_generator_bound(f: &[BigInt]) -> (f64, f64) {
    let (o, _) = maximal_order(f);
    let dk = o.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &dk).abs());
    let r1 = Embeddings::new(&o).r1;
    let ld = dk.to_f64().unwrap().abs().ln();
    let t_unif = (4.0 * ld * ld).max(50.0);
    let split = splitting(&o, &dk, &index, t_unif as u64);
    (super::grh::class_group_bound(o.n, r1, ld, &prime_norms(&split, t_unif), t_unif), t_unif)
}

/// Belabas, Diaz y Diaz and Friedman's one-step bound, for comparison.
pub fn one_step_generator_bound(f: &[BigInt]) -> f64 {
    let (o, _) = maximal_order(f);
    let dk = o.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &dk).abs());
    let r1 = Embeddings::new(&o).r1;
    let ld = dk.to_f64().unwrap().abs().ln();
    let t_unif = (4.0 * ld * ld).max(50.0);
    let split = splitting(&o, &dk, &index, t_unif as u64);
    super::grh::one_step_bound(o.n, r1, ld, &prime_norms(&split, t_unif), t_unif)
}

pub fn bnfinit(f: &[BigInt]) -> Result<(Bnf, Timing), String> {
    bnfinit_with(f, &[]).map(|(b, t, _)| (b, t))
}

/// The relations behind a class group computation: valuation vectors over
/// the factor base and the elements (order coordinates) with those
/// factorizations.  Once the computation is certified (h R against the
/// analytic estimate) they generate the group of factor-base units.
#[derive(Clone, Debug)]
pub struct Relations {
    pub fb: Vec<PrimeIdeal>,
    pub rels: Vec<Relation>,
    pub elems: Vec<Vec<BigInt>>,
    pub order: Order,
}

/// bnfinit, with every prime ideal above the rational primes `extra` also
/// in the factor base (as columns), and the relations returned: so that the
/// S-units for S containing those primes can be read off.
pub fn bnfinit_with(f: &[BigInt], extra: &[u64]) -> Result<(Bnf, Timing, Relations), String> {
    let debug = std::env::var("QCL_DEBUG").is_ok();
    let t0 = crate::clock::Instant::now();
    let (o, _) = maximal_order(f);
    // a T2-reduced basis: the f64 work below needs a well-scaled one
    let o = super::embed::reduce_order(&o);
    let n = o.n;
    let dk = o.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &dk).abs());
    let emb = Embeddings::new(&o);
    let (r1, r2) = (emb.r1, emb.r2);
    let r = r1 + r2 - 1;
    // roots of unity: the x with T2(x) = n
    let ob: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect();
    let red = lll(&ob, &emb);
    let g = emb.t2_gram(&red);
    // (candidates with a loose bound, then exactly: x^k = 1 for some k with
    // phi(k) <= n; large roots of f make T2 in floating point inexact)
    let kmax = (1..=(4 * n * n + 6) as u64).filter(|&k| euler_phi(k) <= n as u64).max().unwrap();
    let one = o.one();
    let w = short_vectors(&g, n as f64 * (1.0 + 1e-4), 1000)
        .iter()
        .filter(|c| {
            let x: Vec<BigInt> = (0..n).map(|j| c.iter().zip(&red).map(|(&ci, b)| &b[j] * ci).sum()).collect();
            let mut y = x.clone();
            (1..=kmax).any(|_| {
                let done = y == one;
                y = o.mul(&y, &x);
                done
            })
        })
        .count()
        .max(2) as u32;
    // factor base: the prime ideals of norm < T, with T from Grenie and
    // Molteni's algorithm (nf/grh.rs), at most the uniform 4 log^2 |d_K|
    let ld = dk.to_f64().unwrap().abs().ln();
    let t_unif = (4.0 * ld * ld).max(50.0);
    let x = ((4.0 * ld * ld) as u64).clamp(1 << 10, 1 << 15);
    let split = splitting(&o, &dk, &index, (t_unif as u64).max(2 * x));
    let norms = prime_norms(&split, t_unif);
    let t_grh = if std::env::var("QCL_UNIFORM").is_ok() { t_unif } else { super::grh::class_group_bound(n, r1, ld, &norms, t_unif) };
    // the factor base itself may be larger than the proven bound needs (and
    // relations, for the units, need some primes)
    let fb_min: f64 = std::env::var("QCL_FBMIN").ok().and_then(|v| v.parse().ok()).unwrap_or(50.0);
    let bound = (t_grh.max(fb_min).ceil() as u64).max(2);
    // all primes above each p < bound (for factoring norms), those of norm
    // < bound (which generate the class group) first: only they are columns
    let mut above = vec![];
    for p in crate::arith::primes_up_to(bound - 1) {
        above.push((p, decompose(&o, &dk, p)?));
    }
    // every prime above an extra p is a column (also those of norm >= bound
    // above a small p)
    let mut extra: Vec<u64> = extra.to_vec();
    extra.sort();
    extra.dedup();
    for &p in extra.iter().filter(|&&p| p >= bound) {
        above.push((p, decompose(&o, &dk, p)?));
    }
    let small = |q: &PrimeIdeal| q.norm() < BigInt::from(bound) || extra.binary_search(&q.p).is_ok();
    let mut fb = vec![];
    let mut by_p: HashMap<u64, Vec<usize>> = HashMap::new();
    for pass in [true, false] {
        for (p, ps) in &above {
            for q in ps.iter().filter(|q| small(q) == pass) {
                by_p.entry(*p).or_default().push(fb.len());
                fb.push(q.clone());
            }
        }
    }
    let ngen = fb.iter().filter(|q| small(q)).count();
    let nfb = ngen;
    // h R estimate
    let res = residue_estimate(&split, x);
    let hr_est = res * w as f64 * dk.to_f64().unwrap().abs().sqrt() / (2f64.powi(r1 as i32) * (2.0 * std::f64::consts::PI).powi(r2 as i32));
    let primorial: BigInt = by_p.keys().map(|&p| BigInt::from(p)).product();
    let fld = Field { o, primorial, log_bound: (bound as f64).ln(), emb, fb, by_p, ngen };
    let mut tm = Timing { fb: nfb, h_est: hr_est, ..Default::default() };
    if debug {
        eprintln!("n {} r1 {} r2 {} d {} w {} fb {} (bound {}, GRH {:.0}, uniform {:.0}) hR est {:.6e} setup {:.1} ms", n, r1, r2, dk, w, nfb, bound, t_grh, t_unif, hr_est, t0.elapsed().as_secs_f64() * 1e3);
    }
    let mut rels: Vec<Relation> = vec![];
    let mut elems: Vec<Vec<BigInt>> = vec![];
    let mut seen = HashSet::new();
    let mut rng = 0x2545_F491_4F6C_DD1Du64;
    let mut forced: HashSet<usize> = HashSet::new();
    // the spread of the log-weights: about the size of the unit lattice per
    // dimension (log of (h R)^(1/r)), capped for f64
    let weight_t: f64 = std::env::var("QCL_T").ok().and_then(|v| v.parse().ok()).unwrap_or(if r == 0 { 0.0 } else { (hr_est.max(1.0).ln() / r as f64).clamp(2.0, 30.0) });
    let mut want = (1.4 * nfb as f64) as usize + 20 + 2 * r;
    let mut cache: Option<(u32, Vec<Vec<BigInt>>)> = None;
    for round in 0..60 {
        sagebrush_interrupt::check();
        tm.rounds = round + 1;
        let t = crate::clock::Instant::now();
        // relations: in the first round the trivial ones (p) = prod P^e and
        // a sweep over every factor-base prime; then the uncovered primes
        // first, and products P_i P_j of random primes for fresh relations
        let start = rels.len();
        let one: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as i32)).collect()).collect();
        if round == 0 {
            for (&p, idx) in fld.by_p.iter() {
                let rel: Relation = idx.iter().map(|&i| (i, fld.fb[i].e as i64)).collect();
                let mut rel = rel;
                rel.sort();
                if rel.iter().all(|&(i, _)| i < fld.ngen) && seen.insert(rel.clone()) {
                    rels.push(rel);
                    elems.push(fld.o.one().into_iter().map(|c| c * p).collect());
                }
            }
            relations_from(&fld, &one, 4 * n + 40, &mut seen, &mut rels, &mut elems, &mut rng);
            for i in 0..nfb {
                sagebrush_interrupt::check();
                let s_log = random_weights(r1 + r2, weight_t, &mut rng);
                relations_weighted(&fld, &fld.fb[i].basis.clone(), n + 2, &s_log, &mut seen, &mut rels, &mut elems, &mut rng);
            }
        }
        let mut counts = vec![0u32; nfb];
        for rel in &rels {
            for &(i, _) in rel {
                counts[i] += 1;
            }
        }
        // uncovered or rank-deficient primes: search until a new relation
        // contains them (P times random small primes, random weights)
        for i in (0..nfb).filter(|&i| counts[i] == 0 || forced.contains(&i)).collect::<Vec<_>>() {
            let nsmall = nfb.min(40);
            for attempt in 0..200 {
                sagebrush_interrupt::check();
                let before = rels.len();
                let ib = if attempt == 0 {
                    fld.fb[i].basis.clone()
                } else {
                    rng ^= rng << 13;
                    rng ^= rng >> 7;
                    rng ^= rng << 17;
                    ideal_mul(&fld.o, &fld.fb[i].basis, &fld.fb[(rng % nsmall as u64) as usize].basis)
                };
                let s_log = random_weights(r1 + r2, weight_t, &mut rng);
                relations_weighted(&fld, &ib, 2 * n + 4, &s_log, &mut seen, &mut rels, &mut elems, &mut rng);
                if rels[before..].iter().any(|rel| rel.iter().any(|&(j, _)| j == i)) {
                    break;
                }
            }
        }
        forced.clear();
        let mut passes = 0;
        while rels.len() < want && passes < 50 * nfb.max(10) {
            sagebrush_interrupt::check();
            passes += 1;
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let a = (rng % nfb as u64) as usize;
            let b = ((rng >> 32) % nfb as u64) as usize;
            let ib = ideal_mul(&fld.o, &fld.fb[a].basis, &fld.fb[b].basis);
            // random log-weights in [-T, T]: skewed elements give large units
            let s_log = random_weights(r1 + r2, weight_t, &mut rng);
            relations_weighted(&fld, &ib, 2 * n + 4, &s_log, &mut seen, &mut rels, &mut elems, &mut rng);
        }
        tm.sieve_s += t.elapsed().as_secs_f64();
        let t = crate::clock::Instant::now();
        if debug {
            eprintln!("round {}: {} relations (+{}); ideal products {:.0} ms, LLL {:.0} ms, norms+factoring {:.0} ms for {} candidates", round, rels.len(), rels.len() - start,
                T_MUL.load(Relaxed) as f64 / 1e6, T_LLL.load(Relaxed) as f64 / 1e6, T_FAC.load(Relaxed) as f64 / 1e6, N_CAND.load(Relaxed));
        }
        let mut more = (rels.len() / 5).max(10);
        let res = match eliminate_with(nfb, &rels, 80, None) {
            (Reduced::Deficient(col), _, _) => {
                if debug {
                    eprintln!("  column {} (norm {}) has no relation", col, fld.fb[col].norm());
                }
                forced.insert(col);
                None
            }
            (Reduced::Core(cols, dense), core_rows, _) => {
                let c = cols.len();
                tm.core = c;
                if debug {
                    eprintln!("  core: {} columns, {} rows", c, dense.len());
                }
                let sel_res = if c == 0 { Ok(vec![]) } else { independent_rows(&dense, c) };
                match sel_res {
                    Err(free) => {
                        if debug {
                            let desc: Vec<String> = free.iter().take(4).map(|&j| { let q = &fld.fb[cols[j]]; format!("p={} e={} f={}", q.p, q.e, q.f) }).collect();
                            eprintln!("  core not of full rank ({} free: {})", free.len(), desc.join("; "));
                        }
                        more = (4 * free.len()).max(10);
                        for j in free {
                            forced.insert(cols[j]);
                        }
                        None
                    }
                    Ok(sel) => try_units(&fld, &rels, &elems, nfb, &dense, &core_rows, c, &sel, r, hr_est, round as u64, &mut cache, debug),
                }
            }
        };
        tm.linalg_s += t.elapsed().as_secs_f64();
        if let Some((group, reg, reg_fixed, prec)) = res {
            tm.relations = rels.len();
            let relations = Relations { fb: fld.fb[..fld.ngen].to_vec(), rels, elems, order: fld.o };
            return Ok((Bnf { n, r1, r2, disc: dk, group, regulator: reg, reg_fixed, prec, w }, tm, relations));
        }
        want = rels.len() + more;
    }
    Err("no convergence".into())
}

/// Log embeddings (first r coordinates... all r1 + r2) of the relation
/// elements at `prec` bits, cached at the highest precision so far.
fn element_logs(fld: &Field, elems: &[Vec<BigInt>], prec: u32, cache: &mut Option<(u32, Vec<Vec<BigInt>>)>) -> Vec<Vec<BigInt>> {
    let need_new = cache.as_ref().map_or(true, |(p, _)| *p < prec);
    if need_new {
        let p = prec + prec / 4 + 16;
        let roots = fld.emb.roots_hp(&fld.o.f, p);
        let logs = elems.iter().map(|x| fld.emb.log_embedding(&fld.o, x, &roots, p)).collect();
        *cache = Some((p, logs));
    } else {
        let (p, logs) = cache.as_mut().unwrap();
        if logs.len() < elems.len() {
            let roots = fld.emb.roots_hp(&fld.o.f, *p);
            let pp = *p;
            logs.extend(elems[logs.len()..].iter().map(|x| fld.emb.log_embedding(&fld.o, x, &roots, pp)));
        }
    }
    let (p, logs) = cache.as_ref().unwrap();
    let shift = (*p - prec) as usize;
    logs[..elems.len()].iter().map(|l| l.iter().map(|x| x >> shift).collect()).collect()
}

/// A basis of {z in Z^k : z Y = 0 mod d} (Y: k rows y_t): the HNF of
/// [Y | I] together with [d I | 0], rows whose Y-part vanishes.
fn kernel_lattice(ys: &[Vec<BigInt>], d: &BigInt) -> Vec<Vec<BigInt>> {
    let k = ys.len();
    if k == 0 {
        return vec![];
    }
    let c = ys[0].len();
    let mut rows: ZMat = ys.iter().enumerate().map(|(t, y)| {
        y.iter().map(|x| x.mod_floor(d)).chain((0..k).map(|j| BigInt::from((j == t) as i32))).collect()
    }).collect();
    for j in 0..c {
        rows.push((0..c + k).map(|i| if i == j { d.clone() } else { BigInt::zero() }).collect());
    }
    hnf(&rows).into_iter().filter(|row| row[..c].iter().all(|x| x.is_zero())).map(|row| row[c..].to_vec()).collect()
}

/// Unit log vectors (first r coordinates) from zero rows and kernel vectors.
#[allow(clippy::too_many_arguments)]
fn unit_logs(fld: &Field, rels: &[Relation], elems: &[Vec<BigInt>], nfb: usize, core_rows: &[usize], sel: &[usize], det: &BigInt, ys: &[Vec<BigInt>], extras: &[usize], r: usize, prec: u32, cache: &mut Option<(u32, Vec<Vec<BigInt>>)>) -> Vec<Vec<BigInt>> {
    let mut logs = element_logs(fld, elems, prec, cache);
    let (_, core2, zero_rows) = eliminate_with(nfb, rels, 80, Some(&mut logs));
    assert_eq!(core2, core_rows);
    let m = logs.first().map_or(r + 1, |l| l.len());
    let mut full: Vec<Vec<BigInt>> = zero_rows.iter().map(|&k| logs[k].clone()).collect();
    let n_zero = full.len();
    // the full kernel of [A; v_1..v_k]: z with z Y = 0 mod det (Y rows y_t);
    // each z gives the unit with coefficients (sum z_t y_t)/det on A and -z_t
    // on the v_t (taking each v_t alone would give a sublattice of index up
    // to about det^(k-1))
    for z in kernel_lattice(ys, det) {
        let mut l = vec![BigInt::zero(); m];
        let c = sel.len();
        for i in 0..c {
            let s: BigInt = z.iter().zip(ys).map(|(zt, y)| zt * &y[i]).sum();
            let a = s / det;
            if a.is_zero() {
                continue;
            }
            for (x, b) in l.iter_mut().zip(&logs[core_rows[sel[i]]]) {
                *x += &a * b;
            }
        }
        for (zt, &e) in z.iter().zip(extras) {
            if zt.is_zero() {
                continue;
            }
            for (x, b) in l.iter_mut().zip(&logs[core_rows[e]]) {
                *x -= zt * b;
            }
        }
        full.push(l);
    }
    if std::env::var("QCL_CHECK").is_ok() {
        // every unit's full log vector sums to 0 (norm +-1)
        let worst = |v: &[Vec<BigInt>]| v.iter().map(|l| to_f64(&l.iter().sum::<BigInt>(), prec).abs()).fold(0.0, f64::max);
        eprintln!("    check at {} bits: {} zero-row units worst |sum| {:.3e}; {} kernel units worst {:.3e}", prec, n_zero, worst(&full[..n_zero]), full.len() - n_zero, worst(&full[n_zero..]));
    }
    let out: Vec<Vec<BigInt>> = full.into_iter().map(|l| l[..r].to_vec()).collect();
    out
}

#[allow(clippy::too_many_arguments)]
fn try_units(fld: &Field, rels: &[Relation], elems: &[Vec<BigInt>], nfb: usize, dense: &[Vec<i64>], core_rows: &[usize], c: usize, sel: &[usize], r: usize, hr_est: f64, seed: u64, cache: &mut Option<(u32, Vec<Vec<BigInt>>)>, debug: bool) -> Option<(ClassGroup, f64, BigInt, u32)> {
    let t = crate::clock::Instant::now();
    let ms = || t.elapsed().as_secs_f64() * 1e3;
    let group_of = |first_det: Option<BigInt>, enough: f64| -> Option<(BigInt, Vec<BigInt>)> {
        if c == 0 {
            Some((BigInt::one(), vec![]))
        } else {
            lattice_group(dense, c, sel, first_det, enough, seed, debug)
        }
    };
    if r == 0 {
        let (h, cyc) = group_of(None, std::f64::consts::SQRT_2 * hr_est)?;
        let ratio = h.to_f64().unwrap_or(f64::INFINITY) / hr_est;
        if debug {
            eprintln!("  h* / est {:.4}", ratio);
        }
        return (ratio <= std::f64::consts::SQRT_2).then(|| (ClassGroup { h, cyc }, 1.0, BigInt::one(), 0));
    }
    let in_sel: HashSet<usize> = sel.iter().cloned().collect();
    let others: Vec<usize> = (0..dense.len()).filter(|k| !in_sel.contains(k)).collect();
    let a: Vec<Vec<i64>> = sel.iter().map(|&k| dense[k].clone()).collect();
    // extra rows (each with A gives kernel vectors); more when R* is still
    // too big, more precision when the unit lattice cannot be identified
    let mut n_extra = r + 6;
    let mut prec = 0u32;
    let mut err_bits = 0u32;
    let mut lattice: Option<(BigInt, Vec<BigInt>)> = None;
    let mut last_r: Option<f64> = None;
    for _ in 0..12 {
        sagebrush_interrupt::check();
        let extras: Vec<usize> = if c == 0 || others.is_empty() { vec![] } else { (0..n_extra.min(others.len())).map(|t| others[t * 7919 % others.len()]).collect() };
        let vs: Vec<Vec<i64>> = extras.iter().map(|&k| dense[k].clone()).collect();
        // (det A also when there are no extra rows: it bounds the group,
        // and 1 there would make the HNF modulo 1 and h* = 1)
        let (det, ys) = if extras.is_empty() { (if c == 0 { BigInt::one() } else { crate::linalg::det_crt(&a).abs() }, vec![]) } else { kernel_crt(&a, &vs) };
        if prec == 0 {
            // The lambdas are exact integer combinations of the relations'
            // logarithms, so their errors are the rounding of those times
            // coefficients that can far exceed |lambda|.  Measure: two cheap
            // passes at 48 and 112 bits give the error at 48 bits.  Exact
            // identification of the unit lattice needs about the size of
            // the multipliers plus twice that of the denominators (both up
            // to |lambda|) beyond the error: 3 log2 |lambda| bits.
            let low = unit_logs(fld, rels, elems, nfb, core_rows, sel, &det, &ys, &extras, r, 48, cache);
            let mid = unit_logs(fld, rels, elems, nfb, core_rows, sel, &det, &ys, &extras, r, 112, cache);
            let lbits = mid.iter().flatten().map(|l| l.bits() as i64 - 112).max().unwrap_or(0).max(0) as u32;
            let ebits = low.iter().flatten().zip(mid.iter().flatten()).map(|(l, m)| ((l << 64usize) - m).bits() as i64 - 112).max().unwrap_or(0).max(0) as u32;
            err_bits = ebits + 48 + 16;
            prec = err_bits + 3 * lbits + 64;
            if debug {
                eprintln!("  kernel: det {} bits; |lambda| ~ 2^{}, error at 48 bits ~ 2^{}: precision {} at {:.1} ms", det.bits(), lbits, ebits, prec, ms());
            }
        }
        let lambdas = unit_logs(fld, rels, elems, nfb, core_rows, sel, &det, &ys, &extras, r, prec, cache);
        let err = BigInt::one() << err_bits as usize;
        let res = unit_lattice(&lambdas, r, &err, prec);
        let verified = res.as_ref().map(|(basis, cov)| {
            let reg = to_f64(&(cov >> (prec as usize * (r - 1))), prec);
            let inv = inverse_f64(basis, prec);
            let ok = reg > 0.2 && lambdas.iter().all(|v| {
                if v.iter().all(|x| x.abs() <= &err * 64) {
                    return true;
                }
                if inv.as_ref().is_some_and(|inv| in_lattice_f64(basis, inv, v, &err, prec)) {
                    return true;
                }
                match solve_rows(basis, v) {
                    Some(cs) => cs.iter().all(|q| {
                        let frac = q - q.round();
                        frac.abs().to_f64().unwrap_or(1.0) < 1e-6
                    }),
                    None => false,
                }
            });
            (reg, ok)
        });
        if debug {
            match &verified {
                Some((reg, ok)) => eprintln!("  precision {}: {} units, R* = {:.6e} (h R est {:.6e}){} at {:.1} ms", prec, lambdas.len(), reg, hr_est, if *ok { "" } else { " NOT VERIFIED" }, ms()),
                None => eprintln!("  precision {}: {} units, no unit lattice at {:.1} ms", prec, lambdas.len(), ms()),
            }
        }
        let reg = match verified {
            Some((reg, true)) => reg,
            Some((_, false)) => {
                prec *= 2;
                continue;
            }
            None => {
                // rank below r (need more units) or identification failed
                if lambdas.len() < 4 * r + 8 {
                    n_extra *= 2;
                }
                prec = prec * 3 / 2;
                continue;
            }
        };
        let (_, cov) = res.unwrap();
        if lattice.is_none() {
            lattice = Some(group_of(Some(det.clone()), std::f64::consts::SQRT_2 * hr_est / reg)?);
        }
        let (h, cyc) = lattice.clone().unwrap();
        let ratio = h.to_f64().unwrap_or(f64::INFINITY) * reg / hr_est;
        if debug {
            eprintln!("  h* R* / est {:.4} at {:.1} ms", ratio, ms());
        }
        if ratio <= std::f64::consts::SQRT_2 {
            let reg_fixed = &cov >> (prec as usize * (r - 1));
            return Some((ClassGroup { h, cyc }, reg, reg_fixed, prec));
        }
        // more units help only while R* is too big; once more leave it
        // unchanged, h* is (more relations needed)
        if ratio > 1e12 || last_r.is_some_and(|lr: f64| (lr - reg).abs() <= 1e-9 * reg) || extras.len() >= others.len() {
            break;
        }
        last_r = Some(reg);
        n_extra *= 2;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_lattice_recovers_covolume() {
        let prec = 200u32;
        let fx = |x: f64| BigInt::from((x * 2f64.powi(50)) as i64) << (prec as usize - 50);
        // a skewed rank-2 lattice
        let b1 = [fx(1013.25), fx(-7.5)];
        let b2 = [fx(3.125), fx(911.0625)];
        let mut rng = 12345u64;
        let mut vs = vec![];
        for _ in 0..40 {
            rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
            let a = (rng % 2001) as i64 - 1000;
            let b = ((rng >> 20) % 2001) as i64 - 1000;
            vs.push(vec![&b1[0] * a + &b2[0] * b, &b1[1] * a + &b2[1] * b]);
        }
        let (_, cov) = unit_lattice(&vs, 2, &BigInt::from(1u64 << 20), prec).unwrap();
        let want = 1013.25 * 911.0625 + 7.5 * 3.125;
        let got = to_f64(&(cov >> prec as usize), prec);
        assert!((got - want).abs() < 1e-6 * want, "{} vs {}", got, want);
    }

    #[test]
    fn square_core_uses_its_determinant() {
        // x^3 - 688422267 x - 6952331593386 (from the elliptic curve 1990d2),
        // with the primes above 199 in the factor base: (199) = P Q^2, and
        // the core after elimination was Q alone with the row [2].  Taking
        // det 1 there (no extra rows) gave h* = 1 from an index-2 lattice;
        // now the relations found must include Q to an odd power.
        let f: Vec<BigInt> = ["-6952331593386", "-688422267", "0", "1"].iter().map(|c| c.parse().unwrap()).collect();
        let (b, _, r) = bnfinit_with(&f, &[2, 3, 5, 199]).unwrap();
        assert_eq!(b.group.h, BigInt::one());
        let q = r.fb.iter().position(|q| q.p == 199 && q.e == 2).unwrap();
        assert!(r.rels.iter().any(|rel| rel.iter().any(|&(i, e)| i == q && e % 2 != 0)));
    }

    #[test]
    fn large_roots() {
        // a root near -87473: its fixed-point start used to overflow
        let f: Vec<BigInt> = [-95282, 82258, 87473, 1].iter().map(|&c| BigInt::from(c)).collect();
        let (o, _) = maximal_order(&f);
        let e = Embeddings::new(&o);
        let prec = 200;
        let hp = e.roots_hp(&o.f, prec);
        for (z, _) in &hp {
            // f(z) ~ 0 relative to the size of the terms
            let fz: BigInt = f.iter().rev().fold(BigInt::zero(), |acc, c| ((acc * z) >> prec as usize) + (c << prec as usize));
            let size = to_f64(z, prec).abs().max(1.0).powi(3);
            assert!(to_f64(&fz, prec).abs() < 1e-30 * size, "f(z) = {}", to_f64(&fz, prec));
        }
    }

    #[test]
    fn against_pari() {
        // bnfinit(f): disc, cyc, reg, number of roots of unity (PARI 2.17.4,
        // used as an oracle only)
        let cases: &[(&[i64], i64, &[u64], f64, u32)] = &[
            (&[23, 0, 1], -23, &[3], 1.0, 2),
            (&[-10, 0, 1], 40, &[2], 1.8184464592320668, 2),
            (&[-2, 0, 0, 1], -108, &[], 1.3473773483293841, 2),
            (&[-11, 0, 0, 1], -3267, &[2], 5.5872066260609078, 2),
            (&[1, 0, 0, 0, 1], 256, &[], 1.7627471740390861, 8),
            (&[-1, -1, 0, 1], -23, &[], 0.28119957432296185, 2),
            (&[1, 0, -10, 0, 1], 2304, &[], 2.6608985801903705, 2),
        ];
        for &(f, d, cyc, reg, w) in cases {
            let f: Vec<BigInt> = f.iter().map(|&c| BigInt::from(c)).collect();
            let (b, _) = bnfinit(&f).unwrap();
            assert_eq!(b.disc, BigInt::from(d));
            assert_eq!(b.group.cyc, cyc.iter().map(|&c| BigInt::from(c)).collect::<Vec<_>>(), "{:?}", f);
            assert!((b.regulator - reg).abs() < 1e-9 * reg, "{:?}: {} vs {}", f, b.regulator, reg);
            assert_eq!(b.w, w);
        }
    }

    /// Grenie and Molteni's example (arXiv:1507.00602, Section 4): T(K) =
    /// 19162 by Belabas, Diaz y Diaz and Friedman's one step, T_1(K) = 11071.
    #[test]
    fn generator_bound_paper_example() {
        let f: Vec<BigInt> = [55137512477462689i64, 559752270111028720, 0, 1].iter().map(|&c| BigInt::from(c)).collect();
        let one = one_step_generator_bound(&f);
        let (t, unif) = class_group_generator_bound(&f);
        eprintln!("one step {} steps {} uniform {}", one, t, unif);
        assert!((19000.0..19400.0).contains(&one), "{}", one);
        assert!((11000.0..11100.0).contains(&t), "{}", t);
    }
}
