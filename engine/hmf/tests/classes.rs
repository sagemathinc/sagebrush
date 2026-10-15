//! Right ideal classes of maximal orders over real quadratic fields
//! (classes.rs).
//!
//! - Against Magma 2.18 as a black box (fixtures/magma-classes.m): for our
//!   maximal order O over each Q(sqrt d), d <= 200 squarefree (121 fields;
//!   the orders of fixtures/quat-orders.txt), the class number
//!   H = #RightIdealClasses(O) and the multiset of the unit indices
//!   #UnitGroup(LeftOrder(I)) = [O_L(I)^x : O_F^x] over the classes. The
//!   fields with d <= 60 run by default; `classes_vs_magma_all` runs all.
//! - Dembélé-Voight, "Explicit methods for Hilbert modular forms" (2013),
//!   Example 8.6: over Q(sqrt 106) (h = h+ = 2), dim S_2(1) = 50. With
//!   M_2(1) the functions on Cl O and its Eisenstein part of dimension h+,
//!   that is H = 52.
//! - The weights sum to the mass exactly (it is how the enumeration stops).

use sagebrush_bigint::BigInt;
use sagebrush_hmf::classes::{ClassSet, Rat};
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::QuadField;

fn class_set(d: i64) -> ClassSet {
    let f = QuadField::new(d).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    ClassSet::new(&o).unwrap_or_else(|e| panic!("d = {}: {}", d, e))
}

fn check(limit: i64) -> usize {
    let mut n = 0;
    for l in include_str!("fixtures/magma-classes.txt").lines().filter(|l| !l.starts_with('#')) {
        // d | H | [w_1, ..., w_H] | t
        let p: Vec<&str> = l.split('|').map(str::trim).collect();
        let d: i64 = p[0].parse().unwrap();
        if d > limit {
            continue;
        }
        let h: usize = p[1].parse().unwrap();
        let want: Vec<usize> = p[2].trim_matches(|c| c == '[' || c == ']').split(',').map(|x| x.trim().parse().unwrap()).collect();
        let cs = class_set(d);
        let mut ws: Vec<usize> = cs.classes().iter().map(|c| c.weight()).collect();
        ws.sort_unstable();
        assert_eq!((cs.len(), &ws), (h, &want), "d = {}", d);
        // the weights sum to the mass
        let sum = ws.iter().fold(Rat::zero(), |s, &w| s.add(&Rat::new(BigInt::from(1), BigInt::from(w as i64))));
        assert_eq!(&sum, cs.mass(), "d = {}", d);
        n += 1;
    }
    n
}

#[test]
fn classes_vs_magma() {
    assert_eq!(check(60), 36);
}

#[test]
#[ignore]
fn classes_vs_magma_all() {
    assert_eq!(check(200), 121);
}

#[test]
fn dembele_voight_example_8_6() {
    let cs = class_set(106);
    let cg = cs.class_group();
    assert_eq!((cg.h(), cg.narrow_h()), (2, 2));
    // zeta_F(-1) h_F / 2 = 87/2
    assert_eq!(cs.mass(), &Rat::new(BigInt::from(87), BigInt::from(2)));
    assert_eq!(cs.len(), 52);
    assert_eq!(cs.len() - cg.narrow_h(), 50);
    // representatives in both narrow classes, as the reduced norm maps Cl O
    // onto Cl+ (Kirschmer-Voight, Proposition 7.3)
    let mut seen = std::collections::HashSet::new();
    for c in cs.classes() {
        seen.insert(cg.narrow_class(&c.ideal().nrd()).unwrap());
    }
    assert_eq!(seen.len(), 2);
}

#[test]
#[ignore]
fn work_used() {
    // the search nodes used by each class set of the fixture (to calibrate
    // the budget)
    let mut max = (0u64, 0i64);
    for l in include_str!("fixtures/magma-classes.txt").lines().filter(|l| !l.starts_with('#')) {
        let d: i64 = l.split('|').next().unwrap().trim().parse().unwrap();
        let t = std::time::Instant::now();
        let cs = class_set(d);
        println!("d = {}: H = {}, {} nodes, {:.2} s", d, cs.len(), cs.work(), t.elapsed().as_secs_f64());
        if cs.work() > max.0 {
            max = (cs.work(), d);
        }
    }
    println!("max {} nodes at d = {}", max.0, max.1);
}
