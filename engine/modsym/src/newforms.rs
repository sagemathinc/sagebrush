//! Rational newforms of weight 2 and level N, and their a_p.
//!
//! A rational newform has integer eigenvalues a_q with |a_q| <= 2 sqrt(q),
//! so no polynomial factoring is needed: the dual of the sign +1 space is
//! split by the integer eigenvalues of T_q in the Hasse range, prime by
//! prime (Eisenstein eigenvalues, chi(q) + psi(q) q, always fall outside
//! it).  Hecke operators commute, so a 1-dimensional joint eigenspace is an
//! eigenvector for the whole Hecke algebra, and its eigen-system has
//! multiplicity one; an oldform from level M | N occurs d(N/M) >= 2 times.
//! The 1-dimensional joint eigenspaces are therefore exactly the rational
//! newforms of level N (once enough primes separate them).
//!
//! Splitting stops as soon as the dimensions are explained: the rational
//! newforms of each level M | N, M < N (computed first, memoized) predict
//! the old part exactly, each with multiplicity d(N/M), so a subspace whose
//! dimension equals the old multiplicity of its eigenvalues is purely old
//! and is dropped, and refinement only continues where something is
//! unexplained.
//!
//! Each newform is a functional psi on the Manin-symbol generators with
//! psi o T_p = a_p psi, so a_p = psi(T_p x) / psi(x) for a fixed generator
//! x: one sum over Heilbronn matrices per prime, no matrices.  Everything is
//! computed modulo a prime ell ~ 2^31; |a_p| <= 2 sqrt(p) < ell / 2 makes
//! the lift exact.  Two checks guard against accidental congruences mod ell
//! (a newform of higher degree, or two eigen-systems, that look rational and
//! distinct only modulo ell): the Hasse bound at every computed a_p, and the
//! whole computation again modulo a second prime, which must give the same
//! newforms.  Neither is a proof in characteristic zero; the result says so
//! (`status`, `checks`).

use crate::exact::is_prime;
use crate::linalg;
use crate::par;
use crate::presentation::Presentation;
use crate::space::Space;

pub const ELL: u64 = 2147483629;
/// The second prime, for the check.
pub const ELL2: u64 = 2147483587;

/// A rational newform: a_p for every prime p <= bound not dividing N.
#[derive(Debug, Clone)]
pub struct Newform {
    pub ap: Vec<(u64, i64)>,
}

#[derive(Debug, Clone)]
pub struct Newforms {
    pub n: u64,
    pub dim: usize,
    pub forms: Vec<Newform>,
    /// Joint eigenspaces of dimension >= 2 left after splitting (rational
    /// oldforms, with their multiplicity), as (dimension, eigenvalues).
    pub old: Vec<(usize, Vec<(u64, i64)>)>,
    /// Primes used for splitting.
    pub split_primes: Vec<u64>,
    /// "checked": the checks below passed (not a proof).
    pub status: &'static str,
    pub checks: Vec<String>,
}

pub(crate) fn isqrt(n: u64) -> i64 {
    let mut r = (n as f64).sqrt() as u64;
    while r * r > n {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    r as i64
}

pub(crate) fn modp(a: i64, p: u64) -> u64 {
    a.rem_euclid(p as i64) as u64
}

pub(crate) fn inv(a: u64, p: u64) -> u64 {
    let (mut b, mut e, mut r) = (a % p, p - 2, 1u64);
    while e > 0 {
        if e & 1 == 1 {
            r = (r as u128 * b as u128 % p as u128) as u64;
        }
        b = (b as u128 * b as u128 % p as u128) as u64;
        e >>= 1;
    }
    r
}

/// Reduced row echelon form in place (zero rows removed); the pivot columns.
pub(crate) fn rref(m: &mut Vec<Vec<u64>>, p: u64) -> Vec<usize> {
    let (r, pivots) = linalg::rref_mod(std::mem::take(m), p);
    *m = r;
    pivots
}

/// A basis of {v : M v = 0} for M with `cols` columns.
pub(crate) fn kernel(mut m: Vec<Vec<u64>>, cols: usize, p: u64) -> Vec<Vec<u64>> {
    let pivots = rref(&mut m, p);
    let mut out = vec![];
    for free in (0..cols).filter(|c| !pivots.contains(c)) {
        let mut v = vec![0u64; cols];
        v[free] = 1;
        for (row, &pc) in m.iter().zip(&pivots) {
            v[pc] = (p - row[free]) % p;
        }
        out.push(v);
    }
    out
}

/// psi(T x) for the generator g, with T given by its Heilbronn matrices.
pub(crate) fn heilbronn_pairing(pres: &Presentation, h: &[(i64, i64, i64, i64)], psi: &[u64], g: u32, p: u64) -> u64 {
    let (i, s) = pres.sym_of_gen[g as usize];
    let (c, d) = pres.p1.get(i as usize);
    let (c, d) = (c as i64, d as i64);
    let mut acc = 0i128;
    for &(a, b, cc, dd) in h {
        if let Some((g2, s2)) = pres.rep_of[pres.p1.index(c * a + d * cc, c * b + d * dd)] {
            let v = psi[g2 as usize] as i128;
            acc += if s2 ^ s { -v } else { v };
        }
    }
    acc.rem_euclid(p as i128) as u64
}

/// T phi for functionals phi (in basis coordinates): (T phi)_i = phi(T e_i).
fn hecke_dual(sp: &Space, pres: &Presentation, q: u64, rows: &[Vec<u64>]) -> Vec<Vec<u64>> {
    let h = linalg::heilbronn(q as i64);
    par::map_slice(rows, |phi| {
        let psi = sp.extend(phi);
        sp.basis_gen.iter().map(|&g| heilbronn_pairing(pres, &h, &psi, g, sp.p)).collect()
    })
}

/// A Hecke-stable subspace of the dual (rows in reduced echelon form) and
/// the eigenvalues found so far.
struct Sub {
    rows: Vec<Vec<u64>>,
    eigen: Vec<(u64, i64)>,
}

/// a_p (p <= CACHE_BOUND, p not dividing the level) of the rational
/// newforms of each level computed so far: the old systems at higher levels.
const CACHE_BOUND: u64 = 400;
static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, std::sync::Arc<Vec<Vec<(u64, i64)>>>>>> = std::sync::OnceLock::new();

/// The a_p (p <= 400, p not dividing N) of the rational newforms of level
/// N, memoized: what a sweep over many levels should call, since every level
/// is also needed as an old part of its multiples.
pub fn newform_aps(n: u64, max_split: usize) -> Result<std::sync::Arc<Vec<Vec<(u64, i64)>>>, String> {
    cached_forms(n, max_split)
}

fn cached_forms(m: u64, max_split: usize) -> Result<std::sync::Arc<Vec<Vec<(u64, i64)>>>, String> {
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(&m) {
        return Ok(v.clone());
    }
    let nf = rational_newforms(m, CACHE_BOUND, max_split)?;
    let v = std::sync::Arc::new(nf.forms.into_iter().map(|f| f.ap).collect::<Vec<_>>());
    cache.lock().unwrap().insert(m, v.clone());
    Ok(v)
}

fn num_divisors(n: u64) -> usize {
    (1..=n).filter(|d| n % d == 0).count()
}

/// The rational old systems at level N: (a_p list, multiplicity d(N/M)).
fn old_systems(n: u64, max_split: usize) -> Result<Vec<(std::sync::Arc<Vec<Vec<(u64, i64)>>>, usize)>, String> {
    let mut out = vec![];
    for m in (11..n).filter(|m| n % m == 0) {
        let forms = cached_forms(m, max_split)?;
        if !forms.is_empty() {
            out.push((forms, num_divisors(n / m)));
        }
    }
    Ok(out)
}

/// The total multiplicity of the old systems with these eigenvalues.
fn old_multiplicity(old: &[(std::sync::Arc<Vec<Vec<(u64, i64)>>>, usize)], eigen: &[(u64, i64)]) -> usize {
    let mut total = 0;
    for (forms, mult) in old {
        for f in forms.iter() {
            if eigen.iter().all(|&(q, a)| f.iter().any(|&(p, b)| p == q && b == a)) {
                total += mult;
            }
        }
    }
    total
}

/// The multiplicity of x as a root of f (constant term first) mod p.
fn root_multiplicity(f: &[u64], x: u64, p: u64) -> usize {
    let mut f = f.to_vec();
    let mut mult = 0;
    while f.len() > 1 {
        // Synthetic division by (t - x): the remainder is f(x).
        let n = f.len() - 1;
        let mut q = vec![0u64; n];
        let mut acc = 0u64;
        for i in (0..=n).rev() {
            acc = ((acc as u128 * x as u128 + f[i] as u128) % p as u128) as u64;
            if i > 0 {
                q[i - 1] = acc;
            }
        }
        if acc != 0 {
            break;
        }
        mult += 1;
        f = q;
    }
    mult
}

/// Drops the subspaces the old systems explain completely; keeps the rest.
fn settle(subs: Vec<Sub>, old_sys: &[(std::sync::Arc<Vec<Vec<(u64, i64)>>>, usize)], old: &mut Vec<(usize, Vec<(u64, i64)>)>) -> Result<Vec<Sub>, String> {
    let mut keep = vec![];
    for s in subs {
        let k = s.rows.len();
        let o = old_multiplicity(old_sys, &s.eigen);
        if o > k {
            return Err(format!("old multiplicity {} exceeds the dimension {} at {:?}", o, k, s.eigen));
        }
        if o == k {
            old.push((k, s.eigen));
        } else {
            keep.push(s);
        }
    }
    Ok(keep)
}

/// Rational newforms of level N, with a_p for primes p <= bound not dividing N.
/// At most `max_split` primes are used to separate eigen-systems.  Checked
/// (the Hasse bound; the same newforms modulo a second prime), or an error.
pub fn rational_newforms(n: u64, bound: u64, max_split: usize) -> Result<Newforms, String> {
    if n == 0 {
        return Err("level N = 0".into());
    }
    if max_split == 0 {
        return Err("max_split must be at least 1".into());
    }
    let mut nf = newforms_mod(n, bound, max_split, ELL)?;
    for f in &nf.forms {
        if !f.hasse_ok() {
            return Err(format!("N = {}: a_p outside the Hasse bound modulo {} (an accidental congruence): {:?}", n, ELL, f.ap.iter().find(|&&(p, a)| a * a > 4 * p as i64)));
        }
    }
    let again = newforms_mod(n, bound, max_split, ELL2)?;
    // the old part: each component's dimension and eigenvalues
    let old = |x: &Newforms| { let mut d = x.old.clone(); d.sort(); d };
    if again.forms.iter().map(|f| &f.ap).ne(nf.forms.iter().map(|f| &f.ap)) || old(&again) != old(&nf) {
        return Err(format!("N = {}: the rational newforms differ modulo {} and {} (an accidental congruence)", n, ELL, ELL2));
    }
    nf.status = "checked";
    nf.checks = vec![
        format!("every a_p (p <= {}) within the Hasse bound", bound),
        format!("the same newform coefficients and old components (dimensions and eigenvalues) modulo {} and {}; the lower levels' newforms, shared by both, were checked the same way", ELL, ELL2),
    ];
    Ok(nf)
}

/// The computation modulo one prime p.
fn newforms_mod(n: u64, bound: u64, max_split: usize, p: u64) -> Result<Newforms, String> {
    let debug = std::env::var("SAGEBRUSH_DEBUG").is_ok();
    let t0 = crate::now();
    let lap = |what: &str| {
        if debug {
            eprintln!("  N={} {:>8.3} s  {}", n, crate::elapsed_ms(t0, crate::now()) / 1000.0, what);
        }
    };
    let pres = Presentation::new(n);
    let sp = Space::new(&pres, p);
    let d = sp.dimension();
    lap(&format!("space, dim {}", d));
    let primes: Vec<u64> = (2..).filter(|&q| is_prime(q) && n % q != 0).take(max_split).collect();
    let old_sys = old_systems(n, max_split)?;
    lap("old systems (lower levels)");
    let mut old = vec![];
    let mut subs: Vec<Sub> = vec![];
    let mut split_primes = vec![];
    // The first prime: the full matrix, its charpoly's integer roots, kernels.
    if d > 0 {
        let q = primes[0];
        split_primes.push(q);
        let t = sp.hecke_matrix(&pres, q);
        lap("first Hecke matrix");
        let f = linalg::charpoly(t.clone(), p);
        lap("charpoly");
        let w = isqrt(4 * q);
        for a in -w..=w {
            let x = modp(a, p);
            let mult = root_multiplicity(&f, x, p);
            if mult == 0 {
                continue;
            }
            // T_q is semisimple, so the eigenspace has dimension mult; if the
            // old systems with this eigenvalue account for all of it, the
            // eigenspace is purely old and its kernel is not needed.
            if old_multiplicity(&old_sys, &[(q, a)]) == mult {
                old.push((mult, vec![(q, a)]));
                lap(&format!("a_{} = {}: multiplicity {}, all old", q, a, mult));
                continue;
            }
            let m: Vec<Vec<u64>> = (0..d).map(|i| (0..d).map(|j| (t[i][j] + if i == j { p - x } else { 0 }) % p).collect()).collect();
            let mut rows = kernel(m, d, p);
            rref(&mut rows, p);
            lap(&format!("kernel for a_{} = {}: dim {}", q, a, rows.len()));
            subs.push(Sub { rows, eigen: vec![(q, a)] });
        }
        subs = settle(subs, &old_sys, &mut old)?;
        lap(&format!("settled: {} subspaces left, dims {:?}", subs.len(), subs.iter().map(|s| s.rows.len()).collect::<Vec<_>>()));
    }
    // Refine the subspaces of dimension >= 2 with further primes.
    for &q in &primes[1..] {
        if subs.iter().all(|s| s.rows.len() < 2) {
            break;
        }
        split_primes.push(q);
        let w = isqrt(4 * q);
        let mut next = vec![];
        for s in subs {
            if s.rows.len() < 2 {
                next.push(s);
                continue;
            }
            let mut rows = s.rows;
            let pivots = rref(&mut rows, p);
            let k = rows.len();
            let tw = hecke_dual(&sp, &pres, q, &rows);
            // T w_r = sum_s A[r][s] w_s; read the coefficients off the pivots.
            let a_mat: Vec<Vec<u64>> = tw.iter().map(|v| pivots.iter().map(|&c| v[c]).collect()).collect();
            for a in -w..=w {
                let x = modp(a, p);
                // c (A - a) = 0  <=>  (A - a)^T c = 0
                let mt: Vec<Vec<u64>> = (0..k).map(|i| (0..k).map(|j| (a_mat[j][i] + if i == j { p - x } else { 0 }) % p).collect()).collect();
                let cs = kernel(mt, k, p);
                if cs.is_empty() {
                    continue;
                }
                let mut new_rows: Vec<Vec<u64>> = cs
                    .iter()
                    .map(|c| (0..d).map(|j| (0..k).fold(0u128, |acc, r| acc + c[r] as u128 * rows[r][j] as u128) % p as u128).map(|v| v as u64).collect())
                    .collect();
                rref(&mut new_rows, p);
                let mut eigen = s.eigen.clone();
                eigen.push((q, a));
                next.push(Sub { rows: new_rows, eigen });
            }
        }
        subs = settle(next, &old_sys, &mut old)?;
        lap(&format!("split by T_{}: {} subspaces left, dims {:?}", q, subs.len(), subs.iter().map(|s| s.rows.len()).collect::<Vec<_>>()));
    }
    let mut forms = vec![];
    let ap_primes: Vec<u64> = (2..=bound).filter(|&q| is_prime(q) && n % q != 0).collect();
    for s in subs {
        if s.rows.len() != 1 {
            return Err(format!("N = {}: a {}-dimensional eigenspace is unexplained after {} primes", n, s.rows.len(), split_primes.len()));
        }
        let psi = sp.extend(&s.rows[0]);
        let x = (0..psi.len()).find(|&g| psi[g] != 0).ok_or("zero functional")? as u32;
        let ix = inv(psi[x as usize], p);
        let ap = par::map_slice(&ap_primes, |&q| {
            let v = heilbronn_pairing(&pres, &linalg::heilbronn(q as i64), &psi, x, p);
            let a = (v as u128 * ix as u128 % p as u128) as i64;
            (q, if a > (p / 2) as i64 { a - p as i64 } else { a })
        });
        forms.push(Newform { ap });
    }
    forms.sort_by(|a, b| a.ap.cmp(&b.ap));
    Ok(Newforms { n, dim: d, forms, old, split_primes, status: "unchecked", checks: vec![] })
}

impl Newform {
    /// Whether every a_p satisfies the Hasse bound (a check against
    /// accidental congruences modulo ell).
    pub fn hasse_ok(&self) -> bool {
        self.ap.iter().all(|&(p, a)| a * a <= 4 * p as i64)
    }
}
