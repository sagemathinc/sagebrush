//! Route 3's C (the HNF of B's column lattice, from a column Howell
//! echelon modulo G, lifted) against classgroup's hnf_mod of B's columns,
//! reduced above its diagonal: equal on the route 3 corpus rows (column
//! side and left side) and on rows whose pivots divide the modulus
//! properly.

use num_integer::Integer;
use num_traits::{Signed, ToPrimitive, Zero};
use sagebrush_arith::smith::route3::{compress, pivot_columns};
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::linalg::hnf_mod;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
}
fn e(r: &mut Rng, b: u32) -> BigInt {
    let x = BigInt::from(r.next() >> (64 - b));
    if r.next() & 1 == 1 {
        -x
    } else {
        x
    }
}

/// hnf_mod of the columns of `b` (as rows) with d = |det B_J|, reduced
/// above the diagonal into [0, pivot): the transpose of C.
fn reference(b: &ZMat, j: &[usize]) -> Option<Vec<Vec<BigInt>>> {
    let r = b.rows;
    let cols: Option<Vec<Vec<i64>>> = (0..b.cols).map(|c| (0..r).map(|i| b.get(i, c).to_i64()).collect()).collect();
    let bj = ZMat::from_rows((0..r).map(|i| j.iter().map(|&c| b.get(i, c).clone()).collect()).collect());
    let mut w = hnf_mod(&cols?, r, &zmat::det(&bj).abs());
    for i in 0..r {
        for t in 0..i {
            let q = w[t][i].div_floor(&w[i][i]);
            if !q.is_zero() {
                let wi = w[i].clone();
                for (x, y) in w[t].iter_mut().zip(&wi) {
                    *x -= &q * y;
                }
            }
        }
    }
    Some(w)
}

/// C (from Compress) against the reference, for B of full row rank.
fn agree(b: &ZMat, j: &[usize]) -> (ZMat, ZMat) {
    let (v0, c) = compress(b, j).unwrap();
    let r = b.rows;
    let w = reference(b, j).expect("the corpus fits i64");
    for i in 0..r {
        for t in 0..r {
            assert_eq!(c.get(t, i), &w[i][t], "C = hnf_mod^T at ({t}, {i}) on {}x{}", r, b.cols);
        }
    }
    (v0, c)
}

/// The route 3 corpus row: A = X Y (X m x rank of `bits`-bit entries, Y
/// rank x n of 4-bit), or a plain random A; B = rows I of A, and the left
/// side's B = (A X)^T with J = I when its entries fit i64.
fn row(rg: &mut Rng, m: usize, n: usize, rank: usize, bits: u32, plain: bool) -> usize {
    let a = if plain {
        ZMat::from_rows((0..m).map(|_| (0..n).map(|_| e(rg, bits)).collect()).collect())
    } else {
        let x = ZMat::from_rows((0..m).map(|_| (0..rank).map(|_| e(rg, bits)).collect()).collect());
        let y = ZMat::from_rows((0..rank).map(|_| (0..n).map(|_| e(rg, 4)).collect()).collect());
        x.mul(&y)
    };
    let is = zmat::rref(&a.transpose()).2;
    let r = is.len();
    let b = ZMat::from_rows(is.iter().map(|&i| (0..n).map(|t| a.get(i, t).clone()).collect()).collect());
    let mut sides = 0;
    if r < n {
        let (v0, _) = agree(&b, &pivot_columns(&b));
        sides += 1;
        let x = ZMat::from_rows((0..n).map(|i| (0..r).map(|t| v0.get(i, t).clone()).collect()).collect());
        let bl = a.mul(&x).transpose();
        if r < m && reference(&bl, &is).is_some() {
            agree(&bl, &is);
            sides += 1;
        }
    } else if r < m {
        let bl = a.transpose();
        if reference(&bl, &is).is_some() {
            agree(&bl, &is);
            sides += 1;
        }
    }
    sides
}

#[test]
fn route3_c_is_hnf_mod_on_the_corpus() {
    let mut rg = Rng(5);
    let mut sides = 0;
    // (m, n, rank, bits, plain): square singular, low rank, rectangular
    // both ways, and plain random rows (delta = Delta, as a rule)
    let rows: &[(usize, usize, usize, u32, bool)] = &[
        (8, 8, 7, 16, false),
        (8, 8, 7, 4, false),
        (8, 8, 4, 16, false),
        (12, 12, 11, 2, false),
        (16, 16, 15, 16, false),
        (24, 24, 12, 16, false),
        (32, 32, 16, 8, false),
        (16, 18, 16, 16, false),
        (20, 14, 14, 16, false),
        (6, 9, 6, 16, true),
        (9, 6, 6, 16, true),
        (8, 40, 8, 16, false),
        (40, 8, 8, 16, false),
    ];
    for &(m, n, rank, bits, plain) in rows {
        sides += row(&mut rg, m, n, rank, bits, plain);
    }
    assert!(sides >= 15, "both sides reached on most rows ({sides})");
}

#[test]
fn route3_c_is_hnf_mod_with_proper_divisor_pivots() {
    // B = D W, D = diag(6, 10, 15) (pivots 2, 3, 5 each a proper divisor
    // of the modulus), and the 2 x 3 row of a non-unit cofactor
    let mut rg = Rng(9);
    let d = ZMat::from_rows(vec![vec![6.into(), 0.into(), 0.into()], vec![0.into(), 10.into(), 0.into()], vec![0.into(), 0.into(), 15.into()]]);
    let mut seen = 0;
    for _ in 0..20 {
        let w = ZMat::from_rows((0..3).map(|_| (0..6).map(|_| e(&mut rg, 3)).collect()).collect());
        let b = d.mul(&w);
        let j = pivot_columns(&b);
        if j.len() == 3 {
            let (_, c) = agree(&b, &j);
            seen += (1..3).any(|i| !c.get(i, i).is_zero() && c.get(i, i) > &BigInt::from(1)) as usize;
        }
    }
    assert!(seen > 0, "a pivot above 1 reached");
    let b = ZMat::from_rows(vec![vec![2.into(), 0.into(), 6.into()], vec![0.into(), 4.into(), 6.into()]]);
    agree(&b, &[0, 1]);
}
