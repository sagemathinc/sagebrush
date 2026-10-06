//! Integral Hecke data for newform orbits: a_p = sum_r beta_r c_{p,r} with
//! c_{p,r} in Z (Stein's representation), exactly and without number-field
//! arithmetic.
//!
//! For an orbit A of dimension k, the dual A^v written on the m free
//! Manin-symbol generators is the reduction of a Q-subspace with a unique
//! reduced echelon basis.  It is computed mod three primes; CRT of two and
//! rational reconstruction give the rationals, the third checks them, and
//! each row is scaled to a primitive integer vector w_r.  Then for a fixed
//! generator x with (w_r(x))_r != 0,
//!   c_{p,r} = w_r(T_p x) = sum over Heilbronn matrices of integers,
//! and a_p = psi(T_p x) / psi(x) = sum_r beta_r c_{p,r} for the
//! eigenfunctional psi = sum lambda_r w_r (beta_r = lambda_r / psi(x)).
//! Check, still without K: tau_r = tr(beta_r) is solved mod ell from k
//! primes, and tr(a_p) = sum_r c_{p,r} tau_r must hold at every other prime.

use crate::exact::{exact_charpoly_combo, is_prime};
use crate::linalg;
use crate::newforms::inv;
use crate::orbits::{krylov_dual, mulmod, newform_orbits, reduce, Factorer, Orbit};
use crate::presentation::Presentation;
use crate::space::Space;

/// Primes near 2^31 (ell_1, ell_2 for CRT, ell_3 to check).
const ELLS: [u64; 3] = [2147483629, 2147483587, 2147483579];

#[derive(Debug, Clone)]
pub struct IntegralOrbit {
    pub orbit: Orbit,
    /// Primitive integer functionals on the generators (k rows of length m).
    pub w: Vec<Vec<i64>>,
    /// The generator x with w_r(x) not all zero.
    pub x: u32,
    /// c_p in Z^k for primes p <= bound not dividing N.
    pub c: Vec<(u64, Vec<i64>)>,
    /// tr(a_p) = sum c_{p,r} tau_r held at every prime.
    pub traces_check: bool,
}

/// r/s with r = a s mod m, |r|, s <= sqrt(m/2), if it exists.
fn rational_reconstruction(a: u128, m: u128) -> Option<(i128, i128)> {
    let bound = ((m / 2) as f64).sqrt() as i128;
    let (mut r0, mut r1) = (m as i128, a as i128);
    let (mut s0, mut s1) = (0i128, 1i128);
    while r1 > bound {
        let q = r0 / r1;
        (r0, r1) = (r1, r0 - q * r1);
        (s0, s1) = (s1, s0 - q * s1);
    }
    if s1 == 0 || s1.abs() > bound {
        return None;
    }
    let (r, s) = if s1 < 0 { (-r1, -s1) } else { (r1, s1) };
    Some((r, s))
}

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// The echelon basis on the generators of each orbit's dual, mod p.
fn duals_mod(pres: &Presentation, ops: &[(u64, i64)], chi: &[sagebrush_bigint::BigInt], orbits: &[Orbit], p: u64) -> Option<Vec<(Vec<Vec<u64>>, Vec<usize>)>> {
    let sp = Space::new(pres, p);
    let d = sp.dimension();
    let mut t = vec![vec![0u64; d]; d];
    for &(q, r) in ops {
        let rq = r.rem_euclid(p as i64) as u64;
        for (row, hrow) in t.iter_mut().zip(sp.hecke_matrix(pres, q)) {
            for (x, h) in row.iter_mut().zip(hrow) {
                *x = (*x + mulmod(rq, h, p)) % p;
            }
        }
    }
    let chi_p = reduce(chi, p);
    orbits
        .iter()
        .map(|o| {
            let rows = krylov_dual(&t, &chi_p, &reduce(&o.f, p), p)?;
            let on_gens: Vec<Vec<u64>> = rows.iter().map(|w| sp.extend(w)).collect();
            Some(linalg::rref_mod(on_gens, p))
        })
        .collect()
}

/// Newform orbits of level N with exact integral coordinates c_p of a_p.
pub fn integral_orbits(n: u64, bound: u64, factor: Factorer) -> Result<Vec<IntegralOrbit>, String> {
    let orbits = newform_orbits(n, bound, factor)?;
    if orbits.is_empty() {
        return Ok(vec![]);
    }
    let ops = orbits[0].ops.clone();
    let chi = exact_charpoly_combo(n, &ops)?;
    let pres = Presentation::new(n);
    let per_prime: Vec<Vec<(Vec<Vec<u64>>, Vec<usize>)>> = ELLS
        .iter()
        .map(|&p| duals_mod(&pres, &ops, &chi, &orbits, p).ok_or_else(|| format!("N = {}: degenerate Krylov basis mod {}", n, p)))
        .collect::<Result<_, _>>()?;
    let primes: Vec<u64> = (2..=bound).filter(|&l| is_prime(l) && n % l != 0).collect();
    let (l1, l2, l3) = (ELLS[0] as u128, ELLS[1] as u128, ELLS[2] as u128);
    let m12 = l1 * l2;
    let inv1 = inv((l1 % l2) as u64, l2 as u64) as u128; // l1^{-1} mod l2
    let mut out = vec![];
    for (j, orbit) in orbits.into_iter().enumerate() {
        let (r1, piv1) = &per_prime[0][j];
        let (r2, piv2) = &per_prime[1][j];
        let (r3, piv3) = &per_prime[2][j];
        if piv1 != piv2 || piv1 != piv3 {
            return Err(format!("N = {}: echelon pivots differ between primes", n));
        }
        let k = r1.len();
        let m = r1[0].len();
        let mut w: Vec<Vec<i64>> = Vec::with_capacity(k);
        for r in 0..k {
            let mut nums = vec![0i128; m];
            let mut dens = vec![1i128; m];
            for g in 0..m {
                let (a1, a2) = (r1[r][g] as u128, r2[r][g] as u128);
                if a1 == 0 && a2 == 0 {
                    continue;
                }
                // x = a1 + l1 * ((a2 - a1) / l1 mod l2) mod l1 l2
                let t = ((a2 + l2 - a1 % l2) % l2) * inv1 % l2;
                let x = a1 + l1 * t;
                let (num, den) = rational_reconstruction(x % m12, m12).ok_or_else(|| format!("N = {}: rational reconstruction failed (entries too large)", n))?;
                // Check mod l3.
                let lhs = (num.rem_euclid(l3 as i128)) as u128;
                let rhs = (r3[r][g] as u128) * (den.rem_euclid(l3 as i128) as u128) % l3;
                if lhs != rhs {
                    return Err(format!("N = {}: reconstruction disagrees mod a third prime", n));
                }
                nums[g] = num;
                dens[g] = den;
            }
            let lcm = dens.iter().fold(1i128, |acc, &d| acc / gcd(acc, d) * d);
            let mut row: Vec<i128> = (0..m).map(|g| nums[g] * (lcm / dens[g])).collect();
            let g = row.iter().fold(0i128, |acc, &x| gcd(acc, x));
            for x in row.iter_mut() {
                *x /= g.max(1);
            }
            w.push(row.into_iter().map(|x| i64::try_from(x).map_err(|_| format!("N = {}: functional entries exceed 64 bits", n))).collect::<Result<_, _>>()?);
        }
        let x = piv1[0] as u32;
        let c: Vec<(u64, Vec<i64>)> = crate::par::map_slice(&primes, |&l| {
            let img = Space::hecke_image(&pres, &linalg::heilbronn(l as i64), x);
            (l, (0..k).map(|r| img.iter().fold(0i128, |acc, &(g2, s)| acc + s as i128 * w[r][g2 as usize] as i128) as i64).collect())
        });
        let traces_check = check_traces(&orbit.traces, &c, crate::newforms::ELL);
        out.push(IntegralOrbit { orbit, w, x, c, traces_check });
    }
    Ok(out)
}

/// Solve tau from the first primes where the c_p are independent, then
/// check tr(a_p) = sum_r c_{p,r} tau_r mod p at every prime.
fn check_traces(traces: &[(u64, i64)], c: &[(u64, Vec<i64>)], p: u64) -> bool {
    let k = c.first().map_or(0, |x| x.1.len());
    let md = |x: i64| x.rem_euclid(p as i64) as u64;
    // Gaussian elimination on [c_p | tr] rows until rank k.
    let mut rows: Vec<Vec<u64>> = vec![];
    for (i, (_, cp)) in c.iter().enumerate() {
        let mut trial = rows.clone();
        let mut row: Vec<u64> = cp.iter().map(|&x| md(x)).collect();
        row.push(md(traces[i].1));
        trial.push(row);
        let (r, piv) = linalg::rref_mod(trial, p);
        if piv.iter().any(|&c| c == k) {
            return false; // inconsistent: tr is not a combination of the c's
        }
        if r.len() > rows.len() {
            rows = r;
        }
        if rows.len() == k {
            break;
        }
    }
    if rows.len() < k {
        return false;
    }
    let tau: Vec<u64> = rows.iter().map(|r| r[k]).collect();
    c.iter().zip(traces).all(|((_, cp), &(_, tr))| cp.iter().zip(&tau).fold(0u64, |acc, (&x, &t)| (acc + mulmod(md(x), t, p)) % p) == md(tr))
}
