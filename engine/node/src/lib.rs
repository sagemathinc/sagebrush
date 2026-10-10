//! Node.js bindings (a native addon, multithreaded like the Python module).
//! Each engine is a namespace: `require("sagebrush").modsym` has the same
//! functions as the Python `sagebrush.modsym`, in camelCase; exact coefficients
//! are BigInts.  Calls are synchronous and use `threads` worker threads
//! (0 or omitted = all cores).  Invalid arguments throw.

use sagebrush_modsym::exact::Exact;
use napi::bindgen_prelude::BigInt;
use napi::{Error, Result};
use napi_derive::napi;

fn run<T: Send>(threads: Option<u32>, f: impl FnOnce() -> T + Send) -> T {
    rayon::ThreadPoolBuilder::new().num_threads(threads.unwrap_or(0) as usize).build().unwrap().install(f)
}

// JavaScript numbers are doubles: every integer argument is taken as one and
// checked to be an integer in range before use (N-API's own u32/i64
// conversion truncated 11.5 to 11 and wrapped 2^32 + 11 to 11, so a
// certificate was returned for a different problem: the systematic review's
// API-F8).
fn int_arg(name: &str, x: f64, lo: f64, hi: f64) -> Result<f64> {
    if !(x.is_finite() && x.fract() == 0.0 && x >= lo && x <= hi) {
        return Err(err(format!("{} = {} must be an integer in [{}, {}]", name, x, lo, hi)));
    }
    Ok(x)
}

fn u32_arg(name: &str, x: f64) -> Result<u32> {
    int_arg(name, x, 0.0, u32::MAX as f64).map(|v| v as u32)
}

fn opt_u32(name: &str, x: Option<f64>) -> Result<Option<u32>> {
    x.map(|v| u32_arg(name, v)).transpose()
}

/// An integer of magnitude below 2^53 (exactly a double).
fn i64_arg(name: &str, x: f64) -> Result<i64> {
    int_arg(name, x, -9007199254740991.0, 9007199254740991.0).map(|v| v as i64)
}

fn err(e: String) -> Error {
    Error::from_reason(e)
}

fn big(c: &sagebrush_bigint::BigInt) -> BigInt {
    let (sign, words) = c.to_u64_digits();
    BigInt { sign_bit: sign == sagebrush_bigint::Sign::Minus, words: if words.is_empty() { vec![0] } else { words } }
}

#[napi(object)]
pub struct ModP {
    pub symbols: u32,
    pub gens: u32,
    pub dim: u32,
    /// Constant term first, reduced mod p.
    pub charpoly: Vec<u32>,
    pub hash: String,
    pub eisenstein_root: bool,
    pub ms: Vec<f64>,
}

/// T_q's characteristic polynomial mod p (constant term first).
#[napi(namespace = "modsym")]
pub fn hecke_charpoly(n: f64, q: f64, p: Option<f64>, threads: Option<f64>) -> Result<ModP> {
    let (n, q, p, threads) = (u32_arg("n", n)?, u32_arg("q", q)?, opt_u32("p", p)?, opt_u32("threads", threads)?);
    let p = p.unwrap_or(67108859) as u64;
    let r = run(threads, || sagebrush_modsym::hecke_charpoly(n as u64, q as u64, p)).map_err(err)?;
    Ok(ModP {
        symbols: r.symbols as u32,
        gens: r.gens as u32,
        dim: r.dim as u32,
        charpoly: r.charpoly.iter().map(|&c| c as u32).collect(),
        hash: r.hash().to_string(),
        eisenstein_root: r.eisenstein_root(),
        ms: r.ms.to_vec(),
    })
}

#[napi(object)]
pub struct ExactResult {
    pub n: u32,
    pub q: u32,
    pub genus: u32,
    pub cusps: u32,
    pub eisenstein: u32,
    pub dim: u32,
    /// Constant term first; monic.
    pub charpoly: Vec<BigInt>,
    pub primes_used: u32,
    pub bound_bits: f64,
    pub status: String,
    pub checks: Vec<String>,
    /// Set instead of the fields above when a level in a batch failed.
    pub error: Option<String>,
}

fn exact_obj(e: &Exact) -> ExactResult {
    ExactResult {
        n: e.n as u32,
        q: e.q as u32,
        genus: e.genus as u32,
        cusps: e.cusps as u32,
        eisenstein: e.eis as u32,
        dim: e.dim as u32,
        charpoly: e.coeffs.iter().map(big).collect(),
        primes_used: e.primes_used.len() as u32,
        bound_bits: e.bound_bits,
        status: e.status.to_string(),
        checks: e.checks.clone(),
        error: None,
    }
}

/// T_q's characteristic polynomial over Z, proven by CRT with a coefficient bound.
#[napi(namespace = "modsym")]
pub fn charpoly_exact(n: f64, q: f64, threads: Option<f64>) -> Result<ExactResult> {
    let (n, q, threads) = (u32_arg("n", n)?, u32_arg("q", q)?, opt_u32("threads", threads)?);
    let e = run(threads, || sagebrush_modsym::exact::exact_charpoly(n as u64, q as u64)).map_err(err)?;
    Ok(exact_obj(&e))
}

/// charpolyExact for many levels in parallel; a failed level has `error` set.
#[napi(namespace = "modsym")]
pub fn batch_exact(levels: Vec<f64>, q: f64, threads: Option<f64>) -> Result<Vec<ExactResult>> {
    let (q, threads) = (u32_arg("q", q)?, opt_u32("threads", threads)?);
    let ls: Vec<u64> = levels.iter().map(|&n| u32_arg("level", n).map(|v| v as u64)).collect::<Result<_>>()?;
    let rs = run(threads, || sagebrush_modsym::exact::batch_exact(&ls, q as u64));
    Ok(ls
        .iter()
        .zip(rs)
        .map(|(&n, r)| match r {
            Ok(e) => exact_obj(&e),
            Err(e) => ExactResult {
                n: n as u32,
                q,
                genus: 0,
                cusps: 0,
                eisenstein: 0,
                dim: 0,
                charpoly: vec![],
                primes_used: 0,
                bound_bits: 0.0,
                status: "error".into(),
                checks: vec![],
                error: Some(e),
            },
        })
        .collect())
}

#[napi(object)]
pub struct LevelData {
    pub psi: f64,
    pub genus: f64,
    pub cusps: f64,
    pub eisenstein: f64,
    pub dim: f64,
}

/// Psi(N), genus, cusps, Eisenstein dimension and dimension of the sign +1 space.
#[napi(namespace = "modsym")]
pub fn level_data(n: f64) -> Result<LevelData> {
    let n = u32_arg("n", n)?;
    let (psi, genus, cusps, eis, dim) = sagebrush_modsym::exact::level_data(n as u64);
    Ok(LevelData { psi: psi as f64, genus: genus as f64, cusps: cusps as f64, eisenstein: eis as f64, dim: dim as f64 })
}

/// Whether T_q and T_r commute mod p.
#[napi(namespace = "modsym")]
pub fn commute(n: f64, q: f64, r: f64, p: Option<f64>, threads: Option<f64>) -> Result<bool> {
    let (n, q, r, p, threads) = (u32_arg("n", n)?, u32_arg("q", q)?, u32_arg("r", r)?, opt_u32("p", p)?, opt_u32("threads", threads)?);
    let p = p.unwrap_or(67108859) as u64;
    run(threads, || sagebrush_modsym::hecke_commute(n as u64, q as u64, r as u64, p)).map_err(err)
}

#[napi(object)]
pub struct Estimate {
    pub symbols: f64,
    pub dim: f64,
    pub genus: f64,
    pub primes: f64,
    pub primes_max: f64,
    pub bytes_modp: f64,
    pub bytes_exact: f64,
    pub seconds_modp: f64,
    pub seconds_exact: f64,
}

/// Predicted dimension, bytes and single-thread seconds, without computing.
#[napi(namespace = "modsym")]
pub fn estimate(n: f64, q: f64) -> Result<Estimate> {
    let (n, q) = (u32_arg("n", n)?, u32_arg("q", q)?);
    sagebrush_modsym::validate(n as u64, q as u64, None).map_err(err)?;
    let e = sagebrush_modsym::estimate::estimate(n as u64, q as u64);
    Ok(Estimate {
        symbols: e.symbols as f64,
        dim: e.dim as f64,
        genus: e.genus as f64,
        primes: e.primes as f64,
        primes_max: e.primes_max as f64,
        bytes_modp: e.bytes_modp,
        bytes_exact: e.bytes_exact,
        seconds_modp: e.seconds_modp,
        seconds_exact: e.seconds_exact,
    })
}

// ---- ap: traces of Frobenius of elliptic curves ----

fn curve(a: Vec<f64>) -> Result<sagebrush_ap::EllipticCurve> {
    let a: Vec<i64> = a.iter().map(|&c| i64_arg("a coefficient", c)).collect::<Result<_>>()?;
    let a: [i64; 5] = a.try_into().map_err(|_| err("a curve is [a1, a2, a3, a4, a6]".into()))?;
    sagebrush_ap::EllipticCurve::new(a).map_err(err)
}

/// a_p of y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6, or null if p divides the discriminant.
#[napi(namespace = "ap")]
pub fn ap(a: Vec<f64>, p: f64) -> Result<Option<i64>> {
    let p = i64_arg("p", p)?;
    if p < 2 || !sagebrush_modsym::exact::is_prime(p as u64) {
        return Err(err(format!("p = {} must be a prime", p)));
    }
    Ok(curve(a)?.ap(p as u64))
}

#[napi(object)]
pub struct ApList {
    pub primes: Vec<i64>,
    /// a_p, or null at primes dividing the discriminant.
    pub ap: Vec<Option<i64>>,
}

/// a_p for all primes p <= n, in parallel.
#[napi(namespace = "ap")]
pub fn aplist(a: Vec<f64>, n: f64, threads: Option<f64>) -> Result<ApList> {
    let (n, threads) = (int_arg("n", n, 0.0, 9007199254740991.0)? as u64, opt_u32("threads", threads)?);
    let e = curve(a)?;
    let r = run(threads, || sagebrush_ap::aplist(&e, n));
    Ok(ApList { primes: r.iter().map(|x| x.0 as i64).collect(), ap: r.iter().map(|x| x.1).collect() })
}

#[napi(object)]
pub struct Moments {
    pub count: f64,
    /// mean((a_p^2 / p)^k) for k = 1..kmax.
    pub moments: Vec<f64>,
}

/// Sato-Tate moments over the good primes p <= n.
#[napi(namespace = "ap")]
pub fn moments(a: Vec<f64>, n: f64, kmax: Option<f64>, threads: Option<f64>) -> Result<Moments> {
    let (n, kmax, threads) = (int_arg("n", n, 0.0, 9007199254740991.0)? as u64, opt_u32("kmax", kmax)?, opt_u32("threads", threads)?);
    let e = curve(a)?;
    let (count, moments) = run(threads, || sagebrush_ap::moments(&e, n, kmax.unwrap_or(4) as usize));
    Ok(Moments { count: count as f64, moments })
}
