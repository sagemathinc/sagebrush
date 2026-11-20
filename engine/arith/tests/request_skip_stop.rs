//! A Stop inside a large skipped request prefix, where the engine steps over
//! request tokens it doesn't use (not charged: the meter's limit, WORK_MAX -
//! R, already pays for every pass over the request; Stop polled every 4096
//! tokens): the reverse walk past a dividend's 300,000 trailing zero tokens
//! (zpoly_divrem's `divrem divide`), and the forward walk past a 20,000th
//! derivative's first 20,000 tokens (qpoly_derivative's `scale compute`).
//! The skips' polls are counted exactly (an unpolled skip has fewer), and a
//! Stop at one of them stops in that phase; the next call is the same.  Its
//! own test binary: the interrupt hooks are global.  Only where a panic
//! unwinds (in WebAssembly a Stop traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn stops_inside_skipped_request_prefixes() {
    use sagebrush_arith::{pdivrem, pscale, qpoly};
    use sagebrush_interrupt::hooks;
    // (the dividend's 300,000 trailing zeros: skipped from the end)
    let a = format!("1,2,3{}", ",0".repeat(300_000));
    let (fa, fb) = (qpoly::scan_ints(&a).unwrap(), qpoly::scan_ints("1,1").unwrap());
    let r = (a.len() + 30) as u64;
    let want = pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap();
    hooks::reset();
    hooks::trace();
    let _ = pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap();
    let idx = hooks::traced("divrem divide");
    hooks::reset();
    // (exactly: the phase's own first check, then one each 4096 skipped
    // tokens, 74; an unpolled skip leaves 1)
    eprintln!("divrem divide: {} polls", idx.len());
    assert_eq!(idx.len(), 1 + 300_000usize.div_ceil(4096));
    for at in [idx[1], idx[40]] {
        hooks::reset();
        hooks::arm_at(at);
        let x = sagebrush_interrupt::catch(|| pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS));
        let stopped = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(x.is_err(), "no Stop at poll {}", at);
        assert_eq!(stopped, "divrem divide", "the Stop at poll {} came in {}", at, stopped);
    }
    assert_eq!(pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap(), want);

    // (the 20,000th derivative of a 20,001-term polynomial: its first 20,000
    // tokens skipped from the front, before k! is built)
    let a = vec!["1"; 20_001].join(",");
    let (fa, fb) = (qpoly::scan(&a).unwrap(), qpoly::scan_ints("4e20").unwrap());
    let r = (a.len() + 30) as u64;
    let kind = pscale::Kind::Derivative;
    let want = pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS).unwrap();
    hooks::reset();
    hooks::trace();
    let _ = pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS).unwrap();
    let idx = hooks::traced("scale compute");
    hooks::reset();
    eprintln!("scale compute: {} polls", idx.len());
    // (exactly: the phase's first check, the skip's 5 (20,000 / 4096 rounded
    // up), then k!'s and the coefficient's metered polls, 36; an unpolled
    // skip leaves 37)
    assert_eq!(idx.len(), 1 + 5 + 36);
    for at in [idx[1], idx[5]] {
        hooks::reset();
        hooks::arm_at(at);
        let x = sagebrush_interrupt::catch(|| pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS));
        let stopped = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(x.is_err(), "no Stop at poll {}", at);
        assert_eq!(stopped, "scale compute", "the Stop at poll {} came in {}", at, stopped);
    }
    assert_eq!(pscale::reply(kind, &fa, &fb, r, &qpoly::CAPS).unwrap(), want);
}
