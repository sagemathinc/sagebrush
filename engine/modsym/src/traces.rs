//! Trace forms of Galois orbits of newforms: tr a_n = sum of a_n(f^sigma)
//! over the orbit, for n <= B (LMFDB stores B = 1000).
//!
//! Modulo ell and for each conjugate character eps^j, let W be the piece of
//! an orbit in M_k(N, eps^j)^+: the kernel of u_j(T), where u_j =
//! gcd(u, charpoly T) and u is the orbit's charpoly of T over Q.  T has
//! squarefree charpoly u_j on W, so every T_n acts on W as P_n(T) for a
//! polynomial P_n mod u_j.  With y = cof(T) e_t (cof = charpoly / u_j, which
//! kills the complement) and its Krylov basis y T^i, and functionals psi_i
//! giving Krylov coordinates of the projection to W (computed once, with a
//! column Krylov basis and a w x w solve), the coordinates of the projection
//! of T_p(x_t) are psi(T_p x_t), which needs only the Heilbronn images of
//! the single Manin symbol x_t: P_p = psi(T_p x_t) * cof mod u_j.  Then
//! P_(p^r) = P_p P_(p^(r-1)) - eps(p) p^(k-1) P_(p^(r-2)), P_(mn) = P_m P_n,
//! and tr P = sum c_i s_i with s_i the power sums of the roots of u_j.
//! Summing over j gives tr a_n mod ell; CRT up to Deligne's bound.

use crate::dirichlet::DirichletGroup;
use crate::exact::is_prime;
use crate::general::{heilbronn_for, mul, powmod, primes_one_mod, root_of_unity, Character, GeneralSpace};
use crate::general_exact::{crt, invert_mod};
use crate::linalg;
use crate::newspace::{deg, levels, new_poly_mod, pdivrem, pgcd, pmul, Level, NewspaceOrbits};
use crate::p1::gcd;
use crate::par;
use num_bigint::{BigInt, BigUint};
use std::collections::HashMap;

/// Merel's matrices for T_p, cached across spaces.
fn mulmod_poly(a: &[u64], b: &[u64], u: &[u64], p: u64) -> Vec<u64> {
    let mut r = pdivrem(&pmul(a, b, p), u, p).1;
    r.resize(deg(u).max(1), 0);
    r
}

/// Row vector v -> v T.
fn vecmat(v: &[u64], t: &[Vec<u64>], p: u64) -> Vec<u64> {
    let mut out = vec![0u64; v.len()];
    for (vi, row) in v.iter().zip(t) {
        if *vi != 0 {
            for (o, &x) in out.iter_mut().zip(row) {
                *o = (*o + mul(*vi, x, p)) % p;
            }
        }
    }
    out
}

/// Column vector z -> T z.
fn matvec(t: &[Vec<u64>], z: &[u64], p: u64) -> Vec<u64> {
    t.iter().map(|row| (row.iter().zip(z).fold(0u128, |acc, (&a, &b)| acc + a as u128 * b as u128) % p as u128) as u64).collect()
}

/// c(T) applied to a row (left = true: v c(T)) or column vector, by Horner.
fn poly_apply(c: &[u64], t: &[Vec<u64>], v: &[u64], left: bool, p: u64) -> Vec<u64> {
    let mut r = vec![0u64; v.len()];
    for &ci in c.iter().rev() {
        r = if left { vecmat(&r, t, p) } else { matvec(t, &r, p) };
        for (x, &y) in r.iter_mut().zip(v) {
            *x = (*x + mul(ci, y, p)) % p;
        }
    }
    r
}

/// Power sums s_0..s_(w-1) of the roots of a monic u of degree w (Newton).
fn power_sums(u: &[u64], p: u64) -> Vec<u64> {
    let w = deg(u);
    let mut s = vec![0u64; w];
    if w == 0 {
        return s;
    }
    s[0] = w as u64 % p;
    for i in 1..w {
        let mut acc = mul(i as u64 % p, u[w - i], p);
        for t in 1..i {
            acc = (acc + mul(u[w - t], s[i - t], p)) % p;
        }
        s[i] = (p - acc) % p;
    }
    s
}

struct OrbitSetup {
    u: Vec<u64>,
    q: Vec<u64>,
    t: usize,
    psi: Vec<Vec<u64>>,
    s: Vec<u64>,
}

/// Traces of T_1..T_B on each orbit's piece for one embedding, mod ell
/// (None: ell is bad for this embedding).
#[allow(clippy::too_many_arguments)]
fn traces_mod(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, lv: &[Level], polys: &[Vec<u64>], rel_deg: &[usize], ell: u64, z_e: u64, e_top: u64, jdx: usize, j: u64, bound: usize) -> Result<Option<Vec<Vec<u64>>>, String> {
    let ops = &res.ops;
    let zm = powmod(z_e, e_top / eps.order * j, ell);
    // The new part of the charpoly for this embedding: an orbit's piece is
    // gcd(u, g_new), not gcd(u, charpoly), since a conjugate's eigenvalue
    // may coincide with an old or Eisenstein one here.
    let g_new = match new_poly_mod(lv, k, ops, ell, z_e, e_top, jdx, j, &res.dims_plus)? {
        Some((g, true)) => g,
        _ => return Ok(None),
    };
    let sp = GeneralSpace::new_mod(n, k, eps, 1, ell, zm)?;
    let d = sp.dimension();
    let tm = sp.hecke_combo_matrix(ops)?;
    let f = linalg::charpoly(tm.clone(), ell);
    let mut setups = vec![];
    let mut seed = 0x9e3779b97f4a7c15u64 ^ ell;
    let mut rand = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % ell
    };
    for (u, &w) in polys.iter().zip(rel_deg) {
        let uj = pgcd(u, &g_new, ell);
        let debug = std::env::var("TRACES_DEBUG").is_ok();
        if deg(&uj) != w {
            if debug {
                eprintln!("N={} ell={}: deg u_j {} != {}", n, ell, deg(&uj), w);
            }
            return Ok(None);
        }
        let (cof, r) = pdivrem(&f, &uj, ell);
        if !(r.len() == 1 && r[0] == 0) || deg(&pgcd(&uj, &cof, ell)) != 0 {
            if debug {
                eprintln!("N={} ell={}: u_j not separated (deg gcd {})", n, ell, deg(&pgcd(&uj, &cof, ell)));
            }
            return Ok(None);
        }
        let mut q = pdivrem(&cof, &uj, ell).1;
        q.resize(w, 0);
        // With z_b = T^b cof(T) c (columns spanning the functionals that
        // vanish off W) and the Krylov rows e_t cof(T) T^a, the Gram matrix
        // is Hankel: G_t[a][b] = (T^(a+b) cof(T)^2 c)_t.  So a handful of
        // vectors give G_t for every t, and the first t with G_t invertible
        // is used (the Krylov rows themselves are never needed).
        let mut found = None;
        for _attempt in 0..3 {
            sagebrush_interrupt::check();
            let c: Vec<u64> = (0..d).map(|_| rand()).collect();
            let mut zs = vec![poly_apply(&cof, &tm, &c, false, ell)];
            for i in 1..w {
                let next = matvec(&tm, &zs[i - 1], ell);
                zs.push(next);
            }
            let mut vs = vec![poly_apply(&cof, &tm, &zs[0], false, ell)];
            for i in 1..2 * w - 1 {
                let next = matvec(&tm, &vs[i - 1], ell);
                vs.push(next);
            }
            for t in 0..d {
                let g: Vec<Vec<u64>> = (0..w).map(|a| (0..w).map(|bb| vs[a + bb][t]).collect()).collect();
                let ginv = match invert_mod(&g, ell) {
                    Some(x) => x,
                    None => continue,
                };
                // Psi = Z G^-1 (d x w): column i is the functional for Krylov coordinate i.
                let psi: Vec<Vec<u64>> = (0..w).map(|i| {
                    let col: Vec<u64> = (0..d).map(|r| (0..w).fold(0u64, |acc, bb| (acc + mul(zs[bb][r], ginv[bb][i], ell)) % ell)).collect();
                    sp.extend(&col)
                }).collect();
                // Self-check: the projection of x_t has coordinates cof^-1 mod u_j.
                let g0 = sp.basis_generator(t) as usize;
                let c1: Vec<u64> = (0..w).map(|i| psi[i][g0]).collect();
                let one = mulmod_poly(&c1, &q, &uj, ell);
                if one[0] != 1 % ell || one[1..].iter().any(|&x| x != 0) {
                    return Err("trace setup self-check failed".into());
                }
                found = Some(OrbitSetup { s: power_sums(&uj, ell), u: uj.clone(), q: q.clone(), t, psi });
                break;
            }
            if found.is_some() {
                break;
            }
        }
        match found {
            Some(s) => setups.push(s),
            None => {
                if debug {
                    eprintln!("N={} ell={}: no cyclic vector found (w = {}, d = {})", n, ell, w, d);
                }
                return Ok(None);
            }
        }
    }
    // P_p for primes p <= bound, then all P_n.
    // The primes in parallel: each needs the Heilbronn images of the few
    // Manin symbols x_t only.
    let primes: Vec<u64> = (2..=bound as u64).filter(|&p| is_prime(p)).collect();
    let per_prime = par::map_slice(&primes, |&p| {
        // generated per prime, not kept: Cremona's are cheap to make, and
        // all of them for p <= 1000 would take tens of megabytes
        let hs = heilbronn_for(p, n);
        let mut images: HashMap<usize, Vec<(u32, u64)>> = HashMap::new();
        setups.iter().map(|st| {
            let img = images.entry(st.t).or_insert_with(|| sp.hecke_image(&hs, sp.basis_generator(st.t)));
            let c: Vec<u64> = st.psi.iter().map(|ps| (img.iter().fold(0u128, |acc, &(g, v)| acc + v as u128 * ps[g as usize] as u128) % ell as u128) as u64).collect();
            mulmod_poly(&c, &st.q, &st.u, ell)
        }).collect::<Vec<Vec<u64>>>()
    });
    let mut pp: Vec<HashMap<u64, Vec<u64>>> = vec![HashMap::new(); setups.len()];
    for (&p, polys) in primes.iter().zip(per_prime) {
        for (oi, poly) in polys.into_iter().enumerate() {
            pp[oi].insert(p, poly);
        }
    }
    let mut out = vec![];
    for (oi, st) in setups.iter().enumerate() {
        let w = deg(&st.u);
        let mut one = vec![0u64; w.max(1)];
        one[0] = 1;
        let mut pn: Vec<Vec<u64>> = vec![vec![], one];
        for nn in 2..=bound as u64 {
            sagebrush_interrupt::check();
            let p = (2..=nn).find(|q| nn % q == 0).unwrap();
            let mut m = nn;
            while m % p == 0 {
                m /= p;
            }
            let v = if m == 1 {
                let prev = nn / p;
                let tp = &pp[oi][&p];
                let mut v = mulmod_poly(tp, &pn[prev as usize], &st.u, ell);
                if prev % p == 0 && n % p != 0 {
                    let c = mul(powmod(zm, eps.exponent(p as i64).unwrap() as u64, ell), powmod(p, k as u64 - 1, ell), ell);
                    for (x, &y) in v.iter_mut().zip(&pn[(prev / p) as usize]) {
                        *x = (*x + ell - mul(c, y, ell)) % ell;
                    }
                }
                v
            } else {
                mulmod_poly(&pn[(nn / m) as usize], &pn[m as usize], &st.u, ell)
            };
            pn.push(v);
        }
        out.push((1..=bound).map(|nn| pn[nn].iter().zip(&st.s).fold(0u64, |acc, (&a, &b)| (acc + mul(a, b, ell)) % ell)).collect());
    }
    Ok(Some(out))
}

/// tr a_n for n = 1..=bound for each orbit of `res` (same order).
pub fn orbit_traces(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, bound: usize) -> Result<Vec<Vec<BigInt>>, String> {
    if res.orbits.is_empty() {
        return Ok(vec![]);
    }
    let eps = eps.minimal();
    let m = eps.order;
    let units: Vec<u64> = (0..m.max(1)).filter(|&j| gcd(j, m) == 1).collect();
    let phi = units.len();
    let e_top = DirichletGroup::new(n).exponent.max(1);
    let rel_deg: Vec<usize> = res.dims.iter().map(|&dd| dd / phi).collect();
    let qs: Vec<u64> = res.ops.iter().map(|o| o.0).collect();
    let t0 = crate::now();
    let lv = levels(n, k, &eps, &units, &qs)?;
    // |tr a_n| <= dim sigma0(n) n^((k-1)/2).
    let mut need = BigUint::from(0u32);
    for nn in 1..=bound as u64 {
        let s0 = (1..=nn).filter(|dd| nn % dd == 0).count() as u64;
        let b = (BigUint::from(nn).pow(k as u32 - 1)).sqrt() + 1u32;
        let x = b * s0 * (*res.dims.iter().max().unwrap() as u64) * 2u32;
        if x > need {
            need = x;
        }
    }
    let mut primes = primes_one_mod(e_top, 1 << 31);
    let mut residues: Vec<(u64, Vec<Vec<u64>>)> = vec![];
    let mut modulus = BigUint::from(1u32);
    let mut rejected = 0;
    while modulus <= need {
        sagebrush_interrupt::check();
        let ell = primes.next().ok_or("ran out of primes")?;
        let polys: Vec<Vec<u64>> = res.orbits.iter().map(|u| u.iter().map(|c| {
            let r = c % BigInt::from(ell);
            let r = if r < BigInt::from(0) { r + BigInt::from(ell) } else { r };
            r.try_into().unwrap()
        }).collect()).collect();
        let z = root_of_unity(e_top, ell);
        let jobs: Vec<(usize, u64)> = units.iter().cloned().enumerate().collect();
        let parts = par::map_slice(&jobs, |&(jdx, j)| traces_mod(n, k, &eps, res, &lv, &polys, &rel_deg, ell, z, e_top, jdx, j, bound));
        let mut sum = vec![vec![0u64; bound]; res.orbits.len()];
        let mut ok = true;
        for part in parts {
            match part? {
                Some(t) => {
                    for (s, tt) in sum.iter_mut().zip(t) {
                        for (a, b) in s.iter_mut().zip(tt) {
                            *a = (*a + b) % ell;
                        }
                    }
                }
                None => ok = false,
            }
        }
        if !ok {
            rejected += 1;
            if rejected > 16 {
                return Err("too many bad primes for traces".into());
            }
            continue;
        }
        residues.push((ell, sum.into_iter().flatten().map(|x| vec![x]).collect()));
        modulus *= ell;
    }
    if std::env::var("SAGEBRUSH_TIMING").is_ok() {
        eprintln!(r#"{{"n":{},"k":{},"bound":{},"traces":{:.4},"trace_primes":{},"orbits":{}}}"#, n, k, bound, crate::elapsed_ms(t0, crate::now()) / 1e3, residues.len(), res.orbits.len());
    }
    let total = res.orbits.len() * bound;
    let flat: Vec<BigInt> = crt(&residues, total - 1, 1).into_iter().map(|c| c[0].clone()).collect();
    Ok(flat.chunks(bound).map(|c| c.to_vec()).collect())
}
