//! The Hecke elements Theta(p): for a prime p with totally positive
//! generator pi, one element alpha_z of R with nrd(alpha_z) = pi for each
//! point z of P^1(O_F/p) (Dembélé 2005, section 3: T_p is a sum over
//! Theta(p) = {u in R : nrd(u) = pi} / R^x).
//!
//! As in PSAGE's AlphaZ (sqrt5.py): under the splitting R/pR = M_2(O_F/p),
//! the elements of R whose image has both columns on the line z form a right
//! ideal I_z of index N(p)^2. It is principal (R has class number one), and
//! its generators of reduced norm pi (they exist since every totally
//! positive unit of O_F is a square) are the right unit multiples of one of
//! them. Every alpha with nrd(alpha) = pi lies in exactly one I_z (its
//! reduction has rank one), so the alpha_z represent Theta(p).
//!
//! alpha_z is found as a vector of the Z-lattice I_z (rank 8) with
//! Tr_{F/Q} nrd(alpha) = Tr(pi), by LLL reduction (Lenstra, Lenstra and
//! Lovász 1982; Cohen, "A Course in Computational Algebraic Number Theory",
//! Algorithm 2.6.3) and Fincke-Pohst enumeration (Cohen, Algorithm 2.7.5),
//! where PSAGE called PARI's qfminim. The reduced norm is checked exactly.

use crate::field::{Elt, Hnf, Kind, Prime};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use crate::p1::LocalP1;
use crate::quat::{icosians, Quat};
use crate::residue::{LocalRing, Res};
use crate::split::LocalSplitting;

type V8 = [i128; 8];

/// The element of R with Z-coordinates v in the basis
/// e1, w e1, e2, w e2, ..., w e4.
pub fn from_z8(v: &V8) -> [Elt; 4] {
    [0, 1, 2, 3].map(|m| Elt::new(v[2 * m] as i64, v[2 * m + 1] as i64))
}

fn q_form(v: &V8) -> i128 {
    Quat::from_e(&from_z8(v)).nrd().trace() as i128
}

/// The Gram matrix of the bilinear form of Q(x) = Tr_{F/Q} nrd(x) on the
/// Z-basis of R: B(x, y) = Q(x + y) - Q(x) - Q(y), so Q(x) = B(x, x)/2.
pub fn gram_r() -> [[i128; 8]; 8] {
    let mut g = [[0i128; 8]; 8];
    let unit = |s: usize| {
        let mut v = [0i128; 8];
        v[s] = 1;
        v
    };
    for s in 0..8 {
        for t in 0..8 {
            let mut v = unit(s);
            v[t] += 1;
            g[s][t] = q_form(&v) - q_form(&unit(s)) - q_form(&unit(t));
        }
    }
    g
}

fn dot(g: &[[i128; 8]; 8], u: &V8, v: &V8) -> i128 {
    let mut s = 0;
    for i in 0..8 {
        if u[i] == 0 {
            continue;
        }
        for j in 0..8 {
            s += u[i] * g[i][j] * v[j];
        }
    }
    s
}

/// LLL reduction (delta = 0.99) of the basis b for the form g, with exact
/// integer inner products and floating-point Gram-Schmidt coefficients,
/// recomputed once per step (Cohen, Algorithm 2.6.3).
fn lll(b: &mut Vec<V8>, g: &[[i128; 8]; 8]) {
    let n = b.len();
    let mut mu = vec![vec![0.0f64; n]; n];
    let mut bn = vec![0.0f64; n];
    let gs_row = |b: &Vec<V8>, i: usize, mu: &mut Vec<Vec<f64>>, bn: &mut Vec<f64>| {
        for j in 0..i {
            let mut s = dot(g, &b[i], &b[j]) as f64;
            for k in 0..j {
                s -= mu[j][k] * mu[i][k] * bn[k];
            }
            mu[i][j] = s / bn[j];
        }
        let mut s = dot(g, &b[i], &b[i]) as f64;
        for k in 0..i {
            s -= mu[i][k] * mu[i][k] * bn[k];
        }
        bn[i] = s;
    };
    for i in 0..n {
        gs_row(b, i, &mut mu, &mut bn);
    }
    let mut k = 1;
    let mut steps = 0;
    while k < n && steps < 100_000 {
        steps += 1;
        // rows 0..k are current; row k may be stale after a swap or an increment
        gs_row(b, k, &mut mu, &mut bn);
        // size-reduce b_k against b_{k-1}, ..., b_0
        for j in (0..k).rev() {
            let r = mu[k][j].round();
            if r != 0.0 {
                let ri = r as i128;
                for t in 0..8 {
                    b[k][t] -= ri * b[j][t];
                }
                for l in 0..j {
                    mu[k][l] -= r * mu[j][l];
                }
                mu[k][j] -= r;
            }
        }
        gs_row(b, k, &mut mu, &mut bn); // refresh in floating point after the exact update
        if bn[k] >= (0.99 - mu[k][k - 1] * mu[k][k - 1]) * bn[k - 1] {
            k += 1;
        } else {
            b.swap(k, k - 1);
            if k == 1 {
                gs_row(b, 0, &mut mu, &mut bn);
            }
            k = k.max(2) - 1;
        }
    }
}

/// The vectors x != 0 of the lattice with basis b (exact coordinates in
/// Z^8 for the form g) with Q(x) = B(x, x)/2 <= bound, passed to f until it
/// returns true (Fincke-Pohst). Returns whether f accepted one.
fn enumerate(b: &[V8], g: &[[i128; 8]; 8], bound: i128, f: &mut dyn FnMut(&V8) -> bool) -> bool {
    let n = b.len();
    // Cholesky decomposition of the Gram matrix of b for Q = B/2 (Cohen 2.7.5)
    let mut q = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..n {
            q[i][j] = dot(g, &b[i], &b[j]) as f64 / 2.0;
        }
    }
    for i in 0..n {
        for j in i + 1..n {
            q[j][i] = q[i][j];
            q[i][j] /= q[i][i];
        }
        for k in i + 1..n {
            for l in k..n {
                q[k][l] -= q[k][i] * q[i][l];
            }
        }
    }
    let c = bound as f64 * (1.0 + 1e-9) + 1e-6;
    let mut x = vec![0i64; n];
    let mut t = vec![0.0f64; n + 1];
    let mut u = vec![0.0f64; n];
    let mut upper = vec![0i64; n];
    let mut i = n - 1;
    t[i] = c;
    u[i] = 0.0;
    let init = |i: usize, t: &[f64], u: &[f64], x: &mut [i64], upper: &mut [i64], q: &Vec<Vec<f64>>| {
        let z = (t[i] / q[i][i]).max(0.0).sqrt();
        upper[i] = (z - u[i]).floor() as i64;
        x[i] = (-z - u[i]).ceil() as i64 - 1;
    };
    init(i, &t, &u, &mut x, &mut upper, &q);
    loop {
        x[i] += 1;
        if x[i] > upper[i] {
            i += 1;
            if i >= n {
                return false;
            }
            continue;
        }
        if i > 0 {
            let d = x[i] as f64 + u[i];
            t[i - 1] = t[i] - q[i][i] * d * d;
            i -= 1;
            u[i] = (i + 1..n).map(|j| q[i][j] * x[j] as f64).sum();
            init(i, &t, &u, &mut x, &mut upper, &q);
            continue;
        }
        if x.iter().all(|&v| v == 0) {
            continue;
        }
        let mut v = [0i128; 8];
        for (k, bk) in b.iter().enumerate() {
            for s in 0..8 {
                v[s] += x[k] as i128 * bk[s];
            }
        }
        if f(&v) {
            return true;
        }
    }
}

/// Theta(p), memoized: it depends only on p, and every level uses it (as
/// Dembélé 2005, section 3.1, step 1 precomputes it once).
pub fn theta(p: &Prime) -> Result<Arc<Vec<[Elt; 4]>>, String> {
    static CACHE: OnceLock<Mutex<HashMap<Hnf, Arc<Vec<[Elt; 4]>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(t) = cache.lock().unwrap().get(&p.hnf) {
        return Ok(t.clone());
    }
    let t = Arc::new(compute_theta(p)?);
    cache.lock().unwrap().insert(p.hnf, t.clone());
    Ok(t)
}

/// For each point z of P^1(O_F/p), in the order of its local index, an
/// element alpha_z of R (e-coordinates) with nrd(alpha_z) = pi_p whose
/// reduction has both columns on z.
///
/// If u is a unit of R then I_{uz} = u I_z, so alpha_{uz} = u alpha_z: one
/// lattice search per orbit of the 120 icosians on P^1(O_F/p) suffices.
pub fn compute_theta(p: &Prime) -> Result<Vec<[Elt; 4]>, String> {
    let ring = LocalRing::new(*p, 1)?;
    let split0 = LocalSplitting::new(&ring)?;
    let line = LocalP1::new(ring.clone());
    let units: Vec<(Quat, [Res; 4])> = icosians().into_iter().map(|u| {
        let m = split0.image(&ring, &u.to_e().unwrap());
        (u, m)
    }).collect();
    let mut out: Vec<Option<[Elt; 4]>> = vec![None; line.size as usize];
    for z in 0..line.size {
        if out[z as usize].is_some() {
            continue;
        }
        let a = search(p, &ring, &split0, z)?;
        let qa = Quat::from_e(&a);
        for (u, m) in &units {
            let y = line.act(m, z).expect("units act on P^1");
            if out[y as usize].is_none() {
                let ua = u.mul(&qa).and_then(|x| x.to_e()).expect("R is a ring");
                out[y as usize] = Some(ua);
            }
        }
    }
    Ok(out.into_iter().map(|a| a.unwrap()).collect())
}

/// alpha_z for one point z (by its index in P^1(O_F/p)), by lattice search.
fn search(p: &Prime, ring: &LocalRing, split: &LocalSplitting, zi: u64) -> Result<[Elt; 4], String> {
    let g = gram_r();
    let pi = p.gen;
    let tr = pi.trace() as i128;
    // images in M_2(k) of the Z-basis of R
    let w = Elt::new(0, 1);
    let images: Vec<[crate::residue::Res; 4]> = (0..8)
        .map(|t| {
            let mut c = [Elt::int(0); 4];
            c[t / 2] = if t % 2 == 0 { Elt::int(1) } else { w };
            split.image(ring, &c)
        })
        .collect();
    let pp = p.p as i128;
    // k is F_p (split, ramified: residues are (x, 0)) or F_p^2 (inert: (x, y)).
    let fp_dim = if p.kind == Kind::Inert { 2 } else { 1 };
    {
        let (z0, z1) = if zi < ring.card { (ring.element(zi), ring.one()) } else { (ring.one(), ring.zero()) };
        // the conditions z0 M[2] - z1 M[0] = 0 and z0 M[3] - z1 M[1] = 0 over k,
        // as 2 * fp_dim linear forms mod p on Z^8
        let mut rows: Vec<Vec<i128>> = vec![vec![0; 8]; 2 * fp_dim];
        for t in 0..8 {
            let m = &images[t];
            let c1 = ring.sub(ring.mul(z0, m[2]), ring.mul(z1, m[0]));
            let c2 = ring.sub(ring.mul(z0, m[3]), ring.mul(z1, m[1]));
            rows[0][t] = c1.0 as i128;
            rows[1][t] = c2.0 as i128;
            if fp_dim == 2 {
                rows[2][t] = c1.1 as i128;
                rows[3][t] = c2.1 as i128;
            }
        }
        let mut basis = kernel_lattice(rows, pp);
        lll(&mut basis, &g);
        let mut found = None;
        enumerate(&basis, &g, tr, &mut |v| {
            if q_form(v) != tr {
                return false;
            }
            let c = from_z8(v);
            if Quat::from_e(&c).nrd() == pi {
                found = Some(c);
                return true;
            }
            false
        });
        found.ok_or_else(|| format!("no element of reduced norm {} found for point {} of P^1", pi, zi))
    }
}

/// A basis of {v in Z^8 : A v = 0 mod p} (p prime): lifts of a basis of the
/// kernel mod p together with p times the unit vectors at the pivots.
fn kernel_lattice(mut a: Vec<Vec<i128>>, p: i128) -> Vec<V8> {
    let n = 8;
    let inv = |x: i128| crate::field::inv_mod(x.rem_euclid(p) as u64, p as u64).unwrap() as i128;
    let mut pivots = vec![];
    let mut r = 0;
    for col in 0..n {
        let Some(piv) = (r..a.len()).find(|&i| a[i][col].rem_euclid(p) != 0) else { continue };
        a.swap(r, piv);
        let s = inv(a[r][col]);
        for t in 0..n {
            a[r][t] = (a[r][t] * s).rem_euclid(p);
        }
        for i in 0..a.len() {
            if i != r && a[i][col].rem_euclid(p) != 0 {
                let f = a[i][col];
                for t in 0..n {
                    a[i][t] = (a[i][t] - f * a[r][t]).rem_euclid(p);
                }
            }
        }
        pivots.push(col);
        r += 1;
        if r == a.len() {
            break;
        }
    }
    let mut basis = vec![];
    for f in 0..n {
        if pivots.contains(&f) {
            continue;
        }
        let mut v = [0i128; 8];
        v[f] = 1;
        for (row, &pc) in pivots.iter().enumerate() {
            v[pc] = (-a[row][f]).rem_euclid(p);
        }
        basis.push(v);
    }
    for &pc in &pivots {
        let mut v = [0i128; 8];
        v[pc] = p;
        basis.push(v);
    }
    basis
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::primes_of_bounded_norm;

    #[test]
    fn theta_elements() {
        for p in primes_of_bounded_norm(200) {
            let th = compute_theta(&p).unwrap();
            assert_eq!(th.len() as u64, p.norm + 1);
            for c in &th {
                assert_eq!(Quat::from_e(c).nrd(), p.gen);
            }
            // distinct classes: no two are right unit multiples of each other,
            // i.e. a_z^-1 a_z' = conj(a_z) a_z' / pi is never in R
            for i in 0..th.len().min(30) {
                for j in 0..i {
                    let x = Quat::from_e(&th[i]).conj().mul(&Quat::from_e(&th[j])).unwrap();
                    let in_r = x.0.iter().all(|c| c.div_exact(p.gen).is_some()) && Quat(x.0.map(|c| c.div_exact(p.gen).unwrap_or(c))).to_e().is_some();
                    assert!(!in_r, "theta elements {} and {} are equivalent", i, j);
                }
            }
        }
    }
}
