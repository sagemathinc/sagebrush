//! Integral LLL (H. Cohen, A Course in Computational Algebraic Number
//! Theory, Algorithm 2.6.7, after de Weger): exact integers only, with
//! delta = 99/100.  The basis rows must be linearly independent.
//!
//! Within the call's budget (plan r3, section 5.3): every step debits its
//! work first; every product is preflighted from its operands' bit lengths
//! (more than 2L + 64 bits refuses before it is computed); every stored
//! value is checked against the cap L after each step.  The caller
//! reserves the memory of the basis and of this state ([`lattice_bytes`])
//! before building the basis.

use crate::budget::{big_bytes, limbs, Budget, FResult};
use crate::clog2;
use num_integer::Integer;
use num_traits::{Signed, Zero};
use sagebrush_bigint::BigInt;

/// The stored-value cap L for a d-row basis whose entries have at most
/// `e` bits: d (2e + ceil(log2 d) + 4) + 64.
pub fn cap_bits(d: usize, e: u64) -> Option<u64> {
    let per = e.checked_mul(2)?.checked_add(clog2(d as u64))?.checked_add(4)?;
    (d as u64).checked_mul(per)?.checked_add(64)
}

/// Bytes for a d-row basis of length-`w` rows plus the LLL state (the d_i
/// and the lambda_ij), every value at most L bits, and two rows of
/// transients of 2L + 64 bits.
pub fn lattice_bytes(d: usize, w: usize, l: u64) -> Option<u64> {
    let d64 = d as u64;
    let values = d64.checked_mul(w as u64)?.checked_add(d64.checked_mul(d64 + 1)? / 2)?.checked_add(d64 + 1)?;
    let stored = values.checked_mul(big_bytes(l)?)?;
    let transient = (2 * d64.max(w as u64)).checked_mul(big_bytes(l.checked_mul(2)?.checked_add(64)?)?)?;
    stored.checked_add(transient)
}

/// The reduced state: the basis and the Gram determinants d_0 = 1, d_1,
/// ..., d_n (d_i = prod_{j <= i} |b_j*|^2).
pub struct Reduced {
    pub basis: Vec<Vec<BigInt>>,
    pub d: Vec<BigInt>,
}

struct State<'a> {
    b: &'a Budget,
    cap: u64,
    basis: Vec<Vec<BigInt>>,
    d: Vec<BigInt>,
    lam: Vec<Vec<BigInt>>,
}

impl State<'_> {
    /// x * y, refused before it is computed when it could exceed 2L + 64
    /// bits.
    fn mul(&self, x: &BigInt, y: &BigInt) -> FResult<BigInt> {
        let bits = x.bits() + y.bits();
        let lim = 2 * self.cap + 64;
        if bits > lim {
            return Err(self.b.refuse("lll bits (transient)", bits, lim));
        }
        Ok(x * y)
    }

    fn check(&self, x: &BigInt) -> FResult<()> {
        if x.bits() > self.cap {
            return Err(self.b.refuse("lll bits", x.bits(), self.cap));
        }
        Ok(())
    }

    fn dot(&self, x: &[BigInt], y: &[BigInt]) -> FResult<BigInt> {
        let mut s = BigInt::zero();
        for (u, w) in x.iter().zip(y) {
            s += self.mul(u, w)?;
        }
        Ok(s)
    }

    /// Charge `count` products of `x`- and `y`-bit operands, plus as many
    /// additions of the result (schoolbook limb operations, from the actual
    /// operands about to be used).
    fn debit_ops(&self, count: usize, x: u64, y: u64) -> FResult<()> {
        let (lx, ly) = (limbs(x), limbs(y));
        self.b.debit(lx.checked_mul(ly).and_then(|p| p.checked_add(lx + ly)).and_then(|p| p.checked_mul(count.max(1) as u64)))
    }

    /// Size-reduce row k against row l (Cohen's REDI, 0-based rows; d is
    /// shifted: d[i + 1] belongs to row i).
    fn redi(&mut self, k: usize, l: usize) -> FResult<()> {
        let dl = &self.d[l + 1];
        let lam = &self.lam[k][l];
        if (lam.abs() * 2u32) <= *dl {
            return Ok(());
        }
        // q = round(lambda / d_l)
        let q = (lam * 2u32 + dl).div_floor(&(dl * 2u32));
        let row_bits = crate::maxbits(&self.basis[l]);
        let lam_bits = crate::maxbits(&self.lam[l]).max(self.d[l + 1].bits());
        self.debit_ops(self.basis[k].len(), q.bits(), row_bits)?;
        self.debit_ops(l + 1, q.bits(), lam_bits)?;
        let row_l = self.basis[l].clone();
        for (x, y) in self.basis[k].iter_mut().zip(&row_l) {
            let t = if q.bits() + y.bits() > 2 * self.cap + 64 {
                return Err(self.b.refuse("lll bits (transient)", q.bits() + y.bits(), 2 * self.cap + 64));
            } else {
                &q * y
            };
            *x -= t;
        }
        let qd = self.mul(&q, &self.d[l + 1])?;
        self.lam[k][l] -= qd;
        for i in 0..l {
            let t = self.mul(&q, &self.lam[l][i])?;
            self.lam[k][i] -= t;
        }
        for x in &self.basis[k] {
            self.check(x)?;
        }
        for x in &self.lam[k][..=l] {
            self.check(x)?;
        }
        Ok(())
    }

    /// Exchange rows k - 1 and k (Cohen's SWAPI, 0-based).
    fn swapi(&mut self, k: usize, kmax: usize) -> FResult<()> {
        let dbits = self.d[k - 1].bits().max(self.d[k].bits()).max(self.d[k + 1].bits());
        let lbits = (k + 1..=kmax).map(|i| self.lam[i][k].bits().max(self.lam[i][k - 1].bits())).max().unwrap_or(0).max(self.lam[k][k - 1].bits());
        // B, then four products and two divisions per later row
        self.debit_ops(2 + 6 * (kmax - k), dbits.max(lbits), dbits.max(lbits) + dbits)?;
        self.basis.swap(k, k - 1);
        for j in 0..k - 1 {
            let t = std::mem::take(&mut self.lam[k][j]);
            self.lam[k][j] = std::mem::replace(&mut self.lam[k - 1][j], t);
        }
        let lam = self.lam[k][k - 1].clone();
        // B = (d_{k-2} d_k + lambda^2) / d_{k-1}  (1-based); here d[k-1], d[k+1], d[k]
        let nb = (self.mul(&self.d[k - 1], &self.d[k + 1])? + self.mul(&lam, &lam)?) / &self.d[k];
        self.check(&nb)?;
        for i in k + 1..=kmax {
            let t = self.lam[i][k].clone();
            let a = (self.mul(&self.d[k + 1], &self.lam[i][k - 1])? - self.mul(&lam, &t)?) / &self.d[k];
            let c = (self.mul(&nb, &t)? + self.mul(&lam, &a)?) / &self.d[k + 1];
            self.check(&a)?;
            self.check(&c)?;
            self.lam[i][k] = a;
            self.lam[i][k - 1] = c;
        }
        self.d[k] = nb;
        Ok(())
    }
}

/// LLL-reduce the rows (independent), with values capped at `cap` bits.
pub fn lll(b: &Budget, basis: Vec<Vec<BigInt>>, cap: u64) -> FResult<Reduced> {
    let n = basis.len();
    let mut s = State { b, cap, basis, d: vec![BigInt::zero(); n + 1], lam: vec![vec![]; n] };
    s.d[0] = BigInt::from(1);
    if n == 0 {
        return Ok(Reduced { basis: s.basis, d: s.d });
    }
    for i in 0..n {
        s.lam[i] = vec![BigInt::zero(); i];
    }
    let b0 = crate::maxbits(&s.basis[0]);
    s.debit_ops(s.basis[0].len(), b0, b0)?;
    s.d[1] = s.dot(&s.basis[0], &s.basis[0])?;
    s.check(&s.d[1])?;
    let mut k = 1usize;
    let mut kmax = 0usize;
    while k < n {
        if k > kmax {
            // incremental Gram-Schmidt
            kmax = k;
            for j in 0..=k {
                let (bk, bj) = (crate::maxbits(&s.basis[k]), crate::maxbits(&s.basis[j]));
                s.debit_ops(s.basis[k].len(), bk, bj)?;
                let mut u = s.dot(&s.basis[k], &s.basis[j])?;
                let gbits = s.d[..=j].iter().map(|x| x.bits()).max().unwrap_or(0).max(crate::maxbits(&s.lam[k][..j.min(k)])).max(crate::maxbits(&s.lam[j]));
                s.debit_ops(2 * j, gbits.max(u.bits()), gbits.max(u.bits()) + gbits)?;
                for i in 0..j {
                    u = (s.mul(&s.d[i + 1], &u)? - s.mul(&s.lam[k][i], &s.lam[j][i])?) / &s.d[i];
                }
                s.check(&u)?;
                if j < k {
                    s.lam[k][j] = u;
                } else {
                    assert!(!u.is_zero(), "lll: dependent rows");
                    s.d[k + 1] = u;
                }
            }
        }
        // Lovasz test with delta = 99/100: 100 d_k d_{k-2} < 99 d_{k-1}^2 - 100 lambda^2
        s.redi(k, k - 1)?;
        let tb = s.d[k - 1].bits().max(s.d[k].bits()).max(s.d[k + 1].bits()).max(s.lam[k][k - 1].bits());
        s.debit_ops(3, tb, tb)?;
        let lhs = s.mul(&s.d[k + 1], &s.d[k - 1])? * 100u32;
        let rhs = s.mul(&s.d[k], &s.d[k])? * 99u32 - s.mul(&s.lam[k][k - 1], &s.lam[k][k - 1])? * 100u32;
        if lhs < rhs {
            s.swapi(k, kmax)?;
            k = if k > 1 { k - 1 } else { 1 };
        } else {
            for l in (0..k - 1).rev() {
                s.redi(k, l)?;
            }
            k += 1;
        }
    }
    Ok(Reduced { basis: s.basis, d: s.d })
}

// --- the L^2 route and the cut ---------------------------------------------------
//
// A caller may reduce with L^2 (crate::l2) instead, then cut: its entries
// stay within a cap of a few bits over the input's, where this module's
// d_i and lambda_ij need d times as many, so its memory is far smaller on
// most shapes. The caller keeps the original rows, charged, while L^2 runs on
// a copy: when L^2 stops (an entry past its cap, no rung proving the result),
// `lll` starts over from them, as if L^2 had not run.

/// The L^2 route's entry cap for a d-row basis whose entries have at most
/// `e` bits: e + d + 64. A heuristic, not a bound: the reductions measured
/// needed at most e + 11 bits (d <= 120); an entry past it stops L^2, and
/// the exact LLL starts over.
pub fn l2_cap(d: usize, e: u64) -> Option<u64> {
    e.checked_add(d as u64)?.checked_add(64)
}

/// Bytes for [`cut`]'s state on d rows of length w, entries of at most `c`
/// bits: the Gram triangle, and the r and mu triangles of its 53-bit and of
/// its p-bit (p at most 96 + 2d) interval Gram-Schmidt, with a few p-bit
/// temporaries twice that.
pub fn cut_bytes(d: usize, w: usize, c: u64) -> Option<u64> {
    const V: u64 = 24;
    let (d, w) = (d as u64, w as u64);
    let tri = d.checked_mul(d.checked_add(1)?)? / 2;
    let lg = clog2(w.max(1)).checked_add(1)?;
    let gram = tri.checked_mul(big_bytes(c.checked_mul(2)?.checked_add(lg)?.checked_add(1)?)?)?.checked_add(d.checked_mul(V)?)?;
    let pb = d.checked_mul(2)?.checked_add(96)?;
    let ip = big_bytes(pb)?.checked_add(8)?.checked_mul(2)?.checked_add(8)?;
    let iv = tri.checked_mul(2 * 32)?;
    let ivp = tri.checked_mul(2)?.checked_mul(ip)?;
    let temps = d.checked_mul(4 * V)?.checked_add(big_bytes(pb.checked_mul(2)?)?.checked_mul(8)?)?;
    gram.checked_add(iv)?.checked_add(ivp)?.checked_add(temps)
}

/// Bytes for [`cut`]'s exact stage on (at most) those rows: the integral
/// Gram-Schmidt data (its own full Gram matrix, d + 1 determinants and the
/// lambda triangle, each of at most d (2c + lg w + 1) + 64 bits) and a few
/// temporaries twice that.
pub fn cut_exact_bytes(d: usize, w: usize, c: u64) -> Option<u64> {
    const V: u64 = 24;
    let (d, w) = (d as u64, w as u64);
    let tri = d.checked_mul(d.checked_add(1)?)? / 2;
    let lg = clog2(w.max(1)).checked_add(1)?;
    let ge = c.checked_mul(2)?.checked_add(lg)?.checked_add(1)?;
    let vb = d.checked_mul(ge)?.checked_add(64)?;
    let full = d.checked_mul(d)?.checked_mul(big_bytes(ge)?)?.checked_add(d.checked_mul(V)?)?;
    let gso = d.checked_add(1)?.checked_add(tri)?.checked_mul(big_bytes(vb)?)?.checked_add(d.checked_mul(V)?)?;
    full.checked_add(gso)?.checked_add(big_bytes(vb.checked_mul(2)?)?.checked_mul(4)?)
}

#[cfg(test)]
thread_local! {
    static CUT_EXACT_ONLY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Tests: the route forced (see `Force`), the L^2 attempts that fell
    /// back to the exact LLL, and those that reduced.
    pub(crate) static FORCE: std::cell::Cell<Force> = const { std::cell::Cell::new(Force::Auto) };
    pub(crate) static FALLBACKS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    pub(crate) static L2_REDUCED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// (the fallbacks whose live heap was checked back at its level before
    /// the attempt's copy)
    pub(crate) static LIVE_CHECKED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Tests: the route as chosen (`Auto`), the exact LLL always (`Exact`), or
/// the L^2 route made to fall back, on its cap (`Bits`: a cap below the
/// input's entries, so at the entry check; `BitsInRun`: the cap at the
/// input's largest entry, so at the first row operation that would pass it,
/// or, when none does, reported past it after the run) or on its proof
/// (`Precision`: a proved result reported unproved).
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Force {
    Auto,
    Exact,
    Bits,
    BitsInRun,
    Precision,
}

/// The L^2 route's sizes: its entry cap, the reservation of its state
/// (`l2_bytes`) and of the kept rows with the cut's state.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct L2Route {
    pub cap: u64,
    pub state: u64,
    pub kept: u64,
}

/// The L^2 route for a d-row basis of length-w rows whose entries have at
/// most `e` bits, when the caller's rows are charged `held` bytes and a
/// kept row set of entries of at most c bits is charged `rows(d, w, c)`;
/// None for the exact LLL. Chosen when its whole peak (the rows held with
/// L^2's state; that state with the kept rows and the cut's; those with the
/// cut's exact stage) is at most the exact LLL's (the rows held with its
/// state; its state with the kept rows and determinants), so a memory limit
/// that admits the exact LLL admits it. Every term is checked: one that
/// doesn't fit in u64 gives the exact LLL (its own terms then refuse as
/// before when they don't fit either).
pub fn l2_route(d: usize, w: usize, e: u64, held: u64, rows: impl Fn(usize, usize, u64) -> Option<u64>) -> Option<L2Route> {
    #[cfg(test)]
    if FORCE.with(|f| f.get()) == Force::Exact {
        return None;
    }
    let cap = l2_cap(d, e)?;
    let state = crate::l2::l2_bytes(d, w, cap)?;
    let kept = rows(d, w, cap)?.checked_add(cut_bytes(d, w, cap)?)?;
    let cx = cut_exact_bytes(d, w, cap)?;
    let p2 = held.checked_add(state)?.max(state.checked_add(kept)?).max(kept.checked_add(cx)?);
    let capx = cap_bits(d, e)?;
    let lx = lattice_bytes(d, w, capx)?;
    let kx = rows(d, w, capx)?.checked_add(big_bytes(capx)?.checked_mul((d as u64).checked_add(1)?)?)?;
    let p0 = held.checked_add(lx)?.max(lx.checked_add(kx)?);
    if p2 > p0 {
        return None;
    }
    #[cfg(test)]
    if FORCE.with(|f| f.get()) == Force::Bits {
        // below the largest input entry: L^2 stops at its entry check
        return Some(L2Route { cap: e.checked_sub(1)?, state, kept });
    }
    #[cfg(test)]
    if FORCE.with(|f| f.get()) == Force::BitsInRun {
        // no entry may grow past the input's largest
        return Some(L2Route { cap: e, state, kept });
    }
    Some(L2Route { cap, state, kept })
}

/// The product of `parts`, plus one: a work estimate (None on overflow).
fn units(parts: &[u64]) -> Option<u64> {
    parts.iter().try_fold(1u64, |a, &x| a.checked_mul(x))?.checked_add(1)
}

/// How many leading rows a cut at `t` keeps: s, once the trailing rows with
/// |b*_{s-1}|^2 > t are dropped (they are no part of a lattice vector of
/// norm^2 at most t, whatever the basis). The rows are independent, their
/// entries of at most `c` bits, and the caller has reserved
/// `cut_bytes(d, w, c)`. Each comparison is decided by 53-bit intervals, else
/// p-bit ones (p = 48 + d, then 96 + 2d), else exactly (d_s > t d_{s-1}): that
/// last stage reserves `cut_exact_bytes` itself, and releases it on return.
/// Every stage's work is debited before it runs. Also returns the exact
/// stage's reservation when it ran (for the caller's ledger).
pub fn cut(b: &Budget, rows: &[Vec<BigInt>], t: &BigInt, c: u64) -> FResult<(usize, Option<u64>)> {
    let d = rows.len();
    if d == 0 {
        return Ok((0, None));
    }
    let w = rows[0].len();
    let (d64, w64) = (d as u64, w as u64);
    let tri = d64.checked_mul(d64 + 1).map(|x| x / 2);
    let overflow = || b.refuse("work (overflow)", u64::MAX, b.work_left());
    // the Gram triangle
    let gram_work = tri.and_then(|x| units(&[x, w64, limbs(c), limbs(c)])).ok_or_else(overflow)?;
    b.debit(Some(gram_work))?;
    let g: Vec<Vec<BigInt>> = (0..d)
        .map(|i| (0..=i).map(|j| rows[i].iter().zip(&rows[j]).fold(BigInt::zero(), |s, (x, y)| s + x * y)).collect())
        .collect();
    let p1 = d64.checked_add(48).ok_or_else(overflow)?;
    let p2 = d64.checked_mul(2).and_then(|x| x.checked_add(96)).ok_or_else(overflow)?;
    let ps = [None, Some(p1), Some(p2)];
    // (tests: the exact stage alone)
    #[cfg(test)]
    let ps = if CUT_EXACT_ONLY.with(|x| x.get()) { &ps[..0] } else { &ps[..] };
    let mut stages: Vec<Vec<Option<bool>>> = vec![];
    let mut exact: Option<(Vec<BigInt>, crate::budget::Reservation<'_>)> = None;
    let mut s = d;
    while s > 0 {
        let k = s - 1;
        let mut above = None;
        for (i, p) in ps.iter().enumerate() {
            if i == stages.len() {
                let per = match p {
                    None => 1,
                    Some(p) => {
                        let l = limbs(p.checked_mul(2).ok_or_else(overflow)?);
                        l.checked_mul(l).and_then(|x| x.checked_mul(4)).ok_or_else(overflow)?
                    }
                };
                b.debit(Some(units(&[d64, d64, d64, per]).ok_or_else(overflow)?))?;
                stages.push(crate::l2_verify::gso_vs(&g, t, *p));
            }
            if let Some(a) = stages[i][k] {
                above = Some(a);
                break;
            }
        }
        let above = match above {
            Some(a) => a,
            None => {
                if exact.is_none() {
                    // the rows kept so far: d_0 .. d_s, the prefix's own
                    let held = b.reserve(cut_exact_bytes(s, w, c))?;
                    let ge = c.checked_mul(2).and_then(|x| x.checked_add(clog2(w64.max(1)) + 2)).ok_or_else(overflow)?;
                    let vb = (s as u64).checked_mul(ge).and_then(|x| x.checked_add(64)).ok_or_else(overflow)?;
                    b.debit(Some(units(&[s as u64, s as u64, s as u64, limbs(vb), limbs(vb), 2]).ok_or_else(overflow)?))?;
                    let (dd, _) = crate::lll_cert::integral_gso(&rows[..s]).ok_or_else(|| b.internal("the cut: dependent rows"))?;
                    exact = Some((dd, held));
                }
                let dd = &exact.as_ref().map(|x| &x.0).ok_or_else(|| b.internal("the cut: no exact data"))?;
                let tk = dd[k].bits().checked_add(t.bits()).ok_or_else(overflow)?;
                b.debit(Some(units(&[limbs(dd[s].bits()), limbs(tk)]).ok_or_else(overflow)?))?;
                dd[s] > t * &dd[k]
            }
        };
        if !above {
            break;
        }
        s -= 1;
    }
    Ok((s, exact.map(|x| x.1.bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::{Budget, Limits};

    fn z(rows: &[&[i64]]) -> Vec<Vec<BigInt>> {
        rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    /// A knapsack-like basis: the identity, with a last column of `bits`-bit
    /// values (the shape of a recombination lattice), from an LCG.
    fn knapsack(d: usize, bits: u32, seed: &mut u64) -> Vec<Vec<BigInt>> {
        (0..d)
            .map(|i| {
                let mut r: Vec<BigInt> = (0..d).map(|j| BigInt::from((i == j) as i64)).collect();
                let mut v = BigInt::zero();
                for _ in 0..bits.div_ceil(32) {
                    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    v = (v << 32u32) + BigInt::from(*seed >> 32);
                }
                r.push(v >> (bits.div_ceil(32) * 32 - bits));
                r
            })
            .collect()
    }

    /// Today's cut, on the exact LLL's determinants.
    fn det_cut(dets: &[BigInt], t: &BigInt) -> usize {
        let mut s = dets.len() - 1;
        while s > 0 && dets[s] > t * &dets[s - 1] {
            s -= 1;
        }
        s
    }

    /// A stopped L^2 attempt leaves nothing allocated: with its result
    /// dropped, this thread's live bytes are those before the caller's copy,
    /// whether an entry passed the cap during the run (`Bits`, the cap at the
    /// input's largest entry) or no rung proved the result (`Precision`); the
    /// attempt ran (its work is debited) and the caller's rows are untouched.
    #[test]
    fn a_stopped_l2_attempt_leaves_nothing_allocated() {
        use crate::l2::{l2_budgeted_typed, L2Err, Stop};
        let mut seed = 0x51ed_270b_2731_4c5fu64;
        for (d, bits) in [(8usize, 60u32), (16, 120), (30, 400)] {
            let m = uniform(d, bits, &mut seed);
            let want = m.clone();
            let e = m.iter().flatten().map(|x| x.bits()).max().unwrap();
            for (force, cap) in [(Force::Auto, e), (Force::Precision, e + d as u64 + 64)] {
                FORCE.with(|f| f.set(force));
                let b = Budget::unlimited();
                let before = crate::alloc_spy::live();
                let r = l2_budgeted_typed(&b, m.clone(), cap);
                FORCE.with(|f| f.set(Force::Auto));
                let stopped = match &r {
                    Err(L2Err::Fallback(Stop::Bits { .. })) => "bits",
                    Err(L2Err::Fallback(Stop::Precision { .. })) => "precision",
                    Ok(_) => "reduced",
                    Err(_) => "refused",
                };
                drop(r);
                assert_eq!(crate::alloc_spy::live(), before, "d {d}: a stopped attempt ({stopped}) left allocations live");
                assert_eq!(stopped, if force == Force::Precision { "precision" } else { "bits" }, "d {d}, cap {cap}");
                assert!(b.work_left() < u64::MAX, "d {d}: the attempt ran");
                assert_eq!(m, want);
            }
        }
    }

    /// The caller's copy of its rows fits `l2_bytes`'s input term at the
    /// route's cap (`l2_input_bytes`), live and at its peak: small and
    /// large entries (limb boundaries, both signs, zeros) and shapes.
    #[test]
    fn the_callers_copy_fits_the_input_term() {
        let mut cases: Vec<Vec<Vec<BigInt>>> = vec![z(&[&[1, 0], &[0, 1]]), z(&[&[0, 0, 0], &[0, 0, 0]])];
        for &(d, bits) in &[(4usize, 1u32), (8, 63), (8, 64), (8, 65), (20, 200), (40, 1000), (12, 20000)] {
            let m: Vec<Vec<BigInt>> = (0..d)
                .map(|i| {
                    (0..d + 1)
                        .map(|j| {
                            let v = (BigInt::from(1) << (bits - 1)) + BigInt::from((i * 7 + j) as u64 % 2);
                            if (i + j) % 2 == 0 { v } else { -v }
                        })
                        .collect()
                })
                .collect();
            cases.push(m);
        }
        for m in cases {
            let (d, n) = (m.len(), m[0].len());
            let e = m.iter().flatten().map(|x| x.bits()).max().unwrap();
            let cap = l2_cap(d, e).unwrap();
            let bound = crate::l2::l2_input_bytes(d as u64, n as u64, cap).unwrap() as i64;
            let before = crate::alloc_spy::live();
            let (copy, peak) = crate::alloc_spy::peak_during(|| m.clone());
            let live = crate::alloc_spy::live() - before;
            assert!(live > 0 || m.iter().flatten().all(|x| x.bits() <= 64), "{d} x {n}: the copy allocated nothing");
            assert!(peak <= bound && live <= bound, "{d} x {n}, {e} bits: the copy's live {live} and peak {peak} bytes, the term {bound}");
            eprintln!("{d} x {n}, {e} bits: copy live {live}, peak {peak} of {bound} bytes");
            drop(copy);
        }
    }

    /// A d x d basis of random `bits`-bit entries of both signs, from an LCG.
    fn uniform(d: usize, bits: u32, seed: &mut u64) -> Vec<Vec<BigInt>> {
        (0..d)
            .map(|_| {
                (0..d)
                    .map(|_| {
                        let mut v = BigInt::zero();
                        for _ in 0..bits.div_ceil(32) {
                            *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                            v = (v << 32u32) + BigInt::from(*seed >> 32);
                        }
                        let v = v >> (bits.div_ceil(32) * 32 - bits);
                        if *seed & 1 == 0 { v } else { -v }
                    })
                    .collect()
            })
            .collect()
    }

    /// The route's and the cut's sizes fail closed: a shape whose figure
    /// doesn't fit in u64 gives None (the exact LLL), never a wrapped one.
    #[test]
    fn the_route_sizes_fail_closed() {
        let rows = |d: usize, w: usize, c: u64| (d as u64).checked_mul(w as u64)?.checked_mul(c / 8 + 32);
        assert_eq!(l2_cap(1, u64::MAX), None);
        assert_eq!(l2_cap(usize::MAX, u64::MAX - 63), None);
        // (the row length enters only through its logarithm)
        for (d, w, c) in [(usize::MAX, 1, 1), (1, 1, u64::MAX), (1 << 32, 1 << 32, 64), (1 << 20, 1, u64::MAX / 4)] {
            assert_eq!(cut_bytes(d, w, c), None, "{d} {w} {c}");
            assert_eq!(cut_exact_bytes(d, w, c), None, "{d} {w} {c}");
        }
        assert_eq!(l2_route(usize::MAX, 1, 1, 0, rows), None);
        assert_eq!(l2_route(10, 10, u64::MAX - 10, 0, rows), None);
        // held near u64::MAX: the sums overflow, so the exact LLL
        assert_eq!(l2_route(10, 11, 100, u64::MAX - 10, rows), None);
        // an ordinary shape takes the route, with its heuristic cap
        let r = l2_route(40, 41, 256, 1000, rows).unwrap();
        assert_eq!(r.cap, 256 + 40 + 64);
        assert!(r.state > 0 && r.kept > 0);
    }

    /// The typed L^2 entry: a cap below the entries and an unproved result
    /// fall back; the work limit is a refusal, never a fallback, and its work
    /// stays debited.
    #[test]
    fn l2_stops_are_typed() {
        use crate::l2::{l2_budgeted_typed, L2Err, Stop};
        let mut seed = 7u64;
        let m = knapsack(12, 80, &mut seed);
        let e = m.iter().flatten().map(|x| x.bits()).max().unwrap();
        let b = Budget::unlimited();
        assert!(matches!(l2_budgeted_typed(&b, m.clone(), e - 1), Err(L2Err::Fallback(Stop::Bits { .. }))));
        FORCE.with(|f| f.set(Force::Precision));
        let r = l2_budgeted_typed(&b, m.clone(), e + 100);
        FORCE.with(|f| f.set(Force::Auto));
        assert!(matches!(r, Err(L2Err::Fallback(Stop::Precision { .. }))));
        let b = Budget::new(Limits { work: 50, ..Limits::UNLIMITED });
        match l2_budgeted_typed(&b, m.clone(), e + 100) {
            Err(L2Err::Refused(x)) => assert_eq!(x.what, "l2 work"),
            r => panic!("expected the work refusal, got {:?}", r.map(|v| v.len())),
        }
        assert!(b.work_left() < 50, "the attempt's work is debited");
        assert!(l2_budgeted_typed(&Budget::unlimited(), m, e + 100).is_ok());
    }

    /// `cut` keeps exactly the rows the determinant cut keeps, by its
    /// interval stages and by its exact stage alone, ties included; and its
    /// allocations stay within cut_bytes (+ cut_exact_bytes for the exact
    /// stage).
    #[test]
    fn cut_agrees_with_the_determinant_cut() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut cases: Vec<Vec<Vec<BigInt>>> = vec![z(&[&[2, 0, 0], &[0, 3, 0], &[0, 0, 4]])];
        for &(d, bits) in &[(4usize, 20u32), (8, 60), (12, 200), (16, 100), (24, 400)] {
            cases.push(knapsack(d, bits, &mut seed));
        }
        let mut decided_by_intervals = 0;
        for m in cases {
            let e = m.iter().flatten().map(|x| x.bits()).max().unwrap();
            let cap = cap_bits(m.len(), e).unwrap();
            let r = lll(&Budget::unlimited(), m, cap).unwrap();
            let (d, w) = (r.basis.len(), r.basis[0].len());
            let c = r.basis.iter().flatten().map(|x| x.bits()).max().unwrap();
            // thresholds around and at every |b*_k|^2
            let mut ts = vec![BigInt::zero(), BigInt::from(1)];
            for k in 0..d {
                let q = &r.d[k + 1] / &r.d[k];
                ts.extend([q.clone() - BigInt::from(1), q.clone(), q + BigInt::from(1)]);
            }
            for t in ts.iter().filter(|t| !t.is_negative()) {
                let want = det_cut(&r.d, t);
                for exact_only in [false, true] {
                    CUT_EXACT_ONLY.with(|x| x.set(exact_only));
                    let b = Budget::unlimited();
                    let ((got, _), peak) = crate::alloc_spy::peak_during(|| cut(&b, &r.basis, t, c).unwrap());
                    CUT_EXACT_ONLY.with(|x| x.set(false));
                    assert_eq!(got, want, "d {d}, t {t}, exact only {exact_only}");
                    let bound = cut_bytes(d, w, c).unwrap() + if exact_only { cut_exact_bytes(d, w, c).unwrap() } else { 0 };
                    if !exact_only && b.peak() == 0 {
                        decided_by_intervals += 1;
                    }
                    assert!(peak <= bound as i64, "d {d}, t {t}: peak {peak} > {bound}");
                }
            }
        }
        assert!(decided_by_intervals > 0);
    }

    fn sq(v: &[BigInt]) -> BigInt {
        v.iter().map(|x| x * x).sum()
    }

    #[test]
    fn reduces_and_keeps_the_lattice() {
        let b = Budget::default();
        // a knapsack-like basis: the short vector (1, 1, -1, 0) * stuff
        let m = z(&[&[1, 0, 0, 1000], &[0, 1, 0, 1031], &[0, 0, 1, 2031], &[0, 0, 0, 100003]]);
        let r = lll(&b, m.clone(), cap_bits(4, 20).unwrap()).unwrap();
        // the first vector is short: (1, 1, -1, 0) up to sign
        assert_eq!(sq(&r.basis[0]), BigInt::from(3));
        // same determinant (the d_n is the Gram determinant)
        assert_eq!(r.d[4], BigInt::from(100003i64 * 100003));
        // the d_i match the Gram-Schmidt norms recomputed exactly: d_1 = |b_1|^2
        assert_eq!(r.d[1], sq(&r.basis[0]));
        assert!(b.debited(crate::budget::Phase::Admission));
    }

    #[test]
    fn refuses_when_values_exceed_the_cap() {
        let b = Budget::default();
        let m = z(&[&[1, 0, 1 << 40], &[0, 1, (1 << 40) + 7], &[0, 0, 1 << 45]]);
        let e = lll(&b, m.clone(), 30).err().unwrap();
        assert!(e.what.starts_with("lll bits"), "{e}");
        // and works with room, the next call unaffected
        assert!(lll(&b, m, cap_bits(3, 46).unwrap()).is_ok());
    }

    #[test]
    fn refuses_when_work_runs_out() {
        let b = Budget::new(Limits { work: 10, ..Limits::DEFAULT });
        let m = z(&[&[1, 0, 1 << 20], &[0, 1, (1 << 20) + 7], &[0, 0, 1 << 25]]);
        assert_eq!(lll(&b, m, cap_bits(3, 26).unwrap()).err().unwrap().what, "work");
    }

    /// The leading principal minors of the Gram matrix, by fraction-free
    /// elimination: d_1, ..., d_n.
    fn gram_dets(m: &[Vec<BigInt>]) -> Vec<BigInt> {
        let n = m.len();
        let mut g: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| m[i].iter().zip(&m[j]).map(|(x, y)| x * y).sum()).collect()).collect();
        let mut out = vec![];
        let mut prev = BigInt::from(1);
        for k in 0..n {
            out.push(g[k][k].clone());
            for i in k + 1..n {
                for j in k + 1..n {
                    g[i][j] = (&g[k][k] * &g[i][j] - &g[i][k] * &g[k][j]) / &prev;
                }
            }
            prev = g[k][k].clone();
        }
        out
    }

    #[test]
    fn gram_determinants_are_exact() {
        // knapsack-shaped random lattices: identity plus large columns
        let mut seed = 12345u64;
        let mut rnd = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m
        };
        for trial in 0..20 {
            let r = 4 + trial % 9;
            let cols = 1 + trial % 3;
            let mut m: Vec<Vec<BigInt>> = vec![];
            for i in 0..r {
                let mut row: Vec<BigInt> = (0..r).map(|j| BigInt::from((i == j) as u32)).collect();
                for _ in 0..cols {
                    row.push(BigInt::from(rnd(1 << 40)));
                }
                m.push(row);
            }
            for c in 0..cols {
                let mut row = vec![BigInt::zero(); r + cols];
                row[r + c] = BigInt::from((1u64 << 40) + 15);
                m.push(row);
            }
            let b = Budget::default();
            let red = lll(&b, m.clone(), cap_bits(m.len(), 42).unwrap()).unwrap();
            let want = gram_dets(&red.basis);
            assert_eq!(&red.d[1..], &want[..], "trial {}", trial);
            // same lattice volume
            assert_eq!(red.d.last(), gram_dets(&m).last());
        }
    }
}
