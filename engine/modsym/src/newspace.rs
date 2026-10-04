//! Galois orbits of newforms in S_k^new(N, [eps]) (the sum over the Galois
//! orbit [eps] of the character), as LMFDB lists them, for k >= 2.
//!
//! Let T = sum r_i T_(q_i) with q_i not dividing N.  Modulo a prime
//! ell = 1 mod exp((Z/N)^*), for every level M with cond(eps) | M | N and
//! every embedding j (the conjugate character eps^j):
//!   * f = charpoly of T on M_k(M, eps_M^j)^+ (sign +1 modular symbols);
//!   * remove every root that is an Eisenstein eigenvalue
//!     psi(q) + phi(q) q^(k-1) (all E_k^(psi, phi, t) with psi phi = eps^j,
//!     cond psi cond phi t | M), leaving the cuspidal charpoly c, whose
//!     degree must be dim S_k(M, eps_M) (dims.rs);
//!   * divide out g_new(M')^sigma0(M/M') for the smaller levels M' (old
//!     forms, Atkin-Lehner-Li), leaving g_new(M) of degree dim S_k^new.
//! The product over j of g_new(N) is the charpoly over Q of T on the
//! newspace, h in Z[x], of degree = LMFDB's dimension; it is lifted by CRT
//! (all roots are cuspidal: Deligne's bound), and when it is squarefree its
//! irreducible factors over Q are exactly the Galois orbits of newforms
//! (their eigenvalues for T generate the Hecke fields).  T is enlarged until
//! h is squarefree mod ell.
//!
//! Soundness: a bad ell (wrong dimension, an Eisenstein root colliding
//! with a cuspidal one mod ell, a non-exact division) fails a degree or
//! remainder check and is skipped.  Dimensions of M^+ are certified once by
//! dim M^+ + dim M^- = 2 dim S_k + dim E_k.

use crate::dims::{dim_cusp_forms, dim_eisenstein, dim_modsym};
use crate::dirichlet::DirichletGroup;
use crate::exact::{factor, is_prime};
use crate::general::{mul, powmod, primes_one_mod, root_of_unity, Character, GeneralSpace};
use crate::general_exact::{crt, embedding_bounds};
use crate::orbits::Factorer;
use crate::p1::gcd;
use crate::par;
use num_bigint::{BigInt, BigUint};
use num_traits::{One, Zero};

#[derive(Debug, Clone)]
pub struct NewspaceOrbits {
    pub n: u64,
    pub k: usize,
    /// Order of the character; dimensions are over Q (as in LMFDB).
    pub m: u64,
    pub dim: usize,
    /// Galois orbits: their charpolys of T over Q, sorted by degree.
    pub orbits: Vec<Vec<BigInt>>,
    pub dims: Vec<usize>,
    /// The Hecke operator used: T = sum r T_q.
    pub ops: Vec<(u64, i64)>,
    pub primes_used: usize,
    pub status: &'static str,
    pub checks: Vec<String>,
}

// ---- polynomials mod p, constant term first, no trailing zeros ----

fn trim(mut f: Vec<u64>) -> Vec<u64> {
    while f.len() > 1 && *f.last().unwrap() == 0 {
        f.pop();
    }
    f
}

fn pmul(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let mut out = vec![0u64; a.len() + b.len() - 1];
    for (i, &x) in a.iter().enumerate() {
        if x != 0 {
            for (j, &y) in b.iter().enumerate() {
                out[i + j] = (out[i + j] + mul(x, y, p)) % p;
            }
        }
    }
    trim(out)
}

/// (quotient, remainder) of a by b (b nonzero).
fn pdivrem(a: &[u64], b: &[u64], p: u64) -> (Vec<u64>, Vec<u64>) {
    let mut r = a.to_vec();
    let db = b.len() - 1;
    if a.len() < b.len() {
        return (vec![0], trim(r));
    }
    let inv = powmod(b[db], p - 2, p);
    let mut q = vec![0u64; a.len() - db];
    for i in (0..q.len()).rev() {
        let c = mul(r[i + db], inv, p);
        q[i] = c;
        if c != 0 {
            for (t, &bt) in b.iter().enumerate() {
                r[i + t] = (r[i + t] + p - mul(c, bt, p)) % p;
            }
        }
    }
    r.truncate(db.max(1));
    (trim(q), trim(r))
}

fn monic(f: Vec<u64>, p: u64) -> Vec<u64> {
    let inv = powmod(*f.last().unwrap(), p - 2, p);
    f.into_iter().map(|c| mul(c, inv, p)).collect()
}

fn pgcd(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let (mut a, mut b) = (trim(a.to_vec()), trim(b.to_vec()));
    while !(b.len() == 1 && b[0] == 0) {
        let r = pdivrem(&a, &b, p).1;
        a = b;
        b = r;
    }
    monic(a, p)
}

fn deriv(f: &[u64], p: u64) -> Vec<u64> {
    if f.len() == 1 {
        return vec![0];
    }
    trim((1..f.len()).map(|i| mul(f[i], i as u64 % p, p)).collect())
}

fn deg(f: &[u64]) -> usize {
    f.len() - 1
}

// ---- levels, Eisenstein series ----

struct Level {
    m: u64,
    eps: Character,
    group: DirichletGroup,
    /// Per embedding j (index into the units mod ord eps): for each
    /// Eisenstein series, the exponents of psi(q_i) and phi(q_i) relative
    /// to zeta_(group exponent), per q in `qs`.
    eis: Vec<Vec<(Vec<u64>, Vec<u64>)>>,
    dim_s: usize,
    dim_new: usize,
    /// Smaller levels M' | M (indices) with sigma0(M / M').
    below: Vec<(usize, u32)>,
}

fn sigma0(n: u64) -> u32 {
    factor(n).iter().map(|&(_, e)| e + 1).product()
}

/// The Eisenstein series of weight k for eps^j at level M, as exponent
/// pairs (psi(q), phi(q)) for q in qs; checked against dim E_k.
fn eisenstein_series(g: &DirichletGroup, eps: &Character, k: usize, units: &[u64], qs: &[u64]) -> Result<Vec<Vec<(Vec<u64>, Vec<u64>)>>, String> {
    let nchars = g.order();
    let conductors: Vec<u64> = (0..nchars).map(|c| g.character(&g.vector(c)).conductor()).collect();
    let ve = g.vector_of(eps);
    let mut out = vec![];
    let mut total = 0usize;
    for &j in units {
        let target: Vec<u64> = ve.iter().zip(&g.orders).map(|(&x, &o)| x * j % o).collect();
        let mut series = vec![];
        for c in 0..nchars {
            let psi = g.vector(c);
            let phi: Vec<u64> = target.iter().zip(&psi).zip(&g.orders).map(|((&t, &s), &o)| (t + o - s) % o).collect();
            let (u, v) = (conductors[c as usize], conductors[g.index(&phi) as usize]);
            if g.n % (u * v) != 0 {
                continue;
            }
            let ts = (1..=g.n / (u * v)).filter(|t| (g.n / (u * v)) % t == 0).count();
            let trivial = u == 1 && v == 1;
            let count = if k == 2 && trivial { ts - 1 } else { ts };
            let vals = |chi: &[u64]| qs.iter().map(|&q| g.value(chi, q).unwrap()).collect::<Vec<u64>>();
            for _ in 0..count {
                series.push((vals(&psi), vals(&phi)));
            }
        }
        total += series.len();
        out.push(series);
    }
    let want = units.len() * dim_eisenstein(eps, k) as usize;
    if total != want {
        return Err(format!("Eisenstein series at level {}: enumerated {}, dim E_k gives {}", g.n, total, want));
    }
    Ok(out)
}

fn levels(n: u64, k: usize, eps: &Character, units: &[u64], qs: &[u64]) -> Result<Vec<Level>, String> {
    let f = eps.conductor();
    let ms: Vec<u64> = (1..=n).filter(|&m| n % m == 0 && m % f == 0).collect();
    let mut out: Vec<Level> = vec![];
    for &m in &ms {
        let e = eps.restrict(m);
        let group = DirichletGroup::new(m);
        let eis = eisenstein_series(&group, &e, k, units, qs)?;
        let dim_s = dim_cusp_forms(&e, k) as usize;
        let below: Vec<(usize, u32)> = out.iter().enumerate().filter(|(_, l)| m % l.m == 0).map(|(i, l)| (i, sigma0(m / l.m))).collect();
        let old: usize = below.iter().map(|&(i, s)| s as usize * out[i].dim_new).sum();
        if old > dim_s {
            return Err(format!("old dimension {} exceeds dim S = {} at level {}", old, dim_s, m));
        }
        out.push(Level { m, eps: e, group, eis, dim_s, dim_new: dim_s - old, below });
    }
    Ok(out)
}

/// g_new(N) mod ell for the embedding with zeta_ord = zm, or None if ell is
/// bad for this embedding (a degree or divisibility check failed).
fn new_poly_mod(levels: &[Level], k: usize, ops: &[(u64, i64)], ell: u64, z_e: u64, e_top: u64, jdx: usize, j: u64, dims_plus: &[usize]) -> Result<Option<Vec<u64>>, String> {
    let mut news: Vec<Vec<u64>> = vec![];
    for (li, lv) in levels.iter().enumerate() {
        let ord = lv.eps.order;
        let zm = powmod(z_e, e_top / ord * j, ell);
        let sp = GeneralSpace::new_mod(lv.m, k, &lv.eps, 1, ell, zm)?;
        if sp.dimension() != dims_plus[li] {
            return Ok(None);
        }
        let mut f = sp.hecke_combo_charpoly(ops)?;
        // Eisenstein eigenvalues of T for eps^j.
        let ze = powmod(z_e, e_top / lv.group.exponent.max(1), ell);
        let mut e = vec![1u64];
        for (psi, phi) in &lv.eis[jdx] {
            let mut lam = 0u64;
            for (i, &(q, r)) in ops.iter().enumerate() {
                let qk = powmod(q, k as u64 - 1, ell);
                let a = (powmod(ze, psi[i], ell) + mul(powmod(ze, phi[i], ell), qk, ell)) % ell;
                lam = (lam + mul(a, r.rem_euclid(ell as i64) as u64, ell)) % ell;
            }
            e = pmul(&e, &[(ell - lam) % ell, 1], ell);
        }
        loop {
            let g = pgcd(&f, &e, ell);
            if deg(&g) == 0 {
                break;
            }
            f = pdivrem(&f, &g, ell).0;
        }
        if deg(&f) != lv.dim_s {
            return Ok(None);
        }
        for &(i, s) in &lv.below {
            for _ in 0..s {
                let (q, r) = pdivrem(&f, &news[i], ell);
                if !(r.len() == 1 && r[0] == 0) {
                    return Ok(None);
                }
                f = q;
            }
        }
        if deg(&f) != lv.dim_new {
            return Ok(None);
        }
        news.push(f);
    }
    Ok(news.pop())
}

/// Primes not dividing N: the two smallest plus the least further primes
/// needed for the residues to generate (Z/N)^*, then two more.
fn hecke_primes(n: u64) -> Vec<u64> {
    let primes = (2..).filter(|&q| is_prime(q) && n % q != 0);
    let units = (1..=n.max(1)).filter(|&x| gcd(x, n) == 1 || n == 1).count();
    let mut qs: Vec<u64> = vec![];
    let mut group = vec![false; n.max(1) as usize];
    group[(1 % n.max(1)) as usize] = true;
    let mut size = 1;
    let mut extra = 0;
    for q in primes {
        let r = q % n.max(1);
        if qs.len() < 2 || !group[r as usize] {
            qs.push(q);
            // Close the subgroup under multiplication by r.
            loop {
                let before = size;
                for x in 0..n.max(1) {
                    if group[x as usize] {
                        let y = (x * r) % n.max(1);
                        if !group[y as usize] {
                            group[y as usize] = true;
                            size += 1;
                        }
                    }
                }
                if size == before {
                    break;
                }
            }
        } else if size == units {
            qs.push(q);
            extra += 1;
        }
        if size == units && extra >= 2 && qs.len() >= 4 {
            break;
        }
    }
    qs
}

pub fn newspace_orbits(n: u64, k: usize, eps: &Character, factor_fn: Factorer) -> Result<NewspaceOrbits, String> {
    if k < 2 || eps.n != n {
        return Err("need k >= 2 and a character mod N".into());
    }
    let eps = eps.minimal();
    let m = eps.order;
    if eps.is_even() != (k % 2 == 0) {
        // eps(-1) != (-1)^k: every space is zero.
        return Ok(NewspaceOrbits { n, k, m, dim: 0, orbits: vec![], dims: vec![], ops: vec![], primes_used: 0, status: "proven", checks: vec!["eps(-1) != (-1)^k".into()] });
    }
    let units: Vec<u64> = (0..m.max(1)).filter(|&j| gcd(j, m) == 1).collect();
    let phi = units.len();
    let e_top = DirichletGroup::new(n).exponent.max(1);
    // Primes q not dividing N: the two smallest, then enough more that their
    // residues generate (Z/N)^*.  A T built from primes in the kernel of an
    // inner twist chi (f^sigma = f (x) chi) cannot separate f from f^sigma,
    // since a_p(f) is then fixed by sigma; generators rule that out.
    // CM forms vanish at inert primes and inner twists fix a_p on a
    // character's kernel, so a small T can give f and f^sigma the same
    // eigenvalue; escalate through more primes with distinct coefficients.
    let gens = hecke_primes(n);
    let mut qs_all = gens.clone();
    for q in (2..).filter(|&q| is_prime(q) && n % q != 0) {
        if qs_all.len() >= 16 {
            break;
        }
        if !qs_all.contains(&q) {
            qs_all.push(q);
        }
    }
    let mut candidates: Vec<Vec<(u64, i64)>> = vec![
        vec![(qs_all[0], 1), (qs_all[1], 1)],
        vec![(qs_all[0], 1), (qs_all[1], 3)],
        (0..gens.len()).map(|i| (qs_all[i], 2 * i as i64 + 1)).collect(),
    ];
    for count in [8, 12, 16] {
        candidates.push((0..count.min(qs_all.len())).map(|i| (qs_all[i], i as i64 + 1)).collect());
    }
    let mut checks = vec![];
    let qs: Vec<u64> = qs_all.clone();
    let lv = levels(n, k, &eps, &units, &qs)?;
    let top = lv.last().unwrap();
    let d = phi * top.dim_new;
    if top.dim_new == 0 {
        return Ok(NewspaceOrbits { n, k, m, dim: 0, orbits: vec![], dims: vec![], ops: vec![], primes_used: 0, status: "proven", checks });
    }
    let mut primes = primes_one_mod(e_top, 1 << 31);
    // Certify dim M^+ at every level with one prime: + and - add up to 2S + E.
    let mut attempts = 0;
    let dims_plus: Vec<usize> = loop {
        attempts += 1;
        if attempts > 8 {
            return Err("could not certify dim M^+ (dimension formula disagrees?)".into());
        }
        let ell = primes.next().ok_or("ran out of primes")?;
        let z = root_of_unity(e_top, ell);
        let mut ok = true;
        let mut dp = vec![];
        for l in &lv {
            let zm = powmod(z, e_top / l.eps.order, ell);
            let a = GeneralSpace::new_mod(l.m, k, &l.eps, 1, ell, zm)?.dimension();
            let b = GeneralSpace::new_mod(l.m, k, &l.eps, -1, ell, zm)?.dimension();
            if a + b != dim_modsym(&l.eps, k) as usize {
                ok = false;
                break;
            }
            dp.push(a);
        }
        if ok {
            checks.push(format!("dim M^+ at levels {:?}: {:?} (certified at ell = {})", lv.iter().map(|l| l.m).collect::<Vec<_>>(), dp, ell));
            break dp;
        }
    };
    let compute = |ell: u64, ops: &[(u64, i64)]| -> Result<Option<Vec<u64>>, String> {
        let z = root_of_unity(e_top, ell);
        let parts = par::map_range(phi, |jdx| new_poly_mod(&lv, k, ops, ell, z, e_top, jdx, units[jdx], &dims_plus));
        let mut h = vec![1u64];
        for p in parts {
            match p? {
                Some(g) => h = pmul(&h, &g, ell),
                None => return Ok(None),
            }
        }
        Ok(Some(h))
    };
    // Pick T: the first candidate with h squarefree mod some good ell.
    let mut chosen = None;
    'outer: for ops in &candidates {
        for _ in 0..4 {
            let ell = primes.next().ok_or("ran out of primes")?;
            if let Some(h) = compute(ell, ops)? {
                if std::env::var("NEWSPACE_DEBUG").is_ok() {
                    eprintln!("N={} k={} ops {:?}: deg h {} deg gcd(h, h') {}", n, k, ops, deg(&h), deg(&pgcd(&h, &deriv(&h, ell), ell)));
                }
                if deg(&pgcd(&h, &deriv(&h, ell), ell)) == 0 {
                    chosen = Some((ops.clone(), ell, h));
                    break 'outer;
                }
                break; // squarefree fails at a good prime: try a more generic T
            }
        }
    }
    let (ops, ell0, h0) = chosen.ok_or("no Hecke operator with a squarefree newspace charpoly")?;
    // CRT until the modulus exceeds twice Deligne's bound on the coefficients.
    let b: BigUint = ops.iter().map(|&(q, r)| {
        let q1 = BigUint::from(q).pow(k as u32 - 1);
        BigUint::from(r.unsigned_abs()) * ((q1 * 4u32).sqrt() + 1u32)
    }).sum();
    let amax = embedding_bounds(d, 0, &BigUint::zero(), &b).into_iter().max().unwrap();
    let need = amax * 2u32;
    let mut residues: Vec<(u64, Vec<Vec<u64>>)> = vec![(ell0, h0.iter().map(|&c| vec![c]).collect())];
    let mut modulus = BigUint::from(ell0);
    let mut rejected = 0;
    while modulus <= need {
        let want = (((need.bits() - modulus.bits()) as f64 / 30.9).ceil() as usize).clamp(1, 16);
        let batch: Vec<u64> = primes.by_ref().take(want).collect();
        let out = par::map_slice(&batch, |&ell| compute(ell, &ops));
        for (&ell, r) in batch.iter().zip(out) {
            match r? {
                Some(h) if deg(&h) == d => {
                    residues.push((ell, h.iter().map(|&c| vec![c]).collect()));
                    modulus *= ell;
                }
                _ => rejected += 1,
            }
        }
        if rejected > 64 {
            return Err("too many bad primes".into());
        }
    }
    let h: Vec<BigInt> = crt(&residues, d, 1).into_iter().map(|c| c[0].clone()).collect();
    let factors = factor_fn(&h);
    let mut orbits: Vec<Vec<BigInt>> = vec![];
    for (f, e) in factors {
        if e != 1 {
            return Err("newspace charpoly is not squarefree over Q".into());
        }
        orbits.push(f);
    }
    orbits.sort_by_key(|f| f.len());
    let dims: Vec<usize> = orbits.iter().map(|f| f.len() - 1).collect();
    let monic = h.last().map_or(false, |c| c.is_one()) && orbits.iter().all(|f| f.last().map_or(false, |c| c.is_one()));
    let total: usize = dims.iter().sum();
    checks.push(format!("T = {:?}; h of degree {} = {} x {} (phi(ord eps) x dim S_k^new); {} primes, {} rejected", ops, d, phi, top.dim_new, residues.len(), rejected));
    let status = if monic && total == d { "proven" } else { "inconsistent" };
    Ok(NewspaceOrbits { n, k, m, dim: d, orbits, dims, ops, primes_used: residues.len(), status, checks })
}
