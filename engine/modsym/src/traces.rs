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
use crate::exact::{factor, is_prime};
use crate::orbits::Factorer;
use crate::general::{heilbronn_for, mul, powmod, primes_one_mod, root_of_unity, Character, GeneralSpace};
pub use crate::newspace::Reject;
use crate::general_exact::{crt, crt_units, invert_mod_c};
use crate::linalg;
use crate::count::{self, Sink};
use crate::newspace::{deg, deriv, eisenstein_exponent, levels, new_poly_mod, pdivrem_c, pgcd, pgcd_c, pmul_c, Level, NewspaceOrbits};
use sagebrush_arith::cost::{Family, Local, Units};
use crate::p1::gcd;
use crate::par;
use sagebrush_bigint::{BigInt, BigUint};
use std::collections::HashMap;

/// a b mod u, padded to deg(u) coefficients.  The kernels here count their
/// units into `cnt` (crate::count).
fn mulmod_poly(a: &[u64], b: &[u64], u: &[u64], p: u64, cnt: &mut Units) -> Vec<u64> {
    let mut r = pdivrem_c(&pmul_c(a, b, p, cnt), u, p, cnt).1;
    r.resize(deg(u).max(1), 0);
    r
}

/// Row vector v -> v T: two ModArith per entry of each row with v_i != 0.
fn vecmat(v: &[u64], t: &[Vec<u64>], p: u64, cnt: &mut Units) -> Vec<u64> {
    let mut out = vec![0u64; v.len()];
    let mut ops = 0u64;
    for (vi, row) in v.iter().zip(t) {
        if *vi != 0 {
            for (o, &x) in out.iter_mut().zip(row) {
                *o = (*o + mul(*vi, x, p)) % p;
            }
            ops += 2 * row.len() as u64;
        }
    }
    count::n(cnt, Family::ModArith, ops);
    out
}

/// Column vector z -> T z: one delayed-reduction multiply-add per entry
/// (MulSchool), one reduction per row.
fn matvec(t: &[Vec<u64>], z: &[u64], p: u64, cnt: &mut Units) -> Vec<u64> {
    count::n(cnt, Family::MulSchool, t.iter().map(|row| row.len().min(z.len()) as u64).sum());
    count::n(cnt, Family::ModArith, t.len() as u64);
    t.iter().map(|row| (row.iter().zip(z).fold(0u128, |acc, (&a, &b)| acc + a as u128 * b as u128) % p as u128) as u64).collect()
}

/// c(T) applied to a row (left = true: v c(T)) or column vector, by Horner.
fn poly_apply(c: &[u64], t: &[Vec<u64>], v: &[u64], left: bool, p: u64, cnt: &mut Units) -> Vec<u64> {
    let mut r = vec![0u64; v.len()];
    for &ci in c.iter().rev() {
        r = if left { vecmat(&r, t, p, cnt) } else { matvec(t, &r, p, cnt) };
        for (x, &y) in r.iter_mut().zip(v) {
            *x = (*x + mul(ci, y, p)) % p;
        }
        count::n(cnt, Family::ModArith, 2 * v.len() as u64);
    }
    r
}

/// Power sums s_0..s_(w-1) of the roots of a monic u of degree w (Newton).
fn power_sums(u: &[u64], p: u64, cnt: &mut Units) -> Vec<u64> {
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
        count::n(cnt, Family::ModArith, 3 + 2 * (i as u64 - 1));
    }
    s
}

struct OrbitSetup {
    u: Vec<u64>,
    q: Vec<u64>,
    /// The functional: (generator coordinate t, coefficient) pairs, one
    /// pair unless no single coordinate worked.
    func: Vec<(usize, u64)>,
    psi: Vec<Vec<u64>>,
    s: Vec<u64>,
    /// No single coordinate gave a functional: a combination did.
    combined: bool,
    /// The candidates were drawn by the seeded generator (w (d - 1) >= ell).
    seeded: bool,
}

type Setups = (GeneralSpace, Vec<OrbitSetup>, u64);

/// The portable seeded generator of the setup's candidates when the
/// deterministic ones are too few (xorshift64, seeded by ell: the same
/// sequence on every run and target).
struct Seeded(u64);

impl Seeded {
    fn new(ell: u64) -> Self {
        Seeded(0x9e37_79b9_7f4a_7c15 ^ ell)
    }

    fn vector(&mut self, d: usize, ell: u64) -> Vec<u64> {
        (0..d).map(|_| {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % ell
        }).collect()
    }
}

/// One embedding's setup mod ell: the space, its orbits' setups and the
/// character value zm, or why ell gives none.
#[allow(clippy::too_many_arguments)]
fn setups_mod<S: Sink>(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, lv: &[Level], polys: &[Vec<u64>], rel_deg: &[usize], ell: u64, z_e: u64, e_top: u64, jdx: usize, j: u64, sink: &mut S) -> Result<Result<Setups, Reject>, String> {
    let mut cnt = Units::default();
    let r = setups_mod_in(n, k, eps, res, lv, polys, rel_deg, ell, z_e, e_top, jdx, j, &mut cnt, sink);
    sink.put(cnt);
    r
}

/// setups_mod's body: the kernels count into `cnt`, handed to `sink` at
/// each Stop check.  (The space mod ell, its Hecke matrix and charpoly and
/// new_poly_mod are not metered yet: the modular symbols construction's
/// own metering is a follow-up.)
#[allow(clippy::too_many_arguments)]
fn setups_mod_in<S: Sink>(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, lv: &[Level], polys: &[Vec<u64>], rel_deg: &[usize], ell: u64, z_e: u64, e_top: u64, jdx: usize, j: u64, cnt: &mut Units, sink: &mut S) -> Result<Result<Setups, Reject>, String> {
    let ops = &res.ops;
    let zm = powmod(z_e, e_top / eps.order * j, ell);
    // The new part of the charpoly for this embedding: an orbit's piece is
    // gcd(u, g_new), not gcd(u, charpoly), since a conjugate's eigenvalue
    // may coincide with an old or Eisenstein one here.
    let g_new = match new_poly_mod(lv, k, ops, ell, z_e, e_top, jdx, j, &res.dims_plus)? {
        Ok((g, true)) => g,
        Ok((_, false)) => return Ok(Err(Reject::Degree)),
        Err(r) => return Ok(Err(r)),
    };
    let sp = GeneralSpace::new_mod(n, k, eps, 1, ell, zm)?;
    let d = sp.dimension();
    let tm = sp.hecke_combo_matrix(ops)?;
    let f = linalg::charpoly(tm.clone(), ell);
    let mut setups = vec![];
    for (u, &w) in polys.iter().zip(rel_deg) {
        let uj = pgcd_c(u, &g_new, ell, cnt);
        let debug = std::env::var("TRACES_DEBUG").is_ok();
        if deg(&uj) != w {
            if debug {
                eprintln!("N={} ell={}: deg u_j {} != {}", n, ell, deg(&uj), w);
            }
            return Ok(Err(Reject::Separation));
        }
        let (cof, r) = pdivrem_c(&f, &uj, ell, cnt);
        // (u_j squarefree and prime to its cofactor: then T on W = ker
        // u_j(T) has w distinct eigenvalues and u_j as its minimal
        // polynomial, so a cyclic vector exists; without the first, T on W
        // can be scalar, and no candidate is cyclic)
        count::n(cnt, Family::ModArith, uj.len() as u64);
        if deg(&pgcd_c(&uj, &deriv(&uj, ell), ell, cnt)) != 0 {
            if debug {
                eprintln!("N={} ell={}: u_j not squarefree", n, ell);
            }
            return Ok(Err(Reject::Separation));
        }
        if !(r.len() == 1 && r[0] == 0) || deg(&pgcd_c(&uj, &cof, ell, cnt)) != 0 {
            if debug {
                eprintln!("N={} ell={}: u_j not separated (deg gcd {})", n, ell, deg(&pgcd(&uj, &cof, ell)));
            }
            return Ok(Err(Reject::Separation));
        }
        let mut q = pdivrem_c(&cof, &uj, ell, cnt).1;
        q.resize(w, 0);
        // With z_b = T^b cof(T) c (columns spanning the functionals that
        // vanish off W) and the Krylov rows e_t cof(T) T^a, the Gram matrix
        // is Hankel: G_t[a][b] = (T^(a+b) cof(T)^2 c)_t.  So a handful of
        // vectors give G_t for every t, and the first t with G_t invertible
        // is used (the Krylov rows themselves are never needed).
        // The cyclic vector and the functional, deterministically.  The
        // candidates are c_x = sum_i x^i e_i for x = 0, 1, 2, ...  The
        // piece's eigenvalues lambda_i are distinct mod ell (u_j squarefree)
        // and cof(lambda_i) != 0 (both checked above, Reject::Separation), so
        // cof(T) c is
        // cyclic on the piece unless mu_i(c) = 0 for a left eigenvector mu_i;
        // mu_i(c_x) is a nonzero polynomial in x of degree < d, so at most
        // w (d - 1) values of x fail.  The functional: one generator's
        // coordinate e_t if one works (its Hecke image is the only one the
        // traces then need), else phi_y = sum_t y^t e_t for y = 0, 1, ...:
        // the Gram matrix is invertible iff phi_y(cof(T) v_i) = cof(lambda_i)
        // phi_y(v_i) != 0 for each eigenvector v_i, again at most w (d - 1)
        // failures.  When w (d - 1) >= ell there may be too few candidates
        // below ell, and they are drawn by the seeded generator instead: each
        // mu_i(c) is linear in c, so a draw fails with probability at most
        // w / ell, and the search has no bound but Stop.  Either way the
        // prime is never set aside here, and the same inputs take the same
        // steps on every run and target.
        let tries = (w as u64).saturating_mul(d.saturating_sub(1) as u64).saturating_add(1);
        let seeded = tries > ell;
        let mut rng = Seeded::new(ell);
        let mut found: Option<OrbitSetup> = None;
        let mut x: u64 = 0;
        while found.is_none() {
            sink.put(std::mem::take(cnt));
            sagebrush_interrupt::check();
            debug_assert!(seeded || x < tries, "no cyclic vector within w (d - 1) + 1 candidates");
            if !seeded && x >= tries {
                return Err("internal error: no cyclic vector within the proven w (d - 1) + 1 candidates".into());
            }
            let c = if seeded { rng.vector(d, ell) } else { powers_mod(x, d, ell) };
            count::n(cnt, Family::ModArith, d as u64);
            x += 1;
            let mut zs = vec![poly_apply(&cof, &tm, &c, false, ell, cnt)];
            for i in 1..w {
                let next = matvec(&tm, &zs[i - 1], ell, cnt);
                zs.push(next);
            }
            if rank_mod(&zs, ell, cnt) < w {
                continue;
            }
            let mut vs = vec![poly_apply(&cof, &tm, &zs[0], false, ell, cnt)];
            for i in 1..2 * w - 1 {
                let next = matvec(&tm, &vs[i - 1], ell, cnt);
                vs.push(next);
            }
            // the Gram matrix of a functional sum_t a_t e_t: Hankel,
            // G[a][b] = sum_t a_t (T^(a+b) cof(T)^2 c)_t
            let gram = |func: &[(usize, u64)], cnt: &mut Units| -> Vec<Vec<u64>> {
                count::n(cnt, Family::ModArith, 2 * (w * w * func.len()) as u64);
                (0..w).map(|a| (0..w).map(|bb| func.iter().fold(0u64, |acc, &(t, at)| (acc + mul(at, vs[a + bb][t], ell)) % ell)).collect()).collect()
            };
            let setup = |func: Vec<(usize, u64)>, combined: bool, cnt: &mut Units| -> Result<Option<OrbitSetup>, String> {
                let Some(ginv) = invert_mod_c(&gram(&func, cnt), ell, cnt) else {
                    return Ok(None);
                };
                // Psi = Z G^-1 (d x w): column i is the functional for Krylov coordinate i.
                let psi: Vec<Vec<u64>> = (0..w).map(|i| {
                    let col: Vec<u64> = (0..d).map(|r| (0..w).fold(0u64, |acc, bb| (acc + mul(zs[bb][r], ginv[bb][i], ell)) % ell)).collect();
                    sp.extend_c(&col, cnt)
                }).collect();
                count::n(cnt, Family::ModArith, 2 * (w * d * w) as u64);
                // Self-check: the projection of the functional's vector has
                // coordinates cof^-1 mod u_j.
                let c1: Vec<u64> = (0..w).map(|i| func.iter().fold(0u64, |acc, &(t, at)| (acc + mul(at, psi[i][sp.basis_generator(t) as usize], ell)) % ell)).collect();
                count::n(cnt, Family::ModArith, 2 * (w * func.len()) as u64);
                let one = mulmod_poly(&c1, &q, &uj, ell, cnt);
                if one[0] != 1 % ell || one[1..].iter().any(|&x| x != 0) {
                    return Err("trace setup self-check failed".into());
                }
                Ok(Some(OrbitSetup { s: power_sums(&uj, ell, cnt), u: uj.clone(), q: q.clone(), combined, seeded, func, psi }))
            };
            for t in (0..d).filter(|_| !tests::single_coordinates_skipped()) {
                if let Some(st) = setup(vec![(t, 1)], false, cnt)? {
                    found = Some(st);
                    break;
                }
            }
            // (no single generator's coordinate works: a combination, which
            // the statistics count)
            let mut y: u64 = 0;
            while found.is_none() {
                sink.put(std::mem::take(cnt));
                sagebrush_interrupt::check();
                debug_assert!(seeded || y < tries, "no functional within w (d - 1) + 1 candidates");
                if !seeded && y >= tries {
                    return Err("internal error: no functional within the proven w (d - 1) + 1 candidates".into());
                }
                let a = if seeded { rng.vector(d, ell) } else { powers_mod(y, d, ell) };
                count::n(cnt, Family::ModArith, d as u64);
                y += 1;
                found = setup(a.into_iter().enumerate().filter(|&(_, a)| a != 0).collect(), true, cnt)?;
            }
        }
        setups.extend(found);
    }
    Ok(Ok((sp, setups, zm)))
}

/// [1, x, x^2, ..., x^(d-1)] mod ell.
fn powers_mod(x: u64, d: usize, ell: u64) -> Vec<u64> {
    let mut out = Vec::with_capacity(d);
    let mut v = 1 % ell;
    for _ in 0..d {
        out.push(v);
        v = mul(v, x % ell, ell);
    }
    out
}

/// P_p mod each orbit's u for the primes given (in parallel: each needs
/// the Heilbronn images of the few Manin symbols x_t only).  Each prime's
/// job counts its units (the Heilbronn matrices written, Move; the images;
/// per functional term a delayed-reduction multiply-add, MulSchool, and
/// three ModArith per coordinate; the product mod u) and returns them: they
/// go to `sink` at the join, so a Stop inside the batch charges none of it.
fn prime_polys<S: Sink>(n: u64, sp: &GeneralSpace, setups: &[OrbitSetup], primes: &[u64], ell: u64, sink: &mut S) -> Vec<HashMap<u64, Vec<u64>>> {
    let per_prime = par::map_slice(primes, |&p| {
        // (each prime's Heilbronn matrices and images take O(p log p): a
        // coarse Stop check per prime, not one for all of them)
        sagebrush_interrupt::check_coarse();
        let mut cnt = Units::default();
        // generated per prime, not kept: Cremona's are cheap to make, and
        // all of them for p <= 1000 would take tens of megabytes
        let hs = heilbronn_for(p, n);
        count::n(&mut cnt, Family::Move, 4 * hs.len() as u64);
        let mut images: HashMap<usize, Vec<(u32, u64)>> = HashMap::new();
        let polys = setups.iter().map(|st| {
            let mut c = vec![0u64; st.psi.len()];
            for &(t, at) in &st.func {
                let img = images.entry(t).or_insert_with(|| sp.hecke_image_c(&hs, sp.basis_generator(t), &mut cnt));
                for (ci, ps) in c.iter_mut().zip(&st.psi) {
                    let v = (img.iter().fold(0u128, |acc, &(g, v)| acc + v as u128 * ps[g as usize] as u128) % ell as u128) as u64;
                    *ci = (*ci + mul(at, v, ell)) % ell;
                }
                count::n(&mut cnt, Family::MulSchool, (img.len() * st.psi.len()) as u64);
                count::n(&mut cnt, Family::ModArith, 3 * st.psi.len() as u64);
            }
            mulmod_poly(&c, &st.q, &st.u, ell, &mut cnt)
        }).collect::<Vec<Vec<u64>>>();
        (polys, cnt)
    });
    let mut pp: Vec<HashMap<u64, Vec<u64>>> = vec![HashMap::new(); setups.len()];
    let mut total = Units::default();
    for (&p, (polys, cnt)) in primes.iter().zip(per_prime) {
        total.add(&cnt);
        for (oi, poly) in polys.into_iter().enumerate() {
            pp[oi].insert(p, poly);
        }
    }
    sink.put(total);
    pp
}

/// P_1..P_bound mod st.u from the prime ones (index 0 unused).
#[allow(clippy::too_many_arguments)]
fn all_pn<S: Sink>(st: &OrbitSetup, pp: &HashMap<u64, Vec<u64>>, bound: usize, n: u64, k: usize, eps: &Character, zm: u64, ell: u64, sink: &mut S) -> Vec<Vec<u64>> {
    let w = deg(&st.u);
    let mut one = vec![0u64; w.max(1)];
    one[0] = 1;
    let mut pn: Vec<Vec<u64>> = vec![vec![], one];
    let mut cnt = Units::default();
    for nn in 2..=bound as u64 {
        sink.put(std::mem::take(&mut cnt));
        sagebrush_interrupt::check();
        let p = (2..=nn).find(|q| nn % q == 0).unwrap();
        let mut m = nn;
        while m % p == 0 {
            m /= p;
        }
        let v = if m == 1 {
            let prev = nn / p;
            let tp = &pp[&p];
            let mut v = mulmod_poly(tp, &pn[prev as usize], &st.u, ell, &mut cnt);
            if prev % p == 0 && n % p != 0 {
                let e = eps.exponent(p as i64).unwrap() as u64;
                let c = mul(powmod(zm, e, ell), powmod(p, k as u64 - 1, ell), ell);
                count::pow(&mut cnt, e);
                count::pow(&mut cnt, k as u64 - 1);
                count::n(&mut cnt, Family::ModArith, 1 + 2 * v.len() as u64);
                for (x, &y) in v.iter_mut().zip(&pn[(prev / p) as usize]) {
                    *x = (*x + ell - mul(c, y, ell)) % ell;
                }
            }
            v
        } else {
            mulmod_poly(&pn[(nn / m) as usize], &pn[m as usize], &st.u, ell, &mut cnt)
        };
        pn.push(v);
    }
    sink.put(cnt);
    pn
}

/// The trace of c(x) mod u, from u's power sums.
fn poly_trace(c: &[u64], s: &[u64], ell: u64, cnt: &mut Units) -> u64 {
    count::n(cnt, Family::ModArith, 2 * c.len().min(s.len()) as u64);
    c.iter().zip(s).fold(0u64, |acc, (&a, &b)| (acc + mul(a, b, ell)) % ell)
}

/// Traces of T_1..T_B on each orbit's piece for one embedding, mod ell
/// (None: ell is bad for this embedding).
#[allow(clippy::too_many_arguments)]
fn traces_mod(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, lv: &[Level], polys: &[Vec<u64>], rel_deg: &[usize], ell: u64, z_e: u64, e_top: u64, jdx: usize, j: u64, bound: usize, sink: &mut Units) -> Result<Option<Vec<Vec<u64>>>, String> {
    let Ok((sp, setups, zm)) = setups_mod(n, k, eps, res, lv, polys, rel_deg, ell, z_e, e_top, jdx, j, sink)? else {
        return Ok(None);
    };
    // P_p for primes p <= bound, then all P_n.
    let primes: Vec<u64> = (2..=bound as u64).filter(|&p| is_prime(p)).collect();
    let pp = prime_polys(n, &sp, &setups, &primes, ell, sink);
    Ok(Some(setups.iter().zip(&pp).map(|(st, pp)| {
        let pn = all_pn(st, pp, bound, n, k, eps, zm, ell, sink);
        let mut cnt = Units::default();
        let t = (1..=bound).map(|nn| poly_trace(&pn[nn], &st.s, ell, &mut cnt)).collect();
        sink.put(cnt);
        t
    }).collect()))
}

/// Rank of the vectors mod ell (row echelon, in place on a copy).
fn rank_mod(rows: &[Vec<u64>], ell: u64, cnt: &mut Units) -> usize {
    let mut m: Vec<Vec<u64>> = rows.to_vec();
    let mut r = 0;
    let cols = m.first().map_or(0, |x| x.len());
    count::n(cnt, Family::Move, (m.len() * cols) as u64);
    let mut ops = 0u64;
    for c in 0..cols {
        let Some(pr) = (r..m.len()).find(|&i| m[i][c] != 0) else {
            continue;
        };
        m.swap(r, pr);
        let inv = powmod(m[r][c], ell - 2, ell);
        count::pow(cnt, ell - 2);
        for i in r + 1..m.len() {
            let f = mul(m[i][c], inv, ell);
            ops += 1;
            if f != 0 {
                for j in c..cols {
                    m[i][j] = (m[i][j] + ell - mul(f, m[r][j], ell)) % ell;
                }
                ops += 2 * (cols - c) as u64;
            }
        }
        r += 1;
    }
    count::n(cnt, Family::ModArith, ops);
    r
}

/// One orbit's twisted traces mod ell: the selected indices m and, for
/// n = 1..=len, rows R[m](n) = Tr(a_m a_n) and S[m](n) = Tr(a_m a_q a_n).
type TwistedMod = (Vec<usize>, Vec<Vec<u64>>, Vec<Vec<u64>>);

/// One prime's twisted traces: each orbit's, and the counts of setups that
/// took a combination functional and the seeded candidates.
type Twisted = (Vec<TwistedMod>, u64, u64);

/// For the trivial character mod ell (or why ell gives none): each orbit's
/// twisted traces, with the indices m < len + 1 chosen greedily (the first
/// w with P_m independent mod u, when `sel` is None) or given.  The a_m for
/// m up to the Sturm bound span the orbit's field over Q (the Hecke
/// algebra is generated by T_1..T_B, B the Sturm bound), and independence
/// mod ell implies independence over Q.
#[allow(clippy::too_many_arguments)]
fn twisted_mod(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, lv: &[Level], polys: &[Vec<u64>], rel_deg: &[usize], ell: u64, z_e: u64, e_top: u64, len: usize, q: u64, sel: Option<&[Vec<usize>]>, sink: &mut Local) -> Result<Result<Twisted, Reject>, String> {
    let (sp, setups, zm) = match setups_mod(n, k, eps, res, lv, polys, rel_deg, ell, z_e, e_top, 0, 0, sink)? {
        Ok(x) => x,
        Err(b) => return Ok(Err(b)),
    };
    let combined = setups.iter().filter(|st| st.combined).count() as u64;
    let seeded = setups.iter().filter(|st| st.seeded).count() as u64;
    let mut primes: Vec<u64> = (2..=len as u64).filter(|&p| is_prime(p)).collect();
    if !primes.contains(&q) {
        primes.push(q);
    }
    let pp = prime_polys(n, &sp, &setups, &primes, ell, sink);
    let mut out = vec![];
    let mut cnt = Units::default();
    for (oi, (st, pp)) in setups.iter().zip(&pp).enumerate() {
        let w = deg(&st.u);
        let pn = all_pn(st, pp, len, n, k, eps, zm, ell, sink);
        let chosen: Vec<usize> = match sel {
            Some(sel) => sel[oi].clone(),
            None => {
                let mut chosen: Vec<usize> = vec![];
                let mut vecs: Vec<Vec<u64>> = vec![];
                for m in 1..=len {
                    if chosen.len() == w {
                        break;
                    }
                    sink.put(std::mem::take(&mut cnt));
                    sagebrush_interrupt::check();
                    vecs.push(pn[m].clone());
                    count::n(&mut cnt, Family::Move, pn[m].len() as u64);
                    if rank_mod(&vecs, ell, &mut cnt) == vecs.len() {
                        chosen.push(m);
                    } else {
                        vecs.pop();
                    }
                }
                if chosen.len() < w {
                    // (dependent mod ell only: over Q the a_m, m <= B, span)
                    sink.put(cnt);
                    return Ok(Err(Reject::Minor));
                }
                chosen
            }
        };
        let (mut r, mut t) = (vec![], vec![]);
        for &m in &chosen {
            sink.put(std::mem::take(&mut cnt));
            sagebrush_interrupt::check();
            let mq = mulmod_poly(&pn[m], &pp[&q], &st.u, ell, &mut cnt);
            r.push((1..=len).map(|nn| { let x = mulmod_poly(&pn[m], &pn[nn], &st.u, ell, &mut cnt); poly_trace(&x, &st.s, ell, &mut cnt) }).collect());
            t.push((1..=len).map(|nn| { let x = mulmod_poly(&mq, &pn[nn], &st.u, ell, &mut cnt); poly_trace(&x, &st.s, ell, &mut cnt) }).collect());
        }
        out.push((chosen, r, t));
    }
    sink.put(cnt);
    Ok(Ok((out, combined, seeded)))
}

/// floor(sqrt(n^(k-1))) + 1, times sigma0(n): above |a_n| for a newform of
/// weight k (Deligne).
pub fn coefficient_bound(n: u64, k: usize) -> BigUint {
    let s0: u64 = factor(n).iter().map(|&(_, e)| u64::from(e) + 1).product();
    (BigUint::from(n).pow(k as u32 - 1).sqrt() + 1u32) * s0
}

/// The bound on |twisted traces| for orbits of dimension at most `dim`:
/// 2 dim A_q A^2, A at least coefficient_bound(n, k) for every n <= len
/// (|Tr(a_m a_q a_n)| <= dim A_m A_q A_n, and so for R without A_q, as
/// A_q >= 1),
/// and the number of CRT primes it takes (each prime is above 2^30).
pub fn hecke_traces_primes(k: usize, dim: usize, len: usize, q: u64) -> (BigUint, u64) {
    // A bounds every coefficient_bound(n, k), n <= len: floor(sqrt(len^(k-1)))
    // + 1 times the largest sigma0(n), n <= len, from a sieve polled for
    // Stop (each n's own bound, by trial, took O(len^2) with no check)
    let mut sigma0 = vec![0u32; len + 1];
    for dd in 1..=len {
        if dd & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        for m in (dd..=len).step_by(dd) {
            sigma0[m] += 1;
        }
    }
    let s0 = u64::from(sigma0.iter().copied().max().unwrap_or(0).max(1));
    let a = (BigUint::from(len.max(1) as u64).pow(k as u32 - 1).sqrt() + 1u32) * s0;
    let need = &a * &a * coefficient_bound(q, k) * (dim as u64) * 2u32;
    let c = need.bits().div_ceil(30).max(1);
    (need, c)
}

/// The first prime the twisted traces use: 2^30.
pub const HECKE_PRIMES_FROM: u64 = 1 << 30;
/// The end of the twisted traces' primes, a limit: the mod-ell kernels
/// multiply in u64, so ell < 2^32.  The primes = 1 mod e in [2^30, 2^32),
/// e = eisenstein_exponent(n) (phi(e) < sqrt(n), e = 1 for squarefree n),
/// number S(e) = 148,880,193 for e <= 2, and 74,439,285, 37,219,306,
/// 18,610,149, 24,812,622 and 4,550 for e = 4, 12, 16, 18 and 65536 (a
/// sieve; examples/hecke_prime_supply.rs).
/// Two refusals, both naming this limit:
/// - up front, when the CRT count c exceeds S(e): only at weights near
///   10^8, where L admits at least 2.0 PiB (the least over n <= 200, at n =
///   1, k = 116,874,434 and q near 2^30; the example);
/// - in the loop, once S(e) - c primes are set aside (Reject, counted per
///   reason in the statistics and the message), each dividing a fixed
///   nonzero integer of the space; bounds on those integers would make this
///   a proof (a follow-up).
pub const HECKE_PRIMES_BELOW: u64 = 1 << 32;

/// The primes ell = 1 mod `order` from HECKE_PRIMES_FROM up, ascending,
/// below HECKE_PRIMES_BELOW.
pub fn hecke_primes(order: u64) -> impl Iterator<Item = u64> {
    let order = order.max(1);
    let from = HECKE_PRIMES_FROM;
    // the least candidate = 1 mod order at least `from`
    let start = from + (order + 1 - from % order) % order;
    (0..).map(move |t: u64| start + t * order).take_while(|&l| l < HECKE_PRIMES_BELOW).filter(|&l| is_prime(l))
}

/// What the twisted traces' prime loop did: the modulus e of its primes
/// (the largest over the levels), the primes used, those set
/// aside by reason (Reject::ALL order), and the orbit setups (one per
/// orbit and prime used) that needed a combination functional or the
/// seeded candidates.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HeckeTraceStats {
    pub e: u64,
    pub primes: u64,
    pub rejected: [u64; 4],
    pub combined: u64,
    pub seeded: u64,
}

impl HeckeTraceStats {
    pub fn rejected_total(&self) -> u64 {
        self.rejected.iter().sum()
    }

    /// The primes set aside by reason, "dimension 0, degree 1, ...".
    pub fn rejected_summary(&self) -> String {
        Reject::ALL.iter().zip(self.rejected).map(|(r, c)| format!("{} {}", r.name(), c)).collect::<Vec<_>>().join(", ")
    }

    /// Accumulate another level's loop.
    pub fn add(&mut self, o: &HeckeTraceStats) {
        self.e = self.e.max(o.e);
        self.primes += o.primes;
        for (a, b) in self.rejected.iter_mut().zip(o.rejected) {
            *a += b;
        }
        self.combined += o.combined;
        self.seeded += o.seeded;
    }
}

/// One orbit's twisted traces: the chosen indices m (a basis over Q of the
/// orbit's span is Tr(a_m f), m in `sel`), and for n = 1..=len the rows
/// r[i][n-1] = Tr(a_m a_n) and s[i][n-1] = Tr(a_m a_q a_n), m = sel[i].
pub struct OrbitHecke {
    pub sel: Vec<usize>,
    pub r: Vec<Vec<BigInt>>,
    pub s: Vec<Vec<BigInt>>,
}

/// The twisted traces of every orbit of `res` (trivial character, same
/// order as res.orbits), CRT'd exactly (hecke_traces_primes).  T_q acts on
/// the basis Tr(a_m f) by the rows s, so its matrix needs coefficients only
/// to the Sturm bound, whatever q.  The primes come from hecke_primes,
/// ascending: a prime set aside (Reject) is counted in the statistics and
/// the next one drawn, with a Stop check per prime and no other limit.
pub fn orbit_hecke_traces(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, len: usize, q: u64) -> Result<(Vec<OrbitHecke>, HeckeTraceStats), String> {
    orbit_hecke_traces_from(n, k, eps, res, len, q, hecke_primes(eisenstein_exponent(n)))
}

/// orbit_hecke_traces with the primes given (any = 1 mod
/// eisenstein_exponent(n), below 2^32): the tests' entry point for small primes, where
/// each Reject can fire.
#[allow(clippy::too_many_arguments)]
pub(crate) fn orbit_hecke_traces_from(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, len: usize, q: u64, primes: impl Iterator<Item = u64>) -> Result<(Vec<OrbitHecke>, HeckeTraceStats), String> {
    if len as u64 >= crate::linalg::MAX_HECKE_PRIME || q >= crate::linalg::MAX_HECKE_PRIME {
        return Err(format!("length {} and prime {} must be below 2^30", len, q));
    }
    if !is_prime(q) {
        return Err(format!("{} is not prime", q));
    }
    if eps.order != 1 {
        return Err("twisted traces: trivial character only".into());
    }
    let mut stats = HeckeTraceStats::default();
    if res.orbits.is_empty() || len == 0 {
        return Ok((res.orbits.iter().map(|_| OrbitHecke { sel: vec![], r: vec![], s: vec![] }).collect(), stats));
    }
    let dim = *res.dims.iter().max().unwrap();
    let (need, count) = hecke_traces_primes(k, dim, len, q);
    let eps = eps.minimal();
    let rel_deg: Vec<usize> = res.dims.clone();
    let qs: Vec<u64> = res.ops.iter().map(|o| o.0).collect();
    let lv = levels(n, k, &eps, &[0], &qs)?;
    // The roots of unity this route needs: only the Eisenstein characters'
    // (the character is trivial), of order dividing e_top = 1 for squarefree
    // n, and phi(e_top) < sqrt(n) always (eisenstein_exponent).
    let e_top = eisenstein_exponent(n);
    stats.e = e_top;
    // Up front, before any setup: the source holds the CRT count (each
    // prime is above 2^30, so `count` of them exceed `need`).  The primes
    // drawn are kept, as the loop's first.
    let mut primes = primes;
    let head: Vec<u64> = primes.by_ref().take(usize::try_from(count).unwrap_or(usize::MAX)).collect();
    if (head.len() as u64) < count {
        return Err(format!("twisted traces: the limit of primes = 1 mod {} below 2^32 (the u64 kernels): the CRT needs {}, there are {}", e_top, count, head.len()));
    }
    let mut primes = head.into_iter().chain(primes);
    let mut residues: Vec<(u64, Vec<Vec<u64>>)> = vec![];
    let mut modulus = BigUint::from(1u32);
    let mut drawn: u64 = 0;
    // (the kernels' units, flushed at their Stop checks: count.rs)
    let mut local = Local::new();
    let mut sel: Option<Vec<Vec<usize>>> = None;
    let t0 = crate::now();
    while modulus <= need {
        sagebrush_interrupt::check_coarse();
        let Some(ell) = primes.next() else {
            return Err(format!("twisted traces: the limit of primes = 1 mod {} below 2^32 (the u64 kernels): ran out after {} drawn ({} set aside: {})", e_top, drawn, stats.rejected_total(), stats.rejected_summary()));
        };
        drawn += 1;
        debug_assert!(ell % e_top == 1 % e_top && ell < HECKE_PRIMES_BELOW);
        let polys: Vec<Vec<u64>> = res.orbits.iter().map(|u| u.iter().map(|c| {
            let r = c % BigInt::from(ell);
            let r = if r < BigInt::from(0) { r + BigInt::from(ell) } else { r };
            r.try_into().unwrap()
        }).collect()).collect();
        let z = root_of_unity(e_top, ell);
        match twisted_mod(n, k, &eps, res, &lv, &polys, &rel_deg, ell, z, e_top, len, q, sel.as_deref(), &mut local)? {
            Ok((parts, combined, seeded)) => {
                if sel.is_none() {
                    sel = Some(parts.iter().map(|p| p.0.clone()).collect());
                }
                residues.push((ell, parts.into_iter().flat_map(|(_, r, s)| r.into_iter().chain(s).flatten()).map(|x| vec![x]).collect()));
                modulus *= ell;
                stats.primes += 1;
                stats.combined += combined;
                stats.seeded += seeded;
            }
            Err(r) => {
                stats.rejected[Reject::ALL.iter().position(|&x| x == r).unwrap()] += 1;
            }
        }
    }
    if std::env::var("SAGEBRUSH_TIMING").is_ok() {
        eprintln!(r#"{{"n":{},"k":{},"len":{},"q":{},"twisted":{:.4},"trace_primes":{}}}"#, n, k, len, q, crate::elapsed_ms(t0, crate::now()) / 1e3, residues.len());
    }
    let sel = sel.ok_or("internal error: no prime selected the twisted basis")?;
    let total: usize = rel_deg.iter().map(|&w| 2 * w * len).sum();
    // (a Stop check before the CRT, which has none of its own: a Stop here
    // charges everything but the CRT, whose units are added once it is done)
    local.flush();
    sagebrush_interrupt::check_coarse();
    let ls: Vec<u64> = residues.iter().map(|r| r.0).collect();
    let flat: Vec<BigInt> = crt(&residues, total - 1, 1).into_iter().map(|c| c[0].clone()).collect();
    local.put(crt_units(&ls, total));
    let mut out = vec![];
    let mut at = 0;
    for (w, sel) in rel_deg.iter().zip(sel) {
        let rows: Vec<Vec<BigInt>> = flat[at..at + 2 * w * len].chunks(len).map(|c| c.to_vec()).collect();
        at += 2 * w * len;
        let (r, s) = rows.split_at(*w);
        out.push(OrbitHecke { sel, r: r.to_vec(), s: s.to_vec() });
    }
    Ok((out, stats))
}

/// The orbits of `res` in LMFDB order (dimension, then trace form) with
/// their traces for n <= bound and charpolys.  Ties in the first `bound`
/// traces are broken by computing more traces: lexicographic order is
/// decided by the first difference, so labels do not depend on `bound`.
/// Distinct orbits have distinct trace forms, which differ below the
/// Sturm bound for Gamma1(N).
pub fn labelled_orbits(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, bound: usize) -> Result<Vec<(usize, Vec<BigInt>, Vec<BigInt>)>, String> {
    let index = factor(n).iter().fold(n as f64 * n as f64, |acc, &(p, _)| acc * (1.0 - 1.0 / (p as f64 * p as f64)));
    let sturm = (k as f64 * index / 12.0).ceil() as usize + 1;
    let mut b = bound;
    loop {
        let tr = orbit_traces(n, k, eps, res, b)?;
        let mut orbits: Vec<(usize, Vec<BigInt>, Vec<BigInt>)> = res.dims.iter().cloned().zip(tr).zip(res.orbits.iter().cloned()).map(|((d, t), u)| (d, t, u)).collect();
        orbits.sort();
        if orbits.windows(2).all(|w| (w[0].0, &w[0].1) != (w[1].0, &w[1].1)) {
            for o in &mut orbits {
                o.1.truncate(bound);
            }
            return Ok(orbits);
        }
        if b > sturm {
            return Err(format!("N = {}: two orbits have the same traces up to the Sturm bound {}", n, sturm));
        }
        b = (2 * b).min(sturm + 1).max(b + 1);
    }
}

/// 2 max over n <= bound of (floor(sqrt(n^(k-1))) + 1) sigma0(n) dim: twice
/// a bound on |tr a_n| for an orbit of dimension at most dim (|tr a_n| <=
/// dim sigma0(n) n^((k-1)/2)), the modulus the traces' CRT must exceed.
/// The divisor counts come from a sieve, O(bound log bound) and polled for
/// Stop: counting each n's divisors by trial took O(bound^2) with no check,
/// seconds at the bounds hecke_matrix(p) asks for.
pub fn trace_coefficient_bound(k: usize, dim: usize, bound: usize) -> BigUint {
    let mut sigma0 = vec![0u32; bound + 1];
    for dd in 1..=bound {
        if dd & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        for m in (dd..=bound).step_by(dd) {
            sigma0[m] += 1;
        }
    }
    let mut need = BigUint::from(0u32);
    for nn in 1..=bound as u64 {
        if nn & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        let s0 = u64::from(sigma0[nn as usize]);
        let b = (BigUint::from(nn).pow(k as u32 - 1)).sqrt() + 1u32;
        let x = b * s0 * (dim as u64) * 2u32;
        if x > need {
            need = x;
        }
    }
    need
}

/// tr a_n for n = 1..=bound for each orbit of `res` (same order).
pub fn orbit_traces(n: u64, k: usize, eps: &Character, res: &NewspaceOrbits, bound: usize) -> Result<Vec<Vec<BigInt>>, String> {
    if bound as u64 >= crate::linalg::MAX_HECKE_PRIME {
        return Err(format!("trace bound {} must be below 2^30", bound));
    }
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
    let need = trace_coefficient_bound(k, *res.dims.iter().max().unwrap(), bound);
    let mut primes = primes_one_mod(e_top, 1 << 31);
    // (the kernels' units: each embedding's job returns its own, added here
    // at the join, count.rs)
    let mut local = Local::new();
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
        let parts = par::map_slice(&jobs, |&(jdx, j)| {
            let mut cnt = Units::default();
            (traces_mod(n, k, &eps, res, &lv, &polys, &rel_deg, ell, z, e_top, jdx, j, bound, &mut cnt), cnt)
        });
        let mut sum = vec![vec![0u64; bound]; res.orbits.len()];
        let mut ok = true;
        for (part, cnt) in parts {
            local.put(cnt);
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
                return Err("too many bad primes for traces (the limit of 16)".into());
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
    let ls: Vec<u64> = residues.iter().map(|r| r.0).collect();
    let flat: Vec<BigInt> = crt(&residues, total - 1, 1).into_iter().map(|c| c[0].clone()).collect();
    local.put(crt_units(&ls, total));
    Ok(flat.chunks(bound).map(|c| c.to_vec()).collect())
}

/// For the Stop-prefix pins (tests/hecke_stop.rs, a binary of its own: the
/// Stop hooks are global): one level's setup at the source's first prime,
/// and its kernels run charging the thread's tally (a `Local`) or counting
/// into `Units`.
#[doc(hidden)]
pub mod pins {
    use super::*;

    pub struct Fixture {
        n: u64,
        k: usize,
        eps: Character,
        ell: u64,
        zm: u64,
        sp: GeneralSpace,
        setups: Vec<OrbitSetup>,
        pp: Vec<HashMap<u64, Vec<u64>>>,
    }

    /// S_k(Gamma0(n))'s newspace at the first prime of hecke_primes(1) (n
    /// squarefree), with P_p for the primes p <= `primes_to`.
    pub fn fixture(n: u64, k: usize, primes_to: u64, factor: Factorer) -> Fixture {
        let res = crate::newspace::newspace_orbits(n, k, &Character::trivial(n), factor).unwrap();
        let eps = Character::trivial(n).minimal();
        let ell = hecke_primes(1).next().unwrap();
        let qs: Vec<u64> = res.ops.iter().map(|o| o.0).collect();
        let lv = levels(n, k, &eps, &[0], &qs).unwrap();
        let polys: Vec<Vec<u64>> = res.orbits.iter().map(|u| u.iter().map(|c| {
            let r = c % BigInt::from(ell);
            let r = if r < BigInt::from(0) { r + BigInt::from(ell) } else { r };
            r.try_into().unwrap()
        }).collect()).collect();
        let mut scratch = Units::default();
        let (sp, setups, zm) = setups_mod(n, k, &eps, &res, &lv, &polys, &res.dims, ell, root_of_unity(1, ell), 1, 0, 0, &mut scratch).unwrap().unwrap();
        let primes: Vec<u64> = (2..=primes_to).filter(|&p| is_prime(p)).collect();
        let pp = prime_polys(n, &sp, &setups, &primes, ell, &mut scratch);
        Fixture { n, k, eps, ell, zm, sp, setups, pp }
    }

    impl Fixture {
        /// prime_polys for these primes: charging the tally, or counted.
        pub fn prime_polys(&self, primes: &[u64], tally: bool) -> Units {
            let mut u = Units::default();
            if tally {
                prime_polys(self.n, &self.sp, &self.setups, primes, self.ell, &mut Local::new());
            } else {
                prime_polys(self.n, &self.sp, &self.setups, primes, self.ell, &mut u);
            }
            u
        }

        /// all_pn of the first orbit to `bound` (at most the fixture's
        /// `primes_to`).
        pub fn all_pn(&self, bound: usize, tally: bool) -> Units {
            let pp = &self.pp;
            let mut u = Units::default();
            if tally {
                all_pn(&self.setups[0], &pp[0], bound, self.n, self.k, &self.eps, self.zm, self.ell, &mut Local::new());
            } else {
                all_pn(&self.setups[0], &pp[0], bound, self.n, self.k, &self.eps, self.zm, self.ell, &mut u);
            }
            u
        }
    }

    /// The CRT's units (general_exact::crt_units).
    pub fn crt_units(ls: &[u64], entries: usize) -> Units {
        super::crt_units(ls, entries)
    }
}

#[cfg(test)]
mod tests;

/// (outside the tests, the setup always tries the single coordinates first)
#[cfg(not(test))]
mod tests {
    #[inline(always)]
    pub(super) fn single_coordinates_skipped() -> bool {
        false
    }
}
