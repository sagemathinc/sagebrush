//! Galois orbits of newforms of weight 2 on Gamma0(N) and their Hecke data.
//!
//! Take T = sum r_i T_{q_i} (small coefficients, q_i not dividing N) and
//! factor chi(T) in Z[x].  Generically distinct eigen-systems give distinct
//! irreducible factors.  A newform orbit occurs once in the sign +1 space,
//! while an old orbit from level M | N occurs d(N/M) >= 2 times, and the
//! Eisenstein factors are exactly those dividing the charpoly chi_E of T
//! on the boundary image delta(M) (computed mod ell).  So the new orbits
//! are the non-Eisenstein irreducible factors of exponent one.  Their
//! degrees must add up to dim S_2^new(N) = sum_{M | N} beta(N/M) g(M); if
//! not (an accidental coincidence), the next combination is tried.
//! Factoring is passed in by the caller (e.g. FLINT via sagebrush-flint),
//! so this crate stays free of it.
//!
//! Each orbit is found in the dual space mod ell without forming f(T):
//! with h = chi / f coprime to f, A^dual = image of h(T), and it is cyclic,
//! so it is spanned by u, Tu, ..., T^(k-1) u for u = h(T) v.  Then, from
//! k functionals w_1..w_k on the Manin-symbol generators (row reduced):
//!   tr(T_p | A) = sum_r (T_p w_r)[pivot_r]: k Heilbronn sums per prime;
//!   c_{p,r} = w_r(T_p x) for a fixed generator x: the coordinates of a_p
//!   in Stein's basis (a_p = sum_r beta_r c_{p,r}, beta_r fixed in K).

use crate::cusps;
use crate::exact::{exact_charpoly_combo, factor as factor_int, is_prime, level_data};
use crate::linalg;
use crate::newforms::{heilbronn_pairing, rref, ELL};
use crate::par;
use crate::presentation::Presentation;
use crate::space::Space;
use sagebrush_bigint::BigInt;
use num_traits::ToPrimitive;

/// Factors a polynomial in Z[x] (constant term first) into irreducible
/// factors with multiplicities.
pub type Factorer<'a> = &'a (dyn Fn(&[BigInt]) -> Vec<(Vec<BigInt>, u32)> + Sync);

/// Calls the factorer on monic f and checks its answer: the factors are
/// irreducible and their product with multiplicities is f.
pub(crate) fn checked_factor(factor: Factorer, f: &[BigInt]) -> Result<Vec<(Vec<BigInt>, u32)>, String> {
    let fs = factor(f);
    let mut prod = vec![BigInt::from(1)];
    for (g, e) in &fs {
        if g.len() < 2 {
            return Err("the factor callback returned a constant factor".into());
        }
        for _ in 0..*e {
            prod = poly_mul_z(&prod, g);
        }
    }
    if prod != f || fs.iter().any(|(g, _)| g.len() > 2 && !sagebrush_poly::is_irreducible(g)) {
        return Err("the factor callback did not return an irreducible factorization".into());
    }
    Ok(fs)
}

fn poly_mul_z(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut out = vec![BigInt::from(0); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            out[i + j] += x * y;
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct Orbit {
    pub dim: usize,
    /// The operator T = sum r T_q and the irreducible f in Z[x] with A = ker f(T).
    pub ops: Vec<(u64, i64)>,
    pub f: Vec<BigInt>,
    /// tr(T_p | A) for primes p <= bound, p != N.
    pub traces: Vec<(u64, i64)>,
    /// c_{p,r} = w_r(T_p x) mod ell (r = 1..dim), for the same primes.
    pub c: Vec<(u64, Vec<u64>)>,
}

pub(crate) fn mulmod(a: u64, b: u64, p: u64) -> u64 {
    (a as u128 * b as u128 % p as u128) as u64
}

/// (T v)_i = sum_j T[i][j] v_j mod p: the action on functionals.
fn matvec(t: &[Vec<u64>], v: &[u64], p: u64) -> Vec<u64> {
    par::map_slice(t, |row| (row.iter().zip(v).fold(0u128, |s, (&a, &b)| s + a as u128 * b as u128) % p as u128) as u64)
}

/// Quotient of a by b mod p (b monic), constant term first.
fn poly_div(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let (n, m) = (a.len() - 1, b.len() - 1);
    let mut r = a.to_vec();
    let mut q = vec![0u64; n - m + 1];
    for i in (0..=n - m).rev() {
        let c = r[i + m];
        q[i] = c;
        if c != 0 {
            for j in 0..=m {
                r[i + j] = (r[i + j] + p - mulmod(c, b[j], p)) % p;
            }
        }
    }
    debug_assert!(r.iter().all(|&x| x == 0), "inexact division");
    q
}

pub(crate) fn reduce(f: &[BigInt], p: u64) -> Vec<u64> {
    let pb = BigInt::from(p);
    f.iter().map(|c| ((c % &pb + &pb) % &pb).to_u64().unwrap()).collect()
}

/// dim S_2^new(Gamma0(N)) = sum_{M | N} beta(N/M) g(M), with beta
/// multiplicative, beta(p) = -2, beta(p^2) = 1, beta(p^k) = 0 for k >= 3.
pub fn new_dimension(n: u64) -> i64 {
    let beta = |m: u64| -> i64 {
        factor_int(m).iter().map(|&(_, e)| match e { 1 => -2, 2 => 1, _ => 0 }).product()
    };
    (1..=n).filter(|m| n % m == 0).map(|m| beta(n / m) * level_data(m).1 as i64).sum()
}

/// The charpoly mod p of the operator induced by T on the boundary image
/// delta(M) (the Eisenstein quotient), from the boundaries of the basis.
fn eisenstein_charpoly(sp: &Space, pres: &Presentation, t: &[Vec<u64>], p: u64) -> Vec<u64> {
    let (bnd, ncusp) = cusps::boundary(pres, true);
    let d = sp.dimension();
    let rows: Vec<Vec<u64>> = sp.basis_gen.iter().map(|&g| {
        let mut v = vec![0u64; ncusp];
        for &(c, s) in &bnd[g as usize] {
            v[c] = (v[c] + modp(s, p)) % p;
        }
        v
    }).collect();
    // Basis elements whose boundaries span the image.
    let mut chosen: Vec<usize> = vec![];
    let mut ech: Vec<Vec<u64>> = vec![];
    for i in 0..d {
        let mut trial = ech.clone();
        trial.push(rows[i].clone());
        let r = linalg::rref_mod(trial.clone(), p).0;
        if r.len() > ech.len() {
            ech = r;
            chosen.push(i);
        }
    }
    let e = chosen.len();
    if e == 0 {
        return vec![1];
    }
    // Coordinates on the chosen boundaries via e pivot columns.
    let basis: Vec<Vec<u64>> = chosen.iter().map(|&i| rows[i].clone()).collect();
    let (_, pivots) = linalg::rref_mod(basis.clone(), p);
    let sq: Vec<Vec<u64>> = (0..e).map(|r| pivots.iter().map(|&c| basis[r][c]).collect()).collect();
    let inv = invert(&sq, p);
    let b: Vec<Vec<u64>> = chosen.iter().map(|&i| {
        let mut v = vec![0u64; ncusp];
        for k in 0..d {
            if t[i][k] != 0 {
                for (x, &y) in v.iter_mut().zip(&rows[k]) {
                    *x = (*x + mulmod(t[i][k], y, p)) % p;
                }
            }
        }
        let vp: Vec<u64> = pivots.iter().map(|&c| v[c]).collect();
        (0..e).map(|s| (0..e).fold(0u64, |acc, r| (acc + mulmod(vp[r], inv[r][s], p)) % p)).collect()
    }).collect();
    linalg::charpoly(b, p)
}

/// The inverse of a square matrix mod p (rows: c = v * inv solves c * m = v).
fn invert(m: &[Vec<u64>], p: u64) -> Vec<Vec<u64>> {
    let e = m.len();
    let aug: Vec<Vec<u64>> = (0..e).map(|i| {
        let mut r = m[i].clone();
        r.extend((0..e).map(|j| if i == j { 1 } else { 0 }));
        r
    }).collect();
    let (r, _) = linalg::rref_mod(aug, p);
    r.into_iter().map(|row| row[e..].to_vec()).collect()
}

fn modp(a: i64, p: u64) -> u64 {
    a.rem_euclid(p as i64) as u64
}

fn divides(f: &[u64], g: &[u64], p: u64) -> bool {
    if g.len() < f.len() {
        return false;
    }
    let lead_inv = crate::newforms::inv(*f.last().unwrap(), p);
    let mut r = g.to_vec();
    for i in (0..=g.len() - f.len()).rev() {
        let c = mulmod(r[i + f.len() - 1], lead_inv, p);
        if c != 0 {
            for j in 0..f.len() {
                r[i + j] = (r[i + j] + p - mulmod(c, f[j], p)) % p;
            }
        }
    }
    r.iter().all(|&x| x == 0)
}

/// The Galois orbits of newforms of prime level N (see `newform_orbits`).
pub fn prime_level_orbits(n: u64, bound: u64, factor: Factorer) -> Result<Vec<Orbit>, String> {
    if !is_prime(n) {
        return Err(format!("N = {} is not prime", n));
    }
    newform_orbits(n, bound, factor)
}

/// The Galois orbits of newforms of level N, with tr(T_p | A) and the
/// coordinates c_p of a_p for primes p <= bound not dividing N.
pub fn newform_orbits(n: u64, bound: u64, factor: Factorer) -> Result<Vec<Orbit>, String> {
    if bound >= crate::linalg::MAX_HECKE_PRIME {
        return Err(format!("bound {} must be below 2^30", bound));
    }
    let p = ELL;
    let new_dim = new_dimension(n);
    if new_dim <= 0 {
        return Ok(vec![]);
    }
    let pres = Presentation::new(n);
    let sp = Space::new(&pres, p);
    let d = sp.dimension();
    let qs: Vec<u64> = (2..).filter(|&q| is_prime(q) && n % q != 0).take(8).collect();
    // Super-increasing coefficients: r_1 = 1, r_{i+1} = 1 + sum_{j<=i} r_j ceil(4 sqrt q_j),
    // so sum r_i (a_{q_i} - b_{q_i}) = 0 with |a_q - b_q| <= 4 sqrt q forces a = b:
    // rational eigen-systems that differ at some q_i always separate.
    let combo = |qs: &[u64]| -> Vec<(u64, i64)> {
        let mut out = vec![];
        let mut acc = 0i64;
        for &q in qs {
            let r = if out.is_empty() { 1 } else { acc + 1 };
            acc += r * (4.0 * (q as f64).sqrt()).ceil() as i64;
            out.push((q, r));
        }
        out
    };
    let attempts: Vec<Vec<(u64, i64)>> = vec![combo(&qs[..1]), combo(&qs[..2]), combo(&qs[..3]), combo(&qs[..4]), combo(&qs[1..5]), combo(&qs[2..6]), combo(&qs[3..8])];
    let mut chosen = None;
    for ops in attempts {
        sagebrush_interrupt::check();
        let chi = exact_charpoly_combo(n, &ops)?;
        let mut t = vec![vec![0u64; d]; d];
        for &(q, r) in &ops {
            let rq = modp(r, p);
            for (row, hrow) in t.iter_mut().zip(sp.hecke_matrix(&pres, q)) {
                for (x, h) in row.iter_mut().zip(hrow) {
                    *x = (*x + mulmod(rq, h, p)) % p;
                }
            }
        }
        let chi_e = eisenstein_charpoly(&sp, &pres, &t, p);
        let fs = checked_factor(factor, &chi)?;
        if std::env::var("SAGEBRUSH_DEBUG").is_ok() {
            let (_, _, _, eis, _) = level_data(n);
            let desc: Vec<String> = fs.iter().map(|(f, e)| format!("{}^{}{}", f.len() - 1, e, if divides(&reduce(f, p), &chi_e, p) { "E" } else { "" })).collect();
            eprintln!("N={} T={:?} deg chi_E={} (eis {}) new_dim={} factors {}", n, ops, chi_e.len() - 1, eis, new_dim, desc.join(" "));
        }
        let new: Vec<Vec<BigInt>> = fs.into_iter().filter(|(f, e)| *e == 1 && !divides(&reduce(f, p), &chi_e, p)).map(|(f, _)| f).collect();
        if new.iter().map(|f| f.len() as i64 - 1).sum::<i64>() == new_dim {
            if let Some(orbits) = build_orbits(n, bound, &pres, &sp, &ops, &chi, &t, new) {
                chosen = Some(orbits);
                break;
            }
        }
    }
    chosen.ok_or_else(|| format!("N = {}: no combination separated the new orbits", n))
}

/// A basis of ker f(T) on functionals mod p (f irreducible of exponent one
/// in chi): the image of h(T) for h = chi / f is cyclic, spanned by
/// u, Tu, ..., T^(k-1) u with u = h(T) v.  None if four random v fail.
pub(crate) fn krylov_dual(t: &[Vec<u64>], chi_p: &[u64], f_p: &[u64], p: u64) -> Option<Vec<Vec<u64>>> {
    let d = t.len();
    let k = f_p.len() - 1;
    let h = poly_div(chi_p, f_p, p);
    for seed in 1..=4u64 {
        sagebrush_interrupt::check();
        // A pseudo-random vector (xorshift); an affine family in the seed
        // would only span two fixed vectors.
        let mut x = 0x9E37_79B9_7F4A_7C15u64 ^ seed.wrapping_mul(0xD1B5_4A32_D192_ED03);
        let v: Vec<u64> = (0..d)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x % p
            })
            .collect();
        let mut u = vec![0u64; d];
        for &c in h.iter().rev() {
            u = matvec(t, &u, p);
            for (x, &vi) in u.iter_mut().zip(&v) {
                *x = (*x + mulmod(c, vi, p)) % p;
            }
        }
        let mut rows = vec![u];
        for _ in 1..k {
            let next = matvec(t, rows.last().unwrap(), p);
            rows.push(next);
        }
        let (r, _) = linalg::rref_mod(rows, p);
        if r.len() == k {
            return Some(r);
        }
    }
    None
}

/// The orbits for the chosen T, or None if a Krylov basis degenerates.
#[allow(clippy::too_many_arguments)]
fn build_orbits(n: u64, bound: u64, pres: &Presentation, sp: &Space, ops: &[(u64, i64)], chi: &[BigInt], t: &[Vec<u64>], fs: Vec<Vec<BigInt>>) -> Option<Vec<Orbit>> {
    let p = ELL;
    let chi_p = reduce(&chi, p);
    let primes: Vec<u64> = (2..=bound).filter(|&l| is_prime(l) && n % l != 0).collect();
    let mut out = vec![];
    for f in fs {
        let k = f.len() - 1;
        let Some(mut rows) = krylov_dual(t, &chi_p, &reduce(&f, p), p) else {
            if std::env::var("SAGEBRUSH_DEBUG").is_ok() {
                eprintln!("  N={} T={:?}: factor {:?} of degree {} gives a degenerate Krylov basis", n, ops, f, k);
            }
            return None;
        };
        let pivots = rref(&mut rows, p);
        let psis: Vec<Vec<u64>> = rows.iter().map(|w| sp.extend(w)).collect();
        let x = sp.basis_gen[pivots[0]];
        let data = par::map_slice(&primes, |&l| {
            let hl = linalg::heilbronn(l as i64);
            let mut tr = 0u64;
            let mut c = Vec::with_capacity(k);
            for (r, psi) in psis.iter().enumerate() {
                tr = (tr + heilbronn_pairing(&pres, &hl, psi, sp.basis_gen[pivots[r]], p)) % p;
                c.push(heilbronn_pairing(&pres, &hl, psi, x, p));
            }
            let tr = if tr > p / 2 { tr as i64 - p as i64 } else { tr as i64 };
            ((l, tr), (l, c))
        });
        let (traces, c) = data.into_iter().unzip();
        out.push(Orbit { dim: k, ops: ops.to_vec(), f, traces, c });
    }
    out.sort_by(|a, b| (a.dim, &a.traces).cmp(&(b.dim, &b.traces)));
    Some(out)
}
