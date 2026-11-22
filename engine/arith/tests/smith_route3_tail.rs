//! Route 3's two paths to C = HNF(B Z^n): the tail path against today's
//! column echelon (the HNF is unique, so the two must agree on every
//! input: the corpus families, cyclic and non-cyclic quotients, a
//! non-suffix one forcing k to r, wide input, delta = 1, G = 1, and index
//! 1 with G > 1, where the tail path stops at k = 0); the switch on named
//! sizes, each guard tripped; the speed rows (the named bar, its
//! reference draws, and the non-suffix input within the worst-case
//! bound); and the estimate taking the path the run takes.

use num_traits::{One, Zero};
use sagebrush_arith::cost::{bigdiv_units, bigmul_units, tallied, Local};
use sagebrush_arith::smith::estimate::{self, stage2_route3_terms};
use sagebrush_arith::smith::route3::{self, hermite_c, pivot_columns, tail_path, CPath};
use sagebrush_arith::smith::smith_form;
use sagebrush_arith::zmat::{self, ZMat};
use sagebrush_bigint::BigInt;

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
fn plain(rg: &mut Rng, m: usize, n: usize, bits: u32) -> ZMat {
    ZMat::from_rows((0..m).map(|_| (0..n).map(|_| e(rg, bits)).collect()).collect())
}
/// X Y with X (m x rank, `bits`-bit entries) and Y (rank x n, 4-bit).
fn product(rg: &mut Rng, m: usize, n: usize, rank: usize, bits: u32) -> ZMat {
    plain(rg, m, rank, bits).mul(&plain(rg, rank, n, 4))
}
fn units<T>(f: impl FnOnce() -> T) -> (u64, T) {
    let t0 = tallied();
    let x = f();
    let t1 = tallied();
    ((0..t0.0.len()).map(|i| t1.0[i].wrapping_sub(t0.0[i])).sum(), x)
}
fn z(rows: &[&[i64]]) -> ZMat {
    ZMat::from_rows(rows.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect())
}

/// The tail size of an HNF: r less its identity head's length.
fn tail_size(c: &ZMat) -> usize {
    let r = c.rows;
    let head = (0..r).take_while(|&i| c.get(i, i).is_one() && (0..r).all(|t| t == i || c.get(i, t).is_zero())).count();
    r - head
}

/// Both paths on B (pivot columns J), the HNF they agree on.
fn both(b: &ZMat, j: &[usize], what: &str) -> ZMat {
    let c1 = hermite_c(b, j, CPath::Echelon).unwrap();
    let c2 = hermite_c(b, j, CPath::Tail).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(c1.d, c2.d, "{what}: the tail path's C");
    c1
}

/// The tail path's C equals today's on every input, and the inputs reach
/// k = 1, k > 1 and k = r.
#[test]
fn the_tail_path_is_the_hnf() {
    let (mut tested, mut ks, mut nonsuffix) = (0, [0usize; 3], 0);
    for &(r, n, bits, xy) in &[
        (2usize, 3usize, 2u32, false),
        (3, 4, 8, false),
        (4, 6, 6, true),
        (5, 12, 8, false),
        (6, 7, 12, true),
        (8, 9, 16, true),
        (10, 11, 3, false),
        (12, 13, 16, true),
        (16, 18, 10, true),
        (24, 25, 16, true),
    ] {
        for seed in 0..12u64 {
            let mut rg = Rng(seed * 31 + r as u64);
            let b = if xy { product(&mut rg, r, n, r, bits) } else { plain(&mut rg, r, n, bits) };
            let j = pivot_columns(&b);
            if j.len() != r {
                continue;
            }
            let c = both(&b, &j, &format!("{r} x {n}, {bits} bits, seed {seed}"));
            let k = tail_size(&c);
            ks[if k <= 1 { 0 } else if k < r { 1 } else { 2 }] += 1;
            if k == r {
                assert!(!c.get(0, 0).is_one() || (1..r).any(|t| !c.get(0, t).is_zero()), "k = r: row 0 is not the identity's");
            }
            tested += 1;
        }
    }
    // a non-suffix input: B = D W, D's non-unit entries at rows 1 and r - 1
    // (6 and a prime), so HNF's tail runs to row 1
    let mut rg = Rng(99);
    for t in 0..8 {
        let r = 6;
        let mut d = ZMat::identity(r);
        d.d[r + 1] = BigInt::from(6);
        d.d[(r - 1) * r + r - 1] = BigInt::from(1_000_003);
        let b = d.mul(&plain(&mut rg, r, r + 2, 3));
        let j = pivot_columns(&b);
        if j.len() != r {
            continue;
        }
        let c = both(&b, &j, &format!("non-suffix {t}"));
        assert!(tail_size(&c) >= r - 1, "non-suffix {t}: the tail reaches row 1");
        nonsuffix += 1;
        tested += 1;
    }
    println!("tested {tested}; k <= 1: {}, 1 < k < r: {}, k = r: {}; non-suffix (k >= r - 1): {nonsuffix}", ks[0], ks[1], ks[2]);
    assert_eq!(tested, 128, "every input reached (all of full row rank)");
    assert!(ks.iter().all(|&x| x > 0) && nonsuffix > 0, "every kind reached: {ks:?}, non-suffix {nonsuffix}");
}

/// The edges: delta = 1 (B_J unimodular: G = 1, C = I on both paths); G = 1
/// with delta > 1; and index 1 with G > 1 (B_J = 2 I, so Delta / delta =
/// 2, and the columns (1, 1), (0, 1) fill Lambda out): the tail path stops
/// at k = 0, C = I; and k = r, the pass running out of columns.
#[test]
fn the_tail_paths_edges() {
    let b = z(&[&[1, 0, 3], &[0, 1, 5]]);
    assert!(both(&b, &[0, 1], "delta = 1").d == ZMat::identity(2).d);
    let b = z(&[&[3, 0, 1], &[0, 1, 1]]);
    assert!(both(&b, &[0, 1], "G = 1, delta = 3").d == ZMat::identity(2).d);
    let b = z(&[&[2, 0, 1, 0], &[0, 2, 1, 1]]);
    let mut acc = Local::new();
    let bj = z(&[&[2, 0], &[0, 2]]);
    let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
    let q = nm.mul(&z(&[&[1, 0], &[1, 1]]));
    let g = route3::hnf_modulus(&q, &delta, &det, &mut acc);
    acc.flush();
    assert_eq!((delta, g), (BigInt::from(2), BigInt::from(2)), "index 1 under G = 2");
    assert!(both(&b, &[0, 1], "index 1, G = 2").d == ZMat::identity(2).d);
    // k = r: Lambda = 2 Z x Z (its first coordinate always even), C =
    // diag(2, 1), no identity head: the pass runs out of columns
    let b = z(&[&[2, 0, 4], &[0, 1, 3]]);
    let c = both(&b, &[0, 1], "k = r");
    assert_eq!((c.d.clone(), tail_size(&c)), (z(&[&[2, 0], &[0, 1]]).d, 2), "k = r = 2");
}

/// The switch on named sizes, each guard tripped: the bar's sizes take the
/// tail path; wide input (n - r >= r) and G much smaller than delta keep
/// today's; and an input whose expected cost is cheaper but whose k = r
/// worst case is more than twice today's keeps today's too.  The rule's
/// three costs are recomputed here from the leaf prices.
#[test]
fn the_switch_on_named_sizes() {
    // (r, n, k^, delta's limbs, word, G's limbs, word, the path)
    let rows: &[(&str, usize, usize, usize, usize, bool, usize, bool, bool)] = &[
        ("the bar: 48 x 48 rank 47, delta 17 limbs, G 13", 47, 48, 1, 17, false, 13, false, true),
        ("wide: n - r >= r", 8, 1000, 1, 3, false, 3, false, false),
        ("G much smaller than delta", 47, 48, 1, 17, false, 1, true, false),
        ("the worst case past twice today's", 20, 26, 1, 4, false, 3, false, false),
        ("word rings, k^ = 0", 2, 3, 0, 1, true, 1, true, true),
    ];
    let price = |l: usize, word: bool| -> u64 {
        if word {
            return 1;
        }
        let mut u = bigmul_units(l, l);
        u.add_saturating(&bigmul_units(l, l));
        u.add_saturating(&bigdiv_units(2 * l + 1, l));
        u.total().unwrap()
    };
    for &(name, r, n, kh, ld, dw, lg, gw, want) in rows {
        let (pd, pg) = (price(ld, dw), price(lg, gw));
        let (r6, n6) = (r as u64, n as u64);
        let today = r6 * r6 * n6 * pg;
        let expected = r6 * n6 * (n6 - r6 + kh as u64) * pd;
        let worst = r6 * n6 * n6 * pd;
        println!("{name}: expected {expected}, today {today}, worst {worst} (2 today {})", 2 * today);
        assert_eq!(expected < today && worst <= 2 * today, want, "{name}: the rule recomputed");
        assert_eq!(tail_path(r, n, kh, ld, dw, lg, gw), want, "{name}");
        if name.starts_with("the worst") {
            assert!(expected < today && worst > 2 * today, "{name}: the worst-case guard alone decides");
        }
    }
}

/// The named bar (smith_route3_bar's input: Rng(7), 48 x 48 rank 47, X Y
/// with 16-bit X and 4-bit Y): route 3 at most 0.55 x its 62,281,179 units
/// before the tail path, against route 2 on the bar's next draw (Cyclic)
/// and on a later one (Trailing), both printed; and the non-suffix speed row: on an input whose
/// tail runs to row 1 while the switch takes the tail path, C's units are
/// at most twice today's path's.
#[test]
fn the_speed_rows() {
    let mut rg = Rng(7);
    let a = product(&mut rg, 48, 48, 47, 16);
    let (u3, f) = units(|| smith_form(&a).unwrap());
    let a2 = product(&mut rg, 48, 48, 48, 16);
    let (u2, f2) = units(|| smith_form(&a2).unwrap());
    println!("the bar: route 3 {u3} units ({:?}); route 2 ({:?}) {u2}; ratio {:.2}; before: 62281179, 9.29", f.route, f2.route, u3 as f64 / u2 as f64);
    assert!(u3 <= 62_281_179 * 55 / 100, "route 3 on the bar: {u3} units, past 0.55 x 62,281,179");
    // (the reference row: route 2 on a later draw of the same kind, which
    // takes route 2 Trailing: 14,163,344 units at the base)
    let mut rg = Rng(7);
    for &(m, n, rank) in &[(48, 48, 47), (32, 32, 31), (24, 24, 12), (8, 1000, 8), (16, 18, 16)] {
        let _ = product(&mut rg, m, n, rank, 16);
    }
    let a3 = product(&mut rg, 48, 48, 48, 16);
    let (u4, f4) = units(|| smith_form(&a3).unwrap());
    println!("the reference draw: route 2 ({:?}) {u4} units; route 3 on the bar against it {:.2}", f4.route, u3 as f64 / u4 as f64);
    // the non-suffix row: B = D [U | w], D's non-unit entries at rows 1
    // and r - 1 (6 and a 201-bit number), U unimodular (unit lower times
    // unit upper, 3-bit entries), so delta and G are both about D's size
    // and the switch takes the tail path
    let r = 24;
    let mut rg = Rng(5);
    let mut d = ZMat::identity(r);
    d.d[r + 1] = BigInt::from(6);
    d.d[(r - 1) * r + r - 1] = (BigInt::one() << 200usize) + BigInt::from(235);
    let unit = |rg: &mut Rng, lower: bool| {
        let mut u = ZMat::identity(r);
        for i in 0..r {
            for t in 0..r {
                if (lower && t < i) || (!lower && t > i) {
                    u.d[i * r + t] = e(rg, 3);
                }
            }
        }
        u
    };
    let uu = unit(&mut rg, true).mul(&unit(&mut rg, false));
    let w = plain(&mut rg, r, 1, 8);
    let wu = ZMat::from_rows((0..r).map(|i| (0..r).map(|t| uu.get(i, t).clone()).chain([w.get(i, 0).clone()]).collect()).collect());
    let b = d.mul(&wu);
    let j = pivot_columns(&b);
    let (ue, ce) = units(|| hermite_c(&b, &j, CPath::Echelon).unwrap());
    let (ut, ct) = units(|| hermite_c(&b, &j, CPath::Tail).unwrap());
    let (us, cs) = units(|| hermite_c(&b, &j, CPath::Switch).unwrap());
    assert_eq!((ce.d.clone(), ct.d), (ce.d.clone(), cs.d), "one HNF");
    assert_eq!(us, ut, "the switch takes the tail path here");
    assert!(tail_size(&ce) >= r - 1, "the tail reaches row 1");
    println!("non-suffix {r} x {}: C by the tail path {ut} units, by today's {ue}: {:.2}", r + 1, ut as f64 / ue as f64);
    assert!(ut <= 2 * ue, "the non-suffix row: the tail path within twice today's");
}

/// The switch from bits is the run's at the word boundary: a modulus
/// below 2^62 (at most 62 bits) is the word ring's, as the run decides by
/// value; the model calls the same function with bit counts.
#[test]
fn the_switch_from_bits_at_the_word_boundary() {
    for bits in [1u64, 2, 61, 62, 63, 64, 65, 128, 129] {
        let x = (BigInt::one() << (bits as usize - 1)) + BigInt::one();
        let word = x < (BigInt::one() << 62usize);
        assert_eq!(word, bits <= 62, "{bits} bits");
        let l = zmat::limbs(&x);
        for (r, n, kh) in [(2usize, 3usize, 0usize), (47, 48, 1), (20, 26, 1)] {
            for gb in [1u64, 2, 62, 63, 130] {
                let g = (BigInt::one() << (gb as usize - 1)) + BigInt::one();
                let gw = g < (BigInt::one() << 62usize);
                assert_eq!(route3::tail_path_bits(r, n, kh, bits, gb), tail_path(r, n, kh, l, word, zmat::limbs(&g), gw), "{bits} / {gb} bits");
            }
        }
    }
}

/// The estimate takes the path the run takes: on the switch's named
/// inputs, stage 2's column side has a "C solve" term exactly when the
/// run's column side records that phase (the tail path's back
/// substitutions).
#[test]
fn the_estimate_takes_the_runs_path() {
    let mut rg = Rng(7);
    let bar = product(&mut rg, 48, 48, 47, 16);
    let mut rg = Rng(3);
    let wide = plain(&mut rg, 8, 200, 16);
    let word = z(&[&[4, 1, 5], &[0, 1, 3]]);
    let small = z(&[&[4, 0, 2], &[0, 1, 3]]);
    for (name, a, tail) in [("the bar", &bar, true), ("wide", &wide, false), ("word, k^ = 0", &word, true), ("word, k^ = 1", &small, false)] {
        let (_, phases) = route3::record_phases(|| smith_form(a).unwrap());
        let ran = phases.iter().any(|(p, _)| p == "col: C solve");
        assert_eq!(ran, tail, "{name}: the run's path");
        // stage 2 at the run's profile, J and inverse
        let (r, is, js) = {
            let (j, i, _) = a.reduce(&sagebrush_arith::nmod::Modulus::new(sagebrush_arith::nmod::Primes::new().next().unwrap())).rref_rows();
            (i.len(), i, j)
        };
        let bj = ZMat::from_rows(is.iter().map(|&i| js.iter().map(|&j| a.get(i, j).clone()).collect()).collect());
        let (nm, delta, det) = zmat::inverse_det(&bj).unwrap();
        let jp: Vec<usize> = (0..a.cols).filter(|c| !js.contains(c)).collect();
        let q = nm.mul(&ZMat::from_rows(is.iter().map(|&i| jp.iter().map(|&j| a.get(i, j).clone()).collect()).collect()));
        let mut acc = Local::new();
        let g = route3::hnf_modulus(&q, &delta, &det, &mut acc);
        acc.flush();
        let terms = stage2_route3_terms(a, &is, &js, &nm, &delta, &det, &g, &estimate::FITTED);
        let modeled = terms.iter().any(|(t, _)| t == "col: C solve");
        assert_eq!(modeled, tail, "{name}: the estimate's path (r = {r})");
    }
}
