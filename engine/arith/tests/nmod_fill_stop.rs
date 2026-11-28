//! A Stop inside the elimination's zero fill below the rank charges only
//! the runs of the fill done before it (Move counted after each run, never
//! up front), in its own test binary (the interrupt hooks are global).

use sagebrush_arith::cost::{metered, Family, Meter};
use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_interrupt::hooks;

/// The fill's run (nmod_mat::echelon_impl's chunks of words).
const RUN: u64 = 1 << 16;

#[test]
fn a_stop_in_the_zero_fill_charges_the_runs_done() {
    // a zero 3 x 2^16 matrix: rank 0, so the fill is the whole matrix, three
    // runs with a check between two runs
    let (rows, cols) = (3usize, 1usize << 16);
    let zero = || Mat { rows, cols, m: Modulus::new(101), d: vec![0; rows * cols] };

    // the whole call, traced: its Move units and its checks by phase
    hooks::reset();
    hooks::trace();
    let mut whole = Meter::accounting(u64::MAX);
    let mut a = zero();
    metered(&mut whole, || {
        let _ = a.echelon(false, false);
    });
    let elim = hooks::traced("eliminate");
    hooks::reset();
    let full = whole.units().get(Family::Move);
    assert!(full >= 3 * RUN, "the fill counted: {full}");
    // (the fill's two checks are the phase's last: nothing after it checks)
    assert!(elim.len() >= 2, "{elim:?}");
    let fill_checks = &elim[elim.len() - 2..];

    for (j, &at) in fill_checks.iter().enumerate() {
        let mut meter = Meter::accounting(u64::MAX);
        let mut a = zero();
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| {
            metered(&mut meter, || {
                let _ = a.echelon(false, false);
            })
        });
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "check {at}: the Stop ended the call");
        assert_eq!(meter.units().total(), Some(meter.used()));
        // (stopped at the fill's (j + 1)-th check: j + 1 runs done, 2 - j
        // not yet; an up-front count would charge all three)
        let runs_left = 2 - j as u64;
        assert_eq!(meter.units().get(Family::Move), full - runs_left * RUN, "a Stop at the fill's check {}: only the runs done", j + 1);
    }
}
