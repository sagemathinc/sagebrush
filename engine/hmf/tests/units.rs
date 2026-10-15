//! A level given by a generator times a large unit is the same level
//! (daybreak CORR-41E-1: 2 w^90 used to overflow in Elt::div_exact).

use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::Space;

/// g w^k (k may be negative: w^-1 = w - 1), computed in i128; None if a
/// coefficient leaves i64.
fn times_unit(g: Elt, k: i32) -> Option<Elt> {
    let (mut a, mut b) = (g.a as i128, g.b as i128);
    for _ in 0..k.unsigned_abs() {
        (a, b) = if k > 0 { (b, a + b) } else { (b - a, a) }; // times w, or times w - 1
    }
    Some(Elt::new(i64::try_from(a).ok()?, i64::try_from(b).ok()?))
}

#[test]
fn reproducer_2_w90() {
    let g = Elt::new(3559958832009428378, 5760134388741632240);
    assert_eq!(times_unit(Elt::int(2), 90), Some(g));
    let s = Space::new(g).unwrap();
    let t = Space::new(Elt::int(2)).unwrap();
    assert_eq!(s.level.hnf, t.level.hnf);
    assert_eq!(s.level.norm(), 4);
    assert_eq!(s.dimension(), t.dimension());
    assert_eq!(s.orbits.orbit, t.orbits.orbit);
}

#[test]
fn large_unit_associates() {
    for g in [Elt::int(2), Elt::new(-2, 5), Elt::int(30), Elt::new(-38, 2), Elt::new(7, -26)] {
        let base = Space::new(g).unwrap();
        for k in [-91, -90, -60, -31, 31, 60, 89, 90, 91] {
            for sign in [1, -1] {
                let Some(h) = times_unit(g.scale(sign), k) else { continue };
                let s = Space::new(h).unwrap_or_else(|e| panic!("{} w^{}: {}", g, k, e));
                assert_eq!(s.level.hnf, base.level.hnf, "{} w^{}", g, k);
                assert_eq!(s.level.gen, base.level.gen);
                assert_eq!(s.dimension(), base.dimension());
                assert_eq!(s.orbits.orbit, base.orbits.orbit);
                assert_eq!(Ideal::principal(h).unwrap().factors, base.level.factors);
                assert!(h.totally_positive_associate().is_totally_positive());
            }
        }
    }
}

/// daybreak CORR-D01-1: w^-84 = 259695496911122585 - 160500643816367088 w
/// has norm 1, but its floating-point norm is -2^62, which a former range
/// check rejected. Every power w^k with coefficients in i64 is the unit
/// ideal, and every multiple g w^k of a small generator is (g).
#[test]
fn powers_of_w_are_units() {
    assert_eq!(times_unit(Elt::int(1), -84), Some(Elt::new(259695496911122585, -160500643816367088)));
    let one = Space::new(Elt::int(1)).unwrap();
    let mut n = 0;
    for k in -100..=100 {
        for sign in [1, -1] {
            let Some(u) = times_unit(Elt::int(sign), k) else { continue };
            assert_eq!(u.norm().abs(), 1, "w^{}", k);
            let s = Space::new(u).unwrap_or_else(|e| panic!("w^{}: {}", k, e));
            assert_eq!(s.level.hnf, one.level.hnf);
            assert_eq!(s.dimension(), 1);
            n += 1;
        }
    }
    assert!(n >= 2 * 2 * 84);
    for g in [Elt::int(2), Elt::new(-2, 5), Elt::int(3)] {
        let base = Ideal::principal(g).unwrap();
        for k in -90..=90 {
            let Some(h) = times_unit(g, k) else { continue };
            assert_eq!(Ideal::principal(h).unwrap().hnf, base.hnf, "{} w^{}", g, k);
        }
    }
}

/// Elements whose norm genuinely exceeds the supported range are an error,
/// not a panic.
#[test]
fn huge_norms_are_errors() {
    assert!(Space::new(Elt::new(i64::MAX, 0)).is_err());
    assert!(Space::new(Elt::new(i64::MIN + 1, i64::MAX)).is_err());
    assert!(Space::new(Elt::new(1 << 40, 3)).is_err());
}
