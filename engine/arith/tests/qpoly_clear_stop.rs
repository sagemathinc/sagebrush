//! A Stop inside qpoly_clear: the lcm's meter polls about every 2^20 units
//! (phase A), and phase B polls in its meter and its scaling.  A Stop at its
//! first, middle and last poll stops the call (an unwind, terminal), after
//! which the next call is the same.  Its own test binary: the interrupt hooks
//! are global.  Only where a panic unwinds (in WebAssembly a Stop traps and
//! the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn qpoly_clear_stops_at_its_first_middle_and_last_poll() {
    use sagebrush_arith::qpoly;
    use sagebrush_interrupt::hooks;
    let a = (0..(1 << 12)).map(|i| format!("{:x}/{:x}", 2 * i + 1, i + 1)).collect::<Vec<_>>().join(",");
    let f = qpoly::scan(&a).unwrap();
    let r = (a.len() + 20) as u64;
    let want = qpoly::clear_reply(&f, r, &qpoly::CAPS).unwrap();
    hooks::reset();
    hooks::trace();
    let _ = qpoly::clear_reply(&f, r, &qpoly::CAPS).unwrap();
    let polls = hooks::total();
    hooks::reset();
    eprintln!("polls: {}", polls);
    assert!(polls >= 3, "{} polls", polls);
    for at in [1, polls / 2, polls] {
        hooks::reset();
        hooks::arm_at(at);
        let x = sagebrush_interrupt::catch(|| qpoly::clear_reply(&f, r, &qpoly::CAPS));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(x.is_err(), "no Stop at poll {} of {}", at, polls);
    }
    assert_eq!(qpoly::clear_reply(&f, r, &qpoly::CAPS).unwrap(), want);
}
