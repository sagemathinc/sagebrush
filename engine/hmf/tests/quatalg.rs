//! Totally definite quaternion algebras and maximal orders over real
//! quadratic fields (quatalg.rs).
//!
//! - Against Magma 2.18 as a black box (fixtures/magma-quat.m): for every
//!   field Q(sqrt d) with d <= 500 squarefree, our algebra (a, b)_F and our
//!   maximal order (fixtures/quat-orders.txt, written by
//!   `write_quat_orders` below and checked to be what the code computes):
//!   Magma finds no finite ramified place, finds the order maximal with
//!   discriminant (1), and its unit group O^x / O_F^x gives the number of
//!   units of reduced norm 1, which we count by lattice enumeration.
//! - The certificate for every field of discriminant <= 5000 (ignored:
//!   about a minute in release mode).

use sagebrush_bigint::BigInt;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::QuadField;

fn order_line(d: i64) -> (MaximalOrder, String) {
    let f = QuadField::new(d).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let h: Vec<String> = o.lattice().hnf().iter().flatten().map(|x| x.to_string()).collect();
    let line = format!("{} | {} {} | {} | {}", d, o.alg().a().a, o.alg().b().a, o.lattice().den(), h.join(" "));
    (o, line)
}

fn squarefree(d: i64) -> bool {
    (2..=d).take_while(|p| p * p <= d).all(|p| d % (p * p) != 0)
}

#[test]
#[ignore]
fn write_quat_orders() {
    let mut out = String::from("# d | a b | den | the 8 x 8 Hermite normal form h: the order is (1/den) (row span of h)\n# in the Q-basis e_m, w e_m (e = 1, i, j, k), from engine/hmf/src/quatalg.rs\n");
    for d in (2..=500).filter(|&d| squarefree(d)) {
        out += &order_line(d).1;
        out.push('\n');
    }
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/quat-orders.txt"), out).unwrap();
}

#[test]
fn orders_vs_magma() {
    let ours: Vec<&str> = include_str!("fixtures/quat-orders.txt").lines().filter(|l| !l.starts_with('#')).collect();
    let magma: Vec<&str> = include_str!("fixtures/magma-quat.txt").lines().filter(|l| !l.starts_with('#')).collect();
    assert_eq!(ours.len(), magma.len());
    assert_eq!(ours.len(), 305);
    for (l, m) in ours.iter().zip(&magma) {
        let d: i64 = l.split('|').next().unwrap().trim().parse().unwrap();
        let (o, line) = order_line(d);
        assert_eq!(&line, l, "d = {}: the order differs from the fixture", d);
        // d | finite ramified places | maximal | disc = (1) | #O^x/O_F^x | #O^1
        let p: Vec<&str> = m.split('|').map(str::trim).collect();
        assert_eq!(p[0].parse::<i64>().unwrap(), d);
        assert_eq!(&p[1..4], &["0", "true", "true"], "d = {}", d);
        let n1: usize = p[5].parse().unwrap();
        assert_eq!(o.norm_one_units().unwrap().len(), n1, "d = {}", d);
    }
}

#[test]
#[ignore]
fn certificate_up_to_5000() {
    let mut n = 0;
    for d in 2..=5000i64 {
        let Ok(f) = QuadField::new(d) else { continue };
        if f.disc > 5000 {
            continue;
        }
        // MaximalOrder::new certifies d_Z(O) = d_F^4
        let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap_or_else(|e| panic!("d = {}: {}", d, e));
        assert_eq!(o.z_discriminant(), BigInt::from(f.disc).pow(4));
        for pr in f.primes_of_bounded_norm(30).unwrap() {
            o.local_splitting(pr, 1).unwrap_or_else(|e| panic!("d = {}: {}", d, e));
        }
        n += 1;
    }
    assert_eq!(n, 1516);
}
