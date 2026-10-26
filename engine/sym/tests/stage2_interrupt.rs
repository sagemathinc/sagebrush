//! An interrupt between Stage-2 passes of the factoring engine's
//! recombination (rank-3 plan r3 with delta 2 r2, LIMIT-R3-D2-2), in its own
//! test binary: the Stop request is process-wide.  S_5 with Stage 1 ended
//! at once and every pass forced (feature test-faults); a Stop requested
//! when the second pass ends unwinds at the next check, and every
//! reservation of the call is released: the budget's live reservation is 0.
use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;
use sagebrush_poly::test_faults as tf;
use sagebrush_poly::{Budget, Limits};

/// S_5, the minimal polynomial of sqrt2 + sqrt3 + sqrt5 + sqrt7 + sqrt11.
fn s5() -> Vec<BigInt> {
    let mul = |a: &[BigInt], b: &[BigInt]| -> Vec<BigInt> {
        let mut r = vec![BigInt::zero(); a.len() + b.len() - 1];
        for (i, x) in a.iter().enumerate() {
            for (j, y) in b.iter().enumerate() {
                r[i + j] += x * y;
            }
        }
        r
    };
    let z = |v: &[i64]| -> Vec<BigInt> { v.iter().map(|&c| BigInt::from(c)).collect() };
    let mut s = z(&[-2, 0, 1]);
    for &p in &[3i64, 5, 7, 11] {
        let (mut a, mut c) = (vec![BigInt::zero()], vec![BigInt::zero()]);
        for coef in s.iter().rev() {
            let mut na = mul(&a, &z(&[0, 1]));
            for (i, v) in mul(&c, &z(&[p])).iter().enumerate() {
                na[i] += v;
            }
            na[0] += coef;
            let mut nc = mul(&c, &z(&[0, 1]));
            for (i, v) in a.iter().enumerate() {
                nc[i] += v;
            }
            a = na;
            c = nc;
        }
        let mut r = mul(&a, &a);
        for (i, v) in mul(&mul(&c, &c), &z(&[p])).iter().enumerate() {
            r[i] -= v;
        }
        while r.last().is_some_and(|x| x.is_zero()) {
            r.pop();
        }
        s = r;
    }
    s
}

#[test]
fn an_interrupt_between_stage2_passes_leaves_no_reservation() {
    let f = s5();
    assert_eq!(f.len(), 33);
    assert!(f.last().unwrap().is_one());
    let hooks = tf::STAGE1_EXIT | tf::S2_LAST_PASS;
    // without the Stop: Stage 2 runs all 8 passes and certifies
    let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
    let r = tf::with_hooks(hooks, None, false, || sagebrush_poly::try_factor_with(&f, &b).map(|x| x.1.len()));
    assert_eq!(r.unwrap(), 1);
    assert_eq!((tf::reach().s2_passes, b.live()), (8, 0));
    // with it: interrupted after the second pass, nothing left reserved
    let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
    let r = sagebrush_interrupt::catch(|| tf::with_hooks(hooks | tf::INTERRUPT_AFTER_PASS2, None, false, || sagebrush_poly::try_factor_with(&f, &b).map(|x| x.1.len())));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "interrupted");
    let reach = tf::reach();
    assert!(reach.s2_passes >= 2 && reach.s2_passes < 8, "{reach:?}");
    assert_eq!(b.live(), 0, "live reservations after the interrupt");
    // and the next call factors normally
    assert_eq!(sagebrush_poly::try_factor(&f).unwrap().1.len(), 1);
}
