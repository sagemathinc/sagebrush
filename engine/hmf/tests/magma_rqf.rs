//! Real quadratic fields (rqf.rs) against Magma 2.18 as a black box
//! (fixtures/magma-rqf.m): for 18 fields with nontrivial class group or
//! narrow class group, the orders of the classes of all primes of norm
//! <= 100 in the class group and in the narrow class group (orders do not
//! depend on how the groups are identified).

use sagebrush_hmf::rqf::{QElt, QuadField};

#[test]
fn class_orders_vs_magma() {
    let mut n = 0;
    let mut fields = std::collections::HashMap::new();
    for l in include_str!("fixtures/magma-rqf.txt").lines().filter(|l| !l.starts_with('#')) {
        let p: Vec<&str> = l.split('|').map(str::trim).collect();
        let d: i64 = p[0].parse().unwrap();
        let (f, g) = fields.entry(d).or_insert_with(|| {
            let f = QuadField::new(d).unwrap();
            let g = f.class_group();
            (f, g)
        });
        let q: i64 = p[1].parse().unwrap();
        let xy: Vec<i64> = p[2].split_whitespace().map(|x| x.parse().unwrap()).collect();
        let ideal = f.ideal(&[QElt::int(q), QElt::new(xy[0], xy[1])]).unwrap();
        assert!(f.primes_above(q).iter().any(|pr| pr.ideal == ideal), "d = {}: ({}, {} + {}w) is not a prime", d, q, xy[0], xy[1]);
        let (o, op): (usize, usize) = (p[3].parse().unwrap(), p[4].parse().unwrap());
        assert_eq!((g.class_order(&ideal, false), g.class_order(&ideal, true)), (o, op), "d = {}, P = ({}, {} + {}w)", d, q, xy[0], xy[1]);
        n += 1;
    }
    assert_eq!(n, 439);
}
