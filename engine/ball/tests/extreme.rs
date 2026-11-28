//! Balls at the exponent range's ends: atan of 2^-(2^40) (its square
//! underflowed, and the square root's None panicked) and e1 of it (an
//! indeterminate series term never met the loop's exit), each a finite
//! enclosure, promptly, where Arb gives one.
use sagebrush_ball::{cmp_dyadic, e1, Ball};
use sagebrush_bigint::BigInt;
use std::cmp::Ordering;

const TINY: i64 = -(1 << 40);

fn approx(b: &Ball) -> f64 {
    b.to_f64_approx()
}

// lower <= m 2^e <= upper
fn contains(b: &Ball, m: i64, e: i64) -> bool {
    let (lm, le) = b.lower();
    let (um, ue) = b.upper();
    let x = BigInt::from(m);
    cmp_dyadic(&lm, le, &x, e) != Ordering::Greater && cmp_dyadic(&um, ue, &x, e) != Ordering::Less
}

#[test]
fn atan_of_tiny_and_huge_balls() {
    for sign in [1i64, -1] {
        for prec in [1u64, 2, 53, 256] {
            // (atan x = x within |x|^3/3: the ball contains x itself)
            let r = Ball::exact(BigInt::from(sign), TINY).atan(prec);
            assert!(r.is_finite() && contains(&r, sign, TINY), "atan({} 2^-(2^40)) at {}", sign, prec);
        }
        // (through the reciprocal: atan of 2^(2^40 - 2), as large as the
        // range allows, is pi/2 within 2^-(2^40 - 2))
        let x = Ball::exact(BigInt::from(sign), -TINY - 2);
        assert!(x.is_finite());
        let r = x.atan(53);
        assert!(r.is_finite());
        assert!((approx(&r) - sign as f64 * std::f64::consts::FRAC_PI_2).abs() < 1e-15);
    }
}

#[test]
fn e1_of_a_tiny_ball() {
    // (Arb at 256 bits: 762123384785.2332346379753389483069449794320259647...,
    // 2^40 log 2 - gamma + x - ...)
    let r = e1(&Ball::exact(BigInt::from(1), TINY), 53).expect("a finite enclosure");
    assert!(r.is_finite());
    assert!((approx(&r) - 762123384785.2332346379753389).abs() < 1e-3);
    assert!(r.rad_f64_approx() < 1e-3);
}
