//! Route 3's Compress: B V0 = [C | 0] with V0 unimodular and C the HNF of
//! B's column lattice, on both rings; and the first commit's measurement
//! (`smith_route3_bar`, ignored: run it in release with --nocapture).

use num_traits::{One, Signed, Zero};
use sagebrush_arith::cost::tallied;
use sagebrush_arith::smith::route3::{compress, pivot_columns};
use sagebrush_arith::smith::{smith_classical, smith_form};
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;
use std::time::Instant;

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
/// X Y with X (m x rank, `bits`-bit entries) and Y (rank x n, 4-bit).
fn product(rg: &mut Rng, m: usize, n: usize, rank: usize, bits: u32) -> ZMat {
    let x = ZMat::from_rows((0..m).map(|_| (0..rank).map(|_| e(rg, bits)).collect()).collect());
    let y = ZMat::from_rows((0..rank).map(|_| (0..n).map(|_| e(rg, 4)).collect()).collect());
    x.mul(&y)
}
fn rows(a: &ZMat, is: &[usize]) -> ZMat {
    ZMat::from_rows(is.iter().map(|&i| (0..a.cols).map(|j| a.get(i, j).clone()).collect()).collect())
}
fn cols(a: &ZMat, js: std::ops::Range<usize>) -> ZMat {
    ZMat::from_rows((0..a.rows).map(|i| js.clone().map(|j| a.get(i, j).clone()).collect()).collect())
}

/// The checks: B V0 = [C | 0], |det V0| = 1, C lower triangular with
/// positive diagonal and the entries left of it reduced, and C's lattice
/// B's (det C = the gcd of B's maximal minors, its index).
fn check(b: &ZMat, j: &[usize]) -> (ZMat, ZMat) {
    let (r, n) = (b.rows, b.cols);
    let (v0, c) = compress(b, j).unwrap();
    let bv = b.mul(&v0);
    for i in 0..r {
        for t in 0..n {
            let want = if t < r { c.get(i, t).clone() } else { BigInt::zero() };
            assert_eq!(bv.get(i, t), &want, "B V0 = [C | 0] at ({i}, {t})");
        }
    }
    assert!(zmat::det(&v0).abs().is_one(), "V0 unimodular");
    for i in 0..r {
        assert!(c.get(i, i).is_positive(), "C's diagonal");
        for t in 0..r {
            if t > i {
                assert!(c.get(i, t).is_zero(), "C lower triangular");
            } else if t < i {
                assert!(!c.get(i, t).is_negative() && c.get(i, t) < c.get(i, i), "C reduced at ({i}, {t})");
            }
        }
    }
    (v0, c)
}

#[test]
fn compress_word_and_big() {
    let mut rg = Rng(3);
    // (r, n, bits): word delta for the small rows, big delta for the rest
    for &(r, n, bits) in &[(1, 3, 8), (2, 5, 8), (3, 3, 8), (4, 9, 12), (5, 7, 16), (6, 20, 10), (3, 4, 40), (5, 9, 30), (8, 12, 24)] {
        for _ in 0..3 {
            let b = ZMat::from_rows((0..r).map(|_| (0..n).map(|_| e(&mut rg, bits)).collect()).collect());
            let j = pivot_columns(&b);
            if j.len() == r {
                check(&b, &j);
            }
        }
    }
}

#[test]
fn compress_proper_divisor_pivots() {
    // pivots g with 1 < g < delta (and a non-unit cofactor), and a column
    // lattice of index > 1: [[2, 0, 6], [0, 4, 6]], delta = 8, C = [[2, 0],
    // [0, 2]] (the gcd of the minors 8, 12, -24 is 4)
    let b = ZMat::from_rows(vec![vec![2.into(), 0.into(), 6.into()], vec![0.into(), 4.into(), 6.into()]]);
    let (_, c) = check(&b, &[0, 1]);
    assert_eq!(c.d, vec![BigInt::from(2), 0.into(), 0.into(), 2.into()]);
    // B = D W with W unimodular and D = diag(6, 10, 15): pivots dividing
    // delta properly on every row
    let mut rg = Rng(11);
    for _ in 0..10 {
        let w = ZMat::from_rows((0..3).map(|_| (0..5).map(|_| e(&mut rg, 3)).collect()).collect());
        let d = ZMat::from_rows(vec![vec![6.into(), 0.into(), 0.into()], vec![0.into(), 10.into(), 0.into()], vec![0.into(), 0.into(), 15.into()]]);
        let b = d.mul(&w);
        let j = pivot_columns(&b);
        if j.len() == 3 {
            check(&b, &j);
        }
    }
}

fn timed<T>(f: impl FnOnce() -> T) -> (T, u64, f64) {
    let t0 = tallied();
    let st = Instant::now();
    let x = f();
    let t1 = tallied();
    (x, (0..t0.0.len()).map(|i| t1.0[i].wrapping_sub(t0.0[i])).sum(), st.elapsed().as_secs_f64())
}

/// Column Compress plus the left side on A (m x n, rank r): the units and
/// seconds of the rank profile, the column Compress, A X, and the left
/// Compress (with J = I: rows I of A X are C, B_J = C^T); and T.
fn compress_both(a: &ZMat) -> (Vec<(&'static str, u64, f64)>, ZMat) {
    let m = a.rows;
    let mut log = vec![];
    let (is, u, s) = timed(|| zmat::rref(&a.transpose()).2);
    log.push(("rank profile", u, s));
    let r = is.len();
    let b = rows(a, &is);
    let ((j, (x, c)), u, s) = timed(|| {
        let j = pivot_columns(&b);
        let vc = compress(&b, &j).unwrap();
        (j, (cols(&vc.0, 0..r), vc.1))
    });
    let _ = j;
    log.push(("column Compress", u, s));
    let (ax, u, s) = timed(|| a.mul(&x));
    log.push(("A X", u, s));
    let (t, u, s) = timed(|| {
        if r == m {
            return ax;
        }
        let bl = ax.transpose();
        let (w, cl) = compress(&bl, &is).unwrap();
        let _ = w;
        cl.transpose()
    });
    log.push(("left Compress", u, s));
    let _ = c;
    (log, t)
}

#[test]
#[ignore]
fn smith_route3_bar() {
    let mut rg = Rng(7);
    // 48 / r47 against route 2 on nonsingular 48 x 48 of the same form
    let a = product(&mut rg, 48, 48, 47, 16);
    let (log, t) = compress_both(&a);
    let sum: (u64, f64) = log.iter().fold((0, 0.0), |s, x| (s.0 + x.1, s.1 + x.2));
    let (tf, tu, ts) = timed(|| smith_form(&t).unwrap());
    let a2 = product(&mut rg, 48, 48, 48, 16);
    let (f2, u2, s2) = timed(|| smith_form(&a2).unwrap());
    for (w, u, s) in &log {
        println!("    48x48 r47 {w}: {u} units {s:.4} s");
    }
    println!(
        "BAR 48x48 r47: Compress + left {} units {:.4} s; core ({:?}) {tu} units {ts:.4} s; route 2 ({:?}) on 48x48 r48: {u2} units {s2:.4} s; ratios {:.2}x units, {:.2}x wall",
        sum.0,
        sum.1,
        tf.route,
        f2.route,
        sum.0 as f64 / u2 as f64,
        sum.1 / s2
    );
    // the thin shapes against the classical route (route 3: Compress, left
    // side and the core)
    for &(m, n) in &[(8, 1000), (1000, 8), (8, 2000)] {
        let a = product(&mut rg, m, n, 8, 16);
        let (log, t) = compress_both(&a);
        let (_, tu, ts) = timed(|| smith_form(&t).unwrap());
        let sum: (u64, f64) = log.iter().fold((tu, ts), |s, x| (s.0 + x.1, s.1 + x.2));
        let (_, cu, cs) = timed(|| smith_classical(&a));
        for (w, u, s) in &log {
            println!("    {m}x{n} r8 {w}: {u} units {s:.4} s");
        }
        println!("THIN {m}x{n} r8: route 3 {} units {:.4} s (core {tu}); classical {cu} units {cs:.4} s; ratio {:.2}x units", sum.0, sum.1, sum.0 as f64 / cu as f64);
    }
}
