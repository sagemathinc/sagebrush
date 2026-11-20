//! A Stop inside qpoly_mul: the lcms' meter polls about every 2^20 units
//! (phase A), and phase B polls in its meter, its packing and its
//! reduction.  A Stop at phase A's first, middle and last poll and at phase
//! B's first, middle and last stops the call (an unwind, terminal), after
//! which the next call is the same.  Its own test binary: the interrupt
//! hooks are global.  Only where a panic unwinds (in WebAssembly a Stop
//! traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn qpoly_mul_stops_at_its_first_middle_and_last_poll_in_each_phase() {
    use sagebrush_arith::qpoly;
    use sagebrush_interrupt::hooks;
    let a = vec!["7/2"; 1 << 14].join(",");
    let b = vec!["-5/6"; 1 << 14].join(",");
    let (fa, fb) = (qpoly::scan(&a).unwrap(), qpoly::scan(&b).unwrap());
    let r = (a.len() + b.len() + 32) as u64;
    let want = qpoly::reply(&fa, &fb, r, &qpoly::CAPS).unwrap();
    // (phase A's polls alone, then the whole call's)
    let pa = qpoly::admit_a(&fa, &fb, r, &qpoly::CAPS).unwrap().unwrap();
    hooks::reset();
    hooks::trace();
    let _ = qpoly::lcms(&fa, &fb, &pa).unwrap();
    let polls_a = hooks::total();
    hooks::reset();
    hooks::trace();
    let _ = qpoly::reply(&fa, &fb, r, &qpoly::CAPS).unwrap();
    let polls = hooks::total();
    hooks::reset();
    eprintln!("polls: phase A {}, in all {}", polls_a, polls);
    assert!(polls_a >= 3 && polls >= polls_a + 3, "polls: phase A {}, in all {}", polls_a, polls);
    for at in [1, polls_a / 2, polls_a, polls_a + 1, (polls_a + polls) / 2, polls] {
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| qpoly::reply(&fa, &fb, r, &qpoly::CAPS));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "no Stop at poll {} of {} (phase A {})", at, polls, polls_a);
    }
    assert_eq!(qpoly::reply(&fa, &fb, r, &qpoly::CAPS).unwrap(), want);
}
