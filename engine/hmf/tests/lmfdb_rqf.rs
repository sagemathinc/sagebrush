//! Real quadratic fields (rqf.rs) against the LMFDB (fixtures/lmfdb-rqf.txt:
//! every real quadratic field of discriminant <= 5000, none of them with a
//! class group conditional on GRH): the class group and the narrow class
//! group (invariant factors), the fundamental unit (up to sign and
//! inversion; the LMFDB's x + y a with a = w) and the regulator log(eps).

use num_traits::Signed;
use sagebrush_bigint::BigInt;
use sagebrush_hmf::rqf::{QElt, QuadField};

fn cyc(s: &str) -> Vec<i64> {
    let mut v: Vec<i64> = s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect();
    v.sort();
    v
}

#[test]
fn real_quadratic_fields_vs_lmfdb() {
    let mut n = 0;
    for l in include_str!("fixtures/lmfdb-rqf.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').map(str::trim).collect();
        let disc: i64 = p[1].parse().unwrap();
        let f = QuadField::from_disc(disc).unwrap();
        let g = f.class_group();
        let mut ours = g.cyc.clone();
        ours.sort();
        assert_eq!((g.h(), ours), (p[2].parse::<usize>().unwrap(), cyc(p[3])), "{}: class group", p[0]);
        let mut ours = g.narrow_cyc.clone();
        ours.sort();
        assert_eq!((g.narrow_h(), ours), (p[4].parse::<usize>().unwrap(), cyc(p[5])), "{}: narrow class group", p[0]);
        assert_eq!(p[7], "f", "{}: the LMFDB's class group assumed GRH", p[0]);
        let (x, y) = p[8].strip_prefix("unit:").unwrap().trim().split_once(',').unwrap();
        let theirs = QElt { a: x.trim().parse::<BigInt>().unwrap(), b: y.trim().parse::<BigInt>().unwrap() };
        assert_eq!(f.norm(&theirs).abs(), BigInt::from(1), "{}: not a unit", p[0]);
        assert_eq!(f.normalize_unit(&theirs), g.eps, "{}: fundamental unit", p[0]);
        let reg: f64 = p[6].parse().unwrap();
        let ours = f.approx(&g.eps).ln();
        assert!((ours - reg).abs() < 1e-9 * reg.max(1.0), "{}: regulator {} vs {}", p[0], ours, reg);
        n += 1;
    }
    assert_eq!(n, 1516);
}
