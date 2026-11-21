//! The public surface used by the bindings (WebAssembly JSON, Python):
//! plain data in and out.  Polynomials are integer coefficient vectors,
//! constant term first; elements of a number field K = Q[x]/(f) are given
//! on the power basis 1, a, ..., a^(n-1) as numerators with one denominator.

use crate::nf::embed::Embeddings;
use crate::nf::order::Order;
use crate::nf::zlin::{hnf, vec_mat, ZMat};
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use sagebrush_bigint::BigRational;
use num_traits::{One, Signed, Zero};

/// The factorization of n != 0 as (prime, exponent), primes ascending
/// (Baillie-PSW probable primes beyond 2^64).  A composite that cannot be split
/// (beyond 1024 bits) is an error, never reported as a prime.
pub fn factor_integer(n: &BigInt) -> Result<Vec<(BigInt, u32)>, String> {
    if n.abs() <= BigInt::one() {
        return Ok(vec![]);
    }
    crate::nf::factor::factor(n)
}

/// Whether n is prime: proven below 2^64, Baillie-PSW beyond (no known
/// counterexample, not a proof; "composite" is proven); false for n < 2
/// (Astra's audit, F7: -7 was "prime").
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
    /// probable primes (BPSW, above 2^64) whose squares divide disc(f):
    /// the order's maximality assumes they are prime
    pub assumed_primes: Vec<BigInt>,
}

fn monic(f: &[BigInt]) -> Result<(), String> {
    if f.len() < 2 || !f.last().unwrap().is_one() {
        return Err("the defining polynomial must be monic with integer coefficients, of degree >= 1".into());
    }
    if !sagebrush_poly::try_is_irreducible(f).map_err(|e| e.to_string())? {
        return Err("the defining polynomial must be irreducible".into());
    }
    Ok(())
}

pub fn nf_data(f: &[BigInt]) -> Result<NfData, String> {
    monic(f)?;
    let (o, _, assumed_primes) = crate::nf::order::maximal_order_assuming(f)?;
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
    Ok(NfData { degree: o.n, r1, r2, disc, index, basis: b, den: o.den.clone(), w, w_proven, assumed_primes })
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
    /// the probable primes (BPSW, above 2^64) that the maximal order, and so
    /// this decomposition, assumes prime
    pub assumed_primes: Vec<BigInt>,
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
    // The modular factorization accepts only p < 2^32; refuse before calling it.
    if p >= 1 << 32 {
        return Err(format!("primes above p >= 2^32 are not supported (p = {})", p));
    }
    let (o, _, assumed_primes) = crate::nf::order::maximal_order_assuming(f)?;
    let dk = o.disc();
    let ps = crate::nf::prime::decompose(&o, &dk, p)?;
    Ok(ps.into_iter().map(|q| {
        let (pi, pi_den) = if q.f as usize == o.n { (vec![BigInt::from(p)], BigInt::one()) } else { small_generator(&o, &q.pi, p) };
        PrimeData { p, e: q.e, f: q.f, pi, pi_den, assumed_primes: assumed_primes.clone() }
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
    /// probable primes the maximal order's maximality assumes prime
    pub assumed_primes: Vec<BigInt>,
}

/// A decimal string of x / 2^prec with `digits` significant digits.
pub fn fixed_to_decimal(x: &BigInt, prec: u32, digits: usize) -> String {
    // `digits` significant digits of x / 2^prec: fixed notation from 10^-4
    // up, scientific below, so small nonzero values do not print as zero.
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

/// Preserve the public representation at one boundary: exact integer fields,
/// and a regulator string made from the fixed-point value, not its f64 estimate.
fn class_group_data(result: crate::nf::bnf::Bnf) -> BnfData {
    let regulator = regulator_decimal(&result.reg_fixed, result.prec, result.reg_digits);
    BnfData { degree: result.n, r1: result.r1, r2: result.r2, disc: result.disc,
        h: result.group.h, cyc: result.group.cyc, regulator, w: result.w,
        w_proven: result.w_proven, certified: result.certified, assumed_primes: result.assumed_primes }
}

/// Precision zero denotes the rank-zero regulator, exactly 1. Otherwise the
/// fixed-point formatter uses fixed notation from 10^-4 up, scientific below.
fn regulator_decimal(value: &BigInt, precision: u32, digits: usize) -> String {
    if precision == 0 { "1".to_string() } else { fixed_to_decimal(value, precision, digits) }
}

pub fn bnf(f: &[BigInt]) -> Result<BnfData, String> {
    monic(f)?;
    if f.len() == 2 {
        return Ok(BnfData { degree: 1, r1: 1, r2: 0, disc: BigInt::one(), h: BigInt::one(), cyc: vec![], regulator: "1".into(), w: 2, w_proven: true, certified: true, assumed_primes: vec![] });
    }
    let (b, _) = crate::nf::bnf::bnfinit(f)?;
    Ok(class_group_data(b))
}

/// The unconditional class group and regulator (nf/proof.rs: no GRH).
pub struct BnfProofData {
    pub degree: usize,
    pub r1: usize,
    pub r2: usize,
    pub disc: BigInt,
    pub h: BigInt,
    pub cyc: Vec<BigInt>,
    /// the regulator to its proven significant digits ("1" for unit rank 0)
    pub regulator: String,
    pub w: u32,
    /// what the proof used: the norm bound M and its source (Minkowski or
    /// Zimmert), the factor base's bound, the prime ideals shown to lie in
    /// its subgroup, Zimmert's regulator lower bound, the unit index bound
    /// B, the primes l <= B checked, and the primes l | h checked
    pub norm_bound: BigInt,
    pub norm_bound_kind: &'static str,
    pub fb_bound: u64,
    pub primes_shown: usize,
    pub reg_lower: f64,
    pub index_bound: u64,
    pub unit_primes: usize,
    pub class_primes: Vec<BigInt>,
}

/// The unconditional certificate for Q[x]/(f), within the limits (None:
/// no limit; Limits::CALIBRATED gives the former ones); an error starting
/// with nf::proof::REFUSED is a refusal
/// (a bound beyond the limits, said by how much), not a failure.
pub fn bnf_certify(f: &[BigInt], norm_max: Option<u64>, index_max: Option<u64>) -> Result<BnfProofData, String> {
    monic(f)?;
    if f.len() == 2 {
        return Ok(BnfProofData { degree: 1, r1: 1, r2: 0, disc: BigInt::one(), h: BigInt::one(), cyc: vec![], regulator: "1".into(), w: 2,
            norm_bound: BigInt::one(), norm_bound_kind: "Minkowski", fb_bound: 1, primes_shown: 0, reg_lower: 1.0, index_bound: 1, unit_primes: 0, class_primes: vec![] });
    }
    let d = crate::nf::proof::Limits::default();
    let limits = crate::nf::proof::Limits { norm_max: norm_max.unwrap_or(d.norm_max), index_max: index_max.unwrap_or(d.index_max) };
    let p = crate::nf::proof::certify(f, &limits)?;
    let regulator = regulator_decimal(&p.reg_fixed, p.prec, p.reg_digits);
    Ok(BnfProofData { degree: p.n, r1: p.r1, r2: p.r2, disc: p.disc, h: p.h, cyc: p.cyc, regulator, w: p.w,
        norm_bound: p.norm_bound, norm_bound_kind: p.norm_bound_kind.name(), fb_bound: p.fb_bound, primes_shown: p.primes_shown,
        reg_lower: p.reg_lower, index_bound: p.index_bound, unit_primes: p.unit_primes, class_primes: p.class_primes })
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
    let bnf = class_group_data(b);
    let elems = r.elems.iter().map(|x| {
        // power-basis coordinates: x B / den
        let n = r.order.n;
        let num: Vec<BigInt> = (0..n).map(|j| (0..n).map(|i| &x[i] * &r.order.basis[i][j]).sum()).collect();
        (num, r.order.den.clone())
    }).collect();
    Ok(RelationData { bnf, fb: r.fb.iter().map(|q| (q.p, q.e, q.f)).collect(), rels: r.rels, elems })
}

/// Class group of the quadratic field of fundamental discriminant d (and
/// the regulator, d > 0), by the quadratic algorithms, with the analytic
/// certificate.
pub fn quadratic(d: &BigInt) -> Result<(BigInt, Vec<BigInt>, Option<String>, bool), String> {
    quadratic_with(d, true)
}

/// quadratic, with the analytic certificate only if `certify` (the last
/// field says whether the result is certified; see imag::class_group_with
/// and realq::class_group_real_with).
pub fn quadratic_with(d: &BigInt, certify: bool) -> Result<(BigInt, Vec<BigInt>, Option<String>, bool), String> {
    if d.is_negative() {
        let (g, _, certified) = crate::imag::class_group_with(d, certify)?;
        Ok((g.h, g.cyc, None, certified))
    } else {
        let (r, _) = crate::realq::class_group_real_with(d, certify)?;
        Ok((r.group.h, r.group.cyc, Some(fixed_to_decimal(&r.reg_fixed, r.prec, r.reg_digits)), r.certified))
    }
}

/// The Hermite normal form (rows, upper triangular, positive pivots; zero
/// rows dropped).  A square nonsingular matrix of size at least
/// HERMITE_CYCLIC_MIN_N is first attempted by `hermite_cyclic` (the form
/// [[I, h], [0, d]]); failing that, one of size at least HERMITE_MODULAR_MIN_N
/// with word-sized entries goes through `hermite_modular`; any other,
/// through the elimination over Z (`zlin::hnf`).
pub fn hermite(m: &ZMat) -> ZMat {
    if m.len() >= HERMITE_CYCLIC_MIN_N {
        if let Some(h) = hermite_cyclic(m) {
            return h;
        }
    }
    if m.len() >= HERMITE_MODULAR_MIN_N {
        if let Some(h) = hermite_modular(m) {
            return h;
        }
    }
    hnf(m)
}

/// The size from which `hermite` uses `hermite_modular`, for the target it
/// runs on: where the modular form overtakes the elimination over Z
/// (WebAssembly, [`HERMITE_MODULAR_MIN_N_WASM`]) or the cyclic attempt's
/// fallback (native, [`HERMITE_MODULAR_MIN_N_NATIVE`]).
pub const HERMITE_MODULAR_MIN_N: usize = if cfg!(target_arch = "wasm32") { HERMITE_MODULAR_MIN_N_WASM } else { HERMITE_MODULAR_MIN_N_NATIVE };

/// [`HERMITE_MODULAR_MIN_N`] in the WebAssembly engine: where the two meet
/// there.  Measured with Sage mode's command line (Node 24.21.0, one core of
/// an AMD EPYC 7B13) on random_matrix(ZZ, n), two seeds each: the
/// elimination over Z took 0.79 s at n = 100, 1.46 s at 110 and 2.80 s at
/// 120; the modular form 0.90 s, 1.46 s and 2.40 s.  Below that the
/// elimination is faster; above it the elimination's entries grow until it
/// doesn't finish (n = 150 ran for over 13 minutes, the modular form took
/// 8.0 s).
pub const HERMITE_MODULAR_MIN_N_WASM: usize = 110;

/// [`HERMITE_MODULAR_MIN_N`] in native builds (x86-64 measured; aarch64 not
/// yet): where, after a failed cyclic attempt, the modular form overtakes the
/// elimination over Z.  Measured natively on one pinned core of an idle
/// Google Cloud n2-standard-8 (Intel Xeon, 2.80 GHz), on Sage mode's
/// random_matrix(ZZ, n) for seeds 1 to 20 together, the three methods timed
/// on the same matrices, twice: with the cyclic attempt first, the
/// elimination fallback took 2.81 s at n = 90 and 5.28 s at 100, the modular
/// one 3.28 s and 4.84 s.
pub const HERMITE_MODULAR_MIN_N_NATIVE: usize = 100;

/// The size from which `hermite` tries `hermite_cyclic` first, for the
/// target it runs on ([`HERMITE_CYCLIC_MIN_N_WASM`],
/// [`HERMITE_CYCLIC_MIN_N_NATIVE`]): below it, the determinant and solves it
/// costs exceed what it saves.
pub const HERMITE_CYCLIC_MIN_N: usize = if cfg!(target_arch = "wasm32") { HERMITE_CYCLIC_MIN_N_WASM } else { HERMITE_CYCLIC_MIN_N_NATIVE };

/// [`HERMITE_CYCLIC_MIN_N`] in the WebAssembly engine.  Measured with Sage
/// mode's command line (Node 24.21.0, one core of an AMD EPYC 7B13) on
/// random_matrix(ZZ, n) for seeds 1 to 20 together (7 of them of that form
/// at n = 50, 10 at 55), twice: without it, 0.54 s at n = 50 and 0.77 s at
/// 55; with it, 0.55 s and 0.63 s.
pub const HERMITE_CYCLIC_MIN_N_WASM: usize = 55;

/// [`HERMITE_CYCLIC_MIN_N`] in native builds (x86-64 measured; aarch64 not
/// yet).  Measured natively on one pinned core of an idle Google Cloud
/// n2-standard-8 (Intel Xeon, 2.80 GHz), on Sage mode's random_matrix(ZZ, n)
/// for seeds 1 to 20 together, the methods timed on the same matrices,
/// twice: without it, 0.089 s at n = 40 and 0.145 s at 45; with it (a failed
/// attempt then pays the elimination), 0.091 s and 0.113 s.
pub const HERMITE_CYCLIC_MIN_N_NATIVE: usize = 45;

/// The Hermite normal form of a square nonsingular matrix when it is
/// [[I, h], [0, d]] (sagebrush_arith::zmat::hermite_cyclic: one Dixon solve
/// and an exact check), or None.
pub fn hermite_cyclic(m: &ZMat) -> Option<ZMat> {
    let n = m.len();
    if n == 0 || m.iter().any(|r| r.len() != n) {
        return None;
    }
    let a = sagebrush_arith::zmat::ZMat::from_rows(m.to_vec());
    // (Units: the copies in and out as Move; zmat counts the rest)
    let mut acc = sagebrush_arith::cost::Local::new();
    acc.n(sagebrush_arith::cost::Family::Move, m.iter().map(|r| sagebrush_arith::zmat::copy_units(r)).sum());
    let h = sagebrush_arith::zmat::hermite_cyclic(&a)?;
    acc.n(sagebrush_arith::cost::Family::Move, (0..n).map(|i| sagebrush_arith::zmat::copy_units(h.row(i))).sum());
    Some((0..n).map(|i| h.row(i).to_vec()).collect())
}

/// The Hermite normal form of a square nonsingular integer matrix with
/// entries in i64, or None for any other.  With d = |det m| (multimodular,
/// `linalg::det_crt`), d Z^n lies in the lattice L of the rows, so L is
/// L + d Z^n, whose Hermite form `linalg::hnf_mod` computes with its
/// arithmetic reduced modulo d, coefficients kept on the scale of d
/// (Domich, Kannan and Trotter, "Hermite normal form computation using
/// modulo determinant arithmetic", Math. Oper. Res. 12 (1987)).  Its rows are then reduced above each pivot into [0, pivot),
/// the normalization of `zlin::hnf`: the Hermite form is unique.
///
/// Units (`cost::tally`): the conversion to words as Move; det_crt and
/// hnf_mod count themselves; the reduction above the diagonal, per pivot
/// after its work and flushed at its check: a quotient per entry
/// (`bigdiv_units`), and for a nonzero one the row copied (Move) and its
/// products (`bigmul_units`; a product's accumulation into its row is part
/// of its units, as in zmat).
pub fn hermite_modular(m: &ZMat) -> Option<ZMat> {
    use sagebrush_arith::cost::{bigdiv_units, bigmul_units, Family, Local};
    use sagebrush_arith::zmat::{copy_units, limbs};
    let n = m.len();
    if n == 0 || m.iter().any(|r| r.len() != n) {
        return None;
    }
    let rows: Vec<Vec<i64>> = m.iter().map(|r| r.iter().map(num_traits::ToPrimitive::to_i64).collect::<Option<Vec<i64>>>()).collect::<Option<Vec<_>>>()?;
    let mut acc = Local::new();
    acc.n(Family::Move, (n * n) as u64);
    let d = crate::linalg::det_crt(&rows).abs();
    if d.is_zero() {
        return None;
    }
    let mut w = crate::linalg::hnf_mod(&rows, n, &d);
    for i in 0..n {
        acc.flush();
        sagebrush_interrupt::check();
        let p = w[i][i].clone();
        let lp = limbs(&p);
        let row = copy_units(&w[i][i..]);
        acc.n(Family::Move, lp as u64);
        for k in 0..i {
            let q = w[k][i].div_floor(&p);
            acc.add(bigdiv_units(limbs(&w[k][i]), lp));
            if !q.is_zero() {
                let wi = w[i].clone();
                for (x, y) in w[k].iter_mut().zip(&wi).skip(i) {
                    *x -= &q * y;
                }
                acc.n(Family::Move, copy_units(&wi));
                acc.add(bigmul_units(limbs(&q), usize::try_from(row).unwrap_or(usize::MAX)));
            }
        }
    }
    Some(w)
}

/// The elementary divisors (Smith form diagonal) of an m x n integer matrix:
/// min(m, n) entries d_1 | d_2 | ..., zeros last.
///
/// A square nonsingular matrix goes straight to
/// `sagebrush_arith::snf::invariants_square` (the determinant, one solve,
/// then the Smith form modulo d / delta: that module's docs).  Any other
/// keeps its invariants through two Hermite forms: `hermite` of the rows
/// (r x n of full row rank, unimodular row operations), then, unless that
/// is already square, `hermite` of its transpose (r x r, nonsingular: the
/// column operations).  Their r x r form is upper triangular, so |det| is
/// the product of its diagonal; its r invariants, then min(m, n) - r zeros.
pub fn elementary_divisors(m: &ZMat) -> Vec<BigInt> {
    use sagebrush_arith::snf;
    use sagebrush_arith::zmat::ZMat as Dense;
    let rows = m.len();
    let cols = m.first().map_or(0, |r| r.len());
    let k = rows.min(cols);
    if k == 0 {
        return vec![];
    }
    if rows == cols {
        if let Some(t) = snf::invariants_square(&Dense::from_rows(m.clone())) {
            return t;
        }
    }
    let h = hermite(m);
    let r = h.len();
    let sq = if r == cols {
        h
    } else {
        let ht: ZMat = (0..cols).map(|j| h.iter().map(|row| row[j].clone()).collect()).collect();
        hermite(&ht)
    };
    let mut t = if r == 0 {
        vec![]
    } else {
        let d: BigInt = (0..r).map(|i| sq[i][i].clone()).product();
        snf::invariants_nonsingular(&Dense::from_rows(sq), &d.abs(), None)
    };
    t.extend((r..k).map(|_| BigInt::zero()));
    t
}

/// The textbook smallest-pivot Smith form over Z that `elementary_divisors`
/// replaced, kept for its tests.
#[cfg(test)]
fn elementary_divisors_elim(m: &ZMat) -> Vec<BigInt> {
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

#[cfg(test)]
thread_local! {
    /// Tests: every LLL refused (a memory refusal), and how many were.
    static REFUSE_LLL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static LLL_REFUSED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// Tests: the rank stage's prime (0: `RANK_PRIME`), to force an unlucky one.
    static RANK_P: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// Tests: when set, each of `lll_in`'s own debits is recorded as (its
    /// site, the work left before it).
    static LLL_TRACE: std::cell::RefCell<Option<Vec<(&'static str, u64)>>> = const { std::cell::RefCell::new(None) };
}

/// Debit `units` at `site` (recorded in tests).
fn lll_debit(b: &sagebrush_poly::Budget, _site: &'static str, units: Option<u64>) -> sagebrush_poly::budget::FResult<()> {
    #[cfg(test)]
    LLL_TRACE.with(|t| {
        if let Some(v) = t.borrow_mut().as_mut() {
            v.push((_site, b.work_left()));
        }
    });
    b.debit(units)
}

/// An LLL-reduced basis ((0.51, 0.99)-reduced, proved) of the lattice
/// spanned by the rows; dependent rows give zero rows, which come first.
/// The rows themselves are reduced when their rank modulo a prime proves
/// them independent, else a basis of their lattice (their Hermite form). The
/// whole call runs within the default budget (`lll_in`); a refusal is an
/// error starting "LLL:".
pub fn lll(m: &ZMat) -> Result<ZMat, String> {
    #[cfg(test)]
    if REFUSE_LLL.with(|r| r.get()) {
        LLL_REFUSED.with(|c| c.set(c.get() + 1));
        let b = sagebrush_poly::Budget::default();
        return Err(b.refuse("memory", 2, 1).message(&sagebrush_poly::budget::LLL));
    }
    let b = sagebrush_poly::Budget::default();
    lll_in(&b, m).map_err(|e| e.message(&sagebrush_poly::budget::LLL))
}

/// The largest entry's bits in a row.
fn row_bits(r: &[BigInt]) -> u64 {
    r.iter().map(|x| x.bits()).max().unwrap_or(0)
}

/// [`lll`] within `b`, each stage's memory reserved before it is allocated
/// and its work debited before it is done: the entries' sizes; the rank
/// modulo a prime (`lll::rank_mod_p`, skipped with more rows than columns);
/// the Hermite form when that rank is short (`lll::hnf_budgeted`, its
/// reservation grown before its entries grow); the reduction (`lll::reduce_held`,
/// handed the rows' reservation); then the zero rows and the outer vector.
/// Its own copies are debited by their limbs, and the output by its
/// entries and rows.
fn lll_in(b: &sagebrush_poly::Budget, m: &ZMat) -> sagebrush_poly::budget::FResult<ZMat> {
    use sagebrush_poly::lll::{basis_bytes, rank_mod_p, reduce_held, RANK_PRIME};
    let r = m.len();
    let n = m.first().map_or(0, |x| x.len());
    let overflow = || b.refuse("work (overflow)", u64::MAX, b.work_left());
    let entries = (r as u64).checked_mul(n as u64).and_then(|x| x.checked_add(1)).ok_or_else(overflow)?;
    // the entries' sizes: the largest, and the limbs a copy reads
    lll_debit(b, "shape", Some(entries))?;
    let e = m.iter().map(|x| row_bits(x)).max().unwrap_or(0);
    let limbs_sum = m.iter().flatten().try_fold(0u64, |s, x| s.checked_add(sagebrush_poly::budget::limbs(x.bits()))).ok_or_else(overflow)?;
    #[allow(unused_mut)]
    let mut p = RANK_PRIME;
    #[cfg(test)]
    if RANK_P.with(|c| c.get()) != 0 {
        p = RANK_P.with(|c| c.get());
    }
    let independent = r <= n && rank_mod_p(b, m, p)? == r;
    let (rows, kept) = if independent {
        let held = b.reserve(basis_bytes(r, n, e))?;
        lll_debit(b, "copy", limbs_sum.checked_add(entries))?;
        reduce_held(b, m.clone(), held)?
    } else {
        let (h, held, _) = sagebrush_poly::lll::hnf_budgeted(b, m)?;
        reduce_held(b, h, held)?
    };
    let k = rows.len();
    let z = basis_bytes(r - k, n, 0).and_then(|x| x.checked_add((r as u64).checked_mul(24)?));
    let zr = b.reserve(z)?;
    // the zero entries, and a move per row
    lll_debit(b, "output", ((r - k) as u64).checked_mul(n as u64).and_then(|x| x.checked_add(r as u64 + 1)))?;
    let mut out: ZMat = Vec::with_capacity(r);
    out.extend((0..r - k).map(|_| vec![BigInt::zero(); n]));
    out.extend(rows);
    drop((kept, zr));
    Ok(out)
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
    /// The modular Hermite form equals the elimination over Z on random
    /// square nonsingular matrices; singular or non-square ones, or entries
    /// past i64, are left to the elimination.
    #[test]
    fn hermite_modular_agrees_with_hnf() {
        use crate::nf::zlin::hnf;
        let mut seed = 0x2545f4914f6cdd1du64;
        let mut rnd = |range: i64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % (2 * range as u64 + 1)) as i64 - range
        };
        let mut done = 0;
        for &(n, range) in &[(1usize, 9i64), (2, 3), (3, 1), (5, 2), (8, 100), (13, 2), (20, 5), (30, 2), (40, 1 << 20)] {
            for _ in 0..3 {
                let m: ZMat = (0..n).map(|_| (0..n).map(|_| BigInt::from(rnd(range))).collect()).collect();
                match hermite_modular(&m) {
                    Some(h) => {
                        assert_eq!(h, hnf(&m), "n={n} range={range}");
                        done += 1;
                    }
                    None => assert!(crate::linalg::det(&m).is_zero(), "n={n}: refused a nonsingular matrix"),
                }
            }
        }
        assert!(done >= 20, "only {done} nonsingular cases");
        // singular, non-square and too-large entries: not this path
        let sing: ZMat = vec![vec![1.into(), 2.into()], vec![2.into(), 4.into()]];
        assert!(hermite_modular(&sing).is_none());
        let rect: ZMat = vec![vec![1.into(), 2.into(), 3.into()], vec![4.into(), 5.into(), 7.into()]];
        assert!(hermite_modular(&rect).is_none());
        let big: ZMat = vec![vec![BigInt::from(1u64 << 63), 1.into()], vec![1.into(), 1.into()]];
        assert!(hermite_modular(&big).is_none());
        assert_eq!(hermite(&big), hnf(&big));
    }

    /// The cyclic case ([[I, h], [0, d]]) equals the elimination over Z
    /// whenever it applies, takes every tested matrix of that form, and refuses a
    /// matrix whose quotient Z^n / L is not cyclic; hermite then still gives
    /// the elimination's form.  A wrong h fails the exact check.
    #[test]
    fn hermite_cyclic_agrees_with_hnf() {
        use crate::nf::zlin::hnf;
        let mut seed = 0x51f15e5f00dau64;
        let mut rnd = |range: i64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % (2 * range as u64 + 1)) as i64 - range
        };
        let (mut took, mut tried) = (0, 0);
        for &(n, range) in &[
            (1usize, 9i64),
            (2, 3),
            (3, 2),
            (5, 2),
            (8, 100),
            (13, 2),
            (20, 5),
            (30, 2),
            (40, 1 << 40),
        ] {
            for _ in 0..4 {
                let m: ZMat = (0..n)
                    .map(|_| (0..n).map(|_| BigInt::from(rnd(range))).collect())
                    .collect();
                if crate::linalg::det(&m).is_zero() {
                    assert!(hermite_cyclic(&m).is_none());
                    continue;
                }
                tried += 1;
                let h = hnf(&m);
                if let Some(c) = hermite_cyclic(&m) {
                    assert_eq!(c, h, "n={n} range={range}");
                    took += 1;
                } else {
                    // refused: the form is not [[I, h], [0, d]]
                    assert!(
                        (0..n - 1).any(|i| !h[i][i].is_one()),
                        "n={n}: refused a cyclic case"
                    );
                }
                assert_eq!(hermite(&m), h);
            }
        }
        // every refusal above was a non-cyclic form, so the shortcut took
        // every cyclic one; small entries make Z^n / L non-cyclic often
        assert!(took >= 10, "the cyclic case took only {took} of {tried}");
        // U H for H = [[I, h], [0, d]] and U unimodular has the form H, also
        // when d has many small prime factors (each one makes a single
        // right-hand side fail with probability 1/p)
        for &(n, d) in &[(6usize, 210i64), (12, 1024), (20, 30030), (25, 1)] {
            let mut hm: ZMat = (0..n)
                .map(|i| (0..n).map(|j| BigInt::from((i == j) as i64)).collect())
                .collect();
            for i in 0..n - 1 {
                hm[i][n - 1] = BigInt::from(rnd(1 << 20).rem_euclid(d));
            }
            hm[n - 1][n - 1] = BigInt::from(d);
            let mut m = hm.clone();
            for _ in 0..4 * n {
                let (i, j) = (
                    rnd(1 << 20).rem_euclid(n as i64) as usize,
                    rnd(1 << 20).rem_euclid(n as i64) as usize,
                );
                if i != j {
                    let k = BigInt::from(rnd(3));
                    let rj = m[j].clone();
                    for (x, y) in m[i].iter_mut().zip(rj) {
                        *x += &k * y;
                    }
                }
            }
            assert_eq!(hermite_cyclic(&m).as_ref(), Some(&hm), "n={n} d={d}");
        }
        // Z^3 / L = Z/2 x Z/2 x Z/3: not cyclic, refused; hermite falls back
        let m: ZMat = vec![
            vec![2.into(), 0.into(), 0.into()],
            vec![0.into(), 2.into(), 0.into()],
            vec![1.into(), 1.into(), 3.into()],
        ];
        assert!(hermite_cyclic(&m).is_none());
        assert_eq!(hermite(&m), hnf(&m));
        // the exact check rejects a wrong h
        let m: ZMat = vec![vec![2.into(), 1.into()], vec![1.into(), 3.into()]];
        let a = sagebrush_arith::zmat::ZMat::from_rows(m.clone());
        let c = hermite_cyclic(&m).unwrap();
        let (h, d) = (c[0][1].clone(), c[1][1].clone());
        assert!(sagebrush_arith::zmat::hermite_cyclic_holds(
            &a,
            &[h.clone()],
            &d
        ));
        assert!(!sagebrush_arith::zmat::hermite_cyclic_holds(
            &a,
            &[(h + 1u32) % &d],
            &d
        ));
    }

    /// Each target's thresholds are the measured ones, and the build picks
    /// its own: the WebAssembly engine's are kept when native ones change.
    #[test]
    fn hermite_thresholds_per_target() {
        assert_eq!((HERMITE_CYCLIC_MIN_N_WASM, HERMITE_MODULAR_MIN_N_WASM), (55, 110));
        assert_eq!((HERMITE_CYCLIC_MIN_N_NATIVE, HERMITE_MODULAR_MIN_N_NATIVE), (45, 100));
        let want = if cfg!(target_arch = "wasm32") { (55, 110) } else { (45, 100) };
        assert_eq!((HERMITE_CYCLIC_MIN_N, HERMITE_MODULAR_MIN_N), want);
    }

    /// hermite on both sides of HERMITE_CYCLIC_MIN_N gives the form of U H,
    /// H = [[I, h], [0, d]] and U unimodular (just below: by the elimination
    /// over Z; at it: by hermite_cyclic, which takes it).
    #[test]
    fn hermite_at_the_cyclic_threshold() {
        let mut seed = 0x2545f4914f6cdd1du64;
        let mut rnd = |k: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % k
        };
        for n in [HERMITE_CYCLIC_MIN_N - 1, HERMITE_CYCLIC_MIN_N] {
            let d = 2 * 3 * 5 * 7 * 11 * 13u64;
            let mut hm: ZMat = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as u64)).collect()).collect();
            for i in 0..n - 1 {
                hm[i][n - 1] = BigInt::from(rnd(d));
            }
            hm[n - 1][n - 1] = BigInt::from(d);
            let mut m = hm.clone();
            for _ in 0..4 * n {
                let (i, j) = (rnd(n as u64) as usize, rnd(n as u64) as usize);
                if i != j {
                    let k = BigInt::from(rnd(5) as i64 - 2);
                    let rj = m[j].clone();
                    for (x, y) in m[i].iter_mut().zip(rj) {
                        *x += &k * y;
                    }
                }
            }
            assert_eq!(hermite(&m), hm, "n={n}");
            if n == HERMITE_CYCLIC_MIN_N {
                assert_eq!(hermite_cyclic(&m).as_ref(), Some(&hm), "n={n}: the cyclic path");
            }
        }
    }

    /// hermite on both sides of HERMITE_MODULAR_MIN_N agrees with the
    /// elimination over Z (just below: the elimination itself; at it: the
    /// modular form, as hermite_modular accepts the matrix).
    #[test]
    fn hermite_at_the_modular_threshold() {
        use crate::nf::zlin::hnf;
        let mut seed = 0x9e3779b97f4a7c15u64;
        for n in [HERMITE_MODULAR_MIN_N - 1, HERMITE_MODULAR_MIN_N] {
            let m: ZMat = (0..n)
                .map(|_| {
                    (0..n)
                        .map(|_| {
                            seed ^= seed << 13;
                            seed ^= seed >> 7;
                            seed ^= seed << 17;
                            BigInt::from((seed % 5) as i64 - 2)
                        })
                        .collect()
                })
                .collect();
            let h = hnf(&m);
            assert_eq!(hermite(&m), h, "n={n}");
            if n >= HERMITE_MODULAR_MIN_N {
                assert_eq!(hermite_modular(&m).as_ref(), Some(&h), "n={n}: the modular path");
            }
        }
    }

    use super::*;

    fn z(v: &[&[i64]]) -> ZMat {
        v.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    /// The order reduction is optional: with every LLL refused, the number
    /// field's data and its class group are the same (the order's basis is
    /// kept as it is); the refusals did happen.
    #[test]
    fn a_refused_order_reduction_changes_no_result() {
        let f = [BigInt::from(-11), BigInt::zero(), BigInt::zero(), BigInt::one()];
        let key = |d: &NfData| (d.degree, d.r1, d.r2, d.disc.clone(), d.w, d.basis.clone(), d.den.clone());
        let bkey = |d: &BnfData| (d.degree, d.r1, d.r2, d.disc.clone(), d.h.clone(), d.cyc.clone(), d.w);
        let (n0, b0) = (nf_data(&f).unwrap(), bnf(&f).unwrap());
        REFUSE_LLL.with(|r| r.set(true));
        let c0 = LLL_REFUSED.with(|c| c.get());
        let got = (nf_data(&f), bnf(&f));
        REFUSE_LLL.with(|r| r.set(false));
        assert!(LLL_REFUSED.with(|c| c.get()) > c0, "no LLL was refused");
        let (n1, b1) = (got.0.unwrap(), got.1.unwrap());
        assert_eq!(key(&n0), key(&n1));
        assert_eq!(bkey(&b0), bkey(&b1));
        // a refusal reaches matrix.LLL() as an error, worded for the reduction
        REFUSE_LLL.with(|r| r.set(true));
        let e = lll(&z(&[&[1, 2], &[3, 4]])).unwrap_err();
        REFUSE_LLL.with(|r| r.set(false));
        assert!(e.starts_with("LLL: resource limit exceeded"), "{e}");
    }

    /// elementary_divisors against the smallest-pivot elimination it
    /// replaced, on every route: square nonsingular, square singular, tall
    /// and wide (the two Hermite compressions), zero, empty, and
    /// relation-like tall matrices with an h* I block appended.
    #[test]
    fn elementary_divisors_agree_with_the_elimination() {
        let mut seed = 0x0123_4567_89ab_cdefu64;
        let mut next = |m: i64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % (2 * m as u64 + 1)) as i64 - m
        };
        let mut shapes: Vec<ZMat> = vec![vec![], vec![vec![]], vec![vec![]; 3]];
        for (r, c) in [(1, 1), (2, 2), (3, 3), (5, 5), (7, 7), (2, 5), (5, 2), (4, 7), (7, 4), (1, 6), (6, 1)] {
            for range in [0, 1, 9, 1000] {
                let a: ZMat = (0..r).map(|_| (0..c).map(|_| BigInt::from(next(range))).collect()).collect();
                shapes.push(a);
            }
            // rank deficient: a product through an inner dimension of about half
            let h = (r.min(c) / 2).max(1);
            let b: Vec<Vec<i64>> = (0..r).map(|_| (0..h).map(|_| next(5)).collect()).collect();
            let cm: Vec<Vec<i64>> = (0..h).map(|_| (0..c).map(|_| next(5)).collect()).collect();
            shapes.push((0..r).map(|i| (0..c).map(|j| BigInt::from((0..h).map(|t| b[i][t] * cm[t][j]).sum::<i64>())).collect()).collect());
        }
        // relations with h* I appended (the class group's shape)
        for hs in [12i64, 360, 1_000_003] {
            let m = 4;
            let mut a: ZMat = (0..6).map(|_| (0..m).map(|_| BigInt::from(next(50))).collect()).collect();
            a.extend((0..m).map(|t| (0..m).map(|j| BigInt::from(if j == t { hs } else { 0 })).collect()));
            shapes.push(a);
        }
        for a in shapes {
            assert_eq!(elementary_divisors(&a), elementary_divisors_elim(&a), "{:?}", a);
        }
    }

    #[test]
    fn against_sage() {
        // M = matrix(ZZ, [[4,6,2],[3,9,12],[1,1,1]]): Sage's outputs
        let m = z(&[&[4, 6, 2], &[3, 9, 12], &[1, 1, 1]]);
        assert_eq!(hermite(&m), z(&[&[1, 1, 1], &[0, 2, 13], &[0, 0, 15]]));
        assert_eq!(elementary_divisors(&m), vec![BigInt::from(1), BigInt::from(1), BigInt::from(30)]);
        assert_eq!(lll(&z(&[&[1, 2, 3], &[4, 5, 6], &[7, 8, 10]])).unwrap(), z(&[&[0, 0, 1], &[-1, 1, 0], &[2, 1, 0]]));
        let r = complex_roots(&[BigInt::from(-2), BigInt::zero(), BigInt::zero(), BigInt::one()], 15).unwrap();
        assert_eq!(r[0].0, "1.25992104989487");
        assert_eq!(r[0].1, "0");
        let d = nf_data(&[BigInt::from(-11), BigInt::zero(), BigInt::zero(), BigInt::one()]).unwrap();
        assert_eq!((d.disc.clone(), d.r1, d.r2, d.w), (BigInt::from(-3267), 1, 1, 2));
        assert_eq!(factor_integer(&((BigInt::one() << 128usize) + 1)).unwrap(), vec![("59649589127497217".parse().unwrap(), 1), ("5704689200685129054721".parse().unwrap(), 1)]);
    }
}

#[cfg(test)]
mod lll_budget_tests {
    use super::*;
    use sagebrush_poly::budget::{with_default_limits, Limits, LLL};
    use sagebrush_poly::lll::{basis_bytes, cap_bits, hnf_budgeted, hnf_bytes, l2_route_plain, lattice_bytes, rank_bytes};
    use sagebrush_poly::Budget;

    fn z(v: &[&[i64]]) -> ZMat {
        v.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    fn bits(m: &ZMat) -> u64 {
        m.iter().map(|r| row_bits(r)).max().unwrap_or(0)
    }

    /// Random rows (an xorshift): r rows of n entries of up to `b` bits, signed.
    fn rand_rows(r: usize, n: usize, b: u32, seed: &mut u64) -> ZMat {
        let mut word = || {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        };
        (0..r)
            .map(|_| {
                (0..n)
                    .map(|_| {
                        let mut v = BigInt::zero();
                        for _ in 0..b.div_ceil(64) {
                            v = (v << 64usize) + BigInt::from(word());
                        }
                        let v = v >> (b.div_ceil(64) * 64 - b) as usize;
                        if word() & 1 == 1 { -v } else { v }
                    })
                    .collect()
            })
            .collect()
    }

    /// The reduction's state for k rows of n entries of e bits: L^2's
    /// (`l2_route_plain`) or the exact LLL's lattice.
    fn state(k: usize, n: usize, e: u64) -> u64 {
        l2_route_plain(k, n, e).map_or_else(|| lattice_bytes(k, n, cap_bits(k, e).unwrap()).unwrap(), |rt| rt.state)
    }

    /// The whole call's peak, from its reservations' lifetimes: independent,
    /// max(R_rank, I + S, O + Z0); dependent, max(R_rank', H(c_max), H_held
    /// + S, O + Z), with R_rank' = 0 when r > n. Fewer than 2 rows to reduce
    /// are handed back as they are: no state S, and O is what they held.
    fn model(m: &ZMat, out: &ZMat, independent: bool) -> u64 {
        let (r, n, e) = (m.len(), m[0].len(), bits(m));
        let red: ZMat = out.iter().filter(|x| x.iter().any(|y| !y.is_zero())).cloned().collect();
        let k = red.len();
        let z = basis_bytes(r - k, n, 0).unwrap() + 24 * r as u64;
        let rank = if r <= n { rank_bytes(r, n).unwrap() } else { 0 };
        let (held, s, extra) = if independent {
            let i = basis_bytes(r, n, e).unwrap();
            (i, if k < 2 { 0 } else { state(r, n, e) }, 0)
        } else {
            let (h, _, c) = hnf_budgeted(&Budget::default(), m).unwrap();
            assert_eq!(h.len(), k);
            let eh = bits(&h);
            (basis_bytes(k, n, eh).unwrap(), if k < 2 { 0 } else { state(k, n, eh) }, hnf_bytes(r, n, c).unwrap())
        };
        let o = if k < 2 { held } else { basis_bytes(k, n, bits(&red)).unwrap() };
        rank.max(extra).max(held + s).max(o + z)
    }

    /// A dependent and an independent input, each of an L^2 and an exact
    /// shape, more rows than columns, and the hand-off's edge cases (a
    /// thousand equal rows, all-zero rows, one row): the Budget's peak is the model's exactly; through the public
    /// route at that memory limit the result is the unlimited one, and one
    /// byte less refuses with an "LLL:" memory message, short by one byte
    /// with nothing left reserved.
    #[test]
    fn the_whole_call_peaks_where_its_reservations_say() {
        let mut seed = 0x11c3_0b5e_u64;
        let mut cases: Vec<(ZMat, bool)> = vec![];
        for (r, n, b) in [(6, 7, 40), (24, 25, 300)] {
            cases.push((rand_rows(r, n, b, &mut seed), true));
            // dependent with r <= n: a combination of two rows appended
            let mut m = rand_rows(r - 1, n, b, &mut seed);
            let extra: Vec<BigInt> = m[0].iter().zip(&m[1]).map(|(x, y)| x * BigInt::from(3) - y).collect();
            m.insert(2, extra);
            cases.push((m, false));
        }
        // more rows than columns
        cases.push((rand_rows(9, 5, 20, &mut seed), false));
        // the hand-off's edge cases: a thousand equal rows (rank 1), zero rows
        // (rank 0), and one row
        cases.push(((0..1000).map(|_| z(&[&[1, 2]])[0].clone()).collect(), false));
        cases.push(((0..50).map(|_| vec![BigInt::zero(); 3]).collect(), false));
        cases.push((z(&[&[3, -5, 7]]), true));
        let mut routes = vec![];
        for (m, independent) in cases {
            let (r, n) = (m.len(), m[0].len());
            let want = lll(&m).unwrap();
            let b = Budget::default();
            assert_eq!(lll_in(&b, &m).unwrap(), want);
            let p = model(&m, &want, independent);
            assert_eq!(b.peak(), p, "{r}x{n} independent={independent}: the Budget's peak");
            assert_eq!(b.live(), 0);
            routes.push(l2_route_plain(r, n, bits(&m)).is_some());
            let lim = |memory| Limits { memory, ..Limits::UNLIMITED };
            assert_eq!(with_default_limits(lim(p), || lll(&m)), Ok(want), "{r}x{n}: at the peak");
            let e = with_default_limits(lim(p - 1), || lll(&m)).unwrap_err();
            assert!(e.starts_with("LLL: resource limit exceeded") && e.contains("memory"), "{r}x{n}: {e}");
            let b = Budget::new(lim(p - 1));
            let e = lll_in(&b, &m).unwrap_err();
            assert_eq!((e.what, e.need - e.remaining, b.live()), ("memory", 1, 0), "{r}x{n}");
        }
        assert!(routes.contains(&true) && routes.contains(&false), "both routes: {routes:?}");
    }

    /// The budgeted Hermite form is `zlin::hnf`'s, its reservation handed
    /// back at the rows' `basis_bytes`.
    #[test]
    fn the_budgeted_hermite_form_is_zlins() {
        let mut seed = 0x4e_a1_7e_u64;
        for (r, n, b) in [(9, 5, 30), (7, 7, 200), (12, 4, 8), (5, 9, 60)] {
            let mut m = rand_rows(r, n, b, &mut seed);
            if r <= n {
                let extra: Vec<BigInt> = m[0].iter().zip(&m[1]).map(|(x, y)| x - y * BigInt::from(5)).collect();
                m.push(extra);
            }
            let bud = Budget::default();
            let (h, res, _) = hnf_budgeted(&bud, &m).unwrap();
            assert_eq!(h, crate::nf::zlin::hnf(&m), "{r}x{n}");
            assert_eq!(res.bytes(), basis_bytes(h.len(), n, bits(&h)).unwrap());
        }
    }

    /// The Hermite stage's growth refuses as memory under the policy, an
    /// "LLL:" resource limit, with nothing left reserved; a policy with room
    /// for the final bound admits it.
    #[test]
    fn hermite_growth_refuses_as_memory() {
        let mut seed = 0x0009_e077_u64;
        let mut m = rand_rows(15, 14, 100, &mut seed);
        m.push(m[0].iter().zip(&m[1]).map(|(x, y)| x * BigInt::from(2) + y).collect());
        let (r, n, e) = (m.len(), m[0].len(), bits(&m));
        let (_, _, c) = hnf_budgeted(&Budget::default(), &m).unwrap();
        assert!(c > e + 64, "the bound grew from {e} to {c} only");
        let lim = |memory| Limits { memory, ..Limits::UNLIMITED };
        let b = Budget::new(lim(hnf_bytes(r, n, (e + c) / 2).unwrap()));
        let err = hnf_budgeted(&b, &m).map(|_| ()).unwrap_err();
        assert_eq!(err.what, "memory");
        assert_eq!(b.live(), 0);
        let msg = err.message(&LLL);
        assert!(msg.starts_with("LLL: resource limit exceeded"), "{msg}");
        assert!(hnf_budgeted(&Budget::new(lim(hnf_bytes(r, n, c).unwrap())), &m).is_ok());
    }

    /// `lll_in`'s own debits come before their work: with the work limit
    /// set to what was used just before one, the call refuses there, as
    /// work, with nothing left reserved; the shape, the independent rows'
    /// copy and the output are each reached (dependent and independent).
    #[test]
    fn lll_in_debits_before_each_step() {
        let mut seed = 0x51_7e_5d_u64;
        let ind = rand_rows(5, 6, 70, &mut seed);
        let mut dep = rand_rows(4, 6, 70, &mut seed);
        dep.push(dep[0].iter().zip(&dep[2]).map(|(x, y)| x - y).collect());
        for (m, want_sites) in [(ind, vec!["copy", "output", "shape"]), (dep, vec!["output", "shape"])] {
            LLL_TRACE.with(|t| *t.borrow_mut() = Some(vec![]));
            let want = lll_in(&Budget::default(), &m).unwrap();
            let sites = LLL_TRACE.with(|t| t.borrow_mut().take().unwrap());
            let mut seen: Vec<&str> = sites.iter().map(|x| x.0).collect();
            seen.sort();
            assert_eq!(seen, want_sites);
            for (k, &(site, left)) in sites.iter().enumerate() {
                LLL_TRACE.with(|t| *t.borrow_mut() = Some(vec![]));
                let b = Budget::new(Limits { work: u64::MAX - left, ..Limits::UNLIMITED });
                let err = lll_in(&b, &m).unwrap_err();
                let got = LLL_TRACE.with(|t| t.borrow_mut().take().unwrap());
                assert_eq!((err.what, got.len(), got.last().map(|x| x.0)), ("work", k + 1, Some(site)), "debit {k} ({site})");
                assert_eq!(b.live(), 0, "debit {k} ({site})");
            }
            assert_eq!(lll(&m).unwrap(), want);
        }
    }

    /// An unlucky prime (one dividing every maximal minor) sends
    /// independent rows through the Hermite form: still a reduced basis of
    /// their lattice, with no zero rows.
    #[test]
    fn an_unlucky_prime_still_gives_a_reduced_basis() {
        let m = z(&[&[7, 14, 0], &[3, 6, 7], &[1, 9, 49]]);
        assert_eq!(sagebrush_poly::lll::rank_mod_p(&Budget::default(), &m, 7), Ok(1));
        RANK_P.with(|c| c.set(7));
        let got = lll(&m);
        RANK_P.with(|c| c.set(0));
        let out = got.unwrap();
        assert!(out.iter().all(|r| r.iter().any(|x| !x.is_zero())));
        assert_eq!(sagebrush_poly::lll_cert::certify(&m, &out, (51, 100), (99, 100)), Ok(()));
    }

    /// A finite work limit refuses in the shape, rank or Hermite stage (as
    /// work) or in the reduction, with nothing left reserved and no fallback.
    #[test]
    fn work_limits_refuse_in_every_stage() {
        let mut seed = 0x3c_0de_u64;
        let mut m = rand_rows(5, 8, 100, &mut seed);
        m.push(m[0].iter().zip(&m[4]).map(|(x, y)| x + y).collect());
        let (r, n) = (m.len() as u64, 8u64);
        let full = Budget::default();
        lll_in(&full, &m).unwrap();
        let used = u64::MAX - full.work_left();
        for work in [1, r * n + 2, 3 * r * n + 2, used - 1] {
            let b = Budget::new(Limits { work, ..Limits::UNLIMITED });
            let e = lll_in(&b, &m).unwrap_err();
            // the last one runs out in the reduction, L^2's work
            let want = if work == used - 1 { "l2 work" } else { "work" };
            assert_eq!(e.what, want, "work {work}: {e}");
            assert_eq!(b.live(), 0);
        }
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
