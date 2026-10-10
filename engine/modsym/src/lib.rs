//! Weight-2 modular symbols for Gamma0(N), sign +1: Hecke operators and
//! their characteristic polynomials, over GF(p) and exactly over Z.
//!
//! * `presentation`: P^1(Z/NZ) (Sage's normalization, O(N d(N)) memory),
//!   2-term relations by a signed union-find, integer 3-term relations.
//! * `space`: the quotient over GF(p) by sparse elimination; T_q via
//!   Cremona's Heilbronn matrices, parallel over basis elements.
//! * `exact`: characteristic polynomials over Z by CRT over primes with a
//!   per-prime dimension check and a proven coefficient bound.
//! * `estimate`: predicted dimension, time and memory before running.
//! * `general`: any weight k >= 2, Dirichlet character and sign, over
//!   GF(ell) with ell = 1 mod ord(eps); validated against Sage.
//!
//! Invalid input (q not a prime, q | N, p out of range) is an `Err`, never a
//! panic, so a batch over many levels reports bad entries and keeps going.
//!
//! With the `parallel` feature, work runs on the current rayon pool.

mod par;
pub mod estimate;
pub mod cusps;
pub mod dims;
pub mod dirichlet;
pub mod exact;
pub mod general;
pub mod general_exact;
pub mod integral;
pub mod linalg;
pub mod newforms;
pub mod newspace;
pub mod orbits;
pub mod p1;
pub mod presentation;
pub mod space;
pub mod traces;

use presentation::Presentation;
use space::Space;

// std::time::Instant panics on wasm32-unknown-unknown; time from the host there.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn now() -> std::time::Instant {
    std::time::Instant::now()
}
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn elapsed_ms(a: std::time::Instant, b: std::time::Instant) -> f64 {
    (b - a).as_secs_f64() * 1000.0
}
#[cfg(target_arch = "wasm32")]
pub(crate) fn now() {}
#[cfg(target_arch = "wasm32")]
pub(crate) fn elapsed_ms(_: (), _: ()) -> f64 {
    0.0
}

#[derive(Debug, Clone)]
pub struct ModP {
    pub n: u64,
    pub q: u64,
    pub p: u64,
    pub symbols: usize,
    /// Free generators after the 2-term relations.
    pub gens: usize,
    pub dim: usize,
    pub charpoly: Vec<u64>,
    pub ms: [f64; 3],
}

impl ModP {
    /// The same hash modsym.py prints.
    pub fn hash(&self) -> u128 {
        self.charpoly.iter().fold(0u128, |h, &c| (h * 1000003 + c as u128) % 2305843009213693951)
    }
    pub fn eisenstein_root(&self) -> bool {
        let x = (self.q + 1) % self.p;
        self.charpoly.iter().rev().fold(0u64, |r, &c| (r * x + c) % self.p) == 0
    }
}

/// Checks the arguments shared by every entry point.
/// A level N >= 1.
pub fn check_level(n: u64) -> Result<(), String> {
    if n == 0 {
        return Err("the level must be a positive integer".into());
    }
    Ok(())
}

/// A weight k >= 2 (modular symbols).
pub fn check_weight(k: usize) -> Result<(), String> {
    if k < 2 {
        return Err("the weight must be an integer k >= 2".into());
    }
    Ok(())
}

pub fn validate(n: u64, q: u64, p: Option<u64>) -> Result<(), String> {
    if n == 0 || n > 1 << 31 {
        return Err(format!("level N = {} out of range", n));
    }
    if !exact::is_prime(q) || n % q == 0 {
        return Err(format!("q = {} must be a prime not dividing N = {}", q, n));
    }
    if let Some(p) = p {
        if p < 3 || p >= 1 << 31 || !exact::is_prime(p) {
            return Err(format!("p = {} must be an odd prime below 2^31", p));
        }
    }
    Ok(())
}

/// Characteristic polynomial of T_q over GF(p) (p < 2^31).
pub fn hecke_charpoly(n: u64, q: u64, p: u64) -> Result<ModP, String> {
    validate(n, q, Some(p))?;
    let t0 = now();
    let pres = Presentation::new(n);
    let sp = Space::new(&pres, p);
    let t1 = now();
    let t = sp.hecke_matrix(&pres, q);
    let t2 = now();
    let f = linalg::charpoly(t, p);
    let t3 = now();
    Ok(ModP { n, q, p, symbols: pres.p1.len(), gens: pres.m, dim: sp.dimension(), charpoly: f, ms: [elapsed_ms(t0, t1), elapsed_ms(t1, t2), elapsed_ms(t2, t3)] })
}

/// T_q T_r == T_r T_q over GF(p): an independent consistency check.
pub fn hecke_commute(n: u64, q: u64, r: u64, p: u64) -> Result<bool, String> {
    validate(n, q, Some(p))?;
    validate(n, r, None)?;
    let pres = Presentation::new(n);
    let sp = Space::new(&pres, p);
    let (a, b) = (sp.hecke_matrix(&pres, q), sp.hecke_matrix(&pres, r));
    Ok(linalg::matmul(&a, &b, p) == linalg::matmul(&b, &a, p))
}
