//! Route 3's Compress: B V0 = [C | 0] with V0 unimodular and C the HNF of
//! B's column lattice, on both rings; and the first commit's measurement
//! (`smith_route3_bar`, ignored: run it in release with --nocapture).

use num_traits::{One, Signed, Zero};
use sagebrush_arith::cost::{tallied, Local};
use sagebrush_arith::smith::route3::{compress, hnf_modulus, pivot_columns};
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

/// The gcd of B's r x r minors (all column subsets), for small B.
fn minors_gcd(b: &ZMat) -> BigInt {
    let (r, n) = (b.rows, b.cols);
    let mut g = BigInt::zero();
    let mut pick: Vec<usize> = (0..r).collect();
    loop {
        let m = ZMat::from_rows((0..r).map(|i| pick.iter().map(|&c| b.get(i, c).clone()).collect()).collect());
        g = num_integer::Integer::gcd(&g, &zmat::det(&m));
        // the next r-subset of 0..n
        let Some(t) = (0..r).rev().find(|&t| pick[t] < n - r + t) else { break };
        pick[t] += 1;
        for u in t + 1..r {
            pick[u] = pick[u - 1] + 1;
        }
    }
    g
}

/// G = (Delta / delta) gcd(delta, Q's entries) is a multiple of the index
/// [Z^r : Lambda] (the gcd of all r-minors; G reads only the minors one
/// column away from B_J, so it can be a proper multiple, on one row here
/// 3 times it), equal to it on most rows; and C's determinant is the index.
#[test]
fn hnf_modulus_is_the_index_on_small_rows() {
    let mut rg = Rng(13);
    let (mut rows, mut equal) = (0, 0);
    for &(r, n, rank_bits, plain) in &[(2usize, 4usize, 8u32, true), (3, 5, 6, true), (3, 6, 12, false), (4, 7, 10, false), (2, 2, 9, true), (3, 3, 9, false)] {
        for _ in 0..4 {
            // plain: random rows; else X Y (an index of about |det X|)
            let b = if plain {
                ZMat::from_rows((0..r).map(|_| (0..n).map(|_| e(&mut rg, rank_bits)).collect()).collect())
            } else {
                product(&mut rg, r, n, r, rank_bits)
            };
            let j = pivot_columns(&b);
            if j.len() < r {
                continue;
            }
            let bj = ZMat::from_rows((0..r).map(|i| j.iter().map(|&c| b.get(i, c).clone()).collect()).collect());
            let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
            let jp: Vec<usize> = (0..n).filter(|c| !j.contains(c)).collect();
            let q = nm.mul(&ZMat::from_rows((0..r).map(|i| jp.iter().map(|&c| b.get(i, c).clone()).collect()).collect()));
            let g = hnf_modulus(&q, &delta, &det, &mut Local::new());
            let index = minors_gcd(&b);
            assert!((&g % &index).is_zero(), "G a multiple of the index");
            rows += 1;
            equal += (g == index) as usize;
            let (_, c) = check(&b, &j);
            assert_eq!(zmat::det(&c), index, "det C = the index");
        }
    }
    eprintln!("G = the index on {equal} of {rows} rows");
    assert!(rows >= 20 && 4 * equal >= 3 * rows, "G = the index on most rows ({equal} of {rows})");
}

/// Compress's units, per family, pinned on four rows: the HNF and the
/// kernel each on the word ring and on the multi-limb ring (G and delta
/// word-sized; G word and delta not; both multi-limb).  Moves when a leaf
/// charge goes (gcd_cofactor_e's on either ring among them) or when C's
/// modulus becomes delta again.
#[test]
fn compress_units_pins() {
    let mut out = vec![];
    for &(r, n, bits, seed, plain, rings) in &[(3usize, 6usize, 8u32, 1u64, false, (true, true)), (4, 7, 30, 2, true, (true, false)), (4, 7, 40, 3, false, (false, false))] {
        let mut rg = Rng(seed);
        let b = if plain { ZMat::from_rows((0..r).map(|_| (0..n).map(|_| e(&mut rg, bits)).collect()).collect()) } else { product(&mut rg, r, n, r, bits) };
        let j = pivot_columns(&b);
        {
            let bj = ZMat::from_rows((0..r).map(|i| j.iter().map(|&c| b.get(i, c).clone()).collect()).collect());
            let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
            let jp: Vec<usize> = (0..n).filter(|c| !j.contains(c)).collect();
            let q = nm.mul(&ZMat::from_rows((0..r).map(|i| jp.iter().map(|&c| b.get(i, c).clone()).collect()).collect()));
            let g = hnf_modulus(&q, &delta, &det, &mut Local::new());
            let word = |x: &BigInt| x.bits() < 62;
            assert_eq!((word(&g), word(&delta)), rings, "the rings reached");
        }
        let t0 = tallied();
        let (_, _) = compress(&b, &j).unwrap();
        let t1 = tallied();
        let d: Vec<u64> = (0..t0.0.len()).map(|i| t1.0[i].wrapping_sub(t0.0[i])).collect();
        out.push(d);
    }
    let pins: [[u64; 10]; 3] = [[242, 0, 22, 0, 28, 154, 305, 0, 0, 0], [1628, 0, 698, 0, 100, 333, 387, 13, 0, 0], [3011, 0, 4359, 0, 544, 428, 458, 110, 0, 0]];
    for (i, (d, p)) in out.iter().zip(&pins).enumerate() {
        assert_eq!(d[..], p[..], "Compress's units on row {i}");
    }
}
