//! Route 3's Compress, for singular and rectangular input: for B (r x n,
//! full row rank) and r independent columns J, a unimodular V0 = [X | K]
//! with B V0 = [C | 0], all modular work modulo G or delta (B_J^-1 = N /
//! delta), no elimination over Z:
//!
//! - C = HNF(Lambda), Lambda = B Z^n, which contains G Z^r for G = (Delta /
//!   delta) gcd(delta, N B_J''s entries), a multiple of the index (see
//!   [`hnf_modulus`]), from a column Howell echelon of B modulo G, lifted;
//! - K: the projection of ker_Z B onto J' = the other columns is L' = {y :
//!   N B_J' y = 0 (mod delta)} (injective, as B_J is nonsingular); a row
//!   Howell form of [N B_J' | N C] modulo delta gives L''s triangular basis
//!   by back substitution (each free coordinate's vector 1 there, each
//!   pivot coordinate's delta / g there), and K_J = -(N / delta) B_J' K_J';
//! - X: for each column c of C, N B_J' y = N c (mod delta) has a solution
//!   (c is in Lambda) from the same form, already reduced against K (zero
//!   on the free coordinates, below delta / g on the pivots), and x_J =
//!   (N / delta)(c - B_J' y).
//!
//! [X | K] is unimodular: for v in Z^n, B v = C y = B X y, so v - X y is in
//! ker_Z B = K Z^(n-r).  The lifted column echelon spans Lambda: its columns
//! are in Lambda (residues of lattice vectors modulo G Z^r), and G e_i is a
//! combination of them, by induction from the last row: (G / g_i) col_i is
//! zero at rows <= i modulo G, so by the Howell property a combination of
//! the later columns modulo G Z^r.
//!
//! Units: the modular work by the ring (a word modulus: ModArith in bulk; a
//! multi-limb one: the ring's own counts), each echelon pivot and each solved column
//! a Stop check after the counts held so far; the exact integer products
//! and divisions by delta at their running sizes.

use super::ring_check;
use crate::cost::{bigdiv_units, biggcd_units, bigmul_units, size_product, Family, Local};
use crate::snf::{Big, Word, Zn, WORD_E};
use crate::zmat::{copy_units, limbs, ZMat};
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

thread_local! {
    /// The phases being recorded (their names and units), and the tally at
    /// the last mark; None when not recording.
    static PHASES: std::cell::RefCell<Option<(Vec<(String, u64)>, u64)>> = const { std::cell::RefCell::new(None) };
    /// The side a Compress runs on ("col: ", "left: ").
    static SIDE: std::cell::Cell<&'static str> = const { std::cell::Cell::new("") };
}

fn tally_total() -> u64 {
    crate::cost::tallied().0.iter().fold(0u64, |a, x| a.wrapping_add(*x))
}

/// Ends a phase: the held counts charged, and when recording its units
/// since the last mark.
fn mark(acc: &mut Local, name: &str) {
    acc.flush();
    PHASES.with(|p| {
        if let Some((v, last)) = p.borrow_mut().as_mut() {
            let t = tally_total();
            v.push((format!("{}{name}", SIDE.with(|s| s.get())), t.wrapping_sub(*last)));
            *last = t;
        }
    });
}

fn side(s: &'static str) {
    SIDE.with(|x| x.set(s));
}

/// Runs `f` recording route 3's phases (the model's terms' names: a test
/// hook for the model's killing tests).
#[doc(hidden)]
pub fn record_phases<T>(f: impl FnOnce() -> T) -> (T, Vec<(String, u64)>) {
    // (recording and the side are reset however f ends, a Stop's unwinding
    // or an error included)
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            PHASES.with(|p| *p.borrow_mut() = None);
            side("");
        }
    }
    PHASES.with(|p| *p.borrow_mut() = Some((vec![], tally_total())));
    let reset = Reset;
    let x = f();
    let v = PHASES.with(|p| p.borrow_mut().take()).map(|x| x.0).unwrap_or_default();
    drop(reset);
    (x, v)
}

/// An internal error of route 3: a proven invariant not holding.
fn internal(what: &str) -> String {
    format!("smith_form: internal error: route 3's {what} (a proven invariant failed; please report it)")
}

/// The column Howell echelon modulo delta of `pool` (columns of `rows`
/// residues), one pivot per row: (column, g) with g | delta the pivot as an
/// integer (delta: no column reaches the row, the column is delta e_i).
fn col_howell<R: Zn>(ring: &R, mut pool: Vec<Vec<R::T>>, rows: usize, delta: &BigInt, ops: &mut u64, steps: &mut u64, acc: &mut Local) -> Vec<(Vec<R::T>, BigInt)> {
    let zero = ring.residue(&BigInt::zero());
    let mut out = Vec::with_capacity(rows);
    for i in 0..rows {
        // (the counts held so far, then the check: a check a pivot)
        ring_check(ring, ops, steps, acc);
        drop_zero::<R>(&mut pool, acc);
        acc.n(Family::Move, pool.len() as u64);
        let Some(pi) = pool.iter().position(|c| !R::is_zero(&c[i])) else {
            out.push((vec![zero.clone(); rows], delta.clone()));
            continue;
        };
        let mut p = pool.swap_remove(pi);
        for t in 0..pool.len() {
            if R::is_zero(&pool[t][i]) {
                continue;
            }
            let (s, u, ag, pg) = ring.bezout(&p[i], &pool[t][i], steps);
            let na = ring.neg(&ag);
            let ct = std::mem::take(&mut pool[t]);
            let (np, nt): (Vec<R::T>, Vec<R::T>) = p.iter().zip(&ct).map(|(x, y)| (ring.lin(&s, x, &u, y), ring.lin(&na, x, &pg, y))).unzip();
            *ops = ops.saturating_add(2 * rows as u64);
            p = np;
            pool[t] = nt;
        }
        // the pivot made gcd(v, delta) = s v (mod delta); the old column,
        // cleared at row i, stays a generator (s need not be a unit)
        let v = R::integer(&p[i]);
        let (g, s) = ring.gcd_cofactor_e(&p[i], steps);
        let piv = if g == v {
            p
        } else {
            let mut nc: Vec<R::T> = p.iter().map(|x| ring.lin(&s, x, &zero, &zero)).collect();
            nc[i] = ring.residue(&g);
            acc.add(bigdiv_units(limbs(&v), limbs(&g)));
            let q = ring.residue(&(&v / &g));
            let old: Vec<R::T> = p.iter().zip(&nc).map(|(x, y)| ring.sub_mul(x, &q, y)).collect();
            *ops = ops.saturating_add(2 * rows as u64);
            pool.push(old);
            nc
        };
        // the Howell generator (delta / g) col: zero at row i, not below
        if &g < delta {
            acc.add(bigdiv_units(limbs(delta), limbs(&g)));
            let f = ring.residue(&(delta / &g));
            let ex: Vec<R::T> = piv.iter().map(|x| ring.lin(&f, x, &zero, &zero)).collect();
            *ops = ops.saturating_add(rows as u64);
            if !ex.iter().all(R::is_zero) {
                pool.push(ex);
            }
        }
        out.push((piv, g));
    }
    ring_check(ring, ops, steps, acc);
    out
}

/// Drops the zero vectors of `pool`, charging the entries read (up to each
/// vector's first nonzero).
fn drop_zero<R: Zn>(pool: &mut Vec<Vec<R::T>>, acc: &mut Local) {
    let mut reads = 0u64;
    pool.retain(|v| match v.iter().position(|x| !R::is_zero(x)) {
        Some(t) => {
            reads += t as u64 + 1;
            true
        }
        None => {
            reads += v.len() as u64;
            false
        }
    });
    acc.n(Family::Move, reads);
}

/// The lift of the column echelon to the HNF of Lambda over Z: lower
/// triangular, the pivots g_i on the diagonal, the entries left of each
/// pivot in [0, g_i), row by row from the top (col_t -= q col_i, which
/// leaves the rows above i alone).  The entries below row i are reduced
/// modulo G as they change: that subtracts multiples of G e_k, in Lambda,
/// and a lower triangular set of lattice vectors with the diagonal g_i is
/// a basis of Lambda (its index prod g_i is Lambda's), so every operand
/// stays below G.
fn lift_hnf<R: Zn>(ech: &[(Vec<R::T>, BigInt)], rows: usize, g: &BigInt, acc: &mut Local) -> ZMat {
    let mut cols: Vec<Vec<BigInt>> = ech
        .iter()
        .enumerate()
        .map(|(i, (c, g))| (0..rows).map(|k| if k == i { g.clone() } else if k > i { R::integer(&c[k]) } else { BigInt::zero() }).collect())
        .collect();
    acc.n(Family::Move, (rows * rows) as u64);
    for i in 0..rows {
        for t in 0..i {
            acc.add(bigdiv_units(limbs(&cols[t][i]), limbs(&cols[i][i])));
            let q = cols[t][i].div_floor(&cols[i][i]);
            if q.is_zero() {
                continue;
            }
            let (head, tail) = cols.split_at_mut(i);
            let (ct, ci) = (&mut head[t], &tail[0]);
            for (k, ck) in ci.iter().enumerate().skip(i) {
                if !ck.is_zero() {
                    acc.add(bigmul_units(limbs(&q), limbs(ck)));
                    let x = &ct[k] - &q * ck;
                    ct[k] = if k == i {
                        x
                    } else {
                        acc.add(bigdiv_units(limbs(&x), limbs(g)));
                        x.mod_floor(g)
                    };
                }
            }
        }
    }
    let mut c = ZMat::zero(rows, rows);
    for (t, col) in cols.iter().enumerate() {
        for (k, x) in col.iter().enumerate() {
            c.d[k * rows + t] = x.clone();
        }
    }
    c
}

/// A pivot row of the row Howell form: its row (k + w residues), its pivot
/// column, and the pivot g | delta as an integer.
struct PivotRow<T> {
    row: Vec<T>,
    col: usize,
    g: BigInt,
}

/// The row Howell form modulo delta of `rows` (each k + w residues: Q's k
/// columns, then w right-hand sides), pivots among the first k columns, in
/// increasing column order; with the leftover rows' right-hand sides
/// checked zero (the systems are consistent).
fn row_howell<R: Zn>(ring: &R, mut pool: Vec<Vec<R::T>>, k: usize, delta: &BigInt, ops: &mut u64, steps: &mut u64, acc: &mut Local) -> Result<Vec<PivotRow<R::T>>, String> {
    let zero = ring.residue(&BigInt::zero());
    let width = pool.first().map_or(k, |r| r.len());
    let mut out = vec![];
    for j in 0..k {
        if pool.is_empty() {
            break;
        }
        ring_check(ring, ops, steps, acc);
        acc.n(Family::Move, pool.len() as u64);
        let Some(pi) = pool.iter().position(|r| !R::is_zero(&r[j])) else { continue };
        let mut p = pool.swap_remove(pi);
        for t in 0..pool.len() {
            if R::is_zero(&pool[t][j]) {
                continue;
            }
            let (s, u, ag, pg) = ring.bezout(&p[j], &pool[t][j], steps);
            let na = ring.neg(&ag);
            let rt = std::mem::take(&mut pool[t]);
            let (np, nt): (Vec<R::T>, Vec<R::T>) = p.iter().zip(&rt).map(|(x, y)| (ring.lin(&s, x, &u, y), ring.lin(&na, x, &pg, y))).unzip();
            *ops = ops.saturating_add(2 * width as u64);
            p = np;
            pool[t] = nt;
        }
        let v = R::integer(&p[j]);
        let (g, s) = ring.gcd_cofactor_e(&p[j], steps);
        let piv = if g == v {
            p
        } else {
            let mut nr: Vec<R::T> = p.iter().map(|x| ring.lin(&s, x, &zero, &zero)).collect();
            nr[j] = ring.residue(&g);
            acc.add(bigdiv_units(limbs(&v), limbs(&g)));
            let q = ring.residue(&(&v / &g));
            let old: Vec<R::T> = p.iter().zip(&nr).map(|(x, y)| ring.sub_mul(x, &q, y)).collect();
            *ops = ops.saturating_add(2 * width as u64);
            pool.push(old);
            nr
        };
        if &g < delta {
            acc.add(bigdiv_units(limbs(delta), limbs(&g)));
            let f = ring.residue(&(delta / &g));
            let ex: Vec<R::T> = piv.iter().map(|x| ring.lin(&f, x, &zero, &zero)).collect();
            *ops = ops.saturating_add(width as u64);
            pool.push(ex);
        }
        drop_zero::<R>(&mut pool, acc);
        out.push(PivotRow { row: piv, col: j, g });
    }
    ring_check(ring, ops, steps, acc);
    // (the rows left are zero on Q's columns: their right-hand sides must
    // be zero too, every c being in Lambda)
    if pool.iter().any(|r| r[k..].iter().any(|x| !R::is_zero(x))) {
        return Err(internal("solve (a column of C outside the lattice)"));
    }
    Ok(out)
}

/// Back substitution over the pivot rows (increasing columns), from `y`'s
/// given entries (a sparse vector, coordinate -> residue) and the
/// right-hand side `rhs` of each pivot row (None: zero): each pivot row i
/// with column below `above` sets y at its column to (rhs_i - sum_j H_ij
/// y_j) / g_i, the sum's divisibility by g_i being the Howell property.
fn back_substitute<R: Zn>(ring: &R, piv: &[PivotRow<R::T>], above: usize, y: &mut Vec<(usize, R::T)>, rhs: Option<usize>, ops: &mut u64, acc: &mut Local) -> Result<(), String> {
    let zero = ring.residue(&BigInt::zero());
    let one = ring.residue(&BigInt::from(1));
    for p in piv.iter().rev().filter(|p| p.col < above) {
        // s = rhs - sum over y's entries past the pivot column
        let mut s = match rhs {
            Some(c) => p.row[c].clone(),
            None => zero.clone(),
        };
        for (j, yj) in y.iter() {
            if *j > p.col && !R::is_zero(&p.row[*j]) {
                let t = ring.lin(&one, &zero, &p.row[*j], yj);
                s = ring.sub_mul(&s, &one, &t);
                *ops = ops.saturating_add(2);
            }
        }
        let si = R::integer(&s);
        acc.add(bigdiv_units(limbs(&si), limbs(&p.g)));
        let (q, rem) = si.div_rem(&p.g);
        if !rem.is_zero() {
            return Err(internal("back substitution (the Howell property)"));
        }
        if !q.is_zero() {
            y.push((p.col, ring.residue(&q)));
        }
    }
    Ok(())
}

/// Compress(B) for B (r x n, full row rank) and r independent columns `j`:
/// (V0, C) with B V0 = [C | 0], V0 unimodular, C = HNF(B Z^n).
#[doc(hidden)]
pub fn compress(b: &ZMat, j: &[usize]) -> Result<(ZMat, ZMat), String> {
    let r = b.rows;
    if j.len() != r {
        return Err(internal("pivot count"));
    }
    let mut acc = Local::new();
    let all: Vec<usize> = (0..r).collect();
    let bj = block(b, &all, j, &mut acc);
    mark(&mut acc, "blocks");
    let (nm, delta, det) = crate::zmat::inverse_det(&bj).ok_or_else(|| internal("pivot columns (B_J singular)"))?;
    mark(&mut acc, "B_J inverse");
    let n = b.cols;
    let jp: Vec<usize> = (0..n).filter(|c| !j.contains(c)).collect();
    let bjp = block(b, &all, &jp, &mut acc);
    mark(&mut acc, "blocks");
    let q = nm.mul(&bjp);
    mark(&mut acc, "Q");
    let g = hnf_modulus(&q, &delta, &det, &mut acc);
    mark(&mut acc, "G");
    let c = match g.to_u64() {
        Some(e) if e < WORD_E => hnf_ring(&Word { e }, b, &g, &mut acc),
        _ => hnf_ring(&Big::new(&g), b, &g, &mut acc),
    };
    match delta.to_u64() {
        Some(e) if e < WORD_E => kernel_ring(&Word { e }, b, j, &jp, &bjp, &nm, &q, &delta, c, &mut acc),
        _ => kernel_ring(&Big::new(&delta), b, j, &jp, &bjp, &nm, &q, &delta, c, &mut acc),
    }
}

/// C's modulus G = (Delta / delta) gcd(delta, Q's entries), Delta = det
/// B_J: by Cramer the r-minor of B with B_J's column i replaced by b_j (j
/// in J') is Delta (B_J^-1 b_j)_i = (Delta / delta) Q_ij, and Delta = (Delta
/// / delta) delta is one too, so the index [Z^r : Lambda] (the gcd of B's
/// r-minors) divides G, and G Z^r is in Lambda.  Units: the gcd fold at its
/// running sizes (stopped at 1), the division and the product.
#[doc(hidden)]
pub fn hnf_modulus(q: &ZMat, delta: &BigInt, det: &BigInt, acc: &mut Local) -> BigInt {
    let mut g = delta.clone();
    for x in q.d.iter() {
        if g.is_one() {
            break;
        }
        if !x.is_zero() {
            acc.add(biggcd_units(limbs(&g), limbs(x)));
            g = g.gcd(x);
        }
    }
    let ad = det.abs();
    acc.add(bigdiv_units(limbs(&ad), limbs(delta)));
    let f = &ad / delta;
    acc.add(bigmul_units(limbs(&f), limbs(&g)));
    f * g
}

/// C = HNF(Lambda): the column Howell echelon of B's columns modulo G,
/// lifted.
fn hnf_ring<R: Zn>(ring: &R, b: &ZMat, g: &BigInt, acc: &mut Local) -> ZMat {
    let (r, n) = (b.rows, b.cols);
    let (mut ops, mut steps) = (0u64, 0u64);
    acc.add(ring.residue_units(b));
    let pool: Vec<Vec<R::T>> = (0..n).map(|c| (0..r).map(|i| ring.residue(b.get(i, c))).collect()).collect();
    let ech = col_howell(ring, pool, r, g, &mut ops, &mut steps, acc);
    mark(acc, "C echelon");
    let c = lift_hnf::<R>(&ech, r, g, acc);
    mark(acc, "lift");
    c
}

/// K and X modulo delta, from Q = N B_J' and C.
#[allow(clippy::too_many_arguments)]
fn kernel_ring<R: Zn>(ring: &R, b: &ZMat, j: &[usize], jp: &[usize], bjp: &ZMat, nm: &ZMat, q: &ZMat, delta: &BigInt, c: ZMat, acc: &mut Local) -> Result<(ZMat, ZMat), String> {
    let (r, n) = (b.rows, b.cols);
    let k = jp.len();
    let (mut ops, mut steps) = (0u64, 0u64);
    // [Q | N C] modulo delta, then its row Howell form
    let nc = nm.mul(&c);
    acc.add(ring.residue_units(&q));
    acc.add(ring.residue_units(&nc));
    mark(acc, "N C");
    let rows: Vec<Vec<R::T>> = (0..r).map(|i| (0..k).map(|t| ring.residue(q.get(i, t))).chain((0..r).map(|t| ring.residue(nc.get(i, t)))).collect()).collect();
    let piv = row_howell(ring, rows, k, delta, &mut ops, &mut steps, acc)?;
    mark(acc, "H echelon");
    let pivot_of: Vec<Option<usize>> = {
        let mut v = vec![None; k];
        for (m, p) in piv.iter().enumerate() {
            v[p.col] = Some(m);
        }
        v
    };
    // K_J' (L''s triangular basis) and K_J = -(N / delta) B_J' K_J', a
    // column at a time; then X, the same way
    let mut v0 = ZMat::zero(n, n);
    let exact = |y: &[(usize, BigInt)], target: Option<usize>, col: usize, v0: &mut ZMat, acc: &mut Local| -> Result<(), String> {
        // t = (c_target or 0) - B_J' y, then N t / delta, exactly
        let mut t: Vec<BigInt> = (0..r).map(|i| target.map_or(BigInt::zero(), |w| c.get(i, w).clone())).collect();
        for (jj, yj) in y {
            for (i, ti) in t.iter_mut().enumerate() {
                let bij = bjp.get(i, *jj);
                if !bij.is_zero() {
                    acc.add(bigmul_units(limbs(bij), limbs(yj)));
                    *ti -= bij * yj;
                }
            }
        }
        for i in 0..r {
            let mut s = BigInt::zero();
            for (l, tl) in t.iter().enumerate() {
                let nil = nm.get(i, l);
                if !nil.is_zero() && !tl.is_zero() {
                    acc.add(bigmul_units(limbs(nil), limbs(tl)));
                    s += nil * tl;
                }
            }
            acc.add(bigdiv_units(limbs(&s), limbs(delta)));
            let (qq, rem) = s.div_rem(delta);
            if !rem.is_zero() {
                return Err(internal("exact division by delta"));
            }
            v0.d[j[i] * n + col] = qq;
        }
        for (jj, yj) in y {
            v0.d[jp[*jj] * n + col] = yj.clone();
        }
        acc.n(Family::Move, (r + y.len()) as u64);
        Ok(())
    };
    for x in 0..k {
        let lead = match pivot_of[x] {
            None => BigInt::from(1),
            Some(m) => {
                acc.add(bigdiv_units(limbs(delta), limbs(&piv[m].g)));
                delta / &piv[m].g
            }
        };
        let mut y: Vec<(usize, R::T)> = vec![(x, ring.residue(&lead))];
        back_substitute(ring, &piv, x, &mut y, None, &mut ops, acc)?;
        let mut yi: Vec<(usize, BigInt)> = y.iter().map(|(jj, v)| (*jj, R::integer(v))).collect();
        // (the lead as the integer it is: delta / g can be delta, residue 0)
        yi[0].1 = lead;
        exact(&yi, None, r + x, &mut v0, acc)?;
        ring_check(ring, &mut ops, &mut steps, acc);
    }
    for w in 0..r {
        let mut y: Vec<(usize, R::T)> = vec![];
        back_substitute(ring, &piv, k, &mut y, Some(k + w), &mut ops, acc)?;
        let yi: Vec<(usize, BigInt)> = y.iter().map(|(jj, v)| (*jj, R::integer(v))).collect();
        exact(&yi, Some(w), w, &mut v0, acc)?;
        ring_check(ring, &mut ops, &mut steps, acc);
    }
    mark(acc, "K and X");
    Ok((v0, c))
}

/// r independent columns of a full-row-rank B, from its echelon modulo a
/// word prime (the next prime when one drops the rank).  (Tests and the
/// measurement: the route takes J from its rank profile.)
#[doc(hidden)]
pub fn pivot_columns(b: &ZMat) -> Vec<usize> {
    for p in crate::nmod::Primes::new() {
        let mut m = b.reduce(&crate::nmod::Modulus::new(p));
        let piv = m.rref();
        if piv.len() == b.rows {
            return piv;
        }
    }
    unreachable!("full row rank")
}

/// The block of `a` in `rows` x `cols`, its copy charged.
fn block(a: &ZMat, rows: &[usize], cols: &[usize], acc: &mut Local) -> ZMat {
    let mut b = ZMat::zero(rows.len(), cols.len());
    for (t, &i) in rows.iter().enumerate() {
        for (u, &j) in cols.iter().enumerate() {
            b.d[t * cols.len() + u] = a.get(i, j).clone();
        }
    }
    acc.n(Family::Move, copy_units(&b.d));
    b
}

/// The rank profile modulo a prime: r, the rows I and the columns J of a
/// nonzero r-minor modulo p (so of a nonzero minor over Z: I and J are
/// independent, and r <= rank A).
fn profile_mod(a: &ZMat, p: u64) -> (Vec<usize>, Vec<usize>) {
    let (j, i, _) = a.reduce(&crate::nmod::Modulus::new(p)).rref_rows();
    (i, j)
}

/// Route 3: the Smith form with transforms of any A (m x n), through its
/// rank profile, the Compress of both sides to a nonsingular r x r core T,
/// route 1 or 2 on T, and the blocks combined:
///
/// 1. the profile modulo a word prime: rows I and columns J of a nonzero
///    r-minor, so r <= rank A;
/// 2. if r < n, Compress(A_I, J) gives V0 = [X | K]; the certificate A K = 0
///    over Z (on the rows outside I: A_I K = 0 by construction) proves rank
///    A <= r, every row of A being orthogonal to K's n - r independent
///    columns.  If it fails, the rank is higher: the next prime is tried
///    and the larger profile kept.  This ends: with M a fixed nonzero
///    (rank A)-minor, a prime gives a lower rank only if it divides M, so
///    at most log2 |M| / 61 primes (all above 2^61) are bad, |M| within
///    Hadamard's bound;
/// 3. A' = A X (A if r = n), whose rows I are C (A_I if r = n), nonsingular;
///    if r < m, Compress(A'^T, I) gives W, U0 = W^T, with U0 A' = [T ; 0] and
///    T = C_left^T exactly (by construction, no product); else T = A';
/// 4. U1 T V1 = D_r by route 1 or 2;
/// 5. V = [X V1 | K] and U = [U1 U0_top ; U0_rest] by blocks (no m x m or
///    n x n product).
///
/// Units: the entry's copy of A and the identities' m^2 + n^2 entries (as
/// the classical route), before anything can return (r = 0 too); each
/// profile's reduction and echelon by nmod_mat; the rest by its parts.
pub(super) fn smith_route3(a: &ZMat) -> Result<super::SmithForm, String> {
    let (m, n) = (a.rows, a.cols);
    let mut acc = Local::new();
    acc.n(Family::Move, copy_units(&a.d).saturating_add(crate::cost::size_product(&[m, m])).saturating_add(crate::cost::size_product(&[n, n])));
    side("");
    mark(&mut acc, "entry");
    sagebrush_interrupt::check_coarse();
    // the largest profile so far, and the rank whose certificate failed
    // (a prime no better than that one is not tried again)
    let mut best: (Vec<usize>, Vec<usize>) = (vec![], vec![]);
    let mut failed: Option<usize> = None;
    let mut primes = crate::nmod::Primes::new();
    let (is, _js, v0) = loop {
        let p = primes.next().ok_or_else(|| internal("primes (exhausted)"))?;
        let (i, j) = profile_mod(a, p);
        if i.len() > best.0.len() {
            best = (i, j);
        }
        let (is, js) = best.clone();
        let r = is.len();
        if failed.is_some_and(|f| r <= f) {
            // (only saves work: a failed certificate at rank f shows rank A
            // > f, so no profile of rank <= f can pass)
            continue;
        }
        if r == 0 {
            // (rank 0 modulo p: A = 0 is the certificate)
            acc.n(Family::Move, a.d.len() as u64);
            if a.d.iter().all(Zero::is_zero) {
                break (is, js, None);
            }
            failed = Some(0);
            acc.flush();
            continue;
        }
        if r == n {
            break (is, js, None);
        }
        let b = block(a, &is, &(0..n).collect::<Vec<_>>(), &mut acc);
        mark(&mut acc, "profile");
        side("col: ");
        let (v0, _c) = compress(&b, &js)?;
        side("");
        // the certificate on the rows outside I (none when r = m)
        let rest: Vec<usize> = (0..m).filter(|i| !is.contains(i)).collect();
        if rest.is_empty() {
            break (is, js, Some((v0, _c)));
        }
        let k = block(&v0, &(0..n).collect::<Vec<_>>(), &(r..n).collect::<Vec<_>>(), &mut acc);
        let ar = block(a, &rest, &(0..n).collect::<Vec<_>>(), &mut acc);
        acc.flush();
        let ak = ar.mul(&k);
        acc.n(Family::Move, ak.d.len() as u64);
        mark(&mut acc, "certificate");
        if ak.d.iter().all(Zero::is_zero) {
            break (is, js, Some((v0, _c)));
        }
        failed = Some(r);
    };
    // (the profile's units when no column side ran; else nothing)
    mark(&mut acc, "profile");
    let r = is.len();
    if r == 0 {
        acc.flush();
        return Ok(super::SmithForm { d: ZMat::zero(m, n), u: ZMat::identity(m), v: ZMat::identity(n), route: super::Route::Hermite, attempts: 0 });
    }
    let all_n: Vec<usize> = (0..n).collect();
    let first_r: Vec<usize> = (0..r).collect();
    // A' (A X, or A when r = n), and if r < m the left side on A'^T with
    // J = I (A''s rows I: C, or A_I); else T = A' (C, or A_I)
    let (w, t) = match (&v0, r < m) {
        (Some((v0, _)), true) => {
            let x = block(v0, &all_n, &first_r, &mut acc);
            acc.flush();
            let bl = a.mul(&x).transpose();
            mark(&mut acc, "A X");
            side("left: ");
            let (w, cl) = compress(&bl, &is)?;
            side("");
            (Some(w), cl.transpose())
        }
        (None, true) => {
            let bl = a.transpose();
            mark(&mut acc, "A X");
            side("left: ");
            let (w, cl) = compress(&bl, &is)?;
            side("");
            (Some(w), cl.transpose())
        }
        (Some((_, c)), false) => {
            acc.n(Family::Move, copy_units(&c.d));
            (None, c.clone())
        }
        (None, false) => (None, block(a, &is, &all_n, &mut acc)),
    };
    acc.flush();
    let super::Square::Done(f) = super::nonsingular(&t, usize::MAX)? else { return Err(internal("core (T singular)")) };
    mark(&mut acc, "core");
    let attempts = f.attempts;
    // V = [X V1 | K], U = [U1 U0_top ; U0_rest]
    // (V0 and U0 are the output's storage, charged at the entry: only the
    // blocks written are charged here)
    let v = match v0 {
        Some((mut v0, _)) => {
            let x = block(&v0, &all_n, &first_r, &mut acc);
            acc.flush();
            let xv = x.mul(&f.v);
            for i in 0..n {
                for j in 0..r {
                    v0.d[i * n + j] = xv.get(i, j).clone();
                }
            }
            acc.n(Family::Move, copy_units(&xv.d));
            v0
        }
        None => f.v,
    };
    let u = match w {
        Some(w) => {
            // U0 = W^T: its first r rows are W's first r columns, transposed
            let top = block(&w, &(0..m).collect::<Vec<_>>(), &first_r, &mut acc).transpose();
            acc.flush();
            let ut = f.u.mul(&top);
            let mut u = w.transpose();
            for i in 0..r {
                for j in 0..m {
                    u.d[i * m + j] = ut.get(i, j).clone();
                }
            }
            acc.n(Family::Move, copy_units(&ut.d));
            u
        }
        None => f.u,
    };
    let mut d = ZMat::zero(m, n);
    for i in 0..r {
        d.d[i * n + i] = f.d.get(i, i).clone();
    }
    acc.n(Family::Move, copy_units(&f.d.d).saturating_add(size_product(&[m, n])));
    mark(&mut acc, "combine");
    Ok(super::SmithForm { d, u, v, route: super::Route::Hermite, attempts })
}
