//! Exact linear algebra over Z, Q and F_p for small dense matrices (number
//! field bases are n x n with n the degree).

use sagebrush_bigint::BigInt;
use num_integer::Integer;
use sagebrush_bigint::BigRational;
use num_traits::{One, Signed, Zero};

pub type ZMat = Vec<Vec<BigInt>>;
pub type QMat = Vec<Vec<BigRational>>;

/// The Hermite normal form of the lattice spanned by the rows: upper
/// triangular rows (rank many), positive pivots, entries above a pivot
/// reduced to [0, pivot).
pub fn hnf(rows: &[Vec<BigInt>]) -> ZMat {
    let mut a: ZMat = rows.iter().filter(|r| r.iter().any(|x| !x.is_zero())).cloned().collect();
    let m = a.first().map_or(0, |r| r.len());
    let mut r = 0;
    for col in 0..m {
        loop {
            sagebrush_interrupt::check();
            // the smallest nonzero entry of the column at or below r
            let best = (r..a.len()).filter(|&i| !a[i][col].is_zero()).min_by(|&i, &j| a[i][col].abs().cmp(&a[j][col].abs()));
            let Some(b) = best else { break };
            a.swap(r, b);
            let mut clean = true;
            for i in r + 1..a.len() {
                if a[i][col].is_zero() {
                    continue;
                }
                let q = a[i][col].div_floor(&a[r][col]);
                let pr = a[r].clone();
                for (x, y) in a[i].iter_mut().zip(&pr) {
                    *x -= &q * y;
                }
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
            for x in a[r].iter_mut() {
                *x = -&*x;
            }
        }
        for i in 0..r {
            let q = a[i][col].div_floor(&a[r][col]);
            if !q.is_zero() {
                let pr = a[r].clone();
                for (x, y) in a[i].iter_mut().zip(&pr) {
                    *x -= &q * y;
                }
            }
        }
        r += 1;
        a.retain(|row| row.iter().any(|x| !x.is_zero()));
        if r >= a.len() {
            break;
        }
    }
    a.truncate(r);
    a
}

/// The Hermite normal form of the lattice spanned by the rows and d Z^m
/// (d > 0, so the lattice has full rank m): the same m x m matrix as hnf of
/// the rows with the rows d e_i added, but every entry kept in [0, d) as it
/// runs (a multiple of d e_k may be added to any row), so that its memory is
/// bounded before it starts ([`hnf_mod_bytes`]).  Column by column, the rows
/// left (each zero in the columns done) are combined into one with the
/// column's gcd, which with d gives the pivot g = gcd(g0, d) = u g0 + v d:
/// the pivot row is u times that row, and that row minus g0/g times the
/// pivot row, and d/g times the pivot row less d e_col, both zero in the
/// column, stay as generators.  Stop is checked at every column.
pub fn hnf_mod(rows: &[Vec<BigInt>], d: &BigInt) -> ZMat {
    let m = rows.first().map_or(0, |r| r.len());
    let red = |r: &mut Vec<BigInt>, from: usize| {
        for x in r[from..].iter_mut() {
            *x = x.mod_floor(d);
        }
    };
    let mut a: ZMat = Vec::with_capacity(rows.len() + 2 * m);
    for r in rows {
        let mut r = r.clone();
        red(&mut r, 0);
        if r.iter().any(|x| !x.is_zero()) {
            a.push(r);
        }
    }
    let mut out: ZMat = Vec::with_capacity(m);
    for col in 0..m {
        sagebrush_interrupt::check();
        // (the rows left with a nonzero entry in the column, combined into one)
        loop {
            let best = (0..a.len()).filter(|&i| !a[i][col].is_zero()).min_by(|&i, &j| a[i][col].cmp(&a[j][col]));
            let Some(b) = best else { break };
            a.swap(0, b);
            let mut clean = true;
            for i in 1..a.len() {
                if a[i][col].is_zero() {
                    continue;
                }
                let q = a[i][col].div_floor(&a[0][col]);
                let (head, tail) = a.split_at_mut(1);
                for (x, y) in tail[i - 1][col..].iter_mut().zip(&head[0][col..]) {
                    *x -= &q * y;
                }
                red(&mut tail[i - 1], col);
                if !tail[i - 1][col].is_zero() {
                    clean = false;
                }
            }
            if clean {
                break;
            }
        }
        let g0 = if a.first().is_some_and(|r| !r[col].is_zero()) { a[0][col].clone() } else { BigInt::zero() };
        let mut pivot = vec![BigInt::zero(); m];
        if g0.is_zero() {
            pivot[col] = d.clone();
        } else {
            let row = a.swap_remove(0);
            let e = g0.extended_gcd(d);
            let g = e.gcd;
            for k in col + 1..m {
                pivot[k] = (&e.x * &row[k]).mod_floor(d);
            }
            pivot[col] = g.clone();
            // row - (g0/g) pivot, and (d/g) pivot - d e_col: zero in the column
            let s = &g0 / &g;
            let mut r1: Vec<BigInt> = (0..m).map(|k| if k <= col { BigInt::zero() } else { &row[k] - &s * &pivot[k] }).collect();
            red(&mut r1, col + 1);
            let t = d / &g;
            let mut r2: Vec<BigInt> = (0..m).map(|k| if k <= col { BigInt::zero() } else { &t * &pivot[k] }).collect();
            red(&mut r2, col + 1);
            for r in [r1, r2] {
                if r.iter().any(|x| !x.is_zero()) {
                    a.push(r);
                }
            }
        }
        a.retain(|r| r.iter().any(|x| !x.is_zero()));
        out.push(pivot);
    }
    // entries above each pivot into [0, pivot), from the left
    for j in 0..m {
        sagebrush_interrupt::check();
        for i in 0..j {
            let q = out[i][j].div_floor(&out[j][j]);
            if q.is_zero() {
                continue;
            }
            let (top, bottom) = out.split_at_mut(j);
            for (x, y) in top[i][j..].iter_mut().zip(&bottom[0][j..]) {
                *x -= &q * y;
            }
            red(&mut top[i], j + 1);
        }
    }
    out
}

/// A bound on the bytes hnf_mod(rows, d) allocates for `r` rows of `m`
/// entries of at most `in_bits` bits: its working rows (at most r + 2 m of
/// them, and the result's m), each entry below d once reduced; one row at a
/// time holds unreduced entries (a difference with a product below d^2 m),
/// and one input row is copied before its reduction.
pub fn hnf_mod_bytes(r: usize, m: usize, d: &BigInt, in_bits: u64) -> u64 {
    use super::mem::{big, lg, vec};
    let bd = d.bits();
    let wide = big(2 * bd + lg(m) + 2);
    let rows = (r + 3 * m + 2) as u64;
    vec(r as u64 + 2 * m as u64, 24) + vec(m as u64, 24) + rows * vec(m as u64, big(bd + 1)) + 2 * vec(m as u64, wide) + vec(m as u64, big(in_bits)) + 4 * wide
}

/// [`inverse`] with its memory reserved before each elimination step: a
/// rolling reservation bounding the matrix after the step from its entries'
/// measured sizes (a new entry x - f y has at most bits(x) + bits(f y) + 1
/// bits in its numerator and denominator before its reduction), taken before
/// the step, the previous one released after it.  Stop is checked at every
/// step.  The result's measured bytes are charged to `keep` before the last
/// step's reservation is released.
pub fn inverse_charged(m: &QMat, keep: &mut super::mem::Held) -> Result<QMat, super::factor::FactorError> {
    use super::mem::{rat, rats, scratch, vec};
    let n = m.len();
    let rb = |x: &BigRational| (x.numer().bits(), x.denom().bits());
    // (the augmented matrix itself, bounded by its entries)
    // (and, in every step's reservation, the step's own bookkeeping: the scaled
    // pivot row's sizes)
    let extra = vec(2 * n as u64, 16);
    let first: u64 = extra + vec(n as u64, 24) + m.iter().map(|r| vec(2 * n as u64, std::mem::size_of::<BigRational>() as u64) + r.iter().map(|x| { let (a, b) = rb(x); rat(a, b) }).sum::<u64>()).sum::<u64>();
    let mut cur = scratch(first)?;
    let mut a: QMat = {
        let _s = cur.scope();
        m.iter().enumerate().map(|(i, r)| r.iter().cloned().chain((0..n).map(|j| if i == j { BigRational::one() } else { BigRational::zero() })).collect()).collect()
    };
    for c in 0..n {
        sagebrush_interrupt::check();
        let p = (c..n).find(|&i| !a[i][c].is_zero()).expect("singular matrix");
        a.swap(c, p);
        // the pivot row scaled: bits(x / p) <= bits(x) + bits(p); then each
        // other row x - f y, with y a scaled pivot entry
        let (pn, pd) = rb(&a[c][c]);
        let scaled: Vec<(u64, u64)> = {
            let _s = cur.scope();
            a[c].iter().map(|x| { let (xn, xd) = rb(x); (xn + pd, xd + pn) }).collect()
        };
        let mut bound = vec(n as u64, 24) + 2 * vec(2 * n as u64, std::mem::size_of::<BigRational>() as u64);
        let mut worst = 0;
        for (i, row) in a.iter().enumerate() {
            bound += vec(2 * n as u64, std::mem::size_of::<BigRational>() as u64);
            let (fn_, fd) = rb(&row[c]);
            for (k, x) in row.iter().enumerate() {
                let (xn, xd) = rb(x);
                let (yn, yd) = scaled[k];
                let (nb, db) = if i == c { (yn, yd) } else { ((xn + fd + yd).max(fn_ + yn + xd) + 1, xd + fd + yd) };
                bound += rat(nb, db);
                // (one entry's unreduced intermediates live at a time)
                worst = worst.max(3 * rat(nb, db));
            }
        }
        let next = scratch(extra + bound + worst + vec(2 * n as u64, std::mem::size_of::<BigRational>() as u64))?;
        {
            let _s = next.scope();
            let inv = a[c][c].recip();
            for x in a[c].iter_mut() {
                *x *= &inv;
            }
            let pr = a[c].clone();
            for (i, row) in a.iter_mut().enumerate() {
                if i != c && !row[c].is_zero() {
                    let f = row[c].clone();
                    for (x, y) in row.iter_mut().zip(&pr) {
                        *x -= &f * y;
                    }
                }
            }
        }
        cur = next;
    }
    let out: QMat = {
        let _s = cur.scope();
        a.into_iter().map(|r| r[n..].to_vec()).collect()
    };
    keep.take(vec(n as u64, 24) + out.iter().map(|r| rats(r)).sum::<u64>())?;
    drop(cur);
    Ok(out)
}

/// The determinant of a square integer matrix (Bareiss, as
/// crate::linalg::det, with the same result), its memory reserved before each
/// step: a rolling reservation bounding the matrix after the step from its
/// entries' measured sizes (an entry (a_ij a_kk - a_ik a_kj) / prev has at
/// most max(bits(a_ij) + bits(a_kk), bits(a_ik) + bits(a_kj)) + 2 - bits(prev)
/// bits, the division being exact), taken before the step, the previous one
/// released after.  Stop is checked at every step.
pub fn det_charged(m: &[Vec<BigInt>]) -> Result<BigInt, super::factor::FactorError> {
    use super::mem::{big, bigs, scratch, vec};
    let n = m.len();
    if n == 0 {
        return Ok(BigInt::one());
    }
    let mut cur = scratch(vec(n as u64, 24) + m.iter().map(|r| bigs(r)).sum::<u64>() + big(0))?;
    let mut a: Vec<Vec<BigInt>> = {
        let _s = cur.scope();
        m.to_vec()
    };
    let mut sign = BigInt::one();
    let mut prev = BigInt::one();
    for k in 0..n - 1 {
        sagebrush_interrupt::check();
        if a[k][k].is_zero() {
            let Some(i) = (k + 1..n).find(|&i| !a[i][k].is_zero()) else { return Ok(BigInt::zero()) };
            a.swap(k, i);
            sign = -sign;
        }
        let pb = prev.bits();
        let mut bound = vec(n as u64, 24) + big(a[k][k].bits());
        let mut worst = 0;
        for i in 0..n {
            bound += vec(n as u64, std::mem::size_of::<BigInt>() as u64);
            for j in 0..n {
                let b = if i > k && j > k {
                    let t = (a[i][j].bits() + a[k][k].bits()).max(a[i][k].bits() + a[k][j].bits()) + 2;
                    worst = worst.max(3 * big(t));
                    t.saturating_sub(pb) + 1
                } else {
                    a[i][j].bits()
                };
                bound += big(b) - std::mem::size_of::<BigInt>() as u64;
            }
        }
        let next = scratch(bound + worst)?;
        {
            let _s = next.scope();
            for i in k + 1..n {
                for j in k + 1..n {
                    let v = (&a[i][j] * &a[k][k] - &a[i][k] * &a[k][j]) / &prev;
                    a[i][j] = v;
                }
            }
            prev = a[k][k].clone();
        }
        cur = next;
    }
    let d = {
        let _s = cur.scope();
        sign * &a[n - 1][n - 1]
    };
    drop(a);
    drop(cur);
    Ok(d)
}

/// The inverse of a nonsingular square integer (or rational) matrix over Q.
pub fn inverse(m: &QMat) -> QMat {
    let n = m.len();
    let mut a: QMat = m.iter().enumerate().map(|(i, r)| r.iter().cloned().chain((0..n).map(|j| if i == j { BigRational::one() } else { BigRational::zero() })).collect()).collect();
    for c in 0..n {
        let p = (c..n).find(|&i| !a[i][c].is_zero()).expect("singular matrix");
        a.swap(c, p);
        let inv = a[c][c].recip();
        for x in a[c].iter_mut() {
            *x *= &inv;
        }
        let pr = a[c].clone();
        for (i, row) in a.iter_mut().enumerate() {
            if i != c && !row[c].is_zero() {
                let f = row[c].clone();
                for (x, y) in row.iter_mut().zip(&pr) {
                    *x -= &f * y;
                }
            }
        }
    }
    a.into_iter().map(|r| r[n..].to_vec()).collect()
}

pub fn to_q(m: &[Vec<BigInt>]) -> QMat {
    m.iter().map(|r| r.iter().map(|x| BigRational::from_integer(x.clone())).collect()).collect()
}

/// v M for a row vector v.
pub fn vec_mat<T>(v: &[T], m: &[Vec<T>]) -> Vec<T>
where
    T: Clone + Zero + for<'a> std::ops::Mul<&'a T, Output = T>,
{
    let cols = m.first().map_or(0, |r| r.len());
    let mut out = vec![T::zero(); cols];
    for (vi, row) in v.iter().zip(m) {
        if vi.is_zero() {
            continue;
        }
        for (o, x) in out.iter_mut().zip(row) {
            *o = o.clone() + vi.clone() * x;
        }
    }
    out
}

/// A basis of the left kernel {x in F_p^r : x A = 0} of an r x c matrix
/// (entries reduced mod p), as integer vectors with entries in [0, p).
pub fn left_kernel_mod(a: &[Vec<BigInt>], p: &BigInt) -> ZMat {
    let r = a.len();
    let c = a.first().map_or(0, |x| x.len());
    // row reduce [A | I]: rows of I next to zero rows of A are the kernel
    let mut m: ZMat = a
        .iter()
        .enumerate()
        .map(|(i, row)| row.iter().map(|x| x.mod_floor(p)).chain((0..r).map(|j| if i == j { BigInt::one() } else { BigInt::zero() })).collect())
        .collect();
    let mut rank = 0;
    for col in 0..c {
        sagebrush_interrupt::check();
        let Some(piv) = (rank..r).find(|&i| !m[i][col].is_zero()) else { continue };
        m.swap(rank, piv);
        let inv = m[rank][col].modpow(&(p - 2u32), p);
        for x in m[rank].iter_mut() {
            *x = (&*x * &inv).mod_floor(p);
        }
        let pr = m[rank].clone();
        for i in 0..r {
            if i != rank && !m[i][col].is_zero() {
                let f = m[i][col].clone();
                for (x, y) in m[i].iter_mut().zip(&pr) {
                    *x = (&*x - &f * y).mod_floor(p);
                }
            }
        }
        rank += 1;
    }
    m[rank..].iter().map(|row| row[c..].to_vec()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(v: &[&[i64]]) -> ZMat {
        v.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect()
    }

    /// The modular Hermite form and the charged inverse and determinant are
    /// the plain ones' results exactly, on random matrices (a xorshift).
    #[test]
    fn modular_and_charged_forms_are_the_plain_ones() {
        sagebrush_ledger::set_total(Some(sagebrush_ledger::Total { bytes: 1 << 36, status: sagebrush_ledger::TotalStatus::Observed, joint: false, uncertified: false }));
        let mut s = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = |m: i64| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s % (2 * m as u64 + 1)) as i64 - m
        };
        for trial in 0..200 {
            let (r, m) = (1 + trial % 5, 1 + trial % 4);
            let rows: ZMat = (0..r).map(|_| (0..m).map(|_| BigInt::from(next(40))).collect()).collect();
            let d = BigInt::from(1 + next(60).abs());
            let mut with_d = rows.clone();
            for i in 0..m {
                with_d.push((0..m).map(|j| if i == j { d.clone() } else { BigInt::zero() }).collect());
            }
            assert_eq!(hnf_mod(&rows, &d), hnf(&with_d), "{rows:?} mod {d}");
            // (a full-rank square lattice contains |det| Z^m)
            let sq: ZMat = (0..m).map(|_| (0..m).map(|_| BigInt::from(next(9))).collect()).collect();
            let det = crate::linalg::det(&sq);
            assert_eq!(det_charged(&sq).unwrap(), det, "{sq:?}");
            if !det.is_zero() {
                assert_eq!(hnf_mod(&sq, &det.abs()), hnf(&sq), "{sq:?}");
                let q = to_q(&sq);
                let mut keep = super::super::mem::Held::new(0).unwrap();
                assert_eq!(inverse_charged(&q, &mut keep).unwrap(), inverse(&q), "{sq:?}");
            }
        }
    }

    #[test]
    fn hnf_inverse_kernel() {
        let h = hnf(&z(&[&[4, 6], &[6, 9], &[2, 3]]));
        assert_eq!(h, z(&[&[2, 3]]));
        let h = hnf(&z(&[&[2, 0], &[1, 3], &[0, 5]]));
        assert_eq!(h, z(&[&[1, 0], &[0, 1]]));
        let m = to_q(&z(&[&[2, 1], &[1, 1]]));
        assert_eq!(inverse(&m), to_q(&z(&[&[1, -1], &[-1, 2]])));
        let k = left_kernel_mod(&z(&[&[1, 2], &[2, 4], &[0, 1]]), &BigInt::from(7));
        assert_eq!(k.len(), 1);
        let prod = vec_mat(&k[0], &z(&[&[1, 2], &[2, 4], &[0, 1]]));
        assert!(prod.iter().all(|x: &BigInt| x.mod_floor(&BigInt::from(7)).is_zero()));
    }
}
