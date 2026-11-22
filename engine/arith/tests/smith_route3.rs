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
/// A random entry of up to `b` bits (any b >= 1), signed.
fn e(r: &mut Rng, b: u32) -> BigInt {
    let mut x = BigInt::zero();
    let mut left = b;
    while left > 0 {
        let t = left.min(63);
        x = (x << t as usize) + BigInt::from(r.next() >> (64 - t));
        left -= t;
    }
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
/// [Z^r : Lambda] (the gcd of all r-minors) on every row, equal to it on
/// all but two named rows (G reads only the minors one column away from
/// B_J, so it can be a proper multiple); and C's determinant is the index.
#[test]
fn hnf_modulus_is_the_index_on_small_rows() {
    let mut rg = Rng(13);
    let (mut rows, mut proper) = (0, vec![]);
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
            if g != index {
                proper.push((rows, &g / &index));
            }
            rows += 1;
            let (_, c) = check(&b, &j);
            assert_eq!(zmat::det(&c), index, "det C = the index");
        }
    }
    // (seeded rows: G is the index on all but rows 9 and 13, where it is 3
    // and 2 times it)
    assert_eq!(rows, 24, "every row reached");
    assert_eq!(proper, [(9, BigInt::from(3)), (13, BigInt::from(2))], "G / index on the named rows");
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
    let pins: [[u64; 10]; 3] = [[241, 0, 38, 0, 28, 172, 296, 0, 0, 0], [1628, 0, 717, 0, 100, 361, 387, 13, 0, 0], [2982, 0, 4447, 0, 544, 456, 458, 110, 0, 0]];
    for (i, (d, p)) in out.iter().zip(&pins).enumerate() {
        assert_eq!(d[..], p[..], "Compress's units on row {i}");
    }
}

/// Route 3 end to end on A, through smith_form: the units and seconds,
/// checked U A V = D (by blocks on the big thin rows).
fn route3_full(a: &ZMat) -> (u64, f64, ZMat) {
    let (f, units, secs) = timed(|| smith_form(a).unwrap());
    assert_eq!(f.route, sagebrush_arith::smith::Route::Hermite);
    let (m, n) = (a.rows, a.cols);
    let r = (0..m.min(n)).take_while(|&i| !f.d.get(i, i).is_zero()).count();
    if m * n <= 4000 {
        assert_eq!(f.u.mul(a).mul(&f.v).d, f.d.d, "U A V = D");
    } else {
        assert_eq!(f.u.mul(a).mul(&cols(&f.v, 0..r)).d, cols(&f.d, 0..r).d, "U A V = D on V's first r columns");
        assert!(a.mul(&cols(&f.v, r..n)).d.iter().all(|x| x.is_zero()), "A K = 0");
    }
    (units, secs, f.d)
}

#[test]
#[ignore]
fn smith_route3_table() {
    let mut rg = Rng(17);
    // (m, n, rank, bits, kind): 0 = X Y, 1 = plain random (delta = Delta as
    // a rule), 2 = plain with the last row the sum of the first two
    let rows_: &[(usize, usize, usize, u32, u8)] = &[
        (8, 8, 7, 16, 0),
        (16, 16, 15, 16, 0),
        (24, 24, 23, 16, 0),
        (32, 32, 31, 16, 0),
        (40, 40, 39, 16, 0),
        (48, 48, 47, 16, 0),
        (24, 24, 12, 16, 0),
        (32, 32, 16, 16, 0),
        (40, 40, 30, 16, 0),
        (16, 18, 16, 16, 0),
        (32, 34, 32, 16, 0),
        (48, 50, 48, 16, 0),
        (20, 14, 14, 16, 0),
        (200, 8, 8, 16, 0),
        (8, 200, 8, 16, 0),
        (1000, 8, 8, 16, 0),
        (8, 1000, 8, 16, 0),
        (8, 2000, 8, 16, 0),
        (8, 8, 7, 16, 2),
        (16, 16, 15, 2, 2),
        (16, 16, 15, 16, 2),
        (16, 18, 16, 4, 1),
        (16, 18, 16, 16, 1),
        (24, 26, 24, 16, 1),
        (18, 16, 16, 16, 1),
    ];
    let mut miss = vec![];
    for &(m, n, rank, bits, kind) in rows_ {
        let a = match kind {
            0 => product(&mut rg, m, n, rank, bits),
            _ => {
                let mut x: Vec<Vec<BigInt>> = (0..m).map(|_| (0..n).map(|_| e(&mut rg, bits)).collect()).collect();
                if kind == 2 {
                    x[m - 1] = x[0].iter().zip(&x[1]).map(|(p, q)| p + q).collect();
                }
                ZMat::from_rows(x)
            }
        };
        let (u3, s3, d3) = route3_full(&a);
        let (g, cu, cs) = timed(|| smith_classical(&a));
        assert_eq!(g.d.d, d3.d, "the Smith form");
        let ratio = u3 as f64 / cu as f64;
        // bar 1 (n >= 16: <= max(classical, F); 8 x 8: <= max(3 classical,
        // F), F = 1e5 units) and bar 2 (thin shapes: <= 3 classical)
        let thin = m.min(n) == 8 && m.max(n) > 8;
        let bar = if thin || m.max(n) <= 8 { 3.0 } else { 1.0 };
        let ok = (u3 as f64) <= (bar * cu as f64).max(if thin { 0.0 } else { 1e5 });
        if !ok {
            miss.push(format!("{m}x{n} r{rank} k{kind}"));
        }
        println!("TABLE {m}x{n} r{rank} {bits}b kind{kind}: route 3 {u3} units {s3:.4} s; classical {cu} units {cs:.4} s; {ratio:.3}x (bar {bar}) {}", if ok { "ok" } else { "MISS" });
    }
    println!("MISSES {miss:?}");
}

/// U A V = D with U and V unimodular and D the oracle's (small inputs).
fn full_check(a: &ZMat) -> sagebrush_arith::smith::SmithForm {
    let f = smith_form(a).unwrap();
    let (m, n) = (a.rows, a.cols);
    assert_eq!((f.u.rows, f.u.cols, f.v.rows, f.v.cols, f.d.rows, f.d.cols), (m, m, n, n, m, n), "shapes");
    assert_eq!(f.u.mul(a).mul(&f.v).d, f.d.d, "U A V = D");
    for z in [&f.u, &f.v] {
        assert!(z.rows == 0 || zmat::det(z).abs().is_one(), "unimodular");
    }
    if m * n <= 400 {
        assert_eq!(f.d.d, smith_classical(a).d.d, "D = the oracle's");
    }
    f
}

#[test]
fn route3_shapes_and_edges() {
    use sagebrush_arith::smith::Route;
    let mut rg = Rng(23);
    let z = |rows: &[&[i64]]| ZMat::from_rows(rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect());
    // r = 0: zero matrices of every shape, the empty ones included
    for (m, n) in [(0, 0), (0, 3), (3, 0), (1, 1), (2, 3), (3, 2)] {
        let f = full_check(&ZMat::zero(m, n));
        assert_eq!(f.route, Route::Hermite);
        assert!(f.d.d.iter().all(|x| x.is_zero()));
    }
    // r = 1, a zero row or column, m = 1 or n = 1
    for a in [z(&[&[0, 6, 4]]), z(&[&[0], &[6], &[4]]), z(&[&[2, 4], &[3, 6]]), z(&[&[0, 0, 0], &[1, 2, 3], &[0, 0, 0]]), z(&[&[0, 1, 0], &[0, 2, 0], &[0, 5, 0]]), z(&[&[1, 2, 3], &[2, 4, 6], &[1, 0, 1]]), z(&[&[6, 10, 15], &[4, 8, 12]])] {
        assert_eq!(full_check(&a).route, Route::Hermite);
    }
    // random singular, rank-deficient, wide and tall
    for &(m, n, rank, bits) in &[(5, 5, 4, 8), (6, 6, 3, 16), (4, 7, 4, 12), (7, 4, 4, 12), (6, 9, 2, 20), (9, 6, 5, 20), (3, 12, 3, 30), (12, 3, 3, 30), (10, 10, 9, 70)] {
        let a = product(&mut rg, m, n, rank, bits);
        assert_eq!(full_check(&a).route, Route::Hermite);
    }
    // nonsingular square input keeps routes 1 and 2
    let a = product(&mut rg, 5, 5, 5, 8);
    assert_ne!(smith_form(&a).unwrap().route, Route::Hermite);
}

/// The rank retry: the first prime p divides the second row's pivot, so the
/// profile modulo p has rank 1; the certificate A K = 0 fails on that row,
/// the next prime gives rank 2, and D = diag(1, p).
#[test]
fn route3_rank_retry_on_a_bad_prime() {
    let p = sagebrush_arith::nmod::Primes::new().next().unwrap();
    let pb = BigInt::from(p);
    for a in [
        ZMat::from_rows(vec![vec![1.into(), 0.into(), 0.into()], vec![0.into(), pb.clone(), 0.into()]]),
        ZMat::from_rows(vec![vec![1.into(), 0.into(), 0.into()], vec![0.into(), pb.clone(), 0.into()], vec![1.into(), pb.clone(), 0.into()]]),
        ZMat::from_rows(vec![vec![pb.clone(), 0.into()], vec![0.into(), 0.into()], vec![0.into(), 1.into()]]),
    ] {
        let f = full_check(&a);
        assert_eq!((f.d.get(0, 0), f.d.get(1, 1)), (&BigInt::from(1), &pb), "the full rank found");
    }
}

/// Route 3's units ceilings (regressions): each row's metered units at most
/// 1.1 times those recorded when route 3 landed (the bars' rows: 8 x 8
/// rank 7, 48 x 48 rank 47, 48 x 50, the thin shapes, and plain random
/// rows, delta = Delta).  A dense n x n product in the block combination
/// would add about n^2 r products: 8 x 2000's ceiling fails on it.
#[test]
fn route3_units_ceilings() {
    let print = std::env::var("PRINT_CEILINGS").is_ok();
    // (m, n, rank, bits, plain, seed, recorded units)
    let rows: &[(usize, usize, usize, u32, bool, u64, u64)] = &[
        (8, 8, 7, 16, false, 1, 31580),
        (48, 48, 47, 16, false, 2, 62045054),
        (48, 50, 48, 16, false, 3, 63794109),
        (200, 8, 8, 16, false, 4, 482519),
        (8, 200, 8, 16, false, 5, 604604),
        (1000, 8, 8, 16, false, 6, 4077496),
        (8, 1000, 8, 16, false, 7, 4807519),
        (8, 2000, 8, 16, false, 8, 13603045),
        (16, 18, 16, 16, true, 9, 273770),
        (18, 16, 16, 16, true, 10, 270382),
        (24, 26, 24, 16, true, 11, 1368983),
    ];
    for &(m, n, rank, bits, plain, seed, recorded) in rows {
        let mut rg = Rng(seed);
        let a = if plain { ZMat::from_rows((0..m).map(|_| (0..n).map(|_| e(&mut rg, bits)).collect()).collect()) } else { product(&mut rg, m, n, rank, bits) };
        let (f, units, _) = timed(|| smith_form(&a).unwrap());
        assert_eq!(f.route, sagebrush_arith::smith::Route::Hermite);
        if print {
            println!("        ({m}, {n}, {rank}, {bits}, {plain}, {seed}, {units}),");
            continue;
        }
        assert!(units * 10 <= recorded * 11, "{m} x {n} rank {rank}: {units} units, above 1.1 times the {recorded} recorded");
    }
}
