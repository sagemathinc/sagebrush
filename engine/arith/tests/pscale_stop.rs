//! A Stop inside qpoly_scale, qpoly_derivative, qpoly_integral, qpoly_add
//! and qpoly_sub: at the first and the last poll of each named phase (the
//! compute, the reply's writing), the call stops there (an unwind,
//! terminal), and the next call is the same.  Its own test binary: the
//! interrupt hooks are global.  Only where a panic unwinds (in WebAssembly a
//! Stop traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn scale_ops_stop_at_the_first_and_last_poll_of_each_phase() {
    use sagebrush_arith::{pscale, qpoly};
    use sagebrush_interrupt::hooks;
    // (200k coefficients with denominators: the compute polls many times,
    // the reply's writing at its start at least)
    let a = (0..200_000).map(|i| format!("{:x}/{:x}", i * 7 + 1, i % 97 + 2)).collect::<Vec<_>>().join(",");
    let fa = qpoly::scan(&a).unwrap();
    let r = (a.len() + 40) as u64;
    let long_b = (0..200_000).map(|i| format!("{:x}/{:x}", i * 5 + 3, i % 89 + 3)).collect::<Vec<_>>().join(",");
    for (kind, b) in [(pscale::Kind::Scale, "-15/22"), (pscale::Kind::Derivative, "3"), (pscale::Kind::Integral, "1/2"), (pscale::Kind::Add, long_b.as_str()), (pscale::Kind::Sub, long_b.as_str())] {
        let fb = if kind == pscale::Kind::Derivative { qpoly::scan_ints(b) } else { qpoly::scan(b) }.unwrap();
        let want = pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS).unwrap();
        hooks::reset();
        hooks::trace();
        let _ = pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS).unwrap();
        let phases: Vec<(&str, Vec<u64>)> = ["scale compute", "scale emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
        hooks::reset();
        for (phase, idx) in &phases {
            eprintln!("{:?} {}: {} polls", kind, phase, idx.len());
            assert!(!idx.is_empty(), "no poll in {}", phase);
            for at in [idx[0], *idx.last().unwrap()] {
                hooks::reset();
                hooks::arm_at(at);
                let x = sagebrush_interrupt::catch(|| pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS));
                let stopped = hooks::stopped_in();
                hooks::reset();
                sagebrush_interrupt::clear();
                assert!(x.is_err(), "no Stop at poll {} ({})", at, phase);
                assert_eq!(stopped, *phase, "the Stop at poll {} came in {}", at, stopped);
            }
        }
        assert_eq!(pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS).unwrap(), want);
    }
}
