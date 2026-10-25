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
//!   * h* R* below sqrt 2 times Bach's estimate of h R stops the search;
//!     then the certificate (nf/certify.rs) proves h and R under GRH alone:
//!     h* R* below twice Belabas and Friedman's proven lower bound for h R,
//!     with R* bounded from genuine units with certified logarithms and h*
//!     from exact determinants.  Bnf.certified says whether it held.

//!
//! Reading map: `bnfinit_configured` orchestrates the computation; `setup`
//! constructs the field and factor base; `collect` gathers relations;
//! `unit_lattice` identifies units; `try_units` decides acceptance.
//!
//! Glossary: h is the class number, R the regulator, w the roots-of-unity
//! count, r1/r2 the real/complex signature, and r = r1 + r2 - 1 the unit
//! rank. A factor base is a list of prime ideals; its generating prefix
//! supplies relation-matrix columns. Relation elements use integral-order
//! coordinates. Logarithms and regulators use integers scaled by 2^prec.
//! A certified result still assumes GRH and any recorded maximal-order
//! primality assumptions. Roots-of-unity completeness is a separate flag.

mod config;
mod setup;
mod collect;
mod unit_lattice;
pub use config::{BnfConfig, BnfDiagnostics};
use setup::{prepare_field, PreparedField};
use collect::RelationSearch;
pub(crate) use unit_lattice::unit_lattice;
pub(super) use unit_lattice::{inverse_f64, solve_rows};
use unit_lattice::{in_lattice_f64, unit_lattice_with_diagnostics};

// Search budgets are heuristics, not mathematical certification thresholds.
const MAX_UNIT_ATTEMPTS: usize = 12;
const MAX_CERTIFICATE_RETRIES: usize = 2;
// Fixed xorshift seed keeps the candidate search reproducible.
const RELATION_RANDOM_SEED: u64 = 0x2545_F491_4F6C_DD1D;
// Bound the cost of the Bach residue estimate; certification has its own window.
const RESIDUE_WINDOW_MIN: u64 = 1 << 10;
const RESIDUE_WINDOW_MAX: u64 = 1 << 15;
// Ball precision for the analytic lower bound and final strict inequality.
// Unit-log precision is estimated separately and can grow as needed.
const CERTIFICATE_BITS: u64 = 96;

use super::embed::{lll, lll_weighted, Embeddings};
use super::order::{maximal_order, Order};
use super::prime::{decompose, factor_element_fast, PrimeIdeal};
use super::zlin::*;
use crate::imag::{lattice_group, lattice_group_exact, ClassGroup, Timing};
use crate::linalg::{eliminate_tracked, eliminate_with, independent_rows, kernel_crt, Reduced};
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
    /// Diagnostic f64 regulator (1 when the unit rank is zero).
    pub regulator: f64,
    /// Returned fixed-point regulator: R = reg_fixed / 2^prec. The determinant
    /// has already been shifted down from its rank-dependent scale.
    pub reg_fixed: BigInt,
    /// Binary fractional bits of reg_fixed; zero denotes the rank-zero value 1.
    pub prec: u32,
    /// the number of roots of unity, and whether that is proven (else a
    /// lower bound)
    pub w: u32,
    pub w_proven: bool,
    /// Analytic certification under GRH (nf/certify.rs); maximal-order
    /// primality assumptions remain separate. Otherwise the stopping
    /// rule's estimate of h R is assumed too.
    pub certified: bool,
    /// the regulator's correct significant digits (when certified; else 20)
    pub reg_digits: usize,
    /// probable primes the maximal order's maximality assumes prime
    pub assumed_primes: Vec<BigInt>,
}

#[allow(dead_code)]
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
fn splitting(order: &Order, discriminant: &BigInt, index: &BigInt, bound: u64) -> Vec<(u64, Vec<(u32, u32)>)> {
    crate::arith::primes_up_to(bound)
        .into_iter()
        .map(|p| {
            let degs: Vec<(u32, u32)> = if (index % p).is_zero() {
                decompose(order, discriminant, p).map(|v| v.iter().map(|q| (q.f, q.e)).collect()).unwrap_or_default()
            } else {
                sagebrush_poly::factor_mod(&order.f, p).iter().map(|(g, e)| ((g.len() - 1) as u32, *e)).collect()
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
pub(crate) fn ideal_mul(order: &Order, a: &ZMat, b: &ZMat) -> ZMat {
    let t = crate::clock::Instant::now();
    let r = ideal_mul_impl(order, a, b);
    T_MUL.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
    r
}

fn ideal_mul_impl(order: &Order, a: &ZMat, b: &ZMat) -> ZMat {
    // the product contains N(A) N(B) O: an HNF modulo that keeps entries small
    let n = order.n;
    let na: BigInt = (0..n).map(|i| a[i][i].clone()).product();
    let nb: BigInt = (0..n).map(|i| b[i][i].clone()).product();
    let m = (na * nb).abs();
    let mut gens: ZMat = (0..n).map(|i| (0..n).map(|j| if i == j { m.clone() } else { BigInt::zero() }).collect()).collect();
    for x in a {
        for y in b {
            gens.push(order.mul(x, y).into_iter().map(|c| c.mod_floor(&m)).collect());
        }
    }
    hnf_mod_d(&gens, &m)
}

/// The HNF of a full-rank lattice containing d Z^n (rows include d e_i),
/// reducing entries modulo d along the way.
pub(crate) fn hnf_mod_d(rows: &ZMat, d: &BigInt) -> ZMat {
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
    order: Order,
    /// the product of the factor base's rational primes
    primorial: BigInt,
    /// log of the factor-base bound
    log_bound: f64,
    embeddings: Embeddings,
    factor_base: Vec<PrimeIdeal>,
    prime_indices: HashMap<u64, Vec<usize>>,
    /// fb[..ngen], the primes of norm below the bound, are the columns;
    /// relations with the others are dropped (they are not needed to
    /// generate, and rarely occur)
    generator_count: usize,
    diagnostics: BnfDiagnostics,
}

/// Relations from small elements of the LLL-reduced ideal with basis `ib`.
fn relations_from(field: &Field, ib: &ZMat, budget: usize, seen: &mut HashSet<Vec<(usize, i64)>>, rels: &mut Vec<Relation>, elems: &mut Vec<Vec<BigInt>>, rng: &mut u64) -> usize {
    relations_weighted(field, ib, budget, &[], seen, rels, elems, rng)
}

/// relations_from, reducing for the weighted form with log-weights s:
/// small elements are then skewed (log |sigma_j(x)| near c - s_j), so that
/// the units they combine to are not all small.
#[allow(clippy::too_many_arguments)]
fn relations_weighted(field: &Field, ib: &ZMat, budget: usize, s_log: &[f64], seen: &mut HashSet<Vec<(usize, i64)>>, rels: &mut Vec<Relation>, elems: &mut Vec<Vec<BigInt>>, rng: &mut u64) -> usize {
    // log N(I) from the HNF diagonal
    let log_ni: f64 = (0..ib.len()).map(|i| ib[i][i].to_f64().unwrap_or(1.0).abs().max(1.0).ln()).sum();
    let t = crate::clock::Instant::now();
    let red = if s_log.is_empty() { lll(ib, &field.embeddings) } else { lll_weighted(ib, &field.embeddings, s_log) };
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
        let mut x = vec![BigInt::zero(); field.order.n];
        for (c, b) in coef.iter().zip(&red) {
            if *c != 0 {
                for (xi, bi) in x.iter_mut().zip(b) {
                    *xi += bi * *c;
                }
            }
        }
        // skip norms too big to be smooth with useful probability: the
        // cofactor N(x)/N(I) as u = log / log B, at most 5
        let sg = field.embeddings.sigma(&x);
        let log_n: f64 = sg.iter().enumerate().map(|(j, (re, im))| if j < field.embeddings.r1 { re.abs().max(1e-300).ln() } else { (re * re + im * im).max(1e-300).ln() }).sum();
        if log_n - log_ni > 5.0 * field.log_bound {
            continue;
        }
        let t = crate::clock::Instant::now();
        let fe = factor_element_fast(&field.order, &field.factor_base, &field.prime_indices, &field.primorial, &x);
        T_FAC.fetch_add(t.elapsed().as_nanos() as u64, Relaxed);
        N_CAND.fetch_add(1, Relaxed);
        if let Some(rel) = fe {
            if rel.is_empty() || rel.iter().any(|&(i, _)| i >= field.generator_count) || !seen.insert(rel.clone()) {
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
pub fn class_group_generator_bound(f: &[BigInt]) -> Result<(f64, f64), String> {
    let (order, _) = maximal_order(f)?;
    let discriminant = order.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &discriminant).abs());
    let r1 = Embeddings::new(&order)?.r1;
    let uniform_bound = super::grh::uniform_bound(&discriminant);
    let split = splitting(&order, &discriminant, &index, uniform_bound as u64);
    Ok((super::grh::class_group_bound_certified(order.n, r1, &discriminant, &prime_norms(&split, uniform_bound), uniform_bound), uniform_bound))
}

/// Belabas, Diaz y Diaz and Friedman's one-step bound, for comparison.
pub fn one_step_generator_bound(f: &[BigInt]) -> Result<f64, String> {
    let (order, _) = maximal_order(f)?;
    let discriminant = order.disc();
    let index = num_integer::Roots::sqrt(&(Order::equation_order(f).disc() / &discriminant).abs());
    let r1 = Embeddings::new(&order)?.r1;
    let log_discriminant = discriminant.to_f64().unwrap().abs().ln();
    let uniform_bound = super::grh::uniform_bound(&discriminant);
    let split = splitting(&order, &discriminant, &index, uniform_bound as u64);
    Ok(super::grh::one_step_bound(order.n, r1, log_discriminant, &prime_norms(&split, uniform_bound), uniform_bound))
}

pub fn bnfinit(f: &[BigInt]) -> Result<(Bnf, Timing), String> {
    bnfinit_with(f, &[]).map(|(b, t, _)| (b, t))
}

/// The relations behind a class group computation: valuation vectors over
/// the factor base and the elements (order coordinates) with those
/// factorizations. Once the analytic certificate holds (h R against a
/// proven lower bound), they generate the group of factor-base units.
#[derive(Clone, Debug)]
pub struct Relations {
    /// Generating prime ideals: norm below `bound`, plus the requested extra primes.
    pub fb: Vec<PrimeIdeal>,
    pub bound: u64,
    pub rels: Vec<Relation>,
    pub elems: Vec<Vec<BigInt>>,
    pub order: Order,
}

/// bnfinit, with every prime ideal above the rational primes `extra` also
/// in the factor base (as columns), and the relations returned: so that the
/// S-units for S containing those primes can be read off.
pub fn bnfinit_with(f: &[BigInt], extra: &[u64]) -> Result<(Bnf, Timing, Relations), String> {
    bnfinit_configured(f, extra, &BnfConfig::default())
}

/// General number-field computation with explicit search and diagnostic options.
/// Ordinary entry points use defaults and never read the environment. For a
/// debug build, callers may explicitly pass `BnfConfig::from_debug_env()`.
pub fn bnfinit_configured(f: &[BigInt], extra: &[u64], config: &BnfConfig) -> Result<(Bnf, Timing, Relations), String> {
    let debug = config.diagnostics.progress;
    let t0 = crate::clock::Instant::now();
    let PreparedField { field, discriminant, bound, w, w_proven,
        assumed_primes, class_number_regulator_estimate, log_hr_lower_bound } = prepare_field(f, extra, config, &t0)?;
    let n = field.order.n;
    let (r1, r2) = (field.embeddings.r1, field.embeddings.r2);
    let r = r1 + r2 - 1;
    let factor_base_size = field.generator_count;
    let mut tm = Timing { fb: factor_base_size, h_est: class_number_regulator_estimate, ..Default::default() };
    let mut search = RelationSearch::new();
    // the spread of the log-weights: about the size of the unit lattice per
    // dimension (log of (h R)^(1/r)), capped for f64
    let log_weight_spread: f64 = config.log_weight_spread.unwrap_or(if r == 0 { 0.0 } else { (class_number_regulator_estimate.max(1.0).ln() / r as f64).clamp(2.0, 30.0) });
    let mut want = (1.4 * factor_base_size as f64) as usize + 20 + 2 * r;
    let mut cache: Option<(u32, Vec<Vec<BigInt>>)> = None;
    // (unlimited unless the caller set crate::limits::with_round_limit)
    for round in 0..crate::limits::round_limit() {
        sagebrush_interrupt::check();
        tm.rounds = round + 1;
        let t = crate::clock::Instant::now();
        // relations: in the first round the trivial ones (p) = prod P^e and
        // a sweep over every factor-base prime; then the uncovered primes
        // first, and products P_i P_j of random primes for fresh relations
        let start = search.relations.len();
        search.collect_round(&field, log_weight_spread, want, round);
        tm.sieve_s += t.elapsed().as_secs_f64();
        let t = crate::clock::Instant::now();
        if debug {
            eprintln!("round {}: {} relations (+{}); ideal products {:.0} ms, LLL {:.0} ms, norms+factoring {:.0} ms for {} candidates", round, search.relations.len(), search.relations.len() - start,
                T_MUL.load(Relaxed) as f64 / 1e6, T_LLL.load(Relaxed) as f64 / 1e6, T_FAC.load(Relaxed) as f64 / 1e6, N_CAND.load(Relaxed));
        }
        let mut more = (search.relations.len() / 5).max(10);
        let res = match eliminate_with(factor_base_size, &search.relations, 80, None) {
            (Reduced::Deficient(col), _, _) => {
                if debug {
                    eprintln!("  column {} (norm {}) has no relation", col, field.factor_base[col].norm());
                }
                search.deficient_columns.insert(col);
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
                            let desc: Vec<String> = free.iter().take(4).map(|&j| { let q = &field.factor_base[cols[j]]; format!("p={} e={} f={}", q.p, q.e, q.f) }).collect();
                            eprintln!("  core not of full rank ({} free: {})", free.len(), desc.join("; "));
                        }
                        more = (4 * free.len()).max(10);
                        for j in free {
                            search.deficient_columns.insert(cols[j]);
                        }
                        None
                    }
                    Ok(sel) => try_units(&field, &search.relations, &search.elements, factor_base_size, &dense, &core_rows, c, &sel, r, class_number_regulator_estimate, log_hr_lower_bound.clone(), round as u64, &mut cache, debug),
                }
            }
        };
        tm.linalg_s += t.elapsed().as_secs_f64();
        if let Some(Found { group, reg, reg_fixed, prec, certified, reg_digits }) = res {
            tm.relations = search.relations.len();
            let relations = Relations { fb: field.factor_base[..field.generator_count].to_vec(), bound, rels: search.relations, elems: search.elements, order: field.order };
            return Ok((Bnf { n, r1, r2, disc: discriminant, group, regulator: reg, reg_fixed, prec, w, w_proven, certified, reg_digits, assumed_primes }, tm, relations));
        }
        want = search.relations.len() + more;
    }
    Err("no convergence".into())
}

/// Log embeddings (first r coordinates... all r1 + r2) of the relation
/// elements at `prec` bits, cached at the highest precision so far.
fn element_logs(field: &Field, elems: &[Vec<BigInt>], prec: u32, cache: &mut Option<(u32, Vec<Vec<BigInt>>)>) -> Result<Vec<Vec<BigInt>>, String> {
    let need_new = cache.as_ref().map_or(true, |(p, _)| *p < prec);
    if need_new {
        let p = prec + prec / 4 + 16;
        let roots = field.embeddings.roots_hp(&field.order.f, p)?;
        let logs = elems.iter().map(|x| field.embeddings.log_embedding(&field.order, x, &roots, p)).collect();
        *cache = Some((p, logs));
    } else {
        let (p, logs) = cache.as_mut().unwrap();
        if logs.len() < elems.len() {
            let roots = field.embeddings.roots_hp(&field.order.f, *p)?;
            let pp = *p;
            logs.extend(elems[logs.len()..].iter().map(|x| field.embeddings.log_embedding(&field.order, x, &roots, pp)));
        }
    }
    let (p, logs) = cache.as_ref().unwrap();
    let shift = (*p - prec) as usize;
    Ok(logs[..elems.len()].iter().map(|l| l.iter().map(|x| x >> shift).collect()).collect())
}

/// A basis of {z in Z^k : z Y = 0 mod d} (Y: k rows y_t): the HNF of
/// [Y | I] together with [d I | 0], rows whose Y-part vanishes.
pub(crate) fn kernel_lattice(ys: &[Vec<BigInt>], d: &BigInt) -> Vec<Vec<BigInt>> {
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
fn unit_logs(field: &Field, rels: &[Relation], elems: &[Vec<BigInt>], factor_base_size: usize, core_rows: &[usize], sel: &[usize], det: &BigInt, ys: &[Vec<BigInt>], extras: &[usize], r: usize, prec: u32, cache: &mut Option<(u32, Vec<Vec<BigInt>>)>) -> Option<Vec<Vec<BigInt>>> {
    // (None: the roots could not be refined to this precision)
    let mut logs = element_logs(field, elems, prec, cache).ok()?;
    let (_, core2, zero_rows) = eliminate_with(factor_base_size, rels, 80, Some(&mut logs));
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
    if field.diagnostics.unit_norms {
        // every unit's full log vector sums to 0 (norm +-1)
        let worst = |v: &[Vec<BigInt>]| v.iter().map(|l| to_f64(&l.iter().sum::<BigInt>(), prec).abs()).fold(0.0, f64::max);
        eprintln!("    check at {} bits: {} zero-row units worst |sum| {:.3e}; {} kernel units worst {:.3e}", prec, n_zero, worst(&full[..n_zero]), full.len() - n_zero, worst(&full[n_zero..]));
    }
    let out: Vec<Vec<BigInt>> = full.into_iter().map(|l| l[..r].to_vec()).collect();
    Some(out)
}

/// unit_logs with certified error bounds (units of 2^-prec, one per
/// vector): logarithms from embed.rs log_embedding_err, the bounds carried
/// through the elimination, and each kernel combination checked to vanish
/// exactly on the core (so every vector is the logarithm of a unit).
#[allow(clippy::too_many_arguments)]
fn unit_logs_bounded(field: &Field, rels: &[Relation], elems: &[Vec<BigInt>], factor_base_size: usize, dense: &[Vec<i64>], core_rows: &[usize], sel: &[usize], det: &BigInt, ys: &[Vec<BigInt>], extras: &[usize], r: usize, prec: u32) -> Option<(Vec<Vec<BigInt>>, Vec<sagebrush_ball::Mag>)> {
    let (roots, rho) = field.embeddings.roots_hp_rad(&field.order.f, prec).ok()?;
    let mut logs = Vec::with_capacity(elems.len());
    let mut errs = Vec::with_capacity(elems.len());
    for x in elems {
        sagebrush_interrupt::check();
        let (l, e) = field.embeddings.log_embedding_err(&field.order, x, &roots, &rho, prec)?;
        logs.push(l);
        errs.push(e);
    }
    let (_, core2, zero_rows) = eliminate_tracked(factor_base_size, rels, 80, Some(&mut logs), Some(&mut errs));
    if core2 != core_rows {
        return None;
    }
    let mut out: Vec<Vec<BigInt>> = zero_rows.iter().map(|&k| logs[k][..r].to_vec()).collect();
    let mut out_err: Vec<sagebrush_ball::Mag> = zero_rows.iter().map(|&k| errs[k]).collect();
    let ncol = dense.first().map_or(0, |d| d.len());
    'z: for z in kernel_lattice(ys, det) {
        let mut a = Vec::with_capacity(sel.len());
        for i in 0..sel.len() {
            let s: BigInt = z.iter().zip(ys).map(|(zt, y)| zt * &y[i]).sum();
            let (q, rem) = s.div_rem(det);
            if !rem.is_zero() {
                if field.diagnostics.certificate_vectors { eprintln!("    kernel vector skipped: not divisible"); }
                continue 'z;
            }
            a.push(q);
        }
        // sum a_i A_i - sum z_t v_t = 0 exactly
        for col in 0..ncol {
            let v: BigInt = a.iter().zip(sel).map(|(ai, &k)| ai * dense[k][col]).sum::<BigInt>() - z.iter().zip(extras).map(|(zt, &k)| zt * dense[k][col]).sum::<BigInt>();
            if !v.is_zero() {
                if field.diagnostics.certificate_vectors { eprintln!("    kernel vector skipped: not zero on the core"); }
                continue 'z;
            }
        }
        // the unit: a_i on the A rows, -z_t on the extra rows
        let terms = a.iter().zip(sel).map(|(c, &k)| (c.clone(), k)).chain(z.iter().zip(extras).map(|(c, &k)| (-c, k)));
        let mut l = vec![BigInt::zero(); r];
        let mut e = sagebrush_ball::Mag::ZERO;
        for (c, k) in terms {
            if c.is_zero() {
                continue;
            }
            for (x, b) in l.iter_mut().zip(&logs[core_rows[k]]) {
                *x += &c * b;
            }
            e = e.add(sagebrush_ball::Mag::from_bigint_up(&c, 0).mul(errs[core_rows[k]]));
        }
        out.push(l);
        out_err.push(e);
    }
    Some((out, out_err))
}

/// An accepted class group and regulator.
struct Found {
    group: ClassGroup,
    reg: f64,
    reg_fixed: BigInt,
    prec: u32,
    certified: bool,
    reg_digits: usize,
}

/// The certificate's condition h* R*_hi < 2 h R_lo in logarithms.
/// The lower end of a ball as a double (for the search's heuristics only).
pub(crate) fn lower_f64(b: &sagebrush_ball::Ball) -> f64 {
    let (m, e) = b.lower();
    sagebrush_ball::Ball::exact(m, e).to_f64_approx()
}

/// Unit rank zero has R = 1; only the exact class-number multiple is certified.
#[allow(clippy::too_many_arguments)]
fn rank_zero_result(dense: &[Vec<i64>], c: usize, sel: &[usize], class_number_regulator_estimate: f64,
    log_hr_lower_bound: Option<&sagebrush_ball::Ball>, seed: u64, debug: bool) -> Option<Found> {
    let (h, cyc) = if c == 0 { (BigInt::one(), vec![]) } else { lattice_group(dense, c, sel, None, std::f64::consts::SQRT_2 * class_number_regulator_estimate, seed, debug)? };
    let ratio = h.to_f64().unwrap_or(f64::INFINITY) / class_number_regulator_estimate;
    if debug {
        eprintln!("  h* / est {:.4}", ratio);
    }
    if ratio > std::f64::consts::SQRT_2 {
        return None;
    }
    // certified: h* (exact determinants) < 2 h, R = 1
    let cert = log_hr_lower_bound.and_then(|lo| {
        let (h2, cyc2) = if c == 0 { (BigInt::one(), vec![]) } else { lattice_group_exact(dense, c, sel, 2.0 * lower_f64(lo).exp(), seed, debug)? };
        super::certify::below_twice_ball(&h2, &sagebrush_ball::Ball::one(), lo, CERTIFICATE_BITS).then_some((h2, cyc2))
    });
    let certified = cert.is_some();
    let (h, cyc) = cert.unwrap_or((h, cyc));
    return Some(Found { group: ClassGroup { h, cyc }, reg: 1.0, reg_fixed: BigInt::one(), prec: 0, certified, reg_digits: 20 });
}

/// Check that every candidate log vector belongs to the identified lattice.
fn verify_unit_lattice(basis: &ZMat, cov: &BigInt, lambdas: &[Vec<BigInt>], r: usize, err: &BigInt, prec: u32) -> (f64, bool) {
    let reg = to_f64(&(cov >> (prec as usize * (r - 1))), prec);
    let inv = inverse_f64(basis, prec);
    let ok = reg > 0.2 && lambdas.iter().all(|v| {
        if v.iter().all(|x| x.abs() <= err * 64) {
            return true;
        }
        if inv.as_ref().is_some_and(|inv| in_lattice_f64(basis, inv, v, err, prec)) {
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
}

type CertifiedUnits = (BigInt, Vec<BigInt>, f64, BigInt);

/// Rigorous unit logs and exact determinants; failure never becomes certification.
#[allow(clippy::too_many_arguments)]
fn certify_candidate(field: &Field, rels: &[Relation], elems: &[Vec<BigInt>], factor_base_size: usize,
    dense: &[Vec<i64>], core_rows: &[usize], sel: &[usize], det: &BigInt, ys: &[Vec<BigInt>],
    extras: &[usize], r: usize, prec: u32, basis: &ZMat, lo: &sagebrush_ball::Ball,
    seed: u64, debug: bool, h: &BigInt, c: usize) -> (Option<CertifiedUnits>, bool) {
    let mut imprecise = false;
    let cert = (|| {
        let Some((lams, errs)) = unit_logs_bounded(field, rels, elems, factor_base_size, dense, core_rows, sel, det, ys, extras, r, prec) else {
            imprecise = true;
            return None;
        };
        let (rlo_b, rhi_b, d, rel) = super::certify::regulator_bounds(&lams, &errs, basis, prec).map_err(|e| imprecise = e).ok()?;
        let (rlo, rhi) = (rlo_b.to_f64_approx(), rhi_b.to_f64_approx());
        let (h2, cyc2) = if c == 0 { (BigInt::one(), vec![]) } else { lattice_group_exact(dense, c, sel, 2.0 * lower_f64(lo).exp() / rhi, seed, debug)? };
        if debug {
            eprintln!("  certificate: R in [{:.12e}, {:.12e}], h* {} (heuristic {}), log h* R*_hi {:.6} vs log 2 hR >= {:.6}", rlo, rhi, h2, h, super::certify::ln_big(&h2) + rhi.ln(), std::f64::consts::LN_2 + lower_f64(lo));
        }
        // (rhi: regulator_bounds' upper end, a double)
        super::certify::below_twice_ball(&h2, &rhi_b, lo, CERTIFICATE_BITS).then_some((h2, cyc2, rel, d))
    })();
    (cert, imprecise)
}

/// Alternate more units and more precision. The heuristic stops the search;
/// the separate certificate sets the returned flag. An unavailable or failed
/// certificate can therefore return an explicitly uncertified candidate.
#[allow(clippy::too_many_arguments)]
fn try_units(field: &Field, rels: &[Relation], elems: &[Vec<BigInt>], factor_base_size: usize, dense: &[Vec<i64>], core_rows: &[usize], c: usize, sel: &[usize], r: usize, class_number_regulator_estimate: f64, log_hr_lower_bound: Option<sagebrush_ball::Ball>, seed: u64, cache: &mut Option<(u32, Vec<Vec<BigInt>>)>, debug: bool) -> Option<Found> {
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
        return rank_zero_result(dense, c, sel, class_number_regulator_estimate, log_hr_lower_bound.as_ref(), seed, debug);
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
    let mut cert_tries = 0;
    let mut rank_short = 0u32;
    for _ in 0..MAX_UNIT_ATTEMPTS {
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
            let low = unit_logs(field, rels, elems, factor_base_size, core_rows, sel, &det, &ys, &extras, r, 48, cache)?;
            let mid = unit_logs(field, rels, elems, factor_base_size, core_rows, sel, &det, &ys, &extras, r, 112, cache)?;
            let lbits = mid.iter().flatten().map(|l| l.bits() as i64 - 112).max().unwrap_or(0).max(0) as u32;
            let ebits = low.iter().flatten().zip(mid.iter().flatten()).map(|(l, m)| ((l << 64usize) - m).bits() as i64 - 112).max().unwrap_or(0).max(0) as u32;
            err_bits = ebits + 48 + 16;
            prec = err_bits + 3 * lbits + 64;
            if debug {
                eprintln!("  kernel: d {} bits; |lambda| ~ 2^{}, error at 48 bits ~ 2^{}: precision {} at {:.1} ms", det.bits(), lbits, ebits, prec, ms());
            }
        }
        let lambdas = unit_logs(field, rels, elems, factor_base_size, core_rows, sel, &det, &ys, &extras, r, prec, cache)?;
        let err = BigInt::one() << err_bits as usize;
        let res = unit_lattice_with_diagnostics(&lambdas, r, &err, prec, field.diagnostics.unit_lattice);
        rank_short += (res == Err(true)) as u32;
        let verified = res.as_ref().ok().map(|(basis, cov)| {
            verify_unit_lattice(basis, cov, &lambdas, r, &err, prec)
        });
        if debug {
            match &verified {
                Some((reg, ok)) => eprintln!("  precision {}: {} units, R* = {:.6e} (h R est {:.6e}){} at {:.1} ms", prec, lambdas.len(), reg, class_number_regulator_estimate, if *ok { "" } else { " NOT VERIFIED" }, ms()),
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
                } else if rank_short >= 2 {
                    // many units of rank below r twice: the relations
                    // lack units, which the next round's relations bring
                    // (more precision did not: the cubic of discriminant
                    // 923277 spent 20 s reaching 12304 bits)
                    break;
                }
                prec = prec * 3 / 2;
                continue;
            }
        };
        let (basis, cov) = res.unwrap();
        if lattice.is_none() {
            // (not the kernel's d: it need not be det of the sel rows)
            lattice = Some(group_of(None, std::f64::consts::SQRT_2 * class_number_regulator_estimate / reg)?);
        }
        let (h, cyc) = lattice.clone().unwrap();
        let ratio = h.to_f64().unwrap_or(f64::INFINITY) * reg / class_number_regulator_estimate;
        if debug {
            eprintln!("  h* R* / est {:.4} at {:.1} ms", ratio, ms());
        }
        if ratio <= std::f64::consts::SQRT_2 {
            // The heuristic may return uncertified. Missing bounds skip the
            // certificate; imprecise bounds allow at most two precision doublings.
            let Some(lo) = log_hr_lower_bound.as_ref() else {
                let reg_fixed = &cov >> (prec as usize * (r - 1));
                return Some(Found { group: ClassGroup { h, cyc }, reg, reg_fixed, prec, certified: false, reg_digits: 20 });
            };
            // the certificate (nf/certify.rs): genuine units with proven
            // error bounds, an exact multiple of h, h* R*_hi < 2 h R_lo
            let tc = crate::clock::Instant::now();
            // (imprecise: the error bounds were too large, worth a retry)
            let (cert, imprecise) = certify_candidate(field, rels, elems, factor_base_size,
                dense, core_rows, sel, &det, &ys, &extras, r, prec, &basis, lo, seed, debug, &h, c);
            if debug {
                eprintln!("  certificate {} at {:.1} ms ({:.1} ms)", if cert.is_some() { "holds" } else { "failed" }, ms(), tc.elapsed().as_secs_f64() * 1e3);
            }
            match cert {
                Some((h2, cyc2, rel, d)) => {
                    // R = |det b|: the digits its error bound fixes
                    let reg_digits = ((-rel.log10()).floor() as i64 - 1).clamp(1, 20) as usize;
                    let reg_fixed = &d >> (prec as usize * (r - 1));
                    let reg = to_f64(&reg_fixed, prec);
                    return Some(Found { group: ClassGroup { h: h2, cyc: cyc2 }, reg, reg_fixed, prec, certified: true, reg_digits });
                }
                None if imprecise && cert_tries < MAX_CERTIFICATE_RETRIES => {
                    // perhaps too imprecise for the error bounds
                    cert_tries += 1;
                    prec *= 2;
                    continue;
                }
                None => {
                    let reg_fixed = &cov >> (prec as usize * (r - 1));
                    return Some(Found { group: ClassGroup { h, cyc }, reg, reg_fixed, prec, certified: false, reg_digits: 20 });
                }
            }
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
mod tests;
