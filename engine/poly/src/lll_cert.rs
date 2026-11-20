//! An exact certificate for LLL reduction, for tests and benchmarks: whether
//! `out` is an LLL-reduced basis, with parameters eta = en/ed and
//! delta = dn/dd, of the same lattice as the independent rows of `inp`.
//!
//! Everything is integer arithmetic. With G = R R^T for the rows of R =
//! `out`, the integral Gram-Schmidt data (Cohen, Algorithm 2.6.7) are the
//! leading principal minors d_0 = 1, d_1, ..., d_k of G and the
//! lambda_ij = d_{j+1} mu_ij (j < i), all integers. Then
//! - size reduction: |mu_ij| <= eta is ed |lambda_ij| <= en d_{j+1};
//! - Lovasz: delta |b*_{k-1}|^2 <= |b*_k|^2 + mu_{k,k-1}^2 |b*_{k-1}|^2 is,
//!   times d_k d_{k-1}, dn d_k^2 <= dd (d_{k+1} d_{k-1} + lambda_{k,k-1}^2);
//! - the same lattice: R has as many rows as B = `inp`, R's rows are
//!   independent (d_k > 0), and integer matrices X, Y with X B = R and
//!   Y R = B exist: L(R) and L(B) contain each other (and B's rows are then
//!   independent too, spanning R's row space). X and Y are found modulo
//!   primes (candidates only); the proof is the exact products.

use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;

/// Why a basis is not certified.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    Shape,
    Dependent,
    SizeReduction { i: usize, j: usize },
    Lovasz { k: usize },
    Covolume,
    NotInLattice { i: usize },
}

fn dot(x: &[BigInt], y: &[BigInt]) -> BigInt {
    x.iter().zip(y).map(|(a, b)| a * b).sum()
}

fn gram(m: &[Vec<BigInt>]) -> Vec<Vec<BigInt>> {
    (0..m.len()).map(|i| (0..m.len()).map(|j| dot(&m[i], &m[j])).collect()).collect()
}

/// The integral Gram-Schmidt data of the rows of `m`: (d_0..d_k, lambda),
/// lambda[i][j] for j < i; None if the rows are dependent.
pub fn integral_gso(m: &[Vec<BigInt>]) -> Option<(Vec<BigInt>, Vec<Vec<BigInt>>)> {
    let k = m.len();
    let g = gram(m);
    let mut d = vec![BigInt::one(); k + 1];
    let mut lam: Vec<Vec<BigInt>> = (0..k).map(|i| vec![BigInt::zero(); i]).collect();
    for i in 0..k {
        for j in 0..=i {
            let mut u = g[i][j].clone();
            for l in 0..j {
                u = (&d[l + 1] * &u - &lam[i][l] * &lam[j][l]) / &d[l];
            }
            if j < i {
                lam[i][j] = u;
            } else {
                if !u.is_positive() {
                    return None;
                }
                d[i + 1] = u;
            }
        }
    }
    Some((d, lam))
}

/// Whether the rows `out` (independent) are (eta, delta)-LLL-reduced,
/// exactly; their integral Gram-Schmidt d_0..d_k on success.
pub fn reduced(out: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32)) -> Result<Vec<BigInt>, Refusal> {
    let k = out.len();
    let (d, lam) = integral_gso(out).ok_or(Refusal::Dependent)?;
    let (en, ed) = (BigInt::from(eta.0), BigInt::from(eta.1));
    for i in 0..k {
        for j in 0..i {
            if &ed * lam[i][j].abs() > &en * &d[j + 1] {
                return Err(Refusal::SizeReduction { i, j });
            }
        }
    }
    let (dn, dd) = (BigInt::from(delta.0), BigInt::from(delta.1));
    for kk in 1..k {
        // b*_{kk-1}, b*_kk: d_kk^2 vs d_{kk+1} d_{kk-1} + lambda_{kk,kk-1}^2
        let l = &lam[kk][kk - 1];
        if &dn * &d[kk] * &d[kk] > &dd * (&d[kk + 1] * &d[kk - 1] + l * l) {
            return Err(Refusal::Lovasz { k: kk });
        }
    }
    Ok(d)
}

// --- the interval oracle for reducedness -------------------------------------
//
// For the largest outputs, whose exact integral Gram-Schmidt data run to
// ~2 b d bits: the same recurrence on the exact Gram matrix in dyadic
// intervals (BigInt mantissas of p bits, every result rounded outward),
// p doubling twice before the exact check decides. A separate
// implementation from the reducer's interval checks (poly::l2_verify).

/// m 2^e.
#[derive(Clone, Debug)]
struct Dy {
    m: BigInt,
    e: i64,
}

/// floor(m / 2^s) and ceil(m / 2^s) for s >= 0, any sign.
fn shr_floor(m: &BigInt, s: u64) -> BigInt {
    if m.is_negative() {
        -shr_ceil(&-m, s)
    } else {
        m >> s as usize
    }
}

fn shr_ceil(m: &BigInt, s: u64) -> BigInt {
    if m.is_negative() {
        -shr_floor(&-m, s)
    } else {
        let q = m >> s as usize;
        if &q << s as usize == *m { q } else { q + 1 }
    }
}

impl Dy {
    fn int(m: BigInt) -> Dy {
        Dy { m, e: 0 }
    }

    /// Rounded to p bits, down or up.
    fn round(m: BigInt, e: i64, p: u64, up: bool) -> Dy {
        let b = m.bits();
        if b <= p {
            return Dy { m, e };
        }
        let s = b - p;
        Dy { m: if up { shr_ceil(&m, s) } else { shr_floor(&m, s) }, e: e + s as i64 }
    }

    /// The exact sum (at the smaller exponent), rounded.
    fn add(&self, o: &Dy, p: u64, up: bool) -> Dy {
        let e = self.e.min(o.e);
        let m = (&self.m << (self.e - e) as usize) + (&o.m << (o.e - e) as usize);
        Dy::round(m, e, p, up)
    }

    fn mul(&self, o: &Dy, p: u64, up: bool) -> Dy {
        Dy::round(&self.m * &o.m, self.e + o.e, p, up)
    }

    /// self / o for o > 0, rounded (the quotient carried to p + 2 bits).
    fn div(&self, o: &Dy, p: u64, up: bool) -> Dy {
        let sh = (p + 2 + o.m.bits()).saturating_sub(self.m.bits()) as i64 + 1;
        let num = &self.m << sh as usize;
        let q = if up { -(-num).div_floor(&o.m) } else { num.div_floor(&o.m) };
        Dy::round(q, self.e - sh - o.e, p, up)
    }

    /// self <= o, exactly.
    fn le(&self, o: &Dy) -> bool {
        let e = self.e.min(o.e);
        (&self.m << (self.e - e) as usize) <= (&o.m << (o.e - e) as usize)
    }

    /// a self <= b o for small nonnegative integers a, b, exactly.
    fn scaled_le(&self, a: u32, o: &Dy, b: u32) -> bool {
        Dy { m: &self.m * a, e: self.e }.le(&Dy { m: &o.m * b, e: o.e })
    }

    fn positive(&self) -> bool {
        self.m.is_positive()
    }
}

/// [lo, hi].
#[derive(Clone, Debug)]
struct Iv {
    lo: Dy,
    hi: Dy,
}

impl Iv {
    fn point(x: &BigInt) -> Iv {
        Iv { lo: Dy::int(x.clone()), hi: Dy::int(x.clone()) }
    }

    fn sub(&self, o: &Iv, p: u64) -> Iv {
        let neg = |x: &Dy| Dy { m: -&x.m, e: x.e };
        Iv { lo: self.lo.add(&neg(&o.hi), p, false), hi: self.hi.add(&neg(&o.lo), p, true) }
    }

    fn mul(&self, o: &Iv, p: u64) -> Iv {
        let c = [(&self.lo, &o.lo), (&self.lo, &o.hi), (&self.hi, &o.lo), (&self.hi, &o.hi)];
        let lo = c.iter().map(|(a, b)| a.mul(b, p, false)).reduce(|a, b| if a.le(&b) { a } else { b }).unwrap();
        let hi = c.iter().map(|(a, b)| a.mul(b, p, true)).reduce(|a, b| if a.le(&b) { b } else { a }).unwrap();
        Iv { lo, hi }
    }

    /// self / o for o.lo > 0.
    fn div_pos(&self, o: &Iv, p: u64) -> Iv {
        let c = [(&self.lo, &o.lo), (&self.lo, &o.hi), (&self.hi, &o.lo), (&self.hi, &o.hi)];
        let lo = c.iter().map(|(a, b)| a.div(b, p, false)).reduce(|a, b| if a.le(&b) { a } else { b }).unwrap();
        let hi = c.iter().map(|(a, b)| a.div(b, p, true)).reduce(|a, b| if a.le(&b) { b } else { a }).unwrap();
        Iv { lo, hi }
    }
}

/// Whether the rows with exact Gram matrix `g` are provably (eta, delta)-
/// reduced (and independent) with p-bit dyadic intervals; false when the
/// intervals cannot decide (or the rows are not reduced).
fn reduced_intervals(g: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32), p: u64) -> bool {
    let k = g.len();
    let mut r: Vec<Vec<Iv>> = vec![vec![]; k];
    let mut mu: Vec<Vec<Iv>> = vec![vec![]; k];
    for i in 0..k {
        let mut s_last = Iv::point(&g[i][i]);
        for j in 0..=i {
            let mut s = Iv::point(&g[i][j]);
            if j < i {
                for l in 0..j {
                    s = s.sub(&mu[j][l].mul(&r[i][l], p), p);
                }
                if !r[j][j].lo.positive() {
                    return false;
                }
                let m = s.div_pos(&r[j][j], p);
                // |mu| <= en / ed: ed hi <= en and -ed lo <= en
                let neg_lo = Dy { m: -&m.lo.m, e: m.lo.e };
                let one = Dy::int(BigInt::one());
                if !m.hi.scaled_le(eta.1, &one, eta.0) || !neg_lo.scaled_le(eta.1, &one, eta.0) {
                    return false;
                }
                mu[i].push(m);
            } else {
                for l in 0..i {
                    if l + 1 == i {
                        s_last = s.clone();
                    }
                    s = s.sub(&mu[i][l].mul(&r[i][l], p), p);
                }
                // (implied for a size-reduced row passing Lovasz: r_ii >=
                // (delta - eta^2) r_{i-1,i-1}; kept as the independence test)
                if !s.lo.positive() {
                    return false;
                }
            }
            r[i].push(s);
        }
        // Lovasz: dn r_{i-1,i-1} <= dd s_{i-1}
        if i > 0 && !r[i - 1][i - 1].hi.scaled_le(delta.0, &s_last.lo, delta.1) {
            return false;
        }
    }
    true
}

/// Which check certified reducedness.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum By {
    Exact,
    /// the interval oracle, at this precision
    Interval(u64),
}

/// The interval oracle alone: the precision that proved the rows reduced
/// (64 + 2k bits, then doubled twice), or None.
pub fn reduced_interval(out: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32)) -> Option<u64> {
    let g = gram(out);
    let mut p = 64 + 2 * out.len() as u64;
    for _ in 0..3 {
        if reduced_intervals(&g, eta, delta, p) {
            return Some(p);
        }
        p *= 2;
    }
    None
}

/// Reducedness: the exact check when the rows are small (its values grow
/// to ~d b bits, the oracle's are 64 + 2d: measured on the benchmark
/// corpus, exact is the faster below d b ~ 5-10 times that, so the cut is
/// 8), else the interval oracle with the exact check as its fallback.
pub fn reduced_by(out: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32)) -> Result<By, Refusal> {
    let d = out.len() as u64;
    let b = out.iter().flatten().map(|x| x.bits()).max().unwrap_or(0);
    if d * b <= 8 * (64 + 2 * d) {
        return reduced(out, eta, delta).map(|_| By::Exact);
    }
    match reduced_interval(out, eta, delta) {
        Some(p) => Ok(By::Interval(p)),
        None => reduced(out, eta, delta).map(|_| By::Exact),
    }
}

/// Both reducedness checks (for the oracle's independence check).
pub fn reduced_both(out: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32)) -> (Option<u64>, Result<(), Refusal>) {
    (reduced_interval(out, eta, delta), reduced(out, eta, delta).map(|_| ()))
}

/// The certificate: Ok when `out` is an (eta, delta)-LLL-reduced basis of
/// the lattice of the independent rows `inp`.
pub fn certify(inp: &[Vec<BigInt>], out: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32)) -> Result<(), Refusal> {
    certify_by(inp, out, eta, delta).map(|_| ())
}

/// `certify`, with the check that certified reducedness.
pub fn certify_by(inp: &[Vec<BigInt>], out: &[Vec<BigInt>], eta: (u32, u32), delta: (u32, u32)) -> Result<By, Refusal> {
    let k = inp.len();
    let n = inp.first().map_or(0, |r| r.len());
    if out.len() != k || inp.iter().chain(out).any(|r| r.len() != n) {
        return Err(Refusal::Shape);
    }
    // R's rows independent (d_k > 0, or r_kk > 0 in the intervals) and
    // reduced
    let by = reduced_by(out, eta, delta)?;
    // R in L(B), and B in L(R): with R independent, the second also makes
    // B's k rows independent (they span R's row space)
    if let Err(i) = integral_combination(inp, out) {
        return Err(Refusal::NotInLattice { i });
    }
    if integral_combination(out, inp).is_err() {
        return Err(Refusal::Covolume);
    }
    Ok(by)
}

/// Integer X with X a = r, checked exactly; Err(i) (a row of r that is not
/// an integer combination of a's rows) when there is none. The candidate is
/// found modulo primes (k pivot columns S of a; X = r_S a_S^-1 mod p, the
/// residues combined by Chinese remaindering, symmetric) and checked against
/// every column once a new prime leaves it unchanged; the search stops past
/// Cramer's bound for |X| (beyond it no integral X can exist).
pub fn integral_combination(a: &[Vec<BigInt>], r: &[Vec<BigInt>]) -> Result<Vec<Vec<BigInt>>, usize> {
    use sagebrush_bigint::nmod::{prev_prime, Modulus};
    use sagebrush_bigint::rem_u64;
    let (k, m) = (a.len(), r.len());
    let n = a.first().map_or(0, |x| x.len());
    if k == 0 {
        return if r.iter().all(|x| x.iter().all(|v| v.is_zero())) { Ok(vec![vec![]; m]) } else { Err(0) };
    }
    let check = |x: &[Vec<BigInt>]| -> Result<(), usize> {
        for t in 0..m {
            for c in 0..n {
                let s: BigInt = (0..k).filter(|&i| !x[t][i].is_zero()).map(|i| &x[t][i] * &a[i][c]).sum();
                if s != r[t][c] {
                    return Err(t);
                }
            }
        }
        Ok(())
    };
    // Cramer: X = r_S adj(a_S) / det(a_S); |X_ti| <= |r_t,S| |adj column|
    // <= sqrt(k) 2^br * Hadamard bound of a's (k-1)-minors; bits of it:
    let ba = a.iter().flatten().map(|x| x.bits()).max().unwrap_or(0);
    let br = r.iter().flatten().map(|x| x.bits()).max().unwrap_or(0);
    let lg = 64 - (k as u64).leading_zeros() as u64;
    let cap = br + (k as u64) * (ba + lg) + lg + 2;
    let mut p = 1u64 << 62;
    let mut cols: Option<Vec<usize>> = None;
    let mut x: Vec<Vec<BigInt>> = vec![vec![BigInt::zero(); k]; m];
    let mut modulus = BigInt::one();
    let mut skipped = BigInt::one();
    loop {
        p = prev_prime(p);
        let md = Modulus::new(p);
        let red = |v: &BigInt| {
            let u = rem_u64(&v.abs(), p);
            if v.is_negative() && u != 0 { p - u } else { u }
        };
        // the pivot columns, once (rank k of a modulo the first good prime)
        if cols.is_none() {
            let mut w: Vec<Vec<u64>> = a.iter().map(|row| row.iter().map(red).collect()).collect();
            let mut piv = vec![];
            let mut row = 0;
            for c in 0..n {
                if row == k {
                    break;
                }
                let Some(q) = (row..k).find(|&i| w[i][c] != 0) else { continue };
                w.swap(row, q);
                let inv = md.inv(w[row][c]).unwrap();
                for i in row + 1..k {
                    let f = md.mul(w[i][c], inv);
                    if f != 0 {
                        for cc in c..n {
                            let t = md.mul(f, w[row][cc]);
                            w[i][cc] = md.sub(w[i][cc], t);
                        }
                    }
                }
                piv.push(c);
                row += 1;
            }
            if piv.len() < k {
                skipped *= BigInt::from(p);
                if skipped.bits() > cap + 64 {
                    // dependent rows (rank deficient modulo many primes)
                    return Err(0);
                }
                continue;
            }
            cols = Some(piv);
        }
        let s = cols.as_ref().unwrap();
        // a_S^-1 mod p by Gauss-Jordan on [a_S | I]
        let mut g: Vec<Vec<u64>> = (0..k).map(|i| s.iter().map(|&c| red(&a[i][c])).chain((0..k).map(|j| (i == j) as u64)).collect()).collect();
        let mut ok = true;
        for c in 0..k {
            let Some(q) = (c..k).find(|&i| g[i][c] != 0) else {
                ok = false;
                break;
            };
            g.swap(c, q);
            let inv = md.inv(g[c][c]).unwrap();
            for v in g[c].iter_mut() {
                *v = md.mul(*v, inv);
            }
            for i in 0..k {
                if i != c && g[i][c] != 0 {
                    let f = g[i][c];
                    for j in 0..2 * k {
                        let t = md.mul(f, g[c][j]);
                        g[i][j] = md.sub(g[i][j], t);
                    }
                }
            }
        }
        if !ok {
            // a_S singular modulo p: skip it
            continue;
        }
        // X_p = r_S a_S^-1
        let rs: Vec<Vec<u64>> = r.iter().map(|row| s.iter().map(|&c| red(&row[c])).collect()).collect();
        let minv = md.inv(rem_u64(&modulus, p)).unwrap();
        let half_new = (&modulus * BigInt::from(p)) >> 1usize;
        let mut changed = false;
        for t in 0..m {
            for i in 0..k {
                let mut v = 0u64;
                for (j, &rv) in rs[t].iter().enumerate() {
                    if rv != 0 {
                        v = md.add(v, md.mul(rv, g[j][k + i]));
                    }
                }
                // Garner: x + M ((v - x) M^-1 mod p), then symmetric
                let xm = red(&x[t][i]);
                let c = md.mul(md.sub(v, xm), minv);
                if c != 0 {
                    let mut nx = &x[t][i] + &modulus * BigInt::from(c);
                    if nx > half_new {
                        nx -= &modulus * BigInt::from(p);
                    }
                    if nx != x[t][i] {
                        changed = true;
                        x[t][i] = nx;
                    }
                } else if x[t][i] > half_new {
                    x[t][i] -= &modulus * BigInt::from(p);
                    changed = true;
                }
            }
        }
        modulus *= BigInt::from(p);
        if !changed || modulus.bits() > cap + 2 {
            match check(&x) {
                Ok(()) => return Ok(x),
                Err(t) if modulus.bits() > cap + 2 => return Err(t),
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::Budget;

    fn z(rows: &[&[i64]]) -> Vec<Vec<BigInt>> {
        rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }
    /// certify_by takes the exact check for small rows and the interval
    /// oracle for large ones (the identity basis, scaled by 2^k).
    #[test]
    fn certify_by_picks_the_check_by_size() {
        let id = |d: usize, k: usize| -> Vec<Vec<BigInt>> { (0..d).map(|i| (0..d).map(|j| BigInt::from((i == j) as i64) << k).collect()).collect() };
        assert_eq!(certify_by(&id(20, 0), &id(20, 0), ETA, DELTA), Ok(By::Exact));
        assert_eq!(certify_by(&id(20, 1000), &id(20, 1000), ETA, DELTA), Ok(By::Interval(104)));
    }

    /// integral_combination finds X with X a = r for r = U a, U random
    /// unimodular (products of elementary operations with large multipliers),
    /// square and knapsack-shaped a; refuses a vector outside the lattice
    /// (one coordinate off by one) and r against dependent rows a.
    #[test]
    fn integral_combination_finds_and_refuses() {
        let mut seed = 0x5a5a_1234_9876_abcdu64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut offs = 0;
        for case in 0..40 {
            let k = 2 + case % 7;
            let n = k + case % 2;
            let a: Vec<Vec<BigInt>> = loop {
                let a: Vec<Vec<BigInt>> = (0..k).map(|_| (0..n).map(|_| BigInt::from((rnd() % 2001) as i64 - 1000) << ((rnd() % 3) * 40) as usize).collect()).collect();
                if integral_gso(&a).is_some() {
                    break a;
                }
            };
            // U: random elementary operations
            let mut u: Vec<Vec<BigInt>> = (0..k).map(|i| (0..k).map(|j| BigInt::from((i == j) as i64)).collect()).collect();
            for _ in 0..3 * k {
                let (i, j) = ((rnd() % k as u64) as usize, (rnd() % k as u64) as usize);
                if i != j {
                    let f = BigInt::from((rnd() % 2_000_001) as i64 - 1_000_000);
                    let rj = u[j].clone();
                    for (x, y) in u[i].iter_mut().zip(&rj) {
                        *x += &f * y;
                    }
                }
            }
            let r: Vec<Vec<BigInt>> = u.iter().map(|ur| (0..n).map(|c| (0..k).map(|i| &ur[i] * &a[i][c]).sum()).collect()).collect();
            assert_eq!(integral_combination(&a, &r).expect("in the lattice"), u, "case {case}");
            assert!(integral_combination(&r, &a).is_ok(), "case {case}: back");
            let mut off = r.clone();
            let t = (rnd() % k as u64) as usize;
            off[t][0] += 1;
            // r_t + e_0 is in L(a) only when e_0 is (never for these a,
            // whose entries are multiples of 2 or large); refuse that row
            let e0_in = integral_combination(&a, &[(0..n).map(|c| BigInt::from((c == 0) as i64)).collect()]).is_ok();
            if !e0_in {
                assert_eq!(integral_combination(&a, &off), Err(t), "case {case}: off");
                offs += 1;
            }
            // dependent a: row 1 = 2 row 0
            let mut dep = a.clone();
            dep[1] = dep[0].iter().map(|x| x * 2).collect();
            assert!(integral_combination(&dep, &a).is_err(), "case {case}: dependent");
        }
        assert!(offs >= 20, "{offs}");
    }

    /// The dyadic interval operations hold the exact results: point and
    /// wide intervals of random integers (signs mixed), at precisions 4 to
    /// 30 bits so that nearly every result is rounded; containment checked
    /// exactly (lo <= x - y <= hi; lo <= x y <= hi; lo y <= x <= hi y for
    /// the quotient by a point y > 0).
    #[test]
    fn dyadic_intervals_contain_the_exact_result() {
        let mut seed = 0x2468_ace0_1357_9bdfu64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let exact = 100_000; // precision that rounds nothing here
        let mut rounded = 0;
        for case in 0..3000 {
            let p = 4 + (rnd() % 27);
            let mut int = || {
                let v = BigInt::from((rnd() >> (rnd() % 40)) as i64 >> 1);
                if rnd() % 2 == 0 { -v } else { v }
            };
            let (x0, x1, y0, y1) = (int(), int(), int(), int());
            let (xl, xh) = if x0 <= x1 { (x0, x1) } else { (x1, x0) };
            let (yl, yh) = if y0 <= y1 { (y0, y1) } else { (y1, y0) };
            let x = Iv { lo: Dy::int(xl.clone()), hi: Dy::int(xh.clone()) };
            let y = Iv { lo: Dy::int(yl.clone()), hi: Dy::int(yh.clone()) };
            let inside = |z: &Iv, v: &BigInt| z.lo.le(&Dy::int(v.clone())) && Dy::int(v.clone()).le(&z.hi);
            // every endpoint combination's exact result is inside
            let d = x.sub(&y, p);
            let m = x.mul(&y, p);
            for a in [&xl, &xh] {
                for b in [&yl, &yh] {
                    assert!(inside(&d, &(a - b)), "sub {case}");
                    assert!(inside(&m, &(a * b)), "mul {case}");
                }
            }
            rounded += (!d.lo.le(&Dy::int(&xl - &yh)) || !Dy::int(&xl - &yh).le(&d.lo)) as u32;
            // the quotient by a point y > 0
            let yp = yh.abs() + 1;
            let q = x.div_pos(&Iv::point(&yp), p);
            let ypd = Dy::int(yp.clone());
            for a in [&xl, &xh] {
                assert!(q.lo.mul(&ypd, exact, false).le(&Dy::int(a.clone())), "div lo {case}");
            }
            for a in [&xl, &xh] {
                assert!(Dy::int(a.clone()).le(&q.hi.mul(&ypd, exact, true)), "div hi {case}");
            }
        }
        assert!(rounded > 1000, "{rounded}");
    }

    /// The interval oracle never proves what the exact check refuses: on
    /// bases just past the boundaries (mu = 0.51 + 2^-107, delta' just below
    /// 0.99, in row 1 and, through the subtractions, row 2), where only the
    /// outward roundings keep it honest, it refuses; it proves the same bases
    /// just inside; and on random near-boundary lattices (dimensions 2 to 6,
    /// entries to 2^120) whenever it proves, the exact check agrees, and it
    /// proves most of the reduced ones.
    #[test]
    fn interval_oracle_agrees_with_the_exact_check() {
        let big = |x: i64, sh: usize| BigInt::from(x) << sh;
        // t = 100: past the edge by ~2^-107, which the oracle resolves; t =
        // 300: by ~2^-300, below its last precision, where only the outward
        // roundings keep it from proving
        for t in [100usize, 300] {
        // mu just above / below 0.51 (a = 100 2^t, b = 51 2^t + 1 or - 1;
        // exactly 0.51 is beyond any interval: it is not dyadic)
        for (plus, reduced_) in [(1i64, false), (-1, true)] {
            let m = vec![vec![big(100, t), BigInt::zero()], vec![big(51, t) + plus, big(100, t)]];
            let (iv, ex) = reduced_both(&m, ETA, DELTA);
            assert_eq!(ex.is_ok(), reduced_, "mu exact");
            assert_eq!(iv.is_some(), reduced_ && t == 100, "mu interval");
        }
        // Lovasz in row 1: |b1|^2 = 0.99 |b0|^2 - tiny (fails) or + (holds),
        // b0 = (10 2^t, 0), b1 = (0, y) with y^2 near 99 2^2t
        let y0 = (BigInt::from(99) << (2 * t)).sqrt();
        for (y, ok) in [(y0.clone(), false), (y0.clone() + 1, true)] {
            let m = vec![vec![big(10, t), BigInt::zero()], vec![BigInt::zero(), y]];
            let (iv, ex) = reduced_both(&m, ETA, DELTA);
            assert_eq!(ex.is_ok(), ok, "lovasz exact");
            // (exact points compared exactly: no rounding to decide)
            assert_eq!(iv.is_some(), ok, "lovasz interval");
        }
        // Lovasz in row 2, through the subtractions: b2 = (q, 0, z) with
        // q = 0.5 |b0| projected away, |z|^2 against 0.99 |b1*|^2
        for (dz, ok) in [(0i64, false), (1, true)] {
            let a0 = big(10, t);
            let m = vec![
                vec![a0.clone(), BigInt::zero(), BigInt::zero()],
                vec![BigInt::zero(), big(10, t), BigInt::zero()],
                vec![big(5, t), BigInt::zero(), y0.clone() + dz],
            ];
            let (iv, ex) = reduced_both(&m, ETA, DELTA);
            assert_eq!(ex.is_ok(), ok, "row 2 exact");
            assert_eq!(iv.is_some(), ok, "row 2 interval");
        }
        // row 2 again, with mu_10 = (5 2^t + 1) / (10 2^t) (not dyadic), so
        // r_11 = 100 2^2t comes out of a rounded product and subtraction
        for (dz, ok) in [(0i64, false), (1, true)] {
            let m = vec![
                vec![big(10, t), BigInt::zero(), BigInt::zero()],
                vec![big(5, t) + 1, big(10, t), BigInt::zero()],
                vec![big(5, t), BigInt::zero(), y0.clone() + dz],
            ];
            let (iv, ex) = reduced_both(&m, ETA, DELTA);
            assert_eq!(ex.is_ok(), ok, "row 2, rounded r_11, exact");
            if !ok {
                assert_eq!(iv, None, "row 2, rounded r_11, interval");
            }
        }
        }
        // random near-boundary lattices
        let mut seed = 0x77ee_1357_2468_9bdfu64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let (mut proved, mut exact_ok) = (0, 0);
        for _ in 0..300 {
            let k = 2 + (rnd() % 5) as usize;
            let sh = (rnd() % 120) as usize;
            // lower triangular with diagonal near 10, off-diagonal near +-5:
            // mu near +-0.5, Lovasz near the edge
            let m: Vec<Vec<BigInt>> = (0..k)
                .map(|i| {
                    (0..k)
                        .map(|j| {
                            if j > i {
                                BigInt::zero()
                            } else if j == i {
                                (BigInt::from(10) << sh) - BigInt::from((rnd() % 4) as i64) * (BigInt::from(1) << (sh.saturating_sub(4)))
                            } else {
                                (BigInt::from(if rnd() % 2 == 0 { 5 } else { -5 }) << sh) + BigInt::from((rnd() % 3) as i64 - 1) * (BigInt::from(1) << (sh / 2))
                            }
                        })
                        .collect()
                })
                .collect();
            let (iv, ex) = reduced_both(&m, ETA, DELTA);
            assert!(!(iv.is_some() && ex.is_err()), "interval proved what exact refuses: {m:?}");
            proved += iv.is_some() as u32;
            exact_ok += ex.is_ok() as u32;
        }
        assert!(exact_ok > 50 && proved * 10 >= exact_ok * 9, "{proved} of {exact_ok}");
    }

    const ETA: (u32, u32) = (51, 100);
    const DELTA: (u32, u32) = (99, 100);

    /// Each condition refuses on its own: a basis that is not size reduced,
    /// one that fails Lovasz, a sublattice (twice a row), another lattice of
    /// the same covolume, dependent rows and a wrong shape.
    #[test]
    fn refuses_each_failure() {
        let b = z(&[&[1, 0], &[0, 2]]);
        assert_eq!(certify(&b, &b, ETA, DELTA), Ok(()));
        assert_eq!(certify(&b, &z(&[&[1, 0], &[1, 2]]), ETA, DELTA), Err(Refusal::SizeReduction { i: 1, j: 0 }));
        assert_eq!(certify(&z(&[&[0, 2], &[1, 0]]), &z(&[&[0, 2], &[1, 0]]), ETA, DELTA), Err(Refusal::Lovasz { k: 1 }));
        assert_eq!(certify(&b, &z(&[&[2, 0], &[0, 2]]), ETA, DELTA), Err(Refusal::Covolume));
        assert_eq!(certify(&b, &z(&[&[0, 1], &[2, 0]]), ETA, DELTA), Err(Refusal::NotInLattice { i: 0 }));
        assert_eq!(certify(&b, &z(&[&[1, 0], &[2, 0]]), ETA, DELTA), Err(Refusal::Dependent));
        // a basis of another plane with the same covolume, whose projection
        // onto B's plane is integral: only recomputing X B catches it
        let p = z(&[&[1, 0, 0], &[0, 1, 0]]);
        assert_eq!(certify(&p, &z(&[&[1, 0, 0], &[0, 0, 1]]), ETA, DELTA), Err(Refusal::NotInLattice { i: 1 }));
        assert_eq!(certify(&b, &z(&[&[1, 0]]), ETA, DELTA), Err(Refusal::Shape));
        // a non-square basis: the same lattice, reduced and not
        let k = z(&[&[1, 0, 0, 1000], &[0, 1, 0, 1031], &[0, 0, 1, 2031]]);
        assert!(certify(&k, &k, ETA, DELTA).is_err());
    }

    /// The exact LLL's output on random knapsack lattices is certified, and
    /// its input is not (it is far from reduced).
    #[test]
    fn certifies_the_exact_lll() {
        let mut seed = 0x9e37_79b9u64;
        let mut rnd = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m
        };
        for d in [2usize, 5, 9, 14] {
            let m: Vec<Vec<BigInt>> = (0..d)
                .map(|i| {
                    let mut r: Vec<BigInt> = (0..d).map(|j| BigInt::from((i == j) as u32)).collect();
                    r.push(BigInt::from(rnd(1 << 50)));
                    r
                })
                .collect();
            let cap = crate::lll::cap_bits(d, 51).unwrap();
            let r = crate::lll::lll(&Budget::unlimited(), m.clone(), cap).unwrap();
            assert_eq!(certify(&m, &r.basis, ETA, DELTA), Ok(()), "d = {d}");
            assert!(certify(&m, &m, ETA, DELTA).is_err());
        }
    }
}

#[cfg(test)]
mod rank_drop_regressions {
    use super::*;
    #[test]
    fn first_prime_rank_drop() {
        use sagebrush_bigint::nmod::prev_prime;
        let p = prev_prime(1u64 << 62);
        let b = vec![vec![BigInt::from(p)]];
        // the same lattice: X = 1
        assert_eq!(integral_combination(&b, &b), Ok(vec![vec![BigInt::one()]]), "X B = B with B = [[p]], p the first prime tried");
    }
    #[test]
    fn first_prime_rank_drop_2x2() {
        use sagebrush_bigint::nmod::prev_prime;
        let p = BigInt::from(prev_prime(1u64 << 62));
        let b = vec![vec![BigInt::from(1), BigInt::from(0)], vec![BigInt::from(0), p.clone()]];
        assert!(certify(&b, &b, (51, 100), (99, 100)).is_ok(), "{:?}", certify(&b, &b, (51, 100), (99, 100)));
    }
}
