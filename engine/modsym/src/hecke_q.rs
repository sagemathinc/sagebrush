//! Hecke operators on S_k(Gamma0(N)) in its reduced echelon q-expansion
//! basis, from coefficients to the Sturm bound only, whatever the prime.
//!
//! For each level M | N and each Galois orbit of newforms f of level M, the
//! forms g_m = Tr(a_m f), m in a set of r indices chosen by
//! `traces::orbit_hecke_traces`, are a basis over Q of the orbit's span,
//! and T_p g_m = Tr(a_m a_p f): both have the integer q-expansion
//! coefficients that function returns.  The oldforms g_m(q^t), t | N/M,
//! complete a basis W of S_k(N), and T_p acts on them by
//!
//! - p not dividing N: T_p(g(q^t)) = (T_p g)(q^t);
//! - p | t: U_p(g(q^t)) = g(q^(t/p));
//! - p not dividing t, p | M: U_p(g(q^t)) = (a_p g)(q^t);
//! - p not dividing t nor M: U_p(g(q^t)) = (a_p g)(q^t) - p^(k-1) g(q^(tp)),
//!
//! from the level-M coefficients (a_(pm) = a_p a_m for p | M, and a_(pm) =
//! a_p a_m - p^(k-1) a_(m/p) otherwise).  To a precision past the Sturm
//! bound, q-expansions determine the forms, so the reduced echelon basis is
//! E = rref(W) = W_J^-1 W, J its pivot columns, and the matrix of T_p (rows:
//! the images of E's rows, in E's coordinates) is C = W_J^-1 (T_p W)_J.
//!
//! **Exact linear algebra.**  E = rref(W) with its pivot columns J, and C
//! from one Dixon solve W_J C = (T_p W)_J, both by `sagebrush_arith::zmat`,
//! which certifies its results exactly; basis and matrix are returned over
//! one common denominator.
//!
//! **The twisted traces' primes.**  `orbit_hecke_traces` CRTs the traces
//! from primes ell = 1 mod the exponent of (Z/M)^*, ascending from 2^30.  A
//! prime is set aside only for a check mod ell that holds over Q
//! (`traces::Reject`: each reason is ell dividing a fixed nonzero integer of
//! the space), counted by reason in the result's `stats`, and the next one
//! drawn: there is no limit on their number.  The cyclic vector and
//! functional of each orbit's setup are found deterministically, so results
//! and meter units are the same on every run and platform.
//!
//! **Cost.**  `cusp_hecke_lower` is the admitted lower bound L (the output's
//! d^2 entries and the q-expansions held, from a closed-form dimension:
//! nothing of size N is built to admit); `cusp_hecke_cost` reports it with
//! no estimate E yet and no upper bound U (the trace phase has none).  The
//! work is metered by family where it is done: the twisted traces' kernels
//! (crate::count; their parallel jobs' units added at the joins, so the
//! units are the same on every thread count and target), the CRT, W's
//! assembly here, and zmat's rref and solve.  The modular symbols spaces
//! mod ell are not metered yet.

use crate::exact::is_prime;
use crate::general::Character;
use crate::newspace::{newspace_orbits, NewspaceOrbits};
use crate::orbits::Factorer;
use crate::traces::{orbit_hecke_traces, HeckeTraceStats};
use sagebrush_bigint::BigInt;

/// The divisors of n, sorted, from its factorization (trial division to
/// sqrt(n), not a scan to n).
fn divisors(n: u64) -> Vec<u64> {
    let mut ds = vec![1u64];
    for (p, e) in crate::exact::factor(n) {
        let len = ds.len();
        let mut q = 1u64;
        for _ in 0..e {
            q *= p;
            for i in 0..len {
                ds.push(ds[i] * q);
            }
        }
    }
    ds.sort_unstable();
    ds
}

/// The Hecke matrix of a prime: the reduced echelon basis (rows of
/// a_0..a_(prec-1)) basis[i][j] / den, its pivot columns, and T_p's matrix
/// matrix[i][j] / den (rows: the images of the basis elements).
pub struct CuspHecke {
    pub dim: usize,
    pub basis: Vec<Vec<BigInt>>,
    pub pivots: Vec<usize>,
    pub matrix: Vec<Vec<BigInt>>,
    pub den: BigInt,
    /// The twisted traces' prime loops, over all levels.
    pub stats: HeckeTraceStats,
}


/// W, T_p W and the twisted traces' statistics.
type Rows = (Vec<Vec<BigInt>>, Vec<Vec<BigInt>>, HeckeTraceStats);

/// W and T_p W: a basis of S_k(Gamma0(n)) (or of its new subspace) as
/// integer q-expansions a_0..a_(prec-1), and their images under T_p.
/// Units (cost::Local, flushed at the Stop check per row): the entries
/// copied, a Move per limb of each, and for U_p's fourth rule the product
/// by p^(k-1) (bigmul_units) and the difference (AddSub, a unit per limb).
fn rows(n: u64, k: usize, p: u64, prec: usize, new_only: bool, levels: &[(u64, NewspaceOrbits)]) -> Result<Rows, String> {
    use sagebrush_arith::cost::{bigmul_units, Family, Local};
    use sagebrush_arith::zmat::{copy_units, limbs};
    let pk = BigInt::from(p).pow(u32::try_from(k - 1).map_err(|_| "the weight must be below 2^31")?);
    let lpk = limbs(&pk);
    let mut stats = HeckeTraceStats::default();
    let mut local = Local::new();
    let mut w: Vec<Vec<BigInt>> = vec![];
    let mut tw: Vec<Vec<BigInt>> = vec![];
    for (m, res) in levels {
        let m = *m;
        sagebrush_interrupt::check_coarse();
        let eps = Character::trivial(m);
        let (tr, st) = orbit_hecke_traces(m, k, &eps, res, prec - 1, p)?;
        stats.add(&st);
        for t in divisors(n / m) {
            if new_only && t != 1 {
                continue;
            }
            for o in &tr {
                for i in 0..o.r.len() {
                    local.flush();
                    sagebrush_interrupt::check();
                    // coefficient nn of g(q^d), from rows indexed by nn - 1
                    let at = |rows: &Vec<Vec<BigInt>>, nn: usize, d: u64| -> BigInt {
                        let d = d as usize;
                        if nn.is_multiple_of(d) { rows[i][nn / d - 1].clone() } else { BigInt::from(0) }
                    };
                    let mut row = vec![BigInt::from(0); prec];
                    let mut img = vec![BigInt::from(0); prec];
                    for nn in 1..prec {
                        row[nn] = at(&o.r, nn, t);
                        img[nn] = if !n.is_multiple_of(p) {
                            at(&o.s, nn, t)
                        } else if t % p == 0 {
                            at(&o.r, nn, t / p)
                        } else if m % p == 0 {
                            at(&o.s, nn, t)
                        } else {
                            let x = at(&o.r, nn, t * p);
                            let y = at(&o.s, nn, t);
                            local.add(bigmul_units(lpk, limbs(&x)));
                            local.n(Family::AddSub, (lpk + limbs(&x)).max(limbs(&y)) as u64);
                            y - &pk * x
                        };
                    }
                    local.n(Family::Move, copy_units(&row) + copy_units(&img));
                    w.push(row);
                    tw.push(img);
                }
            }
        }
    }
    Ok((w, tw, stats))
}

/// The caller's admission of the op's rigorous lower bounds (L: words of
/// work and bytes held), before anything they count is allocated (the
/// native and WebAssembly bindings reserve the bytes in the ledger); an
/// error refuses the call.
pub trait Admit {
    fn admit(&mut self, work: u64, bytes: u64) -> Result<(), String>;
}

/// [SL2(Z) : Gamma0(n)] = n prod over p | n of (1 + 1/p), or None past u64.
fn gamma0_index(n: u64) -> Option<u64> {
    let mut idx = n;
    for (p, _) in crate::exact::factor(n) {
        idx = (idx / p).checked_mul(p + 1)?;
    }
    Some(idx)
}

/// The Sturm bound k [SL2(Z) : Gamma0(n)] / 12: forms in S_k(Gamma0(n))
/// whose q-expansions agree to past it are equal.
pub fn sturm_bound(n: u64, k: usize) -> Option<u64> {
    gamma0_index(n)?.checked_mul(k as u64).map(|x| x / 12)
}

/// dim S_k(Gamma0(n)), or of its new subspace with `new_only` (as sum over M
/// | n of beta(n / M) dim S_k(Gamma0(M)), beta multiplicative with beta(p) =
/// -2, beta(p^2) = 1 and beta(p^e) = 0 for e >= 3).
pub fn cusp_dim(n: u64, k: usize, new_only: bool) -> u64 {
    if !new_only {
        return gamma0_cusp_dim(n, k).unwrap_or(u64::MAX);
    }
    let mut total: i128 = 0;
    for m in divisors(n) {
        let mut beta: i128 = 1;
        for (_, e) in crate::exact::factor(n / m) {
            beta *= match e {
                1 => -2,
                2 => 1,
                _ => 0,
            };
        }
        if beta != 0 {
            let Some(d) = gamma0_cusp_dim(m, k) else { return u64::MAX };
            total += beta * i128::from(d);
        }
    }
    u64::try_from(total.max(0)).unwrap_or(u64::MAX)
}

/// dim S_k(Gamma0(n)) in closed form from n's factorization (Diamond and
/// Shurman, Thm. 3.5.1), with no table of size n: for even k >= 4,
/// (k - 1)(g - 1) + floor(k/4) e2 + floor(k/3) e3 + (k/2 - 1) einf, and g
/// for k = 2, where g = 1 + mu/12 - e2/4 - e3/3 - einf/2, mu the index, e2
/// and e3 the elliptic points and einf the cusps; 0 for odd k.  Computed
/// as 12 times the value in i128; None if it overflows.
pub fn gamma0_cusp_dim(n: u64, k: usize) -> Option<u64> {
    if k % 2 == 1 || n == 0 {
        return Some(0);
    }
    let f = crate::exact::factor(n);
    let mu = i128::from(gamma0_index(n)?);
    let e2: i128 = if n.is_multiple_of(4) { 0 } else { f.iter().map(|&(p, _)| if p == 2 { 1 } else if p % 4 == 1 { 2 } else { 0 }).product() };
    let e3: i128 = if n.is_multiple_of(9) { 0 } else { f.iter().map(|&(p, _)| if p == 3 { 1 } else if p == 2 { 0 } else if p % 3 == 1 { 2 } else { 0 }).product() };
    // cusps: sum over d | n of phi(gcd(d, n/d)), multiplicative: for p^r,
    // sum over a = 0..r of phi(p^min(a, r - a))
    let einf: i128 = f.iter().map(|&(p, r)| {
        (0..=r).map(|a| {
            let m = a.min(r - a);
            if m == 0 { 1i128 } else { i128::from(p - 1) * i128::from(p).pow(m - 1) }
        }).sum::<i128>()
    }).product();
    // 12 g = 12 + mu - 3 e2 - 4 e3 - 6 einf
    let g12 = 12 + mu - 3 * e2 - 4 * e3 - 6 * einf;
    let k = i128::try_from(k).ok()?;
    let d12 = if k == 2 {
        g12
    } else {
        (k - 1).checked_mul(g12 - 12)?
            .checked_add(12 * (k / 4) * e2)?
            .checked_add(12 * (k / 3) * e3)?
            .checked_add(12 * (k / 2 - 1) * einf)?
    };
    debug_assert!(d12 % 12 == 0);
    u64::try_from(d12 / 12).ok()
}

/// The op's rigorous lower bounds (L), from the closed form for d = the
/// dimension, at precision prec: the bytes of what it necessarily holds, C
/// (d^2 rationals, each two integers of at least 8 bytes: dashu keeps a
/// small value inline, 8 bytes on 64- and 32-bit targets alike) and W (d
/// prec integers, while it lives); and the work of writing C, d^2 words.
/// Saturating (a lower bound that overflows is replaced by u64::MAX, which
/// refuses, as the true value would).
pub fn cusp_hecke_lower(n: u64, k: usize, prec: usize, new_only: bool) -> (u64, u64) {
    let d = cusp_dim(n, k, new_only);
    let dd = d.saturating_mul(d);
    let bytes = dd.saturating_mul(16).saturating_add(d.saturating_mul(prec as u64).saturating_mul(8));
    (dd, bytes)
}

/// The op's Cost (the engine cost policy): L from [`cusp_hecke_lower`];
/// no estimate E until the harness has measured it; no upper bound U, as
/// the trace phase has none yet (its prime count has no proven bound on the
/// primes set aside, and the modular symbols spaces mod ell are not yet
/// metered).
pub fn cusp_hecke_cost(n: u64, k: usize, prec: usize, new_only: bool) -> sagebrush_arith::cost::Cost {
    let (work_lower, mem_lower) = cusp_hecke_lower(n, k, prec, new_only);
    sagebrush_arith::cost::Cost { mem_lower, work_lower, work_estimate: None, work_upper: None }
}

/// T_p (p prime) on S_k(Gamma0(n)), or on its new subspace with
/// `new_only`, in the reduced echelon basis, with q-expansions to `prec`,
/// which must exceed the Sturm bound (an error otherwise).
///
/// Admission (the engine cost policy): L ([`cusp_hecke_lower`]) is admitted
/// first, from the closed form for the dimension, before anything is
/// computed.  E and U are not reported yet (None): U for the twisted traces
/// needs a proven bound on their rejected primes, and zmat's routes have no
/// proven upper forms (design r3).  Nothing is capped: the twisted traces
/// draw primes until certified, the linear algebra is zmat's.
pub fn cusp_hecke_matrix(n: u64, k: usize, p: u64, prec: usize, new_only: bool, factor: Factorer, admit: &mut impl Admit) -> Result<CuspHecke, String> {
    if p >= crate::linalg::MAX_HECKE_PRIME || !is_prime(p) {
        return Err(format!("{} must be a prime below 2^30", p));
    }
    // (k < 2^31, so k - 1 is a u32 exponent below)
    crate::check_weight(k)?;
    let empty = CuspHecke { dim: 0, basis: vec![], pivots: vec![], matrix: vec![], den: BigInt::from(1), stats: HeckeTraceStats::default() };
    if k < 2 || k % 2 == 1 {
        // (no cusp forms of odd weight for the trivial character)
        return Ok(empty);
    }
    match sturm_bound(n, k) {
        Some(b) if (prec as u64) > b => {}
        _ => return Err(format!("precision {} must exceed the Sturm bound of S_{}(Gamma0({}))", prec, k, n)),
    }
    let (work, bytes) = cusp_hecke_lower(n, k, prec, new_only);
    admit.admit(work, bytes)?;
    let mut levels = vec![];
    for m in divisors(n) {
        if new_only && m != n {
            continue;
        }
        sagebrush_interrupt::check_coarse();
        let res = newspace_orbits(m, k, &Character::trivial(m), factor)?;
        if !res.orbits.is_empty() {
            levels.push((m, res));
        }
    }
    let (w, tw, stats) = rows(n, k, p, prec, new_only, &levels)?;
    if w.is_empty() {
        return Ok(empty);
    }
    let t0 = crate::now();
    let mut out = solve(&w, &tw)?;
    if std::env::var("SAGEBRUSH_TIMING").is_ok() {
        eprintln!(r#"{{"n":{},"k":{},"p":{},"dim":{},"solve":{:.4}}}"#, n, k, p, out.dim, crate::elapsed_ms(t0, crate::now()) / 1e3);
    }
    out.stats = stats;
    Ok(out)
}

/// The exact linear algebra of the module docs: E = rref(W) (zmat, certified
/// exactly), whose pivots J give W_J, and C = W_J^-1 (T_p W)_J by one Dixon
/// solve (zmat).  Both over one positive common denominator.
fn solve(w: &[Vec<BigInt>], tw: &[Vec<BigInt>]) -> Result<CuspHecke, String> {
    use num_integer::Integer;
    use sagebrush_arith::cost::{bigdiv_units, biggcd_units, bigmul_units, Family, Local};
    use sagebrush_arith::zmat::{self, copy_units, limbs, ZMat};
    // (its own work, in a Local flushed at its Stop checks: the copies into
    // and out of zmat (Move, a unit per limb), the lcm of the denominators
    // (their gcd, the quotient and the product), the two quotients, and a
    // product per entry scaled; zmat counts its rref, select and solve)
    let mut local = Local::new();
    let d = w.len();
    local.n(Family::Move, w.iter().map(|r| copy_units(r)).sum());
    let wm = ZMat::from_rows(w.to_vec());
    let (e, den_e, piv) = zmat::rref(&wm);
    if piv.len() != d {
        // (W's rows are a basis of the space and the precision exceeds the
        // Sturm bound: rank d over Q, or a bug)
        return Err(format!("internal error: the q-expansion rows have rank {} below the dimension {}", piv.len(), d));
    }
    let all: Vec<usize> = (0..d).collect();
    let wj = wm.select(&all, &piv);
    local.n(Family::Move, tw.iter().map(|r| copy_units(r)).sum());
    let twj = ZMat::from_rows(tw.to_vec()).select(&all, &piv);
    let (c, den_c) = zmat::solve(&wj, &twj).ok_or("internal error: W_J is singular at its own pivots")?;
    let (le, lc) = (limbs(&den_e), limbs(&den_c));
    let g = den_e.gcd(&den_c);
    local.add(biggcd_units(le, lc));
    local.add(bigdiv_units(le, limbs(&g)));
    local.add(bigmul_units(le, lc));
    let den = &den_e / &g * &den_c;
    let ld = limbs(&den);
    local.add(bigdiv_units(ld, le));
    local.add(bigdiv_units(ld, lc));
    let (fe, fc) = (&den / &den_e, &den / &den_c);
    let scale = |m: Vec<Vec<BigInt>>, f: &BigInt, local: &mut Local| -> Vec<Vec<BigInt>> {
        let lf = limbs(f);
        m.into_iter().map(|r| {
            local.flush();
            sagebrush_interrupt::check();
            local.n(Family::Move, copy_units(&r));
            let out: Vec<BigInt> = r.into_iter().map(|x| {
                local.add(bigmul_units(limbs(&x), lf));
                x * f
            }).collect();
            out
        }).collect()
    };
    let basis = scale(e.to_rows().into_iter().take(d).collect(), &fe, &mut local);
    let matrix = scale(c.to_rows(), &fc, &mut local);
    Ok(CuspHecke { dim: d, basis, pivots: piv, matrix, den, stats: HeckeTraceStats::default() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sagebrush_arith::cost::{bigdiv_units, biggcd_units, bigmul_units, tallied, Family, Units};
    use sagebrush_arith::zmat::{self, ZMat};

    fn delta(after: Units, before: Units) -> Units {
        let mut d = Units::default();
        for (i, x) in d.0.iter_mut().enumerate() {
            *x = after.0[i].wrapping_sub(before.0[i]);
        }
        d
    }

    /// solve's own units, pinned: all of its units less zmat's (the same
    /// rref, selects and solve, measured apart) are its copies, its lcm and
    /// quotients, and a product per entry scaled, counted here by hand on
    /// one-limb entries.
    #[test]
    fn solve_counts_its_own_work() {
        let big = |v: &[i64]| v.iter().map(|&x| BigInt::from(x)).collect::<Vec<_>>();
        // W: 2 rows of 4 (rank 2, pivots 0 and 1, rref denominator 2), and
        // T W, whose solve has denominator 2 too
        let w = vec![big(&[2, 1, 3, 1]), big(&[0, 2, 1, 5])];
        let tw = vec![big(&[1, 0, 2, 4]), big(&[3, 1, 0, 1])];
        let before = tallied();
        let h = solve(&w, &tw).unwrap();
        let all = delta(tallied(), before);
        let before = tallied();
        let wm = ZMat::from_rows(w.clone());
        let (_, den_e, piv) = zmat::rref(&wm);
        let rows: Vec<usize> = (0..2).collect();
        let wj = wm.select(&rows, &piv);
        let twj = ZMat::from_rows(tw.clone()).select(&rows, &piv);
        let (_, den_c) = zmat::solve(&wj, &twj).unwrap();
        let theirs = delta(tallied(), before);
        let mut mine = Units::default();
        for (a, b) in mine.0.iter_mut().zip(all.0.iter().zip(theirs.0)) {
            *a = b.0 - b.1;
        }
        assert!(den_e.bits() < 64 && den_c.bits() < 64 && h.den.bits() < 64, "one-limb denominators");
        // the copies in (8 + 8 limbs) and out (E's 8 entries, C's 4)
        assert_eq!(mine.get(Family::Move), 8 + 8 + 8 + 4);
        // the lcm's gcd; its quotient and the two scale factors; its product
        // and a product per entry (12)
        assert_eq!(mine.get(Family::Gcd), biggcd_units(1, 1).get(Family::Gcd));
        assert_eq!(mine.get(Family::Div), 3 * bigdiv_units(1, 1).get(Family::Div));
        assert_eq!(mine.get(Family::MulSchool), 13 * bigmul_units(1, 1).get(Family::MulSchool));
        assert_eq!(mine.get(Family::ModArith), 0);
    }
}
