use super::*;

thread_local! {
    /// Tests: the next step 4's first factor is replaced by this value, as
    /// a bug could give, to reach invariants_with's fallback.
    pub(super) static CORRUPT_STEP4: std::cell::RefCell<Option<BigInt>> = const { std::cell::RefCell::new(None) };
}

fn rng(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

fn zm(rows: usize, cols: usize, d: Vec<BigInt>) -> ZMat {
    assert_eq!(d.len(), rows * cols);
    ZMat { rows, cols, d }
}

fn rand_zmat(rows: usize, cols: usize, range: i64, s: &mut u64) -> ZMat {
    zm(rows, cols, (0..rows * cols).map(|_| BigInt::from((rng(s) % (2 * range as u64 + 1)) as i64 - range)).collect())
}

/// A unimodular n x n matrix: a product of `ops` random elementary row
/// operations (and swaps) on the identity.
fn unimodular(n: usize, ops: usize, s: &mut u64) -> ZMat {
    let mut r = ZMat::identity(n).to_rows();
    for _ in 0..ops {
        let (i, j) = ((rng(s) % n as u64) as usize, (rng(s) % n as u64) as usize);
        if i == j {
            continue;
        }
        if rng(s).is_multiple_of(5) {
            r.swap(i, j);
        } else {
            let q = BigInt::from((rng(s) % 7) as i64 - 3);
            let rj = r[j].clone();
            for (x, y) in r[i].iter_mut().zip(&rj) {
                *x += &q * y;
            }
        }
    }
    ZMat::from_rows(r)
}

/// U diag(s) V (s padded with zeros to rows x cols), with random unimodular U, V.
fn structured(rows: usize, cols: usize, s_: &[BigInt], seed: &mut u64) -> ZMat {
    let mut d = ZMat::zero(rows, cols);
    for (i, x) in s_.iter().enumerate() {
        d.d[i * cols + i] = x.clone();
    }
    unimodular(rows, 3 * rows, seed).mul(&d).mul(&unimodular(cols, 3 * cols, seed))
}

/// The invariant factors over Z by the textbook smallest-pivot elimination
/// (fine for the small matrices here): min(rows, cols) entries, zeros last.
fn reference(a: &ZMat) -> Vec<BigInt> {
    let (rows, cols) = (a.rows, a.cols);
    let mut m = a.to_rows();
    let k = rows.min(cols);
    let mut diag = vec![];
    for t in 0..k {
        loop {
            let mut best: Option<(usize, usize)> = None;
            for i in t..rows {
                for j in t..cols {
                    if !m[i][j].is_zero() && best.is_none_or(|(bi, bj)| m[i][j].abs() < m[bi][bj].abs()) {
                        best = Some((i, j));
                    }
                }
            }
            let Some((bi, bj)) = best else {
                diag.extend((t..k).map(|_| BigInt::zero()));
                return diag;
            };
            m.swap(t, bi);
            for row in m.iter_mut() {
                row.swap(t, bj);
            }
            let p = m[t][t].clone();
            let mut clean = true;
            for i in t + 1..rows {
                let q = m[i][t].div_floor(&p);
                let pr = m[t].clone();
                for (x, y) in m[i].iter_mut().zip(&pr) {
                    *x -= &q * y;
                }
                clean &= m[i][t].is_zero();
            }
            for j in t + 1..cols {
                let q = m[t][j].div_floor(&p);
                for row in m.iter_mut() {
                    let v = &row[t] * &q;
                    row[j] -= v;
                }
                clean &= m[t][j].is_zero();
            }
            if !clean {
                continue;
            }
            if let Some(i) = (t + 1..rows).find(|&i| (t + 1..cols).any(|j| !(&m[i][j] % &p).is_zero())) {
                let ri = m[i].clone();
                for (x, y) in m[t].iter_mut().zip(&ri) {
                    *x += y;
                }
                continue;
            }
            diag.push(p.abs());
            break;
        }
    }
    diag
}

fn big(x: i64) -> BigInt {
    BigInt::from(x)
}

/// smith_mod against gcd(t_i, e) from the reference, every shape.
fn check_mod(a: &ZMat, e: &BigInt) {
    let want: Vec<BigInt> = reference(a).iter().map(|t| t.gcd(e)).collect();
    assert_eq!(smith_mod(a, e), want, "{} x {} modulo {}", a.rows, a.cols, e);
}

#[test]
fn smith_mod_agrees_with_the_reference_on_every_shape() {
    let mut s = 0x1234_5678_9abc_def1u64;
    let moduli = [
        big(1),
        big(2),
        big(12),
        big(360),
        big(1 << 20),
        big(1_000_003),
        BigInt::from((1u64 << 62) - 57),
        BigInt::from(1u64 << 62),
        BigInt::from(3u64) * BigInt::from((1u64 << 62) - 57),
        BigInt::from(1u64 << 40).pow(3) * big(7),
    ];
    for (rows, cols) in [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (2, 5), (5, 2), (3, 6), (6, 3), (1, 4), (4, 1)] {
        for _ in 0..6 {
            let a = rand_zmat(rows, cols, 30, &mut s);
            for e in &moduli {
                check_mod(&a, e);
            }
        }
    }
}

#[test]
fn smith_mod_on_structured_singular_and_zero_matrices() {
    let mut s = 0x0bad_cafe_f00d_1234u64;
    let shapes: [(usize, usize, Vec<i64>); 6] = [
        (4, 4, vec![1, 2, 6, 0]),
        (4, 4, vec![2, 4, 4, 8]),
        (5, 3, vec![3, 9, 27]),
        (3, 5, vec![1, 1, 0]),
        (4, 4, vec![0, 0, 0, 0]),
        (4, 4, vec![6, 6, 6, 6]),
    ];
    for (rows, cols, inv) in shapes {
        let inv: Vec<BigInt> = inv.into_iter().map(big).collect();
        let a = structured(rows, cols, &inv, &mut s);
        assert_eq!(reference(&a), inv, "the construction");
        for e in [big(1), big(6), big(8), big(54), big(1_000_003 * 6), BigInt::from(1u64 << 62)] {
            check_mod(&a, &e);
        }
    }
}

/// Residues near 2^62 on the word path: the products need the u128.
#[test]
fn smith_mod_word_path_at_the_top_of_its_range() {
    let mut s = 0x5eed_5eed_5eed_5eedu64;
    let e = BigInt::from((1u64 << 62) - 57);
    let e2 = BigInt::from((1u64 << 62) - 1);
    for (rows, cols) in [(3, 3), (4, 4), (3, 5), (5, 3)] {
        for _ in 0..4 {
            let a = zm(rows, cols, (0..rows * cols).map(|_| BigInt::from(rng(&mut s) >> 2) - BigInt::from(1u64 << 61)).collect());
            check_mod(&a, &e);
            check_mod(&a, &e2);
        }
    }
}

fn check_square(a: &ZMat) {
    let want = reference(a);
    match invariants_square(a) {
        Some(got) => assert_eq!(got, want, "{} x {}", a.rows, a.cols),
        None => assert!(want.iter().any(|x| x.is_zero()), "nonsingular reported singular"),
    }
}

#[test]
fn invariants_of_random_and_structured_square_matrices() {
    let mut s = 0xfeed_beef_0123_4567u64;
    assert_eq!(invariants_square(&ZMat::zero(0, 0)), Some(vec![]));
    assert_eq!(invariants_square(&zm(1, 1, vec![big(-12)])), Some(vec![big(12)]));
    assert_eq!(invariants_square(&zm(1, 1, vec![big(0)])), None);
    for n in [2, 3, 4, 5, 6, 8] {
        for range in [1, 9, 1000, 1 << 30] {
            check_square(&rand_zmat(n, n, range, &mut s));
        }
    }
    // Smith-structured, with large invariants other than the last (a large e)
    let p = BigInt::from(1_000_003);
    for inv in [
        vec![big(1), big(1), big(2), big(6)],
        vec![big(2), big(2), big(2), big(2)],
        vec![p.clone(), p.clone(), p.clone(), p.pow(2)],
        vec![p.pow(3), p.pow(3), p.pow(3), p.pow(5)],
        vec![big(1), big(3), p.clone() * big(3), p.pow(4) * big(3)],
    ] {
        let a = structured(4, 4, &inv, &mut s);
        assert_eq!(invariants_square(&a), Some(inv));
    }
}

/// p I and p U (U unimodular) with a large prime p: the content p is
/// divided out first, so these are as fast as I and U.
#[test]
fn invariants_of_p_times_identity() {
    let p = BigInt::from((1u64 << 61) - 1);
    for n in [2usize, 3, 5] {
        let mut d = vec![BigInt::zero(); n * n];
        for i in 0..n {
            d[i * n + i] = p.clone();
        }
        let a = zm(n, n, d);
        assert_eq!(invariants_square(&a), Some(vec![p.clone(); n]));
    }
    let mut s = 0x3141_5926_5358_9793u64;
    for n in [4usize, 7] {
        let u = unimodular(n, 4 * n, &mut s).scale(&p);
        assert_eq!(invariants_square(&u), Some(vec![p.clone(); n]));
    }
}

/// Diagonal matrices take the gcd/lcm shortcut: against the reference,
/// with negative entries, repeated primes, and zeros (singular: None).
#[test]
fn invariants_of_diagonal_matrices() {
    let mut s = 0x1618_0339_8874_9894u64;
    let p = BigInt::from((1u64 << 61) - 1);
    let picks = [big(1), big(-2), big(3), big(4), big(-6), big(9), big(10), big(12), p.clone(), &p * big(6), big(0)];
    for n in [1usize, 2, 3, 5, 8] {
        for _ in 0..30 {
            let mut a = ZMat::zero(n, n);
            for i in 0..n {
                a.d[i * n + i] = picks[(rng(&mut s) % picks.len() as u64) as usize].clone();
            }
            assert_eq!(invariants_diagonal(&a), Some(reference(&a)), "{:?}", a.d);
            check_square(&a);
        }
    }
    assert_eq!(invariants_diagonal(&zm(2, 2, vec![big(1), big(1), big(0), big(1)])), None, "not diagonal");
}

/// Content 1 but large invariants other than the last: e >= p^2 > 2^62,
/// the big-integer path on natural data.
#[test]
fn invariants_with_a_large_e_take_the_big_path() {
    let mut s = 0x2718_2818_2845_9045u64;
    let p = BigInt::from((1u64 << 61) - 1);
    let q = BigInt::from(1_000_003);
    for inv in [vec![big(1), p.clone(), p.clone(), p.clone()], vec![big(1), big(3) * &p, big(3) * &p, big(3) * &p * &q]] {
        let a = structured(4, 4, &inv, &mut s);
        let d: BigInt = inv.iter().product();
        let (x, den) = zmat::solve(&a, &zmat::det_rhs(4)).expect("nonsingular");
        assert!(modulus_from(&d, &x, &den) >= BigInt::from(1u64 << 62), "the big path is reached");
        assert_eq!(invariants_square(&a), Some(inv));
    }
}

/// t_(n-1) = e: the invariant is 0 modulo e and must read as e.
#[test]
fn an_invariant_equal_to_e_reads_as_e() {
    let mut s = 0x7777_1111_2222_3333u64;
    let sm = BigInt::from(1_000_000_007u64);
    let big_last = BigInt::from((1u64 << 61) - 1) * &sm * big(5);
    let inv = vec![big(1), big(1), sm.clone(), big_last];
    let a = structured(4, 4, &inv, &mut s);
    let d: BigInt = inv.iter().product();
    let (x, den) = zmat::solve(&a, &zmat::det_rhs(4)).expect("nonsingular");
    let e = modulus_from(&d, &x, &den);
    assert_eq!(e, sm, "the case is reached: e = t_(n-1)");
    assert_eq!(smith_mod(&a, &e).last(), Some(&sm), "0 modulo e reads as e");
    assert_eq!(invariants_square(&a), Some(inv));
}

/// The least common denominator is reduced from the solve, not trusted;
/// a delta that does not divide d falls back to e = d; and e = d itself
/// (the classical route) gives the same factors.
#[test]
fn the_denominator_is_reduced_and_checked() {
    let mut s = 0x2468_ace0_1357_9bdfu64;
    let p = BigInt::from((1u64 << 61) - 1);
    let inv = vec![big(1), big(2), big(2) * &p, big(4) * &p * &p];
    let a = structured(4, 4, &inv, &mut s);
    let d: BigInt = inv.iter().product();
    let (x, den) = zmat::solve(&a, &zmat::det_rhs(4)).expect("nonsingular");
    let e = modulus_from(&d, &x, &den);
    // a non-reduced (N, den): the same e
    let k = big(2) * &p;
    let xk = ZMat::from_rows(x.to_rows().into_iter().map(|r| r.into_iter().map(|v| v * &k).collect()).collect());
    assert_eq!(modulus_from(&d, &xk, &(&den * &k)), e);
    // without the reduction, den k divides d but not t_n here, and e would be too small
    let delta = &den / den.gcd(&x.d.iter().fold(BigInt::zero(), |g, v| g.gcd(v)));
    let wrong = &delta * &k;
    assert!((&d % &wrong).is_zero() && !(&inv[3] % &wrong).is_zero(), "the trap is real");
    assert_ne!(invariants_with(&a, &d, &(&d / &wrong)), inv, "an unreduced denominator gives wrong factors");
    // a delta that does not divide d: the classical route
    assert_eq!(modulus_from(&d, &x, &(&den * big(7))), d);
    // e = d gives the same factors
    assert_eq!(invariants_with(&a, &d, &d), inv);
    assert_eq!(invariants_with(&a, &d, &e), inv);
}

/// A matrix large enough that det makes its own solve (n >= 40 and a large
/// Hadamard bound), against the classical route e = d.
#[test]
fn invariants_reuse_det_solve_on_large_matrices() {
    let mut s = 0x9999_8888_7777_6666u64;
    let n = 44;
    let a = rand_zmat(n, n, 1 << 20, &mut s);
    let (det, solved) = zmat::det_with_solve(&a);
    assert!(solved.is_some(), "det made a solve");
    let d = det.abs();
    let got = invariants_square(&a).expect("nonsingular");
    assert_eq!(got, invariants_with(&a, &d, &d));
    assert_eq!(got.iter().product::<BigInt>(), d);
    assert!(got.windows(2).all(|w| (&w[1] % &w[0]).is_zero()), "each divides the next");
}

/// A step 4 whose factors do not multiply into d (only a bug could give
/// that) is caught: the classical route e = d gives the right factors, in
/// release and in debug builds alike, instead of a trap.
#[test]
fn a_failed_check_falls_back_to_e_equals_d() {
    let mut s = 0x6a09_e667_f3bc_c908u64;
    let inv = vec![big(1), big(2), big(6), big(12)];
    let a = structured(4, 4, &inv, &mut s);
    let d: BigInt = inv.iter().product();
    // a factor that does not divide d, a zero one (the division must not
    // be reached) and a negative one
    for bad in [&d + big(1), big(0), big(-2)] {
        CORRUPT_STEP4.with(|c| *c.borrow_mut() = Some(bad.clone()));
        let got = invariants_with(&a, &d, &big(12));
        assert!(CORRUPT_STEP4.with(|c| c.borrow().is_none()), "the hook was reached ({bad})");
        assert_eq!(got, inv, "corrupted to {bad}");
    }
}

/// gcd_cofactor_e: g = gcd(x, e) and s x = g (mod e), s not always a unit;
/// its charge pinned on both rings (word: the quotient steps into
/// `steps`; big: the gcd and the cofactor's reduction, counted by the
/// ring).
#[test]
fn gcd_cofactor_e_values_and_units() {
    let w = Word { e: 1000 };
    let mut steps = 0;
    let (g, s) = w.gcd_cofactor_e(&378, &mut steps);
    assert_eq!((g, s * 378 % 1000), (big(2), 2));
    // (1000, 378) -> (378, 244) -> .. -> (2, 0): 9 quotient steps
    assert_eq!(steps, 9, "the word path's steps");
    let (g, s) = w.gcd_cofactor_e(&0, &mut steps);
    assert_eq!((g, s, steps), (big(1000), 0, 9), "x = 0: e, no step");
    assert_eq!(w.take(), [0; FAMILIES]);
    let e = (BigInt::from(1u64) << 300usize) * big(3);
    let b = Big::new(&e);
    let x = BigInt::from(6u64) << 120usize;
    let mut none = 0;
    let (g, s) = b.gcd_cofactor_e(&x, &mut none);
    assert_eq!(g, BigInt::from(3u64) << 121usize);
    assert_eq!((&s * &x).mod_floor(&e), g);
    assert_eq!(none, 0, "the big path counts its own");
    // (the extended gcd at e's and x's limbs with the check on its
    // coefficients, the cofactor's reduction modulo e)
    let pin = [20, 0, 40, 0, 32, 0, 0, 7, 0, 0];
    let (le, lx) = (limbs(&e), limbs(&x));
    let mut want = crate::cost::bigxgcd_units(le, lx, limbs(&g));
    want.add(&bigdiv_units(2 * le, le));
    assert_eq!((b.take(), want.0), (pin, pin), "the big path's charge");
    assert_eq!(b.take(), [0; FAMILIES], "taken");
    // x = 0: e and 0, no gcd and no reduction run; e's copy (Move, its
    // limbs)
    assert_eq!(b.gcd_cofactor_e(&BigInt::zero(), &mut none), (e.clone(), BigInt::zero()));
    assert_eq!(le, 5);
    assert_eq!(b.take(), [0, 0, 0, 0, 0, 5, 0, 0, 0, 0], "x = 0's charge");
}
