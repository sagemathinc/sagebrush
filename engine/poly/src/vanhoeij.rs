//! van Hoeij's recombination (M. van Hoeij, Factoring polynomials and the
//! knapsack problem, J. Number Theory 95 (2002)), with the CLD columns of
//! Belabas, van Hoeij, Klüners and Steel (JTNB 21 (2009)) and columns added
//! a few at a time as in van Hoeij-Novocin (LATIN 2010) and Hart-van
//! Hoeij-Novocin (ISSAC 2011).  Plan r3 (reviewed): sections refer to it.
//!
//! f (primitive, square-free, lc l, degree n) = l u_1 ... u_r mod p^a, the
//! u_i monic.  For a true factor g with modular support S,
//!     f g'/g = sum_{i in S} c_i (mod p^a),   c_i = l u_i' prod_{j != i} u_j,
//! and |[x^j] f g'/g| <= B_j (section 3.1).  For a column j with p^b_j >= B_j,
//! q_ij = floor(c_ij / p^b_j) and the modulus p^(a - b_j): the true indicator
//! v lifts to a lattice vector of squared norm <= r + |J| (r + 1)^2 (3.2).
//! LLL, then the strict Gram-Schmidt cut keeps every such vector (3.3).
//! Success: the projections of the rows to the first r coordinates are
//! constant on classes of equal columns, there are as many classes as rows
//! and the rows are independent; then the row space is spanned by the class
//! indicators, so every true factor is a union of classes, and the exact
//! division of f by every class's reconstruction, ending in 1, proves each
//! is a true irreducible factor.

use crate::budget::{big_bytes, limbs, mul_work, poly_bytes, tag, words_bytes, Budget, FResult, Phase, Reservation};
use crate::lll;
use crate::{clog2, deg, divexact, hensel, maxbits, mreduce, prim, reconstruct, zassenhaus, FPoly, Held, Modular};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

/// At most this many modular factors: Zassenhaus' subsets directly.
pub const ZASSENHAUS_MAX: usize = 8;
/// At most this many modular factors after the pre-pass for the lattice.
pub const MAX_R: usize = 96;
/// At most this many auxiliary columns in all, over every precision level.
pub const MAX_COLS: usize = 32;
const COLS_PER_PASS: usize = 4;
const LEVELS: u32 = 3;

/// The irreducible factors of f (primitive, square-free, degree >= 2), from
/// its modular data and the factors lifted to p^k.
pub fn recombine<'b>(b: &'b Budget, f: &[BigInt], m: &Modular, lifted: Vec<Held<'b>>) -> FResult<Vec<Held<'b>>> {
    let pk = crate::power(b, m.p, m.k)?;
    // the pre-pass: subsets of sizes 1, then 2 (all singletons first)
    let z = if fault(fault::SKIP_PREPASS) {
        crate::Zassenhaus { found: vec![], residual: Some((Held::copy(b, f)?, lifted)) }
    } else {
        let _p = b.enter(Phase::Prepass);
        zassenhaus(b, f, lifted, &pk, &m.possible, 2)?
    };
    let mut found = z.found;
    let Some((g, rest)) = z.residual else {
        return Ok(found);
    };
    if g[0].is_zero() {
        // x divides g: impossible here, since x mod p is a single modular
        // factor and the pre-pass tests every singleton by reconstruction
        // and exact division; a violation is an internal error, never a
        // subset search (rank-3 plan r3, section 3.2)
        return Err(b.internal("x divides the residual after the pre-pass"));
    }
    if rest.len() <= ZASSENHAUS_MAX || rest.len() > MAX_R {
        // few factors left (Zassenhaus is cheap), or too many for the
        // lattice (the budget bounds the search)
        let _p = b.enter(if rest.len() <= ZASSENHAUS_MAX { Phase::Zassenhaus } else { Phase::Fallback });
        found.extend(zassenhaus(b, &g, rest, &pk, &m.possible, usize::MAX)?.found);
        return Ok(found);
    }
    match lattice(b, &g, m, &rest)? {
        Some(fs) => found.extend(fs),
        None => {
            // the full original modular list of the residual, at the
            // original (Mignotte) precision
            let _p = b.enter(Phase::Fallback);
            found.extend(zassenhaus(b, &g, rest, &pk, &m.possible, usize::MAX)?.found);
        }
    }
    Ok(found)
}

/// Faults the tests inject (rank-3 plan r3, section 4.3), to reach each
/// invariant's branch (only the tests can set one).
pub mod fault {
    /// The pre-pass is skipped: its residual is f with every lifted factor.
    pub const SKIP_PREPASS: u8 = 1;

    #[cfg(any(test, feature = "test-faults"))]
    thread_local! {
        static FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    }

    #[inline]
    pub fn is(_f: u8) -> bool {
        #[cfg(any(test, feature = "test-faults"))]
        {
            FAULT.with(|c| c.get() == _f)
        }
        #[cfg(not(any(test, feature = "test-faults")))]
        {
            false
        }
    }

    /// Run `run` with fault `f` injected.
    #[cfg(any(test, feature = "test-faults"))]
    pub fn with<T>(f: u8, run: impl FnOnce() -> T) -> T {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                FAULT.with(|c| c.set(0));
            }
        }
        let _r = Reset;
        FAULT.with(|c| c.set(f));
        run()
    }
}

use fault::is as fault;

/// The tests' executable ledger (rank-3 plan r3, section 3.7; delta 1 r2
/// (C)): at a checkpoint, the live reservation equals the sum of the
/// table's entries that are live there, each computed from dimensions and
/// bit bounds (never read back from a guard), so a reservation that is
/// missing, released early or held too long fails it.
macro_rules! ledger {
    ($b:expr, $at:expr, $($term:expr),+ $(,)?) => {
        #[cfg(test)]
        {
            let want: u64 = 0 $(+ $term)+;
            if ledger_log::checking() {
                assert_eq!($b.live(), want, "the ledger at {}", $at);
            }
            ledger_log::reached($at);
        }
    };
}

/// A reservation of the ledger, made while the entries `$live` are live:
/// a candidate for the peak (the old guard of a hand-off is still live
/// when its successor is reserved, so both count).
macro_rules! handoff {
    ($($term:expr),+ $(,)?) => {
        #[cfg(test)]
        ledger_log::handoff(0 $(+ $term)+, line!());
    };
}

/// The tests' record of the ledger's checkpoints and of the peak it
/// predicts.
#[cfg(test)]
pub(crate) mod ledger_log {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    thread_local! {
        static REACHED: RefCell<BTreeMap<&'static str, u64>> = const { RefCell::new(BTreeMap::new()) };
        static PEAK: Cell<(u64, u32)> = const { Cell::new((0, 0)) };
        // a level above 0 ran: its relifting's own reservations are not in
        // the predicted peak (the relift coexistence rows are PR 4's)
        static RELIFT: Cell<bool> = const { Cell::new(false) };
        // the equality checkpoints are asserted (off: the size tags alone)
        static CHECKING: Cell<bool> = const { Cell::new(true) };
    }

    pub fn checking() -> bool {
        CHECKING.with(|c| c.get())
    }
    /// Run f with the equality checkpoints off (they still count as reached).
    pub fn without_checkpoints<T>(f: impl FnOnce() -> T) -> T {
        struct On;
        impl Drop for On {
            fn drop(&mut self) {
                CHECKING.with(|c| c.set(true));
            }
        }
        let _on = On;
        CHECKING.with(|c| c.set(false));
        f()
    }

    pub fn reset() {
        REACHED.with(|r| r.borrow_mut().clear());
        PEAK.with(|p| p.set((0, 0)));
        RELIFT.with(|r| r.set(false));
    }
    pub fn reached(at: &'static str) {
        REACHED.with(|r| *r.borrow_mut().entry(at).or_insert(0) += 1);
    }
    /// A peak candidate, and the source line of its reservation.
    pub fn handoff(v: u64, line: u32) {
        PEAK.with(|p| {
            if v > p.get().0 {
                p.set((v, line))
            }
        });
    }
    pub fn relift() {
        RELIFT.with(|r| r.set(true));
    }
    /// (the checkpoints reached and how often, the predicted peak, whether a
    /// level above 0 ran)
    pub fn get() -> (BTreeMap<&'static str, u64>, u64, bool) {
        (REACHED.with(|r| r.borrow().clone()), PEAK.with(|p| p.get().0), RELIFT.with(|r| r.get()))
    }
    /// The source line of the predicted peak's reservation.
    pub fn peak_line() -> u32 {
        PEAK.with(|p| p.get().1)
    }
}

/// The lattice phase: Some(irreducible factors of g) when a certificate is
/// found, None to fall back.
#[allow(unused_assignments)] // `held` is a reservation guard, read by its Drop
fn lattice<'b>(b: &'b Budget, g: &[BigInt], m: &Modular, rest0: &[Held<'b>]) -> FResult<Option<Vec<Held<'b>>>> {
    let r = rest0.len();
    let n = deg(g);
    let p = m.p;
    let pbits = 64 - (p - 1).leading_zeros() as u64; // ceil(log2 p) for p >= 3
    // the lattice's own reservations and refusals belong to its phase (the
    // steps below enter their own)
    let _p = b.enter(Phase::Lattice);
    // (the ledger's entries that live through the whole call: the caller's
    // reservations, the modular factors, the bounds and the column indices)
    #[cfg(test)]
    let (entry, modfs_b, bounds_b, cols_b) = (b.live(), words_bytes(2 * (n as u64 + r as u64 + 1)).unwrap(), bounds_bytes(g).unwrap(), words_bytes(MAX_COLS as u64).unwrap());
    #[cfg(test)]
    let whole = entry + modfs_b + bounds_b + cols_b;
    handoff!(entry, modfs_b, bounds_b, cols_b);
    // the modular factors of g mod p, in the order of rest0 (for relifting):
    // n words and r headers, reserved first
    let _modfs = b.reserve(words_bytes(2 * (n as u64 + r as u64 + 1)))?;
    let modfs: Vec<FPoly> = rest0.iter().map(|u| u.iter().map(|c| c.mod_floor(&BigInt::from(p)).to_u64().unwrap()).collect()).collect();
    // the bounds, with their reservation (gap 1)
    let (bounds, _bounds) = cld_bounds(b, g)?;
    // the coefficient index of every column: at most MAX_COLS, reserved for
    // that many before the first (gap 2)
    let _cols = b.reserve_as("cols", words_bytes(MAX_COLS as u64))?;
    let mut cols: Vec<usize> = {
        let _t = tag("cols");
        Vec::with_capacity(MAX_COLS)
    };
    ledger!(b, "entry", whole);
    // the basis: rows (indicator part | auxiliary columns); starts as I_r
    // (the rows' memory is reserved for as long as they live: `held`)
    let mut held: Reservation<'b> = b.reserve(rows_bytes(r, r, 1))?;
    // (what `held` should charge, from the rows' dimensions and bits)
    #[cfg(test)]
    let mut held_want = rows_bytes(r, r, 1).unwrap();
    handoff!(whole, held_want);
    let mut rows: Vec<Vec<BigInt>> = (0..r).map(|i| (0..r).map(|j| BigInt::from((i == j) as u32)).collect()).collect();
    let mut used_low = 0usize; // next low index
    let mut used_high = 0usize; // next high offset
    for level in 0..LEVELS {
        let a = m.k.checked_mul(1 << level).ok_or_else(|| b.refuse("precision", u64::MAX, m.k as u64))?;
        let lifted_here;
        let us: &[Held<'b>] = if level == 0 {
            rest0
        } else {
            #[cfg(test)]
            ledger_log::relift();
            let pa = crate::power(b, p, a)?;
            // g = lc(g) prod u_i (mod p): relift the same factors to p^a
            let gl = {
                let _p = b.enter(Phase::Hensel);
                mreduce(b, g, &pa)?
            };
            lifted_here = {
                let _p = b.enter(Phase::Hensel);
                // the F_p[x] temporaries of the factor tree, as in lift()
                let _w = b.reserve(crate::budget::words_bytes((4 * (clog2(r as u64) + 1) + 8) * (n as u64 + 1)))?;
                hensel(b, &gl, &modfs, p, a)?
            };
            &lifted_here
        };
        // (the level's entries: p^a and the relifted factors; each relifted
        // factor is a Held, which owns its reservation)
        #[cfg(test)]
        let relifted_b = if level == 0 { 0 } else { us.iter().map(|u| u.reserved()).sum::<u64>() };
        handoff!(whole, held_want, relifted_b, crate::power_bytes(p, a).unwrap());
        let pa = crate::power(b, p, a)?;
        #[cfg(test)]
        let level_bytes = crate::power_bytes(p, a).unwrap() + relifted_b;
        // the retained p-adic digits per entry: e = floor(E / ceil(log2 p)), E = 2r + 64
        let ebits = 2 * r as u64 + 64;
        let edig = (ebits / pbits) as u32;
        loop {
            if cols.len() >= MAX_COLS {
                break;
            }
            // the next columns: low and high alternately
            let mut want: Vec<usize> = vec![];
            while want.len() < COLS_PER_PASS && cols.len() + want.len() < MAX_COLS && (used_low + used_high) < n {
                if want.len() % 2 == 0 && used_low <= n - 1 - used_high {
                    want.push(used_low);
                    used_low += 1;
                } else if used_high < n && n - 1 - used_high >= used_low {
                    want.push(n - 1 - used_high);
                    used_high += 1;
                } else {
                    break;
                }
            }
            if want.is_empty() {
                break;
            }
            // the c_ij of these columns (values below p^a), reserved before
            // cld_columns builds them, held until the pass ends
            let _cld = b.reserve_as("cld", rows_bytes(want.len(), r, pa.bits()))?;
            #[cfg(test)]
            let cld_b = rows_bytes(want.len(), r, pa.bits()).unwrap();
            handoff!(whole, level_bytes, held_want, cld_b, cld_columns_bytes(n, r, &want, pa.bits()).unwrap());
            let cld = {
                let _p = b.enter(Phase::Cld);
                let _t = tag("cld");
                cld_columns(b, g, us, &pa, &want)?
            };
            let mut added = 0;
            {
                let _p = b.enter(Phase::Lattice);
                // room for the rows with every new column, before appending:
                // an entry sum u_i q_ij has at most bits(u) + bits(q) + log2 r + 1 bits
                let ubits = rows.iter().map(|x| maxbits(&x[..r])).max().unwrap_or(0);
                let ebits = rows.iter().map(|x| maxbits(x)).max().unwrap_or(0).max(ubits + pa.bits() + clog2(r as u64) + 1);
                let grown = b.reserve(rows_bytes(rows.len() + want.len(), rows.first().map_or(r, |x| x.len()) + want.len(), ebits))?;
                #[cfg(test)]
                {
                    // the hand-off: the old rows' charge is live until `grown` replaces it
                    let g_b = rows_bytes(rows.len() + want.len(), rows.first().map_or(r, |x| x.len()) + want.len(), ebits).unwrap();
                    handoff!(whole, level_bytes, held_want, cld_b, g_b);
                    held_want = g_b;
                }
                held = grown;
                for (t, &j) in want.iter().enumerate() {
                    // b_j: the least b with p^b >= B_j, raised to keep e
                    // digits; p^b < B_j p has at most bits(B_j) + bits(p)
                    // bits, reserved before the loop (gap 3)
                    let pb = BigInt::from(p);
                    let bmin = {
                        let _pw = b.reserve_as("pw", big_bytes(bounds[j].bits() + pbits))?;
                        handoff!(whole, level_bytes, held_want, cld_b, big_bytes(bounds[j].bits() + pbits).unwrap());
                        let _t = tag("pw");
                        let mut bmin = 0u32;
                        let mut pw = BigInt::one();
                        while pw < bounds[j] {
                            ledger!(b, "the pw loop", whole, level_bytes, held_want, cld_b, big_bytes(bounds[j].bits() + pbits).unwrap());
                            b.debit(Some(limbs(pw.bits())))?;
                            pw *= &pb;
                            bmin += 1;
                        }
                        bmin
                    };
                    let bj = bmin.max(a.saturating_sub(edig));
                    if bj >= a {
                        continue; // no information at this precision
                    }
                    handoff!(whole, level_bytes, held_want, cld_b, crate::power_bytes(p, bj).unwrap());
                    let scale = crate::power(b, p, bj)?;
                    handoff!(whole, level_bytes, held_want, cld_b, crate::power_bytes(p, bj).unwrap(), crate::power_bytes(p, a - bj).unwrap());
                    let modulus = crate::power(b, p, a - bj)?;
                    // a column whose modulus is not above the cut bound B
                    // (counting it) carries too little information: its
                    // modulus row alone would survive the cut
                    let nb = BigInt::from(r as u64) + BigInt::from((cols.len() + 1) as u64) * BigInt::from(r as u64 + 1).pow(2);
                    if &modulus.v * &modulus.v <= nb {
                        continue;
                    }
                    let _q = b.reserve(rows_bytes(1, r, pa.bits()))?;
                    handoff!(whole, level_bytes, held_want, cld_b, crate::power_bytes(p, bj).unwrap(), crate::power_bytes(p, a - bj).unwrap(), rows_bytes(1, r, pa.bits()).unwrap());
                    let q: Vec<BigInt> = cld[t].iter().map(|c| c.div_floor(&scale)).collect();
                    // append: each row (u | aux) gets sum u_i q_i; then the modulus row
                    b.debit(mul_work(rows.len() as u64, maxbits(&q), r as u64, 64))?;
                    for row in rows.iter_mut() {
                        let s: BigInt = row[..r].iter().zip(&q).map(|(u, x)| u * x).sum();
                        row.push(s);
                    }
                    let w = rows.first().map_or(r + 1, |x| x.len());
                    let mut mrow = vec![BigInt::zero(); w];
                    mrow[w - 1] = modulus.v.clone();
                    rows.push(mrow);
                    cols.push(j);
                    added += 1;
                }
            }
            // the columns are in the rows: their values go now, before LLL
            // (plan r3, section 3.7)
            drop(cld);
            drop(_cld);
            if added == 0 {
                continue;
            }
            // reduce: reserve the lattice and the LLL state first (5.3)
            let d = rows.len();
            let w = rows[0].len();
            let e = rows.iter().map(|x| maxbits(x)).max().unwrap_or(0);
            let cap = lll::cap_bits(d, e).ok_or_else(|| b.refuse("lll bits (overflow)", u64::MAX, 0))?;
            let reduced = {
                let _p = b.enter(Phase::Lll);
                ledger!(b, "before LLL", whole, level_bytes, held_want);
                let l = b.reserve(lll::lattice_bytes(d, w, cap))?;
                #[cfg(test)]
                {
                    // the hand-off: the rows' charge is live until the LLL's replaces it
                    handoff!(whole, level_bytes, held_want, lll::lattice_bytes(d, w, cap).unwrap());
                    held_want = lll::lattice_bytes(d, w, cap).unwrap();
                }
                drop(std::mem::replace(&mut held, l));
                lll::lll(b, std::mem::take(&mut rows), cap)?
            };
            // the reduced rows and the d + 1 Gram determinants, at most `cap`
            // bits each: both held until the cut ends, then the rows (gap 4)
            let lll::Reduced { basis, d: dets } = reduced;
            let dets_bytes = big_bytes(cap).and_then(|x| x.checked_mul(d as u64 + 1));
            let kept = b.reserve(rows_bytes(d, w, cap).zip(dets_bytes).and_then(|(x, y)| x.checked_add(y)))?;
            #[cfg(test)]
            let (rows_b, dets_b) = (rows_bytes(d, w, cap).unwrap(), big_bytes(cap).unwrap() * (d as u64 + 1));
            #[cfg(test)]
            {
                // the hand-off: the LLL's charge is live until `kept` replaces it
                handoff!(whole, level_bytes, held_want, rows_b + dets_b);
                held_want = rows_b + dets_b;
            }
            held = kept;
            #[cfg(test)]
            assert!(dets.iter().all(|x| x.bits() <= cap), "a Gram determinant above cap bits");
            // the cut: drop the last row while |b_s*|^2 = d_s / d_{s-1} > B^2 (strictly)
            let bb = BigInt::from(r as u64) + BigInt::from(cols.len() as u64) * BigInt::from(r as u64 + 1).pow(2);
            let mut s = basis.len();
            {
                let _p = b.enter(Phase::Lattice);
                while s > 0 {
                    ledger!(b, "the cut", whole, level_bytes, rows_b + dets_b);
                    b.debit(Some(limbs(dets[s].bits()) * limbs(dets[s - 1].bits()) + 1))?;
                    if dets[s] > &bb * &dets[s - 1] {
                        s -= 1;
                    } else {
                        break;
                    }
                }
            }
            drop(dets);
            held.shrink(rows_bytes(d, w, cap).unwrap_or(0));
            #[cfg(test)]
            {
                held_want = rows_b;
            }
            rows = basis;
            rows.truncate(s);
            ledger!(b, "certify", whole, level_bytes, rows_b);
            if s == 0 {
                return Ok(None); // impossible for a valid lattice: fall back
            }
            if let Some(fs) = certify(b, g, us, &pa, &rows, r)? {
                return Ok(Some(fs));
            }
        }
        if cols.len() >= MAX_COLS {
            break;
        }
        // the next level: more precision, fresh columns
        used_low = 0;
        used_high = 0;
    }
    Ok(None)
}

/// Bytes for `d` rows of `w` integers of at most `bits` bits.
fn rows_bytes(d: usize, w: usize, bits: u64) -> Option<u64> {
    (d as u64).checked_mul(w as u64)?.checked_mul(big_bytes(bits)?)?.checked_add((d as u64).checked_mul(48)?)
}

/// The certificate (module docs): classes of equal projected columns, as
/// many as rows, the rows independent, every class's reconstruction an
/// exact divisor, and the last quotient 1.
fn certify<'b>(b: &'b Budget, g: &[BigInt], us: &[Held<'b>], pa: &BigInt, rows: &[Vec<BigInt>], r: usize) -> FResult<Option<Vec<Held<'b>>>> {
    let _p = b.enter(Phase::Echelon);
    b.debit(mul_work(rows.len() as u64, rows.iter().map(|x| maxbits(&x[..r])).max().unwrap_or(0), r as u64, 64))?;
    // rows whose projection vanishes add nothing to the projected row
    // space: the certificate is about that space
    let rows: Vec<&Vec<BigInt>> = rows.iter().filter(|x| x[..r].iter().any(|c| !c.is_zero())).collect();
    let s = rows.len();
    // classes of equal columns (by the column vector over the s rows)
    let mut classes: Vec<Vec<usize>> = vec![];
    let col = |i: usize| -> Vec<&BigInt> { rows.iter().map(|x| &x[i]).collect() };
    'cols: for i in 0..r {
        let ci = col(i);
        if ci.iter().all(|x| x.is_zero()) {
            return Ok(None);
        }
        for c in classes.iter_mut() {
            if col(c[0]) == ci {
                c.push(i);
                continue 'cols;
            }
        }
        classes.push(vec![i]);
    }
    if classes.len() != s {
        return Ok(None);
    }
    // the rows are independent iff the s x s matrix of class representatives
    // is nonsingular: fraction-free (Bareiss) elimination, bits checked
    let entry = rows.iter().map(|x| classes.iter().map(|c| x[c[0]].bits()).max().unwrap_or(0)).max().unwrap_or(0);
    // Hadamard: every Bareiss value is a minor, at most s (entry + log2 s) bits
    let cap = (s as u64).checked_mul(entry + clog2(s as u64) + 1).ok_or_else(|| b.refuse("echelon bits (overflow)", u64::MAX, 0))? + 64;
    // (the s x s matrix and its values, reserved before it is built)
    let _e = b.reserve(poly_bytes((s * s) as u64, cap))?;
    let mut a: Vec<Vec<BigInt>> = rows.iter().map(|x| classes.iter().map(|c| x[c[0]].clone()).collect()).collect();
    let mut prev = BigInt::one();
    for k in 0..s {
        let piv = (k..s).find(|&i| !a[i][k].is_zero());
        let Some(pi) = piv else { return Ok(None) };
        a.swap(k, pi);
        for i in k + 1..s {
            b.debit(mul_work((s - k) as u64, cap, 2, cap))?;
            for j in k + 1..s {
                let v = (&a[k][k] * &a[i][j] - &a[i][k] * &a[k][j]) / &prev;
                if v.bits() > cap {
                    return Err(b.refuse("echelon bits", v.bits(), cap));
                }
                a[i][j] = v;
            }
            a[i][k] = BigInt::zero();
        }
        prev = a[k][k].clone();
    }
    drop(a);
    // reconstruct and divide, every class
    let _p = b.enter(Phase::Reconstruct);
    let mut rem = Held::copy(b, g)?;
    let mut out = vec![];
    for c in &classes {
        let lc = rem.last().unwrap().clone();
        let h = reconstruct(b, &lc, c.iter().map(|&i| &us[i].v[..]), pa)?;
        b.take_division()?;
        match divexact(b, &rem, &h)? {
            Some(q) => {
                rem = prim(b, &q)?;
                out.push(h);
            }
            None => return Ok(None),
        }
    }
    if rem.len() != 1 || !rem[0].is_one() {
        return Ok(None);
    }
    Ok(Some(out))
}

// ------------------------------------------------------------------ CLD bounds and columns

/// a * 2^e, rounded up (e may be negative).
fn shl_up(a: &BigInt, e: i64) -> BigInt {
    if e >= 0 {
        a << (e as u64)
    } else {
        let s = (-e) as u64;
        (a + ((BigInt::one() << s) - 1u32)) >> s
    }
}

/// t with every root of the polynomial (coefficients `a`, constant first,
/// a_n != 0) of absolute value at most 2^(t + 1) (Fujiwara's bound
/// 2 max_k |a_(n-k) / a_n|^(1/k), with |a_(n-k)| < 2^bits and
/// |a_n| >= 2^(bits(a_n) - 1)).
fn root_exp(a: &[BigInt]) -> i64 {
    let n = a.len() - 1;
    let ln = a[n].bits() as i64 - 1;
    let mut t = i64::MIN;
    for k in 1..=n {
        let c = &a[n - k];
        if c.is_zero() {
            continue;
        }
        let num = c.bits() as i64 - ln; // |c / a_n| < 2^num
        t = t.max(Integer::div_ceil(&num, &(k as i64)));
    }
    if t == i64::MIN {
        0
    } else {
        t
    }
}

/// root_exp of the reverse of a (no copy).
fn root_exp_rev(a: &[BigInt]) -> i64 {
    let n = a.len() - 1;
    let ln = a[0].bits() as i64 - 1;
    let mut t = i64::MIN;
    for k in 1..=n {
        let c = &a[k];
        if c.is_zero() {
            continue;
        }
        let num = c.bits() as i64 - ln;
        t = t.max(Integer::div_ceil(&num, &(k as i64)));
    }
    if t == i64::MIN {
        0
    } else {
        t
    }
}

/// The bounds B_j (section 3.1): n min(sum_{k>j} |a_k| R^(k-j-1),
/// sum_{k<=j} |a_k| rho^(k-j-1)), R = 2^(t+1) above every root, rho =
/// 2^-(t'+1) below every root (t' from the reverse; a_0 != 0).
/// Bytes for cld_bounds' two vectors (absolute values, bounds): a bound is
/// a sum of n + 1 terms |a_k| 2^(e) with e <= (|t| + |tr|) n.
fn bounds_bytes(g: &[BigInt]) -> Option<u64> {
    let n = g.len() - 1;
    let t = root_exp(g) + 1;
    let tr = root_exp_rev(g) + 1;
    let ebits = (t.unsigned_abs() + tr.unsigned_abs()).checked_mul(n as u64 + 1)?.checked_add(maxbits(g) + clog2(n as u64 + 2) + 2 * clog2(n as u64 + 2) + 2)?;
    poly_bytes(2 * (n as u64 + 1), ebits)
}

/// The bounds, with the reservation that covers them for as long as the
/// caller keeps it (gap 1 of plan r3, section 3.7).
fn cld_bounds<'b>(b: &'b Budget, g: &[BigInt]) -> FResult<(Vec<BigInt>, Reservation<'b>)> {
    let _p = b.enter(Phase::Cld);
    let n = g.len() - 1;
    b.debit((n as u64 + 1).checked_mul(n as u64 + 1).and_then(|x| x.checked_mul(limbs(maxbits(g) + 2 * n as u64))))?;
    let t = root_exp(g) + 1;
    let tr = root_exp_rev(g) + 1;
    let r = b.reserve_as("bounds", bounds_bytes(g))?;
    let _t = tag("bounds");
    let abs: Vec<BigInt> = g.iter().map(|c| c.abs()).collect();
    let nn = BigInt::from(n as u64);
    let mut out = vec![];
    for j in 0..n {
        let mut s1 = BigInt::zero();
        for k in j + 1..=n {
            s1 += shl_up(&abs[k], t * (k as i64 - j as i64 - 1));
        }
        let mut s2 = BigInt::zero();
        for k in 0..=j {
            s2 += shl_up(&abs[k], tr * (j as i64 + 1 - k as i64));
        }
        out.push(&nn * s1.min(s2));
    }
    Ok((out, r))
}

/// x * y mod (x^N, m), coefficients in [0, m).
fn tmul(b: &Budget, x: &[BigInt], y: &[BigInt], nn: usize, m: &BigInt) -> FResult<Vec<BigInt>> {
    let lm = limbs(m.bits());
    b.debit((nn as u64).checked_mul(nn as u64).and_then(|v| v.checked_mul(lm * lm)))?;
    let mut r = vec![BigInt::zero(); nn];
    for (i, u) in x.iter().enumerate().take(nn) {
        if u.is_zero() {
            continue;
        }
        for (j, w) in y.iter().enumerate().take(nn - i) {
            r[i + j] += u * w;
        }
    }
    for c in r.iter_mut() {
        *c = c.mod_floor(m);
    }
    Ok(r)
}

/// The coefficients c_ij (i < r) of the requested indices j, in [0, p^a):
/// low ones from prefix and suffix products modulo (x^N, p^a); high ones
/// from the reversals at fixed formal degrees,
///   rev_{n-1}(c_i) = l rev_{d_i - 1}(u_i') rev(P_{<i}) rev(P_{>i}),
/// so coefficient n - 1 - t of c_i is coefficient t of the right side.
/// Bytes for cld_columns' prefix and suffix tables (2 (r + 1) truncated
/// polynomials per side) and its output.
fn cld_columns_bytes(n: usize, r: usize, want: &[usize], pabits: u64) -> Option<u64> {
    let low_n = want.iter().filter(|&&j| 2 * j < n).map(|&j| j + 1).max().unwrap_or(0);
    let high_n = want.iter().filter(|&&j| 2 * j >= n).map(|&j| n - j).max().unwrap_or(0);
    let nmax = low_n.max(high_n) as u64;
    poly_bytes((4 * (r as u64 + 1) + 2) * nmax.max(1) + (r * want.len()) as u64, 2 * pabits + 64)
}

fn cld_columns(b: &Budget, g: &[BigInt], us: &[Held<'_>], pa: &BigInt, want: &[usize]) -> FResult<Vec<Vec<BigInt>>> {
    let n = deg(g);
    let r = us.len();
    let l = g.last().unwrap().mod_floor(pa);
    let low_n = want.iter().filter(|&&j| 2 * j < n).map(|&j| j + 1).max().unwrap_or(0);
    let high_n = want.iter().filter(|&&j| 2 * j >= n).map(|&j| n - j).max().unwrap_or(0);
    // prefix/suffix tables: 2 (r + 1) truncated polynomials per side
    let _r = b.reserve_as("cld", cld_columns_bytes(n, r, want, pa.bits()))?;
    let mut out = vec![vec![BigInt::zero(); r]; want.len()];
    for (side, nn) in [(0, low_n), (1, high_n)] {
        if nn == 0 {
            continue;
        }
        // the factors as seen from this side
        let polys: Vec<Vec<BigInt>> = us
            .iter()
            .map(|u| if side == 0 { u.iter().take(nn).cloned().collect() } else { u.iter().rev().take(nn).cloned().collect() })
            .collect();
        let mut pre = vec![vec![BigInt::one()]];
        for x in &polys {
            let next = tmul(b, pre.last().unwrap(), x, nn, pa)?;
            pre.push(next);
        }
        let mut suf = vec![vec![BigInt::one()]; r + 1];
        for i in (0..r).rev() {
            suf[i] = tmul(b, &polys[i], &suf[i + 1], nn, pa)?;
        }
        for i in 0..r {
            let u = &us[i];
            let di = u.len() - 1;
            // u_i' at its formal degree d_i - 1 (low side: as is; high: reversed)
            let du: Vec<BigInt> = if side == 0 {
                (1..=di).map(|k| &u[k] * BigInt::from(k as u64)).take(nn).collect()
            } else {
                (0..di).map(|t| &u[di - t] * BigInt::from((di - t) as u64)).take(nn).collect()
            };
            let mut c = tmul(b, &du, &pre[i], nn, pa)?;
            c = tmul(b, &c, &suf[i + 1], nn, pa)?;
            for (w, &j) in want.iter().enumerate() {
                let idx = if side == 0 {
                    if 2 * j >= n {
                        continue;
                    }
                    j
                } else {
                    if 2 * j < n {
                        continue;
                    }
                    n - 1 - j
                };
                out[w][i] = (&l * &c[idx]).mod_floor(pa);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::budget::Limits;
    use crate::{zmul, Budget};

    fn z(v: &[i64]) -> Vec<BigInt> {
        v.iter().map(|&x| BigInt::from(x)).collect()
    }

    /// x S_4 (S_4 = prod (x +- sqrt 2 +- sqrt 3 +- sqrt 5 +- sqrt 7), 8
    /// quadratics modulo every good prime): 9 modular factors, so the
    /// lattice's recombine runs, and x divides the polynomial.
    fn x_s4() -> Vec<BigInt> {
        z(&[0, 46225, 0, -5596840, 0, 13950764, 0, -7453176, 0, 1513334, 0, -141912, 0, 6476, 0, -136, 0, 1])
    }

    #[test]
    fn x_dividing_the_residual_is_an_internal_error() {
        // the pre-pass removes x (a singleton): two factors, x and S_4
        let (_, fs) = crate::try_factor_with(&x_s4(), &Budget::default()).unwrap();
        let mut degs: Vec<usize> = fs.iter().map(|(h, _)| h.len() - 1).collect();
        degs.sort();
        assert_eq!(degs, vec![1, 16]);
        // without it, x | g reaches the invariant: an internal error, not a
        // subset search and not a resource refusal
        let e = fault::with(fault::SKIP_PREPASS, || crate::try_factor_with(&x_s4(), &Budget::default())).unwrap_err();
        assert_eq!(e.kind, crate::Kind::Internal);
        assert_eq!(e.what, "x divides the residual after the pre-pass");
        let m = e.to_string();
        assert!(m.starts_with(crate::INTERNAL_PREFIX), "{}", m);
        assert!(m.ends_with("please report it; not factored") && !m.contains("resource limit"), "{}", m);
    }

    /// The full c_i = l u_i' prod_{j != i} u_j mod m, for comparison.
    fn full_cld(b: &Budget, l: &BigInt, us: &[Vec<BigInt>], i: usize, m: &BigInt) -> Vec<BigInt> {
        let du: Vec<BigInt> = us[i].iter().enumerate().skip(1).map(|(k, c)| c * BigInt::from(k as u64)).collect();
        let mut acc = vec![l.clone()];
        acc = zmul(b, &acc, &du).unwrap().into_vec();
        for (j, u) in us.iter().enumerate() {
            if j != i {
                acc = zmul(b, &acc, u).unwrap().into_vec();
            }
        }
        acc.iter().map(|c| c.mod_floor(m)).collect()
    }

    #[test]
    fn truncated_columns_match_full_cld() {
        // non-monic g = 6 (x - 1)(x + 2)(x^2 + 3)(x + 5) with "lifted" monic
        // factors modulo m = 7^3 (exactly the factors, so the identity holds)
        let b = Budget::default();
        let m = BigInt::from(343);
        let us: Vec<Vec<BigInt>> = vec![z(&[-1, 1]), z(&[2, 1]), z(&[3, 0, 1]), z(&[5, 1]), z(&[14, 1])];
        let mut g = z(&[6]);
        for u in &us {
            g = zmul(&b, &g, u).unwrap().into_vec();
        }
        let n = g.len() - 1;
        let held: Vec<Held> = us.iter().map(|u| Held::copy(&b, &u.iter().map(|c| c.mod_floor(&m)).collect::<Vec<_>>()).unwrap()).collect();
        let want: Vec<usize> = (0..n).collect();
        let cols = cld_columns(&b, &g, &held, &m, &want).unwrap();
        let usm: Vec<Vec<BigInt>> = held.iter().map(|h| h.v.clone()).collect();
        for i in 0..us.len() {
            let full = full_cld(&b, &BigInt::from(6), &usm, i, &m);
            for (w, &j) in want.iter().enumerate() {
                assert_eq!(cols[w][i], full.get(j).cloned().unwrap_or_default(), "i {} j {}", i, j);
            }
        }
        // and requested again, in another order, high first (repeatable)
        let want2 = vec![n - 1, 0, n - 2, 1];
        let cols2 = cld_columns(&b, &g, &held, &m, &want2).unwrap();
        for (w, &j) in want2.iter().enumerate() {
            assert_eq!(cols2[w], cols[j]);
        }
    }

    #[test]
    fn derivative_leading_term_divisible_by_p() {
        // a factor of degree p = 3: u' has leading coefficient 3 = 0 mod 3^a's
        // prime; the formal reversal degree must still be d - 1
        let b = Budget::default();
        let m = BigInt::from(27);
        let us: Vec<Vec<BigInt>> = vec![z(&[1, 1, 0, 1]), z(&[2, 1])];
        let mut g = z(&[2]);
        for u in &us {
            g = zmul(&b, &g, u).unwrap().into_vec();
        }
        let n = g.len() - 1;
        let held: Vec<Held> = us.iter().map(|u| Held::copy(&b, u).unwrap()).collect();
        let want: Vec<usize> = (0..n).collect();
        let cols = cld_columns(&b, &g, &held, &m, &want).unwrap();
        for i in 0..2 {
            let full = full_cld(&b, &BigInt::from(2), &us, i, &m);
            for &j in &want {
                assert_eq!(cols[j][i], full.get(j).cloned().unwrap_or_default());
            }
        }
    }

    #[test]
    fn cld_columns_refuse_before_allocating() {
        // a budget too small for the prefix tables: refused before they
        // exist (the counting allocator of lib.rs's tests)
        let b = Budget::default();
        let m = BigInt::from(7).pow(200);
        let us: Vec<Held> = (0..40).map(|i| Held::copy(&b, &[BigInt::from(i), BigInt::from(3), BigInt::one()]).unwrap()).collect();
        let mut g = vec![BigInt::one()];
        for u in &us {
            g = zmul(&b, &g, u).unwrap().into_vec();
        }
        let small = Budget::new(crate::Limits { memory: 4096, ..crate::Limits::DEFAULT });
        let want: Vec<usize> = (0..8).collect();
        let before = crate::alloc_spy::allocated();
        let e = cld_columns(&small, &g, &us, &m, &want).err().unwrap();
        let used = crate::alloc_spy::allocated() - before;
        assert_eq!(e.what, "memory");
        assert!(used < 1024, "allocated {} bytes before refusing", used);
    }

    #[test]
    fn bounds_hold_for_true_factors() {
        // |[x^j] f g'/g| <= B_j for every factor g of f = (x^2 + 1)(x - 3)(2x + 5)(x^3 - 7)
        let b = Budget::default();
        let fs = [z(&[1, 0, 1]), z(&[-3, 1]), z(&[5, 2]), z(&[-7, 0, 0, 1])];
        let mut f = z(&[1]);
        for u in &fs {
            f = zmul(&b, &f, u).unwrap().into_vec();
        }
        let (bounds, _r) = cld_bounds(&b, &f).unwrap();
        for mask in 1u32..16 {
            let mut gp = z(&[1]);
            for (i, u) in fs.iter().enumerate() {
                if mask >> i & 1 == 1 {
                    gp = zmul(&b, &gp, u).unwrap().into_vec();
                }
            }
            let q = divexact(&b, &f, &gp).unwrap().unwrap().into_vec();
            let dg: Vec<BigInt> = gp.iter().enumerate().skip(1).map(|(k, c)| c * BigInt::from(k as u64)).collect();
            let v = zmul(&b, &q, &dg).unwrap().into_vec(); // f g'/g
            for (j, c) in v.iter().enumerate() {
                assert!(c.abs() <= bounds[j], "mask {} j {}: {} > {}", mask, j, c, bounds[j]);
            }
        }
    }

    // ---------------------------------------------------------------- the ledger (plan r3, sections 3.7 and 4.5; delta 1 r2)

    /// S_6's lattice call as recombine makes it (S_6 is irreducible: the
    /// pre-pass leaves g = S_6 with every lifted factor), under `b`.
    /// With `limit`, that is the memory limit of the lattice call (after the
    /// setup, which has room).
    fn s6_lattice(b: &Budget, limit: Option<u64>) -> (Vec<BigInt>, FResult<Option<usize>>, crate::alloc_spy::Report) {
        let f = crate::tests::swinnerton_dyer(6);
        let m = crate::modular(b, &f).unwrap().unwrap();
        let lifted = crate::lift(b, &f, &m, m.k).unwrap();
        assert!(lifted.len() > ZASSENHAUS_MAX);
        b.set_memory_limit(limit.unwrap_or(1 << 30));
        ledger_log::reset();
        let (r, rep) = crate::alloc_spy::audit(|| lattice(b, &f, &m, &lifted).map(|o| o.map(|fs| fs.len())));
        (f, r, rep)
    }

    #[test]
    fn the_ledger_holds_on_s6() {
        let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
        let (_f, r, rep) = s6_lattice(&b, None);
        // S_6 is irreducible: one factor, certified
        assert_eq!(r.unwrap(), Some(1));
        let (reached, peak, relift) = ledger_log::get();
        // every checkpoint ran (each one asserted b.live() = the formula)
        for at in ["entry", "the pw loop", "before LLL", "the cut", "certify"] {
            assert!(reached.get(at).copied().unwrap_or(0) >= 1, "checkpoint {at} not reached: {reached:?}");
        }
        assert!(!relift, "S_6 certifies at level 0");
        // sizes: no tagged object outgrows its reservation; the global net
        assert_eq!(rep.tag_breaches, 0, "{:?}", rep.first_breach);
        assert!(rep.excess <= 64 << 10, "{rep:?}");
        // the predicted peak (hand-offs counted) is the observed one
        assert_eq!(b.peak(), peak, "predicted at line {}", ledger_log::peak_line());
        eprintln!("S_6 lattice: predicted peak {peak} at line {}", ledger_log::peak_line());
        assert_eq!(b.live(), 0);
    }

    #[test]
    fn the_size_tags_hold_on_s6() {
        // delta 1 r2 (B) on its own, without the equality checkpoints: the
        // bounds, the column indices, pw and the CLD values stay within
        // their own reservations, whatever the over-charge elsewhere
        let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
        let (_f, r, rep) = ledger_log::without_checkpoints(|| s6_lattice(&b, None));
        assert_eq!(r.unwrap(), Some(1));
        assert_eq!(rep.tag_breaches, 0, "{:?}", rep.first_breach);
    }

    #[test]
    fn s6_tight_memory() {
        // the predicted peak (the formula, not an observed Budget::peak)
        let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
        let (_, r, _) = s6_lattice(&b, None);
        assert_eq!(r.unwrap(), Some(1));
        let (_, peak, _) = ledger_log::get();
        let line = ledger_log::peak_line();
        drop(b);
        // exactly the peak admits: certified, and nothing left reserved
        let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
        let (_, r, _) = s6_lattice(&b, Some(peak));
        assert_eq!(r.unwrap(), Some(1), "at the predicted peak {peak}");
        assert_eq!(b.live(), 0);
        drop(b);
        // one byte less refuses at that reservation, by one byte, before
        // anything of it is allocated, and unwinds to no reservation
        let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
        let (_, r, _) = s6_lattice(&b, Some(peak - 1));
        let after = crate::alloc_spy::allocated();
        let e = r.unwrap_err();
        assert_eq!((e.what, e.kind, e.phase), ("memory", crate::Kind::Resource, Phase::Lattice), "{e}");
        assert_eq!(e.need - e.remaining, 1, "{e}");
        assert_eq!(after, crate::alloc_spy::refused_at(), "allocations after the refusal");
        assert_eq!(b.live(), 0);
        eprintln!("S_6 tight: peak {peak} (line {line}) admits; {} refuses in {} (need {})", peak - 1, e.phase.name(), e.need);
    }
}
