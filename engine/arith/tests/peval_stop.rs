//! A Stop inside qpoly_eval: at the first and the last poll of each named
//! phase (the denominators' lcm, Horner, the reply's writing), the call stops
//! there (an unwind, terminal), and the next call is the same.  Its own test
//! binary: the interrupt hooks are global.  Only where a panic unwinds (in
//! WebAssembly a Stop traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn eval_stops_at_the_first_and_last_poll_of_each_phase() {
    use sagebrush_arith::{peval, qpoly};
    use sagebrush_interrupt::hooks;
    // (a_i = 1/(i+1) for 3,000 terms: the lcm and Horner poll many times;
    // and a short polynomial with 300,000 trailing zero tokens, which Horner
    // steps over polled)
    let harmonic = (0..3_000).map(|i| format!("1/{:x}", i + 1)).collect::<Vec<_>>().join(",");
    let zeros = format!("1/3,-2/5{}", ",0".repeat(300_000));
    for (a, v) in [(harmonic.as_str(), "-7/3"), (zeros.as_str(), "b/2")] {
        let fa = qpoly::scan(a).unwrap();
        let fv = qpoly::scan(v).unwrap();
        let r = (a.len() + v.len() + 20) as u64;
        let want = peval::reply(&fa, &fv, r, &qpoly::CAPS).unwrap();
        hooks::reset();
        hooks::trace();
        let _ = peval::reply(&fa, &fv, r, &qpoly::CAPS).unwrap();
        let phases: Vec<(&str, Vec<u64>)> = ["eval clear", "eval horner", "eval emit"].iter().map(|p| (*p, hooks::traced(p))).collect();
        hooks::reset();
        for (phase, idx) in &phases {
            eprintln!("{} bytes, {}: {} polls", a.len(), phase, idx.len());
            assert!(!idx.is_empty(), "no poll in {}", phase);
            // (the 300,000 zeros: a poll each 4096 of them)
            if *phase == "eval horner" && a == zeros {
                assert!(idx.len() >= 73, "{}: {} polls", phase, idx.len());
            }
            for at in [idx[0], *idx.last().unwrap()] {
                hooks::reset();
                hooks::arm_at(at);
                let x = sagebrush_interrupt::catch(|| peval::reply(&fa, &fv, r, &qpoly::CAPS));
                let stopped = hooks::stopped_in();
                hooks::reset();
                sagebrush_interrupt::clear();
                assert!(x.is_err(), "no Stop at poll {} ({})", at, phase);
                assert_eq!(stopped, *phase, "the Stop at poll {} came in {}", at, stopped);
            }
        }
        assert_eq!(peval::reply(&fa, &fv, r, &qpoly::CAPS).unwrap(), want);
    }
}
