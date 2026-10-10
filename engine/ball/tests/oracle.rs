//! Against Arb at 4000 bits (tests/fixture.txt, from oracle/make_fixture.sage):
//! every result must contain Arb's ball (rigor), and be within a few bits of
//! the requested precision (tightness, so that certificates decide).

use sagebrush_ball::{catalan, euler_gamma, li2, ln2, pi, ti2, Ball, Mag};
use sagebrush_bigint::BigInt;

fn big(s: &str) -> BigInt {
    BigInt::parse_bytes(s.as_bytes(), 10).unwrap()
}

fn arb_ball(m: &str, e: &str, rm: &str, re: &str) -> Ball {
    let rm = big(rm);
    let r = Mag::from_bigint_up(&rm, re.parse().unwrap());
    Ball::with_radius(big(m), e.parse().unwrap(), r)
}

#[test]
fn contains_arb() {
    let text = include_str!("fixture.txt");
    let (mut n, mut loose, mut strict) = (0, vec![], 0);
    for line in text.lines() {
        let (lhs, rhs) = line.split_once(" | ").unwrap();
        let l: Vec<&str> = lhs.split(' ').collect();
        let r: Vec<&str> = rhs.split(' ').collect();
        let (f, prec) = (l[0], l[1].parse::<u64>().unwrap());
        let x = Ball::exact(big(l[2]), l[3].parse().unwrap());
        let ours = match f {
            "exp" => x.exp(prec),
            "log" => x.log(prec),
            "sqrt" => x.sqrt(prec),
            "sin" => x.sin(prec),
            "cos" => x.cos(prec),
            "atan" => Some(x.atan(prec)),
            "pi" => Some(pi(prec)),
            "ln2" => Some(ln2(prec)),
            "gamma" => Some(euler_gamma(prec)),
            "catalan" => Some(catalan(prec)),
            "li2" => li2(&x, prec),
            "ti2" => ti2(&x, prec),
            _ => panic!("{}", f),
        };
        let ours = ours.unwrap_or_else(|| panic!("{} returned None", line));
        let arb = arb_ball(r[0], r[1], r[2], r[3]);
        // both contain the true value, so they must overlap; when Arb's ball
        // is much tighter, ours must contain it (Arb's own radius at 4000
        // bits can be as wide as ours, e.g. cos(5 2^-2000) at 53 bits)
        assert!(ours.overlaps(&arb), "NOT ENCLOSED: {} -> ours {} vs arb {}", lhs, ours, arb);
        if arb.rad().mul_2exp(16) <= ours.rad() || arb.rad().is_zero() {
            strict += 1;
            assert!(ours.contains(&arb), "NOT ENCLOSED: {} -> ours {} vs arb {}", lhs, ours, arb);
        }
        // tightness: relative accuracy near prec bits (absolute for results near 0)
        let acc = ours.rel_accuracy_bits();
        if acc < prec as i64 - 6 && ours.rad().top() > -(prec as i64) + 4 {
            loose.push(format!("{} acc {} bits", lhs, acc));
        }
        n += 1;
    }
    assert!(n > 500, "{} cases", n);
    // (almost every case is checked by containment, not only overlap)
    assert!(strict * 10 >= n * 9, "only {} of {} cases checked strictly", strict, n);
    assert!(loose.is_empty(), "loose results:\n{}", loose.join("\n"));
}

#[test]
fn identities() {
    // exp(log x) = x, sin^2 + cos^2 = 1, tan(atan x) = x on random dyadics
    let mut seed: u64 = 12345;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for prec in [53u64, 128, 400] {
        for _ in 0..40 {
            let m = BigInt::from(rnd() >> 1) - BigInt::from(1u64 << 62);
            let e = (rnd() % 120) as i64 - 120;
            let x = Ball::exact(m.clone(), e);
            let one = Ball::one();
            let s = x.sin(prec).unwrap();
            let c = x.cos(prec).unwrap();
            assert!(s.sqr(prec).add(&c.sqr(prec), prec).contains(&one), "sin^2+cos^2 at {}", x);
            // (tan near pi/2 multiplies errors by about x^2: atan with that
            // many more bits)
            let t = x.atan(prec + 140).tan(prec).unwrap();
            assert!(t.contains(&x), "tan(atan) at {}: {}", x, t);
            if x.is_positive() {
                let y = x.log(prec).unwrap().exp(prec).unwrap();
                assert!(y.contains(&x), "exp(log) at {}: {}", x, y);
            }
        }
    }
}

#[test]
fn propagation_over_wide_balls() {
    // a wide input ball: the result encloses f at the ends and the middle
    let x = Ball::with_radius(BigInt::from(3), -1, Mag::pow2(-3)); // [1.375, 1.625]
    for (f, pts) in [("exp", [1.375, 1.5, 1.625]), ("log", [1.375, 1.5, 1.625]), ("sin", [1.375, 1.5, 1.625]), ("atan", [1.375, 1.5, 1.625])] {
        let y = match f {
            "exp" => x.exp(80).unwrap(),
            "log" => x.log(80).unwrap(),
            "sin" => x.sin(80).unwrap(),
            _ => x.atan(80),
        };
        for p in pts {
            let pb = Ball::from_f64_exact(p).unwrap();
            let v = match f {
                "exp" => pb.exp(80).unwrap(),
                "log" => pb.log(80).unwrap(),
                "sin" => pb.sin(80).unwrap(),
                _ => pb.atan(80),
            };
            assert!(y.contains(&v), "{} over [1.375, 1.625] misses f({})", f, p);
        }
    }
    // log refuses a ball that is not certainly positive
    assert!(Ball::with_radius(BigInt::from(1), -10, Mag::pow2(-9)).log(64).is_none());
}

#[test]
fn dilogarithm_boundaries() {
    use std::cmp::Ordering;
    let p = 120;
    let pi2_6 = pi(p).sqr(p).div_i64(6, p);
    // Li2(1) = pi^2/6, Ti2(1) = Catalan's G, Li2(1/2) = pi^2/12 - log(2)^2/2
    assert!(li2(&Ball::one(), p).unwrap().overlaps(&pi2_6));
    assert!(ti2(&Ball::one(), p).unwrap().overlaps(&catalan(p)));
    let half = Ball::exact(BigInt::from(1), -1);
    let want = pi(p).sqr(p).div_i64(12, p).sub(&ln2(p).sqr(p).mul_2exp(-1), p);
    assert!(li2(&half, p).unwrap().overlaps(&want));
    // a ball reaching 1 encloses Li2 up to pi^2/6; and Li2 refuses beyond 1
    let near1 = Ball::with_radius(BigInt::from(1), 0, Mag::pow2(-20));
    let l = li2(&near1, p).unwrap();
    assert!(l.contains(&pi2_6) && l.contains(&li2(&Ball::exact(BigInt::from((1 << 20) - 1), -20), p).unwrap()));
    assert!(li2(&Ball::exact(BigInt::from(3), -1), p).is_none());
    assert_eq!(li2(&half, p).unwrap().cmp(&pi2_6), Some(Ordering::Less));
}

/// The review's boundary counterexamples (BALL-F1..F5).
#[test]
fn review_boundaries() {
    use sagebrush_ball::EXP_MAX;
    use std::cmp::Ordering;
    let one = Ball::one();
    // F1: out-of-range exponents give the ball of everything, never a false exact ball
    let huge = Ball::exact(BigInt::from(1), i64::MAX);
    assert!(!huge.is_finite() && huge.cmp(&one).is_none());
    assert!(!huge.mul_i64(2, 64).is_exact());
    let tiny = Ball::exact(BigInt::from(1), i64::MIN);
    assert!(tiny.div(&one, 64).map_or(true, |q| !q.is_finite()));
    assert!(Ball::exact(BigInt::from(1), EXP_MAX - 1).mul(&Ball::exact(BigInt::from(1), EXP_MAX - 1), 64).cmp(&one).is_none());
    assert!(one.mul_2exp(i64::MAX).cmp(&one).is_none());
    // F2: le_pow2 at the bottom of the exponent range
    assert!(!Mag::pow2(-(1 << 60)).le_pow2(-(1 << 60) - 40));
    assert!(Mag::pow2(-5).le_pow2(-5) && !Mag::pow2(-5).le_pow2(-6));
    // F3: pow by i64::MIN, without recursion
    assert!(one.pow_i64(i64::MIN, 64).unwrap().contains(&one));
    // F4: 1 + 2^-(2^40): no trillion-bit endpoint, and certainly positive
    let x = one.add(&Ball::exact(BigInt::from(1), -(1 << 40)), 64);
    assert!(x.is_positive() && x.cmp(&Ball::zero()) == Some(Ordering::Greater));
    let wide = Ball::with_radius(BigInt::from(1), 0, Mag::pow2(-(1 << 39)));
    assert!(wide.is_positive() && wide.contains(&one));
    // F5: display of 2^-1060
    let t = Ball::from_rational(&BigInt::from(1), &(BigInt::from(1) << 1060u32), 100);
    assert!(t.to_f64_approx() > 0.0 && Ball::with_radius(BigInt::from(0), 0, Mag::pow2(-1060)).rad_f64_approx() > 0.0);
}
