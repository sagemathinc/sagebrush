//! Hecke operators against PSAGE's docstrings (sqrt5_fast.pyx
//! IcosiansModP1ModN.hecke_matrix and _hecke_matrix_badnorm; sqrt5.py, the
//! levels 31, 41 and 389). Orbits are numbered differently (they depend on
//! the splitting), so characteristic polynomials are compared.

use sagebrush_arith::zmat::{charpoly, ZMat};
use sagebrush_bigint::BigInt;
use sagebrush_hmf::field::{primes_above, Elt, Prime};
use sagebrush_hmf::Space;

/// det(x - T), constant term first.
pub fn charpoly_i(t: &[Vec<i64>]) -> Vec<i128> {
    let rows: Vec<Vec<BigInt>> = t.iter().map(|r| r.iter().map(|&x| BigInt::from(x)).collect()).collect();
    charpoly(&ZMat::from_rows(rows)).iter().map(|c| i128::try_from(c).unwrap()).collect()
}

/// The product of factors given highest degree first, with multiplicity.
pub fn product(factors: &[(&[i128], u32)]) -> Vec<i128> {
    let mut r = vec![1i128];
    for (f, e) in factors {
        let f: Vec<i128> = f.iter().rev().cloned().collect();
        for _ in 0..*e {
            let mut s = vec![0i128; r.len() + f.len() - 1];
            for (i, a) in r.iter().enumerate() {
                for (j, b) in f.iter().enumerate() {
                    s[i + j] += a * b;
                }
            }
            r = s;
        }
    }
    r
}

fn p(norm: u64) -> Vec<Prime> {
    let mut v: Vec<Prime> = sagebrush_hmf::field::primes_of_bounded_norm(norm).into_iter().filter(|q| q.norm == norm).collect();
    v.sort();
    v
}

fn cp(level: Elt, q: &Prime) -> Vec<i128> {
    let s = Space::new(level).unwrap();
    let t = s.hecke_matrix(q).unwrap().dense();
    for row in &t {
        assert_eq!(row.iter().sum::<i64>() as u64, q.norm + 1);
    }
    charpoly_i(&t)
}

#[test]
fn level_31() {
    let n = Elt::new(-2, 5); // F.prime_above(31) = 5a - 2
    assert_eq!(cp(n, &p(4)[0]), product(&[(&[1, -5], 1), (&[1, 3], 1)]));
    assert_eq!(cp(n, &p(9)[0]), product(&[(&[1, -10], 1), (&[1, -2], 1)]));
    assert_eq!(cp(n, &p(5)[0]), product(&[(&[1, -6], 1), (&[1, 2], 1)]));
    // the other prime above 31 (PSAGE's t31; its norm divides N(N))
    let other = primes_above(31).into_iter().find(|q| !q.contains(n)).unwrap();
    assert_eq!(cp(n, &other), product(&[(&[1, -32], 1), (&[1, -8], 1)]));
    // sqrt5.py: T at the primes of norm 11 and 19, as a multiset
    let mut got: Vec<_> = p(11).iter().map(|q| cp(n, q)).collect();
    let mut want = vec![product(&[(&[1, -12], 1), (&[1, 4], 1)]), product(&[(&[1, -12], 1), (&[1, -4], 1)])];
    got.sort();
    want.sort();
    assert_eq!(got, want);
    let mut got: Vec<_> = p(19).iter().map(|q| cp(n, q)).collect();
    let mut want = vec![product(&[(&[1, -20], 1), (&[1, -4], 1)]), product(&[(&[1, -20], 1), (&[1, 4], 1)])];
    got.sort();
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn level_41() {
    // sqrt5.py: c = F.primes_above(41)[0]; both primes above 41 are
    // conjugate, so either gives the same multiset of charpolys.
    for n in primes_above(41) {
        let n = n.gen;
        assert_eq!(cp(n, &p(5)[0]), product(&[(&[1, -6], 1), (&[1, 1], 1)]));
        assert_eq!(cp(n, &p(9)[0]), product(&[(&[1, -10], 1), (&[1, 4], 1)]));
        let mut got: Vec<_> = p(11).iter().map(|q| cp(n, q)).collect();
        let mut want = vec![product(&[(&[1, -12], 1), (&[1, -5], 1)]), product(&[(&[1, -12], 1), (&[1, 2], 1)])];
        got.sort();
        want.sort();
        assert_eq!(got, want);
    }
}

#[test]
fn level_389() {
    let n = Elt::new(-5, 18); // F.prime_above(389) = 18a - 5
    assert_eq!(cp(n, &p(4)[0]), product(&[(&[1, -5], 1), (&[1, 5, 5], 1), (&[1, -3, -3, 10, -4], 1)]));
    assert_eq!(cp(n, &p(9)[0]), product(&[(&[1, -10], 1), (&[1, 3, -9], 1), (&[1, -5, 3, 6, -4], 1)]));
    assert_eq!(cp(n, &p(5)[0]), product(&[(&[1, -6], 1), (&[1, 4, -1], 1), (&[1, -1, -4], 2)]));
    let mut got: Vec<_> = p(11).iter().map(|q| cp(n, q)).collect();
    let mut want = vec![
        product(&[(&[1, -12], 1), (&[1, 3], 2), (&[1, 0, -17, 0, 68], 1)]),
        product(&[(&[1, -12], 1), (&[1, 5, 5], 1), (&[1, -1, -23, 18, 52], 1)]),
    ];
    got.sort();
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn bad_norm_71_and_809() {
    // _hecke_matrix_badnorm: level one prime above 71, T at the other
    let v = primes_above(71);
    assert_eq!(cp(v[0].gen, &v[1]), product(&[(&[1, -72], 1), (&[1, -6], 1)]));
    assert_eq!(cp(v[1].gen, &v[0]), product(&[(&[1, -72], 1), (&[1, -6], 1)]));
    // level (-26a + 7) of norm 809, T at the other prime above 809
    let n = Elt::new(7, -26);
    let other = primes_above(809).into_iter().find(|q| !q.contains(n)).unwrap();
    assert_eq!(
        cp(n, &other),
        product(&[
            (&[1, -810], 1),
            (&[1, 46], 1),
            (&[1, -48, -1645, 65758, 617743], 1),
            (&[1, 52, -2667, -118268, 2625509, 55326056, -1208759312, 4911732368, -4279699152], 1),
        ])
    );
}

/// hecke_row (PSAGE's hecke_operator_on_basis_element) is the row of the
/// matrix.
#[test]
fn single_rows() {
    let s = Space::new(Elt::new(-5, 18)).unwrap();
    for q in sagebrush_hmf::field::primes_of_bounded_norm(50) {
        let t = s.hecke_matrix(&q).unwrap();
        for i in 0..s.dimension() {
            assert_eq!(s.hecke_row(&q, i).unwrap(), t.rows[i]);
        }
    }
}

#[test]
fn hecke_operators_commute() {
    // PSAGE tests.py test_hecke_commutes, for every level of norm <= 300
    // and the two smallest primes not dividing the level
    for n in sagebrush_hmf::field::ideals_of_bounded_norm(300) {
        let s = Space::from_ideal(n.clone()).unwrap();
        let ps: Vec<Prime> = sagebrush_hmf::field::primes_of_bounded_norm(60).into_iter().filter(|q| n.factors.iter().all(|(r, _)| r != q)).take(3).collect();
        let ts: Vec<Vec<Vec<i64>>> = ps.iter().map(|q| s.hecke_matrix(q).unwrap().dense()).collect();
        let mul = |a: &Vec<Vec<i64>>, b: &Vec<Vec<i64>>| -> Vec<Vec<i64>> {
            let d = a.len();
            (0..d).map(|i| (0..d).map(|j| (0..d).map(|k| a[i][k] * b[k][j]).sum()).collect()).collect()
        };
        for i in 0..ts.len() {
            for j in 0..i {
                assert_eq!(mul(&ts[i], &ts[j]), mul(&ts[j], &ts[i]), "level {} T_{} T_{}", n.gen, ps[i].gen, ps[j].gen);
            }
        }
    }
}
