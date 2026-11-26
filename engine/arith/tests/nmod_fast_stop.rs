//! A Stop inside the fast product (three Winograd levels over a 264-square
//! product at p = 65537): the units charged at every Stop are a prefix of
//! the whole call's, family by family, with the total equal to what was
//! used; Stops land in the kernel's own passes (copies, additions,
//! assembly) and in its child products.  Its own test binary: the
//! interrupt hooks are global.  Also: a Stop inside a fast product that
//! Mat::mul admits at the production crossover gives the allowance's words
//! back.

use sagebrush_arith::cost::{metered, Family, Meter};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::{fast_allowance_left, fast_n0, with_fast_product, Mat};
use sagebrush_interrupt::hooks;

fn mat(n: usize, p: u64, seed: u64) -> Mat {
    let mut s = seed;
    let d = (0..n * n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % p
        })
        .collect();
    Mat { rows: n, cols: n, m: Modulus::new(p), d }
}

#[cfg(panic = "unwind")]
#[test]
fn a_stop_in_the_fast_product_charges_a_prefix() {
    let (n, p) = (264usize, 65537u64);
    let fams = [Family::MulSchool, Family::ModArith, Family::Move];
    let (a, b) = (mat(n, p, 0x9e37_79b9_7f4a_7c15), mat(n, p, 0x2545_f491_4f6c_dd1d));

    hooks::reset();
    let mut whole = Meter::accounting(u64::MAX);
    let c = metered(&mut whole, || a.mul_planned(&b, 2));
    let checks = hooks::total();
    hooks::reset();
    assert_eq!(c, a.mul(&b));
    let full: Vec<u64> = fams.iter().map(|&f| whole.units().get(f)).collect();
    assert!(checks >= 20, "{checks}");

    let mut last = vec![0u64; fams.len()];
    let mut moved = 0;
    for at in 1..=checks {
        let mut meter = Meter::accounting(u64::MAX);
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| metered(&mut meter, || a.mul_planned(&b, 2)));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "check {at}: the Stop ended the call");
        assert_eq!(meter.units().total(), Some(meter.used()));
        let got: Vec<u64> = fams.iter().map(|&f| meter.units().get(f)).collect();
        for i in 0..fams.len() {
            assert!(last[i] <= got[i] && got[i] <= full[i], "check {at}, {:?}: {} then {}, of {}", fams[i], last[i], got[i], full[i]);
        }
        // a Stop between two child products (only the kernel's own passes
        // ran since the last check): no MulSchool since then
        if got[0] == last[0] && got != last {
            moved += 1;
        }
        last = got;
    }
    assert!(moved > 0, "some Stop lands in the kernel's own passes");

    // a Stop inside a fast product that Mat::mul itself admits, at the
    // production crossover (a shape it takes fast: fewer units than the
    // classical product's, proven by a whole run first), gives its words
    // back, and the allowance is off again outside
    let md = Modulus::new(p);
    let s2 = 2 * fast_n0(&md) + 4;
    let (a2, b2) = (mat(s2, p, 0x1234_5678_9abc_def1), mat(s2, p, 0x0fed_cba9_8765_4321));
    let mut classical = Meter::accounting(u64::MAX);
    let want = metered(&mut classical, || a2.mul_classical(&b2));
    let left = 1u64 << 40;
    let mut fast = Meter::accounting(u64::MAX);
    hooks::reset();
    let got = with_fast_product(left, || metered(&mut fast, || a2.mul(&b2)));
    let checks2 = hooks::total();
    hooks::reset();
    assert_eq!(got, want);
    assert!(fast.used() < classical.used(), "{s2}: Mat::mul took the fast route ({} < {})", fast.used(), classical.used());
    assert!(checks2 >= 4, "{checks2}");
    with_fast_product(left, || {
        hooks::reset();
        hooks::arm_at(checks2 / 2);
        let r = sagebrush_interrupt::catch(|| a2.mul(&b2));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err());
        assert_eq!(fast_allowance_left(), Some(left));
    });
    assert_eq!(fast_allowance_left(), None);
}
