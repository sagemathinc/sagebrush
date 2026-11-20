//! A Stop inside the reply's byte count of zpoly_divrem, in a large zero
//! prefix.  Its own test binary: the interrupt hooks are global.  Only where
//! a panic unwinds (in WebAssembly a Stop traps and the host discards the
//! instance).

/// A Stop inside a large zero prefix of the reply's byte count: x^200000 + 1
/// by 3x + 1 (Sage's rule: no top coefficient reaches 3, so the quotient is
/// 200,000 zeros and the remainder the dividend).  The count's first
/// 200,000-token walk is the quotient's zero prefix, polled every 4096
/// tokens; a Stop at its first poll and at a poll inside it stops there, and
/// the next call is the same.
#[cfg(panic = "unwind")]
#[test]
fn zpoly_divrem_stops_inside_a_zero_prefix() {
    use sagebrush_arith::{pdivrem, qpoly};
    use sagebrush_interrupt::hooks;
    let n = 200_000usize;
    let mut a = vec!["0"; n + 1];
    a[0] = "1";
    a[n] = "1";
    let a = a.join(",");
    let (fa, fb) = (qpoly::scan_ints(&a).unwrap(), qpoly::scan_ints("1,3").unwrap());
    let r = (a.len() + 30) as u64;
    let want = pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap();
    assert!(want.starts_with("{\"ok\":{\"q\":\"\",\"r\":\"1,0,"), "{}", &want[..40]);
    hooks::reset();
    hooks::trace();
    let _ = pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap();
    let idx = hooks::traced("divrem bytes");
    hooks::reset();
    // (the quotient's prefix alone: 200,000 / 4096 rounded up = 49 polls,
    // then the remainder's kept tokens as many again)
    assert!(idx.len() >= 2 * 48, "{} polls", idx.len());
    for at in [idx[0], idx[20]] {
        hooks::reset();
        hooks::arm_at(at);
        let x = sagebrush_interrupt::catch(|| pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS));
        let stopped = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(x.is_err(), "no Stop at poll {}", at);
        assert_eq!(stopped, "divrem bytes", "the Stop at poll {} came in {}", at, stopped);
    }
    assert_eq!(pdivrem::reply_z(&fa, &fb, r, &qpoly::CAPS).unwrap(), want);
}
