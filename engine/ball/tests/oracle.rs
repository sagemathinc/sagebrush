//! Against Arb at 4000 bits (tests/fixture.txt, from oracle/make_fixture.sage):
//! every result must contain Arb's ball (rigor), and be within a few bits of
//! the requested precision (tightness, so that certificates decide).

use sagebrush_ball::{catalan, euler_gamma, ln2, pi, Ball, Mag};
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
