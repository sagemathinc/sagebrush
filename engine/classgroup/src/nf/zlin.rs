//! Exact linear algebra over Z, Q and F_p for small dense matrices (number
//! field bases are n x n with n the degree).

use sagebrush_arith::cost::{bigdiv_units, bigeuclid_units, bigmul_units, Family, Local};
use sagebrush_arith::zmat::{copy_units, limbs};
use sagebrush_bigint::BigInt;
use num_integer::Integer;
use sagebrush_bigint::BigRational;
use num_traits::{One, Signed, Zero};

pub type ZMat = Vec<Vec<BigInt>>;
pub type QMat = Vec<Vec<BigRational>>;

/// The Hermite normal form of the lattice spanned by the rows: upper
/// triangular rows (rank many), positive pivots, entries above a pivot
/// reduced to [0, pivot).
///
/// Units (`cost::tally`), per pass after its work and flushed at the
/// pass's check: an elimination step's quotient and pivot-column update as
/// a Euclid step (`bigeuclid_units`, Gcd), the rest of its row update
/// through `bigmul_units`; the reduction above a pivot's quotients through
/// `bigdiv_units` and its row updates through `bigmul_units` (a product's
/// subtraction from its row is part of its units, as in zmat); the
/// smallest-entry search, the row copies and negations as Move.
pub fn hnf(rows: &[Vec<BigInt>]) -> ZMat {
    let mut a: ZMat = rows.iter().filter(|r| r.iter().any(|x| !x.is_zero())).cloned().collect();
    let mut acc = Local::new();
    acc.n(Family::Move, a.iter().map(|r| copy_units(r)).sum());
    let m = a.first().map_or(0, |r| r.len());
    let mut r = 0;
    for col in 0..m {
        loop {
            acc.flush();
            sagebrush_interrupt::check();
            // the smallest nonzero entry of the column at or below r
            let best = (r..a.len()).filter(|&i| !a[i][col].is_zero()).min_by(|&i, &j| a[i][col].abs().cmp(&a[j][col].abs()));
            // (the comparisons' absolute values: a copy of each nonzero
            // candidate, about twice)
            acc.n(Family::Move, (r..a.len()).filter(|&i| !a[i][col].is_zero()).map(|i| 2 * limbs(&a[i][col]) as u64).sum());
            let Some(b) = best else { break };
            a.swap(r, b);
            let lp = limbs(&a[r][col]);
            let row = copy_units(&a[r]);
            let rest = usize::try_from(row.saturating_sub(lp as u64)).unwrap_or(usize::MAX);
            let mut clean = true;
            // (each helper's one family, summed here and added per pass)
            let (mut gcd, mut mul, mut moved) = (0u64, 0u64, 0u64);
            for i in r + 1..a.len() {
                if a[i][col].is_zero() {
                    continue;
                }
                let li = limbs(&a[i][col]);
                let q = a[i][col].div_floor(&a[r][col]);
                let pr = a[r].clone();
                for (x, y) in a[i].iter_mut().zip(&pr) {
                    *x -= &q * y;
                }
                gcd = gcd.saturating_add(bigeuclid_units(li, lp).get(Family::Gcd));
                mul = mul.saturating_add(bigmul_units(limbs(&q), rest).get(Family::MulSchool));
                moved = moved.saturating_add(row);
                if !a[i][col].is_zero() {
                    clean = false;
                }
            }
            acc.n(Family::Gcd, gcd);
            acc.n(Family::MulSchool, mul);
            acc.n(Family::Move, moved);
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
            acc.n(Family::Move, copy_units(&a[r]));
        }
        let lp = limbs(&a[r][col]);
        let row = copy_units(&a[r]);
        for i in 0..r {
            let q = a[i][col].div_floor(&a[r][col]);
            acc.add(bigdiv_units(limbs(&a[i][col]), lp));
            if !q.is_zero() {
                let pr = a[r].clone();
                for (x, y) in a[i].iter_mut().zip(&pr) {
                    *x -= &q * y;
                }
                acc.n(Family::Move, row);
                acc.add(bigmul_units(limbs(&q), usize::try_from(row).unwrap_or(usize::MAX)));
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
