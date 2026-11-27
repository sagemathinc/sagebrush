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
    forced(L2Route { cap, state, kept }, e)
}

/// The L^2 route for a caller with no cut (`reduce`), or None for the exact
/// LLL. The caller's rows stay charged through either route, so their whole
/// peaks are the rows with L^2's state and the rows with the exact LLL's
/// state: L^2 is chosen when its state is no larger. The choice is made
/// before L^2 runs, never by retrying after a refusal. Every term is
/// checked; one that doesn't fit in u64 gives the exact LLL. (`kept` is 0:
/// there is no cut.)
pub fn l2_route_plain(d: usize, w: usize, e: u64) -> Option<L2Route> {
    #[cfg(test)]
    if FORCE.with(|f| f.get()) == Force::Exact {
        return None;
    }
    let cap = l2_cap(d, e)?;
    let state = crate::l2::l2_bytes(d, w, cap)?;
    let lx = lattice_bytes(d, w, cap_bits(d, e)?)?;
    if state > lx {
        return None;
    }
    forced(L2Route { cap, state, kept: 0 }, e)
}

/// The route as chosen, or (tests) made to stop: a cap below the input's
/// entries, or at the largest of them.
#[allow(unused_variables)]
fn forced(r: L2Route, e: u64) -> Option<L2Route> {
    #[cfg(test)]
    if FORCE.with(|f| f.get()) == Force::Bits {
        // below the largest input entry: L^2 stops at its entry check
        return Some(L2Route { cap: e.checked_sub(1)?, ..r });
    }
    #[cfg(test)]
    if FORCE.with(|f| f.get()) == Force::BitsInRun {
        // no entry may grow past the input's largest
        return Some(L2Route { cap: e, ..r });
    }
    Some(r)
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

/// Bytes for d rows of w big integers of at most `bits` bits (the rows'
/// own charge in `reduce`).
pub fn basis_bytes(d: usize, w: usize, bits: u64) -> Option<u64> {
    (d as u64).checked_mul(w as u64)?.checked_mul(big_bytes(bits)?)?.checked_add((d as u64).checked_mul(48)?)
}

/// LLL-reduce the rows (independent, of one length) within `b`, for a
/// caller with no cut: the rows are charged first, then [`reduce_held`].
pub fn reduce(b: &Budget, rows: Vec<Vec<BigInt>>) -> FResult<Vec<Vec<BigInt>>> {
    let (d, w) = (rows.len(), rows.first().map_or(0, |r| r.len()));
    let e = rows.iter().map(|x| crate::maxbits(x)).max().unwrap_or(0);
    let held = b.reserve(basis_bytes(d, w, e))?;
    Ok(reduce_held(b, rows, held)?.0)
}

/// Shrink `r` in place to `bytes`: never an unreserved instant, and never a
/// grow (`Reservation::shrink` saturates when asked to grow, which would
/// leave memory under-reserved): a target above the reservation is an
/// internal error.
pub fn shrink_to(b: &Budget, r: &mut crate::budget::Reservation<'_>, bytes: Option<u64>) -> FResult<()> {
    match bytes {
        Some(x) if x <= r.bytes() => {
            r.shrink(x);
            Ok(())
        }
        _ => Err(b.internal("lll: a reservation asked to grow by shrinking")),
    }
}

/// [`reduce`] with the rows already charged by `held` (the caller reserved
/// them before making them). On the L^2 route (`l2_route_plain`), L^2's state
/// is reserved, then L^2 runs on a copy while the rows stay charged; when it
/// stops on its cap or its proof, its state is gone and the exact LLL starts
/// over from the rows (its state reserved before the rows' charge is handed
/// to it). Every other stop ends the call. Returns the reduced rows with
/// their reservation: the route's state, shrunk in place to the rows'
/// `basis_bytes` (so they stay charged until the caller is done with them).
pub fn reduce_held<'a>(b: &'a Budget, rows: Vec<Vec<BigInt>>, held: crate::budget::Reservation<'a>) -> FResult<(Vec<Vec<BigInt>>, crate::budget::Reservation<'a>)> {
    let d = rows.len();
    if d < 2 {
        // handed back as they are, their list made exact first
        let mut rows = rows;
        compact_rows(b, &mut rows)?;
        return Ok((rows, held));
    }
    let w = rows[0].len();
    let overflow = || b.refuse("work (overflow)", u64::MAX, b.work_left());
    let entries = (d as u64).checked_mul(w as u64).and_then(|x| x.checked_add(1)).ok_or_else(overflow)?;
    // the entries' sizes, and the output's after the reduction
    b.debit(Some(entries))?;
    let e = rows.iter().map(|x| crate::maxbits(x)).max().unwrap_or(0);
    let out = |basis: &Vec<Vec<BigInt>>| -> FResult<Option<u64>> {
        b.debit(Some(entries))?;
        Ok(basis_bytes(d, w, basis.iter().map(|x| crate::maxbits(x)).max().unwrap_or(0)))
    };
    if let Some(rt) = l2_route_plain(d, w, e) {
        let mut state = b.reserve(Some(rt.state))?;
        // L^2 runs on a copy: its limbs
        let limbs_sum = rows.iter().flatten().try_fold(0u64, |s, x| s.checked_add(limbs(x.bits()))).ok_or_else(overflow)?;
        b.debit(limbs_sum.checked_add(entries))?;
        let r = crate::l2::l2_budgeted_typed(b, rows.clone(), rt.cap);
        match r {
            Ok(mut basis) => {
                #[cfg(test)]
                L2_REDUCED.with(|c| c.set(c.get() + 1));
                // the output rows, their list shrunk to them within L^2's
                // state, which then shrinks to them (L^2 returns the copy
                // made above, of exactly d rows: no slack today)
                compact_rows(b, &mut basis)?;
                shrink_to(b, &mut state, out(&basis)?)?;
                drop(held);
                return Ok((basis, state));
            }
            Err(crate::l2::L2Err::Fallback(_)) => {
                drop(state);
                #[cfg(test)]
                FALLBACKS.with(|c| c.set(c.get() + 1));
            }
            Err(crate::l2::L2Err::Refused(e)) => return Err(e),
        }
    }
    let cap = cap_bits(d, e).ok_or_else(|| b.refuse("lll bits (overflow)", u64::MAX, 0))?;
    let mut l = b.reserve(lattice_bytes(d, w, cap))?;
    drop(held);
    let mut r = lll(b, rows, cap)?;
    // the output rows, their list shrunk to them within the lattice's
    // reservation, which then shrinks to them (the exact LLL works in the
    // caller's list, which may have room to spare)
    compact_rows(b, &mut r.basis)?;
    shrink_to(b, &mut l, out(&r.basis)?)?;
    Ok((r.basis, l))
}

/// The prime of [`rank_mod_p`]'s callers: the largest below 2^62.
pub const RANK_PRIME: u64 = (1 << 62) - 57;

/// Bytes [`rank_mod_p`] reserves for r rows of n entries: the residue rows
/// (r vectors of n words), the outer vector and the used-row flags.
pub fn rank_bytes(r: usize, n: usize) -> Option<u64> {
    let (r, n) = (r as u64, n as u64);
    r.checked_mul(n.checked_mul(8)?.checked_add(24)?)?.checked_add(24)?.checked_add(r)
}

/// The rank of the rows modulo the prime `p` (below 2^62), within `b`: a
/// lower bound for their rank over Q, so rank r proves them independent. The
/// residue rows, the outer vector and the flags (`rank_bytes`) are reserved
/// before they are allocated: the elimination works in place in them, with
/// u128 products in registers. Work, debited before each stage: the
/// entries' sizes (one per entry), the residues (the rows' limbs, and one
/// per entry), then the elimination
/// (r n min(r, n) updates, r n for the pivot searches, 130 per pivot for its
/// inverse: a word Euclid's steps). An interrupt is checked per pivot.
pub fn rank_mod_p(b: &Budget, rows: &[Vec<BigInt>], p: u64) -> FResult<usize> {
    let r = rows.len();
    let n = rows.first().map_or(0, |x| x.len());
    if r == 0 || n == 0 {
        return Ok(0);
    }
    let overflow = || b.refuse("work (overflow)", u64::MAX, b.work_left());
    let (r64, n64) = (r as u64, n as u64);
    // the metadata scan (bits() per entry) is debited before it runs
    b.debit(r64.checked_mul(n64).and_then(|x| x.checked_add(1)))?;
    let limbs_sum = rows.iter().flatten().try_fold(0u64, |s, x| s.checked_add(limbs(x.bits()))).ok_or_else(overflow)?;
    b.debit(limbs_sum.checked_add(r64.checked_mul(n64).ok_or_else(overflow)?).and_then(|x| x.checked_add(1)))?;
    let _res = b.reserve(rank_bytes(r, n))?;
    let mut a: Vec<Vec<u64>> = Vec::with_capacity(r);
    for row in rows {
        let mut v = Vec::with_capacity(n);
        v.extend(row.iter().map(|x| sagebrush_bigint::rem_u64(x, p)));
        a.push(v);
    }
    let mut used = vec![false; r];
    let k = r64.min(n64);
    let elim = r64.checked_mul(n64).and_then(|x| x.checked_mul(k)).and_then(|x| x.checked_add(r64.checked_mul(n64)?)).and_then(|x| x.checked_add(k.checked_mul(130)?)).and_then(|x| x.checked_add(1));
    b.debit(Some(elim.ok_or_else(overflow)?))?;
    let (pm, mut rank) = (p as u128, 0usize);
    for c in 0..n {
        sagebrush_interrupt::check();
        let Some(piv) = (0..r).find(|&i| !used[i] && a[i][c] != 0) else { continue };
        used[piv] = true;
        rank += 1;
        let inv = inv_mod(a[piv][c], p) as u128;
        for x in a[piv].iter_mut() {
            *x = ((*x as u128 * inv) % pm) as u64;
        }
        for i in 0..r {
            if i == piv || a[i][c] == 0 {
                continue;
            }
            let f = a[i][c] as u128;
            // row i and the pivot row, borrowed apart
            let (lo, hi) = a.split_at_mut(i.max(piv));
            let (row, pr) = if i < piv { (&mut lo[i], &hi[0]) } else { (&mut hi[0], &lo[piv]) };
            for (x, &y) in row.iter_mut().zip(pr.iter()) {
                let t = (f * y as u128) % pm;
                *x = ((*x as u128 + pm - t) % pm) as u64;
            }
        }
    }
    Ok(rank)
}

/// a^-1 mod p (a nonzero mod p, p prime below 2^62): the extended Euclidean
/// algorithm on words.
fn inv_mod(a: u64, p: u64) -> u64 {
    let (mut r0, mut r1) = (p as i128, a as i128);
    let (mut t0, mut t1) = (0i128, 1i128);
    while r1 != 0 {
        let q = r0 / r1;
        (r0, r1) = (r1, r0 - q * r1);
        (t0, t1) = (t1, t0 - q * t1);
    }
    t0.rem_euclid(p as i128) as u64
}

/// Make the rows' list and each row exactly as long as their contents,
/// before a reservation shrinks to them: a list or row with room to spare
/// keeps that capacity otherwise. Each goes through a boxed slice, whose
/// length is exact by type, and every capacity is then checked against its
/// length (an internal error otherwise), so the bound holds by contract,
/// not by the allocator's behavior. (The entries need nothing: the default
/// big-integer backend keeps every value within its compact capacity, which
/// `big_bytes` covers.) The caller's larger reservation still covers the old
/// buffers and one new one at a time; the work, a move per entry and per row,
/// is debited first.
pub fn compact_rows(b: &Budget, rows: &mut Vec<Vec<BigInt>>) -> FResult<()> {
    let overflow = || b.refuse("work (overflow)", u64::MAX, b.work_left());
    let entries = rows.iter().try_fold(0u64, |s, r| s.checked_add(r.len() as u64)).ok_or_else(overflow)?;
    debit_at(b, "compact", entries.checked_add(rows.len() as u64).and_then(|x| x.checked_add(1)))?;
    for row in rows.iter_mut() {
        if row.capacity() != row.len() {
            *row = std::mem::take(row).into_boxed_slice().into_vec();
        }
    }
    if rows.capacity() != rows.len() {
        *rows = std::mem::take(rows).into_boxed_slice().into_vec();
    }
    if rows.capacity() != rows.len() || rows.iter().any(|r| r.capacity() != r.len()) {
        return Err(b.internal("lll: a compacted list kept spare capacity"));
    }
    Ok(())
}

/// Bytes [`hnf_budgeted`] holds for r rows of n entries of at most c bits:
/// the working rows (`basis_bytes`), the pivot row's copy, the quotient, a
/// product q y and an entry's new value while its old one is live.
pub fn hnf_bytes(r: usize, n: usize, c: u64) -> Option<u64> {
    let state = basis_bytes(r, n, c)?;
    let pivot = (n as u64).checked_mul(big_bytes(c)?)?.checked_add(24)?;
    state.checked_add(pivot)?.checked_add(big_bytes(c)?.checked_mul(3)?)
}

#[cfg(test)]
thread_local! {
    /// Tests: when set, each of [`hnf_budgeted`]'s debits is recorded as
    /// (its site, the work left before it), so a test can stop at each.
    pub static HNF_TRACE: std::cell::RefCell<Option<Vec<(&'static str, u64)>>> = const { std::cell::RefCell::new(None) };
}

/// Debit `units` at `site` (recorded in tests).
fn debit_at(b: &Budget, _site: &'static str, units: Option<u64>) -> FResult<()> {
    #[cfg(test)]
    HNF_TRACE.with(|t| {
        if let Some(v) = t.borrow_mut().as_mut() {
            v.push((_site, b.work_left()));
        }
    });
    b.debit(units)
}

/// The Hermite form of the rows' lattice (upper triangular, rank many
/// rows, positive pivots, entries above a pivot reduced to [0, pivot)) within
/// a budget, for `api::lll`'s dependent inputs: the elimination of the
/// classgroup crate's `zlin::hnf`. A bound c on the entries' bits starts at
/// the input's and grows as the elimination needs: before a row update
/// x -= q y, max(x's row's largest entry, bits(q) + the pivot row's
/// largest entry) + 1 bounds its products and its entries, and a larger bound
/// reserves the difference of `hnf_bytes` first (merged into the one
/// reservation), so growth refuses as memory. Work is debited before each
/// step, by limb-based estimates of what it reads, copies and multiplies:
/// the entries' sizes, the
/// copy of the rows, each pivot search (its comparisons), quotient, bound
/// check, row update (n (limbs(q) limbs(c) + 3 limbs(c) + 1) at the grown
/// bound c: the product, the subtraction and the pivot row's copy), sign
/// normalization and zero-row scan, the compaction and the output's sizes.
/// Returns the
/// rows (their list shrunk to them, `compact_rows`), their reservation shrunk
/// in place to their `basis_bytes`, and the
/// final bound.
pub fn hnf_budgeted<'a>(b: &'a Budget, rows: &[Vec<BigInt>]) -> FResult<(Vec<Vec<BigInt>>, crate::budget::Reservation<'a>, u64)> {
    let (r0, n) = (rows.len(), rows.first().map_or(0, |r| r.len()));
    let overflow = || b.refuse("work (overflow)", u64::MAX, b.work_left());
    let entries = (r0 as u64).checked_mul(n as u64).and_then(|x| x.checked_add(1)).ok_or_else(overflow)?;
    // the entries' sizes (bits() per entry), then a copy of every limb
    debit_at(b, "sizes", Some(entries))?;
    let mut c = rows.iter().map(|r| crate::maxbits(r)).max().unwrap_or(0);
    let limbs_sum = rows.iter().flatten().try_fold(0u64, |s, x| s.checked_add(limbs(x.bits()))).ok_or_else(overflow)?;
    let mut res = b.reserve(hnf_bytes(r0, n, c))?;
    debit_at(b, "copy", entries.checked_mul(2).and_then(|x| x.checked_add(limbs_sum)))?;
    // the nonzero rows, in a list of exactly their number (a scan to count
    // them, then one to copy them: both in the copy's debit)
    let nonzero = |r: &&Vec<BigInt>| r.iter().any(|x| !x.is_zero());
    let mut a: Vec<Vec<BigInt>> = Vec::with_capacity(rows.iter().filter(nonzero).count());
    a.extend(rows.iter().filter(nonzero).cloned());
    // a[i] -= q a[piv], the bound grown (reserved) first
    let mut update = |a: &mut Vec<Vec<BigInt>>, i: usize, piv: usize, q: &BigInt, c: &mut u64| -> FResult<()> {
        // the two rows' sizes
        debit_at(b, "bound", (n as u64).checked_mul(2).and_then(|x| x.checked_add(1)))?;
        // |x - q y| < 2^bits(x) + 2^(bits(q) + bits(y)), for the rows below
        // the pivot and the upward reduction of the rows above it alike
        let need = q.bits().checked_add(crate::maxbits(&a[piv])).map(|x| x.max(crate::maxbits(&a[i]))).and_then(|x| x.checked_add(1));
        let need = need.ok_or_else(|| b.refuse("memory (overflow)", u64::MAX, 0))?;
        if need > *c {
            let more = hnf_bytes(r0, n, need).and_then(|x| x.checked_sub(hnf_bytes(r0, n, *c)?));
            let mut more = b.reserve(more)?;
            res.merge(&mut more)?;
            *c = need;
        }
        // per entry: the product, the subtraction and the pivot row's copy
        // (limb-based estimates), and the bound check after
        let lc = limbs(*c);
        let per = limbs(q.bits()).checked_mul(lc).and_then(|x| x.checked_add(lc.checked_mul(3)?)).and_then(|x| x.checked_add(1)).ok_or_else(overflow)?;
        debit_at(b, "update", Some((n as u64).checked_mul(per).ok_or_else(overflow)?))?;
        let pr = a[piv].clone();
        for (x, y) in a[i].iter_mut().zip(&pr) {
            *x -= q * y;
        }
        if crate::maxbits(&a[i]) > *c {
            return Err(b.internal("lll: a Hermite row passed its bound"));
        }
        Ok(())
    };
    let quotient = |x: &BigInt, d: &BigInt| -> FResult<BigInt> {
        debit_at(b, "quotient", limbs(x.bits()).checked_mul(limbs(d.bits())).and_then(|u| u.checked_add(1)))?;
        Ok(x.div_floor(d))
    };
    let mut r = 0;
    for col in 0..n {
        loop {
            sagebrush_interrupt::check();
            // each comparison reads (and copies, as magnitudes, within the
            // transients of `hnf_bytes`) two entries of at most c bits
            let below = (a.len() - r.min(a.len())) as u64 + 1;
            debit_at(b, "pivot search", below.checked_mul(limbs(c).checked_mul(2).ok_or_else(overflow)?.checked_add(1).ok_or_else(overflow)?))?;
            // the smallest nonzero entry of the column at or below r
            let best = (r..a.len()).filter(|&i| !a[i][col].is_zero()).min_by(|&i, &j| a[i][col].abs().cmp(&a[j][col].abs()));
            let Some(bi) = best else { break };
            a.swap(r, bi);
            let mut clean = true;
            for i in r + 1..a.len() {
                if a[i][col].is_zero() {
                    continue;
                }
                let q = quotient(&a[i][col], &a[r][col])?;
                update(&mut a, i, r, &q, &mut c)?;
                if !a[i][col].is_zero() {
                    clean = false;
                }
            }
            if clean {
                break;
            }
        }
        if r >= a.len() || a[r][col].is_zero() {
            continue;
        }
        if a[r][col].is_negative() {
            debit_at(b, "sign", (n as u64).checked_mul(limbs(c)).and_then(|x| x.checked_add(1)))?;
            for x in a[r].iter_mut() {
                *x = -&*x;
            }
        }
        for i in 0..r {
            let q = quotient(&a[i][col], &a[r][col])?;
            if !q.is_zero() {
                update(&mut a, i, r, &q, &mut c)?;
            }
        }
        r += 1;
        debit_at(b, "zero rows", (a.len() as u64).checked_mul(n as u64).and_then(|x| x.checked_add(1)))?;
        a.retain(|row| row.iter().any(|x| !x.is_zero()));
        if r >= a.len() {
            break;
        }
    }
    a.truncate(r);
    drop(update);
    // the rows' list shrunk to them (`compact_rows`) while the whole
    // reservation still covers it, then the rows handed off at their size
    compact_rows(b, &mut a)?;
    debit_at(b, "output sizes", (r as u64).checked_mul(n as u64).and_then(|x| x.checked_add(1)))?;
    let eh = a.iter().map(|x| crate::maxbits(x)).max().unwrap_or(0);
    shrink_to(b, &mut res, basis_bytes(r, n, eh))?;
    Ok((a, res, c))
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

    /// `reduce` (callers with no cut, such as `matrix.LLL()`): every route
    /// gives a certified reduced basis of the input's lattice (the exact
    /// certificate: the same lattice, (0.51, 0.99)-reduced); a forced stop
    /// on the cap (at the entry, or after the run) or on the proof falls back
    /// to the exact LLL from the original rows; nothing stays reserved and
    /// the thread's live heap is back where it was; a work limit refuses
    /// without falling back.
    #[test]
    fn reduce_certifies_every_route() {
        let mut seed = 0x0bad_5eed_1234_5678u64;
        let count = || (FALLBACKS.with(|c| c.get()), L2_REDUCED.with(|c| c.get()));
        let mut any_routed = false;
        for &(d, bits) in &[(6usize, 30u32), (16, 120), (30, 400)] {
            let m = knapsack(d, bits, &mut seed);
            let (w, e) = (m[0].len(), m.iter().flatten().map(|x| x.bits()).max().unwrap());
            let routed = l2_route_plain(d, w, e).is_some();
            any_routed |= routed;
            for force in [Force::Auto, Force::Exact, Force::Bits, Force::BitsInRun, Force::Precision] {
                FORCE.with(|f| f.set(force));
                let (fb0, l20) = count();
                let b = Budget::unlimited();
                let before = crate::alloc_spy::live();
                let out = reduce(&b, m.clone());
                FORCE.with(|f| f.set(Force::Auto));
                let out = out.unwrap();
                assert_eq!(crate::lll_cert::certify(&m, &out, (51, 100), (99, 100)), Ok(()), "d {d}, {force:?}");
                assert_eq!(b.live(), 0, "d {d}, {force:?}");
                drop(out);
                assert_eq!(crate::alloc_spy::live(), before, "d {d}, {force:?}: allocations left live");
                let (fb, l2) = count();
                let (fb, l2) = (fb - fb0, l2 - l20);
                let want = match (force, routed) {
                    (Force::Exact, _) | (_, false) => (0, 0),
                    (Force::Auto, true) => (0, 1),
                    _ => (1, 0),
                };
                assert_eq!((fb, l2), want, "d {d}, {force:?}, routed {routed}");
            }
        }
        assert!(any_routed, "no case took the L^2 route");
        // the work limit ends the call: L^2's own refusal, not a fallback
        let m = knapsack(16, 120, &mut seed);
        let e = m.iter().flatten().map(|x| x.bits()).max().unwrap();
        assert!(l2_route_plain(16, 17, e).is_some(), "the work witness must take the L^2 route");
        // past reduce_held's own debits (the sizes, the copy's limbs), short
        // in L^2
        let entries = 16 * 17 + 1;
        let copy: u64 = m.iter().flatten().map(|x| limbs(x.bits())).sum::<u64>() + entries;
        let b = Budget::new(Limits { work: entries + copy + 10, ..Limits::UNLIMITED });
        let fb0 = FALLBACKS.with(|c| c.get());
        let e = reduce(&b, m).unwrap_err();
        assert_eq!(e.what, "l2 work", "{e}");
        assert_eq!(FALLBACKS.with(|c| c.get()), fb0, "a work refusal fell back");
        assert_eq!(b.live(), 0);
    }

    /// `reduce`'s memory admission is never worse than the exact LLL's: for
    /// each shape, the exact LLL's whole peak (the rows held with its state)
    /// admits; so does the chosen route's own peak, and exactly that peak is
    /// the Budget's; one byte less refuses with a memory refusal; nothing
    /// stays reserved and the live heap is back where it was. One shape is
    /// rows (identity | 10^60 + i), whose L^2 state is larger than the
    /// exact LLL's, so the exact LLL runs; one takes the L^2 route.
    #[test]
    fn reduce_admits_what_the_exact_lll_admits() {
        let big = BigInt::from(10u32).pow(60);
        let wide: Vec<Vec<BigInt>> = (0..5u64)
            .map(|i| {
                let mut r: Vec<BigInt> = (0..5u64).map(|j| BigInt::from((i == j) as u8)).collect();
                r.push(&big + BigInt::from(i));
                r
            })
            .collect();
        let mut seed = 0x5eed_0f_ad_15_51_0bu64;
        let mut kinds = vec![];
        for m in [wide, knapsack(30, 400, &mut seed)] {
            let (d, w) = (m.len(), m[0].len());
            let e = m.iter().flatten().map(|x| x.bits()).max().unwrap();
            let h = basis_bytes(d, w, e).unwrap();
            let lx = lattice_bytes(d, w, cap_bits(d, e).unwrap()).unwrap();
            let route = l2_route_plain(d, w, e);
            kinds.push(route.is_some());
            let peak = h + route.map_or(lx, |r| r.state);
            assert!(peak <= h + lx, "d {d}: the chosen route's peak is above the exact LLL's");
            for (limit, admits) in [(h + lx, true), (peak, true), (peak - 1, false)] {
                let b = Budget::new(Limits { memory: limit, ..Limits::UNLIMITED });
                let before = crate::alloc_spy::live();
                let r = reduce(&b, m.clone());
                if admits {
                    let out = r.unwrap_or_else(|e| panic!("d {d}, limit {limit}: {e}"));
                    assert_eq!(crate::lll_cert::certify(&m, &out, (51, 100), (99, 100)), Ok(()), "d {d}");
                    assert_eq!(b.peak(), peak, "d {d}: the Budget's peak");
                } else {
                    let e = r.unwrap_err();
                    assert_eq!(e.what, "memory", "d {d}: {e}");
                    assert_eq!(e.need - e.remaining, 1, "d {d}: {e}");
                }
                assert_eq!(b.live(), 0);
                assert_eq!(crate::alloc_spy::live(), before, "d {d}, limit {limit}: allocations left live");
            }
        }
        assert_eq!(kinds, vec![false, true], "one exact shape, one L^2 shape");
    }

    /// An LLL reduction's refusals name it: a resource limit starts "LLL:"
    /// and ends "not reduced", with the memory share as "this reduction's";
    /// an internal error starts with its own recognized prefix; a
    /// factorization's wording is unchanged.
    #[test]
    fn lll_refusals_name_the_reduction() {
        let b = Budget::new(Limits { memory: 1000, ..Limits::UNLIMITED });
        let r = b.refuse("memory", 2000, 1000);
        let m = r.message(&crate::budget::LLL);
        assert!(m.starts_with("LLL: resource limit exceeded (memory in ") && m.ends_with("); not reduced"), "{m}");
        assert_eq!(r.to_string(), r.message(&crate::budget::FACTOR));
        assert!(r.to_string().starts_with("factor: resource limit exceeded") && r.to_string().ends_with("); not factored"));
        let i = b.internal("an invariant").message(&crate::budget::LLL);
        assert!(i.starts_with(crate::budget::LLL_INTERNAL_PREFIX) && i.contains("please report it") && i.ends_with("not reduced"), "{i}");
    }

    /// The route's and the cut's sizes fail closed: a shape whose figure
    /// doesn't fit in u64 gives None (the exact LLL), never a wrapped one.
    #[test]
    fn the_route_sizes_fail_closed() {
        let rows = |d: usize, w: usize, c: u64| (d as u64).checked_mul(w as u64)?.checked_mul(c / 8 + 32);
        assert_eq!(l2_cap(1, u64::MAX), None);
        assert_eq!(l2_cap(usize::MAX, u64::MAX - 63), None);
        // (a shape past a 32-bit usize only where usize holds it; the widest
        // a 32-bit one holds there)
        #[cfg(target_pointer_width = "64")]
        const WIDE: &[(usize, usize, u64)] = &[(1 << 32, 1 << 32, 64)];
        #[cfg(not(target_pointer_width = "64"))]
        const WIDE: &[(usize, usize, u64)] = &[(usize::MAX, usize::MAX, 64)];
        // (the row length enters only through its logarithm)
        for &(d, w, c) in [(usize::MAX, 1, 1), (1, 1, u64::MAX), (1 << 20, 1, u64::MAX / 4)].iter().chain(WIDE) {
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

    /// rank_mod_p's residues: x mod p in [0, p) for zero, positive and
    /// negative multi-limb entries, a negative one with remainder 0 included.
    #[test]
    fn rank_residues_of_signed_multi_limb_entries() {
        use num_integer::Integer;
        let p = RANK_PRIME;
        let pb = BigInt::from(p);
        let big = BigInt::from(3u32).pow(150) + BigInt::from(7u32);
        for x in [BigInt::zero(), BigInt::from(5u32), big.clone(), -big.clone(), -(&pb << 100u32), &pb * BigInt::from(9u32)] {
            let want = x.mod_floor(&pb);
            assert_eq!(BigInt::from(sagebrush_bigint::rem_u64(&x, p)), want, "{x}");
        }
        // -(p 2^100) has remainder 0, so this row is zero mod p
        let m = vec![vec![-(&pb << 100u32), BigInt::zero()], vec![BigInt::zero(), -big]];
        assert_eq!(rank_mod_p(&Budget::default(), &m, p), Ok(1));
    }

    /// The rank modulo p: full on independent rows, short on dependent ones
    /// (with negative and multi-limb entries), and short on an unlucky prime.
    #[test]
    fn rank_mod_p_counts_independent_rows() {
        let b = Budget::default();
        let mut seed = 0x0dd_ba11_u64;
        let k = knapsack(6, 300, &mut seed);
        assert_eq!(rank_mod_p(&b, &k, RANK_PRIME), Ok(6));
        let mut dep = k.clone();
        dep.push(dep[0].iter().zip(&dep[3]).map(|(x, y)| x * BigInt::from(-5i64) + y).collect());
        assert_eq!(rank_mod_p(&b, &dep, RANK_PRIME), Ok(6));
        assert_eq!(rank_mod_p(&b, &z(&[&[7, 0], &[0, 1]]), 7), Ok(1));
        assert_eq!(rank_mod_p(&b, &z(&[&[7, 0], &[0, 1]]), RANK_PRIME), Ok(2));
        assert_eq!(rank_mod_p(&b, &z(&[]), RANK_PRIME), Ok(0));
    }

    /// rank_mod_p reserves its buffers before allocating them: its
    /// allocator peak is within `rank_bytes`, the Budget's peak is exactly
    /// that, one byte less refuses with nothing allocated, and a finite work
    /// limit refuses before the stage it would not cover.
    #[test]
    fn rank_mod_p_stays_within_its_reservation() {
        let mut seed = 0x7a_11_0c_u64;
        let m = knapsack(12, 500, &mut seed);
        let (r, n) = (m.len(), m[0].len());
        let need = rank_bytes(r, n).unwrap();
        let b = Budget::new(Limits { memory: need, ..Limits::UNLIMITED });
        let (got, peak) = crate::alloc_spy::peak_during(|| rank_mod_p(&b, &m, RANK_PRIME));
        assert_eq!(got, Ok(12));
        assert!(peak as u64 <= need, "allocator peak {peak} above {need}");
        assert_eq!((b.peak(), b.live()), (need, 0));
        let b = Budget::new(Limits { memory: need - 1, ..Limits::UNLIMITED });
        let before = crate::alloc_spy::live();
        let e = rank_mod_p(&b, &m, RANK_PRIME).unwrap_err();
        assert_eq!((e.what, e.need - e.remaining), ("memory", 1));
        assert_eq!((b.live(), crate::alloc_spy::live()), (0, before));
        for work in [1, (r * n) as u64 + 5, (r * n) as u64 * 4] {
            let b = Budget::new(Limits { work, ..Limits::UNLIMITED });
            let e = rank_mod_p(&b, &m, RANK_PRIME).unwrap_err();
            assert_eq!(e.what, "work", "work {work}: {e}");
            assert_eq!(b.peak(), if work == 1 || work == (r * n) as u64 + 5 { 0 } else { need }, "work {work}");
        }
    }

    /// The Hermite stage reserves before it allocates: its allocator peak
    /// is within `hnf_bytes` at its final bound, the Budget's peak is exactly
    /// that, it hands back the rows' reservation shrunk to their
    /// `basis_bytes`, and one byte less refuses as memory (at a growth step
    /// when the bound grew) with nothing left allocated.
    #[test]
    fn hnf_budgeted_stays_within_its_reservation() {
        let mut seed = 0x4e_a1_7e_u64;
        let mut grew = 0;
        for (r, bits) in [(9usize, 30u32), (8, 200), (12, 8), (20, 64)] {
            // knapsack rows with a dependent one: a combination of the first two
            let mut m = knapsack(r - 1, bits, &mut seed);
            let extra: Vec<BigInt> = m[0].iter().zip(&m[1]).map(|(x, y)| x - y * BigInt::from(5)).collect();
            m.push(extra);
            let n = m[0].len();
            let e = m.iter().map(|x| crate::maxbits(x)).max().unwrap();
            let c = hnf_budgeted(&Budget::default(), &m).map(|x| x.2).unwrap();
            grew += (c > e) as u32;
            let need = hnf_bytes(m.len(), n, c).unwrap();
            let b = Budget::new(Limits { memory: need, ..Limits::UNLIMITED });
            let ((h, held), peak) = crate::alloc_spy::peak_during(|| {
                let (h, res, _) = hnf_budgeted(&b, &m).unwrap();
                (h, res.bytes())
            });
            assert!(peak as u64 <= need, "r {r}: allocator peak {peak} above {need}");
            assert_eq!(h.len(), r - 1, "r {r}: the rank");
            let eh = h.iter().map(|x| crate::maxbits(x)).max().unwrap();
            assert_eq!(held, basis_bytes(h.len(), n, eh).unwrap());
            assert_eq!((b.peak(), b.live()), (need, 0));
            let b = Budget::new(Limits { memory: need - 1, ..Limits::UNLIMITED });
            let before = crate::alloc_spy::live();
            let err = hnf_budgeted(&b, &m).map(|_| ()).unwrap_err();
            assert_eq!((err.what, err.need - err.remaining), ("memory", 1), "r {r}");
            assert_eq!((b.live(), crate::alloc_spy::live()), (0, before));
        }
        assert!(grew >= 2, "the bound grew in {grew} cases");
    }

    /// `compact_rows` makes the list and each row exactly as long as their
    /// contents (the invariant the hand-offs shrink to), from lists and rows
    /// with room to spare; and the hand-offs return such lists: the Hermite
    /// stage's, and `reduce_held`'s on each route and for fewer than 2 rows.
    #[test]
    fn compaction_leaves_no_room_to_spare() {
        let exact = |m: &Vec<Vec<BigInt>>| m.capacity() == m.len() && m.iter().all(|r| r.capacity() == r.len());
        let mut rows: Vec<Vec<BigInt>> = Vec::with_capacity(4096);
        for i in 0..5i64 {
            let mut r = Vec::with_capacity(64);
            r.extend((0..3).map(|j| BigInt::from(i * 7 + j)));
            rows.push(r);
        }
        let b = Budget::default();
        compact_rows(&b, &mut rows).unwrap();
        assert!(exact(&rows));
        assert_eq!(rows[4], z(&[&[28, 29, 30]])[0]);
        let mut empty: Vec<Vec<BigInt>> = Vec::with_capacity(16);
        compact_rows(&b, &mut empty).unwrap();
        assert!(exact(&empty));
        let (h, _, _) = hnf_budgeted(&b, &(0..1000).map(|_| z(&[&[1, 2]])[0].clone()).collect::<Vec<_>>()).unwrap();
        assert!(exact(&h));
        let mut seed = 0x5ca1_ab1e_u64;
        let big = BigInt::from(10u32).pow(60);
        let wide: Vec<Vec<BigInt>> = (0..5u64)
            .map(|i| {
                let mut r: Vec<BigInt> = (0..5u64).map(|j| BigInt::from((i == j) as u8)).collect();
                r.push(&big + BigInt::from(i));
                r
            })
            .collect();
        for m in [wide, knapsack(30, 400, &mut seed), z(&[&[3, 4, 5]])] {
            let (d, w) = (m.len(), m[0].len());
            let e = m.iter().map(|x| crate::maxbits(x)).max().unwrap();
            // the baseline before the rows handed in are made: what is live
            // after the call above it is what the call returned
            let before = crate::alloc_spy::live();
            let mut spare = Vec::with_capacity(4096);
            for r in &m {
                let mut v = Vec::with_capacity(4 * w);
                v.extend(r.iter().cloned());
                spare.push(v);
            }
            let held = b.reserve(basis_bytes(d, w, e)).unwrap();
            let (out, res) = reduce_held(&b, spare, held).unwrap();
            assert!(exact(&out), "d {d}");
            let live = crate::alloc_spy::live() - before;
            assert!(live >= 0 && live <= res.bytes() as i64, "d {d}: {live} live bytes, {} held", res.bytes());
            assert_eq!(b.live(), res.bytes());
            drop((out, res));
            assert_eq!((b.live(), crate::alloc_spy::live()), (0, before), "d {d}");
        }
    }

    /// What the Hermite stage hands off is all it holds: for rank 0, rank 1
    /// from a thousand equal rows, and many dependent rows, the live bytes
    /// left with the returned rows (their list, rows and entries) are within
    /// the returned reservation, which is all the Budget still holds.
    #[test]
    fn hnf_budgeted_hands_off_what_it_holds() {
        let row = |v: &[i64]| v.iter().map(|&x| BigInt::from(x)).collect::<Vec<BigInt>>();
        let mut many = vec![];
        for k in 0..300i64 {
            // combinations of three rows, with large entries
            let (x, y, w) = (k % 7 - 3, k % 5 - 2, k % 3 + 1);
            let big = BigInt::from(1u32) << 200u32;
            many.push(vec![&big * x + w, BigInt::from(y) * &big, BigInt::from(x + y), BigInt::from(w * 11 - x), &big * w - y]);
        }
        // dense signed rows whose bound grows by a limb or more, while the
        // Hermite form's entries end far below it
        let mut seed = 0x6a09_e667_f3bc_c908_u64;
        let mut word = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seed >> 32
        };
        let mut dense: Vec<Vec<BigInt>> = (0..11).map(|_| (0..10).map(|_| BigInt::from(((word() << 32) | word()) as i64)).collect()).collect();
        dense.push(dense[0].iter().zip(&dense[1]).map(|(x, y)| x * BigInt::from(3) - y).collect());
        let cases: Vec<(Vec<Vec<BigInt>>, usize)> = vec![
            ((0..60).map(|_| row(&[0, 0, 0])).collect(), 0),
            ((0..1000).map(|_| row(&[1, 2])).collect(), 1),
            (many, 3),
            (dense, 10),
        ];
        for (m, rank) in cases {
            let b = Budget::default();
            let before = crate::alloc_spy::live();
            let (h, res, c) = hnf_budgeted(&b, &m).unwrap();
            let live = crate::alloc_spy::live() - before;
            assert_eq!(h.len(), rank);
            if rank == 10 {
                let eh = h.iter().map(|x| crate::maxbits(x)).max().unwrap();
                assert!(c >= 64 + m.iter().map(|x| crate::maxbits(x)).max().unwrap() && c > 2 * eh, "bound {c}, output {eh} bits");
            }
            assert!(live as u64 <= res.bytes(), "rank {rank}: {live} live bytes, {} held", res.bytes());
            assert_eq!(b.live(), res.bytes());
            drop((h, res));
            assert_eq!((b.live(), crate::alloc_spy::live()), (0, before));
        }
        // reduce_held's hand-off, on each route (its rows given in a list with
        // spare room): what it returns lives within the reservation it returns
        let big = BigInt::from(10u32).pow(60);
        let wide: Vec<Vec<BigInt>> = (0..5u64)
            .map(|i| {
                let mut r: Vec<BigInt> = (0..5u64).map(|j| BigInt::from((i == j) as u8)).collect();
                r.push(&big + BigInt::from(i));
                r
            })
            .collect();
        let mut seed = 0x0ff_1ce_u64;
        for (m, l2) in [(wide, false), (knapsack(30, 400, &mut seed), true)] {
            let (d, w) = (m.len(), m[0].len());
            let e = m.iter().map(|x| crate::maxbits(x)).max().unwrap();
            assert_eq!(l2_route_plain(d, w, e).is_some(), l2);
            let b = Budget::default();
            let before = crate::alloc_spy::live();
            // a list with room to spare: the exact LLL works in it
            let mut rows = Vec::with_capacity(4096);
            rows.extend(m.iter().cloned());
            let held = b.reserve(basis_bytes(d, w, e)).unwrap();
            let (out, res) = reduce_held(&b, rows, held).unwrap();
            let live = crate::alloc_spy::live() - before;
            assert!(live as u64 <= res.bytes(), "L^2 {l2}: {live} live bytes, {} held", res.bytes());
            assert_eq!(b.live(), res.bytes());
            drop((out, res));
            assert_eq!((b.live(), crate::alloc_spy::live()), (0, before));
        }
    }

    /// A growth of the bound past a limb (64 bits or more, on dense signed
    /// dependent rows): the allocator peak is within `hnf_bytes` at the final
    /// bound, which is the Budget's peak, and one byte less refuses as
    /// memory with nothing left allocated.
    #[test]
    fn hnf_budgeted_grows_past_a_limb_within_its_reservation() {
        let mut seed = 0x6a09_e667_f3bc_c908_u64;
        let mut word = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seed >> 32
        };
        let mut m: Vec<Vec<BigInt>> = (0..11)
            .map(|_| (0..10).map(|_| BigInt::from(((word() << 32) | word()) as i64)).collect())
            .collect();
        m.push(m[0].iter().zip(&m[1]).map(|(x, y)| x * BigInt::from(3) - y).collect());
        let n = m[0].len();
        let e = m.iter().map(|x| crate::maxbits(x)).max().unwrap();
        let c = hnf_budgeted(&Budget::default(), &m).map(|x| x.2).unwrap();
        assert!(c >= e + 64, "the bound grew from {e} to {c} only");
        let need = hnf_bytes(m.len(), n, c).unwrap();
        let b = Budget::new(Limits { memory: need, ..Limits::UNLIMITED });
        let (got, peak) = crate::alloc_spy::peak_during(|| hnf_budgeted(&b, &m).map(|x| x.0.len()));
        // rank 10: the columns
        assert_eq!(got, Ok(10));
        assert!(peak as u64 <= need, "allocator peak {peak} above {need}");
        assert_eq!((b.peak(), b.live()), (need, 0));
        let b = Budget::new(Limits { memory: need - 1, ..Limits::UNLIMITED });
        let before = crate::alloc_spy::live();
        let err = hnf_budgeted(&b, &m).map(|_| ()).unwrap_err();
        assert_eq!((err.what, err.need - err.remaining), ("memory", 1));
        assert_eq!((b.live(), crate::alloc_spy::live()), (0, before));
    }

    /// An update whose products stay short can still carry an entry past
    /// the bound (x at the bound, x - q y one bit longer): the bound grows
    /// first, and the result is the Hermite form, not an internal error.
    #[test]
    fn hnf_budgeted_grows_for_a_carry_past_the_bound() {
        // the pivot is row 0's 1, q = 2, and row 1 - 2 row 0 = (0, 257):
        // 9 bits, past the bound of 8, from a 3-bit q y
        let m = z(&[&[1, -1], &[2, 255]]);
        let (h, _, c) = hnf_budgeted(&Budget::default(), &m).unwrap();
        assert_eq!(h, z(&[&[1, 256], &[0, 257]]));
        // 9 there; then row 0's upward reduction, q = -1 against the 9-bit
        // pivot row, bounds its entries by 1 + 9 + 1
        assert_eq!(c, 11);
    }

    /// Every work debit of the Hermite stage comes before its work: with
    /// the work limit set to what was used just before a debit, the call
    /// refuses there (as work), with nothing left reserved or allocated;
    /// every site is reached (the sizes, the copy, a pivot search, a
    /// quotient, a bound check, an update, a sign normalization, a zero-row
    /// scan, the output's sizes).
    #[test]
    fn hnf_budgeted_debits_before_each_step() {
        // dependent rows with negative pivots
        let m = z(&[&[-3, 5, 7, 2], &[6, -2, 4, -8], &[-9, 3, 11, 5], &[3, 3, 11, -6], &[0, 7, -1, 4]]);
        let trace = || {
            HNF_TRACE.with(|t| *t.borrow_mut() = Some(vec![]));
            let b = Budget::default();
            let r = hnf_budgeted(&b, &m).map(|x| x.0);
            (r, HNF_TRACE.with(|t| t.borrow_mut().take().unwrap()))
        };
        let (want, sites) = trace();
        let want = want.unwrap();
        let mut seen: Vec<&str> = sites.iter().map(|x| x.0).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen, ["bound", "compact", "copy", "output sizes", "pivot search", "quotient", "sign", "sizes", "update", "zero rows"]);
        for (k, &(site, left)) in sites.iter().enumerate() {
            let used = u64::MAX - left;
            // (the trace's own room allocated before the count starts)
            HNF_TRACE.with(|t| *t.borrow_mut() = Some(Vec::with_capacity(sites.len() + 1)));
            let b = Budget::new(Limits { work: used, ..Limits::UNLIMITED });
            let before = crate::alloc_spy::live();
            let err = hnf_budgeted(&b, &m).map(|_| ()).unwrap_err();
            let got = HNF_TRACE.with(|t| t.borrow_mut().take().unwrap());
            assert_eq!((err.what, got.len(), got.last().map(|x| x.0)), ("work", k + 1, Some(site)), "debit {k} ({site})");
            assert_eq!((b.live(), crate::alloc_spy::live()), (0, before), "debit {k} ({site})");
        }
        let b = Budget::new(Limits { work: u64::MAX - sites.last().unwrap().1 + 10_000, ..Limits::UNLIMITED });
        assert_eq!(hnf_budgeted(&b, &m).unwrap().0, want);
    }

    /// A merge keeps the Budget's live bytes, and the merged reservation's
    /// drop releases nothing; across budgets it is an internal error that
    /// leaves both reservations, and both Budgets' live bytes, as they were.
    #[test]
    fn a_merged_reservation_moves_its_bytes() {
        let b = Budget::default();
        let mut x = b.reserve(Some(100)).unwrap();
        let mut y = b.reserve(Some(30)).unwrap();
        x.merge(&mut y).unwrap();
        assert_eq!((x.bytes(), y.bytes(), b.live()), (130, 0, 130));
        drop(y);
        assert_eq!(b.live(), 130);
        x.shrink(10);
        assert_eq!(b.live(), 10);
        drop(x);
        assert_eq!(b.live(), 0);
        let other = Budget::default();
        let mut x = b.reserve(Some(5)).unwrap();
        let mut z = other.reserve(Some(7)).unwrap();
        assert_eq!(x.merge(&mut z).unwrap_err().kind, crate::budget::Kind::Internal);
        // both reservations as they were, each still held by its Budget
        assert_eq!((x.bytes(), z.bytes(), b.live(), other.live()), (5, 7, 5, 7));
        drop(z);
        assert_eq!(other.live(), 0);
    }
}
