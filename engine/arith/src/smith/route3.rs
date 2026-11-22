//! Route 3's Compress, for singular and rectangular input: for B (r x n,
//! full row rank) and r independent columns J, a unimodular V0 = [X | K]
//! with B V0 = [C | 0], everything modulo delta (B_J^-1 = N / delta), no
//! elimination over Z:
//!
//! - C = HNF(Lambda), Lambda = B Z^n, which contains delta Z^r (B_J N =
//!   delta I), from a column Howell echelon of B modulo delta, lifted;
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
//! are in Lambda (residues of lattice vectors modulo delta Z^r), and
//! delta e_i is a combination of them, by induction from the last row: (delta
//! / g_i) col_i is zero at rows <= i modulo delta, so by the Howell property
//! a combination of the later columns modulo delta Z^r.
//!
//! Units: the modular work by the ring (word delta: ModArith in bulk; big
//! delta: the ring's own counts), each echelon pivot and each solved column
//! a Stop check after the counts held so far; the exact integer products
//! and divisions by delta at their running sizes.

use super::ring_check;
use crate::cost::{bigdiv_units, bigmul_units, Family, Local};
use crate::snf::{Big, Word, Zn, WORD_E};
use crate::zmat::{limbs, ZMat};
use num_integer::Integer;
use num_traits::{ToPrimitive, Zero};
use sagebrush_bigint::BigInt;

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
            let q = ring.residue(&(&v / &g));
            let old: Vec<R::T> = p.iter().zip(&nc).map(|(x, y)| ring.sub_mul(x, &q, y)).collect();
            *ops = ops.saturating_add(2 * rows as u64);
            pool.push(old);
            nc
        };
        // the Howell generator (delta / g) col: zero at row i, not below
        if &g < delta {
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
/// pivot in [0, g_i).
fn lift_hnf<R: Zn>(ech: &[(Vec<R::T>, BigInt)], rows: usize, acc: &mut Local) -> ZMat {
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
            let ci = cols[i].clone();
            for (k, ck) in ci.iter().enumerate().skip(i) {
                if !ck.is_zero() {
                    acc.add(bigmul_units(limbs(&q), limbs(ck)));
                    let x = &cols[t][k] - &q * ck;
                    cols[t][k] = x;
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
            let q = ring.residue(&(&v / &g));
            let old: Vec<R::T> = p.iter().zip(&nr).map(|(x, y)| ring.sub_mul(x, &q, y)).collect();
            *ops = ops.saturating_add(2 * width as u64);
            pool.push(old);
            nr
        };
        if &g < delta {
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
fn back_substitute<R: Zn>(ring: &R, piv: &[PivotRow<R::T>], above: usize, y: &mut Vec<(usize, R::T)>, rhs: Option<usize>, ops: &mut u64) -> Result<(), String> {
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
        let (q, rem) = si.div_rem(&p.g);
        if !rem.is_zero() {
            return Err(internal("back substitution (the Howell property)"));
        }
        *ops = ops.saturating_add(1);
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
    let bj = ZMat::from_rows((0..r).map(|i| j.iter().map(|&c| b.get(i, c).clone()).collect()).collect());
    let (nm, delta, _) = crate::zmat::inverse_det(&bj).ok_or_else(|| internal("pivot columns (B_J singular)"))?;
    let mut acc = Local::new();
    match delta.to_u64() {
        Some(e) if e < WORD_E => compress_ring(&Word { e }, b, j, &nm, &delta, &mut acc),
        _ => compress_ring(&Big::new(&delta), b, j, &nm, &delta, &mut acc),
    }
}

fn compress_ring<R: Zn>(ring: &R, b: &ZMat, j: &[usize], nm: &ZMat, delta: &BigInt, acc: &mut Local) -> Result<(ZMat, ZMat), String> {
    let (r, n) = (b.rows, b.cols);
    let jp: Vec<usize> = (0..n).filter(|c| !j.contains(c)).collect();
    let k = jp.len();
    let (mut ops, mut steps) = (0u64, 0u64);
    // C: the column Howell echelon of B's columns modulo delta, lifted
    acc.add(ring.residue_units(b));
    let pool: Vec<Vec<R::T>> = (0..n).map(|c| (0..r).map(|i| ring.residue(b.get(i, c))).collect()).collect();
    let ech = col_howell(ring, pool, r, delta, &mut ops, &mut steps, acc);
    let c = lift_hnf::<R>(&ech, r, acc);
    acc.flush();
    // [Q | N C] modulo delta, Q = N B_J', then its row Howell form
    let bjp = ZMat::from_rows((0..r).map(|i| jp.iter().map(|&cc| b.get(i, cc).clone()).collect()).collect());
    let q = nm.mul(&bjp);
    let nc = nm.mul(&c);
    acc.add(ring.residue_units(&q));
    acc.add(ring.residue_units(&nc));
    let rows: Vec<Vec<R::T>> = (0..r).map(|i| (0..k).map(|t| ring.residue(q.get(i, t))).chain((0..r).map(|t| ring.residue(nc.get(i, t)))).collect()).collect();
    let piv = row_howell(ring, rows, k, delta, &mut ops, &mut steps, acc)?;
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
            Some(m) => delta / &piv[m].g,
        };
        let mut y: Vec<(usize, R::T)> = vec![(x, ring.residue(&lead))];
        back_substitute(ring, &piv, x, &mut y, None, &mut ops)?;
        let mut yi: Vec<(usize, BigInt)> = y.iter().map(|(jj, v)| (*jj, R::integer(v))).collect();
        // (the lead as the integer it is: delta / g can be delta, residue 0)
        yi[0].1 = lead;
        exact(&yi, None, r + x, &mut v0, acc)?;
        ring_check(ring, &mut ops, &mut steps, acc);
    }
    for w in 0..r {
        let mut y: Vec<(usize, R::T)> = vec![];
        back_substitute(ring, &piv, k, &mut y, Some(k + w), &mut ops)?;
        let yi: Vec<(usize, BigInt)> = y.iter().map(|(jj, v)| (*jj, R::integer(v))).collect();
        exact(&yi, Some(w), w, &mut v0, acc)?;
        ring_check(ring, &mut ops, &mut steps, acc);
    }
    Ok((v0, c))
}

/// r independent columns of a full-row-rank B, from its echelon modulo a
/// word prime (the next prime when one drops the rank).
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
