//! A Stop inside an elimination whose u64 sums fold (fold64 = 4 at
//! p = 2^31 - 1): the work charged at each Stop is a prefix of the whole
//! call's, family by family, with the units total equal to what was used;
//! and the whole call's units, per family, are pinned at the route before
//! folding's.  Its own test binary: the interrupt hooks are global.

use sagebrush_arith::cost::{metered, Family, Meter};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_interrupt::hooks;

fn mat(n: usize, p: u64) -> Mat {
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
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
fn a_stop_in_a_folding_elimination_charges_a_prefix() {
    let (n, p) = (96usize, (1u64 << 31) - 1);
    let fams = [Family::MulSchool, Family::ModArith, Family::Move];

    hooks::reset();
    hooks::trace();
    let mut whole = Meter::accounting(u64::MAX);
    let mut a = mat(n, p);
    metered(&mut whole, || {
        let _ = a.echelon(true, true);
    });
    let checks = hooks::traced("eliminate");
    hooks::reset();
    let full: Vec<u64> = fams.iter().map(|&f| whole.units().get(f)).collect();
    // (the units of the route before folding, the u128 sums: folding counts
    // them exactly, its folds inside the products, src/nmod_mat.rs u64_route)
    assert_eq!(full, vec![580_640, 31_942, 22_870], "MulSchool, ModArith, Move of the whole elimination");
    assert!(checks.len() >= 3, "{checks:?}");

    let mut last = vec![0u64; fams.len()];
    for &at in [checks[0], checks[checks.len() / 2], checks[checks.len() - 1]].iter() {
        let mut meter = Meter::accounting(u64::MAX);
        let mut a = mat(n, p);
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| {
            metered(&mut meter, || {
                let _ = a.echelon(true, true);
            })
        });
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "check {at}: the Stop ended the call");
        assert_eq!(meter.units().total(), Some(meter.used()));
        let got: Vec<u64> = fams.iter().map(|&f| meter.units().get(f)).collect();
        for i in 0..fams.len() {
            assert!(last[i] <= got[i] && got[i] <= full[i], "check {at}, {:?}: {} then {}, of {}", fams[i], last[i], got[i], full[i]);
        }
        last = got;
    }
}
