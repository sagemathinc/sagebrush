use super::*;
use crate::zmat;
use num_traits::One;

fn z(rows: &[&[i64]]) -> ZMat {
    let n = rows.first().map_or(0, |r| r.len());
    ZMat { rows: rows.len(), cols: n, d: rows.iter().flat_map(|r| r.iter().map(|&x| BigInt::from(x))).collect() }
}

fn rows_of(m: &ZMat) -> Vec<Vec<i64>> {
    (0..m.rows).map(|i| (0..m.cols).map(|j| num_traits::ToPrimitive::to_i64(m.get(i, j)).unwrap()).collect()).collect()
}

/// U A V = D exactly, U and V unimodular, D diagonal with nonnegative
/// entries t_1 | t_2 | ... (zeros last).
pub(crate) fn assert_smith(a: &ZMat, s: &SmithForm) {
    let (m, n) = (a.rows, a.cols);
    assert_eq!((s.u.rows, s.u.cols, s.v.rows, s.v.cols, s.d.rows, s.d.cols), (m, m, n, n, m, n));
    let uav = s.u.mul(a).mul(&s.v);
    assert_eq!(uav.d, s.d.d, "U A V = D");
    for (k, x) in [&s.u, &s.v].iter().enumerate() {
        if x.rows > 0 {
            assert!(zmat::det(x).abs().is_one(), "transform {k} unimodular");
        }
    }
    let diag: Vec<BigInt> = (0..m.min(n)).map(|i| s.d.get(i, i).clone()).collect();
    for i in 0..m {
        for j in 0..n {
            if i != j {
                assert!(s.d.get(i, j).is_zero(), "D diagonal");
            }
        }
    }
    for w in diag.windows(2) {
        assert!(!w[0].is_negative() && !w[1].is_negative());
        if w[0].is_zero() {
            assert!(w[1].is_zero(), "zeros last");
        } else {
            assert!(w[1].is_multiple_of(&w[0]), "t_i | t_(i+1)");
        }
    }
}

/// The port gives the Python elimination's own (D, U, V), entry for entry
/// (reference outputs from the algorithm of lib/_sage_matrix.py's
/// _smith_uv, run on the same inputs).
#[test]
fn classical_matches_the_python_elimination() {
    type Case = (&'static [&'static [i64]], &'static [&'static [i64]], &'static [&'static [i64]], &'static [&'static [i64]]);
    let cases: &[Case] = &[
        (&[&[2, 4], &[6, 8]], &[&[2, 0], &[0, 4]], &[&[1, 0], &[3, -1]], &[&[1, -2], &[0, 1]]),
        (
            &[&[-3, 5, 7], &[2, -4, 6], &[9, 1, -2]],
            &[&[1, 0, 0], &[0, 1, 0], &[0, 0, 550]],
            &[&[0, 0, 1], &[-1, -9, -31], &[2, 17, 58]],
            &[&[0, 0, 1], &[1, 2, 579], &[0, 1, 294]],
        ),
        (
            &[&[1, 2, 3], &[2, 4, 6], &[1, 0, 1]],
            &[&[1, 0, 0], &[0, 2, 0], &[0, 0, 0]],
            &[&[1, 0, 0], &[1, 0, -1], &[-2, 1, 0]],
            &[&[1, -2, -1], &[0, 1, -1], &[0, 0, 1]],
        ),
        (
            &[&[4, 6], &[10, 15], &[2, 3], &[8, 1]],
            &[&[1, 0], &[0, 22], &[0, 0], &[0, 0]],
            &[&[0, 0, 0, 1], &[0, 0, -1, 3], &[0, 1, -5, 0], &[1, 0, -2, 0]],
            &[&[0, 1], &[1, -8]],
        ),
        (&[&[6, 10, 15], &[4, 8, 12]], &[&[1, 0, 0], &[0, 4, 0]], &[&[1, -1], &[-8, 9]], &[&[-1, -1, 0], &[0, 1, 3], &[1, 0, -2]]),
        (&[&[0, 0], &[0, 0]], &[&[0, 0], &[0, 0]], &[&[1, 0], &[0, 1]], &[&[1, 0], &[0, 1]]),
    ];
    for (a, d, u, v) in cases {
        let a = z(a);
        let s = smith_classical(&a);
        assert_smith(&a, &s);
        assert_eq!(rows_of(&s.d), d.iter().map(|r| r.to_vec()).collect::<Vec<_>>());
        assert_eq!(rows_of(&s.u), u.iter().map(|r| r.to_vec()).collect::<Vec<_>>());
        assert_eq!(rows_of(&s.v), v.iter().map(|r| r.to_vec()).collect::<Vec<_>>());
    }
}

#[test]
fn classical_edge_shapes() {
    for a in [ZMat::zero(0, 0), ZMat::zero(0, 3), ZMat::zero(2, 0), z(&[&[-7]]), z(&[&[0]])] {
        let s = smith_classical(&a);
        assert_eq!((s.u.rows, s.v.rows), (a.rows, a.cols));
        if a.rows > 0 && a.cols > 0 {
            assert_smith(&a, &s);
        }
    }
    assert_eq!(smith_classical(&z(&[&[-7]])).d.d, vec![BigInt::from(7)]);
}

fn pm(b: u64, e: u64) -> i64 {
    let (mut r, mut b, mut e) = (1u128, b as u128, e);
    while e > 0 {
        if e & 1 == 1 {
            r = r * b % 1_000_003;
        }
        b = b * b % 1_000_003;
        e >>= 1;
    }
    r as i64
}

/// The bench's input: entry (i, j) = (i + 2 + v)^(j + 3) mod 1000003 - 500001.
pub(crate) fn bench(n: usize, v: u64) -> ZMat {
    ZMat { rows: n, cols: n, d: (0..n * n).map(|k| BigInt::from(pm((k / n) as u64 + 2 + v, (k % n) as u64 + 3) - 500_001)).collect() }
}

pub(crate) fn rand(n: usize, seed: u64) -> ZMat {
    let mut s = seed | 1;
    ZMat {
        rows: n,
        cols: n,
        d: (0..n * n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                BigInt::from((s % 2001) as i64 - 1000)
            })
            .collect(),
    }
}

#[test]
fn route_one_is_exact_on_cyclic_inputs() {
    // (k = 1 at these: bench n = 12 v = 3, n = 24 v = 0; random 10, 16
    // (6 attempts) and 20 (the first attempt, r = 0))
    for a in [bench(12, 3), bench(24, 0), rand(10, 3), rand(16, 6), rand(20, 9)] {
        let s = smith_form(&a).unwrap();
        assert_eq!(s.route, Route::Cyclic);
        assert!(s.attempts >= 1);
        assert_smith(&a, &s);
        assert_eq!(s.d.get(a.rows - 1, a.rows - 1), &zmat::det(&a).abs());
    }
}

#[test]
fn route_one_edge_cases() {
    // n = 1, negative
    let a = z(&[&[-7]]);
    let s = smith_form(&a).unwrap();
    assert_eq!((s.route, s.d.d.clone()), (Route::Cyclic, vec![BigInt::from(7)]));
    assert_smith(&a, &s);
    // unimodular (k = 0): D = I and U = a^-1
    let a = z(&[&[2, 3, 1], &[1, 2, 1], &[0, 0, 1]]);
    assert!(zmat::det(&a).abs().is_one());
    let s = smith_form(&a).unwrap();
    assert_eq!(s.route, Route::Cyclic);
    assert_smith(&a, &s);
    assert_eq!(s.d.d, ZMat::identity(3).d);
    // k = 2 (bench n = 12 v = 0) and k = 3 (random 16): not this route,
    // still exact
    for a in [bench(12, 0), rand(16, 5)] {
        let s = smith_form(&a).unwrap();
        assert_ne!(s.route, Route::Cyclic);
        assert_smith(&a, &s);
    }
}

#[test]
fn route_one_is_deterministic() {
    let a = rand(14, 7);
    let (s, t) = (smith_form(&a).unwrap(), smith_form(&a).unwrap());
    assert_eq!((s.u.d, s.v.d, s.attempts), (t.u.d, t.v.d, t.attempts));
}

/// U0 diag(s) V0 with unimodular U0, V0 (products of elementary
/// operations): a matrix with chosen invariant factors.
pub(crate) fn structured(s: &[i64], seed: u64) -> ZMat {
    let n = s.len();
    let mut st = seed | 1;
    let mut next = || {
        st ^= st << 13;
        st ^= st >> 7;
        st ^= st << 17;
        st
    };
    let mut uni = || -> ZMat {
        let mut r: Vec<Vec<BigInt>> = (0..n).map(|i| (0..n).map(|j| BigInt::from((i == j) as u8)).collect()).collect();
        for _ in 0..4 * n {
            let (i, j) = ((next() % n as u64) as usize, (next() % n as u64) as usize);
            if i != j {
                let q = BigInt::from((next() % 7) as i64 - 3);
                let rj = r[j].clone();
                for (x, y) in r[i].iter_mut().zip(&rj) {
                    *x += &q * y;
                }
            }
        }
        to_zmat(r, n)
    };
    let mut d = ZMat::zero(n, n);
    for (i, &x) in s.iter().enumerate() {
        d.d[i * n + i] = BigInt::from(x);
    }
    let (u, v) = (uni(), uni());
    u.mul(&d).mul(&v)
}

#[test]
fn route_two_is_exact() {
    // k = 2: bench n = 12 v = 0 and n = 24 v = 2; k = 3: random 16
    for a in [bench(12, 0), bench(24, 2), rand(16, 5)] {
        let s = smith_form(&a).unwrap();
        assert_eq!(s.route, Route::Trailing);
        assert_smith(&a, &s);
        assert_eq!((0..a.rows).map(|i| s.d.get(i, i).clone()).collect::<Vec<_>>(), crate::snf::invariants_square(&a).unwrap());
    }
    // chosen invariants: k = 4 with repeated primes, k = n (3 I), a big e
    let big = BigInt::from(1u64 << 40) * BigInt::from(1_000_003) * BigInt::from(97);
    for (a, want) in [
        (structured(&[1, 1, 2, 6, 12, 36], 3), vec![1, 1, 2, 6, 12, 36]),
        (structured(&[3, 3, 3, 3, 3], 5), vec![3, 3, 3, 3, 3]),
    ] {
        let s = smith_form(&a).unwrap();
        assert_eq!(s.route, Route::Trailing);
        assert_smith(&a, &s);
        assert_eq!((0..a.rows).map(|i| s.d.get(i, i).clone()).collect::<Vec<_>>(), want.into_iter().map(BigInt::from).collect::<Vec<_>>());
    }
    let mut a = structured(&[1, 1, 1, 2, 2], 7);
    // (scale the last invariant to a multi-limb one: a's last row times big)
    for j in 0..a.cols {
        let x = a.get(4, j) * &big;
        a.d[4 * a.cols + j] = x;
    }
    let s = smith_form(&a).unwrap();
    assert_eq!(s.route, Route::Trailing);
    assert_smith(&a, &s);
    assert_eq!((0..a.rows).map(|i| s.d.get(i, i).clone()).collect::<Vec<_>>(), crate::snf::invariants_square(&a).unwrap());
    assert!(s.d.get(4, 4).bits() > 64, "a multi-limb delta");
}

#[test]
fn more_than_k_max_takes_the_classical_route() {
    let s: Vec<i64> = (0..K_MAX + 1).map(|_| 2).collect();
    let a = structured(&s, 11);
    let f = smith_form(&a).unwrap();
    assert_eq!(f.route, Route::Classical);
    assert_smith(&a, &f);
    assert!((0..a.rows).all(|i| f.d.get(i, i) == &BigInt::from(2)));
}

#[test]
fn route_two_is_deterministic() {
    let a = bench(12, 1);
    let (s, t) = (smith_form(&a).unwrap(), smith_form(&a).unwrap());
    assert_eq!((s.route, s.u.d, s.v.d, s.attempts), (t.route, t.u.d, t.v.d, t.attempts));
}

/// Route 1's ranges grow: a = [[3, 8], [6, 1]] (det -45, D = diag(1, 45))
/// has y = r N_1 + N_2 non-generating at r = 0 (zero mod 3) and at r = 1
/// (zero mod 5), so attempts 0 and 1, whose range is {0, 1}, fail whatever
/// they draw; success needs attempt 2's range [0, 4) (r = 2; r = 3 is zero
/// mod 3 again).
#[test]
fn route_one_ranges_grow_past_a_covered_box() {
    let a = z(&[&[3, 8], &[6, 1]]);
    let s = smith_form(&a).unwrap();
    assert_eq!(s.route, Route::Cyclic);
    assert!(s.attempts >= 3, "attempts {}", s.attempts);
    assert_smith(&a, &s);
    assert_eq!(s.d.d, vec![BigInt::from(1), BigInt::zero(), BigInt::zero(), BigInt::from(45)]);
}

#[test]
fn the_floor_is_checked() {
    assert_eq!(floor_bytes(0, 0), Some(0));
    assert_eq!(floor_bytes(2, 3), Some(8 * (4 + 9 + 6)));
    assert_eq!(floor_bytes(1 << 20, 1 << 20), Some(8 * 3 * (1u64 << 40)));
    assert_eq!(floor_bytes(usize::MAX, 1), None);
    assert_eq!(floor_bytes(usize::MAX, usize::MAX), None);
}

fn digest(s: &SmithForm) -> u64 {
    let mut h = 17u64;
    for x in s.u.d.iter().chain(&s.v.d) {
        for b in x.to_string().bytes().chain(*b",") {
            h = (h.wrapping_mul(1_000_003) ^ b as u64) % ((1 << 61) - 1);
        }
    }
    h ^ s.attempts
}

/// The transforms and attempts are pinned, the same on every target (a
/// fixed portable sequence of preconditionings): these pins hold natively
/// and under wasm32-wasip1.
#[test]
fn outputs_are_pinned() {
    let got: Vec<(Route, u64, u64)> = [bench(12, 3), bench(12, 0), z(&[&[3, 8], &[6, 1]]), z(&[&[1, 2, 3], &[2, 4, 6], &[1, 0, 1]])]
        .iter()
        .map(|a| {
            let s = smith_form(a).unwrap();
            (s.route, s.attempts, digest(&s))
        })
        .collect();
    let want: Vec<(Route, u64, u64)> = vec![
        (Route::Cyclic, 2, 1276465326252702338),
        (Route::Trailing, 5, 767491620189235518),
        (Route::Cyclic, 3, 2239573289118338536),
        (Route::Classical, 0, 2007014360717136981),
    ];
    assert_eq!(got, want);
}

/// The small Smith form of route 2's relations: d_1 | .. | d_k | delta, V
/// unimodular with V V^-1 = I, L V in D Z^k for the generators and delta
/// Z^k, the invariants those of the classical elimination of [rel; delta
/// I], and the transforms within the proved bound (asserted here, in
/// release builds too, up to k = 8); word and big delta.
#[test]
fn the_small_smith_form_is_exact_and_bounded() {
    let mut s: u64 = 0x2545f4914f6cdd1d;
    let mut next = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let deltas: Vec<BigInt> = vec![
        BigInt::from(12),
        BigInt::from(2 * 3 * 5 * 7 * 11 * 13),
        BigInt::from(1u64 << 40) * BigInt::from(9),
        // big delta: (2^61 - 1) * 2^70 * 45
        (BigInt::from((1u64 << 61) - 1) << 70usize) * BigInt::from(45),
    ];
    for delta in &deltas {
        for k in 1..=8usize {
            for _ in 0..6 {
                let mut rel = ZMat::zero(k, k);
                for x in rel.d.iter_mut() {
                    // small primes' multiples often: nontrivial invariants
                    let r = BigInt::from(next() >> 3);
                    let f = [1u64, 2, 3, 4, 6, 9][(next() % 6) as usize];
                    *x = (r * BigInt::from(f)).mod_floor(delta);
                }
                let (d, v, vinv) = small_smith_route(&rel, delta);
                assert_eq!(v.mul(&vinv).d, ZMat::identity(k).d, "V V^-1 = I");
                assert!(zmat::det(&v).abs().is_one(), "V unimodular");
                for w in d.windows(2) {
                    assert!(w[1].is_multiple_of(&w[0]), "d_i | d_(i+1)");
                }
                assert!(delta.is_multiple_of(d.last().unwrap()), "d_k | delta");
                // the generators and delta e_i map into D Z^k
                let lv = rel.mul(&v);
                for i in 0..k {
                    for j in 0..k {
                        assert!(lv.get(i, j).is_multiple_of(&d[j]), "generator {i} column {j}");
                        assert!((delta * v.get(i, j)).is_multiple_of(&d[j]), "delta e_{i} column {j}");
                    }
                }
                // the invariants: the classical elimination of [rel; delta I]
                let mut m = ZMat::zero(2 * k, k);
                for i in 0..k {
                    for j in 0..k {
                        m.d[i * k + j] = rel.get(i, j).clone();
                    }
                    m.d[(k + i) * k + i] = delta.clone();
                }
                let c = smith_classical(&m);
                let want: Vec<BigInt> = (0..k).map(|i| c.d.get(i, i).clone()).collect();
                assert_eq!(d, want, "invariants, delta {delta}, k {k}");
                // the bound: 3 (k - 1) (bits(delta) + 1) + 2 bits(k) + 2
                let kb = (usize::BITS - k.leading_zeros()) as u64;
                let bound = 3 * (k as u64 - 1) * (delta.bits() + 1) + 2 * kb + 2;
                assert!(v.max_bits() <= bound && vinv.max_bits() <= bound, "bounded transforms");
            }
        }
    }
}

/// The exact transform's growth guard: on this lattice (found by a search
/// over 120,000 random ones, the only such) the elimination's own exact
/// transform passes the proved bound, so its tracking is dropped and the
/// construction is returned, valid and within the bound.  (Without the
/// guard the exact pair would be kept to the end and lose on size.)
#[test]
fn the_exact_transform_is_dropped_past_the_bound() {
    let delta = BigInt::from((1u64 << 61) - 2);
    let rel = ZMat::from_rows(
        [
            ["51039702996356152", "312", "44696181706988778"],
            ["584", "888", "534702549680384832"],
            ["2305843009213693945", "604", "2305843009213693901"],
        ]
        .iter()
        .map(|r| r.iter().map(|x| x.parse::<BigInt>().unwrap()).collect())
        .collect(),
    );
    let (d, v, vinv, pick) = small_smith_pick(&rel, &delta);
    assert_eq!(pick, Pick::Dropped, "the exact transform passed the bound and was dropped");
    assert_eq!(v.mul(&vinv).d, ZMat::identity(3).d);
    let lv = rel.mul(&v);
    for i in 0..3 {
        for j in 0..3 {
            assert!(lv.get(i, j).is_multiple_of(&d[j]));
        }
    }
    let bound = 3 * 2 * (delta.bits() + 1) + 2 * 2 + 2;
    assert!(v.max_bits() <= bound && vinv.max_bits() <= bound);
}
