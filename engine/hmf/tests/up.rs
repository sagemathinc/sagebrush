//! U_P for primes P dividing the level: rows sum to N(P), and U_P commutes
//! with T_Q and with U_P' (the Hecke algebra is commutative).

use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm, Prime};
use sagebrush_hmf::Space;

fn mul(a: &[Vec<i64>], b: &[Vec<i64>]) -> Vec<Vec<i64>> {
    let d = a.len();
    (0..d).map(|i| (0..d).map(|j| (0..d).map(|k| a[i][k] * b[k][j]).sum()).collect()).collect()
}

#[test]
fn up_row_sums_and_commutation() {
    let mut checked = 0;
    for n in ideals_of_bounded_norm(400) {
        if n.is_one() {
            continue;
        }
        let s = Space::from_ideal(n.clone()).unwrap();
        let bad: Vec<Prime> = n.factors.iter().map(|(p, _)| *p).collect();
        let good: Vec<Prime> = primes_of_bounded_norm(30).into_iter().filter(|p| !bad.contains(p)).take(2).collect();
        let ups: Vec<Vec<Vec<i64>>> = bad
            .iter()
            .map(|p| {
                let t = s.hecke_matrix(p).unwrap();
                for row in &t.rows {
                    assert_eq!(row.iter().map(|&(_, c)| c as u64).sum::<u64>(), p.norm, "row sums of U_P at level {}", n.gen);
                }
                t.dense()
            })
            .collect();
        let ts: Vec<Vec<Vec<i64>>> = good.iter().map(|p| s.hecke_matrix(p).unwrap().dense()).collect();
        for (k, u) in ups.iter().enumerate() {
            for t in &ts {
                assert_eq!(mul(u, t), mul(t, u), "U_{} and T_q at level {}", bad[k].gen, n.gen);
            }
            for u2 in &ups[..k] {
                assert_eq!(mul(u, u2), mul(u2, u), "U_P and U_P' at level {}", n.gen);
            }
            checked += 1;
        }
    }
    assert!(checked > 150);
}
