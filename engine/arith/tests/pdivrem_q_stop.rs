//! A Stop inside qpoly_divrem: at the first and the last poll of each of its
//! named phases (the denominators' lcms, the divisor's clearing and Q1, the
//! division, the reply's writing), the call stops there (an unwind,
//! terminal), and the next call is the same.  Its own test binary: the
//! interrupt hooks are global.  Only where a panic unwinds (in WebAssembly a
//! Stop traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn qpoly_divrem_stops_at_the_first_and_last_poll_of_each_phase() {
    use sagebrush_arith::{pdivrem, qpoly};
    use sagebrush_interrupt::hooks;
    // ((2t + 1)(1 + ... + t^(k-1)) / (2t + 1), k = 100k: the division polls
    // several times; the other phases at their start, at least)
    let k = 100_000usize;
    let mut a = vec!["3"; k + 1];
    a[0] = "1";
    a[k] = "2";
    let a = a.join(",");
    let (fa, fb) = (qpoly::scan(&a).unwrap(), qpoly::scan("1/7,2/7").unwrap());
    let r = (a.len() + 30) as u64;
    let want = pdivrem::reply_q(&fa, &fb, r, &pdivrem::DIVREM_Q_CAPS).unwrap();
    hooks::reset();
    hooks::trace();
    let _ = pdivrem::reply_q(&fa, &fb, r, &pdivrem::DIVREM_Q_CAPS).unwrap();
    let phases: Vec<(&str, Vec<u64>)> = ["divrem clear", "divrem load", "divrem divide", "divrem bytes", "divrem emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
    hooks::reset();
    for (phase, idx) in &phases {
        eprintln!("{}: {} polls", phase, idx.len());
        assert!(!idx.is_empty(), "no poll in {}", phase);
        for at in [idx[0], *idx.last().unwrap()] {
            hooks::reset();
            hooks::arm_at(at);
            let x = sagebrush_interrupt::catch(|| pdivrem::reply_q(&fa, &fb, r, &pdivrem::DIVREM_Q_CAPS));
            let stopped = hooks::stopped_in();
            hooks::reset();
            sagebrush_interrupt::clear();
            assert!(x.is_err(), "no Stop at poll {} ({})", at, phase);
            assert_eq!(stopped, *phase, "the Stop at poll {} came in {}", at, stopped);
        }
    }
    assert_eq!(pdivrem::reply_q(&fa, &fb, r, &pdivrem::DIVREM_Q_CAPS).unwrap(), want);
}
