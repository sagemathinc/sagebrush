//! Route 3's model: the units its parts charge, walked from their loops
//! at given sizes, one term a part (the three inverses each a term of
//! their own: B_J's, the left side's C^T, the core's T).  Assumes dense
//! residues, the echelons' pivots coprime to their modulus after the
//! Bezout steps (no Howell generator survives), and no prime dropping
//! the rank.

use super::{at_attempts, cyclic_model, steps, times, Constants};
use crate::cost::{bigdiv_units, biggcd_units, bigmul_units, bigxgcd_units, size_product, Family, Units};
use crate::zmat::{self, limbs, ZMat};
use num_traits::{One, Signed, Zero};
use sagebrush_bigint::BigInt;

/// The sizes of one Compress of an r x w matrix B (w > r) with pivot
/// columns J: B's limbs, delta's bits and limbs, N's limbs, G's limbs and
/// bits, and the Q entries G's fold reads.
#[derive(Clone, Copy, Debug)]
#[doc(hidden)]
pub struct Side {
    pub r: usize,
    pub w: usize,
    pub lb: usize,
    pub ld: usize,
    pub delta_bits: u64,
    pub ln: usize,
    pub lg: usize,
    pub g_bits: u64,
    pub folds: usize,
    /// The share of N's entries that are nonzero (1 for a dense B_J; the
    /// left side's B_J = C^T is the identity but for C's few rows of
    /// nontrivial pivots, so its inverse is too).
    pub nd: f64,
    /// The row echelon's pivots: the image of Q modulo delta lies in Z^r /
    /// B_J Z^r, whose invariant factors bound them (1 when it is cyclic,
    /// |det B_J| = delta; else taken as 3).
    pub piv: usize,
    /// The limbs of gcd(delta, Q's entries), the fold's running gcd after
    /// its first steps.
    pub lgq: usize,
    /// X's right-hand sides are C's columns, the identity's but for C's
    /// few rows of nontrivial pivots, solved by y = 0 (the left side after a
    /// column side): t = c has about 3 nonzero entries.
    pub sparse_x: bool,
}

/// The sizes route 3's model walks at: A (m x n, rank r, entries of `la`
/// limbs), the column side and the left side (None when skipped), the
/// three inverses' units, the core's delta bits, and the failed inverse
/// pass (square input).
#[derive(Clone, Debug)]
#[doc(hidden)]
pub struct Route3Sizes {
    pub m: usize,
    pub n: usize,
    pub r: usize,
    pub la: usize,
    pub cols: Option<Side>,
    pub left: Option<Side>,
    pub inv_bj: Units,
    pub inv_ct: Units,
    pub inv_t: Units,
    pub t_delta_bits: u64,
    pub failed_pass: Units,
}

/// The left side's N density after a column side: the identity's r
/// entries and, for each of C's rows of a nontrivial pivot (taken as 2),
/// a dense column of r.
#[allow(non_snake_case)]
fn LEFT_DENSITY(r: usize) -> f64 {
    ((1 + 2) as f64 / r.max(1) as f64).min(1.0)
}

/// The batch length of the word primes' echelons (their products summed
/// in u128).
fn word_batch() -> usize {
    let p = crate::nmod::Primes::new().next().expect("a prime");
    crate::nmod_mat::batch_of(&crate::nmod::Modulus::new(p))
}

/// One ring operation lin(s, x, u, y) at a modulus of `le` limbs, x of
/// `lx` limbs (the word ring: one ModArith unit).
fn lin(word: bool, le: usize, lx: usize) -> Units {
    let mut u = Units::default();
    if word {
        u.0[Family::ModArith as usize] = 1;
    } else {
        u.add_saturating(&bigmul_units(le, lx));
        u.add_saturating(&bigmul_units(le, lx));
        u.add_saturating(&bigdiv_units(2 * le + 1, le));
    }
    u
}

/// A matrix product's charge (`ZMat::mul`): r x k by k x c, dense, at
/// entries of la and lb limbs; the one-word path charges a unit product
/// each.
fn mul(r: usize, k: usize, c: usize, la: usize, lb: usize) -> Units {
    let mut u = Units::default();
    let one = if la == 1 && lb == 1 { bigmul_units(1, 1) } else { bigmul_units(la, lb) };
    times(&mut u, size_product(&[r, k, c]), &one);
    u
}

/// count times d, rounded up.
fn part(count: u64, d: f64) -> u64 {
    (count as f64 * d).ceil() as u64
}

/// Compress's terms: the blocks' copies, Q = N B_J', G's fold, the column
/// Howell echelon modulo G and its lift, N C and the residues, the row
/// Howell echelon modulo delta, and the k kernel columns' and r columns
/// of X's back substitutions and exact products.  (B_J's inverse is the
/// caller's term.)
fn compress(s: &Side, side: &str, out: &mut Vec<(String, Units)>) {
    let mut push = |name: &str, u: Units| out.push((format!("{side}{name}"), u));
    let (r, w) = (s.r, s.w);
    let k = w - r;
    let mv = Family::Move as usize;
    let ma = Family::ModArith as usize;
    let mut copies = Units::default();
    copies.0[mv] = size_product(&[r, w, s.lb]);
    push("blocks", copies);
    let lq = s.ln + s.lb;
    // (the one-word path of a product charges its zeros too: N's density
    // counts on the multi-limb one only)
    let one_word = |l: usize| s.ln == 1 && l == 1;
    let dens = |l: usize| if one_word(l) { 1.0 } else { s.nd };
    let mut qm = Units::default();
    times(&mut qm, part(size_product(&[r, r, k]), dens(s.lb)), &bigmul_units(s.ln, s.lb));
    push("Q", qm);
    let mut g = Units::default();
    if s.folds > 0 {
        g.add_saturating(&biggcd_units(s.ld, lq));
        times(&mut g, s.folds as u64 - 1, &biggcd_units(s.lgq, lq));
    }
    g.add_saturating(&bigdiv_units(s.ld, s.ld));
    g.add_saturating(&bigmul_units(1, s.lg));
    push("G", g);
    // the column echelon: B's residues; row i reads its pool of w - i
    // columns (i + 1 entries each, then the pool's length), combines the
    // other w - i - 1 into the pivot (a Bezout step and 2 r ring operations
    // each: the i entries above are zero, one limb), then the pivot's gcd
    // with G, G / g and the generator's r operations
    let gw = s.g_bits < 62;
    let mut ech = Units::default();
    if gw {
        ech.0[ma] = size_product(&[r, w, s.lb]);
    } else {
        times(&mut ech, size_product(&[r, w]), &bigdiv_units(s.lb, s.lg));
    }
    // (G = 1: every residue is 0, every column is read through and dropped
    // at row 0, each row's pivot is G e_i, and the lift has no quotient)
    let unit = s.g_bits <= 1;
    if unit {
        ech.0[mv] = ech.0[mv].saturating_add(size_product(&[r, w]));
    }
    for i in (0..r).filter(|_| !unit) {
        steps(1);
        let pool = (w - i) as u64;
        ech.0[mv] = ech.0[mv].saturating_add(pool.saturating_mul(i as u64 + 2));
        let others = pool.saturating_sub(1);
        if gw {
            // (the first step's Euclid from a residue of G's size, then a
            // small pivot: two steps)
            let eu = if others > 0 { s.g_bits * 6 / 10 + 1 + 2 * (others - 1) } else { 0 };
            ech.0[ma] = ech.0[ma].saturating_add(eu + others * 2 * r as u64 + 1 + r as u64);
        } else {
            let mut step = Units::default();
            step.add_saturating(&bigxgcd_units(1, s.lg));
            step.add_saturating(&bigdiv_units(2 * s.lg, s.lg));
            step.add_saturating(&bigdiv_units(2 * s.lg, s.lg));
            times(&mut step, 2 * i as u64, &lin(false, s.lg, 1));
            times(&mut step, 2 * (r - i) as u64, &lin(false, s.lg, s.lg));
            times(&mut ech, others, &step);
            ech.add_saturating(&bigxgcd_units(s.lg, 1));
            ech.add_saturating(&bigdiv_units(2 * s.lg, s.lg));
            times(&mut ech, i as u64, &lin(false, s.lg, 1));
            times(&mut ech, (r - i) as u64, &lin(false, s.lg, s.lg));
        }
        ech.add_saturating(&bigdiv_units(s.lg, 1));
    }
    push("C echelon", ech);
    // the lift: for each pair t < i a division by g_i (1), and its quotient
    // (G's size) times col_i's r - i entries, each but the pivot's reduced
    // modulo G
    let mut lift = Units::default();
    lift.0[mv] = size_product(&[r, r]);
    let pairs = size_product(&[r, r.saturating_sub(1)]) / 2;
    times(&mut lift, pairs, &bigdiv_units(s.lg, 1));
    // (the sum over i of i (r - i - 1): r (r - 1) (r - 2) / 6)
    let triples = size_product(&[r, r.saturating_sub(1), r.saturating_sub(2)]) / 6;
    let mut red = bigmul_units(s.lg, s.lg);
    red.add_saturating(&bigdiv_units(2 * s.lg, s.lg));
    if !unit {
        times(&mut lift, pairs, &bigmul_units(s.lg, 1));
        times(&mut lift, triples, &red);
    }
    push("lift", lift);
    // N C, and the residues of Q and N C modulo delta
    // (C is the identity but for its rows of nontrivial pivots, taken as
    // 2: one-limb entries but those)
    let mut nc = Units::default();
    let cbig = (2.0 / r.max(1) as f64).min(1.0);
    let ncount = part(size_product(&[r, r, r]), dens(s.lg));
    times(&mut nc, part(ncount, cbig), &bigmul_units(s.ln, s.lg));
    times(&mut nc, ncount - part(ncount, cbig), &bigmul_units(s.ln, 1));
    let dw = s.delta_bits < 62;
    let entries = size_product(&[r, w]);
    if dw {
        nc.0[ma] = nc.0[ma].saturating_add(entries.saturating_mul(lq as u64));
    } else {
        times(&mut nc, entries, &bigdiv_units(lq, s.ld));
    }
    push("N C", nc);
    // the row echelon: p pivots, the first's pool all r rows, a later one's
    // the p - j rows left (the others vanish modulo delta), each read to
    // its column, Bezout steps of 2 w operations into the pivot, the gcd,
    // delta / g and the generator's w operations
    let p = s.piv.min(r).min(k);
    let mut rows = Units::default();
    for j in 0..p {
        steps(1);
        let pool = if j == 0 { r as u64 } else { (p - j) as u64 };
        rows.0[mv] = rows.0[mv].saturating_add(pool.saturating_mul(j as u64 + 2));
        let others = pool - 1;
        if dw {
            let eu = if others > 0 { s.delta_bits * 6 / 10 + 1 + 2 * (others - 1) } else { 0 };
            rows.0[ma] = rows.0[ma].saturating_add(eu + others * 2 * w as u64 + 1 + w as u64);
        } else {
            let mut step = Units::default();
            step.add_saturating(&bigxgcd_units(1, s.ld));
            step.add_saturating(&bigdiv_units(2 * s.ld, s.ld));
            step.add_saturating(&bigdiv_units(2 * s.ld, s.ld));
            times(&mut step, 2 * w as u64, &lin(false, s.ld, s.ld));
            times(&mut rows, others, &step);
            rows.add_saturating(&bigxgcd_units(s.ld, 1));
            rows.add_saturating(&bigdiv_units(2 * s.ld, s.ld));
            times(&mut rows, w as u64, &lin(false, s.ld, s.ld));
        }
        rows.add_saturating(&bigdiv_units(s.ld, 1));
    }
    push("H echelon", rows);
    // the solved columns: each a back substitution over the pivots (two
    // operations a term and a division a pivot), then B_J' y, N t and the
    // exact divisions by delta; a pivot coordinate's y is its lead alone
    // (delta / g, a residue 0), a free coordinate's and X's grow to p + 1
    // entries
    let bsub = |u: &mut Units, terms: u64, pivots: u64| {
        if dw {
            u.0[ma] = u.0[ma].saturating_add(2 * terms);
        } else {
            let mut t = lin(false, s.ld, s.ld);
            t.add_saturating(&bigmul_units(1, s.ld));
            t.add_saturating(&bigdiv_units(2 * s.ld + 1, s.ld));
            times(u, terms, &t);
        }
        times(u, pivots, &bigdiv_units(s.ld, 1));
    };
    let exact = |u: &mut Units, ys: u64| {
        times(u, ys.saturating_mul(r as u64), &bigmul_units(s.lb, s.ld));
        times(u, part(size_product(&[r, r]), s.nd), &bigmul_units(s.ln, s.lb + s.ld));
        times(u, r as u64, &bigdiv_units(s.ln + s.lb + s.ld, s.ld));
        u.0[mv] = u.0[mv].saturating_add(r as u64 + ys);
    };
    let mut kx = Units::default();
    let pp = p as u64;
    // pivot coordinates x < p: x earlier pivots, one term each
    bsub(&mut kx, pp * pp.saturating_sub(1) / 2, pp * pp.saturating_sub(1) / 2);
    times(&mut kx, pp, &bigdiv_units(s.ld, 1));
    let mut one = Units::default();
    exact(&mut one, 1);
    times(&mut kx, pp, &one);
    // free coordinates (k - p) and X's r columns: p pivots, y growing to p
    let free = if s.sparse_x { (k - p) as u64 } else { (k - p + r) as u64 };
    let mut col = Units::default();
    bsub(&mut col, pp * (pp + 1) / 2, pp);
    exact(&mut col, pp + 1);
    times(&mut kx, free, &col);
    if s.sparse_x {
        // X: the back substitution's pivots, then N c (3 entries of c) and
        // the divisions
        let mut x = Units::default();
        times(&mut x, pp, &bigdiv_units(s.ld, 1));
        times(&mut x, 3 * r as u64, &bigmul_units(s.ln, s.lg));
        times(&mut x, r as u64, &bigdiv_units(s.ln + s.lg, s.ld));
        x.0[mv] = x.0[mv].saturating_add(r as u64);
        times(&mut kx, r as u64, &x);
    }
    push("K and X", kx);
}

/// Route 3's terms at the given sizes: the entry, the failed pass (square
/// input), the profile and the three inverses as modeled; the rest (both
/// Compresses, the certificate, A X, the core's route, the block
/// combination) scaled by the fitted constant of the first side's G ring
/// (word or multi-limb).
#[doc(hidden)]
pub fn route3_terms(z: &Route3Sizes, c: &Constants) -> Vec<(String, Units)> {
    let (m, n, r) = (z.m, z.n, z.r);
    let mv = Family::Move as usize;
    let mut out: Vec<(String, Units)> = vec![];
    let mut entry = Units::default();
    entry.0[mv] = size_product(&[m, n, z.la]).saturating_add(size_product(&[m, m])).saturating_add(size_product(&[n, n]));
    out.push(("entry".into(), entry));
    if m == n && m > 0 {
        out.push(("failed pass".into(), z.failed_pass));
    }
    // the profile: A's reduction and its echelon modulo a word prime (and
    // B = A_I's copy for a column side)
    let mut prof = Units::default();
    prof.0[Family::ModArith as usize] = size_product(&[m, n, z.la]);
    let (lo, hi) = (m.min(n), m.max(n));
    if lo > 0 {
        prof.add_saturating(&Units(crate::nmod_mat::echelon_units_dense(lo, hi, word_batch())));
    }
    if z.cols.is_some() {
        prof.0[mv] = prof.0[mv].saturating_add(size_product(&[r, n, z.la]));
    }
    out.push(("profile".into(), prof));
    let mut rest: Vec<(String, Units)> = vec![];
    if let Some(s) = &z.cols {
        out.push(("col: B_J inverse".into(), z.inv_bj));
        compress(s, "col: ", &mut rest);
        if r < m {
            // the certificate on the m - r rows outside I (K's copy and the
            // product), then A X
            // (K's and X's rows J dense, of N B_J' y's size; their rows J'
            // y's, about one limb but the p + 1 nonzero entries of delta's
            // size)
            let lk = s.ln + s.lb;
            let mut cert = Units::default();
            cert.0[mv] = size_product(&[r, n - r, lk]).saturating_add(size_product(&[n - r, n - r])).saturating_add(size_product(&[m - r, n, z.la]));
            times(&mut cert, size_product(&[m - r, n - r, r]), &bigmul_units(z.la, lk));
            times(&mut cert, size_product(&[m - r, n - r, n - r]), &bigmul_units(z.la, 1));
            rest.push(("certificate".into(), cert));
            // (A X, then its transpose's copy)
            let mut ax = Units::default();
            times(&mut ax, size_product(&[m, r, r]), &bigmul_units(z.la, lk));
            times(&mut ax, size_product(&[m, r, n - r]), &bigmul_units(z.la, 1));
            ax.0[mv] = ax.0[mv].saturating_add(size_product(&[m, r, s.lg]));
            rest.push(("A X".into(), ax));
        }
    } else if z.left.is_some() {
        // (A^T's copy)
        let mut ax = Units::default();
        ax.0[mv] = size_product(&[m, n, z.la]);
        rest.push(("A X".into(), ax));
    }
    if let Some(s) = &z.left {
        out.push(("left: B_J inverse".into(), z.inv_ct));
        compress(s, "left: ", &mut rest);
    }
    // the core: T's inverse, and route 1 at T's sizes
    out.push(("T inverse".into(), z.inv_t));
    if r > 0 {
        let word = z.t_delta_bits < 62;
        let ld = (z.t_delta_bits as usize).div_ceil(64).max(1);
        rest.push(("core".into(), at_attempts(c.attempts_cyclic, |t| cyclic_model(r, ld, ld, t, 2, word, z.t_delta_bits.max(1)))));
    }
    // the block combination: X V1 and U1 U0_top, and D
    let mut comb = Units::default();
    if let Some(s) = &z.cols {
        // (X V1 by X's nonzero entries: X_J dense, X_J' a column's y, at
        // most min(r, n - r) + 1 of them)
        let lx = s.ln + s.lb;
        let nz = size_product(&[r, r]).saturating_add(size_product(&[r, s.piv.min(r).min(n - r) + 1]));
        times(&mut comb, nz.saturating_mul(r as u64), &bigmul_units(lx, 1));
        comb.0[mv] = comb.0[mv].saturating_add(size_product(&[n, r, lx]));
    }
    if let Some(s) = &z.left {
        let lu = s.ln + s.lb;
        comb.add_saturating(&mul(r, r, m, 1, lu));
        comb.0[mv] = comb.0[mv].saturating_add(size_product(&[r, m, lu]));
    }
    comb.0[mv] = comb.0[mv].saturating_add(size_product(&[m, n])).saturating_add(r as u64);
    rest.push(("combine".into(), comb));
    let gw = z.cols.as_ref().or(z.left.as_ref()).is_none_or(|s| s.g_bits < 62);
    let scale = c.scale_route3[if gw { 0 } else { 1 }];
    for (name, u) in rest {
        let mut v = Units::default();
        super::add_scaled(&mut v, &u, scale);
        out.push((name, v));
    }
    out
}

/// [`route3_terms`]' sum.
#[doc(hidden)]
pub fn route3_model(z: &Route3Sizes, c: &Constants) -> Units {
    let mut u = Units::default();
    for (_, t) in route3_terms(z, c) {
        u.add_saturating(&t);
    }
    u
}

/// The failed inverse pass on a singular square input of n rows (h the
/// Hadamard bound's log2, `red` a reduction's units): two primes'
/// eliminations of [a | I] that drop the rank, then the multimodular
/// determinant (an elimination a prime, over the bound's primes).
#[doc(hidden)]
pub fn failed_pass_model(n: usize, h: f64, red: u64) -> Units {
    let mut u = Units::default();
    if n == 0 {
        return u;
    }
    let mut aug = Units(crate::nmod_mat::echelon_units_dense(n, 2 * n, word_batch()));
    aug.0[Family::ModArith as usize] = aug.0[Family::ModArith as usize].saturating_add(red);
    aug.0[Family::Move as usize] = aug.0[Family::Move as usize].saturating_add(size_product(&[n, n, 3]));
    times(&mut u, 2, &aug);
    let primes = ((h.max(0.0) + 2.0) / 61.9).ceil().max(1.0) as u64;
    let mut det = Units(crate::nmod_mat::echelon_units_dense(n, n, word_batch()));
    det.0[Family::ModArith as usize] = det.0[Family::ModArith as usize].saturating_add(red + 3);
    times(&mut u, primes, &det);
    times(&mut u, primes, &bigmul_units(primes as usize, 1));
    u
}

/// k^ for any shape at rank `rank`: a prime p dividing the contents of R_p
/// rows (zero rows included) and of C_p columns bounds rank_p(A) by min(m
/// - R_p, n - C_p), and rank_p(A) is the number of nonzero invariant
/// factors p does not divide, so at least rank - min(m - R_p, n - C_p) of
/// them p divides; k^ is the largest over the primes below 100.  At rank =
/// r it is a lower bound on k (the nonzero nontrivial factors); stage 1
/// takes rank = min(m, n), the generic case, which is at most k + (min(m,
/// n) - r).
#[doc(hidden)]
pub fn k_lower_bound_rect(a: &ZMat, rank: usize) -> usize {
    use num_integer::Integer;
    let (m, n) = (a.rows, a.cols);
    let mut row = vec![BigInt::zero(); m];
    let mut col = vec![BigInt::zero(); n];
    for (i, ri) in row.iter_mut().enumerate() {
        for (j, cj) in col.iter_mut().enumerate() {
            let x = a.get(i, j);
            if !x.is_zero() {
                if !ri.is_one() {
                    *ri = ri.gcd(x);
                }
                if !cj.is_one() {
                    *cj = cj.gcd(x);
                }
            }
        }
    }
    steps(1);
    super::SMALL_PRIMES
        .iter()
        .map(|&p| {
            let p = BigInt::from(p);
            let count = |cs: &[BigInt]| cs.iter().filter(|c| (*c % &p).is_zero()).count();
            rank.saturating_sub((m - count(&row)).min(n - count(&col)))
        })
        .max()
        .unwrap_or(0)
}

/// The core's route: route 2 at k^ when k^ >= 2, else route 1, at T's
/// sizes (r x r, delta of `t_bits` bits).
fn core_model(r: usize, t_bits: u64, kh: usize, c: &Constants) -> Units {
    let word = t_bits < 62;
    let ld = (t_bits as usize).div_ceil(64).max(1);
    if kh >= 2 && r >= kh {
        let mut dls = vec![1; kh - 1];
        dls.push(ld);
        at_attempts(c.attempts_trailing, |t| super::trailing_model(r, kh, ld, ld, t, word, t_bits.max(1), &dls, c.vinv_of_delta, c.multiplier))
    } else {
        at_attempts(c.attempts_cyclic, |t| cyclic_model(r, ld, ld, t, 2, word, t_bits.max(1)))
    }
}

/// An r x r inverse modeled from sizes: Hadamard's log2 `h`, entries of
/// `le` limbs, the determinant of `lx` limbs.
fn inverse_at(r: usize, h: f64, le: usize, lx: usize) -> Units {
    zmat::inverse_model_sizes(r, h, size_product(&[r, r, le]), lx, 2, None)
}

/// Stage 1 for route 3 (non-square input, or a square one with a zero row
/// or column): the generic case, rank r = min(m, n) (a square input with
/// a zero row or column: n - 1), index 1 (G and T word-sized), the first
/// side's delta from Hadamard's bound on an r x r block of the r rows
/// (wide) or columns (tall) less the fitted gap, its inverse at those sizes.
#[doc(hidden)]
pub fn stage1_route3(a: &ZMat, c: &Constants) -> Option<Units> {
    let (m, n) = (a.rows, a.cols);
    if m == 0 || n == 0 {
        return None;
    }
    let r = if m == n { n - 1 } else { m.min(n) };
    let la = super::mean_limbs(a);
    let (rows, cols) = zmat::norm_bits(a);
    // r of the norms (the largest: a bound on any r x r block), shrunk by
    // sqrt(r / length) for the block's share of each
    let block = |v: &[f64], len: usize| -> f64 {
        let mut v = v.to_vec();
        v.sort_by(|x, y| y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal));
        v.iter().take(r).sum::<f64>() - 0.5 * r as f64 * (len as f64 / r.max(1) as f64).log2()
    };
    let wide = m <= n;
    let h = if wide { block(&rows, n) } else { block(&cols, m) };
    let dh = (h - c.hadamard_gap * r as f64).max(1.0).ceil() as u64;
    let ld = (dh as usize).div_ceil(64).max(1);
    let side = |w: usize| Side { r, w, lb: la, ld, delta_bits: dh, ln: ld, lg: 1, g_bits: 1, folds: 2, nd: 1.0, piv: 1, lgq: 1, sparse_x: false };
    let inv = inverse_at(r, h, la, ld);
    let mut z = Route3Sizes {
        m,
        n,
        r,
        la,
        cols: None,
        left: None,
        inv_bj: Units::default(),
        inv_ct: Units::default(),
        inv_t: inverse_at(r, 1.0 + 0.5 * (r as f64).log2(), 1, 1),
        t_delta_bits: 1,
        failed_pass: Units::default(),
    };
    if r < n {
        z.cols = Some(side(n));
        z.inv_bj = inv;
    }
    if r < m {
        // (after a column side, the left side's delta is at most C's index,
        // 1 here)
        let mut s = side(m);
        if z.cols.is_some() {
            s = Side { lb: 1, ld: 1, delta_bits: 1, ln: 1, nd: LEFT_DENSITY(r), sparse_x: true, ..s };
            z.inv_ct = inverse_at(r, 1.0 + 0.5 * (r as f64).log2(), 1, 1);
        } else {
            z.inv_ct = inv;
        }
        z.left = Some(s);
    }
    if m == n {
        z.failed_pass = failed_pass_model(n, 0.0, size_product(&[n, n, la]));
    }
    let kh = k_lower_bound_rect(a, m.min(n));
    let mut u = route3_model(&z, c);
    if kh >= 2 {
        // (the core at k^ instead of route 1)
        let mut swap = core_model(r, 1, kh, c);
        let one = core_model(r, 1, 0, c);
        swap.0.iter_mut().zip(&one.0).for_each(|(x, y)| *x = x.saturating_sub(*y));
        let mut s = Units::default();
        super::add_scaled(&mut s, &swap, c.scale_route3[0]);
        u.add_saturating(&s);
    }
    Some(u)
}

/// Stage 2 for route 3: after the rank profile (rank r, rows `is`,
/// columns `js`) and the first side's inverse (N / delta, det) and G; the
/// other side at its proved bounds (after a column side, the left
/// delta is at most C's index, at most G; T's delta at most the left
/// index, taken as a word), the core at the r form of k^.
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn stage2_route3(a: &ZMat, is: &[usize], js: &[usize], nm: &ZMat, delta: &BigInt, det: &BigInt, g: &BigInt, c: &Constants) -> Units {
    let mut u = Units::default();
    for (_, t) in stage2_route3_terms(a, is, js, nm, delta, det, g, c) {
        u.add_saturating(&t);
    }
    u
}

/// [`stage2_route3`]'s terms (the core's at k^ when k^ >= 2).
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn stage2_route3_terms(a: &ZMat, is: &[usize], js: &[usize], nm: &ZMat, delta: &BigInt, det: &BigInt, g: &BigInt, c: &Constants) -> Vec<(String, Units)> {
    let (m, n) = (a.rows, a.cols);
    let r = is.len();
    let la = super::mean_limbs(a);
    let ld = limbs(delta);
    let ln = super::mean_limbs(nm);
    let lg = limbs(g);
    let e = det.abs() / delta;
    // (G's fold reads Q until the running gcd is 1: G = (Delta / delta) gcd
    // reaches Delta / delta)
    let folds = if &e == g { 2 } else { size_product(&[r, n.max(m) - r]) as usize };
    let first_bj: ZMat = if r < n {
        ZMat::from_rows(is.iter().map(|&i| js.iter().map(|&j| a.get(i, j).clone()).collect()).collect())
    } else {
        ZMat::from_rows(is.iter().map(|&i| (0..n).map(|j| a.get(i, j).clone()).collect()).collect()).transpose()
    };
    let inv = zmat::inverse_model(&first_bj, limbs(det), 2, (!e.is_one()).then(|| limbs(&e)));
    let piv = if &det.abs() == delta { 1 } else { 3 };
    // (gcd(delta, Q) = G / (Delta / delta))
    let lgq = limbs(&(g / &e.max(BigInt::one())));
    let first = |w: usize| Side { r, w, lb: la, ld, delta_bits: delta.bits(), ln, lg, g_bits: g.bits(), folds, nd: 1.0, piv, lgq, sparse_x: false };
    let small = |h: f64| inverse_at(r, h + 1.0 + 0.5 * (r as f64).log2(), 1, (h as usize).div_ceil(64).max(1));
    let mut z = Route3Sizes {
        m,
        n,
        r,
        la,
        cols: None,
        left: None,
        inv_bj: Units::default(),
        inv_ct: Units::default(),
        inv_t: small(1.0),
        t_delta_bits: 1,
        failed_pass: Units::default(),
    };
    if r < n {
        z.cols = Some(first(n));
        z.inv_bj = inv;
        if r < m {
            // (A' = A X: its rows I are C, the others combinations of them,
            // entries of C's size)
            z.left = Some(Side { r, w: m, lb: lg, ld: lg, delta_bits: g.bits(), ln: lg, lg: 1, g_bits: 1, folds: 2, nd: LEFT_DENSITY(r), piv: 1, lgq: 1, sparse_x: true });
            z.inv_ct = small(g.bits() as f64);
        } else {
            // T = C: its delta at most the index, at most G
            z.t_delta_bits = g.bits();
            z.inv_t = small(g.bits() as f64);
        }
    } else if r < m {
        z.left = Some(first(m));
        z.inv_ct = inv;
    }
    if m == n {
        let red = a.d.iter().map(|x| limbs(x) as u64).sum();
        z.failed_pass = failed_pass_model(n, zmat::hadamard_bits(a), red);
    }
    let kh = k_lower_bound_rect(a, r);
    let mut terms = route3_terms(&z, c);
    if kh >= 2 {
        let scale = c.scale_route3[if g.bits() < 62 { 0 } else { 1 }];
        let mut core = Units::default();
        super::add_scaled(&mut core, &core_model(r, z.t_delta_bits, kh, c), scale);
        if let Some(t) = terms.iter_mut().find(|t| t.0 == "core") {
            t.1 = core;
        }
    }
    terms
}
