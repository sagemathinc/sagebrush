//! Exact characteristic polynomials against Sage: fixtures/sage_charpolys.txt
//! (regenerate with `sage fixtures/make_sage_charpolys.sage`).

use sagebrush_modsym::exact::exact_charpoly;
use sagebrush_bigint::BigInt;

#[test]
fn exact_charpolys_match_sage() {
    let mut cases = 0;
    for line in include_str!("fixtures/sage_charpolys.txt").lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        let (n, q): (u64, u64) = (w[0].parse().unwrap(), w[1].parse().unwrap());
        let sage: Vec<BigInt> = w[2..].iter().map(|c| c.parse().unwrap()).collect();
        let e = exact_charpoly(n, q).unwrap();
        assert_eq!(e.status, "proven", "N={} q={}: {:?}", n, q, e.checks);
        assert_eq!(e.coeffs, sage, "N={} q={}", n, q);
        cases += 1;
    }
    assert_eq!(cases, 24);
}
