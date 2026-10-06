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
pub fn hecke_charpoly(n: u32, q: u32, p: Option<u32>, threads: Option<u32>) -> Result<ModP> {
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
pub fn charpoly_exact(n: u32, q: u32, threads: Option<u32>) -> Result<ExactResult> {
    let e = run(threads, || sagebrush_modsym::exact::exact_charpoly(n as u64, q as u64)).map_err(err)?;
    Ok(exact_obj(&e))
}

/// charpolyExact for many levels in parallel; a failed level has `error` set.
#[napi(namespace = "modsym")]
pub fn batch_exact(levels: Vec<u32>, q: u32, threads: Option<u32>) -> Vec<ExactResult> {
    let ls: Vec<u64> = levels.iter().map(|&n| n as u64).collect();
    let rs = run(threads, || sagebrush_modsym::exact::batch_exact(&ls, q as u64));
    ls.iter()
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
        .collect()
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
pub fn level_data(n: u32) -> LevelData {
    let (psi, genus, cusps, eis, dim) = sagebrush_modsym::exact::level_data(n as u64);
    LevelData { psi: psi as f64, genus: genus as f64, cusps: cusps as f64, eisenstein: eis as f64, dim: dim as f64 }
}

/// Whether T_q and T_r commute mod p.
#[napi(namespace = "modsym")]
pub fn commute(n: u32, q: u32, r: u32, p: Option<u32>, threads: Option<u32>) -> Result<bool> {
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
pub fn estimate(n: u32, q: u32) -> Result<Estimate> {
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

fn curve(a: Vec<i64>) -> Result<sagebrush_ap::EllipticCurve> {
    let a: [i64; 5] = a.try_into().map_err(|_| err("a curve is [a1, a2, a3, a4, a6]".into()))?;
    sagebrush_ap::EllipticCurve::new(a).map_err(err)
}

/// a_p of y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6, or null if p divides the discriminant.
#[napi(namespace = "ap")]
pub fn ap(a: Vec<i64>, p: i64) -> Result<Option<i64>> {
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
pub fn aplist(a: Vec<i64>, n: i64, threads: Option<u32>) -> Result<ApList> {
    let e = curve(a)?;
    let r = run(threads, || sagebrush_ap::aplist(&e, n as u64));
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
pub fn moments(a: Vec<i64>, n: i64, kmax: Option<u32>, threads: Option<u32>) -> Result<Moments> {
    let e = curve(a)?;
    let (count, moments) = run(threads, || sagebrush_ap::moments(&e, n as u64, kmax.unwrap_or(4) as usize));
    Ok(Moments { count: count as f64, moments })
}
