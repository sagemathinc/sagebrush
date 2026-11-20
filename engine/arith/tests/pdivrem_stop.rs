//! A Stop inside zpoly_divrem: at the first and the last poll of each of its
//! named phases (the divisor's load, the division, the reply's writing), the
//! call stops there (an unwind, terminal), and the next call is the same.
//! Its own test binary: the interrupt hooks are global.  Only where a panic
//! unwinds (in WebAssembly a Stop traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn zpoly_divrem_stops_at_the_first_and_last_poll_of_each_phase() {
    use sagebrush_arith::{pdivrem, qpoly};
    use sagebrush_interrupt::hooks;
    // (100k: the division polls several times; the load and the reply's
    // writing poll at their start, at least)
    let n = 100_000usize;
    let mut a = vec!["0"; n + 1];
    a[0] = "-1";
    a[n] = "1";
    let a = a.join(",");
    let (fa, fb) = (qpoly::scan_ints(&a).unwrap(), qpoly::scan_ints("1,1,1").unwrap());
    let r = (a.len() + 30) as u64;
    let want = pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap();
    hooks::reset();
    hooks::trace();
    let _ = pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap();
    let phases: Vec<(&str, Vec<u64>)> = ["divrem load", "divrem divide", "divrem emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
    hooks::reset();
    for (phase, idx) in &phases {
        eprintln!("{}: {} polls", phase, idx.len());
        assert!(!idx.is_empty(), "no poll in {}", phase);
        for at in [idx[0], *idx.last().unwrap()] {
            hooks::reset();
            hooks::arm_at(at);
            let x = sagebrush_interrupt::catch(|| pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS));
            let stopped = hooks::stopped_in();
            hooks::reset();
            sagebrush_interrupt::clear();
            assert!(x.is_err(), "no Stop at poll {} ({})", at, phase);
            assert_eq!(stopped, *phase, "the Stop at poll {} came in {}", at, stopped);
        }
    }
    assert_eq!(pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap(), want);
}
